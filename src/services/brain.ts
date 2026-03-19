/**
 * BRAIN SERVICE
 *
 * Cervello AI del bot: riceve contesto completo → genera risposta + decide azione.
 * Nessuna frase hardcodata. Claude Sonnet guida tutta la conversazione.
 */

import { prisma } from './db';
import { anthropic } from './ai';
import { waveQueue } from './queue';
import pino from 'pino';

const logger = pino({ level: 'info' });

export type BrainAction =
    | 'NONE'
    | 'ACCEPT_INVITATION'
    | 'REJECT_INVITATION'
    | 'CANCEL_MATCH'
    | 'BOOK_FIELD'
    | 'OPT_OUT'
    | 'INVITE_PREFERRED';

export interface BrainResponse {
    message: string;
    action: BrainAction;
    params?: any;
}

export interface BrainContext {
    club: any;
    player: any | null;
    recentMessages: { role: string; content: string }[];
    pendingInvitations: any[];
    confirmedMatches: any[];
    availableMatches: any[];
}

// ─────────────────────────────────────────────
// BUILD CONTEXT
// ─────────────────────────────────────────────

export async function buildBrainContext(jid: string, phoneNumber: string): Promise<BrainContext> {
    const currentClubId = process.env.CLUB_ID;
    const club = currentClubId
        ? await prisma.club.findUnique({ where: { id: currentClubId } })
        : await prisma.club.findFirst();

    const phoneVariants = [phoneNumber, '+' + phoneNumber, phoneNumber.replace(/^\+/, '')];
    const player = await prisma.player.findFirst({
        where: { phoneNumber: { in: phoneVariants }, clubId: club?.id },
    });

    const recentMessages = await prisma.whatsAppMessage.findMany({
        where: { chatId: jid },
        orderBy: { timestamp: 'desc' },
        take: 20,
    });

    let pendingInvitations: any[] = [];
    let confirmedMatches: any[] = [];
    let availableMatches: any[] = [];

    if (player) {
        pendingInvitations = await prisma.invitation.findMany({
            where: { playerId: player.id, status: 'PENDING', match: { status: 'OPEN' } },
            include: { match: { include: { court: true, MatchPlayer: { where: { leftAt: null } } } } },
            orderBy: { sentAt: 'asc' },
        });

        confirmedMatches = await prisma.matchPlayer.findMany({
            where: { playerId: player.id, leftAt: null, noShow: false, match: { status: { in: ['OPEN', 'LOCKED'] } } },
            include: { match: { include: { court: true } } },
        });

        if (player.skillLevel > 0) {
            const skillMin = player.skillLevel - (club?.matchLowerRange ?? 1.0);
            const skillMax = player.skillLevel + (club?.matchUpperRange ?? 1.0);
            availableMatches = await prisma.match.findMany({
                where: {
                    clubId: club?.id,
                    status: 'OPEN',
                    skillLevel: { gte: skillMin, lte: skillMax },
                    startTime: { gte: new Date() },
                    NOT: {
                        OR: [
                            { MatchPlayer: { some: { playerId: player.id, leftAt: null } } },
                            { invitations: { some: { playerId: player.id, status: { in: ['PENDING', 'ACCEPTED'] } } } },
                        ],
                    },
                },
                include: { court: true, MatchPlayer: { where: { leftAt: null } } },
                orderBy: { startTime: 'asc' },
                take: 5,
            });
        }
    }

    return {
        club,
        player,
        recentMessages: recentMessages.slice().reverse().map(m => ({ role: m.role as string, content: m.content })),
        pendingInvitations,
        confirmedMatches,
        availableMatches,
    };
}

// ─────────────────────────────────────────────
// CALL BRAIN
// ─────────────────────────────────────────────

function fmtDatetime(date: Date): string {
    return date.toLocaleString('it-IT', {
        timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric',
        month: 'short', hour: '2-digit', minute: '2-digit',
    });
}

export async function callBrain(
    context: BrainContext,
    userMessage: string,
    contactCards?: { phone?: string; name?: string }[],
): Promise<BrainResponse> {
    const { club, player, recentMessages, pendingInvitations, confirmedMatches, availableMatches } = context;

    const now = new Date().toLocaleString('it-IT', {
        timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric',
        month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });

    const invitationsStr = pendingInvitations.length > 0
        ? pendingInvitations.map((inv, i) => {
            const spots = inv.match.playersNeeded - inv.match.MatchPlayer.length;
            return `  ${i + 1}. ${inv.match.court?.name || 'Campo'} – ${fmtDatetime(inv.match.startTime)} – mancano ${spots} posti [invitationId:${inv.id}]`;
        }).join('\n')
        : '  nessuno';

    const confirmedStr = confirmedMatches.length > 0
        ? confirmedMatches.map(mp =>
            `  - ${mp.match.court?.name || 'Campo'} – ${fmtDatetime(mp.match.startTime)} [matchPlayerId:${mp.id}]`
        ).join('\n')
        : '  nessuno';

    const availableStr = availableMatches.length > 0
        ? availableMatches.map((m, i) => {
            const spots = m.playersNeeded - m.MatchPlayer.length;
            return `  ${i + 1}. ${m.court?.name || 'Campo'} – ${fmtDatetime(m.startTime)} – mancano ${spots} posti [matchId:${m.id}]`;
        }).join('\n')
        : '  nessuna partita aperta adatta';

    const cardsStr = contactCards && contactCards.length > 0
        ? contactCards.map(c => `  - ${c.name || 'Sconosciuto'}: ${c.phone}`).join('\n')
        : null;

    const skillTestPending = !player || player.skillLevel <= 0;

    const clubLocation = [club?.address, club?.city].filter(Boolean).join(', ');

    const systemPrompt = `Sei l'assistente WhatsApp del circolo padel "${club?.name || 'Padel Club'}".
Sei caldo, diretto, colloquiale — come un amico esperto del circolo. Max 2 frasi per messaggio. Emoji padel con parsimonia (🎾🏟️).
Oggi è: ${now}
${clubLocation ? `Circolo: ${clubLocation}` : ''}

═══ CHI SEI E COSA SAI FARE ═══
Gestisci prenotazioni campi e partite del circolo. Puoi rispondere a qualsiasi domanda sulla vita del circolo in modo naturale.
Se non sai qualcosa di specifico (prezzi esatti, orari apertura), dì che verifichi e fai sapere, oppure rimanda al contatto diretto col circolo.
NON devi mai dire "errore tecnico" o cose simili — se non puoi fare qualcosa, spiegalo in modo umano e naturale.

═══ COME FUNZIONA IL CIRCOLO ═══
- Il padel è 2 vs 2 (4 giocatori totale per campo)
- Ogni giocatore si iscrive individualmente — il sistema abbina le persone per livello e disponibilità
- Per ricevere inviti alle partite serve uno Skill Test: una valutazione informale con il maestro per capire il livello di gioco. La contatteremo noi quando siamo pronti — nessuna fretta
- Nel frattempo, i giocatori possono sempre prenotare un campo in autonomia (anche senza skill test)
- Gli inviti arrivano via WhatsApp — basta rispondere sì o no
- Il sistema cerca automaticamente altri giocatori dello stesso livello per completare la partita

═══ STATO GIOCATORE ═══
Nome: ${player?.name || 'non registrato'}
Livello: ${player && player.skillLevel > 0 ? player.skillLevel + ' (scala 1-7, dove 1=principiante, 7=agonista)' : 'da assegnare — Skill Test in attesa'}
${skillTestPending ? 'NOTA: questo giocatore non ha ancora il livello. Può prenotare campi, ma non riceverà inviti automatici finché non completa lo Skill Test.' : ''}

═══ INVITI IN ATTESA ═══
${invitationsStr}

═══ PARTITE CONFERMATE ═══
${confirmedStr}

═══ PARTITE APERTE DISPONIBILI ═══
${availableStr}
${cardsStr ? `\n═══ CONTATTI RICEVUTI ═══\n${cardsStr}` : ''}

═══ AZIONI DISPONIBILI ═══
Rispondi SEMPRE con JSON valido: { "message": "...", "action": "NOME", "params": {...} }

- NONE — risposta conversazionale, nessuna operazione DB. Usa per saluti, domande, info, ringraziamenti, qualsiasi cosa non richieda un'azione specifica
- ACCEPT_INVITATION — params: { "invitationId": "..." } — utente conferma presenza a partita
- REJECT_INVITATION — params: { "invitationId": "..." } — utente declina partita
- CANCEL_MATCH — params: { "matchPlayerId": "..." } — utente vuole annullare partecipazione confermata
- BOOK_FIELD — params: { "day": "YYYY-MM-DD o oggi/domani/lunedì/martedì/...", "time": "HH:MM", "joinMatchId": "id o null" }
  Usa quando l'utente vuole giocare/prenotare e ha fornito giorno + orario.
  Se manca l'orario → NONE e chiedi solo quello.
  Se c'è una partita aperta compatibile → metti joinMatchId.
  Messaggio di conferma: breve e caldo, es. "Perfetto, sei dentro! 🎾" — i dettagli (campo, prezzo, indirizzo) li manda il sistema subito dopo.
  ${skillTestPending ? 'Skill Test pendente: conferma la prenotazione ma NON promettere abbinamento altri giocatori.' : ''}
- OPT_OUT — params: {} — utente non vuole più messaggi
- INVITE_PREFERRED — params: { "playerName": "..." } — utente vuole che un amico specifico venga invitato

═══ REGOLE FONDAMENTALI ═══
- MAI ripetere la stessa frase mandata in precedenza nella stessa conversazione — varia sempre
- MAI usare frasi come "errore tecnico", "problema tecnico", "non riesco" — se c'è un limite, spiegalo con naturalezza
- MAI chiedere più cose insieme — una alla volta
- MAI menzionare lo Skill Test più di una volta per conversazione
- Rispondi a qualsiasi messaggio in modo umano — un "grazie" merita un "prego!", un saluto merita un saluto
- Se l'utente dice cose fuori tema (calcio, cucina, ecc.) rispondi con ironia leggera e riporta al circolo
- Con inviti multipli e risposta ambigua → chiedi a quale si riferisce
${club?.aiTone ? `\nSTILE AGGIUNTIVO: ${club.aiTone}` : ''}`;

    const history = recentMessages.slice(-8);

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 500,
            temperature: 0.7,
            system: systemPrompt,
            messages: [
                ...history.map(m => ({
                    role: (m.role === 'USER' ? 'user' : 'assistant') as 'user' | 'assistant',
                    content: m.content,
                })),
                { role: 'user', content: userMessage },
            ],
        });

        const content = response.content[0];
        if (content.type === 'text') {
            const text = content.text.trim();
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            if (start !== -1 && end !== -1) {
                const parsed = JSON.parse(text.substring(start, end + 1));
                return {
                    message: String(parsed.message || '...'),
                    action: (parsed.action || 'NONE') as BrainAction,
                    params: parsed.params || {},
                };
            }
        }
    } catch (err: any) {
        logger.error({ err: { message: err?.message, stack: err?.stack?.split('\n').slice(0,3).join(' | ') } }, 'Brain call failed');
    }

    // Fallback naturale — mai la stessa frase due volte
    const fallbacks = [
        'Dammi un secondo, ho avuto un piccolo intoppo 😅 Ripeti?',
        'Ops, mi sono perso un attimo! Puoi riscrivere? 🎾',
        'Scusa, non ho capito bene — ripeti e ci penso io!',
        'Un momento di confusione da parte mia 😄 Dimmi di nuovo!',
    ];
    return { message: fallbacks[Math.floor(Math.random() * fallbacks.length)], action: 'NONE' };
}

// ─────────────────────────────────────────────
// EXECUTE ACTION
// ─────────────────────────────────────────────

export async function executeAction(
    action: BrainAction,
    params: any,
    player: any,
    club: any,
): Promise<{ success: boolean; errorMessage?: string; matchId?: string }> {
    if (action === 'NONE') return { success: true };

    try {
        if (action === 'ACCEPT_INVITATION') {
            const inv = await prisma.invitation.findUnique({
                where: { id: params.invitationId },
            });
            if (!inv) return { success: false, errorMessage: 'Invito non trovato.' };

            await prisma.$transaction(async (tx: any) => {
                await tx.$executeRaw`SELECT 1 FROM "Match" WHERE id = ${inv.matchId} FOR UPDATE`;
                const match = await tx.match.findUnique({
                    where: { id: inv.matchId },
                    include: { MatchPlayer: { where: { leftAt: null } } },
                });
                if (!match || match.status !== 'OPEN') throw new Error('MATCH_CLOSED');
                if (match.MatchPlayer.length >= match.playersNeeded) throw new Error('MATCH_FULL');

                await tx.matchPlayer.upsert({
                    where: { matchId_playerId: { matchId: match.id, playerId: player.id } },
                    create: { matchId: match.id, playerId: player.id },
                    update: {},
                });
                await tx.invitation.update({ where: { id: inv.id }, data: { status: 'ACCEPTED', respondedAt: new Date() } });

                if (match.MatchPlayer.length + 1 >= match.playersNeeded) {
                    await tx.match.update({ where: { id: match.id }, data: { status: 'LOCKED' } });
                }

                await tx.player.update({
                    where: { id: player.id },
                    data: { lastContactedAt: new Date() },
                });
            });

            const { increaseReliability } = await import('./scoring');
            await increaseReliability(player.id).catch(() => {});
            return { success: true };
        }

        if (action === 'REJECT_INVITATION') {
            await prisma.invitation.update({
                where: { id: params.invitationId },
                data: { status: 'REJECTED', respondedAt: new Date() },
            });
            return { success: true };
        }

        if (action === 'CANCEL_MATCH') {
            const mp = await prisma.matchPlayer.findUnique({ where: { id: params.matchPlayerId } });
            if (!mp) return { success: false, errorMessage: 'Partecipazione non trovata.' };

            await prisma.matchPlayer.update({ where: { id: mp.id }, data: { leftAt: new Date() } });

            const match = await prisma.match.findUnique({ where: { id: mp.matchId } });
            if (match?.status === 'LOCKED') {
                await prisma.match.update({ where: { id: mp.matchId }, data: { status: 'OPEN' } });
                const { handleMatchUnfillable } = await import('./recovery');
                handleMatchUnfillable(mp.matchId).catch(() => {});
            }

            const { decreaseReliability } = await import('./scoring');
            await decreaseReliability(player.id).catch(() => {});
            return { success: true };
        }

        if (action === 'BOOK_FIELD') {
            const startTime = parseBookingDateTime(params.day, params.time);
            if (!startTime) return { success: false, errorMessage: 'Orario non valido.' };

            // Join existing match if specified
            if (params.joinMatchId) {
                const joinResult = await joinExistingMatch(params.joinMatchId, player);
                return { ...joinResult, matchId: params.joinMatchId };
            }

            // Search for open matches in ±30min window
            const from = new Date(startTime.getTime() - 30 * 60 * 1000);
            const to = new Date(startTime.getTime() + 30 * 60 * 1000);

            if (player.skillLevel > 0) {
                const skillMin = player.skillLevel - (club?.matchLowerRange ?? 1.0);
                const skillMax = player.skillLevel + (club?.matchUpperRange ?? 1.0);
                const existing = await prisma.match.findFirst({
                    where: {
                        clubId: player.clubId,
                        status: 'OPEN',
                        skillLevel: { gte: skillMin, lte: skillMax },
                        startTime: { gte: from, lte: to },
                        NOT: {
                            OR: [
                                { MatchPlayer: { some: { playerId: player.id, leftAt: null } } },
                                { invitations: { some: { playerId: player.id, status: { in: ['PENDING', 'ACCEPTED'] } } } },
                            ],
                        },
                    },
                    include: { MatchPlayer: { where: { leftAt: null } } },
                    orderBy: { startTime: 'asc' },
                });

                if (existing && existing.MatchPlayer.length < existing.playersNeeded) {
                    const joinResult = await joinExistingMatch(existing.id, player);
                    return { ...joinResult, matchId: existing.id };
                }
            }

            // Create new match
            return await createNewMatchAction(startTime, player, club); // returns { success, matchId }
        }

        if (action === 'OPT_OUT') {
            await prisma.player.update({ where: { id: player.id }, data: { active: false } });
            return { success: true };
        }

        if (action === 'INVITE_PREFERRED') {
            // Find player by name in club and add to preferred list
            const preferred = await prisma.player.findFirst({
                where: {
                    clubId: player.clubId,
                    name: { contains: params.playerName, mode: 'insensitive' },
                },
            });
            if (!preferred) return { success: false, errorMessage: `Non ho trovato "${params.playerName}" nel circolo.` };
            // Store as preferred player (no-op for now, matchmaker handles it)
            return { success: true };
        }
    } catch (err: any) {
        logger.error({ err, action, params }, 'executeAction failed');
        return { success: false, errorMessage: err.message || 'Errore imprevisto.' };
    }

    return { success: true };
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

async function joinExistingMatch(matchId: string, player: any): Promise<{ success: boolean; errorMessage?: string }> {
    try {
        await prisma.$transaction(async (tx: any) => {
            await tx.$executeRaw`SELECT 1 FROM "Match" WHERE id = ${matchId} FOR UPDATE`;
            const match = await tx.match.findUnique({
                where: { id: matchId },
                include: { MatchPlayer: { where: { leftAt: null } } },
            });
            if (!match || match.status !== 'OPEN') throw new Error('MATCH_CLOSED');
            if (match.MatchPlayer.length >= match.playersNeeded) throw new Error('MATCH_FULL');

            await tx.matchPlayer.upsert({
                where: { matchId_playerId: { matchId, playerId: player.id } },
                create: { matchId, playerId: player.id },
                update: {},
            });

            const existingInv = await tx.invitation.findFirst({ where: { matchId, playerId: player.id } });
            if (existingInv) {
                await tx.invitation.update({ where: { id: existingInv.id }, data: { status: 'ACCEPTED', respondedAt: new Date() } });
            } else {
                await tx.invitation.create({ data: { matchId, playerId: player.id, status: 'ACCEPTED', respondedAt: new Date() } });
            }

            if (match.MatchPlayer.length + 1 >= match.playersNeeded) {
                await tx.match.update({ where: { id: matchId }, data: { status: 'LOCKED' } });
            }
        });
        return { success: true };
    } catch (err: any) {
        if (err.message === 'MATCH_CLOSED') return { success: false, errorMessage: 'La partita si è chiusa nel frattempo.' };
        if (err.message === 'MATCH_FULL') return { success: false, errorMessage: 'La partita si è riempita nel frattempo.' };
        throw err;
    }
}

async function createNewMatchAction(
    startTime: Date,
    player: any,
    club: any,
): Promise<{ success: boolean; errorMessage?: string; matchId?: string }> {
    const occupied = await prisma.match.findMany({
        where: { clubId: player.clubId, status: { in: ['OPEN', 'LOCKED'] }, startTime },
        select: { courtId: true },
    });
    const occupiedIds = occupied.map(m => m.courtId).filter(Boolean) as string[];
    const freeCourt = await prisma.court.findFirst({
        where: { clubId: player.clubId, active: true, id: { notIn: occupiedIds } },
        orderBy: { name: 'asc' },
    });

    if (!freeCourt) return { success: false, errorMessage: "Tutti i campi sono occupati a quell'orario." };

    const skillLevel = player.skillLevel > 0 ? player.skillLevel : 1.0;

    const match = await prisma.match.create({
        data: {
            clubId: player.clubId,
            courtId: freeCourt.id,
            startTime,
            skillLevel,
            isMixed: false,
            allowMixedLevels: club?.allowMixedLevels ?? false,
            playersNeeded: 4,
            status: 'OPEN',
        },
    });

    await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: player.id } });
    await prisma.invitation.create({ data: { matchId: match.id, playerId: player.id, status: 'ACCEPTED' } });

    // Wave per trovare gli altri 3 giocatori (solo se skill assegnato)
    if (player.skillLevel > 0) {
        const spotsNeeded = match.playersNeeded - 1; // sempre 3
        await waveQueue.add('process-wave', {
            matchId: match.id,
            waveNumber: 1,
            limit: spotsNeeded,
        }, { delay: Math.floor(Math.random() * 60000) + 30000 });
    }

    return { success: true, matchId: match.id };
}

function buildRomeTime(baseDate: Date, h: number, m: number): Date {
    const noon = new Date(Date.UTC(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 12, 0, 0));
    const noonRomeHour = Number(noon.toLocaleString('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }));
    const offsetH = noonRomeHour - 12;
    let utcH = h - offsetH;
    let dayOffset = 0;
    if (utcH < 0) { utcH += 24; dayOffset = -1; }
    if (utcH >= 24) { utcH -= 24; dayOffset = 1; }
    return new Date(Date.UTC(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + dayOffset, utcH, m, 0));
}

function parseBookingDateTime(day: string, time: string): Date | null {
    if (!time) return null;
    const [h, m] = time.split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return null;

    const now = new Date();
    let targetDate = new Date(now);

    if (!day || day === 'oggi') {
        // keep today
    } else if (day === 'domani') {
        targetDate.setDate(targetDate.getDate() + 1);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        const [y, mo, d] = day.split('-').map(Number);
        targetDate = new Date(Date.UTC(y, mo - 1, d, 12, 0));
    } else {
        const dayMap: Record<string, number> = {
            domenica: 0, lunedì: 1, martedì: 2, mercoledì: 3,
            giovedì: 4, venerdì: 5, sabato: 6,
        };
        const target = dayMap[day.toLowerCase()];
        if (target !== undefined) {
            const current = now.getDay();
            let diff = target - current;
            if (diff <= 0) diff += 7;
            targetDate.setDate(targetDate.getDate() + diff);
        }
    }

    return buildRomeTime(targetDate, h, m);
}
