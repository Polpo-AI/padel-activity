/**
 * TEST FAQ FLOW — verifica side effect (Redis + DB), no WA mock
 *
 * Flusso testato:
 *  1. executeAction FAQ_REQUEST → salva in Redis con playerJid + notifica admin
 *  2. handleAdminFaqFlow → classifica risposta admin, inoltra a utente, salva FAQ
 *  3. buildBrainContext → include la FAQ salvata nel contesto
 *
 * Uso (sul VPS):
 *   DATABASE_URL="postgresql://..." npx tsx src/scripts/test-faq-flow.ts
 */

import 'dotenv/config';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── Runner ───────────────────────────────────────────────────────────────────

let passed = 0; let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (err: any) {
        console.log(`  ❌ ${name}\n     → ${err?.message ?? String(err)}`);
        failed++;
    }
}

function assert(cond: boolean, msg: string): asserts cond {
    if (!cond) throw new Error(msg);
}

// ─── Setup / Teardown ────────────────────────────────────────────────────────

const RUN_ID = `faq-test-${Date.now()}`;

async function setup() {
    const club = await prisma.club.create({
        data: {
            id: RUN_ID,
            name: `_TEST_ FAQ`,
            timezone: 'Europe/Rome',
            matchDuration: 90,
            openTime: '08:00',
            closeTime: '23:30',
            adminPhone: '390000000001',
            matchLowerRange: 1.0,
            matchUpperRange: 1.0,
            maxDailyMessages: 10,
        },
    });
    const player = await prisma.player.create({
        data: {
            clubId: RUN_ID,
            name: 'Utente Test',
            phoneNumber: '39000000001',
            skillLevel: 3.5,
            reliabilityScore: 0.33,
            active: true,
        },
    });
    return { club, player };
}

async function teardown(redis: any) {
    await prisma.faq.deleteMany({ where: { clubId: RUN_ID } });
    await prisma.player.deleteMany({ where: { clubId: RUN_ID } });
    await prisma.club.deleteMany({ where: { id: RUN_ID } });
    await redis.del(`faq:pending_question:${RUN_ID}`);
    await redis.del(`faq:awaiting_save_confirm:${RUN_ID}`);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n📦 FAQ FLOW — Test suite\n');

    const { club, player } = await setup();

    const { getRedis }       = await import('../services/queue');
    const { executeAction, buildBrainContext } = await import('../services/brain');
    const { handleAdminFaqFlow } = await import('../services/admin-commands');
    const { runWithContext } = await import('../utils/request-context');
    const redis = getRedis();

    const playerJid = `39000000001@s.whatsapp.net`;
    const adminJid  = `390000000001@s.whatsapp.net`;
    const question  = 'Avete docce e spogliatoi nel circolo?';
    const answer    = 'Sì, abbiamo spogliatoi con docce calde disponibili dalle 8 alle 23.';

    // ── 1. executeAction FAQ_REQUEST ──────────────────────────────────────────

    await test('FAQ_REQUEST: salva pending in Redis con playerJid', async () => {
        await runWithContext({ clubId: RUN_ID, jid: playerJid }, async () => {
            await executeAction('FAQ_REQUEST', { question }, player, club, '39000000001', playerJid);
        });

        const raw = await redis.get(`faq:pending_question:${RUN_ID}`);
        assert(raw !== null, 'faq:pending_question deve essere in Redis');

        const data = JSON.parse(raw!);
        assert(data.question === question, `question: "${data.question}"`);
        assert(data.playerJid === playerJid, `playerJid: "${data.playerJid}"`);
        assert(data.askedBy === 'Utente Test', `askedBy: "${data.askedBy}"`);
    });

    // ── 2. faq:pending_question NON cancellata dopo invio notifica ─────────────

    await test('FAQ_REQUEST: chiave Redis NON cancellata dopo invio notifica', async () => {
        // La chiave deve sopravvivere per quando l'admin risponde
        const raw = await redis.get(`faq:pending_question:${RUN_ID}`);
        assert(raw !== null, 'faq:pending_question deve ancora esistere');
    });

    // ── 3. handleAdminFaqFlow ignora messaggi non-FAQ ─────────────────────────

    await test('handleAdminFaqFlow: ignora messaggi non correlati', async () => {
        await runWithContext({ clubId: RUN_ID, jid: adminJid }, async () => {
            const handled = await handleAdminFaqFlow('ok perfetto', club, adminJid);
            assert(!handled, 'Messaggio generico non deve essere gestito dal flusso FAQ');
        });
        const raw = await redis.get(`faq:pending_question:${RUN_ID}`);
        assert(raw !== null, 'faq:pending_question intatta dopo messaggio non-FAQ');
    });

    // ── 4. handleAdminFaqFlow con risposta valida ─────────────────────────────

    await test('handleAdminFaqFlow: classifica risposta come isFaqAnswer', async () => {
        await runWithContext({ clubId: RUN_ID, jid: adminJid }, async () => {
            const handled = await handleAdminFaqFlow(answer, club, adminJid);
            assert(handled, 'handleAdminFaqFlow deve gestire la risposta dell\'admin');
        });

        // Dopo la risposta, o la FAQ è in DB (high confidence) o in awaiting_save_confirm (low)
        const faqInDb       = await prisma.faq.findFirst({ where: { clubId: RUN_ID } });
        const awaitingConfirm = await redis.get(`faq:awaiting_save_confirm:${RUN_ID}`);
        const savedOrPending = faqInDb !== null || awaitingConfirm !== null;
        assert(savedOrPending, 'FAQ deve essere in DB o in attesa di conferma admin');

        if (faqInDb) {
            console.log(`     ℹ️  Auto-salvata (high confidence): "${faqInDb.question}"`);
        } else {
            const conf = JSON.parse(awaitingConfirm!);
            assert(conf.playerJid === playerJid, `playerJid preserved in awaiting_save_confirm: ${conf.playerJid}`);
            console.log(`     ℹ️  Low confidence → in attesa conferma admin`);
        }
    });

    // ── 5. Se low-confidence: admin conferma → FAQ salvata ────────────────────

    await test('handleAdminFaqFlow: conferma admin (sì) → FAQ nel DB', async () => {
        const awaitingConfirm = await redis.get(`faq:awaiting_save_confirm:${RUN_ID}`);

        if (!awaitingConfirm) {
            // Già salvata al test precedente
            const faq = await prisma.faq.findFirst({ where: { clubId: RUN_ID } });
            assert(faq !== null, 'FAQ deve essere nel DB');
            console.log(`     ℹ️  Già auto-salvata, skip conferma`);
            return;
        }

        await runWithContext({ clubId: RUN_ID, jid: adminJid }, async () => {
            const handled = await handleAdminFaqFlow('sì', club, adminJid);
            assert(handled, 'Conferma "sì" deve essere gestita');
        });

        const faq = await prisma.faq.findFirst({ where: { clubId: RUN_ID } });
        assert(faq !== null, 'FAQ salvata nel DB dopo conferma');
        assert(faq!.answer === answer, `answer: "${faq!.answer}"`);

        const confirmGone = await redis.get(`faq:awaiting_save_confirm:${RUN_ID}`);
        assert(confirmGone === null, 'awaiting_save_confirm cancellata dopo conferma');
    });

    // ── 6. faq:pending_question cancellata dopo risposta admin ────────────────

    await test('faq:pending_question cancellata dopo che admin ha risposto', async () => {
        const raw = await redis.get(`faq:pending_question:${RUN_ID}`);
        assert(raw === null, `faq:pending_question deve essere null, got: ${raw}`);
    });

    // ── 7. buildBrainContext include la FAQ ───────────────────────────────────

    await test('buildBrainContext include la FAQ salvata', async () => {
        await runWithContext({ clubId: RUN_ID, jid: playerJid }, async () => {
            const ctx = await buildBrainContext(playerJid, '39000000001');
            const faq = ctx.faqs?.find((f: any) =>
                f.question?.includes('docce') || f.answer?.includes('docce') ||
                f.question?.includes('spogliatoi') || f.answer?.includes('spogliatoi')
            );
            assert(!!faq, `ctx.faqs deve contenere la FAQ salvata. faqs: ${JSON.stringify(ctx.faqs?.slice(0, 3))}`);
        });
    });

    // ── Teardown ──────────────────────────────────────────────────────────────

    await teardown(redis);
    await prisma.$disconnect();
    await pool.end();

    // ── Risultato ─────────────────────────────────────────────────────────────
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Risultati: ${passed} ✅  ${failed} ❌`);
    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
