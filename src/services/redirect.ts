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
    courtId?: string | null;
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

    // Stato redirect — dual-write Redis + PostgreSQL tramite conversation-state
    try {
        const { setState } = await import('./conversation-state');
        await setState(`state:role:${group.referentJid}:AWAITING_REDIRECT_CHOICE`, { group, options }, 3600); // 1h TTL
    } catch (err) {
        logger.error({ err }, 'Failed to save redirect state');
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
        include: { MatchPlayer: true, court: true },
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
                court: match.court?.name || 'Campo',
                courtId: match.courtId,
                startTime: match.startTime,
                spotsLeft,
                willLock: true,
                description: buildOptionDescription(1, match.court?.name || 'Campo', match.startTime, spotsLeft, playerCount),
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
                    court: match.court?.name || 'Campo',
                courtId: match.courtId,
                    startTime: match.startTime,
                    spotsLeft,
                    willLock: false,
                    description: buildOptionDescription(2, match.court?.name || 'Campo', match.startTime, spotsLeft, playerCount),
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
            include: { MatchPlayer: true, court: true },
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
                    court: match.court?.name || 'Campo',
                courtId: match.courtId,
                    startTime: match.startTime,
                    spotsLeft,
                    willLock: spotsLeft === playerCount,
                    description: buildOptionDescription(4, match.court?.name || 'Campo', match.startTime, spotsLeft, playerCount),
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

    // Controlla se ora è piena
    const updatedMatch = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: true, court: true },
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
                // Recupera i nomi dei nuovi arrivati
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
        `Perfetto! Vi ho segnati per le ${timeStr} al ${(match as any).court?.name || 'Campo'} 🎾${newCount >= match.playersNeeded ? ' Siamo al completo!' : ' Aspettiamo gli altri.'}`
    );
}

// ─────────────────────────────────────────────
// CREA NUOVA PARTITA PER IL GRUPPO
// ─────────────────────────────────────────────

async function createMatchForGroup(option: RedirectOption, group: RedirectGroup): Promise<void> {
    // ✅ FIX J: usa clubId dal group, mai findFirst()
    const referent = await prisma.player.findFirst({ where: { phoneNumber: group.referentPhone } });
    const skillLevel = referent?.skillLevel || 'INTERMEDIATE';

    const match = await prisma.match.create({
        data: {
            clubId: group.clubId,   // ✅ FIX J
            courtId: option.courtId || null,
            startTime: option.startTime,
            skillLevel: skillLevel as any,
            playersNeeded: 4,
            status: 'OPEN',
        },
    });

    // Aggiungi i giocatori del gruppo
    for (const phone of group.playerPhones) {
        const player = await prisma.player.findFirst({ where: { phoneNumber: phone } });
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
): Promise<{ court: string; courtId?: string | null; startTime: Date }[]> {
    // ✅ FIX J+P: usa clubId esplicito, legge i campi reali dal DB
    const clubCourts = await prisma.court.findMany({
        where: { clubId, active: true },
        select: { id: true, name: true },
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
        select: { courtId: true, startTime: true },
    });

    // ✅ Fix: usa courtId (stringa), non l'oggetto court (che diventa [object Object])
    const occupiedKeys = new Set(
        existingMatches.map(m => `${m.courtId}_${m.startTime.toISOString()}`)
    );

    const slots: { court: string; courtId?: string | null; startTime: Date }[] = [];
    const STEP_MS = 30 * 60 * 1000;

    // ✅ Fix: espansione bidirezionale da referenceTime → prima le fasce vicine all'orario originale
    // Per ogni fascia oraria candidata scegliamo UN SOLO campo libero (il primo disponibile),
    // non tutti i campi liberi a quell'ora.
    let fwd = new Date(referenceTime);
    let bwd = new Date(referenceTime.getTime() - STEP_MS);

    while (slots.length < 3) {
        const hasFwd = fwd <= to;
        const hasBwd = bwd >= from;
        if (!hasFwd && !hasBwd) break;

        for (const dir of [hasFwd ? fwd : null, hasBwd ? bwd : null]) {
            if (!dir || slots.length >= 3) continue;
            const freeCourt = clubCourts.find(
                c => !occupiedKeys.has(`${c.id}_${dir.toISOString()}`)
            );
            if (freeCourt) {
                slots.push({ court: freeCourt.name, courtId: freeCourt.id, startTime: new Date(dir) });
            }
        }

        fwd = new Date(fwd.getTime() + STEP_MS);
        bwd = new Date(bwd.getTime() - STEP_MS);
    }

    return slots;
}

async function findJollySlot(
    referenceTime: Date,
    from: Date,
    to: Date,
    excludeMatchId: string,
    clubId: string           // ✅ FIX J + P
): Promise<{ court: string; courtId?: string | null; startTime: Date } | null> {
    const nextDay = new Date(referenceTime);
    nextDay.setDate(nextDay.getDate() + 1);

    // ✅ FIX J+P: campi reali dal DB del club corretto
    const clubCourts = await prisma.court.findMany({
        where: { clubId, active: true },
        select: { id: true, name: true },
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
        select: { courtId: true },
    });

    const occupiedCourtIds = new Set(existingNextDay.map(m => m.courtId).filter(Boolean));
    const courts = clubCourts; // ✅ FIX P: da DB
    const freeCourt = courts.find(c => !occupiedCourtIds.has(c.id));

    if (freeCourt) {
        return { court: freeCourt.name, courtId: freeCourt.id, startTime: nextDay };
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

    const closingVariants = [
        `Quale preferisci? Dimmi il numero e chiudo subito 🎾`,
        `Dimmi quale ti va e mi metto subito in moto 🎾`,
        `Scegli pure — basta il numero e ci penso io 🙌`,
    ];
    const closing = closingVariants[Math.floor(Math.random() * closingVariants.length)];

    return `${reason}\n\nHo trovato queste alternative:\n\n${lines}\n\n${closing}`;
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
