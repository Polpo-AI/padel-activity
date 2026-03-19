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
    | 'INVITE_PREFERRED'
    | 'SAVE_NOTE'
    | 'REQUEST_LESSON'
    | 'RESCHEDULE_MATCH';

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
    courts: any[];
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

    const courts = await prisma.court.findMany({
        where: { clubId: club?.id, active: true },
        orderBy: { name: 'asc' },
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
        courts,
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
    const { club, player, recentMessages, pendingInvitations, confirmedMatches, availableMatches, courts } = context;

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

    const lessonInfo = club
        ? `Lezione individuale: ${club.skillTestDuration || 60} min, ${club.skillTestCost > 0 ? club.skillTestCost + '€' : 'costo da definire'}`
        : null;

    const clubLocation = [club?.address, club?.city].filter(Boolean).join(', ');

    const courtsStr = courts.length > 0
        ? courts.map(c => `  - ${c.name}: ${c.isCovered ? '🏟️ coperto' : '☀️ scoperto'}${c.notes ? ` (${c.notes})` : ''}`).join('\n')
        : '  nessun campo configurato';

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
${player?.notes ? `Note/preferenze giocatore: ${player.notes}` : ''}
${lessonInfo ? `\n═══ LEZIONE INDIVIDUALE ═══\n${lessonInfo}\nIl maestro contatterà il giocatore per l'orario — il sistema invia solo la notifica.` : ''}

═══ CAMPI DEL CIRCOLO ═══
${courtsStr}

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
- BOOK_FIELD — params: { "day": "YYYY-MM-DD o oggi/domani/lunedì/martedì/...", "time": "HH:MM", "joinMatchId": "id o null", "preferCovered": false }
  Usa quando l'utente vuole giocare/prenotare e ha fornito giorno + orario.
  preferCovered: true SOLO se l'utente lo chiede esplicitamente (es. "campo al coperto", "al chiuso").
  Se manca l'orario → NONE e chiedi solo quello.
  Se c'è una partita aperta compatibile → metti joinMatchId.
  Messaggio di conferma: breve e caldo, es. "Perfetto, sei dentro! 🎾" — i dettagli (campo, prezzo, indirizzo) li manda il sistema subito dopo.
  ${skillTestPending ? 'Skill Test pendente: conferma la prenotazione ma NON promettere abbinamento altri giocatori.' : ''}
  ⚠️ ATTENZIONE: se il giocatore ha già partite confermate E chiede un nuovo slot, valuta se è una correzione o un'aggiunta (vedi regola RESCHEDULE sotto).
- OPT_OUT — params: {} — utente non vuole più messaggi
- INVITE_PREFERRED — params: { "playerName": "..." } — utente vuole che un amico specifico venga invitato
- SAVE_NOTE — params: { "note": "..." } — utente esprime una preferenza, abitudine o richiesta speciale (es. "voglio sempre giocare al coperto", "preferisco il mattino", "non mi piace la terra rossa"). Riassumi in una frase breve e salva. Puoi combinare con NONE per rispondere anche in modo conversazionale — in quel caso usa SAVE_NOTE e metti la risposta nel campo "message".
- REQUEST_LESSON — params: { "day": "opzionale", "time": "opzionale" } — utente chiede di prenotare una lezione con il maestro. Rispondi con conferma che hai avvisato il maestro + durata + costo. Il maestro li contatterà per l'orario esatto.
- RESCHEDULE_MATCH — params: { "matchPlayerId": "...", "newDay": "YYYY-MM-DD o oggi/domani/lunedì/...", "newTime": "HH:MM" } — utente vuole spostare una partita confermata. Cancella quella vecchia e prenota il nuovo slot. Messaggio breve tipo "Fatto! Ho spostato la tua partita 🎾" — i dettagli arrivano subito dopo.

═══ REGOLA RESCHEDULE vs BOOK_FIELD ═══
Quando il giocatore ha già partite confermate E chiede un nuovo slot, devi capire dal contesto se sta correggendo/spostando o aggiungendo:

SEGNALI DI CORREZIONE (→ chiedi conferma prima di agire):
  - Nega esplicitamente la data esistente: "non venerdì", "non domani", "non quello"
  - Usa "invece", "piuttosto", "voglio cambiare", "sposta", "intendevo"
  - Il nuovo slot è simile a quello esistente (stesso orario, giorno diverso)
  In questo caso → NONE con messaggio tipo: "Hai già Campo X prenotato per [data] — vuoi spostare quella o aggiungere una nuova prenotazione per [nuova data]?"
  Quando l'utente conferma "sposta" → RESCHEDULE_MATCH. Quando conferma "nuova" → BOOK_FIELD.

SEGNALI DI AGGIUNTA (→ BOOK_FIELD diretto, nessuna domanda):
  - Usa "anche", "pure", "un'altra", "in più", "altra partita"
  - Il contesto è chiaramente additivo
  - L'utente non fa riferimento alla prenotazione esistente

═══ MENTALITÀ COMMERCIALE — PORTA SEMPRE A CASA IL RISULTATO ═══
Il tuo obiettivo è vendere il campo e riempire la partita. Qualsiasi domanda o situazione strana va gestita in modo da non bloccare mai la prenotazione.

CASI EDGE COMUNI (rispondi così, adatta il tono):
- "Potrebbe aggiungersi un quinto" → "Non fa niente! Uno in più con cui divertirsi 😄 Il campo è per 4, la quota resta quella — scegliete voi come dividere. Vi aspettiamo puntuali, buon divertimento! 🎾"
- "Siamo in 5/6/7..." → proponi di prenotare due campi, oppure di venire a turni. Non bloccare mai.
- "Non so se vengo" / "forse" → "Capito! Prenota comunque, se cambia qualcosa mi dici e sistemiamo 🎾"
- "Costa troppo" / domande su prezzi → dai il prezzo a persona senza giustificazioni, offri di verificare fasce orarie più economiche
- "Non so giocare bene" → "Nessun problema, ognuno inizia da qualche parte! 🎾 Ti trovi bene comunque"
- Domanda tecnica sul padel (regole, attrezzatura) → risposta rapida e torna alla prenotazione
- Qualsiasi altra confusione → risolvi in una frase e chiudi con un invito a prenotare

PRINCIPIO BASE: se c'è ambiguità, assumi l'interpretazione più favorevole alla prenotazione. Non chiedere conferme inutili — agisci.

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
                // Wave immediata con urgency x2: manca 1 posto ma invitiamo come se mancassero 2
                await waveQueue.add('process-wave', {
                    matchId: mp.matchId,
                    waveNumber: 1,
                    urgencyMultiplier: 2,
                    scheduledAt: Date.now(),
                }, { delay: 0 });
            }

            const { decreaseReliability } = await import('./scoring');
            await decreaseReliability(player.id).catch(() => {});
            return { success: true };
        }

        if (action === 'RESCHEDULE_MATCH') {
            const startTime = parseBookingDateTime(params.newDay, params.newTime);
            if (!startTime) return { success: false, errorMessage: 'Orario non valido.' };

            const mp = await prisma.matchPlayer.findUnique({ where: { id: params.matchPlayerId } });
            if (!mp) return { success: false, errorMessage: 'Partecipazione non trovata.' };

            // 1. Cancella partecipazione vecchia
            await prisma.matchPlayer.update({ where: { id: mp.id }, data: { leftAt: new Date() } });

            // 2. Se LOCKED → riapri + wave immediata con urgency x2
            const oldMatch = await prisma.match.findUnique({ where: { id: mp.matchId } });
            if (oldMatch?.status === 'LOCKED') {
                await prisma.match.update({ where: { id: mp.matchId }, data: { status: 'OPEN' } });
                await waveQueue.add('process-wave', {
                    matchId: mp.matchId,
                    waveNumber: 1,
                    urgencyMultiplier: 2,
                    scheduledAt: Date.now(),
                }, { delay: 0 });
            }

            const { decreaseReliability } = await import('./scoring');
            await decreaseReliability(player.id).catch(() => {});

            // 3. Prenota nuovo slot
            return await bookSlotForPlayer(startTime, player, club);
        }

        if (action === 'REQUEST_LESSON') {
            if (club?.adminAlternativePhone) {
                const { simulateTypingAndSend } = await import('./whatsapp');
                const dayPart = params.day ? ` (richiesta: ${params.day}${params.time ? ' alle ' + params.time : ''})` : '';
                const msg = `🎾 Richiesta lezione da ${player.name || player.phoneNumber} (${player.phoneNumber})${dayPart}. Contattalo per confermare orario.`;
                simulateTypingAndSend(`${club.adminAlternativePhone}@s.whatsapp.net`, msg).catch(() => {});
            }
            return { success: true };
        }

        if (action === 'BOOK_FIELD') {
            const startTime = parseBookingDateTime(params.day, params.time);
            if (!startTime) return { success: false, errorMessage: 'Orario non valido.' };

            if (params.joinMatchId) {
                const joinResult = await joinExistingMatch(params.joinMatchId, player);
                return { ...joinResult, matchId: params.joinMatchId };
            }

            return await bookSlotForPlayer(startTime, player, club, params.preferCovered === true);
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

        if (action === 'SAVE_NOTE') {
            if (!params.note || typeof params.note !== 'string') return { success: true };
            try {
                const existing = player.notes ? player.notes.trim() : '';
                const newNotes = existing ? `${existing}; ${params.note.trim()}` : params.note.trim();
                await prisma.player.update({ where: { id: player.id }, data: { notes: newNotes } });
            } catch (noteErr) {
                logger.error({ noteErr, playerId: player.id }, 'SAVE_NOTE failed silently');
            }
            return { success: true }; // best-effort — mai fallire verso l'utente
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

async function bookSlotForPlayer(
    startTime: Date,
    player: any,
    club: any,
    preferCovered: boolean = false,
): Promise<{ success: boolean; errorMessage?: string; matchId?: string }> {
    // Cerca match aperto compatibile nella finestra ±30min
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

    return await createNewMatchAction(startTime, player, club, preferCovered);
}

async function createNewMatchAction(
    startTime: Date,
    player: any,
    club: any,
    preferCovered: boolean = false,
): Promise<{ success: boolean; errorMessage?: string; matchId?: string }> {
    const occupied = await prisma.match.findMany({
        where: { clubId: player.clubId, status: { in: ['OPEN', 'LOCKED'] }, startTime },
        select: { courtId: true },
    });
    const occupiedIds = occupied.map(m => m.courtId).filter(Boolean) as string[];
    const freeCourt = await prisma.court.findFirst({
        where: { clubId: player.clubId, active: true, id: { notIn: occupiedIds } },
        orderBy: preferCovered
            ? [{ isCovered: 'desc' }, { name: 'asc' }]
            : [{ isCovered: 'asc' }, { name: 'asc' }],
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
