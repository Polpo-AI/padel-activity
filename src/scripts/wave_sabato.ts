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
  const davide = await prisma.player.findFirst({ where: { phoneNumber: '393762031767' } });
  if (!davide) throw new Error('Davide non trovato');

  await prisma.invitation.deleteMany({ where: { matchId: 'test-day1-sabato', playerId: davide.id } });
  console.log('Invito PENDING eliminato');

  const prefix = process.env.QUEUE_PREFIX ? `${process.env.QUEUE_PREFIX}-` : '';
  const redis = new IORedis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', { maxRetriesPerRequest: null });
  const waveQueue = new Queue(`${prefix}wave`, { connection: redis });
  await waveQueue.add('process-wave', { matchId: 'test-day1-sabato', waveNumber: 1 }, { delay: 0 });
  console.log('Wave enqueued per test-day1-sabato');

  await redis.quit();
  await prisma.$disconnect();
  await pool.end();
}
main().catch(console.error);
