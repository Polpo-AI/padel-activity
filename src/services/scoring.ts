/**
 * SCORING SERVICE
 *
 * Metrica unica: showUpRate ∈ [0, 1]
 * Media mobile esponenziale α=0.15, prior=0.33
 * Bonus ×1.3 se viene con < 2h di preavviso
 *
 * Soglia esclusione: < 0.05 SOLO dopo almeno 10 inviti.
 * Un giocatore nuovo (reliabilityScore = 0) NON viene escluso.
 */

import { prisma } from './db';
import pino from 'pino';

const logger = pino({ level: 'info' });

export const PRIOR = 0.33;
const ALPHA = 0.15;
const LAST_MINUTE_BONUS = 1.3;
const LAST_MINUTE_THRESHOLD_MIN = 120;
const EXCLUSION_MIN_INVITES = 10;
const EXCLUSION_THRESHOLD = 0.05;

// ─────────────────────────────────────────────
// AGGIORNA SHOW UP RATE
// ─────────────────────────────────────────────

export async function updateShowUpRate(
    playerId: string,
    showed: boolean,
    minutesUntilMatchWhenInvited: number
): Promise<void> {
    const player = await prisma.player.findUnique({ where: { id: playerId } });
    if (!player) return;

    // reliabilityScore = 0 su giocatori nuovi: trattiamo come prior
    const currentRate = player.reliabilityScore === 0 ? PRIOR : player.reliabilityScore;

    let eventValue = showed ? 1.0 : 0.0;
    if (showed && minutesUntilMatchWhenInvited <= LAST_MINUTE_THRESHOLD_MIN) {
        eventValue = Math.min(1.0, 1.0 * LAST_MINUTE_BONUS);
    }

    const newRate = Math.min(1.0, (1 - ALPHA) * currentRate + ALPHA * eventValue);

    await prisma.player.update({
        where: { id: playerId },
        data: { reliabilityScore: newRate },
    });

    logger.info(
        `Player ${playerId}: showUpRate ${currentRate.toFixed(3)} → ${newRate.toFixed(3)} ` +
        `(showed=${showed}, preavviso=${minutesUntilMatchWhenInvited}min` +
        `${showed && minutesUntilMatchWhenInvited <= LAST_MINUTE_THRESHOLD_MIN ? ' +LM bonus' : ''})`
    );
}

// ─────────────────────────────────────────────
// PROCESSA OUTCOME PARTITA
// Idempotente: salta se la partita ha già un outcomeProcessedAt
// ─────────────────────────────────────────────

export async function processMatchOutcomes(matchId: string): Promise<void> {
    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: true, invitations: true },
    });

    if (!match) return;

    // Invitations già in stato finale = già processate in un run precedente
    const unprocessed = match.invitations.filter(
        inv => inv.status !== 'EXPIRED' || match.MatchPlayer.some(mp => mp.playerId === inv.playerId)
    );

    for (const inv of match.invitations) {
        const mp = match.MatchPlayer.find(mp => mp.playerId === inv.playerId && !mp.leftAt);
        const showed = !!mp && !mp.noShow;
        const minutesUntilMatch = inv.minutesUntilMatch ?? 360;

        await updateShowUpRate(inv.playerId, showed, minutesUntilMatch);

        if (inv.status === 'PENDING') {
            await prisma.invitation.update({
                where: { id: inv.id },
                data: { status: 'EXPIRED' },
            });
        }
    }

    logger.info(`processMatchOutcomes ${matchId}: ${match.invitations.length} invitations processed`);
}

// ─────────────────────────────────────────────
// FILTRA ESCLUSI (async — corretto)
// ─────────────────────────────────────────────

async function filterExcluded(players: any[]): Promise<any[]> {
    const result: any[] = [];
    for (const p of players) {
        // Nuovi utenti (score=0) passano sempre — non hanno abbastanza storia
        if (p.reliabilityScore === 0) { result.push(p); continue; }
        if (p.reliabilityScore >= EXCLUSION_THRESHOLD) { result.push(p); continue; }
        // Score basso — controlla quanti inviti ha ricevuto
        const invCount = await prisma.invitation.count({ where: { playerId: p.id } });
        if (invCount < EXCLUSION_MIN_INVITES) result.push(p); // non abbastanza storia
    }
    return result;
}

// ─────────────────────────────────────────────
// SELEZIONE WAVE — normale
// ─────────────────────────────────────────────

export async function selectPlayersForWave(
    matchId: string,
    spotsNeeded: number,
    clubWaveMultiplier: number = 3
): Promise<{ players: any[]; targetCount: number }> {
    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { invitations: true, MatchPlayer: true },
    });
    if (!match) return { players: [], targetCount: 0 };

    const excludedIds = [
        ...match.invitations.map(i => i.playerId),
        ...match.MatchPlayer.map(mp => mp.playerId),
    ];

    const skillMin = match.allowMixedLevels ? match.skillLevel - 1 : match.skillLevel;
    const skillMax = match.allowMixedLevels ? match.skillLevel + 1 : match.skillLevel;

    const pool = await prisma.player.findMany({
        where: {
            skillLevel: { gte: skillMin, lte: skillMax },
            active: true,
            dailyMessagesCount: { lt: 2 },
            id: { notIn: excludedIds },
        },
        orderBy: [
            { lastContactedAt: 'asc' },
            { reliabilityScore: 'desc' },
        ],
    });

    if (pool.length === 0) return { players: [], targetCount: 0 };

    const eligible = await filterExcluded(pool);
    if (eligible.length === 0) return { players: [], targetCount: 0 };

    const avgRate = eligible.reduce((s, p) => s + (p.reliabilityScore || PRIOR), 0) / eligible.length;
    let multiplier = clubWaveMultiplier;
    if (avgRate > 0.5) multiplier = Math.max(2, clubWaveMultiplier - 1);
    else if (avgRate < 0.3) multiplier = clubWaveMultiplier + 1;

    const targetCount = Math.min(spotsNeeded * multiplier, eligible.length);

    logger.info(
        `Wave selection: ${spotsNeeded} spots, eligible ${eligible.length}, ` +
        `avgRate ${avgRate.toFixed(2)}, ×${multiplier}, targeting ${targetCount}`
    );

    return { players: eligible.slice(0, targetCount), targetCount };
}

// ─────────────────────────────────────────────
// SELEZIONE RECOVERY — pool più ampio, ignora cap giornaliero
// Usato da recovery.ts (sostituisce getPlayersForRecovery da matchmaker)
// ─────────────────────────────────────────────

export async function getPlayersForRecovery(matchId: string): Promise<any[]> {
    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { invitations: true, MatchPlayer: true, club: true },
    });
    if (!match) return [];

    const excludedIds = [
        ...match.invitations.map(i => i.playerId),
        ...match.MatchPlayer.map(mp => mp.playerId),
    ];

    const skillMin = match.allowMixedLevels ? match.skillLevel - 1 : match.skillLevel;
    const skillMax = match.allowMixedLevels ? match.skillLevel + 1 : match.skillLevel;

    // In recovery: ignoriamo dailyMessagesCount — la partita deve essere riempita
    const pool = await prisma.player.findMany({
        where: {
            skillLevel: { gte: skillMin, lte: skillMax },
            active: true,
            id: { notIn: excludedIds },
        },
        orderBy: [
            { reliabilityScore: 'desc' },  // in recovery vogliamo i più affidabili prima
            { lastContactedAt: 'asc' },
        ],
    });

    return filterExcluded(pool);
}

// ─────────────────────────────────────────────
// DELAY PROSSIMA WAVE
// ─────────────────────────────────────────────

export function computeNextWaveDelayMs(minutesUntilMatch: number): number | null {
    if (minutesUntilMatch > 1440) return 3 * 60 * 60 * 1000;
    if (minutesUntilMatch > 360)  return 90 * 60 * 1000;
    if (minutesUntilMatch > 120)  return 25 * 60 * 1000;
    if (minutesUntilMatch > 60)   return 10 * 60 * 1000;
    return null;
}

// ─────────────────────────────────────────────
// STATISTICHE GIOCATORE
// ─────────────────────────────────────────────

export async function getPlayerStats(playerId: string) {
    const [totalInvitations, totalShowed, totalNoShow, player] = await Promise.all([
        prisma.invitation.count({ where: { playerId } }),
        prisma.matchPlayer.count({ where: { playerId, noShow: false, leftAt: null } }),
        prisma.matchPlayer.count({ where: { playerId, noShow: true } }),
        prisma.player.findUnique({ where: { id: playerId } }),
    ]);

    return {
        totalInvitations,
        totalShowed,
        totalNoShow,
        showUpRate: player?.reliabilityScore === 0 ? PRIOR : (player?.reliabilityScore ?? PRIOR),
    };
}

// ─────────────────────────────────────────────
// SHIM — per compatibilità con chiamate dirette nel codebase
// recovery.ts e messageHandler.ts usano questi alias
// ─────────────────────────────────────────────

export async function increaseReliability(playerId: string): Promise<void> {
    await updateShowUpRate(playerId, true, 360);
}

export async function decreaseReliability(playerId: string, _amount?: number): Promise<void> {
    // _amount ignorato — scoring ora è relativo, non assoluto
    await updateShowUpRate(playerId, false, 60); // trattato come last-minute miss
}
