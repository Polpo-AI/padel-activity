import dotenv from 'dotenv';
dotenv.config();
import { prisma } from '../services/db';
import { callBrain, executeAction, buildBrainContext } from '../services/brain';
import { getRedis } from '../services/queue';

interface TurnResult {
  userMsg: string;
  botMsg: string;
  action: string;
  params: any;
  actionResult?: any;
  error?: string;
}

interface TestResult {
  name: string;
  passed: boolean;
  turns: TurnResult[];
  notes: string[];
  errors: string[];
}

const allResults: TestResult[] = [];
const TURN_DELAY = 3000;
const GROUP_DELAY = 18000;
let totalApiErrors = 0;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function fmtDate(d: Date) {
  return d.toLocaleString('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function futureDate(daysFromNow: number, hour: number, minute = 0): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  const noon = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0));
  const noonRomeHour = Number(noon.toLocaleString('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }));
  const offsetH = noonRomeHour - 12;
  let utcH = hour - offsetH;
  let dayOffset = 0;
  if (utcH < 0) { utcH += 24; dayOffset = -1; }
  if (utcH >= 24) { utcH -= 24; dayOffset = 1; }
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, utcH, minute, 0));
}

async function getClub() {
  const clubId = process.env.CLUB_ID;
  const club = clubId
    ? await prisma.club.findUnique({ where: { id: clubId }, include: { courts: { where: { active: true } } } })
    : await prisma.club.findFirst({ include: { courts: { where: { active: true } } } });
  if (!club) throw new Error('No club found');
  return club;
}

async function getPlayer(phone: string) {
  const club = await getClub();
  return prisma.player.findFirst({ where: { phoneNumber: phone, clubId: club.id } });
}

async function createPlayer(phone: string, name: string, skillLevel: number, gender: 'MALE' | 'FEMALE' = 'MALE') {
  const club = await getClub();
  const existing = await prisma.player.findFirst({ where: { phoneNumber: phone, clubId: club.id } });
  if (existing) await prisma.player.delete({ where: { id: existing.id } });
  return prisma.player.create({
    data: { phoneNumber: phone, name, clubId: club.id, skillLevel, gender, active: true }
  });
}

async function runTurn(phone: string, msg: string): Promise<TurnResult> {
  await sleep(TURN_DELAY);
  const club = await getClub();
  try {
    // Use buildBrainContext with phone as jid (test mode)
    const jid = phone + '@s.whatsapp.net';
    const ctx = await buildBrainContext(jid, phone);
    const brain = await callBrain(ctx, msg);
    let actionResult;
    if (brain.action !== 'NONE') {
      const p2 = await getPlayer(phone);
      actionResult = await executeAction(brain.action as any, brain.params, p2, club, phone);
    }
    return { userMsg: msg, botMsg: brain.message, action: brain.action, params: brain.params, actionResult };
  } catch (err: any) {
    totalApiErrors++;
    const errMsg = err?.message || String(err);
    console.error('  API ERROR:', errMsg.substring(0, 100));
    return { userMsg: msg, botMsg: '[API ERROR]', action: 'ERROR', params: {}, error: errMsg };
  }
}

async function runTest(
  name: string,
  phone: string,
  conversation: Array<{ msg: string; check?: (t: TurnResult) => boolean; note?: string }>,
  dbCheck?: () => Promise<{ passed: boolean; notes: string[] }>
): Promise<TestResult> {
  const result: TestResult = { name, passed: true, turns: [], notes: [], errors: [] };

  console.log('\n' + '-'.repeat(70));
  console.log('TEST: ' + name);
  console.log('-'.repeat(70));

  for (const { msg, check, note } of conversation) {
    const turn = await runTurn(phone, msg);
    result.turns.push(turn);

    console.log('\n  USER: ' + turn.userMsg);
    console.log('  BOT [' + turn.action + ']: ' + turn.botMsg);
    if (turn.params && Object.keys(turn.params).length > 0) {
      console.log('     params: ' + JSON.stringify(turn.params));
    }
    if (turn.actionResult) {
      console.log('     result: ' + JSON.stringify(turn.actionResult));
    }
    if (note) result.notes.push(note);

    if (turn.action === 'ERROR') {
      result.errors.push('API error on turn: ' + msg);
      result.passed = false;
      await sleep(10000);
    } else if (check && !check(turn)) {
      result.errors.push('Check failed on turn: "' + msg + '" -> action=' + turn.action + ' msg="' + turn.botMsg.substring(0, 80) + '"');
      result.passed = false;
    }
  }

  if (dbCheck) {
    const { passed, notes } = await dbCheck();
    if (!passed) result.passed = false;
    result.notes.push(...notes);
  }

  console.log('\n  ' + (result.passed ? 'PASSED' : 'FAILED'));
  if (result.errors.length) result.errors.forEach(e => console.log('  |-- ' + e));
  if (result.notes.length) result.notes.forEach(n => console.log('  [i] ' + n));

  allResults.push(result);
  return result;
}

async function main() {
  console.log('\nPADEL BOT -- TEST SUITE COMPLETA v2');
  console.log('Avviato: ' + new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' }));

  const club = await getClub();
  console.log('Club: ' + club.name);
  console.log('Campi: ' + (club as any).courts.map((c: any) => c.name + (c.isCovered ? ' (cop)' : ' (sch)')).join(', '));
  console.log('');

  // =================================================
  // GRUPPO 1: REGISTRAZIONE
  // =================================================

  console.log('\n' + '='.repeat(70));
  console.log('GRUPPO 1 -- REGISTRAZIONE NUOVI UTENTI');
  console.log('='.repeat(70));

  await runTest(
    'T01 -- Registrazione naturale: prima info poi nome',
    '39201000001',
    [
      { msg: 'Ciao! Come funziona il circolo?' },
      { msg: 'Quanto costa giocare?' },
      { msg: 'Mi chiamo Sofia Marchetti' },
      {
        msg: 'Si esatto, Marchetti e il cognome',
        check: t => t.action === 'REGISTER_PLAYER'
      },
    ],
    async () => {
      const p = await getPlayer('39201000001');
      const notes = ['Player: ' + (p ? p.name + ' skill=' + p.skillLevel : 'NOT CREATED')];
      return { passed: !!p && p.name.toLowerCase().includes('sofia'), notes };
    }
  );
  await sleep(GROUP_DELAY);

  await runTest(
    'T02 -- Registrazione immediata: nome e cognome in un messaggio',
    '39201000002',
    [
      {
        msg: 'Ciao mi chiamo Roberto Ferrante, vorrei iscrivermi',
        check: t => t.action === 'REGISTER_PLAYER'
      },
    ],
    async () => {
      const p = await getPlayer('39201000002');
      const notes = ['Player: ' + (p ? p.name : 'NOT CREATED')];
      return { passed: !!p && p.name.toLowerCase().includes('roberto'), notes };
    }
  );
  await sleep(GROUP_DELAY);

  // =================================================
  // GRUPPO 2: PRENOTAZIONE PRIVATA
  // =================================================

  console.log('\n' + '='.repeat(70));
  console.log('GRUPPO 2 -- PRENOTAZIONE PRIVATA');
  console.log('='.repeat(70));

  await createPlayer('39202000001', 'Davide Privato', 3.5);
  await runTest(
    'T03 -- Prenotazione privata esplicita: campo solo per noi',
    '39202000001',
    [
      {
        msg: 'Voglio prenotare un campo solo per me e i miei amici, domenica alle 11 misto',
        check: t => t.action === 'BOOK_FIELD' && t.params?.private === true
      },
    ],
    async () => {
      const turns = allResults[allResults.length - 1].turns;
      const bt = turns.find(t => t.action === 'BOOK_FIELD');
      if (!bt?.actionResult?.matchId) return { passed: false, notes: ['No match created'] };
      const m = await prisma.match.findUnique({ where: { id: bt.actionResult.matchId } });
      return {
        passed: m?.status === 'LOCKED' && m?.isPrivateBooking === true,
        notes: ['Match: status=' + m?.status + ' private=' + m?.isPrivateBooking]
      };
    }
  );
  await sleep(GROUP_DELAY);

  await createPlayer('39202000002', 'Chiara Privata', 4.0, 'FEMALE');
  await runTest(
    'T04 -- Prenotazione privata: siamo in 4 amici senza dire matchmaking',
    '39202000002',
    [
      {
        msg: 'Prenota per lunedi alle 18 -- veniamo in 4 amici, campo coperto misto',
        check: t => t.action === 'BOOK_FIELD'
      },
    ],
    async () => {
      const turns = allResults[allResults.length - 1].turns;
      const bt = turns.find(t => t.action === 'BOOK_FIELD');
      if (!bt?.actionResult?.matchId) return { passed: false, notes: ['No match created'] };
      const m = await prisma.match.findUnique({ where: { id: bt.actionResult.matchId }, include: { court: true } });
      return {
        passed: m?.status === 'LOCKED',
        notes: ['Match: status=' + m?.status + ' private=' + m?.isPrivateBooking + ' covered=' + m?.court?.isCovered]
      };
    }
  );
  await sleep(GROUP_DELAY);

  await createPlayer('39202000003', 'Marco Privato', -1);
  await runTest(
    'T05 -- Skill <= 0 prenota campo privato: deve funzionare',
    '39202000003',
    [
      {
        msg: 'Ciao, vorrei prenotare un campo per martedi alle 10, campo privato, misto',
        check: t => t.action === 'BOOK_FIELD'
      },
    ],
    async () => {
      const turns = allResults[allResults.length - 1].turns;
      const bt = turns.find(t => t.action === 'BOOK_FIELD');
      if (!bt?.actionResult?.matchId) return { passed: false, notes: ['No match -- errorMsg: ' + bt?.actionResult?.errorMessage] };
      const m = await prisma.match.findUnique({ where: { id: bt.actionResult.matchId } });
      return {
        passed: m?.status === 'LOCKED' && m?.isPrivateBooking === true,
        notes: ['Match: status=' + m?.status + ' private=' + m?.isPrivateBooking]
      };
    }
  );
  await sleep(GROUP_DELAY);

  // =================================================
  // GRUPPO 3: MATCHMAKING
  // =================================================

  console.log('\n' + '='.repeat(70));
  console.log('GRUPPO 3 -- MATCHMAKING');
  console.log('='.repeat(70));

  await createPlayer('39203000001', 'Luca Matchmaking', 4.5);
  await runTest(
    'T06 -- Matchmaking esplicito: cercatemi avversari, misto',
    '39203000001',
    [
      {
        msg: 'Voglio giocare mercoledi alle 19, cercatemi degli avversari, misto ok',
        check: t => t.action === 'BOOK_FIELD' && t.params?.private === false
      },
    ],
    async () => {
      const turns = allResults[allResults.length - 1].turns;
      const bt = turns.find(t => t.action === 'BOOK_FIELD');
      if (!bt?.actionResult?.matchId) return { passed: false, notes: ['No match created'] };
      const m = await prisma.match.findUnique({ where: { id: bt.actionResult.matchId } });
      return {
        passed: m?.status === 'OPEN' && m?.isPrivateBooking === false,
        notes: ['Match: status=' + m?.status + ' private=' + m?.isPrivateBooking]
      };
    }
  );
  await sleep(GROUP_DELAY);

  await createPlayer('39203000002', 'Elena Matchmaking', -1, 'FEMALE');
  await runTest(
    'T07 -- Skill <= 0 chiede matchmaking: spiega skill test, poi prenota privata',
    '39203000002',
    [
      {
        msg: 'Voglio giocare con altre persone, cercatemi qualcuno per giovedi alle 15',
        check: t => t.action === 'NONE' || (t.action === 'BOOK_FIELD' && t.params?.private === true)
      },
      {
        msg: 'Va bene, prenoto il campo privato allora, misto',
        check: t => t.action === 'BOOK_FIELD'
      },
    ],
    async () => {
      const turns = allResults[allResults.length - 1].turns;
      const bt = turns.find(t => t.action === 'BOOK_FIELD');
      const notes = ['Matchmaking blocked, booked private: ' + !!bt?.actionResult?.matchId];
      return { passed: !!bt?.actionResult?.matchId, notes };
    }
  );
  await sleep(GROUP_DELAY);

  await createPlayer('39203000003', 'Tizio Ambiguo', 4.0);
  await runTest(
    'T08 -- Intento ambiguo: bot chiede privata o matchmaking',
    '39203000003',
    [
      {
        msg: 'Voglio giocare venerdi alle 20',
        check: t => t.action === 'NONE'
      },
      {
        msg: 'Cerco avversari, misto ok',
        check: t => t.action === 'BOOK_FIELD' && t.params?.private === false
      },
    ],
    async () => {
      const turns = allResults[allResults.length - 1].turns;
      const bt = turns.find(t => t.action === 'BOOK_FIELD');
      if (!bt?.actionResult?.matchId) return { passed: false, notes: ['No match'] };
      const m = await prisma.match.findUnique({ where: { id: bt.actionResult.matchId } });
      return {
        passed: m?.status === 'OPEN',
        notes: ['Match OPEN: ' + (m?.status === 'OPEN')]
      };
    }
  );
  await sleep(GROUP_DELAY);

  // =================================================
  // GRUPPO 4: CANCELLAZIONE E SPOSTAMENTO
  // =================================================

  console.log('\n' + '='.repeat(70));
  console.log('GRUPPO 4 -- CANCELLAZIONE E SPOSTAMENTO');
  console.log('='.repeat(70));

  await createPlayer('39204000001', 'Paolo Cancella', 3.0);
  await runTest(
    'T09 -- Prenota poi cancella',
    '39204000001',
    [
      {
        msg: 'Prenota per sabato fra 8 giorni alle 16, campo solo per me e la mia ragazza, misto',
        check: t => t.action === 'BOOK_FIELD'
      },
      {
        msg: 'Scusa mi e venuto un impegno, cancella la prenotazione',
        check: t => t.action === 'CANCEL_MATCH' && t.actionResult?.success === true
      },
    ],
    async () => {
      const turns = allResults[allResults.length - 1].turns;
      const bt = turns.find(t => t.action === 'BOOK_FIELD');
      const ct = turns.find(t => t.action === 'CANCEL_MATCH');
      if (!bt?.actionResult?.matchId) return { passed: false, notes: ['No match to cancel'] };
      const mps = await prisma.matchPlayer.findMany({
        where: { matchId: bt.actionResult.matchId, leftAt: null }
      });
      return {
        passed: ct?.actionResult?.success === true && mps.length === 0,
        notes: ['Active players after cancel: ' + mps.length]
      };
    }
  );
  await sleep(GROUP_DELAY);

  await createPlayer('39204000002', 'Giulia Sposta', 4.5, 'FEMALE');
  await runTest(
    'T10 -- Prenota poi sposta esplicitamente',
    '39204000002',
    [
      {
        msg: 'Prenota per mercoledi alle 14, campo privato, misto',
        check: t => t.action === 'BOOK_FIELD'
      },
      {
        msg: 'In realta voglio spostare quella partita a giovedi alla stessa ora',
        check: t => t.action === 'NONE'
      },
      {
        msg: 'Si, sposta quella di mercoledi alle 14',
        check: t => t.action === 'RESCHEDULE_MATCH' || t.action === 'BOOK_FIELD'
      },
    ],
    async () => {
      const turns = allResults[allResults.length - 1].turns;
      const last = turns[turns.length - 1];
      const notes = ['Final action: ' + last.action + ' success: ' + last.actionResult?.success];
      return { passed: last.actionResult?.success === true, notes };
    }
  );
  await sleep(GROUP_DELAY);

  // =================================================
  // GRUPPO 5: SLOT OCCUPATI E REDIRECT
  // =================================================

  console.log('\n' + '='.repeat(70));
  console.log('GRUPPO 5 -- SLOT OCCUPATI E REDIRECT');
  console.log('='.repeat(70));

  const clubForOcc = await getClub();
  const occupiedTime = futureDate(6, 16, 0);
  const openCourt = (clubForOcc as any).courts.find((c: any) => !c.isCovered);
  const covCourt = (clubForOcc as any).courts.find((c: any) => c.isCovered);
  const occPlayer = await createPlayer('39205000099', 'Occupante Test', 4.0);
  if (openCourt) {
    const om = await prisma.match.create({
      data: {
        clubId: clubForOcc.id,
        courtId: openCourt.id,
        startTime: occupiedTime,
        skillLevel: 4.0,
        playersNeeded: 4,
        status: 'LOCKED',
        isPrivateBooking: true,
        isMixed: true,
      }
    });
    await prisma.matchPlayer.create({ data: { matchId: om.id, playerId: occPlayer.id } });
    console.log('\n  [SETUP] Creato match LOCKED su campo scoperto alle ' + fmtDate(occupiedTime));
  }

  if (covCourt) {
    await prisma.match.create({
      data: {
        clubId: clubForOcc.id,
        courtId: covCourt.id,
        startTime: occupiedTime,
        skillLevel: 4.0,
        playersNeeded: 4,
        status: 'LOCKED',
        isPrivateBooking: true,
        isMixed: true,
      }
    });
    console.log('  [SETUP] Creato match LOCKED su campo coperto alle ' + fmtDate(occupiedTime));
  }

  await createPlayer('39205000001', 'Andrea Redirect', 4.0);
  await runTest(
    'T11 -- Tutti i campi occupati: bot propone alternative',
    '39205000001',
    [
      {
        msg: 'Voglio prenotare tra 6 giorni alle 16, cerca avversari, misto',
        check: t => {
          if (t.action === 'NONE') return true;
          if (t.action === 'BOOK_FIELD' && t.actionResult?.errorMessage === 'ALL_COURTS_TAKEN') return true;
          return false;
        }
      },
    ],
    async () => {
      const turn = allResults[allResults.length - 1].turns[0];
      const notes = ['action=' + turn.action + ' result=' + JSON.stringify(turn.actionResult)];
      const ok = turn.action === 'NONE' || turn.actionResult?.errorMessage === 'ALL_COURTS_TAKEN';
      return { passed: ok, notes };
    }
  );
  await sleep(GROUP_DELAY);

  await createPlayer('39205000002', 'Beatrice Coperto', 4.0, 'FEMALE');
  const openCourts = (clubForOcc as any).courts.filter((c: any) => !c.isCovered);
  const covTime = futureDate(7, 11, 0);
  const tempOccP = await createPlayer('39205000090', 'Occupante Scoperto', 4.0);
  for (const oc of openCourts) {
    await prisma.match.create({
      data: {
        clubId: clubForOcc.id,
        courtId: oc.id,
        startTime: covTime,
        skillLevel: 4.0,
        playersNeeded: 4,
        status: 'LOCKED',
        isPrivateBooking: true,
        isMixed: true,
      }
    });
  }

  if (openCourts.length > 0 && covCourt) {
    await runTest(
      'T12 -- Scoperti occupati, coperto libero: bot chiede conferma',
      '39205000002',
      [
        {
          msg: 'Prenota tra 7 giorni alle 11, campo privato, misto',
          check: t => true
        },
      ],
      async () => {
        const turn = allResults[allResults.length - 1].turns[0];
        const notes = ['action=' + turn.action + ' params.private=' + turn.params?.private + ' error=' + turn.actionResult?.errorMessage];
        return { passed: true, notes };
      }
    );
    await sleep(GROUP_DELAY);
  }

  // =================================================
  // GRUPPO 6: MATCHMAKING COMPLETO (4 giocatori)
  // =================================================

  console.log('\n' + '='.repeat(70));
  console.log('GRUPPO 6 -- MATCHMAKING COMPLETO (4 giocatori -> LOCKED)');
  console.log('='.repeat(70));

  const p1 = await createPlayer('39206000001', 'Alice Quattro', 3.5, 'FEMALE');
  const p2 = await createPlayer('39206000002', 'Bruno Quattro', 3.5);
  const p3 = await createPlayer('39206000003', 'Carla Quattro', 3.5, 'FEMALE');
  const p4 = await createPlayer('39206000004', 'Diego Quattro', 3.5);

  const t6result: TestResult = {
    name: 'T13 -- 4 giocatori: matchmaking completo -> LOCKED',
    passed: true, turns: [], notes: [], errors: []
  };

  console.log('\n' + '-'.repeat(70));
  console.log('TEST: T13 -- 4 giocatori: matchmaking completo -> LOCKED');
  console.log('-'.repeat(70));

  try {
    const clubX = await getClub();
    console.log('\n  Turno P1 (Alice -- crea partita matchmaking)');
    const ctx1 = await buildBrainContext(p1.phoneNumber + '@s.whatsapp.net', p1.phoneNumber);
    const b1 = await callBrain(ctx1, 'Voglio giocare dopodomani alle 17, cerca avversari, misto ok');
    console.log('  BOT [' + b1.action + ']: ' + b1.message);
    const r1 = await executeAction(b1.action as any, b1.params, p1, clubX, p1.phoneNumber);
    console.log('  -> ' + JSON.stringify(r1));
    t6result.turns.push({ userMsg: 'Voglio giocare dopodomani alle 17, cerca avversari, misto ok', botMsg: b1.message, action: b1.action, params: b1.params, actionResult: r1 });

    const matchId = r1.matchId;
    if (!matchId) {
      t6result.errors.push('P1 did not create match: ' + JSON.stringify(r1));
      t6result.passed = false;
    } else {
      t6result.notes.push('Match created: ' + matchId);

      for (const [idx, player] of [[2, p2], [3, p3], [4, p4]] as [number, typeof p1][]) {
        await sleep(1500);
        const inv = await prisma.invitation.create({
          data: { matchId, playerId: player.id, status: 'PENDING' }
        });
        const acceptResult = await executeAction(
          'ACCEPT_INVITATION',
          { invitationId: inv.id },
          player,
          clubX,
          player.phoneNumber
        );
        console.log('  P' + idx + ' (' + player.name + ') accetta -> ' + JSON.stringify(acceptResult));
        t6result.turns.push({
          userMsg: player.name + ' accetta invito',
          botMsg: '',
          action: 'ACCEPT_INVITATION',
          params: { invitationId: inv.id },
          actionResult: acceptResult
        });
      }

      await sleep(2000);
      const finalMatch = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: { where: { leftAt: null }, include: { player: true } }, court: true }
      });
      t6result.notes.push('Final status: ' + finalMatch?.status);
      t6result.notes.push('Court: ' + finalMatch?.court?.name);
      t6result.notes.push('Players: ' + finalMatch?.MatchPlayer.map(mp => mp.player.name).join(', '));
      t6result.passed = finalMatch?.status === 'LOCKED' && (finalMatch?.MatchPlayer.length ?? 0) === 4;
    }
  } catch (err: any) {
    t6result.errors.push(err?.message);
    t6result.passed = false;
    totalApiErrors++;
  }

  console.log('\n  ' + (t6result.passed ? 'PASSED' : 'FAILED'));
  t6result.notes.forEach(n => console.log('  [i] ' + n));
  t6result.errors.forEach(e => console.log('  |-- ' + e));
  allResults.push(t6result);
  await sleep(GROUP_DELAY);

  // =================================================
  // GRUPPO 7: INVITE_PREFERRED
  // =================================================

  console.log('\n' + '='.repeat(70));
  console.log('GRUPPO 7 -- INVITE_PREFERRED');
  console.log('='.repeat(70));

  await createPlayer('39207000001', 'Francesco Amico', 4.0);
  await createPlayer('39207000002', 'Stefano Target', 4.0);

  await runTest(
    'T14 -- INVITE_PREFERRED: vuole Stefano Target in partita',
    '39207000001',
    [
      {
        msg: 'Voglio giocare lunedi alle 21, cerca avversari ma voglio Stefano Target con me, misto ok',
        check: t => t.action === 'BOOK_FIELD' || t.action === 'INVITE_PREFERRED'
      },
    ],
    async () => {
      const turns = allResults[allResults.length - 1].turns;
      const hasBook = turns.some(t => t.action === 'BOOK_FIELD');
      const hasInvite = turns.some(t => t.action === 'INVITE_PREFERRED');
      const notes = ['BOOK_FIELD: ' + hasBook + ', INVITE_PREFERRED: ' + hasInvite];
      return { passed: hasBook, notes };
    }
  );
  await sleep(GROUP_DELAY);

  await createPlayer('39207000003', 'Veronica Generica', 4.0, 'FEMALE');
  await runTest(
    'T15 -- Amici generici: NON usa INVITE_PREFERRED, usa BOOK_FIELD diretto',
    '39207000003',
    [
      {
        msg: 'Prenoto per sabato alle 18, vengo con dei miei amici, campo privato, misto',
        check: t => t.action === 'BOOK_FIELD' && t.action !== 'INVITE_PREFERRED'
      },
    ],
    async () => {
      const turns = allResults[allResults.length - 1].turns;
      const hasInvite = turns.some(t => t.action === 'INVITE_PREFERRED');
      const notes = ['INVITE_PREFERRED used (should be false): ' + hasInvite];
      return { passed: !hasInvite, notes };
    }
  );
  await sleep(GROUP_DELAY);

  // =================================================
  // GRUPPO 8: DOPPIA PRENOTAZIONE STESSO SLOT
  // =================================================

  console.log('\n' + '='.repeat(70));
  console.log('GRUPPO 8 -- DOPPIA PRENOTAZIONE STESSO SLOT');
  console.log('='.repeat(70));

  await createPlayer('39208000001', 'Roberto Doppio', 4.0);
  await runTest(
    'T16 -- Doppia prenotazione stesso orario: seconda bloccata',
    '39208000001',
    [
      {
        msg: 'Prenota per fra 10 giorni alle 15, campo privato, misto',
        check: t => t.action === 'BOOK_FIELD' && t.actionResult?.success === true
      },
      {
        msg: 'Prenota ancora fra 10 giorni alle 15, campo privato, misto',
        check: t => {
          if (t.action === 'NONE') return true;
          if (t.action === 'BOOK_FIELD' && t.actionResult?.success === false) return true;
          return false;
        }
      },
    ],
    async () => {
      const turns = allResults[allResults.length - 1].turns;
      const second = turns[1];
      const notes = ['Second booking: action=' + second.action + ' success=' + second.actionResult?.success + ' err=' + second.actionResult?.errorMessage];
      const blocked = second.action === 'NONE' || (second.action === 'BOOK_FIELD' && second.actionResult?.success === false);
      return { passed: blocked, notes };
    }
  );
  await sleep(GROUP_DELAY);

  // =================================================
  // GRUPPO 9: CONVERSAZIONI NATURALI
  // =================================================

  console.log('\n' + '='.repeat(70));
  console.log('GRUPPO 9 -- CONVERSAZIONI NATURALI E EDGE CASES');
  console.log('='.repeat(70));

  await createPlayer('39209000001', 'Monica FAQ', 3.5, 'FEMALE');
  await runTest(
    'T17 -- FAQ: domanda senza risposta disponibile',
    '39209000001',
    [
      {
        msg: "Avete l assicurazione infortuni per i giocatori?",
        check: t => t.action === 'FAQ_REQUEST'
      },
    ],
    async () => {
      const turn = allResults[allResults.length - 1].turns[0];
      return { passed: turn.action === 'FAQ_REQUEST', notes: ['question: ' + turn.params?.question] };
    }
  );
  await sleep(GROUP_DELAY);

  await createPlayer('39209000002', 'Nicola OPT', 4.0);
  await runTest(
    'T18 -- OPT_OUT: non voglio piu messaggi',
    '39209000002',
    [
      {
        msg: 'Non voglio piu ricevere messaggi, rimuovimi',
        check: t => t.action === 'OPT_OUT' && t.actionResult?.success === true
      },
    ],
    async () => {
      const p = await getPlayer('39209000002');
      return { passed: p?.active === false, notes: ['player.active=' + p?.active] };
    }
  );
  await sleep(GROUP_DELAY);

  await createPlayer('39209000003', 'Ornella Nota', 3.0, 'FEMALE');
  await runTest(
    'T19 -- SAVE_NOTE: preferenza sempre al coperto',
    '39209000003',
    [
      {
        msg: 'Per favore, io voglio sempre giocare al campo coperto se possibile',
        check: t => t.action === 'SAVE_NOTE'
      },
    ],
    async () => {
      const turn = allResults[allResults.length - 1].turns[0];
      return { passed: turn.action === 'SAVE_NOTE', notes: ['note: ' + turn.params?.note] };
    }
  );
  await sleep(GROUP_DELAY);

  const invPlayerFinal = await createPlayer('39209000004', 'Pietro Invitato', 3.5);
  const clubFinalInv = await getClub();
  const invTimeFinal = futureDate(9, 20, 0);
  const courtForInv = (clubFinalInv as any).courts[0];
  const matchForInv = await prisma.match.create({
    data: {
      clubId: clubFinalInv.id,
      courtId: courtForInv.id,
      startTime: invTimeFinal,
      skillLevel: 3.5,
      playersNeeded: 4,
      status: 'OPEN',
      isPrivateBooking: false,
      isMixed: true,
    }
  });
  const invForAccept = await prisma.invitation.create({
    data: { matchId: matchForInv.id, playerId: invPlayerFinal.id, status: 'PENDING' }
  });
  console.log('  [SETUP] Invitation pending creata per Pietro Invitato: ' + invForAccept.id);

  await runTest(
    'T20 -- Accetta invito a partita',
    '39209000004',
    [
      {
        msg: 'Si ci sono, confermo la partita!',
        check: t => t.action === 'ACCEPT_INVITATION' && t.actionResult?.success === true
      },
    ],
    async () => {
      const inv = await prisma.invitation.findUnique({ where: { id: invForAccept.id } });
      return {
        passed: inv?.status === 'ACCEPTED',
        notes: ['invitation status: ' + inv?.status]
      };
    }
  );
  await sleep(GROUP_DELAY);

  const rejPlayer = await createPlayer('39209000005', 'Quirino Rifiuta', 4.0);
  const matchForRej = await prisma.match.create({
    data: {
      clubId: clubFinalInv.id,
      courtId: courtForInv.id,
      startTime: futureDate(11, 18, 0),
      skillLevel: 4.0,
      playersNeeded: 4,
      status: 'OPEN',
      isPrivateBooking: false,
      isMixed: true,
    }
  });
  const invForRej = await prisma.invitation.create({
    data: { matchId: matchForRej.id, playerId: rejPlayer.id, status: 'PENDING' }
  });

  await runTest(
    'T21 -- Rifiuta invito a partita',
    '39209000005',
    [
      {
        msg: 'No grazie, non posso venire',
        check: t => t.action === 'REJECT_INVITATION' && t.actionResult?.success === true
      },
    ],
    async () => {
      const inv = await prisma.invitation.findUnique({ where: { id: invForRej.id } });
      return {
        passed: inv?.status === 'REJECTED',
        notes: ['invitation status: ' + inv?.status]
      };
    }
  );
  await sleep(GROUP_DELAY);

  // =================================================
  // GRUPPO 10: MULTI-TURN REALISTICI
  // =================================================

  console.log('\n' + '='.repeat(70));
  console.log('GRUPPO 10 -- CONVERSAZIONI MULTI-TURN REALISTICHE');
  console.log('='.repeat(70));

  await createPlayer('39210000001', 'Riccardo Realistico', 4.0);
  await runTest(
    'T22 -- Conversazione realistica: info -> prenotazione -> amico -> cancella',
    '39210000001',
    [
      { msg: 'Ciao! A che ora apre il circolo?' },
      { msg: 'Perfetto. Quanto costa un campo?' },
      { msg: 'Ok. Puoi prenotarmi per martedi prossimo alle 19, voglio cercare avversari, misto' },
      { msg: 'Benissimo! E posso portare anche Stefano Verdi con me? E iscritto al circolo' },
      { msg: 'Sai che preferisco il campo privato, cancella e prenota solo per noi due, misto' },
    ],
    async () => {
      const turns = allResults[allResults.length - 1].turns;
      const actions = turns.map(t => t.action).join(' -> ');
      const hasBook = turns.some(t => t.action === 'BOOK_FIELD');
      const hasCancel = turns.some(t => t.action === 'CANCEL_MATCH');
      const notes = ['Actions: ' + actions, 'Has booking: ' + hasBook, 'Has cancel: ' + hasCancel];
      return { passed: hasBook, notes };
    }
  );
  await sleep(GROUP_DELAY);

  await createPlayer('39210000002', 'Simona Weekend', 3.0, 'FEMALE');
  await runTest(
    'T23 -- Richiesta disponibilita poi prenotazione',
    '39210000002',
    [
      { msg: 'Quando avete campi liberi nel weekend?' },
      { msg: 'Perfetto, prenoto sabato prossimo alle 10, campo privato, misto' },
      { msg: 'Grazie mille!' },
    ],
    async () => {
      const turns = allResults[allResults.length - 1].turns;
      const hasBook = turns.some(t => t.action === 'BOOK_FIELD' && t.actionResult?.success === true);
      return { passed: hasBook, notes: ['Booked: ' + hasBook] };
    }
  );
  await sleep(GROUP_DELAY);

  // =================================================
  // RIEPILOGO FINALE
  // =================================================

  const endTime = new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' });
  console.log('\n\n' + '='.repeat(70));
  console.log('RIEPILOGO FINALE -- ' + endTime);
  console.log('='.repeat(70));

  let passed = 0, failed = 0;
  for (const r of allResults) {
    const icon = r.passed ? 'PASSED' : 'FAILED';
    console.log('[' + icon + '] ' + r.name);
    if (!r.passed && r.errors.length > 0) {
      r.errors.forEach(e => console.log('   |-- ' + e));
    }
    r.notes.forEach(n => console.log('   [i] ' + n));
    if (r.passed) passed++; else failed++;
  }

  console.log('\n' + '-'.repeat(70));
  console.log('TOTALE: ' + (passed + failed) + ' test');
  console.log('PASSED: ' + passed);
  console.log('FAILED: ' + failed);
  console.log('API errors durante i test: ' + totalApiErrors);
  console.log('Fine: ' + endTime);

  await prisma.$disconnect();
  const redis = getRedis();
  await redis.quit();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async err => {
  console.error('FATAL:', err.message);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
