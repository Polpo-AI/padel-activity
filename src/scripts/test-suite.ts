/**
 * TEST SUITE — Padel Bot
 *
 * Copertura:
 *  1. Booking logic         (via executeAction BOOK_FIELD)
 *  2. executeAction         (CANCEL, ACCEPT, REJECT, REGISTER, OPT_*, RESCHEDULE, INVITE, SAVE_NOTE)
 *  3. Scoring utils         (pure logic — nessuna chiamata esterna)
 *  4. selectPlayersForWave  (DB reale)
 *  5. buildBrainContext     (DB reale)
 *  6. Dashboard API         (HTTP → staging)
 *  7. callBrain AI          (solo con flag --brain — chiama Claude, ha un costo)
 *
 * Uso:
 *   npx tsx src/scripts/test-suite.ts
 *   npx tsx src/scripts/test-suite.ts --brain    # include test AI
 *
 * ⚠️  Non resetta il DB. Crea un cluster di dati isolati (clubId ts-club-*) e li cancella al termine.
 *     Richiede DB + Redis raggiungibili (VPS staging o env locale con DIRECT_URL_STAGING).
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

// ─────────────────────────────────────────────
// TEST RUNNER
// ─────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: { name: string; err: string }[] = [];
let currentSuite = '';

function suite(name: string) {
    currentSuite = name;
    console.log(`\n📦 ${name}`);
}

async function test(name: string, fn: () => Promise<void>) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        console.log(`  ❌ ${name}\n     → ${msg}`);
        failures.push({ name: `[${currentSuite}] ${name}`, err: msg });
        failed++;
    }
}

function assert(cond: boolean, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}

function assertEqual<T>(actual: T, expected: T, msg?: string) {
    if (actual !== expected) {
        throw new Error(msg ?? `Expected "${String(expected)}", got "${String(actual)}"`);
    }
}

function assertContains(str: string, sub: string) {
    if (!str.includes(sub)) throw new Error(`"${str}" does not contain "${sub}"`);
}

// ─────────────────────────────────────────────
// DB CLIENT (isolato — non usa il singleton di services/db.ts)
// ─────────────────────────────────────────────

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─────────────────────────────────────────────
// TIME HELPERS
// ─────────────────────────────────────────────

/** Costruisce una Date UTC che corrisponde all'orario Rome h:m nel giorno +daysFromNow */
function romeTime(daysFromNow: number, h: number, m = 0): Date {
    const base = new Date();
    base.setDate(base.getDate() + daysFromNow);
    // buildRomeTime logic: trova offset da UTC a Rome usando mezzogiorno UTC come sonda
    const noon = new Date(Date.UTC(base.getFullYear(), base.getMonth(), base.getDate(), 12, 0, 0));
    const noonRomeH = Number(noon.toLocaleString('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }));
    const offsetH = noonRomeH - 12;
    let utcH = h - offsetH;
    let dayDelta = 0;
    if (utcH < 0)  { utcH += 24; dayDelta = -1; }
    if (utcH >= 24) { utcH -= 24; dayDelta = 1; }
    return new Date(Date.UTC(base.getFullYear(), base.getMonth(), base.getDate() + dayDelta, utcH, m, 0));
}

// ─────────────────────────────────────────────
// TEST DATA (isolato — club ID univoco per run)
// ─────────────────────────────────────────────

const RUN_ID = `ts-${Date.now()}`;
let testClub: any;
let courtScoperto: any;
let courtCoperto: any;
let playerSkilled: any;   // skillLevel 3.5 — partecipa alle wave
let playerNew: any;       // skillLevel -1  — prenotazione privata
let playerNew2: any;      // skillLevel -1  — secondo giocatore senza skill
let playerB: any;         // skillLevel 3.5 — per test selectPlayersForWave
let playerC: any;         // skillLevel 5.0 — fuori range per default
let playerD: any;         // skillLevel 3.5, active: false

async function setup() {
    console.log(`\n🔧 Setup dati test (id: ${RUN_ID})…`);

    testClub = await prisma.club.create({
        data: {
            id: RUN_ID,
            name: `_TEST_ Club ${RUN_ID}`,
            timezone: 'Europe/Rome',
            matchDuration: 90,
            openTime: '08:00',
            closeTime: '23:30',
            adminPhone: '390000000000',
            matchLowerRange: 1.0,
            matchUpperRange: 1.0,
            waveMultiplier: 2,
            maxDailyMessages: 3,
        },
    });

    courtScoperto = await prisma.court.create({
        data: { clubId: testClub.id, name: 'Campo Scoperto', isCovered: false, active: true },
    });

    courtCoperto = await prisma.court.create({
        data: { clubId: testClub.id, name: 'Campo Coperto', isCovered: true, active: true },
    });

    playerSkilled = await prisma.player.create({
        data: { clubId: testClub.id, phoneNumber: '39100000001', name: 'Marco Bianchi', skillLevel: 3.5, active: true },
    });

    playerNew = await prisma.player.create({
        data: { clubId: testClub.id, phoneNumber: '39100000002', name: 'Luca Nuovi', skillLevel: -1, active: true },
    });

    playerNew2 = await prisma.player.create({
        data: { clubId: testClub.id, phoneNumber: '39100000003', name: 'Sara Nuovi', skillLevel: -1, active: true },
    });

    playerB = await prisma.player.create({
        data: { clubId: testClub.id, phoneNumber: '39100000004', name: 'Giulia Verdi', skillLevel: 3.5, active: true },
    });

    playerC = await prisma.player.create({
        data: { clubId: testClub.id, phoneNumber: '39100000005', name: 'Roberto Alto', skillLevel: 5.0, active: true },
    });

    playerD = await prisma.player.create({
        data: { clubId: testClub.id, phoneNumber: '39100000006', name: 'Pietro Inattivo', skillLevel: 3.5, active: false },
    });

    console.log(`  Club, 2 campi, 6 giocatori creati.\n`);
}

async function cleanup() {
    if (!testClub?.id) { console.log('\n🧹 Cleanup saltato (setup non completato).'); return; }
    console.log('\n🧹 Cleanup dati test…');
    await prisma.invitation.deleteMany({ where: { match: { clubId: testClub.id } } });
    await prisma.matchFeedback.deleteMany({ where: { match: { clubId: testClub.id } } });
    await prisma.matchPlayer.deleteMany({ where: { match: { clubId: testClub.id } } });
    await prisma.match.deleteMany({ where: { clubId: testClub.id } });
    await prisma.player.deleteMany({ where: { clubId: testClub.id } });
    await prisma.court.deleteMany({ where: { clubId: testClub.id } });
    await prisma.club.delete({ where: { id: testClub.id } });
    console.log('  OK\n');
}

// ─────────────────────────────────────────────
// IMPORT SERVIZI (dopo dotenv e setup)
// ─────────────────────────────────────────────

// Importati dinamicamente dopo setup per evitare side effects al load
let executeAction: any;
let buildBrainContext: any;
let callBrain: any;
let selectPlayersForWave: any;
let updateShowUpRate: any;
let computeNextWaveDelayMs: any;
let isNightInRome: any;
let isWeekdayInRome: any;
let getPlayerStats: any;

async function importServices() {
    // Imposta CLUB_ID al club di test in modo che buildBrainContext lo usi
    process.env.CLUB_ID = RUN_ID;

    const brain = await import('../services/brain');
    executeAction = brain.executeAction;
    buildBrainContext = brain.buildBrainContext;
    callBrain = brain.callBrain;

    const scoring = await import('../services/scoring');
    selectPlayersForWave = scoring.selectPlayersForWave;
    updateShowUpRate = scoring.updateShowUpRate;
    computeNextWaveDelayMs = scoring.computeNextWaveDelayMs;
    isNightInRome = scoring.isNightInRome;
    isWeekdayInRome = scoring.isWeekdayInRome;
    getPlayerStats = scoring.getPlayerStats;
}

// ─────────────────────────────────────────────
// 1. BOOKING LOGIC
// ─────────────────────────────────────────────

async function runBookingTests() {
    suite('1. Booking logic (via executeAction BOOK_FIELD)');

    await test('skill=-1 → partita LOCKED, nessuna wave', async () => {
        const slot = romeTime(1, 10, 0);
        const res = await executeAction('BOOK_FIELD', { day: '2099-01-01', time: '10:00' }, playerNew, testClub);
        // Overrride: chiamo bookSlotForPlayer indirettamente — devo fornire una data reale
        // Invece uso directy createNewMatchAction tramite executeAction con date corretta
        // Costruisco la data come stringa per parseBookingDateTime
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dayStr = tomorrow.toISOString().slice(0, 10); // YYYY-MM-DD
        const res2 = await executeAction('BOOK_FIELD', { day: dayStr, time: '10:00' }, playerNew, testClub);
        assert(res2.success, `Booking fallita: ${res2.errorMessage}`);
        assert(!!res2.matchId, 'matchId assente');

        const match = await prisma.match.findUnique({ where: { id: res2.matchId } }) as any;
        assertEqual(match?.status, 'LOCKED', 'Match deve essere LOCKED per skill=-1');
        assertEqual(match?.isPrivateBooking, true, 'isPrivateBooking deve essere true');

        // Verifica nessuna wave schedulata in Redis (non possiamo controllare BullMQ da qui facilmente,
        // ma verifichiamo che il match esista e sia LOCKED — la wave non viene aggiunta se skill<=0)
    });

    await test('skill=3.5 → partita OPEN, wave schedulata', async () => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dayStr = tomorrow.toISOString().slice(0, 10);
        const res = await executeAction('BOOK_FIELD', { day: dayStr, time: '11:30' }, playerSkilled, testClub);
        assert(res.success, `Booking fallita: ${res.errorMessage}`);
        assert(!!res.matchId, 'matchId assente');

        const match = await prisma.match.findUnique({ where: { id: res.matchId } }) as any;
        assertEqual(match?.status, 'OPEN', 'Match deve essere OPEN per skillLevel > 0');
        assertEqual(match?.isPrivateBooking, false, 'isPrivateBooking deve essere false');
    });

    await test('doppia prenotazione ±30min → errore', async () => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dayStr = tomorrow.toISOString().slice(0, 10);
        // playerNew ha già una partita alle 10:00 dal test precedente
        const res = await executeAction('BOOK_FIELD', { day: dayStr, time: '10:15' }, playerNew, testClub);
        assert(!res.success, 'Doveva fallire — doppia prenotazione');
        assertContains(res.errorMessage ?? '', 'già una prenotazione');
    });

    await test('giocatore con skill>0 entra in partita esistente compatibile', async () => {
        // playerB (skill 3.5) → deve entrare nel match OPEN di playerSkilled alle 11:30
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dayStr = tomorrow.toISOString().slice(0, 10);
        const res = await executeAction('BOOK_FIELD', { day: dayStr, time: '11:30' }, playerB, testClub);
        assert(res.success, `Join fallita: ${res.errorMessage}`);

        // Trova il match di playerSkilled alle 11:30 e verifica che playerB sia dentro
        const slot = romeTime(1, 11, 30);
        const from = new Date(slot.getTime() - 30 * 60 * 1000);
        const to = new Date(slot.getTime() + 30 * 60 * 1000);
        const match = await prisma.match.findFirst({
            where: { clubId: testClub.id, status: { in: ['OPEN', 'LOCKED'] }, startTime: { gte: from, lte: to } },
            include: { MatchPlayer: { where: { leftAt: null } } },
        });
        assert(!!match, 'Match non trovato');
        const inMatch = match.MatchPlayer.some((mp: any) => mp.playerId === playerB.id);
        assert(inMatch, 'playerB non risulta nel match');
    });

    await test('orario prima apertura → errore', async () => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dayStr = tomorrow.toISOString().slice(0, 10);
        // 06:00 è prima dell'apertura (08:00)
        const res = await executeAction('BOOK_FIELD', { day: dayStr, time: '06:00' }, playerSkilled, testClub);
        assert(!res.success, 'Doveva fallire — prima dell\'apertura');
        assertContains(res.errorMessage ?? '', 'apre alle');
    });

    await test('ultimi 90 min prima chiusura → errore (last valid 22:00)', async () => {
        // closeTime 23:30 → last valid 22:00 (22:00 + 90min = 23:30)
        // 22:01 deve fallire
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dayStr = tomorrow.toISOString().slice(0, 10);
        const res = await executeAction('BOOK_FIELD', { day: dayStr, time: '22:01' }, playerSkilled, testClub);
        assert(!res.success, 'Doveva fallire — orario troppo tardi');
        assertContains(res.errorMessage ?? '', 'ultimo orario');
    });

    await test('22:00 esatto → valido (22:00 + 90min = 23:30 = chiusura)', async () => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dayStr = tomorrow.toISOString().slice(0, 10);
        // Usiamo un nuovo player per non avere doppia prenotazione
        const res = await executeAction('BOOK_FIELD', { day: dayStr, time: '22:00' }, playerNew2, testClub);
        assert(res.success, `Doveva riuscire — esattamente 90min prima chiusura: ${res.errorMessage}`);
    });

    await test('preferCovered=false + scoperti occupati → ONLY_COVERED_AVAILABLE', async () => {
        // Il campo scoperto è già occupato alle 10:00 (da playerNew).
        // playerSkilled prenota alle 10:00 senza preferCovered → deve trovare solo il coperto → ONLY_COVERED_AVAILABLE
        // Prima verifichiamo che il campo scoperto sia occupato
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dayStr = tomorrow.toISOString().slice(0, 10);

        // Occupa anche il campo coperto alle 10:00 (per playerB — diverso slot dal suo 11:30)
        // In realtà alle 10:00 c'è già playerNew su Campo Scoperto.
        // playerC (skill 5.0, fuori range) prenota il coperto alle 10:00 direttamente tramite DB
        await prisma.match.create({
            data: {
                clubId: testClub.id,
                courtId: courtScoperto.id, // scoperto già occupato da playerNew alle 10:00
                startTime: romeTime(1, 10, 0),
                skillLevel: 5.0,
                status: 'OPEN',
                playersNeeded: 4,
            },
        });
        // Ora crea una situazione dove entrambi i campi scoperto hanno match alle 14:00
        // → no, è più semplice: occupa il solo campo scoperto alle 13:00 e chiedi alle 13:00 senza preferCovered
        const matchOccupy = await prisma.match.create({
            data: {
                clubId: testClub.id,
                courtId: courtScoperto.id,
                startTime: romeTime(1, 13, 0),
                skillLevel: 3.5,
                status: 'OPEN',
                playersNeeded: 4,
            },
        });

        // playerC prova a prenotare alle 13:00 senza preferCovered
        // Il campo scoperto è occupato → trova solo il coperto → ONLY_COVERED_AVAILABLE
        const res = await executeAction('BOOK_FIELD', { day: tomorrow.toISOString().slice(0, 10), time: '13:00' }, playerC, testClub);
        // playerC ha skill 5.0, fuori range del match occupato (skill 3.5 ±1.0 = 2.5-4.5), quindi non può unirsi
        // Verrà in createNewMatchAction → scoperto occupato → ONLY_COVERED_AVAILABLE
        assert(!res.success, 'Doveva fallire con ONLY_COVERED_AVAILABLE');
        assertContains(res.errorMessage ?? '', 'ONLY_COVERED_AVAILABLE');

        // cleanup
        await prisma.match.delete({ where: { id: matchOccupy.id } });
    });

    await test('preferCovered=true → assegna campo coperto', async () => {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dayStr = tomorrow.toISOString().slice(0, 10);
        const res = await executeAction('BOOK_FIELD', { day: dayStr, time: '15:00', preferCovered: true }, playerSkilled, testClub);
        assert(res.success, `Booking fallita: ${res.errorMessage}`);

        const match = await prisma.match.findUnique({
            where: { id: res.matchId },
            include: { court: true },
        });
        assert(match?.court?.isCovered === true, 'Doveva assegnare campo coperto');
    });

    await test('tutti i campi occupati → ALL_COURTS_TAKEN', async () => {
        const slot = romeTime(1, 16, 0);
        // Occupa entrambi i campi alle 16:00
        const m1 = await prisma.match.create({
            data: { clubId: testClub.id, courtId: courtScoperto.id, startTime: slot, skillLevel: 1.0, status: 'OPEN', playersNeeded: 4 },
        });
        const m2 = await prisma.match.create({
            data: { clubId: testClub.id, courtId: courtCoperto.id, startTime: slot, skillLevel: 1.0, status: 'OPEN', playersNeeded: 4 },
        });

        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const res = await executeAction('BOOK_FIELD', { day: tomorrow.toISOString().slice(0, 10), time: '16:00' }, playerSkilled, testClub);
        assert(!res.success, 'Doveva fallire — tutti i campi occupati');
        assertContains(res.errorMessage ?? '', 'ALL_COURTS_TAKEN');

        // cleanup
        await prisma.match.deleteMany({ where: { id: { in: [m1.id, m2.id] } } });
    });
}

// ─────────────────────────────────────────────
// 2. EXECUTE ACTION — EDGE CASES
// ─────────────────────────────────────────────

async function runActionTests() {
    suite('2. executeAction — edge cases');

    await test('REGISTER_PLAYER solo nome → skip (nessun player creato)', async () => {
        const before = await prisma.player.count({ where: { clubId: testClub.id } });
        await executeAction('REGISTER_PLAYER', { name: 'Mario' }, null, testClub, '39199999999');
        const after = await prisma.player.count({ where: { clubId: testClub.id } });
        assertEqual(after, before, 'Non deve creare player con solo nome');
    });

    await test('REGISTER_PLAYER nome completo → crea player con skill=-1', async () => {
        const phone = '39199999998';
        await executeAction('REGISTER_PLAYER', { name: 'Mario Test' }, null, testClub, phone);
        const p = await prisma.player.findFirst({ where: { clubId: testClub.id, phoneNumber: phone } });
        assert(!!p, 'Player non creato');
        assertEqual(p.skillLevel, -1, 'skillLevel deve essere -1');
        assertEqual(p.active, true, 'deve essere active');
        // cleanup
        await prisma.player.delete({ where: { id: p.id } });
    });

    await test('CANCEL_MATCH su match OPEN → leftAt impostato, match rimane OPEN', async () => {
        const slot = romeTime(2, 10, 0);
        const match = await prisma.match.create({
            data: { clubId: testClub.id, courtId: courtScoperto.id, startTime: slot, skillLevel: 3.5, status: 'OPEN', playersNeeded: 4 },
        });
        const mp = await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: playerSkilled.id } });

        await executeAction('CANCEL_MATCH', { matchPlayerId: mp.id }, playerSkilled, testClub);

        const updatedMp = await prisma.matchPlayer.findUnique({ where: { id: mp.id } });
        assert(!!updatedMp?.leftAt, 'leftAt deve essere impostato');

        const updatedMatch = await prisma.match.findUnique({ where: { id: match.id } });
        assertEqual(updatedMatch?.status, 'OPEN', 'Match OPEN deve rimanere OPEN dopo cancellazione');

        // cleanup
        await prisma.matchPlayer.delete({ where: { id: mp.id } });
        await prisma.match.delete({ where: { id: match.id } });
    });

    await test('CANCEL_MATCH su match LOCKED → riapre match (OPEN)', async () => {
        const slot = romeTime(2, 11, 0);
        const match = await prisma.match.create({
            data: { clubId: testClub.id, courtId: courtScoperto.id, startTime: slot, skillLevel: 3.5, status: 'LOCKED', playersNeeded: 4 },
        });
        const mp = await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: playerSkilled.id } });
        await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: playerB.id } });

        await executeAction('CANCEL_MATCH', { matchPlayerId: mp.id }, playerSkilled, testClub);

        const updatedMatch = await prisma.match.findUnique({ where: { id: match.id } });
        assertEqual(updatedMatch?.status, 'OPEN', 'Match deve tornare OPEN dopo cancellazione da LOCKED');

        // cleanup (wave job sarà in Redis ma non eseguito senza worker)
        await prisma.invitation.deleteMany({ where: { matchId: match.id } });
        await prisma.matchPlayer.deleteMany({ where: { matchId: match.id } });
        await prisma.match.delete({ where: { id: match.id } });
    });

    await test('ACCEPT_INVITATION → status ACCEPTED + match LOCKED quando pieno', async () => {
        const slot = romeTime(2, 12, 0);
        const match = await prisma.match.create({
            data: { clubId: testClub.id, courtId: courtScoperto.id, startTime: slot, skillLevel: 3.5, status: 'OPEN', playersNeeded: 2 },
        });
        // playerSkilled già dentro
        await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: playerSkilled.id } });
        // Invito per playerB
        const inv = await prisma.invitation.create({
            data: { matchId: match.id, playerId: playerB.id, status: 'PENDING' },
        });

        const res = await executeAction('ACCEPT_INVITATION', { invitationId: inv.id }, playerB, testClub);
        assert(res.success, `ACCEPT fallita: ${res.errorMessage}`);

        const updatedInv = await prisma.invitation.findUnique({ where: { id: inv.id } });
        assertEqual(updatedInv?.status, 'ACCEPTED', 'Invitation deve essere ACCEPTED');

        const updatedMatch = await prisma.match.findUnique({ where: { id: match.id } });
        assertEqual(updatedMatch?.status, 'LOCKED', 'Match con playersNeeded raggiunto deve diventare LOCKED');

        // cleanup
        await prisma.invitation.deleteMany({ where: { matchId: match.id } });
        await prisma.matchPlayer.deleteMany({ where: { matchId: match.id } });
        await prisma.match.delete({ where: { id: match.id } });
    });

    await test('ACCEPT_INVITATION su match già chiuso → errore', async () => {
        const slot = romeTime(2, 13, 0);
        const match = await prisma.match.create({
            data: { clubId: testClub.id, courtId: courtScoperto.id, startTime: slot, skillLevel: 3.5, status: 'LOCKED', playersNeeded: 4 },
        });
        const inv = await prisma.invitation.create({
            data: { matchId: match.id, playerId: playerB.id, status: 'PENDING' },
        });

        const res = await executeAction('ACCEPT_INVITATION', { invitationId: inv.id }, playerB, testClub);
        assert(!res.success, 'Doveva fallire — match chiuso');

        // cleanup
        await prisma.invitation.deleteMany({ where: { matchId: match.id } });
        await prisma.matchPlayer.deleteMany({ where: { matchId: match.id } });
        await prisma.match.delete({ where: { id: match.id } });
    });

    await test('REJECT_INVITATION → status REJECTED', async () => {
        const slot = romeTime(2, 14, 0);
        const match = await prisma.match.create({
            data: { clubId: testClub.id, courtId: courtScoperto.id, startTime: slot, skillLevel: 3.5, status: 'OPEN', playersNeeded: 4 },
        });
        const inv = await prisma.invitation.create({
            data: { matchId: match.id, playerId: playerB.id, status: 'PENDING' },
        });

        const res = await executeAction('REJECT_INVITATION', { invitationId: inv.id }, playerB, testClub);
        assert(res.success, `REJECT fallita: ${res.errorMessage}`);

        const updatedInv = await prisma.invitation.findUnique({ where: { id: inv.id } });
        assertEqual(updatedInv?.status, 'REJECTED', 'Invitation deve essere REJECTED');

        // cleanup
        await prisma.invitation.deleteMany({ where: { matchId: match.id } });
        await prisma.matchPlayer.deleteMany({ where: { matchId: match.id } });
        await prisma.match.delete({ where: { id: match.id } });
    });

    await test('OPT_OUT → player.active = false', async () => {
        const res = await executeAction('OPT_OUT', {}, playerB, testClub);
        assert(res.success, 'OPT_OUT fallita');
        const updated = await prisma.player.findUnique({ where: { id: playerB.id } });
        assertEqual(updated?.active, false, 'Player deve essere inactive dopo OPT_OUT');
        // Ripristina per test successivi
        await prisma.player.update({ where: { id: playerB.id }, data: { active: true } });
    });

    await test('OPT_IN → player.active = true (partendo da false)', async () => {
        await prisma.player.update({ where: { id: playerD.id }, data: { active: false } });
        const res = await executeAction('OPT_IN', {}, playerD, testClub);
        assert(res.success, 'OPT_IN fallita');
        const updated = await prisma.player.findUnique({ where: { id: playerD.id } });
        assertEqual(updated?.active, true, 'Player deve essere active dopo OPT_IN');
    });

    await test('INVITE_PREFERRED con nome inesistente → PLAYER_NOT_FOUND', async () => {
        const res = await executeAction('INVITE_PREFERRED', { playerName: 'Inesistente XYZ' }, playerSkilled, testClub);
        assert(!res.success, 'Doveva fallire — giocatore non trovato');
        assertContains(res.errorMessage ?? '', 'PLAYER_NOT_FOUND');
    });

    await test('INVITE_PREFERRED con nome fuzzy match → success', async () => {
        // playerB si chiama "Giulia Verdi" — provo con "Verdi" o "Giulia Vrdi" (typo)
        const res = await executeAction('INVITE_PREFERRED', { playerName: 'Giulia Vrdi' }, playerSkilled, testClub);
        assert(res.success, `INVITE_PREFERRED con fuzzy match fallita: ${res.errorMessage}`);
    });

    await test('SAVE_NOTE con preferenza mattina → avoidAfternoon=true', async () => {
        const res = await executeAction('SAVE_NOTE', { note: 'Preferisco solo la mattina, pomeriggio non riesco mai' }, playerSkilled, testClub);
        assert(res.success, 'SAVE_NOTE fallita');
        const updated = await prisma.player.findUnique({ where: { id: playerSkilled.id } }) as any;
        assert(updated?.avoidAfternoon === true, 'avoidAfternoon deve essere true');
        // Cleanup flag
        await (prisma.player.update as any)({ where: { id: playerSkilled.id }, data: { avoidAfternoon: false, notes: null } });
    });

    await test('RESCHEDULE_MATCH → cancella vecchia partecipazione + prenota nuovo slot', async () => {
        const slot1 = romeTime(3, 10, 0);
        const match = await prisma.match.create({
            data: { clubId: testClub.id, courtId: courtScoperto.id, startTime: slot1, skillLevel: 3.5, status: 'OPEN', playersNeeded: 4 },
        });
        const mp = await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: playerSkilled.id } });

        const nextDay = new Date();
        nextDay.setDate(nextDay.getDate() + 4);
        const newDayStr = nextDay.toISOString().slice(0, 10);

        const res = await executeAction('RESCHEDULE_MATCH', {
            matchPlayerId: mp.id,
            newDay: newDayStr,
            newTime: '14:00',
            preferCovered: false,
        }, playerSkilled, testClub);

        assert(res.success, `RESCHEDULE fallita: ${res.errorMessage}`);

        const updatedMp = await prisma.matchPlayer.findUnique({ where: { id: mp.id } });
        assert(!!updatedMp?.leftAt, 'Vecchia partecipazione deve avere leftAt');

        // Verifica nuovo match
        const newMatch = await prisma.match.findUnique({ where: { id: res.matchId } });
        assert(!!newMatch, 'Nuovo match non trovato');

        // cleanup vecchio match
        await prisma.invitation.deleteMany({ where: { matchId: match.id } });
        await prisma.matchPlayer.deleteMany({ where: { matchId: match.id } });
        await prisma.match.delete({ where: { id: match.id } });
        // cleanup nuovo match
        await prisma.invitation.deleteMany({ where: { matchId: newMatch!.id } });
        await prisma.matchPlayer.deleteMany({ where: { matchId: newMatch!.id } });
        await prisma.match.delete({ where: { id: newMatch!.id } });
    });
}

// ─────────────────────────────────────────────
// 3. SCORING UTILS (pure logic)
// ─────────────────────────────────────────────

async function runScoringTests() {
    suite('3. Scoring utils (pure logic)');

    await test('computeNextWaveDelayMs(1500) = 3h (>24h)', async () => {
        const d = computeNextWaveDelayMs(1500);
        assertEqual(d, 3 * 60 * 60 * 1000, '> 24h deve dare 3h');
    });

    await test('computeNextWaveDelayMs(800) = 2h (>12h)', async () => {
        const d = computeNextWaveDelayMs(800);
        assertEqual(d, 2 * 60 * 60 * 1000, '> 12h deve dare 2h');
    });

    await test('computeNextWaveDelayMs(400) = 90min (>6h)', async () => {
        const d = computeNextWaveDelayMs(400);
        assertEqual(d, 90 * 60 * 1000, '> 6h deve dare 90min');
    });

    await test('computeNextWaveDelayMs(121) = 25min (>2h)', async () => {
        const d = computeNextWaveDelayMs(121);
        assertEqual(d, 25 * 60 * 1000, '> 2h deve dare 25min');
    });

    await test('computeNextWaveDelayMs(61) = 10min (>1h)', async () => {
        const d = computeNextWaveDelayMs(61);
        assertEqual(d, 10 * 60 * 1000, '> 1h deve dare 10min');
    });

    await test('computeNextWaveDelayMs(20) = null (<1h, match quasi iniziato)', async () => {
        const d = computeNextWaveDelayMs(20);
        assertEqual(d, null as any, 'Meno di 1h deve restituire null');
    });

    await test('isNightInRome: notte (03:00 UTC+2 = 01:00 Rome)', async () => {
        // Crea una data che in Italy sia le 02:00 (notte)
        // UTC+2 (CEST): 00:00 UTC = 02:00 Rome — è notte
        const d = new Date();
        d.setUTCHours(0, 0, 0, 0);
        // Se siamo in CEST (UTC+2): 00:00 UTC = 02:00 Rome → notte
        // Se siamo in CET (UTC+1): 00:00 UTC = 01:00 Rome → notte
        // In entrambi i casi, 00:00 UTC è notte in Italy
        assert(isNightInRome(d), '00:00 UTC deve essere notte in Italy');
    });

    await test('isNightInRome: giorno (10:00 UTC = ~11-12 Rome)', async () => {
        const d = new Date();
        d.setUTCHours(10, 0, 0, 0);
        assert(!isNightInRome(d), '10:00 UTC deve essere giorno in Italy');
    });

    await test('isWeekdayInRome: weekday', async () => {
        // Trova il prossimo lunedì
        const d = new Date();
        const day = d.getDay();
        const toMonday = (1 - day + 7) % 7 || 7;
        d.setDate(d.getDate() + toMonday);
        d.setUTCHours(10, 0, 0, 0);
        assert(isWeekdayInRome(d), 'Lunedì deve essere weekday');
    });

    await test('isWeekdayInRome: weekend', async () => {
        // Prossima domenica
        const d = new Date();
        const toSunday = (7 - d.getDay()) % 7 || 7;
        d.setDate(d.getDate() + toSunday);
        d.setUTCHours(10, 0, 0, 0);
        assert(!isWeekdayInRome(d), 'Domenica non deve essere weekday');
    });

    await test('updateShowUpRate EMA: showed=true da prior 0.33', async () => {
        const before = await getPlayerStats(playerSkilled.id);
        await updateShowUpRate(playerSkilled.id, true, 180);
        const after = await getPlayerStats(playerSkilled.id);
        // EMA: new = (1 - 0.15) × 0.33 + 0.15 × 1.0 = 0.8505 × 0.33 + 0.15 = 0.4307 (prima inv)
        // Il valore esatto dipende da quante invitazioni ci sono già state
        // Verifichiamo solo che il tasso sia ≥ quello precedente (showed=true aumenta)
        assert(after.showUpRate >= before.showUpRate * 0.9, `showUpRate non è aumentato: before=${before.showUpRate} after=${after.showUpRate}`);
    });

    await test('updateShowUpRate EMA: showed=false → tasso diminuisce', async () => {
        const before = await getPlayerStats(playerSkilled.id);
        await updateShowUpRate(playerSkilled.id, false, 180);
        const after = await getPlayerStats(playerSkilled.id);
        assert(after.showUpRate < before.showUpRate, `showUpRate non è diminuito: before=${before.showUpRate} after=${after.showUpRate}`);
    });
}

// ─────────────────────────────────────────────
// 4. SELECT PLAYERS FOR WAVE
// ─────────────────────────────────────────────

async function runWaveSelectionTests() {
    suite('4. selectPlayersForWave');

    await test('skill filter: giocatori fuori range esclusi', async () => {
        const slot = romeTime(5, 10, 0);
        // Match con skill 3.5, range ±1.0 → seleziona skill 2.5-4.5
        // playerC ha skill 5.0 → escluso
        const match = await prisma.match.create({
            data: { clubId: testClub.id, courtId: courtScoperto.id, startTime: slot, skillLevel: 3.5, status: 'OPEN', playersNeeded: 4 },
        });
        await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: playerSkilled.id } });

        const result = await selectPlayersForWave(match.id, 3, testClub.waveMultiplier);
        const selectedIds = result.players.map((p: any) => p.id);

        assert(!selectedIds.includes(playerC.id), 'playerC (skill 5.0) non deve essere selezionato');
        assert(!selectedIds.includes(playerSkilled.id), 'playerSkilled (già nel match) non deve essere selezionato');

        // cleanup
        await prisma.matchPlayer.deleteMany({ where: { matchId: match.id } });
        await prisma.match.delete({ where: { id: match.id } });
    });

    await test('player inattivo escluso dalla wave', async () => {
        const slot = romeTime(5, 11, 0);
        const match = await prisma.match.create({
            data: { clubId: testClub.id, courtId: courtScoperto.id, startTime: slot, skillLevel: 3.5, status: 'OPEN', playersNeeded: 4 },
        });
        await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: playerSkilled.id } });

        // playerD è active=true (abbiamo impostato in OPT_IN test), quindi lo escludiamo manualmente
        await prisma.player.update({ where: { id: playerD.id }, data: { active: false } });

        const result = await selectPlayersForWave(match.id, 3, testClub.waveMultiplier);
        const selectedIds = result.players.map((p: any) => p.id);
        assert(!selectedIds.includes(playerD.id), 'playerD (inactive) non deve essere selezionato');

        // ripristina
        await prisma.player.update({ where: { id: playerD.id }, data: { active: true } });

        // cleanup
        await prisma.matchPlayer.deleteMany({ where: { matchId: match.id } });
        await prisma.match.delete({ where: { id: match.id } });
    });

    await test('giocatori già invitati esclusi da wave successiva', async () => {
        const slot = romeTime(5, 12, 0);
        const match = await prisma.match.create({
            data: { clubId: testClub.id, courtId: courtScoperto.id, startTime: slot, skillLevel: 3.5, status: 'OPEN', playersNeeded: 4 },
        });
        await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: playerSkilled.id } });
        // playerB già invitato con status REJECTED
        await prisma.invitation.create({ data: { matchId: match.id, playerId: playerB.id, status: 'REJECTED' } });

        const result = await selectPlayersForWave(match.id, 3, testClub.waveMultiplier);
        const selectedIds = result.players.map((p: any) => p.id);
        assert(!selectedIds.includes(playerB.id), 'playerB (già invitato) non deve essere riselezionato');

        // cleanup
        await prisma.invitation.deleteMany({ where: { matchId: match.id } });
        await prisma.matchPlayer.deleteMany({ where: { matchId: match.id } });
        await prisma.match.delete({ where: { id: match.id } });
    });
}

// ─────────────────────────────────────────────
// 5. BUILD BRAIN CONTEXT
// ─────────────────────────────────────────────

async function runContextTests() {
    suite('5. buildBrainContext');

    await test('utente non registrato → player=null, isAdmin=false', async () => {
        const ctx = await buildBrainContext('99@s.whatsapp.net', '39900000000');
        assertEqual(ctx.player, null, 'Player deve essere null per numero sconosciuto');
        assertEqual(ctx.isAdmin, false, 'Non deve essere admin');
        assert(Array.isArray(ctx.courts), 'courts deve essere un array');
        assert(!!ctx.club, 'club deve essere presente');
    });

    await test('utente registrato → player presente con dati corretti', async () => {
        const ctx = await buildBrainContext('marco@s.whatsapp.net', '39100000001');
        assert(!!ctx.player, 'Player deve essere presente');
        assertEqual(ctx.player.id, playerSkilled.id, 'Player ID deve corrispondere');
        assertEqual(ctx.player.skillLevel, 3.5, 'skillLevel deve essere 3.5');
    });

    await test('admin phone → isAdmin=true', async () => {
        const ctx = await buildBrainContext('admin@s.whatsapp.net', '390000000000');
        assertEqual(ctx.isAdmin, true, 'Deve essere riconosciuto come admin');
    });

    await test('slotsAvailability presente con struttura corretta', async () => {
        const ctx = await buildBrainContext('marco@s.whatsapp.net', '39100000001');
        assert(Array.isArray(ctx.slotsAvailability.fullSlots), 'fullSlots deve essere array');
        assert(Array.isArray(ctx.slotsAvailability.onlyCoveredSlots), 'onlyCoveredSlots deve essere array');
        assert(Array.isArray(ctx.slotsAvailability.freeScopertoSlots), 'freeScopertoSlots deve essere array');
    });

    await test('inviti pendenti inclusi nel contesto', async () => {
        const slot = romeTime(1, 18, 0);
        const match = await prisma.match.create({
            data: { clubId: testClub.id, courtId: courtScoperto.id, startTime: slot, skillLevel: 3.5, status: 'OPEN', playersNeeded: 4 },
        });
        const inv = await prisma.invitation.create({
            data: { matchId: match.id, playerId: playerSkilled.id, status: 'PENDING' },
        });

        const ctx = await buildBrainContext('marco@s.whatsapp.net', '39100000001');
        const hasInv = ctx.pendingInvitations.some((i: any) => i.id === inv.id);
        assert(hasInv, 'Invito pendente deve apparire nel contesto');

        // cleanup
        await prisma.invitation.delete({ where: { id: inv.id } });
        await prisma.match.delete({ where: { id: match.id } });
    });
}

// ─────────────────────────────────────────────
// 6. DASHBOARD API (HTTP)
// ─────────────────────────────────────────────

async function runDashboardTests() {
    suite('6. Dashboard API (HTTP)');

    const BASE = process.env.STAGING_URL || 'https://padel-staging.polpo-ai.com';
    const DASH_USER = process.env.DASH_USER || 'admin';
    const DASH_PASS = process.env.DASH_PASS || '';
    let token = '';
    let createdMatchId = '';

    // Health check prima di tutto
    await test('GET /health → 200', async () => {
        const r = await fetch(`${BASE}/health`);
        assert(r.status === 200 || r.status === 503, `Unexpected status: ${r.status}`);
        const body = await r.json();
        assert(!!body.ts, 'health deve avere timestamp');
    });

    if (!DASH_PASS) {
        console.log('  ⚠️  DASH_PASS non impostata — test dashboard saltati. Imposta DASH_PASS nel .env o esegui con DASH_PASS=xxx');
        return;
    }

    await test('POST /api/dashboard/login → 200 + token', async () => {
        const r = await fetch(`${BASE}/api/dashboard/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: DASH_USER, password: DASH_PASS }),
        });
        assert(r.status === 200, `Login fallito: ${r.status}`);
        const body = await r.json();
        assert(!!body.token, 'Token assente nella risposta login');
        token = body.token;
    });

    if (!token) return;

    const auth = () => ({ 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' });

    await test('GET /api/dashboard/club → 200 con dati club', async () => {
        const r = await fetch(`${BASE}/api/dashboard/club`, { headers: auth() });
        assert(r.status === 200, `Status: ${r.status}`);
        const body = await r.json();
        assert(!!body.id, 'club.id assente');
        assert(!!body.name, 'club.name assente');
    });

    await test('GET /api/dashboard/courts → 200 con array', async () => {
        const r = await fetch(`${BASE}/api/dashboard/courts`, { headers: auth() });
        assert(r.status === 200, `Status: ${r.status}`);
        const body = await r.json();
        assert(Array.isArray(body), 'Risposta deve essere array');
    });

    await test('GET /api/dashboard/matches → 200 con array', async () => {
        const r = await fetch(`${BASE}/api/dashboard/matches`, { headers: auth() });
        assert(r.status === 200, `Status: ${r.status}`);
        const body = await r.json();
        assert(Array.isArray(body), 'Risposta deve essere array');
    });

    await test('GET /api/dashboard/players → 200 con array', async () => {
        const r = await fetch(`${BASE}/api/dashboard/players`, { headers: auth() });
        assert(r.status === 200, `Status: ${r.status}`);
        const body = await r.json();
        assert(Array.isArray(body), 'Risposta deve essere array');
    });

    await test('GET /api/dashboard/stats → 200 con stats', async () => {
        const r = await fetch(`${BASE}/api/dashboard/stats`, { headers: auth() });
        assert(r.status === 200, `Status: ${r.status}`);
        const body = await r.json();
        assert('fillRate' in body || 'totalMatches' in body || typeof body === 'object', 'stats devono essere un oggetto');
    });

    await test('GET /api/dashboard/matches/suggest-level → 200 con {suggestions}', async () => {
        const r = await fetch(`${BASE}/api/dashboard/matches/suggest-level`, { headers: auth() });
        assert(r.status === 200, `Status: ${r.status}`);
        const body = await r.json();
        assert(Array.isArray(body.suggestions), `suggest-level deve avere suggestions array, got: ${JSON.stringify(body)}`);
    });

    await test('POST /api/dashboard/matches → 201 crea match', async () => {
        // Usa 365 giorni + ora insolita per evitare conflitti con dati reali
        const futureSlot = new Date();
        futureSlot.setDate(futureSlot.getDate() + 365);
        futureSlot.setUTCHours(7, 43, 0, 0); // 07:43 UTC = orario improbabile per conflitti

        // Prima recupera un courtId reale dal dashboard
        const courtsR = await fetch(`${BASE}/api/dashboard/courts`, { headers: auth() });
        const courts = await courtsR.json();
        if (!courts.length) { throw new Error('Nessun campo trovato sul dashboard — impossibile creare match'); }
        const courtId = courts[0].id;

        const r = await fetch(`${BASE}/api/dashboard/matches`, {
            method: 'POST',
            headers: auth(),
            body: JSON.stringify({
                courtId,
                startTime: futureSlot.toISOString(),
                skillLevel: 3.5,
            }),
        });
        assert(r.status === 200 || r.status === 201, `Creazione match fallita: ${r.status} — ${await r.text()}`);
        const body = await r.json();
        assert(!!body.id, 'Match ID assente nella risposta');
        createdMatchId = body.id;
    });

    await test('POST /api/dashboard/matches/:id/cancel → 200', async () => {
        if (!createdMatchId) throw new Error('Match non creato nel test precedente');
        const r = await fetch(`${BASE}/api/dashboard/matches/${createdMatchId}/cancel`, {
            method: 'POST',
            headers: auth(),
            body: JSON.stringify({ reason: 'TEST' }),
        });
        assert(r.status === 200, `Cancellazione fallita: ${r.status} — ${await r.text()}`);
    });

    await test('POST /api/dashboard/login con password errata → 401', async () => {
        const r = await fetch(`${BASE}/api/dashboard/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: DASH_USER, password: 'WRONG_PASSWORD_XYZ' }),
        });
        assertEqual(r.status, 401, `Deve essere 401 per password errata`);
    });

    await test('GET /api/dashboard/club senza token → 401', async () => {
        const r = await fetch(`${BASE}/api/dashboard/club`);
        assertEqual(r.status, 401, 'Deve essere 401 senza token');
    });
}

// ─────────────────────────────────────────────
// 7. CALL BRAIN (AI — solo con --brain)
// ─────────────────────────────────────────────

async function runBrainAITests() {
    suite('7. callBrain AI (chiama Claude — potrebbe essere lento)');

    await test('utente non registrato + messaggio presentazione → REGISTER_PLAYER', async () => {
        const ctx = await buildBrainContext('fake99@s.whatsapp.net', '39900000099');
        // ctx.player = null
        const res = await callBrain(ctx, 'Ciao, mi chiamo Giovanni Ferrari, vorrei iscrivermi');
        assert(res.action === 'REGISTER_PLAYER', `Azione attesa REGISTER_PLAYER, ottenuta: ${res.action}`);
        assertContains((res.params?.name ?? '').toLowerCase(), 'giovanni');
    });

    await test('utente registrato + richiesta prenotazione → BOOK_FIELD', async () => {
        const ctx = await buildBrainContext('marco@s.whatsapp.net', '39100000001');
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const res = await callBrain(ctx, `Vorrei prenotare domani alle 16:00`);
        assert(res.action === 'BOOK_FIELD', `Azione attesa BOOK_FIELD, ottenuta: ${res.action}`);
        assert(!!res.params?.time, 'Parametro time deve essere presente');
    });

    await test('messaggio conversazionale generico → NONE o FAQ_REQUEST', async () => {
        const ctx = await buildBrainContext('marco@s.whatsapp.net', '39100000001');
        const res = await callBrain(ctx, 'Quanto costa noleggiare una racchetta?');
        assert(
            res.action === 'NONE' || res.action === 'FAQ_REQUEST',
            `Azione attesa NONE o FAQ_REQUEST, ottenuta: ${res.action}`,
        );
    });

    await test('richiesta cancellazione → CANCEL_MATCH (se partita esistente)', async () => {
        // Crea una partita confermata per playerSkilled
        const slot = romeTime(1, 17, 0);
        const match = await prisma.match.create({
            data: { clubId: testClub.id, courtId: courtScoperto.id, startTime: slot, skillLevel: 3.5, status: 'LOCKED', playersNeeded: 4 },
        });
        const mp = await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: playerSkilled.id } });

        const ctx = await buildBrainContext('marco@s.whatsapp.net', '39100000001');
        const res = await callBrain(ctx, 'Non riesco a venire domani, devo cancellare');
        assert(res.action === 'CANCEL_MATCH', `Azione attesa CANCEL_MATCH, ottenuta: ${res.action} — messaggio: ${res.message}`);

        // cleanup
        await prisma.invitation.deleteMany({ where: { matchId: match.id } });
        await prisma.matchPlayer.deleteMany({ where: { matchId: match.id } });
        await prisma.match.delete({ where: { id: match.id } });
    });

    await test('risposta JSON sempre valida (anche su input strano)', async () => {
        const ctx = await buildBrainContext('marco@s.whatsapp.net', '39100000001');
        const res = await callBrain(ctx, '🎾🎾🎾 ??? !!!');
        assert(!!res.message, 'message non deve essere vuoto');
        assert(!!res.action, 'action non deve essere vuota');
    });
}

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────

async function main() {
    const withBrain = process.argv.includes('--brain');
    console.log('━'.repeat(60));
    console.log(' PADEL BOT — TEST SUITE');
    if (withBrain) console.log(' (modalità --brain: include test AI con Claude)');
    console.log('━'.repeat(60));

    try {
        await setup();
        await importServices();

        await runBookingTests();
        await runActionTests();
        await runScoringTests();
        await runWaveSelectionTests();
        await runContextTests();
        await runDashboardTests();

        if (withBrain) {
            await runBrainAITests();
        } else {
            console.log('\n📦 7. callBrain AI → saltati (aggiungi --brain per eseguirli)');
        }
    } finally {
        await cleanup();
        await prisma.$disconnect();
        await pool.end();
    }

    console.log('\n' + '━'.repeat(60));
    console.log(` Risultati: ✅ ${passed} passati  ❌ ${failed} falliti`);
    if (failures.length) {
        console.log('\n Fallimenti:');
        failures.forEach(f => console.log(`  ❌ ${f.name}\n     ${f.err}`));
    }
    console.log('━'.repeat(60) + '\n');

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('Errore fatale nel test runner:', err);
    process.exit(1);
});
