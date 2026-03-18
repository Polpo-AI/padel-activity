/**
 * ENTRY POINT — Padel Bot
 *
 * Gestione errori completa:
 * - Retry su tutte le chiamate esterne (AI, DB, Redis) — vedi retry.ts
 * - Inbound queue persistente su Redis — i messaggi sopravvivono al restart
 * - Wave silente: maintenance rilancia wave orfane ogni 30min
 * - Health check reale: controlla DB, Redis, WhatsApp
 * - Notifiche admin su errori critici e fallimenti ripetuti
 * - Graceful shutdown su SIGTERM/SIGINT
 * - PM2 gestisce il restart automatico (vedi ecosystem.config.js)
 * - Feedback garantito: ogni messaggio riceve sempre una risposta (vedi messageHandler)
 */

import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import pino from 'pino';
import path from 'path';
import fs from 'fs';

import webhooksRouter from './api/webhooks';
import dashboardRouter from './api/dashboard.api';
import { connectToWhatsApp, getConnectionStatus } from './services/whatsapp';
import { maintenanceQueue, checkSilentMatches, checkRedisHealth } from './services/queue';
import { checkDbHealth } from './services/db';
import { notifyAdminCritical } from './utils/notify-admin';

// Workers
import './workers/wave.worker';
import './workers/recovery.worker';
import './workers/maintenance.worker';

// Registra batch handler
import './services/messageHandler';
import { wahEvents } from './services/whatsapp';
import { enqueue } from './services/inbound-queue';
wahEvents.on('message', (msg) => enqueue(msg));

const logger = pino({
    level: process.env.LOG_LEVEL || 'info',
    transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
});

const app = express();

// ─────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────

app.use(express.json({
    verify: (req: any, res, buf) => {
        req.rawBody = buf;
    }
}));
app.use(express.urlencoded({ extended: true }));

app.disable('x-powered-by');

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', process.env.DASHBOARD_ORIGIN || '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'DENY');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────

// Dashboard React in produzione
if (process.env.NODE_ENV === 'production') {
    const buildPath = path.join(__dirname, '../dashboard/dist');
    const indexExists = fs.existsSync(path.join(buildPath, 'index.html'));
    logger.info({ buildPath, indexExists }, 'Serving dashboard from');
    
    app.use('/dashboard', express.static(buildPath));
    app.get(/^\/dashboard($|\/.*)/, (req, res) => {
        res.sendFile(path.join(buildPath, 'index.html'));
    });
}

app.use('/api/webhooks', webhooksRouter);
app.use('/api/dashboard', dashboardRouter);

// ─────────────────────────────────────────────
// HEALTH CHECK REALE
// Controlla DB, Redis, WhatsApp — ritorna 503 se qualcosa è down
// ─────────────────────────────────────────────

app.get('/health', async (req, res) => {
    const [dbOk, redisOk] = await Promise.all([
        checkDbHealth(),
        checkRedisHealth(),
    ]);

    const waStatus = getConnectionStatus(); // 'open' | 'connecting' | 'closed'
    const waOk = waStatus === 'open';

    const status = {
        db: dbOk ? 'ok' : 'down',
        redis: redisOk ? 'ok' : 'down',
        whatsapp: waOk ? 'ok' : waStatus,
        ts: new Date().toISOString(),
    };

    const allOk = dbOk && redisOk;  // WA può essere in reconnect — non blocca il 200
    res.status(allOk ? 200 : 503).json(status);
});

// ─────────────────────────────────────────────
// JOB SCHEDULATI
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// GLOBAL EXPRESS ERROR HANDLER
// ─────────────────────────────────────────────
// Cattura errori di parse JSON e altri errori Express prima che diventino 500 non gestiti
app.use((err: any, req: any, res: any, _next: any) => {
    // Payload too large (413)
    if (err.type === 'entity.too.large' || err.status === 413) {
        return res.status(413).json({ error: 'Payload troppo grande' });
    }
    // JSON parse errors (400)
    if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) {
        return res.status(400).json({ error: 'Body JSON non valido o Content-Type errato' });
    }
    // Other 4xx errors — preserva il codice originale
    if (err.status && err.status >= 400 && err.status < 500) {
        return res.status(err.status).json({ error: err.message || 'Bad request' });
    }
    logger.error({ err, url: req.url, method: req.method }, 'Unhandled Express error');
    return res.status(500).json({ error: 'Internal server error' });
});

async function scheduleMaintenance() {
    await maintenanceQueue.add('daily-reset', {}, {
        repeat: { pattern: '0 0 * * *' },
        jobId: 'daily-reset',
        removeOnComplete: true,
    });

    await maintenanceQueue.add('check-timeouts', {}, {
        repeat: { every: 30 * 60 * 1000 },
        jobId: 'check-timeouts',
        removeOnComplete: true,
    });

    await maintenanceQueue.add('process-match-outcomes', {}, {
        repeat: { every: 2 * 60 * 60 * 1000 },
        jobId: 'process-match-outcomes',
        removeOnComplete: true,
    });

    // Controlla wave silenti ogni 30 minuti
    await maintenanceQueue.add('check-silent-matches', {}, {
        repeat: { every: 30 * 60 * 1000 },
        jobId: 'check-silent-matches',
        removeOnComplete: true,
    });

    // Pulizia WhatsAppMessage — ogni notte alle 03:00
    await maintenanceQueue.add('cleanup-messages', {}, {
        repeat: { pattern: '0 3 * * *' },
        jobId: 'cleanup-messages',
        removeOnComplete: true,
    });

    // Pulizia invitation PENDING scadute — ogni ora
    await maintenanceQueue.add('cleanup-pending-invitations', {}, {
        repeat: { every: 60 * 60 * 1000 },
        jobId: 'cleanup-pending-invitations',
        removeOnComplete: true,
    });

    logger.info('Maintenance jobs scheduled (daily-reset, check-timeouts, check-silent, cleanup-messages, process-outcomes, cleanup-pending-invitations)');
}

// ─────────────────────────────────────────────
// STARTUP
// ─────────────────────────────────────────────

async function main() {
    const PORT = parseInt(process.env.STAGING_PORT || process.env.PORT || '3000', 10);
    app.listen(PORT, () => {
        logger.info(`Server on port ${PORT}`);
        logger.info(`Dashboard: http://localhost:${PORT}/dashboard`);
        logger.info(`Health:    http://localhost:${PORT}/health`);
    });

    logger.info('Starting Padel Bot logic...');

    // Verifica DB prima di tutto
    const dbOk = await checkDbHealth();
    if (!dbOk) {
        logger.error('Cannot reach database on startup — continuing but functionality will be limited');
        notifyAdminCritical('Bot avviato ma Database non raggiungibile. Funzionalità limitata.').catch(() => {});
    }

    // WhatsApp First (so we can notify about errors later)
    try {
        await connectToWhatsApp();
        logger.info('WhatsApp connection sequence started');
    } catch (err) {
        logger.error({ err }, 'WhatsApp initial socket creation failed');
    }

    // Wait a bit for WhatsApp to actually connect before critical health checks
    // this avoids "socket not initialized" errors in notifyAdmin
    await new Promise(r => setTimeout(r, 2000));

    // Verifica Redis
    const redisOk = await checkRedisHealth();
    if (!redisOk) {
        logger.warn('Redis not reachable on startup — waves will not work until Redis is up');
        notifyAdminCritical('Bot avviato ma Redis non raggiungibile. Le wave sono sospese.').catch(() => {});
    }

    await scheduleMaintenance();
}

main().catch(async (err) => {
    logger.error({ err }, 'Fatal error during startup');
    await notifyAdminCritical(`Bot crashato all'avvio: ${err.message}`).catch(() => {});
    process.exit(1);
});

// ─────────────────────────────────────────────
// GRACEFUL SHUTDOWN
// ─────────────────────────────────────────────

async function shutdown(signal: string) {
    logger.info(`${signal} received — graceful shutdown`);
    try {
        const { prisma } = await import('./services/db');
        await prisma.$disconnect();
        const { getRedis } = await import('./services/queue');
        await getRedis().quit();
    } catch {}
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('unhandledRejection', async (reason: any) => {
    logger.error({ reason }, 'Unhandled promise rejection');
    const msg = reason instanceof Error ? reason.message : String(reason);
    await notifyAdminCritical(`Eccezione Async Silente: ${msg.substring(0, 150)}`).catch(() => {});
});

process.on('uncaughtException', async (err) => {
    logger.error({ err }, 'Uncaught exception — process will exit');
    await notifyAdminCritical(`Eccezione non gestita: ${err.message}`).catch(() => {});
    process.exit(1);
});
