/**
 * TEST NUOVE FEATURE — Padel Bot
 *
 * Testa su staging (bypass Baileys, usa brain + executeAction direttamente):
 *  1. FAQ playerJid fix — verifica che Redis salvi @s.whatsapp.net, non @lid
 *  2. Multi-intent — brain restituisce secondaryAction=BOOK_FIELD
 *  3. Regression single-intent — nessun secondaryAction per messaggio singolo
 *  4. Gender balance misto — ACCEPT_INVITATION gender-aware (OPEN→LOCKED solo su 2M+2F)
 *  5. Regression BOOK_FIELD — prenotazione normale funziona ancora
 *  6. Regression CANCEL_MATCH — cancellazione funziona ancora
 *
 * ⚠️  Eseguire sul VPS:
 *     DATABASE_URL="<DIRECT_URL>" npx tsx src/scripts/test-new-features.ts
 */

import 'dotenv/config';
import { prisma } from '../services/db';
import { getRedis } from '../services/queue';

// ─── Test runner ──────────────────────────────────────────────
let passed = 0;
let failed = 0;
const failures: { name: string; err: string }[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (err: any) {
        if (String(err?.message).includes('529') || String(err?.message).includes('overload')) {
            try {
                await delay(8000);
                await fn();
                console.log(`  ✅ ${name} (retry)`);
                passed++;
                return;
            } catch {}
        }
        const msg = err?.message ?? String(err);
        console.log(`  ❌ ${name}\n     → ${msg.substring(0, 250)}`);
        failures.push({ name, err: msg });
        failed++;
    }
}

function assert(cond: boolean, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}

function delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

// ─── Globals ─────────────────────────────────────────────────
const DAVIDE_PHONE = '393762031767';
const CLUB_ID = '72fedeff-b228-42ac-b7b9-ad1339dfcb0b';
const RUN_ID = `tnf-${Date.now()}`;

let davide: any;
let club: any;
let auxM1: any;
let auxM2: any;
let auxF1: any;
let auxF2: any;
const createdMatchIds: string[] = [];

function jid(phone: string): string {
    return `${phone}@s.whatsapp.net`;
}

function futureDate(daysFromNow: number): string {
    const d = new Date();
    d.setDate(d.getDate() + daysFromNow);
    return d.toISOString().slice(0, 10);
}

// ─── Setup ───────────────────────────────────────────────────
async function setup() {
    console.log(`\n🔧 Setup (run: ${RUN_ID})…`);
    club = await prisma.club.findUniqueOrThrow({ where: { id: CLUB_ID } });
    davide = await prisma.player.findFirstOrThrow({
        where: { phoneNumber: DAVIDE_PHONE, clubId: CLUB_ID },
    });

    [auxM1, auxM2, auxF1, auxF2] = await Promise.all([
        prisma.player.create({ data: {
            clubId: CLUB_ID, name: `AuxM1 ${RUN_ID}`,
            phoneNumber: `390011${RUN_ID.slice(-6)}01`, skillLevel: 3.5,
            reliabilityScore: 0.8, active: true, gender: 'MALE',
        } as any }),
        prisma.player.create({ data: {
            clubId: CLUB_ID, name: `AuxM2 ${RUN_ID}`,
            phoneNumber: `390011${RUN_ID.slice(-6)}02`, skillLevel: 3.5,
            reliabilityScore: 0.8, active: true, gender: 'MALE',
        } as any }),
        prisma.player.create({ data: {
            clubId: CLUB_ID, name: `AuxF1 ${RUN_ID}`,
            phoneNumber: `390011${RUN_ID.slice(-6)}03`, skillLevel: 3.5,
            reliabilityScore: 0.8, active: true, gender: 'FEMALE',
        } as any }),
        prisma.player.create({ data: {
            clubId: CLUB_ID, name: `AuxF2 ${RUN_ID}`,
            phoneNumber: `390011${RUN_ID.slice(-6)}04`, skillLevel: 3.5,
            reliabilityScore: 0.8, active: true, gender: 'FEMALE',
        } as any }),
    ]);

    process.env.CLUB_ID = CLUB_ID;
    console.log(`  Davide: ${davide.name} (${DAVIDE_PHONE}), skill=${davide.skillLevel}`);
    console.log(`  Club: ${club.name}`);
    console.log(`  Aux players creati: ${auxM1.name}, ${auxM2.name}, ${auxF1.name}, ${auxF2.name}\n`);
}

// ─── Cleanup ─────────────────────────────────────────────────
async function cleanup() {
    console.log('\n🧹 Cleanup…');
    try {
        if (createdMatchIds.length > 0) {
            await prisma.invitation.deleteMany({ where: { matchId: { in: createdMatchIds } } });
            await prisma.matchPlayer.deleteMany({ where: { matchId: { in: createdMatchIds } } });
            await prisma.match.deleteMany({ where: { id: { in: createdMatchIds } } });
        }
        const auxPhones = [auxM1, auxM2, auxF1, auxF2].filter(Boolean).map((p: any) => p.phoneNumber);
        if (auxPhones.length > 0) {
            await prisma.whatsAppMessage.deleteMany({ where: { sender: { in: auxPhones } } });
        }
        // Rimuovi messaggi di test di Davide da questa run
        await prisma.whatsAppMessage.deleteMany({
            where: { sender: DAVIDE_PHONE, clubId: CLUB_ID, content: { contains: RUN_ID } },
        });
        const auxIds = [auxM1, auxM2, auxF1, auxF2].filter(Boolean).map((p: any) => p.id);
        if (auxIds.length > 0) await prisma.player.deleteMany({ where: { id: { in: auxIds } } });

        const redis = getRedis();
        await redis.del(`faq:pending_ids:${CLUB_ID}`);
        const faqKeys = await redis.keys(`faq:pending:${CLUB_ID}:*`);
        if (faqKeys.length > 0) await redis.del(...faqKeys as [string, ...string[]]);
        console.log('  Done.\n');
    } catch (err: any) {
        console.error('  Cleanup parzialmente fallito:', err.message);
    }
}

// ─── Brain helper ─────────────────────────────────────────────
async function brainTurn(phone: string, userMessage: string) {
    const { buildBrainContext, callBrain } = await import('../services/brain');
    const phoneJid = jid(phone);
    await prisma.whatsAppMessage.create({
        data: {
            chatId: phoneJid, sender: phone, role: 'USER', content: userMessage,
            messageId: `tnf-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            clubId: CLUB_ID, timestamp: new Date(),
        },
    });
    const context = await buildBrainContext(phoneJid, phone);
    await delay(2500);
    const result = await callBrain(context, userMessage);
    await prisma.whatsAppMessage.create({
        data: {
            chatId: phoneJid, sender: 'BOT', role: 'BOT', content: result.message,
            clubId: CLUB_ID, timestamp: new Date(Date.now() + 1),
        },
    });
    return result;
}

async function execAction(action: string, params: any, player: any, phone: string) {
    const { executeAction } = await import('../services/brain');
    return executeAction(action as any, params, player, club, phone);
}

// ─── TEST 1: FAQ playerJid fix ────────────────────────────────
async function test1_faqPlayerJid() {
    const redis = getRedis();
    await redis.del(`faq:pending_ids:${CLUB_ID}`);
    const oldKeys = await redis.keys(`faq:pending:${CLUB_ID}:*`);
    if (oldKeys.length > 0) await redis.del(...oldKeys as [string, ...string[]]);

    // Chiama executeAction direttamente (bypass brain) — testa solo il fix LID JID
    // Il brain potrebbe restituire NONE per history conversazione precedente, quindi
    // qui verifichiamo il comportamento di executeAction in modo diretto e ripetibile.
    await execAction(
        'FAQ_REQUEST',
        { question: `Avete la doccia calda in inverno? [${RUN_ID}]` },
        davide,
        DAVIDE_PHONE,
    );

    const ids = await redis.lrange(`faq:pending_ids:${CLUB_ID}`, 0, -1);
    assert(ids.length > 0, 'Nessun FAQ pending trovato in Redis dopo executeAction');

    const rawItems = await Promise.all(ids.map(id => redis.get(`faq:pending:${CLUB_ID}:${id}`)));
    const items = rawItems.filter(Boolean).map(r => JSON.parse(r!));
    const item = items[0];

    assert(
        typeof item.playerJid === 'string' && item.playerJid.endsWith('@s.whatsapp.net'),
        `playerJid in Redis è "${item.playerJid}" (atteso @s.whatsapp.net)`,
    );
    assert(
        item.playerJid === jid(DAVIDE_PHONE),
        `playerJid errato: "${item.playerJid}" (atteso: "${jid(DAVIDE_PHONE)}")`,
    );
}

// ─── TEST 2: Multi-intent ─────────────────────────────────────
async function test2_multiIntent() {
    const court = await prisma.court.findFirst({ where: { clubId: CLUB_ID } });
    assert(court !== null, 'Nessun campo trovato nel club staging');

    // Ignora tutte le invitation PENDING preesistenti di Davide per evitare ambiguità con brain
    await prisma.invitation.updateMany({
        where: { match: { clubId: CLUB_ID }, playerId: davide.id, status: 'PENDING' },
        data: { status: 'IGNORED' },
    });

    const matchStart = new Date();
    matchStart.setDate(matchStart.getDate() + 5);
    matchStart.setHours(16, 0, 0, 0);

    const openMatch = await prisma.match.create({
        data: {
            clubId: CLUB_ID, courtId: court!.id, startTime: matchStart,
            endTime: new Date(matchStart.getTime() + 90 * 60000),
            status: 'OPEN', playersNeeded: 4, skillLevel: 3.5, isMixed: false,
        } as any,
    });
    createdMatchIds.push(openMatch.id);
    await prisma.matchPlayer.create({ data: { matchId: openMatch.id, playerId: auxM1.id } });

    const inv = await prisma.invitation.create({
        data: { matchId: openMatch.id, playerId: davide.id, status: 'PENDING' },
    });

    const saturday = futureDate(4);
    const brainResult = await brainTurn(
        DAVIDE_PHONE,
        `Sì, accetto l'invito! E poi prenota ${saturday} alle 10:00 misto per favore`,
    );

    assert(
        brainResult.action === 'ACCEPT_INVITATION',
        `Azione primaria attesa ACCEPT_INVITATION, ottenuta: ${brainResult.action}. AI: "${brainResult.message.substring(0, 120)}"`,
    );
    assert(
        brainResult.secondaryAction === 'BOOK_FIELD',
        `secondaryAction atteso BOOK_FIELD, ottenuto: "${brainResult.secondaryAction ?? 'assente'}". AI: "${brainResult.message.substring(0, 120)}"`,
    );
    // Brain può usare "date" o "day" come chiave — entrambi validi
    const dateParam = brainResult.secondaryParams?.date ?? brainResult.secondaryParams?.day;
    assert(
        dateParam !== undefined,
        `secondaryParams.date/day mancante. params: ${JSON.stringify(brainResult.secondaryParams)}`,
    );

    // Esegui azione primaria
    const primaryResult = await execAction('ACCEPT_INVITATION', { invitationId: inv.id }, davide, DAVIDE_PHONE);
    assert(primaryResult.success, `ACCEPT_INVITATION fallito: ${primaryResult.errorMessage}`);

    // Esegui azione secondaria
    const secResult = await execAction('BOOK_FIELD', brainResult.secondaryParams || {}, davide, DAVIDE_PHONE);
    if (secResult.matchId) createdMatchIds.push(secResult.matchId);
    assert(
        secResult.success || secResult.errorMessage === 'ONLY_COVERED_AVAILABLE' || secResult.errorMessage === 'ALL_COURTS_TAKEN',
        `BOOK_FIELD secondario fallito: ${secResult.errorMessage}`,
    );
}

// ─── TEST 3: Single-intent regression ────────────────────────
async function test3_singleIntent() {
    // Usa orario mattutino insolito (+12gg) — bassa probabilità di slot pieno in staging
    const brainResult = await brainTurn(DAVIDE_PHONE, `Prenota fra 12 giorni alle 08:00 misto`);

    // La verifica chiave: nessun secondaryAction in messaggio a intento singolo
    assert(
        brainResult.secondaryAction === undefined,
        `secondaryAction inatteso per messaggio singolo: "${brainResult.secondaryAction}". AI: "${brainResult.message.substring(0, 120)}"`,
    );
    // Il brain deve almeno tentare un'azione (BOOK_FIELD o NONE se slot pieno)
    // Non assertiamo BOOK_FIELD strettamente perché dipende dalla disponibilità staging

    if (brainResult.action === 'BOOK_FIELD') {
        const bookResult = await execAction('BOOK_FIELD', brainResult.params, davide, DAVIDE_PHONE);
        if (bookResult.matchId) createdMatchIds.push(bookResult.matchId);
    }
}

// ─── TEST 4: Gender balance misto ────────────────────────────
async function test4_genderBalance() {
    const court = await prisma.court.findFirst({ where: { clubId: CLUB_ID } });
    assert(court !== null, 'Nessun campo trovato');

    const matchStart = new Date();
    matchStart.setDate(matchStart.getDate() + 6);
    matchStart.setHours(18, 0, 0, 0);

    const mixedMatch = await prisma.match.create({
        data: {
            clubId: CLUB_ID, courtId: court!.id, startTime: matchStart,
            endTime: new Date(matchStart.getTime() + 90 * 60000),
            status: 'OPEN', playersNeeded: 4, skillLevel: 3.5, isMixed: true,
        } as any,
    });
    createdMatchIds.push(mixedMatch.id);
    await prisma.matchPlayer.create({ data: { matchId: mixedMatch.id, playerId: auxM1.id } });

    const [invDavide, invAuxM2, invAuxF1, invAuxF2] = await Promise.all([
        prisma.invitation.create({ data: { matchId: mixedMatch.id, playerId: davide.id, status: 'PENDING' } }),
        prisma.invitation.create({ data: { matchId: mixedMatch.id, playerId: auxM2.id, status: 'PENDING' } }),
        prisma.invitation.create({ data: { matchId: mixedMatch.id, playerId: auxF1.id, status: 'PENDING' } }),
        prisma.invitation.create({ data: { matchId: mixedMatch.id, playerId: auxF2.id, status: 'PENDING' } }),
    ]);

    // Accetta Davide (MALE → 2M, 0F) → OPEN
    const r1 = await execAction('ACCEPT_INVITATION', { invitationId: invDavide.id }, davide, DAVIDE_PHONE);
    assert(r1.success, `Davide ACCEPT_INVITATION fallito: ${r1.errorMessage}`);
    const after2M = await prisma.match.findUniqueOrThrow({ where: { id: mixedMatch.id } });
    assert(after2M.status === 'OPEN', `Dopo 2M il match doveva essere OPEN, è ${after2M.status}`);

    // Prova 3° maschio → GENDER_SLOT_FULL
    const r2 = await execAction('ACCEPT_INVITATION', { invitationId: invAuxM2.id }, auxM2, auxM2.phoneNumber);
    assert(
        !r2.success && r2.errorMessage === 'GENDER_SLOT_FULL',
        `Atteso GENDER_SLOT_FULL, ottenuto: success=${r2.success} err="${r2.errorMessage}"`,
    );

    // Accetta auxF1 (2M+1F) → OPEN
    const r3 = await execAction('ACCEPT_INVITATION', { invitationId: invAuxF1.id }, auxF1, auxF1.phoneNumber);
    assert(r3.success, `auxF1 ACCEPT_INVITATION fallito: ${r3.errorMessage}`);
    const after2M1F = await prisma.match.findUniqueOrThrow({ where: { id: mixedMatch.id } });
    assert(after2M1F.status === 'OPEN', `Dopo 2M+1F il match doveva essere OPEN, è ${after2M1F.status}`);

    // Accetta auxF2 (2M+2F) → LOCKED
    const r4 = await execAction('ACCEPT_INVITATION', { invitationId: invAuxF2.id }, auxF2, auxF2.phoneNumber);
    assert(r4.success, `auxF2 ACCEPT_INVITATION fallito: ${r4.errorMessage}`);
    const afterFull = await prisma.match.findUniqueOrThrow({ where: { id: mixedMatch.id } });
    assert(afterFull.status === 'LOCKED', `Dopo 2M+2F il match doveva essere LOCKED, è ${afterFull.status}`);
}

// ─── TEST 5: BOOK_FIELD regression ───────────────────────────
async function test5_bookFieldRegression() {
    // Usa +15gg e orario mattutino insolito per evitare overlap con prenotazioni staging esistenti
    const result = await execAction(
        'BOOK_FIELD',
        { date: futureDate(15), time: '08:00', preferMixed: 'false' },
        davide, DAVIDE_PHONE,
    );
    if (result.matchId) createdMatchIds.push(result.matchId);
    assert(
        result.success || result.errorMessage === 'ONLY_COVERED_AVAILABLE' || result.errorMessage === 'ALL_COURTS_TAKEN',
        `BOOK_FIELD fallito: ${result.errorMessage}`,
    );
    if (result.success && result.matchId) {
        const mp = await prisma.matchPlayer.findFirst({
            where: { matchId: result.matchId, playerId: davide.id, leftAt: null },
        });
        assert(mp !== null, 'Davide non trovato nel MatchPlayer dopo BOOK_FIELD');
    }
}

// ─── TEST 6: CANCEL_MATCH regression ─────────────────────────
async function test6_cancelRegression() {
    const court = await prisma.court.findFirst({ where: { clubId: CLUB_ID } });
    const matchStart = new Date();
    matchStart.setDate(matchStart.getDate() + 7);
    matchStart.setHours(15, 0, 0, 0);

    const match = await prisma.match.create({
        data: {
            clubId: CLUB_ID, courtId: court!.id, startTime: matchStart,
            endTime: new Date(matchStart.getTime() + 90 * 60000),
            status: 'OPEN', playersNeeded: 4, skillLevel: 3.5, isMixed: false,
        } as any,
    });
    createdMatchIds.push(match.id);

    // CANCEL_MATCH richiede matchPlayerId (non matchId)
    const mpRecord = await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: davide.id } });

    const result = await execAction('CANCEL_MATCH', { matchPlayerId: mpRecord.id }, davide, DAVIDE_PHONE);
    assert(result.success, `CANCEL_MATCH fallito: ${result.errorMessage}`);

    const mp = await prisma.matchPlayer.findUnique({ where: { id: mpRecord.id } });
    assert(mp?.leftAt !== null && mp?.leftAt !== undefined, 'MatchPlayer.leftAt non impostato dopo CANCEL_MATCH');
}

// ─── MAIN ────────────────────────────────────────────────────
async function main() {
    await setup();
    console.log('🧪 Running tests…\n');

    await test('1. FAQ playerJid fix — Redis salva @s.whatsapp.net', test1_faqPlayerJid);
    await delay(3000);
    await test('2. Multi-intent — brain restituisce secondaryAction=BOOK_FIELD', test2_multiIntent);
    await delay(3000);
    await test('3. Regression: single-intent — nessun secondaryAction', test3_singleIntent);
    await delay(1000);
    await test('4. Gender balance misto — OPEN→LOCKED solo su 2M+2F', test4_genderBalance);
    await delay(1000);
    await test('5. Regression: BOOK_FIELD normale funziona ancora', test5_bookFieldRegression);
    await delay(1000);
    await test('6. Regression: CANCEL_MATCH funziona ancora', test6_cancelRegression);

    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Risultati: ${passed} ✅  ${failed} ❌  (${passed + failed} totali)`);
    if (failures.length > 0) {
        console.log('\nFallimenti:');
        failures.forEach(f => console.log(`  • ${f.name}: ${f.err.substring(0, 200)}`));
    }
    if (failed > 0) process.exit(1);
}

main()
    .catch(err => { console.error('\nErrore fatale:', err.message); process.exit(1); })
    .finally(() => cleanup().then(() => prisma.$disconnect()).catch(() => {}));
