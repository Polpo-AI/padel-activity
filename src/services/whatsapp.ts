/**
 * WhatsApp Service - Hyper-Human Simulation Edition
 *
 * This service wraps Baileys to make every interaction indistinguishable
 * from a real person using WhatsApp on their phone.
 *
 * Human Simulation Layers implemented:
 * 1. READ RECEIPT: Before replying, we mark the incoming message as "read" (blue ticks).
 * 2. READ DELAY: A natural pause after reading, before starting to type (1.5 - 3.5s).
 * 3. COMPOSING BURST: We don't just type once. We start, pause, then start again —
 *    just like a human who writes, deletes, and rewrites.
 * 4. PROPORTIONAL TYPING TIME: Composing duration scales with message length.
 * 5. MESSAGE CHUNKING: Long messages are optionally split and sent as 2 separate
 *    "bubbles" with a brief pause between them (like a human afterthought).
 * 6. RANDOM MICRO-PAUSES: Small jitter added to every sleep to avoid any clock regularity.
 */

import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    delay,
    proto,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import * as qrcode from 'qrcode-terminal';
import { handleIncomingMessage } from './messageHandler';

const logger = pino({ level: 'info' });

let sock: ReturnType<typeof makeWASocket> | null = null;

// ------------------------------------------------------------------
// UTILITY HELPERS
// ------------------------------------------------------------------

/** Inclusive random integer */
const randomInt = (min: number, max: number) =>
    Math.floor(Math.random() * (max - min + 1)) + min;

/** Sleep with optional jitter (±jitterMs) so timing is never perfectly regular */
const jitteredSleep = (ms: number, jitterMs = 500) => {
    const jitter = randomInt(-jitterMs, jitterMs);
    const total = Math.max(200, ms + jitter);
    return delay(total);
};

const formatJid = (jid: string) =>
    jid.includes('@s.whatsapp.net') ? jid : `${jid.replace(/\D/g, '')}@s.whatsapp.net`;

/**
 * Splits a long text at a sentence boundary into two parts.
 * Returns [part1, part2] or [full, null] if not worth splitting.
 */
function maybeSplitMessage(text: string): [string, string | null] {
    // Only split if longer than 80 chars and there's a punctuation mid-point
    if (text.length < 80) return [text, null];

    const splitChars = ['. ', '! ', '? ', ', '];
    const mid = Math.floor(text.length * 0.55);

    for (const ch of splitChars) {
        const idx = text.indexOf(ch, mid - 20);
        if (idx > 0 && idx < text.length - 10) {
            return [text.slice(0, idx + ch.length - 1).trim(), text.slice(idx + ch.length - 1).trim()];
        }
    }

    return [text, null];
}

// ------------------------------------------------------------------
// CONNECTION
// ------------------------------------------------------------------

export async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');

    sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        logger: pino({ level: 'silent' }) as any,
        // Emulate browser fingerprint of a real Chrome on macOS
        browser: ['Chrome (Mac)', 'Chrome', '120.0.6099.199'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            logger.info('📱 Scan this QR Code to authenticate WhatsApp:');
            qrcode.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const shouldReconnect =
                (lastDisconnect?.error as any)?.output?.statusCode !== DisconnectReason.loggedOut;
            logger.error(`WhatsApp connection closed. Reconnecting: ${shouldReconnect}`);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === 'open') {
            logger.info('✅ WhatsApp Connected Successfully!');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type !== 'notify') return;
        for (const msg of m.messages) {
            if (!msg.key.fromMe && msg.message) {
                await handleIncomingMessage(msg);
            }
        }
    });
}

// ------------------------------------------------------------------
// CORE SENDING LOGIC
// ------------------------------------------------------------------

/** Raw send with no simulation (used for group messages) */
export async function sendMessage(jid: string, text: string) {
    if (!sock) throw new Error('WhatsApp socket not initialized');
    await sock.sendMessage(formatJid(jid), { text });
}

/**
 * HYPER-HUMAN SEND — for 1-on-1 conversations.
 *
 * The full chain:
 * 1. Mark the incoming message as READ (blue ticks) if provided
 * 2. Short "reading" pause (simulates human looking at screen)
 * 3. Start composing (burst 1)
 * 4. Optional mid-typing pause (simulates human re-thinking)
 * 5. Resume composing (burst 2)
 * 6. Stop composing briefly
 * 7. If message is splittable → send part 1, organic pause, send part 2
 *    Otherwise → send full message
 */
export async function humanSend(
    jid: string,
    text: string,
    incomingMsgKey?: proto.IMessageKey
): Promise<void> {
    if (!sock) throw new Error('WhatsApp socket not initialized');
    const formattedJid = formatJid(jid);

    // ── LAYER 1: Read receipt (blue ticks) ──────────────────────────
    if (incomingMsgKey) {
        try {
            await sock.readMessages([incomingMsgKey]);
            logger.info(`[HUMAN] Marked message from ${jid} as read`);
            // Small pause after "reading" — human takes a second to process
            await jitteredSleep(randomInt(1500, 3500), 400);
        } catch {
            // Non-critical — continue even if read-receipt fails
        }
    }

    // ── LAYER 2: Pre-typing "thinking" pause ───────────────────────
    // Already done in messageHandler (5-25s reaction delay), but if we're
    // triggered directly (like from wave.worker), add a short one here.
    await jitteredSleep(randomInt(800, 2000), 300);

    // ── LAYER 3: Calculate realistic typing speed ───────────────────
    // Average human: ~200 WPM → ~3.3 chars/sec
    // We add variance: slow typer = 2.8 chars/s, fast = 4.2 chars/s
    const charsPerSec = (Math.random() * 1.4) + 2.8; // 2.8 to 4.2
    let totalTypingMs = (text.length / charsPerSec) * 1000;
    totalTypingMs = Math.max(2000, Math.min(12000, totalTypingMs));

    // ── LAYER 4: Composing burst with mid-pause ─────────────────────
    // 70% chance: type continuously
    // 30% chance: type, pause briefly (as if re-reading what was written), then resume
    const hasMidPause = Math.random() < 0.3;

    if (hasMidPause) {
        const burst1Ms = totalTypingMs * randomInt(40, 60) / 100;
        const burst2Ms = totalTypingMs - burst1Ms;

        await sock.sendPresenceUpdate('composing', formattedJid);
        await jitteredSleep(burst1Ms, 200);

        await sock.sendPresenceUpdate('paused', formattedJid);
        await jitteredSleep(randomInt(600, 1800), 200); // Re-thinking pause

        await sock.sendPresenceUpdate('composing', formattedJid);
        await jitteredSleep(burst2Ms, 200);
    } else {
        await sock.sendPresenceUpdate('composing', formattedJid);
        await jitteredSleep(totalTypingMs, 300);
    }

    await sock.sendPresenceUpdate('paused', formattedJid);
    await jitteredSleep(200, 100); // Brief pause before sending

    // ── LAYER 5: Message chunking ───────────────────────────────────
    // Split long messages into two separate bubbles (like human after-thoughts)
    const [part1, part2] = maybeSplitMessage(text);

    await sock.sendMessage(formattedJid, { text: part1 });
    logger.info(`[HUMAN SEND] → ${jid}: "${part1}"`);

    if (part2) {
        // Brief "afterthought" delay before second bubble
        await jitteredSleep(randomInt(1200, 3000), 400);
        await sock.sendPresenceUpdate('composing', formattedJid);
        await jitteredSleep(randomInt(1500, 3500), 300);
        await sock.sendPresenceUpdate('paused', formattedJid);
        await jitteredSleep(200, 100);
        await sock.sendMessage(formattedJid, { text: part2 });
        logger.info(`[HUMAN SEND] → ${jid}: "${part2}" (chunk 2)`);
    }
}

// Keep the old name as an alias so we don't break wave.worker imports
export { humanSend as simulateTypingAndSend };

// ------------------------------------------------------------------
// GROUP CREATION
// ------------------------------------------------------------------

export async function createGroupAndAddPlayers(
    groupName: string,
    playerJids: string[],
    confirmationMessage: string
): Promise<string> {
    if (!sock) throw new Error('WhatsApp socket not initialized');
    try {
        const group = await sock.groupCreate(groupName, playerJids.map(formatJid));
        logger.info(`Group ${group.id} created successfully.`);

        // Organic delay before typing the first group message
        await jitteredSleep(randomInt(3000, 6000), 500);
        await sock.sendPresenceUpdate('composing', group.id);
        await jitteredSleep(randomInt(2000, 4500), 300);
        await sock.sendPresenceUpdate('paused', group.id);
        await jitteredSleep(300, 100);
        await sock.sendMessage(group.id, { text: confirmationMessage });

        return group.id;
    } catch (error) {
        logger.error({ error }, 'Failed to create group');
        throw error;
    }
}

export function getSock() {
    return sock;
}
