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

const logger = pino({ level: 'info' });
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
    const messageKey = messages[0]?.raw?.key;
    try {
        await _handleBatchInner(jid, messages);
    } catch (err) {
        // REGOLA FEEDBACK: qualunque errore, l'utente riceve sempre una risposta.
        logger.error({ err }, `Unhandled error in handleBatch for ${jid}`);
        try {
            await simulateTypingAndSend(jid, "Scusa, ho avuto un piccolo problema tecnico 😅 Puoi ripetere?");
        } catch {}
    }
}

async function _handleBatchInner(jid: string, messages: NormalizedMessage[]): Promise<void> {
    // ── Risoluzione Numero di Telefono ──────────────────────────
    // Se il JID è un @lid, cerchiamo il numero reale (@s.whatsapp.net) nei metadata Baileys
    let phoneNumber = jid.split('@')[0];
    const rawKey = messages[0]?.raw?.key as any;
    const remoteJidAlt = rawKey?.remoteJidAlt;

    if (jid.includes('@lid') && remoteJidAlt && remoteJidAlt.includes('@s.whatsapp.net')) {
        phoneNumber = remoteJidAlt.split('@')[0];
        logger.info({ LID: jid.split('@')[0], Phone: phoneNumber }, 'Resolved LID to Phone Number');
    }

    const pushName = messages[0]?.raw?.pushName;
    logger.info({ rawKey, pushName, jid, resolvedPhone: phoneNumber }, 'DEBUG message batch processing');
    logger.info(`Batch: ${messages.length} msg from ${phoneNumber}`);

    // ── Persisti ─────────────────────────────────────────────────
    for (const msg of messages) {
        try {
            const content = msg.type === 'contact'
                ? `[Contatto] ${msg.contactName || ''} ${msg.contactPhone || ''}`
                : msg.type === 'audio' ? '[Audio]' : (msg.text || '').trim();

            if (content) {
                await prisma.whatsAppMessage.create({
                    data: {
                        chatId: jid,
                        sender: phoneNumber,
                        role: 'USER',
                        content,
                    },
                });
            }
        } catch (err) {
            logger.error({ err }, 'Failed to persist message');
        }
    }

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
                        "Non riesco ad ascoltare il messaggio vocale al momento 😅 Puoi scrivermi?",
                        undefined
                    );
                    return;
                }
            }
        }
    }

    // ── Estrai contesto dal batch ─────────────────────────────────
    const contactCards = messages.filter(m => m.type === 'contact' && m.contactPhone);
    const firstCard = contactCards[0];
    const textMessages = messages.filter(m => m.type === 'text' && m.text);
    const combinedText = textMessages.map(m => m.text).join(' ').trim();
    // undefined è definito nel wrapper esterno handleBatch e usato nel fallback
    // qui usiamo quello del batch corrente per i messaggi normali
    const batchFirstKey = messages[0]?.raw?.key;

    // ─────────────────────────────────────────
    // STEP 1: stati conversazionali attivi
    // (priorità assoluta su tutto il resto)
    // ─────────────────────────────────────────

    // 1a. Onboarding nuovo giocatore
    const onboardingState = await getOnboardingState(jid);
    if (onboardingState) {
        const input = combinedText || contactCards.map(c => `${c.contactName || ''} ${c.contactPhone || ''}`).join(' ').trim();
        if (input) await continueOnboarding(jid, input, onboardingState.step, onboardingState.data);
        return;
    }

    // 1b. Redirect in attesa di conferma scelta
    const redirectState = await getStateByRole(jid, 'AWAITING_REDIRECT_CHOICE');
    if (redirectState && combinedText) {
        await confirmRedirectChoice(jid, combinedText, redirectState);
        return;
    }

    // 1c. Booking flow attivo
    const bookingState = await getBookingState(jid);
    if (bookingState) {
        const contactInfo = firstCard ? { phone: firstCard.contactPhone, name: firstCard.contactName } : null;
        // Se il giocatore non esiste ancora, consideriamo lo stato 'stale' e procediamo a conversazione fluida
        const currentClubId = process.env.CLUB_ID;
        const playerExists = await prisma.player.findFirst({ 
            where: { 
                phoneNumber, 
                clubId: currentClubId ? currentClubId : { not: '' } 
            } 
        });
        if (playerExists) {
            await continueBookingFlow(jid, combinedText, contactInfo, bookingState);
            return;
        } else {
            logger.warn({ jid, phoneNumber }, 'Booking state found for unknown player — ignoring state to allow fluid interaction');
            // Opzionale: puliamo lo stato sporco
            const { clearBookingState } = await import('./booking');
            await clearBookingState(jid);
        }
    }

    // 1d. Awaiting friend phone/level
    const awaitingState = await getAwaitingState(jid);
    if (awaitingState) {
        if (awaitingState.role === 'AWAITING_FRIEND_PHONE' || awaitingState.role === 'AWAITING_GROUP_PHONES') {
            if (contactCards.length > 0) {
                // Processa TUTTE le card ricevute in sequenza
                for (const card of contactCards) {
                    await processFriendPhone(
                        jid,
                        `${card.contactPhone} ${card.contactName || ''}`.trim(),
                        awaitingState.data,
                        undefined,
                        { phone: card.contactPhone!, name: card.contactName }
                    );
                }

                // Se Mario aveva detto N amici ma ha mandato meno card, notificalo
                const expectedCount = awaitingState.data.expectedFriendCount || 1;
                const receivedCount = contactCards.length;
                if (receivedCount < expectedCount) {
                    const missing = expectedCount - receivedCount;
                    await simulateTypingAndSend(
                        jid,
                        `Ho ricevuto ${receivedCount} contatt${receivedCount === 1 ? 'o' : 'i'} su ${expectedCount}. Mancano ancora ${missing} — intanto ho segnato quelli che mi hai mandato, il posto per ${missing} è riservato sotto tua responsabilità 👍`,
                        undefined
                    );
                }
            } else if (combinedText) {
                await processFriendPhone(jid, combinedText, awaitingState.data);
            }
            return;
        }

        if (awaitingState.role === 'AWAITING_FRIEND_LEVEL' && combinedText) {
            await processFriendLevel(jid, combinedText, awaitingState.data);
            return;
        }
    }

    // ─────────────────────────────────────────
    // STEP 2: Recupero storia recente
    // ─────────────────────────────────────────
    const recentMessages = await prisma.whatsAppMessage.findMany({
        where: { chatId: jid },
        take: 15,
        orderBy: { timestamp: 'desc' }
    });
    const historyText = recentMessages.slice().reverse()
        .map(m => `${m.role === 'USER' ? 'User' : 'Bot'}: ${m.content}`)
        .join('\n');

    // 1e. Clarification (intent poco chiaro, tentativi in corso)
    const unclearState = await getUnclearState(jid);
    if (unclearState && combinedText) {
        const result = await classifyWithConfidence(combinedText, unclearState.context, historyText);
        if (result.confident && result.intent !== 'UNKNOWN') {
            await clearUnclearState(jid);
            // Riprocessa con intent chiaro
            await routeIntent(jid, phoneNumber, result.intent, combinedText, contactCards);
        } else {
            await handleUnclearIntent(
                jid,
                combinedText,
                unclearState.attempt,
                unclearState.context,
                unclearState.availableIntents,
                undefined
            );
        }
        return;
    }

    // ─────────────────────────────────────────
    // STEP 2: risoluzione club e caricamento player
    // ─────────────────────────────────────────

    const currentClubId = process.env.CLUB_ID;
    const player = await prisma.player.findFirst({ 
        where: { 
            phoneNumber, 
            clubId: currentClubId ? currentClubId : { not: '' } 
        } 
    });
    
    // Identifica il club
    let club = null;
    if (currentClubId) {
        club = await prisma.club.findUnique({ where: { id: currentClubId } });
    } else {
        const clubCount = await prisma.club.count();
        if (clubCount === 1) {
            club = await prisma.club.findFirst();
        } else {
            club = await prisma.club.findFirst({ where: { groupJids: { has: jid } } });
        }
    }
    if (!club) club = await prisma.club.findFirst(); // fallback al primo se proprio non lo sappiamo

    // ─────────────────────────────────────────
    // STEP 3: classifica intent e routing fluido
    // ─────────────────────────────────────────

    let intent: string;
    let confident: boolean;

    if (contactCards.length > 0 && !combinedText) {
        intent = 'BRING_FRIEND';
        confident = true;
    } else if (combinedText) {
        const result = await classifyWithConfidence(combinedText, undefined, historyText);
        intent = result.intent;
        confident = result.confident;
    } else {
        return;
    }

    // Se l'utente è sconosciuto O l'intent non è chiarissimo O è una domanda generica
    // usiamo il ConversationalManager naturale invece del flusso rigido.
    if (!player || !confident || intent === 'UNKNOWN' || intent === 'QUESTION') {
        const fluidAction = await handleFluidConversation({
            jid,
            phoneNumber,
            player,
            club,
            recentMessages: recentMessages.slice().reverse()
        }, combinedText);

        // Se l'AI fluida ha rilevato un impegno concreto (BOOK o BRING_FRIEND), bridge verso business logic
        if (fluidAction) {
            logger.info({ jid, action: fluidAction.intent, params: fluidAction.params }, 'Bridging fluid action to structured flow');
            await routeIntent(jid, phoneNumber, fluidAction.intent, combinedText, contactCards, club?.id, fluidAction.params);
        }
        return;
    }

    // Delay umano per intent confermati
    await sleep(randomInt(8, 35) * 1000);

    await routeIntent(jid, phoneNumber, intent as any, combinedText, contactCards, club?.id);
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
    const player = await prisma.player.findFirst({ 
        where: { 
            phoneNumber, 
            clubId: resolvedClubId || { not: '' } 
        } 
    });
    if (!player) return;

    const firstCard = contactCards[0];

    if (intent === 'OPT_OUT') {
        await handleOptOut(jid, phoneNumber);
        return;
    }

    if (intent === 'QUESTION') {
        await simulateTypingAndSend(jid, "Aspetta, controllo e ti dico subito! 🎾");
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
            await simulateTypingAndSend(jid, "Non risulti in nessuna partita confermata al momento 🤔");
        }
        return;
    }

    if (intent === 'BRING_FRIEND' || intent === 'BRING_GROUP' || intent === 'WHOLE_COURT') {
        const confirmedMatchPlayer = await prisma.matchPlayer.findFirst({
            where: { playerId: player.id, leftAt: null, match: { status: { in: ['OPEN', 'LOCKED'] } } },
            include: { match: { include: { MatchPlayer: true, club: true } } },
        });

        const targetMatch = confirmedMatchPlayer?.match;
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

        if (intent === 'BRING_FRIEND') {
            if (contactCards.length > 0) {
                // Processa tutte le card ricevute
                for (const card of contactCards) {
                    await processFriendPhone(
                        jid,
                        `${card.contactPhone} ${card.contactName || ''}`.trim(),
                        { matchId: targetMatch.id, spotsAvailable: spotsLeft, invitedByPhone: phoneNumber },
                        undefined,
                        { phone: card.contactPhone!, name: card.contactName }
                    );
                }
            } else {
                await handleBringFriend(jid, phoneNumber, targetMatch.id, spotsLeft);
            }
        } else if (intent === 'BRING_GROUP') {
            // Estrai quanti sono dal testo
            const groupCount = await extractGroupCount(combinedText);
            if (contactCards.length > 0) {
                const missing = groupCount - contactCards.length;
                for (const card of contactCards) {
                    await processFriendPhone(
                        jid,
                        `${card.contactPhone} ${card.contactName || ''}`.trim(),
                        { matchId: targetMatch.id, spotsAvailable: spotsLeft, invitedByPhone: phoneNumber },
                        undefined,
                        { phone: card.contactPhone!, name: card.contactName }
                    );
                }
                if (missing > 0) {
                    await simulateTypingAndSend(
                        jid,
                        `Ho ricevuto ${contactCards.length} contatt${contactCards.length === 1 ? 'o' : 'i'} su ${groupCount}. Mancano ${missing} — mandameli quando puoi, intanto segno il posto 👍`,
                        undefined
                    );
                }
            } else {
                await handleBringGroup(jid, phoneNumber, targetMatch.id, spotsLeft);
            }
        } else if (intent === 'WHOLE_COURT') {
            await handleWholeCourt(jid, phoneNumber, targetMatch.id);
        }
        return;
    }

    // ── YES / NO ──────────────────────────────────────────────────

    const activeInvitations = await prisma.invitation.findMany({
        where: { playerId: player.id, status: 'PENDING', match: { status: 'OPEN' } },
        include: { match: { include: { MatchPlayer: true, club: true } } },
        orderBy: { sentAt: 'desc' },
    });

    if (activeInvitations.length === 0) {
        if (intent === 'YES' || intent === 'NO') {
            await simulateTypingAndSend(jid, "Non ho inviti attivi per te al momento 🎾");
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
        await simulateTypingAndSend(jid, "Tranquillo! Sarà per la prossima volta 💪");
        return;
    }

    if (intent === 'YES') {
        try {
            const result = await prisma.$transaction(async (tx: PrismaTransactionClient) => {
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
                    ? "Ottimo! Siamo al completo 🎾 Ti mando i dettagli nel gruppo!"
                    : "Perfetto! Ti ho segnato. Ti scrivo appena siamo al completo 🎾",
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

    const { decreaseReliability } = await import('./reliability');
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

    await simulateTypingAndSend(jid, "Ok, capito! Ho aggiornato la partita 👍");

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
// DOPPIA INVITATION — chiedi su quale
// ─────────────────────────────────────────────

async function resolveDoubleInvitation(
    jid: string,
    combinedText: string,
    invitations: any[],
    undefined: any
): Promise<any | null> {
    // Prima prova a capirlo dal testo
    const times = invitations.map(inv =>
        inv.match.startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })
    );

    // Controlla se il testo menziona già uno degli orari
    for (let i = 0; i < invitations.length; i++) {
        if (combinedText.includes(times[i])) return invitations[i];
    }

    // Non è chiaro — chiedi con domanda AI-generated
    const options = invitations.map((inv, i) =>
        `${i + 1}. ${inv.match.court} alle ${times[i]}`
    ).join('\n');

    await simulateTypingAndSend(
        jid,
        `Scusa, ho due inviti aperti per te! Per quale stai confermando?\n\n${options}\n\nDimmi il numero 😊`,
        undefined
    );

    // Salva stato per gestire la risposta nel prossimo batch
    await prisma.whatsAppMessage.create({
        data: {
            chatId: jid,
            sender: 'BOT',
            role: 'AWAITING_INVITATION_CHOICE',
            content: JSON.stringify({ invitationIds: invitations.map(inv => inv.id) }),
        },
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

    const timeStr = startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const dateStr = startTime.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    const groupName = `Padel ${timeStr} - ${match.court?.name || 'Campo'}`;

    // Build rich confirmation message
    const playerList = confirmed.map((mp, i) => `${i + 1}. ${mp.player.name || 'Giocatore'}`).join('\n');
    const confirmationMsg = `
✨ **PARTITA CONFERMATA!** 🎾

🏟️ **Circolo**: ${match.club?.name || 'Padel Club'}
📍 **Campo**: ${match.court?.name || 'Da definire'}
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

// ✅ FIX B: legge da Redis con fallback DB per compatibilità durante migrazione
async function getStateByRole(jid: string, role: string): Promise<any | null> {
    try {
        const redis = getRedis();
        const raw = await redis.get(`state:role:${jid}:${role}`);
        if (raw) return JSON.parse(raw);
    } catch (err) {
        logger.error({ err, jid, role }, 'getStateByRole Redis error — falling back to DB');
    }
    // Fallback DB: mantiene compatibilità con stati scritti prima della migrazione
    const msg = await prisma.whatsAppMessage.findFirst({
        where: { chatId: jid, role },
        orderBy: { timestamp: 'desc' },
    });
    if (!msg) return null;
    try { return JSON.parse(msg.content); } catch { return null; }
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
    // Deterministico prima: cerca numeri nel testo
    const numMatch = text.match(/\b([2-9]|10)\b/);
    if (numMatch) {
        const n = parseInt(numMatch[1]);
        if (n >= 2 && n <= 10) return n - 1; // escludi chi scrive
    }
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
