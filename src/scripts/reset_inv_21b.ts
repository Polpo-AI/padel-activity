import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const davide = await prisma.player.findFirst({ where: { phoneNumber: '393762031767' } });
  if (!davide) throw new Error('Davide non trovato');

  await prisma.matchPlayer.updateMany({
    where: { matchId: 'test-day1-sabato', playerId: davide.id, leftAt: null },
    data: { leftAt: new Date() },
  });
  await prisma.invitation.updateMany({
    where: { matchId: 'test-day1-sabato', playerId: davide.id },
    data: { status: 'PENDING' },
  });
  await prisma.match.update({ where: { id: 'test-day1-sabato' }, data: { status: 'OPEN' } });

  console.log('Reset fatto: Davide fuori da MatchPlayer, invito → PENDING, match → OPEN');
}
main().catch(console.error).finally(() => prisma.$disconnect());
