/**
 * MESSAGE HANDLER
 *
 * Riceve batch dalla inbound-queue (debounce 60s per JID).
 * Flow:
 * 1. De-LID + deduplication + persistenza + trascrizione audio
 * 2. Catena admin (approval → pending action → FAQ flow → comandi DB)
 * 3. Redirect choice → confirmRedirectChoice
 * 4. Brain (Claude Sonnet) → callBrain → executeAction (registrati e non)
 */

import { proto } from '@whiskeysockets/baileys';
import { prisma } from './db';
import { getRedis } from './queue';
import { transcribeAudio } from './ai';
import { registerBatchHandler, NormalizedMessage, extractQuotedRef } from './inbound-queue';
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

// ─── Booking card — 5 varianti (prima e ultima frase ruotano, centro fisso) ──

const _BOOKING_VARIANTS = [
    {
        mm:   { first: `*Sei in lista!*`,                last: `Ti scrivo quando siamo in 4.` },
        priv: { first: `*Prenotazione confermata.*`,     last: `A presto in campo!` },
    },
    {
        mm:   { first: `*Ci sei — cerco gli altri tre.*`, last: `Ti avviso appena siamo al completo.` },
        priv: { first: `*Campo prenotato.*`,              last: `Ci vediamo lì!` },
    },
    {
        mm:   { first: `*Dentro. Cerco i compagni.*`,   last: `Appena troviamo gli altri ti faccio sapere.` },
        priv: { first: `*Tutto confermato.*`,            last: `Buona partita!` },
    },
    {
        mm:   { first: `*Fatto, sei in lista.*`,         last: `Ti mando un messaggio quando la partita è piena.` },
        priv: { first: `*Fatto, hai il campo.*`,         last: `A presto!` },
    },
    {
        mm:   { first: `*Sei in — ora trovo gli altri.*`, last: `Appena siamo in 4 ti scrivo.` },
        priv: { first: `*Ci siamo — campo tuo.*`,        last: `Ci vediamo sul campo.` },
    },
];

function buildBookingCard(p: {
    courtName: string;
    timeStr: string;
    pricePerPerson: string | null;
    racketPrice?: string | null;
    otherPlayers?: string[];
    location?: string | null;
    waveWillStart: boolean;
}): string {
    const v = _BOOKING_VARIANTS[Math.floor(Math.random() * _BOOKING_VARIANTS.length)];
    const others = p.otherPlayers ?? [];
    const lines = p.waveWillStart ? [
        v.mm.first,
        p.timeStr,
        p.courtName,
        p.pricePerPerson ? `${p.pricePerPerson}€ a persona` : null,
        others.length > 0 ? `Già dentro: ${others.join(', ')}` : null,
        v.mm.last,
    ] : [
        v.priv.first,
        p.timeStr,
        p.courtName,
        p.pricePerPerson ? `${p.pricePerPerson}€ a persona` : null,
        p.racketPrice ? `Noleggio racchetta ${p.racketPrice}/persona` : null,
        others.length > 0 ? `Con: ${others.join(', ')}` : null,
        p.location || null,
        v.priv.last,
    ];
    return lines.filter(Boolean).join('\n');
}
type PrismaTransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

// ─────────────────────────────────────────────
// REGISTRA HANDLER
// ─────────────────────────────────────────────

registerBatchHandler(handleBatch);

// ─────────────────────────────────────────────
// BATCH HANDLER
// ─────────────────────────────────────────────

export async function handleBatch(jid: string, messages: NormalizedMessage[], retryCount = 0): Promise<void> {
    const correlationId = `${jid.split('@')[0]}-${Date.now()}`;
    // Estrai il clubId dal primo messaggio del batch (tutti appartengono allo stesso socket/club)
    const clubId = messages[0]?.clubId;
    await runWithContext({ correlationId, jid, clubId }, async () => {
        try {
            await _handleBatchInner(jid, messages, correlationId, clubId);
            conversationalPhase.delete(correlationId);
        } catch (err) {
            const isSocketError = err instanceof Error && err.message.includes('socket not available');
            if (isSocketError && retryCount === 0) {
                logger.warn({ correlationId, jid, clubId }, 'Socket unavailable — retrying batch in 90s');
                conversationalPhase.delete(correlationId);
                // I messaggi sono già stati persistiti nel primo passaggio: senza alreadyPersisted
                // il retry li scarterebbe tutti come duplicati (dedup su messageId) e la risposta
                // non partirebbe mai.
                const retryMessages = messages.map(m => ({ ...m, alreadyPersisted: true }));
                setTimeout(() => {
                    handleBatch(jid, retryMessages, 1).catch(retryErr =>
                        logger.error({ err: retryErr, correlationId }, `Retry batch also failed for ${jid}`)
                    );
                }, 90_000);
                return;
            }
            logger.error({ err, correlationId, clubId }, `Unhandled error in handleBatch for ${jid}`);
            if (clubId) {
                const { notifyAdminByClubId } = await import('../utils/notify-admin');
                notifyAdminByClubId(`🔴 Errore critico handleBatch\njid: ${jid}\n${err instanceof Error ? err.message : String(err)}`, 'critical', clubId).catch(() => {});
            }
            // Point 6: only notify user if routing already started (user expects a reply)
            if (conversationalPhase.get(correlationId)) {
                const _fallbacks = [
                    "Scusa, ho perso il filo per un attimo. Puoi ripetere?",
                    "Mi è scappato qualcosa di mano, riprova!",
                    "Non ho capito bene, puoi riscrivere?",
                    "Scusami, c'è stato un intoppo. Riesci a rimandarlo?",
                    "Ho avuto un momento di confusione, riprova pure!",
                ];
                try {
                    await simulateTypingAndSend(jid, _fallbacks[Math.floor(Math.random() * _fallbacks.length)]);
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
                            "Non riesco ad ascoltare il messaggio vocale al momento, puoi scrivermi? 😅",
                            "Non riesco ad elaborare l'audio adesso, prova a scrivere 🙉",
                            "Ho problemi con l'audio adesso, scrivimi quello che volevi dire 😅",
                            "Il vocale non passa, scrivi pure qui!",
                            "Non riesco a sentire il vocale adesso. Scrivimi e ti rispondo subito!",
                        ][Math.floor(Math.random() * 5)],
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
        const { handleAdminCommand, handleAdminFaqFlow, handleAdminPendingAction, handleApprovalCommand } = await import('./admin-commands');
        const approvalHandled = await handleApprovalCommand(combinedText, club, jid);
        if (approvalHandled) return;
        const pendingActionHandled = await handleAdminPendingAction(combinedText, club, jid);
        if (pendingActionHandled) return;

        // Admin: FAQ in sospeso PRIMA dei comandi — se c'è una domanda pending il messaggio
        // viene classificato AI contro le FAQ; solo se non gestito passa ai comandi DB
        const faqHandled = await handleAdminFaqFlow(combinedText, club, jid);
        if (faqHandled) return;

        const adminHandled = await handleAdminCommand(combinedText, club, jid);
        if (adminHandled) return;
    }

    const player = await prisma.player.findFirst({
        where: { phoneNumber: { in: phoneVariants }, clubId: resolvedClubId ? resolvedClubId : { not: '' } }
    });

    // Punto 3: un messaggio in entrata prova che il canale funziona → registra e riattiva dalla dormienza.
    if (player) {
        prisma.player.update({
            where: { id: player.id },
            data: { lastInboundAt: new Date(), dormantSince: null, consecutiveUndelivered: 0 },
        }).catch(() => { /* fire-and-forget */ });
    }

    if (!player) {
        // L'admin bypassa sempre il gate — può onboardarsi senza approvazione
        const redis = getRedis();
        const approved = isFromAdmin || await redis.get(`approval:approved:${phoneNumber}`);
        // Gate approvazione numeri sconosciuti (feature dev): attivo SOLO con APPROVAL_GATE=true
        // (staging). In produzione il flag è assente → i numeri nuovi vanno dritti al brain → REGISTER_PLAYER.
        if (process.env.APPROVAL_GATE === 'true' && !approved) {
            const alreadyPending = await redis.get(`approval:pending:${phoneNumber}`);
            if (!alreadyPending) {
                // Prima volta che scrive: notifica admin (self-chat sempre, adminPhone se abilitato) e metti in attesa
                const preview = combinedText.substring(0, 200) || '(nessun testo)';
                await redis.set(`approval:pending:${phoneNumber}`, '1', 'EX', 86400);
                await redis.set(`approval:text:${phoneNumber}`, combinedText || '', 'EX', 86400);
                await redis.set(`approval:last_pending:${club?.id || ''}`, phoneNumber, 'EX', 86400);
                const { notifyAdmin } = await import('../utils/notify-admin');
                await notifyAdmin(
                    `🔔 Numero sconosciuto: +${phoneNumber}\n📩 "${preview}"\n\nRispondi *ok ${phoneNumber}* per autorizzare.`,
                    `approval-${phoneNumber}`,
                    club?.adminPhone ?? undefined,
                    club?.name ?? undefined,
                    'players',
                ).catch(() => {});
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

    // ── Messaggio citato (reply) ─────────────────────────────────
    // Se l'utente risponde citando un messaggio precedente, il brain non saprebbe
    // a cosa si riferisce un "questo". Risaliamo al messaggio citato dal raw Baileys
    // e determiniamo l'autore (bot vs utente) dallo stanzaId nel DB.
    let quotedContext: { text: string; fromBot: boolean } | undefined;
    for (const m of textMessages) {
        const ref = extractQuotedRef(m.raw);
        if (!ref?.text && !ref?.stanzaId) continue;

        let text = ref.text;
        let fromBot = false;
        if (ref.stanzaId) {
            const quoted = await prisma.whatsAppMessage.findFirst({
                where: { messageId: ref.stanzaId },
                select: { role: true, content: true },
            });
            if (quoted) {
                fromBot = quoted.role === 'BOT';
                if (!text) text = quoted.content; // fallback se il proto non aveva testo (es. scheda con media)
            }
        }
        if (text) {
            quotedContext = { text: text.trim(), fromBot };
            break; // basta la prima citazione del batch
        }
    }

    const mappedContactCards = contactCards.map(c => ({ phone: c.contactPhone ?? undefined, name: c.contactName ?? undefined }));
    const { message, action, params, secondaryAction, secondaryParams } = await callBrain(
        brainContext,
        combinedText || '(messaggio senza testo)',
        mappedContactCards.length > 0 ? mappedContactCards : undefined,
        quotedContext,
    );

    // Se il brain restituisce un message vuoto, NON inviare il placeholder "..." (rimosso da brain.ts).
    // Con un'azione, è l'azione stessa a produrre la risposta (card di conferma, ecc.) → niente bolla.
    // Senza azione (output degenerato), manda un fallback neutro invece di lasciare l'utente senza risposta.
    let outMessage = (message ?? '').trim();
    if (!outMessage && action === 'NONE') {
        const _neutral = [
            'Dimmi pure, come posso aiutarti? 🎾',
            'Eccomi! Cosa ti serve?',
            'Sono qui, dimmi pure!',
        ];
        outMessage = _neutral[Math.floor(Math.random() * _neutral.length)];
    }
    const { splitAtEmoji } = await import('../utils/split-message');
    for (const part of splitAtEmoji(outMessage)) {
        if (!part.trim()) continue;
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

    // Salva bozza prenotazione in Redis quando il brain produce BOOK_FIELD:
    // permette di ricordare giorno/orario/formato nelle risposte successive senza ri-chiedere all'utente.
    if (action === 'BOOK_FIELD' && params?.day && params?.time && !params?.joinMatchId) {
        try {
            const { getRedis } = await import('./queue');
            await getRedis().set(
                `state:booking_intent:${jid}`,
                JSON.stringify({
                    day: params.day,
                    time: params.time,
                    preferMixed: params.preferMixed ?? null,
                    preferCovered: params.preferCovered ?? null,
                }),
                'EX', 900, // 15 minuti
            );
        } catch { /* fire-and-forget */ }
    }

    if (action !== 'NONE') {
        const result = await executeAction(action, params, player, club, phoneNumber);
        if (!result.success && result.errorMessage) {
            await handleActionError(jid, action, params, result, player, club, phoneNumber);
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
                                const totalCost = await calculateSlotCost(match2.court.id, match2.startTime, (club as any)?.matchDuration || 90);
                                const pricePerPerson = totalCost > 0 ? (totalCost / 4).toFixed(2) : null;
                                const racketPrice = (club as any)?.racketPrice != null ? `${(club as any).racketPrice}€` : null;
                                const timeStr = match2.startTime.toLocaleString('it-IT', {
                                    timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric',
                                    month: 'long', hour: '2-digit', minute: '2-digit',
                                });
                                const clubLocation = [club?.address, club?.city].filter(Boolean).join(' — ');
                                await simulateTypingAndSend(jid, buildBookingCard({
                                    courtName:    match2.court.name,
                                    timeStr,
                                    pricePerPerson,
                                    racketPrice,
                                    location:     clubLocation || null,
                                    waveWillStart: false,
                                }));
                            }
                            // Per match OPEN (matchmaking): msg2 è già stato inviato sopra
                        } else if (!result2.success && result2.errorMessage) {
                            // Catena unica: stessi messaggi/redirect del path principale
                            await handleActionError(jid, action2, params2, result2, newCtx.player, club, phoneNumber);
                        }

                        // Pulisci la bozza prenotazione: l'intento è stato gestito in questo turno
                        // (eseguito o fallito con redirect). Senza questo, una bozza pre-esistente
                        // sopravviverebbe al return e inquinerebbe i turni successivi.
                        if (action2 === 'BOOK_FIELD' || action2 === 'RESCHEDULE_MATCH') {
                            try {
                                const { getRedis } = await import('./queue');
                                await getRedis().del(`state:booking_intent:${jid}`);
                            } catch { /* fire-and-forget */ }
                        }
                    }
                }
            } catch (err) {
                logger.warn({ err }, 'Re-call brain after REGISTER_PLAYER failed — ignored');
            }
            return;
        }

        // CANCEL_MATCH: invia scheda di conferma cancellazione con giorno/ora/campo
        if (action === 'CANCEL_MATCH' && result.success && (result as any).cancelledMatchInfo) {
            try {
                const info = (result as any).cancelledMatchInfo as { startTime: Date; courtName: string | null; isCovered: boolean | null };
                const timeStr = info.startTime.toLocaleString('it-IT', {
                    timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit',
                });
                const courtPart = info.courtName
                    ? ` — ${info.courtName} (${info.isCovered ? '🏟️ coperto' : '☀️ scoperto'})`
                    : '';
                await simulateTypingAndSend(jid, `✅ Prenotazione cancellata: ${timeStr}${courtPart}`);
            } catch (err) {
                logger.error({ err }, 'CANCEL_MATCH: failed to send cancellation confirmation');
            }
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
            // Punto 1: dopo la conferma, chiedi del noleggio racchetta (matchmaking → sì/no).
            if ((club as any)?.racketPrice != null) {
                try {
                    const { racketQuestionSingle } = await import('./invitation-templates');
                    await simulateTypingAndSend(jid, racketQuestionSingle());
                } catch { /* non bloccante */ }
            }
        }

        // Booking riuscito: cancella la bozza prenotazione in sospeso
        if ((action === 'BOOK_FIELD' || action === 'RESCHEDULE_MATCH') && result.success) {
            try {
                const { getRedis } = await import('./queue');
                await getRedis().del(`state:booking_intent:${jid}`);
            } catch { /* fire-and-forget */ }
        }

        // BOOK_FIELD / RESCHEDULE_MATCH: se NO wave (match LOCKED = prenotazione privata) → scheda completa subito.
        // Se wave partirà (match OPEN = matchmaking) → il brain ha già comunicato "sto cercando giocatori";
        //   la conferma reale arriva col gruppo WA (handleMatchFilled)
        if ((action === 'BOOK_FIELD' || action === 'RESCHEDULE_MATCH') && result.success && result.matchId) {
            try {
                const match = await prisma.match.findUnique({
                    where: { id: result.matchId },
                    include: {
                        court: true,
                        MatchPlayer: {
                            where: { leftAt: null },
                            include: { player: { select: { id: true, name: true, skillLevel: true } } },
                        },
                    },
                });
                if (match?.court) {
                    const { calculateSlotCost } = await import('./pricing');
                    const totalCost = await calculateSlotCost(match.court.id, match.startTime, (club as any)?.matchDuration || 90);
                    const pricePerPerson = totalCost > 0 ? (totalCost / 4).toFixed(2) : null;
                    const racketPrice = (club as any)?.racketPrice != null ? `${(club as any).racketPrice}€` : null;
                    const timeStr = match.startTime.toLocaleString('it-IT', {
                        timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric',
                        month: 'long', hour: '2-digit', minute: '2-digit',
                    });
                    const waveWillStart = match.status === 'OPEN';

                    // Giocatori già dentro (escludo il giocatore corrente)
                    const otherPlayers = (match.MatchPlayer as any[])
                        .filter((mp: any) => mp.player?.id !== player?.id)
                        .map((mp: any) => {
                            const lvl = mp.player?.skillLevel > 0 ? ` (${Number(mp.player.skillLevel).toFixed(1)})` : '';
                            return `${mp.player?.name?.split(' ')[0] || '?'}${lvl}`;
                        });

                    await simulateTypingAndSend(jid, buildBookingCard({
                        courtName:    match.court.name,
                        timeStr,
                        pricePerPerson,
                        racketPrice,
                        otherPlayers,
                        location:     [club?.address, club?.city].filter(Boolean).join(' — ') || null,
                        waveWillStart,
                    }), undefined, { important: true });

                    // Punto 1: dopo la card, chiedi del noleggio racchetta (se il circolo lo offre).
                    // Privata → quante racchette per il gruppo; matchmaking → sì/no per il giocatore.
                    if ((club as any)?.racketPrice != null) {
                        try {
                            const { racketQuestionSingle, racketQuestionCount } = await import('./invitation-templates');
                            await simulateTypingAndSend(jid, match.isPrivateBooking ? racketQuestionCount() : racketQuestionSingle());
                        } catch { /* non bloccante */ }
                    }
                }

                // Se il giocatore preferito non è stato trovato nel circolo, avvisa l'utente
                if ((result as any).preferredNotFound) {
                    const notFoundName = (result as any).preferredNotFound;
                    await simulateTypingAndSend(jid, `${notFoundName} non risulta iscritto al circolo — ho aperto la partita per te e sto cercando altri giocatori compatibili.`);
                }

                // Nome del preferito ambiguo (più iscritti corrispondono): la partita è aperta,
                // ma per la priorità all'amico serve il nome esatto
                if ((result as any).preferredAmbiguous) {
                    const pa = (result as any).preferredAmbiguous as { name: string; candidates: string[] };
                    await simulateTypingAndSend(jid,
                        `Ho trovato più giocatori che corrispondono a "${pa.name}": ${pa.candidates.join(', ')}. La partita è aperta — dimmi nome e cognome esatti e gli do la priorità 🎾`
                    );
                }

                // Bug fix: se il player è diventato il 4° (match ora LOCKED, matchmaking) → crea gruppo WA.
                // Questo path non veniva coperto dal blocco ACCEPT_INVITATION.
                if (match?.status === 'LOCKED' && !match.isPrivateBooking && !match.groupId) {
                    await handleMatchFilled(result.matchId, match.startTime).catch(err =>
                        logger.error({ err, matchId: result.matchId }, 'handleMatchFilled after BOOK_FIELD join failed')
                    );
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
            notifyAdmin(`⚠️ OPT_OUT: ${player.name || phoneNumber} (${phoneNumber}) ha disattivato i messaggi.`, `opt-out-${phoneNumber}`, undefined, undefined, 'players').catch(() => {});
        }

        // ── Secondary FAQ detection: batch con 2+ messaggi ───────────────────────
        // Quando il brain esegue un'azione concreta (BOOK_FIELD, ACCEPT_INVITATION, ecc.)
        // ma il batch conteneva anche una domanda separata (es. "prenoto + c'è l'assicurazione?"),
        // classifichiamo ogni messaggio individuale con Haiku per rilevare intent secondari FAQ.
        // Non attiviamo se la primary era già FAQ_REQUEST, NONE o REGISTER_PLAYER.
        if (
            result.success &&
            action !== 'FAQ_REQUEST' &&
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

        // ── Secondary action dal brain (multi-intent) ────────────────────────────
        // Quando il brain rileva DUE intenti separati restituisce secondaryAction/secondaryParams.
        // Whitelist conservativa — mai azioni distruttive come OPT_OUT o REGISTER_PLAYER.
        const SECONDARY_ACTION_WHITELIST = ['BOOK_FIELD', 'CANCEL_MATCH', 'RESCHEDULE_MATCH', 'FAQ_REQUEST', 'INVITE_PREFERRED'];
        if (
            result.success &&
            secondaryAction &&
            SECONDARY_ACTION_WHITELIST.includes(secondaryAction)
        ) {
            try {
                logger.info({ primaryAction: action, secondaryAction }, 'Executing secondary action from brain');
                const secResult = await executeAction(secondaryAction, secondaryParams || {}, player, club, phoneNumber);

                if ((secondaryAction === 'BOOK_FIELD' || secondaryAction === 'RESCHEDULE_MATCH') && secResult.success && secResult.matchId) {
                    const secMatch = await prisma.match.findUnique({
                        where: { id: secResult.matchId },
                        include: { court: true, MatchPlayer: { where: { leftAt: null }, include: { player: { select: { id: true, name: true, skillLevel: true } } } } },
                    });
                    if (secMatch?.court) {
                        const { calculateSlotCost } = await import('./pricing');
                        const totalCost = await calculateSlotCost(secMatch.court.id, secMatch.startTime, (club as any)?.matchDuration || 90);
                        const pricePerPerson = totalCost > 0 ? (totalCost / 4).toFixed(2) : null;
                        const timeStr = secMatch.startTime.toLocaleString('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
                        await simulateTypingAndSend(jid, buildBookingCard({
                            courtName:    secMatch.court.name,
                            timeStr,
                            pricePerPerson,
                            location:     [club?.address, club?.city].filter(Boolean).join(' — ') || null,
                            waveWillStart: secMatch.status === 'OPEN',
                        }));
                    }
                } else if (!secResult.success && secResult.errorMessage) {
                    // Catena unica: l'azione secondaria fallita riceve gli stessi messaggi/redirect della primaria
                    await handleActionError(jid, secondaryAction, secondaryParams || {}, secResult, player, club, phoneNumber);
                }
            } catch (err) {
                logger.warn({ err, secondaryAction }, 'Secondary action from brain failed — ignored');
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
    const shortDay = startTime.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: '2-digit', month: '2-digit' });
    const courtShort = match.court?.name || 'Campo';
    const groupName = `Padel · ${shortDay} ${timeStr} · ${courtShort}`;

    // Scheda riepilogativa — unico messaggio (bolla unica via sock.sendMessage) alla creazione gruppo (Punto 4).
    // Card schematica con emoji + avviso "Importante": qui il tipo campo è ammesso (è una card, vedi Punto 5).
    const courtLabel = match.court
        ? `🎾 ${match.court.name || 'Campo'} (${match.court.isCovered ? '🏟️ coperto' : '☀️ scoperto'})`
        : '🎾 Campo';
    const GROUP_NOTICE =
        `⚠️ *Importante*\n` +
        `Questo gruppo serve solo a voi giocatori per coordinarvi.\n` +
        `Per qualsiasi cosa su campo o partita (disdette, cambi, problemi) scrivete a me in chat privata: qui nessuno del circolo legge.`;
    let confirmationMsg = `📋 *Riepilogo partita*\n📅 ${dateStr} alle ${timeStr}\n${courtLabel}\n\n${GROUP_NOTICE}`;
    try {
        const { calculateSlotCost } = await import('./pricing');
        const totalCost = await calculateSlotCost(match.court!.id, startTime, (match.club as any)?.matchDuration || 90);
        const pricePerPerson = totalCost > 0 ? (totalCost / 4).toFixed(2) : null;
        const racketPrice = (match.club as any)?.racketPrice != null ? `${(match.club as any).racketPrice}€` : null;
        const clubLocation = [(match.club as any)?.address, (match.club as any)?.city].filter(Boolean).join(' — ');
        const lines = [
            `📋 *Riepilogo partita*`,
            `📅 ${dateStr} alle ${timeStr}`,
            courtLabel,
            pricePerPerson ? `💶 ${pricePerPerson}€ a persona` : null,
            racketPrice ? `🎾 Noleggio racchetta: ${racketPrice}/persona` : null,
            clubLocation ? `📍 ${clubLocation}` : null,
        ].filter(Boolean);
        confirmationMsg = lines.join('\n') + `\n\n${GROUP_NOTICE}`;
    } catch { /* usa il fallback sopra (già con avviso) */ }

    // Filter players that have a valid JID/Phone for the WhatsApp group
    // Guests or placeholder players (with fake identifiers) won't be added to the physical group
    const playerPhones = confirmed
        .filter(mp => mp.player.phoneNumber && (mp.player.phoneNumber.length > 5)) // basic check for real phone
        .map(mp => mp.player.phoneNumber);

    try {
        const groupId = await createGroupAndAddPlayers(groupName, playerPhones, confirmationMsg);
        await prisma.match.update({ where: { id: matchId }, data: { groupId } });

        // I PENDING rimasti (invitati che NON hanno risposto) NON vengono più messi a IGNORED qui.
        // Restano PENDING: a partita giocata (LOCKED) processMatchOutcomes li conta come "fantasma"
        // (no-show) e applica la penalità piena. Prima, messi a IGNORED, sfuggivano del tutto al
        // calcolo → solo chi rispondeva veniva valutato. Restano comunque invisibili in chat/wave
        // (match LOCKED → non più OPEN). Chi prova ad accettare a match pieno → path willing-but-full.

        // NB(reliability): il segnale positivo NON viene più dato qui a partita piena.
        // Arriva UNA sola volta da processMatchOutcomes a fine partita (presenza effettiva),
        // per evitare il doppio/triplo conteggio (accept + match-pieno + outcome).

        // GAP #19: schedula reminder solo se mancano almeno 10 minuti all'orario previsto
        // (1h prima del match). Con delay=0 il reminder scatta immediatamente — sbagliato.
        const reminderTime = new Date(startTime.getTime() - 60 * 60 * 1000);
        const reminderDelay = reminderTime.getTime() - Date.now();
        if (reminderDelay > 10 * 60 * 1000) {
            reminderQueue.add('send-reminder', { matchId, groupId, timeStr }, { delay: reminderDelay })
                .catch(err => logger.warn({ err, matchId }, 'Reminder scheduling failed — will be skipped'));
        } else {
            logger.info({ matchId, reminderDelay }, 'Reminder skipped — match too close to schedule a 1h reminder');
        }

    } catch (err) {
        logger.error({ err }, `Error in closing sequence for match ${matchId}`);

        // GAP #20: fallback — se la creazione gruppo WA fallisce, notifica i giocatori individualmente
        try {
            const { simulateTypingAndSend } = await import('./whatsapp');
            const timeStr = startTime.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
            const dateStr = startTime.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric', month: 'long' });
            const firstNames = confirmed.map(mp => (mp.player.name || 'Giocatore').split(' ')[0]).join(', ');
            const _fallbackMsgs = [
                `Partita confermata! Siete in 4: ${firstNames}. Vi aspettiamo ${dateStr} alle ${timeStr} 🎾`,
                `${dateStr} alle ${timeStr}, siete al completo: ${firstNames}! Vi aspettiamo in campo 🎾`,
                `Tutto confermato! ${firstNames}, ci vediamo ${dateStr} alle ${timeStr} 🎾`,
                `Siete al completo: ${firstNames}. Appuntamento ${dateStr} alle ${timeStr}!`,
                `Partita al completo! ${firstNames}, vi aspettiamo ${dateStr} alle ${timeStr} 🎾`,
            ];
            const fallbackMsg = _fallbackMsgs[Math.floor(Math.random() * _fallbackMsgs.length)];
            for (const mp of confirmed) {
                if (mp.player.phoneNumber && !mp.player.phoneNumber.startsWith('FRIEND_')) {
                    simulateTypingAndSend(`${mp.player.phoneNumber}@s.whatsapp.net`, fallbackMsg).catch(() => {});
                }
            }
        } catch (fallbackErr) {
            logger.error({ fallbackErr }, 'handleMatchFilled: fallback individual notify also failed');
        }
    }
}


// ─────────────────────────────────────────────
// GESTIONE ESITI NEGATIVI DI executeAction
// Catena unica per tutti i path (principale, post-REGISTER_PLAYER): traduce gli
// errorMessage simbolici in messaggi utente e attiva il redirect dove previsto.
// ─────────────────────────────────────────────

export async function handleActionError(
    jid: string,
    action: string,
    params: any,
    result: { errorMessage?: string; requestedTime?: Date },
    player: any,
    club: any,
    phoneNumber: string,
): Promise<void> {
    if (!result.errorMessage) return;
    {
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
                const _msgs = [
                    "A quell'orario i campi scoperti sono tutti occupati. Dimmi un altro orario e trovo qualcosa!",
                    "I campi scoperti sono tutti pieni in quella fascia, prova un altro orario 😔",
                    "A quell'ora non c'è nessun campo scoperto libero. Ti va un campo coperto, o preferisci cambiare orario?",
                    "Campi scoperti esauriti a quell'orario, vuoi un altro orario o consideri un campo coperto? 😅",
                    "Nessun campo scoperto disponibile in quella fascia. Hai un altro orario in mente?",
                ];
                await simulateTypingAndSend(jid, _msgs[Math.floor(Math.random() * _msgs.length)]);
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
                const _msgs = [
                    "A quell'orario i campi coperti sono tutti occupati. Dimmi un altro orario e trovo qualcosa!",
                    "I campi coperti sono tutti pieni in quella fascia, prova un altro orario 😔",
                    "A quell'ora non c'è nessun campo coperto libero. Ti va un campo scoperto, o preferisci cambiare orario?",
                    "Campi coperti esauriti a quell'orario, vuoi un altro orario o consideri un campo scoperto? 😅",
                    "Nessun campo coperto disponibile in quella fascia. Hai un altro orario in mente?",
                ];
                await simulateTypingAndSend(jid, _msgs[Math.floor(Math.random() * _msgs.length)]);
            }
            return;
        }
        if (result.errorMessage.startsWith('PLAYER_NOT_FOUND:')) {
            const searchedName = result.errorMessage.split(':').slice(1).join(':').trim();
            const redis = getRedis();
            const nameKey = searchedName.toLowerCase();
            const alreadyNotified = await redis.get(`invite:admin_notified:${club?.id}:${nameKey}`);
            const clubName = club?.name || 'circolo';
            if (alreadyNotified) {
                const _alreadyMsgs = [
                    `Ho già contattato il circolo per verificare. Ti rispondo appena ho notizie!`,
                    `Ho già segnalato al circolo, appena ho una risposta te la giro!`,
                    `Il circolo è già al corrente, ti aggiorno non appena rispondo!`,
                    `Ho già mandato il messaggio al circolo. Attendo risposta per te!`,
                    `Ho già contattato il circolo, ti tengo aggiornato!`,
                ];
                await simulateTypingAndSend(jid, _alreadyMsgs[Math.floor(Math.random() * _alreadyMsgs.length)]);
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
                        'faq',
                    ).catch(() => {});
                    await redis.set(`invite:admin_notified:${club?.id}:${nameKey}`, '1', 'EX', 3600);
                    const _escalateMsgs = [
                        `Ho già contattato il circolo per verificare. Ti rispondo appena ho notizie!`,
                        `Ho già segnalato al circolo, appena ho una risposta te la giro!`,
                        `Il circolo è già al corrente, ti aggiorno non appena rispondo!`,
                        `Ho già mandato il messaggio al circolo. Attendo risposta per te!`,
                        `Ho già contattato il circolo, ti tengo aggiornato!`,
                    ];
                    await simulateTypingAndSend(jid, _escalateMsgs[Math.floor(Math.random() * _escalateMsgs.length)]);
                } else {
                    // Prima volta: informa l'utente e memorizza
                    await redis.set(`invite:not_found:${club?.id}:${nameKey}`, '1', 'EX', 3600);
                    const _notFoundMsgs = [
                        `Non trovo "${searchedName}" iscritto a ${clubName}. Sei sicuro si sia segnato così?`,
                        `"${searchedName}" non risulta nella lista di ${clubName}. Lo conosci con un altro nome?`,
                        `Non ho trovato "${searchedName}" tra gli iscritti a ${clubName}. Sei sicuro del nome?`,
                        `Il nome "${searchedName}" non mi torna tra gli iscritti a ${clubName}. Come l'hai scritto?`,
                        `Nessun "${searchedName}" nella lista di ${clubName}. Magari è iscritto con un nome diverso?`,
                    ];
                    await simulateTypingAndSend(jid, _notFoundMsgs[Math.floor(Math.random() * _notFoundMsgs.length)]);
                }
            }
        } else if (result.errorMessage.startsWith('PLAYER_AMBIGUOUS:')) {
            // Più giocatori corrispondono al nome: chiedi quale, mai invitare a caso
            const names = result.errorMessage.split(':').slice(1).join(':').split('|').filter(Boolean);
            const _ambiguousMsgs = [
                `Ho trovato più giocatori con quel nome: ${names.join(', ')}. Quale intendi? Dimmi nome e cognome e lo invito 🎾`,
                `Ce n'è più d'uno con quel nome (${names.join(', ')}) — dimmi nome e cognome esatti così non sbaglio persona 😊`,
                `Nel circolo risultano: ${names.join(', ')}. Chi di loro? Scrivimi nome e cognome e procedo 🎾`,
            ];
            await simulateTypingAndSend(jid, _ambiguousMsgs[Math.floor(Math.random() * _ambiguousMsgs.length)]);
        } else if (result.errorMessage.startsWith('NO_ACTIVE_MATCH_FOR_INVITE:')) {
            // L'amico esiste ma non c'è una partita aperta a cui agganciarlo
            const friendName = result.errorMessage.split(':').slice(1).join(':').trim() || 'il tuo amico';
            const _noMatchMsgs = [
                `${friendName} è iscritto, ma al momento non hai una partita aperta a cui aggiungerlo. Dimmi giorno e orario, apro la partita e lo invito per primo 🎾`,
                `Ho trovato ${friendName}! Però non hai partite in cerca di giocatori adesso — prenota prima un campo e lo coinvolgo subito 🎾`,
                `${friendName} c'è nella lista! Mi serve solo una partita aperta: dimmi quando volete giocare e lo invito per primo 🎾`,
            ];
            await simulateTypingAndSend(jid, _noMatchMsgs[Math.floor(Math.random() * _noMatchMsgs.length)]);
        } else if (result.errorMessage === 'ALREADY_JOINED') {
            const _alreadyMsgs = [
                "Sei già dentro a questa partita! Non devi fare altro, ci vediamo in campo 🎾",
                "Tranquillo, sei già iscritto a questa partita — è tutto a posto 🎾",
                "Ci sei già dentro! Non serve confermare di nuovo, ci vediamo in campo 🎾",
                "Sei già in questa partita, non devi fare nulla 🎾",
            ];
            await simulateTypingAndSend(jid, _alreadyMsgs[Math.floor(Math.random() * _alreadyMsgs.length)]);
        } else if (result.errorMessage === 'MATCH_CLOSED') {
            const _closedMsgs = [
                "Questa partita non è più disponibile (è stata chiusa o completata). Vuoi che cerchi un altro orario?",
                "Questa partita è già chiusa, vuoi che cerchi qualcos'altro? 😔",
                "La partita non è più disponibile, ti trovo subito un'alternativa? 😕",
                "Questa partita si è chiusa, dimmi quando sei libero e cerco 😔",
                "La partita è già chiusa. Vuoi un altro orario?",
            ];
            await simulateTypingAndSend(jid, _closedMsgs[Math.floor(Math.random() * _closedMsgs.length)]);
        } else if (result.errorMessage === 'MATCH_FULL') {
            const _fullMsgs = [
                "Questa partita si è appena riempita! Dimmi un altro orario e ti trovo posto 🎾",
                "Il posto è stato preso appena prima di te, vuoi che cerchi un'altra partita? 😔",
                "La partita si è riempita proprio adesso, dimmi quando sei libero e trovo qualcosa 😅",
                "Arrivato un attimo dopo, i posti sono finiti. Provo un altro orario? 😕",
                "Piena! Qualcuno ti ha appena superato, ti cerco subito un'altra partita? 😅",
            ];
            await simulateTypingAndSend(jid, _fullMsgs[Math.floor(Math.random() * _fullMsgs.length)]);
        } else if (result.errorMessage === 'GENDER_SLOT_FULL') {
            // Niente genere nei messaggi (scelta di prodotto): all'utente si dice solo
            // che in quella partita non c'è più posto per lui.
            const _genderMsgs = [
                "In questa partita non c'è più posto! Provo a cercartene un'altra? 🎾",
                "Ops, i posti per questa partita sono già tutti occupati. Vuoi che cerchi un altro slot? 😅",
                "Qualcuno ha appena preso l'ultimo posto disponibile. Cerco un'altra partita per te? 😕",
            ];
            await simulateTypingAndSend(jid, _genderMsgs[Math.floor(Math.random() * _genderMsgs.length)]);
        } else if (result.errorMessage === 'SKILL_TEST_REQUIRED') {
            const _skillMsgs = [
                "Per cercare altri giocatori ti serve prima la valutazione col maestro (il circolo ti contatterà per organizzarla). Nel frattempo puoi prenotare il campo privatamente!",
                "Prima di cercare altri giocatori ci vuole la valutazione col maestro, te la organizziamo noi presto. Per ora puoi prenotare il campo con chi vuoi!",
                "La valutazione col maestro è il primo passo per giocare con altri iscritti, il circolo ti contatta presto. Nel frattempo il campo è tuo quando vuoi!",
                "Non hai ancora fatto la valutazione col maestro, ti contatteranno per fissarla. Puoi già prenotare il campo nel frattempo!",
                "La valutazione col maestro è necessaria prima di cercare altri giocatori (il circolo ti raggiungerà presto). Puoi prenotare il campo privatamente da subito!",
            ];
            await simulateTypingAndSend(jid, _skillMsgs[Math.floor(Math.random() * _skillMsgs.length)]);
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
                const _msgs = [
                    "Tutti i campi sono occupati a quell'orario, dimmi un altro orario e trovo subito qualcosa 😔",
                    "A quell'orario non c'è nessun campo libero, prova con un altro orario 😔",
                    "Tutti i campi sono pieni in quella fascia. Hai un altro orario in testa?",
                    "A quell'ora sono tutti occupati, dammi un'alternativa e vedo cosa c'è 😕",
                    "Nessun campo disponibile a quell'orario, dimmi quando sei libero e trovo qualcosa 😔",
                ];
                await simulateTypingAndSend(jid, _msgs[Math.floor(Math.random() * _msgs.length)]);
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
                const _msgs = [
                    "Non ci sono partite aperte a quell'orario. Dimmi un altro orario e vedo cosa c'è disponibile!",
                    "A quell'orario non c'è nessuna partita aperta. Vuoi che apra io una per te?",
                    "Nessuna partita disponibile in quella fascia, prova un altro orario o vuoi prenotare il campo in privato? 😔",
                    "Non ho trovato partite a quell'orario, dimmi quando sei libero e cerco 😕",
                    "A quell'ora non ci sono partite disponibili. Hai un'altra fascia che preferisci?",
                ];
                await simulateTypingAndSend(jid, _msgs[Math.floor(Math.random() * _msgs.length)]);
            }
        } else if (result.errorMessage === 'NO_PRIVATE_BOOKING_TO_CONVERT') {
            const _msgs = [
                'Non trovo nessuna prenotazione privata da aprire. Hai già una partita prenotata privatamente?',
                'Non vedo prenotazioni private attive al momento. Vuoi prenotare un campo e poi cercare altri giocatori?',
                'Non ho trovato una prenotazione privata da convertire. Hai già una partita fissa o vuoi crearne una?',
                'Non risulta nessuna prenotazione privata aperta. Vuoi che prenoti il campo adesso e poi cerco altri giocatori?',
                'Non trovo partite private da aprire. Hai già prenotato qualcosa, o vuoi iniziare da zero?',
            ];
            await simulateTypingAndSend(jid, _msgs[Math.floor(Math.random() * _msgs.length)]);
        } else if (result.errorMessage === 'TOO_LATE_FOR_MATCHMAKING') {
            // La conversione a matchmaking è stata rifiutata (troppo poco tempo): la prenotazione
            // privata NON è stata toccata, resta valida. Lo comunichiamo chiaramente.
            const _msgs = [
                'Manca troppo poco all\'orario per trovare altri giocatori in tempo, quindi non apro la partita al matchmaking — ma tranquilla, il tuo campo resta prenotato! Vieni pure con chi vuoi 🎾',
                'Per cercare altri giocatori servirebbe più anticipo: così a ridosso dell\'orario rischierei di non trovarli e farti perdere il campo. La tua prenotazione resta valida, gioca con chi hai! 🎾',
                'Troppo a ridosso per il matchmaking, rischierei di lasciarti senza campo. Tengo la tua prenotazione privata così com\'è — il campo è tuo, porta chi vuoi! 🎾',
            ];
            await simulateTypingAndSend(jid, _msgs[Math.floor(Math.random() * _msgs.length)]);
        } else if (result.errorMessage === 'GENDER_UNKNOWN') {
            // Partita mista (2M+2F): serve il genere prima di aggiungerlo.
            // Al turno dopo il brain usa SAVE_GENDER e si procede.
            const _genderAskMsgs = [
                'Questa è una partita mista (2 uomini e 2 donne), quindi mi serve saperlo: sei un uomo o una donna? 😊 Appena mi rispondi ti metto dentro.',
                'Per le partite miste devo bilanciare 2 uomini e 2 donne. Essendo un assistente digitale non vorrei sbagliarmi: sei un uomo o una donna? 😊',
                'Mi manca solo un dato: questa partita è mista (2 e 2), sei un uomo o una donna? Poi ti aggiungo subito 🎾',
            ];
            await simulateTypingAndSend(jid, _genderAskMsgs[Math.floor(Math.random() * _genderAskMsgs.length)]);
        } else if (result.errorMessage === 'GENDER_MISMATCH') {
            await simulateTypingAndSend(jid, 'Questa partita è riservata a giocatori dello stesso genere, non posso aggiungerti. Vuoi che cerchi un\'altra partita o prenoti un campo libero? 🎾');
        } else if (result.errorMessage?.includes('già una prenotazione') || result.errorMessage === 'ALREADY_BOOKED') {
            // Prenotazione duplicata: suggerisci cercare altri giocatori se è privata
            const existingPrivate = player ? await prisma.matchPlayer.findFirst({
                where: { playerId: player.id, leftAt: null, match: { status: 'LOCKED', isPrivateBooking: true } },
            }) : null;
            if (existingPrivate) {
                const _bookedOpenMsgs = [
                    "Hai già una prenotazione in quella fascia. Vuoi che cerchi altri giocatori per completare la partita? 🎾",
                    "Sei già prenotato in quella fascia, vuoi che cerchi altri giocatori per completarla? 🎾",
                    "Ho già una tua prenotazione lì, vuoi che cerchi altri giocatori per completarla? 😊",
                    "Quella fascia è già tua! Vuoi che trovi altri giocatori per la partita?",
                    "Sei già dentro in quella fascia, cerco altri giocatori per completare la squadra? 🎾",
                ];
                await simulateTypingAndSend(jid, _bookedOpenMsgs[Math.floor(Math.random() * _bookedOpenMsgs.length)]);
            } else {
                const _bookedRescheduleMsgs = [
                    "Hai già una prenotazione in quella fascia. Vuoi spostare o prenotare un altro orario? 🎾",
                    "Hai già qualcosa in quella fascia, vuoi spostare o scegliere un altro orario? 😊",
                    "Quell'orario è già occupato da una tua prenotazione. Cambio orario o sposto quella?",
                    "Sei già prenotato in quella fascia! Vuoi cambiare orario?",
                    "Quella fascia è già tua, vuoi spostare la prenotazione o sceglierne un'altra? 🎾",
                ];
                await simulateTypingAndSend(jid, _bookedRescheduleMsgs[Math.floor(Math.random() * _bookedRescheduleMsgs.length)]);
            }
        } else if (/^[A-Z][A-Z0-9_]*(:.*)?$/.test(result.errorMessage)) {
            // Codice simbolico non mappato (nuovo errore interno): mai mostrarlo grezzo all'utente
            logger.warn({ action, errorMessage: result.errorMessage }, 'handleActionError: unmapped symbolic error code');
            const _genericMsgs = [
                'Non sono riuscita a completare l\'operazione, riprova tra poco!',
                'Qualcosa non è andato come previsto, riprova tra un attimo 😅',
                'Non ci sono riuscita al primo colpo — riprova tra poco e dovrebbe andare!',
            ];
            await simulateTypingAndSend(jid, _genericMsgs[Math.floor(Math.random() * _genericMsgs.length)]);
        } else {
            await simulateTypingAndSend(jid, `Ops! ${result.errorMessage} 😕`);
        }
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

