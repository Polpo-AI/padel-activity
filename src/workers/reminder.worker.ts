import { Worker, Job } from 'bullmq';
import { redisOpts } from '../services/queue';
import { sendMessage } from '../services/whatsapp';
import pino from 'pino';

const logger = pino({ level: 'info' });

interface ReminderJobData {
    matchId: string;
    groupId: string;
    timeStr: string;
}

export const reminderWorker = new Worker<ReminderJobData>(
    'reminder-queue',
    async (job: Job<ReminderJobData>) => {
        const { matchId, groupId, timeStr } = job.data;
        logger.info(`Sending Reminder for Match ${matchId} to Group ${groupId}`);

        const msg = `Promemoria: Padel alle ${timeStr}! Non fate tardi! 🏃‍♂️💨`;

        try {
            await sendMessage(groupId, msg);
        } catch (error) {
            logger.error({ error }, `Failed to send reminder to ${groupId}`);
        }
    },
    { connection: redisOpts }
);

reminderWorker.on('failed', (job, err) => {
    logger.error({ err }, `Reminder worker failed for job ${job?.id}`);
});
