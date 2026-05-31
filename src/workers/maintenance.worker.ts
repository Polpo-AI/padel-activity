import { Worker } from 'bullmq';
import { connection } from '../services/queue';
import { prisma } from '../services/db';
import { checkMatchTimeouts } from '../services/recovery';
import { processMatchOutcomes } from '../services/scoring';
import pino from 'pino';

const logger = pino({ level: 'info' });

const prefix = process.env.QUEUE_PREFIX ? `${process.env.QUEUE_PREFIX}-` : '';

const maintenanceWorker = new Worker(
    `${prefix}maintenance`,
    async (job) => {
        logger.info(`Running maintenance job: ${job.name}`);

        if (job.name === 'daily-reset') {
            const result = await prisma.player.updateMany({
                data: { dailyMessagesCount: 0, morningContactsToday: 0, afternoonContactsToday: 0 },
            });
            logger.info(`Daily reset: cleared dailyMessagesCount/morningContactsToday/afternoonContactsToday for ${result.count} players`);
        }

        if (job.name === 'check-timeouts') {
            await checkMatchTimeouts();
        }

        if (job.name === 'check-silent-matches') {
            const { checkSilentMatches } = await import('../services/queue');
            await checkSilentMatches();
        }

        if (job.name === 'resend-undelivered') {
            const { resendUndeliveredMessages } = await import('../services/delivery');
            await resendUndeliveredMessages();
        }

        if (job.name === 'cleanup-messages') {
            // Elimina messaggi WhatsApp > 30 giorni (stati conversazionali compresi)
            // Mantiene solo l'ultima settimana per i chatId attivi nelle ultime 48h
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

            // Trova chatId attivi nelle ultime 48h (non toccare conversazioni in corso)
            const activeChats = await prisma.whatsAppMessage.findMany({
                where: { timestamp: { gte: twoDaysAgo } },
                select: { chatId: true },
                distinct: ['chatId'],
            });
            const activeChatIds = activeChats.map(c => c.chatId);

            // Elimina messaggi vecchi solo per chat NON attive di recente
            const deleted = await prisma.whatsAppMessage.deleteMany({
                where: {
                    timestamp: { lt: thirtyDaysAgo },
                    chatId: { notIn: activeChatIds },
                },
            });

            // Elimina stati conversazionali (AWAITING_*, BOOKING_*, etc.) > 24h
            const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
            const deletedStates = await prisma.whatsAppMessage.deleteMany({
                where: {
                    role: {
                        in: [
                            'AWAITING_FRIEND_PHONE', 'AWAITING_FRIEND_LEVEL',
                            'AWAITING_GROUP_PHONES', 'AWAITING_REDIRECT_CHOICE',
                            'AWAITING_INVITATION_CHOICE', 'BOOKING_FLOW',
                            'ONBOARDING_FLOW', 'UNCLEAR_INTENT',
                        ],
                    },
                    timestamp: { lt: oneDayAgo },
                },
            });

            logger.info(`Cleanup: deleted ${deleted.count} old messages, ${deletedStates.count} stale states`);
        }

        // ✅ FIX D (Staleness): i job "daily-reset" possono accumularsi dopo un riavvio.
        //    Se scheduledAt è nel payload e scaduto da > 15min, scartiamo.
        if (job.data?.scheduledAt && Date.now() - job.data.scheduledAt > 15 * 60 * 1000) {
            logger.warn({ jobName: job.name, delayedMs: Date.now() - job.data.scheduledAt },
                'Stale maintenance job discarded');
            return;
        }

        // ✅ FIX F (N+1): job mensile che archivia match completati > 30 giorni
        //    Imposta status ARCHIVED per escluderli da checkSilentMatches e wave selection
        if (job.name === 'archive-old-matches') {
            const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            const archived = await prisma.match.updateMany({
                where: {
                    status: { in: ['LOCKED', 'CANCELLED', 'UNFILLED'] },
                    startTime: { lt: thirtyDaysAgo },
                },
                data: { status: 'ARCHIVED' },
            });
            logger.info(`archive-old-matches: archived ${archived.count} matches`);
        }

        if (job.name === 'prune-conversation-states') {
            const { pruneExpiredStates } = await import('../services/conversation-state');
            await pruneExpiredStates();
        }

        if (job.name === 'cleanup-pending-invitations') {
            const now = new Date();
            const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);

            // 1. Invitation per partite già passate (match terminato o scaduto)
            const expiredByMatch = await prisma.invitation.updateMany({
                where: {
                    status: 'PENDING',
                    match: { startTime: { lt: now } },
                },
                data: { status: 'IGNORED' },
            });

            // 2. Invitation inviate da più di 48h su partite future ancora aperte
            //    (il giocatore non ha risposto in due giorni — non ha senso tenerle vive)
            const expiredByAge = await prisma.invitation.updateMany({
                where: {
                    status: 'PENDING',
                    sentAt: { lt: fortyEightHoursAgo },
                    match: { startTime: { gt: now }, status: 'OPEN' },
                },
                data: { status: 'IGNORED' },
            });

            logger.info(`cleanup-pending-invitations: ${expiredByMatch.count} expired by past match, ${expiredByAge.count} expired by age (>48h)`);
        }

        if (job.name === 'process-match-outcomes') {
            // Finestra: partite terminate nelle ultime 3 ore (copre gap tra run).
            // processMatchOutcomes è idempotente: salta invitation già in stato finale.
            // Usiamo 3h invece di 2h per assorbire eventuali delay del job precedente.
            const windowStart = new Date(Date.now() - 3 * 60 * 60 * 1000);
            const windowEnd = new Date(Date.now() - 5 * 60 * 1000); // non toccare partite ancora in corso

            const recentMatches = await prisma.match.findMany({
                where: {
                    status: { in: ['LOCKED', 'CANCELLED', 'UNFILLED'] },
                    startTime: { gte: windowStart, lte: windowEnd },
                },
                select: { id: true }, // solo id — processMatchOutcomes carica il resto
            });

            for (const match of recentMatches) {
                await processMatchOutcomes(match.id);
            }

            logger.info(`Processed outcomes for ${recentMatches.length} matches`);
        }
    },
    { connection }
);

maintenanceWorker.on('completed', (job) => logger.info(`Maintenance job ${job.name} completed`));
maintenanceWorker.on('failed', (job, err) => logger.error({ err }, `Maintenance job ${job?.name} failed`));

export default maintenanceWorker;
