/**
 * TEST AUDIT 11/06/2026 — redirect.ts
 *
 * L2: l'orario mostrato/classificato è SEMPRE in Europe/Rome (fix cd2a504)
 * L3: dedup per-orario — due redirect ravvicinati con orari diversi passano entrambi (fix be8c3eb)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const H = vi.hoisted(() => {
    const nxKeys = new Set<string>();
    const redisMock = {
        get: vi.fn(async (..._a: any[]) => null),
        set: vi.fn(async (k: string, _v: string, ...rest: any[]) => {
            if (rest.includes('NX')) {
                if (nxKeys.has(k)) return null;
                nxKeys.add(k);
                return 'OK';
            }
            return 'OK';
        }),
        del: vi.fn(async (..._a: any[]) => 1),
    };
    return {
        nxKeys,
        redisMock,
        mockSend: vi.fn(async (..._a: any[]) => undefined),
        mockSendRaw: vi.fn(async (..._a: any[]) => undefined),
        mockAnthropicCreate: vi.fn(),
        prisma: {
            club: { findUnique: vi.fn(async (..._a: any[]) => ({ matchDuration: 90 })) },
            court: { findMany: vi.fn(async (..._a: any[]) => [] as any[]) },
            match: { findUnique: vi.fn(), findMany: vi.fn(async (..._a: any[]) => [] as any[]), create: vi.fn(async (..._a: any[]) => ({ id: 'm-new' })) },
            matchPlayer: { create: vi.fn(async (..._a: any[]) => ({})), findMany: vi.fn(async (..._a: any[]) => []) },
            invitation: { create: vi.fn(async (..._a: any[]) => ({})) },
            player: { findFirst: vi.fn(async (..._a: any[]) => ({ id: 'p-ref', skillLevel: 3 })) },
        } as any,
    };
});

vi.mock('pino', () => ({ default: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
vi.mock('../services/db', () => ({ prisma: H.prisma }));
vi.mock('../services/queue', () => ({ getRedis: () => H.redisMock, waveQueue: { add: vi.fn(async (..._a: any[]) => ({})) }, connection: {} }));
vi.mock('../services/whatsapp', () => ({
    simulateTypingAndSend: H.mockSend,
    sendMessage: H.mockSendRaw,
    getSock: vi.fn(() => null),
    dissolveGroup: vi.fn(),
}));
vi.mock('../services/ai', () => ({ anthropic: { messages: { create: H.mockAnthropicCreate } } }));
vi.mock('../services/conversation-state', () => ({
    setState: vi.fn(async (..._a: any[]) => undefined),
    getState: vi.fn(async (..._a: any[]) => null),
    clearState: vi.fn(async (..._a: any[]) => undefined),
}));
vi.mock('../services/brain', async (importOriginal) => {
    const real: any = await importOriginal();
    return { ...real, joinExistingMatch: vi.fn() };
});

import { confirmRedirectChoice, redirectGroup, findRedirectOptions } from '../services/redirect';

// 16:00 UTC del 12 giugno = 18:00 Europe/Rome (CEST, UTC+2)
const SLOT_UTC = '2026-06-12T16:00:00.000Z';
const ROME_HOUR = '18:00';
const UTC_HOUR = '16:00';

const baseGroup = (startTime: string | Date) => ({
    referentPhone: '393331112222',
    referentJid: '393331112222@s.whatsapp.net',
    playerPhones: ['393331112222'],
    playerCount: 1,
    originalMatchId: 'none',
    originalStartTime: startTime as any,
    originalSkillLevel: 0,
    originalCourtIsCovered: null,
    reason: 'SLOT_TAKEN' as const,
    clubId: 'club-1',
    intent: 'BOOK_FIELD' as const,
});

beforeEach(() => {
    vi.clearAllMocks();
    H.nxKeys.clear();
    H.prisma.club.findUnique.mockResolvedValue({ matchDuration: 90 });
    H.prisma.court.findMany.mockResolvedValue([]);
    H.prisma.match.findMany.mockResolvedValue([]);
    H.prisma.match.create.mockResolvedValue({ id: 'm-new' });
    H.prisma.player.findFirst.mockResolvedValue({ id: 'p-ref', skillLevel: 3 });
});

describe('L2 — orari sempre in Europe/Rome (mai UTC)', () => {
    it('resolveChoice: il classificatore vede gli stessi orari mostrati all\'utente (18:00, non 16:00)', async () => {
        H.mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '1' }] });

        await confirmRedirectChoice('393331112222@s.whatsapp.net', 'ok per le 18', {
            group: baseGroup(SLOT_UTC),
            options: [{
                priority: 1, court: 'Campo 1', courtId: 'c-1', courtIsCovered: false,
                startTime: SLOT_UTC as any, willLock: false, isOpenMatch: false,
                description: `Campo 1 scoperto — venerdì 12 giugno alle ${ROME_HOUR}`,
            }],
        } as any);

        // Il prompt passato ad Haiku deve contenere l'ora di Roma, NON quella UTC:
        // prima del fix l'utente vedeva 18:00 ma il classificatore riceveva 16:00 → scelta sbagliata
        const prompt: string = H.mockAnthropicCreate.mock.calls[0][0].messages[0].content;
        expect(prompt).toContain(`alle ${ROME_HOUR}`);
        expect(prompt).not.toContain(`alle ${UTC_HOUR}`);
    });

    it('conferma prenotazione da redirect: "per le 18:00", non "per le 16:00"', async () => {
        H.mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '1' }] });

        await confirmRedirectChoice('393331112222@s.whatsapp.net', '1', {
            group: baseGroup(SLOT_UTC),
            options: [{
                priority: 1, court: 'Campo 1', courtId: 'c-1', courtIsCovered: false,
                startTime: SLOT_UTC as any, willLock: false, isOpenMatch: false, description: 'x',
            }],
        } as any);

        // BOOK_FIELD redirect → match privato LOCKED creato + conferma al referente
        expect(H.prisma.match.create).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ status: 'LOCKED', isPrivateBooking: true, courtId: 'c-1' }),
        }));
        const confirmation = H.mockSend.mock.calls.map((c: any) => String(c[1])).find((m: string) => m.includes('prenotato'));
        expect(confirmation).toBeDefined();
        expect(confirmation).toContain(ROME_HOUR);
        expect(confirmation).not.toContain(UTC_HOUR);
    });

    it('scelta non chiara: chiede chiarimento al 1° tentativo, sblocca al 2°', async () => {
        H.mockAnthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: 'UNCLEAR' }] });
        H.redisMock.get.mockResolvedValueOnce(null as any);   // attempts = 0 → 1
        const state = {
            group: baseGroup(SLOT_UTC),
            options: [{ priority: 1, court: 'Campo 1', courtId: 'c-1', courtIsCovered: false, startTime: SLOT_UTC as any, willLock: false, isOpenMatch: false, description: 'x' }],
        } as any;

        await confirmRedirectChoice('393331112222@s.whatsapp.net', 'boh', state);
        expect(H.prisma.match.create).not.toHaveBeenCalled();
        expect(H.mockSend).toHaveBeenCalledTimes(1); // chiarimento

        H.redisMock.get.mockResolvedValueOnce('1' as any);    // attempts = 1 → 2 → sblocca
        await confirmRedirectChoice('393331112222@s.whatsapp.net', 'mah', state);
        expect(H.mockSend).toHaveBeenCalledTimes(2);
        expect(String(H.mockSend.mock.calls[1][1])).toContain('Nessun problema');
    });
});

describe('L3 — dedup redirect per-orario (race e richieste ravvicinate)', () => {
    it('due booking falliti ravvicinati con ORARI DIVERSI ricevono entrambi le alternative', async () => {
        const t1 = new Date('2026-06-13T16:00:00.000Z');
        const t2 = new Date('2026-06-14T16:00:00.000Z');

        await redirectGroup(baseGroup(t1) as any);
        await redirectGroup(baseGroup(t2) as any);

        // Entrambi i redirect inviati (con courts=[] il messaggio è il fallback "nessuna disponibilità")
        expect(H.mockSend).toHaveBeenCalledTimes(2);

        // Le chiavi di lock includono il timestamp → diverse
        const lockKeys = H.redisMock.set.mock.calls
            .map((c: any) => String(c[0]))
            .filter((k: string) => k.startsWith('redirect:sent:'));
        expect(lockKeys).toHaveLength(2);
        expect(lockKeys[0]).not.toBe(lockKeys[1]);
        expect(lockKeys[0]).toContain(String(t1.getTime()));
        expect(lockKeys[1]).toContain(String(t2.getTime()));
    });

    it('STESSO orario in parallelo: il secondo job è deduplicato (nessun doppio messaggio)', async () => {
        const t = new Date('2026-06-15T16:00:00.000Z');

        await redirectGroup(baseGroup(t) as any);
        await redirectGroup(baseGroup(t) as any); // stesso jid+matchId+reason+orario → NX nega

        expect(H.mockSend).toHaveBeenCalledTimes(1);
    });
});

describe('L3 — filtro genere sulle opzioni matchmaking del redirect', () => {
    const REF = new Date('2026-06-13T15:00:00.000Z'); // 17:00 Rome

    const maleOnly = {
        id: 'm-male', playersNeeded: 4, startTime: new Date('2026-06-13T16:00:00.000Z'),
        courtId: 'c1', court: { name: 'Campo 1', isCovered: false },
        isMixed: false, targetGender: 'MALE',
        MatchPlayer: [{ player: { gender: 'MALE' } }, { player: { gender: 'MALE' } }, { player: { gender: 'MALE' } }],
    };
    const mixedOneFemaleSpot = {
        id: 'm-mixed', playersNeeded: 4, startTime: new Date('2026-06-13T13:00:00.000Z'),
        courtId: 'c2', court: { name: 'Campo 2', isCovered: true },
        isMixed: true, targetGender: 'ANY',
        MatchPlayer: [{ player: { gender: 'MALE' } }, { player: { gender: 'MALE' } }, { player: { gender: 'FEMALE' } }],
    };

    it('a una donna NON viene proposta la partita solo-uomini (resta solo la mista con posto donna)', async () => {
        H.prisma.match.findMany.mockResolvedValueOnce([maleOnly, mixedOneFemaleSpot] as any);
        const options = await findRedirectOptions(1, REF, 'none', 'club-1', 3, null, 'MATCHMAKING', ['FEMALE']);
        expect(options.map(o => o.matchId)).toEqual(['m-mixed']);
    });

    it('a un uomo NON viene proposta la mista con quota uomini piena (resta la solo-uomini)', async () => {
        H.prisma.match.findMany.mockResolvedValueOnce([maleOnly, mixedOneFemaleSpot] as any);
        const options = await findRedirectOptions(1, REF, 'none', 'club-1', 3, null, 'MATCHMAKING', ['MALE']);
        expect(options.map(o => o.matchId)).toEqual(['m-male']);
    });

    it('gruppo 2M+1F: passa solo la mista con quote residue sufficienti (2 posti uomo + 1 donna)', async () => {
        const mixedTight = { ...mixedOneFemaleSpot, id: 'm-tight', MatchPlayer: [{ player: { gender: 'MALE' } }] };   // liberi: 1M+2F → i 2 uomini non ci stanno
        const mixedRoomy = { ...mixedOneFemaleSpot, id: 'm-roomy', MatchPlayer: [{ player: { gender: 'FEMALE' } }] }; // liberi: 2M+1F → perfetto
        H.prisma.match.findMany.mockResolvedValueOnce([mixedTight, mixedRoomy] as any);
        const options = await findRedirectOptions(3, REF, 'none', 'club-1', 3, null, 'MATCHMAKING', ['MALE', 'MALE', 'FEMALE']);
        expect(options.map(o => o.matchId)).toEqual(['m-roomy']);
    });

    it('tutte le partite incompatibili → fallback automatico sugli slot liberi (mai opzioni-trappola)', async () => {
        H.prisma.match.findMany.mockResolvedValueOnce([maleOnly] as any);
        const options = await findRedirectOptions(1, REF, 'none', 'club-1', 3, null, 'MATCHMAKING', ['FEMALE']);
        // Nessuna partita proponibile → si passa alla ricerca campi liberi (qui courts=[] → 0 opzioni)
        expect(options).toHaveLength(0);
        expect(H.prisma.court.findMany).toHaveBeenCalled(); // prova che il fallback BOOK_FIELD è scattato
    });

    it('senza dati sui generi non si filtra (best-effort, comportamento precedente)', async () => {
        H.prisma.match.findMany.mockResolvedValueOnce([maleOnly, mixedOneFemaleSpot] as any);
        const options = await findRedirectOptions(1, REF, 'none', 'club-1', 3, null, 'MATCHMAKING', []);
        expect(options).toHaveLength(2);
    });
});
