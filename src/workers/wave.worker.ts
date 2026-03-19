/**
 * WAVE WORKER
 *
 * ✅ FIX CRITICITÀ D (Thundering Herd / Staleness Check):
 *    Se il sistema era offline e Redis ha accumulato job arretrati,
 *    i job il cui scheduledAt è scaduto da più di STALE_THRESHOLD_MS
 *    vengono scartati silenziosamente invece di sparare una raffica
 *    di notifiche tardive agli utenti.
 */

import { Worker } from 'bullmq';
import { connection } from '../services/queue';
import { processWave } from '../services/matchmaker';
import { STALE_THRESHOLD_MS } from '../api/webhooks';
import pino from 'pino';

const logger = pino({ level: 'info' });
const prefix = process.env.QUEUE_PREFIX ? `${process.env.QUEUE_PREFIX}-` : '';

const waveWorker = new Worker(
    `${prefix}wave`,
    async (job) => {
        const { matchId, waveNumber, scheduledAt, urgencyMultiplier } = job.data;

        // ✅ FIX: staleness check — scarta job troppo vecchi dopo un riavvio
        if (scheduledAt && Date.now() - scheduledAt > STALE_THRESHOLD_MS) {
            logger.warn(
                { matchId, waveNumber, delayedMs: Date.now() - scheduledAt },
                'Stale wave job discarded — system was likely offline'
            );
            return; // scarta senza inviare messaggi
        }

        logger.info(`Processing wave ${waveNumber} for match ${matchId}`);
        await processWave(matchId, waveNumber, urgencyMultiplier);
    },
    {
        connection,
        concurrency: 2,
    }
);

waveWorker.on('completed', (job) => {
    logger.info(`Wave job ${job.id} completed`);
});

waveWorker.on('failed', (job, err) => {
    logger.error({ err }, `Wave job ${job?.id} failed`);
});

export default waveWorker;
