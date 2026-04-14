/**
 * RECOVERY SERVICE
 *
 * Gestisce disdette, recovery wave e match non riempibili.
 * Fix:
 * - getPlayersForRecovery importato da scoring (non più da matchmaker)
 * - notifyAdmin importato da utils/notify-admin (non da onboarding)
 * - decreaseReliability importato da scoring (non reliability.ts — eliminato)
 * - match.court → match.court?.name
 */

import { prisma } from './db';
import { simulateTypingAndSend } from './whatsapp';
import { generateInvitation } from './ai';
import { getPlayersForRecovery, decreaseReliability } from './scoring';
import { notifyAdmin } from '../utils/notify-admin';
import pino from 'pino';

const logger = pino({ level: 'info' });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

// ─────────────────────────────────────────────
// GESTIONE DISDETTA DA MATCH LOCKED
// ─────────────────────────────────────────────

export async function handleCancellation(
    senderJid: string,
    senderPhone: string,
    matchId: string,
    matchPlayerId: string,
    messageKey?: any
): Promise<void> {
    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: {
            MatchPlayer: { include: { player: true } },
            club: true,
            court: true,
        },
    });

    if (!match) return;

    const now = new Date();
    const minutesUntilMatch = (match.startTime.getTime() - now.getTime()) / 60000;
    const isLastMinute = minutesUntilMatch < 60;
    const courtName = (match.court?.name ?? 'il campo') + (match.court ? (match.court.isCovered ? ' 🏠' : ' ☀️') : '');
    const timeStr = match.startTime.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });

    // ✅ FIX N: transazione atomica — segna uscita + ricalcola posti in un'unica operazione
    // Previene race condition se due giocatori disdettano simultaneamente.
    const { spotsLeft, playerId } = await prisma.$transaction(async (tx) => {
        // Segna il giocatore come uscito
        const updated = await tx.matchPlayer.update({
            where: { id: matchPlayerId },
            data: { leftAt: now },
            select: { playerId: true },
        });

        // Ricalcola i posti rimanenti all'interno della stessa transazione
        const current = await tx.match.findUnique({
            where: { id: matchId },
            include: { MatchPlayer: { where: { leftAt: null } } },
        });
        const remaining = current ? current.MatchPlayer.length : 0;
        const spots = match.playersNeeded - remaining;

        return { spotsLeft: spots, playerId: updated.playerId };
    });

    // Penalizza score (fuori transazione — è best-effort)
    const player = await prisma.player.findUnique({ where: { id: playerId } });
    if (player) await decreaseReliability(player.id);

    await simulateTypingAndSend(
        senderJid,
        isLastMinute
            ? ["Ok, mi dispiace per la disdetta last-minute 😕 Gli altri giocatori verranno avvisati. Cerca di avvisare prima la prossima volta!", "Capito, mi dispiace per il preavviso così breve 😕 Avviso subito gli altri. La prossima volta cerca di dirlo prima!", "Preso nota, anche se un po' tardi 😕 Avviso il gruppo. Per il futuro cerca di avvisare con più anticipo!"][Math.floor(Math.random() * 3)]
            : ["Ok, capito! Cerco subito un sostituto e avviso gli altri 👍", "Tranquillo! Mi metto subito a cercare qualcuno 🔍", "Preso! Avviso il gruppo e cerco un sostituto 💪", "Ok, mi metto in moto! Cerco qualcuno per il tuo posto 🎾"][Math.floor(Math.random() * 4)],
        messageKey
    );

    if (spotsLeft <= 0) return; // ✅ FIX N: già calcolato atomicamente sopra

    // Rimetti in OPEN
    await prisma.match.update({
        where: { id: matchId },
        data: { status: 'OPEN', recoveryWaveCount: { increment: 1 } },
    });

    // Notifica gruppo WhatsApp
    if (match.groupId && !match.groupId.startsWith('WHOLE_COURT_')) {
        const urgencyMsg = isLastMinute
            ? [
                `⚠️ Disdetta dell'ultimo minuto! Stiamo cercando un sostituto in corsa — tenetevi pronti!`,
                `⚠️ Un giocatore ha appena disdetto. Ci stiamo muovendo subito per trovare qualcuno!`,
                `⚠️ Disdetta last-minute! Sto cercando un sostituto urgentemente 🔍`,
              ][Math.floor(Math.random() * 3)]
            : [
                `Un giocatore ha disdetto. Sto cercando qualcuno per completare la squadra 🔍`,
                `Aggiornamento: una disdetta — cerco subito un sostituto 🎾`,
                `Ci manca un giocatore. Sto già cercando qualcuno — a breve aggiornamenti!`,
              ][Math.floor(Math.random() * 3)];
        try {
            const { sendMessage } = await import('./whatsapp');
            await sendMessage(match.groupId, urgencyMsg);
        } catch (err) {
            logger.error({ err }, 'Failed to notify group about cancellation');
        }
    }

    await notifyAdmin(
        `⚠️ Disdetta${isLastMinute ? ' LAST-MINUTE' : ''}\n` +
        `${courtName} alle ${timeStr}\n` +
        `Da: ${senderPhone} — Posti da recuperare: ${spotsLeft}`,
        `cancellation-${matchId}`
    );

    await launchRecoveryWave(matchId, spotsLeft, isLastMinute);
}

// ─────────────────────────────────────────────
// RECOVERY WAVE
// ─────────────────────────────────────────────

export async function launchRecoveryWave(
    matchId: string,
    spotsNeeded: number,
    isUrgent: boolean = false
): Promise<void> {
    logger.info(`Recovery wave for ${matchId}, spots=${spotsNeeded}, urgent=${isUrgent}`);

    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { club: true, court: true },
    });

    if (!match || match.status !== 'OPEN') {
        logger.info(`Match ${matchId} not OPEN, aborting recovery`);
        return;
    }

    const targets = await getPlayersForRecovery(matchId);
    const courtName = (match.court?.name ?? 'il campo') + (match.court ? (match.court.isCovered ? ' 🏠' : ' ☀️') : '');

    if (targets.length === 0) {
        logger.warn(`Recovery: no players available for ${matchId}`);
        await handleMatchUnfillable(matchId);
        return;
    }

    // Stato match prima del loop — aggiornato ogni 3 invii
    let currentSpots = spotsNeeded;
    let currentStatus = 'OPEN';

    for (let i = 0; i < targets.length; i++) {
        if (currentStatus !== 'OPEN' || currentSpots <= 0) break;

        if (i % 3 === 0) {
            const snapshot = await prisma.match.findUnique({
                where: { id: matchId },
                include: { MatchPlayer: true },
            });
            if (!snapshot) break;
            currentStatus = snapshot.status;
            currentSpots = snapshot.playersNeeded - snapshot.MatchPlayer.filter(mp => !mp.leftAt).length;
            if (currentStatus !== 'OPEN' || currentSpots <= 0) break;
        }

        const player = targets[i];

        await prisma.invitation.create({
            data: { matchId, playerId: player.id, status: 'PENDING' },
        });

        const text = await generateInvitation(
            player.name || 'Amico',
            match.startTime,
            match.courtId,
            match.clubId ?? undefined,
            false
        );

        const delayMs = isUrgent ? randomInt(10, 25) * 1000 : randomInt(20, 45) * 1000;
        if (i > 0) await sleep(delayMs);

        try {
            await simulateTypingAndSend(player.phoneNumber, text);
            await prisma.player.update({
                where: { id: player.id },
                data: {
                    lastContactedAt: new Date(),
                    dailyMessagesCount: { increment: 1 },
                },
            });
        } catch (err) {
            logger.error({ err }, `Failed to send recovery message to ${player.phoneNumber}`);
        }
    }
}

// ─────────────────────────────────────────────
// MATCH NON RIEMPIBILE
// ─────────────────────────────────────────────

export async function handleMatchUnfillable(matchId: string, forceCancel: boolean = false): Promise<void> {
    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: {
            MatchPlayer: { include: { player: true } },
            club: true,
            court: true,
        },
    });

    if (!match) return;

    const now = new Date();
    const minutesUntilMatch = (match.startTime.getTime() - now.getTime()) / 60000;
    const deadlineMinutes = match.club?.deadlineMinutesBeforeMatch ?? 60;
    const courtName = (match.court?.name ?? 'il campo') + (match.court ? (match.court.isCovered ? ' 🏠' : ' ☀️') : '');
    const timeStr = match.startTime.toLocaleString('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const confirmedPlayers = match.MatchPlayer.filter(mp => !mp.leftAt);

    if (minutesUntilMatch < deadlineMinutes || forceCancel) {
        await prisma.match.update({
            where: { id: matchId },
            data: {
                status: 'CANCELLED',
                cancelledAt: now,
                cancelledReason: 'NO_PLAYERS',
            },
        });

        // Annulla le invitation PENDING prima di notificare
        const pendingInvitations = await prisma.invitation.findMany({
            where: { matchId, status: 'PENDING' },
            include: { player: true },
        });
        await prisma.invitation.updateMany({
            where: { matchId, status: 'PENDING' },
            data: { status: 'IGNORED' },
        });

        // Notifica i pending invitations: solo avviso, NO redirect
        for (const inv of pendingInvitations) {
            await sleep(randomInt(1, 3) * 1000);
            try {
                await simulateTypingAndSend(
                    inv.player.phoneNumber,
                    `${courtName} alle ${timeStr} non si gioca più 😔`
                );
            } catch (err) {
                logger.error({ err }, `Failed to notify pending invitation ${inv.player.phoneNumber}`);
            }
        }

        // Notifica i confirmed players con messaggio che motiva il redirect ("meglio una partita sicura")
        // Poi usa redirectGroup con intent MATCHMAKING (questi match sono sempre matchmaking/OPEN)
        if (confirmedPlayers.length > 0) {
            const missing = match.playersNeeded - confirmedPlayers.length;
            // Messaggi diversi: per prenotazione privata (isPrivateBooking) solo avviso,
            // per matchmaking aggiungi motivazione "meglio una partita sicura"
            for (const mp of confirmedPlayers) {
                await sleep(randomInt(2, 5) * 1000);
                try {
                    const unfillableVariants = (match as any).isPrivateBooking ? [
                        `${courtName} alle ${timeStr} — prenotazione annullata. Scrivimi quando vuoi riprenotare 🎾`,
                        `Ho liberato ${courtName} alle ${timeStr}, la prenotazione è scaduta. Scrivimi per una nuova!`,
                    ] : [
                        `${courtName} alle ${timeStr} non è andata — mancavano ${missing} ${missing === 1 ? 'giocatore' : 'giocatori'}. Ti cerco subito un'alternativa 🎾`,
                        `Partita al ${courtName} alle ${timeStr} saltata 😕 Cerco subito qualcosa di disponibile!`,
                        `Non abbiamo chiuso ${courtName} alle ${timeStr} 😔 Ti trovo un'alternativa!`,
                    ];
                    await simulateTypingAndSend(
                        mp.player.phoneNumber,
                        unfillableVariants[Math.floor(Math.random() * unfillableVariants.length)]
                    );
                } catch (err) {
                    logger.error({ err }, `Failed to notify ${mp.player.phoneNumber} of cancellation`);
                }
            }

            // redirectGroup solo per matchmaking (non prenotazioni private)
            if (!(match as any).isPrivateBooking && match.club) {
                try {
                    const { redirectGroup } = await import('./redirect');
                    await redirectGroup({
                        clubId: match.club.id,
                        referentPhone: confirmedPlayers[0].player.phoneNumber,
                        referentJid: confirmedPlayers[0].player.phoneNumber,
                        playerPhones: confirmedPlayers.map(mp => mp.player.phoneNumber),
                        playerCount: confirmedPlayers.length,
                        originalMatchId: matchId,
                        originalStartTime: match.startTime,
                        originalSkillLevel: (match as any).skillLevel ?? 0,
                        originalCourtIsCovered: match.court?.isCovered ?? null,
                        originalCourtName: match.court?.name,
                        reason: 'UNFILLED',
                        intent: 'MATCHMAKING',
                    });
                } catch (err) {
                    logger.error({ err, matchId }, 'handleMatchUnfillable: redirectGroup failed');
                }
            }
        }

        await notifyAdmin(
            `❌ Partita CANCELLATA per mancanza giocatori\n${courtName} alle ${timeStr}\n` +
            `Confermati: ${confirmedPlayers.length}/${match.playersNeeded}`,
            `unfillable-${matchId}`
        );
    } else {
        await prisma.match.update({
            where: { id: matchId },
            data: { status: 'UNFILLED' },
        });

        await notifyAdmin(
            `⚠️ Partita SENZA GIOCATORI SUFFICIENTI\n${courtName} alle ${timeStr}\n` +
            `${confirmedPlayers.length}/${match.playersNeeded} — pool esaurito. Intervento manuale.`,
            `unfilled-${matchId}`
        );
    }
}

// ─────────────────────────────────────────────
// CHECK TIMEOUT MATCH
// ─────────────────────────────────────────────

export async function checkMatchTimeouts(): Promise<void> {
    const now = new Date();

    const expiredMatches = await prisma.match.findMany({
        where: {
            status: { in: ['OPEN', 'UNFILLED'] },
            type: 'MATCH',   // lezioni e occupati non vanno in timeout
            startTime: { lt: new Date(now.getTime() + 60 * 60 * 1000) },
        },
        include: {
            MatchPlayer: { include: { player: true } },
            club: true,
            court: true,
        },
    });

    for (const match of expiredMatches) {
        const confirmed = match.MatchPlayer.filter(mp => !mp.leftAt).length;
        const deadlineMinutes = match.club?.deadlineMinutesBeforeMatch ?? 60;
        const warningMinutes = deadlineMinutes + 30; // 30 min prima del fischio finale
        const minutesUntilMatch = (match.startTime.getTime() - now.getTime()) / 60000;

        // Warning pre-timeout
        if (minutesUntilMatch < warningMinutes && minutesUntilMatch >= deadlineMinutes && confirmed < match.playersNeeded) {
            // Usa Redis per non mandare doppioni
            const { getRedis } = await import('./queue');
            const redis = getRedis();
            const warningKey = `warning:timeout:${match.id}`;
            const alreadySent = await redis.get(warningKey);

            if (!alreadySent) {
                const timeStr = match.startTime.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
                const ultCallVariants = [
                    `Ehi! Siamo in ${confirmed} su ${match.playersNeeded} per le ${timeStr} e mancano 30 minuti alla scadenza 😬 Se non troviamo nessuno a breve dovrò liberare il campo 😔`,
                    `⚠️ Mancano 30 minuti! La partita delle ${timeStr} è ancora in ${confirmed}/${match.playersNeeded} — sto cercando ma se entro poco non trovo nessuno dovrò annullare 😔`,
                    `Ultima chiamata per le ${timeStr} 🎾 Siamo in ${confirmed} su ${match.playersNeeded} — sto facendo il possibile, ma senza altri giocatori dovrò cancellare 😕`,
                ];
                const msg = ultCallVariants[Math.floor(Math.random() * ultCallVariants.length)];
                
                // Notifica referenti
                const referents = match.MatchPlayer.filter(mp => !mp.leftAt);
                for (const rp of referents) {
                    await simulateTypingAndSend(rp.player.phoneNumber, msg);
                }
                
                await redis.set(warningKey, 'sent', 'EX', 60 * 60); // Scade dopo 1h
                logger.info({ matchId: match.id }, 'Pre-timeout warning sent');
            }
        }

        if (minutesUntilMatch < deadlineMinutes && confirmed < match.playersNeeded) {
            logger.info(`Match ${match.id} timeout: ${confirmed}/${match.playersNeeded} — cancelling`);
            await handleMatchUnfillable(match.id);
        }
    }

    // Scadi invitation pendenti di match già terminati
    const expired = await prisma.invitation.updateMany({
        where: {
            status: 'PENDING',
            match: { startTime: { lt: now } },
        },
        data: { status: 'EXPIRED' },
    });

    if (expired.count > 0) {
        logger.info(`Expired ${expired.count} stale PENDING invitations`);
    }
}
