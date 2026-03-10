import { Queue, QueueEvents } from 'bullmq';
import IORedis, { RedisOptions } from 'ioredis';
import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();

const logger = pino({ level: 'info' });

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Setup ioredis natively for other possible uses (if needed)
export const connection = new IORedis(redisUrl, {
    maxRetriesPerRequest: null,
});

// For BullMQ, sometimes passing the `IORedis` instance directly throws type errors
// depending on the bullmq vs ioredis version mismatch. 
// We can use the connection options for BullMq to be safe.
export const redisOpts = {
    host: new URL(redisUrl).hostname,
    port: parseInt(new URL(redisUrl).port || '6379', 10),
    maxRetriesPerRequest: null
};

// Queue instances
export const waveQueue = new Queue('wave-queue', { connection: redisOpts });
export const reminderQueue = new Queue('reminder-queue', { connection: redisOpts });

// Optional: Queue Events for logging
const waveEvents = new QueueEvents('wave-queue', { connection: redisOpts });
waveEvents.on('completed', ({ jobId }) => {
    logger.info(`Wave Job ${jobId} completed`);
});
waveEvents.on('failed', ({ jobId, failedReason }) => {
    logger.error(`Wave Job ${jobId} failed: ${failedReason}`);
});
