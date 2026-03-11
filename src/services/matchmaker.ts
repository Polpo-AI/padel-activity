/**
 * MATCHMAKER
 *
 * Orchestra le wave di inviti per riempire un match.
 * Fix applicati:
 * - No più N+1: il re-check del match avviene una volta sola fuori dal loop
 *   per i controlli di break, poi di nuovo in blocco se necessario.
 * - match.court → match.court?.name (FK su Court)
 * - skillLevel è Int, non enum
 * - getPlayersForRecovery → importato da scoring.ts
 */

import { prisma } from './db';
import { selectPlayersForWave, computeNextWaveDelayMs, getPlayersForRecovery } from './scoring';
import { generateInvitation } from './ai';
import { simulateTypingAndSend } from './whatsapp';
import { waveQueue } from './queue';
import pino from 'pino';

const logger = pino({ level: 'info' });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

// ─────────────────────────────────────────────
// PROCESS WAVE
// ─────────────────────────────────────────────

export async function processWave(matchId: string, waveNumber: number): Promise<void> {
    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: {
            MatchPlayer: true,
            court: true,   // relazione FK — non stringa
            club: true,
        },
    });

    if (!match || match.status !== 'OPEN') {
        logger.info(`Match ${matchId} not OPEN, skipping wave ${waveNumber}`);
        return;
    }

    const confirmedCount = match.MatchPlayer.filter(mp => !mp.leftAt).length;
    const spotsNeeded = match.playersNeeded - confirmedCount;

    if (spotsNeeded <= 0) {
        logger.info(`Match ${matchId} already full, skipping wave ${waveNumber}`);
        return;
    }

    const minutesUntilMatch = (match.startTime.getTime() - Date.now()) / 60000;

    if (minutesUntilMatch < 60) {
        logger.info(`Match ${matchId} < 1h away, no more waves`);
        return;
    }

    const { players, targetCount } = await selectPlayersForWave(
        matchId,
        spotsNeeded,
        match.club?.waveMultiplier ?? 3
    );

    if (players.length === 0) {
        logger.warn(`Wave ${waveNumber} for match ${matchId}: no players available`);
        const { handleMatchUnfillable } = await import('./recovery');
        await handleMatchUnfillable(matchId);
        return;
    }

    const courtName = match.court?.name ?? `Campo ${match.courtId ?? ''}`;
    logger.info(`Wave ${waveNumber} for ${matchId}: contacting ${players.length}/${targetCount} players for ${spotsNeeded} spots`);

    // ── Stato partita prima del loop — aggiornato UNA sola volta per blocco ──
    // Ogni 3 messaggi ricontrolliamo (anti N+1)
    let currentSpots = spotsNeeded;
    let currentStatus = 'OPEN';

    for (let i = 0; i < players.length; i++) {
        if (currentStatus !== 'OPEN' || currentSpots <= 0) break;

        // Ricarica stato ogni 3 invii o al primo
        if (i % 3 === 0) {
            const snapshot = await prisma.match.findUnique({
                where: { id: matchId },
                include: { MatchPlayer: true },
            });
            if (!snapshot) { currentStatus = 'DELETED'; break; }
            currentStatus = snapshot.status;
            currentSpots = snapshot.playersNeeded - snapshot.MatchPlayer.filter(mp => !mp.leftAt).length;
            if (currentStatus !== 'OPEN' || currentSpots <= 0) break;
        }

        const player = players[i];
        const currentMinutes = (match.startTime.getTime() - Date.now()) / 60000;

        await prisma.invitation.create({
            data: {
                matchId,
                playerId: player.id,
                status: 'PENDING',
                minutesUntilMatch: Math.round(currentMinutes),
            },
        });

        const text = await generateInvitation(
            player.name || 'Amico',
            match.startTime,
            courtName,
            match.clubId ?? undefined,
            false
        );

        // Delay anti-ban tra messaggi
        if (i > 0) await sleep(randomInt(15, 45) * 1000);

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
            logger.error({ err }, `Failed to send invitation to ${player.phoneNumber}`);
            await prisma.invitation.updateMany({
                where: { matchId, playerId: player.id, status: 'PENDING' },
                data: { status: 'IGNORED' },
            });
        }
    }

    // Schedula prossima wave
    const nextDelayMs = computeNextWaveDelayMs(minutesUntilMatch);
    if (nextDelayMs) {
        await waveQueue.add(
            'process-wave',
            { matchId, waveNumber: waveNumber + 1 },
            { delay: nextDelayMs }
        );
        logger.info(`Next wave ${waveNumber + 1} for ${matchId} in ${(nextDelayMs / 60000).toFixed(0)}min`);
    }
}

// ─────────────────────────────────────────────
// TROVA MATCH APERTO COMPATIBILE
// skillLevel è Int — nessun cast
// ─────────────────────────────────────────────

export async function findOpenMatchForPlayer(
    skillLevel: number,
    preferredTime?: Date
): Promise<{ id: string; courtName: string; startTime: Date; spotsLeft: number } | null> {
    const now = new Date();

    const matches = await prisma.match.findMany({
        where: {
            status: 'OPEN',
            skillLevel,
            startTime: { gt: now },
        },
        include: { MatchPlayer: true, court: true },
        orderBy: { startTime: 'asc' },
    });

    for (const match of matches) {
        const spotsLeft = match.playersNeeded - match.MatchPlayer.filter(mp => !mp.leftAt).length;
        if (spotsLeft <= 0) continue;

        if (preferredTime) {
            const diff = Math.abs(match.startTime.getTime() - preferredTime.getTime());
            if (diff > 2 * 60 * 60 * 1000) continue;
        }

        return {
            id: match.id,
            courtName: match.court?.name ?? 'Campo',
            startTime: match.startTime,
            spotsLeft,
        };
    }

    return null;
}

// Riesporta per recovery.ts (che lo importava da qui prima)
export { getPlayersForRecovery };
