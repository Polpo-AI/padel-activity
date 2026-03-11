/**
 * REDIRECT SERVICE
 *
 * Algoritmo di dirottamento universale.
 * Chiamato ogni volta che N giocatori vengono rimossi da una partita
 * per qualsiasi motivo (disdetta, cancellazione, slot preso, pool esaurito).
 *
 * Priorità di ricerca:
 * P1 — Partite OPEN dove mancano esattamente N → chiusura garantita
 * P2 — Partite OPEN dove mancano più di N → entrano ma non chiudono
 * P3 — Campi liberi in orari vicini (±2h stesso giorno, poi ±1 giorno)
 * P4 — Rimando ai primi (4 - soluzioni_trovate) campi disponibili qualunque
 * P5 — Jolly: campo libero in giorno limitrofo (sempre aggiunto se soluzioni < 5)
 *
 * Il bot presenta sempre 4-5 opzioni e aspetta conferma prima di spostare.
 */

import { prisma } from './db';
import { getRedis } from './queue';
import { simulateTypingAndSend, sendMessage } from './whatsapp';
import pino from 'pino';

const logger = pino({ level: 'info' });

const REDIRECT_WINDOW_HOURS = 2;       // ±2h per P1/P2/P3
const REDIRECT_WINDOW_DAYS = 1;        // ±1 giorno per P3 esteso
const TARGET_OPTIONS = 5;              // opzioni da mostrare (4 + 1 jolly)

// ─────────────────────────────────────────────
// TIPI
// ─────────────────────────────────────────────

export interface RedirectOption {
    priority: 1 | 2 | 3 | 4 | 5;
    matchId?: string;           // se partita esistente
    court: string;
    startTime: Date;
    spotsLeft?: number;         // posti liberi nella partita
    willLock: boolean;          // true se aggiungendo N si chiude
    description: string;        // testo human-readable per il messaggio
}

export interface RedirectGroup {
    referentPhone: string;          // Mario — chi contattare
    referentJid: string;
    playerPhones: string[];         // tutti i giocatori da spostare (incluso Mario)
    playerCount: number;            // quanti sono in totale
    originalMatchId: string;
    originalStartTime: Date;
    reason: 'CANCELLED' | 'UNFILLED' | 'SLOT_TAKEN' | 'POOL_EXHAUSTED' | 'CANCELLATION';
    clubId: string;                 // ✅ FIX J: obbligatorio per isolamento multi-tenant
}

// ─────────────────────────────────────────────
// ENTRY POINT PRINCIPALE
// ─────────────────────────────────────────────

export async function redirectGroup(group: RedirectGroup): Promise<void> {
    logger.info(`Redirecting ${group.playerCount} players from match ${group.originalMatchId}`);

    const options = await findRedirectOptions(
        group.playerCount,
        group.originalStartTime,
        group.originalMatchId,
        group.clubId  // ✅ FIX J
    );

    const message = buildRedirectMessage(group, options);

    // Contatta il referente (Mario)
    await simulateTypingAndSend(group.referentJid, message);

    // ✅ FIX L: stato conversazionale su Redis invece di WhatsAppMessage
    try {
        const redis = getRedis();
        await redis.set(
            `state:role:${group.referentJid}:AWAITING_REDIRECT_CHOICE`,
            JSON.stringify({ group, options }),
            'EX', 24 * 60 * 60
        );
    } catch (err) {
        logger.error({ err }, 'Failed to save redirect state to Redis');
    }

    // Se abbiamo i numeri degli altri, li notifichiamo in parallelo (solo info, non chiedono)
    for (const phone of group.playerPhones) {
        if (phone === group.referentPhone) continue;
        try {
            await simulateTypingAndSend(
                phone,
                buildPlayerNotificationMessage(group)
            );
        } catch (err) {
            logger.error({ err }, `Failed to notify player ${phone} of redirect`);
        }
    }
}

// ─────────────────────────────────────────────
// TROVA OPZIONI
// ─────────────────────────────────────────────

export async function findRedirectOptions(
    playerCount: number,
    referenceTime: Date,
    excludeMatchId: string,
    clubId: string           // ✅ FIX J: filtra sempre per club
): Promise<RedirectOption[]> {
    const options: RedirectOption[] = [];

    const windowStart = new Date(referenceTime.getTime() - REDIRECT_WINDOW_HOURS * 60 * 60 * 1000);
    const windowEnd = new Date(referenceTime.getTime() + REDIRECT_WINDOW_HOURS * 60 * 60 * 1000);
    const dayStart = new Date(referenceTime.getTime() - REDIRECT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
    const dayEnd = new Date(referenceTime.getTime() + REDIRECT_WINDOW_DAYS * 24 * 60 * 60 * 1000);

    // ✅ FIX J: filtra per clubId — nessuna partita cross-club
    const openMatches = await prisma.match.findMany({
        where: {
            clubId,
            id: { not: excludeMatchId },
            status: 'OPEN',
            startTime: { gte: windowStart, lte: windowEnd },
        },
        include: { MatchPlayer: true },
        orderBy: { startTime: 'asc' },
    });

    // P1 — chiusura esatta
    for (const match of openMatches) {
        if (options.length >= TARGET_OPTIONS) break;
        const spotsLeft = match.playersNeeded - match.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
        if (spotsLeft === playerCount) {
            options.push({
                priority: 1,
                matchId: match.id,
                court: match.court,
                startTime: match.startTime,
                spotsLeft,
                willLock: true,
                description: buildOptionDescription(1, match.court, match.startTime, spotsLeft, playerCount),
            });
        }
    }

    // P2 — entrano ma non chiudono
    for (const match of openMatches) {
        if (options.length >= TARGET_OPTIONS - 1) break; // lascia spazio al jolly
        const spotsLeft = match.playersNeeded - match.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
        if (spotsLeft > playerCount) {
            // Evita duplicati con P1
            if (!options.find(o => o.matchId === match.id)) {
                options.push({
                    priority: 2,
                    matchId: match.id,
                    court: match.court,
                    startTime: match.startTime,
                    spotsLeft,
                    willLock: false,
                    description: buildOptionDescription(2, match.court, match.startTime, spotsLeft, playerCount),
                });
            }
        }
    }

    // P3 — campi liberi ±2h (slot senza partita)
    if (options.length < TARGET_OPTIONS - 1) {
        const freeSlots = await findFreeSlots(referenceTime, windowStart, windowEnd, excludeMatchId, clubId);
        for (const slot of freeSlots) {
            if (options.length >= TARGET_OPTIONS - 1) break;
            options.push({
                priority: 3,
                court: slot.court,
                startTime: slot.startTime,
                willLock: false,
                description: buildOptionDescription(3, slot.court, slot.startTime, 4, playerCount),
            });
        }
    }

    // P4 — rimando ai primi (4 - soluzioni) campi disponibili qualunque
    if (options.length < TARGET_OPTIONS - 1) {
        const needed = (TARGET_OPTIONS - 1) - options.length;
        const anyMatches = await prisma.match.findMany({
            where: {
                clubId,
                id: { not: excludeMatchId },
                status: 'OPEN',
                startTime: { gte: dayStart, lte: dayEnd },
            },
            include: { MatchPlayer: true },
            orderBy: { startTime: 'asc' },
            take: needed,
        });

        for (const match of anyMatches) {
            if (options.find(o => o.matchId === match.id)) continue;
            const spotsLeft = match.playersNeeded - match.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
            if (spotsLeft >= playerCount) {
                options.push({
                    priority: 4,
                    matchId: match.id,
                    court: match.court,
                    startTime: match.startTime,
                    spotsLeft,
                    willLock: spotsLeft === playerCount,
                    description: buildOptionDescription(4, match.court, match.startTime, spotsLeft, playerCount),
                });
            }
        }
    }

    // P5 — jolly: campo libero in giorno limitrofo
    const jollySlot = await findJollySlot(referenceTime, dayStart, dayEnd, excludeMatchId, clubId);
    if (jollySlot) {
        options.push({
            priority: 5,
            court: jollySlot.court,
            startTime: jollySlot.startTime,
            willLock: false,
            description: buildOptionDescription(5, jollySlot.court, jollySlot.startTime, 4, playerCount),
        });
    }

    return options;
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

    // AI capisce quale opzione ha scelto
    const chosenOption = await resolveChoice(choiceText, options);

    if (!chosenOption) {
        await simulateTypingAndSend(
            jid,
            "Non ho capito quale preferisci 😅 Rispondimi con il numero dell'opzione (es. \"la prima\", \"opzione 2\") o con l'orario."
        );
        return;
    }

    // ✅ FIX L: pulisci da Redis
    try {
        const redis = getRedis();
        await redis.del(`state:role:${jid}:AWAITING_REDIRECT_CHOICE`);
    } catch (err) {
        logger.error({ err }, 'Failed to clear redirect state from Redis');
    }

    if (chosenOption.matchId) {
        // Partita esistente — aggiungi tutti i giocatori
        await addGroupToMatch(chosenOption.matchId, group);
    } else {
        // Campo libero — crea nuova partita
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

    // Aggiungi tutti i giocatori
    for (const phone of group.playerPhones) {
        const player = await prisma.player.findUnique({ where: { phoneNumber: phone } });
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

    // Controlla se ora è piena
    const updatedMatch = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: true },
    });
    const newCount = updatedMatch!.MatchPlayer.filter((mp: any) => !mp.leftAt).length;

    if (newCount >= match.playersNeeded) {
        await prisma.match.update({ where: { id: matchId }, data: { status: 'LOCKED' } });

        if (match.groupId) {
            // Aggiungi al gruppo WA esistente
            const { getSock } = await import('./whatsapp');
            const sock = getSock();
            if (sock) {
                for (const phone of group.playerPhones) {
                    await sock.groupParticipantsUpdate(match.groupId, [`${phone}@s.whatsapp.net`], 'add');
                }
                await sendMessage(match.groupId, `🎾 Siamo al completo! Benvenuti ${group.playerPhones.map(p => p).join(', ')}!`);
            }
        }
    }

    const timeStr = match.startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    await simulateTypingAndSend(
        group.referentJid,
        `Perfetto! Vi ho segnati per le ${timeStr} al ${match.court} 🎾${newCount >= match.playersNeeded ? ' Siamo al completo!' : ' Aspettiamo gli altri.'}`
    );
}

// ─────────────────────────────────────────────
// CREA NUOVA PARTITA PER IL GRUPPO
// ─────────────────────────────────────────────

async function createMatchForGroup(option: RedirectOption, group: RedirectGroup): Promise<void> {
    // ✅ FIX J: usa clubId dal group, mai findFirst()
    const referent = await prisma.player.findUnique({ where: { phoneNumber: group.referentPhone } });
    const skillLevel = referent?.skillLevel || 'INTERMEDIATE';

    const match = await prisma.match.create({
        data: {
            clubId: group.clubId,   // ✅ FIX J
            court: option.court,
            startTime: option.startTime,
            skillLevel: skillLevel as any,
            playersNeeded: 4,
            status: 'OPEN',
        },
    });

    // Aggiungi i giocatori del gruppo
    for (const phone of group.playerPhones) {
        const player = await prisma.player.findUnique({ where: { phoneNumber: phone } });
        if (!player) continue;
        await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: player.id } });
        await prisma.invitation.create({
            data: { matchId: match.id, playerId: player.id, status: 'ACCEPTED' },
        });
    }

    // Avvia wave per i posti rimanenti
    const { waveQueue } = await import('./queue');
    const spotsLeft = 4 - group.playerCount;
    if (spotsLeft > 0) {
        await waveQueue.add('process-wave', {
            matchId: match.id,
            waveNumber: 1,
            limit: spotsLeft,
        }, {
            delay: Math.floor(Math.random() * 60000) + 30000,
        });
    }

    const timeStr = option.startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    await simulateTypingAndSend(
        group.referentJid,
        `Perfetto! Ho aperto una partita per le ${timeStr} al ${option.court} 🎾 ${spotsLeft > 0 ? `Cerco altri ${spotsLeft} giocatori!` : 'Siete al completo!'}`
    );
}

// ─────────────────────────────────────────────
// UTILITY: trova slot liberi
// ─────────────────────────────────────────────

async function findFreeSlots(
    referenceTime: Date,
    from: Date,
    to: Date,
    excludeMatchId: string,
    clubId: string           // ✅ FIX J + P: carica campi dal DB del club corretto
): Promise<{ court: string; startTime: Date }[]> {
    // ✅ FIX J+P: usa clubId esplicito, legge i campi reali dal DB
    const clubCourts = await prisma.court.findMany({
        where: { clubId, active: true },
        select: { name: true },
        orderBy: { name: 'asc' },
    });
    if (clubCourts.length === 0) return [];

    const existingMatches = await prisma.match.findMany({
        where: {
            clubId,
            id: { not: excludeMatchId },
            status: { in: ['OPEN', 'LOCKED'] },
            startTime: { gte: from, lte: to },
        },
        select: { court: true, startTime: true },
    });

    const occupiedKeys = new Set(
        existingMatches.map(m => `${m.court}_${m.startTime.toISOString()}`)
    );

    // Genera slot ogni 30 minuti nell'arco temporale
    const slots: { court: string; startTime: Date }[] = [];
    const courts = clubCourts.map(c => c.name); // ✅ FIX P: da DB, non hardcoded
    const current = new Date(from);

    while (current <= to && slots.length < 3) {
        for (const court of courts) {
            const key = `${court}_${current.toISOString()}`;
            if (!occupiedKeys.has(key)) {
                slots.push({ court, startTime: new Date(current) });
                if (slots.length >= 3) break;
            }
        }
        current.setMinutes(current.getMinutes() + 30);
    }

    return slots;
}

async function findJollySlot(
    referenceTime: Date,
    from: Date,
    to: Date,
    excludeMatchId: string,
    clubId: string           // ✅ FIX J + P
): Promise<{ court: string; startTime: Date } | null> {
    const nextDay = new Date(referenceTime);
    nextDay.setDate(nextDay.getDate() + 1);

    // ✅ FIX J+P: campi reali dal DB del club corretto
    const clubCourts = await prisma.court.findMany({
        where: { clubId, active: true },
        select: { name: true },
    });
    if (clubCourts.length === 0) return null;

    const existingNextDay = await prisma.match.findMany({
        where: {
            clubId,
            status: { in: ['OPEN', 'LOCKED'] },
            startTime: {
                gte: new Date(nextDay.getTime() - 60 * 60 * 1000),
                lte: new Date(nextDay.getTime() + 60 * 60 * 1000),
            },
        },
        select: { court: true },
    });

    const occupiedCourts = new Set(existingNextDay.map(m => m.court));
    const courts = clubCourts.map(c => c.name); // ✅ FIX P: da DB
    const freeCourt = courts.find(c => !occupiedCourts.has(c));

    if (freeCourt) {
        return { court: freeCourt, startTime: nextDay };
    }

    return null;
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

function buildOptionDescription(
    priority: number,
    court: string,
    startTime: Date,
    spotsLeft: number,
    playerCount: number
): string {
    const timeStr = startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const dateStr = startTime.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });

    if (priority === 1) {
        return `${court} — ${dateStr} alle ${timeStr} — mancano esattamente ${spotsLeft} 🔒 se confermi chiudo subito`;
    }
    if (priority === 2) {
        return `${court} — ${dateStr} alle ${timeStr} — mancano ${spotsLeft}, entrerete ma cerco ancora qualcuno`;
    }
    if (priority === 3) {
        return `${court} — ${dateStr} alle ${timeStr} — campo libero, apro io la partita e cerco altri ${4 - playerCount}`;
    }
    if (priority === 4) {
        return `${court} — ${dateStr} alle ${timeStr} — partita aperta, ci sono ${spotsLeft} posti`;
    }
    // jolly
    return `${court} — ${dateStr} alle ${timeStr} — jolly: campo libero in giornata alternativa`;
}

function buildRedirectMessage(group: RedirectGroup, options: RedirectOption[]): string {
    const reasonText: Record<RedirectGroup['reason'], string> = {
        CANCELLED: 'La partita purtroppo è stata cancellata',
        UNFILLED: 'Non siamo riusciti a riempire il campo',
        SLOT_TAKEN: 'Il posto è stato preso mentre aspettavi',
        POOL_EXHAUSTED: 'Non ci sono altri giocatori disponibili per completare la partita',
        CANCELLATION: 'Un giocatore ha disdetto e non riusciamo a trovare un sostituto',
    };

    const reason = reasonText[group.reason];
    const lines = options.map((o, i) => `${i + 1}. ${o.description}`).join('\n');

    return `${reason} 😕\n\nHo trovato queste alternative per voi:\n\n${lines}\n\nQuale preferisci? Dimmi il numero e chiudo subito 🎾`;
}

function buildPlayerNotificationMessage(group: RedirectGroup): string {
    const timeStr = group.originalStartTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    return `Ciao! Purtroppo la partita delle ${timeStr} non si è chiusa. Stiamo cercando un'alternativa — ti aggiorniamo a breve 🎾`;
}
