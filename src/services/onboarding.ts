/**
 * ONBOARDING
 *
 * ✅ FIX CRITICITÀ B (Redis State):
 *    getAwaitingState / setAwaitingState / clearAwaitingState ora usano Redis
 *    con TTL 24h invece di query WhatsAppMessage su DB.
 *    Chiavi: `state:awaiting:{jid}` — zero query DB per gestire lo stato.
 *
 * Il resto del flusso (processFriendPhone, processFriendLevel, ecc.)
 * rimane invariato — solo la persistenza dello stato cambia.
 */

import { prisma } from './db';
import { getRedis } from './queue';
import { simulateTypingAndSend, sendMessage } from './whatsapp';
import { extractPhoneNumber, extractSkillLevel } from './ai';
import pino from 'pino';

const logger = pino({ level: 'info' });

const STATE_TTL_SEC = 24 * 60 * 60; // 24h
const AWAITING_ROLES = ['AWAITING_FRIEND_PHONE', 'AWAITING_GROUP_PHONES', 'AWAITING_FRIEND_LEVEL'] as const;
type AwaitingRole = typeof AWAITING_ROLES[number];

// ─────────────────────────────────────────────
// GESTIONE "PORTO UN AMICO"
// ─────────────────────────────────────────────

export async function handleBringFriend(
    senderJid: string,
    senderPhone: string,
    matchId: string,
    spotsAvailable: number,
    messageKey?: any
): Promise<void> {
    if (spotsAvailable <= 0) {
        await simulateTypingAndSend(
            senderJid,
            "Mi dispiace, il campo è già pieno! Se il tuo amico vuole, lo aggiungo alla lista per la prossima partita 🙏",
            messageKey
        );
        return;
    }

    await simulateTypingAndSend(
        senderJid,
        `Figurati, più siamo meglio è! 🎾 Mandami il numero del tuo amico (con prefisso, es. +393471234567) e lo aggiungo subito.`,
        messageKey
    );

    // ✅ FIX B: salva su Redis invece di WhatsAppMessage
    await setAwaitingState(senderJid, 'AWAITING_FRIEND_PHONE', {
        matchId,
        spotsAvailable,
        invitedByPhone: senderPhone,
    });
}

// ─────────────────────────────────────────────
// GESTIONE "PORTO UN GRUPPO"
// ─────────────────────────────────────────────

export async function handleBringGroup(
    senderJid: string,
    senderPhone: string,
    matchId: string,
    spotsAvailable: number,
    messageKey?: any
): Promise<void> {
    if (spotsAvailable <= 1) {
        await simulateTypingAndSend(
            senderJid,
            `Purtroppo rimane solo ${spotsAvailable} posto libero. Vuoi venire tu solo, o preferisci aspettare una partita con più spazio?`,
            messageKey
        );
        return;
    }

    await simulateTypingAndSend(
        senderJid,
        `Ottimo, più siamo meglio è! Quanti siete in totale? Abbiamo ${spotsAvailable} posti liberi. Mandami i numeri uno alla volta e li aggiungo tutti.`,
        messageKey
    );

    await setAwaitingState(senderJid, 'AWAITING_GROUP_PHONES', {
        matchId,
        spotsAvailable,
        invitedByPhone: senderPhone,
        collected: [],
    });
}

// ─────────────────────────────────────────────
// GESTIONE "PRENOTA TUTTO IL CAMPO"
// ─────────────────────────────────────────────

export async function handleWholeCourt(
    senderJid: string,
    senderPhone: string,
    matchId: string,
    messageKey?: any
): Promise<void> {
    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: true, club: true },
    });

    if (!match || match.status !== 'OPEN') {
        await simulateTypingAndSend(senderJid, "Mi dispiace, questa partita non è più disponibile!", messageKey);
        return;
    }

    const player = await prisma.player.findUnique({ where: { phoneNumber: senderPhone } });
    if (!player) return;

    await prisma.match.update({
        where: { id: matchId },
        data: {
            status: 'LOCKED',
            groupId: `WHOLE_COURT_${player.id}`,
        },
    });

    const confirmedCount = match.MatchPlayer.length;
    const spotsLeft = match.playersNeeded - confirmedCount;
    const timeStr = match.startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

    await notifyAdmin(
        match.club,
        `🎾 Campo prenotato interamente!\nPartita: ${(match as any).court} alle ${timeStr}\nPrenotato da: ${player.name || senderPhone}\nPosti occupati: ${spotsLeft} aggiuntivi (nessuna verifica richiesta)`
    );

    await simulateTypingAndSend(
        senderJid,
        `Perfetto! Ho bloccato tutti i posti per voi. Vi aspettiamo! 🎾 Il circolo riceverà una notifica.`,
        messageKey
    );
}

// ─────────────────────────────────────────────
// PROCESSAMENTO NUMERO AMICO
// ─────────────────────────────────────────────

export async function processFriendPhone(
    senderJid: string,
    messageText: string,
    pendingState: { matchId: string; spotsAvailable: number; invitedByPhone: string },
    messageKey?: any,
    contactInfo?: { phone?: string | null; name?: string | null }
): Promise<void> {
    const { matchId, invitedByPhone } = pendingState;

    const friendPhone = contactInfo?.phone || await extractPhoneNumber(messageText);
    if (!friendPhone) {
        await simulateTypingAndSend(
            senderJid,
            "Non ho trovato un numero valido nel messaggio. Mandamelo nel formato +393471234567 😊",
            messageKey
        );
        return;
    }

    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: true, club: true },
    });

    if (!match || match.status !== 'OPEN') {
        await simulateTypingAndSend(senderJid, "Mi dispiace, la partita si è nel frattempo riempita!", messageKey);
        await clearAwaitingState(senderJid);
        return;
    }

    const spotsLeft = match.playersNeeded - match.MatchPlayer.length;
    if (spotsLeft <= 0) {
        await simulateTypingAndSend(senderJid, "Ops, qualcuno ha preso l'ultimo posto proprio adesso! 😅", messageKey);
        await clearAwaitingState(senderJid);
        return;
    }

    const existingPlayer = await prisma.player.findUnique({ where: { phoneNumber: friendPhone } });
    const invitedByPlayer = await prisma.player.findUnique({ where: { phoneNumber: invitedByPhone } });

    if (existingPlayer) {
        const alreadyIn = await prisma.matchPlayer.findUnique({
            where: { matchId_playerId: { matchId, playerId: existingPlayer.id } },
        });

        if (alreadyIn) {
            await simulateTypingAndSend(senderJid, `${existingPlayer.name || 'Il tuo amico'} è già nella partita! 🎾`, messageKey);
        } else {
            await prisma.matchPlayer.create({ data: { matchId, playerId: existingPlayer.id } });
            await prisma.invitation.create({
                data: { matchId, playerId: existingPlayer.id, status: 'ACCEPTED', isFriendInvite: true, invitedById: invitedByPlayer?.id },
            });

            const timeStr = match.startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
            await simulateTypingAndSend(
                friendPhone,
                `Ciao ${existingPlayer.name || ''}! Ti ha aggiunto alla partita di padel ${(match as any).court} alle ${timeStr}. Ci vediamo lì! 🎾`
            );

            await simulateTypingAndSend(senderJid, `✅ ${existingPlayer.name || friendPhone} aggiunto! Ci vediamo in campo 🎾`, messageKey);

            await notifyAdmin(
                match.club,
                `👤 Nuovo giocatore aggiunto a partita\nPartita: ${(match as any).court} ${match.startTime.toLocaleTimeString('it-IT')}\nAggiunto: ${existingPlayer.name || friendPhone} (${friendPhone})\nPortato da: ${invitedByPhone}\n➡️ Aggiungere al gruppo WhatsApp del livello appropriato`
            );
        }
    } else {
        await prisma.pendingOnboarding.create({
            data: {
                matchId,
                phoneNumber: friendPhone,
                invitedByPlayerId: invitedByPlayer?.id || '',
            },
        });

        await simulateTypingAndSend(
            senderJid,
            `Ottimo! ${friendPhone} non è ancora nel sistema. Che livello ha? (principiante, intermedio, avanzato)`,
            messageKey
        );

        // ✅ FIX B: aggiorna stato Redis con nuovo role
        await setAwaitingState(senderJid, 'AWAITING_FRIEND_LEVEL', {
            matchId,
            friendPhone,
            invitedByPhone,
        });
        return; // non fare clearAwaitingState — aspettiamo il livello
    }

    await clearAwaitingState(senderJid);
}

// ─────────────────────────────────────────────
// PROCESSAMENTO LIVELLO AMICO
// ─────────────────────────────────────────────

export async function processFriendLevel(
    senderJid: string,
    messageText: string,
    pendingState: { matchId: string; friendPhone: string; invitedByPhone: string },
    messageKey?: any
): Promise<void> {
    const { matchId, friendPhone, invitedByPhone } = pendingState;
    const skillLevel = await extractSkillLevel(messageText);

    const invitedByPlayer = await prisma.player.findUnique({ where: { phoneNumber: invitedByPhone } });

    const newPlayer = await prisma.player.create({
        data: {
            phoneNumber: friendPhone,
            skillLevel: skillLevel as any,
            dailyMessagesCount: 0,
        },
    });

    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: true, club: true },
    });

    if (!match || match.status !== 'OPEN') {
        await simulateTypingAndSend(senderJid, "Mi dispiace, la partita si è riempita nel frattempo!", messageKey);
        await clearAwaitingState(senderJid);
        return;
    }

    await prisma.matchPlayer.create({ data: { matchId, playerId: newPlayer.id } });
    await prisma.invitation.create({
        data: { matchId, playerId: newPlayer.id, status: 'ACCEPTED', isFriendInvite: true, invitedById: invitedByPlayer?.id },
    });

    await prisma.pendingOnboarding.updateMany({
        where: { matchId, phoneNumber: friendPhone, resolved: false },
        data: { resolved: true, skillLevel: skillLevel as any },
    });

    const timeStr = match.startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    await simulateTypingAndSend(
        friendPhone,
        `Ciao! Sei stato aggiunto a una partita di padel 🎾 ${(match as any).court} alle ${timeStr}. Ci vediamo lì!`
    );

    await simulateTypingAndSend(senderJid, `✅ Perfetto! Il tuo amico è stato aggiunto. Ci vediamo in campo! 🎾`, messageKey);

    await notifyAdmin(
        match.club,
        `👤 Nuovo giocatore onboardato\nTelefono: ${friendPhone}\nLivello assegnato: ${skillLevel}\nPartita: ${(match as any).court} ${match.startTime.toLocaleTimeString('it-IT')}\nPortato da: ${invitedByPhone}\n➡️ Aggiungere al gruppo WhatsApp livello: ${skillLevel}`
    );

    await clearAwaitingState(senderJid);
}

// ─────────────────────────────────────────────
// OPT-OUT
// ─────────────────────────────────────────────

export async function handleOptOut(senderJid: string, senderPhone: string, messageKey?: any): Promise<void> {
    await prisma.player.updateMany({
        where: { phoneNumber: senderPhone },
        data: { active: false },
    });

    await simulateTypingAndSend(
        senderJid,
        "Ok, ti ho rimosso dalla lista 👋 Se cambi idea scrivimi e ti riaggiungo in qualsiasi momento!",
        messageKey
    );
}

// ─────────────────────────────────────────────
// ✅ FIX B: STATO CONVERSAZIONALE SU REDIS (era DB)
// Chiave: state:awaiting:{jid}
// ─────────────────────────────────────────────

function awaitingKey(jid: string): string {
    return `state:awaiting:${jid}`;
}

async function setAwaitingState(jid: string, role: AwaitingRole, data: object): Promise<void> {
    try {
        const redis = getRedis();
        await redis.set(awaitingKey(jid), JSON.stringify({ role, data }), 'EX', STATE_TTL_SEC);
        logger.debug({ jid, role }, 'Awaiting state saved to Redis');
    } catch (err) {
        logger.error({ err, jid }, 'Failed to save awaiting state to Redis');
    }
}

export async function getAwaitingState(senderJid: string): Promise<{ role: string; data: any } | null> {
    try {
        const redis = getRedis();
        const raw = await redis.get(awaitingKey(senderJid));
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (err) {
        logger.error({ err, jid: senderJid }, 'Failed to read awaiting state from Redis');
        return null;
    }
}

export async function clearAwaitingState(senderJid: string): Promise<void> {
    try {
        const redis = getRedis();
        await redis.del(awaitingKey(senderJid));
        logger.debug({ jid: senderJid }, 'Awaiting state cleared from Redis');
    } catch (err) {
        logger.error({ err, jid: senderJid }, 'Failed to clear awaiting state from Redis');
    }
}

// ─────────────────────────────────────────────
// UTILITY: notifica admin
// ─────────────────────────────────────────────

export async function notifyAdmin(club: any, message: string): Promise<void> {
    if (!club?.adminPhone) return;
    try {
        await sendMessage(club.adminPhone, `[POLPO BOT]\n${message}`);
        logger.info(`Admin notified: ${message.substring(0, 50)}...`);
    } catch (err) {
        logger.error({ err }, 'Failed to notify admin');
    }
}
