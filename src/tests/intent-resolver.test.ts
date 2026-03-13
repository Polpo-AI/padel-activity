/**
 * TEST: intent-resolver.ts
 *
 * Testa le funzioni sincrone (deterministiche) che non fanno chiamate AI o Redis.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─────────────────────────────────────────────
// Mock dipendenze esterne prima dell'import
// ─────────────────────────────────────────────

const mockRedis = {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue('OK'),
    del: vi.fn().mockResolvedValue(1),
};

vi.mock('../services/queue', () => ({
    getRedis: () => mockRedis,
    maintenanceQueue: { add: vi.fn() },
    matchQueue: { add: vi.fn() }
}));

vi.mock('../services/ai', () => ({
    anthropic: {
        messages: {
            create: vi.fn(),
        },
    },
}));

vi.mock('../services/whatsapp', () => ({
    simulateTypingAndSend: vi.fn().mockResolvedValue(undefined),
}));

import {
    handleUnclearIntent,
    setUnclearState,
    getUnclearState,
    clearUnclearState,
    type Intent,
} from '../services/intent-resolver';
import { getRedis } from '../services/queue';
import { simulateTypingAndSend } from '../services/whatsapp';

// ─────────────────────────────────────────────
// Redis state: set / get / clear
// ─────────────────────────────────────────────

describe('Unclear state (Redis)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('setUnclearState salva il payload su Redis', async () => {
        const redis = getRedis();
        await setUnclearState('jid@s.whatsapp.net', 1, 'contesto test', ['YES', 'NO']);
        expect(redis.set).toHaveBeenCalledWith(
            'state:unclear:jid@s.whatsapp.net',
            expect.stringContaining('"attempt":1'),
            'EX',
            expect.any(Number)
        );
    });

    it('getUnclearState ritorna null se Redis non ha la chiave', async () => {
        (getRedis().get as any).mockResolvedValue(null);
        const result = await getUnclearState('jid@s.whatsapp.net');
        expect(result).toBeNull();
    });

    it('getUnclearState deserializza correttamente il payload', async () => {
        const payload = JSON.stringify({ attempt: 2, context: 'test', availableIntents: ['YES', 'NO'] });
        (getRedis().get as any).mockResolvedValue(payload);
        const result = await getUnclearState('jid@s.whatsapp.net');
        expect(result).toEqual({ attempt: 2, context: 'test', availableIntents: ['YES', 'NO'] });
    });

    it('clearUnclearState chiama del su Redis', async () => {
        await clearUnclearState('jid@s.whatsapp.net');
        expect(getRedis().del).toHaveBeenCalledWith('state:unclear:jid@s.whatsapp.net');
    });
});

// ─────────────────────────────────────────────
// handleUnclearIntent — logica di retry/fallback
// ─────────────────────────────────────────────

describe('handleUnclearIntent', () => {
    const jid = 'test@s.whatsapp.net';
    const intents: Intent[] = ['YES', 'NO', 'CANCEL'];

    beforeEach(() => {
        vi.clearAllMocks();
        (getRedis().set as any).mockResolvedValue('OK');
        (getRedis().del as any).mockResolvedValue(1);
    });

    it('ritorna shouldRetry=true per i primi tentativi', async () => {
        const result = await handleUnclearIntent(jid, 'boh', 0, 'contesto', intents);
        expect(result.shouldRetry).toBe(true);
        expect(result.newAttempt).toBe(1);
    });

    it('invia un messaggio WhatsApp ad ogni tentativo', async () => {
        await handleUnclearIntent(jid, 'boh', 1, 'contesto', intents);
        expect(simulateTypingAndSend).toHaveBeenCalledTimes(1);
    });

    it('ritorna shouldRetry=false dopo MAX_ATTEMPTS (5)', async () => {
        const result = await handleUnclearIntent(jid, 'boh', 5, 'contesto', intents);
        expect(result.shouldRetry).toBe(false);
        expect(result.newAttempt).toBe(0);
    });

    it('al limite MAX_ATTEMPTS pulisce lo stato Redis', async () => {
        await handleUnclearIntent(jid, 'boh', 5, 'contesto', intents);
        expect(getRedis().del).toHaveBeenCalledWith(`state:unclear:${jid}`);
    });

    it('al tentativo 4 (CLOSED_QUESTION_AT) invia il menu numerato', async () => {
        await handleUnclearIntent(jid, 'boh', 3, 'contesto', intents);
        const sentMsg = (simulateTypingAndSend as any).mock.calls[0][1] as string;
        expect(sentMsg).toContain('1.');
        expect(sentMsg).toContain('2.');
    });
});
