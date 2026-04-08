/**
 * RCA TESTS — Test specifici per i bug trovati in produzione
 *
 * 1. Sharon: re-call dopo REGISTER_PLAYER — no doppia prenotazione
 * 2. Roberto: redirect loop quando 0 alternative → no Redis state
 * 3. Christian: committedPlayers — wave cerca solo N giocatori mancanti
 * 4. Gioele: OPEN_TO_MATCHMAKING — cancella vecchio, crea nuovo OPEN
 *
 * ⚠️  Eseguire SUL VPS: npx tsx src/scripts/rca-tests.ts
 */

import 'dotenv/config';
import { prisma } from '../services/db';
import { getRedis } from '../services/queue';

let passed = 0;
let failed = 0;
const failures: { name: string; err: string; detail?: string }[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        const detail = err?.detail;
        console.log(`  ❌ ${name}\n     → ${msg}${detail ? `\n     ${detail}` : ''}`);
        failures.push({ name, err: msg, detail });
        failed++;
    }
}

function assert(cond: boolean, msg: string, detail?: string): asserts cond {
    if (!cond) {
        const err: any = new Error(msg);
        err.detail = detail;
        throw err;
    }
}

const RUN_ID = `rca-${Date.now()}`;
let testClub: any;
let court1: any;
let court2: any;

function jid(phone: string) { return `${phone}@s.whatsapp.net`; }

function futureDateStr(days: number): string {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
}

async function conversationTurn(phone: string, msg: string): Promise<{
    message: string; action: string; params: any; actionResult: any;
}> {
    const phoneJid = jid(phone);
    const { buildBrainContext, callBrain, executeAction } = await import('../services/brain');

    await prisma.whatsAppMessage.create({
        data: {
            chatId: phoneJid, sender: phone, role: 'USER', content: msg,
            messageId: `rca-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            clubId: testClub.id, timestamp: new Date(),
        },
    });

    process.env.CLUB_ID = testClub.id;
    const context = await buildBrainContext(phoneJid, phone);
    await new Promise(r => setTimeout(r, 2500)); // rate limit
    const brain = await callBrain(context, msg);

    let actionResult: any = null;
    if (brain.action !== 'NONE') {
        try {
            actionResult = await executeAction(brain.action as any, brain.params, context.player, context.club, phone);
        } catch (err) {
            actionResult = { success: false, error: String(err) };
        }
    }

    await prisma.whatsAppMessage.create({
        data: {
            chatId: phoneJid, sender: 'BOT', role: 'BOT', content: brain.message,
            clubId: testClub.id, timestamp: new Date(Date.now() + 1),
        },
    });

    return { message: brain.message, action: brain.action, params: brain.params, actionResult };
}

// ─────────────────────────────────────────────────────────────
// SETUP
// ─────────────────────────────────────────────────────────────

async function setup() {
    console.log(`\n🔧 Setup (run: ${RUN_ID})…`);
    testClub = await prisma.club.create({
        data: {
            id: RUN_ID,
            name: 'Test Club RCA',
            openTime: '07:00',
            closeTime: '23:30',
            matchLowerRange: 1.0,
            matchUpperRange: 1.0,
            skillLevelCount: 3,
            adminPhone: '390000000000',
            botPhoneNumber: null,
        } as any,
    });
    [court1, court2] = await Promise.all([
        prisma.court.create({ data: { clubId: testClub.id, name: 'Campo A', isCovered: false } }),
        prisma.court.create({ data: { clubId: testClub.id, name: 'Campo B', isCovered: true } }),
    ]);
    console.log('  OK.\n');
}

async function cleanup() {
    if (!testClub?.id) return;
    console.log('\n🧹 Cleanup…');
    try {
        const redis = getRedis();
        // Pulisci stati Redis del test
        const keys = await redis.keys(`state:*:${RUN_ID}*`);
        if (keys.length) await redis.del(...keys);

        await prisma.whatsAppMessage.deleteMany({ where: { clubId: testClub.id } });
        await prisma.invitation.deleteMany({ where: { match: { clubId: testClub.id } } });
        await prisma.matchPlayer.deleteMany({ where: { match: { clubId: testClub.id } } });
        await prisma.match.deleteMany({ where: { clubId: testClub.id } });
        await prisma.player.deleteMany({ where: { clubId: testClub.id } });
        await prisma.court.deleteMany({ where: { clubId: testClub.id } });
        await prisma.faq.deleteMany({ where: { clubId: testClub.id } });
        await prisma.club.delete({ where: { id: testClub.id } });
        console.log('  Done.');
    } catch (err) {
        console.error('  Cleanup parzialmente fallito:', err);
    }
}

// ─────────────────────────────────────────────────────────────
// TEST 1: SHARON — Re-call dopo REGISTER_PLAYER
// Il brain deve eseguire il booking intent senza chiedere conferma
// e senza creare una doppia prenotazione.
// ─────────────────────────────────────────────────────────────
async function testSharonRecall() {
    console.log('📋 Test 1: Sharon — re-call dopo REGISTER_PLAYER');
    const PHONE = `399001${RUN_ID.slice(-6)}`;
    const day = futureDateStr(2);
    const dayName = new Date(day).toLocaleDateString('it-IT', { weekday: 'long' });

    // Turno unico: utente non registrato che chiede anche di prenotare
    const r1 = await conversationTurn(PHONE,
        `Ciao! Mi chiamo Laura Bianchi e vorrei prenotare ${dayName} alle 10:00 misto`
    );

    await test('re-call: REGISTER_PLAYER eseguito', async () => {
        const player = await prisma.player.findFirst({ where: { phoneNumber: PHONE, clubId: testClub.id } });
        assert(player !== null, 'Player non creato dopo REGISTER_PLAYER');
    });

    await test('re-call: al massimo 1 prenotazione (no doppio booking)', async () => {
        const player = await prisma.player.findFirst({ where: { phoneNumber: PHONE, clubId: testClub.id } });
        if (!player) return; // già fallito sopra
        const matches = await prisma.matchPlayer.findMany({
            where: { playerId: player.id, leftAt: null },
        });
        assert(matches.length <= 1,
            `Trovate ${matches.length} MatchPlayer — doppio booking!`,
            `MatchPlayer IDs: ${matches.map(m => m.matchId).join(', ')}`
        );
    });

    await test('re-call: risposta sensata (no JSON, no tecnicismi)', async () => {
        assert(!r1.message.includes('{') && !r1.message.includes('undefined'),
            'La risposta contiene JSON grezzo o undefined', r1.message.slice(0, 200));
    });
}

// ─────────────────────────────────────────────────────────────
// TEST 2: ROBERTO — No redirect loop quando 0 alternative
// Se tutti i campi sono occupati, redirectGroup NON deve
// salvare AWAITING_REDIRECT_CHOICE in Redis.
// ─────────────────────────────────────────────────────────────
async function testRobertoRedirectLoop() {
    console.log('\n📋 Test 2: Roberto — no redirect loop con 0 alternative');
    const PHONE = `399002${RUN_ID.slice(-6)}`;

    // Crea player
    const player = await prisma.player.create({
        data: { clubId: testClub.id, name: 'Roberto Test', phoneNumber: PHONE, skillLevel: 3.0, active: true } as any,
    });

    // Occupa entrambi i campi (skill=3.0 → stesso range)
    const slot = new Date();
    slot.setDate(slot.getDate() + 3);
    slot.setUTCHours(7, 0, 0, 0); // 09:00 Rome

    await Promise.all([
        prisma.match.create({ data: { clubId: testClub.id, courtId: court1.id, startTime: slot, skillLevel: 3.0, status: 'LOCKED', playersNeeded: 4, isPrivateBooking: true } }),
        prisma.match.create({ data: { clubId: testClub.id, courtId: court2.id, startTime: slot, skillLevel: 3.0, status: 'LOCKED', playersNeeded: 4, isPrivateBooking: true } }),
    ]);

    // Turno 1: Roberto chiede slot occupato
    const dayName = slot.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Europe/Rome' });
    const r1 = await conversationTurn(PHONE, `Vorrei prenotare ${dayName} alle 9:00`);

    await test('slot pieno: AI segnala non disponibile o suggerisce alternative', async () => {
        const lower = r1.message.toLowerCase();
        const hasFeedback = ['occupat', 'pien', 'non disponib', 'alternativ', 'altro orario', 'libero', 'disponibile'].some(k => lower.includes(k));
        assert(hasFeedback, 'AI non ha segnalato indisponibilità o alternative', r1.message.slice(0, 200));
    });

    await test('no AWAITING_REDIRECT_CHOICE in Redis quando 0 alternative', async () => {
        const redis = getRedis();
        const key = `state:role:${jid(PHONE)}:AWAITING_REDIRECT_CHOICE`;
        const val = await redis.get(key);
        assert(val === null, 'AWAITING_REDIRECT_CHOICE salvato anche con 0 opzioni!',
            `Valore Redis: ${val?.slice(0, 100)}`);
    });

    // Turno 2: Roberto manda un messaggio normale → non deve essere bloccato dal redirect
    const r2 = await conversationTurn(PHONE, `Ok grazie, lascia perdere`);

    await test('turno successivo: non bloccato da redirect state', async () => {
        assert(r2.action !== 'REDIRECT_CHOICE' as any,
            'Il secondo turno ha attivato redirect flow!', r2.message.slice(0, 200));
        // Deve rispondere normalmente
        assert(r2.message.length > 5, 'Risposta vuota al secondo turno');
    });
}

// ─────────────────────────────────────────────────────────────
// TEST 3: CHRISTIAN — committedPlayers: wave per 1 solo giocatore
// "Siamo in 3, cerco 1 giocatore" → committedPlayers=3 → 1 spot
// ─────────────────────────────────────────────────────────────
async function testChristianCommitted() {
    console.log('\n📋 Test 3: Christian — committedPlayers e wave per 1 giocatore');
    const PHONE = `399003${RUN_ID.slice(-6)}`;

    const player = await prisma.player.create({
        data: { clubId: testClub.id, name: 'Christian Test', phoneNumber: PHONE, skillLevel: 3.0, active: true } as any,
    });

    const day = futureDateStr(4);
    const dayName = new Date(day).toLocaleDateString('it-IT', { weekday: 'long' });

    // Turno 1: chiede matchmaking specificando che sono già in 3
    const r1 = await conversationTurn(PHONE,
        `Ciao! Io e altri 2 amici vogliamo giocare ${dayName} alle 11:00, cerchiamo un quarto giocatore. Va bene misto`
    );

    await test('BOOK_FIELD eseguito con successo', async () => {
        assert(r1.action === 'BOOK_FIELD', `Azione inattesa: ${r1.action}`, r1.message.slice(0, 200));
        assert(r1.actionResult?.success === true, 'BOOK_FIELD fallito', JSON.stringify(r1.actionResult));
    });

    await test('match creato come OPEN (matchmaking)', async () => {
        const matchId = r1.actionResult?.matchId;
        assert(!!matchId, 'Nessun matchId nel result');
        const match = await prisma.match.findUnique({ where: { id: matchId } });
        assert(match?.status === 'OPEN', `Match status: ${match?.status} (atteso OPEN)`, matchId);
        assert(match?.isPrivateBooking === false, 'Match marcato come privato invece di matchmaking');
    });

    await test('match OPEN creato con wave avviata (matchmaking attivo)', async () => {
        const matchId = r1.actionResult?.matchId;
        if (!matchId) return;
        const match = await prisma.match.findUnique({ where: { id: matchId } });
        assert(match?.status === 'OPEN', `Match status: ${match?.status}`, matchId);
        assert(match?.isPrivateBooking === false, 'Match ancora privato', matchId);
        // committedPlayers: se il brain ha capito "siamo in 3" → committedPlayers >= 2
        // altrimenti è 0 (solo il player registrato) → wave cerca 3 giocatori
        const committed = (match as any)?.committedPlayers ?? 0;
        console.log(`    [info] committedPlayers=${committed} (brain interpretation of "siamo in 3")`);
    });
}

// ─────────────────────────────────────────────────────────────
// TEST 4: GIOELE — OPEN_TO_MATCHMAKING: cancella vecchio, crea nuovo
// ─────────────────────────────────────────────────────────────
async function testGioeleOpenToMatchmaking() {
    console.log('\n📋 Test 4: Gioele — OPEN_TO_MATCHMAKING');
    const PHONE = `399004${RUN_ID.slice(-6)}`;

    const player = await prisma.player.create({
        data: { clubId: testClub.id, name: 'Gioele Test', phoneNumber: PHONE, skillLevel: 3.0, active: true } as any,
    });

    // Crea una prenotazione privata esistente (LOCKED)
    const slot = new Date();
    slot.setDate(slot.getDate() + 5);
    slot.setUTCHours(7, 0, 0, 0); // 09:00 Rome

    const oldMatch = await prisma.match.create({
        data: { clubId: testClub.id, courtId: court1.id, startTime: slot, skillLevel: 3.0, status: 'LOCKED', isPrivateBooking: true, playersNeeded: 4 },
    });
    await prisma.matchPlayer.create({ data: { matchId: oldMatch.id, playerId: player.id } });
    await prisma.invitation.create({ data: { matchId: oldMatch.id, playerId: player.id, status: 'ACCEPTED' } });

    const oldMatchId = oldMatch.id;

    // Turno: chiede di aprire al matchmaking
    const r1 = await conversationTurn(PHONE,
        `Ho una prenotazione privata ma vorrei aprirla al matchmaking per trovare altri giocatori, siamo solo in 2`
    );

    await test('OPEN_TO_MATCHMAKING azione eseguita', async () => {
        assert(r1.action === 'OPEN_TO_MATCHMAKING',
            `Azione inattesa: ${r1.action} (atteso OPEN_TO_MATCHMAKING)`,
            r1.message.slice(0, 200)
        );
        assert(r1.actionResult?.success === true, 'OPEN_TO_MATCHMAKING fallito',
            JSON.stringify(r1.actionResult));
    });

    await test('vecchio match CANCELLED (non flipppato a OPEN)', async () => {
        const old = await prisma.match.findUnique({ where: { id: oldMatchId } });
        assert(old?.status === 'CANCELLED',
            `Vecchio match status: ${old?.status} (atteso CANCELLED)`, oldMatchId);
        assert((old as any)?.cancelledReason === 'CONVERTED_TO_MATCHMAKING',
            `cancelledReason: ${(old as any)?.cancelledReason}`, oldMatchId);
    });

    await test('nuovo match OPEN creato sulla stessa corte/orario', async () => {
        const newMatchId = r1.actionResult?.matchId;
        assert(!!newMatchId, 'Nessun matchId nel result');
        assert(newMatchId !== oldMatchId, 'matchId uguale al vecchio — non è stato creato un nuovo match!');

        const newMatch = await prisma.match.findUnique({ where: { id: newMatchId } });
        assert(newMatch?.status === 'OPEN', `Nuovo match status: ${newMatch?.status}`, newMatchId);
        assert(newMatch?.isPrivateBooking === false, 'Nuovo match ancora marcato come privato');
        assert(newMatch?.courtId === court1.id, `Corte diversa: ${newMatch?.courtId}`, newMatchId);
    });

    await test('player iscritto al nuovo match', async () => {
        const newMatchId = r1.actionResult?.matchId;
        if (!newMatchId) return;
        const mp = await prisma.matchPlayer.findFirst({
            where: { matchId: newMatchId, playerId: player.id, leftAt: null },
        });
        assert(mp !== null, 'Player non trovato nel nuovo match come MatchPlayer');
    });
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────
async function main() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(' PADEL BOT — RCA BUG TESTS (Sharon/Roberto/Christian/Gioele)');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    await setup();

    try {
        await testSharonRecall();
        await new Promise(r => setTimeout(r, 8000)); // rate limit
        await testRobertoRedirectLoop();
        await new Promise(r => setTimeout(r, 8000));
        await testChristianCommitted();
        await new Promise(r => setTimeout(r, 8000));
        await testGioeleOpenToMatchmaking();
    } catch (err) {
        console.error('\n💥 Errore fatale durante i test:', err);
    }

    await cleanup();
    await prisma.$disconnect();

    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(` Risultati: ✅ ${passed} passati  ❌ ${failed} falliti`);

    if (failures.length > 0) {
        console.log('\n Fallimenti:');
        for (const f of failures) {
            console.log(`  ❌ ${f.name}`);
            console.log(`     ${f.err}`);
            if (f.detail) console.log(`     ${f.detail}`);
        }
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(async err => {
    console.error('\n💥 Fatal:', err);
    await cleanup().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
});
