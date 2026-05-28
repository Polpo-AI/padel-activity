/**
 * TEST REDIRECT — slot completamente pieno
 *
 * Verifica la fix: quando l'orario richiesto è in fullSlots il brain DEVE
 * fare BOOK_FIELD (non NONE) → executeAction ritorna ALL_COURTS_TAKEN →
 * il redirect propone alternative reali dal DB.
 *
 * Esegui SUL VPS:  npx tsx src/scripts/test-redirect-fullslot.ts
 */
import 'dotenv/config';
import { prisma } from '../services/db';

const fmt = (d: Date) => d.toLocaleString('it-IT', { timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });

async function main() {
    const club = await prisma.club.findFirst({ include: { courts: true } });
    if (!club) throw new Error('NO CLUB');
    process.env.CLUB_ID = club.id;

    // Mercoledì prossimo alle 21:00 Rome (CEST = UTC+2) → 19:00 UTC
    const target = new Date('2026-06-03T19:00:00Z');
    console.log(`Slot target: ${fmt(target)} (${target.toISOString()})  | club=${club.name} | ${club.courts.length} campi`);

    const createdMatchIds: string[] = [];
    const testPhone = '393000000999';
    const testJid = `${testPhone}@s.whatsapp.net`;
    let testPlayerId: string | null = null;

    try {
        // 1. Riempi TUTTI i campi a quell'orario → fullSlot
        for (const court of club.courts) {
            const m = await prisma.match.create({
                data: {
                    clubId: club.id,
                    courtId: court.id,
                    startTime: target,
                    skillLevel: 3.0,
                    playersNeeded: 4,
                    status: 'LOCKED',
                    title: 'TEST-REDIRECT-FILLER',
                },
            });
            createdMatchIds.push(m.id);
        }
        console.log(`Creati ${createdMatchIds.length} match filler (slot ora pieno)\n`);

        // 2. Player di test registrato
        const tp = await prisma.player.create({
            data: { clubId: club.id, name: 'Test Redirect', phoneNumber: testPhone, skillLevel: 3.0, gender: 'MALE' },
        });
        testPlayerId = tp.id;

        // 3. Turno conversazione con il brain
        const { buildBrainContext, callBrain, executeAction } = await import('../services/brain');
        const userMessage = 'Ciao, vorrei prenotare un campo da padel mercoledì alle 21, vengo con tre amici';

        await prisma.whatsAppMessage.create({
            data: { chatId: testJid, sender: testPhone, role: 'USER', content: userMessage, messageId: `trf-${Date.now()}`, clubId: club.id, timestamp: new Date() },
        });

        const ctx = await buildBrainContext(testJid, testPhone);
        const inFull = ctx.slotsAvailability.fullSlots.some(s => s.includes('21:00') && s.includes('3/6'));
        console.log(`fullSlots contiene lo slot 21:00 del 3/6? ${inFull ? 'SÌ ✅' : 'NO ❌'}`);
        console.log(`  fullSlots: ${JSON.stringify(ctx.slotsAvailability.fullSlots)}\n`);

        const brain = await callBrain(ctx, userMessage);
        console.log(`🤖 Brain message: "${brain.message}"`);
        console.log(`   action: ${brain.action}`);
        console.log(`   params: ${JSON.stringify(brain.params)}\n`);

        const passBookField = brain.action === 'BOOK_FIELD';
        console.log(`[ASSERT 1] brain.action === BOOK_FIELD (non NONE): ${passBookField ? 'PASS ✅' : 'FAIL ❌'}`);

        let passAllTaken = false;
        let redirectTime = target;
        if (brain.action === 'BOOK_FIELD') {
            const res: any = await executeAction('BOOK_FIELD', brain.params, ctx.player, ctx.club, testPhone);
            console.log(`\n   executeAction result: ${JSON.stringify({ success: res.success, errorMessage: res.errorMessage })}`);
            passAllTaken = res.errorMessage === 'ALL_COURTS_TAKEN';
            if (res.requestedTime) redirectTime = res.requestedTime;
            console.log(`[ASSERT 2] executeAction → ALL_COURTS_TAKEN: ${passAllTaken ? 'PASS ✅' : 'FAIL ❌'}`);
        }

        // 4. Mostra le alternative reali che il redirect proporrebbe
        if (passAllTaken) {
            const { findRedirectOptions } = await import('../services/redirect');
            const options = await findRedirectOptions(1, redirectTime, 'none', club.id, ctx.player?.skillLevel ?? 0, null, 'BOOK_FIELD');
            console.log(`\n📍 Alternative proposte dal redirect (${options.length}):`);
            for (const o of options) {
                console.log(`   [P${o.priority}] ${fmt(o.startTime)} | ${o.court} (${o.courtIsCovered ? 'coperto' : 'scoperto'}) | ${o.description}`);
            }
            console.log(`[ASSERT 3] redirect propone ≥1 alternativa: ${options.length > 0 ? 'PASS ✅' : 'FAIL ❌'}`);
        }

        console.log(`\n${'='.repeat(50)}`);
        console.log(`ESITO: ${passBookField && passAllTaken ? 'REDIRECT FUNZIONA ✅' : 'PROBLEMA ❌'}`);
    } finally {
        // Cleanup
        if (createdMatchIds.length) await prisma.match.deleteMany({ where: { id: { in: createdMatchIds } } });
        await prisma.whatsAppMessage.deleteMany({ where: { chatId: testJid } });
        if (testPlayerId) await prisma.player.delete({ where: { id: testPlayerId } }).catch(() => {});
        console.log('\n🧹 Cleanup completato (match filler, player e messaggi di test rimossi)');
        await prisma.$disconnect();
    }
}
main().catch(e => { console.error(e); process.exit(1); });
