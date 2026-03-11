import dotenv from 'dotenv';
import pino from 'pino';

import './workers/wave.worker';
import './workers/reminder.worker';
import './workers/maintenance.worker';
import './workers/recovery.worker';

dotenv.config();
const logger = pino({ level: 'info' });

logger.info('🚀 Padel Bot Workers started — wave | reminder | maintenance | recovery');

process.on('uncaughtException', (err) => {
    logger.error({ err }, 'Uncaught Exception in Worker process');
});

process.on('unhandledRejection', (reason, promise) => {
    logger.error({ reason, promise }, 'Unhandled Rejection in Worker process');
});
