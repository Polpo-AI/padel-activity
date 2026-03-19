/**
 * MESSAGE HANDLER — versione finale
 *
 * Riceve batch dalla inbound-queue (finestra 5s per JID).
 * Gestisce in ordine:
 * 1. Stati conversazionali attivi (onboarding, awaiting, booking, redirect, clarification)
 * 2. Giocatore sconosciuto → onboarding
 * 3. Classificazione intent con confidenza
 * 4. Routing verso handler specifici
 *
 * ✅ FIX CRITICITÀ B (Redis State):
 *    getStateByRole ora legge da Redis invece di query WhatsAppMessage su DB.
 *    Chiavi Redis: `state:role:{jid}:{role}` con TTL 24h.
 *
 * ✅ FIX CRITICITÀ A (Multi-Tenancy):
 *    prisma.club.findFirst() → lookup per clubId estratto dal JID giocatore.
 */

import { proto } from '@whiskeysockets/baileys';
import { prisma } from './db';
import { getRedis } from './queue';
import { transcribeAudio } from './ai';
import { increaseReliability } from './scoring';
import {
    handleBringFriend,
    handleBringGroup,
    handleWholeCourt,
    handleOptOut,
    processFriendPhone,
    processFriendLevel,
    getAwaitingState,
    setAwaitingState,
    clearAwaitingState,
} from './onboarding';
import { handleCancellation } from './recovery';
import { registerBatchHandler, NormalizedMessage } from './inbound-queue';
import { getOnboardingState, continueOnboarding, startSingleOnboarding } from './onboarding-flow';
import {
    classifyWithConfidence,
    handleUnclearIntent,
    getUnclearState,
    clearUnclearState,
    setUnclearState,
} from './intent-resolver';
import {
    startBookingFlow,
    continueBookingFlow,
    getBookingState,
} from './booking';
import {
    confirmRedirectChoice,
} from './redirect';
import pino from 'pino';
import { simulateTypingAndSend, createGroupAndAddPlayers, downloadMediaMessage } from './whatsapp';
import { reminderQueue } from './queue';
import { handleFluidConversation } from './conversational-manager';
import { runWithContext, getCorrelationId } from '../utils/request-context';

const logger = pino({ level: 'info' });

// Point 6: tracks per-correlationId whether routing has started (to gate error messages)
const conversationalPhase = new Map<string, boolean>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
type PrismaTransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// ─────────────────────────────────────────────
// REGISTRA HANDLER
// ─────────────────────────────────────────────

registerBatchHandler(handleBatch);

// ─────────────────────────────────────────────
// BATCH HANDLER
// ─────────────────────────────────────────────

export async function handleBatch(jid: string, messages: NormalizedMessage[]): Promise<void> {
    const correlationId = `${jid.split('@')[0]}-${Date.now()}`;
    await runWithContext({ correlationId, jid }, async () => {
        try {
            await _handleBatchInner(jid, messages, correlationId);
            conversationalPhase.delete(correlationId);
        } catch (err) {
            logger.error({ err, correlationId }, `Unhandled error in handleBatch for ${jid}`);
            // Point 6: only notify user if routing already started (user expects a reply)
            if (conversationalPhase.get(correlationId)) {
                try {
                    await simulateTypingAndSend(jid, ["Scusa, ho avuto un piccolo problema tecnico 😅 Puoi ripetere?", "Ops, qualcosa è andato storto 🙈 Riprova!", "Mi sono inceppato un attimo 😅 Puoi riscrivere?"][Math.floor(Math.random() * 3)]);
                } catch {}
            }
            conversationalPhase.delete(correlationId);
        }
    });
}

async function _handleBatchInner(jid: string, messages: NormalizedMessage[], correlationId: string): Promise<void> {
    // ── Risoluzione Numero di Telefono ──────────────────────────
    // Se il JID è un @lid, cerchiamo il numero reale (@s.whatsapp.net) nei metadata Baileys
    let phoneNumber = jid.split('@')[0];
    const rawKey = messages[0]?.raw?.key as any;
    const remoteJidAlt = rawKey?.remoteJidAlt;

    if (jid.includes('@lid') && remoteJidAlt && remoteJidAlt.includes('@s.whatsapp.net')) {
        phoneNumber = remoteJidAlt.split('@')[0];
        logger.info({ LID: jid.split('@')[0], Phone: phoneNumber }, 'Resolved LID to Phone Number');
    }

    // Guard: se il phoneNumber non sembra un numero di telefono valido (es. è un LID grezzo
    // senza suffisso @lid che Baileys non ha risolto), scartiamo silenziosamente.
    // Un numero italiano è 10-15 cifre. Un LID Baileys è tipicamente > 15 cifre.
    if (!/^\d{8,14}$/.test(phoneNumber)) {
        logger.warn({ jid, phoneNumber }, 'Unresolved LID or invalid phone — skipping batch');
        return;
    }

    // Canonicalizza il JID: usa sempre il numero reale (@s.whatsapp.net) come chiave Redis.
    // Senza questo, la stessa persona con JID @lid e @s.whatsapp.net avrebbe due stati Redis
    // separati → doppio onboarding, stati conversazionali duplicati, loop di messaggi.
    jid = `${phoneNumber}@s.whatsapp.net`;

    logger.info(`Batch: ${messages.length} msg from ${phoneNumber}`);

    // ── Persisti ─────────────────────────────────────────────────
    const filteredMessages = [];
    for (const msg of messages) {
        try {
            const content = msg.type === 'contact'
                ? `[Contatto] ${msg.contactName || ''} ${msg.contactPhone || ''}`
                : msg.type === 'audio' ? '[Audio]' : (msg.text || '').trim();

            if (content) {
                const messageId = msg.raw.key?.id;

                if (messageId) {
                    const existing = await prisma.whatsAppMessage.findFirst({
                        where: { messageId }
                    });
                    if (existing) {
                        logger.info({ messageId }, 'Deduplication: message already processed, skipping');
                        continue; // Salta per non creare doppioni
                    }
                }

                await prisma.whatsAppMessage.create({
                    data: {
                        chatId: jid,
                        sender: phoneNumber,
                        role: 'USER',
                        content,
                        messageId: messageId || null,
                    },
                });
                filteredMessages.push(msg); // solo quelli non duplicati
            }
        } catch (err) {
            logger.error({ err }, 'Failed to persist message');
        }
    }

    // Se tutti i messaggi sono stati skippati (duplicati), esci presto
    if (filteredMessages.length === 0 && messages.length > 0) {
        logger.info({ jid }, 'All messages in batch were duplicates, stopping early');
        return;
    }
    messages = filteredMessages; // lavora solo su quelli nuovi

    // ── Trascrivi audio ──────────────────────────────────────────
    for (const msg of messages) {
        if (msg.type === 'audio' && msg.raw.message?.audioMessage) {
            try {
                const buffer = await downloadMediaMessage(msg.raw as any, 'buffer', {}, {
                    logger: pino({ level: 'silent' }) as any,
                    reuploadRequest: (m: any) => Promise.resolve(m as any),
                });
                msg.text = await transcribeAudio(buffer as Buffer, 'ogg');
                msg.type = 'text';
            } catch (err: any) {
                logger.error({ err }, 'Failed to transcribe audio');
                if (err?.name === 'TranscriptionError') {
                    await simulateTypingAndSend(
                        jid,
                        [
                            "Non riesco ad ascoltare il messaggio vocale al momento 😅 Puoi scrivermi?",
                            "Non riesco ad elaborare l'audio in questo momento 🙉 Prova a scrivere!",
                            "Ho problemi con l'audio adesso 😅 Scrivimi quello che volevi dire!",
                        ][Math.floor(Math.random() * 3)],
                        undefined
                    );
                    return;
                }
            }
        }
    }

    // ── Estrai contesto dal batch ─────────────────────────────────
    const contactCards = messages.filter(m => m.type === 'contact' && m.contactPhone);
    const textMessages = messages.filter(m => m.type === 'text' && m.text);
    const combinedText = textMessages.map(m => m.text).join(' ').trim();

    // ─── ONBOARDING ───
    const onboardingState = await getOnboardingState(jid);
    if (onboardingState) {
        const input = combinedText || contactCards.map(c => `${c.contactName || ''} ${c.contactPhone || ''}`).join(' ').trim();
        if (input) await continueOnboarding(jid, input, onboardingState.step, { ...onboardingState.data, resolvedPhone: phoneNumber });
        return;
    }

    const currentClubId = process.env.CLUB_ID;
    const phoneVariants = [phoneNumber, '+' + phoneNumber, phoneNumber.replace(/^\+/, '')];
    const player = await prisma.player.findFirst({
        where: { phoneNumber: { in: phoneVariants }, clubId: currentClubId ? currentClubId : { not: '' } }
    });
    let club = currentClubId
        ? await prisma.club.findUnique({ where: { id: currentClubId } })
        : await prisma.club.findFirst();
    if (!club) club = await prisma.club.findFirst();

    if (!player) {
        // Nuovo utente — avvia onboarding
        const onboardingConfig = {
            clubId: club?.id || '',
            botName: club?.name || 'Bot',
            askAvailability: false,
            askTimePreference: false,
            skipLevel: true,
            notifyAdminOnNewPlayer: true,
            allowMixedLevels: club?.allowMixedLevels ?? false,
            maxDailyMessages: club?.maxDailyMessages ?? 2,
        };
        // Salva intent pendente così viene ripreso dopo l'onboarding
        if (combinedText) {
            const { setState } = await import('./conversation-state');
            await setState(`state:pending-intent:${jid}`, { intent: 'PENDING', combinedText }, 600);
        }
        await startSingleOnboarding(jid, onboardingConfig);
        return;
    }

    // ─── REDIRECT CHOICE ───
    const redirectState = await getStateByRole(jid, 'AWAITING_REDIRECT_CHOICE');
    if (redirectState && combinedText) {
        await confirmRedirectChoice(jid, combinedText, redirectState);
        return;
    }

    // ─── BRAIN ───
    conversationalPhase.set(getCorrelationId() || correlationId, true);

    const { buildBrainContext, callBrain, executeAction } = await import('./brain');
    const brainContext = await buildBrainContext(jid, phoneNumber);

    const mappedContactCards = contactCards.map(c => ({ phone: c.contactPhone ?? undefined, name: c.contactName ?? undefined }));
    const { message, action, params } = await callBrain(
        brainContext,
        combinedText || '(messaggio senza testo)',
        mappedContactCards.length > 0 ? mappedContactCards : undefined,
    );

    await simulateTypingAndSend(jid, message, undefined);

    // Persisti risposta bot
    try {
        await prisma.whatsAppMessage.create({
            data: {
                chatId: jid,
                sender: 'bot',
                role: 'BOT',
                content: message,
            },
        });
    } catch (err) {
        logger.error({ err }, 'Failed to persist bot message');
    }

    // Aggiorna dailyMessagesCount
    try {
        await prisma.player.update({
            where: { id: player.id },
            data: { dailyMessagesCount: { increment: 1 } },
        });
    } catch (err) {
        logger.error({ err }, 'Failed to update dailyMessagesCount');
    }

    if (action !== 'NONE') {
        const result = await executeAction(action, params, player, club);
        if (!result.success && result.errorMessage) {
            await simulateTypingAndSend(jid, `Ops! ${result.errorMessage} 😕`);
        }
        // BOOK_FIELD: invia scheda prenotazione con dettagli campo + prezzo + indirizzo
        if (action === 'BOOK_FIELD' && result.success && result.matchId) {
            try {
                const { calculateSlotCost } = await import('./pricing');
                const match = await prisma.match.findUnique({
                    where: { id: result.matchId },
                    include: { court: true },
                });
                if (match && match.court) {
                    const totalCost = await calculateSlotCost(match.court.id, match.startTime);
                    const pricePerPerson = totalCost > 0 ? (totalCost / 4).toFixed(2) : null;
                    const timeStr = match.startTime.toLocaleString('it-IT', {
                        timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric',
                        month: 'long', hour: '2-digit', minute: '2-digit',
                    });
                    const courtType = match.court.isCovered ? '🏟️ coperto' : '☀️ all\'aperto';
                    const clubLocation = [club?.address, club?.city].filter(Boolean).join(' — ');
                    const lines = [
                        `📋 *Dettagli prenotazione*`,
                        `📅 ${timeStr}`,
                        `🎾 ${match.court.name} (${courtType})`,
                        pricePerPerson ? `💶 ${pricePerPerson}€ a persona` : null,
                        clubLocation ? `📍 ${clubLocation}` : null,
                    ].filter(Boolean);
                    await simulateTypingAndSend(jid, lines.join('\n'));
                }
            } catch (err) {
                logger.error({ err }, 'Failed to send booking detail card');
            }
        }
        // OPT_OUT: notifica admin
        if (action === 'OPT_OUT') {
            const { notifyAdmin } = await import('../utils/notify-admin');
            notifyAdmin(`⚠️ OPT_OUT: ${player.name || phoneNumber} (${phoneNumber}) ha disattivato i messaggi.`).catch(() => {});
        }
    }
}

// ─────────────────────────────────────────────
// ROUTING INTENT
// ─────────────────────────────────────────────

async function routeIntent(
    jid: string,
    phoneNumber: string,
    intent: string,
    combinedText: string,
    contactCards: NormalizedMessage[],
    resolvedClubId?: string,
    params?: any
): Promise<void> {
    // ✅ FIX: normalizza numero per lookup (gestisce sia '393...' che '+393...')
    const phoneVariants = [phoneNumber, '+' + phoneNumber, phoneNumber.replace(/^\+/, '')];
    const player = await prisma.player.findFirst({ 
        where: { 
            phoneNumber: { in: phoneVariants },
            clubId: resolvedClubId || { not: '' } 
        } 
    });
    if (!player) {
        // Utente non registrato — avvia onboarding light (solo nome, skill 0)
        // Salva l'intent pendente in modo da riprenderlo dopo la registrazione
        const club = await prisma.club.findFirst({ where: resolvedClubId ? { id: resolvedClubId } : {} });
        if (!club) return;

        const { startSingleOnboarding } = await import('./onboarding-flow');
        const { setState } = await import('./conversation-state');

        // Salva intent pendente così continueOnboarding lo riprende dopo il nome
        await setState(`state:pending-intent:${jid}`, {
            intent,
            combinedText,
            params,
            clubId: club.id,
        }, 600); // 10 min TTL

        await startSingleOnboarding(jid, {
            clubId: club.id,
            botName: club.name || 'Padel Bot',
            askAvailability: false,
            askTimePreference: false,
            skipLevel: true,
            notifyAdminOnNewPlayer: true,
            allowMixedLevels: club.allowMixedLevels ?? false,
            maxDailyMessages: club.maxDailyMessages ?? 2,
        });
        return;
    }

    const firstCard = contactCards[0];

    if (intent === 'INVITE_PREFERRED') {
        const { extractPreferredPlayerName } = await import('./ai');
        const nameToSearch = await extractPreferredPlayerName(combinedText);
        if (!nameToSearch) {
            const { simulateTypingAndSend } = await import('./whatsapp');
            await simulateTypingAndSend(jid, "❌ Non ho capito bene chi vuoi invitare. Prova a scriverlo chiaramente (es. 'Invita Giuseppe Rossi') 🎾");
            return;
        }

        const match = await prisma.match.findFirst({
            where: {
                status: 'OPEN',
                MatchPlayer: { some: { playerId: player.id } }
            },
            include: { club: true },
            orderBy: { startTime: 'asc' }
        });

        const { simulateTypingAndSend } = await import('./whatsapp');

        if (!match) {
            await simulateTypingAndSend(jid, "❌ Non ho trovato nessuna partita aperta creata da te a cui invitare giocatori. 🎾");
            return;
        }

        const targets = await prisma.player.findMany({
            where: {
                name: { contains: nameToSearch, mode: 'insensitive' },
                active: true,
                clubId: match.clubId
            },
            take: 3
        });

        if (targets.length === 0) {
            await simulateTypingAndSend(jid, `❌ Non ho trovato nessuno nel club col nome **${nameToSearch}**. Assicurati che sia registrato! 🎾`);
            return;
        }

        const target = targets[0];

        const skillMin = match.skillLevel - (match.club?.matchLowerRange ?? 1.0);
        const skillMax = match.skillLevel + (match.club?.matchUpperRange ?? 1.0);

        if (target.skillLevel < skillMin || target.skillLevel > skillMax) {
            await simulateTypingAndSend(jid, `⚠️ **${target.name}** ha un livello incompatibile (${target.skillLevel}) per questa partita (range ${skillMin.toFixed(1)} - ${skillMax.toFixed(1)}).`);
            return;
        }

        // Add to preferred array
        await prisma.match.update({
            where: { id: match.id },
            data: { preferredPlayerIds: { push: target.id } }
        });

        await prisma.invitation.create({
            data: {
                matchId: match.id,
                playerId: target.id,
                status: 'PENDING',
                isFriendInvite: true,
                invitedById: player.id
            }
        });

        const { generateInvitation } = await import('./ai');
        const textToInvite = await generateInvitation(target.name || 'Amico', match.startTime, match.courtId, match.clubId || undefined, true);
        await simulateTypingAndSend(target.phoneNumber, textToInvite);
        // Aggiorna stats del destinatario (senza toccare dailyMessagesCount — inviti preferiti esenti da quota)
        await prisma.player.update({ where: { id: target.id }, data: { lastContactedAt: new Date() } });

        await simulateTypingAndSend(jid, `✅ Invito prioritario inviato a **${target.name}** per la tua partita! 🎾`);
        return;
    }

    if (intent === 'OPT_OUT') {
        await handleOptOut(jid, phoneNumber);
        return;
    }

    if (intent === 'QUESTION') {
        await simulateTypingAndSend(jid, ["Aspetta, controllo e ti dico subito! 🎾", "Un secondo, vedo cosa c'è in programma! 🎾", "Dammi un attimo, verifico! 🔍"][Math.floor(Math.random() * 3)]);
        return;
    }

    if (intent === 'BOOK') {
        const overrides = params ? {
            specificDay: params.day,
            specificTime: params.time
        } : undefined;
        await startBookingFlow(jid, phoneNumber, combinedText, undefined, overrides);
        return;
    }

    if (intent === 'CANCEL') {
        // Controlla sia LOCKED che OPEN
        const confirmedMatchPlayer = await prisma.matchPlayer.findFirst({
            where: {
                playerId: player.id,
                leftAt: null,
                match: { status: { in: ['LOCKED', 'OPEN'] } },
            },
            include: { match: { include: { club: true, MatchPlayer: { include: { player: true } } } } },
        });

        if (confirmedMatchPlayer) {
            if (confirmedMatchPlayer.match.status === 'LOCKED') {
                await handleCancellation(jid, phoneNumber, confirmedMatchPlayer.matchId, confirmedMatchPlayer.id);
            } else {
                // Disdetta da match OPEN
                await handleOpenMatchCancellation(jid, phoneNumber, confirmedMatchPlayer, undefined);
            }
        } else {
            await simulateTypingAndSend(jid, ["Non risulti in nessuna partita confermata al momento 🤔", "Non ho partite confermate per te ora 🎾", "Al momento non sei in nessuna partita attiva 🤔"][Math.floor(Math.random() * 3)]);
        }
        return;
    }

    if (intent === 'CHANGE_TIME') {
        const { simulateTypingAndSend } = await import('./whatsapp');
        const confirmedMatchPlayer = await prisma.matchPlayer.findFirst({
            where: {
                playerId: player.id,
                leftAt: null,
                match: { status: { in: ['LOCKED', 'OPEN'] } },
            },
            include: { match: { include: { club: true, MatchPlayer: { include: { player: true } } } } },
        });

        if (!confirmedMatchPlayer) {
            await simulateTypingAndSend(jid, "Non risulti in nessuna partita confermata al momento 🤔");
            return;
        }

        // Annulla la partita corrente e avvia booking per una nuova
        await simulateTypingAndSend(jid, `Ok ${player.name}, annullo la tua partecipazione e ti aiuto a trovarne un'altra 🎾`);

        if (confirmedMatchPlayer.match.status === 'LOCKED') {
            await handleCancellation(jid, phoneNumber, confirmedMatchPlayer.matchId, confirmedMatchPlayer.id);
        } else {
            await handleOpenMatchCancellation(jid, phoneNumber, confirmedMatchPlayer, undefined);
        }

        // Avvia subito il booking per il nuovo slot
        await startBookingFlow(jid, phoneNumber, combinedText);
        return;
    }

    if (intent === 'BRING_FRIEND' || intent === 'BRING_GROUP' || intent === 'WHOLE_COURT') {
        const confirmedMatchPlayer = await prisma.matchPlayer.findFirst({
            where: { playerId: player.id, leftAt: null, match: { status: { in: ['OPEN', 'LOCKED'] } } },
            include: { match: { include: { MatchPlayer: true, club: true, court: true } } },
        });

    const activeInvitations = await prisma.invitation.findMany({
            where: { playerId: player.id, status: 'PENDING', match: { status: 'OPEN' } },
            include: { match: { include: { MatchPlayer: true, club: true, court: true } } },
            orderBy: { sentAt: 'desc' },
        });

        const targetMatch = confirmedMatchPlayer?.match || activeInvitations[0]?.match;
        
        if (!targetMatch) {
            // Se non c'è un match attivo ma l'utente vuole portare amici, probabilmente è un BOOKING intent
            // che contiene menzione di amici (es. "Vorrei venire con un amico martedì").
            // Instradiamo verso il booking flow invece di bloccare.
            logger.info({ jid, intent, params }, 'No active match found for friend intent — routing to startBookingFlow');
            const overrides = params ? {
                specificDay: params.day,
                specificTime: params.time
            } : undefined;
            await startBookingFlow(jid, phoneNumber, combinedText, undefined, overrides);
            return;
        }

        const spotsLeft = targetMatch.playersNeeded - targetMatch.MatchPlayer.filter((mp: any) => !mp.leftAt).length;

        if (intent === 'WHOLE_COURT') {
            await handleWholeCourt(jid, phoneNumber, targetMatch.id);
        } else if (intent === 'BRING_FRIEND' || intent === 'BRING_GROUP') {
            await simulateTypingAndSend(
                jid,
                "Per preservare il livello tecnico della partita, non è più possibile inserire amici esterni singolarmente 🛡️\n" +
                "L'unico modo per giocare con amici è prenotare l'intero campo (prendendo tutti i posti rimanenti). Se vuoi farlo, scrivimi «prendo tutto il campo»."
            );
        }
        return;
    }

    // ── YES / NO ──────────────────────────────────────────────────

    const activeInvitations = await prisma.invitation.findMany({
        where: { playerId: player.id, status: 'PENDING', match: { status: 'OPEN' } },
        include: { match: { include: { MatchPlayer: true, club: true, court: true } } },
        orderBy: { sentAt: 'desc' },
    });

    if (activeInvitations.length === 0) {
        if (intent === 'YES' || intent === 'NO') {
            const noInvReplies = [
            "Non ho inviti attivi per te al momento 🎾",
            "Al momento non c'è nulla per te, ti avviso appena esce qualcosa! 🎾",
            "Nessun invito aperto per ora 🎾 Resto in ascolto!",
        ];
        await simulateTypingAndSend(jid, noInvReplies[Math.floor(Math.random() * noInvReplies.length)]);
        }
        return;
    }

    // Doppia invitation — chiedi conferma su quale
    let invitation = activeInvitations[0];
    if (activeInvitations.length > 1 && intent === 'YES') {
        const chosen = await resolveDoubleInvitation(jid, combinedText, activeInvitations, undefined);
        if (!chosen) return; // ha chiesto conferma, aspetta risposta
        invitation = chosen;
    }

    if (intent === 'NO') {
        await prisma.invitation.update({ where: { id: invitation.id }, data: { status: 'REJECTED' } });
        const noReplies = [
            "Tranquillo! Sarà per la prossima volta 💪",
            "Ok, nessun problema! Ci sarà un'altra occasione 🎾",
            "Capito! Ti tengo in mente per le prossime 😊",
            "Va bene, ci vediamo alla prossima partita! 🏟️",
        ];
        await simulateTypingAndSend(jid, noReplies[Math.floor(Math.random() * noReplies.length)]);
        
        // Verifica matematica se la partita è diventata impossibile da riempire a seguito di questo NO
        const { checkAndCancelIfUnfillable } = await import('./matchmaker');
        await checkAndCancelIfUnfillable(invitation.matchId);
        
        return;
    }

    if (intent === 'YES') {
        try {
            const result = await prisma.$transaction(async (tx: any) => {
                // ✅ FIX A (Race Condition): Acquisisce lock sulla riga per evitare sovraffollamento
                await tx.$executeRaw`SELECT 1 FROM "Match" WHERE id = ${invitation.matchId} FOR UPDATE`;

                const match = await tx.match.findUnique({
                    where: { id: invitation.matchId },
                    include: { MatchPlayer: true },
                });

                if (!match || match.status !== 'OPEN') throw new Error('MATCH_CLOSED');

                const activeCount = match.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
                if (activeCount >= match.playersNeeded) throw new Error('MATCH_FULL');

                await tx.matchPlayer.create({ data: { matchId: match.id, playerId: player.id } });
                await tx.invitation.update({ where: { id: invitation.id }, data: { status: 'ACCEPTED' } });

                if (activeCount + 1 >= match.playersNeeded) {
                    const filled = await tx.match.update({ where: { id: match.id }, data: { status: 'LOCKED' } });
                    return { status: 'JUST_FILLED', match: filled };
                }

                return { status: 'ADDED', match };
            });

            await simulateTypingAndSend(
                jid,
                result.status === 'JUST_FILLED'
                    ? Math.random() < 0.5 ? "Ottimo! Siamo al completo 🎾 Ti mando i dettagli nel gruppo!" : "Perfetti! Squadra al completo 🏟️ Segui il gruppo per i dettagli!"
                    : Math.random() < 0.5 ? "Perfetto! Ti ho segnato. Ti scrivo appena siamo al completo 🎾" : Math.random() < 0.5 ? "Ottimo! Sei dentro 🎾 Ti avviso quando il gruppo è completo!" : "Fatto! Ti confermo appena troviamo gli altri 💪",
                undefined
            );

            if (result.status === 'JUST_FILLED') {
                await handleMatchFilled(result.match.id, result.match.startTime);
                await increaseReliability(player.id);
            }

        } catch (error: any) {
            if (error.message === 'MATCH_FULL' || error.message === 'MATCH_CLOSED') {
                await prisma.invitation.update({ where: { id: invitation.id }, data: { status: 'REJECTED' } });

                // Dirottta con algoritmo redirect invece di dirlo e basta
                const { redirectGroup } = await import('./redirect');
                await redirectGroup({
                    referentPhone: phoneNumber,
                    referentJid: jid,
                    playerPhones: [phoneNumber],
                    playerCount: 1,
                    originalMatchId: invitation.matchId,
                    originalStartTime: invitation.match.startTime,
                    reason: 'SLOT_TAKEN',
                    clubId: invitation.match.clubId || '',
                });
            } else {
                logger.error({ error }, 'Error processing YES intent');
            }
        }
    }
}

// ─────────────────────────────────────────────
// DISDETTA DA MATCH OPEN
// ─────────────────────────────────────────────

async function handleOpenMatchCancellation(
    jid: string,
    phoneNumber: string,
    matchPlayer: any,
    undefined: any
): Promise<void> {
    const match = matchPlayer.match;

    // Rimuovi il giocatore
    await prisma.matchPlayer.update({
        where: { id: matchPlayer.id },
        data: { leftAt: new Date() },
    });

    const { decreaseReliability } = await import('./scoring');
    const player = await prisma.player.findFirst({ 
        where: { 
            phoneNumber, 
            clubId: matchPlayer.match.clubId || { not: '' } 
        } 
    });
    if (player) await decreaseReliability(player.id, 5);

    // Ricalcola situazione
    const updatedMatch = await prisma.match.findUnique({
        where: { id: match.id },
        include: {
            MatchPlayer: { include: { player: true } },
            invitations: { where: { status: 'PENDING' }, include: { player: true } },
            club: true,
        },
    });

    if (!updatedMatch) return;

    const confirmed = updatedMatch.MatchPlayer.filter((mp: any) => !mp.leftAt);
    const pending = updatedMatch.invitations;
    const confirmedCount = confirmed.length;
    const pendingCount = pending.length;
    const total = confirmedCount + pendingCount;

    await simulateTypingAndSend(jid, ["Ok, capito! Ho aggiornato la partita 👍", "Fatto! Ho modificato la tua partita 🎾", "Aggiornato! Ho preso nota delle modifiche 👌"][Math.floor(Math.random() * 3)]);

    if (total >= updatedMatch.playersNeeded) {
        // Ci sono abbastanza pending da aspettare — no wave
        logger.info(`Match ${match.id}: ${confirmedCount} confirmed + ${pendingCount} pending >= ${updatedMatch.playersNeeded}. Waiting for pending.`);
        return;
    }

    if (confirmedCount < 4 && total < 4) {
        // Pool esaurito e non si può raggiungere il minimo — annulla tutto
        await prisma.match.update({
            where: { id: match.id },
            data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: 'NO_PLAYERS' },
        });

        // Notifica i confermati rimasti e dirottali
        if (confirmed.length > 0) {
            const { redirectGroup } = await import('./redirect');
            await redirectGroup({
                referentPhone: confirmed[0].player.phoneNumber,
                referentJid: confirmed[0].player.phoneNumber,
                playerPhones: confirmed.map((mp: any) => mp.player.phoneNumber),
                playerCount: confirmed.length,
                originalMatchId: match.id,
                originalStartTime: match.startTime,
                reason: 'POOL_EXHAUSTED',
                clubId: match.clubId || '',
            });
        }
        return;
    }

    // Delta mancante — lancia wave per i posti che servono
    const delta = updatedMatch.playersNeeded - total;
    logger.info(`Match ${match.id}: launching delta wave for ${delta} players`);

    const { waveQueue } = await import('./queue');
    await waveQueue.add('process-wave', {
        matchId: match.id,
        waveNumber: (updatedMatch as any).recoveryWaveCount + 1,
        limit: delta,
    }, {
        delay: randomInt(15, 45) * 1000,
    });

    await prisma.match.update({
        where: { id: match.id },
        data: { recoveryWaveCount: { increment: 1 } },
    });
}

// ─────────────────────────────────────────────
// RISPOSTA ALLA SCELTA TRA PIÙ INVITATION
// ─────────────────────────────────────────────

async function handleInvitationChoiceReply(
    jid: string,
    phoneNumber: string,
    text: string,
    stateData: { invitationIds: string[] }
): Promise<void> {
    const player = await prisma.player.findFirst({ where: { phoneNumber } });
    if (!player) return;

    await clearAwaitingState(jid);

    const invitations = await prisma.invitation.findMany({
        where: { id: { in: stateData.invitationIds }, status: 'PENDING', match: { status: 'OPEN' } },
        include: { match: { include: { MatchPlayer: true, court: true } } },
        orderBy: { sentAt: 'asc' },
    });

    if (invitations.length === 0) {
        await simulateTypingAndSend(jid, "Gli inviti non sono più disponibili 😔 Ti avviso per le prossime partite!");
        return;
    }

    // Risolvi la scelta tramite AI
    const times = invitations.map(inv =>
        inv.match.startTime.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' })
    );
    const optionsList = invitations.map((inv, i) => {
        const t = times[i];
        const d = inv.match.startTime.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric', month: 'short' });
        return `${i + 1}. ${inv.match.court?.name || 'Campo'} – ${d} alle ${t}`;
    }).join('\n');

    const { anthropic } = await import('./ai');
    let chosenIndex: number | null = null;
    try {
        const aiResp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 5,
            temperature: 0,
            messages: [{ role: 'user', content: `Lista inviti:\n${optionsList}\n\nRisposta utente: "${text}"\n\nQuale numero ha scelto? Rispondi SOLO con il numero o UNCLEAR.` }],
        });
        const val = (aiResp.content[0] as any).text?.trim();
        if (val !== 'UNCLEAR') {
            const idx = parseInt(val) - 1;
            if (idx >= 0 && idx < invitations.length) chosenIndex = idx;
        }
    } catch { /* lascia null */ }

    if (chosenIndex === null) {
        await simulateTypingAndSend(jid, `Non ho capito bene 😅 Dimmi solo il numero:\n\n${optionsList}`);
        await setAwaitingState(jid, 'AWAITING_INVITATION_CHOICE', stateData);
        return;
    }

    const chosen = invitations[chosenIndex];

    // Processa come YES sulla partita scelta
    const invitation = chosen;
    try {
        const result = await prisma.$transaction(async (tx: any) => {
            await tx.$executeRaw`SELECT 1 FROM "Match" WHERE id = ${invitation.matchId} FOR UPDATE`;
            const match = await tx.match.findUnique({
                where: { id: invitation.matchId },
                include: { MatchPlayer: true },
            });
            if (!match || match.status !== 'OPEN') throw new Error('MATCH_CLOSED');
            const activeCount = match.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
            if (activeCount >= match.playersNeeded) throw new Error('MATCH_FULL');
            await tx.matchPlayer.create({ data: { matchId: match.id, playerId: player.id } });
            await tx.invitation.update({ where: { id: invitation.id }, data: { status: 'ACCEPTED' } });
            if (activeCount + 1 >= match.playersNeeded) {
                const filled = await tx.match.update({ where: { id: match.id }, data: { status: 'LOCKED' } });
                return { status: 'JUST_FILLED', match: filled };
            }
            return { status: 'ADDED', match };
        });

        // Declina automaticamente le altre invitation aperte
        const otherIds = invitations.filter(i => i.id !== invitation.id).map(i => i.id);
        if (otherIds.length > 0) {
            await prisma.invitation.updateMany({ where: { id: { in: otherIds } }, data: { status: 'REJECTED' } });
        }

        await simulateTypingAndSend(
            jid,
            result.status === 'JUST_FILLED'
                ? "Ottimo! Siamo al completo 🎾 Ti mando i dettagli nel gruppo!"
                : "Perfetto! Ti ho segnato 🎾 Ti avviso appena siamo al completo!"
        );

        if (result.status === 'JUST_FILLED') {
            await handleMatchFilled(result.match.id, result.match.startTime);
            await increaseReliability(player.id);
        }
    } catch (error: any) {
        if (error.message === 'MATCH_FULL' || error.message === 'MATCH_CLOSED') {
            await prisma.invitation.update({ where: { id: invitation.id }, data: { status: 'REJECTED' } });
            const { redirectGroup } = await import('./redirect');
            await redirectGroup({
                referentPhone: phoneNumber,
                referentJid: jid,
                playerPhones: [phoneNumber],
                playerCount: 1,
                originalMatchId: invitation.matchId,
                originalStartTime: invitation.match.startTime,
                reason: 'SLOT_TAKEN',
                clubId: invitation.match.clubId || '',
            });
        } else {
            logger.error({ error }, 'Error processing invitation choice reply');
        }
    }
}

// ─────────────────────────────────────────────
// DOPPIA INVITATION — chiedi su quale
// ─────────────────────────────────────────────

async function resolveDoubleInvitation(
    jid: string,
    combinedText: string,
    invitations: any[],
    undefined: any
): Promise<any | null> {
    const times = invitations.map(inv =>
        inv.match.startTime.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' })
    );
    const dates = invitations.map(inv =>
        inv.match.startTime.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric', month: 'short' })
    );

    // Prova a capire dal testo tramite AI
    const options = invitations.map((inv, i) =>
        `${i + 1}. ${inv.match.court?.name || 'Campo'} ${inv.match.court?.isCovered ? '🏠' : '☀️'} – ${dates[i]} alle ${times[i]}`
    ).join('\n');

    if (combinedText) {
        try {
            const { anthropic } = await import('./ai');
            const aiResp = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 5,
                temperature: 0,
                messages: [{ role: 'user', content: `Lista inviti:\n${options}\n\nMessaggio utente: "${combinedText}"\n\nQuale numero ha scelto? Rispondi SOLO con il numero o UNCLEAR.` }],
            });
            const val = (aiResp.content[0] as any).text?.trim();
            if (val !== 'UNCLEAR') {
                const idx = parseInt(val) - 1;
                if (idx >= 0 && idx < invitations.length) return invitations[idx];
            }
        } catch { /* chiedi conferma */ }
    }

    await simulateTypingAndSend(
        jid,
        `Scusa, ho due inviti aperti per te! Per quale stai confermando?\n\n${options}\n\nDimmi il numero 😊`,
        undefined
    );

    // Salva stato su Redis (TTL 1h — oltre non ha senso aspettare)
    await setAwaitingState(jid, 'AWAITING_INVITATION_CHOICE', {
        invitationIds: invitations.map(inv => inv.id),
    });

    return null; // aspetta risposta
}

// ─────────────────────────────────────────────
// MATCH FILLED — sequenza di chiusura
// ─────────────────────────────────────────────

export async function handleMatchFilled(matchId: string, startTime: Date): Promise<void> {
    logger.info(`Match ${matchId} LOCKED.`);

    const confirmed = await prisma.matchPlayer.findMany({
        where: { matchId, leftAt: null },
        include: { player: true },
        orderBy: { joinedAt: 'asc' }
    });

    const match = await prisma.match.findUnique({ 
        where: { id: matchId }, 
        include: { club: true, court: true } 
    });
    
    if (!match) {
        logger.error({ matchId }, 'Match not found in handleMatchFilled');
        return;
    }

    const timeStr = startTime.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
    const dateStr = startTime.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long' });
    const groupName = `Padel ${timeStr} - ${match.court?.name || 'Campo'}`;

    // Build rich confirmation message
    const playerList = confirmed.map((mp, i) => `${i + 1}. ${mp.player.name || 'Giocatore'}`).join('\n');
    const confirmationMsg = `
✨ **PARTITA CONFERMATA!** 🎾

🏟️ **Circolo**: ${match.club?.name || 'Padel Club'}
📍 **Campo**: ${match.court?.name || 'Da definire'} ${match.court?.isCovered ? '🏠 coperto' : '☀️ scoperto'}
📅 **Data**: ${dateStr}
🕐 **Orario**: ${timeStr}

👥 **Giocatori**:
${playerList}

🌟 Buon divertimento a tutti! 💪🎾🏁
`.trim();

    // Filter players that have a valid JID/Phone for the WhatsApp group
    // Guests or placeholder players (with fake identifiers) won't be added to the physical group
    const playerPhones = confirmed
        .filter(mp => mp.player.phoneNumber && (mp.player.phoneNumber.length > 5)) // basic check for real phone
        .map(mp => mp.player.phoneNumber);

    try {
        const groupId = await createGroupAndAddPlayers(groupName, playerPhones, confirmationMsg);
        await prisma.match.update({ where: { id: matchId }, data: { groupId } });

        // Notifica i PENDING rimasti e dirottali
        const pendingInvs = await prisma.invitation.findMany({
            where: { matchId, status: 'PENDING' },
            include: { player: true },
        });

        for (const inv of pendingInvs) {
            await prisma.invitation.update({ where: { id: inv.id }, data: { status: 'IGNORED' } });

            // Dirottta invece di dire solo "pieno"
            const { redirectGroup } = await import('./redirect');
            await redirectGroup({
                referentPhone: inv.player.phoneNumber,
                referentJid: inv.player.phoneNumber,
                playerPhones: [inv.player.phoneNumber],
                playerCount: 1,
                originalMatchId: matchId,
                originalStartTime: startTime,
                reason: 'SLOT_TAKEN',
                clubId: match?.clubId || '',
            });
        }

        for (const mp of confirmed) await increaseReliability(mp.player.id);

        const reminderTime = new Date(startTime.getTime() - 60 * 60 * 1000);
        const delay = Math.max(0, reminderTime.getTime() - Date.now());
        await reminderQueue.add('send-reminder', { matchId, groupId, timeStr }, { delay });

    } catch (err) {
        logger.error({ err }, `Error in closing sequence for match ${matchId}`);
    }
}

// ─────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────

// Legge stato da Redis con fallback su ConversationState (PostgreSQL)
async function getStateByRole(jid: string, role: string): Promise<any | null> {
    const { getState } = await import('./conversation-state');
    return await getState(`state:role:${jid}:${role}`);
}

function getAvailableIntents(player: any): string[] {
    return ['YES', 'NO', 'CANCEL', 'BRING_FRIEND', 'BRING_GROUP', 'WHOLE_COURT', 'OPT_OUT', 'BOOK'];
}

function buildContext(intent: string, text: string): string {
    const contexts: Record<string, string> = {
        YES: 'Sembra che tu voglia confermare la tua presenza.',
        NO: 'Sembra che tu voglia declinare.',
        UNKNOWN: 'Non ho capito cosa vuoi fare.',
    };
    return contexts[intent] || 'Non ho capito bene il tuo messaggio.';
}

async function extractGroupCount(text: string): Promise<number> {
    const { withRetry, isTransientNetworkError } = await import('../utils/retry');
    const { anthropic } = await import('./ai');
    try {
        const response = await withRetry(
            () => anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 5,
                temperature: 0,
                messages: [{
                    role: 'user',
                    content: `Quante persone (escluso chi scrive) vuole portare? Rispondi SOLO con un numero intero. Messaggio: "${text}"`,
                }],
            }),
            { maxAttempts: 2, shouldRetry: isTransientNetworkError, context: 'extractGroupCount' }
        );
        const c = response.content[0];
        if (c.type === 'text') return parseInt(c.text.trim()) || 1;
    } catch { /* default */ }
    return 1;
}

// ─────────────────────────────────────────────
