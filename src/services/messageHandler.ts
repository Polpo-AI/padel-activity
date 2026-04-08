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

    // (pending_covered e pending_uncovered rimossi: ora si usa sempre il redirect algorithm)

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
            // Campo preferito non disponibile → redirect algorithm con preferenza tipo campo
            // Il two-pass in redirect.ts cerca prima il tipo preferito, poi aggiunge il tipo opposto come fallback
            if (result.errorMessage === 'ONLY_COVERED_AVAILABLE') {
                // Utente voleva scoperto, solo coperto è libero a quell'orario
                // → redirect con originalCourtIsCovered=false: prima cerca scoperti vicini, poi coperto come fallback
                try {
                    const { redirectGroup } = await import('./redirect');
                    const refTime = result.requestedTime ?? new Date();
                    await redirectGroup({
                        clubId: club?.id ?? '',
                        referentPhone: player?.phoneNumber ?? phoneNumber,
                        referentJid: jid,
                        playerPhones: [player?.phoneNumber ?? phoneNumber],
                        playerCount: 1,
                        originalMatchId: 'none',
                        originalStartTime: refTime,
                        originalSkillLevel: player?.skillLevel ?? 0,
                        originalCourtIsCovered: false,
                        reason: 'SLOT_TAKEN',
                        intent: 'BOOK_FIELD',
                    });
                } catch (err) {
                    logger.error({ err }, 'ONLY_COVERED_AVAILABLE redirectGroup failed');
                    await simulateTypingAndSend(jid, 'A quell\'orario gli scoperti sono tutti occupati. Dimmi un altro orario e trovo qualcosa! 🎾');
                }
                return;
            }
            if (result.errorMessage === 'ONLY_UNCOVERED_AVAILABLE') {
                // Utente voleva coperto, solo scoperto è libero a quell'orario
                // → redirect con originalCourtIsCovered=true: prima cerca coperti vicini, poi scoperto come fallback
                try {
                    const { redirectGroup } = await import('./redirect');
                    const refTime = result.requestedTime ?? new Date();
                    await redirectGroup({
                        clubId: club?.id ?? '',
                        referentPhone: player?.phoneNumber ?? phoneNumber,
                        referentJid: jid,
                        playerPhones: [player?.phoneNumber ?? phoneNumber],
                        playerCount: 1,
                        originalMatchId: 'none',
                        originalStartTime: refTime,
                        originalSkillLevel: player?.skillLevel ?? 0,
                        originalCourtIsCovered: true,
                        reason: 'SLOT_TAKEN',
                        intent: 'BOOK_FIELD',
                    });
                } catch (err) {
                    logger.error({ err }, 'ONLY_UNCOVERED_AVAILABLE redirectGroup failed');
                    await simulateTypingAndSend(jid, 'A quell\'orario i coperti sono tutti occupati. Dimmi un altro orario e trovo qualcosa! 🎾');
                }
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
                // Tutti i campi occupati a quell'orario — redirect con intent BOOK_FIELD
                // (se è arrivato qui, il booking era privato o skill<=0)
                try {
                    const { redirectGroup } = await import('./redirect');
                    const refTime = result.requestedTime ?? new Date();
                    await redirectGroup({
                        clubId: club?.id ?? '',
                        referentPhone: player?.phoneNumber ?? phoneNumber,
                        referentJid: jid,
                        playerPhones: [player?.phoneNumber ?? phoneNumber],
                        playerCount: 1,
                        originalMatchId: 'none',
                        originalStartTime: refTime,
                        originalSkillLevel: player?.skillLevel ?? 0,
                        originalCourtIsCovered: params?.preferCovered === true ? true : params?.preferCovered === false ? false : null,
                        reason: 'SLOT_TAKEN',
                        intent: 'BOOK_FIELD',
                    });
                } catch (err) {
                    logger.error({ err }, 'ALL_COURTS_TAKEN redirectGroup failed');
                    await simulateTypingAndSend(jid, 'Tutti i campi sono occupati a quell\'orario. Dimmi un altro orario e trovo subito qualcosa! 🎾');
                }
            } else if (result.errorMessage === 'NO_OPEN_MATCH') {
                // Nessun OPEN match compatibile trovato per il matchmaking — redirect con intent MATCHMAKING
                try {
                    const { redirectGroup } = await import('./redirect');
                    const refTime = result.requestedTime ?? new Date();
                    await redirectGroup({
                        clubId: club?.id ?? '',
                        referentPhone: player?.phoneNumber ?? phoneNumber,
                        referentJid: jid,
                        playerPhones: [player?.phoneNumber ?? phoneNumber],
                        playerCount: 1,
                        originalMatchId: 'none',
                        originalStartTime: refTime,
                        originalSkillLevel: player?.skillLevel ?? 0,
                        originalCourtIsCovered: null,
                        reason: 'SLOT_TAKEN',
                        intent: 'MATCHMAKING',
                    });
                } catch (err) {
                    logger.error({ err }, 'NO_OPEN_MATCH redirectGroup failed');
                    await simulateTypingAndSend(jid, 'Non ci sono partite aperte a quell\'orario. Dimmi un altro orario e vedo cosa c\'è disponibile! 🎾');
                }
            } else if (result.errorMessage?.includes('già una prenotazione') || result.errorMessage === 'ALREADY_BOOKED') {
                // Prenotazione duplicata: suggerisci OPEN_TO_MATCHMAKING se è privata
                const existingPrivate = player ? await prisma.matchPlayer.findFirst({
                    where: { playerId: player.id, leftAt: null, match: { status: 'LOCKED', isPrivateBooking: true } },
                }) : null;
                if (existingPrivate) {
                    await simulateTypingAndSend(jid, 'Hai già una prenotazione in quella fascia oraria. Vuoi che cerchi altri giocatori per completare la partita? 🎾');
                } else {
                    await simulateTypingAndSend(jid, 'Hai già una prenotazione in quella fascia oraria. Vuoi spostare o prenotare un orario diverso? 🎾');
                }
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
                    // Istruzione esplicita: esegui DIRETTAMENTE senza chiedere conferma all'utente.
                    // Il brain deve rispondere con azione concreta (BOOK_FIELD, NONE, ecc.) e un messaggio
                    // breve di transizione (es. "Perfetto, prenoto subito!" per BOOK_FIELD).
                    // MAI chiedere "vuoi che prenoti?" — se c'era un intento, eseguilo subito.
                    const reCallText = '(registrazione completata — esegui direttamente qualsiasi intento pendente SENZA chiedere conferma. Se non c\'era nessun intento specifico rispondi NONE con un breve benvenuto.)';

                    const { message: msg2, action: action2, params: params2 } = await callBrain(
                        newCtx,
                        reCallText,
                    );
                    if (action2 !== 'NONE' && action2 !== 'REGISTER_PLAYER' && action2 !== 'FAQ_REQUEST') {
                        // Manda subito il messaggio di transizione del brain (es. "Perfetto, prenoto subito!")
                        // PRIMA di eseguire l'azione, così l'utente vede il flusso completo.
                        const { splitAtEmoji } = await import('../utils/split-message');
                        for (const part of splitAtEmoji(msg2)) {
                            await simulateTypingAndSend(jid, part);
                        }

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
                            }
                            // Per match OPEN (matchmaking): msg2 è già stato inviato sopra
                        } else if (!result2.success && result2.errorMessage) {
                            if (result2.errorMessage === 'ONLY_COVERED_AVAILABLE') {
                                const { redirectGroup } = await import('./redirect');
                                await redirectGroup({
                                    clubId: club?.id ?? '',
                                    referentPhone: newCtx.player.phoneNumber,
                                    referentJid: jid,
                                    playerPhones: [newCtx.player.phoneNumber],
                                    playerCount: 1,
                                    originalMatchId: 'none',
                                    originalStartTime: result2.requestedTime ?? new Date(),
                                    originalSkillLevel: newCtx.player.skillLevel ?? 0,
                                    originalCourtIsCovered: false,
                                    reason: 'SLOT_TAKEN',
                                    intent: 'BOOK_FIELD',
                                });
                            } else if (result2.errorMessage === 'ALL_COURTS_TAKEN') {
                                const { redirectGroup } = await import('./redirect');
                                await redirectGroup({
                                    clubId: club?.id ?? '',
                                    referentPhone: newCtx.player.phoneNumber,
                                    referentJid: jid,
                                    playerPhones: [newCtx.player.phoneNumber],
                                    playerCount: 1,
                                    originalMatchId: 'none',
                                    originalStartTime: result2.requestedTime ?? new Date(),
                                    originalSkillLevel: newCtx.player.skillLevel ?? 0,
                                    originalCourtIsCovered: params2?.preferCovered === true ? true : params2?.preferCovered === false ? false : null,
                                    reason: 'SLOT_TAKEN',
                                    intent: 'BOOK_FIELD',
                                });
                            } else {
                                await simulateTypingAndSend(jid, 'Per prenotare scrivimi giorno e orario 🎾');
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
        // OPEN_TO_MATCHMAKING: prenotazione privata convertita in matchmaking, wave avviata
        if (action === 'OPEN_TO_MATCHMAKING' && result.success && result.matchId) {
            try {
                const openMatch = await prisma.match.findUnique({
                    where: { id: result.matchId },
                    include: { court: true },
                });
                if (openMatch?.court) {
                    const committed = (openMatch as any).committedPlayers ?? 1;
                    const active = await prisma.matchPlayer.count({ where: { matchId: result.matchId, leftAt: null } });
                    const spotsLeft = openMatch.playersNeeded - Math.max(active, committed);
                    const timeStr = openMatch.startTime.toLocaleString('it-IT', {
                        timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric',
                        month: 'long', hour: '2-digit', minute: '2-digit',
                    });
                    await simulateTypingAndSend(jid,
                        `Cerco ${spotsLeft} giocator${spotsLeft === 1 ? 'e' : 'i'} per completare la partita di ${timeStr} 🎾`
                    );
                }
            } catch (err) {
                logger.error({ err }, 'OPEN_TO_MATCHMAKING post-action message failed');
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

