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
  console.log('Davide:', davide.id, davide.name);

  // 1. Pulisci match orfani
  const orphans = ['95824e2d-b04e-4954-9955-15107895f739', 'd112f5ee-10f1-4e74-aed1-76aba8be99f2'];
  for (const mid of orphans) {
    await prisma.matchPlayer.deleteMany({ where: { matchId: mid } });
    await prisma.invitation.deleteMany({ where: { matchId: mid } });
    await prisma.match.deleteMany({ where: { id: mid } });
    console.log('Eliminato match orfano:', mid);
  }

  // 2. Crea prenotazione venerdì 15/05 alle 16:00 Roma (= 14:00 UTC)
  const venerdi = new Date('2026-05-15T14:00:00.000Z');
  const campo1 = await prisma.court.findFirst({ where: { clubId, name: 'Campo 1' } });
  if (!campo1) throw new Error('Campo 1 non trovato');

  await prisma.match.deleteMany({ where: { id: 'test-day3-venerdi' } });
  const matchVen = await prisma.match.create({
    data: {
      id: 'test-day3-venerdi',
      clubId,
      courtId: campo1.id,
      status: 'LOCKED',
      isPrivateBooking: true,
      startTime: venerdi,
      skillLevel: davide.skillLevel,
      playersNeeded: 4,
      targetGender: 'MIXED',
    }
  });
  await prisma.matchPlayer.create({ data: { matchId: matchVen.id, playerId: davide.id } });
  console.log('Creata prenotazione venerdi:', matchVen.id, '— 15/05 16:00 Roma');

  // 3. Reset invitation test-day1-sabato per Davide: rimuovi da MatchPlayer, PENDING
  await prisma.matchPlayer.deleteMany({ where: { matchId: 'test-day1-sabato', playerId: davide.id } });
  await prisma.invitation.updateMany({
    where: { matchId: 'test-day1-sabato', playerId: davide.id },
    data: { status: 'PENDING' }
  });
  console.log('Reset invitation test-day1-sabato: ACCEPTED→PENDING, rimosso da MatchPlayer');

  // 4. Verifica 5151f558 (lunedì 18/05 10:00)
  const lun = await prisma.match.findUnique({ where: { id: '5151f558-67e7-4bf5-8445-a3e7aa0375b0' } });
  console.log('Match lunedi:', lun?.id, lun?.status, lun?.startTime?.toLocaleString('it-IT', { timeZone: 'Europe/Rome' }));

  // Recap
  const davideActive = await prisma.matchPlayer.findMany({
    where: { playerId: davide.id, leftAt: null },
    include: { match: { include: { court: true } } }
  });
  console.log('\n=== Prenotazioni attive Davide ===');
  for (const mp of davideActive) {
    const m = mp.match;
    console.log(' ', m.id, '|', m.status, '|', m.isPrivateBooking ? 'privata' : 'matchmaking', '|',
      m.startTime.toLocaleString('it-IT', { timeZone: 'Europe/Rome' }), '|', m.court?.name);
  }

  const pendingInv = await prisma.invitation.findMany({
    where: { playerId: davide.id, status: 'PENDING' },
    include: { match: { include: { court: true } } }
  });
  console.log('\n=== Inviti PENDING Davide ===');
  for (const inv of pendingInv) {
    console.log(' ', inv.matchId, '|', inv.match.startTime.toLocaleString('it-IT', { timeZone: 'Europe/Rome' }), '|', inv.match.court?.name);
  }
}

main().catch(console.error).finally(() => prisma.$disconnect());
