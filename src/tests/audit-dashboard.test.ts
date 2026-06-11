/**
 * TEST AUDIT 11/06/2026 — dashboard.api.ts PATCH /matches/:id
 *
 * L2/L3: il check di conflitto campo è su OVERLAP di durata (non orario esatto)
 * e scatta anche quando cambia solo il campo. Si invoca l'handler della rotta
 * direttamente (bypass authMiddleware) con req/res finti.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => {
    process.env.JWT_SECRET = 'test-secret-for-audit-tests';
    return {
        prisma: {
            match: { findFirst: vi.fn(), findMany: vi.fn(async () => [] as any[]), update: vi.fn(async () => ({})), findUnique: vi.fn() },
            club: { findUnique: vi.fn(async () => ({ matchDuration: 90 })), findFirst: vi.fn() },
        } as any,
        mockNotifyRescheduled: vi.fn(async () => undefined),
    };
});

vi.mock('pino', () => ({ default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../services/db', () => ({ prisma: H.prisma, checkDbHealth: vi.fn(async () => true) }));
vi.mock('../services/queue', () => ({ getRedis: () => ({ get: vi.fn(), set: vi.fn(), del: vi.fn() }), waveQueue: { add: vi.fn() }, maintenanceQueue: { add: vi.fn() }, connection: {}, checkRedisHealth: vi.fn(async () => true) }));
vi.mock('../services/whatsapp', () => ({
    simulateTypingAndSend: vi.fn(), sendMessage: vi.fn(), getConnectionStatus: vi.fn(() => 'open'),
    getAllClubStatuses: vi.fn(() => ({})), getSock: vi.fn(), dissolveGroup: vi.fn(), isOnWhatsApp: vi.fn(), getBotJid: vi.fn(),
}));
vi.mock('../services/match-notifications', () => ({
    notifyMatchRescheduled: H.mockNotifyRescheduled,
    notifyMatchCancelled: vi.fn(async () => undefined),
    cancelMatchesWithNotification: vi.fn(async () => 0),
    findMatchesOnCourt: vi.fn(async () => []),
    findMatchesOutsideHours: vi.fn(async () => []),
}));
vi.mock('../services/scoring', () => ({ getPlayerStats: vi.fn(), processMatchOutcomes: vi.fn(), computeWindowedReliability: vi.fn(), recomputeReliability: vi.fn(), setInvitationOutcome: vi.fn(), PRIOR: 0.33, RELIAB_WINDOW: 20 }));
vi.mock('../utils/notify-admin', () => ({ notifyAdmin: vi.fn(), notifyAdminByClubId: vi.fn(), notifyAdminCritical: vi.fn(), ADMIN_NOTIFY_CATEGORIES: [], ADMIN_NOTIFY_CATEGORY_LABELS: {} }));
vi.mock('../services/admin-commands', () => ({ notifyPendingFaqUsers: vi.fn() }));
vi.mock('../services/faq-manager', () => ({ analyzeFaq: vi.fn() }));
vi.mock('../services/ai', () => ({ anthropic: { messages: { create: vi.fn() } }, inferGender: vi.fn(), splitFaqQuestions: vi.fn() }));

import dashboardRouter from '../api/dashboard.api';

/** Estrae l'handler finale di una rotta dal router Express (salta i middleware auth) */
function routeHandler(method: string, path: string): (req: any, res: any) => Promise<any> {
    const layer = (dashboardRouter as any).stack.find(
        (l: any) => l.route?.path === path && l.route?.methods?.[method],
    );
    if (!layer) throw new Error(`Rotta ${method.toUpperCase()} ${path} non trovata`);
    const stack = layer.route.stack;
    return stack[stack.length - 1].handle;
}

function fakeRes() {
    return {
        statusCode: 200,
        body: null as any,
        status(c: number) { this.statusCode = c; return this; },
        json(b: any) { this.body = b; return this; },
    };
}

// Match esistente: LOCKED, 12/06 16:00 Rome (14:00Z), Campo c-1
const EXISTING = { id: 'm-1', clubId: 'club-1', status: 'LOCKED', startTime: new Date('2026-06-12T14:00:00.000Z'), courtId: 'c-1' };

beforeEach(() => {
    vi.clearAllMocks();
    H.prisma.match.findFirst.mockResolvedValue(EXISTING);
    H.prisma.club.findUnique.mockResolvedValue({ matchDuration: 90 });
    H.prisma.match.findMany.mockResolvedValue([]);
    H.prisma.match.update.mockResolvedValue({});
});

describe('L2 — PATCH /matches/:id: conflitti su overlap di durata', () => {
    const patch = () => routeHandler('patch', '/matches/:id');

    it('spostamento su slot SOVRAPPOSTO (Δ=30min < 90min) → 409', async () => {
        // Sul campo c'è già una partita alle 16:30Z: spostare la nostra alle 16:00Z si sovrappone
        H.prisma.match.findMany.mockResolvedValue([{ startTime: new Date('2026-06-12T16:30:00.000Z') }]);
        const res = fakeRes();
        await patch()({ params: { id: 'm-1' }, body: { startTime: '2026-06-12T16:00:00.000Z' }, clubId: 'club-1' }, res);

        expect(res.statusCode).toBe(409); // prima del fix passava: il check era solo su orario ESATTO
        expect(H.prisma.match.update).not.toHaveBeenCalled();
    });

    it('cambio di SOLO campo verso un campo occupato → 409 (prima il check veniva saltato)', async () => {
        H.prisma.match.findMany.mockResolvedValue([{ startTime: new Date('2026-06-12T14:30:00.000Z') }]);
        const res = fakeRes();
        await patch()({ params: { id: 'm-1' }, body: { courtId: 'c-2' }, clubId: 'club-1' }, res);

        expect(res.statusCode).toBe(409);
        // Il check deve essere stato fatto sul campo di DESTINAZIONE
        expect(H.prisma.match.findMany.mock.calls[0][0].where.courtId).toBe('c-2');
    });

    it('back-to-back esatto (Δ=90min) NON è conflitto → update + notifica giocatori', async () => {
        H.prisma.match.findMany.mockResolvedValue([{ startTime: new Date('2026-06-12T14:30:00.000Z') }]);
        const res = fakeRes();
        await patch()({ params: { id: 'm-1' }, body: { startTime: '2026-06-12T16:00:00.000Z' }, clubId: 'club-1' }, res);

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({ success: true, notified: true });
        expect(H.prisma.match.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'm-1' } }));
        expect(H.mockNotifyRescheduled).toHaveBeenCalledWith('m-1', EXISTING.startTime, new Date('2026-06-12T16:00:00.000Z'), 'club-1');
    });

    it('campo libero → 200 e durata letta dalla config del circolo', async () => {
        H.prisma.club.findUnique.mockResolvedValue({ matchDuration: 60 });
        // Con durata 60: una partita a Δ=70min NON confligge
        H.prisma.match.findMany.mockResolvedValue([{ startTime: new Date('2026-06-12T17:10:00.000Z') }]);
        const res = fakeRes();
        await patch()({ params: { id: 'm-1' }, body: { startTime: '2026-06-12T16:00:00.000Z' }, clubId: 'club-1' }, res);
        expect(res.statusCode).toBe(200);
    });

    it('multi-tenant: partita di un altro club → 404', async () => {
        H.prisma.match.findFirst.mockResolvedValue(null); // findFirst filtra per clubId
        const res = fakeRes();
        await patch()({ params: { id: 'm-altro-club' }, body: { startTime: '2026-06-12T16:00:00.000Z' }, clubId: 'club-1' }, res);
        expect(res.statusCode).toBe(404);
    });

    it('partita CANCELLED non è modificabile → 400', async () => {
        H.prisma.match.findFirst.mockResolvedValue({ ...EXISTING, status: 'CANCELLED' });
        const res = fakeRes();
        await patch()({ params: { id: 'm-1' }, body: { startTime: '2026-06-12T16:00:00.000Z' }, clubId: 'club-1' }, res);
        expect(res.statusCode).toBe(400);
    });
});
