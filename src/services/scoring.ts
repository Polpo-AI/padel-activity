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

export const PRIOR = 0.33; // fallback EMA per giocatori legacy con reliabilityScore=0 nel DB
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

    const currentRate = player.reliabilityScore || PRIOR; // PRIOR fallback for legacy players with score=0

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

    for (const inv of unprocessed) {
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
                    const { generateFeedbackRequest } = await import('./ai');
                    const jid = `${player.phoneNumber}@s.whatsapp.net`;
                    const timeStr = match.startTime
                        ? match.startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' })
                        : '';
                    const message = await generateFeedbackRequest(
                        player.name || '',
                        match.court?.name || '',
                        timeStr,
                    );

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
    extraExcluded: string[] = [],
): Promise<{ players: any[]; targetCount: number }> {
    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { invitations: true, MatchPlayer: { include: { player: true } }, club: true },
    });
    if (!match) return { players: [], targetCount: 0 };

    // 1. GENDER RESTRICTION
    // targetGender sul match (esplicito da dashboard o bot): 'MALE', 'FEMALE', 'ANY', null
    // 'ANY' = misto esplicito → nessun filtro
    // 'MALE'/'FEMALE' = filtro diretto
    // null = legacy: inferisci dal genere dei partecipanti già iscritti (se isMixed=false)
    let targetGender: any = null;
    const explicitTarget = (match as any).targetGender as string | null;
    const participants = match.MatchPlayer.filter(mp => !mp.leftAt).map(mp => mp.player).filter(Boolean);

    if (explicitTarget === 'MALE' || explicitTarget === 'FEMALE') {
        targetGender = explicitTarget;
    } else if (match.isMixed) {
        // Misto: se uno dei due generi ha già raggiunto 2 posti, invitare solo l'altro
        const maleCount = participants.filter(p => p.gender === 'MALE').length;
        const femaleCount = participants.filter(p => p.gender === 'FEMALE').length;
        if (maleCount >= 2) targetGender = 'FEMALE';
        else if (femaleCount >= 2) targetGender = 'MALE';
        // altrimenti nessun filtro: entrambi i generi sono ancora disponibili
    } else if (explicitTarget !== 'ANY') {
        // Non-misto legacy: inferisci dai partecipanti
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
        ...extraExcluded,
    ];

    const skillMin = match.skillLevel - (match.club?.matchLowerRange ?? 1.0);
    const skillMax = match.skillLevel + (match.club?.matchUpperRange ?? 1.0);

    const isMorning = isMorningMatchInRome(match.startTime);
    const isWeekday = isWeekdayInRome(match.startTime);
    const dailyCap = match.club?.maxDailyMessages ?? 2;

    const pool = await prisma.player.findMany({
        where: {
            clubId: match.clubId,
            skillLevel: { gt: 0, gte: skillMin, lte: skillMax },
            gender: targetGender ? targetGender : undefined,
            active: true,
            // Time-bucketed cap + avoid flags (solo feriali — nel weekend si gioca anche la mattina)
            ...(isMorning
                ? { morningContactsToday: { lt: dailyCap }, ...(isWeekday ? { avoidMorning: false } : {}) }
                : { afternoonContactsToday: { lt: dailyCap }, ...(isWeekday ? { avoidAfternoon: false } : {}) }),
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
        const ema = player.reliabilityScore || PRIOR;
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
    const explicitTargetR = (match as any).targetGender as string | null;
    const participantsR = match.MatchPlayer.filter(mp => !mp.leftAt).map(mp => mp.player).filter(Boolean);

    if (explicitTargetR === 'MALE' || explicitTargetR === 'FEMALE') {
        targetGender = explicitTargetR;
    } else if (match.isMixed) {
        const maleCount = participantsR.filter(p => p.gender === 'MALE').length;
        const femaleCount = participantsR.filter(p => p.gender === 'FEMALE').length;
        if (maleCount >= 2) targetGender = 'FEMALE';
        else if (femaleCount >= 2) targetGender = 'MALE';
    } else if (explicitTargetR !== 'ANY') {
        if (participantsR.length > 0) {
            const genders = Array.from(new Set(participantsR.map(p => p.gender)));
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

    const isMorning = isMorningMatchInRome(match.startTime);
    const isWeekday = isWeekdayInRome(match.startTime);

    const pool = await prisma.player.findMany({
        where: {
            clubId: match.clubId,
            skillLevel: { gt: 0, gte: skillMin, lte: skillMax },
            gender: targetGender ? targetGender : undefined,
            active: true,
            // Recovery ignora il cap ma rispetta avoid flags solo nei feriali
            ...(isWeekday
                ? (isMorning ? { avoidMorning: false } : { avoidAfternoon: false })
                : {}),
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
    if (minutesUntilMatch > 1440) return 3 * 60 * 60 * 1000;   // >24h  → ogni 3h
    if (minutesUntilMatch > 720)  return 2 * 60 * 60 * 1000;   // >12h  → ogni 2h
    if (minutesUntilMatch > 360)  return 90 * 60 * 1000;        // >6h   → ogni 90min
    if (minutesUntilMatch > 120)  return 25 * 60 * 1000;        // >2h   → ogni 25min
    if (minutesUntilMatch > 60)   return 10 * 60 * 1000;        // >1h   → ogni 10min
    return null;                                                  // <1h   → stop
}

// ─────────────────────────────────────────────
// TIME BUCKET — pre/post 14:00 Europe/Rome
// ─────────────────────────────────────────────

/** true se l'orario del match (in Rome) è prima delle 14:00 */
export function isMorningMatchInRome(date: Date): boolean {
    const h = parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false })
            .format(date).replace('24', '0'),
        10
    );
    return h < 14;
}

/** true se il match cade in un giorno feriale (lun-ven) in Rome */
export function isWeekdayInRome(date: Date): boolean {
    const day = parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', weekday: 'narrow' })
            .formatToParts(date).find(p => p.type === 'weekday')?.value === 'S' ? '0' : '1', // trick: use numeric weekday
        10
    );
    // Più semplice: usare getDay() dopo conversione alla data Rome
    const romeDate = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Rome' }));
    const dow = romeDate.getDay(); // 0=Dom, 1=Lun, ..., 6=Sab
    return dow >= 1 && dow <= 5;
}

// ─────────────────────────────────────────────
// NIGHT WINDOW — 22:00–08:00 Europe/Rome
// ─────────────────────────────────────────────

/** Restituisce true se l'orario (in Rome) è nella fascia notturna 22:00–08:00. */
export function isNightInRome(d: Date): boolean {
    const h = parseInt(
        new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false })
            .format(d).replace('24', '0'),
        10
    );
    return h >= 22 || h < 8;
}

/**
 * Se `from` cade in fascia notturna, restituisce i ms mancanti alle 08:00 Rome
 * del mattino successivo (o dello stesso giorno se siamo < 08:00).
 * Altrimenti restituisce 0.
 */
export function msUntil8amRome(from: Date): number {
    if (!isNightInRome(from)) return 0;

    const romeStr = from.toLocaleString('sv-SE', { timeZone: 'Europe/Rome' }); // "YYYY-MM-DD HH:mm:ss"
    const [dateStr, timeStr] = romeStr.split(' ');
    const romeHour = parseInt(timeStr.split(':')[0], 10);

    // Se siamo dopo le 22, target = domani 08:00; se siamo prima delle 08, target = oggi 08:00
    let [y, mo, dd] = dateStr.split('-').map(Number);
    if (romeHour >= 22) dd += 1;

    // Costruisci "YYYY-MM-DDT08:00:00" come wall-clock Rome e converti in UTC
    const wallClock = new Date(`${y}-${String(mo).padStart(2,'0')}-${String(dd).padStart(2,'0')}T08:00:00`);
    // Stima dell'offset Rome→UTC al momento del target (iterazione singola per DST)
    const approxOffset = new Date(from.toLocaleString('en-US', { timeZone: 'Europe/Rome' })).getTime() - from.getTime();
    const targetUtc = new Date(wallClock.getTime() - approxOffset);

    // Aggiunge jitter 0–15min per evitare che tutte le wave si sveglino alle 08:00:00 esatte
    const jitterMs = Math.floor(Math.random() * 15 * 60 * 1000);
    return Math.max(60_000, targetUtc.getTime() - from.getTime() + jitterMs);
}

// ─────────────────────────────────────────────
// ANTI-BOT — delay umano tra un invito e l'altro
// Distribuzione a 4 fasce per simulare comportamento reale:
//   50% → 8–35s   (risposta rapida)
//   25% → 40–150s (piccola pausa)
//   15% → 150–360s (distratto)
//   10% → 360–900s (pausa lunga)
// ─────────────────────────────────────────────

export function humanSendDelayMs(): number {
    const r = Math.random();
    const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
    if (r < 0.50) return rand(8,  35)  * 1000;
    if (r < 0.75) return rand(40, 150) * 1000;
    if (r < 0.90) return rand(150, 360) * 1000;
    return            rand(360, 900) * 1000;
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
        showUpRate: player?.reliabilityScore ?? 0.33,
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
