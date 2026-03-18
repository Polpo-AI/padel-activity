/**
 * CONVERSATION STATE — Dual-write Redis + PostgreSQL
 *
 * Redis è il primary (accesso O(1), latenza ~1ms).
 * PostgreSQL è il fallback: se Redis va giù e si riavvia,
 * lo stato delle conversazioni in corso viene ripristinato
 * invece di costringere l'utente a ricominciare da capo.
 *
 * Le operazioni su DB sono best-effort: un errore non propaga
 * eccezioni al chiamante, lasciando Redis come unica fonte di verità
 * per quella sessione.
 */

import { prisma } from './db';
import { getRedis } from './queue';
import pino from 'pino';

const logger = pino({ level: 'info' });

const DEFAULT_TTL_SECONDS = 24 * 60 * 60;

export async function setState(key: string, data: object, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<void> {
    const redis = getRedis();
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

    // Primary: Redis (sempre prima, path critico)
    await redis.set(key, JSON.stringify(data), 'EX', ttlSeconds);

    // Fallback: PostgreSQL (best-effort — non blocca il flusso se fallisce)
    try {
        await prisma.conversationState.upsert({
            where: { key },
            update: { value: data as any, expiresAt },
            create: { key, value: data as any, expiresAt },
        });
    } catch (err) {
        logger.warn({ err, key }, 'ConversationState DB write failed — Redis only for this session');
    }
}

export async function getState(key: string): Promise<any | null> {
    const redis = getRedis();

    // Primary: Redis
    const raw = await redis.get(key);
    if (raw) return JSON.parse(raw);

    // Fallback: PostgreSQL (Redis miss — es. dopo restart)
    try {
        const row = await prisma.conversationState.findFirst({
            where: { key, expiresAt: { gt: new Date() } },
        });
        if (!row) return null;

        // Ripristina in Redis con il TTL residuo
        const remainingMs = row.expiresAt.getTime() - Date.now();
        if (remainingMs > 0) {
            await redis.set(key, JSON.stringify(row.value), 'PX', remainingMs);
        }
        logger.info({ key }, 'ConversationState restored from DB to Redis after cache miss');
        return row.value;
    } catch (err) {
        logger.warn({ err, key }, 'ConversationState DB read failed');
        return null;
    }
}

export async function clearState(key: string): Promise<void> {
    const redis = getRedis();

    await redis.del(key);

    try {
        await prisma.conversationState.deleteMany({ where: { key } });
    } catch (err) {
        logger.warn({ err, key }, 'ConversationState DB delete failed');
    }
}

// Chiamato dal maintenance worker — elimina righe scadute
export async function pruneExpiredStates(): Promise<void> {
    try {
        const { count } = await prisma.conversationState.deleteMany({
            where: { expiresAt: { lt: new Date() } },
        });
        if (count > 0) logger.info(`ConversationState: pruned ${count} expired rows`);
    } catch (err) {
        logger.warn({ err }, 'ConversationState prune failed');
    }
}
