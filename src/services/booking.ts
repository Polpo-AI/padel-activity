/**
 * BOOKING SERVICE
 *
 * Gestisce il flusso quando un giocatore scrive spontaneamente
 * per prenotare una partita.
 *
 * Flusso:
 * 1. AI estrae: quante persone, fascia oraria preferita
 * 2. Cerca partite OPEN compatibili per livello e orario
 * 3. Propone opzioni con algoritmo priorità (chiusura prima)
 * 4. Se nessuna partita → chiede orario preciso → crea match → wave
 * 5. Edge case: Mario garantisce di chiudere il campo → svuota partita
 *    esistente, dirottta gli altri con redirect
 */

import { prisma } from './db';
import { getRedis } from './queue';
import { anthropic } from './ai';
import { simulateTypingAndSend } from './whatsapp';
import { findRedirectOptions, confirmRedirectChoice } from './redirect';
import { waveQueue } from './queue';
import pino from 'pino';

const logger = pino({ level: 'info' });

// ─────────────────────────────────────────────
// ESTRAI CONTESTO PRENOTAZIONE
// ─────────────────────────────────────────────

interface BookingContext {
    playerCount: number;        // quante persone (incluso Mario)
    timeSlot: 'morning' | 'afternoon' | 'evening' | 'specific' | 'unknown';
    specificTime?: string;      // es. "20:30" se specificato
    guaranteesFull: boolean;    // Mario dice "siamo già in 4" o simile
}

export async function extractBookingContext(messageText: string): Promise<BookingContext> {
    const prompt = `
Analizza questo messaggio di un giocatore di padel che vuole prenotare una partita.

Estrai le seguenti informazioni e rispondi SOLO con un JSON:
{
  "playerCount": numero intero (quante persone vengono, incluso chi scrive, default 1),
  "timeSlot": "morning" | "afternoon" | "evening" | "specific" | "unknown",
  "specificTime": "HH:MM" oppure null,
  "guaranteesFull": true se dice che sono già in 4 o che chiudono il campo da soli, false altrimenti
}

Regole per timeSlot:
- "morning": mattina, mattinata, prima delle 13
- "afternoon": pomeriggio, tra le 13 e le 18
- "evening": sera, stasera, dopo le 18
- "specific": ha dato un orario preciso
- "unknown": non specificato

Messaggio: "${messageText}"

Rispondi SOLO con il JSON.
`;

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 80,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        });

        const content = response.content[0];
        if (content.type === 'text') {
            return JSON.parse(content.text.trim());
        }
    } catch (err) {
        logger.error({ err }, 'Error extracting booking context');
    }

    return { playerCount: 1, timeSlot: 'unknown', guaranteesFull: false };
}

// ─────────────────────────────────────────────
// ENTRY POINT — avvia flusso prenotazione
// ─────────────────────────────────────────────

export async function startBookingFlow(
    jid: string,
    phoneNumber: string,
    messageText: string,
    messageKey?: any
): Promise<void> {
    const player = await prisma.player.findFirst({ where: { phoneNumber } });
    if (!player) return;

    const context = await extractBookingContext(messageText);
    logger.info(`Booking context: ${JSON.stringify(context)}`);

    // Edge case: Mario garantisce di chiudere il campo
    if (context.guaranteesFull && context.playerCount >= 4) {
        await handleGuaranteedFull(jid, phoneNumber, context, messageKey);
        return;
    }

    // Determina finestra oraria
    const now = new Date();
    const { from, to } = getTimeWindow(context, now);

    if (!from || !to) {
        // Non sappiamo l'orario — chiediamo
        await simulateTypingAndSend(
            jid,
            `Certo! A che ora vorresti giocare? ${context.playerCount > 1 ? `Siete in ${context.playerCount}` : 'Solo tu?'} 🎾`,
            messageKey
        );
        await setBookingState(jid, { ...context, step: 'AWAITING_TIME' });
        return;
    }

    // Cerca partite OPEN compatibili
    await searchAndProposeMatches(jid, player, context, from, to, messageKey);
}

// ─────────────────────────────────────────────
// CERCA E PROPONI PARTITE
// ─────────────────────────────────────────────

async function searchAndProposeMatches(
    jid: string,
    player: any,
    context: BookingContext,
    from: Date,
    to: Date,
    messageKey?: any
): Promise<void> {
    const openMatches = await prisma.match.findMany({
        where: {
            status: 'OPEN',
            skillLevel: player.skillLevel,
            startTime: { gte: from, lte: to },
        },
        include: { MatchPlayer: true, court: true },
        orderBy: [
            // Prima quelle che si chiudono aggiungendo Mario e co.
            { startTime: 'asc' },
        ],
    });

    // Filtra solo quelle con spazio sufficiente per il gruppo
    const suitable = openMatches.filter(m => {
        const spotsLeft = m.playersNeeded - m.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
        return spotsLeft >= context.playerCount;
    });

    // Ordina: prima quelle che si chiudono esattamente
    const closing = suitable.filter(m => {
        const spotsLeft = m.playersNeeded - m.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
        return spotsLeft === context.playerCount;
    });
    const notClosing = suitable.filter(m => {
        const spotsLeft = m.playersNeeded - m.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
        return spotsLeft > context.playerCount;
    });

    const ordered = [...closing, ...notClosing];

    if (ordered.length === 0) {
        // Nessuna partita disponibile — chiedi orario e crea
        const slotDescription = getSlotDescription(context.timeSlot);
        await simulateTypingAndSend(
            jid,
            `Non ho partite aperte ${slotDescription} per il tuo livello 😕 A che ora esatta vorresti giocare? Ti apro io un campo 🎾`,
            messageKey
        );
        await setBookingState(jid, { ...context, step: 'AWAITING_TIME_FOR_NEW_MATCH' });
        return;
    }

    // Costruisci messaggio con opzioni
    const options = ordered.slice(0, 5).map((m, i) => {
        const spotsLeft = m.playersNeeded - m.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
        const timeStr = m.startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
        const willLock = spotsLeft === context.playerCount;
        return `${i + 1}. ${m.court} alle ${timeStr} — ${willLock
            ? `mancate solo voi ${context.playerCount > 1 ? `${context.playerCount}` : ''}, se confermi chiudo 🔒`
            : `mancano ${spotsLeft} posti, voi ${context.playerCount > 1 ? 'entrate' : 'entri'} e cerco gli altri`
        }`;
    });

    const intro = context.playerCount > 1
        ? `Ho trovato queste partite per voi ${context.playerCount}:`
        : 'Ho trovato queste partite:';

    await simulateTypingAndSend(
        jid,
        `${intro}\n\n${options.join('\n')}\n\nQuale ti va? Dimmi il numero e ti segno subito 🎾`,
        messageKey
    );

    await setBookingState(jid, {
        ...context,
        step: 'AWAITING_MATCH_CHOICE',
        matchOptions: ordered.slice(0, 5).map(m => m.id),
    });
}

// ─────────────────────────────────────────────
// EDGE CASE: CAMPO GARANTITO
// Mario dice "siamo già in 4" → svuota una partita OPEN e dirottta gli altri
// ─────────────────────────────────────────────

async function handleGuaranteedFull(
    jid: string,
    phoneNumber: string,
    context: BookingContext,
    messageKey?: any
): Promise<void> {
    const player = await prisma.player.findFirst({ where: { phoneNumber } });
    if (!player) return;

    const now = new Date();
    const { from, to } = getTimeWindow(context, now);

    if (!from || !to) {
        await simulateTypingAndSend(
            jid,
            "Ottimo! Siete già in 4? 🎾 A che ora vorreste giocare?",
            messageKey
        );
        await setBookingState(jid, { ...context, step: 'AWAITING_TIME_FOR_GUARANTEED' });
        return;
    }

    // Cerca partita OPEN da "liberare" per Mario e i suoi
    // ✅ FIX J: filtra per clubId del player
    const targetMatch = await prisma.match.findFirst({
        where: {
            clubId: player.clubId,
            status: 'OPEN',
            skillLevel: player.skillLevel,
            startTime: { gte: from, lte: to },
        },
        include: { MatchPlayer: { include: { player: true } }, invitations: { include: { player: true } }, club: true, court: true },
        orderBy: { startTime: 'asc' },
    });

    if (!targetMatch) {
        // Nessuna partita da liberare — crea direttamente
        await simulateTypingAndSend(
            jid,
            "Non ho partite aperte in quella fascia. Vi creo io un campo 🎾 A che ora esatta?",
            messageKey
        );
        await setBookingState(jid, { ...context, step: 'AWAITING_TIME_FOR_GUARANTEED' });
        return;
    }

    // Raccogli i giocatori da spostare (confirmed + pending)
    const confirmedPlayers = targetMatch.MatchPlayer
        .filter((mp: any) => !mp.leftAt)
        .map((mp: any) => mp.player);
    const pendingPlayers = targetMatch.invitations
        .filter((inv: any) => inv.status === 'PENDING')
        .map((inv: any) => inv.player);

    const playersToRedirect = [...confirmedPlayers, ...pendingPlayers];

    if (playersToRedirect.length === 0) {
        // Partita vuota — assegna direttamente a Mario
        await assignMatchToGroup(targetMatch.id, jid, phoneNumber, context);
        return;
    }

    // Svuota la partita
    await prisma.matchPlayer.updateMany({
        where: { matchId: targetMatch.id, leftAt: null },
        data: { leftAt: new Date() },
    });
    await prisma.invitation.updateMany({
        where: { matchId: targetMatch.id, status: 'PENDING' },
        data: { status: 'IGNORED' },
    });

    // Assegna la partita a Mario e gruppo
    await assignMatchToGroup(targetMatch.id, jid, phoneNumber, context);

    // Dirottta i giocatori rimossi con algoritmo redirect
    if (playersToRedirect.length > 0) {
        const referent = playersToRedirect[0];
        const { redirectGroup } = await import('./redirect');
        await redirectGroup({
            clubId: targetMatch.clubId || '',
            referentPhone: referent.phoneNumber,
            referentJid: referent.phoneNumber,
            playerPhones: playersToRedirect.map((p: any) => p.phoneNumber),
            playerCount: playersToRedirect.length,
            originalMatchId: targetMatch.id,
            originalStartTime: targetMatch.startTime,
            reason: 'CANCELLATION',
        });
    }

    const timeStr = targetMatch.startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    await simulateTypingAndSend(
        jid,
        `Perfetto! Ho riservato il ${targetMatch.court?.name || "Campo"} alle ${timeStr} per voi 4 🎾 Confermate e chiudiamo!`,
        messageKey
    );
}

async function assignMatchToGroup(
    matchId: string,
    referentJid: string,
    referentPhone: string,
    context: BookingContext
): Promise<void> {
    const player = await prisma.player.findFirst({ where: { phoneNumber: referentPhone } });
    if (!player) return;

    await prisma.matchPlayer.create({ data: { matchId, playerId: player.id } });
    await prisma.invitation.create({
        data: { matchId, playerId: player.id, status: 'ACCEPTED' },
    });

    // Salva stato per raccogliere i numeri degli altri del gruppo
    await setBookingState(referentJid, {
        ...context,
        step: 'AWAITING_GROUP_CARDS',
        matchId,
        collectedCount: 1,
    });

    await simulateTypingAndSend(
        referentJid,
        `Ti ho segnato! Mandami i contatti degli altri ${context.playerCount - 1} e chiudo il campo 🎾`
    );
}

// ─────────────────────────────────────────────
// CONTINUAZIONE FLUSSO BOOKING
// ─────────────────────────────────────────────

export async function continueBookingFlow(
    jid: string,
    messageText: string,
    contactInfo: { phone?: string; name?: string } | null,
    state: any,
    messageKey?: any
): Promise<void> {
    const phoneNumber = jid.split('@')[0];
    const player = await prisma.player.findFirst({ where: { phoneNumber } });
    if (!player) return;

    if (state.step === 'AWAITING_TIME' || state.step === 'AWAITING_TIME_FOR_NEW_MATCH') {
        // Estrai orario dal testo
        const timeContext = await extractBookingContext(messageText);
        const now = new Date();
        const { from, to } = getTimeWindow(timeContext, now);

        if (!from) {
            await simulateTypingAndSend(jid, "Non ho capito l'orario 😅 Prova con qualcosa tipo \"20:30\" o \"stasera alle 20\"", messageKey);
            return;
        }

        if (state.step === 'AWAITING_TIME_FOR_NEW_MATCH') {
            await createNewMatch(jid, player, from, state.playerCount, messageKey);
        } else {
            await searchAndProposeMatches(jid, player, state, from, to!, messageKey);
        }
        await clearBookingState(jid);
        return;
    }

    if (state.step === 'AWAITING_MATCH_CHOICE') {
        // Risolvi scelta con AI
        const matchIds: string[] = state.matchOptions || [];
        const matches = await prisma.match.findMany({
            where: { id: { in: matchIds } },
            include: { MatchPlayer: true, court: true },
        });

        const choiceIndex = await resolveMatchChoice(messageText, matches);
        if (choiceIndex === null) {
            await simulateTypingAndSend(jid, "Non ho capito quale partita vuoi 😅 Dimmi il numero (es. \"la prima\", \"2\")", messageKey);
            return;
        }

        const chosenMatch = matches[choiceIndex];
        await addPlayerToMatch(jid, player, chosenMatch.id, state.playerCount, messageKey);
        await clearBookingState(jid);
        return;
    }

    if (state.step === 'AWAITING_GROUP_CARDS') {
        // Raccoglie card contatti del gruppo di Mario
        if (contactInfo?.phone) {
            await addFriendToMatch(jid, contactInfo.phone, contactInfo.name, state.matchId, messageKey);
            const newCount = state.collectedCount + 1;

            if (newCount >= state.playerCount) {
                await simulateTypingAndSend(jid, "Perfetto! Siete tutti segnati 🎾 Campo chiuso!", messageKey);
                await clearBookingState(jid);
            } else {
                await setBookingState(jid, { ...state, collectedCount: newCount });
                await simulateTypingAndSend(
                    jid,
                    `${newCount}/${state.playerCount} ricevuti. Mandami ancora ${state.playerCount - newCount} contatt${state.playerCount - newCount === 1 ? 'o' : 'i'} 👋`,
                    messageKey
                );
            }
        } else {
            await simulateTypingAndSend(jid, "Mandami i contatti come card WhatsApp o con il numero (es. +393471234567) 😊", messageKey);
        }
        return;
    }

    if (state.step === 'AWAITING_TIME_FOR_GUARANTEED') {
        const timeContext = await extractBookingContext(messageText);
        const now = new Date();
        const { from } = getTimeWindow(timeContext, now);

        if (!from) {
            await simulateTypingAndSend(jid, "Non ho capito l'orario 😅 Prova con qualcosa tipo \"20:30\"", messageKey);
            return;
        }

        await handleGuaranteedFull(jid, phoneNumber, { ...state, specificTime: from.toTimeString() }, messageKey);
        await clearBookingState(jid);
    }
}

// ─────────────────────────────────────────────
// CREA NUOVA PARTITA
// ─────────────────────────────────────────────

async function createNewMatch(
    jid: string,
    player: any,
    startTime: Date,
    playerCount: number,
    messageKey?: any
): Promise<void> {
    // ✅ FIX J/M: usa clubId dal player — non findFirst()
    const clubId = player.clubId;

    // Assegna il primo campo disponibile del club in quell'orario
    const occupiedCourtIds = await prisma.match.findMany({
        where: { clubId, status: { in: ['OPEN', 'LOCKED'] }, startTime },
        select: { courtId: true },
    });
    const occupiedIds = occupiedCourtIds.map(m => m.courtId).filter(Boolean);
    const freeCourt = await prisma.court.findFirst({
        where: { clubId, active: true, id: { notIn: occupiedIds as string[] } },
        orderBy: { name: 'asc' },
    });

    const match = await prisma.match.create({
        data: {
            clubId,
            courtId: freeCourt?.id,
            
            startTime,
            skillLevel: player.skillLevel,
            playersNeeded: 4,
            status: 'OPEN',
        },
    });

    await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: player.id } });
    await prisma.invitation.create({ data: { matchId: match.id, playerId: player.id, status: 'ACCEPTED' } });

    const spotsNeeded = 4 - playerCount;
    if (spotsNeeded > 0) {
        await waveQueue.add('process-wave', {
            matchId: match.id,
            waveNumber: 1,
            limit: spotsNeeded,
        }, {
            delay: Math.floor(Math.random() * 60000) + 30000,
        });
    }

    const timeStr = startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    await simulateTypingAndSend(
        jid,
        `Fatto! Ho aperto una partita alle ${timeStr} 🎾 ${spotsNeeded > 0 ? `Cerco altri ${spotsNeeded} giocatori e ti aggiorno!` : 'Siete al completo!'}`,
        messageKey
    );
}

// ─────────────────────────────────────────────
// AGGIUNGI GIOCATORE A PARTITA
// ─────────────────────────────────────────────

async function addPlayerToMatch(
    jid: string,
    player: any,
    matchId: string,
    playerCount: number,
    messageKey?: any
): Promise<void> {
    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: true, court: true },
    });

    if (!match || match.status !== 'OPEN') {
        await simulateTypingAndSend(jid, "Mi dispiace, quella partita si è nel frattempo chiusa! Vuoi cercarne un'altra?", messageKey);
        return;
    }

    await prisma.matchPlayer.upsert({
        where: { matchId_playerId: { matchId, playerId: player.id } },
        create: { matchId, playerId: player.id },
        update: {},
    });

    // Cerca invitation esistente, aggiorna o crea — upsert con id UUID non funziona
    const existingInv = await prisma.invitation.findFirst({
        where: { matchId, playerId: player.id },
        orderBy: { sentAt: 'desc' },
    });
    if (existingInv) {
        await prisma.invitation.update({
            where: { id: existingInv.id },
            data: { status: 'ACCEPTED', respondedAt: new Date() },
        });
    } else {
        await prisma.invitation.create({
            data: { matchId, playerId: player.id, status: 'ACCEPTED', respondedAt: new Date() },
        });
    }

    const timeStr = match.startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const spotsLeft = match.playersNeeded - match.MatchPlayer.filter((mp: any) => !mp.leftAt).length - 1;
    await simulateTypingAndSend(
        jid,
        `Perfetto! Ti ho segnato per le ${timeStr} 🎾 ${spotsLeft > 0 ? `Mancano ancora ${spotsLeft} giocatori, ti aggiorno!` : 'Siete al completo!'}`,
        messageKey
    );
}

async function addFriendToMatch(
    referentJid: string,
    friendPhone: string,
    friendName: string | undefined,
    matchId: string,
    messageKey?: any
): Promise<void> {
    let friend = await prisma.player.findFirst({ where: { phoneNumber: friendPhone } });

    if (!friend) {
        const referentPlayer = await prisma.player.findFirst({ where: { phoneNumber: referentJid.split('@')[0] } });
        friend = await prisma.player.create({
            data: {
                phoneNumber: friendPhone,
                name: friendName || null,
                skillLevel: referentPlayer?.skillLevel ?? 3,
                active: true,
            },
        });
    }

    await prisma.matchPlayer.upsert({
        where: { matchId_playerId: { matchId, playerId: friend.id } },
        create: { matchId, playerId: friend.id },
        update: {},
    });
}

// ─────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────

function getTimeWindow(
    context: BookingContext,
    now: Date
): { from: Date | null; to: Date | null } {
    const today = new Date(now);

    if (context.specificTime) {
        const [h, m] = context.specificTime.split(':').map(Number);
        const specific = new Date(today);
        specific.setHours(h, m, 0, 0);
        return {
            from: new Date(specific.getTime() - 30 * 60 * 1000),
            to: new Date(specific.getTime() + 30 * 60 * 1000),
        };
    }

    const slots: Record<string, { from: number; to: number }> = {
        morning: { from: 7, to: 13 },
        afternoon: { from: 13, to: 18 },
        evening: { from: 18, to: 23 },
    };

    const slot = slots[context.timeSlot];
    if (!slot) return { from: null, to: null };

    const from = new Date(today);
    from.setHours(slot.from, 0, 0, 0);
    const to = new Date(today);
    to.setHours(slot.to, 0, 0, 0);

    return { from, to };
}

function getSlotDescription(timeSlot: string): string {
    const desc: Record<string, string> = {
        morning: 'stamattina',
        afternoon: 'questo pomeriggio',
        evening: 'stasera',
        unknown: 'in questo momento',
    };
    return desc[timeSlot] || '';
}

async function resolveMatchChoice(text: string, matches: any[]): Promise<number | null> {
    const { anthropic } = await import('./ai');
    const list = matches.map((m, i) =>
        `${i + 1}. ${m.court} alle ${m.startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`
    ).join('\n');

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 5,
            temperature: 0,
            messages: [{
                role: 'user',
                content: `Lista opzioni:\n${list}\n\nL'utente ha risposto: "${text}"\n\nQuale numero ha scelto? Rispondi SOLO con il numero o UNCLEAR.`,
            }],
        });

        const content = response.content[0];
        if (content.type === 'text') {
            const val = content.text.trim();
            if (val === 'UNCLEAR') return null;
            const idx = parseInt(val) - 1;
            if (idx >= 0 && idx < matches.length) return idx;
        }
    } catch (err) {
        logger.error({ err }, 'Error resolving match choice');
    }

    return null;
}

// ─────────────────────────────────────────────
// STATO BOOKING
// ─────────────────────────────────────────────

// ✅ FIX L: stato BOOKING_FLOW su Redis invece di WhatsAppMessage
export async function setBookingState(jid: string, data: any): Promise<void> {
    try {
        const redis = getRedis();
        await redis.set(
            `state:booking:${jid}`,
            JSON.stringify(data),
            'EX', 24 * 60 * 60
        );
    } catch (err) {
        logger.error({ err, jid }, 'Failed to save booking state to Redis');
    }
}

export async function getBookingState(jid: string): Promise<any | null> {
    try {
        const redis = getRedis();
        const raw = await redis.get(`state:booking:${jid}`);
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (err) {
        logger.error({ err, jid }, 'Failed to read booking state from Redis');
        return null;
    }
}

export async function clearBookingState(jid: string): Promise<void> {
    try {
        const redis = getRedis();
        await redis.del(`state:booking:${jid}`);
    } catch (err) {
        logger.error({ err, jid }, 'Failed to clear booking state from Redis');
    }
}
