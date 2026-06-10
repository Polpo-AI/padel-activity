import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const clubId = '72fedeff-b228-42ac-b7b9-ad1339dfcb0b';
  const davidePhone = '393762031767';

  const davide = await prisma.player.findFirst({ where: { phoneNumber: davidePhone } });
  if (!davide) throw new Error('Davide non trovato');

  const campo1 = await prisma.court.findFirst({ where: { clubId, name: 'Campo 1' } });
  if (!campo1) throw new Error('Campo 1 non trovato');

  // 1. Pulisci tutti i match Day 3 esistenti (incluso il martedì dal reschedule)
  const toClean = [
    'test-day3-venerdi',
    'test-day3-lunedi',
    'test-day3-mercoledi',
    '689bfade-4902-4f01-b062-6e19a88c1e6e',
  ];
  for (const id of toClean) {
    await prisma.matchPlayer.deleteMany({ where: { matchId: id } });
    await prisma.invitation.deleteMany({ where: { matchId: id } });
    await prisma.match.deleteMany({ where: { id } });
  }
  console.log('Puliti match Day 3 esistenti');

  // 2. Ricrea venerdì 15/05 16:00 Roma (= 14:00 UTC) — LOCKED privata
  const matchVen = await prisma.match.create({
    data: {
      id: 'test-day3-venerdi',
      clubId,
      courtId: campo1.id,
      status: 'LOCKED',
      isPrivateBooking: true,
      startTime: new Date('2026-05-15T14:00:00.000Z'),
      skillLevel: davide.skillLevel,
      playersNeeded: 4,
      targetGender: 'MIXED',
    }
  });
  await prisma.matchPlayer.create({ data: { matchId: matchVen.id, playerId: davide.id } });
  console.log('Creata prenotazione venerdì 15/05 16:00');

  // 3. Ricrea lunedì 18/05 10:00 Roma (= 08:00 UTC) — LOCKED privata
  const matchLun = await prisma.match.create({
    data: {
      id: 'test-day3-lunedi',
      clubId,
      courtId: campo1.id,
      status: 'LOCKED',
      isPrivateBooking: true,
      startTime: new Date('2026-05-18T08:00:00.000Z'),
      skillLevel: davide.skillLevel,
      playersNeeded: 4,
      targetGender: 'MIXED',
    }
  });
  await prisma.matchPlayer.create({ data: { matchId: matchLun.id, playerId: davide.id } });
  console.log('Creata prenotazione lunedì 18/05 10:00');

  // 4. Reset invito test-day1-sabato → PENDING (rimuovi da MatchPlayer se presente)
  await prisma.matchPlayer.deleteMany({ where: { matchId: 'test-day1-sabato', playerId: davide.id } });
  await prisma.match.update({ where: { id: 'test-day1-sabato' }, data: { status: 'OPEN' } });
  await prisma.invitation.updateMany({
    where: { matchId: 'test-day1-sabato', playerId: davide.id },
    data: { status: 'PENDING' },
  });
  console.log('Reset invito sabato → PENDING');

  // Recap
  const active = await prisma.matchPlayer.findMany({
    where: { playerId: davide.id, leftAt: null },
    include: { match: { include: { court: true } } }
  });
  console.log('\n=== Prenotazioni attive Davide ===');
  for (const mp of active) {
    const m = mp.match;
    console.log(` ${m.id} | ${m.status} | ${m.isPrivateBooking ? 'privata' : 'matchmaking'} | ${m.startTime.toLocaleString('it-IT', { timeZone: 'Europe/Rome' })} | ${m.court?.name}`);
  }
  const inv = await prisma.invitation.findFirst({ where: { matchId: 'test-day1-sabato', playerId: davide.id } });
  console.log(`\nInvito sabato: ${inv?.status}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
