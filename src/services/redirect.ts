/**
 * REDIRECT SERVICE
 *
 * Algoritmo di dirottamento intent-aware.
 * Chiamato ogni volta che N giocatori vengono rimossi da una partita
 * per qualsiasi motivo (disdetta, cancellazione, slot preso, pool esaurito),
 * oppure quando un booking fallisce (slot pieno, nessun match aperto).
 *
 * L'intent determina la strategia di ricerca:
 *
 * BOOK_FIELD (prenotazione privata / skill<=0):
 *   - Slot 1: slot libero più vicino PRIMA di T nello stesso giorno (Rome tz)
 *   - Slot 2: slot libero più vicino DOPO T nello stesso giorno
 *   - Slot 3-5: stesso orario di T in giorni successivi (fino a 7 giorni) dove c'è un campo libero
 *   - Max 5 opzioni totali
 *
 * MATCHMAKING (matchmaking / skill>0):
 *   - Match 1: OPEN match compatibile più vicino PRIMA di T nello stesso giorno
 *   - Match 2: OPEN match compatibile più vicino DOPO T nello stesso giorno
 *   - Match 3-5: OPEN match compatibili allo stesso orario di T in giorni diversi entro 7 giorni
 *   - MAX 5 opzioni totali
 *
 * Se non si raggiungono 5 opzioni si mostra quello che c'è (4, 3, 2...).
 */

import { prisma } from './db';
import { getRedis } from './queue';
import { simulateTypingAndSend, sendMessage } from './whatsapp';
import { formatMatchSlot } from '../utils/format-match';
import pino from 'pino';

const logger = pino({ level: 'info' });

const FREE_SLOT_WINDOW_DAYS  = 7;    // cerca slot liberi entro 7 giorni in avanti
const TARGET_OPTIONS = 5;

// Helper per estrarre H:M da un timestamp in Rome timezone
function getRomeHM(d: Date): { h: number; m: number } {
    const s = d.toLocaleString('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false });
    const [h, m] = s.split(':').map(Number);
    return { h, m };
}

// Helper per costruire timestamp UTC da una data base + H:M in Rome timezone
// Segue la stessa logica di buildRomeTime in brain.ts
function buildRomeTimestamp(baseDate: Date, h: number, m: number): Date {
    const noon = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate(), 12, 0, 0));
    const noonRomeHour = Number(noon.toLocaleString('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }));
    const offsetH = noonRomeHour - 12;
    let utcH = h - offsetH;
    let dayOffset = 0;
    if (utcH < 0) { utcH += 24; dayOffset = -1; }
    if (utcH >= 24) { utcH -= 24; dayOffset = 1; }
    return new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate() + dayOffset, utcH, m, 0));
}

// Ritorna la data base del giorno in UTC (mezzanotte UTC del giorno in cui cade referenceTime in Rome tz)
function getDayBaseUTC(referenceTime: Date): Date {
    const romeStr = referenceTime.toLocaleString('en-US', {
        timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
    });
    // romeStr: "MM/DD/YYYY"
    const [mm, dd, yyyy] = romeStr.split('/').map(Number);
    return new Date(Date.UTC(yyyy, mm - 1, dd));
}

// ─────────────────────────────────────────────
// TIPI
// ─────────────────────────────────────────────

export interface RedirectOption {
    priority: 1 | 2 | 3;
    matchId?: string;               // se partita esistente
    court: string;
    courtId?: string | null;
    courtIsCovered: boolean | null;
    startTime: Date;
    spotsLeft?: number;
    willLock: boolean;
    isOpenMatch: boolean;           // true = matchmaking open, false = campo da affittare
    description: string;
}

export interface RedirectGroup {
    referentPhone: string;
    referentJid: string;
    playerPhones: string[];
    playerCount: number;
    originalMatchId: string;
    originalStartTime: Date;
    originalSkillLevel: number;         // -1 = non testato, >=1.0 = testato
    originalCourtIsCovered: boolean | null; // tipologia campo originale — null = qualsiasi
    originalCourtName?: string;             // nome campo — per messaggi più specifici
    reason: 'CANCELLED' | 'UNFILLED' | 'SLOT_TAKEN' | 'POOL_EXHAUSTED' | 'CANCELLATION';
    clubId: string;
    // Nuovo campo intent-aware: determina quale algoritmo di ricerca usare
    intent?: 'BOOK_FIELD' | 'MATCHMAKING';
}

// ─────────────────────────────────────────────
// ENTRY POINT PRINCIPALE
// ─────────────────────────────────────────────

export async function redirectGroup(group: RedirectGroup): Promise<void> {
    logger.info(`Redirecting ${group.playerCount} players from match ${group.originalMatchId} (intent: ${group.intent || 'auto'})`);

    // Dedup: evita messaggi duplicati se due job recovery girano in parallelo per lo stesso match.
    // La chiave include referentJid e reason: con originalMatchId='none' (caso BOOK_FIELD) un lock
    // sul solo matchId sarebbe condiviso fra TUTTI gli utenti → il secondo utente non riceverebbe il
    // redirect. TTL breve: basta a deduplicare job paralleli, non blocca un redirect legittimo successivo.
    const redis = getRedis();
    // La chiave include anche l'orario richiesto: senza, due booking falliti ravvicinati
    // (orari diversi) entro il TTL condividevano il lock e il secondo redirect spariva.
    const lockKey = `redirect:sent:${group.referentJid}:${group.originalMatchId}:${group.reason}:${new Date(group.originalStartTime).getTime()}`;
    const acquired = await redis.set(lockKey, '1', 'EX', 90, 'NX').catch(() => null);
    if (!acquired) {
        logger.warn({ matchId: group.originalMatchId, referentJid: group.referentJid, reason: group.reason }, 'redirectGroup: già inviato — skip duplicato');
        return;
    }

    const options = await findRedirectOptions(
        group.playerCount,
        group.originalStartTime,
        group.originalMatchId,
        group.clubId,
        group.originalSkillLevel,
        group.originalCourtIsCovered,
        group.intent,
    );

    const message = buildRedirectMessage(group, options);

    await simulateTypingAndSend(group.referentJid, message);

    // Salva lo stato SOLO se ci sono opzioni da scegliere.
    // Con options.length === 0 il messaggio invita a scrivere liberamente → il brain gestisce il prossimo turno.
    if (options.length > 0) {
        try {
            const { setState } = await import('./conversation-state');
            await setState(`state:role:${group.referentJid}:AWAITING_REDIRECT_CHOICE`, { group, options }, 600);
        } catch (err) {
            logger.error({ err }, 'Failed to save redirect state');
        }
    }

    for (const phone of group.playerPhones) {
        if (phone === group.referentPhone) continue;
        try {
            await simulateTypingAndSend(phone, buildPlayerNotificationMessage(group));
        } catch (err) {
            logger.error({ err }, `Failed to notify player ${phone} of redirect`);
        }
    }
}

// ─────────────────────────────────────────────
// TROVA OPZIONI (intent-aware)
// ─────────────────────────────────────────────

export async function findRedirectOptions(
    playerCount: number,
    referenceTime: Date,
    excludeMatchId: string,
    clubId: string,
    originalSkillLevel: number = 0,
    originalCourtIsCovered: boolean | null = null,
    intent?: 'BOOK_FIELD' | 'MATCHMAKING',
): Promise<RedirectOption[]> {
    // Determina l'intent effettivo: se non esplicito, usa la logica precedente
    // (MATCHMAKING se skill>0, BOOK_FIELD altrimenti)
    const effectiveIntent: 'BOOK_FIELD' | 'MATCHMAKING' =
        intent ?? (originalSkillLevel > 0 ? 'MATCHMAKING' : 'BOOK_FIELD');

    if (effectiveIntent === 'BOOK_FIELD') {
        return findRedirectOptionsBookField(referenceTime, excludeMatchId, clubId, originalCourtIsCovered);
    } else {
        return findRedirectOptionsMatchmaking(playerCount, referenceTime, excludeMatchId, clubId, originalSkillLevel);
    }
}

/**
 * BOOK_FIELD redirect: cerca slot liberi (campo non occupato) vicini a referenceTime.
 *
 * - Slot 1: slot libero più vicino PRIMA di T nello stesso giorno (Rome tz)
 * - Slot 2: slot libero più vicino DOPO T nello stesso giorno (Rome tz)
 * - Slot 3-5: stesso orario di T nei giorni successivi (fino a 7 giorni) dove esiste almeno un campo libero
 *
 * Se il tipo di campo preferito non produce abbastanza opzioni, fa un secondo giro
 * col tipo opposto (coperto ↔ scoperto) per non lasciare l'utente senza alternative.
 */
async function findRedirectOptionsBookField(
    referenceTime: Date,
    excludeMatchId: string,
    clubId: string,
    originalCourtIsCovered: boolean | null = null,
): Promise<RedirectOption[]> {
    const options = await _bookFieldSearch(referenceTime, excludeMatchId, clubId, originalCourtIsCovered);

    // Se abbiamo preferenza di tipo ma mancano opzioni → fallback col tipo opposto
    if (originalCourtIsCovered !== null && options.length < TARGET_OPTIONS) {
        const fallback = await _bookFieldSearch(referenceTime, excludeMatchId, clubId, !originalCourtIsCovered);
        // Deduplica per startTime (evita di proporre lo stesso slot già trovato)
        const existingKeys = new Set(options.map(o => o.startTime.toISOString()));
        for (const o of fallback) {
            if (options.length >= TARGET_OPTIONS) break;
            if (!existingKeys.has(o.startTime.toISOString())) {
                options.push(o);
                existingKeys.add(o.startTime.toISOString());
            }
        }
    }

    return options;
}

async function _bookFieldSearch(
    referenceTime: Date,
    excludeMatchId: string,
    clubId: string,
    isCoveredFilter: boolean | null,
): Promise<RedirectOption[]> {
    const options: RedirectOption[] = [];

    // Non proporre mai slot già passati (o che inizierebbero tra pochissimo): floor su now + 10 min
    const nowFloorMs = Date.now() + 10 * 60 * 1000;

    // Durata partita del circolo (default 90) — determina la "footprint" degli slot proposti
    const clubCfg = await prisma.club.findUnique({ where: { id: clubId }, select: { matchDuration: true } });
    const matchDurationMin = clubCfg?.matchDuration || 90;

    const courts = await prisma.court.findMany({
        where: { clubId, active: true, ...(isCoveredFilter !== null ? { isCovered: isCoveredFilter } : {}) },
        select: { id: true, name: true, isCovered: true },
        orderBy: { name: 'asc' },
    });
    if (courts.length === 0) return [];

    // Calcola inizio e fine giorno in Rome timezone per il giorno di referenceTime
    const dayBase = getDayBaseUTC(referenceTime);
    const dayStart = buildRomeTimestamp(dayBase, 0, 0);
    const dayEnd = buildRomeTimestamp(dayBase, 23, 59);

    // Trova tutti i match che occupano campi in un range ampio (stesso giorno + 7 giorni futuri)
    const windowEnd = new Date(dayBase.getTime() + FREE_SLOT_WINDOW_DAYS * 86_400_000 + 24 * 3600_000);
    const allOccupied = await prisma.match.findMany({
        where: {
            clubId,
            id: { not: excludeMatchId },
            // Include solo match che bloccano veramente il campo: OPEN con ≥3 confermati O LOCKED
            // oppure controlla separatamente per la logica displacement — qui usiamo approccio semplice:
            // un campo è considerato "libero" se non ha match OPEN con ≥3 confermati o LOCKED.
            status: { in: ['OPEN', 'LOCKED'] },
            startTime: { gte: dayStart, lte: windowEnd },
        },
        include: { MatchPlayer: { where: { leftAt: null } } },
    });

    // Costruisci mappa di intervalli occupati per campo (courtId → [{start, end}]).
    // Usa interval overlap per bloccare slot che si sovrappongono con partite esistenti,
    // non solo lo slot di inizio esatto — es. una partita alle 10:00 da 90min blocca anche le 9:30 e le 11:00.
    const DEFAULT_MATCH_DURATION_MS = matchDurationMin * 60 * 1000;
    const occupiedIntervals = new Map<string, { start: number; end: number }[]>();

    for (const m of allOccupied as any[]) {
        const confirmedCount = (m.MatchPlayer as any[]).filter((mp: any) => !mp.leftAt).length;
        if (m.status === 'LOCKED' || confirmedCount >= 3) {
            const start = new Date(m.startTime).getTime();
            const end = m.endTime ? new Date(m.endTime).getTime() : start + DEFAULT_MATCH_DURATION_MS;
            const cid = m.courtId as string;
            if (!occupiedIntervals.has(cid)) occupiedIntervals.set(cid, []);
            occupiedIntervals.get(cid)!.push({ start, end });
        }
    }

    // Un nuovo match che parte a T su campo C è libero se nessun intervallo su C si sovrappone con [T, T+90min]
    const isSlotFree = (courtId: string, slotStart: Date): boolean => {
        const t = slotStart.getTime();
        const t2 = t + DEFAULT_MATCH_DURATION_MS;
        return !(occupiedIntervals.get(courtId) ?? []).some(i => t < i.end && t2 > i.start);
    };

    const STEP_MS = 30 * 60 * 1000;

    // ── Slot 1 & 2: stesso giorno, prima e dopo referenceTime ────────────────
    // Prima cerca il più vicino PRIMA di T nello stesso giorno
    let before: { court: string; courtId: string; isCovered: boolean; startTime: Date } | null = null;
    {
        let t = new Date(referenceTime.getTime() - STEP_MS);
        while (t >= dayStart && t.getTime() >= nowFloorMs) {
            for (const c of courts) {
                if (isSlotFree(c.id, t)) {
                    before = { court: c.name, courtId: c.id, isCovered: c.isCovered, startTime: new Date(t) };
                    break;
                }
            }
            if (before) break;
            t = new Date(t.getTime() - STEP_MS);
        }
    }
    if (before) {
        options.push({
            priority: 1,
            court: before.court,
            courtId: before.courtId,
            courtIsCovered: before.isCovered,
            startTime: before.startTime,
            willLock: false,
            isOpenMatch: false,
            description: buildOptionDescription(false, before.court, before.isCovered, before.startTime, 4),
        });
    }

    // Poi cerca il più vicino DOPO T nello stesso giorno
    if (options.length < TARGET_OPTIONS) {
        let after: { court: string; courtId: string; isCovered: boolean; startTime: Date } | null = null;
        {
            // Inizia da referenceTime stesso (arrotondato al passo successivo)
            let t = new Date(referenceTime.getTime() + STEP_MS);
            while (t <= dayEnd) {
                if (t.getTime() >= nowFloorMs) {
                    for (const c of courts) {
                        if (isSlotFree(c.id, t)) {
                            after = { court: c.name, courtId: c.id, isCovered: c.isCovered, startTime: new Date(t) };
                            break;
                        }
                    }
                    if (after) break;
                }
                t = new Date(t.getTime() + STEP_MS);
            }
        }
        if (after) {
            options.push({
                priority: 1,
                court: after.court,
                courtId: after.courtId,
                courtIsCovered: after.isCovered,
                startTime: after.startTime,
                willLock: false,
                isOpenMatch: false,
                description: buildOptionDescription(false, after.court, after.isCovered, after.startTime, 4),
            });
        }
    }

    // ── Slot 3-5: stesso orario di T in giorni successivi entro 7 giorni ─────
    const { h: refH, m: refM } = getRomeHM(referenceTime);

    for (let d = 1; d <= FREE_SLOT_WINDOW_DAYS && options.length < TARGET_OPTIONS; d++) {
        const futureBase = new Date(dayBase.getTime() + d * 86_400_000);
        const futureSlot = buildRomeTimestamp(futureBase, refH, refM);

        for (const c of courts) {
            if (isSlotFree(c.id, futureSlot)) {
                options.push({
                    priority: 2,
                    court: c.name,
                    courtId: c.id,
                    courtIsCovered: c.isCovered,
                    startTime: futureSlot,
                    willLock: false,
                    isOpenMatch: false,
                    description: buildOptionDescription(false, c.name, c.isCovered, futureSlot, 4),
                });
                break; // un campo per giorno è sufficiente
            }
        }
    }

    return options;
}

/**
 * MATCHMAKING redirect: cerca OPEN match skill-compatibili vicini a referenceTime.
 *
 * - Match 1: OPEN match compatibile più vicino PRIMA di T nello stesso giorno
 * - Match 2: OPEN match compatibile più vicino DOPO T nello stesso giorno
 * - Match 3-5: OPEN match compatibili allo stesso orario di T in giorni successivi entro 7 giorni
 */
async function findRedirectOptionsMatchmaking(
    playerCount: number,
    referenceTime: Date,
    excludeMatchId: string,
    clubId: string,
    originalSkillLevel: number,
): Promise<RedirectOption[]> {
    const options: RedirectOption[] = [];

    // Se skill non assegnato, non possiamo fare matchmaking — fallback a BOOK_FIELD
    if (originalSkillLevel <= 0) {
        return findRedirectOptionsBookField(referenceTime, excludeMatchId, clubId, null);
    }

    const club = await prisma.club.findUnique({
        where: { id: clubId },
        select: { matchLowerRange: true, matchUpperRange: true },
    });
    const lowerRange = club?.matchLowerRange ?? 1.0;
    const upperRange = club?.matchUpperRange ?? 1.0;
    const skillMin = originalSkillLevel - lowerRange;
    const skillMax = originalSkillLevel + upperRange;

    const dayBase = getDayBaseUTC(referenceTime);
    const dayStart = buildRomeTimestamp(dayBase, 0, 0);
    const dayEnd = buildRomeTimestamp(dayBase, 23, 59);

    // Carica tutti gli OPEN match skill-compatibili nel giorno di riferimento
    const sameDayMatches = await prisma.match.findMany({
        where: {
            clubId,
            id: { not: excludeMatchId },
            status: 'OPEN',
            startTime: { gte: dayStart, lte: dayEnd },
            skillLevel: { gte: skillMin, lte: skillMax },
        },
        include: {
            MatchPlayer: { where: { leftAt: null } },
            court: true,
        },
        orderBy: { startTime: 'asc' },
    });

    // Filtra per posti disponibili sufficienti
    const sameDayEligible = sameDayMatches.filter(m =>
        (m.playersNeeded - m.MatchPlayer.length) >= playerCount
    );

    // Match più vicino PRIMA di T
    const before = sameDayEligible
        .filter(m => m.startTime < referenceTime)
        .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())[0];

    if (before) {
        const spotsLeft = before.playersNeeded - before.MatchPlayer.length;
        options.push({
            priority: spotsLeft === playerCount ? 1 : 2,
            matchId: before.id,
            court: before.court?.name || 'Campo',
            courtId: before.courtId,
            courtIsCovered: before.court?.isCovered ?? null,
            startTime: before.startTime,
            spotsLeft,
            willLock: spotsLeft === playerCount,
            isOpenMatch: true,
            description: buildOptionDescription(true, before.court?.name || 'Campo', before.court?.isCovered ?? null, before.startTime, spotsLeft),
        });
    }

    // Match più vicino DOPO T
    if (options.length < TARGET_OPTIONS) {
        const after = sameDayEligible
            .filter(m => m.startTime >= referenceTime)
            .sort((a, b) => a.startTime.getTime() - b.startTime.getTime())[0];

        if (after) {
            const spotsLeft = after.playersNeeded - after.MatchPlayer.length;
            options.push({
                priority: spotsLeft === playerCount ? 1 : 2,
                matchId: after.id,
                court: after.court?.name || 'Campo',
                courtId: after.courtId,
                courtIsCovered: after.court?.isCovered ?? null,
                startTime: after.startTime,
                spotsLeft,
                willLock: spotsLeft === playerCount,
                isOpenMatch: true,
                description: buildOptionDescription(true, after.court?.name || 'Campo', after.court?.isCovered ?? null, after.startTime, spotsLeft),
            });
        }
    }

    // ── Match 3-5: stesso orario di T in giorni successivi entro 7 giorni ────
    const { h: refH, m: refM } = getRomeHM(referenceTime);

    for (let d = 1; d <= FREE_SLOT_WINDOW_DAYS && options.length < TARGET_OPTIONS; d++) {
        const futureBase = new Date(dayBase.getTime() + d * 86_400_000);
        const futureSlot = buildRomeTimestamp(futureBase, refH, refM);
        const futureSlotEnd = new Date(futureSlot.getTime() + 30 * 60 * 1000);

        const futureMatches = await prisma.match.findMany({
            where: {
                clubId,
                id: { not: excludeMatchId },
                status: 'OPEN',
                startTime: { gte: futureSlot, lte: futureSlotEnd },
                skillLevel: { gte: skillMin, lte: skillMax },
            },
            include: {
                MatchPlayer: { where: { leftAt: null } },
                court: true,
            },
            take: 1,
        });

        for (const m of futureMatches) {
            const spotsLeft = m.playersNeeded - m.MatchPlayer.length;
            if (spotsLeft < playerCount) continue;
            options.push({
                priority: 2,
                matchId: m.id,
                court: m.court?.name || 'Campo',
                courtId: m.courtId,
                courtIsCovered: m.court?.isCovered ?? null,
                startTime: m.startTime,
                spotsLeft,
                willLock: spotsLeft === playerCount,
                isOpenMatch: true,
                description: buildOptionDescription(true, m.court?.name || 'Campo', m.court?.isCovered ?? null, m.startTime, spotsLeft),
            });
            break;
        }
    }

    // Fallback: se non ci sono match OPEN da joinare, offri slot liberi come BOOK_FIELD
    // (es. staging con pochi giocatori, o orario strano senza partite aperte)
    if (options.length === 0) {
        return findRedirectOptionsBookField(referenceTime, excludeMatchId, clubId, null);
    }

    return options;
}

// ─────────────────────────────────────────────
// NOTIFY DISPLACED PLAYERS (fire-and-forget, usato da createNewMatchAction)
// ─────────────────────────────────────────────

/**
 * Notifica i giocatori di un match OPEN che è stato "spostato" (displacement)
 * perché un BOOK_FIELD ha preso il loro campo.
 *
 * - Pending invitations: solo notifica "campo non più disponibile"
 * - Confirmed players: notifica + redirect con intent MATCHMAKING
 *
 * Questa funzione è fire-and-forget: viene chiamata senza await da createNewMatchAction.
 */
export async function notifyDisplacedPlayers(
    displacedMatchId: string,
    confirmedPlayers: { id: string; phoneNumber: string; name: string | null; skillLevel: number }[],
    pendingPlayerPhones: string[],
    clubId: string,
    originalStartTime: Date,
    originalSkillLevel: number,
    isPrivateBooking: boolean = false,
): Promise<void> {
    // Notifica i pending invitations: solo avviso, no redirect
    for (const phone of pendingPlayerPhones) {
        const jid = `${phone}@s.whatsapp.net`;
        try {
            await simulateTypingAndSend(jid,
                'Il posto per cui eri stato invitato non è più disponibile 😔'
            );
        } catch (err) {
            logger.warn({ err, phone }, 'notifyDisplacedPlayers: failed to notify pending player');
        }
    }

    // Notifica i confirmed players + redirect MATCHMAKING
    if (confirmedPlayers.length > 0) {
        // Slot della partita saltata — giorno+ora in priorità, MAI nome campo nei messaggi (Punto 5)
        let slotLabel = '';
        try {
            const { prisma } = await import('./db');
            const dm = await prisma.match.findUnique({ where: { id: displacedMatchId }, select: { startTime: true } });
            if (dm) slotLabel = formatMatchSlot(dm.startTime);
        } catch { /* ignore */ }

        // Invia prima la notifica a ogni confermato
        for (const p of confirmedPlayers) {
            const jid = `${p.phoneNumber}@s.whatsapp.net`;
            try {
                const slotTakenVariants = slotLabel ? [
                    `Il posto di ${slotLabel} è stato preso da qualcun altro 😕 Cerco subito un'alternativa!`,
                    `Purtroppo il posto di ${slotLabel} è stato occupato 😔 Ti trovo qualcosa di simile!`,
                    `Qualcuno ti ha soffiato il posto di ${slotLabel} 😅 Cerco subito un'alternativa!`,
                    `Il tuo posto di ${slotLabel} è andato 😕 Mi metto subito a cercare!`,
                    `Il posto di ${slotLabel} non è più libero 😔 Dammi un secondo che trovo qualcos'altro!`,
                    `Qualcuno ha appena preso il posto di ${slotLabel} — cerco subito un'alternativa 🎾`,
                    `Il posto di ${slotLabel} è stato occupato 😕 Ti buco subito qualcosa di disponibile!`,
                    `Il posto che avevi di ${slotLabel} è stato preso 😔 Sto cercando un'alternativa!`,
                    `Il posto di ${slotLabel} è volato via 😅 Vediamo cos'altro c'è disponibile per te!`,
                    `Mannaggia, il posto di ${slotLabel} è stato soffiato 😔 Cerco subito!`,
                ] : [
                    `Il tuo posto è stato preso da qualcun altro 😕 Cerco subito un'alternativa!`,
                    `Purtroppo il tuo slot è stato occupato 😔 Ti trovo qualcosa di simile!`,
                    `Qualcuno ti ha soffiato il posto 😅 Cerco subito un'alternativa!`,
                    `Il tuo posto è andato 😕 Mi metto subito a cercare!`,
                    `Il tuo slot non è più disponibile 😔 Dammi un secondo!`,
                    `Qualcuno ha appena preso il tuo posto — cerco subito un'alternativa 🎾`,
                    `Il tuo slot è stato occupato 😕 Ti buco subito qualcosa di disponibile!`,
                    `Il posto che avevi è stato preso 😔 Sto cercando un'alternativa!`,
                    `Il tuo slot è volato via 😅 Vediamo cos'altro c'è disponibile per te!`,
                    `Mannaggia, il tuo posto è stato soffiato 😔 Cerco subito!`,
                ];
                const msg = slotTakenVariants[Math.floor(Math.random() * slotTakenVariants.length)];
                await simulateTypingAndSend(jid, msg);
            } catch (err) {
                logger.warn({ err, phone: p.phoneNumber }, 'notifyDisplacedPlayers: failed to notify confirmed player');
            }
        }

        // Redirect per il referente — usa intent corretto in base al tipo di partita displacata
        try {
            await redirectGroup({
                clubId,
                referentPhone: confirmedPlayers[0].phoneNumber,
                referentJid: `${confirmedPlayers[0].phoneNumber}@s.whatsapp.net`,
                playerPhones: confirmedPlayers.map(p => p.phoneNumber),
                playerCount: confirmedPlayers.length,
                originalMatchId: displacedMatchId,
                originalStartTime,
                originalSkillLevel,
                originalCourtIsCovered: null,
                reason: 'SLOT_TAKEN',
                intent: isPrivateBooking ? 'BOOK_FIELD' : 'MATCHMAKING',
            });
        } catch (err) {
            logger.warn({ err, matchId: displacedMatchId }, 'notifyDisplacedPlayers: redirectGroup failed');
        }
    }
}

// ─────────────────────────────────────────────
// CONFERMA SCELTA
// ─────────────────────────────────────────────

export async function confirmRedirectChoice(
    jid: string,
    choiceText: string,
    pendingState: { group: RedirectGroup; options: RedirectOption[] }
): Promise<void> {
    // Rehydrate Date fields: JSON/Redis serializza i Date come stringhe ISO
    const options: RedirectOption[] = (pendingState.options ?? []).map(o => ({
        ...o,
        startTime: o.startTime instanceof Date ? o.startTime : new Date(o.startTime as any),
    }));
    const group: RedirectGroup = {
        ...pendingState.group,
        originalStartTime: pendingState.group.originalStartTime instanceof Date
            ? pendingState.group.originalStartTime
            : new Date(pendingState.group.originalStartTime as any),
    };

    // Stato corrotto o salvato senza opzioni: pulisci e lascia gestire al brain
    if (!options || options.length === 0) {
        try {
            const { clearState } = await import('./conversation-state');
            await clearState(`state:role:${jid}:AWAITING_REDIRECT_CHOICE`);
        } catch {}
        return;
    }

    const chosenOption = await resolveChoice(choiceText, options);

    if (!chosenOption) {
        // Contatore tentativi falliti — dopo 2 sblocca la conversazione e lascia al brain
        const { getRedis } = await import('./queue');
        const redis = getRedis();
        const attemptsKey = `redirect:attempts:${jid}`;
        const attempts = parseInt(await redis.get(attemptsKey) ?? '0', 10) + 1;
        await redis.set(attemptsKey, String(attempts), 'EX', 600);

        if (attempts >= 2) {
            // Sblocca: pulisce stato e lascia che il brain gestisca il prossimo messaggio
            const { clearState } = await import('./conversation-state');
            await clearState(`state:role:${jid}:AWAITING_REDIRECT_CHOICE`).catch(() => {});
            await redis.del(attemptsKey);
            await simulateTypingAndSend(jid, `Nessun problema, dimmi pure cosa preferisci e ci penso io 🎾`);
            return;
        }

        const clarifyVariants = [
            `Non ho capito quale preferisci, dimmi il numero dell'opzione o l'orario e mi metto subito 😅`,
            `Aiutami: scrivi il numero dell'opzione che vuoi (es. "la prima", "opzione 2") 🎾`,
            `Non sono sicuro di aver capito, ripeti con il numero dell'opzione o l'orario? 😊`,
            `Quale prendi? Dimmi solo il numero e prenoto subito!`,
            `Non ho capito bene, scrivi solo il numero dell'opzione e penso a tutto io 🎾`,
        ];
        await simulateTypingAndSend(jid, clarifyVariants[Math.floor(Math.random() * clarifyVariants.length)]);
        return;
    }

    try {
        const { clearState } = await import('./conversation-state');
        await clearState(`state:role:${jid}:AWAITING_REDIRECT_CHOICE`);
    } catch (err) {
        logger.error({ err }, 'Failed to clear redirect state');
    }

    if (chosenOption.matchId) {
        await addGroupToMatch(chosenOption.matchId, group);
    } else {
        await createMatchForGroup(chosenOption, group);
    }
}

// ─────────────────────────────────────────────
// AGGIUNGI GRUPPO A PARTITA ESISTENTE
// ─────────────────────────────────────────────

async function addGroupToMatch(matchId: string, group: RedirectGroup): Promise<void> {
    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: true, club: true },
    });

    if (!match || match.status !== 'OPEN') {
        const _closedMsgs = [
            "Mi dispiace, quella partita si è nel frattempo chiusa! Vuoi scegliere un'altra opzione?",
            "Quella partita si è chiusa appena prima, scegli un'altra opzione 😔",
            "Ops, quella partita non è più disponibile, quale altra preferisci? 😅",
            "Quella si è chiusa nel frattempo, quale opzione scegli? 😔",
            "Arrivato un attimo tardi su quella, hai un'altra preferenza? 😕",
        ];
        await simulateTypingAndSend(group.referentJid, _closedMsgs[Math.floor(Math.random() * _closedMsgs.length)]);
        return;
    }

    const spotsLeft = match.playersNeeded - match.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
    if (spotsLeft < group.playerCount) {
        const _spotsMsgs = [
            "Mi dispiace, i posti disponibili sono cambiati! Vuoi scegliere un'altra opzione?",
            "Peccato, i posti sono cambiati nel frattempo, quale altra opzione preferisci? 😔",
            "Quella si è riempita appena prima di te, scegliene un'altra 😅",
            "I posti sono finiti su quella, ti va un'altra opzione? 😕",
            "Qualcuno ha appena preso l'ultimo posto, quale altra opzione ti va? 😔",
        ];
        await simulateTypingAndSend(group.referentJid, _spotsMsgs[Math.floor(Math.random() * _spotsMsgs.length)]);
        return;
    }

    // Riusa joinExistingMatch (brain.ts): transazione con FOR UPDATE, check genere,
    // lock gender-aware per i misti, upsert invitation (aggiorna eventuali PENDING →
    // niente falsi GHOST a fine partita). Import dinamico per evitare cicli di modulo.
    const { joinExistingMatch } = await import('./brain');
    let joinedAny = false;
    let lastError: string | null = null;
    for (const phone of group.playerPhones) {
        const player = await prisma.player.findFirst({ where: { phoneNumber: phone, clubId: group.clubId } });
        if (!player) continue;
        try {
            const res = await joinExistingMatch(matchId, player);
            if (res.success || res.errorMessage === 'ALREADY_JOINED') joinedAny = true;
            else lastError = res.errorMessage ?? null;
        } catch (err) {
            logger.error({ err, phone, matchId }, 'addGroupToMatch: joinExistingMatch failed');
        }
    }

    if (!joinedAny) {
        const _failMsgs: Record<string, string[]> = {
            GENDER_MISMATCH: [
                'Quella partita è riservata a giocatori di un altro genere, non posso aggiungerti 😔 Vuoi un\'altra opzione?',
            ],
            GENDER_SLOT_FULL: [
                'I posti per il tuo genere in quella partita si sono appena esauriti 😕 Vuoi scegliere un\'altra opzione?',
            ],
            DEFAULT: [
                'Mi dispiace, i posti disponibili sono cambiati! Vuoi scegliere un\'altra opzione?',
                'Quella si è riempita appena prima di te, scegliene un\'altra 😅',
                'Qualcuno ha appena preso l\'ultimo posto, quale altra opzione ti va? 😔',
            ],
        };
        const pool = _failMsgs[lastError ?? ''] ?? _failMsgs.DEFAULT;
        await simulateTypingAndSend(group.referentJid, pool[Math.floor(Math.random() * pool.length)]);
        return;
    }

    const updatedMatch = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: { where: { leftAt: null } }, court: true },
    });
    const newCount = updatedMatch!.MatchPlayer.length;
    const nowLocked = updatedMatch!.status === 'LOCKED';

    if (nowLocked) {
        if (match.groupId) {
            // Gruppo già esistente: aggiungi i nuovi e dai il benvenuto
            const { getSock } = await import('./whatsapp');
            const sock = getSock();
            if (sock) {
                for (const phone of group.playerPhones) {
                    await sock.groupParticipantsUpdate(match.groupId, [`${phone}@s.whatsapp.net`], 'add');
                }
                const newPlayers = await prisma.player.findMany({
                    where: { phoneNumber: { in: group.playerPhones }, clubId: group.clubId },
                    select: { name: true },
                });
                const newNames = newPlayers.map(p => (p.name || '').split(' ')[0]).filter(Boolean).join(', ') || 'i nuovi arrivati';
                const welcomeVariants = [
                    `Siamo al completo! Benvenuti ${newNames}, ci vediamo in campo! 🎾`,
                    `Gruppo al completo! Benvenuti ${newNames}, preparatevi! 🙌`,
                    `${newNames} sono con noi, squadra al completo! A presto! 🎾`,
                    `Perfetto, ci siamo tutti! Benvenuti ${newNames}, a presto! 🎾`,
                    `Il gruppo è al completo con ${newNames}! Ci vediamo in campo 🎾`,
                ];
                await sendMessage(match.groupId, welcomeVariants[Math.floor(Math.random() * welcomeVariants.length)]);
            }
        } else {
            // Nessun gruppo ancora: la partita si è riempita proprio con questo join →
            // crea gruppo WA + scheda riepilogo + reminder (come ogni altro path di riempimento)
            const { handleMatchFilled } = await import('./messageHandler');
            await handleMatchFilled(matchId, updatedMatch!.startTime).catch(err =>
                logger.error({ err, matchId }, 'addGroupToMatch: handleMatchFilled failed'));
        }
    }

    const timeStr = match.startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
    await simulateTypingAndSend(
        group.referentJid,
        `Perfetto! Vi ho segnati per le ${timeStr} al ${(updatedMatch as any).court?.name || 'Campo'} 🎾${nowLocked ? ' Siamo al completo!' : ' Aspettiamo gli altri.'}`
    );
}

// ─────────────────────────────────────────────
// CREA NUOVA PARTITA PER IL GRUPPO
// ─────────────────────────────────────────────

async function createMatchForGroup(option: RedirectOption, group: RedirectGroup): Promise<void> {
    // BOOK_FIELD redirect → match privato LOCKED (campo riservato per il gruppo)
    // MATCHMAKING redirect → match OPEN (cercano altri giocatori) — caso raro, di solito si sceglie un match esistente
    const isBookField = group.intent === 'BOOK_FIELD' || group.originalSkillLevel <= 0;

    const referent = await prisma.player.findFirst({ where: { phoneNumber: group.referentPhone, clubId: group.clubId } });
    // Priorità: originalSkillLevel del match displacato → skill attuale referente → default 3.5
    // Non usare la skill corrente del referente come prima scelta: potrebbe essere cambiata dopo il displacement
    const skillLevel = group.originalSkillLevel > 0
        ? group.originalSkillLevel
        : referent?.skillLevel && referent.skillLevel > 0 ? referent.skillLevel : 3.5;

    // Durata partita del circolo (default 90) per re-check occupazione + endTime del nuovo match
    const clubCfg = await prisma.club.findUnique({ where: { id: group.clubId }, select: { matchDuration: true } });
    const durationMin = clubCfg?.matchDuration || 90;

    // Re-check occupazione campo: tra l'invio delle opzioni e la scelta dell'utente (TTL 600s)
    // il campo può essere stato preso da qualcun altro → evita la doppia prenotazione.
    if (isBookField && option.courtId) {
        const SLOT_MS = durationMin * 60 * 1000;
        const candidates = await prisma.match.findMany({
            where: {
                clubId: group.clubId,
                courtId: option.courtId,
                status: { in: ['OPEN', 'LOCKED'] },
                startTime: { gte: new Date(option.startTime.getTime() - SLOT_MS), lte: new Date(option.startTime.getTime() + SLOT_MS) },
            },
            select: { startTime: true },
        });
        const conflict = candidates.some(m => Math.abs(m.startTime.getTime() - option.startTime.getTime()) < SLOT_MS);
        if (conflict) {
            const _takenMsgs = [
                "Mi dispiace, quel campo è stato appena preso! Vuoi scegliere un'altra opzione?",
                "Quel campo si è occupato un attimo prima, quale altra opzione preferisci? 😔",
                "Ops, quello slot non è più libero, scegline un altro 😅",
            ];
            await simulateTypingAndSend(group.referentJid, _takenMsgs[Math.floor(Math.random() * _takenMsgs.length)]);
            return;
        }
    }

    const match = await prisma.match.create({
        data: {
            clubId: group.clubId,
            courtId: option.courtId || null,
            startTime: option.startTime,
            endTime: new Date(option.startTime.getTime() + durationMin * 60000),
            skillLevel,
            playersNeeded: 4,
            status: isBookField ? 'LOCKED' : 'OPEN',
            isPrivateBooking: isBookField,
        },
    });

    for (const phone of group.playerPhones) {
        const player = await prisma.player.findFirst({ where: { phoneNumber: phone, clubId: group.clubId } });
        if (!player) continue;
        await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: player.id } });
        await prisma.invitation.create({
            data: { matchId: match.id, playerId: player.id, status: 'ACCEPTED' },
        });
    }

    const timeStr = option.startTime.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });

    if (isBookField) {
        await simulateTypingAndSend(
            group.referentJid,
            `Perfetto! Ti ho prenotato ${option.court} per le ${timeStr} 🎾 Ci vediamo in campo!`
        );
    } else {
        const spotsLeft = 4 - group.playerCount;
        if (spotsLeft > 0) {
            const { waveQueue } = await import('./queue');
            waveQueue.add('process-wave', {
                matchId: match.id,
                waveNumber: 1,
                limit: spotsLeft,
            }, {
                delay: Math.floor(Math.random() * 60000) + 30000,
            }).catch(err => logger.warn({ err, matchId: match.id }, 'Wave scheduling failed'));
        }
        await simulateTypingAndSend(
            group.referentJid,
            `Perfetto! Ho aperto una partita per le ${timeStr} al ${option.court} 🎾 ${spotsLeft > 0 ? `Cerco altri ${spotsLeft} giocatori!` : 'Siete al completo!'}`
        );
    }
}

// ─────────────────────────────────────────────
// UTILITY: risolvi scelta con AI
// ─────────────────────────────────────────────

async function resolveChoice(text: string, options: RedirectOption[]): Promise<RedirectOption | null> {
    const { anthropic } = await import('./ai');

    const optionsList = options.map((o, i) =>
        // timeZone obbligatorio: l'utente ha visto gli orari in ora italiana (buildOptionDescription) —
        // senza, Haiku riceveva orari UTC e "ok per le 18" non matchava nessuna opzione.
        `${i + 1}. ${o.court} alle ${o.startTime.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' })} (${o.description})`
    ).join('\n');

    const prompt = `
L'utente ha ricevuto questo elenco di opzioni:
${optionsList}

L'utente ha risposto: "${text}"

Quale opzione ha scelto? Rispondi SOLO con il numero (1, 2, 3, 4 o 5).
Se non è chiaro, rispondi: UNCLEAR
`;

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 5,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        });

        const content = response.content[0];
        if (content.type === 'text') {
            const choice = content.text.trim();
            if (choice === 'UNCLEAR') return null;
            const idx = parseInt(choice) - 1;
            if (idx >= 0 && idx < options.length) return options[idx];
        }
    } catch (err) {
        logger.error({ err }, 'Error resolving redirect choice');
    }

    return null;
}

// ─────────────────────────────────────────────
// UTILITY: costruisci messaggi
// ─────────────────────────────────────────────

function courtTypeLabel(isCovered: boolean | null): string {
    if (isCovered === true)  return 'coperto';
    if (isCovered === false) return 'scoperto';
    return '';
}

function buildOptionDescription(
    isOpenMatch: boolean,
    court: string,
    isCovered: boolean | null,
    startTime: Date,
    spotsLeft: number,
): string {
    const timeStr = startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
    const dateStr = startTime.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Rome' });
    const typeLabel = courtTypeLabel(isCovered);
    const courtPart = typeLabel ? `${court} ${typeLabel}` : court;

    if (isOpenMatch) {
        return `${courtPart} — ${dateStr} alle ${timeStr} — 👥 partita aperta, mancano ${spotsLeft}`;
    }
    return `${courtPart} — ${dateStr} alle ${timeStr}`;
}

function buildRedirectMessage(group: RedirectGroup, options: RedirectOption[]): string {
    const timeSlot = formatMatchSlot(group.originalStartTime);
    const slot = group.originalCourtName ? `${group.originalCourtName} — ${timeSlot}` : timeSlot;

    const reasonVariants: Record<RedirectGroup['reason'], string[]> = {
        CANCELLED: [
            `Purtroppo la partita di ${timeSlot} non si è potuta tenere 😔`,
            `${slot}: cancellata, mi dispiace 😔`,
            `Brutta notizia: ${slot} è saltata 😕`,
            `La partita di ${timeSlot} è stata annullata 😔`,
            `Mi dispiace, ${slot} non si gioca più 😕`,
        ],
        UNFILLED: [
            `Per ${timeSlot} non siamo riusciti a trovare abbastanza giocatori 😔`,
            `${slot}: il campo è rimasto vuoto, non abbiamo trovato tutti e 4 😕`,
            `Peccato — per la partita di ${timeSlot} non abbiamo chiuso la squadra in tempo 😔`,
            `Non ce l'abbiamo fatta: mancavano giocatori per ${slot} 😕`,
            `La partita di ${timeSlot} non si è riempita 😔`,
        ],
        SLOT_TAKEN: [
            `L'orario di ${timeSlot} è già occupato 😕`,
            `${slot}: nessun campo libero, qualcuno ha preso quell'orario 😔`,
            `Purtroppo ${timeSlot} non è disponibile — è andato 😕`,
            `A ${timeSlot} non c'è posto, è tutto occupato 😔`,
            `${slot}: quell'orario è stato preso 😕`,
        ],
        POOL_EXHAUSTED: [
            `Per ${timeSlot} ho chiamato tutti nella lista — nessun altro disponibile adesso 😔`,
            `${slot}: la lista giocatori è esaurita, non riesco a trovare altri 😕`,
            `Ho cercato giocatori per ${slot} ma al momento non ce ne sono altri da chiamare 😔`,
            `Nessun altro giocatore disponibile per ${timeSlot} in questo momento 😕`,
            `${slot}: ho esaurito la lista — nessuno disponibile adesso 😔`,
        ],
        CANCELLATION: [
            `Per ${timeSlot} c'è stata una disdetta e non riesco a trovare un sostituto in tempo 😔`,
            `${slot}: qualcuno ha cancellato e non riusciamo a rimpiazzarlo 😕`,
            `Disdetta dell'ultimo minuto per ${slot} — nessun sostituto disponibile 😔`,
            `Un posto si è liberato per ${timeSlot} ma non ho trovato nessuno 😕`,
            `${slot}: c'è stata una disdetta e il sostituto non si è trovato 😔`,
        ],
    };

    const reasonList = reasonVariants[group.reason];
    const reason = reasonList[Math.floor(Math.random() * reasonList.length)];

    if (options.length === 0) {
        // Quando originalCourtIsCovered !== null, findRedirectOptionsBookField ha già cercato
        // anche il tipo opposto come fallback → se options è ancora vuoto, entrambi i tipi
        // sono pieni → non suggerire "prova il tipo opposto" (è già stato provato).
        const _noOptMsgs = [
            `${reason}\n\nNon ho trovato campi liberi nei prossimi giorni. Scrivimi un giorno specifico e vedo subito! 🎾`,
            `${reason}\n\nAl momento non ho altre disponibilità, dimmi un giorno e cerco per te 😔`,
            `${reason}\n\nNon ho trovato nulla nei prossimi giorni. Scrivimi quando sei libero e riprovo!`,
            `${reason}\n\nNessuna disponibilità nei prossimi giorni, mandami una data e ci guardo 😕`,
            `${reason}\n\nNon vedo disponibilità nei prossimi giorni, scrivimi il giorno preferito e cerco subito 😔`,
        ];
        return _noOptMsgs[Math.floor(Math.random() * _noOptMsgs.length)];
    }

    const effectiveIntent: 'BOOK_FIELD' | 'MATCHMAKING' =
        group.intent ?? (group.originalSkillLevel > 0 ? 'MATCHMAKING' : 'BOOK_FIELD');

    // Costruisci intestazione con contesto tipo campo
    let introLine: string;
    if (group.originalCourtIsCovered !== null) {
        const preferredTypeLabel = group.originalCourtIsCovered ? 'coperto' : 'scoperto';
        const fallbackTypeLabel  = group.originalCourtIsCovered ? 'scoperto' : 'coperto';
        const hasFallbackOptions = options.some(o => o.courtIsCovered !== group.originalCourtIsCovered);
        const allAreFallback     = options.every(o => o.courtIsCovered !== group.originalCourtIsCovered);

        if (allAreFallback) {
            introLine = `Nessun campo ${preferredTypeLabel} libero a quell'orario. Ho trovato queste disponibilità con campo ${fallbackTypeLabel}:`;
        } else if (hasFallbackOptions) {
            introLine = `I campi ${preferredTypeLabel} sono occupati a quell'orario. Ho trovato queste alternative (alcune con campo ${fallbackTypeLabel}):`;
        } else {
            introLine = `Ho trovato queste disponibilità con campo ${preferredTypeLabel}:`;
        }
    } else {
        introLine = effectiveIntent === 'MATCHMAKING'
            ? 'Ho trovato questi match aperti nelle vicinanze:'
            : 'Ho trovato queste disponibilità:';
    }

    const lines = options.map((o, i) => `${i + 1}. ${o.description}`).join('\n');

    // Coda action-oriented
    const closingVariants = [
        'Dimmi il numero e prenoto subito 🎾',
        'Basta il numero e chiudo io 🎾',
        'Scegli il numero e ci penso io 🙌',
        'Il numero basta, penso a tutto io!',
        'Dimmi quale e prenoto in un secondo 🎾',
    ];
    const closing = closingVariants[Math.floor(Math.random() * closingVariants.length)];

    // Opzioni aggiuntive in coda
    const tailParts: string[] = [];
    tailParts.push('📅 Preferisci un giorno diverso? Scrivimi quando e vedo le disponibilità.');
    if (group.originalCourtIsCovered !== null) {
        const otherType = group.originalCourtIsCovered ? 'scoperto' : 'coperto';
        const otherTypePlural = otherType === 'coperto' ? 'coperti' : 'scoperti';
        tailParts.push(`Vuoi che cerchi anche campi ${otherTypePlural}? Dimmelo!`);
    }

    return `${reason}\n\n${introLine}\n\n${lines}\n\n${closing}\n\n${tailParts.join('\n')}`;
}

function buildPlayerNotificationMessage(group: RedirectGroup): string {
    const timeStr = formatMatchSlot(group.originalStartTime);
    const slot = group.originalCourtName ? `${group.originalCourtName} — ${timeStr}` : timeStr;
    const variants = [
        `${slot}: non è andato in porto — cerco subito un'alternativa 🎾`,
        `Partita al ${slot}: saltata 😕 Ti trovo qualcos'altro a breve!`,
        `${slot}: non abbiamo chiuso 😔 Sto cercando un'alternativa per te!`,
        `La partita al ${slot} è saltata — mi metto subito a cercarti qualcosa 🎾`,
        `${slot}: purtroppo non si gioca 😔 Vediamo cosa c'è disponibile!`,
        `Niente partita al ${slot} — sono già sul pezzo per trovare un'alternativa!`,
        `${slot}: saltata, ma non ti lascio senza campo 🎾 Cerco subito!`,
        `${slot}: partita cancellata 😕 Ti buco subito qualcos'altro!`,
        `${slot}: non si gioca più — dammi un secondo che trovo una soluzione 🎾`,
        `Peccato, ${slot} non è riuscita 😔 Cerco un'alternativa!`,
    ];
    return variants[Math.floor(Math.random() * variants.length)];
}
