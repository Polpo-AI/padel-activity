import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const davidePhone = '393762031767';
  const matchId = 'test-day1-sabato';

  const davide = await prisma.player.findFirst({ where: { phoneNumber: davidePhone } });
  if (!davide) throw new Error('Davide non trovato');

  // Rimuovi Davide dal match (come se non avesse accettato)
  await prisma.matchPlayer.updateMany({
    where: { matchId, playerId: davide.id, leftAt: null },
    data: { leftAt: new Date() }
  });

  // Reset invito → PENDING
  await prisma.invitation.updateMany({
    where: { matchId, playerId: davide.id },
    data: { status: 'PENDING' }
  });

  // Il match era tornato LOCKED quando Davide ha accettato → rimetti OPEN
  await prisma.match.update({ where: { id: matchId }, data: { status: 'OPEN' } });

  console.log('Reset fatto: Davide rimosso da MatchPlayer, invito → PENDING, match → OPEN');
}

main().catch(console.error).finally(() => prisma.$disconnect());
