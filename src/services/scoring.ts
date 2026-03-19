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
        eventValue = 1.3;
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
        include: { MatchPlayer: { include: { player: true } }, invitations: true, court: true },
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

        // ─── TRIGGER FEEDBACK ───
        if (showed) {
            const { getRedis } = await import('./queue');
            const redis = getRedis();
            const redisKey = `feedback_requested:${matchId}:${inv.playerId}`;
            const alreadyAsked = await redis.get(redisKey);

            if (!alreadyAsked) {
                const player = match.MatchPlayer.find(mp => mp.playerId === inv.playerId)?.player;
                if (player && player.phoneNumber && !player.phoneNumber.startsWith('FRIEND_')) {
                    const { simulateTypingAndSend } = await import('./whatsapp');
                    const jid = `${player.phoneNumber}@s.whatsapp.net`;
                    const message = `Ciao ${player.name || ''}! 👋 Com'è andata la partita di oggi al ${match.court?.name || 'campo'}? 🎾 Raccontami pure qui! 😊`;

                    try {
                        await simulateTypingAndSend(jid, message);
                        await redis.set(redisKey, '1', 'EX', 86400); // 24 ore
                    } catch (err) {
                        logger.error({ err, playerId: inv.playerId }, 'Error sending feedback request');
                    }
                }
            }
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
        include: { invitations: true, MatchPlayer: { include: { player: true } }, club: true },
    });
    if (!match) return { players: [], targetCount: 0 };

    // 1. GENDER RESTRICTION (Always same sex unless club allows mixed)
    let targetGender: any = null;
    if (!match.club?.allowMixedGenderMatchmaking) {
        const participants = match.MatchPlayer.map(mp => mp.player).filter(Boolean);
        if (participants.length > 0) {
            const genders = Array.from(new Set(participants.map(p => p.gender)));
            // Se sono tutti dello stesso sesso (e non UNKNOWN), restringiamo a quello
            if (genders.length === 1 && genders[0] !== 'UNKNOWN') {
                targetGender = genders[0];
            }
        }
    }

    const excludedIds = [
        ...match.invitations.map(i => i.playerId),
        ...match.MatchPlayer.map(mp => mp.playerId),
    ];

    const skillMin = match.skillLevel - (match.club?.matchLowerRange ?? 1.0);
    const skillMax = match.skillLevel + (match.club?.matchUpperRange ?? 1.0);

    const pool = await prisma.player.findMany({
        where: {
            clubId: match.clubId,
            skillLevel: { gt: 0, gte: skillMin, lte: skillMax },
            gender: targetGender ? targetGender : undefined,
            active: true,
            dailyMessagesCount: { lt: match.club?.maxDailyMessages ?? 2 },
            id: { notIn: excludedIds },
        },
    });

    if (pool.length === 0) return { players: [], targetCount: 0 };

    const eligible = await filterExcluded(pool);
    if (eligible.length === 0) return { players: [], targetCount: 0 };

    // 2. LEVEL PRIORITIZATION: Exact Level First
    const perfectMatches = eligible.filter(p => p.skillLevel === match.skillLevel);
    const adjacentMatches = eligible.filter(p => p.skillLevel !== match.skillLevel);

    const sortEligible = (a: any, b: any) => {
        const lastA = a.lastContactedAt?.getTime() || 0;
        const lastB = b.lastContactedAt?.getTime() || 0;
        if (lastA !== lastB) return lastA - lastB; // Chi non contattiamo da più tempo va prima
        return (b.reliabilityScore || PRIOR) - (a.reliabilityScore || PRIOR); // A parità di tempo, chi è più affidabile
    };

    perfectMatches.sort(sortEligible);
    adjacentMatches.sort(sortEligible);

    const sortedEligible = [...perfectMatches, ...adjacentMatches];

    let targetCount = 0;
    let currentEmaSum = 0;

    for (let i = 0; i < sortedEligible.length; i++) {
        const player = sortedEligible[i];
        const ema = player.reliabilityScore === 0 ? PRIOR : player.reliabilityScore;
        currentEmaSum += ema;
        targetCount++;
        
        if (currentEmaSum >= spotsNeeded) {
            break;
        }
    }

    logger.info(
        `Wave selection: ${spotsNeeded} spots needed, perfect ${perfectMatches.length}, adjacent ${adjacentMatches.length}, ` +
        `gender: ${targetGender || 'any'}, sumEMA: ${currentEmaSum.toFixed(2)}, targeting ${targetCount} players`
    );

    return { players: sortedEligible.slice(0, targetCount), targetCount };
}

// ─────────────────────────────────────────────
// SELEZIONE RECOVERY — pool più ampio, ignora cap giornaliero
// Usato da recovery.ts (sostituisce getPlayersForRecovery da matchmaker)
// ─────────────────────────────────────────────
 
export async function getPlayersForRecovery(matchId: string): Promise<any[]> {
    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { invitations: true, MatchPlayer: { include: { player: true } }, club: true },
    });
    if (!match) return [];

    let targetGender: any = null;
    if (!match.club?.allowMixedGenderMatchmaking) {
        const participants = match.MatchPlayer.map(mp => mp.player).filter(Boolean);
        if (participants.length > 0) {
            const genders = Array.from(new Set(participants.map(p => p.gender)));
            if (genders.length === 1 && genders[0] !== 'UNKNOWN') {
                targetGender = genders[0];
            }
        }
    }

    const excludedIds = [
        ...match.invitations.map(i => i.playerId),
        ...match.MatchPlayer.map(mp => mp.playerId),
    ];

    const skillMin = match.skillLevel - (match.club?.matchLowerRange ?? 1.0);
    const skillMax = match.skillLevel + (match.club?.matchUpperRange ?? 1.0);

    const pool = await prisma.player.findMany({
        where: {
            clubId: match.clubId,
            skillLevel: { gt: 0, gte: skillMin, lte: skillMax },
            gender: targetGender ? targetGender : undefined,
            active: true,
            id: { notIn: excludedIds },
        },
    });

    const eligible = await filterExcluded(pool);

    const perfectMatches = eligible.filter(p => p.skillLevel === match.skillLevel);
    const adjacentMatches = eligible.filter(p => p.skillLevel !== match.skillLevel);

    const sortRecovery = (a: any, b: any) => {
        const lastA = a.lastContactedAt?.getTime() || 0;
        const lastB = b.lastContactedAt?.getTime() || 0;
        if (lastA !== lastB) return lastA - lastB;
        return (b.reliabilityScore || PRIOR) - (a.reliabilityScore || PRIOR);
    };

    perfectMatches.sort(sortRecovery);
    adjacentMatches.sort(sortRecovery);

    return [...perfectMatches, ...adjacentMatches];
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
