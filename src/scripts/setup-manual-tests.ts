/**
 * setup-manual-tests.ts
 * Pulizia DB + setup scenari per test manuali.
 * Eseguire SUL VPS staging:
 *   npx tsx src/scripts/setup-manual-tests.ts
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

// ─── Costanti ────────────────────────────────────────────────────────────────

const CLUB_ID = '72fedeff-b228-42ac-b7b9-ad1339dfcb0b';

const COURTS = {
  campo1: '38dadb7e-ced3-41a6-b08a-971b14e7e91a', // scoperto
  campo2: '51553bb9-44ca-4749-ac2f-77df37d4efb0', // coperto
  campo3: '33848e08-3f53-4bac-b53f-ef66dd4a885b', // scoperto
  campo4: '9f398b9d-590e-4835-a248-bef57ff8dc88', // coperto
};

// Italy è UTC+2 in maggio → sottraggo 2h per ottenere UTC
const romeToUtc = (dateStr: string, h: number, m = 0) =>
  new Date(`${dateStr}T${String(h - 2).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`);

const TUE = '2026-05-26'; // domani
const WED = '2026-05-27'; // dopodomani

// ─── Giocatori reali (IDs noti dal DB) ───────────────────────────────────────

const P = {
  davide:      { id: 'pid-davide',                               name: 'Davide',    skill: 3.5 },
  roberto:     { id: 'pid-roberto',                              name: 'Roberto',   skill: 3.0 },
  gioele:      { id: 'pid-gioele',                               name: 'Gioele',    skill: 3.0 },
  paola:       { id: 'pid-paola',                                name: 'Paola',     skill: 3.0 },
  monica:      { id: 'pid-monica',                               name: 'Monica',    skill: 3.0 },
  simoneG:     { id: 'pid-simone',                               name: 'Simone G.', skill: 3.5 },
  sharon:      { id: 'pid-sharon',                               name: 'Sharon',    skill: 3.5 },
  christian:   { id: 'pid-christian',                            name: 'Christian', skill: 3.5 },
  alessio:     { id: 'pid-alessio',                              name: 'Alessio',   skill: 4.0 },
  mattia:      { id: 'pid-mattia',                               name: 'Mattia',    skill: 3.0 },
  sandroG:     { id: 'pid-sandro',                               name: 'Alessandro G.', skill: 4.0 },
  sandroS:     { id: 'c97a302b-b35a-496c-bf44-bcfb044f2632',    name: 'Alessandro S.', skill: 3.2 },
  giovanna:    { id: 'ac831185-8eeb-438e-8994-9ea41bed39db',    name: 'Giovanna',  skill: 3.5 },
  silvia:      { id: 'c1e6419f-e883-41b4-b9ec-3aae99a3b41f',    name: 'Silvia',    skill: 4.0 },
  alvaro:      { id: '8828d9e3-225c-40de-9714-ea62e3a0dc81',    name: 'Alvaro',    skill: 3.7 },
  giulia:      { id: '70600dc1-a74f-4228-b094-34f1a3184f7f',    name: 'Giulia',    skill: 3.3 },
  simoneP:     { id: '1c00956d-0e70-4d10-b99c-6fc825d5bc02',    name: 'Simone P.', skill: 3.1 },
  martina:     { id: '809670e3-edc2-4597-9347-c3042d2aa5e7',    name: 'Martina',   skill: 2.5 },
};

// ─── Helper ───────────────────────────────────────────────────────────────────

async function createBlockerMatch(
  courtId: string,
  startItaly: Date,
  squad: typeof P.davide[],
  label: string
) {
  const endTime = new Date(startItaly.getTime() + 90 * 60 * 1000);
  const avgSkill = squad.reduce((s, p) => s + p.skill, 0) / squad.length;

  const match = await prisma.match.create({
    data: {
      clubId:       CLUB_ID,
      courtId,
      startTime:    startItaly,
      endTime,
      status:       'LOCKED',
      skillLevel:   Math.round(avgSkill * 10) / 10,
      playersNeeded: 4,
      type:         'MATCH',
    },
  });

  await prisma.matchPlayer.createMany({
    data: squad.map(p => ({
      matchId:  match.id,
      playerId: p.id,
      joinedAt: new Date(),
    })),
  });

  console.log(`  ✓ ${label}`);
  console.log(`    Squadra: ${squad.map(p => p.name).join(', ')}`);
  return match;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║      SETUP TEST MANUALI — STAGING        ║');
  console.log('╚══════════════════════════════════════════╝\n');

  // ── 1. PULIZIA: giocatori fake ──────────────────────────────────────────────

  console.log('▶ Pulizia giocatori fake...');

  const fakeIds: string[] = [];

  // Aux* con numeri 390011...
  const auxPlayers = await prisma.player.findMany({
    where: { phoneNumber: { startsWith: '390011' } },
    select: { id: true, name: true },
  });
  auxPlayers.forEach(p => { fakeIds.push(p.id); console.log(`  - ${p.name}`); });

  // Marco Rossi seed
  const marcoRossi = await prisma.player.findFirst({
    where: { id: 'pid-marco-rossi' },
    select: { id: true, name: true },
  });
  if (marcoRossi) { fakeIds.push(marcoRossi.id); console.log(`  - ${marcoRossi.name} (seed)`); }

  if (fakeIds.length > 0) {
    const matchIds = (await prisma.matchPlayer.findMany({
      where: { playerId: { in: fakeIds } },
      select: { matchId: true },
    })).map(mp => mp.matchId);

    await prisma.matchFeedback.deleteMany({ where: { playerId: { in: fakeIds } } });
    await prisma.invitation.deleteMany({ where: { playerId: { in: fakeIds } } });
    await prisma.matchPlayer.deleteMany({ where: { playerId: { in: fakeIds } } });
    await prisma.player.deleteMany({ where: { id: { in: fakeIds } } });

    // Match orfani (nessun giocatore rimasto → eliminali)
    for (const mId of [...new Set(matchIds)]) {
      const remaining = await prisma.matchPlayer.count({ where: { matchId: mId } });
      if (remaining === 0) {
        await prisma.invitation.deleteMany({ where: { matchId: mId } });
        await prisma.match.delete({ where: { id: mId } }).catch(() => {});
      }
    }
    console.log(`  ✓ Rimossi ${fakeIds.length} giocatori fake\n`);
  } else {
    console.log('  Nessun giocatore fake trovato.\n');
  }

  // ── 2. PULIZIA: club FAQ test ───────────────────────────────────────────────

  console.log('▶ Pulizia club di test FAQ...');
  const faqClubs = await prisma.club.findMany({
    where: { id: { startsWith: 'faq-test' } },
    select: { id: true, name: true },
  });
  for (const fc of faqClubs) {
    const pIds = (await prisma.player.findMany({ where: { clubId: fc.id }, select: { id: true } })).map(p => p.id);
    if (pIds.length > 0) {
      await prisma.matchFeedback.deleteMany({ where: { playerId: { in: pIds } } });
      await prisma.invitation.deleteMany({ where: { playerId: { in: pIds } } });
      await prisma.matchPlayer.deleteMany({ where: { playerId: { in: pIds } } });
      await prisma.player.deleteMany({ where: { clubId: fc.id } });
    }
    await prisma.match.deleteMany({ where: { clubId: fc.id } });
    await prisma.court.deleteMany({ where: { clubId: fc.id } });
    try { await (prisma as any).fAQ.deleteMany({ where: { clubId: fc.id } }); } catch {}
    await prisma.club.delete({ where: { id: fc.id } });
    console.log(`  ✓ Rimosso club: ${fc.name}`);
  }
  if (!faqClubs.length) console.log('  Nessun club FAQ test trovato.');
  console.log();

  // ── 3. PULIZIA: partite attive esistenti ────────────────────────────────────

  console.log('▶ Pulizia partite OPEN/LOCKED esistenti...');
  const active = await prisma.match.findMany({
    where: { clubId: CLUB_ID, status: { in: ['OPEN', 'LOCKED'] } },
    select: { id: true },
  });
  if (active.length > 0) {
    const ids = active.map(m => m.id);
    await prisma.invitation.deleteMany({ where: { matchId: { in: ids } } });
    await prisma.matchPlayer.deleteMany({ where: { matchId: { in: ids } } });
    await prisma.match.deleteMany({ where: { id: { in: ids } } });
    console.log(`  ✓ Rimosse ${ids.length} partite\n`);
  } else {
    console.log('  Nessuna partita attiva.\n');
  }

  // ── 4. PULIZIA: Redis ───────────────────────────────────────────────────────

  console.log('▶ Flush Redis (job wave stale)...');
  try {
    const IORedis = require('ioredis');
    const redis = new IORedis({
      host:     process.env.REDIS_HOST     || '127.0.0.1',
      port:     parseInt(process.env.REDIS_PORT || '6379'),
      password: process.env.REDIS_PASSWORD || undefined,
      maxRetriesPerRequest: 1,
    });
    await redis.flushdb();
    await redis.quit();
    console.log('  ✓ Redis flushed\n');
  } catch {
    console.log('  ⚠ Redis non raggiungibile — nessun problema\n');
  }

  // ── 5. SCENARIO B — Solo campo coperto (Martedì 19:30) ─────────────────────

  console.log('▶ Scenario B — Solo coperto disponibile (Martedì 19:30 Italy)');
  console.log('  Occupo Campo 1 e Campo 3 (scoperti) — rimangono liberi solo Campo 2 e 4 (coperti)');
  await createBlockerMatch(
    COURTS.campo1,
    romeToUtc(TUE, 19, 30),
    [P.roberto, P.gioele, P.paola, P.monica],
    'Campo 1 (scoperto) — martedì 19:30'
  );
  await createBlockerMatch(
    COURTS.campo3,
    romeToUtc(TUE, 19, 30),
    [P.simoneG, P.sharon, P.christian, P.alessio],
    'Campo 3 (scoperto) — martedì 19:30'
  );
  console.log('  → Cosa testare: Davide scrive "domani alle 19:30"');
  console.log('  → Atteso: bot chiede conferma campo coperto\n');

  // ── 6. SCENARIO C — Orario tutto pieno (Mercoledì 21:00) ───────────────────

  console.log('▶ Scenario C — Orario tutto pieno (Mercoledì 21:00 Italy)');
  console.log('  Occupo tutti e 4 i campi');
  await createBlockerMatch(
    COURTS.campo1,
    romeToUtc(WED, 21, 0),
    [P.mattia, P.giovanna, P.sandroS, P.simoneP],
    'Campo 1 (scoperto) — mercoledì 21:00'
  );
  await createBlockerMatch(
    COURTS.campo2,
    romeToUtc(WED, 21, 0),
    [P.silvia, P.alvaro, P.giulia, P.sandroG],
    'Campo 2 (coperto) — mercoledì 21:00'
  );
  await createBlockerMatch(
    COURTS.campo3,
    romeToUtc(WED, 21, 0),
    [P.roberto, P.gioele, P.paola, P.monica],
    'Campo 3 (scoperto) — mercoledì 21:00'
  );
  await createBlockerMatch(
    COURTS.campo4,
    romeToUtc(WED, 21, 0),
    [P.simoneG, P.sharon, P.christian, P.martina],
    'Campo 4 (coperto) — mercoledì 21:00'
  );
  console.log('  → Cosa testare: Davide scrive "mercoledì alle 21"');
  console.log('  → Atteso: bot dice tutto pieno, propone orari alternativi\n');

  // ── 7. SCENARIO D — Cancellazione + sostituto (Mercoledì 18:00) ────────────

  console.log('▶ Scenario D — Cancellazione + wave sostituto (Mercoledì 18:00 Italy)');
  const matchD = await prisma.match.create({
    data: {
      clubId:       CLUB_ID,
      courtId:      COURTS.campo1,
      startTime:    romeToUtc(WED, 18, 0),
      endTime:      new Date(romeToUtc(WED, 18, 0).getTime() + 90 * 60 * 1000),
      status:       'LOCKED',
      skillLevel:   3.2,
      playersNeeded: 4,
      type:         'MATCH',
    },
  });
  await prisma.matchPlayer.createMany({
    data: [P.davide, P.roberto, P.gioele, P.paola].map(p => ({
      matchId: matchD.id, playerId: p.id, joinedAt: new Date(),
    })),
  });
  console.log('  ✓ Campo 1 — mercoledì 18:00 — LOCKED');
  console.log('  Squadra: Davide, Roberto, Gioele, Paola');
  console.log('  → Cosa testare: Davide scrive "cancella la partita di mercoledì alle 18"');
  console.log('  → Atteso: partita riaperta → wave urgente agli altri giocatori\n');

  // ── 8. RIEPILOGO ────────────────────────────────────────────────────────────

  const remaining = await prisma.player.count({ where: { clubId: CLUB_ID } });
  const matches   = await prisma.match.count({ where: { clubId: CLUB_ID, status: { in: ['OPEN', 'LOCKED'] } } });

  console.log('╔══════════════════════════════════════════╗');
  console.log('║              SETUP COMPLETATO            ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log(`  Giocatori nel club: ${remaining}`);
  console.log(`  Partite create:     ${matches}`);
  console.log();
  console.log('  SCENARIO A  Prenotazione libera');
  console.log('  SCENARIO B  Solo coperto disponibile');
  console.log('  SCENARIO C  Orario tutto pieno');
  console.log('  SCENARIO D  Cancellazione + sostituto');
  console.log();

  await prisma.$disconnect();
  await pool.end();
}

main().catch(e => { console.error(e); process.exit(1); });
