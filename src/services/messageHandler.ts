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

                // Fix #5: skip persistence for replayed messages (already in DB from original send)
                if (msg.alreadyPersisted) {
                    filteredMessages.push(msg);
                    continue;
                }

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
        // Supporta sia "ok +393..." (singolo) che "ok +39A +39B +39C" (multipli)
        const isOkCommand = /^ok\b/i.test(combinedText);
        if (isOkCommand) {
            const redis = getRedis();
            const extractedPhones = [...combinedText.matchAll(/[+]?\d{7,15}/g)]
                .map(m => m[0].replace(/\D/g, ''))
                .filter(p => p.length >= 7);

            let phonesToApprove: string[] = extractedPhones;
            if (phonesToApprove.length === 0) {
                // "ok" senza numero: approva l'unico pending
                const pendingRaw = await redis.get(`approval:last_pending:${club?.id || ''}`);
                if (pendingRaw) phonesToApprove = [pendingRaw];
            }

            if (phonesToApprove.length === 0) {
                await sendMessage(jid, '⚠️ Nessun numero in attesa di approvazione.');
                return;
            }

            for (const targetPhone of phonesToApprove) {
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
                        alreadyPersisted: true,
                        raw: {
                            key: { id: `APPROVED_${Date.now()}`, remoteJid: `${targetPhone}@s.whatsapp.net`, fromMe: false },
                            pushName: targetPhone,
                            messageTimestamp: Math.floor(Date.now() / 1000),
                            message: { conversation: stored },
                        } as any,
                    }]);
                }
            }

            const plural = phonesToApprove.length > 1 ? `${phonesToApprove.length} numeri approvati` : `${phonesToApprove[0]} approvato`;
            await sendMessage(jid, `✅ ${plural}`).catch(() => {});
            return;
        }

        // Admin: conferma azioni destructive pendenti
        const { handleAdminCommand, handleAdminFaqFlow, handleAdminPendingAction } = await import('./admin-commands');
        const pendingActionHandled = await handleAdminPendingAction(combinedText, club, jid);
        if (pendingActionHandled) return;

        // Admin: tenta il parsing come comando DB PRIMA del flusso FAQ
        // (altrimenti i comandi vengono intercettati dal classificatore FAQ se c'è una domanda pending)
        const adminHandled = await handleAdminCommand(combinedText, club, jid);
        if (adminHandled) return;

        // Admin: gestione FAQ intelligente — solo se il messaggio non era un comando DB
        const faqHandled = await handleAdminFaqFlow(combinedText, club, jid);
        if (faqHandled) return;
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
        // Numero approvato: il brain gestisce la conversazione anche senza player
    }

    // ─── REDIRECT CHOICE ───
    const redirectState = await getStateByRole(jid, 'AWAITING_REDIRECT_CHOICE');
    if (redirectState && combinedText) {
        await confirmRedirectChoice(jid, combinedText, redirectState);
        return;
    }

    // ─── PENDING COVERED CONFIRMATION (Fix #4) ───
    // Se il bot ha chiesto "campo coperto va bene?" e l'utente risponde sì, esegui il booking
    {
        const redis = getRedis();
        const pendingCoveredRaw = await redis.get(`state:pending_covered:${jid}`);
        if (pendingCoveredRaw && combinedText) {
            const lower = combinedText.toLowerCase().trim();
            const isYes = /^(s[iì]|yes|ok|certo|va bene|esatto|perfetto|dai|sì|si)/.test(lower);
            const isNo = /^(no|nope|non|neanche|lascia perdere|cancella)/.test(lower);
            if (isYes || isNo) {
                await redis.del(`state:pending_covered:${jid}`);
                if (isYes) {
                    const { action: pendingAction, params: pendingParams } = JSON.parse(pendingCoveredRaw);
                    const { executeAction } = await import('./brain');
                    const brainPlayer = player || await prisma.player.findFirst({
                        where: { phoneNumber: { in: phoneVariants }, clubId: resolvedClubId ? resolvedClubId : { not: '' } }
                    });
                    const result = await executeAction(pendingAction, pendingParams, brainPlayer, club, phoneNumber);
                    if (result.success && result.matchId) {
                        const { calculateSlotCost } = await import('./pricing');
                        const match = await prisma.match.findUnique({
                            where: { id: result.matchId },
                            include: { court: true },
                        });
                        if (match?.court) {
                            const totalCost = await calculateSlotCost(match.court.id, match.startTime);
                            const pricePerPerson = totalCost > 0 ? (totalCost / 4).toFixed(2) : null;
                            const timeStr = match.startTime.toLocaleString('it-IT', {
                                timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
                            });
                            const courtType = match.court.isCovered ? '🏟️ coperto' : '☀️ all\'aperto';
                            const clubLocation = [club?.address, club?.city].filter(Boolean).join(' — ');
                            const coveredConfirmVariants = [
                                'Perfetto, prenoto il campo coperto! 🏟️',
                                'Ottimo, ti metto al coperto! 🏟️',
                                'Fatto, campo coperto prenotato! 🏟️',
                            ];
                            await simulateTypingAndSend(jid, coveredConfirmVariants[Math.floor(Math.random() * coveredConfirmVariants.length)]);
                            const lines = [
                                `📋 *Dettagli prenotazione*`,
                                `📅 ${timeStr}`,
                                `🎾 ${match.court.name} (${courtType})`,
                                pricePerPerson ? `💶 ${pricePerPerson}€ a persona` : null,
                                clubLocation ? `📍 ${clubLocation}` : null,
                            ].filter(Boolean);
                            await simulateTypingAndSend(jid, lines.join('\n'));
                        } else {
                            await simulateTypingAndSend(jid, 'Perfetto, sei dentro! 🏟️');
                        }
                    } else if (result.errorMessage) {
                        await simulateTypingAndSend(jid, `Ops! ${result.errorMessage} 😕`);
                    }
                } else {
                    await simulateTypingAndSend(jid, 'Ok, nessun problema! Dimmi se vuoi provare un altro orario. 🎾');
                }
                return;
            }
            // Se non è un sì/no chiaro, cancella il pending e prosegui normalmente col brain
            await redis.del(`state:pending_covered:${jid}`);
        }
    }

    // ─── PENDING UNCOVERED CONFIRMATION ───
    // Speculare a pending_covered: ha chiesto coperto ma solo scoperto è libero
    {
        const redis = getRedis();
        const pendingUncoveredRaw = await redis.get(`state:pending_uncovered:${jid}`);
        if (pendingUncoveredRaw && combinedText) {
            const lower = combinedText.toLowerCase().trim();
            const isYes = /^(s[iì]|yes|ok|certo|va bene|esatto|perfetto|dai|sì|si)/.test(lower);
            const isNo = /^(no|nope|non|neanche|lascia perdere|cancella)/.test(lower);
            if (isYes || isNo) {
                await redis.del(`state:pending_uncovered:${jid}`);
                if (isYes) {
                    const { action: pendingAction, params: pendingParams } = JSON.parse(pendingUncoveredRaw);
                    const { executeAction } = await import('./brain');
                    const brainPlayer = player || await prisma.player.findFirst({
                        where: { phoneNumber: { in: phoneVariants }, clubId: resolvedClubId ? resolvedClubId : { not: '' } }
                    });
                    const result = await executeAction(pendingAction, { ...pendingParams, preferCovered: false }, brainPlayer, club, phoneNumber);
                    if (result.success && result.matchId) {
                        const { calculateSlotCost } = await import('./pricing');
                        const match = await prisma.match.findUnique({ where: { id: result.matchId }, include: { court: true } });
                        if (match?.court) {
                            const totalCost = await calculateSlotCost(match.court.id, match.startTime);
                            const pricePerPerson = totalCost > 0 ? (totalCost / 4).toFixed(2) : null;
                            const timeStr = match.startTime.toLocaleString('it-IT', {
                                timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
                            });
                            const clubLocation = [club?.address, club?.city].filter(Boolean).join(' — ');
                            await simulateTypingAndSend(jid, 'Perfetto, prenoto il campo scoperto! ☀️');
                            const lines = [
                                `📋 *Dettagli prenotazione*`,
                                `📅 ${timeStr}`,
                                `🎾 ${match.court.name} (☀️ all'aperto)`,
                                pricePerPerson ? `💶 ${pricePerPerson}€ a persona` : null,
                                clubLocation ? `📍 ${clubLocation}` : null,
                            ].filter(Boolean);
                            await simulateTypingAndSend(jid, lines.join('\n'));
                        } else {
                            await simulateTypingAndSend(jid, 'Perfetto, sei dentro! ☀️');
                        }
                    } else if (result.errorMessage) {
                        await simulateTypingAndSend(jid, 'Ok, nessun problema! Dimmi se vuoi provare un altro orario. 🎾');
                    }
                } else {
                    await simulateTypingAndSend(jid, 'Ok, nessun problema! Dimmi se vuoi provare un altro orario. 🎾');
                }
                return;
            }
            await redis.del(`state:pending_uncovered:${jid}`);
        }
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
    if (player) {
        try {
            await prisma.player.update({
                where: { id: player.id },
                data: { dailyMessagesCount: { increment: 1 } },
            });
        } catch (err) {
            logger.error({ err }, 'Failed to update dailyMessagesCount');
        }
    }

    if (action !== 'NONE') {
        const result = await executeAction(action, params, player, club, phoneNumber);
        if (!result.success && result.errorMessage) {
            // Solo campo coperto disponibile — chiedi conferma + proponi alternative scoperto
            if (result.errorMessage === 'ONLY_COVERED_AVAILABLE') {
                const redis = getRedis();
                await redis.set(
                    `state:pending_covered:${jid}`,
                    JSON.stringify({ action, params: { ...params, preferCovered: true } }),
                    'EX', 300,
                );
                // Cerca slot scoperto alternativi vicini
                let altMsg = '';
                try {
                    const { findNearbyFreeScopertoSlots } = await import('./brain');
                    const refTime = result.requestedTime ?? new Date();
                    const altSlots = await findNearbyFreeScopertoSlots(
                        club?.id ?? '',
                        refTime,
                        (club as any)?.openTime || '08:00',
                        (club as any)?.closeTime || '23:30',
                        3,
                    );
                    if (altSlots.length > 0) {
                        altMsg = `\n\nSe preferisci all'aperto, ho questi orari liberi:\n${altSlots.map(s => `  📅 ${s}`).join('\n')}`;
                    }
                } catch { /* non bloccare */ }
                const onlyCoveredVariants = altMsg ? [
                    'A quell\'orario gli scoperti sono tutti occupati. Posso prenotarti il campo coperto 🏟️',
                    'Per quell\'orario ho solo il coperto disponibile. Ti va bene? 🏟️',
                    'Gli scoperti sono tutti presi a quell\'orario. Posso metterti al coperto 🏟️',
                ] : [
                    'A quell\'orario gli scoperti sono tutti occupati. Posso prenotarti il campo coperto? 🏟️',
                    'Per quell\'orario ho solo il campo coperto libero. Lo prenoto? 🏟️',
                    'Gli scoperti sono tutti occupati a quell\'orario. Ti va bene il coperto? 🏟️',
                ];
                const baseMsg = onlyCoveredVariants[Math.floor(Math.random() * onlyCoveredVariants.length)];
                await simulateTypingAndSend(jid, baseMsg + altMsg);
                return;
            }
            if (result.errorMessage === 'ONLY_UNCOVERED_AVAILABLE') {
                const redis = getRedis();
                await redis.set(
                    `state:pending_uncovered:${jid}`,
                    JSON.stringify({ action, params }),
                    'EX', 300,
                );
                const variants = [
                    'A quell\'orario i campi coperti sono tutti occupati. Posso prenotarti un campo all\'aperto? ☀️',
                    'Per quell\'orario ho solo campo scoperto libero. Ti va bene? ☀️',
                    'I coperti sono tutti presi a quell\'orario. Prenoto all\'aperto? ☀️',
                ];
                await simulateTypingAndSend(jid, variants[Math.floor(Math.random() * variants.length)]);
                return;
            }
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
                            `❓ ${player?.name || phoneNumber} insiste: vuole invitare "${searchedName}" ma non risulta iscritto. Verificare?`,
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
            } else if (result.errorMessage === 'MATCH_CLOSED') {
                await simulateTypingAndSend(jid, 'Questa partita non è più disponibile — è stata chiusa o completata. Vuoi che cerchi un altro slot? 🎾');
            } else if (result.errorMessage === 'MATCH_FULL') {
                await simulateTypingAndSend(jid, 'Purtroppo questa partita si è appena riempita! Dimmi un altro orario e ti trovo posto 🎾');
            } else if (result.errorMessage === 'LESSON_NO_CONTACT') {
                await simulateTypingAndSend(jid, 'Per le lezioni ti chiedo di contattare direttamente la segreteria del circolo — saranno loro a confermarti orario e disponibilità!');
            } else if (result.errorMessage === 'SKILL_TEST_REQUIRED') {
                await simulateTypingAndSend(jid, 'Per cercare avversari hai bisogno di completare prima lo Skill Test. Il circolo ti contatterà per organizzarlo — nel frattempo puoi prenotare il campo per te e i tuoi amici!');
            } else if (result.errorMessage === 'ALL_COURTS_TAKEN') {
                // Tutti i campi occupati a quell'orario (skill incompatibile con le partite esistenti)
                // Cerca partite pending quasi complete da proporre come alternativa
                let redirectMsg = '';
                try {
                    const { findRedirectOptions } = await import('./redirect');
                    const refTime = result.requestedTime ?? new Date();
                    const opts = await findRedirectOptions(1, refTime, 'none', club?.id ?? '');
                    const nearComplete = opts.filter(o => o.spotsLeft !== undefined && o.spotsLeft <= 2).slice(0, 3);
                    if (nearComplete.length > 0) {
                        const list = nearComplete.map((o, i) => `  ${i + 1}. ${o.description}`).join('\n');
                        redirectMsg = `\n\nHo però queste partite in corso che cercano ancora giocatori:\n${list}\n\nVuoi unirti a una? Dimmi il numero oppure dimmi un altro orario!`;
                    }
                } catch { /* non bloccare */ }
                const baseMsg = `Tutti i campi sono occupati a quell'orario${redirectMsg ? '' : ' — prova un orario diverso tra quelli liberi che ti ho indicato!'}.`;
                await simulateTypingAndSend(jid, baseMsg + redirectMsg);
            } else {
                await simulateTypingAndSend(jid, `Ops! ${result.errorMessage} 😕`);
            }
        }
        // REGISTER_PLAYER riuscito → re-call brain con il player ora registrato per catturare
        // qualsiasi intento di prenotazione espresso prima della registrazione.
        if (action === 'REGISTER_PLAYER' && result.success) {
            try {
                const newCtx = await buildBrainContext(jid, phoneNumber);
                if (newCtx.player) {
                    // Messaggio sintetico: il brain ha la cronologia completa,
                    // sa da solo se c'era un intento pendente (es. prenotazione)
                    const reCallText = '(registrazione completata — controlla la conversazione e se c\'era un intento pendente eseguilo, altrimenti rispondi NONE)';

                    const { message: msg2, action: action2, params: params2 } = await callBrain(
                        newCtx,
                        reCallText,
                    );
                    if (action2 !== 'NONE' && action2 !== 'REGISTER_PLAYER' && action2 !== 'FAQ_REQUEST') {
                        const result2 = await executeAction(action2, params2, newCtx.player, club, phoneNumber);
                        // Manda la scheda se è un booking andato a buon fine
                        if ((action2 === 'BOOK_FIELD' || action2 === 'RESCHEDULE_MATCH') && result2.success && result2.matchId) {
                            const match2 = await prisma.match.findUnique({
                                where: { id: result2.matchId },
                                include: { court: true },
                            });
                            if (match2?.status !== 'OPEN' && match2?.court) {
                                const { calculateSlotCost } = await import('./pricing');
                                const totalCost = await calculateSlotCost(match2.court.id, match2.startTime);
                                const pricePerPerson = totalCost > 0 ? (totalCost / 4).toFixed(2) : null;
                                const racketPrice = (club as any)?.racketPrice != null ? `${(club as any).racketPrice}€` : null;
                                const timeStr = match2.startTime.toLocaleString('it-IT', {
                                    timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric',
                                    month: 'long', hour: '2-digit', minute: '2-digit',
                                });
                                const courtType = match2.court.isCovered ? '🏟️ coperto' : '☀️ all\'aperto';
                                const clubLocation = [club?.address, club?.city].filter(Boolean).join(' — ');
                                const lines = [
                                    `📋 *Prenotazione confermata*`,
                                    `📅 ${timeStr}`,
                                    `🎾 ${match2.court.name} (${courtType})`,
                                    pricePerPerson ? `💶 ${pricePerPerson}€ a persona` : null,
                                    racketPrice ? `🎾 Noleggio racchetta: ${racketPrice}/persona` : null,
                                    clubLocation ? `📍 ${clubLocation}` : null,
                                ].filter(Boolean);
                                await simulateTypingAndSend(jid, lines.join('\n'));
                            } else if (match2?.status === 'OPEN') {
                                // Matchmaking avviato: il brain ha già inviato "sto cercando giocatori" nel msg2
                                // Mandiamo solo msg2 se non è stato già inviato come booking confirm
                                await simulateTypingAndSend(jid, msg2);
                            }
                        } else if (!result2.success && result2.errorMessage) {
                            if (result2.errorMessage === 'ONLY_COVERED_AVAILABLE') {
                                const redis = getRedis();
                                await redis.set(
                                    `state:pending_covered:${jid}`,
                                    JSON.stringify({ action: action2, params: { ...params2, preferCovered: true } }),
                                    'EX', 300,
                                );
                                await simulateTypingAndSend(jid, 'Sei registrato! Per quell\'orario ho solo il coperto disponibile, ti va bene? 🏟️');
                            } else if (result2.errorMessage === 'ALL_COURTS_TAKEN') {
                                await simulateTypingAndSend(jid, 'Sei registrato! Purtroppo tutti i campi sono occupati a quell\'orario — dimmi un orario alternativo e trovo subito qualcosa 🎾');
                            } else {
                                await simulateTypingAndSend(jid, 'Sei registrato! Per prenotare scrivimi giorno e orario 🎾');
                            }
                        }
                    }
                }
            } catch (err) {
                logger.warn({ err }, 'Re-call brain after REGISTER_PLAYER failed — ignored');
            }
            return;
        }

        // ACCEPT_INVITATION: se il match è diventato LOCKED (4° giocatore) → crea gruppo WA
        if (action === 'ACCEPT_INVITATION' && result.success && result.matchId) {
            try {
                const filledMatch = await prisma.match.findUnique({ where: { id: result.matchId } });
                if (filledMatch?.status === 'LOCKED' && !filledMatch.groupId) {
                    await handleMatchFilled(result.matchId, filledMatch.startTime);
                }
            } catch (err) {
                logger.error({ err, matchId: result.matchId }, 'handleMatchFilled after ACCEPT_INVITATION failed');
            }
        }

        // BOOK_FIELD / RESCHEDULE_MATCH: se NO wave (match LOCKED = prenotazione privata) → scheda completa subito.
        // Se wave partirà (match OPEN = matchmaking) → il brain ha già comunicato "sto cercando giocatori";
        //   la conferma reale arriva col gruppo WA (handleMatchFilled)
        if ((action === 'BOOK_FIELD' || action === 'RESCHEDULE_MATCH') && result.success && result.matchId) {
            try {
                const match = await prisma.match.findUnique({
                    where: { id: result.matchId },
                    include: { court: true },
                });
                const waveWillStart = match?.status === 'OPEN';
                if (!waveWillStart) {
                    if (match?.court) {
                        const { calculateSlotCost } = await import('./pricing');
                        const totalCost = await calculateSlotCost(match.court.id, match.startTime);
                        const pricePerPerson = totalCost > 0 ? (totalCost / 4).toFixed(2) : null;
                        const racketPrice = (club as any)?.racketPrice != null ? `${(club as any).racketPrice}€` : null;
                        const timeStr = match.startTime.toLocaleString('it-IT', {
                            timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric',
                            month: 'long', hour: '2-digit', minute: '2-digit',
                        });
                        const courtType = match.court.isCovered ? '🏟️ coperto' : '☀️ all\'aperto';
                        const clubLocation = [club?.address, club?.city].filter(Boolean).join(' — ');
                        const lines = [
                            `📋 *Prenotazione confermata*`,
                            `📅 ${timeStr}`,
                            `🎾 ${match.court.name} (${courtType})`,
                            pricePerPerson ? `💶 ${pricePerPerson}€ a persona` : null,
                            racketPrice ? `🎾 Noleggio racchetta: ${racketPrice}/persona` : null,
                            clubLocation ? `📍 ${clubLocation}` : null,
                        ].filter(Boolean);
                        await simulateTypingAndSend(jid, lines.join('\n'));
                    }
                }
            } catch (err) {
                logger.error({ err }, 'Failed to send booking detail card');
            }
        }
        // OPT_OUT: notifica admin
        if (action === 'OPT_OUT' && player) {
            const { notifyAdmin } = await import('../utils/notify-admin');
            notifyAdmin(`⚠️ OPT_OUT: ${player.name || phoneNumber} (${phoneNumber}) ha disattivato i messaggi.`).catch(() => {});
        }

        // ── Secondary FAQ detection: batch con 2+ messaggi ───────────────────────
        // Quando il brain esegue un'azione concreta (BOOK_FIELD, ACCEPT_INVITATION, ecc.)
        // ma il batch conteneva anche una domanda separata (es. "prenoto + c'è l'assicurazione?"),
        // classifichiamo ogni messaggio individuale con Haiku per rilevare intent secondari FAQ.
        // Non attiviamo se la primary era già FAQ_REQUEST, NONE o REGISTER_PLAYER.
        if (
            result.success &&
            action !== 'FAQ_REQUEST' &&
            action !== 'NONE' &&
            action !== 'REGISTER_PLAYER' &&
            textMessages.length > 1
        ) {
            const { detectSecondaryFaqQuestion } = await import('./ai');
            for (const msg of textMessages) {
                const t = (msg.text || '').trim();
                if (!t) continue;
                const faqText = await detectSecondaryFaqQuestion(t).catch(() => null);
                if (faqText) {
                    logger.info({ faqText, primaryAction: action }, 'Secondary FAQ_REQUEST detected in multi-message batch');
                    await executeAction('FAQ_REQUEST', { question: faqText }, player, club, phoneNumber).catch(err => {
                        logger.warn({ err }, 'Secondary FAQ_REQUEST failed — ignored');
                    });
                    break; // una FAQ secondaria per batch è sufficiente
                }
            }
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

    // Guard idempotenza: se il gruppo è già stato creato non procedere
    if (match.groupId) {
        logger.warn({ matchId, groupId: match.groupId }, 'handleMatchFilled: group already exists, skipping');
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

    // Scheda dettagli: campo, prezzo, indirizzo — accodata dopo il messaggio AI nel gruppo
    let detailCard: string | null = null;
    try {
        const { calculateSlotCost } = await import('./pricing');
        const totalCost = await calculateSlotCost(match.court!.id, startTime);
        const pricePerPerson = totalCost > 0 ? (totalCost / 4).toFixed(2) : null;
        const racketPrice = (match.club as any)?.racketPrice != null ? `${(match.club as any).racketPrice}€` : null;
        const courtType = match.court?.isCovered ? '🏟️ coperto' : '☀️ all\'aperto';
        const clubLocation = [(match.club as any)?.address, (match.club as any)?.city].filter(Boolean).join(' — ');
        const lines = [
            `📋 *Dettagli partita*`,
            `📅 ${dateStr} alle ${timeStr}`,
            `🎾 ${match.court?.name || 'Campo'} (${courtType})`,
            pricePerPerson ? `💶 ${pricePerPerson}€ a persona` : null,
            racketPrice ? `🎾 Noleggio racchetta: ${racketPrice}/persona` : null,
            clubLocation ? `📍 ${clubLocation}` : null,
        ].filter(Boolean);
        detailCard = lines.join('\n');
    } catch { /* non bloccare la creazione del gruppo */ }

    // Filter players that have a valid JID/Phone for the WhatsApp group
    // Guests or placeholder players (with fake identifiers) won't be added to the physical group
    const playerPhones = confirmed
        .filter(mp => mp.player.phoneNumber && (mp.player.phoneNumber.length > 5)) // basic check for real phone
        .map(mp => mp.player.phoneNumber);

    try {
        const groupId = await createGroupAndAddPlayers(groupName, playerPhones, confirmationMsg);
        await prisma.match.update({ where: { id: matchId }, data: { groupId } });

        // Invia scheda dettagli nel gruppo dopo il messaggio di benvenuto
        if (detailCard && groupId) {
            const { simulateTypingAndSend } = await import('./whatsapp');
            await simulateTypingAndSend(groupId, detailCard).catch(() => {});
        }

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
                originalSkillLevel: match?.skillLevel ?? 0,
                originalCourtIsCovered: match?.court?.isCovered ?? null,
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

