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
import { formatMatchSlot } from '../utils/format-match';
import pino from 'pino';

const logger = pino({ level: 'info' });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

// Tetto al numero di cicli di recovery per una stessa partita: oltre questo la consideriamo
// non riempibile invece di rilanciare all'infinito (gruppi instabili che entrano/escono).
const MAX_RECOVERY_WAVES = 3;

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

    // Tetto recovery: se abbiamo già rilanciato MAX_RECOVERY_WAVES volte, non insistere all'infinito
    // → tratta la partita come non riempibile (cancella + notifica) invece di riaprirla di nuovo.
    if (match.recoveryWaveCount >= MAX_RECOVERY_WAVES) {
        logger.warn({ matchId, recoveryWaveCount: match.recoveryWaveCount }, `Recovery cap (${MAX_RECOVERY_WAVES}) raggiunto — match non riempibile`);
        await handleMatchUnfillable(matchId);
        return;
    }

    // Rimetti in OPEN
    await prisma.match.update({
        where: { id: matchId },
        data: { status: 'OPEN', recoveryWaveCount: { increment: 1 } },
    });

    // Notifica gruppo WhatsApp
    if (match.groupId && !match.groupId.startsWith('WHOLE_COURT_')) {
        const urgencyMsg = isLastMinute
            ? [
                `⚠️ Disdetta dell'ultimo minuto! Stiamo cercando un sostituto in corsa, tenetevi pronti!`,
                `⚠️ Un giocatore ha appena disdetto. Ci stiamo muovendo subito per trovare qualcuno!`,
                `⚠️ Disdetta last-minute! Sto cercando un sostituto urgentemente 🔍`,
                `⚠️ Disdetta all'ultimo! Mi sto muovendo subito per trovare qualcuno 🔍`,
                `⚠️ Un posto si è liberato all'improvviso, cerco subito un sostituto!`,
              ][Math.floor(Math.random() * 5)]
            : [
                `Un giocatore ha disdetto. Sto cercando qualcuno per completare la squadra 🔍`,
                `Aggiornamento: una disdetta, cerco subito qualcuno per completare la squadra 🎾`,
                `Ci manca un giocatore. Sto già cercando qualcuno, a breve aggiornamenti!`,
                `Disdetta nel gruppo, mi metto subito a cercare qualcuno 🔍`,
                `Un posto si è liberato. Sto cercando qualcuno, vi aggiorno presto!`,
              ][Math.floor(Math.random() * 5)];
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

    // Follow-up: se dopo questo giro restano posti e la partita è ancora OPEN, programma una wave
    // normale (candidati freschi, esclude chi ha già un invito pendente) con un breve delay.
    // Senza questo, una recovery in cui tutti ignorano resterebbe ferma fino al cron checkSilentMatches.
    try {
        const after = await prisma.match.findUnique({
            where: { id: matchId },
            include: { MatchPlayer: { where: { leftAt: null } } },
        });
        if (after && after.status === 'OPEN' && after.MatchPlayer.length < after.playersNeeded) {
            const { waveQueue } = await import('./queue');
            const followUpDelayMs = isUrgent ? 5 * 60 * 1000 : 15 * 60 * 1000;
            waveQueue.add('process-wave', {
                matchId,
                waveNumber: after.recoveryWaveCount + 1,
                scheduledAt: Date.now() + followUpDelayMs,
            }, { delay: followUpDelayMs }).catch(err => logger.warn({ err, matchId }, 'Recovery follow-up wave scheduling failed'));
        }
    } catch (err) {
        logger.warn({ err, matchId }, 'Recovery follow-up check failed');
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
    if (match.status === 'ARCHIVED') {
        logger.debug({ matchId }, 'handleMatchUnfillable: match già archiviato — skip');
        return;
    }

    const now = new Date();
    const minutesUntilMatch = (match.startTime.getTime() - now.getTime()) / 60000;
    const deadlineMinutes = match.club?.deadlineMinutesBeforeMatch ?? 60;
    const courtName = (match.court?.name ?? 'il campo') + (match.court ? (match.court.isCovered ? ' 🏠' : ' ☀️') : '');
    const timeStr = formatMatchSlot(match.startTime);
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
        const pendingVariants = [
            `La partita di ${timeStr} non si gioca più 😔`,
            `La partita di ${timeStr} è saltata 😔`,
            `${timeStr}: annullata, non si è riempita 😕`,
            `Purtroppo la partita di ${timeStr} non va in porto 😔`,
            `Niente partita ${timeStr} 😕`,
            `La partita di ${timeStr} è stata cancellata 😔`,
            `La partita di ${timeStr} non si gioca 😕`,
            `${timeStr}: non si è riempita, purtroppo 😔`,
            `Saltata la partita di ${timeStr} 😕`,
            `La partita di ${timeStr} è annullata 😔`,
        ];
        for (const inv of pendingInvitations) {
            await sleep(randomInt(1, 3) * 1000);
            try {
                await simulateTypingAndSend(
                    inv.player.phoneNumber,
                    pendingVariants[Math.floor(Math.random() * pendingVariants.length)]
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
                        `Prenotazione di ${timeStr} annullata. Scrivimi quando vuoi riprenotare 🎾`,
                        `Ho liberato lo slot di ${timeStr}, la prenotazione è scaduta. Scrivimi per una nuova!`,
                        `${timeStr}: prenotazione annullata. Scrivimi quando vuoi riprenotare 🎾`,
                        `La prenotazione di ${timeStr} è scaduta. Scrivimi per rifissare!`,
                        `${timeStr}: cancellata. Scrivimi quando sei pronto a riprenotare 🎾`,
                        `Ho cancellato la prenotazione di ${timeStr}. Quando vuoi riprenota pure!`,
                        `Lo slot di ${timeStr} non è più prenotato. Scrivimi quando vuoi un altro orario 🎾`,
                        `Prenotazione di ${timeStr} annullata. Riscrivimi quando vuoi!`,
                        `${timeStr}: slot liberato. Scrivimi quando vuoi prenotare di nuovo 🎾`,
                        `Ho liberato lo slot di ${timeStr}. Rifissami quando sei pronto!`,
                    ] : [
                        `La partita di ${timeStr} non è andata, mancavano ${missing} ${missing === 1 ? 'giocatore' : 'giocatori'}. Ti cerco subito un'alternativa 🎾`,
                        `La partita di ${timeStr} è saltata 😕 Cerco subito qualcosa di disponibile!`,
                        `Non abbiamo chiuso la partita di ${timeStr} 😔 Ti trovo un'alternativa!`,
                        `${timeStr}: non si è riempita, mancavano ${missing} ${missing === 1 ? 'giocatore' : 'giocatori'} 😕 Mi metto subito a cercare!`,
                        `Peccato, la partita di ${timeStr} è saltata 😔 Cerco subito qualcosa per te!`,
                        `${timeStr}: non ce l'abbiamo fatta 😕 Trovo subito un'alternativa!`,
                        `La partita di ${timeStr} non si gioca 😔 Vediamo cosa c'è disponibile!`,
                        `${timeStr}: non è andata in porto 😕 Dammi un secondo che trovo qualcos'altro!`,
                        `Siamo rimasti in ${confirmedPlayers.length} per la partita di ${timeStr} 😔 Ti cerco subito qualcosa!`,
                        `${timeStr}: saltata 😕 Sto già cercando un'alternativa — torno subito!`,
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
                        referentJid: `${confirmedPlayers[0].player.phoneNumber}@s.whatsapp.net`,
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
                    `Ehi! Siamo in ${confirmed} su ${match.playersNeeded} per le ${timeStr} e mancano 30 minuti alla scadenza, se non troviamo nessuno a breve dovrò liberare il campo 😔`,
                    `⚠️ Mancano 30 minuti! La partita delle ${timeStr} è ancora in ${confirmed}/${match.playersNeeded}, sto cercando ma se non trovo nessuno dovrò annullare 😔`,
                    `Ultima chiamata per le ${timeStr}: siamo in ${confirmed} su ${match.playersNeeded}, sto facendo il possibile ma senza altri giocatori dovrò cancellare 😕`,
                    `Mancano 30 minuti e siamo ancora in ${confirmed}/${match.playersNeeded} per le ${timeStr}, se non troviamo nessuno presto dovrò cancellare 😬`,
                    `⏰ Ultima mezz'ora: partita delle ${timeStr} con ${confirmed}/${match.playersNeeded} giocatori. Sto cercando, ti aggiorno presto 😔`,
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
