/**
 * TEST RELIABILITY — alpha adattivo
 * Confronta il nuovo α = max(0.08, 1/(n+1)) col vecchio α fisso 0.15 su due scenari:
 *   - Veterano: tanta storia (n=40), un paio di inviti ignorati → deve restare stabile
 *   - Nuovo: poca storia (n=2) → deve imparare in fretta (no cold-start bloccato sul PRIOR)
 *
 * Esegui sul VPS:  npx tsx src/scripts/test-reliability.ts
 */
import 'dotenv/config';
import { prisma } from '../services/db';
import { updateShowUpRate } from '../services/scoring';

const RUN = `rel-test-${Date.now()}`;
const OLD_ALPHA = 0.15;

async function makePlayer(name: string, score: number, nObservations: number, matchId: string) {
    const p = await prisma.player.create({
        data: { clubId: RUN, name, phoneNumber: `${RUN}-${name}`, skillLevel: 3.0, reliabilityScore: score },
    });
    // n inviti già processati (ACCEPTED) → determinano l'alpha adattivo
    for (let i = 0; i < nObservations; i++) {
        await prisma.invitation.create({ data: { matchId, playerId: p.id, status: 'ACCEPTED' } });
    }
    return p;
}

async function scenario(label: string, player: any, startScore: number) {
    console.log(`\n=== ${label} (score iniziale ${startScore.toFixed(3)}) ===`);
    let old = startScore;
    for (let miss = 1; miss <= 2; miss++) {
        await updateShowUpRate(player.id, false, 360); // invito ignorato
        const fresh = await prisma.player.findUnique({ where: { id: player.id } });
        old = old * (1 - OLD_ALPHA); // proiezione col vecchio alpha fisso
        console.log(`  miss ${miss}: nuovo=${fresh!.reliabilityScore.toFixed(3)}   (vecchio α=0.15 avrebbe dato ${old.toFixed(3)})`);
    }
}

async function coldStartClimb(matchId: string) {
    console.log(`\n=== COLD-START: nuovo (prior 0.33) che accetta 4 inviti ===`);
    const p = await prisma.player.create({
        data: { clubId: RUN, name: 'ColdStart', phoneNumber: `${RUN}-cold`, skillLevel: 3.0, reliabilityScore: 0.33 },
    });
    let old = 0.33;
    for (let i = 1; i <= 4; i++) {
        await prisma.invitation.create({ data: { matchId, playerId: p.id, status: 'ACCEPTED' } });
        await updateShowUpRate(p.id, true, 360); // presentato
        const fresh = await prisma.player.findUnique({ where: { id: p.id } });
        old = old * (1 - OLD_ALPHA) + OLD_ALPHA * 1.0;
        console.log(`  accetta ${i}: nuovo=${fresh!.reliabilityScore.toFixed(3)}   (vecchio α=0.15 avrebbe dato ${old.toFixed(3)})`);
    }
}

async function main() {
    await prisma.club.create({ data: { id: RUN, name: '_TEST_ reliability', timezone: 'Europe/Rome' } });
    const match = await prisma.match.create({ data: { clubId: RUN, startTime: new Date(), skillLevel: 3.0 } });

    const veteran = await makePlayer('Veterano', 0.97, 40, match.id);
    const novice  = await makePlayer('Nuovo', 0.51, 2, match.id);

    await scenario('VETERANO  n=40 (2 inviti ignorati)', veteran, 0.97);
    await scenario('NUOVO     n=2  (2 inviti ignorati)',  novice, 0.51);
    await coldStartClimb(match.id);

    // teardown
    await prisma.invitation.deleteMany({ where: { matchId: match.id } });
    await prisma.match.deleteMany({ where: { clubId: RUN } });
    await prisma.player.deleteMany({ where: { clubId: RUN } });
    await prisma.club.deleteMany({ where: { id: RUN } });
    console.log('\n🧹 Cleanup completato');
    await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
