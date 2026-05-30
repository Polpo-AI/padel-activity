/**
 * WhatsApp Service — Multi-Tenant Edition
 *
 * Ogni circolo ha il proprio socket Baileys separato.
 * Il routing usa clubId dal request-context (AsyncLocalStorage):
 *   – messageHandler setta il clubId quando riceve un messaggio
 *   – processWave setta il clubId dal match.clubId
 *   – Tutte le chiamate a sendMessage/simulateTypingAndSend all'interno
 *     del pipeline usano automaticamente il socket corretto
 *
 * Fallback: se clubId non è nel context, usa il primo socket 'open' disponibile
 * (backward-compat per codice non ancora multi-tenant-aware).
 *
 * Human Simulation Layers:
 * 1. Read receipt (blue ticks)
 * 2. Read delay (1.5–3.5s)
 * 3. Composing burst with mid-pause
 * 4. Proportional typing time
 * 5. Message chunking (two bubbles for long messages)
 * 6. Random micro-pauses
 */

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    delay,
    proto,
    downloadMediaMessage,
    Browsers,
    fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import * as qrcode from 'qrcode-terminal';
import EventEmitter from 'events';

export const wahEvents = new EventEmitter();

const logger = pino({ level: 'info' });

// ─────────────────────────────────────────────
// STATO PER CLUB
// ─────────────────────────────────────────────

interface ClubSocketState {
    sock: ReturnType<typeof makeWASocket> | null;
    status: 'open' | 'connecting' | 'closed';
    reconnectAttempts: number;
    isReconnecting: boolean;
    syncTimer: NodeJS.Timeout | null;
    syncCount: number;
    isResyncing: boolean;
    offlineMessages: Map<string, proto.IWebMessageInfo[]>;
    botPhoneNumber?: string;
    heartbeatInterval: NodeJS.Timeout | null;
    lastHeartbeatOk: number; // timestamp ultima conferma socket vivo
}

// Map<clubId, stato> — supporta N club contemporaneamente
const clubSockets = new Map<string, ClubSocketState>();

// Chiave usata per club senza ID esplicito (legacy single-tenant)
const DEFAULT_CLUB_KEY = 'default';

const MAX_RECONNECT_DELAY_MS = 64000;
const OFFLINE_MSG_WINDOW_MS = 24 * 60 * 60 * 1000;
const SEND_WAIT_TIMEOUT_MS = 30_000; // attende fino a 30s che il socket torni su

// ─────────────────────────────────────────────
// WAIT FOR SOCKET — gestisce microinterruzioni WA
// ─────────────────────────────────────────────

/**
 * Attende che il socket del club sia disponibile (sock != null).
 * Gestisce i casi in cui WA si disconnette brevemente e si riconnette
 * entro pochi secondi (es. rotazione di sessione, microinterruzioni di rete).
 * Lancia solo se il timeout viene superato.
 */
async function waitForSocket(clubId: string | undefined, timeoutMs = SEND_WAIT_TIMEOUT_MS): Promise<ClubSocketState> {
    const deadline = Date.now() + timeoutMs;
    let waited = false;
    while (Date.now() < deadline) {
        const cs = clubId ? (clubSockets.get(clubId) ?? null) : getSocketForClub(clubId);
        if (cs?.sock) {
            if (waited) logger.info({ clubId }, 'Socket came back — sending queued message');
            return cs;
        }
        waited = true;
        await new Promise(r => setTimeout(r, 1500));
    }
    throw new Error(`WhatsApp socket not available${clubId ? ` for club ${clubId}` : ''} after ${timeoutMs}ms`);
}

// ─────────────────────────────────────────────
// ROUTING: socket corretto per il club corrente
// ─────────────────────────────────────────────

function getSocketForClub(clubId?: string): ClubSocketState | null {
    // Multi-tenant: se il context specifica un club, usa SOLO il suo socket.
    // Mai ripiegare su quello di un altro club → altrimenti invieremmo dal numero WhatsApp sbagliato.
    // Se non è ancora pronto restituiamo null (il chiamante attende/fallisce invece di misroutare).
    if (clubId) return clubSockets.get(clubId) ?? null;

    // Legacy single-tenant (nessun clubId nel context): primo socket 'open', poi qualsiasi inizializzato
    for (const [, cs] of clubSockets) {
        if (cs.status === 'open') return cs;
    }
    if (clubSockets.size > 0) return clubSockets.values().next().value!;

    return null;
}

/** Restituisce il clubId corrente dal request-context */
function currentClubId(): string | undefined {
    try {
        const { getClubId } = require('../utils/request-context');
        return getClubId();
    } catch {
        return undefined;
    }
}

// ─────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────

const randomInt = (min: number, max: number) =>
    Math.floor(Math.random() * (max - min + 1)) + min;

const jitteredSleep = (ms: number, jitterMs = 500) => {
    const jitter = randomInt(-jitterMs, jitterMs);
    const total = Math.max(200, ms + jitter);
    return delay(total);
};

const formatJid = (jid: string) => {
    if (jid.includes('@lid')) return jid;
    if (jid.includes('@s.whatsapp.net')) return jid;
    return `${jid.replace(/\D/g, '')}@s.whatsapp.net`;
};

function maybeSplitMessage(text: string): [string, string | null] {
    if (text.includes('\n')) return [text, null];
    if (text.length < 120) return [text, null];

    const splitChars = ['. ', '! ', '? '];
    const mid = Math.floor(text.length * 0.55);

    for (const ch of splitChars) {
        const idx = text.indexOf(ch, mid - 20);
        if (idx > 0 && idx < text.length - 10) {
            const before = text.slice(0, idx);
            const openParens = (before.match(/\(/g) || []).length;
            const closeParens = (before.match(/\)/g) || []).length;
            if (openParens > closeParens) continue;
            return [text.slice(0, idx + ch.length - 1).trim(), text.slice(idx + ch.length - 1).trim()];
        }
    }

    return [text, null];
}

// ─────────────────────────────────────────────
// CONNESSIONE — una per club
// ─────────────────────────────────────────────

/**
 * Connette un club a WhatsApp.
 * @param clubId - ID del circolo (opzionale: usa 'default' per legacy single-tenant)
 * @param botPhoneNumber - Numero WA del bot per pairing code (opzionale, sovrascrive BOT_PHONE_NUMBER env)
 */
export async function connectToWhatsApp(clubId?: string, botPhoneNumber?: string): Promise<void> {
    const key = clubId || DEFAULT_CLUB_KEY;
    const botPhone = botPhoneNumber || process.env.BOT_PHONE_NUMBER;

    // Crea stato iniziale per questo club
    const state: ClubSocketState = {
        sock: null,
        status: 'connecting',
        reconnectAttempts: 0,
        isReconnecting: false,
        syncTimer: null,
        syncCount: 0,
        isResyncing: false,
        offlineMessages: new Map(),
        botPhoneNumber: botPhone,
        heartbeatInterval: null,
        lastHeartbeatOk: Date.now(),
    };
    clubSockets.set(key, state);

    logger.info({ clubId: key, botPhone }, 'Connecting club to WhatsApp...');
    await _doConnect(key, state);
}

async function _doConnect(key: string, state: ClubSocketState): Promise<void> {
    const authFolder = `baileys_auth_info${key !== DEFAULT_CLUB_KEY ? `_${key}` : ''}`;
    const { state: authState, saveCreds } = await useMultiFileAuthState(authFolder);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info({ clubId: key }, `Using WA version: ${version.join('.')} (isLatest: ${isLatest})`);

    const sock = makeWASocket({
        version,
        auth: authState,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }) as any,
        browser: ['Ubuntu', 'Chrome', '120.0.6099.129'],
    });

    state.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    let isPairingCodeRequested = false;

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            const forceQr = process.env.FORCE_QR === 'true';
            const botPhone = state.botPhoneNumber;
            if (botPhone && !sock.authState.creds.registered && !isPairingCodeRequested && !forceQr) {
                isPairingCodeRequested = true;
                try {
                    const cleanNumber = botPhone.replace(/\D/g, '');
                    logger.info({ clubId: key }, `[AUTH] Requesting pairing code for: ${cleanNumber}`);
                    const code = await sock.requestPairingCode(cleanNumber);
                    logger.info({ clubId: key, code }, `🔢 CODICE DI ABBINAMENTO — Apri WA Business > Dispositivi Collegati > Collega con numero`);
                } catch (err) {
                    logger.error({ err, clubId: key }, 'Errore pairing code');
                }
            } else {
                logger.info({ clubId: key }, '📱 Scan QR Code:');
                qrcode.generate(qr, { small: true });
            }
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
            state.status = 'closed';
            if (state.heartbeatInterval) {
                clearInterval(state.heartbeatInterval);
                state.heartbeatInterval = null;
            }
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

            logger.error({ statusCode, clubId: key, error: lastDisconnect?.error?.message },
                `WA connection closed for club ${key}. Reconnecting: ${shouldReconnect}`);

            if (shouldReconnect && !state.isReconnecting) {
                state.isReconnecting = true;
                const delayMs = Math.min(1000 * Math.pow(2, state.reconnectAttempts), MAX_RECONNECT_DELAY_MS);
                state.reconnectAttempts++;
                logger.warn({ attempt: state.reconnectAttempts, delayMs, clubId: key }, 'Reconnecting...');
                setTimeout(() => {
                    state.isReconnecting = false;
                    _doConnect(key, state).catch(err =>
                        logger.error({ err, clubId: key }, 'Reconnect failed')
                    );
                }, delayMs);
            } else if (shouldReconnect && state.isReconnecting) {
                logger.warn({ clubId: key }, 'Reconnect already scheduled — skipping duplicate');
            }

        } else if (connection === 'open') {
            logger.info({ clubId: key }, '✅ WhatsApp Connected!');
            state.reconnectAttempts = 0;
            state.isReconnecting = false;
            state.status = 'open';
            state.lastHeartbeatOk = Date.now();

            // Notifica admin startup + retry FAQ pending (non-blocking)
            setTimeout(async () => {
                try {
                    const { prisma } = await import('./db');
                    const club = key === DEFAULT_CLUB_KEY
                        ? await prisma.club.findFirst({ where: { adminPhone: { not: null } } })
                        : await prisma.club.findUnique({ where: { id: key }, select: { adminPhone: true, name: true, id: true } });

                    if (club?.adminPhone) {
                        const adminJid = `${club.adminPhone.replace(/\D/g, '')}@s.whatsapp.net`;
                        await _sendRaw(state, adminJid, '🤖 *Bot riavviato — connesso.*');

                        // Retry FAQ domande in attesa non inviate (WA era disconnessa)
                        // Usa il nuovo sistema faq:pending_ids + faq:pending:{clubId}:{faqId}
                        try {
                            const { getRedis } = await import('./queue');
                            const redis = getRedis();
                            const clubId = (club as any).id || key;

                            // Cleanup chiave legacy (può essere ancora presente su istanze pre-refactor)
                            await redis.del(`faq:pending_question:${clubId}`).catch(() => {});

                            const pendingIds = await redis.lrange(`faq:pending_ids:${clubId}`, 0, -1);
                            if (pendingIds.length > 0) {
                                const items = (await Promise.all(
                                    pendingIds.map((id: string) => redis.get(`faq:pending:${clubId}:${id}`))
                                )).filter(Boolean).map((raw: string) => JSON.parse(raw!));

                                if (items.length > 0) {
                                    const prefix = items.length > 1 ? `[${items.length} domande in sospeso]\n` : '';
                                    const first = items[0];
                                    const msg = `${prefix}❓ ${first.askedBy || 'Un giocatore'} ha chiesto:\n"${first.question}"\n\nRispondi qui per inoltrarla all'utente e salvarla come FAQ.`;
                                    await _sendRaw(state, adminJid, msg);
                                    logger.info({ clubId, count: items.length, question: first.question }, 'Pending FAQ(s) sent to admin after reconnect');
                                }
                            }
                        } catch (faqErr) {
                            logger.warn({ faqErr }, 'Failed to send pending FAQ on reconnect');
                        }
                    }
                } catch (err) {
                    logger.error({ err, clubId: key }, 'Failed to send startup notification');
                }
            }, 5000);
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        // Messaggi `append` = storia offline consegnata da WA al reconnect.
        // Raccolta sempre attiva (non dipende da isResyncing) con finestra 24h.
        if (m.type === 'append') {
            const cutoff = Date.now() - OFFLINE_MSG_WINDOW_MS;
            for (const msg of m.messages) {
                if (msg.key.fromMe || !msg.message || !msg.key.remoteJid) continue;
                if (msg.key.remoteJid.endsWith('@g.us')) continue;
                if (Number(msg.messageTimestamp) * 1000 < cutoff) continue;
                const jid = msg.key.remoteJid;
                if (!state.offlineMessages.has(jid)) state.offlineMessages.set(jid, []);
                state.offlineMessages.get(jid)!.push(msg);
            }

            // Schedula processOfflineMessages 15s dopo l'ultimo append
            if (state.syncTimer) clearTimeout(state.syncTimer);
            state.syncTimer = setTimeout(async () => {
                state.isResyncing = false;
                state.syncCount = 0;
                if (state.offlineMessages.size > 0) {
                    const count = [...state.offlineMessages.values()].reduce((n, msgs) => n + msgs.length, 0);
                    logger.info({ clubId: key, count }, 'Processing offline messages after append resync');
                    await processOfflineMessages(state.offlineMessages, key).catch(err =>
                        logger.error({ err, clubId: key }, 'processOfflineMessages failed')
                    );
                    state.offlineMessages.clear();
                }
            }, 15000);
            return;
        }

        if (m.type !== 'notify') return;

        // Messaggi `notify` = messaggi in tempo reale — processati sempre,
        // anche durante resync (non li blocchiamo più).
        for (const msg of m.messages) {
            if (!msg.key.fromMe && msg.message) {
                wahEvents.emit('message', msg, key === DEFAULT_CLUB_KEY ? undefined : key);
            }
        }
    });
}

// ─────────────────────────────────────────────
// OFFLINE MESSAGE RECOVERY
// ─────────────────────────────────────────────

async function processOfflineMessages(
    collected: Map<string, proto.IWebMessageInfo[]>,
    clubId: string
): Promise<void> {
    const { prisma } = await import('./db');
    const { enqueue } = await import('./inbound-queue');

    for (const [jid, messages] of collected) {
        const sorted = [...messages].sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp));

        let lastBotTs = 0;
        try {
            const lastBotMsg = await prisma.whatsAppMessage.findFirst({
                // Scope per club: con lo stesso numero utente su più club, il "last bot reply" di un altro
                // club falserebbe il filtro dei messaggi offline non risposti.
                where: { chatId: jid, role: 'BOT', clubId },
                orderBy: { timestamp: 'desc' },
            });
            if (lastBotMsg) lastBotTs = lastBotMsg.timestamp.getTime();
        } catch {}

        const unanswered = sorted.filter(m => Number(m.messageTimestamp) * 1000 > lastBotTs);
        if (unanswered.length === 0) continue;

        const { requiresResponse } = await import('./ai');
        const actionable: proto.IWebMessageInfo[] = [];
        for (const msg of unanswered) {
            const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
            const needed = await requiresResponse(text).catch(() => true);
            if (needed) {
                actionable.push(msg);
            } else {
                logger.info({ jid, text: text.slice(0, 60) }, 'Offline message skipped — no response needed');
            }
        }

        if (actionable.length === 0) continue;

        logger.info({ jid, count: actionable.length, clubId },
            'Re-enqueuing offline messages after resync');

        for (const msg of actionable) {
            enqueue(msg, clubId === DEFAULT_CLUB_KEY ? undefined : clubId);
        }
    }
}

// ─────────────────────────────────────────────
// INVIO RAW (interno, usa stato esplicito)
// ─────────────────────────────────────────────

async function _sendRaw(state: ClubSocketState, formattedJid: string, text: string): Promise<void> {
    if (!state.sock) throw new Error('WhatsApp socket not initialized');
    await state.sock.sendMessage(formattedJid, { text });
}

// ─────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────

/** Raw send senza simulazione (usato per messaggi di gruppo e admin) */
export async function sendMessage(jid: string, text: string): Promise<void> {
    if (process.env.DRY_RUN === 'true') {
        logger.info(`[DRY RUN] Would send raw message to ${jid}: ${text}`);
        return;
    }

    const clubId = currentClubId();
    const cs = await waitForSocket(clubId);

    const formattedJid = formatJid(jid);
    await cs.sock!.sendMessage(formattedJid, { text });

    try {
        const { prisma } = await import('./db');
        await prisma.whatsAppMessage.create({
            data: {
                chatId: formattedJid,
                sender: 'BOT',
                role: 'BOT',
                content: text,
                clubId: clubId || null,
            },
        });
    } catch (err) {
        logger.error({ err }, 'Failed to persist outgoing raw message');
    }
}

/**
 * HYPER-HUMAN SEND — per conversazioni 1-on-1.
 * Usa automaticamente il socket del club dal request-context.
 */
export async function humanSend(
    jid: string,
    text: string,
    incomingMsgKey?: proto.IMessageKey
): Promise<void> {
    if (process.env.DRY_RUN === 'true') {
        logger.info(`[DRY RUN] Would humanSend to ${jid}: ${text.slice(0, 80)}`);
        return;
    }
    const clubId = currentClubId();
    const cs = await waitForSocket(clubId);
    const sock = cs.sock!;
    const formattedJid = formatJid(jid);

    // Dedup: evita messaggi identici consecutivi
    try {
        const { prisma } = await import('./db');
        const lastMsg = await prisma.whatsAppMessage.findFirst({
            // Scope per club: evita falsi "duplicati" tra club diversi che parlano con lo stesso numero
            // (clubId undefined nel legacy single-tenant → Prisma ignora il filtro)
            where: { chatId: formattedJid, role: 'BOT', clubId },
            orderBy: { timestamp: 'desc' },
        });
        if (lastMsg && lastMsg.content.trim() === text.trim()) {
            logger.warn({ jid: formattedJid }, 'Duplicate message detected — adding variation');
            text = text + ' .';
        }
    } catch (err) {
        logger.error({ err }, 'Duplicate check failed');
    }

    // ── Read receipt ──────────────────────────────────────────────
    if (incomingMsgKey) {
        try {
            await sock.readMessages([incomingMsgKey]);
            await jitteredSleep(randomInt(1500, 3500), 400);
        } catch {}
    }

    // ── Pre-typing pause ──────────────────────────────────────────
    await jitteredSleep(randomInt(800, 2000), 300);

    // ── Typing speed ──────────────────────────────────────────────
    const charsPerSec = (Math.random() * 1.4) + 2.8;
    let totalTypingMs = (text.length / charsPerSec) * 1000;
    totalTypingMs = Math.max(2000, Math.min(12000, totalTypingMs));

    // ── Composing burst ───────────────────────────────────────────
    const hasMidPause = Math.random() < 0.3;

    if (hasMidPause) {
        const burst1Ms = totalTypingMs * randomInt(40, 60) / 100;
        const burst2Ms = totalTypingMs - burst1Ms;

        await sock.sendPresenceUpdate('composing', formattedJid);
        await jitteredSleep(burst1Ms, 200);
        await sock.sendPresenceUpdate('paused', formattedJid);
        await jitteredSleep(randomInt(600, 1800), 200);
        await sock.sendPresenceUpdate('composing', formattedJid);
        await jitteredSleep(burst2Ms, 200);
    } else {
        await sock.sendPresenceUpdate('composing', formattedJid);
        await jitteredSleep(totalTypingMs, 300);
    }

    await sock.sendPresenceUpdate('paused', formattedJid);
    await jitteredSleep(200, 100);

    // ── Message chunking ──────────────────────────────────────────
    const [part1, part2] = maybeSplitMessage(text);

    await sock.sendMessage(formattedJid, { text: part1 });
    logger.info({ jid, clubId }, `[HUMAN SEND] → "${part1}"`);

    try {
        const { prisma } = await import('./db');
        await prisma.whatsAppMessage.create({
            data: { chatId: formattedJid, sender: 'BOT', role: 'BOT', content: part1, clubId: clubId || null },
        });
    } catch (err) {
        logger.error({ err }, 'Failed to persist outgoing human message (part 1)');
    }

    if (part2) {
        await jitteredSleep(randomInt(1200, 3000), 400);
        await sock.sendPresenceUpdate('composing', formattedJid);
        await jitteredSleep(randomInt(1500, 3500), 300);
        await sock.sendPresenceUpdate('paused', formattedJid);
        await jitteredSleep(200, 100);
        await sock.sendMessage(formattedJid, { text: part2 });
        logger.info({ jid, clubId }, `[HUMAN SEND] → "${part2}" (chunk 2)`);

        try {
            const { prisma } = await import('./db');
            await prisma.whatsAppMessage.create({
                data: { chatId: formattedJid, sender: 'BOT', role: 'BOT', content: part2, clubId: clubId || null },
            });
        } catch (err) {
            logger.error({ err }, 'Failed to persist outgoing human message (part 2)');
        }
    }
}

export { humanSend as simulateTypingAndSend };

// ─────────────────────────────────────────────
// GROUP CREATION
// ─────────────────────────────────────────────

export async function createGroupAndAddPlayers(
    groupName: string,
    playerJids: string[],
    confirmationMessage: string
): Promise<string> {
    if (process.env.DRY_RUN === 'true') {
        logger.info(`[DRY RUN] Would create group "${groupName}"`);
        return 'dry-run-group-id';
    }

    const clubId = currentClubId();
    const cs = await waitForSocket(clubId);
    const sock = cs.sock!;

    const validJids = playerJids
        .map(formatJid)
        .filter(jid => jid.includes('@s.whatsapp.net') || jid.includes('@lid'));

    try {
        const group = await sock.groupCreate(groupName, validJids);
        logger.info({ groupId: group.id, clubId }, `Group created with ${validJids.length} participants`);

        await jitteredSleep(randomInt(3000, 6000), 500);
        await sock.sendPresenceUpdate('composing', group.id);
        await jitteredSleep(randomInt(2000, 4500), 300);
        await sock.sendPresenceUpdate('paused', group.id);
        await jitteredSleep(300, 100);
        await sock.sendMessage(group.id, { text: confirmationMessage });

        return group.id;
    } catch (error) {
        logger.error({ error, clubId }, 'Failed to create group');
        throw error;
    }
}

/**
 * Invia un messaggio finale nel gruppo, rimuove tutti i partecipanti e fa uscire il bot.
 * Azzera il gruppo WA dopo che una partita LOCKED si è riaperta per sostituzione.
 */
export async function dissolveGroup(groupJid: string, finalMessage: string, explicitClubId?: string): Promise<void> {
    if (process.env.DRY_RUN === 'true') {
        logger.info(`[DRY RUN] Would dissolve group ${groupJid}`);
        return;
    }

    const clubId = explicitClubId || currentClubId();
    const cs = await waitForSocket(clubId);
    const sock = cs.sock!;

    try {
        await sock.sendMessage(groupJid, { text: finalMessage });
        await jitteredSleep(1500, 300);

        const meta = await sock.groupMetadata(groupJid);
        const botJid = sock.user?.id;
        const others = meta.participants
            .map(p => p.id)
            .filter(id => id !== botJid);

        if (others.length > 0) {
            await sock.groupParticipantsUpdate(groupJid, others, 'remove');
            await jitteredSleep(1000, 200);
        }

        await sock.groupLeave(groupJid);
        logger.info({ groupJid, clubId }, 'Group dissolved after player cancel');
    } catch (err) {
        logger.warn({ err, groupJid, clubId }, 'dissolveGroup failed — group may still exist');
    }
}

// ─────────────────────────────────────────────
// EXPORTED GETTERS
// ─────────────────────────────────────────────

/** Restituisce il socket per il club dal context (o il primo disponibile) */
export function getSock(): ReturnType<typeof makeWASocket> | null {
    const cs = getSocketForClub(currentClubId());
    return cs?.sock ?? null;
}

/**
 * Stato connessione:
 * - con clubId: stato di quel club
 * - senza clubId: 'open' se almeno uno è connesso, altrimenti 'connecting'/'closed'
 */
export function getConnectionStatus(clubId?: string): 'open' | 'connecting' | 'closed' {
    if (clubId && clubSockets.has(clubId)) {
        return clubSockets.get(clubId)!.status;
    }
    for (const [, cs] of clubSockets) {
        if (cs.status === 'open') return 'open';
    }
    if (clubSockets.size > 0) return 'connecting';
    return 'closed';
}

/** Restituisce lo stato di tutti i club connessi (per health check) */
export function getAllClubStatuses(): Record<string, 'open' | 'connecting' | 'closed'> {
    const result: Record<string, 'open' | 'connecting' | 'closed'> = {};
    for (const [key, cs] of clubSockets) {
        result[key] = cs.status;
    }
    return result;
}

export { downloadMediaMessage };
