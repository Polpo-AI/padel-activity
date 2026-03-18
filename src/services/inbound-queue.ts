/**
 * INBOUND QUEUE
 *
 * Debounce 5s per JID: accumula messaggi in arrivo e li processa in batch.
 * Persistenza su Redis: se il processo cade i batch pendenti sopravvivono
 * e vengono recuperati al restart dopo 30s.
 */

import pino from 'pino';
import { proto } from '@whiskeysockets/baileys';
import { getRedis } from './queue';

const logger = pino({ level: 'info' });

const DEBOUNCE_MS = 10000;
const REDIS_TTL_S = 600;         // 10 minuti
const RECOVERY_DELAY_MS = 30000; // 30s dopo startup

const prefix = process.env.QUEUE_PREFIX ? `${process.env.QUEUE_PREFIX}-` : '';

export interface NormalizedMessage {
    type: 'text' | 'audio' | 'contact' | 'other';
    text?: string;
    contactPhone?: string;
    contactName?: string;
    raw: proto.IWebMessageInfo;
}

type BatchHandler = (jid: string, messages: NormalizedMessage[]) => Promise<void>;

interface PendingBatch {
    messages: NormalizedMessage[];
    timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, PendingBatch>();
let batchHandler: BatchHandler | null = null;

// Message ID deduplication: prevents double-processing if Baileys emits same message twice
const recentMsgIds = new Set<string>();
const DEDUP_WINDOW_MS = 60000; // 1 minute window

// ─────────────────────────────────────────────
// REGISTRA HANDLER
// ─────────────────────────────────────────────

export function registerBatchHandler(handler: BatchHandler) {
    batchHandler = handler;
    setTimeout(recoverPendingBatches, RECOVERY_DELAY_MS);
}

// ─────────────────────────────────────────────
// ENQUEUE
// ─────────────────────────────────────────────

export function enqueue(raw: proto.IWebMessageInfo): void {
    const jid = raw.key?.remoteJid;
    if (!jid || jid.endsWith('@g.us')) return;

    // Deduplication: skip already-seen message IDs
    const msgId = raw.key?.id;
    if (msgId) {
        if (recentMsgIds.has(msgId)) {
            logger.warn({ msgId, jid }, 'Duplicate message ID detected — skipping');
            return;
        }
        recentMsgIds.add(msgId);
        setTimeout(() => recentMsgIds.delete(msgId), DEDUP_WINDOW_MS);
    }

    const msg = normalize(raw);
    if (!msg) return;

    if (pending.has(jid)) {
        clearTimeout(pending.get(jid)!.timer);
        pending.get(jid)!.messages.push(msg);
    } else {
        pending.set(jid, { messages: [msg], timer: setTimeout(() => {}, 0) });
    }

    const batch = pending.get(jid)!;
    batch.timer = setTimeout(() => flush(jid), DEBOUNCE_MS);

    persistToRedis(jid, batch.messages).catch(() => {});
}

// ─────────────────────────────────────────────
// FLUSH
// ─────────────────────────────────────────────

async function flush(jid: string): Promise<void> {
    const batch = pending.get(jid);
    if (!batch) return;

    pending.delete(jid);
    await deleteFromRedis(jid).catch(() => {});

    if (!batchHandler) {
        logger.error('No batch handler registered');
        return;
    }

    logger.info(`Flushing batch for ${jid}: ${batch.messages.length} messages`);

    try {
        await batchHandler(jid, batch.messages);
    } catch (err) {
        logger.error({ err, jid }, 'Batch handler error');
    }
}

// ─────────────────────────────────────────────
// NORMALIZZA
// ─────────────────────────────────────────────

function normalize(raw: proto.IWebMessageInfo): NormalizedMessage | null {
    const msg = raw.message;
    if (!msg) return null;

    const text =
        msg.conversation ||
        msg.extendedTextMessage?.text ||
        msg.ephemeralMessage?.message?.extendedTextMessage?.text;
    if (text) return { type: 'text', text, raw };

    if (msg.audioMessage) return { type: 'audio', raw };

    if (msg.contactMessage) {
        const vcard = msg.contactMessage.vcard || '';
        const phoneMatch = vcard.match(/TEL[^:]*:([+\d\s()-]+)/);
        const nameMatch = vcard.match(/FN:(.+)/);
        return {
            type: 'contact',
            contactPhone: phoneMatch?.[1]?.replace(/\s/g, '') || undefined,
            contactName: nameMatch?.[1]?.trim() || msg.contactMessage.displayName || undefined,
            raw,
        };
    }

    if (msg.contactsArrayMessage?.contacts?.length) {
        const first = msg.contactsArrayMessage.contacts[0];
        const vcard = first.vcard || '';
        const phoneMatch = vcard.match(/TEL[^:]*:([+\d\s()-]+)/);
        const nameMatch = vcard.match(/FN:(.+)/);
        return {
            type: 'contact',
            contactPhone: phoneMatch?.[1]?.replace(/\s/g, '') || undefined,
            contactName: nameMatch?.[1]?.trim() || first.displayName || undefined,
            raw,
        };
    }

    return { type: 'other', raw };
}

// ─────────────────────────────────────────────
// REDIS
// ─────────────────────────────────────────────

async function persistToRedis(jid: string, messages: NormalizedMessage[]): Promise<void> {
    try {
        const redis = getRedis();
        const serializable = messages.map(m => ({
            type: m.type,
            text: m.text,
            contactPhone: m.contactPhone,
            contactName: m.contactName,
            rawKey: m.raw.key,
            rawMessage: m.raw.message,
        }));
        await redis.setex(`${prefix}inbound:${jid}`, REDIS_TTL_S, JSON.stringify(serializable));
    } catch {}
}

async function deleteFromRedis(jid: string): Promise<void> {
    try {
        const redis = getRedis();
        await redis.del(`${prefix}inbound:${jid}`);
    } catch {}
}

async function recoverPendingBatches(): Promise<void> {
    try {
        const redis = getRedis();
        const keys = await redis.keys(`${prefix}inbound:*`);
        if (keys.length === 0) return;

        logger.info(`Recovering ${keys.length} pending batches from Redis after restart`);

        for (const key of keys) {
            const jid = key.replace(`${prefix}inbound:`, '');
            const data = await redis.get(key);
            if (!data) continue;

            try {
                const messages: NormalizedMessage[] = JSON.parse(data).map((m: any) => ({
                    ...m,
                    raw: { key: m.rawKey, message: m.rawMessage },
                }));
                await redis.del(key);
                if (batchHandler && messages.length > 0) {
                    // Point 7: check if bot already responded since the last inbound message
                    // to avoid double-sending on restart when the crash happened after responding
                    let alreadyResponded = false;
                    try {
                        const { prisma } = await import('./db');
                        const lastInboundTs = messages[messages.length - 1].raw?.messageTimestamp;
                        const sinceMs = lastInboundTs ? Number(lastInboundTs) * 1000 : Date.now() - 300000;
                        const botMsg = await prisma.whatsAppMessage.findFirst({
                            where: { chatId: jid, role: 'BOT', timestamp: { gte: new Date(sinceMs) } },
                            orderBy: { timestamp: 'desc' },
                        });
                        if (botMsg) {
                            logger.info({ jid }, 'Recovery skipped — bot already responded since last inbound message');
                            alreadyResponded = true;
                        }
                    } catch {}
                    if (!alreadyResponded) {
                        await batchHandler(jid, messages);
                    }
                }
            } catch (err) {
                logger.error({ err, jid }, 'Failed to recover batch');
                await redis.del(key);
            }
        }
    } catch (err) {
        logger.error({ err }, 'Failed to recover pending batches');
    }
}
