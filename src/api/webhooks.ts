/**
 * WEBHOOKS
 *
 * ✅ FIX CRITICITÀ A (Multi-Tenancy):
 *    Il clubId viene richiesto esplicitamente nel body del webhook.
 *    Niente più prisma.club.findFirst() — ogni match è sempre associato
 *    al club corretto fin dalla creazione.
 *
 * ✅ FIX CRITICITÀ D (Staleness Check):
 *    I job wave processati dopo un riavvio vengono scartati se il loro
 *    timestamp schedulato è scaduto da più di STALE_THRESHOLD_MS.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../services/db';
import { waveQueue } from '../services/queue';
import * as crypto from 'crypto';
import pino from 'pino';

const logger = pino({ level: 'info' });
const router = Router();

// ✅ FIX O: autenticazione HMAC-SHA256 sul webhook
// Il chiamante (sistema prenotazioni) deve inviare:
//   Header: X-Webhook-Signature: sha256=<HMAC_HEX>
// dove HMAC_HEX = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex')
//
// Impostare WEBHOOK_SECRET nel .env. Se non configurato, il webhook è bloccato in produzione.
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

function verifyWebhookSignature(req: Request, res: Response, next: NextFunction): void {
    // In development senza secret configurato: warn ma passa
    if (!WEBHOOK_SECRET) {
        if (process.env.NODE_ENV === 'production') {
            logger.error('WEBHOOK_SECRET not set — blocking webhook in production');
            res.status(401).json({ error: 'Webhook not configured' });
            return;
        }
        logger.warn('WEBHOOK_SECRET not set — skipping signature check (dev mode only)');
        next();
        return;
    }

    const signature = req.headers['x-webhook-signature'] as string;
    if (!signature?.startsWith('sha256=')) {
        logger.warn('Webhook request missing X-Webhook-Signature header');
        res.status(401).json({ error: 'Missing webhook signature' });
        return;
    }

    const rawBody = JSON.stringify(req.body); // body già parsato da express.json()
    const expected = 'sha256=' + crypto
        .createHmac('sha256', WEBHOOK_SECRET)
        .update(rawBody)
        .digest('hex');

    // Timing-safe compare per prevenire timing attacks
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
        logger.warn({ ip: req.ip }, 'Invalid webhook signature — rejected');
        res.status(401).json({ error: 'Invalid webhook signature' });
        return;
    }

    next();
}

// Job considerato "stale" se creato più di 15 minuti fa senza essere processato
export const STALE_THRESHOLD_MS = 15 * 60 * 1000;

router.post('/slots', verifyWebhookSignature, async (req, res) => {
    try {
        const { court, time, skill_level, players_needed = 4, clubId } = req.body;

        // ✅ FIX: clubId ora obbligatorio per garantire il corretto isolamento multi-tenant
        if (!court || !time || !skill_level || !clubId) {
            return res.status(400).json({ error: 'Missing required fields: court, time, skill_level, clubId' });
        }

        // ✅ FIX: verifica che il club esista prima di procedere
        const club = await prisma.club.findUnique({ where: { id: clubId } });
        if (!club) {
            return res.status(404).json({ error: `Club ${clubId} not found` });
        }

        // ✅ FIX: match sempre creato con clubId esplicito — nessun findFirst()
        const match = await prisma.match.create({
            data: {
                clubId,
                court,
                startTime: new Date(time),
                skillLevel: (skill_level || 'INTERMEDIATE').toUpperCase() as any,
                playersNeeded: parseInt(players_needed, 10) || 4,
                status: 'OPEN',
            },
        });

        logger.info({ matchId: match.id, clubId, time, court }, 'Match created via webhook');

        const minDelayMs = 25000;
        const maxDelayMs = 125000;
        const initialDelayMs = Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1)) + minDelayMs;

        // ✅ FIX: aggiungiamo scheduledAt nel payload del job per lo staleness check
        await waveQueue.add(
            'process-wave',
            {
                matchId: match.id,
                waveNumber: 1,
                limit: 4,
                scheduledAt: Date.now() + initialDelayMs, // usato dallo staleness check nel worker
            },
            {
                delay: initialDelayMs,
                removeOnComplete: true,
            }
        );

        res.status(201).json({
            message: 'Match slotted and Initial Wave scheduled',
            matchId: match.id,
            clubId,
            plannedExecutionDelaySeconds: initialDelayMs / 1000,
        });
    } catch (error) {
        logger.error({ error }, 'Error processing slot webhook');
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
