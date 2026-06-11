/**
 * TEST: match-notifications.ts + admin-commands.ts (handleAdminPendingAction)
 *
 * Verifica i meccanismi di notifica ai giocatori in caso di interventi manuali
 * (cancellazione, spostamento orario, disattivazione campo).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────────────────────────
// MOCK SETUP
// ─────────────────────────────────────────────

// vi.mock factories are hoisted before const declarations, so use vi.hoisted()
// to avoid TDZ "Cannot access before initialization" errors
const { mockSimulateTypingAndSend, mockDissolveGroup, mockRedirectGroup, mockWaveQueueAdd } = vi.hoisted(() => ({
    mockSimulateTypingAndSend: vi.fn().mockResolvedValue(undefined),
    mockDissolveGroup: vi.fn().mockResolvedValue(undefined),
    mockRedirectGroup: vi.fn().mockResolvedValue(undefined),
    mockWaveQueueAdd: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/whatsapp', () => ({
    simulateTypingAndSend: mockSimulateTypingAndSend,
    dissolveGroup: mockDissolveGroup,
}));

vi.mock('../services/redirect', () => ({
    redirectGroup: mockRedirectGroup,
}));

vi.mock('../services/queue', () => ({
    waveQueue: { add: mockWaveQueueAdd },
    getRedis: vi.fn(),
}));

vi.mock('pino', () => ({
    default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Prisma mock — configurato per-test con mockImplementation
const { mockPrismaMatchFindUnique, mockPrismaMatchFindMany, mockPrismaMatchUpdate,
    mockPrismaMatchUpdateMany, mockPrismaInvitationUpdateMany, mockPrismaMatchPlayerUpdateMany } = vi.hoisted(() => ({
    mockPrismaMatchFindUnique: vi.fn(),
    mockPrismaMatchFindMany: vi.fn(),
    mockPrismaMatchUpdate: vi.fn().mockResolvedValue({}),
    mockPrismaMatchUpdateMany: vi.fn(),
    mockPrismaInvitationUpdateMany: vi.fn(),
    mockPrismaMatchPlayerUpdateMany: vi.fn().mockResolvedValue({ count: 0 }),
}));

vi.mock('../services/db', () => ({
    prisma: {
        match: {
            findUnique: (...args: any[]) => mockPrismaMatchFindUnique(...args),
            findMany: (...args: any[]) => mockPrismaMatchFindMany(...args),
            update: (...args: any[]) => mockPrismaMatchUpdate(...args),
            updateMany: (...args: any[]) => mockPrismaMatchUpdateMany(...args),
        },
        invitation: {
            updateMany: (...args: any[]) => mockPrismaInvitationUpdateMany(...args),
        },
        matchPlayer: {
            updateMany: (...args: any[]) => mockPrismaMatchPlayerUpdateMany(...args),
        },
    },
}));

import {
    notifyMatchCancelled,
    notifyMatchRescheduled,
    findMatchesOutsideHours,
    cancelMatchesWithNotification,
} from '../services/match-notifications';

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function makePlayer(phone: string, name: string = 'Giocatore', skillLevel: number = 3) {
    return { id: `player-${phone}`, phoneNumber: phone, name, skillLevel };
}

function makeMatchPlayer(phone: string, name?: string) {
    return { player: makePlayer(phone, name) };
}

function makeMatch(overrides: Record<string, any> = {}) {
    return {
        id: 'match-1',
        status: 'OPEN',
        groupId: null,
        startTime: new Date('2026-04-01T10:00:00Z'),
        playersNeeded: 4,
        skillLevel: 3,
        MatchPlayer: [],
        ...overrides,
    };
}

// ─────────────────────────────────────────────
// notifyMatchCancelled
// ─────────────────────────────────────────────

describe('notifyMatchCancelled', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockPrismaInvitationUpdateMany.mockResolvedValue({ count: 0 });
    });

    it('non fa nulla se il match non esiste', async () => {
        mockPrismaMatchFindUnique.mockResolvedValue(null);
        await notifyMatchCancelled('match-1', 'club-1');
        expect(mockRedirectGroup).not.toHaveBeenCalled();
    });

    it('non fa nulla se 0 giocatori confermati', async () => {
        mockPrismaMatchFindUnique.mockResolvedValue(makeMatch({ MatchPlayer: [] }));
        await notifyMatchCancelled('match-1', 'club-1');
        expect(mockRedirectGroup).not.toHaveBeenCalled();
    });

    it('chiama redirectGroup solo per il singolo prenotante (prenotazione singola)', async () => {
        const mp = makeMatchPlayer('393001112222', 'Mario');
        mockPrismaMatchFindUnique.mockResolvedValue(makeMatch({ MatchPlayer: [mp] }));

        await notifyMatchCancelled('match-1', 'club-1');

        expect(mockRedirectGroup).toHaveBeenCalledTimes(1);
        const call = mockRedirectGroup.mock.calls[0][0];
        expect(call.playerPhones).toEqual(['393001112222']);
        expect(call.playerCount).toBe(1);
        expect(call.reason).toBe('CANCELLED');
        // Nessun messaggio al gruppo WA (groupId null)
        expect(mockSimulateTypingAndSend).not.toHaveBeenCalled();
    });

    it('notifica il gruppo WA + redirect a tutti i giocatori (caso matchmaking, 2+ confermati)', async () => {
        const players = [
            makeMatchPlayer('393001112222', 'Mario'),
            makeMatchPlayer('393003334444', 'Luca'),
            makeMatchPlayer('393005556666', 'Sara'),
        ];
        const groupId = 'group-abc@g.us';
        mockPrismaMatchFindUnique.mockResolvedValue(makeMatch({
            MatchPlayer: players,
            groupId,
        }));

        await notifyMatchCancelled('match-1', 'club-1');

        // Il gruppo WA viene sciolto (messaggio finale + rimozione partecipanti), non solo notificato
        expect(mockDissolveGroup).toHaveBeenCalledWith(
            groupId,
            expect.stringContaining('annullata'),
            'club-1',
        );

        // redirectGroup con tutti e 3 i telefoni
        expect(mockRedirectGroup).toHaveBeenCalledTimes(1);
        const call = mockRedirectGroup.mock.calls[0][0];
        expect(call.playerPhones).toHaveLength(3);
        expect(call.playerPhones).toContain('393003334444');
        expect(call.reason).toBe('CANCELLED');
    });

    it('annulla sempre le invitation PENDING prima di notificare', async () => {
        const mp = makeMatchPlayer('393001112222', 'Mario');
        mockPrismaMatchFindUnique.mockResolvedValue(makeMatch({ MatchPlayer: [mp] }));

        await notifyMatchCancelled('match-1', 'club-1');

        // Reliability v2: l'annullamento tagga outcome MATCH_CANCELLED (escluso dalla finestra)
        expect(mockPrismaInvitationUpdateMany).toHaveBeenCalledWith({
            where: { matchId: 'match-1', status: 'PENDING' },
            data: { status: 'IGNORED', outcome: 'MATCH_CANCELLED' },
        });
    });
});

// ─────────────────────────────────────────────
// notifyMatchRescheduled
// ─────────────────────────────────────────────

describe('notifyMatchRescheduled', () => {
    const oldTime = new Date('2026-04-01T10:00:00Z');
    const newTime = new Date('2026-04-01T18:00:00Z');

    beforeEach(() => {
        vi.clearAllMocks();
        mockPrismaInvitationUpdateMany.mockResolvedValue({ count: 0 });
    });

    it('non fa nulla se il match non esiste', async () => {
        mockPrismaMatchFindUnique.mockResolvedValue(null);
        await notifyMatchRescheduled('match-1', oldTime, newTime, 'club-1');
        expect(mockSimulateTypingAndSend).not.toHaveBeenCalled();
    });

    it('non fa nulla se 0 giocatori confermati', async () => {
        mockPrismaMatchFindUnique.mockResolvedValue(makeMatch({ MatchPlayer: [] }));
        await notifyMatchRescheduled('match-1', oldTime, newTime, 'club-1');
        expect(mockSimulateTypingAndSend).not.toHaveBeenCalled();
    });

    it('notifica il gruppo WA se esiste', async () => {
        const groupId = 'group-abc@g.us';
        const mp = makeMatchPlayer('393001112222', 'Mario');
        mockPrismaMatchFindUnique.mockResolvedValue(makeMatch({ MatchPlayer: [mp], groupId }));

        await notifyMatchRescheduled('match-1', oldTime, newTime, 'club-1');

        const groupCall = mockSimulateTypingAndSend.mock.calls.find(c => c[0] === groupId);
        expect(groupCall).toBeDefined();
        expect(groupCall![1]).toContain('spostata');
    });

    it('notifica individualmente ogni giocatore confermato', async () => {
        const players = [
            makeMatchPlayer('393001112222', 'Mario'),
            makeMatchPlayer('393003334444', 'Luca'),
        ];
        mockPrismaMatchFindUnique.mockResolvedValue(makeMatch({ MatchPlayer: players }));

        await notifyMatchRescheduled('match-1', oldTime, newTime, 'club-1');

        const jids = mockSimulateTypingAndSend.mock.calls.map(c => c[0]);
        expect(jids).toContain('393001112222@s.whatsapp.net');
        expect(jids).toContain('393003334444@s.whatsapp.net');
    });

    it('annulla le invitation PENDING', async () => {
        const mp = makeMatchPlayer('393001112222', 'Mario');
        mockPrismaMatchFindUnique.mockResolvedValue(makeMatch({ MatchPlayer: [mp] }));

        await notifyMatchRescheduled('match-1', oldTime, newTime, 'club-1');

        expect(mockPrismaInvitationUpdateMany).toHaveBeenCalledWith({
            where: { matchId: 'match-1', status: 'PENDING' },
            data: { status: 'IGNORED' },
        });
    });

    it('rilancia la wave se il match è ancora OPEN con posti liberi e skillLevel > 0', async () => {
        const mp = makeMatchPlayer('393001112222', 'Mario');
        mockPrismaMatchFindUnique.mockResolvedValue(makeMatch({
            MatchPlayer: [mp],
            status: 'OPEN',
            playersNeeded: 4,
            skillLevel: 3,
        }));

        await notifyMatchRescheduled('match-1', oldTime, newTime, 'club-1');

        expect(mockWaveQueueAdd).toHaveBeenCalledWith(
            'process-wave',
            expect.objectContaining({ matchId: 'match-1', waveNumber: 1 }),
            expect.objectContaining({ delay: expect.any(Number) }),
        );
    });

    it('non rilancia la wave se il match è LOCKED', async () => {
        const players = [
            makeMatchPlayer('393001112222', 'Mario'),
            makeMatchPlayer('393003334444', 'Luca'),
            makeMatchPlayer('393005556666', 'Sara'),
            makeMatchPlayer('393007778888', 'Giulia'),
        ];
        mockPrismaMatchFindUnique.mockResolvedValue(makeMatch({
            MatchPlayer: players,
            status: 'LOCKED',
            playersNeeded: 4,
        }));

        await notifyMatchRescheduled('match-1', oldTime, newTime, 'club-1');

        expect(mockWaveQueueAdd).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────
// findMatchesOutsideHours
// ─────────────────────────────────────────────

describe('findMatchesOutsideHours', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    function makeMatchWithStart(isoUtcTime: string) {
        // Crea un match con startTime in UTC corrispondente all'orario italiano dato
        return makeMatch({ startTime: new Date(isoUtcTime) });
    }

    it('filtra partite fuori dagli orari di apertura (prima dell\'apertura)', async () => {
        // 07:00 italiani (CEST = UTC+2) → 05:00 UTC
        const earlyMatch = makeMatchWithStart('2026-07-01T05:00:00Z'); // 07:00 IT
        const okMatch = makeMatchWithStart('2026-07-01T08:00:00Z');    // 10:00 IT

        mockPrismaMatchFindMany.mockResolvedValue([earlyMatch, okMatch]);

        const result = await findMatchesOutsideHours('club-1', '09:00', '22:00');

        expect(result).toHaveLength(1);
        expect(result[0].startTime.toISOString()).toBe('2026-07-01T05:00:00.000Z');
    });

    it('filtra partite dopo la chiusura', async () => {
        // 23:00 italiani (CEST = UTC+2) → 21:00 UTC
        const lateMatch = makeMatchWithStart('2026-07-01T21:00:00Z'); // 23:00 IT
        const okMatch = makeMatchWithStart('2026-07-01T16:00:00Z');   // 18:00 IT

        mockPrismaMatchFindMany.mockResolvedValue([lateMatch, okMatch]);

        const result = await findMatchesOutsideHours('club-1', '09:00', '22:00');

        expect(result).toHaveLength(1);
        expect(result[0].startTime.toISOString()).toBe('2026-07-01T21:00:00.000Z');
    });

    it('restituisce lista vuota se tutti i match sono negli orari', async () => {
        const okMatch = makeMatchWithStart('2026-07-01T14:00:00Z'); // 16:00 IT

        mockPrismaMatchFindMany.mockResolvedValue([okMatch]);

        const result = await findMatchesOutsideHours('club-1', '09:00', '22:00');

        expect(result).toHaveLength(0);
    });
});

// ─────────────────────────────────────────────
// cancelMatchesWithNotification
// ─────────────────────────────────────────────

describe('cancelMatchesWithNotification', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Il servizio usa updateMany scopato per club (difesa multi-tenant): count=1 = match trovato
        mockPrismaMatchUpdateMany.mockResolvedValue({ count: 1 });
        mockPrismaInvitationUpdateMany.mockResolvedValue({ count: 0 });
        // Match senza giocatori confermati → notifyMatchCancelled termina subito
        mockPrismaMatchFindUnique.mockResolvedValue(makeMatch({ MatchPlayer: [] }));
    });

    it('aggiorna lo status di tutti i match a CANCELLED (scopato per club)', async () => {
        await cancelMatchesWithNotification(['match-1', 'match-2'], 'club-1', 'campo disattivato');

        expect(mockPrismaMatchUpdateMany).toHaveBeenCalledTimes(2);
        expect(mockPrismaMatchUpdateMany).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { id: 'match-1', clubId: 'club-1' },
                data: expect.objectContaining({ status: 'CANCELLED', cancelledReason: 'campo disattivato' }),
            }),
        );
    });

    it('restituisce il conteggio dei match notificati', async () => {
        const count = await cancelMatchesWithNotification(['m1', 'm2', 'm3'], 'club-1', 'test');
        expect(count).toBe(3);
    });

    it('match di un altro club (updateMany count=0) → skippato senza notifica', async () => {
        mockPrismaMatchUpdateMany
            .mockResolvedValueOnce({ count: 1 })  // m1 ok
            .mockResolvedValueOnce({ count: 0 })  // m2 di un altro club
            .mockResolvedValueOnce({ count: 1 }); // m3 ok

        const count = await cancelMatchesWithNotification(['m1', 'm2', 'm3'], 'club-1', 'test');
        expect(count).toBe(2);
    });

    it('salta silenziosamente i match che falliscono e continua con gli altri', async () => {
        mockPrismaMatchUpdateMany
            .mockResolvedValueOnce({ count: 1 })    // m1 ok
            .mockRejectedValueOnce(new Error('DB error')) // m2 fallisce
            .mockResolvedValueOnce({ count: 1 });   // m3 ok

        const count = await cancelMatchesWithNotification(['m1', 'm2', 'm3'], 'club-1', 'test');
        expect(count).toBe(2); // m2 skippato
    });
});
