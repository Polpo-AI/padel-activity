import 'dotenv/config';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';

async function main() {
  const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  const prefix = process.env.QUEUE_PREFIX ? `${process.env.QUEUE_PREFIX}-` : '';
  const queueName = `${prefix}wave`;

  const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const waveQueue = new Queue(queueName, { connection: redis });

  await waveQueue.add('process-wave', { matchId: 'test-day1-sabato', waveNumber: 1 }, { delay: 0 });
  console.log('Wave enqueued to queue:', queueName);

  await redis.quit();
}

main().catch(console.error);
