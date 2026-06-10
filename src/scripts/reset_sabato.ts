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
  const matchId = 'test-day1-sabato';

  // Reset match a OPEN
  await prisma.match.update({ where: { id: matchId }, data: { status: 'OPEN' } });
  console.log('Match resettato a OPEN');

  // Triggera wave
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const waveQueue = new Queue('wave', { connection: redis });
  await waveQueue.add('process-wave', { matchId, waveNumber: 1 }, { delay: 0 });
  console.log('Wave enqueued');

  await redis.quit();
  await prisma.$disconnect();
  await pool.end();
}

main().catch(console.error);
