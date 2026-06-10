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

  // Pulisci eventuale residuo
  await prisma.matchPlayer.deleteMany({ where: { matchId: 'test-day3-lunedi' } });
  await prisma.match.deleteMany({ where: { id: 'test-day3-lunedi' } });

  // Ricrea: lunedì 18/05 alle 10:00 Roma = 08:00 UTC
  const match = await prisma.match.create({
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
  await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: davide.id } });

  console.log('Ricreata prenotazione lunedì:', match.id, '— 18/05 10:00 Roma, Campo 1, LOCKED privata');
}

main().catch(console.error).finally(() => prisma.$disconnect());
