/**
 * MESSAGE HANDLER
 *
 * Riceve batch dalla inbound-queue (debounce 10s per JID).
 * Flow:
 * 1. Deduplication + trascrizione audio
 * 2. Onboarding attivo → continueOnboarding
 * 3. Giocatore non trovato → startSingleOnboarding
 * 4. Redirect choice → confirmRedirectChoice
 * 5. Brain (Claude Sonnet) → callBrain → executeAction
 */

import { proto } from '@whiskeysockets/baileys';
import { prisma } from './db';
import { getRedis } from './queue';
import { transcribeAudio } from './ai';
import { increaseReliability } from './scoring';
import { registerBatchHandler, NormalizedMessage } from './inbound-queue';
import { getOnboardingState, continueOnboarding, startSingleOnboarding } from './onboarding-flow';
import { confirmRedirectChoice } from './redirect';
import pino from 'pino';
import { simulateTypingAndSend, sendMessage, createGroupAndAddPlayers, downloadMediaMessage } from './whatsapp';
import { reminderQueue } from './queue';
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
    // Estrai il clubId dal primo messaggio del batch (tutti appartengono allo stesso socket/club)
    const clubId = messages[0]?.clubId;
    await runWithContext({ correlationId, jid, clubId }, async () => {
        try {
            await _handleBatchInner(jid, messages, correlationId, clubId);
            conversationalPhase.delete(correlationId);
        } catch (err) {
            logger.error({ err, correlationId, clubId }, `Unhandled error in handleBatch for ${jid}`);
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

async function _handleBatchInner(jid: string, messages: NormalizedMessage[], correlationId: string, clubId?: string): Promise<void> {
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

    // Risolvi il club subito — serve per il check admin prima dell'onboarding
    const resolvedClubId = clubId || process.env.CLUB_ID || undefined;
    const phoneVariants = [phoneNumber, '+' + phoneNumber, phoneNumber.replace(/^\+/, '')];
    let club = resolvedClubId
        ? await prisma.club.findUnique({ where: { id: resolvedClubId } })
        : await prisma.club.findFirst();
    if (!club) club = await prisma.club.findFirst();

    // ── ADMIN COMMANDS (prima di tutto, anche durante onboarding) ──
    // Ordine: ok <numero> → faq: risposta → comandi DB → flow normale
    const adminPhone = (club?.adminPhone || '').replace(/\D/g, '');
    const isFromAdmin = adminPhone && phoneNumber === adminPhone;
    if (isFromAdmin) {
        const okMatch = combinedText.match(/^ok\s*(\d{7,15})?$/i);
        if (okMatch) {
            const redis = getRedis();
            let targetPhone = okMatch[1];
            if (!targetPhone) {
                // "ok" senza numero: approva l'unico pending o mostra lista
                const pendingRaw = await redis.get(`approval:last_pending:${club?.id || ''}`);
                if (pendingRaw) targetPhone = pendingRaw;
            }
            if (targetPhone) {
                await redis.set(`approval:approved:${targetPhone}`, '1', 'EX', 90 * 24 * 3600);
                await redis.del(`approval:pending:${targetPhone}`);
                await redis.del(`approval:last_pending:${club?.id || ''}`);
                logger.info({ targetPhone }, 'Admin approved number');
                // Replay il messaggio pendente come se fosse appena arrivato
                const stored = await redis.get(`approval:text:${targetPhone}`);
                if (stored) {
                    await redis.del(`approval:text:${targetPhone}`);
                    const { handleBatch } = await import('./messageHandler');
                    const { getClubId } = await import('../utils/request-context');
                    await handleBatch(`${targetPhone}@s.whatsapp.net`, [{
                        type: 'text',
                        text: stored,
                        clubId: getClubId(),
                        raw: {
                            key: { id: `APPROVED_${Date.now()}`, remoteJid: `${targetPhone}@s.whatsapp.net`, fromMe: false },
                            pushName: targetPhone,
                            messageTimestamp: Math.floor(Date.now() / 1000),
                            message: { conversation: stored },
                        } as any,
                    }]);
                }
            } else {
                await sendMessage(jid, '⚠️ Nessun numero in attesa di approvazione.');
            }
            return;
        }

        // Admin: conferma azioni destructive pendenti (disattiva campo, cambia orari)
        const { looksLikeAdminCommand, handleAdminCommand, handleAdminFaqFlow, handleAdminPendingAction } = await import('./admin-commands');
        const pendingActionHandled = await handleAdminPendingAction(combinedText, club, jid);
        if (pendingActionHandled) return;

        // Admin: gestione FAQ intelligente via AI (nessun formato hardcoded)
        // Admin: gestione FAQ intelligente via AI (nessun formato hardcoded)
        const faqHandled = await handleAdminFaqFlow(combinedText, club, jid);
        if (faqHandled) return;

        // Admin: comandi DB (lista partite, modifica livello, cancella partita, ecc.)
        if (looksLikeAdminCommand(combinedText)) {
            await handleAdminCommand(combinedText, club, jid);
            return;
        }
    }

    // ─── ONBOARDING ───
    // Dopo il check admin: così i comandi "ok X" dell'admin non vengono
    // intercettati dal suo eventuale stato onboarding.
    const onboardingState = await getOnboardingState(jid);
    if (onboardingState) {
        const input = combinedText || contactCards.map(c => `${c.contactName || ''} ${c.contactPhone || ''}`).join(' ').trim();
        if (input) await continueOnboarding(jid, input, onboardingState.step, { ...onboardingState.data, resolvedPhone: phoneNumber });
        return;
    }

    const player = await prisma.player.findFirst({
        where: { phoneNumber: { in: phoneVariants }, clubId: resolvedClubId ? resolvedClubId : { not: '' } }
    });

    if (!player) {
        // L'admin bypassa sempre il gate — può onboardarsi senza approvazione
        const redis = getRedis();
        const approved = isFromAdmin || await redis.get(`approval:approved:${phoneNumber}`);
        if (!approved) {
            const alreadyPending = await redis.get(`approval:pending:${phoneNumber}`);
            if (!alreadyPending && adminPhone) {
                // Prima volta che scrive: notifica admin e metti in attesa
                const preview = combinedText.substring(0, 200) || '(nessun testo)';
                await redis.set(`approval:pending:${phoneNumber}`, '1', 'EX', 86400);
                await redis.set(`approval:text:${phoneNumber}`, combinedText || '', 'EX', 86400);
                await redis.set(`approval:last_pending:${club?.id || ''}`, phoneNumber, 'EX', 86400);
                const adminJid = `${adminPhone}@s.whatsapp.net`;
                await sendMessage(adminJid,
                    `🔔 Numero sconosciuto: +${phoneNumber}\n📩 "${preview}"\n\nRispondi *ok ${phoneNumber}* per autorizzare.`
                );
                logger.info({ phoneNumber }, 'Unknown number — waiting for admin approval');
            }
            return; // Nessuna risposta al numero non autorizzato
        }
        // Numero approvato: procedi con l'onboarding
        const onboardingConfig = {
            clubId: club?.id || '',
            botName: (club as any)?.botName || 'Francesca',
            aiTone: club?.aiTone || undefined,
            askAvailability: false,
            askTimePreference: false,
            skipLevel: true,
            notifyAdminOnNewPlayer: true,
            allowMixedLevels: club?.allowMixedLevels ?? false,
            maxDailyMessages: club?.maxDailyMessages ?? 2,
        };
        if (combinedText) {
            const { setState } = await import('./conversation-state');
            await setState(`state:pending-intent:${jid}`, { intent: 'PENDING', combinedText }, 600);
        }
        await startSingleOnboarding(jid, onboardingConfig, combinedText || undefined);
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

    const { splitAtEmoji } = await import('../utils/split-message');
    for (const part of splitAtEmoji(message)) {
        await simulateTypingAndSend(jid, part, undefined);
    }
    // NON salvare qui: simulateTypingAndSend salva già il messaggio (Lesson #6)

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
            if (result.errorMessage.startsWith('PLAYER_NOT_FOUND:')) {
                const searchedName = result.errorMessage.split(':').slice(1).join(':').trim();
                const redis = getRedis();
                const nameKey = searchedName.toLowerCase();
                const alreadyNotified = await redis.get(`invite:admin_notified:${club?.id}:${nameKey}`);
                if (alreadyNotified) {
                    await simulateTypingAndSend(jid, `Ho già contattato il circolo per verificare. Ti rispondo appena ho notizie!`);
                } else {
                    const alreadyAsked = await redis.get(`invite:not_found:${club?.id}:${nameKey}`);
                    if (alreadyAsked) {
                        // Seconda volta: escalation all'admin
                        const { notifyAdmin } = await import('../utils/notify-admin');
                        await notifyAdmin(
                            `❓ ${player.name || phoneNumber} insiste: vuole invitare "${searchedName}" ma non risulta iscritto. Verificare?`,
                            `invite_not_found_${nameKey.substring(0, 20)}`,
                            club?.adminPhone ?? undefined,
                            club?.name ?? undefined,
                        ).catch(() => {});
                        await redis.set(`invite:admin_notified:${club?.id}:${nameKey}`, '1', 'EX', 3600);
                        await simulateTypingAndSend(jid, `Ho contattato il circolo per verificare. Ti rispondo appena ho notizie!`);
                    } else {
                        // Prima volta: informa l'utente e memorizza
                        await redis.set(`invite:not_found:${club?.id}:${nameKey}`, '1', 'EX', 3600);
                        await simulateTypingAndSend(jid, `Non trovo "${searchedName}" tra i giocatori iscritti al circolo. Se sei sicuro che sia registrato, scrivimi di nuovo e verifico con il campo!`);
                    }
                }
            } else {
                await simulateTypingAndSend(jid, `Ops! ${result.errorMessage} 😕`);
            }
        }
        // BOOK_FIELD / RESCHEDULE_MATCH: invia scheda prenotazione con dettagli campo + prezzo + indirizzo
        if ((action === 'BOOK_FIELD' || action === 'RESCHEDULE_MATCH') && result.success && result.matchId) {
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

    // Genera messaggio di conferma warm con Haiku
    const firstNames = confirmed.map(mp => (mp.player.name || 'Giocatore').split(' ')[0]).join(', ');
    const courtLabel = `${match.court?.name || 'il campo'} (${match.court?.isCovered ? 'coperto 🏠' : 'all\'aperto ☀️'})`;
    let confirmationMsg = `Partita confermata! 🎾 Siamo in 4: ${firstNames}.\n📅 ${dateStr} alle ${timeStr} — ${courtLabel}\nBuon divertimento a tutti! 💪`;
    try {
        const { anthropic } = await import('./ai');
        const aiTone = (match.club as any)?.aiTone || 'calda, entusiasta, colloquiale';
        const prompt = `Scrivi un messaggio WhatsApp da mandare in un gruppo padel quando la partita si è appena riempita.
TONO: ${aiTone}
CONTESTO: ${firstNames} giocheranno ${dateStr} alle ${timeStr} su ${courtLabel}.
REGOLE: max 3 frasi, caldo ed entusiasta ma non esagerato, includi orario e nomi, niente markdown (no asterischi), emoji con parsimonia.
Scrivi solo il messaggio.`;
        const resp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 150,
            temperature: 0.8,
            messages: [{ role: 'user', content: prompt }],
        });
        if (resp.content[0].type === 'text') confirmationMsg = resp.content[0].text.trim();
    } catch { /* usa fallback */ }

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

