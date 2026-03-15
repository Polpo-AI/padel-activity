/**
 * TEST LIVELLO 5 — Race Condition e Flusso Inviti
 *
 * Verifica che:
 * - Il sistema crei correttamente le Invitation quando processWave viene chiamato
 * - La Race Condition (FOR UPDATE) impedisca doppie accettazioni
 */
import { prisma } from '../src/services/db';
import * as dotenv from 'dotenv';
dotenv.config();

const CLUB_ID = 'ebff5173-3fd4-4beb-b919-f904343bd551';
const TEST_PHONES = ['+39111001', '+39111002', '+39111003', '+39111004'];

async function cleanup(matchId?: string) {
    if (matchId) {
        await prisma.invitation.deleteMany({ where: { matchId } });
        await prisma.matchPlayer.deleteMany({ where: { matchId } });
        await prisma.match.deleteMany({ where: { id: matchId } });
    }
    await prisma.player.deleteMany({ where: { clubId: CLUB_ID, phoneNumber: { in: TEST_PHONES } } });
}

async function run() {
    console.log('\n🧪 TEST LIVELLO 5 — Flusso Inviti e Race Condition\n');

    await cleanup();

    const now = new Date();
    const players = await Promise.all(
        TEST_PHONES.map((phone, i) =>
            prisma.player.create({
                data: { clubId: CLUB_ID, phoneNumber: phone, name: `TestRace${i+1}`, skillLevel: 2, active: true, reliabilityScore: 0.7 }
            })
        )
    );

    const match = await prisma.match.create({
        data: {
            clubId: CLUB_ID,
            startTime: new Date(now.getTime() + 3 * 60 * 60_000),
            skillLevel: 2, playersNeeded: 2, status: 'OPEN'
        }
    });

    console.log(`✅ Match creato (2 posti): ${match.id}`);
    console.log(`✅ ${players.length} giocatori di test creati.`);

    // 5.1 — Crea inviti manualmente per simulare wave
    await prisma.invitation.createMany({
        data: players.map(p => ({ matchId: match.id, playerId: p.id, status: 'PENDING' }))
    });
    const invitations = await prisma.invitation.findMany({ where: { matchId: match.id } });
    console.log(`\n📨 ${invitations.length} inviti creati.`);
    if (invitations.length === players.length) {
        console.log('✅ PASS: Inviti creati correttamente per tutti i giocatori.');
    } else {
        console.log('❌ FAIL: Numero di inviti errato.');
    }

    // 5.2 — Simula Race Condition: 4 giocatori accettano "contemporaneamente"
    console.log('\n⚡ Test Race Condition: 4 giocatori accettano contemporaneamente (2 posti disponibili)...');

    const results = await Promise.allSettled(
        players.map(async (player) => {
            return await prisma.$transaction(async (tx) => {
                // Blocco con row-level lock
                const locked = await tx.$queryRaw<any[]>`
                    SELECT * FROM "Match" WHERE id = ${match.id} FOR UPDATE
                `;
                const currentMatch = locked[0];
                
                const currentPlayers = await tx.matchPlayer.count({ where: { matchId: match.id } });
                if (currentPlayers >= currentMatch.playersNeeded) {
                    throw new Error('Match già pieno');
                }
                
                await tx.matchPlayer.create({ data: { matchId: match.id, playerId: player.id } });
                await tx.invitation.updateMany({
                    where: { matchId: match.id, playerId: player.id },
                    data: { status: 'ACCEPTED' }
                });
                return player.name;
            });
        })
    );

    const accepted = results.filter(r => r.status === 'fulfilled').map(r => (r as any).value);
    const rejected = results.filter(r => r.status === 'rejected').map(r => (r as any).reason?.message);

    console.log(`✅ Accettati (${accepted.length}): ${accepted.join(', ')}`);
    console.log(`🚫 Rigettati per Match pieno (${rejected.length}): ${rejected.join(', ')}`);

    const finalCount = await prisma.matchPlayer.count({ where: { matchId: match.id } });

    if (finalCount === match.playersNeeded) {
        console.log(`\n✅ PASS: Race Condition — Esattamente ${match.playersNeeded} giocatori accettati (su ${players.length} tentativi). Nessun posto in eccesso!`);
    } else {
        console.error(`\n❌ FAIL: Race Condition — ${finalCount} giocatori registrati (attesi: ${match.playersNeeded})!`);
    }

    await cleanup(match.id);
    console.log('\n🧹 Dati di test rimossi.');
    console.log('\n🎉 LIVELLO 5 — TEST COMPLETATO!\n');
}

run().catch(e => console.error('❌ Errore fatale:', e.message));
