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
// Reliability v2 — computeWindowedReliability
// Finestra sugli ultimi RELIAB_WINDOW inviti con outcome osservabile,
// smoothing bayesiano: (somma + PRIOR*3) / (validi + 3)
// ─────────────────────────────────────────────

vi.mock('../services/db', () => ({
    prisma: {
        player: {
            findUnique: vi.fn(),
            update: vi.fn(),
        },
        invitation: {
            findMany: vi.fn(),
            count: vi.fn(),
        },
        matchPlayer: {
            findMany: vi.fn(),
        },
    },
}));

import { prisma } from '../services/db';
import { computeWindowedReliability, RELIAB_WINDOW } from '../services/scoring';

const SMOOTH = 3; // RELIAB_PRIOR_SMOOTH in scoring.ts

const matchAt = (iso: string) => ({ startTime: new Date(iso) });
const inv = (outcome: string | null, status = 'ACCEPTED', matchIso = '2026-06-01T18:00:00Z', respondedAt: Date | null = new Date()) =>
    ({ status, respondedAt, outcome, sentAt: new Date(), match: matchAt(matchIso) });

describe('computeWindowedReliability — finestra outcome v2', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        (prisma.matchPlayer.findMany as any).mockResolvedValue([]); // nessuna partita vicina di default
    });

    it('nessun invito → PRIOR', async () => {
        (prisma.invitation.findMany as any).mockResolvedValue([]);
        expect(await computeWindowedReliability('p1')).toBeCloseTo(PRIOR, 5);
    });

    it('solo ACCEPTED → score alto ma temperato dallo smoothing', async () => {
        (prisma.invitation.findMany as any).mockResolvedValue([inv('ACCEPTED'), inv('ACCEPTED')]);
        // (1+1 + 0.33*3) / (2+3)
        expect(await computeWindowedReliability('p2')).toBeCloseTo((2 + PRIOR * SMOOTH) / (2 + SMOOTH), 5);
    });

    it('GHOST senza partite vicine → conta 0', async () => {
        (prisma.invitation.findMany as any).mockResolvedValue([inv('GHOST')]);
        expect(await computeWindowedReliability('p3')).toBeCloseTo((0 + PRIOR * SMOOTH) / (1 + SMOOTH), 5);
    });

    it('GHOST con partita confermata entro 7 giorni → scontato a 0.5', async () => {
        (prisma.invitation.findMany as any).mockResolvedValue([inv('GHOST', 'EXPIRED', '2026-06-01T18:00:00Z')]);
        (prisma.matchPlayer.findMany as any).mockResolvedValue([{ match: matchAt('2026-06-03T18:00:00Z') }]);
        expect(await computeWindowedReliability('p4')).toBeCloseTo((0.5 + PRIOR * SMOOTH) / (1 + SMOOTH), 5);
    });

    it('CANCELLED_AFTER_ACCEPT e NO_SHOW → contano 0 anche con partita vicina', async () => {
        (prisma.invitation.findMany as any).mockResolvedValue([inv('CANCELLED_AFTER_ACCEPT'), inv('NO_SHOW')]);
        (prisma.matchPlayer.findMany as any).mockResolvedValue([{ match: matchAt('2026-06-01T18:00:00Z') }]);
        expect(await computeWindowedReliability('p5')).toBeCloseTo((0 + PRIOR * SMOOTH) / (2 + SMOOTH), 5);
    });

    it('WILLING_FULL e MATCH_CANCELLED → esclusi dalla finestra (score resta PRIOR)', async () => {
        (prisma.invitation.findMany as any).mockResolvedValue([inv('WILLING_FULL'), inv('MATCH_CANCELLED')]);
        expect(await computeWindowedReliability('p6')).toBeCloseTo(PRIOR, 5);
    });

    it('invito storico senza outcome: inferenza da status (REJECTED → DECLINED → 0)', async () => {
        (prisma.invitation.findMany as any).mockResolvedValue([inv(null, 'REJECTED')]);
        expect(await computeWindowedReliability('p7')).toBeCloseTo((0 + PRIOR * SMOOTH) / (1 + SMOOTH), 5);
    });

    it('finestra mobile: considera solo gli ultimi RELIAB_WINDOW inviti validi', async () => {
        // 25 ACCEPTED recenti + 5 GHOST più vecchi: i GHOST cadono fuori finestra
        const invitations = [
            ...Array.from({ length: 25 }, () => inv('ACCEPTED')),
            ...Array.from({ length: 5 }, () => inv('GHOST')),
        ];
        (prisma.invitation.findMany as any).mockResolvedValue(invitations);
        const expected = (RELIAB_WINDOW * 1 + PRIOR * SMOOTH) / (RELIAB_WINDOW + SMOOTH);
        expect(await computeWindowedReliability('p8')).toBeCloseTo(expected, 5);
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
