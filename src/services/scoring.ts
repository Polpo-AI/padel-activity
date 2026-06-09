/**
 * SCORING SERVICE
 *
 * Metrica unica: tasso di risposta/presentazione ∈ [0, 1]
 * Media mobile esponenziale con α adattivo = max(0.08, 1/(n+2)), prior=0.33
 *   (n = osservazioni precedenti: impara in fretta da nuovo, stabile con storia lunga)
 * Bonus ×1.3 se viene con < 2h di preavviso
 *
 * Soglia esclusione: < 0.05 SOLO dopo almeno 10 inviti.
 * Un giocatore nuovo (reliabilityScore = 0) NON viene escluso.
 */

import { prisma } from './db';
import pino from 'pino';

const logger = pino({ level: 'info' });

export const PRIOR = 0.33; // fallback EMA per giocatori legacy con reliabilityScore=0 nel DB
// Alpha adattivo: alto con poche osservazioni (impara in fretta, no cold-start), basso con storia
// lunga (stabile, un singolo evento non fa crollare un veterano). α = max(MIN_ALPHA, 1/(n+2)).
const MIN_ALPHA = 0.08;
const LAST_MINUTE_BONUS = 1.3;
const LAST_MINUTE_THRESHOLD_MIN = 120;
const EXCLUSION_MIN_INVITES = 10;
const EXCLUSION_THRESHOLD = 0.05;
// Peso EMA per il "declina educato": penalità più lieve di un no-show/fantasma (peso 1.0).
const DECLINE_WEIGHT = 0.4;

// ─────────────────────────────────────────────
// AGGIORNA SHOW UP RATE
// ─────────────────────────────────────────────

export async function updateShowUpRate(
    playerId: string,
    showed: boolean,
    minutesUntilMatchWhenInvited: number,
    weight: number = 1.0, // <1 = evento "leggero" (es. declina educato): passo EMA ridotto
): Promise<void> {
    const player = await prisma.player.findUnique({ where: { id: playerId } });
    if (!player) return;

    const currentRate = player.reliabilityScore || PRIOR; // PRIOR fallback for legacy players with score=0

    let eventValue = showed ? 1.0 : 0.0;
    if (showed && minutesUntilMatchWhenInvited <= LAST_MINUTE_THRESHOLD_MIN) {
        eventValue = LAST_MINUTE_BONUS;
    }

    // n = osservazioni precedenti (inviti già processati, cioè non più PENDING).
    // Alpha adattivo: con n piccolo impara in fretta (cold-start), con n grande è stabile.
    const priorObservations = await prisma.invitation.count({
        where: { playerId, status: { in: ['ACCEPTED', 'REJECTED', 'IGNORED', 'EXPIRED'] } },
    });
    // +2 a denominatore (smoothing): anche alla prima osservazione il prior pesa ancora (α=0.5),
    // così un singolo evento non porta lo score a 0 o 1.
    // weight scala il passo: un "declina educato" pesa meno di un no-show/fantasma (target=0.0 in entrambi,
    // ma il declina muove meno → penalità più lieve, premia la comunicazione).
    const alpha = Math.max(MIN_ALPHA, 1 / (priorObservations + 2)) * weight;

    const newRate = Math.min(1.0, (1 - alpha) * currentRate + alpha * eventValue);

    await prisma.player.update({
        where: { id: playerId },
        data: { reliabilityScore: newRate },
    });

    logger.info(
        `Player ${playerId}: showUpRate ${currentRate.toFixed(3)} → ${newRate.toFixed(3)} ` +
        `(showed=${showed}, n=${priorObservations}, α=${alpha.toFixed(3)}, preavviso=${minutesUntilMatchWhenInvited}min` +
        `${showed && minutesUntilMatchWhenInvited <= LAST_MINUTE_THRESHOLD_MIN ? ' +LM bonus' : ''})`
    );
}

// ─────────────────────────────────────────────
// PROCESSA OUTCOME PARTITA
// Idempotente via marcatore Redis: processa gli outcome di una partita UNA SOLA volta.
// (Il job maintenance gira ogni 2h su finestra 3h → senza guardia la stessa partita
//  verrebbe processata più volte e l'EMA dei presenti si gonfierebbe a ogni passaggio.)
// ─────────────────────────────────────────────

export async function processMatchOutcomes(matchId: string): Promise<void> {
    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: { include: { player: true } }, invitations: true, court: true },
    });

    if (!match) return;

    // Idempotenza: se questa partita ha già avuto gli outcome processati, esci subito.
    // Senza questo, updateShowUpRate (EMA, NON idempotente) veniva riapplicato a ogni run.
    const _redis = (await import('./queue')).getRedis();
    const _procKey = `outcomes_processed:${matchId}`;
    try {
        if (await _redis.get(_procKey)) {
            logger.info(`processMatchOutcomes ${matchId}: già processato — skip (idempotenza)`);
            return;
        }
    } catch { /* Redis non raggiungibile: procediamo comunque (rischio basso) */ }

    // Invitations già in stato finale = già processate in un run precedente.
    // ACCEPTED/REJECTED/IGNORED vanno in FINAL_STATUSES per evitare che updateShowUpRate
    // venga chiamato più volte (EMA non è idempotente: chiamate ripetute inflazionano il score).
    // Eccezione: ACCEPTED con giocatore ancora presente (leftAt=null) → va processato per il feedback.
    const FINAL_STATUSES = new Set(['EXPIRED', 'ACCEPTED', 'REJECTED', 'IGNORED']);
    const unprocessed = match.invitations.filter(
        inv => !FINAL_STATUSES.has(inv.status) || match.MatchPlayer.some(mp => mp.playerId === inv.playerId && !mp.leftAt)
    );

    const touched = new Set<string>();
    for (const inv of unprocessed) {
        const mp = match.MatchPlayer.find(mp => mp.playerId === inv.playerId && !mp.leftAt);
        const showed = !!mp && !mp.noShow;

        if (inv.status === 'PENDING') {
            // Reliability v2: invitato che non ha MAI risposto.
            //  · partita GIOCATA (LOCKED) → outcome GHOST (conta come mancata conversione)
            //  · partita non giocata (cancellata/non riempita) → MATCH_CANCELLED (escluso, nessuna chance)
            const outcome = match.status === 'LOCKED' ? 'GHOST' : 'MATCH_CANCELLED';
            await prisma.invitation.update({
                where: { id: inv.id },
                data: { status: 'EXPIRED', outcome } as any,
            });
            touched.add(inv.playerId);
            continue; // nessun feedback a chi non ha risposto
        }

        // ACCEPTED+presente: l'outcome ACCEPTED è già taggato all'accept → qui solo il feedback.
        // ─── TRIGGER FEEDBACK ───
        if (showed) {
            const { getRedis } = await import('./queue');
            const redis = getRedis();
            const redisKey = `feedback_requested:${matchId}:${inv.playerId}`;
            let alreadyAsked: string | null = null;
            try {
                alreadyAsked = await redis.get(redisKey);
            } catch {
                // Redis down: procedi comunque (al massimo un feedback duplicato alla prossima run)
            }

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

    // Reliability v2: ricalcola la finestra per i giocatori i cui inviti sono stati appena taggati (fantasmi).
    for (const pid of touched) await recomputeReliability(pid);

    // Marca la partita come processata (TTL 30g) → i run successivi escono subito.
    try { await _redis.set(_procKey, '1', 'EX', 30 * 24 * 60 * 60); } catch { /* best-effort */ }

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

    const explicitTarget = (match as any).targetGender as string | null;
    const participants = match.MatchPlayer.filter(mp => !mp.leftAt).map(mp => mp.player).filter(Boolean);

    const excludedIds = [
        ...match.invitations.map(i => i.playerId),
        // Tutti i MatchPlayer, inclusi quelli con leftAt != null: chi ha lasciato
        // la partita (anche se entrato senza invitation) non va reinvitato.
        ...match.MatchPlayer.map(mp => mp.playerId),
        ...extraExcluded,
    ];

    const skillMin = match.skillLevel - (match.club?.matchLowerRange ?? 1.0);
    const skillMax = match.skillLevel + (match.club?.matchUpperRange ?? 1.0);
    const isMorning = isMorningMatchInRome(match.startTime);
    const isWeekday = isWeekdayInRome(match.startTime);
    const dailyCap = match.club?.maxDailyMessages ?? 2;

    const baseWhere = {
        clubId: match.clubId,
        skillLevel: { gt: 0, gte: skillMin, lte: skillMax },
        active: true,
        dormantSince: null,   // Punto 3: non contattare i giocatori dormienti (irraggiungibili / sospetto blocco)
        ...(isMorning
            ? { morningContactsToday: { lt: dailyCap }, ...(isWeekday ? { avoidMorning: false } : {}) }
            : { afternoonContactsToday: { lt: dailyCap }, ...(isWeekday ? { avoidAfternoon: false } : {}) }),
        id: { notIn: excludedIds },
    };

    const sortFn = (a: any, b: any) => {
        const lastA = a.lastContactedAt?.getTime() || 0;
        const lastB = b.lastContactedAt?.getTime() || 0;
        if (lastA !== lastB) return lastA - lastB;
        return (b.reliabilityScore || PRIOR) - (a.reliabilityScore || PRIOR);
    };

    // Pool → filterExcluded → sorted → EMA accumulation fino a N posti
    const selectByEma = async (gender: string | null, slotsNeeded: number): Promise<any[]> => {
        if (slotsNeeded <= 0) return [];
        const pool = await prisma.player.findMany({ where: { ...baseWhere, ...(gender ? { gender: gender as any } : {}) } });
        if (pool.length === 0) return [];
        const eligible = await filterExcluded(pool);
        if (eligible.length === 0) return [];
        const perfect = eligible.filter(p => p.skillLevel === match.skillLevel).sort(sortFn);
        const adjacent = eligible.filter(p => p.skillLevel !== match.skillLevel).sort(sortFn);
        const sorted = [...perfect, ...adjacent];
        let count = 0;
        let emaSum = 0;
        for (const p of sorted) {
            emaSum += p.reliabilityScore || PRIOR;
            count++;
            if (emaSum >= slotsNeeded) break;
        }
        return sorted.slice(0, count);
    };

    // MISTO: seleziona M e F separatamente per i posti rimasti per genere (target: 2M+2F)
    if (match.isMixed && explicitTarget !== 'MALE' && explicitTarget !== 'FEMALE') {
        const maleCount = participants.filter(p => p.gender === 'MALE').length;
        const femaleCount = participants.filter(p => p.gender === 'FEMALE').length;
        const maleNeeded = Math.max(0, 2 - maleCount);
        const femaleNeeded = Math.max(0, 2 - femaleCount);
        const males = await selectByEma('MALE', maleNeeded);
        const females = await selectByEma('FEMALE', femaleNeeded);
        logger.info(`Wave selection MISTO: ${maleNeeded}M+${femaleNeeded}F needed, selected ${males.length}M+${females.length}F`);
        return { players: [...males, ...females], targetCount: males.length + females.length };
    }

    // NON-MISTO: targetGender singolo
    let targetGender: string | null = null;
    if (explicitTarget === 'MALE' || explicitTarget === 'FEMALE') {
        targetGender = explicitTarget;
    } else if (explicitTarget !== 'ANY') {
        if (participants.length > 0) {
            const genders = Array.from(new Set(participants.map(p => p.gender)));
            if (genders.length === 1 && genders[0] !== 'UNKNOWN') targetGender = genders[0];
        }
    }

    const players = await selectByEma(targetGender, spotsNeeded);
    logger.info(`Wave selection: ${spotsNeeded} spots needed, gender: ${targetGender || 'any'}, selected ${players.length}`);
    return { players, targetCount: players.length };
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

    const explicitTargetR = (match as any).targetGender as string | null;
    const participantsR = match.MatchPlayer.filter(mp => !mp.leftAt).map(mp => mp.player).filter(Boolean);

    const excludedIds = [
        ...match.invitations.map(i => i.playerId),
        ...match.MatchPlayer.map(mp => mp.playerId),
    ];

    const skillMin = match.skillLevel - (match.club?.matchLowerRange ?? 1.0);
    const skillMax = match.skillLevel + (match.club?.matchUpperRange ?? 1.0);
    const isMorning = isMorningMatchInRome(match.startTime);
    const isWeekday = isWeekdayInRome(match.startTime);

    const baseWhereR = {
        clubId: match.clubId,
        skillLevel: { gt: 0, gte: skillMin, lte: skillMax },
        active: true,
        dormantSince: null,   // Punto 3: non contattare i giocatori dormienti
        ...(isWeekday ? (isMorning ? { avoidMorning: false } : { avoidAfternoon: false }) : {}),
        id: { notIn: excludedIds },
    };

    const sortRecovery = (a: any, b: any) => {
        const lastA = a.lastContactedAt?.getTime() || 0;
        const lastB = b.lastContactedAt?.getTime() || 0;
        if (lastA !== lastB) return lastA - lastB;
        return (b.reliabilityScore || PRIOR) - (a.reliabilityScore || PRIOR);
    };

    const fetchAndSort = async (gender: string | null): Promise<any[]> => {
        const pool = await prisma.player.findMany({ where: { ...baseWhereR, ...(gender ? { gender: gender as any } : {}) } });
        const eligible = await filterExcluded(pool);
        const perfect = eligible.filter(p => p.skillLevel === match.skillLevel).sort(sortRecovery);
        const adjacent = eligible.filter(p => p.skillLevel !== match.skillLevel).sort(sortRecovery);
        return [...perfect, ...adjacent];
    };

    // MISTO: recupera M e F separatamente per i posti rimasti
    if (match.isMixed && explicitTargetR !== 'MALE' && explicitTargetR !== 'FEMALE') {
        const maleCount = participantsR.filter(p => p.gender === 'MALE').length;
        const femaleCount = participantsR.filter(p => p.gender === 'FEMALE').length;
        const results: any[] = [];
        if (maleCount < 2) results.push(...await fetchAndSort('MALE'));
        if (femaleCount < 2) results.push(...await fetchAndSort('FEMALE'));
        return results;
    }

    // NON-MISTO
    let targetGender: string | null = null;
    if (explicitTargetR === 'MALE' || explicitTargetR === 'FEMALE') {
        targetGender = explicitTargetR;
    } else if (explicitTargetR !== 'ANY') {
        if (participantsR.length > 0) {
            const genders = Array.from(new Set(participantsR.map(p => p.gender)));
            if (genders.length === 1 && genders[0] !== 'UNKNOWN') targetGender = genders[0];
        }
    }
    return fetchAndSort(targetGender);
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
    const [y, mo, dd] = dateStr.split('-').map(Number);
    const targetDay = romeHour >= 22 ? dd + 1 : dd;

    // Costruisci le 08:00 (wall-clock) del giorno target. Date.UTC normalizza l'overflow di
    // giorno/mese (es. 32 maggio → 1 giugno), evitando il NaN che dava la stringa "2026-05-32T..."
    // a fine mese — bug che faceva fallire la riprogrammazione notturna delle wave.
    const wallClock = new Date(Date.UTC(y, mo - 1, targetDay, 8, 0, 0));
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
    await updateShowUpRate(playerId, false, 60); // penalità PIENA: no-show / fantasma
}

/**
 * Penalità LIEVE per chi declina educatamente ("non ci sono"): ha comunicato, possiamo
 * cercare un sostituto → pesa meno di un fantasma che non risponde affatto.
 */
export async function declineReliability(playerId: string): Promise<void> {
    await updateShowUpRate(playerId, false, 360, DECLINE_WEIGHT);
}

// ═══════════════════════════════════════════════════════════════════════════
// RELIABILITY v2 — finestra di conversione su eventi OSSERVABILI
// reliability = media degli ultimi N inviti "validi" (= con segnale).
// Niente EMA accumulata: il punteggio si RICALCOLA dagli outcome, così il recente
// pesa e il vecchio esce dalla finestra (richiesta: "finestra mobile").
// ═══════════════════════════════════════════════════════════════════════════

export const RELIAB_WINDOW = 20;     // ultimi N inviti "validi"
const NEARBY_DAYS = 7;               // ±giorni: se ha già una partita vicina, declina/fantasma è scontato
const NEARBY_DISCOUNT = 0.5;         // valore di declina/fantasma quando ha una partita vicina
const RELIAB_PRIOR_SMOOTH = 3;       // osservazioni-prior virtuali (smoothing): tempera i pochi dati

// Outcome possibili (campo Invitation.outcome). Valore nella finestra; null = ESCLUSO.
export type InvOutcome =
    | 'ACCEPTED' | 'DECLINED' | 'GHOST' | 'CANCELLED_AFTER_ACCEPT'
    | 'WILLING_FULL' | 'MATCH_CANCELLED' | 'SLOT_FILLED';

function outcomeValue(outcome: string, nearby: boolean): number | null {
    switch (outcome) {
        case 'ACCEPTED': return 1;                    // conversione riuscita
        case 'CANCELLED_AFTER_ACCEPT': return 0;      // ha accettato e si è tirato indietro
        case 'DECLINED':
        case 'GHOST': return nearby ? NEARBY_DISCOUNT : 0; // non convertito (scontato se ha partita vicina)
        case 'WILLING_FULL':                          // voleva ma era pieno → nessuna colpa
        case 'MATCH_CANCELLED':                       // partita non giocata
        case 'SLOT_FILLED':                           // slot chiuso prima che potesse → nessuna chance
        default: return null;                         // ESCLUSO dalla finestra
    }
}

// Fallback per inviti storici senza `outcome` esplicito (inferenza da status/respondedAt).
function inferOutcome(status: string, respondedAt: Date | null): string | null {
    switch (status) {
        case 'ACCEPTED': return 'ACCEPTED';
        case 'REJECTED': return 'DECLINED';
        case 'EXPIRED': return 'GHOST';
        case 'IGNORED': return respondedAt ? 'WILLING_FULL' : 'MATCH_CANCELLED'; // chiuso dal sistema → escluso
        default: return null; // PENDING: non ancora deciso
    }
}

/** Calcola (senza scrivere) la reliability v2 dagli ultimi inviti del giocatore. */
export async function computeWindowedReliability(playerId: string): Promise<number> {
    const invs = await prisma.invitation.findMany({
        where: { playerId },
        orderBy: { sentAt: 'desc' },
        take: 200,
        include: { match: { select: { startTime: true } } },
    });
    // Partite confermate (giocate o in programma) per lo "sconto partita vicina".
    const confirmed = await prisma.matchPlayer.findMany({
        where: { playerId, leftAt: null, match: { status: 'LOCKED' } },
        include: { match: { select: { startTime: true } } },
    });
    const confTimes = confirmed.map(c => c.match.startTime.getTime());
    const DAY = 24 * 60 * 60 * 1000;

    const vals: number[] = [];
    for (const i of invs) {
        if (vals.length >= RELIAB_WINDOW) break;
        const outcome = (i as any).outcome ?? inferOutcome(i.status, i.respondedAt);
        if (!outcome) continue;
        const mStart = i.match?.startTime?.getTime() ?? 0;
        const nearby = confTimes.some(t => Math.abs(t - mStart) <= NEARBY_DAYS * DAY);
        const v = outcomeValue(outcome, nearby);
        if (v === null) continue;
        vals.push(v);
    }
    // Smoothing bayesiano: RELIAB_PRIOR_SMOOTH "osservazioni-prior" virtuali a PRIOR.
    // Su pochi dati il punteggio resta vicino al prior (un singolo evento non manda a 0/1),
    // e converge al tasso vero man mano che la finestra si riempie. Con vals vuoto → PRIOR.
    const sum = vals.reduce((a, b) => a + b, 0);
    return (sum + PRIOR * RELIAB_PRIOR_SMOOTH) / (vals.length + RELIAB_PRIOR_SMOOTH);
}

/** Tagga l'outcome di un invito e ricalcola la reliability del giocatore. */
export async function setInvitationOutcome(invitationId: string, outcome: InvOutcome): Promise<void> {
    const inv = await prisma.invitation.update({
        where: { id: invitationId },
        data: { outcome } as any,
        select: { playerId: true },
    }).catch(() => null);
    if (inv?.playerId) await recomputeReliability(inv.playerId);
}

/** Ricalcola e salva la reliability v2 del giocatore dalla finestra. */
export async function recomputeReliability(playerId: string): Promise<void> {
    const score = await computeWindowedReliability(playerId);
    await prisma.player.update({ where: { id: playerId }, data: { reliabilityScore: score } }).catch(() => {});
}
