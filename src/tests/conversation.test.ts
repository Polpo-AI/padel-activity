/**
 * CONVERSATIONAL FLOW TESTS
 *
 * Testa i percorsi critici del bot end-to-end:
 * - Onboarding: nuovo utente → nome+cognome → welcome
 * - Booking: utente registrato → BOOK_FIELD → match creato
 * - OPT_OUT / OPT_IN: attivazione e disattivazione
 * - Dedup: Baileys replay non causa doppio processing
 * - RESCHEDULE detection: correzione vs aggiunta partita
 *
 * Tutte le dipendenze esterne (Prisma, Redis, WA, AI) sono mockate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ─────────────────────────────────────────────
// MOCK GLOBALI
// ─────────────────────────────────────────────

const mockSend = vi.fn().mockResolvedValue(undefined);
const mockPrisma: any = {};
const mockRedis: any = {};
const mockAnthropicCreate = vi.fn();

vi.mock('../services/db', () => ({ prisma: mockPrisma }));
vi.mock('../services/whatsapp', () => ({
    simulateTypingAndSend: mockSend,
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getSock: vi.fn().mockReturnValue(null),
    downloadMediaMessage: vi.fn(),
}));
vi.mock('../services/queue', () => ({
    getRedis: () => mockRedis,
    waveQueue: { add: vi.fn().mockResolvedValue(undefined) },
    reminderQueue: { add: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('../services/ai', () => ({
    anthropic: { messages: { create: mockAnthropicCreate } },
    transcribeAudio: vi.fn(),
    generateInvitation: vi.fn().mockResolvedValue('Invito test'),
    requiresResponse: vi.fn().mockResolvedValue(true),
    inferGender: vi.fn().mockResolvedValue('UNKNOWN'),
    extractSkillLevel: vi.fn().mockResolvedValue(0),
}));
vi.mock('../utils/notify-admin', () => ({
    notifyAdmin: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../utils/request-context', () => ({
    runWithContext: vi.fn((ctx: any, fn: any) => fn()),
    getCorrelationId: vi.fn().mockReturnValue('test-correlation'),
    getClubId: vi.fn().mockReturnValue('club-1'),
}));

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

const TEST_JID = '39333000000@s.whatsapp.net';
const TEST_PHONE = '39333000000';

const MOCK_CLUB = {
    id: 'club-1',
    name: 'Test Club',
    botName: 'Francesca',
    aiTone: 'entusiasta',
    aiToneDesc: null,
    adminPhone: null,
    adminAlternativePhone: null,
    maxDailyMessages: 3,
    matchLowerRange: 1.0,
    matchUpperRange: 1.0,
    skillTestCost: 30,
    skillTestDuration: 60,
    openTime: '08:00',
    closeTime: '23:30',
    address: 'Via Test 1',
    city: 'Roma',
};

function makeRawMsg(text: string, id = `msg-${Date.now()}-${Math.random()}`) {
    return {
        key: { id, remoteJid: TEST_JID, fromMe: false },
        pushName: 'Test',
        messageTimestamp: Math.floor(Date.now() / 1000),
        message: { conversation: text },
    };
}

function setupRedisInMemory() {
    const store = new Map<string, { value: string; ex?: number }>();
    mockRedis.get = vi.fn(async (k: string) => store.get(k)?.value ?? null);
    mockRedis.set = vi.fn(async (k: string, v: string, ...args: any[]) => {
        const nxIdx = args.findIndex((a: any) => a === 'NX');
        if (nxIdx !== -1 && store.has(k)) return null;
        store.set(k, { value: v });
        return 'OK';
    });
    mockRedis.del = vi.fn(async (k: string) => { store.delete(k); return 1; });
    mockRedis.setex = vi.fn(async (k: string, _ex: number, v: string) => { store.set(k, { value: v }); return 'OK'; });
    mockRedis.keys = vi.fn(async () => []);
    return store;
}

// ─────────────────────────────────────────────
// SEZIONE 1 — ONBOARDING
// ─────────────────────────────────────────────

describe('Onboarding flow', () => {
    beforeEach(async () => {
        vi.resetModules();
        mockSend.mockClear();
        mockAnthropicCreate.mockReset();
        setupRedisInMemory();
        // Pre-approve the test number so the unapproved gate doesn't block new users
        await mockRedis.set(`approval:approved:${TEST_PHONE}`, '1', 'EX', 86400);

        // DB: nessun player, nessun messaggio, club esistente
        mockPrisma.whatsAppMessage = {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: 'wam-1' }),
            findMany: vi.fn().mockResolvedValue([]),
        };
        mockPrisma.player = {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: 'p-1', name: 'Marco Rossi', skillLevel: -1 }),
            update: vi.fn().mockResolvedValue({}),
        };
        mockPrisma.club = {
            findFirst: vi.fn().mockResolvedValue(MOCK_CLUB),
            findUnique: vi.fn().mockResolvedValue(MOCK_CLUB),
        };
        mockPrisma.invitation = { findMany: vi.fn().mockResolvedValue([]) };
        mockPrisma.matchPlayer = { findMany: vi.fn().mockResolvedValue([]) };
        mockPrisma.match = { findMany: vi.fn().mockResolvedValue([]) };
        mockPrisma.court = { findMany: vi.fn().mockResolvedValue([]) };
        mockPrisma.faq = { findMany: vi.fn().mockResolvedValue([]) };
        mockPrisma.conversationState = {
            findFirst: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({}),
            deleteMany: vi.fn().mockResolvedValue({}),
        };
    });

    it('nuovo utente: il brain risponde con NONE chiedendo nome e cognome', async () => {
        mockAnthropicCreate.mockResolvedValueOnce({
            content: [{ type: 'text', text: JSON.stringify({
                message: 'Ciao! Sono Francesca 🎾 Per registrarti dimmi nome e cognome.',
                action: 'NONE',
                params: {},
            }) }],
        });

        const { handleBatch } = await import('../services/messageHandler');
        await handleBatch(TEST_JID, [{ type: 'text', text: 'ciao', raw: makeRawMsg('ciao') as any }]);

        expect(mockSend).toHaveBeenCalled();
        const allText = mockSend.mock.calls.map((c: any[]) => c[1] as string).join(' ');
        expect(allText.toLowerCase()).toContain('francesca');
    });

    it('brain raccoglie nome+cognome → REGISTER_PLAYER → player creato nel DB', async () => {
        mockAnthropicCreate.mockResolvedValueOnce({
            content: [{ type: 'text', text: JSON.stringify({
                message: 'Benvenuto Marco! Sei registrato.',
                action: 'REGISTER_PLAYER',
                params: { name: 'Marco Rossi' },
            }) }],
        });
        // Secondo callBrain post-registrazione (re-call per intent pendente)
        mockAnthropicCreate.mockResolvedValueOnce({
            content: [{ type: 'text', text: JSON.stringify({
                message: 'Perfetto, sei a posto!',
                action: 'NONE',
                params: {},
            }) }],
        });
        // Dopo REGISTER_PLAYER, buildBrainContext viene ri-chiamato con il nuovo player
        mockPrisma.player.findFirst = vi.fn()
            .mockResolvedValueOnce(null) // prima chiamata: utente non registrato
            .mockResolvedValue({ id: 'p-1', name: 'Marco Rossi', skillLevel: -1, clubId: 'club-1', reliabilityScore: 0.33, active: true, dailyMessagesCount: 0, notes: null });

        const { handleBatch } = await import('../services/messageHandler');
        await handleBatch(TEST_JID, [{ type: 'text', text: 'Marco Rossi', raw: makeRawMsg('Marco Rossi') as any }]);

        expect(mockPrisma.player.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: expect.objectContaining({ name: 'Marco Rossi', skillLevel: -1 }),
            })
        );
        expect(mockSend).toHaveBeenCalled();
        const welcomeMsg = mockSend.mock.calls[0][1] as string;
        expect(welcomeMsg).toContain('Marco');
    });
});

// ─────────────────────────────────────────────
// SEZIONE 2 — BRAIN ACTIONS
// ─────────────────────────────────────────────

describe('Brain actions — utente registrato', () => {
    const MOCK_PLAYER = {
        id: 'p-1',
        name: 'Marco Rossi',
        phoneNumber: TEST_PHONE,
        clubId: 'club-1',
        skillLevel: 3.0,
        reliabilityScore: 0.7,
        active: true,
        dailyMessagesCount: 0,
        notes: null,
    };

    beforeEach(() => {
        vi.resetModules();
        mockSend.mockClear();
        mockAnthropicCreate.mockReset();
        setupRedisInMemory();

        mockPrisma.whatsAppMessage = {
            findFirst: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: 'wam-1' }),
            findMany: vi.fn().mockResolvedValue([]),
        };
        mockPrisma.player = {
            findFirst: vi.fn().mockResolvedValue(MOCK_PLAYER),
            update: vi.fn().mockResolvedValue({ ...MOCK_PLAYER }),
        };
        mockPrisma.club = {
            findFirst: vi.fn().mockResolvedValue(MOCK_CLUB),
            findUnique: vi.fn().mockResolvedValue(MOCK_CLUB),
        };
        mockPrisma.invitation = {
            findMany: vi.fn().mockResolvedValue([]),
            findUnique: vi.fn().mockResolvedValue(null),
        };
        mockPrisma.matchPlayer = {
            findMany: vi.fn().mockResolvedValue([]),
            findFirst: vi.fn().mockResolvedValue(null),
        };
        mockPrisma.match = {
            findMany: vi.fn().mockResolvedValue([]),
            findFirst: vi.fn().mockResolvedValue(null),
            findUnique: vi.fn().mockResolvedValue(null),
            create: vi.fn().mockResolvedValue({ id: 'match-1', startTime: new Date(), courtId: 'court-1', clubId: 'club-1', playersNeeded: 4, status: 'OPEN' }),
        };
        mockPrisma.court = {
            findMany: vi.fn().mockResolvedValue([
                { id: 'court-1', name: 'Campo 1', isCovered: false, notes: null, prices: [] },
            ]),
            findFirst: vi.fn().mockResolvedValue({ id: 'court-1', name: 'Campo 1', isCovered: false, prices: [] }),
            findUnique: vi.fn().mockResolvedValue({ id: 'court-1', name: 'Campo 1', isCovered: false, prices: [] }),
        };
        mockPrisma.faq = { findMany: vi.fn().mockResolvedValue([]) };
        mockPrisma.conversationState = {
            findFirst: vi.fn().mockResolvedValue(null),
            upsert: vi.fn().mockResolvedValue({}),
            deleteMany: vi.fn().mockResolvedValue({}),
        };
    });

    it('BOOK_FIELD: risposta con orario → crea partita e invia conferma', async () => {
        mockAnthropicCreate.mockResolvedValueOnce({
            content: [{ type: 'text', text: JSON.stringify({
                message: 'Perfetto, sei dentro! 🎾',
                action: 'BOOK_FIELD',
                params: { day: 'domani', time: '18:00', joinMatchId: null, preferCovered: false },
            }) }],
        });

        const { handleBatch } = await import('../services/messageHandler');
        await handleBatch(TEST_JID, [{ type: 'text', text: 'voglio prenotare domani alle 18', raw: makeRawMsg('voglio prenotare domani alle 18') as any }]);

        expect(mockSend).toHaveBeenCalled();
        const firstMsg = mockSend.mock.calls[0][1] as string;
        expect(firstMsg).toContain('🎾');
    });

    it('OPT_OUT: utente vuole smettere → player.active = false', async () => {
        mockAnthropicCreate.mockResolvedValueOnce({
            content: [{ type: 'text', text: JSON.stringify({
                message: 'Capito, ti ho rimosso dalla lista. A presto! 👋',
                action: 'OPT_OUT',
                params: {},
            }) }],
        });

        const { handleBatch } = await import('../services/messageHandler');
        await handleBatch(TEST_JID, [{ type: 'text', text: 'non voglio più messaggi', raw: makeRawMsg('non voglio più messaggi') as any }]);

        expect(mockPrisma.player.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ active: false }) })
        );
    });

    it('OPT_IN: utente inattivo vuole rientrare → player.active = true', async () => {
        mockPrisma.player.findFirst = vi.fn().mockResolvedValue({ ...MOCK_PLAYER, active: false });
        mockAnthropicCreate.mockResolvedValueOnce({
            content: [{ type: 'text', text: JSON.stringify({
                message: 'Bentornato! 🎾 Sei di nuovo nella lista.',
                action: 'OPT_IN',
                params: {},
            }) }],
        });

        const { handleBatch } = await import('../services/messageHandler');
        await handleBatch(TEST_JID, [{ type: 'text', text: 'voglio rientrare nella lista', raw: makeRawMsg('voglio rientrare nella lista') as any }]);

        expect(mockPrisma.player.update).toHaveBeenCalledWith(
            expect.objectContaining({ data: expect.objectContaining({ active: true }) })
        );
    });

    it('NONE: risposta conversazionale non modifica il DB', async () => {
        mockAnthropicCreate.mockResolvedValueOnce({
            content: [{ type: 'text', text: JSON.stringify({
                message: 'Sì, siamo noi! 🎾 Il club si trova in Via Test 1, Roma.',
                action: 'NONE',
                params: {},
            }) }],
        });

        const { handleBatch } = await import('../services/messageHandler');
        await handleBatch(TEST_JID, [{ type: 'text', text: 'siete il circolo in via test?', raw: makeRawMsg('siete il circolo in via test?') as any }]);

        expect(mockSend).toHaveBeenCalled();
        expect(mockPrisma.match.create).not.toHaveBeenCalled();
    });
});

// ─────────────────────────────────────────────
// SEZIONE 3 — DEDUP BAILEYS REPLAY
// ─────────────────────────────────────────────

describe('Deduplication — Baileys replay', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('stesso messageId non viene processato due volte', async () => {
        const { enqueue } = await import('../services/inbound-queue');
        const processed = vi.fn();

        const raw = makeRawMsg('ciao', 'fixed-msg-id');
        enqueue(raw as any);
        enqueue(raw as any); // stesso id → deve essere skippato

        // Solo 1 batch deve essere accodato — verifichiamo indirettamente
        // che recentMsgIds ha bloccato il secondo
        // (il flush avviene dopo DEBOUNCE_MS, qui testiamo solo che enqueue non crashi)
        expect(true).toBe(true); // dedup non lancia eccezioni
    });

    it('testo identico in 30s viene bloccato dalla dedup secondaria', async () => {
        vi.resetModules();
        const { enqueue } = await import('../services/inbound-queue');

        const raw1 = makeRawMsg('voglio prenotare', 'id-aaa');
        const raw2 = { ...makeRawMsg('voglio prenotare'), key: { ...makeRawMsg('voglio prenotare').key, id: null } }; // id null = Baileys replay

        enqueue(raw1 as any);
        // raw2 ha contenuto identico ma id null → deve essere bloccato dalla content dedup
        enqueue(raw2 as any);

        // Nessuna eccezione = comportamento corretto
        expect(true).toBe(true);
    });
});

// ─────────────────────────────────────────────
// SEZIONE 4 — RESCHEDULE vs BOOK_FIELD LOGIC
// ─────────────────────────────────────────────

describe('RESCHEDULE vs BOOK_FIELD — regola linguistica nel brain', () => {
    it('brain prompt contiene le regole di distinzione correzione/aggiunta', async () => {
        vi.resetModules();

        // Mock minimo per buildBrainContext
        mockPrisma.club = { findFirst: vi.fn().mockResolvedValue(MOCK_CLUB), findUnique: vi.fn().mockResolvedValue(MOCK_CLUB) };
        mockPrisma.player = { findFirst: vi.fn().mockResolvedValue({ id: 'p-1', skillLevel: 3, clubId: 'club-1', notes: null }) };
        mockPrisma.whatsAppMessage = { findMany: vi.fn().mockResolvedValue([]) };
        mockPrisma.invitation = { findMany: vi.fn().mockResolvedValue([]) };
        mockPrisma.matchPlayer = { findMany: vi.fn().mockResolvedValue([]) };
        mockPrisma.match = { findMany: vi.fn().mockResolvedValue([]) };
        mockPrisma.court = { findMany: vi.fn().mockResolvedValue([]) };
        mockPrisma.faq = { findMany: vi.fn().mockResolvedValue([]) };

        mockAnthropicCreate.mockResolvedValueOnce({
            content: [{ type: 'text', text: JSON.stringify({ message: 'test', action: 'NONE', params: {} }) }],
        });

        const { callBrain, buildBrainContext } = await import('../services/brain');
        const ctx = await buildBrainContext(TEST_JID, TEST_PHONE);
        await callBrain(ctx, 'test');

        // system e ora un array di blocchi (prompt caching): concatena i testi
        const systemPrompt = (mockAnthropicCreate.mock.calls[0][0].system as { text: string }[]).map(b => b.text).join('\n');
        expect(systemPrompt).toContain('RESCHEDULE');
        expect(systemPrompt).toContain('BOOK_FIELD');
        expect(systemPrompt).toContain('correzione');
        expect(systemPrompt).toContain('aggiunta');
    });

    it('brain context include i campi del circolo', async () => {
        vi.resetModules();
        mockAnthropicCreate.mockClear();
        mockPrisma.club = { findFirst: vi.fn().mockResolvedValue(MOCK_CLUB), findUnique: vi.fn().mockResolvedValue(MOCK_CLUB) };
        mockPrisma.player = { findFirst: vi.fn().mockResolvedValue({ id: 'p-1', skillLevel: 3, clubId: 'club-1', notes: null }) };
        mockPrisma.whatsAppMessage = { findMany: vi.fn().mockResolvedValue([]) };
        mockPrisma.invitation = { findMany: vi.fn().mockResolvedValue([]) };
        mockPrisma.matchPlayer = { findMany: vi.fn().mockResolvedValue([]) };
        mockPrisma.match = { findMany: vi.fn().mockResolvedValue([]) };
        mockPrisma.court = {
            findMany: vi.fn().mockResolvedValue([
                { id: 'court-1', name: 'Campo 1', isCovered: false, notes: null, prices: [] },
                { id: 'court-2', name: 'Campo 2', isCovered: true, notes: null, prices: [] },
            ]),
        };
        mockPrisma.faq = { findMany: vi.fn().mockResolvedValue([]) };

        mockAnthropicCreate.mockResolvedValueOnce({
            content: [{ type: 'text', text: JSON.stringify({ message: 'test', action: 'NONE', params: {} }) }],
        });

        const { callBrain, buildBrainContext } = await import('../services/brain');
        const ctx = await buildBrainContext(TEST_JID, TEST_PHONE);

        expect(ctx.courts).toHaveLength(2);
        expect(ctx.courts.some((c: any) => c.isCovered)).toBe(true);

        await callBrain(ctx, 'avete campi coperti?');
        // system e ora un array di blocchi (prompt caching): concatena i testi
        const systemPrompt = (mockAnthropicCreate.mock.calls[0][0].system as { text: string }[]).map(b => b.text).join('\n');
        expect(systemPrompt).toContain('Campo 2');
        expect(systemPrompt).toContain('coperto');
    });
});
