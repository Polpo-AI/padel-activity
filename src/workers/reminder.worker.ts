import { Worker, Job } from 'bullmq';
import { getRedis } from '../services/queue';
import { sendMessage } from '../services/whatsapp';
import pino from 'pino';

const logger = pino({ level: 'info' });

interface ReminderJobData {
    matchId: string;
    groupId: string;
    timeStr: string;
}

const prefix = process.env.QUEUE_PREFIX ? `${process.env.QUEUE_PREFIX}-` : '';

export const reminderWorker = new Worker<ReminderJobData>(
    `${prefix}reminder`,
    async (job: Job<ReminderJobData>) => {
        const { matchId, groupId, timeStr } = job.data;
        logger.info(`Sending Reminder for Match ${matchId} to Group ${groupId}`);

        const variants = [
            `Ci vediamo tra un'ora! 🎾 Vi aspetto alle ${timeStr} — non fate tardi!`,
            `Quasi ora di giocare! ⏰ Appuntamento alle ${timeStr}, portate le scarpette 😄`,
            `Promemoria: padel alle ${timeStr}! 🏃‍♂️ Siete pronti?`,
            `Tra un'ora si gioca! 🎾 Campo alle ${timeStr} — a presto!`,
            `Un'ora e si inizia! Ci vediamo alle ${timeStr} 💪🎾`,
        ];
        const msg = variants[Math.floor(Math.random() * variants.length)];

        try {
            await sendMessage(groupId, msg);
        } catch (error) {
            logger.error({ error }, `Failed to send reminder to ${groupId}`);
        }
    },
    { connection: getRedis() as any }
);

reminderWorker.on('failed', (job, err) => {
    logger.error({ err }, `Reminder worker failed for job ${job?.id}`);
});
