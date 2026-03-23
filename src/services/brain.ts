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
                take: 5,
            });
        }
    }

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
    const { club, player, isAdmin, recentMessages, pendingInvitations, confirmedMatches, availableMatches, courts, faqs } = context;

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
                const perPerson = (v: number) => (v * 1.5 / 4).toFixed(0);
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
                const perPerson = (maxSpecial * 1.5 / 4).toFixed(0);
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

    const next7days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(nowDate.getTime() + i * 24 * 60 * 60 * 1000);
        return d.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric', month: 'numeric' });
    }).join(', ');

    const systemPrompt = `Ti chiami ${botName} e sei l'assistente virtuale del circolo padel "${club?.name || 'Padel Club'}".
Tono: ${toneDescription}
Presentati come ${botName}, assistente virtuale del circolo, se qualcuno ti chiede il tuo nome o in apertura di conversazione con nuovi contatti. Sei trasparente sul fatto di essere un assistente virtuale — se te lo chiedono esplicitamente, confermalo senza esitazione.
Usa SEMPRE il "tu" — mai il "voi" o il "lei". Es. "ti trovi bene", "puoi prenotare", "sei dentro" — mai "vi trovate", "potete", "siete".
Oggi è: ${now}
Prossimi 7 giorni: ${next7days}
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
Gestisci prenotazioni campi e partite del circolo. Puoi rispondere a qualsiasi domanda sulla vita del circolo in modo naturale.
Se non sai qualcosa di specifico, dì che verifichi e fai sapere, oppure rimanda al contatto diretto col circolo.
NON devi mai dire "errore tecnico" o cose simili — se non puoi fare qualcosa, spiegalo in modo umano e naturale.

═══ COME FUNZIONA IL CIRCOLO ═══
- Il padel è 2 vs 2 (4 giocatori totale per campo)
- Ogni giocatore si iscrive individualmente — il sistema abbina le persone per livello e disponibilità
- Per ricevere inviti alle partite serve uno Skill Test: una valutazione informale con il maestro per capire il livello di gioco. La contatteremo noi quando siamo pronti — nessuna fretta
- Nel frattempo, i giocatori possono sempre prenotare un campo in autonomia (anche senza skill test)
- Gli inviti arrivano via WhatsApp — basta rispondere sì o no
- Il sistema cerca automaticamente altri giocatori dello stesso livello per completare la partita

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
${player.skillLevel <= 0 ? 'NOTA: questo giocatore non ha ancora il livello. Può prenotare campi, ma non riceverà inviti automatici finché non completa lo Skill Test.' : ''}
${player.notes ? `Note/preferenze giocatore: ${player.notes}` : ''}
${lessonInfo ? `\n═══ LEZIONE INDIVIDUALE ═══\n${lessonInfo}\nIl maestro contatterà il giocatore per l'orario — il sistema invia solo la notifica.` : ''}`}

═══ CAMPI DEL CIRCOLO ═══
${courtsStr}
${faqsStr ? `\n═══ FAQ DEL CIRCOLO ═══\nQueste domande hanno già una risposta ufficiale del circolo. Se la domanda dell'utente corrisponde a una di queste, usa la risposta memorizzata (adattando il tono ma senza cambiare il contenuto):\n\n${faqsStr}` : ''}

${player ? `═══ INVITI IN ATTESA ═══
${invitationsStr}

═══ PARTITE CONFERMATE ═══
${confirmedStr}

═══ PARTITE APERTE DISPONIBILI ═══
${availableStr}` : ''}
${cardsStr ? `\n═══ CONTATTI RICEVUTI ═══\n${cardsStr}` : ''}

${!player ? `═══ AZIONI DISPONIBILI ═══
Rispondi SEMPRE con JSON valido: { "message": "...", "action": "NOME", "params": {...} }

- NONE — risposta conversazionale: info sul circolo, prezzi, come funziona, qualsiasi cosa che non richieda registrazione
- REGISTER_PLAYER — params: { "name": "Nome Cognome" } — registra il nuovo giocatore. Usa SOLO quando hai nome E cognome certi. Il messaggio deve essere un breve benvenuto caldo nel circolo e spiegare che può già prenotare campi e che verranno contattati per lo Skill Test.` : `═══ AZIONI DISPONIBILI ═══
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
- OPT_OUT — params: {} — utente non vuole più messaggi / vuole essere rimosso dalla lista
- OPT_IN — params: {} — utente vuole rientrare nella lista (es. "voglio ricominciare", "rimettimi dentro", "voglio ricevere partite di nuovo"). Usa solo se il giocatore risulta inattivo o lo chiede esplicitamente.
- INVITE_PREFERRED — params: { "playerName": "Nome Cognome" } — utente vuole che una persona specifica venga coinvolta nella partita tramite matchmaking.
  ⚠️ REGOLA CRITICA: se l'utente menziona persone per nome DURANTE la fase di prenotazione ("voglio giocare con Marco", "ci sono io, Luca e Sara") usa SEMPRE questa azione INVECE di BOOK_FIELD. Il sistema verificherà se esistono nel circolo — non puoi saperlo tu.
  ⛔ ECCEZIONE: se il giocatore ha GIÀ una partita confermata e menziona un amico/compagno che "viene con lui" o chiede "hai segnato il mio compagno?" — NON usare INVITE_PREFERRED. Il campo è già prenotato, chi portano è affar loro. Rispondi semplicemente che il campo è prenotato e possono venire in quanti vogliono (fino a 4 giocatori totali).
  MAI creare una partita con wave quando l'utente ha già indicato persone specifiche con cui vuole giocare.
- SAVE_NOTE — params: { "note": "..." } — utente esprime una preferenza, abitudine o richiesta speciale (es. "voglio sempre giocare al coperto", "preferisco il mattino", "non mi piace la terra rossa"). Riassumi in una frase breve e salva. Puoi combinare con NONE per rispondere anche in modo conversazionale — in quel caso usa SAVE_NOTE e metti la risposta nel campo "message".
- REQUEST_LESSON — params: { "day": "opzionale", "time": "opzionale" } — utente chiede di prenotare una lezione con il maestro. Rispondi con conferma che hai avvisato il maestro + durata + costo. Il maestro li contatterà per l'orario esatto.
- RESCHEDULE_MATCH — params: { "matchPlayerId": "...", "newDay": "YYYY-MM-DD o oggi/domani/lunedì/...", "newTime": "HH:MM" } — utente vuole spostare una partita confermata. Cancella quella vecchia e prenota il nuovo slot. Messaggio breve tipo "Fatto! Ho spostato la tua partita 🎾" — i dettagli arrivano subito dopo.
- FAQ_REQUEST — params: { "question": "testo esatto della domanda" } — usa SOLO quando l'utente fa una domanda sul circolo (orari speciali, regole particolari, eventi, iniziative) a cui NON puoi rispondere con le informazioni disponibili.
  ⛔ NON usare FAQ_REQUEST per: stato della partita, quante persone mancano, chi è già confermato — queste info sono nella sezione PARTITE CONFERMATE sopra, rispondi direttamente.
  ⛔ NON usare FAQ_REQUEST se la risposta è già nella sezione FAQ DEL CIRCOLO sopra — quelle le hai già, rispondi direttamente.
  Il messaggio deve dire che verifichi con il circolo e che farai sapere presto. NON usare NONE quando non sai rispondere a una domanda specifica — usa FAQ_REQUEST.`}

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

    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 800,
            temperature: 0.7,
            system: systemPrompt,
            messages: [
                ...mergedHistory.map(m => ({
                    role: (m.role === 'USER' ? 'user' : 'assistant') as 'user' | 'assistant',
                    content: m.content,
                })),
                { role: 'user', content: userMessage },
                { role: 'assistant', content: '{' },
            ],
        });

        const content = response.content[0];
        if (content.type === 'text') {
            const text = ('{' + content.text).trim();
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
            // Risposta AI senza JSON valido — logga per debug
            logger.warn({ rawText: text.slice(0, 300) }, 'Brain: no JSON in response — using fallback');
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
): Promise<{ success: boolean; errorMessage?: string; matchId?: string }> {
    if (action === 'NONE') return { success: true };

    if (action === 'REGISTER_PLAYER') {
        const name = (params.name || '').trim();
        if (!name || !name.includes(' ')) return { success: true }; // nome incompleto, continua conversazione
        if (!club?.id || !phoneNumber) return { success: true };
        await prisma.player.create({
            data: {
                phoneNumber: phoneNumber.replace(/\D/g, ''),
                name,
                clubId: club.id,
                skillLevel: 0,
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
