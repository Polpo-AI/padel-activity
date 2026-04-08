/**
 * QUEUE SERVICE
 *
 * BullMQ queues + Redis client condiviso.
 * - Hook globali onFailed: notifica admin dopo 3 fallimenti consecutivi
 * - checkSilentMatches: rileva partite OPEN senza wave attive e le rilancia
 * - checkRedisHealth: usato dal health check endpoint
 */

import { Queue, QueueEvents } from 'bullmq';
import Redis from 'ioredis';
import pino from 'pino';

const logger = pino({ level: 'info' });

// ─────────────────────────────────────────────
// REDIS
// ─────────────────────────────────────────────

let redisInstance: Redis | null = null;

export function getRedis(): Redis {
    if (!redisInstance) {
        const redisUrl = process.env.REDIS_URL;
        if (redisUrl) {
            redisInstance = new Redis(redisUrl, {
                maxRetriesPerRequest: null,
                enableReadyCheck: false,
                retryStrategy: (times) => Math.min(times * 500, 5000),
            });
        } else {
            redisInstance = new Redis({
                host: process.env.REDIS_HOST || 'localhost',
                port: parseInt(process.env.REDIS_PORT || '6379'),
                password: process.env.REDIS_PASSWORD || undefined,
                maxRetriesPerRequest: null,
                enableReadyCheck: false,
                retryStrategy: (times) => Math.min(times * 500, 5000),
            });
        }

        redisInstance.on('connect', () => logger.info('Redis connected'));
        redisInstance.on('error', async (err) => {
            logger.error({ err }, 'Redis error');
            if (err.message?.includes('ECONNREFUSED')) {
                await notifyAdminSafe('Redis non raggiungibile. Le wave sono sospese.', 'redis-down');
            }
        });
        redisInstance.on('reconnecting', () => logger.warn('Redis reconnecting...'));
    }
    return redisInstance;
}

export const connection = (process.env.REDIS_HOST
    ? {
          host: process.env.REDIS_HOST,
          port: parseInt(process.env.REDIS_PORT || '6379'),
          password: process.env.REDIS_PASSWORD || undefined,
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
      }
    : process.env.REDIS_URL || {
          host: 'localhost',
          port: 6379,
          maxRetriesPerRequest: null,
          enableReadyCheck: false,
      }) as any;

// ─────────────────────────────────────────────
// QUEUES
// ─────────────────────────────────────────────

const prefix = process.env.QUEUE_PREFIX ? `${process.env.QUEUE_PREFIX}-` : '';

export const waveQueue = new Queue(`${prefix}wave`, {
    connection,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
    },
});

export const reminderQueue = new Queue(`${prefix}reminder`, {
    connection,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
    },
});

export const maintenanceQueue = new Queue(`${prefix}maintenance`, {
    connection,
    defaultJobOptions: {
        attempts: 2,
        removeOnComplete: true,
        removeOnFail: { count: 50 },
    },
});

export const recoveryQueue = new Queue(`${prefix}recovery`, {
    connection,
    defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 3000 },
        removeOnComplete: { count: 50 },
        removeOnFail: { count: 100 },
    },
});

// ─────────────────────────────────────────────
// QUEUE EVENTS — notifica admin su fallimenti
// ─────────────────────────────────────────────

const failureCounters = new Map<string, number>();

function setupQueueEvents(name: string) {
    const queueName = `${prefix}${name}`;
    const events = new QueueEvents(queueName, { connection });

    events.on('failed', async ({ jobId, failedReason }) => {
        const count = (failureCounters.get(queueName) || 0) + 1;
        failureCounters.set(queueName, count);

        logger.error({ queueName, jobId, failedReason }, `Job failed (queue failures: ${count})`);

        if (count >= 3 && count % 3 === 0) {
            await notifyAdminSafe(
                `⚠️ Queue *${queueName}*: ${count} job falliti.\nUltimo: ${failedReason?.slice(0, 200)}`,
                `queue-failed-${queueName}`
            );
        }
    });

    events.on('completed', () => {
        failureCounters.set(queueName, 0);
    });

    return events;
}

export const waveQueueEvents       = setupQueueEvents('wave');
export const recoveryQueueEvents   = setupQueueEvents('recovery');
export const maintenanceQueueEvents = setupQueueEvents('maintenance');

// ─────────────────────────────────────────────
// WAVE SILENTE — rilancia wave orfane
// ─────────────────────────────────────────────

// ✅ FIX F (N+1 / loop match storici):
//    Filtra solo le partite recenti (ultimi 7 giorni) per non ciclare
//    su match archiviati. Il campo status ARCHIVED verrà aggiunto
//    dalla migration Prisma corrispondente.
//
// ✅ FIX D (Staleness):
//    I job iniettati da checkSilentMatches includono scheduledAt
//    per il controllo staleness nel wave.worker.
export async function checkSilentMatches(): Promise<void> {
    try {
        const { prisma } = await import('./db');
        const now = new Date();
        const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

        const openMatches = await prisma.match.findMany({
            where: {
                status: 'OPEN',
                type: 'MATCH',   // solo partite reali — no LESSON, no UNAVAILABLE
                startTime: {
                    gt: new Date(now.getTime() + 60 * 60 * 1000),
                    gte: sevenDaysAgo,  // ✅ FIX F: esclude match storici
                },
            },
            include: { MatchPlayer: true },
        });

        // Carica tutti i job wave UNA SOLA VOLTA fuori dal loop (anti N+1)
        const [waitingJobs, delayedJobs] = await Promise.all([
            waveQueue.getWaiting(),
            waveQueue.getDelayed(),
        ]);
        const allWaveMatchIds = new Set(
            [...waitingJobs, ...delayedJobs].map(j => j.data?.matchId).filter(Boolean)
        );

        for (const match of openMatches) {
            const confirmed = match.MatchPlayer.filter(mp => !mp.leftAt).length;
            if (confirmed >= match.playersNeeded) continue;

            const hasActiveWave = allWaveMatchIds.has(match.id);

            if (!hasActiveWave) {
                const minutesLeft = (match.startTime.getTime() - now.getTime()) / 60000;
                logger.warn({ matchId: match.id, minutesLeft }, 'Silent match detected — relaunching wave');

                const delayMs = 5000;
                waveQueue.add('process-wave', {
                    matchId: match.id,
                    waveNumber: match.recoveryWaveCount + 1,
                    scheduledAt: Date.now() + delayMs,
                }, { delay: delayMs }).catch(err => logger.warn({ err, matchId: match.id }, 'checkSilentMatches: wave reschedule failed'));

                await notifyAdminSafe(
                    `Partita rilevata senza wave attive → rilancio automatico (${Math.round(minutesLeft)} min al match).`,
                    `silent-match-${match.id}`
                );
            }
        }
    } catch (err) {
        logger.error({ err }, 'checkSilentMatches failed');
    }
}

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

export async function checkRedisHealth(): Promise<boolean> {
    try {
        const result = await getRedis().ping();
        return result === 'PONG';
    } catch {
        return false;
    }
}

// ─────────────────────────────────────────────
// NOTIFY ADMIN SAFE
// ─────────────────────────────────────────────

async function notifyAdminSafe(message: string, key: string): Promise<void> {
    try {
        const { notifyAdmin } = await import('../utils/notify-admin');
        await notifyAdmin(message, key);
    } catch {}
}
