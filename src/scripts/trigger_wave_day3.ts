import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
  const davidePhone = '393762031767';
  const matchId = 'test-day1-sabato';

  const davide = await prisma.player.findFirst({ where: { phoneNumber: davidePhone } });
  if (!davide) throw new Error('Davide non trovato');

  // Cancella l'invito PENDING esistente così la wave ne crea uno nuovo (e manda il WA)
  const deleted = await prisma.invitation.deleteMany({
    where: { matchId, playerId: davide.id, status: 'PENDING' }
  });
  console.log('Inviti PENDING eliminati:', deleted.count);

  // Enqueue wave con la config Redis del progetto
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const waveQueue = new Queue('wave', { connection: redis });

  await waveQueue.add('process-wave', { matchId, waveNumber: 1 }, { delay: 0 });
  console.log('Wave enqueued per', matchId);

  await redis.quit();
  await prisma.$disconnect();
  await pool.end();
}

main().catch(console.error);
