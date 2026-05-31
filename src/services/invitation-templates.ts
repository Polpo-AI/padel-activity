/**
 * MESSAGGI DI RECRUITING — template random (Punto 6)
 *
 * L'invito è il messaggio a volume più alto del prodotto (ogni wave × ogni invitato).
 * Per questo NON è AI-generated: assembliamo varianti hardcoded per slot → centinaia
 * di combinazioni naturali, a costo API zero e qualità controllata.
 *
 * Onestà sul livello: il waving filtra i candidati nella banda di livello della partita
 * (scoring.ts: match.skill ± matchLowerRange/matchUpperRange). Quindi quando ci sono già
 * giocatori segnati, "in linea col tuo livello" è sempre vero per costruzione.
 *
 * Regole stile (CLAUDE.md): mai iniziare con un'emoji, al massimo una emoji a fine frase.
 */

const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

// {name} {partita} {quando}  — la partita include già il tipo ("una partita mista" / "una partita")
const openers = [
  "Ciao {name}! Ti va {partita} {quando}?",
  "Ehi {name}, ti andrebbe di giocare {quando}? Sto mettendo su {partita}.",
  "Ciao {name}! {quando} organizzo {partita}, ci sei?",
  "Ehi {name}! Cerco qualcuno per {partita} {quando}.",
  "Ciao {name}, {quando} si gioca: ti va {partita}?",
  "Ehi {name}! Hai voglia di {partita} {quando}?",
  "Ciao {name}! Ti aspetto {quando} per {partita}?",
  "{name}, ci stai per {partita} {quando}?",
  "Ehi {name}, butto lì {partita} {quando}: ti interessa?",
  "Ciao {name}! Pensavo a te per {partita} {quando}.",
  "Ehi {name}! {quando} c'è {partita}, ti va di esserci?",
  "Ciao {name}, ti tiro dentro per {partita} {quando}?",
  "{name}! Ti va di scendere in campo {quando}? Sto organizzando {partita}.",
  "Ehi {name}, una sfida {quando}? Sto organizzando {partita}.",
];

// Clausola "social proof + livello" per N≥1 — singolare/plurale gestiti separatamente.
function socialClause(n: number): string {
  if (n === 1) {
    return pick([
      `C'è già 1 giocatore segnato in linea col tuo livello, viene fuori una bella partita.`,
      `C'è già 1 persona del tuo livello, manca poco a chiudere.`,
      `Ho già 1 giocatore confermato del tuo livello, serve solo completare.`,
      `C'è 1 giocatore del tuo livello che aspetta solo di chiudere la squadra.`,
      `Già 1 confermato in linea con te, esce proprio un bel match.`,
      `C'è già 1 giocatore segnato, sul tuo livello.`,
    ]);
  }
  const gioc = `${n} giocatori`;
  return pick([
    `Ci sono già ${gioc} segnati in linea col tuo livello, viene fuori una bella partita.`,
    `Siete già in ${gioc} dello stesso livello, manca poco a chiudere.`,
    `Ho già ${gioc} confermati del tuo livello, serve solo completare.`,
    `Ci sono ${gioc} del tuo livello che aspettano solo di chiudere la squadra.`,
    `Già ${gioc} confermati in linea con te, esce proprio un bel match.`,
    `Sono già ${gioc} segnati, tutti sul tuo livello.`,
    `Ci sono già ${gioc} del tuo livello.`,
    `C'è già un bel gruppetto di ${gioc} del tuo livello.`,
  ]);
}

// Chiusura (a volte vuota per variare). Al massimo una emoji, a fine frase.
const closers = [
  "Fammi sapere!",
  "Ci stai? 🎾",
  "Che dici?",
  "Mi dici se ci sei?",
  "Esce una bella partita 🎾",
  "Sarebbe perfetta.",
  "Dai che si chiude!",
  "Ti aspetto!",
  "",
  "",
];

// N=0 → niente menzione giocatori, invito più semplice.
const closersSolo = [
  "Fammi sapere se ti va!",
  "Che ne dici?",
  "Ci stai? 🎾",
  "Vedi tu, nessun problema se non puoi.",
  "Se ti va ci sono.",
  "Dimmi se ti interessa!",
  "",
  "",
];

// Inviti via amico (isFriend) — il riferimento è "un amico ti ha invitato".
const friendTemplates = [
  "Ciao {name}! Un amico ti ha tirato dentro per {partita} {quando}. Ci sei? 🎾",
  "Ehi {name}! Un tuo amico ti vuole in campo {quando}, {partita}. Ti va?",
  "Ciao {name}, un amico ha fatto il tuo nome per {partita} {quando}. Sei della partita?",
  "Ehi {name}! Ti hanno invitato a {partita} {quando}. Ci stai?",
  "Ciao {name}! Un amico conta su di te per {partita} {quando}. Confermi?",
  "{name}, un amico ti aspetta {quando} per {partita}. Ci sei?",
  "Ehi {name}! Sei stato invitato da un amico per {partita} {quando}. Che dici?",
  "Ciao {name}! Un amico ti ha proposto per {partita} {quando}, fammi sapere se ci sei 🎾",
  "Ehi {name}, un amico ti vuole {quando} per {partita}. Ti unisci?",
  "Ciao {name}! Ti hanno chiamato per {partita} {quando}. Disponibile?",
];

function clean(s: string): string {
  let out = s
    .replace(/\s+/g, " ")
    .replace(/\s+([?!.,:])/g, "$1")
    .trim();
  // Maiuscola a inizio frase e dopo punteggiatura forte (gestisce "{quando}" minuscolo dopo "!").
  out = out.charAt(0).toUpperCase() + out.slice(1);
  out = out.replace(/([.!?])\s+([a-zàèéìòù])/g, (_m, p, c) => `${p} ${c.toUpperCase()}`);
  return out;
}

export interface InvitationParams {
  playerName: string;
  quando: string;   // es. "sabato alle 18:30"
  tipo: string;     // "mista" | "maschile" | "femminile" | ""
  confirmedCount: number;
  isFriend: boolean;
}

export function buildInvitation({ playerName, quando, tipo, confirmedCount, isFriend }: InvitationParams): string {
  const partita = tipo ? `una partita ${tipo}` : "una partita";
  const fill = (t: string) => t
    .replace(/\{name\}/g, playerName)
    .replace(/\{partita\}/g, partita)
    .replace(/\{quando\}/g, quando);

  if (isFriend) {
    return clean(fill(pick(friendTemplates)));
  }

  if (confirmedCount >= 1) {
    const parts = [fill(pick(openers)), socialClause(confirmedCount), pick(closers)];
    return clean(parts.join(" "));
  }

  // N=0
  return clean([fill(pick(openers)), pick(closersSolo)].join(" "));
}

// ─── Domanda racchetta (Punto 1) — inviata DOPO la card di conferma ──────────────

// Matchmaking: sì/no per il singolo giocatore.
export function racketQuestionSingle(): string {
  return pick([
    "Hai bisogno della racchetta o porti la tua?",
    "Ti serve il noleggio racchetta o usi la tua?",
    "Porti la racchetta o te ne serve una a noleggio?",
    "Una cosa veloce: racchetta tua o te ne serve una?",
    "Ti serve una racchetta a noleggio o ne hai una?",
    "Per la racchetta: la porti o ti serve il noleggio?",
    "Ah, ti serve una racchetta o sei a posto?",
    "Hai la tua racchetta o te ne procuro una?",
    "Giochi con la tua racchetta o ti serve a noleggio?",
    "Ultima cosa: racchetta tua o noleggio?",
  ]);
}

// Prenotazione privata: quante racchette per il gruppo.
export function racketQuestionCount(): string {
  return pick([
    "Quante racchette vi servono a noleggio? Se le portate, nessun problema.",
    "Per il noleggio: quante racchette servono al gruppo?",
    "Avete bisogno di racchette a noleggio? Se sì, quante?",
    "Quante racchette devo preparare per voi? (0 se le portate)",
    "Vi serve qualche racchetta a noleggio? Dimmi quante!",
    "Racchette: ne portate di vostre o ve ne servono? In caso, quante?",
    "Quante racchette a noleggio vi servono per la partita?",
    "Dovete noleggiare racchette? Fammi sapere quante!",
  ]);
}
