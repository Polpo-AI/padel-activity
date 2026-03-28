import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();
const logger = pino({ level: 'info' });

// I worker sono stati spostati in index.ts (hanno bisogno del socket WA).
// Questo processo è mantenuto per compatibilità systemd ma non registra worker.
logger.info('padel-worker: i job sono processati da padel-staging (socket WA incluso).');

process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught Exception in Worker process');
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason, promise }, 'Unhandled Rejection in Worker process');
});
