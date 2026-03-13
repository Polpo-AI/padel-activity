/**
 * TEST: matchmaker.ts
 *
 * Testa findOpenMatchForPlayer con mock di Prisma.
 * processWave non viene testato qui (dipende da WhatsApp + AI attivi).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/db', () => ({
    prisma: {
        match: {
            findMany: vi.fn(),
        },
    },
}));

// matchmaker importa anche scoring, whatsapp, ai, queue — li mocchiamo tutti
vi.mock('../services/scoring', () => ({
    selectPlayersForWave: vi.fn(),
    computeNextWaveDelayMs: vi.fn(),
    getPlayersForRecovery: vi.fn(),
}));
vi.mock('../services/ai', () => ({ generateInvitation: vi.fn() }));
vi.mock('../services/whatsapp', () => ({ simulateTypingAndSend: vi.fn() }));
vi.mock('../services/queue', () => ({
    waveQueue: { add: vi.fn() },
    getRedis: vi.fn(),
}));
vi.mock('pino', () => ({
    default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { findOpenMatchForPlayer } from '../services/matchmaker';
import { prisma } from '../services/db';

// Helper per costruire un match fittizio
function makeMatch(overrides: Partial<{
    id: string;
    skillLevel: number;
    startTime: Date;
    playersNeeded: number;
    MatchPlayer: { leftAt: Date | null }[];
    court: { name: string } | null;
}> = {}) {
    return {
        id: 'match-1',
        skillLevel: 3,
        startTime: new Date(Date.now() + 3 * 60 * 60 * 1000), // tra 3h
        playersNeeded: 4,
        MatchPlayer: [],
        court: { name: 'Campo A' },
        ...overrides,
    };
}

describe('findOpenMatchForPlayer', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('ritorna null se non ci sono match disponibili', async () => {
        (prisma.match.findMany as any).mockResolvedValue([]);
        const result = await findOpenMatchForPlayer(3);
        expect(result).toBeNull();
    });

    it('ritorna i dati del match se c\'è un posto libero', async () => {
        const match = makeMatch({
            MatchPlayer: [{ leftAt: null }], // 1 su 4 occupato → 3 posti liberi
        });
        (prisma.match.findMany as any).mockResolvedValue([match]);

        const result = await findOpenMatchForPlayer(3);

        expect(result).not.toBeNull();
        expect(result!.id).toBe('match-1');
        expect(result!.spotsLeft).toBe(3);
        expect(result!.courtName).toBe('Campo A');
    });

    it('salta i match già pieni (spotsLeft = 0)', async () => {
        const fullMatch = makeMatch({
            MatchPlayer: [
                { leftAt: null },
                { leftAt: null },
                { leftAt: null },
                { leftAt: null },
            ], // 4 su 4 → pieno
        });
        (prisma.match.findMany as any).mockResolvedValue([fullMatch]);

        const result = await findOpenMatchForPlayer(3);
        expect(result).toBeNull();
    });

    it('i MatchPlayer con leftAt valorizzato non contano come occupati', async () => {
        const match = makeMatch({
            MatchPlayer: [
                { leftAt: new Date() }, // uscito — non conta
                { leftAt: new Date() }, // uscito — non conta
                { leftAt: null },       // attivo
            ],
        });
        (prisma.match.findMany as any).mockResolvedValue([match]);

        const result = await findOpenMatchForPlayer(3);
        expect(result!.spotsLeft).toBe(3); // 4 - 1 attivo
    });

    it('filtro preferredTime: scarta match fuori da ±2h', async () => {
        const farMatch = makeMatch({
            startTime: new Date(Date.now() + 6 * 60 * 60 * 1000), // tra 6h
        });
        (prisma.match.findMany as any).mockResolvedValue([farMatch]);

        const preferredTime = new Date(Date.now() + 1 * 60 * 60 * 1000); // tra 1h
        const result = await findOpenMatchForPlayer(3, preferredTime);
        expect(result).toBeNull(); // diff 5h > 2h → escluso
    });

    it('filtro preferredTime: accetta match entro ±2h', async () => {
        const nearMatch = makeMatch({
            startTime: new Date(Date.now() + 2 * 60 * 60 * 1000), // tra 2h
        });
        (prisma.match.findMany as any).mockResolvedValue([nearMatch]);

        const preferredTime = new Date(Date.now() + 1 * 60 * 60 * 1000); // tra 1h
        const result = await findOpenMatchForPlayer(3, preferredTime);
        expect(result).not.toBeNull(); // diff 1h ≤ 2h → incluso
    });

    it('usa "Campo" come fallback se court è null', async () => {
        const match = makeMatch({ court: null });
        (prisma.match.findMany as any).mockResolvedValue([match]);

        const result = await findOpenMatchForPlayer(3);
        expect(result!.courtName).toBe('Campo');
    });
});
