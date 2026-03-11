/**
 * RETRY UTILITY
 *
 * Retry esponenziale generico con jitter.
 * Usato da tutti i servizi esterni (Anthropic, OpenAI, Prisma, Baileys).
 */

import pino from 'pino';
const logger = pino({ level: 'info' });

export interface RetryOptions {
    maxAttempts?: number;       // default 3
    baseDelayMs?: number;       // default 1000ms
    maxDelayMs?: number;        // default 16000ms
    shouldRetry?: (err: any) => boolean;  // default: ritenta sempre
    context?: string;           // label per il log
}

export async function withRetry<T>(
    fn: () => Promise<T>,
    opts: RetryOptions = {}
): Promise<T> {
    const {
        maxAttempts = 3,
        baseDelayMs = 1000,
        maxDelayMs = 16000,
        shouldRetry = () => true,
        context = 'operation',
    } = opts;

    let lastError: any;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err: any) {
            lastError = err;

            if (!shouldRetry(err) || attempt === maxAttempts) {
                logger.error({ err, context, attempt }, `${context} failed after ${attempt} attempt(s)`);
                throw err;
            }

            // Backoff esponenziale con jitter
            const delay = Math.min(
                baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * 500,
                maxDelayMs
            );

            logger.warn({ context, attempt, nextRetryMs: Math.round(delay) },
                `${context} attempt ${attempt} failed, retrying in ${Math.round(delay)}ms`);

            await sleep(delay);
        }
    }

    throw lastError;
}

// Predicati comuni per shouldRetry

export function isTransientNetworkError(err: any): boolean {
    const msg = err?.message?.toLowerCase() || '';
    const code = err?.code || '';
    return (
        msg.includes('timeout') ||
        msg.includes('econnreset') ||
        msg.includes('econnrefused') ||
        msg.includes('enotfound') ||
        msg.includes('socket hang up') ||
        msg.includes('network') ||
        code === 'ETIMEDOUT' ||
        code === 'ECONNRESET' ||
        code === 'ECONNREFUSED' ||
        // HTTP 429, 500, 502, 503, 504
        err?.status === 429 ||
        err?.status === 500 ||
        err?.status === 502 ||
        err?.status === 503 ||
        err?.status === 504
    );
}

export function isTransientDbError(err: any): boolean {
    const msg = err?.message?.toLowerCase() || '';
    return (
        msg.includes('connection') ||
        msg.includes('timeout') ||
        msg.includes('too many connections') ||
        msg.includes('deadlock') ||
        err?.code === 'P1001' || // Prisma: can't reach DB
        err?.code === 'P1002' || // Prisma: timeout
        err?.code === 'P1008' || // Prisma: operations timed out
        err?.code === 'P1017'    // Prisma: server closed connection
    );
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
