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
    | 'REGISTER_PLAYER'
    | 'OPEN_TO_MATCHMAKING'
    | 'SAVE_GENDER';

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
    const { getClubId } = await import('../utils/request-context');
    const currentClubId = getClubId() || process.env.CLUB_ID;
    const club = currentClubId
        ? await prisma.club.findUnique({ where: { id: currentClubId } })
        : await prisma.club.findFirst();

    const phoneVariants = [phoneNumber, '+' + phoneNumber, phoneNumber.replace(/^\+/, '')];
    const now_ = new Date();
    const in10Days_ = new Date(now_.getTime() + 10 * 24 * 60 * 60 * 1000);
    const since = new Date(now_.getTime() - 24 * 60 * 60 * 1000);

    // Parallelizza le query indipendenti
    const [player, recentMessages, courts, faqs, upcomingForAvail] = await Promise.all([
        prisma.player.findFirst({
            where: { phoneNumber: { in: phoneVariants }, clubId: club?.id },
        }),
        prisma.whatsAppMessage.findMany({
            where: { chatId: jid, timestamp: { gte: since } },
            orderBy: { timestamp: 'desc' },
            take: 30,
        }),
        prisma.court.findMany({
            where: { clubId: club?.id, active: true },
            include: { prices: true },
            orderBy: { name: 'asc' },
        }),
        club?.id ? prisma.faq.findMany({
            where: { clubId: club.id, answer: { not: null } },
            orderBy: { createdAt: 'desc' },
            take: 30,
        }) : Promise.resolve([]),
        prisma.match.findMany({
            where: {
                clubId: club?.id,
                status: { in: ['OPEN', 'LOCKED'] },
                startTime: { gte: now_, lte: in10Days_ },
            },
            select: { startTime: true, courtId: true, court: { select: { isCovered: true } } },
        }),
    ]);

    const isAdmin = !!(club?.adminPhone &&
        phoneNumber.replace(/\D/g, '') === club.adminPhone.replace(/\D/g, ''));

    let pendingInvitations: any[] = [];
    let confirmedMatches: any[] = [];
    let availableMatches: any[] = [];

    if (player) {
        // Parallelizza le query dipendenti dal player
        const skillMin = player.skillLevel > 0 ? player.skillLevel - (club?.matchLowerRange ?? 1.0) : 0;
        const skillMax = player.skillLevel > 0 ? player.skillLevel + (club?.matchUpperRange ?? 1.0) : 0;

        const [inv, conf, avail] = await Promise.all([
            prisma.invitation.findMany({
                where: { playerId: player.id, status: 'PENDING', match: { status: 'OPEN' } },
                include: { match: { include: { court: true, MatchPlayer: { where: { leftAt: null } } } } },
                orderBy: { sentAt: 'asc' },
            }),
            prisma.matchPlayer.findMany({
                where: { playerId: player.id, leftAt: null, noShow: false, match: { status: { in: ['OPEN', 'LOCKED'] } } },
                include: { match: { include: { court: true, MatchPlayer: { where: { leftAt: null } } } } },
            }),
            player.skillLevel > 0 ? prisma.match.findMany({
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
            }) : Promise.resolve([]),
        ]);

        pendingInvitations = inv;
        confirmedMatches = conf;
        availableMatches = avail;

        // Ordina per completezza decrescente (quasi piene prima = migliori per redirect)
        availableMatches.sort((a: any, b: any) => {
            const spotsA = a.playersNeeded - a.MatchPlayer.length;
            const spotsB = b.playersNeeded - b.MatchPlayer.length;
            return spotsA - spotsB;
        });
    }

    // Slot availability: compute full/only-covered slots (next 10 days) + free scoperto slots (next 7 days)
    const scopertoCourtIds = courts.filter((c: any) => !c.isCovered).map((c: any) => c.id) as string[];

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
            const courtType = mp.match.court?.isCovered ? '🏟️ coperto' : '☀️ scoperto';
            return `  - ${mp.match.court?.name || 'Campo'} (${courtType}) – ${fmtDatetime(mp.match.startTime)} – ${statusLabel} [matchPlayerId:${mp.id}]`;
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
- Prenotare un campo funziona in due modi:
  a) Prenotazione privata: il campo è tutto tuo (per te e i tuoi amici, fino a 4 totali). Nessun abbinamento automatico. Funziona sempre, anche prima dello Skill Test.
  b) Matchmaking: il sistema cerca altri 3 giocatori compatibili per livello e li invita via WhatsApp. Richiede lo Skill Test completato.
- Lo Skill Test è una valutazione col maestro che assegna il tuo livello di gioco. Il circolo ti contatta per organizzarlo. Prima del test puoi già prenotare il campo privatamente.
- Quando la partita si riempie (4 confermati nel matchmaking): viene creato un gruppo WhatsApp con tutti i giocatori.
- Si può cancellare la propria partecipazione rispondendo al bot — il posto torna disponibile per altri.
- Per portare un amico specifico nel matchmaking: basta dirlo al bot, che verifica se è iscritto al circolo e lo invita prioritariamente.

${!player ? `═══ UTENTE NON REGISTRATO ═══
Questa persona non è ancora iscritta al circolo.
Raccogliere nome e cognome è la tua priorità, ma in modo completamente naturale.
- Rispondi PRIMA a qualsiasi cosa chieda (prezzi, campi, orari, come funziona — tutto)
- Presentati come ${botName} se è uno dei primi scambi della conversazione
- Chiedi nome e cognome solo quando è naturale, MAI in modo burocratico
- Se l'utente vuole prenotare un campo ma non si è ancora presentato: digli che per prenotare hai bisogno di nome e cognome, in modo naturale (es. "Per procedere con la prenotazione ho bisogno di registrarti — come ti chiami?")
- Quando hai ENTRAMBI nome E cognome certi → usa REGISTER_PLAYER
- Se hai solo il nome → rispondi e chiedi il cognome con leggerezza
- MAI usare REGISTER_PLAYER senza avere sia nome che cognome certi` : `═══ STATO GIOCATORE ═══
Nome: ${player.name || 'non registrato'}
Genere: ${player.gender === 'MALE' ? 'uomo' : player.gender === 'FEMALE' ? 'donna' : 'SCONOSCIUTO — chiedi prima di fare matchmaking (vedi regola sotto)'}
Livello: ${player.skillLevel > 0 ? player.skillLevel + ' (scala 1-7, dove 1=principiante, 7=agonista)' : 'da assegnare — Skill Test in attesa'}
${player.skillLevel <= 0 ? `NOTA SKILL TEST: questo giocatore NON ha ancora completato lo Skill Test.
- PUÒ prenotare il campo privatamente (private: true) — per sé e i suoi amici, fino a 4 totali. Funziona SEMPRE.
- NON può fare matchmaking (private: false) — il sistema non può abbinarlo con sconosciuti senza livello assegnato.
- Se parla di "giocare con qualcuno" o "trovare avversari": spiegagli che per quello serve lo Skill Test, il circolo organizzerà appena possibile. Poi chiedi se vuole comunque prenotare il campo privatamente.
- Per BOOK_FIELD → usa SEMPRE private: true. NON usare mai private: false per questo giocatore.` : ''}
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
- REGISTER_PLAYER — params: { "name": "Nome Cognome" } — registra il nuovo giocatore. Usa SOLO quando hai nome E cognome certi. Il messaggio deve essere un breve benvenuto caldo, e se l'utente aveva espresso l'intenzione di prenotare, chiudi con un invito esplicito a farlo ora (es. "Sei dentro! Vuoi che prenoti subito il campo?").
  ⛔ MAI descrivere dettagli del campo o promettere uno slot specifico nel messaggio di REGISTER_PLAYER — quelli arrivano dopo. L'invito deve essere generico e aperto.
  Quando hai solo il nome e chiedi il cognome, usa una frase naturale e diretta come: "Mi diresti anche il cognome? Così ti salvo e ti contatto se esce qualche partita interessante." — breve, senza aggiunte o domande retoriche.` : `═══ AZIONI DISPONIBILI ═══
Rispondi SEMPRE con JSON valido: { "message": "...", "action": "NOME", "params": {...} }

- NONE — risposta conversazionale, nessuna operazione DB. Usa per saluti, domande, info, ringraziamenti, qualsiasi cosa non richieda un'azione specifica
- ACCEPT_INVITATION — params: { "invitationId": "..." } — utente conferma presenza a partita
- REJECT_INVITATION — params: { "invitationId": "..." } — utente declina partita
- CANCEL_MATCH — params: { "matchPlayerId": "..." } — utente vuole annullare partecipazione confermata. ⚠️ matchPlayerId DEVE essere copiato esattamente dal tag [matchPlayerId:...] in PARTITE CONFERMATE. Se non trovi NESSUNA partita confermata → NONE e chiedi quale partita vuole cancellare.
- BOOK_FIELD — params: { "day": "YYYY-MM-DD o oggi/domani/lunedì/martedì/...", "time": "HH:MM", "joinMatchId": "id o null", "preferCovered": false, "preferMixed": null, "private": null, "committedPlayers": null }
  committedPlayers: se l'utente dice "siamo in 2/3/..., cerco N" → numero di giocatori fisici GIÀ confermati incluso il player stesso. Es. "siamo in 3, mi manca 1" → committedPlayers: 3. Default: null (solo il player). Si usa solo con private: false (matchmaking).
  Usa quando l'utente vuole giocare/prenotare e ha fornito giorno + orario.
  preferCovered: true SOLO se l'utente lo chiede esplicitamente (es. "campo al coperto", "al chiuso"). Default: false (scoperto preferito).
  private: indica l'intento dell'utente — prenotazione privata o matchmaking.
    - private: true → prenotazione privata: il campo è riservato, nessun abbinamento automatico. Funziona SEMPRE, anche senza Skill Test.
    - private: false → matchmaking: il sistema cerca altri 3 giocatori compatibili e li invita. ⚠️ Richiede Skill Test completato (skill > 0). Se skill ≤ 0 → NON usare private: false; spiega che serve prima lo Skill Test e offri la prenotazione privata.
    - private: null → intento non chiaro: usa NONE e chiedi "Vuoi prenotare il campo solo per te (o con i tuoi amici), oppure preferisci che ti cerchiamo degli avversari?"
  ⚠️ NON chiedere se l'intento è già chiaro dal contesto:
    - "campo solo per noi", "prenota per me e i miei amici", "veniamo in 4", "campo privato" → private: true
    - "voglio giocare con qualcuno", "cercatemi degli avversari", "trovami altri giocatori", "partita aperta" → private: false
    - Skill test pendente (skill ≤ 0) → sempre private: true, senza chiedere
  preferMixed: true se accetta match misto (maschi e femmine insieme), false se preferisce solo stesso sesso, null se non ha ancora espresso preferenza.
  ⚠️ REGOLA GENERE SCONOSCIUTO: se Genere è SCONOSCIUTO e private è false (matchmaking) → NON procedere con BOOK_FIELD. Prima usa NONE e chiedi: "Essendo un assistente digitale non vorrei sbagliarmi — sei un uomo o una donna? 😊" Poi al turno successivo usa SAVE_GENDER con il genere indicato, e SOLO dopo procedi con BOOK_FIELD.
  ⚠️ REGOLA MISTO: si applica SOLO quando private: false (matchmaking) E Genere NON è SCONOSCIUTO. Se preferMixed è null e private è false, prima chiedi con NONE: "Preferisci un match solo con giocatori del tuo stesso sesso o va bene anche misto?" Poi al turno successivo usa BOOK_FIELD con preferMixed impostato. Se private: true → salta la domanda (usa preferMixed: null).
  Se manca l'orario → NONE e chiedi solo quello.
  Se c'è una partita aperta compatibile (da "PARTITE APERTE DISPONIBILI") e l'utente vuole matchmaking (private: false) → usa joinMatchId.
  ⚠️ REDIRECT: se l'orario richiesto è in fullSlots O il sistema ha appena risposto "tutti i campi occupati" → NON creare nuovo BOOK_FIELD senza joinMatchId. Prima proponi le "PARTITE APERTE DISPONIBILI" (le più complete, con meno posti liberi). Se l'utente sceglie una → BOOK_FIELD con joinMatchId. Se non vuole nessuna → suggerisci slot da freeScopertoSlots per nuova pending.
  Messaggio nel JSON per BOOK_FIELD (private: false, nuova partita): "Perfetto, sto cercando gli altri giocatori — ti scrivo nel gruppo quando siamo in 4. 🎾" NON menzionare mai il nome del campo, il tipo (coperto/scoperto) o altri dettagli.
  Messaggio per BOOK_FIELD (private: true): "Perfetto, prenoto subito! 🎾" — i dettagli li manda il sistema.
  Messaggio per BOOK_FIELD con joinMatchId: "Perfetto, ti aggiungo! 🎾" (breve, il sistema gestisce il resto).
  ⚠️ ATTENZIONE: se il giocatore ha già partite confermate E chiede un nuovo slot, valuta se è una correzione o un'aggiunta (vedi regola RESCHEDULE sotto).
- OPT_OUT — params: {} — utente non vuole più messaggi / vuole essere rimosso dalla lista
- OPT_IN — params: {} — utente vuole rientrare nella lista (es. "voglio ricominciare", "rimettimi dentro", "voglio ricevere partite di nuovo"). Usa solo se il giocatore risulta inattivo o lo chiede esplicitamente.
- INVITE_PREFERRED — params: { "playerName": "Nome Cognome" } — utente vuole che una persona specifica venga coinvolta nella partita tramite matchmaking.
  ⚠️ REGOLA: usa SOLO se l'utente cita un NOME SPECIFICO (es. "voglio giocare con Marco", "ci sono io e Luca Rossi"). Il sistema verificherà se esistono nel circolo.
  ⛔ ECCEZIONE 1: se il giocatore ha GIÀ una partita confermata e menziona un amico che "viene con lui" — NON usare INVITE_PREFERRED. Il campo è già prenotato, chi portano è affar loro. Rispondi che possono venire in quanti vogliono (fino a 4 totali).
  ⛔ ECCEZIONE 2: se l'utente parla di "amici", "compagni" o "persone" in modo GENERICO (es. "vengo con degli amici", "siamo un gruppo", "veniamo in 4") SENZA nomi specifici → NON usare INVITE_PREFERRED. Usa BOOK_FIELD direttamente — il campo tiene fino a 4 giocatori e il sistema gestisce il resto.
  MAI creare una partita con wave quando l'utente ha già indicato persone specifiche con cui vuole giocare.
- SAVE_GENDER — params: { "gender": "MALE" | "FEMALE" } — utente rivela il proprio sesso. Usa SOLO dopo aver ricevuto una risposta esplicita alla domanda sul genere. Dopo il salvataggio, procedi normalmente con il flusso (es. chiedi preferMixed e poi BOOK_FIELD).
- SAVE_NOTE — params: { "note": "..." } — utente esprime una preferenza PERMANENTE o abitudine generale (es. "voglio *sempre* giocare al coperto", "di solito preferisco il mattino", "non mi piace la terra rossa"). Riassumi in una frase breve e salva. Puoi combinare con NONE per rispondere anche in modo conversazionale — in quel caso usa SAVE_NOTE e metti la risposta nel campo "message".
  ⚠️ NON usare SAVE_NOTE quando l'utente sta chiedendo qualcosa di specifico per la prenotazione in corso (es. "vorrei il coperto" in risposta a una prenotazione → usa BOOK_FIELD o RESCHEDULE_MATCH con preferCovered:true, NON SAVE_NOTE). SAVE_NOTE è solo per preferenze dichiarate in modo esplicito e generale, non per richieste contestuali.
- REQUEST_LESSON — params: { "day": "opzionale", "time": "opzionale" } — utente chiede di prenotare una lezione con il maestro. Rispondi con conferma che hai avvisato il maestro + durata + costo. Il maestro li contatterà per l'orario esatto.
- RESCHEDULE_MATCH — params: { "matchPlayerId": "...", "newDay": "YYYY-MM-DD o oggi/domani/lunedì/...", "newTime": "HH:MM", "preferCovered": true/false } — utente vuole spostare una partita confermata. Cancella quella vecchia e prenota il nuovo slot. Se l'utente chiede esplicitamente il coperto → preferCovered: true. ⚠️ matchPlayerId DEVE essere copiato esattamente dal tag [matchPlayerId:...] in PARTITE CONFERMATE. Se non trovi NESSUNA partita confermata → NONE e chiedi quale partita vuole spostare.
  ⚠️ MESSAGGIO per RESCHEDULE_MATCH: usa sempre una frase neutra che non conferma il risultato — il sistema verifica disponibilità DOPO il tuo messaggio. Esempi: "Perfetto, sposto subito 🎾" / "Un momento, verifico e sposto 🎾". MAI scrivere "Ho spostato", "fatto", "prenotato" o qualsiasi frase che presuppone il successo dell'operazione.
  ⚠️ CAMBIO CAMPO STESSO ORARIO: se l'utente ha già una prenotazione privata e vuole passare al coperto (o allo scoperto) alla STESSA ora → usa BOOK_FIELD con stesso day/time e preferCovered aggiornato (NON RESCHEDULE_MATCH). Il sistema gestisce automaticamente il cambio. Messaggio: "Vedo subito se c'è il campo coperto disponibile 🎾" oppure "Verifico la disponibilità del coperto 🎾" — MAI confermare il cambio prima di sapere se il campo è libero.
- FAQ_REQUEST — params: { "question": "testo esatto della domanda" } — usa SOLO quando l'utente fa una domanda sul circolo (orari speciali, regole particolari, eventi, iniziative) a cui NON puoi rispondere con le informazioni disponibili.
  ⛔ NON usare FAQ_REQUEST per: stato della partita, quante persone mancano, chi è già confermato — queste info sono nella sezione PARTITE CONFERMATE sopra, rispondi direttamente.
  ⛔ NON usare FAQ_REQUEST se la risposta è già nella sezione FAQ DEL CIRCOLO sopra — quelle le hai già, rispondi direttamente.
  Il messaggio deve dire che verifichi con il circolo e che farai sapere presto. NON usare NONE quando non sai rispondere a una domanda specifica — usa FAQ_REQUEST.
  ✅ Esempi di domande che RICHIEDONO FAQ_REQUEST (non inventare la risposta): "c'è l'assicurazione infortuni?", "avete tornei?", "si possono portare ospiti esterni?", "qual è il regolamento specifico del club?", "fate abbonamenti?", "avete docce/spogliatoi?", qualsiasi domanda su polizze, eventi speciali, regole interne, servizi non menzionati sopra.
- OPEN_TO_MATCHMAKING — params: { "alreadyCommitted": N } — utente ha già una prenotazione privata (LOCKED, isPrivateBooking=true) e vuole che il sistema cerchi altri giocatori per completare la partita.
  alreadyCommitted: numero di giocatori fisici già confermati incluso il player stesso. Se l'utente dice "siamo in 3, mi manca 1" → alreadyCommitted: 3. Se non specifica quanti sono → alreadyCommitted: 1 (solo il player registrato).
  ✅ Usa quando il giocatore ha GIÀ una partita confermata e dice: "mi manca qualcuno", "puoi cercarmi dei giocatori?", "trovami altri giocatori per questa partita", "apri al matchmaking", "siamo in X, ci manca Y".
  ⛔ MAI usare BOOK_FIELD in questi casi: il campo è già prenotato. OPEN_TO_MATCHMAKING converte la prenotazione esistente.
  Messaggio: usa sempre una frase che indica quanti ne stai cercando. Es. "Perfetto, cerco subito 1 giocatore per completare la partita 🎾" oppure "Cerco subito 2 giocatrici 🎾"`}

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

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 1024,
            temperature: 0.4,
            system: systemPrompt,
            messages: [
                ...historyMessages,
                { role: 'user', content: userMessage },
            ],
        });

        const content = response.content[0];
        if (content.type === 'text') {
            const result = extractBrainJson(content.text.trim());
            if (result) return result;

            // Nessun JSON trovato — retry a temperature=0 con enforcement esplicito
            logger.warn({ rawText: content.text.slice(0, 200) }, 'Brain: no JSON in response — retrying at temp=0');
            try {
                const retry = await anthropic.messages.create({
                    model: 'claude-sonnet-4-6',
                    max_tokens: 1024,
                    temperature: 0,
                    system: systemPrompt + '\n\n⚠️ FORMATO OBBLIGATORIO: la tua risposta deve essere ESCLUSIVAMENTE un oggetto JSON valido, senza nessun testo prima o dopo. Esempio esatto: {"message":"testo risposta","action":"NONE","params":{}}',
                    messages: [
                        ...historyMessages,
                        { role: 'user', content: userMessage },
                    ],
                });
                const rc = retry.content[0];
                if (rc.type === 'text') {
                    const retryResult = extractBrainJson(rc.text.trim());
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
        try {
            const { inferGender } = await import('./ai');
            const firstName = name.split(' ')[0];
            const gender = await inferGender(firstName).catch(() => 'UNKNOWN' as const);
            await prisma.player.create({
                data: {
                    phoneNumber: phoneNumber.replace(/\D/g, ''),
                    name,
                    clubId: club.id,
                    skillLevel: -1,
                    reliabilityScore: 0.33,
                    gender,
                    active: true,
                },
            });
            if (club.adminPhone) {
                const { notifyAdmin } = await import('../utils/notify-admin');
                notifyAdmin(`🆕 Nuovo giocatore registrato: ${name} (${phoneNumber})`).catch(() => {});
            }
            return { success: true };
        } catch (regErr: any) {
            // P2002 = unique constraint: player già registrato (race condition o doppio messaggio)
            if (regErr?.code === 'P2002') {
                logger.warn({ phoneNumber, clubId: club.id }, 'REGISTER_PLAYER: player already exists, treating as success');
                return { success: true };
            }
            logger.error({ regErr, phoneNumber }, 'REGISTER_PLAYER failed');
            return { success: false, errorMessage: 'Registrazione non riuscita. Riprova tra poco.' };
        }
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

            // Se LOCKED: messageHandler chiamerà handleMatchFilled — restituiamo matchId per segnalarlo
            const updatedMatch = await prisma.match.findUnique({ where: { id: inv.matchId }, select: { status: true } });
            return { success: true, matchId: updatedMatch?.status === 'LOCKED' ? inv.matchId : undefined };
        }

        if (action === 'REJECT_INVITATION') {
            await prisma.invitation.update({
                where: { id: params.invitationId },
                data: { status: 'REJECTED', respondedAt: new Date() },
            });
            return { success: true };
        }

        if (action === 'CANCEL_MATCH') {
            if (!params?.matchPlayerId || typeof params.matchPlayerId !== 'string') {
                return { success: false, errorMessage: 'Non riesco a identificare la partita. Quale partita vuoi cancellare?' };
            }
            const mp = await prisma.matchPlayer.findUnique({ where: { id: params.matchPlayerId } });
            if (!mp) return { success: false, errorMessage: 'Partecipazione non trovata.' };

            await prisma.matchPlayer.update({ where: { id: mp.id }, data: { leftAt: new Date() } });

            const match = await prisma.match.findUnique({ where: { id: mp.matchId } });
            if (match?.status === 'LOCKED') {
                if (match.isPrivateBooking) {
                    // Prenotazione privata: il campo era riservato per questo player → libera il slot
                    await prisma.match.update({
                        where: { id: mp.matchId },
                        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: 'PLAYER_CANCELLED' },
                    });
                } else {
                    // Matchmaking LOCKED: manca 1 giocatore → riapri e rilancia wave con urgenza
                    await prisma.match.update({ where: { id: mp.matchId }, data: { status: 'OPEN' } });
                    waveQueue.add('process-wave', {
                        matchId: mp.matchId,
                        waveNumber: 1,
                        urgencyMultiplier: 2,
                        scheduledAt: Date.now(),
                    }, { delay: 0 }).catch(err => logger.warn({ err, matchId: mp.matchId }, 'Wave scheduling failed'));
                }
            }

            const { decreaseReliability } = await import('./scoring');
            await decreaseReliability(player.id).catch(() => {});
            return { success: true };
        }

        if (action === 'RESCHEDULE_MATCH') {
            if (!params?.matchPlayerId || typeof params.matchPlayerId !== 'string') {
                return { success: false, errorMessage: 'Non riesco a identificare la partita. Quale partita vuoi spostare?' };
            }
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
            } else if (oldMatch?.status === 'LOCKED' && !oldMatch.isPrivateBooking) {
                // Matchmaking LOCKED con giocatori rimasti → riapri e rilancia wave
                await prisma.match.update({ where: { id: mp.matchId }, data: { status: 'OPEN' } });
                waveQueue.add('process-wave', {
                    matchId: mp.matchId,
                    waveNumber: 1,
                    urgencyMultiplier: 2,
                    scheduledAt: Date.now(),
                }, { delay: 0 }).catch(err => logger.warn({ err, matchId: mp.matchId }, 'Wave scheduling failed'));
            }

            // 3. Prenota nuovo slot — propaga la preferenza coperto/scoperto
            const preferCovered = params.preferCovered === true;
            return await bookSlotForPlayer(startTime, player, club, preferCovered, null);
        }

        if (action === 'REQUEST_LESSON') {
            const contactPhone = club?.adminAlternativePhone || club?.adminPhone;
            if (contactPhone) {
                const { simulateTypingAndSend } = await import('./whatsapp');
                const dayPart = params.day ? ` (richiesta: ${params.day}${params.time ? ' alle ' + params.time : ''})` : '';
                const msg = `🎾 Richiesta lezione da ${player.name || player.phoneNumber} (${player.phoneNumber})${dayPart}. Contattalo per confermare orario.`;
                simulateTypingAndSend(`${contactPhone}@s.whatsapp.net`, msg).catch(() => {});
            } else {
                logger.warn({ playerId: player.id, clubId: club?.id }, 'REQUEST_LESSON: nessun contatto configurato per il circolo');
                return { success: false, errorMessage: 'LESSON_NO_CONTACT' };
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
            // private: true = campo privato, false = matchmaking, null = decide createNewMatchAction in base a skillLevel (backward compat)
            const privateBooking: boolean | null = params.private === true ? true : params.private === false ? false : null;
            const committedPlayers = typeof params.committedPlayers === 'number'
                ? Math.max(1, Math.min(params.committedPlayers, 3)) : null;
            return await bookSlotForPlayer(startTime, player, club, params.preferCovered === true, preferMixed, privateBooking, committedPlayers);
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
            const playerName = (params.playerName || '').trim();
            if (!playerName) return { success: false, errorMessage: 'PLAYER_NOT_FOUND:' };
            const preferred = await findPlayerFuzzy(playerName, player.clubId);
            if (!preferred) return { success: false, errorMessage: `PLAYER_NOT_FOUND:${playerName}` };
            // Store as preferred player (no-op for now, matchmaker handles it)
            return { success: true };
        }

        if (action === 'FAQ_REQUEST') {
            const question = (params.question || '').trim();
            if (question && club?.id) {
                const redis = getRedis();
                const faqKey = `faq:pending_question:${club.id}`;
                // Salva in Redis — include playerJid per poter rispondere all'utente dopo
                // NON cancellare dopo l'invio: handleAdminFaqFlow dipende da questa chiave per
                // ricevere e inoltrare la risposta dell'admin all'utente originale.
                const { getContextStore } = await import('../utils/request-context');
                const playerJidFromCtx = getContextStore()?.jid;
                await redis.set(faqKey, JSON.stringify({
                    question,
                    askedBy: player?.name || player?.phoneNumber,
                    playerJid: playerJidFromCtx,
                }), 'EX', 7 * 24 * 3600);
                const { notifyAdmin } = await import('../utils/notify-admin');
                await notifyAdmin(
                    `❓ ${player?.name || player?.phoneNumber} ha chiesto:\n"${question}"\n\nRispondi qui per salvare la tua risposta come FAQ e inoltrarla all'utente.`,
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

        if (action === 'SAVE_GENDER') {
            const g = params?.gender;
            if (g !== 'MALE' && g !== 'FEMALE') return { success: true };
            try {
                await prisma.player.update({ where: { id: player.id }, data: { gender: g } });
                logger.info({ playerId: player.id, gender: g }, 'SAVE_GENDER: genere aggiornato');
            } catch (err) {
                logger.error({ err, playerId: player.id }, 'SAVE_GENDER failed silently');
            }
            return { success: true };
        }

        if (action === 'OPEN_TO_MATCHMAKING') {
            // Cancella la prenotazione privata esistente (LOCKED) e apre un nuovo match OPEN per il matchmaking.
            // params.alreadyCommitted: giocatori fisici già confermati (incluso il player stesso).
            // Es. "siamo in 3, cerco 1" → alreadyCommitted=3 → wave cerca solo 1 persona.
            const existingMp = await prisma.matchPlayer.findFirst({
                where: {
                    playerId: player.id,
                    leftAt: null,
                    match: { status: 'LOCKED', isPrivateBooking: true },
                },
                include: { match: true },
                orderBy: { joinedAt: 'desc' },
            });

            if (!existingMp) {
                return { success: false, errorMessage: 'Nessuna prenotazione privata attiva da convertire.' };
            }

            const alreadyCommitted = typeof params?.alreadyCommitted === 'number'
                ? Math.max(1, Math.min(params.alreadyCommitted, existingMp.match.playersNeeded - 1))
                : 1;

            const oldMatch = existingMp.match;

            // 1. Cancella il vecchio match privato
            await prisma.matchPlayer.update({ where: { id: existingMp.id }, data: { leftAt: new Date() } });
            await prisma.invitation.updateMany({
                where: { matchId: oldMatch.id, status: 'PENDING' },
                data: { status: 'IGNORED' },
            });
            await prisma.match.update({
                where: { id: oldMatch.id },
                data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: 'CONVERTED_TO_MATCHMAKING' },
            });

            // 2. Crea nuovo match OPEN sulla stessa corte e orario
            const newMatch = await prisma.match.create({
                data: {
                    clubId: oldMatch.clubId,
                    courtId: oldMatch.courtId,
                    startTime: oldMatch.startTime,
                    skillLevel: player.skillLevel > 0 ? player.skillLevel : 1.0,
                    isMixed: oldMatch.isMixed,
                    playersNeeded: oldMatch.playersNeeded,
                    status: 'OPEN',
                    isPrivateBooking: false,
                    committedPlayers: alreadyCommitted,
                },
            });

            // 3. Iscrivi il player al nuovo match
            await prisma.matchPlayer.create({ data: { matchId: newMatch.id, playerId: player.id } });
            await prisma.invitation.create({ data: { matchId: newMatch.id, playerId: player.id, status: 'ACCEPTED' } });

            // 4. Avvia la wave per trovare gli altri giocatori
            waveQueue.add('process-wave', {
                matchId: newMatch.id,
                waveNumber: 1,
                scheduledAt: Date.now(),
            }, { delay: 5000 }).catch(err => logger.warn({ err, matchId: newMatch.id }, 'OPEN_TO_MATCHMAKING wave scheduling failed'));

            logger.info({ oldMatchId: oldMatch.id, newMatchId: newMatch.id, alreadyCommitted }, 'OPEN_TO_MATCHMAKING: cancelled private booking, created new open matchmaking');

            return { success: true, matchId: newMatch.id };
        }
    } catch (err: any) {
        logger.error({ err, action, params }, 'executeAction failed');
        // Non esporre errori tecnici Prisma all'utente
        const isPrismaError = err?.code?.startsWith?.('P') || err?.name === 'PrismaClientKnownRequestError' || err?.name === 'PrismaClientUnknownRequestError' || err?.name === 'PrismaClientValidationError';
        const userMessage = isPrismaError ? 'Errore interno. Riprova tra poco.' : (err.message || 'Errore imprevisto.');
        return { success: false, errorMessage: userMessage };
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
    privateBooking: boolean | null = null,
    committedPlayers: number | null = null,
): Promise<{ success: boolean; errorMessage?: string; matchId?: string; requestedTime?: Date }> {
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
        include: { match: { include: { court: true } } },
    });
    if (alreadyBooked) {
        const existingMatch = alreadyBooked.match as any;
        const existingCovered = existingMatch?.court?.isCovered ?? false;

        // Court swap: stessa fascia oraria ma tipo campo diverso (scoperto ↔ coperto)
        // Tenta prima il nuovo booking; cancella il vecchio SOLO se riesce
        // → evita di lasciare l'utente senza prenotazione se il tipo richiesto è esaurito
        if (preferCovered !== existingCovered && existingMatch?.isPrivateBooking) {
            logger.info(
                { matchId: existingMatch.id, from: existingCovered ? 'coperto' : 'scoperto', to: preferCovered ? 'coperto' : 'scoperto' },
                'Court swap detected — trying new booking before cancelling old'
            );

            const newResult = await createNewMatchAction(startTime, player, club, preferCovered, preferMixed, privateBooking ?? true);

            if (newResult.success) {
                // Nuovo campo assegnato: ora cancella il vecchio booking
                await prisma.matchPlayer.update({
                    where: { id: alreadyBooked.id },
                    data: { leftAt: new Date() },
                });
                await prisma.match.update({
                    where: { id: existingMatch.id },
                    data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: 'COURT_SWAP' },
                });
            }
            // Se fallisce, il vecchio booking rimane intatto e l'errore va a messageHandler (che farà redirect)
            return newResult;
        }

        return { success: false, errorMessage: 'Hai già una prenotazione in quella fascia oraria.' };
    }

    // Matchmaking: cerca match aperto compatibile da joinare.
    // Solo se l'utente vuole matchmaking (privateBooking !== true) e ha skill assegnato.
    const wantsMatchmaking = privateBooking === false || (privateBooking === null && player.skillLevel > 0);
    if (wantsMatchmaking) {
        // Se vuole matchmaking ma skill non ancora assegnato → blocca
        if (player.skillLevel <= 0) {
            return { success: false, errorMessage: 'SKILL_TEST_REQUIRED' };
        }
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

        // Nessun OPEN match compatibile trovato: crea un nuovo OPEN match (privateBooking=false)
        // Il player ha skill > 0 e vuole matchmaking → il sistema trova gli altri 3 via wave.
        return await createNewMatchAction(startTime, player, club, preferCovered, preferMixed, false, committedPlayers);
    }

    return await createNewMatchAction(startTime, player, club, preferCovered, preferMixed, privateBooking, committedPlayers);
}

async function createNewMatchAction(
    startTime: Date,
    player: any,
    club: any,
    preferCovered: boolean = false,
    preferMixed: boolean | null = null,
    privateBooking: boolean | null = null,
    committedPlayers: number | null = null,
): Promise<{ success: boolean; errorMessage?: string; matchId?: string; requestedTime?: Date }> {
    // Carica tutti i match esistenti a questo startTime con i loro giocatori confermati
    const occupiedMatches = await prisma.match.findMany({
        where: { clubId: player.clubId, status: { in: ['OPEN', 'LOCKED'] }, startTime },
        include: { MatchPlayer: { where: { leftAt: null } } },
    });

    const allOccupied = occupiedMatches as any[];

    // Determina se questo è un BOOK_FIELD (prenotazione privata): private=true o skill<=0
    const isPrivateBookingIntent = privateBooking === true || (privateBooking === null && player.skillLevel <= 0);

    // Costruisci set di courtId "completamente occupati" (LOCKED o OPEN con ≥3 confermati):
    // questi non possono essere spostati
    const hardOccupiedIds = new Set<string>(
        allOccupied
            .filter((m: any) => m.status === 'LOCKED' || (m.MatchPlayer as any[]).length >= 3)
            .map((m: any) => m.courtId)
            .filter(Boolean)
    );

    // Costruisci set di courtId "morbidamente occupati" (OPEN con ≤2 confermati):
    // possono essere spostati (displacement) SOLO per BOOK_FIELD
    const softOccupied = allOccupied.filter((m: any) =>
        m.status === 'OPEN' && (m.MatchPlayer as any[]).length <= 2 && m.courtId
    );

    const allOccupiedIds = allOccupied.map((m: any) => m.courtId).filter(Boolean) as string[];

    // Prima cerca un campo veramente libero (non occupato da nessun match)
    const freeCourt = await prisma.court.findFirst({
        where: { clubId: player.clubId, active: true, id: { notIn: allOccupiedIds } },
        orderBy: preferCovered
            ? [{ isCovered: 'desc' }, { name: 'asc' }]
            : [{ isCovered: 'asc' }, { name: 'asc' }],
    });

    // Se non c'è un campo libero ma è BOOK_FIELD, proviamo il displacement
    let displacedMatchId: string | null = null;
    let displacedMatchData: any | null = null;
    let courtToUse = freeCourt;

    if (!freeCourt && isPrivateBookingIntent && softOccupied.length > 0) {
        // Trova il campo "morbidamente occupato" compatibile con la preferenza coperto/scoperto
        const courtIds = softOccupied.map((m: any) => m.courtId) as string[];
        const displacementCourt = await prisma.court.findFirst({
            where: { clubId: player.clubId, active: true, id: { in: courtIds } },
            orderBy: preferCovered
                ? [{ isCovered: 'desc' }, { name: 'asc' }]
                : [{ isCovered: 'asc' }, { name: 'asc' }],
        });
        if (displacementCourt) {
            // Trova il match da spostare
            const matchToDisplace = softOccupied.find((m: any) => m.courtId === displacementCourt.id);
            if (matchToDisplace) {
                displacedMatchId = matchToDisplace.id;
                displacedMatchData = matchToDisplace;
                courtToUse = displacementCourt;
            }
        }
    }

    // Usa courtToUse per la verifica (freeCourt o campo da displacement)
    const effectiveCourt = courtToUse;

    if (!effectiveCourt) return { success: false, errorMessage: 'ALL_COURTS_TAKEN', requestedTime: startTime };

    // Se l'utente NON ha richiesto il coperto ma l'unico campo libero è coperto, chiedi conferma
    if (!preferCovered && effectiveCourt.isCovered) {
        const scopertoCount = await prisma.court.count({
            where: { clubId: player.clubId, active: true, isCovered: false },
        });
        if (scopertoCount > 0) {
            return { success: false, errorMessage: 'ONLY_COVERED_AVAILABLE', requestedTime: startTime };
        }
    }

    // Check simmetrico: ha chiesto coperto ma l'unico campo libero è scoperto
    if (preferCovered && !effectiveCourt.isCovered) {
        const copertoCount = await prisma.court.count({
            where: { clubId: player.clubId, active: true, isCovered: true },
        });
        if (copertoCount > 0) {
            return { success: false, errorMessage: 'ONLY_UNCOVERED_AVAILABLE', requestedTime: startTime };
        }
    }

    const skillLevel = player.skillLevel > 0 ? player.skillLevel : 1.0;

    // isPrivateBooking: true se l'utente ha richiesto esplicitamente private, o se skill non ancora assegnato (null fallback).
    // privateBooking === false è già stato bloccato in bookSlotForPlayer se skill <= 0.
    const isPrivateBooking = privateBooking === true || (privateBooking === null && player.skillLevel <= 0);
    const initialStatus = isPrivateBooking ? 'LOCKED' : 'OPEN';

    // ── DISPLACEMENT: se stiamo usando un campo da un match OPEN ≤2, cancellalo prima ──
    // Fetch i dati dei giocatori coinvolti PRIMA di aggiornare il DB
    let displacedConfirmed: { id: string; phoneNumber: string; name: string | null; skillLevel: number }[] = [];
    let displacedPendingPhones: string[] = [];
    let displacedOriginalSkill = 0;

    if (displacedMatchId && displacedMatchData) {
        // Fetch confirmed players e pending invitations del match che stiamo spostando
        const fullDisplacedMatch = await prisma.match.findUnique({
            where: { id: displacedMatchId },
            include: {
                MatchPlayer: { where: { leftAt: null }, include: { player: true } },
                invitations: { where: { status: 'PENDING' }, include: { player: true } },
            },
        });

        if (fullDisplacedMatch) {
            displacedConfirmed = (fullDisplacedMatch.MatchPlayer as any[]).map((mp: any) => ({
                id: mp.player.id,
                phoneNumber: mp.player.phoneNumber,
                name: mp.player.name,
                skillLevel: mp.player.skillLevel,
            }));
            displacedPendingPhones = (fullDisplacedMatch.invitations as any[]).map((inv: any) => inv.player.phoneNumber);
            displacedOriginalSkill = (fullDisplacedMatch as any).skillLevel ?? 0;

            // Displacement DB sync (atomico):
            // 1. Segna tutti i MatchPlayer come usciti
            await prisma.matchPlayer.updateMany({
                where: { matchId: displacedMatchId, leftAt: null },
                data: { leftAt: new Date() },
            });
            // 2. Annulla le invitation PENDING
            await prisma.invitation.updateMany({
                where: { matchId: displacedMatchId, status: 'PENDING' },
                data: { status: 'IGNORED' },
            });
            // 3. Cancella il match con motivo DISPLACED_BY_BOOKING
            await prisma.match.update({
                where: { id: displacedMatchId },
                data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: 'DISPLACED_BY_BOOKING' },
            });

            logger.info({ displacedMatchId, courtId: effectiveCourt.id }, 'createNewMatchAction: displaced OPEN match for BOOK_FIELD');
        }
    }

    const match = await prisma.match.create({
        data: {
            clubId: player.clubId,
            courtId: effectiveCourt.id,
            startTime,
            skillLevel,
            isMixed: preferMixed === true,
            playersNeeded: 4,
            status: initialStatus,
            isPrivateBooking,
            committedPlayers: (!isPrivateBooking && committedPlayers && committedPlayers > 1) ? committedPlayers : 0,
        },
    });

    await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: player.id } });
    await prisma.invitation.create({ data: { matchId: match.id, playerId: player.id, status: 'ACCEPTED' } });

    // Wave per trovare gli altri 3 giocatori (solo se matchmaking — match OPEN)
    // Fire-and-forget: checkSilentMatches (ogni 30min) rilancia se Redis era down
    if (!isPrivateBooking) {
        const spotsNeeded = match.playersNeeded - 1; // sempre 3
        waveQueue.add('process-wave', {
            matchId: match.id,
            waveNumber: 1,
            limit: spotsNeeded,
        }, { delay: Math.floor(Math.random() * 60000) + 30000 }).catch(err =>
            logger.warn({ err, matchId: match.id }, 'Wave scheduling failed — checkSilentMatches riproverà')
        );
    }

    // ── Fire-and-forget: notifica i giocatori del match spostato (displacement) ──
    // Solo se c'è stato un displacement e ci sono giocatori da notificare
    if (displacedMatchId && (displacedConfirmed.length > 0 || displacedPendingPhones.length > 0)) {
        const { notifyDisplacedPlayers } = await import('./redirect');
        notifyDisplacedPlayers(
            displacedMatchId,
            displacedConfirmed,
            displacedPendingPhones,
            player.clubId,
            startTime,
            displacedOriginalSkill,
        ).catch(err => logger.warn({ err, displacedMatchId }, 'notifyDisplacedPlayers failed (fire-and-forget)'));
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
