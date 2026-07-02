/**
 * TEST DI INTEGRAZIONE LOCALE — API dashboard reale (supertest, no mock).
 * Prerequisiti: Postgres :5433 + Redis :6379 attivi, .env di test.
 *
 *   A1  login con credenziali valide → token JWT + dati club
 *   A2  login con password errata → 401
 *   A3  endpoint protetto senza token → 401
 *   A4  endpoint protetto con token → dati del SOLO proprio club
 *   A5  creazione campo via API → persistito
 *   A6  no-show su un match → reliability del giocatore scende
 */
import 'dotenv/config';
import express from 'express';
import request from 'supertest';
import bcrypt from 'bcrypt';

let passed = 0, failed = 0;
const failures: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
    const { prisma } = await import('../src/services/db');
    const dashboardRouter = (await import('../src/api/dashboard.api')).default;

    const app = express();
    app.use(express.json());
    app.use('/api/dashboard', dashboardRouter);

    console.log('\n════ SETUP: club con credenziali dashboard ════');
    // Non tocca i dati dei test di booking: club dedicato (cleanup in ordine FK)
    const oldClub = await prisma.club.findFirst({ where: { dashboardUsername: 'apitest' } });
    if (oldClub) {
        await prisma.invitation.deleteMany({ where: { match: { clubId: oldClub.id } } });
        await prisma.matchPlayer.deleteMany({ where: { match: { clubId: oldClub.id } } });
        await prisma.match.deleteMany({ where: { clubId: oldClub.id } });
        await prisma.courtPrice.deleteMany({ where: { court: { clubId: oldClub.id } } });
        await prisma.court.deleteMany({ where: { clubId: oldClub.id } });
        await prisma.player.deleteMany({ where: { clubId: oldClub.id } });
        await prisma.club.delete({ where: { id: oldClub.id } });
    }
    const hash = await bcrypt.hash('password-sicura-123', 10);
    const club = await prisma.club.create({
        data: {
            name: 'Circolo API Test', dashboardUsername: 'apitest', dashboardPasswordHash: hash,
            courts: { create: [{ name: 'Campo API 1', isCovered: false }] },
        },
        include: { courts: true },
    });

    // ════ A1: login ok ════
    console.log('\n════ A1-A2: login ════');
    const login = await request(app).post('/api/dashboard/login').send({ username: 'apitest', password: 'password-sicura-123' });
    check('A1 login 200 + token', login.status === 200 && !!login.body.token, `status=${login.status}`);
    check('A1 club corretto nel payload', login.body.club?.name === 'Circolo API Test');
    const token = login.body.token;

    // ════ A2: password errata ════
    const badLogin = await request(app).post('/api/dashboard/login').send({ username: 'apitest', password: 'sbagliata' });
    check('A2 password errata → 401', badLogin.status === 401, `status=${badLogin.status}`);

    // ════ A3: senza token ════
    console.log('\n════ A3-A4: autorizzazione ════');
    const noAuth = await request(app).get('/api/dashboard/courts');
    check('A3 endpoint protetto senza token → 401', noAuth.status === 401, `status=${noAuth.status}`);

    // ════ A4: con token → solo il proprio club ════
    const courts = await request(app).get('/api/dashboard/courts').set('Authorization', `Bearer ${token}`);
    check('A4 lista campi 200', courts.status === 200, `status=${courts.status}`);
    const courtList = Array.isArray(courts.body) ? courts.body : courts.body.courts || [];
    check('A4 vede SOLO i campi del proprio club', courtList.length === 1 && courtList[0].name === 'Campo API 1',
        `campi visti: ${courtList.length} (${courtList.map((c: any) => c.name).join(',')})`);

    // ════ A5: CRUD reali — crea giocatore + modifica campo ════
    // (la creazione campi avviene solo dal wizard di setup: POST /courts non esiste by design)
    console.log('\n════ A5: POST /players + PATCH /courts/:id ════');
    const newPlayer = await request(app).post('/api/dashboard/players').set('Authorization', `Bearer ${token}`)
        .send({ phoneNumber: '393339990002', name: 'Creato Da API', skillLevel: 4 });
    check('A5 creazione giocatore ok', [200, 201].includes(newPlayer.status), `status=${newPlayer.status} ${JSON.stringify(newPlayer.body).slice(0, 120)}`);
    const pPersisted = await prisma.player.findFirst({ where: { clubId: club.id, phoneNumber: '393339990002' } });
    check('A5 giocatore persistito con skill 4', pPersisted?.skillLevel === 4, `skill=${pPersisted?.skillLevel}`);

    const editCourt = await request(app).patch(`/api/dashboard/courts/${club.courts[0].id}`).set('Authorization', `Bearer ${token}`)
        .send({ name: 'Campo API 1 Rinominato' });
    check('A5 modifica campo ok', editCourt.status === 200, `status=${editCourt.status} ${JSON.stringify(editCourt.body).slice(0, 120)}`);
    const cPersisted = await prisma.court.findUnique({ where: { id: club.courts[0].id } });
    check('A5 rinomina persistita', cPersisted?.name === 'Campo API 1 Rinominato', cPersisted?.name);

    // ════ A6: no-show → reliability scende ════
    console.log('\n════ A6: no-show → reliability aggiornata ════');
    const player = await prisma.player.create({
        data: { clubId: club.id, phoneNumber: '393339990001', name: 'NoShow Tester', skillLevel: 3, reliabilityScore: 0.8 },
    });
    const match = await prisma.match.create({
        data: { clubId: club.id, courtId: club.courts[0].id, startTime: new Date(Date.now() - 3600_000), skillLevel: 3, playersNeeded: 4, status: 'ARCHIVED' },
    });
    await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: player.id } });
    const noShow = await request(app).post(`/api/dashboard/matches/${match.id}/no-show/${player.id}`).set('Authorization', `Bearer ${token}`);
    check('A6 no-show endpoint 200', noShow.status === 200, `status=${noShow.status} ${JSON.stringify(noShow.body).slice(0, 120)}`);
    const after = await prisma.player.findUnique({ where: { id: player.id } });
    check('A6 reliability scesa sotto 0.8', (after?.reliabilityScore ?? 1) < 0.8, `score=${after?.reliabilityScore}`);
    const mpAfter = await prisma.matchPlayer.findFirst({ where: { matchId: match.id, playerId: player.id } });
    check('A6 MatchPlayer marcato noShow', (mpAfter as any)?.noShow === true);

    console.log('\n══════════════════════════════════════');
    console.log(`RISULTATO API: ${passed} passati, ${failed} falliti`);
    if (failures.length) console.log('Falliti:\n' + failures.map(f => `  - ${f}`).join('\n'));
    console.log('══════════════════════════════════════');

    await prisma.$disconnect().catch(() => {});
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRORE FATALE:', err); process.exit(2); });
