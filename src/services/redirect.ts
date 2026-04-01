/**
 * REDIRECT SERVICE
 *
 * Algoritmo di dirottamento universale.
 * Chiamato ogni volta che N giocatori vengono rimossi da una partita
 * per qualsiasi motivo (disdetta, cancellazione, slot preso, pool esaurito).
 *
 * Priorità di ricerca (fino a 5 opzioni totali):
 * FASE 1 — Partite OPEN nel range di skill del club (skip se skillLevel <= 0)
 *           ordinate per vicinanza all'orario originale
 * FASE 2 — Slot liberi della stessa tipologia (coperto/scoperto) della partita originale,
 *           espansione bidirezionale dall'orario originale
 *
 * Se non si raggiungono 5 opzioni si mostra quello che c'è (4, 3, 2...).
 */

import { prisma } from './db';
import { getRedis } from './queue';
import { simulateTypingAndSend, sendMessage } from './whatsapp';
import pino from 'pino';

const logger = pino({ level: 'info' });

const OPEN_MATCH_WINDOW_HOURS = 24;   // cerca partite open entro ±24h dall'orario originale
const FREE_SLOT_WINDOW_DAYS  = 7;    // cerca slot liberi entro ±7 giorni
const TARGET_OPTIONS = 5;

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
        group.clubId,
        group.originalSkillLevel,
        group.originalCourtIsCovered,
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
// TROVA OPZIONI
// ─────────────────────────────────────────────

export async function findRedirectOptions(
    playerCount: number,
    referenceTime: Date,
    excludeMatchId: string,
    clubId: string,
    originalSkillLevel: number = 0,
    originalCourtIsCovered: boolean | null = null,
): Promise<RedirectOption[]> {
    const options: RedirectOption[] = [];

    // ── FASE 1: Partite OPEN compatibili con lo skill ──────────────────────────
    // Skip se il giocatore non è ancora testato (skillLevel <= 0)
    if (originalSkillLevel > 0) {
        const club = await prisma.club.findUnique({
            where: { id: clubId },
            select: { matchLowerRange: true, matchUpperRange: true },
        });
        const lowerRange = club?.matchLowerRange ?? 1.0;
        const upperRange = club?.matchUpperRange ?? 1.0;
        const skillMin = originalSkillLevel - lowerRange;
        const skillMax = originalSkillLevel + upperRange;

        const windowStart = new Date(referenceTime.getTime() - OPEN_MATCH_WINDOW_HOURS * 3600_000);
        const windowEnd   = new Date(referenceTime.getTime() + OPEN_MATCH_WINDOW_HOURS * 3600_000);

        const openMatches = await prisma.match.findMany({
            where: {
                clubId,
                id: { not: excludeMatchId },
                status: 'OPEN',
                startTime: { gte: windowStart, lte: windowEnd },
                skillLevel: { gte: skillMin, lte: skillMax },
            },
            include: {
                MatchPlayer: { where: { leftAt: null } },
                court: true,
            },
        });

        // Ordina per vicinanza all'orario originale
        openMatches.sort((a, b) =>
            Math.abs(a.startTime.getTime() - referenceTime.getTime()) -
            Math.abs(b.startTime.getTime() - referenceTime.getTime())
        );

        for (const match of openMatches) {
            if (options.length >= TARGET_OPTIONS) break;
            const spotsLeft = match.playersNeeded - match.MatchPlayer.length;
            if (spotsLeft < playerCount) continue;

            options.push({
                priority: spotsLeft === playerCount ? 1 : 2,
                matchId: match.id,
                court: match.court?.name || 'Campo',
                courtId: match.courtId,
                courtIsCovered: match.court?.isCovered ?? null,
                startTime: match.startTime,
                spotsLeft,
                willLock: spotsLeft === playerCount,
                isOpenMatch: true,
                description: buildOptionDescription(true, match.court?.name || 'Campo', match.court?.isCovered ?? null, match.startTime, spotsLeft),
            });
        }
    }

    // ── FASE 2: Slot liberi stessa tipologia campo, orari più vicini ──────────
    if (options.length < TARGET_OPTIONS) {
        const needed = TARGET_OPTIONS - options.length;
        const freeSlots = await findFreeSlotsNearby(
            referenceTime,
            originalCourtIsCovered,
            clubId,
            excludeMatchId,
            needed,
        );
        for (const slot of freeSlots) {
            options.push({
                priority: 3,
                court: slot.court,
                courtId: slot.courtId,
                courtIsCovered: slot.isCovered,
                startTime: slot.startTime,
                willLock: false,
                isOpenMatch: false,
                description: buildOptionDescription(false, slot.court, slot.isCovered, slot.startTime, 4),
            });
        }
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
            status: 'OPEN',
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

    const timeStr = option.startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    await simulateTypingAndSend(
        group.referentJid,
        `Perfetto! Ho aperto una partita per le ${timeStr} al ${option.court} 🎾 ${spotsLeft > 0 ? `Cerco altri ${spotsLeft} giocatori!` : 'Siete al completo!'}`
    );
}

// ─────────────────────────────────────────────
// UTILITY: slot liberi per tipologia campo
// ─────────────────────────────────────────────

async function findFreeSlotsNearby(
    referenceTime: Date,
    isCovered: boolean | null,
    clubId: string,
    excludeMatchId: string,
    count: number,
): Promise<{ court: string; courtId: string; isCovered: boolean; startTime: Date }[]> {
    const windowFrom = new Date(referenceTime.getTime() - FREE_SLOT_WINDOW_DAYS * 86_400_000);
    const windowTo   = new Date(referenceTime.getTime() + FREE_SLOT_WINDOW_DAYS * 86_400_000);

    const courts = await prisma.court.findMany({
        where: {
            clubId,
            active: true,
            ...(isCovered !== null ? { isCovered } : {}),
        },
        select: { id: true, name: true, isCovered: true },
        orderBy: { name: 'asc' },
    });
    if (courts.length === 0) return [];

    const existingMatches = await prisma.match.findMany({
        where: {
            clubId,
            id: { not: excludeMatchId },
            status: { in: ['OPEN', 'LOCKED'] },
            startTime: { gte: windowFrom, lte: windowTo },
        },
        select: { courtId: true, startTime: true },
    });

    const occupiedKeys = new Set(
        existingMatches.map(m => `${m.courtId}_${m.startTime.toISOString()}`)
    );

    const slots: { court: string; courtId: string; isCovered: boolean; startTime: Date }[] = [];
    const STEP_MS = 30 * 60 * 1000;

    // Espansione bidirezionale da referenceTime → prima gli orari più vicini
    let fwd = new Date(referenceTime);
    let bwd = new Date(referenceTime.getTime() - STEP_MS);

    while (slots.length < count) {
        const hasFwd = fwd <= windowTo;
        const hasBwd = bwd >= windowFrom;
        if (!hasFwd && !hasBwd) break;

        for (const dir of [hasFwd ? fwd : null, hasBwd ? bwd : null]) {
            if (!dir || slots.length >= count) continue;
            const freeCourt = courts.find(
                c => !occupiedKeys.has(`${c.id}_${dir.toISOString()}`)
            );
            if (freeCourt) {
                slots.push({
                    court: freeCourt.name,
                    courtId: freeCourt.id,
                    isCovered: freeCourt.isCovered,
                    startTime: new Date(dir),
                });
            }
        }

        fwd = new Date(fwd.getTime() + STEP_MS);
        bwd = new Date(bwd.getTime() - STEP_MS);
    }

    return slots;
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
