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

        // ✅ FIX D (Staleness): job accumulati dopo un riavvio — se scheduledAt è nel payload
        // ed è scaduto da > 15min, scarta PRIMA di eseguire qualsiasi job (a metà handler
        // proteggeva solo i job dichiarati dopo il check).
        if (job.data?.scheduledAt && Date.now() - job.data.scheduledAt > 15 * 60 * 1000) {
            logger.warn({ jobName: job.name, delayedMs: Date.now() - job.data.scheduledAt },
                'Stale maintenance job discarded');
            return;
        }

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
            const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);

            // 1. Invitation per partite già passate → IGNORED. MA NON toccare i PENDING su partite
            //    LOCKED finite da meno di 3h: sono "fantasmi" che processMatchOutcomes deve ancora
            //    penalizzare (gira ogni 2h su finestra 3h). Metterli IGNORED qui li farebbe sfuggire
            //    alla penalità (com'era prima). Le LOCKED più vecchie di 3h (fuori finestra) le
            //    ripuliamo comunque per non lasciare PENDING orfani.
            const expiredByMatch = await prisma.invitation.updateMany({
                where: {
                    status: 'PENDING',
                    OR: [
                        { match: { startTime: { lt: threeHoursAgo } } },                 // troppo vecchie: pulisci
                        { match: { startTime: { lt: now }, status: { not: 'LOCKED' } } }, // passate non-giocate: neutro
                    ],
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

        if (job.name === 'skill-test-reminder') {
            // Promemoria settimanale: giocatori registrati da 2+ giorni ancora senza
            // valutazione col maestro (skillLevel <= 0). Finché non hanno un livello
            // possono solo prenotare in privato — l'admin deve organizzare gli skill test.
            const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
            const clubs = await prisma.club.findMany({ select: { id: true, name: true, adminPhone: true } });
            for (const club of clubs) {
                const pending = await prisma.player.findMany({
                    where: { clubId: club.id, active: true, skillLevel: { lte: 0 }, createdAt: { lt: twoDaysAgo } },
                    select: { name: true, phoneNumber: true, createdAt: true },
                    orderBy: { createdAt: 'asc' },
                    take: 30,
                });
                if (pending.length === 0) continue;
                const lines = pending.map(p =>
                    `• ${p.name || 'Senza nome'} (+${p.phoneNumber}) — iscritto il ${p.createdAt.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' })}`
                ).join('\n');
                const { notifyAdmin } = await import('../utils/notify-admin');
                const { runWithContext } = await import('../utils/request-context');
                await runWithContext({ clubId: club.id }, () =>
                    notifyAdmin(
                        `📋 Valutazioni col maestro in attesa (${pending.length}):\n${lines}\n\nFinché non assegni il livello (Dashboard → Utenti) possono solo prenotare il campo in privato — niente inviti alle partite.`,
                        `skill-test-reminder-${club.id}`,
                        club.adminPhone ?? undefined,
                        club.name ?? undefined,
                        'players',
                    )
                ).catch(() => {});
            }
            logger.info('skill-test-reminder: done');
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
