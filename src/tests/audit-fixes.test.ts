/**
 * TEST AUDIT 11/06/2026 — fix critici (cd2a504) e medi (be8c3eb)
 *
 * Difficoltà crescente:
 *  L1 — workflow base: i percorsi felici toccati funzionano ancora
 *  L2 — controlli su stati e valori interni: guardie, ownership, clamp, codici
 *  L3 — tempistiche, race ed edge case: retry, deadline, staleness, lock
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────────────────────────
// MOCK SETUP (hoisted)
// ─────────────────────────────────────────────

const H = vi.hoisted(() => {
    const fn = () => vi.fn();
    const redisStore = new Map<string, string>();
    const redisMock = {
        get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
        set: vi.fn(async (k: string, v: string, ..._rest: any[]) => { redisStore.set(k, String(v)); return 'OK'; }),
        del: vi.fn(async (k: string) => { redisStore.delete(k); return 1; }),
        keys: vi.fn(async (..._a: any[]): Promise<string[]> => []),
        lrange: vi.fn(async (..._a: any[]): Promise<string[]> => []),
        llen: vi.fn(async (..._a: any[]) => 0),
        lrem: vi.fn(async (..._a: any[]) => 1),
        rpush: vi.fn(async (..._a: any[]) => 1),
        expire: vi.fn(async (..._a: any[]) => 1),
        setex: vi.fn(async (..._a: any[]) => 'OK'),
        flushdb: vi.fn(async (..._a: any[]) => 'OK'),
    };
    const prisma: any = {
        $transaction: vi.fn(),
        $executeRaw: vi.fn(async (..._a: any[]) => 1),
        invitation: { findUnique: fn(), findFirst: fn(), findMany: vi.fn(async (..._a: any[]) => []), update: fn(), updateMany: vi.fn(async (..._a: any[]) => ({ count: 0 })), create: fn(), groupBy: vi.fn(async (..._a: any[]) => []), count: vi.fn(async (..._a: any[]) => 0) },
        match: { findUnique: fn(), findFirst: fn(), findMany: vi.fn(async (..._a: any[]) => []), update: fn(), updateMany: vi.fn(async (..._a: any[]) => ({ count: 0 })), create: fn() },
        matchPlayer: { findUnique: fn(), findFirst: fn(), findMany: vi.fn(async (..._a: any[]) => []), update: fn(), updateMany: vi.fn(async (..._a: any[]) => ({ count: 0 })), create: fn(), upsert: fn(), count: vi.fn(async (..._a: any[]) => 0), groupBy: vi.fn(async (..._a: any[]) => []) },
        player: { findUnique: fn(), findFirst: fn(), findMany: vi.fn(async (..._a: any[]) => []), update: vi.fn(async (..._a: any[]) => ({})), updateMany: vi.fn(async (..._a: any[]) => ({ count: 0 })), create: fn() },
        club: { findUnique: fn(), findFirst: fn(), count: vi.fn(async (..._a: any[]) => 1) },
        court: { findFirst: fn(), findMany: vi.fn(async (..._a: any[]) => []), count: vi.fn(async (..._a: any[]) => 0) },
        faq: { findMany: vi.fn(async (..._a: any[]) => []), create: fn() },
        whatsAppMessage: { findFirst: fn(), findMany: vi.fn(async (..._a: any[]) => []), create: fn(), deleteMany: vi.fn(async (..._a: any[]) => ({ count: 0 })) },
        conversationState: { findFirst: vi.fn(async (..._a: any[]) => null), upsert: vi.fn(async (..._a: any[]) => ({})), deleteMany: vi.fn(async (..._a: any[]) => ({ count: 0 })) },
        matchFeedback: { create: fn() },
    };
    return {
        redisStore,
        redisMock,
        prisma,
        mockSend: vi.fn(async (..._a: any[]) => undefined),
        mockSendRaw: vi.fn(async (..._a: any[]) => undefined),
        mockDissolveGroup: vi.fn(async (..._a: any[]) => undefined),
        mockCreateGroup: vi.fn(async (..._a: any[]) => 'group-id@g.us'),
        mockWaveAdd: vi.fn(async (..._a: any[]) => ({})),
        mockReminderAdd: vi.fn(async (..._a: any[]) => ({})),
        mockRedirectGroup: vi.fn(async (..._a: any[]) => undefined),
        mockNotifyAdmin: vi.fn(async (..._a: any[]) => true),
        mockAnthropicCreate: vi.fn(),
        mockCallBrain: vi.fn(),
        mockBuildBrainContext: vi.fn(),
        mockCheckMatchTimeouts: vi.fn(async (..._a: any[]) => undefined),
        mockProcessMatchOutcomes: vi.fn(async (..._a: any[]) => undefined),
        workerProcessors: {} as Record<string, (job: any) => Promise<any>>,
    };
});

vi.mock('pino', () => ({ default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../services/db', () => ({ prisma: H.prisma, checkDbHealth: vi.fn(async (..._a: any[]) => true) }));
vi.mock('../services/queue', () => ({
    waveQueue: { add: H.mockWaveAdd },
    reminderQueue: { add: H.mockReminderAdd },
    maintenanceQueue: { add: vi.fn(async (..._a: any[]) => ({})) },
    getRedis: () => H.redisMock,
    connection: {},
    checkSilentMatches: vi.fn(),
    checkRedisHealth: vi.fn(async (..._a: any[]) => true),
}));
vi.mock('../services/whatsapp', () => ({
    simulateTypingAndSend: H.mockSend,
    sendMessage: H.mockSendRaw,
    dissolveGroup: H.mockDissolveGroup,
    createGroupAndAddPlayers: H.mockCreateGroup,
    downloadMediaMessage: vi.fn(),
    isOnWhatsApp: vi.fn(async (..._a: any[]) => true),
    getBotJid: vi.fn(async (..._a: any[]) => null),
    wahEvents: { on: vi.fn(), emit: vi.fn() },
}));
vi.mock('../services/ai', () => ({
    anthropic: { messages: { create: H.mockAnthropicCreate } },
    transcribeAudio: vi.fn(),
    inferGender: vi.fn(async (..._a: any[]) => 'MALE'),
    detectSecondaryFaqQuestion: vi.fn(async (..._a: any[]) => null),
    splitFaqQuestions: vi.fn(async (q: string) => [q]),
    requiresResponse: vi.fn(async (..._a: any[]) => true),
    generateInvitation: vi.fn(async (..._a: any[]) => 'invito'),
    generateFeedbackRequest: vi.fn(async (..._a: any[]) => 'feedback?'),
    classifyIntent: vi.fn(),
    extractPhoneNumber: vi.fn(),
    extractPreferredPlayerName: vi.fn(),
    extractSkillLevel: vi.fn(),
    TranscriptionError: class extends Error {},
}));
vi.mock('../services/redirect', () => ({
    redirectGroup: H.mockRedirectGroup,
    confirmRedirectChoice: vi.fn(),
    findRedirectOptions: vi.fn(),
    notifyDisplacedPlayers: vi.fn(),
}));
vi.mock('../utils/notify-admin', () => ({
    notifyAdmin: H.mockNotifyAdmin,
    notifyAdminByClubId: vi.fn(),
    notifyAdminCritical: vi.fn(),
    ADMIN_NOTIFY_CATEGORIES: ['system', 'matches', 'faq', 'players'],
    ADMIN_NOTIFY_CATEGORY_LABELS: {},
}));
// scoring: reale per le funzioni pure (computeNextWaveDelayMs ecc.), mock per i side-effect
vi.mock('../services/scoring', async (importOriginal) => {
    const real: any = await importOriginal();
    return {
        ...real,
        processMatchOutcomes: H.mockProcessMatchOutcomes,
        setInvitationOutcome: vi.fn(async (..._a: any[]) => undefined),
        recomputeReliability: vi.fn(async (..._a: any[]) => undefined),
    };
});
vi.mock('../services/recovery', () => ({
    checkMatchTimeouts: H.mockCheckMatchTimeouts,
    handleMatchUnfillable: vi.fn(async (..._a: any[]) => undefined),
}));
vi.mock('../services/delivery', () => ({ resendUndeliveredMessages: vi.fn(async (..._a: any[]) => undefined) }));
vi.mock('../services/conversation-state', () => ({
    setState: vi.fn(async (..._a: any[]) => undefined),
    getState: vi.fn(async (..._a: any[]) => null),
    clearState: vi.fn(async (..._a: any[]) => undefined),
    pruneExpiredStates: vi.fn(async (..._a: any[]) => undefined),
}));
vi.mock('bullmq', () => ({
    Worker: class {
        constructor(name: string, processor: any) { H.workerProcessors[name.replace(/^.*?-/, '').replace(/^(wave|maintenance|reminder).*$/, '$1') || name] = processor; H.workerProcessors[name] = processor; }
        on() { return this; }
    },
    Queue: class { constructor() {} add = vi.fn(); on() { return this; } },
    QueueEvents: class { constructor() {} on() { return this; } },
}));

import { executeAction, joinExistingMatch } from '../services/brain';
import { handleBatch, handleActionError } from '../services/messageHandler';
import { handleApprovalCommand, handleAdminPendingAction, handleAdminFaqFlow } from '../services/admin-commands';
import { computeNextWaveDelayMs, humanSendDelayMs, isNightInRome, msUntil8amRome } from '../services/scoring';
import '../workers/maintenance.worker';

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

const PLAYER = { id: 'p-me', name: 'Mario Rossi', phoneNumber: '393331112222', gender: 'MALE', skillLevel: 3, clubId: 'club-1', notes: null };
const CLUB = { id: 'club-1', name: 'Padel Club', adminPhone: null, openTime: '08:00', closeTime: '23:30', matchDuration: 90, deadlineMinutesBeforeMatch: 60, matchLowerRange: 1.0, matchUpperRange: 1.0, racketPrice: null, address: null, city: null };

const mp = (playerId: string, gender = 'MALE') => ({ id: `mp-${playerId}`, playerId, leftAt: null, player: { gender } });

/** Configura il mock di $transaction con un tx che condivide i mock prisma + $executeRaw */
function useTx() {
    H.prisma.$transaction.mockImplementation(async (fn: any) => fn({ ...H.prisma, $executeRaw: vi.fn(async (..._a: any[]) => 1) }));
}

beforeEach(() => {
    vi.clearAllMocks();
    H.redisStore.clear();
    useTx();
});

afterEach(() => {
    vi.useRealTimers();
});

// ═════════════════════════════════════════════
// L1 — WORKFLOW BASE (percorsi felici toccati)
// ═════════════════════════════════════════════

describe('L1 — workflow base', () => {
    it('ACCEPT_INVITATION: 3° giocatore entra, match resta OPEN, invito ACCEPTED', async () => {
        H.prisma.invitation.findUnique.mockResolvedValue({ id: 'inv-1', playerId: 'p-me', matchId: 'm-1' });
        H.prisma.match.findUnique.mockImplementation(async (args: any) => {
            if (args.select?.status) return { status: 'OPEN' };
            return { id: 'm-1', status: 'OPEN', playersNeeded: 4, isMixed: false, MatchPlayer: [mp('p1'), mp('p2')] };
        });
        H.prisma.matchPlayer.upsert.mockResolvedValue({});
        H.prisma.invitation.update.mockResolvedValue({});

        const res = await executeAction('ACCEPT_INVITATION', { invitationId: 'inv-1' }, PLAYER, CLUB, PLAYER.phoneNumber);

        expect(res.success).toBe(true);
        expect(res.matchId).toBeUndefined(); // non LOCKED → niente handleMatchFilled
        expect(H.prisma.invitation.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'ACCEPTED' }) }),
        );
        // Nessun lock a 3
        const lockCalls = H.prisma.match.update.mock.calls.filter((c: any) => c[0]?.data?.status === 'LOCKED');
        expect(lockCalls).toHaveLength(0);
    });

    it('ACCEPT_INVITATION: 4° giocatore → LOCK e matchId per handleMatchFilled', async () => {
        H.prisma.invitation.findUnique.mockResolvedValue({ id: 'inv-1', playerId: 'p-me', matchId: 'm-1' });
        H.prisma.match.findUnique.mockImplementation(async (args: any) => {
            if (args.select?.status) return { status: 'LOCKED' };
            return { id: 'm-1', status: 'OPEN', playersNeeded: 4, isMixed: false, MatchPlayer: [mp('p1'), mp('p2'), mp('p3')] };
        });
        H.prisma.matchPlayer.upsert.mockResolvedValue({});
        H.prisma.invitation.update.mockResolvedValue({});
        H.prisma.match.update.mockResolvedValue({});

        const res = await executeAction('ACCEPT_INVITATION', { invitationId: 'inv-1' }, PLAYER, CLUB, PLAYER.phoneNumber);

        expect(res.success).toBe(true);
        expect(res.matchId).toBe('m-1');
        expect(H.prisma.match.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'm-1' }, data: { status: 'LOCKED' } }),
        );
    });

    it('SAVE_FEEDBACK: salva MatchFeedback con rating nel content e pulisce lo stato Redis', async () => {
        H.prisma.match.findUnique.mockResolvedValue({ courtId: 'c-1', clubId: 'club-1' });
        H.prisma.matchFeedback.create.mockResolvedValue({});
        H.redisStore.set('state:feedback_pending:393331112222@s.whatsapp.net', JSON.stringify({ matchId: 'm-1' }));

        const res = await executeAction('SAVE_FEEDBACK', { matchId: 'm-1', rating: 4, comment: 'Bella partita, campo ottimo' }, PLAYER, CLUB, PLAYER.phoneNumber);

        expect(res.success).toBe(true);
        expect(H.prisma.matchFeedback.create).toHaveBeenCalledWith({
            data: { matchId: 'm-1', playerId: 'p-me', courtId: 'c-1', content: '[4/5] Bella partita, campo ottimo' },
        });
        expect(H.redisMock.del).toHaveBeenCalledWith('state:feedback_pending:393331112222@s.whatsapp.net');
    });

    it('joinExistingMatch: join felice su match vuoto dello stesso club', async () => {
        H.prisma.match.findUnique.mockResolvedValue({ id: 'm-1', clubId: 'club-1', status: 'OPEN', playersNeeded: 4, isMixed: false, targetGender: null, MatchPlayer: [] });
        H.prisma.matchPlayer.upsert.mockResolvedValue({});
        H.prisma.invitation.findFirst.mockResolvedValue(null);
        H.prisma.invitation.create.mockResolvedValue({});

        const res = await joinExistingMatch('m-1', PLAYER);
        expect(res.success).toBe(true);
        expect(H.prisma.invitation.create).toHaveBeenCalled();
    });

    it('Approval: "ok <numero>" approva e conferma all\'admin', async () => {
        const ok = await handleApprovalCommand('ok 393409998877', CLUB, 'admin@s.whatsapp.net');
        expect(ok).toBe(true);
        expect(H.redisMock.set).toHaveBeenCalledWith('approval:approved:393409998877', '1', 'EX', 90 * 24 * 3600);
        expect(H.mockSendRaw).toHaveBeenCalledWith('admin@s.whatsapp.net', expect.stringContaining('approvato'));
    });
});

// ═════════════════════════════════════════════
// L2 — CONTROLLI SU STATI E VALORI INTERNI
// ═════════════════════════════════════════════

describe('L2 — guardie su stati e valori', () => {
    it('ACCEPT con giocatore GIÀ dentro → ALREADY_JOINED, nessun LOCK a 3, invito risolto ACCEPTED', async () => {
        H.prisma.invitation.findUnique.mockResolvedValue({ id: 'inv-1', playerId: 'p-me', matchId: 'm-1' });
        H.prisma.match.findUnique.mockResolvedValue({
            id: 'm-1', status: 'OPEN', playersNeeded: 4, isMixed: false,
            MatchPlayer: [mp('p1'), mp('p2'), mp('p-me')], // il player è già il 3°
        });
        H.prisma.invitation.update.mockResolvedValue({});

        const res = await executeAction('ACCEPT_INVITATION', { invitationId: 'inv-1' }, PLAYER, CLUB, PLAYER.phoneNumber);

        expect(res.success).toBe(false);
        expect(res.errorMessage).toBe('ALREADY_JOINED');
        // PRIMA del fix: 3 MatchPlayer + 1 (doppio conteggio) = LOCK con 3 giocatori reali
        const lockCalls = H.prisma.match.update.mock.calls.filter((c: any) => c[0]?.data?.status === 'LOCKED');
        expect(lockCalls).toHaveLength(0);
        // Invito stale risolto: non riapparirà nel contesto del brain né diventerà GHOST
        expect(H.prisma.invitation.update).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: 'inv-1' }, data: expect.objectContaining({ status: 'ACCEPTED' }) }),
        );
    });

    it('ACCEPT su match pieno → MATCH_FULL, invito IGNORED con outcome WILLING_FULL (nessuna colpa)', async () => {
        H.prisma.invitation.findUnique.mockResolvedValue({ id: 'inv-1', playerId: 'p-me', matchId: 'm-1' });
        H.prisma.match.findUnique.mockResolvedValue({
            id: 'm-1', status: 'OPEN', playersNeeded: 4, isMixed: false,
            MatchPlayer: [mp('p1'), mp('p2'), mp('p3'), mp('p4')],
        });
        H.prisma.invitation.update.mockResolvedValue({});

        const res = await executeAction('ACCEPT_INVITATION', { invitationId: 'inv-1' }, PLAYER, CLUB, PLAYER.phoneNumber);

        expect(res.errorMessage).toBe('MATCH_FULL');
        expect(H.prisma.invitation.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ status: 'IGNORED', outcome: 'WILLING_FULL' }) }),
        );
    });

    it('ACCEPT con ownership sbagliata (invito di un altro) → rifiutato senza toccare nulla', async () => {
        H.prisma.invitation.findUnique.mockResolvedValue({ id: 'inv-1', playerId: 'p-ALTRO', matchId: 'm-1' });
        const res = await executeAction('ACCEPT_INVITATION', { invitationId: 'inv-1' }, PLAYER, CLUB, PLAYER.phoneNumber);
        expect(res.success).toBe(false);
        expect(H.prisma.$transaction).not.toHaveBeenCalled();
    });

    it('ACCEPT su partita mista con genere UNKNOWN → GENDER_UNKNOWN (niente partite zombie)', async () => {
        H.prisma.invitation.findUnique.mockResolvedValue({ id: 'inv-1', playerId: 'p-me', matchId: 'm-1' });
        H.prisma.match.findUnique.mockResolvedValue({
            id: 'm-1', status: 'OPEN', playersNeeded: 4, isMixed: true,
            MatchPlayer: [mp('p1', 'MALE')],
        });
        const res = await executeAction('ACCEPT_INVITATION', { invitationId: 'inv-1' }, { ...PLAYER, gender: 'UNKNOWN' }, CLUB, PLAYER.phoneNumber);
        expect(res.errorMessage).toBe('GENDER_UNKNOWN');
    });

    it('joinExistingMatch: match di un ALTRO club → MATCH_CLOSED (difesa multi-tenant)', async () => {
        H.prisma.match.findUnique.mockResolvedValue({ id: 'm-X', clubId: 'club-B', status: 'OPEN', playersNeeded: 4, isMixed: false, MatchPlayer: [] });
        const res = await joinExistingMatch('m-X', PLAYER); // PLAYER.clubId = club-1
        expect(res.success).toBe(false);
        expect(res.errorMessage).toBe('MATCH_CLOSED');
        expect(H.prisma.matchPlayer.upsert).not.toHaveBeenCalled();
    });

    it('joinExistingMatch: misto con quota uomini piena → GENDER_SLOT_FULL', async () => {
        H.prisma.match.findUnique.mockResolvedValue({
            id: 'm-1', clubId: 'club-1', status: 'OPEN', playersNeeded: 4, isMixed: true,
            MatchPlayer: [mp('p1', 'MALE'), mp('p2', 'MALE')],
        });
        const res = await joinExistingMatch('m-1', PLAYER);
        expect(res.errorMessage).toBe('GENDER_SLOT_FULL');
    });

    it('SAVE_FEEDBACK: rating fuori scala viene clampato, rating non numerico omesso', async () => {
        H.prisma.match.findUnique.mockResolvedValue({ courtId: 'c-1', clubId: 'club-1' });
        H.prisma.matchFeedback.create.mockResolvedValue({});

        await executeAction('SAVE_FEEDBACK', { matchId: 'm-1', rating: 9, comment: 'Super' }, PLAYER, CLUB, PLAYER.phoneNumber);
        expect(H.prisma.matchFeedback.create).toHaveBeenLastCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ content: '[5/5] Super' }) }),
        );

        await executeAction('SAVE_FEEDBACK', { matchId: 'm-1', rating: 'boh', comment: 'Così così' }, PLAYER, CLUB, PLAYER.phoneNumber);
        expect(H.prisma.matchFeedback.create).toHaveBeenLastCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ content: 'Così così' }) }),
        );
    });

    it('SAVE_FEEDBACK: match senza campo (webhook) → nessuna create ma stato comunque ripulito', async () => {
        H.prisma.match.findUnique.mockResolvedValue({ courtId: null, clubId: 'club-1' });
        const res = await executeAction('SAVE_FEEDBACK', { matchId: 'm-1', comment: 'ok' }, PLAYER, CLUB, PLAYER.phoneNumber);
        expect(res.success).toBe(true);
        expect(H.prisma.matchFeedback.create).not.toHaveBeenCalled();
        expect(H.redisMock.del).toHaveBeenCalledWith('state:feedback_pending:393331112222@s.whatsapp.net');
    });

    it('SAVE_FEEDBACK: senza commento è un no-op silenzioso', async () => {
        const res = await executeAction('SAVE_FEEDBACK', { matchId: 'm-1', comment: '' }, PLAYER, CLUB, PLAYER.phoneNumber);
        expect(res.success).toBe(true);
        expect(H.prisma.match.findUnique).not.toHaveBeenCalled();
    });

    it('OPEN_TO_MATCHMAKING: considera SOLO prenotazioni future, la più vicina', async () => {
        H.prisma.matchPlayer.findFirst.mockResolvedValue(null);
        const res = await executeAction('OPEN_TO_MATCHMAKING', {}, PLAYER, CLUB, PLAYER.phoneNumber);
        expect(res.errorMessage).toBe('NO_PRIVATE_BOOKING_TO_CONVERT');

        const args = H.prisma.matchPlayer.findFirst.mock.calls[0][0];
        expect(args.where.match.startTime.gt).toBeInstanceOf(Date); // niente prenotazioni passate
        expect(args.orderBy).toEqual({ match: { startTime: 'asc' } }); // la più vicina, non l'ultima creata
    });

    it('handleActionError: codice simbolico non mappato NON arriva grezzo all\'utente', async () => {
        await handleActionError('x@s.whatsapp.net', 'BOOK_FIELD', {}, { errorMessage: 'STRANO_CODICE_NUOVO' }, PLAYER, CLUB, PLAYER.phoneNumber);
        expect(H.mockSend).toHaveBeenCalledTimes(1);
        const sent = H.mockSend.mock.calls[0][1];
        expect(sent).not.toContain('STRANO_CODICE_NUOVO');
        expect(sent).not.toContain('Ops!');
    });

    it('handleActionError: messaggio già user-friendly passa invariato', async () => {
        await handleActionError('x@s.whatsapp.net', 'BOOK_FIELD', {}, { errorMessage: 'Il circolo apre alle 08:00.' }, PLAYER, CLUB, PLAYER.phoneNumber);
        expect(H.mockSend.mock.calls[0][1]).toContain('Il circolo apre alle 08:00.');
    });

    it('Approval gate: "ok" secco con azione admin pendente NON viene ingoiato', async () => {
        H.redisStore.set('admin:pending_action:club-1', JSON.stringify({ steps: [{ command: 'LIST_PLAYERS', params: {} }] }));
        const handled = await handleApprovalCommand('ok', CLUB, 'admin@s.whatsapp.net');
        expect(handled).toBe(false); // passa la mano a handleAdminPendingAction
        expect(H.mockSendRaw).not.toHaveBeenCalled();
    });

    it('Approval gate: "ok" secco senza nulla in attesa lascia proseguire la catena', async () => {
        const handled = await handleApprovalCommand('ok', CLUB, 'admin@s.whatsapp.net');
        expect(handled).toBe(false);
        expect(H.mockSendRaw).not.toHaveBeenCalled(); // niente più "Nessun numero in attesa"
    });

    it('Catena completa: "ok" conferma davvero l\'azione admin pendente', async () => {
        H.redisStore.set('admin:pending_action:club-1', JSON.stringify({ steps: [{ command: 'LIST_PLAYERS', params: {} }] }));
        const fromApproval = await handleApprovalCommand('ok', CLUB, 'admin@s.whatsapp.net');
        expect(fromApproval).toBe(false);
        const fromPending = await handleAdminPendingAction('ok', CLUB, 'admin@s.whatsapp.net');
        expect(fromPending).toBe(true);
        expect(H.redisMock.del).toHaveBeenCalledWith('admin:pending_action:club-1');
        // LIST_PLAYERS eseguito (nessun giocatore nei mock → messaggio "Nessun giocatore")
        expect(H.mockSend).toHaveBeenCalledWith('admin@s.whatsapp.net', expect.stringContaining('Nessun giocatore'));
    });

    it('FAQ flow: con 2 FAQ pending un comando admin NON viene intercettato (routing "none")', async () => {
        H.redisMock.lrange.mockResolvedValue(['f1', 'f2']);
        H.redisStore.set('faq:pending:club-1:f1', JSON.stringify({ id: 'f1', question: 'Avete il bar?', askedBy: 'Mario', playerJid: 'x@s.whatsapp.net' }));
        H.redisStore.set('faq:pending:club-1:f2', JSON.stringify({ id: 'f2', question: 'C\'è il parcheggio?', askedBy: 'Luca', playerJid: 'y@s.whatsapp.net' }));
        H.mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '{"type":"none","targetIndex":null,"answerText":null,"answers":null}' }] });

        const handled = await handleAdminFaqFlow('cancella tutte le partite di domani', CLUB, 'admin@s.whatsapp.net');

        expect(handled).toBe(false); // il comando prosegue verso handleAdminCommand
        expect(H.mockSendRaw).not.toHaveBeenCalled();
        expect(H.mockSend).not.toHaveBeenCalled();
    });

    it('FAQ flow: errore AI nel routing non blocca più l\'admin (default none, non ambiguous)', async () => {
        H.redisMock.lrange.mockResolvedValue(['f1', 'f2']);
        H.redisStore.set('faq:pending:club-1:f1', JSON.stringify({ id: 'f1', question: 'Avete il bar?', askedBy: 'Mario', playerJid: 'x@s.whatsapp.net' }));
        H.redisStore.set('faq:pending:club-1:f2', JSON.stringify({ id: 'f2', question: 'C\'è il parcheggio?', askedBy: 'Luca', playerJid: 'y@s.whatsapp.net' }));
        H.mockAnthropicCreate.mockRejectedValue(new Error('AI down'));

        const handled = await handleAdminFaqFlow('lista partite', CLUB, 'admin@s.whatsapp.net');
        expect(handled).toBe(false);
    });
});

// ═════════════════════════════════════════════
// L3 — TEMPISTICHE, RACE, EDGE CASE
// ═════════════════════════════════════════════

describe('L3 — RESCHEDULE_MATCH: gruppo WA e deadline', () => {
    const inHours = (h: number) => new Date(Date.now() + h * 3600_000);

    /** Mock completo del percorso reschedule: booking nuovo slot + gestione vecchio match */
    function setupReschedule(oldMatch: any) {
        H.prisma.matchPlayer.findUnique.mockResolvedValue({ id: 'mp-me', playerId: 'p-me', matchId: 'm-old' });
        H.prisma.matchPlayer.findMany.mockResolvedValue([]); // nessuna sovrapposizione per il nuovo slot
        H.prisma.match.findMany.mockResolvedValue([]);       // nessun match aperto da joinare / campo libero
        H.prisma.court.findFirst.mockResolvedValue({ id: 'c-free', name: 'Campo 2', isCovered: false });
        H.prisma.match.findUnique.mockImplementation(async (args: any) => {
            if (args.select?.isPrivateBooking && !args.include) return { isPrivateBooking: oldMatch.isPrivateBooking };
            return oldMatch;
        });
        H.prisma.$transaction.mockImplementation(async (fn: any) => fn({
            ...H.prisma,
            $executeRaw: vi.fn(async (..._a: any[]) => 1),
            match: { ...H.prisma.match, create: vi.fn(async (..._a: any[]) => ({ id: 'm-new', playersNeeded: 4 })) },
            matchPlayer: { ...H.prisma.matchPlayer, create: vi.fn(async (..._a: any[]) => ({})) },
            invitation: { ...H.prisma.invitation, create: vi.fn(async (..._a: any[]) => ({})) },
        }));
        H.prisma.matchPlayer.update.mockResolvedValue({});
        H.prisma.match.update.mockResolvedValue({});
    }

    const remaining3 = [
        { id: 'mp-1', playerId: 'p1', leftAt: null, player: { phoneNumber: '391', name: 'Uno' } },
        { id: 'mp-2', playerId: 'p2', leftAt: null, player: { phoneNumber: '392', name: 'Due' } },
        { id: 'mp-3', playerId: 'p3', leftAt: null, player: { phoneNumber: '393', name: 'Tre' } },
    ];

    it('LOCKED matchmaking con margine: scioglie il gruppo, groupId=null, riapre e rilancia wave urgente', async () => {
        setupReschedule({
            id: 'm-old', status: 'LOCKED', isPrivateBooking: false, groupId: 'grp@g.us',
            startTime: inHours(5), recoveryWaveCount: 0, skillLevel: 3, MatchPlayer: remaining3,
        });

        const res = await executeAction('RESCHEDULE_MATCH', { matchPlayerId: 'mp-me', newDay: 'domani', newTime: '18:00' }, PLAYER, CLUB, PLAYER.phoneNumber);
        expect(res.success).toBe(true);

        // Il gruppo viene sciolto e groupId azzerato → handleMatchFilled potrà ricreare il gruppo col sostituto
        expect(H.mockDissolveGroup).toHaveBeenCalledWith('grp@g.us', expect.stringContaining('sostituto'), 'club-1');
        expect(H.prisma.match.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'm-old' },
            data: expect.objectContaining({ status: 'OPEN', groupId: null, recoveryWaveCount: { increment: 1 } }),
        }));
        // Wave urgente immediata sul vecchio match
        const oldWave = H.mockWaveAdd.mock.calls.find((c: any) => c[1]?.matchId === 'm-old');
        expect(oldWave?.[1]).toMatchObject({ urgencyMultiplier: 2 });
        expect(oldWave?.[2]).toMatchObject({ delay: 0 });
        // I 3 rimasti vengono avvisati
        const notified = H.mockSend.mock.calls.filter((c: any) => String(c[1]).includes('non può più venire'));
        expect(notified).toHaveLength(3);
        expect(H.prisma.match.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'CANCELLED' }) }));
    });

    it('LOCKED matchmaking SOTTO deadline: cancella con onestà, redirect dei rimasti, avvisa admin', async () => {
        setupReschedule({
            id: 'm-old', status: 'LOCKED', isPrivateBooking: false, groupId: 'grp@g.us',
            startTime: inHours(0.5), recoveryWaveCount: 0, skillLevel: 3, MatchPlayer: remaining3,
        });

        const res = await executeAction('RESCHEDULE_MATCH', { matchPlayerId: 'mp-me', newDay: 'domani', newTime: '18:00' }, PLAYER, CLUB, PLAYER.phoneNumber);
        expect(res.success).toBe(true);

        expect(H.prisma.match.update).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'm-old' },
            data: expect.objectContaining({ status: 'CANCELLED', cancelledReason: 'PLAYER_CANCELLED' }),
        }));
        expect(H.prisma.invitation.updateMany).toHaveBeenCalledWith(expect.objectContaining({
            where: { matchId: 'm-old', status: 'PENDING' }, data: { status: 'IGNORED' },
        }));
        expect(H.mockDissolveGroup).toHaveBeenCalledWith('grp@g.us', expect.stringContaining('annullata'), 'club-1');
        expect(H.mockRedirectGroup).toHaveBeenCalledWith(expect.objectContaining({
            playerCount: 3, reason: 'CANCELLATION', intent: 'MATCHMAKING', originalMatchId: 'm-old',
        }));
        expect(H.mockNotifyAdmin).toHaveBeenCalled();
        // NESSUNA wave promessa sul vecchio match (sarebbe una promessa impossibile)
        const oldWave = H.mockWaveAdd.mock.calls.find((c: any) => c[1]?.matchId === 'm-old');
        expect(oldWave).toBeUndefined();
    });

    it('LOCKED con recovery esaurite (recoveryWaveCount>=3) → cancella anche con ore di margine', async () => {
        setupReschedule({
            id: 'm-old', status: 'LOCKED', isPrivateBooking: false, groupId: null,
            startTime: inHours(6), recoveryWaveCount: 3, skillLevel: 3, MatchPlayer: remaining3,
        });

        await executeAction('RESCHEDULE_MATCH', { matchPlayerId: 'mp-me', newDay: 'domani', newTime: '18:00' }, PLAYER, CLUB, PLAYER.phoneNumber);

        expect(H.prisma.match.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'CANCELLED' }),
        }));
        expect(H.mockDissolveGroup).not.toHaveBeenCalled(); // nessun gruppo da sciogliere
    });

    it('OPEN matchmaking (nessun gruppo): solo wave, niente dissolve né cambio status', async () => {
        setupReschedule({
            id: 'm-old', status: 'OPEN', isPrivateBooking: false, groupId: null,
            startTime: inHours(5), recoveryWaveCount: 0, skillLevel: 3, MatchPlayer: remaining3.slice(0, 2),
        });

        await executeAction('RESCHEDULE_MATCH', { matchPlayerId: 'mp-me', newDay: 'domani', newTime: '18:00' }, PLAYER, CLUB, PLAYER.phoneNumber);

        expect(H.mockDissolveGroup).not.toHaveBeenCalled();
        // matchUpdate vuoto → nessuna update di status sul vecchio match
        const statusUpdates = H.prisma.match.update.mock.calls.filter((c: any) => c[0]?.where?.id === 'm-old');
        expect(statusUpdates).toHaveLength(0);
        const oldWave = H.mockWaveAdd.mock.calls.find((c: any) => c[1]?.matchId === 'm-old');
        expect(oldWave).toBeDefined();
    });

    it('ownership: matchPlayerId di un altro giocatore → rifiutato prima di toccare il booking', async () => {
        H.prisma.matchPlayer.findUnique.mockResolvedValue({ id: 'mp-x', playerId: 'p-ALTRO', matchId: 'm-old' });
        const res = await executeAction('RESCHEDULE_MATCH', { matchPlayerId: 'mp-x', newDay: 'domani', newTime: '18:00' }, PLAYER, CLUB, PLAYER.phoneNumber);
        expect(res.success).toBe(false);
        expect(H.prisma.$transaction).not.toHaveBeenCalled();
    });
});

describe('L3 — retry batch dopo socket-error (il messaggio NON va perso)', () => {
    it('al retry i messaggi sono alreadyPersisted: niente dedup-scarto, il brain risponde', async () => {
        vi.useFakeTimers();

        H.prisma.club.findUnique.mockResolvedValue(CLUB);
        H.prisma.club.findFirst.mockResolvedValue(CLUB);
        H.prisma.player.findFirst.mockResolvedValue(null); // utente sconosciuto → brain con contesto ridotto
        H.prisma.whatsAppMessage.findFirst.mockResolvedValue(null);
        H.prisma.whatsAppMessage.create.mockResolvedValue({});
        // buildBrainContext reale: query già coperte dai default ([] / null)
        H.mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '{"message":"Ciao! Come posso aiutarti?","action":"NONE","params":{}}' }], usage: {} });

        // Primo invio: socket giù → handleBatch schedula il retry a 90s
        H.mockSend.mockRejectedValueOnce(new Error('WhatsApp socket not available for club club-1 after 30000ms'));

        const messages = [{
            type: 'text' as const,
            text: 'vorrei prenotare un campo',
            clubId: 'club-1',
            raw: { key: { id: 'MSG-RETRY-1', remoteJid: '393331112222@s.whatsapp.net', fromMe: false }, message: { conversation: 'vorrei prenotare un campo' }, messageTimestamp: Math.floor(Date.now() / 1000) } as any,
        }];

        await handleBatch('393331112222@s.whatsapp.net', messages);

        // Primo giro: persistito 1 volta, dedup interrogata 1 volta, risposta fallita
        const dedupCalls = () => H.prisma.whatsAppMessage.findFirst.mock.calls.filter((c: any) => c[0]?.where?.messageId === 'MSG-RETRY-1');
        expect(dedupCalls()).toHaveLength(1);
        expect(H.prisma.whatsAppMessage.create).toHaveBeenCalledTimes(1);
        expect(H.mockAnthropicCreate).toHaveBeenCalledTimes(1);

        // Avanza 91s → scatta il retry
        await vi.advanceTimersByTimeAsync(91_000);

        // PRIMA del fix: la dedup scartava tutto e il batch moriva qui.
        // ORA: alreadyPersisted=true → niente seconda dedup, niente doppio salvataggio, il brain risponde.
        expect(dedupCalls()).toHaveLength(1);                       // nessuna seconda query dedup
        expect(H.prisma.whatsAppMessage.create).toHaveBeenCalledTimes(1); // nessun doppione in DB
        expect(H.mockAnthropicCreate).toHaveBeenCalledTimes(2);     // il brain ha rielaborato il batch
        expect(H.mockSend).toHaveBeenCalledTimes(2);                // e la risposta è partita
    });
});

describe('L3 — maintenance worker: staleness e tempistiche wave', () => {
    function processor() {
        const keys = Object.keys(H.workerProcessors).filter(k => k.includes('maintenance'));
        return H.workerProcessors[keys[0]];
    }

    it('job stale (>15min) viene scartato PRIMA di eseguire daily-reset', async () => {
        await processor()({ name: 'daily-reset', data: { scheduledAt: Date.now() - 16 * 60 * 1000 } });
        expect(H.prisma.player.updateMany).not.toHaveBeenCalled();
    });

    it('job stale viene scartato PRIMA di check-timeouts (prima del fix girava comunque)', async () => {
        await processor()({ name: 'check-timeouts', data: { scheduledAt: Date.now() - 16 * 60 * 1000 } });
        expect(H.mockCheckMatchTimeouts).not.toHaveBeenCalled();
    });

    it('job fresco esegue normalmente (daily-reset azzera i contatori)', async () => {
        await processor()({ name: 'daily-reset', data: {} });
        expect(H.prisma.player.updateMany).toHaveBeenCalledWith({
            data: { dailyMessagesCount: 0, morningContactsToday: 0, afternoonContactsToday: 0 },
        });
    });

    it('job fresco con scheduledAt recente (<15min) esegue normalmente', async () => {
        await processor()({ name: 'check-timeouts', data: { scheduledAt: Date.now() - 5 * 60 * 1000 } });
        expect(H.mockCheckMatchTimeouts).toHaveBeenCalledTimes(1);
    });

    it('process-match-outcomes: finestra di recupero 48h→2h (downtime-proof, niente feedback mid-partita)', async () => {
        await processor()({ name: 'process-match-outcomes', data: {} });
        const args: any = H.prisma.match.findMany.mock.calls.at(-1)?.[0];
        const ageGte = Date.now() - args.where.startTime.gte.getTime();
        const ageLte = Date.now() - args.where.startTime.lte.getTime();
        expect(ageGte).toBeGreaterThan(47.9 * 3600_000);  // ~48h indietro: i riavvii non perdono partite
        expect(ageGte).toBeLessThan(48.1 * 3600_000);
        expect(ageLte).toBeGreaterThan(1.9 * 3600_000);   // ~2h: mai feedback a partita in corso
        expect(ageLte).toBeLessThan(2.1 * 3600_000);
    });

    it('computeNextWaveDelayMs: tutte le soglie temporali corrette, stop sotto i 60min', () => {
        expect(computeNextWaveDelayMs(1441)).toBe(3 * 60 * 60 * 1000);
        expect(computeNextWaveDelayMs(721)).toBe(2 * 60 * 60 * 1000);
        expect(computeNextWaveDelayMs(361)).toBe(90 * 60 * 1000);
        expect(computeNextWaveDelayMs(121)).toBe(25 * 60 * 1000);
        expect(computeNextWaveDelayMs(61)).toBe(10 * 60 * 1000);
        expect(computeNextWaveDelayMs(60)).toBeNull();
        expect(computeNextWaveDelayMs(30)).toBeNull();
    });

    it('humanSendDelayMs: sempre nel range anti-ban 8s–900s', () => {
        for (let i = 0; i < 200; i++) {
            const d = humanSendDelayMs();
            expect(d).toBeGreaterThanOrEqual(8_000);
            expect(d).toBeLessThanOrEqual(900_000);
        }
    });

    it('night window: 02:00 Rome è notte, 12:00 no; msUntil8amRome > 0 solo di notte', () => {
        const night = new Date('2026-06-12T00:30:00.000Z');  // 02:30 Rome (CEST)
        const day = new Date('2026-06-12T10:00:00.000Z');    // 12:00 Rome
        expect(isNightInRome(night)).toBe(true);
        expect(isNightInRome(day)).toBe(false);
        expect(msUntil8amRome(night)).toBeGreaterThan(0);
        expect(msUntil8amRome(night)).toBeLessThanOrEqual(7 * 3600_000); // max ~5.5h + jitter
        expect(msUntil8amRome(day)).toBe(0);
    });
});
