/**
 * INTEGRATION TESTS — Percorso critico del bot
 *
 * Copre i componenti trasversali aggiunti nelle criticità 1-5:
 *
 *  1. Circuit Breaker (AI) — macchina a stati CLOSED/OPEN/HALF_OPEN
 *  2. Conversation State — dual-write Redis + PostgreSQL con fallback
 *  3. Correlation ID — propagazione AsyncLocalStorage through async chain
 *  4. Wave Lock — mutua esclusione distribuita via Redis NX
 *
 * L'infrastruttura reale (WhatsApp, AI, DB) viene mockata.
 * Redis viene simulato in-memory per testare il comportamento NX.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────────────────────────
// SEZIONE 1 — Circuit Breaker
// ─────────────────────────────────────────────

import { CircuitBreaker } from '../utils/circuit-breaker';

describe('CircuitBreaker', () => {
    let cb: CircuitBreaker;

    beforeEach(() => {
        // threshold=3, cooldown=100ms per test veloci
        cb = new CircuitBreaker('test', 3, 100);
    });

    it('esegue fn normalmente in stato CLOSED', async () => {
        const result = await cb.call(() => Promise.resolve(42), () => -1);
        expect(result).toBe(42);
    });

    it('usa il fallback invece di propagare errore in stato CLOSED', async () => {
        const result = await cb.call(
            () => Promise.reject(new Error('boom')),
            () => -1
        );
        expect(result).toBe(-1);
    });

    it('transizione CLOSED → OPEN dopo threshold fallimenti consecutivi', async () => {
        const fail = () => Promise.reject(new Error('fail'));
        const fb = () => 0;

        for (let i = 0; i < 3; i++) {
            await cb.call(fail, fb);
        }

        // Ora è OPEN: anche una fn di successo viene cortocircuitata
        const wasCalled = vi.fn().mockResolvedValue(999);
        const result = await cb.call(wasCalled, () => -99);

        expect(result).toBe(-99);
        expect(wasCalled).not.toHaveBeenCalled();
    });

    it('un successo in CLOSED azzera il contatore fallimenti', async () => {
        await cb.call(() => Promise.reject(new Error('x')), () => 0);
        await cb.call(() => Promise.reject(new Error('x')), () => 0);
        // Successo → reset
        await cb.call(() => Promise.resolve('ok'), () => '');
        // Un altro fallimento non apre il circuit (counter resettato)
        await cb.call(() => Promise.reject(new Error('x')), () => 0);

        const wasCalled = vi.fn().mockResolvedValue(1);
        const result = await cb.call(wasCalled, () => -1);
        // Il counter è a 1 (< 3) → ancora CLOSED → fn viene eseguita
        expect(wasCalled).toHaveBeenCalled();
        expect(result).toBe(1);
    });

    it('OPEN → HALF_OPEN → CLOSED dopo cooldown + successo', async () => {
        // Porta a OPEN
        const fail = () => Promise.reject(new Error('x'));
        for (let i = 0; i < 3; i++) await cb.call(fail, () => 0);

        // Aspetta cooldown (100ms)
        await new Promise(r => setTimeout(r, 120));

        // Ora è HALF_OPEN: la prossima chiamata viene eseguita
        const result = await cb.call(() => Promise.resolve('recovered'), () => 'fallback');
        expect(result).toBe('recovered');

        // Verifico che sia tornato CLOSED: fn successiva eseguita normalmente
        const next = vi.fn().mockResolvedValue('ok2');
        await cb.call(next, () => '');
        expect(next).toHaveBeenCalled();
    });

    it('HALF_OPEN → OPEN se il test-call fallisce', async () => {
        // Porta a OPEN
        for (let i = 0; i < 3; i++) {
            await cb.call(() => Promise.reject(new Error('x')), () => 0);
        }
        // Aspetta cooldown
        await new Promise(r => setTimeout(r, 120));

        // HALF_OPEN: test-call fallisce → torna OPEN
        await cb.call(() => Promise.reject(new Error('still broken')), () => 0);

        // Deve essere di nuovo OPEN
        const wasCalled = vi.fn().mockResolvedValue(1);
        const r = await cb.call(wasCalled, () => -1);
        expect(r).toBe(-1);
        expect(wasCalled).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────
// SEZIONE 2 — Conversation State (dual-write)
// ─────────────────────────────────────────────

// vi.hoisted() garantisce che queste variabili siano inizializzate PRIMA
// che i factory di vi.mock() vengano eseguiti (i mock sono hoistati in cima al file).
const { redisStore, redisMock, dbMock } = vi.hoisted(() => {
    const redisStore: Record<string, string> = {};
    const redisMock = {
        get: vi.fn(async (k: string) => redisStore[k] ?? null),
        set: vi.fn(async (k: string, v: string, ..._args: unknown[]) => { redisStore[k] = v; return 'OK'; }),
        del: vi.fn(async (k: string) => { delete redisStore[k]; return 1; }),
    };
    const dbMock = {
        conversationState: {
            upsert: vi.fn().mockResolvedValue({}),
            findFirst: vi.fn().mockResolvedValue(null),
            deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        },
    };
    return { redisStore, redisMock, dbMock };
});

vi.mock('../services/queue', () => ({
    getRedis: () => redisMock,
    waveQueue: { add: vi.fn() },
    maintenanceQueue: { add: vi.fn() },
    reminderQueue: { add: vi.fn() },
    matchQueue: { add: vi.fn() },
}));

vi.mock('../services/db', () => ({
    prisma: dbMock,
}));

vi.mock('pino', () => ({
    default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { setState, getState, clearState } from '../services/conversation-state';

describe('ConversationState — dual-write Redis + PostgreSQL', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        Object.keys(redisStore).forEach(k => delete redisStore[k]);
    });

    it('setState scrive prima su Redis poi su DB', async () => {
        await setState('key:test', { foo: 'bar' }, 300);

        expect(redisMock.set).toHaveBeenCalledWith('key:test', JSON.stringify({ foo: 'bar' }), 'EX', 300);
        expect(dbMock.conversationState.upsert).toHaveBeenCalledOnce();
    });

    it('getState ritorna il valore da Redis (cache hit)', async () => {
        redisStore['key:cached'] = JSON.stringify({ value: 42 });

        const result = await getState('key:cached');

        expect(result).toEqual({ value: 42 });
        expect(dbMock.conversationState.findFirst).not.toHaveBeenCalled();
    });

    it('getState cade su DB se Redis miss', async () => {
        // Redis miss (store vuoto)
        const expiresAt = new Date(Date.now() + 60_000);
        dbMock.conversationState.findFirst.mockResolvedValueOnce({
            key: 'key:miss',
            value: { fromDb: true },
            expiresAt,
        });

        const result = await getState('key:miss');

        expect(result).toEqual({ fromDb: true });
        expect(dbMock.conversationState.findFirst).toHaveBeenCalledOnce();
    });

    it('getState ripristina in Redis dopo un DB-fallback', async () => {
        const expiresAt = new Date(Date.now() + 60_000);
        dbMock.conversationState.findFirst.mockResolvedValueOnce({
            key: 'key:restore',
            value: { restored: true },
            expiresAt,
        });

        await getState('key:restore');

        // Deve essere stato riscritto in Redis con PX (ms rimanenti)
        expect(redisMock.set).toHaveBeenCalledWith(
            'key:restore',
            JSON.stringify({ restored: true }),
            'PX',
            expect.any(Number)
        );
    });

    it('getState ritorna null se Redis miss E DB non ha il record', async () => {
        dbMock.conversationState.findFirst.mockResolvedValueOnce(null);
        const result = await getState('key:nonexistent');
        expect(result).toBeNull();
    });

    it('clearState cancella da Redis E da DB', async () => {
        redisStore['key:clear'] = '{"x":1}';

        await clearState('key:clear');

        expect(redisMock.del).toHaveBeenCalledWith('key:clear');
        expect(dbMock.conversationState.deleteMany).toHaveBeenCalledWith({ where: { key: 'key:clear' } });
        expect(redisStore['key:clear']).toBeUndefined();
    });

    it('setState non propaga errore DB (best-effort)', async () => {
        dbMock.conversationState.upsert.mockRejectedValueOnce(new Error('DB down'));

        await expect(setState('key:safe', { data: 1 }, 60)).resolves.not.toThrow();
        // Redis deve comunque avere i dati
        expect(redisStore['key:safe']).toBe(JSON.stringify({ data: 1 }));
    });

    it('getState non propaga errore DB (best-effort)', async () => {
        dbMock.conversationState.findFirst.mockRejectedValueOnce(new Error('DB timeout'));

        const result = await getState('key:dbfail');
        expect(result).toBeNull();
    });
});

// ─────────────────────────────────────────────
// SEZIONE 3 — Correlation ID (AsyncLocalStorage)
// ─────────────────────────────────────────────

import { runWithContext, getCorrelationId } from '../utils/request-context';

describe('Correlation ID — AsyncLocalStorage', () => {
    it('getCorrelationId ritorna undefined fuori dal contesto', () => {
        expect(getCorrelationId()).toBeUndefined();
    });

    it('getCorrelationId ritorna il valore iniettato in runWithContext', async () => {
        let capturedId: string | undefined;

        await runWithContext({ correlationId: 'test-abc-123', jid: 'player@s.whatsapp.net' }, async () => {
            capturedId = getCorrelationId();
        });

        expect(capturedId).toBe('test-abc-123');
    });

    it('contesti annidati non si inquinano tra loro', async () => {
        const results: (string | undefined)[] = [];

        await Promise.all([
            runWithContext({ correlationId: 'ctx-1', jid: 'a@s' }, async () => {
                await new Promise(r => setTimeout(r, 10));
                results.push(getCorrelationId());
            }),
            runWithContext({ correlationId: 'ctx-2', jid: 'b@s' }, async () => {
                await new Promise(r => setTimeout(r, 5));
                results.push(getCorrelationId());
            }),
        ]);

        expect(results).toContain('ctx-1');
        expect(results).toContain('ctx-2');
    });

    it('il contesto non "filtra" fuori dalla callback', async () => {
        await runWithContext({ correlationId: 'inner', jid: 'x@s' }, async () => {
            // noop
        });
        // Fuori dal contesto, deve essere undefined di nuovo
        expect(getCorrelationId()).toBeUndefined();
    });
});

// ─────────────────────────────────────────────
// SEZIONE 4 — Wave Lock (mutua esclusione Redis NX)
// ─────────────────────────────────────────────

/**
 * Simula il comportamento di Redis SET NX in-memory.
 * Testa la logica del lock SENZA chiamare matchmaker (che dipende da WA + AI).
 */

const lockStore: Record<string, string> = {};

const redisMockNX = {
    set: vi.fn(async (key: string, value: string, mode: string, ttl: number, nx: string) => {
        if (nx === 'NX' && lockStore[key] !== undefined) return null; // già occupato
        lockStore[key] = value;
        return 'OK';
    }),
    get: vi.fn(async (key: string) => lockStore[key] ?? null),
    del: vi.fn(async (key: string) => { delete lockStore[key]; return 1; }),
};

async function withMatchLockTest<T>(
    matchId: string,
    fn: () => Promise<T>,
    redis: typeof redisMockNX
): Promise<T | null> {
    const lockKey = `wave_lock:${matchId}`;
    const lockToken = `token-${Math.random()}`;
    const acquired = await redis.set(lockKey, lockToken, 'PX', 15_000, 'NX');
    if (!acquired) return null;
    try {
        return await fn();
    } finally {
        const current = await redis.get(lockKey);
        if (current === lockToken) await redis.del(lockKey);
    }
}

describe('Wave Lock — mutua esclusione', () => {
    beforeEach(() => {
        Object.keys(lockStore).forEach(k => delete lockStore[k]);
        vi.clearAllMocks();
    });

    it('il primo ad acquisire il lock esegue la fn', async () => {
        const fn = vi.fn().mockResolvedValue('done');
        const result = await withMatchLockTest('match-1', fn, redisMockNX);
        expect(result).toBe('done');
        expect(fn).toHaveBeenCalledOnce();
    });

    it('il secondo tentativo sullo stesso matchId viene rifiutato', async () => {
        // Prima chiamata: acquista il lock e "rimane appesa"
        let firstRelease: () => void;
        const firstFn = () => new Promise<string>((resolve) => { firstRelease = () => resolve('first'); });

        const firstPromise = withMatchLockTest('match-2', firstFn, redisMockNX);

        // Seconda chiamata mentre il lock è tenuto
        const secondFn = vi.fn().mockResolvedValue('second');
        const secondResult = await withMatchLockTest('match-2', secondFn, redisMockNX);

        expect(secondResult).toBeNull();
        expect(secondFn).not.toHaveBeenCalled();

        // Rilascia il lock
        firstRelease!();
        await firstPromise;
    });

    it('dopo il rilascio, il lock può essere riacquisito', async () => {
        const fn1 = vi.fn().mockResolvedValue('first');
        await withMatchLockTest('match-3', fn1, redisMockNX);

        const fn2 = vi.fn().mockResolvedValue('second');
        const result = await withMatchLockTest('match-3', fn2, redisMockNX);

        expect(result).toBe('second');
        expect(fn2).toHaveBeenCalledOnce();
    });

    it('lock diversi su matchId diversi non si bloccano', async () => {
        const fn1 = vi.fn().mockResolvedValue('a');
        const fn2 = vi.fn().mockResolvedValue('b');

        const [r1, r2] = await Promise.all([
            withMatchLockTest('match-a', fn1, redisMockNX),
            withMatchLockTest('match-b', fn2, redisMockNX),
        ]);

        expect(r1).toBe('a');
        expect(r2).toBe('b');
    });

    it('il lock viene rilasciato anche se fn lancia un errore', async () => {
        const failFn = () => Promise.reject(new Error('fn crashed'));
        await expect(withMatchLockTest('match-err', failFn, redisMockNX)).rejects.toThrow('fn crashed');

        // Il lock deve essere stato rilasciato
        expect(lockStore['wave_lock:match-err']).toBeUndefined();

        // Ora un altro tentativo deve poter acquisire
        const fn2 = vi.fn().mockResolvedValue('recovered');
        const r = await withMatchLockTest('match-err', fn2, redisMockNX);
        expect(r).toBe('recovered');
    });
});
