/**
 * TEST: scoring.ts
 *
 * Testa le funzioni pure che non richiedono DB o Redis.
 * Le funzioni che usano Prisma vengono testate con mock di vi.mock().
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeNextWaveDelayMs, PRIOR } from '../services/scoring';

// ─────────────────────────────────────────────
// computeNextWaveDelayMs — funzione pura, zero dipendenze
// ─────────────────────────────────────────────

describe('computeNextWaveDelayMs', () => {
    it('restituisce 3h se mancano più di 24h', () => {
        expect(computeNextWaveDelayMs(2000)).toBe(3 * 60 * 60 * 1000);
    });

    it('restituisce 90min se mancano tra 6h e 24h', () => {
        expect(computeNextWaveDelayMs(500)).toBe(90 * 60 * 1000);
        expect(computeNextWaveDelayMs(361)).toBe(90 * 60 * 1000);
    });

    it('restituisce 25min se mancano tra 2h e 6h', () => {
        expect(computeNextWaveDelayMs(200)).toBe(25 * 60 * 1000);
        expect(computeNextWaveDelayMs(121)).toBe(25 * 60 * 1000);
    });

    it('restituisce 10min se mancano tra 1h e 2h', () => {
        expect(computeNextWaveDelayMs(90)).toBe(10 * 60 * 1000);
        expect(computeNextWaveDelayMs(61)).toBe(10 * 60 * 1000);
    });

    it('restituisce null se manca meno di 1h', () => {
        expect(computeNextWaveDelayMs(59)).toBeNull();
        expect(computeNextWaveDelayMs(0)).toBeNull();
    });

    it('caso limite: esattamente 60 minuti → null', () => {
        expect(computeNextWaveDelayMs(60)).toBeNull();
    });

    it('caso limite: esattamente 1441 minuti → 3h', () => {
        expect(computeNextWaveDelayMs(1441)).toBe(3 * 60 * 60 * 1000);
    });
});

// ─────────────────────────────────────────────
// Formula EMA updateShowUpRate — logica matematica
// Testiamo isolando Prisma con un mock
// ─────────────────────────────────────────────

vi.mock('../services/db', () => ({
    prisma: {
        player: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        invitation: {
            count: vi.fn(),
        },
    },
}));

import { prisma } from '../services/db';
import { updateShowUpRate, increaseReliability, decreaseReliability } from '../services/scoring';

const ALPHA = 0.15;

describe('updateShowUpRate — formula EMA', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (prisma.player.update as any).mockResolvedValue({});
    });

    it('giocatore legacy (score=0 nel DB): usa PRIOR come base', async () => {
        (prisma.player.findUnique as any).mockResolvedValue({ id: 'p1', reliabilityScore: 0 });

        await updateShowUpRate('p1', true, 360);

        const expectedRate = Math.min(1.0, (1 - ALPHA) * PRIOR + ALPHA * 1.0);
        expect(prisma.player.update).toHaveBeenCalledWith({
            where: { id: 'p1' },
            data: { reliabilityScore: expect.closeTo(expectedRate, 5) },
        });
    });

    it('giocatore esistente (score=0.8) che si presenta → score aumenta', async () => {
        (prisma.player.findUnique as any).mockResolvedValue({ id: 'p2', reliabilityScore: 0.8 });

        await updateShowUpRate('p2', true, 360);

        const expected = Math.min(1.0, (1 - ALPHA) * 0.8 + ALPHA * 1.0);
        expect(prisma.player.update).toHaveBeenCalledWith({
            where: { id: 'p2' },
            data: { reliabilityScore: expect.closeTo(expected, 5) },
        });
    });

    it('giocatore che non si presenta → score scende', async () => {
        (prisma.player.findUnique as any).mockResolvedValue({ id: 'p3', reliabilityScore: 0.5 });

        await updateShowUpRate('p3', false, 360);

        const expected = (1 - ALPHA) * 0.5 + ALPHA * 0.0;
        expect(prisma.player.update).toHaveBeenCalledWith({
            where: { id: 'p3' },
            data: { reliabilityScore: expect.closeTo(expected, 5) },
        });
    });

    it('bonus last-minute: presentarsi con < 2h di preavviso non supera 1.0', async () => {
        (prisma.player.findUnique as any).mockResolvedValue({ id: 'p4', reliabilityScore: 0.95 });

        await updateShowUpRate('p4', true, 60); // 60 min < 120 → last-minute

        // Con bonus: eventValue = min(1.0, 1.0 * 1.3) = 1.0
        // Risultato non può superare 1.0
        const call = (prisma.player.update as any).mock.calls[0][0];
        expect(call.data.reliabilityScore).toBeLessThanOrEqual(1.0);
    });

    it('increaseReliability è un alias di updateShowUpRate(showed=true, 360min)', async () => {
        (prisma.player.findUnique as any).mockResolvedValue({ id: 'p5', reliabilityScore: 0.5 });
        await increaseReliability('p5');
        expect(prisma.player.findUnique).toHaveBeenCalledWith({ where: { id: 'p5' } });
    });

    it('decreaseReliability è un alias di updateShowUpRate(showed=false)', async () => {
        (prisma.player.findUnique as any).mockResolvedValue({ id: 'p6', reliabilityScore: 0.5 });
        await decreaseReliability('p6');
        const call = (prisma.player.update as any).mock.calls[0][0];
        // showed=false → score deve scendere
        expect(call.data.reliabilityScore).toBeLessThan(0.5);
    });

    it('giocatore non trovato → nessun aggiornamento', async () => {
        (prisma.player.findUnique as any).mockResolvedValue(null);
        await updateShowUpRate('ghost', true, 360);
        expect(prisma.player.update).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────
// PRIOR
// ─────────────────────────────────────────────

describe('PRIOR', () => {
    it('è 0.33 (punteggio base per giocatori nuovi)', () => {
        expect(PRIOR).toBe(0.33);
    });
});
