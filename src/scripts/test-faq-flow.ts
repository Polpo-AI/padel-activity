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
// Test dei side effect DB/Redis, non della consegna WhatsApp: DRY_RUN evita di attendere/usare il socket WA
process.env.DRY_RUN = 'true';
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
    // Pulisci pending FAQ (schema attuale: lista + chiavi per id)
    const ids = await redis.lrange(`faq:pending_ids:${RUN_ID}`, 0, -1).catch(() => []);
    for (const id of ids) await redis.del(`faq:pending:${RUN_ID}:${id}`);
    await redis.del(`faq:pending_ids:${RUN_ID}`);
    await redis.del(`faq:awaiting_save_confirm:${RUN_ID}`);
    await redis.del(`faq:awaiting_merge_confirm:${RUN_ID}`);
    await redis.del(`faq:awaiting_conflict_resolve:${RUN_ID}`);
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

    // Schema FAQ pending attuale: lista faq:pending_ids:{clubId} + faq:pending:{clubId}:{id}
    const readFirstPending = async (): Promise<any | null> => {
        const ids = await redis.lrange(`faq:pending_ids:${RUN_ID}`, 0, -1);
        if (!ids.length) return null;
        const raw = await redis.get(`faq:pending:${RUN_ID}:${ids[0]}`);
        return raw ? JSON.parse(raw) : null;
    };

    const playerJid = `39000000001@s.whatsapp.net`;
    const adminJid  = `390000000001@s.whatsapp.net`;
    const question  = 'Avete docce e spogliatoi nel circolo?';
    const answer    = 'Sì, abbiamo spogliatoi con docce calde disponibili dalle 8 alle 23.';

    // ── 1. executeAction FAQ_REQUEST ──────────────────────────────────────────

    await test('FAQ_REQUEST: salva pending in Redis con playerJid', async () => {
        await runWithContext({ correlationId: RUN_ID, clubId: RUN_ID, jid: playerJid }, async () => {
            await executeAction('FAQ_REQUEST', { question }, player, club, '39000000001');
        });

        const data = await readFirstPending();
        assert(data !== null, 'pending FAQ deve essere in Redis');
        assert(data.question === question, `question: "${data.question}"`);
        assert(data.playerJid === playerJid, `playerJid: "${data.playerJid}"`);
        assert(data.askedBy === 'Utente Test', `askedBy: "${data.askedBy}"`);
    });

    // ── 2. pending NON cancellato dopo invio notifica ──────────────────────────

    await test('FAQ_REQUEST: pending NON cancellato dopo invio notifica', async () => {
        // Deve sopravvivere per quando l'admin risponde
        const data = await readFirstPending();
        assert(data !== null, 'pending FAQ deve ancora esistere');
    });

    // ── 3. handleAdminFaqFlow ignora messaggi non-FAQ ─────────────────────────

    await test('handleAdminFaqFlow: ignora messaggi non correlati', async () => {
        await runWithContext({ correlationId: RUN_ID, clubId: RUN_ID, jid: adminJid }, async () => {
            const handled = await handleAdminFaqFlow('ok perfetto', club, adminJid);
            assert(!handled, 'Messaggio generico non deve essere gestito dal flusso FAQ');
        });
        const data = await readFirstPending();
        assert(data !== null, 'pending intatto dopo messaggio non-FAQ');
    });

    // ── 4. handleAdminFaqFlow con risposta valida ─────────────────────────────

    await test('handleAdminFaqFlow: la risposta admin avvia il salvataggio', async () => {
        await runWithContext({ correlationId: RUN_ID, clubId: RUN_ID, jid: adminJid }, async () => {
            const handled = await handleAdminFaqFlow(answer, club, adminJid);
            assert(handled, 'handleAdminFaqFlow deve gestire la risposta dell\'admin');
        });

        // Esiti possibili: FAQ già in DB, oppure in attesa di un secondo passo admin
        // (review automatica → awaiting_improvement, o low-confidence → awaiting_save_confirm)
        const faqInDb           = await prisma.faq.findFirst({ where: { clubId: RUN_ID } });
        const awaitingImprove   = await redis.get(`faq:awaiting_improvement:${RUN_ID}`);
        const awaitingConfirm   = await redis.get(`faq:awaiting_save_confirm:${RUN_ID}`);
        assert(!!(faqInDb || awaitingImprove || awaitingConfirm),
            'FAQ deve essere in DB o in uno stato di attesa (improvement/save_confirm)');
        console.log(`     ℹ️  Esito: ${faqInDb ? 'in DB' : awaitingImprove ? 'awaiting_improvement' : 'awaiting_save_confirm'}`);
    });

    // ── 5. Admin completa l'eventuale secondo passo → FAQ nel DB ──────────────

    await test('handleAdminFaqFlow: completamento → FAQ nel DB', async () => {
        let faq = await prisma.faq.findFirst({ where: { clubId: RUN_ID } });
        if (!faq) {
            const awaitingImprove = await redis.get(`faq:awaiting_improvement:${RUN_ID}`);
            // su improvement "no" = tieni l'originale; su save_confirm "sì" = salva
            const reply = awaitingImprove ? 'no' : 'sì';
            await runWithContext({ correlationId: RUN_ID, clubId: RUN_ID, jid: adminJid }, async () => {
                await handleAdminFaqFlow(reply, club, adminJid);
            });
            faq = await prisma.faq.findFirst({ where: { clubId: RUN_ID } });
        }
        assert(faq !== null, 'FAQ salvata nel DB dopo il completamento');
        assert(faq!.answer === answer, `answer atteso "${answer}", got "${faq!.answer}"`);

        // Nessuno stato di attesa deve restare appeso
        const pendingStates = await Promise.all([
            redis.get(`faq:awaiting_improvement:${RUN_ID}`),
            redis.get(`faq:awaiting_save_confirm:${RUN_ID}`),
        ]);
        assert(pendingStates.every(s => s === null), 'stati di attesa cancellati dopo il salvataggio');
    });

    // ── 6. faq:pending_question cancellata dopo risposta admin ────────────────

    await test('pending cancellato dopo che admin ha risposto', async () => {
        const data = await readFirstPending();
        assert(data === null, `pending deve essere null, got: ${JSON.stringify(data)}`);
    });

    // ── 7. buildBrainContext include la FAQ ───────────────────────────────────

    await test('buildBrainContext include la FAQ salvata', async () => {
        await runWithContext({ correlationId: RUN_ID, clubId: RUN_ID, jid: playerJid }, async () => {
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
