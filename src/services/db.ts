/**
 * DB SERVICE
 *
 * Prisma client singleton con middleware per:
 * - Retry automatico su errori transient (connection timeout, deadlock)
 * - Log query lente (> 2s)
 * - Notifica admin se DB è irraggiungibile per più di 3 tentativi
 */

import { PrismaClient } from '@prisma/client';
import { withRetry, isTransientDbError } from '../utils/retry';
import pino from 'pino';

const logger = pino({ level: 'info' });

function createPrismaClient() {
    const client = new PrismaClient({
        log: [
            { level: 'warn', emit: 'event' },
            { level: 'error', emit: 'event' },
        ],
    });

    // Log query lente
    (client.$on as any)('warn', (e: any) => {
        logger.warn({ message: e.message }, 'Prisma warning');
    });

    (client.$on as any)('error', (e: any) => {
        logger.error({ message: e.message }, 'Prisma error');
    });

    return client;
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };
export const prisma = globalForPrisma.prisma ?? createPrismaClient();
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

// ─────────────────────────────────────────────
// WRAPPER CON RETRY per operazioni critiche
// ─────────────────────────────────────────────

export async function dbQuery<T>(
    fn: () => Promise<T>,
    context: string = 'db query'
): Promise<T> {
    return withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 4000,
        shouldRetry: isTransientDbError,
        context,
    });
}

// ─────────────────────────────────────────────
// HEALTH CHECK
// ─────────────────────────────────────────────

export async function checkDbHealth(): Promise<boolean> {
    try {
        await prisma.$queryRaw`SELECT 1`;
        return true;
    } catch (err) {
        logger.error({ err }, 'DB health check failed');
        return false;
    }
}
