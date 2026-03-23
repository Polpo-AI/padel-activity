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
import { waveQueue, getRedis } from './queue';
import { runWithContext } from '../utils/request-context';
import pino from 'pino';

const logger = pino({ level: 'info' });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

// ─────────────────────────────────────────────
// DISTRIBUTED LOCK — protegge la fase di selezione + creazione invitation
// TTL breve (15s) perché copre solo operazioni DB veloci, non il loop di invio
// ─────────────────────────────────────────────

async function withMatchLock<T>(matchId: string, fn: () => Promise<T>): Promise<T | null> {
    const redis = getRedis();
    const lockKey = `wave_lock:${matchId}`;
    const lockToken = `${Date.now()}-${Math.random()}`;

    const acquired = await redis.set(lockKey, lockToken, 'PX', 15_000, 'NX');
    if (!acquired) {
        logger.warn(`Wave lock for match ${matchId} already held — skipping parallel wave`);
        return null;
    }

    try {
        return await fn();
    } finally {
        // Rilascia solo se siamo ancora noi i proprietari del lock
        const current = await redis.get(lockKey);
        if (current === lockToken) await redis.del(lockKey);
    }
}

// ─────────────────────────────────────────────
// PROCESS WAVE
// Fase 1 (con lock): selezione giocatori + creazione invitation in bulk
// Fase 2 (senza lock): invio messaggi WhatsApp (lento, non reversibile)
// ─────────────────────────────────────────────

export async function processWave(matchId: string, waveNumber: number, urgencyMultiplier: number = 1): Promise<void> {
    // Risolvi il clubId dal match per impostare il contesto corretto (socket WA corretto)
    const matchClub = await prisma.match.findUnique({ where: { id: matchId }, select: { clubId: true } });
    const clubId = matchClub?.clubId ?? undefined;

    await runWithContext({ correlationId: `wave-${matchId}-${waveNumber}`, clubId }, async () => {
    await _processWaveInner(matchId, waveNumber, urgencyMultiplier);
    });
}

async function _processWaveInner(matchId: string, waveNumber: number, urgencyMultiplier: number): Promise<void> {
    // ── FASE 1: Selezione e creazione invitation atomica ──────────────────
    const context = await withMatchLock(matchId, async () => {
        const match = await prisma.match.findUnique({
            where: { id: matchId },
            include: { MatchPlayer: { include: { player: true } }, court: true, club: true },
        });

        if (!match || match.status !== 'OPEN') {
            logger.info(`Match ${matchId} not OPEN, skipping wave ${waveNumber}`);
            return null;
        }

        const confirmedCount = match.MatchPlayer.filter(mp => !mp.leftAt).length;
        const actualSpotsNeeded = match.playersNeeded - confirmedCount;
        const spotsNeeded = Math.max(actualSpotsNeeded, Math.round(actualSpotsNeeded * urgencyMultiplier));

        if (spotsNeeded <= 0) {
            logger.info(`Match ${matchId} already full, skipping wave ${waveNumber}`);
            return null;
        }

        const minutesUntilMatch = (match.startTime.getTime() - Date.now()) / 60000;

        if (minutesUntilMatch < 60) {
            logger.info(`Match ${matchId} < 1h away, no more waves`);
            return null;
        }

        const { players, targetCount } = await selectPlayersForWave(
            matchId,
            spotsNeeded,
            match.club?.waveMultiplier ?? 3
        );

        let playersList = [...players];

        if (waveNumber === 1 && match.preferredPlayerIds && match.preferredPlayerIds.length > 0) {
            const preferred = await prisma.player.findMany({
                where: {
                    id: { in: match.preferredPlayerIds },
                    active: true,
                    dailyMessagesCount: { lt: match.club?.maxDailyMessages ?? 2 },
                },
            });

            const skillMin = match.skillLevel - (match.club?.matchLowerRange ?? 1.0);
            const skillMax = match.skillLevel + (match.club?.matchUpperRange ?? 1.0);

            for (const p of preferred) {
                if (p.skillLevel >= skillMin && p.skillLevel <= skillMax) {
                    if (!playersList.some(fp => fp.id === p.id)) {
                        playersList.unshift(p);
                        logger.info(`Adding preferred player ${p.name} (${p.id}) to Wave 1 prioritisation`);
                    }
                }
            }
        }

        if (playersList.length === 0) {
            logger.warn(`Wave ${waveNumber} for match ${matchId}: no players available`);
            return { playersList: [], match, minutesUntilMatch, targetCount: 0, empty: true };
        }

        // Crea TUTTE le invitation in bulk prima di iniziare a inviare messaggi.
        // Questo garantisce che una wave parallela che parta subito dopo vedrà
        // già tutti questi giocatori in excludedIds e non li selezionerà di nuovo.
        const minutesNow = Math.round(minutesUntilMatch);
        await prisma.invitation.createMany({
            data: playersList.map(p => ({
                matchId,
                playerId: p.id,
                status: 'PENDING',
                minutesUntilMatch: minutesNow,
            })),
            skipDuplicates: true,
        });

        logger.info(`Wave ${waveNumber} for ${matchId}: ${playersList.length}/${targetCount} invitations created, starting send loop`);

        // Giocatori già confermati — passati all'AI per il recap social
        const confirmedPlayers = match.MatchPlayer
            .filter((mp: any) => !mp.leftAt && mp.player)
            .map((mp: any) => ({ name: mp.player.name || 'Giocatore', skillLevel: mp.player.skillLevel ?? 1 }));

        return { playersList, match, minutesUntilMatch, targetCount, empty: false, confirmedPlayers };
    });

    if (!context) return;

    // Pool esaurito → gestisci fuori dal lock (può fare import dinamici lenti)
    // Wave 1: non cancellare mai — il club potrebbe avere pochi iscritti al momento
    // ma altri si potrebbero aggiungere. Solo dalla wave 2 in poi dichiariamo unfillable.
    if (context.empty) {
        if (waveNumber < 2) {
            logger.warn(`Wave ${waveNumber} for match ${matchId}: pool empty but too early to cancel — waiting for next wave`);
            return;
        }
        const isCancelled = await checkAndCancelIfUnfillable(matchId);
        if (!isCancelled) {
            const { handleMatchUnfillable } = await import('./recovery');
            await handleMatchUnfillable(matchId, false);
        }
        return;
    }

    const { playersList, match, minutesUntilMatch, targetCount, confirmedPlayers } = context;

    // ── FASE 2: Invio messaggi (fuori dal lock) ───────────────────────────
    let currentSpots = match.playersNeeded - match.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
    let currentStatus = 'OPEN';

    for (let i = 0; i < playersList.length; i++) {
        if (currentStatus !== 'OPEN' || currentSpots <= 0) break;

        // Ricarica stato ogni 3 invii (anti N+1)
        if (i % 3 === 0) {
            const snapshot = await prisma.match.findUnique({
                where: { id: matchId },
                include: { MatchPlayer: true },
            });
            if (!snapshot) { currentStatus = 'DELETED'; break; }
            currentStatus = snapshot.status;
            currentSpots = snapshot.playersNeeded - snapshot.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
            if (currentStatus !== 'OPEN' || currentSpots <= 0) break;
        }

        const player = playersList[i];

        const confirmedPlayerIds = match.MatchPlayer
            .filter((mp: any) => !mp.leftAt && mp.player)
            .map((mp: any) => mp.player.id);

        const socialContext = await buildMatchSocialContext(
            matchId,
            currentSpots,
            confirmedPlayerIds,
            player.id,
            match.startTime
        );

        const text = await generateInvitation(
            player.name || 'Amico',
            match.startTime,
            match.courtId,
            match.club?.id ?? undefined,
            false,
            socialContext
        );

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
            // Invitation già in DB — aggiorna a IGNORED
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

// ─────────────────────────────────────────────
// CONTROLLO ESAURIMENTO LISTA E CANCELLAZIONE
// ─────────────────────────────────────────────

export async function checkAndCancelIfUnfillable(matchId: string): Promise<boolean> {
    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: { where: { leftAt: null } }, invitations: { where: { status: 'PENDING' } } }
    });

    if (!match || match.status !== 'OPEN') return false;

    const confirmed = match.MatchPlayer.length;
    const pending = match.invitations.length;

    // Se matematicamente abbiamo ancora chance (i PENDING basterebbero)
    if (confirmed + pending >= match.playersNeeded) return false;

    // Se matematicamente non bastano, controlliamo se il serbatoio eligibili è a 0
    const { getPlayersForRecovery } = await import('./scoring');
    const targets = await getPlayersForRecovery(matchId);
    
    if (targets.length === 0) {
        logger.warn(`Match ${matchId} mathematically unfillable (${confirmed} conf + ${pending} pending < ${match.playersNeeded}) AND pool exhausted. Cancelling.`);
        
        const { handleMatchUnfillable } = await import('./recovery');
        await handleMatchUnfillable(matchId, true); // true = forceCancel
        return true;
    }
    return false;
}

// ─────────────────────────────────────────────
// SEGNALI COMPORTAMENTALI PER INVITI WAVE
// ─────────────────────────────────────────────

export interface PlayerSignal {
    name: string;
    matchesLast30Days: number;
    acceptanceRate: number; // 0.0 – 1.0
}

export interface MatchSocialContext {
    spotsLeft: number;
    timeOfDay: 'mattina' | 'pomeriggio' | 'sera';
    players: PlayerSignal[];
    hasPlayedWithBefore: boolean;
}

export async function buildMatchSocialContext(
    matchId: string,
    spotsLeft: number,
    confirmedPlayerIds: string[],
    inviteeId: string,
    matchStartTime: Date
): Promise<MatchSocialContext> {
    const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Frequenza e acceptance rate in parallel
    const [recentMatchCounts, invitationStats, sharedMatches] = await Promise.all([
        // Quante partite hanno giocato negli ultimi 30 giorni
        prisma.matchPlayer.groupBy({
            by: ['playerId'],
            where: {
                playerId: { in: confirmedPlayerIds },
                leftAt: null,
                match: { startTime: { gte: since30 }, status: { in: ['OPEN', 'LOCKED', 'ARCHIVED'] } },
            },
            _count: { playerId: true },
        }),
        // Acceptance rate: inviti accettati vs totali
        prisma.invitation.groupBy({
            by: ['playerId', 'status'],
            where: { playerId: { in: confirmedPlayerIds } },
            _count: { status: true },
        }),
        // Ha già giocato con questi giocatori?
        prisma.matchPlayer.findFirst({
            where: {
                playerId: inviteeId,
                match: {
                    MatchPlayer: { some: { playerId: { in: confirmedPlayerIds }, leftAt: null } },
                },
            },
        }),
    ]);

    const matchCountMap = new Map(recentMatchCounts.map(r => [r.playerId, r._count.playerId]));

    // Raggruppa accepted/total per player
    const acceptMap = new Map<string, { accepted: number; total: number }>();
    for (const row of invitationStats) {
        const cur = acceptMap.get(row.playerId) ?? { accepted: 0, total: 0 };
        cur.total += row._count.status;
        if (row.status === 'ACCEPTED') cur.accepted += row._count.status;
        acceptMap.set(row.playerId, cur);
    }

    // Recupera nomi
    const confirmedPlayers = await prisma.player.findMany({
        where: { id: { in: confirmedPlayerIds } },
        select: { id: true, name: true },
    });

    const players: PlayerSignal[] = confirmedPlayers.map(p => {
        const stats = acceptMap.get(p.id) ?? { accepted: 0, total: 0 };
        return {
            name: (p.name || 'Giocatore').split(' ')[0],
            matchesLast30Days: matchCountMap.get(p.id) ?? 0,
            acceptanceRate: stats.total > 0 ? stats.accepted / stats.total : 0,
        };
    });

    const hour = matchStartTime.getHours();
    const timeOfDay = hour < 13 ? 'mattina' : hour < 18 ? 'pomeriggio' : 'sera';

    return {
        spotsLeft,
        timeOfDay,
        players,
        hasPlayedWithBefore: !!sharedMatches,
    };
}

// Riesporta per recovery.ts
export { getPlayersForRecovery };
