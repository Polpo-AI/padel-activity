const { prisma } = require('./dist/services/db.js');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');
const webhooks = require('./dist/api/webhooks.js').default;

const app = express();
app.use(express.json());
app.use('/api/webhooks', webhooks);

async function runTest() {
    console.log("=== INIZIO TEST 2 (Sicurezza Webhook HMAC) ===");
    process.env.WEBHOOK_SECRET = 'test_secret_for_hmac_verification';
    
    const payload = JSON.stringify({
        court: "Campo Test",
        time: new Date().toISOString(),
        skill_level: "3",
        players_needed: 2,
        clubId: "fake_club_id"
    });

    const signature = 'sha256=' + crypto.createHmac('sha256', process.env.WEBHOOK_SECRET).update(payload).digest('hex');

    let res1 = await request(app).post('/api/webhooks/slots').send(JSON.parse(payload));
    console.log("TEST 2.A: Richiesta Senza Signature -> Status:", res1.statusCode, "(Atteso: 401)");

    let res2 = await request(app).post('/api/webhooks/slots')
        .set('x-webhook-signature', 'sha256=invalid_hash')
        .send(JSON.parse(payload));
    console.log("TEST 2.B: Richiesta con Signature invalida -> Status:", res2.statusCode, "(Atteso: 401)");

    let res3 = await request(app).post('/api/webhooks/slots')
        .set('x-webhook-signature', signature)
        .send(JSON.parse(payload));
    console.log("TEST 2.C: Richiesta con Signature valida -> Status:", res3.statusCode, "(Atteso: 404 - Club mancante, ma NON 401)");
    
    console.log("\n=== INIZIO TEST 3 (Multi-Tenancy) ===");
    const club1 = await prisma.club.create({ data: { name: 'Club Alpha' } });
    const club2 = await prisma.club.create({ data: { name: 'Club Omega' } });

    console.log("1. Creati due circoli distinti:", club1.id, club2.id);

    const player1 = await prisma.player.create({
        data: { phoneNumber: '+39111', clubId: club1.id, name: 'Mario', skillLevel: 3, reliabilityScore: 1 }
    });

    const matchClub1 = await prisma.match.create({
        data: {
            clubId: club1.id,
            courtId: null,
            startTime: new Date(Date.now() + 100000),
            skillLevel: 3,
            playersNeeded: 4,
            status: 'OPEN'
        }
    });

    const matchClub2 = await prisma.match.create({
        data: {
            clubId: club2.id,
            courtId: null,
            startTime: new Date(Date.now() + 100000),
            skillLevel: 3,
            playersNeeded: 4,
            status: 'OPEN'
        }
    });
    
    console.log("2. Creati 2 Match (uno per Club Alpha, uno per Club Omega)");

    // Test query come in booking.ts
    const openMatchesForPlayer1 = await prisma.match.findMany({
        where: {
            clubId: player1.clubId,
            status: 'OPEN',
            skillLevel: player1.skillLevel
        }
    });

    const seesClub2 = openMatchesForPlayer1.some(m => m.clubId === club2.id);
    console.log("3. Mario (Alpha) vede il match del Club Omega?", seesClub2 ? "Sì, PROBLEMA!" : "No, OK (Isolamento riuscito)");
    console.log("Mario (Alpha) vede quanti match validi?", openMatchesForPlayer1.length);
    
    // Cleanup
    await prisma.match.deleteMany({ where: { id: { in: [matchClub1.id, matchClub2.id] } } });
    await prisma.player.delete({ where: { id: player1.id } });
    await prisma.club.deleteMany({ where: { id: { in: [club1.id, club2.id] } } });
    
    console.log("MOCK DATI DB PULITI");
    process.exit(0);
}

runTest().catch(e => { console.error(e); process.exit(1); });
