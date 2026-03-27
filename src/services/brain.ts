/**
 * BRAIN SERVICE
 *
 * Cervello AI del bot: riceve contesto completo → genera risposta + decide azione.
 * Nessuna frase hardcodata. Claude Sonnet guida tutta la conversazione.
 */

import { prisma } from './db';
import { anthropic } from './ai';
import { waveQueue, getRedis } from './queue';
import pino from 'pino';

const logger = pino({ level: 'info' });

export type BrainAction =
    | 'NONE'
    | 'ACCEPT_INVITATION'
    | 'REJECT_INVITATION'
    | 'CANCEL_MATCH'
    | 'BOOK_FIELD'
    | 'OPT_OUT'
    | 'OPT_IN'
    | 'INVITE_PREFERRED'
    | 'SAVE_NOTE'
    | 'REQUEST_LESSON'
    | 'RESCHEDULE_MATCH'
    | 'FAQ_REQUEST'
    | 'REGISTER_PLAYER';

export interface BrainResponse {
    message: string;
    action: BrainAction;
    params?: any;
}

export interface BrainContext {
    club: any;
    player: any | null;
    isAdmin: boolean;
    recentMessages: { role: string; content: string }[];
    pendingInvitations: any[];
    confirmedMatches: any[];
    availableMatches: any[];
    courts: any[];
    faqs: any[];
    slotsAvailability: { fullSlots: string[]; onlyCoveredSlots: string[]; freeScopertoSlots: string[] };
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

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000); // ultime 24h
    const recentMessages = await prisma.whatsAppMessage.findMany({
        where: { chatId: jid, timestamp: { gte: since } },
        orderBy: { timestamp: 'desc' },
        take: 30, // cap di sicurezza
    });

    const courts = await prisma.court.findMany({
        where: { clubId: club?.id, active: true },
        include: { prices: true },
        orderBy: { name: 'asc' },
    });

    const faqs = club?.id ? await prisma.faq.findMany({
        where: { clubId: club.id, answer: { not: null } },
        orderBy: { createdAt: 'desc' },
        take: 30,
    }) : [];

    const isAdmin = !!(club?.adminPhone &&
        phoneNumber.replace(/\D/g, '') === club.adminPhone.replace(/\D/g, ''));

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
            include: { match: { include: { court: true, MatchPlayer: { where: { leftAt: null } } } } },
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
                take: 8,
            });
            // Ordina per completezza decrescente (quasi piene prima = migliori per redirect)
            availableMatches.sort((a: any, b: any) => {
                const spotsA = a.playersNeeded - a.MatchPlayer.length;
                const spotsB = b.playersNeeded - b.MatchPlayer.length;
                return spotsA - spotsB; // 1 posto libero prima, 3 dopo
            });
        }
    }

    // Slot availability: compute full/only-covered slots (next 10 days) + free scoperto slots (next 7 days)
    const now_ = new Date();
    const in10Days_ = new Date(now_.getTime() + 10 * 24 * 60 * 60 * 1000);
    const scopertoCourtIds = courts.filter((c: any) => !c.isCovered).map((c: any) => c.id) as string[];

    // Query: all matches next 10 days (for full/only-covered) + occupied scoperto (for free scoperto)
    const upcomingForAvail = await prisma.match.findMany({
        where: {
            clubId: club?.id,
            status: { in: ['OPEN', 'LOCKED'] },
            startTime: { gte: now_, lte: in10Days_ },
        },
        select: { startTime: true, courtId: true, court: { select: { isCovered: true } } },
    });

    const totalCourts = courts.length;
    const totalScoperto = scopertoCourtIds.length;
    const slotMap = new Map<number, { matchCount: number; coveredMatchCount: number }>();
    // Map: timestamp → set of occupied scoperto courtIds
    const occupiedScopertoMap = new Map<number, Set<string>>();

    for (const m of upcomingForAvail) {
        const t = m.startTime.getTime();
        const s = slotMap.get(t) ?? { matchCount: 0, coveredMatchCount: 0 };
        s.matchCount++;
        if ((m as any).court?.isCovered) s.coveredMatchCount++;
        slotMap.set(t, s);
        // Track occupied scoperto courts per slot
        if (m.courtId && scopertoCourtIds.includes(m.courtId)) {
            if (!occupiedScopertoMap.has(t)) occupiedScopertoMap.set(t, new Set());
            occupiedScopertoMap.get(t)!.add(m.courtId);
        }
    }

    const fullSlots: string[] = [];
    const onlyCoveredSlots: string[] = [];
    for (const [t, s] of slotMap) {
        const label = new Date(t).toLocaleString('it-IT', {
            timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit',
        });
        if (totalCourts > 0 && s.matchCount >= totalCourts) {
            fullSlots.push(label);
        } else if (totalScoperto > 0) {
            const scopertoOccupied = s.matchCount - s.coveredMatchCount;
            if (scopertoOccupied >= totalScoperto && s.matchCount < totalCourts) {
                onlyCoveredSlots.push(label);
            }
        }
    }

    // Free scoperto slots for next 7 days: compute synthetic 90-min slots within club hours
    const freeScopertoSlots = await computeFreeScopertoSlots(
        club?.id ?? '',
        scopertoCourtIds,
        club?.openTime || '08:00',
        club?.closeTime || '23:30',
        now_,
        7,
        10,
        occupiedScopertoMap,
    );

    return {
        club,
        player,
        isAdmin,
        recentMessages: recentMessages.slice().reverse().map(m => ({ role: m.role as string, content: m.content })),
        pendingInvitations,
        confirmedMatches,
        availableMatches,
        courts,
        faqs,
        slotsAvailability: { fullSlots, onlyCoveredSlots, freeScopertoSlots },
    };
}

// ─────────────────────────────────────────────
// FREE SCOPERTO SLOTS — helpers (used in context + ONLY_COVERED_AVAILABLE redirect)
// ─────────────────────────────────────────────

/**
 * Computes free scoperto slots within open hours for the next N days.
 * Accepts a pre-computed occupiedMap (timestamp → Set<courtId>) to avoid extra DB queries
 * when called from buildBrainContext (which already fetched the matches).
 * When called standalone (findNearbyFreeScopertoSlots), it fetches from DB directly.
 */
async function computeFreeScopertoSlots(
    clubId: string,
    scopertoCourtIds: string[],
    openTime: string,
    closeTime: string,
    from: Date,
    days: number = 7,
    maxSlots: number = 10,
    precomputedOccupied?: Map<number, Set<string>>,
): Promise<string[]> {
    if (scopertoCourtIds.length === 0) return [];

    let occupiedMap: Map<number, Set<string>>;
    if (precomputedOccupied) {
        occupiedMap = precomputedOccupied;
    } else {
        const to = new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
        const occupied = await prisma.match.findMany({
            where: { clubId, status: { in: ['OPEN', 'LOCKED'] }, startTime: { gte: from, lte: to }, courtId: { in: scopertoCourtIds } },
            select: { startTime: true, courtId: true },
        });
        occupiedMap = new Map();
        for (const m of occupied) {
            const t = m.startTime.getTime();
            if (!occupiedMap.has(t)) occupiedMap.set(t, new Set());
            if (m.courtId) occupiedMap.get(t)!.add(m.courtId);
        }
    }

    const [openH, openM] = (openTime || '08:00').split(':').map(Number);
    const [closeH, closeM] = (closeTime || '23:30').split(':').map(Number);
    const lastSlotMinutes = closeH * 60 + closeM - 90; // last valid start
    const freeSlots: string[] = [];

    for (let d = 0; d < days && freeSlots.length < maxSlots; d++) {
        const baseDate = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + d));
        let slotH = openH, slotM = openM;

        while (slotH * 60 + slotM <= lastSlotMinutes && freeSlots.length < maxSlots) {
            const slotTime = buildRomeTime(baseDate, slotH, slotM);
            if (slotTime > from) {
                const t = slotTime.getTime();
                const occupiedCourts = occupiedMap.get(t) ?? new Set<string>();
                const hasFree = scopertoCourtIds.some(id => !occupiedCourts.has(id));
                if (hasFree) {
                    freeSlots.push(slotTime.toLocaleString('it-IT', {
                        timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric',
                        month: 'numeric', hour: '2-digit', minute: '2-digit',
                    }));
                }
            }
            const totalM = slotH * 60 + slotM + 90;
            slotH = Math.floor(totalM / 60);
            slotM = totalM % 60;
        }
    }
    return freeSlots;
}

/**
 * Exported: finds free scoperto slots near a reference time (±4 days).
 * Used by messageHandler when ONLY_COVERED_AVAILABLE to suggest alternatives.
 */
export async function findNearbyFreeScopertoSlots(
    clubId: string,
    referenceTime: Date,
    openTime: string,
    closeTime: string,
    limit: number = 3,
): Promise<string[]> {
    const courts = await prisma.court.findMany({
        where: { clubId, active: true, isCovered: false },
        select: { id: true },
    });
    return computeFreeScopertoSlots(clubId, courts.map(c => c.id), openTime, closeTime, referenceTime, 4, limit);
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
    const { club, player, isAdmin, recentMessages, pendingInvitations, confirmedMatches, availableMatches, courts, faqs, slotsAvailability } = context;

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
        ? confirmedMatches.map(mp => {
            const confirmed = mp.match.MatchPlayer?.length ?? 0;
            const needed = mp.match.playersNeeded ?? 4;
            const free = needed - confirmed;
            const statusLabel = mp.match.status === 'LOCKED'
                ? `campo pieno (${confirmed}/${needed})`
                : `${confirmed}/${needed} confermati, mancano ${free}`;
            return `  - ${mp.match.court?.name || 'Campo'} – ${fmtDatetime(mp.match.startTime)} – ${statusLabel} [matchPlayerId:${mp.id}]`;
        }).join('\n')
        : '  nessuno';

    const availableStr = availableMatches.length > 0
        ? `(ordinate per completezza — prima le quasi piene, ottime per redirect)\n` + availableMatches.map((m, i) => {
            const confirmed = m.MatchPlayer?.length ?? 0;
            const spots = m.playersNeeded - confirmed;
            return `  ${i + 1}. ${m.court?.name || 'Campo'} – ${fmtDatetime(m.startTime)} – ${confirmed}/${m.playersNeeded} confermati, mancano ${spots} [matchId:${m.id}]`;
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

    const nowDate = new Date();
    const in10days = new Date(nowDate.getTime() + 10 * 24 * 60 * 60 * 1000);

    const courtsStr = courts.length > 0
        ? courts.map(c => {
            const label = `${c.name}: ${c.isCovered ? '🏟️ coperto' : '☀️ scoperto'}${c.notes ? ` (${c.notes})` : ''}`;

            if (!c.prices || c.prices.length === 0) return `  - ${label}`;

            const standardPrices = c.prices.filter((p: any) => !p.startDate && !p.endDate);
            const exceptionPrices = c.prices.filter((p: any) => p.startDate || p.endDate);

            // Prezzo standard: mostra il range (min-max) oppure unico valore
            let priceStr = '';
            if (standardPrices.length > 0) {
                const vals = standardPrices.map((p: any) => p.price);
                const minP = Math.min(...vals);
                const maxP = Math.max(...vals);
                const perPerson = (v: number) => (v / 4).toFixed(0);
                priceStr = minP === maxP
                    ? `€${perPerson(minP)}/persona`
                    : `€${perPerson(minP)}-${perPerson(maxP)}/persona a seconda dell'orario`;
            }

            // Prezzi speciali attivi ora o nei prossimi 7 giorni
            const activeExceptions = exceptionPrices.filter((p: any) => {
                const from = p.startDate ? new Date(p.startDate) : null;
                const to = p.endDate ? new Date(p.endDate) : null;
                const startsWithin7 = from && from <= in10days;
                const notYetExpired = !to || to >= nowDate;
                const alreadyActive = !from || from <= nowDate;
                return notYetExpired && (alreadyActive || startsWithin7);
            });

            if (activeExceptions.length > 0) {
                const vals = activeExceptions.map((p: any) => p.price);
                const maxSpecial = Math.max(...vals);
                const perPerson = (maxSpecial / 4).toFixed(0);
                const from = activeExceptions[0].startDate ? new Date(activeExceptions[0].startDate).toLocaleDateString('it-IT') : null;
                const to = activeExceptions[0].endDate ? new Date(activeExceptions[0].endDate).toLocaleDateString('it-IT') : null;
                const period = from && to ? ` (dal ${from} al ${to})` : from ? ` (dal ${from})` : to ? ` (fino al ${to})` : '';
                priceStr += priceStr ? ` | Tariffa speciale${period}: €${perPerson}/persona` : `Tariffa speciale${period}: €${perPerson}/persona`;
            }

            return `  - ${label}${priceStr ? ` — ${priceStr}` : ''}`;
        }).join('\n')
        : '  nessun campo configurato';

    const clubOpenClose = club ? `${club.openTime || '08:00'} – ${club.closeTime || '23:30'}` : null;

    const botName = (club as any)?.botName || 'Francesca';
    const toneDescription = club?.aiTone ||
        'calda, diretta, colloquiale — come un\'amica esperta del circolo. Max 2 frasi per messaggio. Emoji padel con parsimonia (🎾🏟️)';

    const faqsStr = faqs?.length > 0
        ? faqs.map((f: any) => `D: ${f.question}\nR: ${f.answer}`).join('\n\n')
        : null;

    const racketPriceStr = (club as any)?.racketPrice != null
        ? `Noleggio racchetta: €${(club as any).racketPrice}/persona`
        : null;

    const next7days = Array.from({ length: 10 }, (_, i) => {
        const d = new Date(nowDate.getTime() + i * 24 * 60 * 60 * 1000);
        return d.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric', month: 'numeric' });
    }).join(', ');

    const systemPrompt = `Ti chiami ${botName} e sei l'assistente virtuale del circolo padel "${club?.name || 'Padel Club'}".
Tono: ${toneDescription}
Presentati come ${botName}, assistente virtuale del circolo, se qualcuno ti chiede il tuo nome o in apertura di conversazione con nuovi contatti. Sei trasparente sul fatto di essere un assistente virtuale — se te lo chiedono esplicitamente, confermalo senza esitazione.
Usa SEMPRE il "tu" — mai il "voi" o il "lei". Es. "ti trovi bene", "puoi prenotare", "sei dentro" — mai "vi trovate", "potete", "siete".
Oggi è: ${now}
Prossimi 10 giorni: ${next7days}
${isAdmin ? `
═══ MODALITÀ ADMIN ═══
Stai parlando con l'amministratore del circolo. Rispondi in modo diretto e operativo, senza le presentazioni e le formalità che useresti con un giocatore normale.
L'admin può:
- Ricevere notifiche e aggiornamenti sugli eventi del circolo
- Rispondere alle domande degli utenti (le tue risposte vengono salvate come FAQ dal sistema)
- Gestire il circolo via WhatsApp con comandi come "lista partite", "cancella partita", "lista giocatori", ecc.
Non proporgli di prenotare campi o partecipare a partite — è il gestore, non un giocatore.
` : ''}
═══ INFO CIRCOLO ═══
Nome: ${club?.name || 'Padel Club'}
${clubLocation ? `Indirizzo: ${clubLocation}` : ''}
${clubOpenClose ? `Orari: ${clubOpenClose}` : ''}
${racketPriceStr ? racketPriceStr : ''}
Se qualcuno chiede "siete voi in [via]?" o "qual è il vostro indirizzo?" rispondi con le info sopra in modo naturale.

═══ CHI SEI E COSA SAI FARE ═══
Puoi: prenotare campi, accettare/rifiutare inviti a partite, cancellare una prenotazione, invitare un amico specifico, prenotare una lezione col maestro.
Non puoi: gestire pagamenti, modificare dati personali, vedere i contatti degli altri giocatori.
Se non sai qualcosa, dì che verifichi col circolo — mai inventare informazioni.
NON devi mai dire "errore tecnico" o cose simili — se non puoi fare qualcosa, spiegalo in modo umano e naturale.

═══ COME FUNZIONA IL CIRCOLO ═══
- Il padel è 2 vs 2 (4 giocatori per campo)
- Ogni giocatore prenota per sé — il sistema abbina automaticamente per livello
- Per gli inviti automatici serve lo Skill Test (valutazione col maestro, il circolo contatta quando disponibile). Prima del test si può comunque prenotare un campo liberamente.
- Quando si prenota: il sistema cerca altri giocatori compatibili e li invita via WhatsApp. Gli inviti scadono — chi non risponde viene escluso e si invita qualcun altro.
- Quando la partita si riempie (4 confermati): viene creato un gruppo WhatsApp con tutti i giocatori e ricevono conferma.
- Si può cancellare la propria partecipazione rispondendo al bot — il posto torna disponibile per altri.
- Per portare un amico specifico: basta dirlo al bot, che verifica se è iscritto al circolo e lo invita prioritariamente.

${!player ? `═══ UTENTE NON REGISTRATO ═══
Questa persona non è ancora iscritta al circolo.
Raccogliere nome e cognome è la tua priorità, ma in modo completamente naturale.
- Rispondi PRIMA a qualsiasi cosa chieda (prezzi, campi, orari, come funziona — tutto)
- Presentati come ${botName} se è uno dei primi scambi della conversazione
- Chiedi nome e cognome solo quando è naturale, MAI in modo burocratico
- Quando hai ENTRAMBI nome E cognome certi → usa REGISTER_PLAYER
- Se hai solo il nome → rispondi e chiedi il cognome con leggerezza
- MAI usare REGISTER_PLAYER senza avere sia nome che cognome certi` : `═══ STATO GIOCATORE ═══
Nome: ${player.name || 'non registrato'}
Livello: ${player.skillLevel > 0 ? player.skillLevel + ' (scala 1-7, dove 1=principiante, 7=agonista)' : 'da assegnare — Skill Test in attesa'}
${player.skillLevel <= 0 ? `NOTA SKILL TEST: questo giocatore NON ha ancora completato lo Skill Test.
- PUÒ prenotare un campo per sé e i suoi amici (fino a 4 persone totali)
- NON può essere abbinato automaticamente con altri giocatori — il sistema non lo cerca e non lo propone
- Se chiede di giocare "con altri" o "con persone del suo livello": spiegagli PRIMA DI PRENOTARE che per quello serve lo Skill Test, che il circolo organizzerà appena possibile. Poi chiedi se vuole comunque prenotare il campo.
- Se vuole prenotare solo il campo (anche con amici propri) → procedi con BOOK_FIELD normalmente.` : ''}
${player.notes ? `Note/preferenze giocatore: ${player.notes}` : ''}
${lessonInfo ? `\n═══ LEZIONE INDIVIDUALE ═══\n${lessonInfo}\nIl maestro contatterà il giocatore per l'orario — il sistema invia solo la notifica.` : ''}`}

═══ CAMPI DEL CIRCOLO ═══
${courtsStr}
${faqsStr ? `\n═══ FAQ DEL CIRCOLO ═══\nQueste domande hanno già una risposta ufficiale del circolo. Se la domanda dell'utente corrisponde a una di queste, usa la risposta memorizzata (adattando il tono ma senza cambiare il contenuto):\n\n${faqsStr}` : ''}


═══ DISPONIBILITÀ CAMPI (prossimi 7-10 giorni) ═══
${slotsAvailability.freeScopertoSlots.length > 0
    ? `Slot con campo SCOPERTO libero (preferiti — usa questi per suggerire disponibilità):\n${slotsAvailability.freeScopertoSlots.map(s => `  - ${s}`).join('\n')}`
    : 'Nessun campo scoperto libero nei prossimi 7 giorni.'}
${slotsAvailability.onlyCoveredSlots.length > 0 ? `\nSolo coperto disponibile a questi orari (scoperti occupati da partite in corso):\n${slotsAvailability.onlyCoveredSlots.map(s => `  - ${s}`).join('\n')}` : ''}
${slotsAvailability.fullSlots.length > 0 ? `\nSlot completamente occupati (nessun campo libero):\n${slotsAvailability.fullSlots.map(s => `  - ${s}`).join('\n')}` : ''}

COME USARE QUESTA INFO:
• freeScopertoSlots è una lista di SUGGERIMENTI pre-calcolati a intervalli fissi — NON è una whitelist di orari prenotabili. Se l'utente richiede un orario SPECIFICO (es. "sabato alle 9"), quell'orario è valido anche se non appare nella lista, purché non sia in fullSlots e rientri nell'orario di apertura del circolo.
• "quando hai disponibilità?" / "quando c'è posto?" → proponi 3-4 slot da freeScopertoSlots in modo conversazionale. Se non ci sono scoperti liberi, proponi quelli con solo coperto.
• Se l'utente chiede un orario specifico: controlla SOLO se è in fullSlots (bloccante), prima dell'orario di apertura, o se startTime + 90 min supera l'orario di chiusura (es. chiusura 23:30 → ultimo orario valido 22:00). In tutti gli altri casi esegui BOOK_FIELD direttamente senza chiedere conferma disponibilità.
• Matchmaking (skill > 0): se l'orario richiesto è in fullSlots → NON eseguire BOOK_FIELD. Proponi le "PARTITE APERTE DISPONIBILI" (quasi complete, usa joinMatchId). Messaggio: "Quell'orario è al completo, ma ho queste partite che cercano ancora giocatori — vuoi unirti a una di queste?" Se nessuna va bene → suggerisci slot da freeScopertoSlots per creare una nuova pending.
• Se l'utente vuole un orario specifico pieno E non vuole alternative → BOOK_FIELD sull'orario più vicino libero da freeScopertoSlots.
• Se l'utente riceve "tutti i campi occupati" e chiede alternative → mostra le partite quasi complete da "PARTITE APERTE DISPONIBILI" (joinMatchId) oppure slot da freeScopertoSlots per nuova pending.
• onlyCoveredSlots: ok per solo booking, chiedi conferma; per matchmaking procedi normalmente (il sistema gestisce la conferma coperto).
${player ? `═══ INVITI IN ATTESA ═══
${invitationsStr}

═══ PARTITE CONFERMATE ═══
${confirmedStr}
⚠️ IMPORTANTE: questa sezione è l'UNICA fonte autorevole sulle prenotazioni attuali del giocatore. La cronologia della conversazione può essere obsoleta (es. partite cancellate dal circolo dopo la prenotazione). Se qui risulta "nessuno", il giocatore NON ha prenotazioni attive — indipendentemente da cosa dicono i messaggi precedenti.

═══ PARTITE APERTE DISPONIBILI ═══
${availableStr}` : ''}
${cardsStr ? `\n═══ CONTATTI RICEVUTI ═══\n${cardsStr}` : ''}

${!player ? `═══ AZIONI DISPONIBILI ═══
Rispondi SEMPRE con JSON valido: { "message": "...", "action": "NOME", "params": {...} }

- NONE — risposta conversazionale: info sul circolo, prezzi, come funziona, qualsiasi cosa che non richieda registrazione
- REGISTER_PLAYER — params: { "name": "Nome Cognome" } — registra il nuovo giocatore. Usa SOLO quando hai nome E cognome certi. Il messaggio deve essere un breve benvenuto caldo nel circolo, spiegare che può già prenotare campi e che verranno contattati per lo Skill Test.
  Quando hai solo il nome e chiedi il cognome, spiega brevemente il motivo: "per salvare il tuo contatto e proporti partite future ho bisogno anche del cognome".` : `═══ AZIONI DISPONIBILI ═══
Rispondi SEMPRE con JSON valido: { "message": "...", "action": "NOME", "params": {...} }

- NONE — risposta conversazionale, nessuna operazione DB. Usa per saluti, domande, info, ringraziamenti, qualsiasi cosa non richieda un'azione specifica
- ACCEPT_INVITATION — params: { "invitationId": "..." } — utente conferma presenza a partita
- REJECT_INVITATION — params: { "invitationId": "..." } — utente declina partita
- CANCEL_MATCH — params: { "matchPlayerId": "..." } — utente vuole annullare partecipazione confermata
- BOOK_FIELD — params: { "day": "YYYY-MM-DD o oggi/domani/lunedì/martedì/...", "time": "HH:MM", "joinMatchId": "id o null", "preferCovered": false, "preferMixed": null }
  Usa quando l'utente vuole giocare/prenotare e ha fornito giorno + orario.
  preferCovered: true SOLO se l'utente lo chiede esplicitamente (es. "campo al coperto", "al chiuso"). Default: false (scoperto preferito).
  preferMixed: true se accetta match misto (maschi e femmine insieme), false se preferisce solo stesso sesso, null se non ha ancora espresso preferenza.
  ⚠️ REGOLA MISTO: se preferMixed è null (non ancora espresso e skill > 0), prima chiedi con NONE: "Preferisci un match solo con giocatori del tuo stesso sesso o va bene anche misto?" Poi al turno successivo usa BOOK_FIELD con preferMixed impostato. Se lo skill test è pendente (skill <= 0) non chiedere — salta e usa preferMixed: false.
  Se manca l'orario → NONE e chiedi solo quello.
  Se c'è una partita aperta compatibile (da "PARTITE APERTE DISPONIBILI") → usa joinMatchId.
  ⚠️ REDIRECT: se l'orario richiesto è in fullSlots O il sistema ha appena risposto "tutti i campi occupati" → NON creare nuovo BOOK_FIELD senza joinMatchId. Prima proponi le "PARTITE APERTE DISPONIBILI" (le più complete, con meno posti liberi). Se l'utente sceglie una → BOOK_FIELD con joinMatchId. Se non vuole nessuna → suggerisci slot da freeScopertoSlots per nuova pending.
  Messaggio nel JSON per BOOK_FIELD (quando skill > 0 e nuova partita): "Perfetto, sto cercando gli altri giocatori — ti scrivo nel gruppo quando siamo in 4. 🎾" NON menzionare mai il nome del campo, il tipo (coperto/scoperto) o altri dettagli.
  Messaggio per BOOK_FIELD con joinMatchId: "Perfetto, ti aggiungo! 🎾" (breve, il sistema gestisce il resto).
  Messaggio per BOOK_FIELD (quando skill test pendente): breve e neutro, tipo "Perfetto, prenoto subito! 🎾" — i dettagli li manda il sistema.
  ${skillTestPending ? 'Skill Test pendente: puoi confermare la prenotazione del campo, ma PRIMA spiega che il sistema non abbinerà altri giocatori finché non completa lo Skill Test.' : ''}
  ⚠️ ATTENZIONE: se il giocatore ha già partite confermate E chiede un nuovo slot, valuta se è una correzione o un'aggiunta (vedi regola RESCHEDULE sotto).
- OPT_OUT — params: {} — utente non vuole più messaggi / vuole essere rimosso dalla lista
- OPT_IN — params: {} — utente vuole rientrare nella lista (es. "voglio ricominciare", "rimettimi dentro", "voglio ricevere partite di nuovo"). Usa solo se il giocatore risulta inattivo o lo chiede esplicitamente.
- INVITE_PREFERRED — params: { "playerName": "Nome Cognome" } — utente vuole che una persona specifica venga coinvolta nella partita tramite matchmaking.
  ⚠️ REGOLA: usa SOLO se l'utente cita un NOME SPECIFICO (es. "voglio giocare con Marco", "ci sono io e Luca Rossi"). Il sistema verificherà se esistono nel circolo.
  ⛔ ECCEZIONE 1: se il giocatore ha GIÀ una partita confermata e menziona un amico che "viene con lui" — NON usare INVITE_PREFERRED. Il campo è già prenotato, chi portano è affar loro. Rispondi che possono venire in quanti vogliono (fino a 4 totali).
  ⛔ ECCEZIONE 2: se l'utente parla di "amici", "compagni" o "persone" in modo GENERICO (es. "vengo con degli amici", "siamo un gruppo", "veniamo in 4") SENZA nomi specifici → NON usare INVITE_PREFERRED. Usa BOOK_FIELD direttamente — il campo tiene fino a 4 giocatori e il sistema gestisce il resto.
  MAI creare una partita con wave quando l'utente ha già indicato persone specifiche con cui vuole giocare.
- SAVE_NOTE — params: { "note": "..." } — utente esprime una preferenza, abitudine o richiesta speciale (es. "voglio sempre giocare al coperto", "preferisco il mattino", "non mi piace la terra rossa"). Riassumi in una frase breve e salva. Puoi combinare con NONE per rispondere anche in modo conversazionale — in quel caso usa SAVE_NOTE e metti la risposta nel campo "message".
- REQUEST_LESSON — params: { "day": "opzionale", "time": "opzionale" } — utente chiede di prenotare una lezione con il maestro. Rispondi con conferma che hai avvisato il maestro + durata + costo. Il maestro li contatterà per l'orario esatto.
- RESCHEDULE_MATCH — params: { "matchPlayerId": "...", "newDay": "YYYY-MM-DD o oggi/domani/lunedì/...", "newTime": "HH:MM" } — utente vuole spostare una partita confermata. Cancella quella vecchia e prenota il nuovo slot. Messaggio breve tipo "Fatto! Ho spostato la tua partita 🎾" — i dettagli arrivano subito dopo.
- FAQ_REQUEST — params: { "question": "testo esatto della domanda" } — usa SOLO quando l'utente fa una domanda sul circolo (orari speciali, regole particolari, eventi, iniziative) a cui NON puoi rispondere con le informazioni disponibili.
  ⛔ NON usare FAQ_REQUEST per: stato della partita, quante persone mancano, chi è già confermato — queste info sono nella sezione PARTITE CONFERMATE sopra, rispondi direttamente.
  ⛔ NON usare FAQ_REQUEST se la risposta è già nella sezione FAQ DEL CIRCOLO sopra — quelle le hai già, rispondi direttamente.
  Il messaggio deve dire che verifichi con il circolo e che farai sapere presto. NON usare NONE quando non sai rispondere a una domanda specifica — usa FAQ_REQUEST.
  ✅ Esempi di domande che RICHIEDONO FAQ_REQUEST (non inventare la risposta): "c'è l'assicurazione infortuni?", "avete tornei?", "si possono portare ospiti esterni?", "qual è il regolamento specifico del club?", "fate abbonamenti?", "avete docce/spogliatoi?", qualsiasi domanda su polizze, eventi speciali, regole interne, servizi non menzionati sopra.`}

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
- MAI usare il trattino "–" o "-" nei messaggi. Sostituisci sempre con una virgola, un punto o una nuova frase.

═══ REGOLA EMOJI ═══
- Usa emoji con parsimonia: max 1-2 per risposta, mai di più
- MAI iniziare un messaggio con un'emoji
- Ogni emoji termina naturalmente un pensiero: il sistema divide il tuo testo in bolle separate ogni volta che incontra un'emoji. Scrivi quindi: [pensiero] 🎾 [nuovo pensiero separato]. L'emoji chiude la bolla precedente.
`;

    const rawHistory = recentMessages.slice(-15);

    // Merge consecutive same-role messages to avoid Anthropic 400 "roles must alternate".
    // This happens when a debounced batch saves N user messages individually to DB,
    // then they all appear back-to-back in recentMessages.
    const mergedHistory: { role: string; content: string }[] = [];
    for (const msg of rawHistory) {
        const last = mergedHistory[mergedHistory.length - 1];
        if (last && last.role === msg.role) {
            last.content += '\n' + msg.content;
        } else {
            mergedHistory.push({ role: msg.role, content: msg.content });
        }
    }
    // Drop trailing user message — userMessage (combined batch text) already supersedes it.
    if (mergedHistory.length > 0 && mergedHistory[mergedHistory.length - 1].role === 'user') {
        mergedHistory.pop();
    }

    const historyMessages = mergedHistory.map(m => ({
        role: (m.role === 'USER' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.role === 'BOT'
            ? JSON.stringify({ message: m.content, action: 'NONE', params: {} })
            : m.content,
    }));

    function extractBrainJson(text: string) {
        const start = text.indexOf('{');
        let end = -1;
        if (start !== -1) {
            let depth = 0;
            for (let i = start; i < text.length; i++) {
                if (text[i] === '{') depth++;
                else if (text[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
            }
        }
        if (start === -1 || end === -1) return null;
        try {
            const parsed = JSON.parse(text.substring(start, end + 1));
            return {
                message: String(parsed.message || '...'),
                action: (parsed.action || 'NONE') as BrainAction,
                params: parsed.params || {},
            };
        } catch { return null; }
    }

    // Prefill: iniziare il turno assistant con '{"' forza Claude a continuare
    // esclusivamente con JSON — tecnica più affidabile per format enforcement.
    const PREFILL = '{"';

    function parseWithPrefill(raw: string): ReturnType<typeof extractBrainJson> {
        return extractBrainJson(PREFILL + raw);
    }

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            temperature: 0.4,
            system: systemPrompt,
            messages: [
                ...historyMessages,
                { role: 'user', content: userMessage },
                { role: 'assistant', content: PREFILL },
            ],
        });

        const content = response.content[0];
        if (content.type === 'text') {
            const result = parseWithPrefill(content.text);
            if (result) return result;

            // Prefill non è bastato (risposta malformata) — retry a temperatura minima
            logger.warn({ rawText: content.text.slice(0, 200) }, 'Brain: prefill JSON malformed — retrying at temp=0');
            try {
                const retry = await anthropic.messages.create({
                    model: 'claude-sonnet-4-6',
                    max_tokens: 1024,
                    temperature: 0,
                    system: systemPrompt,
                    messages: [
                        ...historyMessages,
                        { role: 'user', content: userMessage },
                        { role: 'assistant', content: PREFILL },
                    ],
                });
                const rc = retry.content[0];
                if (rc.type === 'text') {
                    const retryResult = parseWithPrefill(rc.text);
                    if (retryResult) return retryResult;
                    logger.error({ rawText: rc.text.slice(0, 200) }, 'Brain: retry also failed to produce JSON');
                }
            } catch (retryErr: any) {
                logger.error({ err: retryErr?.message }, 'Brain retry failed');
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
    phoneNumber?: string,
): Promise<{ success: boolean; errorMessage?: string; matchId?: string; requestedTime?: Date }> {
    if (action === 'NONE') return { success: true };

    if (action === 'REGISTER_PLAYER') {
        const name = (params.name || '').trim();
        if (!name || !name.includes(' ')) return { success: true }; // nome incompleto, continua conversazione
        if (!club?.id || !phoneNumber) return { success: true };
        const { inferGender } = await import('./ai');
        const firstName = name.split(' ')[0];
        const gender = await inferGender(firstName).catch(() => 'UNKNOWN' as const);
        await prisma.player.create({
            data: {
                phoneNumber: phoneNumber.replace(/\D/g, ''),
                name,
                clubId: club.id,
                skillLevel: -1,
                gender,
                active: true,
            },
        });
        if (club.adminPhone) {
            const { notifyAdmin } = await import('../utils/notify-admin');
            notifyAdmin(`🆕 Nuovo giocatore registrato: ${name} (${phoneNumber})`).catch(() => {});
        }
        return { success: true };
    }

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

            // 2. Controlla quanti giocatori rimangono nel vecchio match
            const oldMatch = await prisma.match.findUnique({
                where: { id: mp.matchId },
                include: { MatchPlayer: { where: { leftAt: null } } },
            });
            const remainingPlayers = oldMatch?.MatchPlayer.length ?? 0;

            if (remainingPlayers === 0) {
                // Nessun giocatore rimasto → cancella il match per liberare il campo
                await prisma.match.update({
                    where: { id: mp.matchId },
                    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: 'RESCHEDULED' },
                });
            } else if (oldMatch?.status === 'LOCKED') {
                // Match LOCKED con giocatori rimasti → riapri e rilancia wave
                await prisma.match.update({ where: { id: mp.matchId }, data: { status: 'OPEN' } });
                await waveQueue.add('process-wave', {
                    matchId: mp.matchId,
                    waveNumber: 1,
                    urgencyMultiplier: 2,
                    scheduledAt: Date.now(),
                }, { delay: 0 });
            }

            // 3. Prenota nuovo slot
            return await bookSlotForPlayer(startTime, player, club, false, null);
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

            const preferMixed = params.preferMixed === true ? true : params.preferMixed === false ? false : null;
            return await bookSlotForPlayer(startTime, player, club, params.preferCovered === true, preferMixed);
        }

        if (action === 'OPT_OUT') {
            await prisma.player.update({ where: { id: player.id }, data: { active: false } });
            return { success: true };
        }

        if (action === 'OPT_IN') {
            await prisma.player.update({ where: { id: player.id }, data: { active: true } });
            const { notifyAdmin } = await import('../utils/notify-admin');
            notifyAdmin(`✅ OPT_IN: ${player.name || player.id} ha richiesto di rientrare nella lista.`).catch(() => {});
            return { success: true };
        }

        if (action === 'INVITE_PREFERRED') {
            const preferred = await findPlayerFuzzy(params.playerName || '', player.clubId);
            if (!preferred) return { success: false, errorMessage: `PLAYER_NOT_FOUND:${params.playerName || ''}` };
            // Store as preferred player (no-op for now, matchmaker handles it)
            return { success: true };
        }

        if (action === 'FAQ_REQUEST') {
            const question = (params.question || '').trim();
            if (question && club?.id) {
                const redis = getRedis();
                await redis.set(
                    `faq:pending_question:${club.id}`,
                    JSON.stringify({ question, askedBy: player?.phoneNumber }),
                    'EX', 7 * 24 * 3600,
                );
                const { notifyAdmin } = await import('../utils/notify-admin');
                await notifyAdmin(
                    `❓ ${player?.name || player?.phoneNumber} ha chiesto:\n"${question}"\n\nRispondi qui per salvare la tua risposta come FAQ.`,
                    `faq_pending_${question.substring(0, 20)}`,
                    club?.adminPhone,
                    club?.name,
                ).catch(() => {});
            }
            return { success: true };
        }

        if (action === 'SAVE_NOTE') {
            if (!params.note || typeof params.note !== 'string') return { success: true };
            try {
                const note = params.note.trim();
                const existing = player.notes ? player.notes.trim() : '';
                const newNotes = existing ? `${existing}; ${note}` : note;

                // Rileva preferenze di fascia oraria dalla nota e aggiorna i flag strutturati
                const noteLower = note.toLowerCase();
                const preferenceFlags: Record<string, boolean> = {};
                const MORNING_PATTERNS = ['non gioc', 'mattina', 'mattino', 'al mattino', 'la mattina', 'presto', 'morning'];
                const AFTERNOON_PATTERNS = ['pomeriggio', 'sera', 'afternoon', 'evening', 'dopo pranzo', 'after'];

                const mentionsMorning = MORNING_PATTERNS.some(p => noteLower.includes(p));
                const mentionsAfternoon = AFTERNOON_PATTERNS.some(p => noteLower.includes(p));
                const mentionsAvoid = ['evit', 'non vuol', 'non piac', 'non può', 'non riesc', 'problema', 'difficolt', 'preferisce non'].some(p => noteLower.includes(p));

                if (mentionsMorning && mentionsAvoid) preferenceFlags.avoidMorning = true;
                if (mentionsAfternoon && mentionsAvoid) preferenceFlags.avoidAfternoon = true;
                // Preferisce solo mattina → implica avoid afternoon
                if (mentionsMorning && ['prefer', 'solo', 'solament', 'meglio', 'tipicament', 'di solito'].some(p => noteLower.includes(p)) && !mentionsAfternoon) {
                    preferenceFlags.avoidAfternoon = true;
                }
                // Preferisce solo pomeriggio/sera → implica avoid morning
                if (mentionsAfternoon && ['prefer', 'solo', 'solament', 'meglio', 'tipicament', 'di solito'].some(p => noteLower.includes(p)) && !mentionsMorning) {
                    preferenceFlags.avoidMorning = true;
                }

                await prisma.player.update({
                    where: { id: player.id },
                    data: { notes: newNotes, ...preferenceFlags },
                });

                if (Object.keys(preferenceFlags).length > 0) {
                    logger.info({ playerId: player.id, preferenceFlags }, 'SAVE_NOTE: updated time preference flags');
                }
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

function levenshtein(a: string, b: string): number {
    const dp: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
        Array.from({ length: b.length + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0),
    );
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            dp[i][j] = a[i - 1] === b[j - 1]
                ? dp[i - 1][j - 1]
                : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
        }
    }
    return dp[a.length][b.length];
}

async function findPlayerFuzzy(name: string, clubId: string): Promise<any | null> {
    if (!name || !clubId) return null;

    // Prima prova: contains esatto (case-insensitive)
    const exact = await prisma.player.findFirst({
        where: { clubId, name: { contains: name, mode: 'insensitive' } },
    });
    if (exact) return exact;

    // Seconda prova: fuzzy su tutti i giocatori attivi (Levenshtein per cognome)
    const all = await prisma.player.findMany({
        where: { clubId, active: true },
        select: { id: true, name: true, phoneNumber: true },
    });

    const nameLower = name.toLowerCase().trim();
    const targetSurname = nameLower.split(' ').pop() || nameLower;

    let bestMatch: any = null;
    let bestDistance = Infinity;

    for (const p of all) {
        if (!p.name) continue;
        const pLower = p.name.toLowerCase();
        const pSurname = pLower.split(' ').pop() || pLower;

        const surnameDist = levenshtein(targetSurname, pSurname);
        if (surnameDist <= 2 && surnameDist < bestDistance) {
            bestDistance = surnameDist;
            bestMatch = p;
        }

        const fullDist = levenshtein(nameLower, pLower);
        if (fullDist <= 2 && fullDist < bestDistance) {
            bestDistance = fullDist;
            bestMatch = p;
        }
    }

    return bestMatch;
}

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
    preferMixed: boolean | null = null,
): Promise<{ success: boolean; errorMessage?: string; matchId?: string }> {
    // Valida che ci siano almeno 90 minuti prima della chiusura e dopo l'apertura
    if (club?.openTime || club?.closeTime) {
        const romeHM = (d: Date) => {
            const s = d.toLocaleString('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false });
            const [h, m] = s.split(':').map(Number);
            return h * 60 + m;
        };
        const startMinutes = romeHM(startTime);
        const [openH, openM] = (club.openTime || '08:00').split(':').map(Number);
        const [closeH, closeM] = (club.closeTime || '23:30').split(':').map(Number);
        const openMinutes = openH * 60 + openM;
        const closeMinutes = closeH * 60 + closeM;
        if (startMinutes < openMinutes) {
            return { success: false, errorMessage: `Il circolo apre alle ${club.openTime || '08:00'}.` };
        }
        if (startMinutes + 90 > closeMinutes) {
            const lastValid = `${String(Math.floor((closeMinutes - 90) / 60)).padStart(2, '0')}:${String((closeMinutes - 90) % 60).padStart(2, '0')}`;
            return { success: false, errorMessage: `L'ultimo orario disponibile è alle ${lastValid} (servono 90 minuti prima della chiusura alle ${club.closeTime || '23:30'}).` };
        }
    }

    // Cerca match aperto compatibile nella finestra ±30min
    const from = new Date(startTime.getTime() - 30 * 60 * 1000);
    const to = new Date(startTime.getTime() + 30 * 60 * 1000);

    // Fix #6: impedisci doppia prenotazione nella stessa fascia oraria
    const alreadyBooked = await prisma.matchPlayer.findFirst({
        where: {
            playerId: player.id,
            leftAt: null,
            match: {
                status: { in: ['OPEN', 'LOCKED'] },
                startTime: { gte: from, lte: to },
            },
        },
    });
    if (alreadyBooked) {
        return { success: false, errorMessage: 'Hai già una prenotazione in quella fascia oraria.' };
    }

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

    return await createNewMatchAction(startTime, player, club, preferCovered, preferMixed);
}

async function createNewMatchAction(
    startTime: Date,
    player: any,
    club: any,
    preferCovered: boolean = false,
    preferMixed: boolean | null = null,
): Promise<{ success: boolean; errorMessage?: string; matchId?: string; requestedTime?: Date }> {
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

    if (!freeCourt) return { success: false, errorMessage: 'ALL_COURTS_TAKEN', requestedTime: startTime };

    // Fix #4: se l'utente NON ha richiesto il coperto ma l'unico campo libero è coperto, chiedi conferma
    if (!preferCovered && freeCourt.isCovered) {
        const scopertoCount = await prisma.court.count({
            where: { clubId: player.clubId, active: true, isCovered: false },
        });
        if (scopertoCount > 0) {
            // Ci sono campi scoperti nel circolo, ma sono tutti occupati a quell'orario
            return { success: false, errorMessage: 'ONLY_COVERED_AVAILABLE', requestedTime: startTime };
        }
    }

    const skillLevel = player.skillLevel > 0 ? player.skillLevel : 1.0;

    const isPrivateBooking = player.skillLevel <= 0;

    const match = await prisma.match.create({
        data: {
            clubId: player.clubId,
            courtId: freeCourt.id,
            startTime,
            skillLevel,
            isMixed: preferMixed === true,
            allowMixedLevels: club?.allowMixedLevels ?? false,
            playersNeeded: 4,
            status: 'OPEN',
            isPrivateBooking,
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
