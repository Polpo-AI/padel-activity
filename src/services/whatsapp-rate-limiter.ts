/**
 * WHATSAPP RATE LIMITER
 *
 * Problema: più batch concorrenti (wave + recovery + onboarding) possono
 * scatenare invii simultanei su Baileys → rischio ban WhatsApp.
 *
 * Soluzione: coda FIFO globale. Tutti gli invii passano per qui.
 * Max 1 messaggio alla volta, con gap minimo configurabile.
 *
 * Non usa Redis — è in memoria perché deve essere nell'istanza Baileys.
 * (Baileys è single-process per design.)
 */

import pino from 'pino';
const logger = pino({ level: 'info' });

const MIN_GAP_MS = 3000;   // minimo 3s tra un messaggio e l'altro
const MAX_GAP_MS = 8000;   // max 8s (gap casuale anti-pattern detection)

interface QueuedSend {
    fn: () => Promise<void>;
    resolve: () => void;
    reject: (err: any) => void;
    jid: string;
}

const queue: QueuedSend[] = [];
let isProcessing = false;
let lastSentAt = 0;

export async function enqueueSend(jid: string, fn: () => Promise<void>): Promise<void> {
    return new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject, jid });
        if (!isProcessing) processQueue();
    });
}

async function processQueue(): Promise<void> {
    if (isProcessing || queue.length === 0) return;
    isProcessing = true;

    while (queue.length > 0) {
        const item = queue.shift()!;

        // Rispetta gap minimo dall'ultimo invio
        const elapsed = Date.now() - lastSentAt;
        const gap = MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS);
        if (elapsed < gap) {
            await sleep(gap - elapsed);
        }

        try {
            await item.fn();
            lastSentAt = Date.now();
            item.resolve();
        } catch (err) {
            logger.error({ err, jid: item.jid }, 'enqueueSend error');
            item.reject(err);
        }
    }

    isProcessing = false;
}

// Statistiche utili per debug
export function getQueueLength(): number {
    return queue.length;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
