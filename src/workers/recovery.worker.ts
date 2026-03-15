import { Worker } from 'bullmq';
import { connection } from '../services/queue';
import { launchRecoveryWave } from '../services/recovery';
import pino from 'pino';

const logger = pino({ level: 'info' });

const prefix = process.env.QUEUE_PREFIX ? `${process.env.QUEUE_PREFIX}-` : '';

const recoveryWorker = new Worker(
    `${prefix}recovery`,
    async (job) => {
        const { matchId, spotsNeeded, isUrgent } = job.data;
        logger.info(`Recovery worker: match ${matchId}, spots ${spotsNeeded}, urgent: ${isUrgent}`);
        await launchRecoveryWave(matchId, spotsNeeded, isUrgent ?? false);
    },
    {
        connection,
        concurrency: 1, // Una recovery alla volta per non spammare
    }
);

recoveryWorker.on('completed', (job) => {
    logger.info(`Recovery job ${job.id} completed`);
});

recoveryWorker.on('failed', (job, err) => {
    logger.error({ err }, `Recovery job ${job?.id} failed`);
});

export default recoveryWorker;
