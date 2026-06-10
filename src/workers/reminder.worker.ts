import { Worker, Job } from 'bullmq';
import { connection } from '../services/queue';
import { prisma } from '../services/db';
import { sendMessage } from '../services/whatsapp';
import { runWithContext } from '../utils/request-context';
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

        // Il reminder è schedulato ore prima: nel frattempo la partita può essere stata
        // cancellata o il gruppo sciolto/ricreato. Ricontrolla lo stato prima di inviare.
        const match = await prisma.match.findUnique({
            where: { id: matchId },
            select: { status: true, groupId: true, clubId: true },
        });
        if (!match || match.status !== 'LOCKED' || match.groupId !== groupId) {
            logger.info({ matchId, groupId, status: match?.status }, 'Reminder skipped — match cancelled or group changed');
            return;
        }

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
            // Contesto club: in multi-tenant serve il socket WA del circolo giusto
            await runWithContext({ correlationId: `reminder-${matchId}`, clubId: match.clubId }, () =>
                sendMessage(groupId, msg)
            );
        } catch (error) {
            logger.error({ error }, `Failed to send reminder to ${groupId}`);
        }
    },
    { connection }
);

reminderWorker.on('failed', (job, err) => {
    logger.error({ err }, `Reminder worker failed for job ${job?.id}`);
});
