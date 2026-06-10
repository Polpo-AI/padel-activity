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
  const campo2 = await prisma.court.findFirst({ where: { clubId, name: 'Campo 2' } });
  if (!campo1 || !campo2) throw new Error('Campi non trovati');

  // --- Scenario 25: martedì su campo coperto (Campo 2) ---
  // 689bfade era su Campo 1 scoperto → cambiato a Campo 2 coperto
  await prisma.match.update({
    where: { id: '689bfade-4902-4f01-b062-6e19a88c1e6e' },
    data: { courtId: campo2.id },
  });
  console.log('Scenario 25: martedì spostato su Campo 2 (coperto)');

  // --- Scenario 26: OPEN_TO_MATCHMAKING su martedì → diventa OPEN matchmaking ---
  await prisma.match.update({
    where: { id: '689bfade-4902-4f01-b062-6e19a88c1e6e' },
    data: { status: 'OPEN', isPrivateBooking: false },
  });
  console.log('Scenario 26: martedì → OPEN matchmaking');

  // --- Scenario 24: prenotazione privata mercoledì 20/05 10:00 Roma (08:00 UTC) ---
  await prisma.matchPlayer.deleteMany({ where: { matchId: 'test-day3-mercoledi' } });
  await prisma.match.deleteMany({ where: { id: 'test-day3-mercoledi' } });
  const matchMer = await prisma.match.create({
    data: {
      id: 'test-day3-mercoledi',
      clubId,
      courtId: campo1.id,
      status: 'LOCKED',
      isPrivateBooking: true,
      startTime: new Date('2026-05-20T08:00:00.000Z'),
      skillLevel: davide.skillLevel,
      playersNeeded: 4,
      targetGender: 'MIXED',
    }
  });
  await prisma.matchPlayer.create({ data: { matchId: matchMer.id, playerId: davide.id } });
  console.log('Scenario 24: creata prenotazione mercoledì 20/05 10:00, Campo 1');

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
}

main().catch(console.error).finally(() => prisma.$disconnect());
