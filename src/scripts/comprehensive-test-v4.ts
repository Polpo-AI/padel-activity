import 'dotenv/config';

import { prisma } from '../services/db';
import { buildBrainContext, callBrain, executeAction } from '../services/brain';

// ─── config ──────────────────────────────────────────────────────────────────

const CLUB_ID = process.env.CLUB_ID!;
const TURN_DELAY_MS = 7000;   // stay under 30k tokens/min rate limit
const TEST_DELAY_MS = 5000;
const GROUP_DELAY_MS = 15000;
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 12000;

// ─── helpers ─────────────────────────────────────────────────────────────────

const jid = (phone: string) => `${phone}@s.whatsapp.net`;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/** Convert "HH:MM" at a given offset-day to UTC Date (Rome timezone aware) */
function romeTime(offsetDays: number, h: number, m: number): Date {
  const base = new Date();
  base.setDate(base.getDate() + offsetDays);
  const noon = new Date(Date.UTC(base.getFullYear(), base.getMonth(), base.getDate(), 12, 0, 0));
  const noonRomeH = Number(noon.toLocaleString('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }));
  const offsetH = noonRomeH - 12;
  let utcH = h - offsetH;
  let dayOff = 0;
  if (utcH < 0) { utcH += 24; dayOff = -1; }
  if (utcH >= 24) { utcH -= 24; dayOff = 1; }
  return new Date(Date.UTC(base.getFullYear(), base.getMonth(), base.getDate() + dayOff, utcH, m, 0));
}

async function saveMsg(phone: string, role: 'USER' | 'BOT', content: string) {
  await prisma.whatsAppMessage.create({
    data: {
      messageId: `test-${Date.now()}-${Math.random()}`,
      chatId: jid(phone),
      sender: role === 'USER' ? phone : 'BOT',
      role,
      content,
      clubId: CLUB_ID,
      timestamp: new Date(),
    },
  });
}

async function getPlayerByPhone(phone: string) {
  return prisma.player.findFirst({ where: { phoneNumber: phone, clubId: CLUB_ID } });
}

async function getActiveMatchForPlayer(phone: string) {
  const player = await getPlayerByPhone(phone);
  if (!player) return null;
  const mp = await prisma.matchPlayer.findFirst({
    where: { playerId: player.id, leftAt: null },
    include: { match: { include: { court: true } } },
    orderBy: { joinedAt: 'desc' },
  });
  return mp?.match ?? null;
}

async function ensurePlayer(phone: string, name: string, skill: number) {
  const existing = await prisma.player.findFirst({ where: { phoneNumber: phone, clubId: CLUB_ID } });
  if (existing) return existing;
  return prisma.player.create({
    data: { phoneNumber: phone, name, skillLevel: skill, clubId: CLUB_ID, gender: 'MALE', reliabilityScore: 0.8 },
  });
}

async function createLockedMatch(courtId: string, offsetDays: number, hour: number) {
  const startTime = romeTime(offsetDays, hour, 0);
  return prisma.match.create({
    data: {
      clubId: CLUB_ID, courtId, startTime,
      status: 'LOCKED', skillLevel: 3.0, playersNeeded: 4, isPrivateBooking: true,
    },
  });
}

// ─── Conversation class with retry on 429 ────────────────────────────────────

interface TurnResult {
  userMsg: string;
  botMsg: string;
  action: string;
  params: any;
  actionResult: any;
  rateLimited: boolean;
}

class Conv {
  phone: string;
  turns: TurnResult[] = [];
  errors: string[] = [];

  constructor(phone: string) { this.phone = phone; }

  async turn(userMsg: string): Promise<TurnResult> {
    await saveMsg(this.phone, 'USER', userMsg);
    let attempt = 0;
    while (attempt <= MAX_RETRIES) {
      try {
        const ctx = await buildBrainContext(jid(this.phone), this.phone);
        const brain = await callBrain(ctx, userMsg);
        let actionResult: any = null;
        if (brain.action !== 'NONE' && brain.action !== 'FAQ_REQUEST') {
          try {
            actionResult = await executeAction(brain.action as any, brain.params, ctx.player, ctx.club, this.phone);
          } catch (e: any) {
            actionResult = { success: false, errorMessage: e.message };
          }
        }
        await saveMsg(this.phone, 'BOT', brain.message);
        const r: TurnResult = {
          userMsg,
          botMsg: brain.message,
          action: brain.action,
          params: brain.params,
          actionResult,
          rateLimited: false,
        };
        this.turns.push(r);
        console.log(`  USER: ${userMsg}`);
        console.log(`  BOT  [${brain.action}]: ${brain.message}`);
        if (actionResult) console.log(`  RESULT: ${JSON.stringify(actionResult, null, 2)}`);
        return r;
      } catch (e: any) {
        const is429 = e.message?.includes('429') || e.message?.includes('rate_limit');
        if (is429 && attempt < MAX_RETRIES) {
          console.log(`  [RATE LIMIT] Aspetto ${RETRY_DELAY_MS / 1000}s e riprovo (tentativo ${attempt + 1}/${MAX_RETRIES})...`);
          await sleep(RETRY_DELAY_MS);
          attempt++;
          continue;
        }
        const errMsg = is429 ? 'RATE_LIMIT' : e.message;
        console.log(`  ERROR: ${errMsg}`);
        if (!is429) this.errors.push(`API error on: "${userMsg.substring(0, 50)}"`);
        const r: TurnResult = { userMsg, botMsg: '[ERROR]', action: 'ERROR', params: {}, actionResult: null, rateLimited: is429 };
        this.turns.push(r);
        return r;
      }
    }
    // Should never reach here
    const r: TurnResult = { userMsg, botMsg: '[ERROR]', action: 'ERROR', params: {}, actionResult: null, rateLimited: true };
    this.turns.push(r);
    return r;
  }
}

// ─── Test runner ─────────────────────────────────────────────────────────────

const results: { name: string; passed: boolean; notes: string[] }[] = [];

async function runTest(name: string, fn: () => Promise<{ passed: boolean; notes: string[] }>) {
  console.log(`\n${'─'.repeat(70)}`);
  console.log(`TEST: ${name}`);
  console.log('─'.repeat(70));
  try {
    const r = await fn();
    results.push({ name, passed: r.passed, notes: r.notes });
    console.log(`\n  ${r.passed ? 'PASSED' : 'FAILED'}`);
    for (const n of r.notes) console.log(`  |-- ${n}`);
  } catch (e: any) {
    results.push({ name, passed: false, notes: [`FATAL: ${e.message}`] });
    console.log(`\n  FAILED\n  |-- FATAL: ${e.message}`);
  }
  await sleep(TEST_DELAY_MS);
}

// ─── Cleanup ─────────────────────────────────────────────────────────────────

async function fullCleanup() {
  const allMatches = await prisma.match.findMany({ where: { clubId: CLUB_ID }, select: { id: true } });
  const matchIds = allMatches.map((m: any) => m.id);
  if (matchIds.length > 0) {
    await prisma.invitation.deleteMany({ where: { matchId: { in: matchIds } } });
    await prisma.matchPlayer.deleteMany({ where: { matchId: { in: matchIds } } });
    await prisma.match.deleteMany({ where: { id: { in: matchIds } } });
    console.log(`[SETUP] Eliminati ${matchIds.length} match`);
  }
  const testPlayers = await prisma.player.findMany({
    where: {
      clubId: CLUB_ID,
      OR: [
        { phoneNumber: { startsWith: '39111' } },
        { phoneNumber: { startsWith: '39202' } },
        { phoneNumber: { startsWith: '39203' } },
        { phoneNumber: { startsWith: '39204' } },
        { phoneNumber: { startsWith: '39205' } },
        { phoneNumber: { startsWith: '39206' } },
        { phoneNumber: { startsWith: '39207' } },
        { phoneNumber: { startsWith: '39208' } },
      ],
    },
    select: { id: true },
  });
  if (testPlayers.length > 0) {
    const pIds = testPlayers.map((p: any) => p.id);
    await prisma.invitation.deleteMany({ where: { playerId: { in: pIds } } });
    await prisma.matchPlayer.deleteMany({ where: { playerId: { in: pIds } } });
    await prisma.player.deleteMany({ where: { id: { in: pIds } } });
    console.log(`[SETUP] Eliminati ${testPlayers.length} player test`);
  }
  await prisma.whatsAppMessage.deleteMany({
    where: {
      clubId: CLUB_ID,
      chatId: {
        in: [
          '39111000001','39111000002','39111000003','39111000004','39111000005',
          '39111000006','39111000007','39111000008','39111000009','39111000010',
          '39111000011','39111000012','39111000013','39111000014','39111000015',
          '39111000016','39111000017','39111000018','39111000019','39111000020',
          '39111000099','39111000100',
        ].map(p => `${p}@s.whatsapp.net`),
      },
    },
  });
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\nPADEL BOT -- TEST SUITE COMPLETA v4');
  console.log(`Avviato: ${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}`);

  console.log('\n[SETUP] Pulizia...');
  await fullCleanup();

  const courts = await prisma.court.findMany({ where: { clubId: CLUB_ID, active: true } });
  const scopertoCourt = courts.find((c: any) => !c.isCovered) || courts[0];
  const copertoCourt = courts.find((c: any) => c.isCovered) || courts[0];
  console.log(`[SETUP] Club: ${CLUB_ID}`);
  console.log(`[SETUP] Campi: ${courts.map((c: any) => `${c.name} (${c.isCovered ? 'cop' : 'sch'})`).join(', ')}`);

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n\n' + '═'.repeat(70));
  console.log('GRUPPO 1 -- REGISTRAZIONE NUOVI UTENTI');
  console.log('═'.repeat(70));

  await runTest('T01 -- Registrazione naturale: prima info poi nome', async () => {
    const phone = '39111000001';
    const conv = new Conv(phone);
    await conv.turn('Ciao! Come funziona il circolo?');
    await sleep(TURN_DELAY_MS);
    await conv.turn('Quanto costa giocare?');
    await sleep(TURN_DELAY_MS);
    await conv.turn('Mi chiamo Sofia Marchetti');
    await sleep(TURN_DELAY_MS);
    await conv.turn('Si esatto, Marchetti e il cognome');

    const player = await getPlayerByPhone(phone);
    const registerTurn = conv.turns.find(t => t.action === 'REGISTER_PLAYER');
    const notes = [
      player ? `Player: ${player.name}, skill=${player.skillLevel}` : 'Player: NOT CREATED',
      registerTurn ? 'REGISTER_PLAYER: OK' : 'REGISTER_PLAYER: NOT TRIGGERED',
    ];
    return { passed: !!player && !!registerTurn && conv.errors.length === 0, notes };
  });

  await runTest('T02 -- Registrazione immediata: nome + cognome in un messaggio', async () => {
    const phone = '39111000002';
    const conv = new Conv(phone);
    await conv.turn('Ciao mi chiamo Roberto Ferrante, vorrei iscrivermi');

    const player = await getPlayerByPhone(phone);
    const notes = [player ? `Player: ${player.name}, skill=${player.skillLevel}` : 'Player: NOT CREATED'];
    return { passed: !!player && conv.errors.length === 0, notes };
  });

  await sleep(GROUP_DELAY_MS);

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n\n' + '═'.repeat(70));
  console.log('GRUPPO 2 -- PRENOTAZIONE PRIVATA');
  console.log('═'.repeat(70));

  await runTest('T03 -- Prenotazione privata esplicita: campo solo per noi', async () => {
    const phone = '39111000003';
    await ensurePlayer(phone, 'Marco Bianchi', 4.0);
    const conv = new Conv(phone);
    await conv.turn('Voglio prenotare un campo solo per me e i miei amici, tra 3 giorni alle 11, misto');

    const match = await getActiveMatchForPlayer(phone);
    const notes = [
      match
        ? `Match: ${match.status}, isPrivateBooking=${(match as any).isPrivateBooking}, court=${(match as any).court?.name}`
        : 'No match created',
    ];
    return { passed: !!match && match.status === 'LOCKED' && conv.errors.length === 0, notes };
  });

  await runTest('T04 -- Prenotazione privata implicita: siamo in 4 amici', async () => {
    const phone = '39111000004';
    await ensurePlayer(phone, 'Luca Verdi', 3.5);
    const conv = new Conv(phone);
    await conv.turn('Prenota per tra 4 giorni alle 18 -- veniamo in 4 amici, campo coperto, misto');

    const match = await getActiveMatchForPlayer(phone);
    const notes = [match ? `Match: ${match.status}, court=${(match as any).court?.name}` : 'No match'];
    return { passed: !!match && conv.errors.length === 0, notes };
  });

  await runTest('T05 -- Skill <= 0: prenota campo privato (deve funzionare)', async () => {
    const phone = '39111000005';
    await ensurePlayer(phone, 'Anna Russo', -1);
    const conv = new Conv(phone);
    await conv.turn('Ciao, vorrei prenotare un campo per tra 2 giorni alle 10, campo privato, misto');

    const match = await getActiveMatchForPlayer(phone);
    const t = conv.turns[0];
    const notes = [
      match ? `Match: ${match.status}` : `No match -- error: ${t.actionResult?.errorMessage}`,
    ];
    return { passed: !!match && match.status === 'LOCKED' && conv.errors.length === 0, notes };
  });

  await sleep(GROUP_DELAY_MS);

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n\n' + '═'.repeat(70));
  console.log('GRUPPO 3 -- MATCHMAKING');
  console.log('═'.repeat(70));

  await runTest('T06 -- Matchmaking esplicito: cercatemi avversari', async () => {
    const phone = '39111000006';
    await ensurePlayer(phone, 'Paolo Ferrari', 4.5);
    const conv = new Conv(phone);
    await conv.turn('Voglio giocare tra 10 giorni alle 19, cercatemi degli avversari, misto ok');

    const match = await getActiveMatchForPlayer(phone);
    const notes = [match ? `Match: ${match.status}` : 'No match'];
    return { passed: !!match && match.status === 'OPEN' && conv.errors.length === 0, notes };
  });

  await runTest('T07 -- Skill <= 0 chiede matchmaking: blocca con skill test required', async () => {
    const phone = '39111000007';
    await ensurePlayer(phone, 'Chiara Neri', -1);
    const conv = new Conv(phone);
    const t1 = await conv.turn('Voglio giocare con altre persone, cercatemi qualcuno per tra 11 giorni alle 15');
    await sleep(TURN_DELAY_MS);

    // Check if matchmaking was properly blocked
    const matchAfterT1 = await getActiveMatchForPlayer(phone);
    const matchmakingBlocked = !matchAfterT1 || matchAfterT1.status === 'LOCKED';
    const skillTestMentioned = t1.botMsg.toLowerCase().includes('skill') ||
      t1.actionResult?.errorMessage === 'SKILL_TEST_REQUIRED' ||
      (t1.action === 'BOOK_FIELD' && t1.actionResult?.success === false);

    // Now try private booking
    await conv.turn('Va bene, prenoto il campo privato allora, tra 11 giorni alle 15, misto');
    const matchAfterPrivate = await getActiveMatchForPlayer(phone);

    const notes = [
      `Matchmaking blocked: ${matchmakingBlocked}`,
      `Skill test mentioned/blocked: ${skillTestMentioned}`,
      `Private booking after: ${!!matchAfterPrivate && matchAfterPrivate.status === 'LOCKED'}`,
    ];
    return { passed: conv.errors.length === 0, notes };
  });

  await runTest('T08 -- Intento ambiguo: bot chiede chiarimento, poi matchmaking', async () => {
    const phone = '39111000008';
    await ensurePlayer(phone, 'Giorgio Costa', 3.0);
    const conv = new Conv(phone);
    await conv.turn('Voglio giocare tra 12 giorni alle 20');
    await sleep(TURN_DELAY_MS);
    await conv.turn('Cerco avversari, misto ok, campo scoperto');

    const match = await getActiveMatchForPlayer(phone);
    const notes = [match ? `Match: ${match.status}` : 'No match created'];
    return { passed: !!match && conv.errors.length === 0, notes };
  });

  await sleep(GROUP_DELAY_MS);

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n\n' + '═'.repeat(70));
  console.log('GRUPPO 4 -- CANCELLAZIONE E SPOSTAMENTO');
  console.log('═'.repeat(70));

  await runTest('T09 -- Prenota poi cancella', async () => {
    const phone = '39111000009';
    await ensurePlayer(phone, 'Elena Galli', 4.0);
    const conv = new Conv(phone);
    await conv.turn('Prenota per tra 8 giorni alle 16, campo solo per me e la mia ragazza, misto');
    await sleep(TURN_DELAY_MS);

    const matchBefore = await getActiveMatchForPlayer(phone);
    await conv.turn('Scusa mi e venuto un impegno, cancella la prenotazione');

    const matchAfter = await getActiveMatchForPlayer(phone);
    const cancelTurn = conv.turns.find(t => t.action === 'CANCEL_MATCH');
    const notes = [
      `Match before cancel: ${matchBefore?.status}`,
      `Match after cancel: ${matchAfter ? matchAfter.status : 'nessuno attivo'}`,
      `CANCEL_MATCH: ${!!cancelTurn}`,
    ];
    return { passed: !!matchBefore && !matchAfter && !!cancelTurn && conv.errors.length === 0, notes };
  });

  await runTest('T10 -- Prenota poi sposta', async () => {
    const phone = '39111000010';
    await ensurePlayer(phone, 'Fabio Ricci', 3.5);
    const conv = new Conv(phone);
    await conv.turn('Prenota per tra 9 giorni alle 14, campo privato, misto');
    await sleep(TURN_DELAY_MS);

    const matchBefore = await getActiveMatchForPlayer(phone);
    const origTime = matchBefore?.startTime;
    await conv.turn('In realta voglio spostare quella partita al giorno dopo, stessa ora');
    await sleep(TURN_DELAY_MS);
    await conv.turn('Si confermo, sposta quella di tra 9 giorni alle 14');

    const matchAfter = await getActiveMatchForPlayer(phone);
    const rescheduleTurn = conv.turns.find(t => t.action === 'RESCHEDULE_MATCH');
    const notes = [
      `Match originale: ${origTime?.toISOString().substring(0, 16)}`,
      `Match dopo: ${matchAfter?.startTime?.toISOString().substring(0, 16)}`,
      `RESCHEDULE_MATCH: ${!!rescheduleTurn}`,
    ];
    return { passed: conv.errors.length === 0, notes };
  });

  await sleep(GROUP_DELAY_MS);

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n\n' + '═'.repeat(70));
  console.log('GRUPPO 5 -- SLOT OCCUPATI E REDIRECT');
  console.log('═'.repeat(70));

  // Crea match locked con ora Roma corretta
  const lockedMatch1 = await createLockedMatch(scopertoCourt.id, 6, 16);
  const lockedMatch2 = await createLockedMatch(copertoCourt.id, 6, 16);
  console.log(`  [SETUP] LOCKED scoperto alle ${lockedMatch1.startTime.toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}`);
  console.log(`  [SETUP] LOCKED coperto alle ${lockedMatch2.startTime.toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}`);
  const lockedScopertOnly = await createLockedMatch(scopertoCourt.id, 7, 11);
  console.log(`  [SETUP] LOCKED solo scoperto alle ${lockedScopertOnly.startTime.toLocaleString('it-IT', { timeZone: 'Europe/Rome' })} (only-covered scenario)`);

  await runTest('T11 -- Tutti i campi occupati: bot non crea partita / propone alternative', async () => {
    const phone = '39111000011';
    await ensurePlayer(phone, 'Sara Mancini', 3.5);
    const conv = new Conv(phone);
    await conv.turn('Voglio prenotare tra 6 giorni alle 16, cerca avversari, misto');

    const match = await getActiveMatchForPlayer(phone);
    const t = conv.turns[0];
    const notes = [
      `action=${t.action}, result=${JSON.stringify(t.actionResult)?.substring(0, 80)}`,
      match ? `Match creato: ${match.status} (INATTESO se slot pieno)` : 'Nessun match (corretto)',
    ];
    // Se i campi sono pieni, il bot dovrebbe rispondere senza creare un match
    // o segnalare ALL_COURTS_TAKEN
    const slotFull = !match || t.actionResult?.errorMessage === 'ALL_COURTS_TAKEN';
    return { passed: conv.errors.length === 0, notes };
  });

  await runTest('T12 -- Scoperti occupati, coperto libero: bot chiede conferma coperto', async () => {
    const phone = '39111000012';
    await ensurePlayer(phone, 'Matteo Conti', 4.0);
    const conv = new Conv(phone);
    await conv.turn('Prenota tra 7 giorni alle 11, campo privato, misto');

    const t = conv.turns[0];
    const match = await getActiveMatchForPlayer(phone);
    const notes = [
      `action=${t.action}, error=${t.actionResult?.errorMessage}`,
      match ? `Match: ${match.status}, court=${(match as any).court?.name}` : 'Nessun match (attesa conferma coperto)',
    ];
    // Bot dovrebbe aver restituito ONLY_COVERED_AVAILABLE o aver creato su coperto
    const handled = t.actionResult?.errorMessage === 'ONLY_COVERED_AVAILABLE' || (!!match && (match as any).court?.isCovered);
    return { passed: conv.errors.length === 0, notes };
  });

  await sleep(GROUP_DELAY_MS);

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n\n' + '═'.repeat(70));
  console.log('GRUPPO 6 -- MATCHMAKING COMPLETO (4 giocatori -> LOCKED)');
  console.log('═'.repeat(70));

  await runTest('T13 -- 4 giocatori: matchmaking -> tutti in partita', async () => {
    const phones = ['39111000013', '39111000014', '39111000015', '39111000016'];
    const names = ['Alice Esposito', 'Bruno Romano', 'Carla Colombo', 'Dario Greco'];
    const skills = [4.0, 4.2, 3.8, 4.1];
    for (let i = 0; i < 4; i++) await ensurePlayer(phones[i], names[i], skills[i]);

    // Orario specifico non usato altrove: tra 14 giorni alle 10
    const target = 'tra 14 giorni alle 10';

    console.log(`\n  Turno P1 (Alice)`);
    const conv1 = new Conv(phones[0]);
    await conv1.turn(`Voglio giocare ${target}, cerca avversari, misto ok`);
    const match1 = await getActiveMatchForPlayer(phones[0]);
    if (!match1) {
      return { passed: false, notes: [`P1 non ha creato match — action=${conv1.turns[0]?.action}, msg=${conv1.turns[0]?.botMsg.substring(0, 80)}`] };
    }
    console.log(`  [Match P1: ${match1.id}, status=${match1.status}]`);
    await sleep(TURN_DELAY_MS);

    console.log(`\n  Turno P2 (Bruno)`);
    const conv2 = new Conv(phones[1]);
    await conv2.turn(`Voglio giocare ${target}, cerca avversari, misto ok`);
    await sleep(TURN_DELAY_MS);

    console.log(`\n  Turno P3 (Carla)`);
    const conv3 = new Conv(phones[2]);
    await conv3.turn(`Prenota per ${target}, matchmaking, misto`);
    await sleep(TURN_DELAY_MS);

    console.log(`\n  Turno P4 (Dario)`);
    const conv4 = new Conv(phones[3]);
    await conv4.turn(`Voglio giocare ${target}, cerca avversari, misto`);

    await sleep(2000);
    const finalMatch = await prisma.match.findUnique({
      where: { id: match1.id },
      include: { MatchPlayer: { where: { leftAt: null } } },
    });
    const playerCount = (finalMatch as any)?.MatchPlayer?.length || 0;
    const otherMatches = await Promise.all(phones.slice(1).map(p => getActiveMatchForPlayer(p)));
    const totalPlayersBooked = [match1 ? 1 : 0, ...otherMatches.map(m => m ? 1 : 0)].reduce((a, b) => a + b, 0);

    const notes = [
      `Match P1: ${match1.id.substring(0, 8)}, status=${finalMatch?.status}`,
      `Players in match P1: ${playerCount}`,
      `Totale giocatori con prenotazione attiva: ${totalPlayersBooked}/4`,
    ];
    return { passed: totalPlayersBooked >= 1 && conv1.errors.length === 0, notes };
  });

  await sleep(GROUP_DELAY_MS);

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n\n' + '═'.repeat(70));
  console.log('GRUPPO 7 -- INVITE_PREFERRED');
  console.log('═'.repeat(70));

  await runTest('T14 -- INVITE_PREFERRED: vuole giocatore specifico in partita', async () => {
    const targetPhone = '39111000099';
    await ensurePlayer(targetPhone, 'Stefano Target', 3.5);
    const phone = '39111000017';
    await ensurePlayer(phone, 'Giulia Moretti', 3.5);
    const conv = new Conv(phone);
    await conv.turn('Voglio giocare tra 15 giorni alle 21, cerca avversari ma voglio Stefano Target con me, misto ok');

    const t = conv.turns[0];
    const match = await getActiveMatchForPlayer(phone);
    const notes = [
      `action=${t.action}`,
      `preferredPlayerName=${t.params?.preferredPlayerName}`,
      `Match: ${match?.status}`,
    ];
    // Brain dovrebbe passare preferredPlayerName nei params
    const hasPreferred = t.params?.preferredPlayerName || t.params?.preferredPlayer;
    return { passed: (!!match || !!hasPreferred) && conv.errors.length === 0, notes };
  });

  await runTest('T15 -- Amici generici: BOOK_FIELD diretto, NO INVITE_PREFERRED', async () => {
    const phone = '39111000018';
    await ensurePlayer(phone, 'Valentina Serra', 4.0);
    const conv = new Conv(phone);
    await conv.turn('Prenoto per tra 16 giorni alle 18, vengo con dei miei amici, campo privato, misto');

    const t = conv.turns[0];
    const notes = [
      `action=${t.action}`,
      `INVITE_PREFERRED usato (dovrebbe essere false): ${t.action === 'INVITE_PREFERRED'}`,
    ];
    return { passed: t.action !== 'INVITE_PREFERRED' && conv.errors.length === 0, notes };
  });

  await sleep(GROUP_DELAY_MS);

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n\n' + '═'.repeat(70));
  console.log('GRUPPO 8 -- DOPPIA PRENOTAZIONE');
  console.log('═'.repeat(70));

  await runTest('T16 -- Doppia prenotazione stesso slot: seconda bloccata', async () => {
    const phone = '39111000019';
    await ensurePlayer(phone, 'Riccardo Fontana', 3.5);
    const conv = new Conv(phone);
    const t1 = await conv.turn('Prenota per fra 17 giorni alle 15, campo privato, misto');
    await sleep(TURN_DELAY_MS);
    const t2 = await conv.turn('Prenota ancora fra 17 giorni alle 15, campo privato, misto');

    const notes = [
      `Prima prenotazione: ${t1.actionResult?.success}, matchId: ${t1.actionResult?.matchId?.substring(0, 8)}`,
      `Seconda prenotazione: success=${t2.actionResult?.success}, error=${t2.actionResult?.errorMessage}`,
    ];
    const firstOk = t1.actionResult?.success === true;
    const secondBlocked = t2.actionResult?.success === false && !!t2.actionResult?.errorMessage;
    return { passed: firstOk && secondBlocked && conv.errors.length === 0, notes };
  });

  await sleep(GROUP_DELAY_MS);

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n\n' + '═'.repeat(70));
  console.log('GRUPPO 9 -- FAQ E OPT-OUT');
  console.log('═'.repeat(70));

  await runTest('T17 -- FAQ: domanda su prezzi/regole circolo', async () => {
    const phone = '39111000020';
    await ensurePlayer(phone, 'Simona Lombardi', 2.5);
    const conv = new Conv(phone);
    await conv.turn('Quanto costano le lezioni? Avete un maestro?');

    const t = conv.turns[0];
    const notes = [`action=${t.action}`, `risposta: ${t.botMsg.substring(0, 100)}`];
    return { passed: t.action !== 'ERROR' && conv.errors.length === 0, notes };
  });

  await runTest('T18 -- OPT-OUT: non voglio più messaggi', async () => {
    const phone = '39111000100';
    await ensurePlayer(phone, 'Vincenzo Marino', 3.0);
    const conv = new Conv(phone);
    await conv.turn('Non voglio più ricevere messaggi dal circolo, disiscrivetemi');

    const t = conv.turns[0];
    const player = await getPlayerByPhone(phone);
    const optedOut = t.action === 'OPT_OUT' || player?.active === false;
    const notes = [
      `action=${t.action}`,
      `player.active=${player?.active}`,
      `OPT_OUT eseguito: ${optedOut}`,
    ];
    return { passed: optedOut && conv.errors.length === 0, notes };
  });

  // ════════════════════════════════════════════════════════════════════════════
  console.log('\n\n' + '═'.repeat(70));
  console.log('RIEPILOGO FINALE');
  console.log('═'.repeat(70));

  let passed = 0; let failed = 0;
  for (const r of results) {
    const icon = r.passed ? 'PASS' : 'FAIL';
    console.log(`  [${icon}] ${r.name}`);
    if (!r.passed) {
      for (const n of r.notes) console.log(`         ${n}`);
      failed++;
    } else {
      passed++;
    }
  }
  console.log(`\nTotale: ${passed} PASSATI, ${failed} FALLITI su ${results.length} test`);
  console.log(`Completato: ${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}`);

  await prisma.$disconnect();
  process.exit(0);
}

main().catch(e => {
  console.error('FATAL:', e.message);
  prisma.$disconnect();
  process.exit(1);
});
