import dotenv from "dotenv";
dotenv.config();
import { prisma } from "../services/db";
import { buildBrainContext, callBrain, executeAction } from "../services/brain";
import { getRedis } from "../services/queue";

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

const results: TestResult[] = [];
const DELAY_BETWEEN_TURNS = 2500;
const DELAY_BETWEEN_GROUPS = 12000;

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

const CLUB_ID = process.env.CLUB_ID!;
if (!CLUB_ID) throw new Error("CLUB_ID not set in env");

async function runConversation(
  testName: string,
  phone: string,
  turns: Array<{ msg: string; expectedAction?: string; expectedInMessage?: string[]; notInMessage?: string[] }>,
  checkFn?: (turns: TurnResult[]) => Promise<{ passed: boolean; notes: string[] }>
): Promise<TestResult> {
  const result: TestResult = { name: testName, passed: true, turns: [], notes: [], errors: [] };
  console.log("\n" + "=".repeat(60));
  console.log("TEST: " + testName);
  console.log("=".repeat(60));

  const jid = phone + "@s.whatsapp.net";

  for (const turn of turns) {
    await sleep(DELAY_BETWEEN_TURNS);
    try {
      const ctx = await buildBrainContext(jid, phone);
      const brainResult = await callBrain(ctx, turn.msg);
      console.log("\nUSER: " + turn.msg);
      console.log("BOT [" + brainResult.action + "]: " + brainResult.message);
      if (brainResult.params && Object.keys(brainResult.params).length > 0) {
        console.log("   params: " + JSON.stringify(brainResult.params));
      }

      let actionResult: any;
      if (brainResult.action !== "NONE") {
        const ctx2 = await buildBrainContext(jid, phone);
        actionResult = await executeAction(brainResult.action as any, brainResult.params, ctx2.player, ctx2.club, phone);
        console.log("   -> executeAction: " + JSON.stringify(actionResult));
      }

      const turnResult: TurnResult = {
        userMsg: turn.msg,
        botMsg: brainResult.message,
        action: brainResult.action,
        params: brainResult.params,
        actionResult,
      };
      result.turns.push(turnResult);

      if (turn.expectedAction && brainResult.action !== turn.expectedAction) {
        result.errors.push("Turn [" + turn.msg.substring(0,40) + "]: expected " + turn.expectedAction + ", got " + brainResult.action);
        result.passed = false;
      }
      if (turn.expectedInMessage) {
        for (const kw of turn.expectedInMessage) {
          if (!brainResult.message.toLowerCase().includes(kw.toLowerCase())) {
            result.errors.push("Turn [" + turn.msg.substring(0,40) + "]: expected keyword \"" + kw + "\" in message");
            result.passed = false;
          }
        }
      }
      if (turn.notInMessage) {
        for (const kw of turn.notInMessage) {
          if (brainResult.message.toLowerCase().includes(kw.toLowerCase())) {
            result.errors.push("Turn [" + turn.msg.substring(0,40) + "]: should NOT contain \"" + kw + "\"");
            result.passed = false;
          }
        }
      }
    } catch (err: any) {
      console.error("   EXCEPTION: " + err?.message);
      result.errors.push("Turn [" + turn.msg.substring(0,40) + "]: exception: " + err?.message);
      result.passed = false;
      result.turns.push({ userMsg: turn.msg, botMsg: "", action: "ERROR", params: {}, error: err?.message });
    }
  }

  if (checkFn) {
    try {
      const check = await checkFn(result.turns);
      if (!check.passed) result.passed = false;
      result.notes.push(...check.notes);
    } catch (err: any) {
      result.errors.push("checkFn exception: " + err?.message);
      result.passed = false;
    }
  }

  console.log("\n" + (result.passed ? "PASSED" : "FAILED"));
  if (result.errors.length > 0) console.log("Errors:\n" + result.errors.map(e => "  ERR: " + e).join("\n"));
  if (result.notes.length > 0) console.log("Notes:\n" + result.notes.map(n => "  INFO: " + n).join("\n"));
  results.push(result);
  return result;
}

async function cleanupAndCreatePlayer(phone: string, name: string, skillLevel: number, gender: "MALE"|"FEMALE" = "MALE") {
  const existing = await prisma.player.findFirst({ where: { phoneNumber: phone, clubId: CLUB_ID } });
  if (existing) {
    await prisma.invitation.deleteMany({ where: { playerId: existing.id } });
    await prisma.matchPlayer.deleteMany({ where: { playerId: existing.id } });
    await prisma.player.delete({ where: { id: existing.id } });
  }
  return prisma.player.create({
    data: { phoneNumber: phone, name, clubId: CLUB_ID, skillLevel, gender, active: true }
  });
}

const PHONES = {
  NEW_USER:       "39111000001",
  PRIVATE:        "39111000002",
  MATCHMAKING:    "39111000003",
  SKILL_ZERO:     "39111000004",
  CANCEL:         "39111000005",
  RESCHEDULE:     "39111000006",
  DOUBLE_BOOKING: "39111000007",
  MULTI1:         "39111000010",
  MULTI2:         "39111000011",
  MULTI3:         "39111000012",
  MULTI4:         "39111000013",
  FRIEND:         "39111000020",
  INVITE_TARGET:  "39111000021",
  OCCUPIED_SETUP: "39111000030",
  OCCUPIED_TEST:  "39111000031",
  COVERED:        "39111000040",
  AMBIGUOUS:      "39111000060",
  OPTOUT:         "39111000070",
  FAQ:            "39111000080",
  INV_ACCEPT:     "39111000090",
  MULTI_PRIVATE:  "39111000100",
};

async function main() {
  console.log("\nCOMPREHENSIVE PADEL BOT TEST SUITE");
  console.log("Started: " + new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" }));
  console.log("CLUB_ID: " + CLUB_ID);
  console.log("=".repeat(60));

  const club = await prisma.club.findUnique({
    where: { id: CLUB_ID },
    include: { courts: { where: { active: true } } }
  });
  if (!club) { console.error("Club not found for CLUB_ID=" + CLUB_ID); process.exit(1); }
  console.log("Club: " + club.name);
  console.log("Courts: " + club.courts.map((c: any) => c.name + (c.isCovered ? "(cop)" : "(sch)")).join(", "));
  const now = new Date();

  // ── T1: Nuovo utente non registrato ──
  const existing1 = await prisma.player.findFirst({ where: { phoneNumber: PHONES.NEW_USER, clubId: CLUB_ID } });
  if (existing1) {
    await prisma.invitation.deleteMany({ where: { playerId: existing1.id } });
    await prisma.matchPlayer.deleteMany({ where: { playerId: existing1.id } });
    await prisma.player.delete({ where: { id: existing1.id } });
  }

  await runConversation(
    "T1 - Utente non registrato: registrazione naturale",
    PHONES.NEW_USER,
    [
      { msg: "Ciao! Quanto costa giocare?", expectedAction: "NONE" },
      { msg: "Mi chiamo Marco Rossi, sono nuovo del circolo" },
      { msg: "Rossi e il mio cognome. Marco Rossi, mi sono gia presentato" },
    ],
    async (turns) => {
      const player = await prisma.player.findFirst({ where: { phoneNumber: PHONES.NEW_USER, clubId: CLUB_ID } });
      const notes = ["Player in DB: " + (player ? player.name + " | skill=" + player.skillLevel : "NOT FOUND")];
      const registerTurn = turns.find(t => t.action === "REGISTER_PLAYER");
      if (registerTurn) notes.push("REGISTER_PLAYER at turn: \"" + registerTurn.userMsg.substring(0,40) + "\" params=" + JSON.stringify(registerTurn.params));
      return { passed: !!player, notes };
    }
  );
  await sleep(DELAY_BETWEEN_GROUPS);

  // ── T2: Prenotazione privata ──
  await cleanupAndCreatePlayer(PHONES.PRIVATE, "Davide Ferrari", 3.5);
  await runConversation(
    "T2 - Prenotazione privata esplicita",
    PHONES.PRIVATE,
    [
      { msg: "Voglio prenotare domani alle 10 solo per me e un amico, campo privato misto", expectedAction: "BOOK_FIELD" },
    ],
    async (turns) => {
      const bookTurn = turns.find(t => t.action === "BOOK_FIELD");
      const matchId = bookTurn?.actionResult?.matchId;
      if (!matchId) return { passed: false, notes: ["No matchId. action=" + bookTurn?.action + " params=" + JSON.stringify(bookTurn?.params) + " result=" + JSON.stringify(bookTurn?.actionResult)] };
      const match = await prisma.match.findUnique({ where: { id: matchId } });
      const notes = ["Match status=" + match?.status + " isPrivate=" + match?.isPrivateBooking];
      return { passed: match?.status === "LOCKED" && match?.isPrivateBooking === true, notes };
    }
  );
  await sleep(DELAY_BETWEEN_GROUPS);

  // ── T3: Matchmaking esplicito ──
  await cleanupAndCreatePlayer(PHONES.MATCHMAKING, "Luca Bianchi", 4.0);
  await runConversation(
    "T3 - Matchmaking esplicito (cerca avversari)",
    PHONES.MATCHMAKING,
    [
      { msg: "Voglio giocare venerdi alle 18, cercatemi degli avversari, misto ok", expectedAction: "BOOK_FIELD" },
    ],
    async (turns) => {
      const bookTurn = turns.find(t => t.action === "BOOK_FIELD");
      const matchId = bookTurn?.actionResult?.matchId;
      if (!matchId) return { passed: false, notes: ["No matchId. action=" + bookTurn?.action + " params=" + JSON.stringify(bookTurn?.params) + " result=" + JSON.stringify(bookTurn?.actionResult)] };
      const match = await prisma.match.findUnique({ where: { id: matchId } });
      const notes = ["Match status=" + match?.status + " isPrivate=" + match?.isPrivateBooking];
      return { passed: match?.status === "OPEN" && match?.isPrivateBooking === false, notes };
    }
  );
  await sleep(DELAY_BETWEEN_GROUPS);

  // ── T4: Skill <= 0 ──
  await cleanupAndCreatePlayer(PHONES.SKILL_ZERO, "Gianni Nessuno", -1);
  await runConversation(
    "T4 - Skill <= 0: matchmaking bloccato",
    PHONES.SKILL_ZERO,
    [
      { msg: "Voglio giocare domani alle 11, cercatemi avversari, misto" },
    ],
    async (turns) => {
      const bookTurn = turns.find(t => t.action === "BOOK_FIELD");
      const t = turns[0];
      const params = bookTurn?.params;
      const actionResult = bookTurn?.actionResult;
      const notes = ["action=" + t.action + " | private=" + params?.private + " | result=" + JSON.stringify(actionResult)];
      if (!bookTurn) {
        notes.push("Brain returned NONE - acceptable for skill pending");
        return { passed: t.action === "NONE", notes };
      }
      const isCorrect = params?.private === true || actionResult?.errorMessage === "SKILL_TEST_REQUIRED";
      if (isCorrect && params?.private === true && actionResult?.matchId) {
        const match = await prisma.match.findUnique({ where: { id: actionResult.matchId } });
        notes.push("Match status: " + match?.status);
        return { passed: match?.status === "LOCKED", notes };
      }
      return { passed: isCorrect, notes };
    }
  );
  await sleep(DELAY_BETWEEN_GROUPS);

  // ── T5: Prenotazione poi cancellazione ──
  await cleanupAndCreatePlayer(PHONES.CANCEL, "Paolo Cancel", 3.0);
  await runConversation(
    "T5 - Prenotazione poi cancellazione",
    PHONES.CANCEL,
    [
      { msg: "Prenota per sabato alle 16, campo privato misto", expectedAction: "BOOK_FIELD" },
      { msg: "Scusa devo cancellare la partita", expectedAction: "CANCEL_MATCH" },
    ],
    async (turns) => {
      const bookTurn = turns.find(t => t.action === "BOOK_FIELD");
      const cancelTurn = turns.find(t => t.action === "CANCEL_MATCH");
      const cancelMatchId = bookTurn?.actionResult?.matchId ?? "";
      const notes = ["booked matchId=" + cancelMatchId + " | cancel result=" + JSON.stringify(cancelTurn?.actionResult)];
      if (cancelMatchId) {
        const match = await prisma.match.findUnique({ where: { id: cancelMatchId } });
        const mps = await prisma.matchPlayer.findMany({ where: { matchId: cancelMatchId, leftAt: null } });
        notes.push("match status after cancel: " + match?.status + " | active players: " + mps.length);
      }
      return { passed: cancelTurn?.actionResult?.success === true, notes };
    }
  );
  await sleep(DELAY_BETWEEN_GROUPS);

  // ── T6: Slot completamente occupato ──
  await cleanupAndCreatePlayer(PHONES.OCCUPIED_SETUP, "Marco Occupato", 4.5);
  await cleanupAndCreatePlayer(PHONES.OCCUPIED_TEST, "Sara Occupata", 4.5);
  const mondaySlot = new Date(now);
  mondaySlot.setDate(now.getDate() + ((8 - now.getDay()) % 7 || 7));
  mondaySlot.setHours(15, 0, 0, 0);
  for (const court of club.courts) {
    const existingMatch = await prisma.match.findFirst({ where: { courtId: court.id, startTime: mondaySlot } });
    if (!existingMatch) {
      await prisma.match.create({
        data: { clubId: CLUB_ID, courtId: court.id, startTime: mondaySlot, skillLevel: 4.0, playersNeeded: 4, status: "OPEN", isPrivateBooking: false, isMixed: true }
      });
    }
  }
  console.log("Setup T6: filled " + club.courts.length + " courts at " + mondaySlot.toLocaleString("it-IT", { timeZone: "Europe/Rome" }));
  await runConversation(
    "T6 - Slot completamente occupato: bot gestisce redirect",
    PHONES.OCCUPIED_TEST,
    [
      { msg: "Voglio prenotare lunedi alle 15, cerca avversari, misto" },
    ],
    async (turns) => {
      const t = turns[0];
      const notes = ["action=" + t.action + " | result=" + JSON.stringify(t.actionResult) + " | msg: \"" + t.botMsg?.substring(0, 120) + "\""];
      const correctBehavior = t.action === "NONE" ||
        (t.action === "BOOK_FIELD" && (t.actionResult?.errorMessage === "ALL_COURTS_TAKEN" || !t.actionResult?.matchId));
      return { passed: correctBehavior, notes };
    }
  );
  await sleep(DELAY_BETWEEN_GROUPS);

  // ── T7: Rescheduling ──
  await cleanupAndCreatePlayer(PHONES.RESCHEDULE, "Elena Reschedule", 3.5);
  await runConversation(
    "T7 - Prenotazione + spostamento",
    PHONES.RESCHEDULE,
    [
      { msg: "Prenota per domani alle 9, campo privato, misto", expectedAction: "BOOK_FIELD" },
      { msg: "Aspetta, voglio spostarlo a domenica alle 10" },
      { msg: "Si, sposta quella li" },
    ],
    async (turns) => {
      const rescheduleTurn = turns.find(t => t.action === "RESCHEDULE_MATCH");
      const bookTurn = turns.find(t => t.action === "BOOK_FIELD");
      const notes = [
        "actions: " + turns.map(t => t.action).join(", "),
        "BOOK_FIELD matchId: " + (bookTurn?.actionResult?.matchId ?? "none"),
        "RESCHEDULE found: " + !!rescheduleTurn,
      ];
      if (!rescheduleTurn) {
        return { passed: false, notes };
      }
      if (rescheduleTurn.actionResult?.matchId) {
        const match = await prisma.match.findUnique({ where: { id: rescheduleTurn.actionResult.matchId } });
        notes.push("new match: status=" + match?.status + " time=" + match?.startTime?.toLocaleString("it-IT", { timeZone: "Europe/Rome" }));
      }
      return { passed: rescheduleTurn.actionResult?.success === true, notes };
    }
  );
  await sleep(DELAY_BETWEEN_GROUPS);

  // ── T8: Doppia prenotazione stesso slot ──
  await cleanupAndCreatePlayer(PHONES.DOUBLE_BOOKING, "Roberto Doppio", 4.0);
  await runConversation(
    "T8 - Doppia prenotazione stesso orario: bloccata",
    PHONES.DOUBLE_BOOKING,
    [
      { msg: "Prenota sabato alle 11, cerca avversari, misto", expectedAction: "BOOK_FIELD" },
      { msg: "Prenota sabato alle 11 di nuovo, cerca avversari, misto" },
    ],
    async (turns) => {
      const firstBook = turns[0];
      const secondBook = turns[1];
      const notes = [
        "first: action=" + firstBook?.action + " matchId=" + firstBook?.actionResult?.matchId,
        "second: action=" + secondBook?.action + " result=" + JSON.stringify(secondBook?.actionResult)
      ];
      if (secondBook?.action === "NONE") {
        const msgBlocked = (secondBook?.botMsg?.toLowerCase().includes("gia") ||
          secondBook?.botMsg?.toLowerCase().includes("prenotazione") ||
          secondBook?.botMsg?.toLowerCase().includes("stessa"));
        notes.push("NONE action - msg mention duplicate: " + msgBlocked + " | msg: \"" + secondBook?.botMsg?.substring(0,80) + "\"");
        return { passed: msgBlocked, notes };
      }
      if (secondBook?.action === "BOOK_FIELD") {
        const isError = secondBook?.actionResult?.success === false;
        const firstMatch = firstBook?.actionResult?.matchId;
        const secondMatch = secondBook?.actionResult?.matchId;
        const joinedSame = !!(secondMatch && secondMatch === firstMatch);
        notes.push("isError=" + isError + " joinedSame=" + joinedSame);
        return { passed: isError || joinedSame, notes };
      }
      return { passed: false, notes };
    }
  );
  await sleep(DELAY_BETWEEN_GROUPS);

  // ── T9: INVITE_PREFERRED ──
  await cleanupAndCreatePlayer(PHONES.FRIEND, "Claudio Amico", 3.5);
  await cleanupAndCreatePlayer(PHONES.INVITE_TARGET, "Stefano Target", 3.5);
  await runConversation(
    "T9 - INVITE_PREFERRED: invita amico specifico nel matchmaking",
    PHONES.FRIEND,
    [
      { msg: "Voglio giocare giovedi alle 20, cerca avversari ma voglio Stefano Target in squadra, misto" },
    ],
    async (turns) => {
      const notes: string[] = [];
      for (const t of turns) {
        notes.push("action=" + t.action + " params=" + JSON.stringify(t.params) + " result=" + JSON.stringify(t.actionResult));
      }
      const hasBook = turns.some(t => t.action === "BOOK_FIELD");
      notes.push("BOOK_FIELD=" + hasBook);
      return { passed: hasBook, notes };
    }
  );
  await sleep(DELAY_BETWEEN_GROUPS);

  // ── T10: 4 giocatori che si uniscono ──
  console.log("\n" + "=".repeat(60));
  console.log("TEST: T10 - 4 giocatori che si uniscono (matchmaking completo)");
  console.log("=".repeat(60));
  const p1 = await cleanupAndCreatePlayer(PHONES.MULTI1, "Alice Quattro", 3.5, "FEMALE");
  const p2 = await cleanupAndCreatePlayer(PHONES.MULTI2, "Bruno Quattro", 3.5);
  const p3 = await cleanupAndCreatePlayer(PHONES.MULTI3, "Carla Quattro", 3.5, "FEMALE");
  const p4 = await cleanupAndCreatePlayer(PHONES.MULTI4, "Diego Quattro", 3.5);
  const t10result: TestResult = { name: "T10 - 4 giocatori che si uniscono", passed: true, turns: [], notes: [], errors: [] };
  try {
    const jid1 = PHONES.MULTI1 + "@s.whatsapp.net";
    const ctx1 = await buildBrainContext(jid1, PHONES.MULTI1);
    const brain1 = await callBrain(ctx1, "Voglio giocare mercoledi alle 19, cerca avversari, misto");
    console.log("\nAlice: [" + brain1.action + "] " + brain1.message);
    const ctx1b = await buildBrainContext(jid1, PHONES.MULTI1);
    const r1 = await executeAction(brain1.action as any, brain1.params, ctx1b.player, ctx1b.club, PHONES.MULTI1);
    const matchId = r1.matchId;
    console.log("   -> matchId: " + matchId + " | result: " + JSON.stringify(r1));
    if (!matchId) {
      t10result.passed = false;
      t10result.errors.push("P1 did not create match. action=" + brain1.action + " params=" + JSON.stringify(brain1.params) + " result=" + JSON.stringify(r1));
    } else {
      for (const [idx, p] of [[2, p2], [3, p3], [4, p4]] as [number, typeof p2][]) {
        await sleep(1000);
        await prisma.invitation.create({ data: { matchId, playerId: p.id, status: "PENDING" } });
        const inv = await prisma.invitation.findFirst({ where: { matchId, playerId: p.id } });
        const clubX = await prisma.club.findUnique({ where: { id: CLUB_ID } });
        const acceptResult = await executeAction("ACCEPT_INVITATION", { invitationId: inv!.id }, p, clubX, p.phoneNumber);
        console.log("   P" + idx + " (" + p.name + ") accept: " + JSON.stringify(acceptResult));
        t10result.turns.push({ userMsg: "P" + idx + " accepts", botMsg: "", action: "ACCEPT_INVITATION", params: { invitationId: inv!.id }, actionResult: acceptResult });
      }
      const finalMatch = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: { where: { leftAt: null }, include: { player: true } } }
      });
      t10result.notes.push("Final match status: " + finalMatch?.status);
      t10result.notes.push("Players (" + (finalMatch?.MatchPlayer.length ?? 0) + "): " + finalMatch?.MatchPlayer.map((mp: any) => mp.player.name).join(", "));
      t10result.passed = finalMatch?.status === "LOCKED" && (finalMatch?.MatchPlayer.length ?? 0) === 4;
      if (!t10result.passed) t10result.errors.push("Expected LOCKED+4 players, got status=" + finalMatch?.status + " players=" + finalMatch?.MatchPlayer.length);
    }
  } catch (err: any) {
    t10result.errors.push(err?.message);
    t10result.passed = false;
  }
  console.log("\n" + (t10result.passed ? "PASSED" : "FAILED"));
  if (t10result.notes.length) console.log("Notes:\n" + t10result.notes.map((n: string) => "  INFO: " + n).join("\n"));
  if (t10result.errors.length) console.log("Errors:\n" + t10result.errors.map((e: string) => "  ERR: " + e).join("\n"));
  results.push(t10result);
  await sleep(DELAY_BETWEEN_GROUPS);

  // ── T11: Intento ambiguo ──
  await cleanupAndCreatePlayer(PHONES.AMBIGUOUS, "Filippo Ambiguo", 4.0);
  await runConversation(
    "T11 - Intento ambiguo: bot chiede privata o matchmaking",
    PHONES.AMBIGUOUS,
    [
      { msg: "Voglio prenotare domani alle 14", expectedAction: "NONE" },
    ],
    async (turns) => {
      const t = turns[0];
      const notes = ["action=" + t.action + " | msg: \"" + t.botMsg?.substring(0, 150) + "\""];
      return { passed: t.action === "NONE", notes };
    }
  );
  await sleep(DELAY_BETWEEN_GROUPS);

  // ── T12: OPT_OUT ──
  await cleanupAndCreatePlayer(PHONES.OPTOUT, "Giada OptOut", 3.0);
  await runConversation(
    "T12 - OPT_OUT: non voglio piu messaggi",
    PHONES.OPTOUT,
    [
      { msg: "Non voglio piu ricevere messaggi, rimuovimi dalla lista" },
    ],
    async (turns) => {
      const t = turns[0];
      const player = await prisma.player.findFirst({ where: { phoneNumber: PHONES.OPTOUT, clubId: CLUB_ID } });
      const notes = ["action=" + t.action + " | player.active=" + player?.active];
      return { passed: t.action === "OPT_OUT" || player?.active === false, notes };
    }
  );
  await sleep(DELAY_BETWEEN_GROUPS);

  // ── T13: FAQ ──
  await cleanupAndCreatePlayer(PHONES.FAQ, "Tizio FAQ", 3.0);
  await runConversation(
    "T13 - FAQ: domanda assicurazione infortuni",
    PHONES.FAQ,
    [
      { msg: "Avete l assicurazione infortuni?" },
    ],
    async (turns) => {
      const t = turns[0];
      const notes = ["action=" + t.action + " | msg: \"" + t.botMsg?.substring(0, 120) + "\""];
      return { passed: t.action === "FAQ_REQUEST" || t.action === "NONE", notes };
    }
  );
  await sleep(DELAY_BETWEEN_GROUPS);

  // ── T14: Accetta invito ──
  const invPlayer = await cleanupAndCreatePlayer(PHONES.INV_ACCEPT, "Ivan Invitato", 3.5);
  const clubForInv = await prisma.club.findUnique({ where: { id: CLUB_ID }, include: { courts: true } });
  const invTime = new Date();
  invTime.setDate(invTime.getDate() + 5);
  invTime.setHours(17, 0, 0, 0);
  const invMatch = await prisma.match.create({
    data: { clubId: CLUB_ID, courtId: (clubForInv as any).courts[0].id, startTime: invTime, skillLevel: 3.5, playersNeeded: 4, status: "OPEN", isPrivateBooking: false, isMixed: true }
  });
  const invitation = await prisma.invitation.create({
    data: { matchId: invMatch.id, playerId: invPlayer.id, status: "PENDING" }
  });
  console.log("\nSetup T14: invitation id=" + invitation.id + " match=" + invMatch.id);
  await runConversation(
    "T14 - Accetta invito a partita",
    PHONES.INV_ACCEPT,
    [
      { msg: "Si confermo, ci sono!" },
    ],
    async (turns) => {
      const t = turns[0];
      const inv = await prisma.invitation.findUnique({ where: { id: invitation.id } });
      const notes = ["action=" + t.action + " | inv.status=" + inv?.status + " | result=" + JSON.stringify(t.actionResult)];
      return { passed: t.action === "ACCEPT_INVITATION" && t.actionResult?.success === true, notes };
    }
  );
  await sleep(DELAY_BETWEEN_GROUPS);

  // ── T15: Campo coperto quando scoperti occupati ──
  await cleanupAndCreatePlayer(PHONES.COVERED, "Mirko Coperto", 4.0);
  const openCourts = club.courts.filter((c: any) => !c.isCovered);
  if (openCourts.length > 0) {
    const tuesdaySlot = new Date(now);
    tuesdaySlot.setDate(now.getDate() + ((9 - now.getDay()) % 7 || 7));
    tuesdaySlot.setHours(16, 0, 0, 0);
    for (const court of openCourts) {
      const existing = await prisma.match.findFirst({ where: { courtId: court.id, startTime: tuesdaySlot } });
      if (!existing) {
        await prisma.match.create({
          data: { clubId: CLUB_ID, courtId: court.id, startTime: tuesdaySlot, skillLevel: 4.0, playersNeeded: 4, status: "OPEN", isPrivateBooking: false, isMixed: true }
        });
      }
    }
    console.log("Setup T15: filled " + openCourts.length + " open courts at " + tuesdaySlot.toLocaleString("it-IT", { timeZone: "Europe/Rome" }));
    await runConversation(
      "T15 - Solo coperto disponibile: bot chiede conferma",
      PHONES.COVERED,
      [
        { msg: "Prenota martedi alle 16, campo privato, misto" },
      ],
      async (turns) => {
        const t = turns[0];
        const notes = ["action=" + t.action + " | result=" + JSON.stringify(t.actionResult) + " | msg: \"" + t.botMsg?.substring(0, 150) + "\""];
        const correctBehavior =
          t.actionResult?.errorMessage === "ONLY_COVERED_AVAILABLE" ||
          (t.action === "NONE" && (t.botMsg.toLowerCase().includes("copert") || t.botMsg.toLowerCase().includes("chiuso") || t.botMsg.toLowerCase().includes("indoor"))) ||
          (t.action === "BOOK_FIELD" && t.actionResult?.errorMessage === "ONLY_COVERED_AVAILABLE");
        return { passed: correctBehavior, notes };
      }
    );
  } else {
    const r: TestResult = { name: "T15 - Solo coperto (SKIPPED: all courts covered)", passed: true, turns: [], notes: ["Skipped"], errors: [] };
    results.push(r);
    console.log("\nT15 SKIPPED");
  }
  await sleep(DELAY_BETWEEN_GROUPS);

  // ── T16: Multi-turn privata poi matchmaking ──
  await cleanupAndCreatePlayer(PHONES.MULTI_PRIVATE, "Vera Multi", 4.5);
  await runConversation(
    "T16 - Multi-turn: prima privata poi matchmaking",
    PHONES.MULTI_PRIVATE,
    [
      { msg: "Prenota venerdi alle 18, campo solo per me e mia sorella, misto", expectedAction: "BOOK_FIELD" },
      { msg: "Bene! E per lunedi alle 20 cercami degli avversari invece, misto", expectedAction: "BOOK_FIELD" },
    ],
    async (turns) => {
      const t1 = turns[0];
      const t2 = turns[1];
      const notes: string[] = [];
      let privateOk = false, matchmakingOk = false;
      if (t1.actionResult?.matchId) {
        const m = await prisma.match.findUnique({ where: { id: t1.actionResult.matchId } });
        notes.push("First: status=" + m?.status + " private=" + m?.isPrivateBooking);
        privateOk = m?.status === "LOCKED" && m?.isPrivateBooking === true;
      } else {
        notes.push("First: no matchId. action=" + t1.action + " result=" + JSON.stringify(t1.actionResult));
      }
      if (t2.actionResult?.matchId) {
        const m = await prisma.match.findUnique({ where: { id: t2.actionResult.matchId } });
        notes.push("Second: status=" + m?.status + " private=" + m?.isPrivateBooking);
        matchmakingOk = m?.status === "OPEN" && m?.isPrivateBooking === false;
      } else {
        notes.push("Second: no matchId. action=" + t2.action + " result=" + JSON.stringify(t2.actionResult));
      }
      return { passed: privateOk && matchmakingOk, notes };
    }
  );

  // ── RIEPILOGO FINALE ──
  console.log("\n\n" + "#".repeat(60));
  console.log("RIEPILOGO FINALE TEST");
  console.log("#".repeat(60));
  let passed = 0, failed = 0;
  for (const r of results) {
    const icon = r.passed ? "PASSED" : "FAILED";
    console.log("[" + icon + "] " + r.name);
    if (!r.passed) {
      for (const e of r.errors) console.log("       ERR: " + e);
      failed++;
    } else {
      passed++;
    }
    for (const n of r.notes) console.log("       INFO: " + n);
  }
  console.log("\n" + "-".repeat(60));
  console.log("TOTALE: " + (passed + failed) + " test | PASSED: " + passed + " | FAILED: " + failed);
  console.log("Completato: " + new Date().toLocaleString("it-IT", { timeZone: "Europe/Rome" }));
  await prisma.$disconnect();
  const redis = getRedis();
  await redis.quit();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("FATAL:", err);
  await prisma.$disconnect();
  process.exit(1);
});
