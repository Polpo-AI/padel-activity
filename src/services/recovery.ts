/**
 * RECOVERY SERVICE
 *
 * Gestisce match non riempibili e timeout pre-partita.
 * Le disdette passano da CANCEL_MATCH in brain.ts (handleCancellation/launchRecoveryWave
 * erano codice morto e sono stati rimossi: la recovery post-disdetta è la wave urgente
 * lanciata da CANCEL_MATCH, con cap recoveryWaveCount gestito lì).
 */

import { prisma } from './db';
import { simulateTypingAndSend } from './whatsapp';
import { notifyAdmin } from '../utils/notify-admin';
import { formatMatchSlot } from '../utils/format-match';
import { runWithContext } from '../utils/request-context';
import pino from 'pino';

const logger = pino({ level: 'info' });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

// ─────────────────────────────────────────────
// MATCH NON RIEMPIBILE
// ─────────────────────────────────────────────

export async function handleMatchUnfillable(matchId: string, forceCancel: boolean = false): Promise<void> {
    // Contesto club: chiamata anche dal maintenance worker (check-timeouts) SENZA contesto —
    // senza clubId tutti i messaggi a valle partirebbero dal socket WA del primo club connesso.
    const matchClub = await prisma.match.findUnique({ where: { id: matchId }, select: { clubId: true } });
    await runWithContext({ correlationId: `unfillable-${matchId}`, clubId: matchClub?.clubId ?? undefined }, () =>
        _handleMatchUnfillableInner(matchId, forceCancel)
    );
}

async function _handleMatchUnfillableInner(matchId: string, forceCancel: boolean = false): Promise<void> {
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
            `unfillable-${matchId}`,
            undefined, undefined, 'matches'
        );
    } else {
        await prisma.match.update({
            where: { id: matchId },
            data: { status: 'UNFILLED' },
        });

        await notifyAdmin(
            `⚠️ Partita SENZA GIOCATORI SUFFICIENTI\n${courtName} alle ${timeStr}\n` +
            `${confirmedPlayers.length}/${match.playersNeeded} — pool esaurito. Intervento manuale.`,
            `unfilled-${matchId}`,
            undefined, undefined, 'matches'
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
                
                // Notifica referenti — col socket WA del club giusto (job maintenance: nessun contesto)
                const referents = match.MatchPlayer.filter(mp => !mp.leftAt);
                await runWithContext({ correlationId: `timeout-warn-${match.id}`, clubId: match.clubId ?? undefined }, async () => {
                    for (const rp of referents) {
                        await simulateTypingAndSend(rp.player.phoneNumber, msg);
                    }
                });
                
                await redis.set(warningKey, 'sent', 'EX', 60 * 60); // Scade dopo 1h
                logger.info({ matchId: match.id }, 'Pre-timeout warning sent');
            }
        }

        if (minutesUntilMatch < deadlineMinutes && confirmed < match.playersNeeded) {
            logger.info(`Match ${match.id} timeout: ${confirmed}/${match.playersNeeded} — cancelling`);
            await handleMatchUnfillable(match.id);
        }
    }

    // Scadi invitation pendenti di match già terminati e MAI giocati (non-LOCKED):
    // outcome esplicito MATCH_CANCELLED = neutro nella finestra reliability.
    // I PENDING su match LOCKED (giocati) NON vanno toccati qui: li processa
    // processMatchOutcomes che li tagga GHOST (penalità). Marcarli EXPIRED senza
    // outcome faceva scattare l'inferenza GHOST anche per partite cancellate.
    const expired = await prisma.invitation.updateMany({
        where: {
            status: 'PENDING',
            match: { startTime: { lt: now }, status: { not: 'LOCKED' } },
        },
        data: { status: 'EXPIRED', outcome: 'MATCH_CANCELLED' } as any,
    });

    if (expired.count > 0) {
        logger.info(`Expired ${expired.count} stale PENDING invitations (outcome=MATCH_CANCELLED)`);
    }
}
