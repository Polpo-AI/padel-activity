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
import { simulateTypingAndSend, createGroupAndAddPlayers, downloadMediaMessage } from './whatsapp';
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

