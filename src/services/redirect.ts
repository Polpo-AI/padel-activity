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

    try {
        const { setState } = await import('./conversation-state');
        await setState(`state:role:${group.referentJid}:AWAITING_REDIRECT_CHOICE`, { group, options }, 3600);
    } catch (err) {
        logger.error({ err }, 'Failed to save redirect state');
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

    // Costruisci set di slot bloccati (courtId + timestamp):
    // LOCKED o OPEN con ≥3 giocatori confermati sono "occupati"
    const occupiedKeys = new Set<string>();
    for (const m of allOccupied as any[]) {
        const confirmedCount = (m.MatchPlayer as any[]).filter((mp: any) => !mp.leftAt).length;
        if (m.status === 'LOCKED' || confirmedCount >= 3) {
            occupiedKeys.add(`${m.courtId}_${new Date(m.startTime).toISOString()}`);
        }
    }

    const STEP_MS = 30 * 60 * 1000;

    // ── Slot 1 & 2: stesso giorno, prima e dopo referenceTime ────────────────
    // Prima cerca il più vicino PRIMA di T nello stesso giorno
    let before: { court: string; courtId: string; isCovered: boolean; startTime: Date } | null = null;
    {
        let t = new Date(referenceTime.getTime() - STEP_MS);
        while (t >= dayStart) {
            for (const c of courts) {
                const key = `${c.id}_${t.toISOString()}`;
                if (!occupiedKeys.has(key)) {
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
                for (const c of courts) {
                    const key = `${c.id}_${t.toISOString()}`;
                    if (!occupiedKeys.has(key)) {
                        after = { court: c.name, courtId: c.id, isCovered: c.isCovered, startTime: new Date(t) };
                        break;
                    }
                }
                if (after) break;
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
            const key = `${c.id}_${futureSlot.toISOString()}`;
            if (!occupiedKeys.has(key)) {
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
): Promise<void> {
    // Notifica i pending invitations: solo avviso, no redirect
    for (const phone of pendingPlayerPhones) {
        const jid = `${phone}@s.whatsapp.net`;
        try {
            await simulateTypingAndSend(jid,
                'Il campo per cui eri stato invitato non è più disponibile. Spero di trovarti qualcosa di meglio presto! 🎾'
            );
        } catch (err) {
            logger.warn({ err, phone }, 'notifyDisplacedPlayers: failed to notify pending player');
        }
    }

    // Notifica i confirmed players + redirect MATCHMAKING
    if (confirmedPlayers.length > 0) {
        // Invia prima la notifica a ogni confermato
        for (const p of confirmedPlayers) {
            const jid = `${p.phoneNumber}@s.whatsapp.net`;
            try {
                await simulateTypingAndSend(jid,
                    'Purtroppo il tuo slot è stato prenotato da qualcun altro 😕 Sto cercando subito un\'alternativa per te!'
                );
            } catch (err) {
                logger.warn({ err, phone: p.phoneNumber }, 'notifyDisplacedPlayers: failed to notify confirmed player');
            }
        }

        // Poi redirect con intent MATCHMAKING per il referente (primo confermato)
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
                intent: 'MATCHMAKING',
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
    const { group, options } = pendingState;

    const chosenOption = await resolveChoice(choiceText, options);

    if (!chosenOption) {
        const clarifyVariants = [
            `Non ho capito quale preferisci 😅 Dimmi il numero dell'opzione o l'orario e mi metto subito!`,
            `Aiutami: scrivi il numero dell'opzione che vuoi (es. "la prima", "opzione 2") 🎾`,
            `Non sono sicura di aver capito — ripeti con il numero dell'opzione o l'orario? 😊`,
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
        await simulateTypingAndSend(
            group.referentJid,
            "Mi dispiace, quella partita si è nel frattempo chiusa! Vuoi scegliere un'altra opzione?"
        );
        return;
    }

    const spotsLeft = match.playersNeeded - match.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
    if (spotsLeft < group.playerCount) {
        await simulateTypingAndSend(
            group.referentJid,
            "Mi dispiace, i posti disponibili sono cambiati! Vuoi scegliere un'altra opzione?"
        );
        return;
    }

    for (const phone of group.playerPhones) {
        const player = await prisma.player.findFirst({ where: { phoneNumber: phone } });
        if (!player) continue;

        const alreadyIn = await prisma.matchPlayer.findUnique({
            where: { matchId_playerId: { matchId, playerId: player.id } },
        });
        if (alreadyIn) continue;

        await prisma.matchPlayer.create({ data: { matchId, playerId: player.id } });
        await prisma.invitation.create({
            data: { matchId, playerId: player.id, status: 'ACCEPTED' },
        });
    }

    const updatedMatch = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: true, court: true },
    });
    const newCount = updatedMatch!.MatchPlayer.filter((mp: any) => !mp.leftAt).length;

    if (newCount >= match.playersNeeded) {
        await prisma.match.update({ where: { id: matchId }, data: { status: 'LOCKED' } });

        if (match.groupId) {
            const { getSock } = await import('./whatsapp');
            const sock = getSock();
            if (sock) {
                for (const phone of group.playerPhones) {
                    await sock.groupParticipantsUpdate(match.groupId, [`${phone}@s.whatsapp.net`], 'add');
                }
                const newPlayers = await prisma.player.findMany({
                    where: { phoneNumber: { in: group.playerPhones } },
                    select: { name: true },
                });
                const newNames = newPlayers.map(p => (p.name || '').split(' ')[0]).filter(Boolean).join(', ') || 'i nuovi arrivati';
                const welcomeVariants = [
                    `Siamo al completo! 🎾 Benvenuti ${newNames} — ci vediamo in campo!`,
                    `Gruppo al completo! Benvenuti ${newNames} 🙌 Preparatevi!`,
                    `${newNames} sono con noi! 🎾 Squadra al completo, a presto!`,
                ];
                await sendMessage(match.groupId, welcomeVariants[Math.floor(Math.random() * welcomeVariants.length)]);
            }
        }
    }

    const timeStr = match.startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    await simulateTypingAndSend(
        group.referentJid,
        `Perfetto! Vi ho segnati per le ${timeStr} al ${(updatedMatch as any).court?.name || 'Campo'} 🎾${newCount >= match.playersNeeded ? ' Siamo al completo!' : ' Aspettiamo gli altri.'}`
    );
}

// ─────────────────────────────────────────────
// CREA NUOVA PARTITA PER IL GRUPPO
// ─────────────────────────────────────────────

async function createMatchForGroup(option: RedirectOption, group: RedirectGroup): Promise<void> {
    // BOOK_FIELD redirect → match privato LOCKED (campo riservato per il gruppo)
    // MATCHMAKING redirect → match OPEN (cercano altri giocatori) — caso raro, di solito si sceglie un match esistente
    const isBookField = group.intent === 'BOOK_FIELD' || group.originalSkillLevel <= 0;

    const referent = await prisma.player.findFirst({ where: { phoneNumber: group.referentPhone } });
    const skillLevel = referent?.skillLevel && referent.skillLevel > 0
        ? referent.skillLevel
        : group.originalSkillLevel > 0 ? group.originalSkillLevel : 3.5;

    const match = await prisma.match.create({
        data: {
            clubId: group.clubId,
            courtId: option.courtId || null,
            startTime: option.startTime,
            skillLevel,
            playersNeeded: 4,
            status: isBookField ? 'LOCKED' : 'OPEN',
            isPrivateBooking: isBookField,
        },
    });

    for (const phone of group.playerPhones) {
        const player = await prisma.player.findFirst({ where: { phoneNumber: phone } });
        if (!player) continue;
        await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: player.id } });
        await prisma.invitation.create({
            data: { matchId: match.id, playerId: player.id, status: 'ACCEPTED' },
        });
    }

    const timeStr = option.startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

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
        `${i + 1}. ${o.court} alle ${o.startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })} (${o.description})`
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
    if (isCovered === true)  return '🏟️ coperto';
    if (isCovered === false) return '☀️ scoperto';
    return '';
}

function buildOptionDescription(
    isOpenMatch: boolean,
    court: string,
    isCovered: boolean | null,
    startTime: Date,
    spotsLeft: number,
): string {
    const timeStr = startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const dateStr = startTime.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
    const typeLabel = courtTypeLabel(isCovered);
    const courtPart = typeLabel ? `${court} ${typeLabel}` : court;

    if (isOpenMatch) {
        return `${courtPart} — ${dateStr} alle ${timeStr} — 👥 partita aperta, mancano ${spotsLeft}`;
    }
    return `${courtPart} — ${dateStr} alle ${timeStr} — 🔑 solo campo (affitto)`;
}

function buildRedirectMessage(group: RedirectGroup, options: RedirectOption[]): string {
    const reasonVariants: Record<RedirectGroup['reason'], string[]> = {
        CANCELLED: [
            'La partita purtroppo è stata cancellata 😔',
            'Mi dispiace, la partita non si è potuta tenere 😔',
            'Purtroppo la partita è saltata 😕',
        ],
        UNFILLED: [
            'Non siamo riusciti a trovare abbastanza giocatori 😔',
            'Il campo è rimasto vuoto — non abbiamo trovato tutti e 4 😕',
            'Purtroppo non abbiamo chiuso la squadra in tempo 😔',
        ],
        SLOT_TAKEN: [
            'Il posto è stato preso mentre aspettavi 😕',
            'Peccato, qualcun altro ha preso il posto un attimo prima! 😅',
            'Il posto si è liberato ma qualcuno è stato più veloce 😔',
        ],
        POOL_EXHAUSTED: [
            'Ho esaurito i giocatori disponibili per completare la partita 😔',
            'Non ci sono altri giocatori da chiamare in questo momento 😕',
            'Il pool di giocatori è esaurito — non riesco a trovare altri 😔',
        ],
        CANCELLATION: [
            'Un giocatore ha disdetto e non riesco a trovare un sostituto in tempo 😔',
            'Purtroppo qualcuno ha cancellato e non riusciamo a rimpiazzarlo 😕',
            'Disdetta dell\'ultimo minuto e nessuno disponibile come sostituto 😔',
        ],
    };

    const reasonList = reasonVariants[group.reason];
    const reason = reasonList[Math.floor(Math.random() * reasonList.length)];
    const lines = options.map((o, i) => `${i + 1}. ${o.description}`).join('\n');

    if (options.length === 0) {
        return `${reason}\n\nPurtroppo non ho trovato alternative disponibili al momento. Contatta il circolo per maggiori informazioni.`;
    }

    const closingVariants = [
        `Quale preferisci? Dimmi il numero e chiudo subito 🎾`,
        `Dimmi quale ti va e mi metto subito in moto 🎾`,
        `Scegli pure — basta il numero e ci penso io 🙌`,
    ];
    const closing = closingVariants[Math.floor(Math.random() * closingVariants.length)];

    // Closing message aggiuntivo intent-aware
    const effectiveIntent: 'BOOK_FIELD' | 'MATCHMAKING' =
        group.intent ?? (group.originalSkillLevel > 0 ? 'MATCHMAKING' : 'BOOK_FIELD');
    const intentClosing = effectiveIntent === 'MATCHMAKING'
        ? 'Oppure dimmi un giorno e ti dico i match aperti disponibili 📅'
        : 'Sennò dimmi un giorno e ti dico le disponibilità libere 📅';

    // Se l'utente aveva una preferenza di tipo campo, controlla se le alternative includono il tipo opposto
    let courtTypeNote = '';
    if (group.originalCourtIsCovered !== null) {
        const hasFallbackOptions = options.some(o => o.courtIsCovered !== group.originalCourtIsCovered);
        const preferredTypeLabel = group.originalCourtIsCovered ? 'coperto' : 'scoperto';
        const fallbackTypeLabel  = group.originalCourtIsCovered ? 'scoperto' : 'coperto';
        const allAreFallback = options.every(o => o.courtIsCovered !== group.originalCourtIsCovered);

        if (allAreFallback) {
            courtTypeNote = `\nIl campo ${preferredTypeLabel} non è disponibile a quell'orario — ecco le alternative con campo ${fallbackTypeLabel}:`;
        } else if (hasFallbackOptions) {
            courtTypeNote = `\nIl campo ${preferredTypeLabel} è esaurito a quell'orario — alcune opzioni qui sotto sono con campo ${fallbackTypeLabel}:`;
        }
    }

    const introLine = courtTypeNote
        ? `Ho trovato queste alternative:${courtTypeNote}`
        : `Ho trovato queste alternative:`;

    return `${reason}\n\n${introLine}\n\n${lines}\n\n${closing}\n${intentClosing}`;
}

function buildPlayerNotificationMessage(group: RedirectGroup): string {
    const timeStr = group.originalStartTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const variants = [
        `Ciao! Purtroppo la partita delle ${timeStr} non si è chiusa 😔 Stiamo trovando un'alternativa — ti aggiorniamo a breve 🎾`,
        `La partita delle ${timeStr} è saltata 😕 Stiamo cercando un'altra soluzione per voi — a breve ti dico!`,
        `Aggiornamento sulla partita delle ${timeStr}: non siamo riusciti a completarla 😔 Sto lavorando su un'alternativa!`,
    ];
    return variants[Math.floor(Math.random() * variants.length)];
}
