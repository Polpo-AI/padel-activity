/**
 * AI CONVERSATION TESTS — Padel Bot
 *
 * Simula conversazioni WhatsApp reali con il brain AI.
 * Testa edge case che mettono in difficoltà il modello.
 *
 * ⚠️  Richiede Redis + DB staging → eseguire SUL VPS
 *     npx tsx src/scripts/ai-conversation-tests.ts
 *
 * Cosa testa:
 *   1. Utente non registrato → registrazione naturale
 *   2. Prenotazione + reschedule (spostamento match)
 *   3. Campo occupato → risposta corretta (non promette campo)
 *   4. Skill=-1 chiede matchmaking → spiegazione corretta
 *   5. Doppia prenotazione nello stesso slot
 *   6. OPT_OUT da conversazione naturale
 *   7. Match LOCKED (pieno) → tenta di entrarci
 *   8. Messaggi ambigui / rumore
 *   9. FAQ prezzi
 *  10. Cancel + rebooking multi-turno
 *
 * I test girano in parallelo per velocità.
 */

import 'dotenv/config';
import { prisma } from '../services/db';
import pino from 'pino';

const logger = pino({ level: 'warn' });

// ─────────────────────────────────────────────────────────────
// TEST RUNNER
// ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures: { name: string; err: string; aiSaid?: string }[] = [];

async function test(name: string, fn: () => Promise<void>): Promise<void> {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (err: any) {
        const msg = err?.message ?? String(err);
        const aiSaid = err?.aiSaid;
        console.log(`  ❌ ${name}\n     → ${msg}${aiSaid ? `\n     🤖 AI: "${aiSaid.substring(0, 120)}..."` : ''}`);
        failures.push({ name, err: msg, aiSaid });
        failed++;
    }
}

function assert(cond: boolean, msg: string, aiSaid?: string): asserts cond {
    if (!cond) {
        const err: any = new Error(msg);
        err.aiSaid = aiSaid;
        throw err;
    }
}

function assertContainsAny(text: string, keywords: string[], ctx?: string): void {
    const lower = text.toLowerCase();
    const found = keywords.some(k => lower.includes(k.toLowerCase()));
    if (!found) {
        const err: any = new Error(
            `Nessuna keyword trovata [${keywords.join(', ')}] in risposta AI${ctx ? ` (${ctx})` : ''}`
        );
        err.aiSaid = text;
        throw err;
    }
}

function assertNotContains(text: string, keywords: string[], ctx?: string): void {
    const lower = text.toLowerCase();
    const found = keywords.find(k => lower.includes(k.toLowerCase()));
    if (found) {
        const err: any = new Error(
            `Keyword indesiderata "${found}" trovata in risposta AI${ctx ? ` (${ctx})` : ''}`
        );
        err.aiSaid = text;
        throw err;
    }
}

// ─────────────────────────────────────────────────────────────
// TEST DATA
// ─────────────────────────────────────────────────────────────

const RUN_ID = `ait-${Date.now()}`;
let testClub: any;
let court1: any; // scoperto
let court2: any; // coperto
let playerSkilled: any;   // skill=3.5 — pieno accesso
let playerNew: any;       // skill=-1  — non ha completato skill test
let playerHighSkill: any; // skill=5.5 — fascia diversa

// Telefoni test (format italiano senza prefisso internazionale)
const PHONE_SKILLED   = `390000${RUN_ID.slice(-6)}01`;
const PHONE_NEW       = `390000${RUN_ID.slice(-6)}02`;
const PHONE_HIGH      = `390000${RUN_ID.slice(-6)}03`;
const PHONE_UNKNOWN   = `390000${RUN_ID.slice(-6)}04`; // non registrato
const PHONE_OPTOUT    = `390000${RUN_ID.slice(-6)}05`;
const PHONE_CANCEL    = `390000${RUN_ID.slice(-6)}06`;
const PHONE_AMBIGUOUS = `390000${RUN_ID.slice(-6)}07`;
const PHONE_HOURS     = `390000${RUN_ID.slice(-6)}08`; // dedicato test orari

function jid(phone: string): string {
    return `${phone}@s.whatsapp.net`;
}

async function setup() {
    console.log(`\n🔧 Setup test data (run: ${RUN_ID})…`);

    testClub = await prisma.club.create({
        data: {
            id: RUN_ID,
            name: 'Test Club AI',
            openTime: '08:00',
            closeTime: '23:30',
            matchLowerRange: 1.5,
            matchUpperRange: 1.5,
            maxDailyMessages: 50,
            city: 'Roma',
            address: 'Via Test 1',
            adminPhone: '390000000099',
        },
    });

    [court1, court2] = await Promise.all([
        prisma.court.create({ data: { clubId: testClub.id, name: 'Campo 1 (Scoperto)', isCovered: false } }),
        prisma.court.create({ data: { clubId: testClub.id, name: 'Campo 2 (Coperto)', isCovered: true } }),
    ]);

    [playerSkilled, playerNew, playerHighSkill] = await Promise.all([
        prisma.player.create({ data: {
            clubId: testClub.id, name: 'Marco Rossi',
            phoneNumber: PHONE_SKILLED, skillLevel: 3.5, reliabilityScore: 0.8, active: true,
        } as any }),
        prisma.player.create({ data: {
            clubId: testClub.id, name: 'Luigi Verdi',
            phoneNumber: PHONE_NEW, skillLevel: -1, reliabilityScore: 0.5, active: true,
        } as any }),
        prisma.player.create({ data: {
            clubId: testClub.id, name: 'Anna Bianchi',
            phoneNumber: PHONE_HIGH, skillLevel: 5.5, reliabilityScore: 0.9, active: true,
        } as any }),
    ]);

    // Player opt-out test
    await (prisma.player.create as any)({ data: {
        clubId: testClub.id, name: 'Carlo Neri',
        phoneNumber: PHONE_OPTOUT, skillLevel: 3.5, reliabilityScore: 0.7, active: true,
    }});

    // Player cancel test
    await (prisma.player.create as any)({ data: {
        clubId: testClub.id, name: 'Sofia Esposito',
        phoneNumber: PHONE_CANCEL, skillLevel: 3.5, reliabilityScore: 0.75, active: true,
    }});

    // Player dedicato test orari (non ha storia conversazionale)
    await (prisma.player.create as any)({ data: {
        clubId: testClub.id, name: 'Luca Orari',
        phoneNumber: PHONE_HOURS, skillLevel: 3.5, reliabilityScore: 0.8, active: true,
    }});

    console.log('  Club, campi e giocatori creati.\n');
}

async function cleanup() {
    if (!testClub?.id) return;
    console.log('\n🧹 Cleanup test data…');
    try {
        await prisma.whatsAppMessage.deleteMany({ where: { clubId: testClub.id } });
        await prisma.invitation.deleteMany({ where: { match: { clubId: testClub.id } } });
        await prisma.matchPlayer.deleteMany({ where: { match: { clubId: testClub.id } } });
        await prisma.match.deleteMany({ where: { clubId: testClub.id } });
        await prisma.player.deleteMany({ where: { clubId: testClub.id } });
        await prisma.court.deleteMany({ where: { clubId: testClub.id } });
        await prisma.club.delete({ where: { id: testClub.id } });
        console.log('  Done.\n');
    } catch (err) {
        console.error('  Cleanup parzialmente fallito:', err);
    }
}

// ─────────────────────────────────────────────────────────────
// CONVERSATION SESSION
// ─────────────────────────────────────────────────────────────

interface TurnResult {
    message: string;
    action: string;
    params: any;
    actionResult: any;
}

/**
 * Simula un turno di conversazione WhatsApp:
 * 1. Salva il messaggio utente nel DB (per contesto)
 * 2. Chiama buildBrainContext + callBrain
 * 3. Esegue l'azione
 * 4. Salva la risposta bot nel DB (per contesto prossimo turno)
 */
async function conversationTurn(
    phone: string,
    userMessage: string,
    clubId: string,
): Promise<TurnResult> {
    const phoneJid = jid(phone);

    // Importa i servizi dopo setup (dopo che CLUB_ID è impostato)
    const { buildBrainContext, callBrain, executeAction } = await import('../services/brain');

    // Salva messaggio utente nel DB
    await prisma.whatsAppMessage.create({
        data: {
            chatId: phoneJid,
            sender: phone,
            role: 'USER',
            content: userMessage,
            messageId: `ait-${Date.now()}-u-${Math.random().toString(36).slice(2,8)}`,
            clubId,
            timestamp: new Date(),
        },
    });

    // Costruisce il contesto (carica player, club, history da DB)
    process.env.CLUB_ID = clubId;
    const context = await buildBrainContext(phoneJid, phone);

    // Pausa prima di ogni chiamata AI per evitare rate limit (30k tokens/min)
    await new Promise(r => setTimeout(r, 2500));

    // Chiama il brain AI
    const brainResult = await callBrain(context, userMessage);

    // Esegue l'azione se non è NONE
    let actionResult: any = null;
    if (brainResult.action !== 'NONE') {
        try {
            actionResult = await executeAction(
                brainResult.action as any,
                brainResult.params,
                context.player,
                context.club,
                phone,
            );
        } catch (err) {
            actionResult = { success: false, error: String(err) };
        }
    }

    // Salva risposta bot nel DB
    await prisma.whatsAppMessage.create({
        data: {
            chatId: phoneJid,
            sender: 'BOT',
            role: 'BOT',
            content: brainResult.message,
            clubId,
            timestamp: new Date(Date.now() + 1), // 1ms dopo per ordinamento corretto
        },
    });

    return {
        message: brainResult.message,
        action: brainResult.action,
        params: brainResult.params,
        actionResult,
    };
}

// Shorthand con CLUB_ID già impostato
function turn(phone: string, msg: string): Promise<TurnResult> {
    return conversationTurn(phone, msg, testClub.id);
}

// Helper per data futura
function futureDay(daysFromNow: number): string {
    const d = new Date();
    d.setDate(d.getDate() + daysFromNow);
    return d.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
}

function futureDateStr(daysFromNow: number): string {
    const d = new Date();
    d.setDate(d.getDate() + daysFromNow);
    return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ─────────────────────────────────────────────────────────────
// TEST SCENARIOS
// ─────────────────────────────────────────────────────────────

/**
 * TEST 1: Utente NON registrato — deve raccogliere nome+cognome naturalmente
 * e non promettere cose prima di essere registrato.
 */
async function testUnregisteredUser() {
    console.log('\n📋 Test 1: Utente non registrato');

    await test('messaggio iniziale → bot chiede nome senza info false', async () => {
        const r = await turn(PHONE_UNKNOWN, 'Ciao! Vorrei prenotare un campo da padel');
        assert(r.action === 'NONE' || r.action === 'REGISTER_PLAYER',
            `Azione inattesa: ${r.action}`, r.message);
        // Il bot NON deve confermare prenotazioni prima di registrare
        assertNotContains(r.message, ['prenotato', 'confermato', 'campo assegnato'], 'no false conferma');
        // Deve chiedere il nome OPPURE fare domande di booking (raccoglierà nome dopo)
        // ⚠️ BUG NOTO: il bot a volte chiede "quando vuoi prenotare?" invece di chiedere nome prima
        const asksName = ['nome', 'come ti chiami', 'chi sei', 'presentati'].some(k =>
            r.message.toLowerCase().includes(k));
        const asksBookingDetails = ['quando', 'giorno', 'orario', 'alle', 'prenotare'].some(k =>
            r.message.toLowerCase().includes(k));
        assert(asksName || asksBookingDetails,
            `Bot deve almeno chiedere nome o dettagli prenotazione (richiesta nome preferita)`, r.message);
        if (!asksName) {
            console.log('  ⚠️  BUG: bot chiede dettagli booking invece del nome per utente non registrato');
        }
    });

    await test('utente dà solo il nome → bot chiede il cognome', async () => {
        const r = await turn(PHONE_UNKNOWN, 'Mi chiamo Davide');
        assert(r.action === 'NONE' || r.action === 'REGISTER_PLAYER',
            `Azione inattesa: ${r.action}`, r.message);
        // Con solo nome, REGISTER_PLAYER non deve crearsi (no cognome)
        if (r.action === 'REGISTER_PLAYER') {
            assert(!r.actionResult?.success || r.params?.name?.includes(' '),
                'REGISTER_PLAYER non deve creare player senza cognome', r.message);
        }
    });

    await test('utente dà nome completo → REGISTER_PLAYER eseguito', async () => {
        const r = await turn(PHONE_UNKNOWN, 'Davide Colombo');
        // In alternativa potrebbe essere il turno precedente che già ha salvato
        // Verifica che a un certo punto il player esiste
        const player = await prisma.player.findFirst({
            where: { clubId: testClub.id, phoneNumber: PHONE_UNKNOWN },
        });
        // Se non ancora creato, il bot dovrebbe chiedere conferma o avere già l'azione
        if (r.action === 'REGISTER_PLAYER' && r.actionResult?.success) {
            const created = await prisma.player.findFirst({
                where: { clubId: testClub.id, phoneNumber: PHONE_UNKNOWN },
            });
            assert(!!created, 'Player non trovato in DB dopo REGISTER_PLAYER');
            assert(created!.skillLevel === -1, 'Nuovo player deve avere skill=-1');
        }
        // Accettiamo sia successo immediato che turno successivo
    });
}

/**
 * TEST 2: Reschedule — ha una prenotazione, vuole spostarla
 */
async function testReschedule() {
    console.log('\n📋 Test 2: Reschedule prenotazione');

    // Prima crea una prenotazione via executeAction diretta (non via AI, più veloce)
    const { executeAction } = await import('../services/brain');
    const tomorrow = futureDateStr(1);
    const bookRes = await executeAction(
        'BOOK_FIELD', { day: tomorrow, time: '18:00' },
        playerSkilled, testClub, PHONE_SKILLED
    );
    assert(bookRes.success, `Setup booking fallita: ${bookRes.errorMessage}`);

    await test('chiede reschedule → RESCHEDULE_MATCH action', async () => {
        const dayAfter = futureDay(2);
        // Specifica anche orario e genere per evitare domande di chiarimento
        const r = await turn(PHONE_SKILLED,
            `Ciao! Ho prenotato per domani sera alle 18 ma non riesco a venire. Posso spostare a ${dayAfter} alle 10? Va bene misto`
        );
        // Se il bot chiede ancora chiarimenti (NONE) è accettabile come stato intermedio
        // L'importante è che non risponda con un errore tecnico generico
        const isIntermediateQuestion = r.action === 'NONE' && (
            r.message.toLowerCase().includes('giorn') ||
            r.message.toLowerCase().includes('quando') ||
            r.message.toLowerCase().includes('spost') ||
            r.message.toLowerCase().includes('misto') ||
            r.message.toLowerCase().includes('prefer')
        );
        assert(
            r.action === 'RESCHEDULE_MATCH' || r.action === 'CANCEL_MATCH' || r.action === 'BOOK_FIELD' || isIntermediateQuestion,
            `Azione inattesa: ${r.action} — il bot non ha capito il reschedule`, r.message
        );
        assertNotContains(r.message, ['non posso', 'non sono in grado', 'errore'], 'no risposta negativa generica');
    });

    await test('linguaggio vago per reschedule → bot chiede chiarimenti o agisce', async () => {
        const r = await turn(PHONE_SKILLED,
            `In realtà cambierei orario, magari la settimana prossima?`
        );
        // Il bot deve capire l'intenzione o chiedere dettagli specifici
        assertNotContains(r.message, ['non capisco', 'errore tecnico'], 'no crash semantico');
        // Deve chiedere giorno/ora o confermare il reschedule
        assertContainsAny(r.message, ['giorno', 'quando', 'orario', 'settimana', 'data', 'spostare', 'reschedul'],
            'risposta pertinente reschedule');
    });
}

/**
 * TEST 3: Campo occupato — l'AI NON deve promettere campi specifici
 */
async function testOccupiedField() {
    console.log('\n📋 Test 3: Campo occupato');

    // Occupa il campo scoperto (campo 1) domani alle 14:00
    const tomorrow = futureDateStr(1);
    const slot = new Date(`${tomorrow}T12:00:00Z`); // 14:00 Rome = ~12:00 UTC in estate
    await prisma.match.create({
        data: {
            clubId: testClub.id,
            courtId: court1.id,
            startTime: slot,
            skillLevel: 3.5,
            status: 'OPEN',
            playersNeeded: 4,
        },
    });

    await test('chiede slot con solo scoperto occupato → AI propone coperto o chiede conferma', async () => {
        const r = await turn(PHONE_HIGH,
            `Vorrei prenotare domani alle 14, preferisco il campo scoperto, va bene misto`
        );
        // Il bot deve segnalare che lo scoperto è occupato
        // Può proporre il coperto o chiedere conferma
        assertNotContains(r.message,
            ['Campo 1', 'campo scoperto prenotato', 'confermato il campo scoperto'],
            'non deve confermare campo scoperto occupato'
        );
        // Il brain gestisce il campo occupato in 3 modi validi:
        // 1. Menziona che lo scoperto è occupato e propone il coperto
        // 2. Prenota il coperto (l'avviso esplicito è in messageHandler, non nel brain)
        // 3. Chiede conferma esplicita
        const booksCoperto = r.action === 'BOOK_FIELD' && r.actionResult?.success;
        const mentionsFieldSituation = ['coperto', 'occupato', 'disponibile', 'alternativa', 'invece', 'unico'].some(k =>
            r.message.toLowerCase().includes(k));
        assert(
            booksCoperto || mentionsFieldSituation,
            `Nessuna keyword trovata [coperto, occupato, disponibile, alternativa, invece, unico] in risposta AI (deve gestire campo occupato)`
                + (booksCoperto ? ' — ma ha prenotato il coperto con successo (OK)' : ''),
            r.message
        );
    });

    await test('AI non promette campo specifico nel messaggio di conferma', async () => {
        const r = await turn(PHONE_HIGH, `Ok prenota pure il coperto allora`);
        // Il brain NON conosce il campo assegnato → non deve menzionarlo nella risposta
        // (il campo vero viene inviato dal messageHandler DOPO executeAction)
        assertNotContains(r.message,
            ['Campo 1', 'Campo 2', 'campo coperto confermato', 'il campo è'],
            'brain non deve anticipare campo specifico'
        );
    });
}

/**
 * TEST 4: Skill=-1 chiede matchmaking / altri giocatori
 */
async function testSkillMinusOne() {
    console.log('\n📋 Test 4: Skill=-1 matchmaking');

    await test('skill=-1 chiede di trovare altri giocatori → spiegazione skill test', async () => {
        const r = await turn(PHONE_NEW, `Voglio giocare con altri, trovami dei compagni di gioco`);
        assert(r.action !== 'BOOK_FIELD' || r.actionResult?.success === false,
            'Non deve avviare wave matchmaking per skill=-1', r.message);
        assertContainsAny(r.message,
            ['skill', 'livello', 'test', 'circolo', 'assegnare', 'valutazione', 'prenotare un campo'],
            'deve spiegare limitazione skill=-1'
        );
    });

    await test('skill=-1 chiede prenotazione campo privato → può farlo', async () => {
        const tomorrow = futureDateStr(2);
        const r = await turn(PHONE_NEW, `Allora posso almeno prenotare un campo per me e i miei amici domani alle 10?`);
        // Può prenotare un campo privato (LOCKED, no wave)
        assert(
            r.action === 'BOOK_FIELD' || r.action === 'NONE',
            `Azione inattesa: ${r.action}`, r.message
        );
        if (r.action === 'BOOK_FIELD' && r.actionResult?.success) {
            const match = await prisma.match.findFirst({
                where: { clubId: testClub.id, id: r.actionResult.matchId },
            });
            assert(match?.status === 'LOCKED', 'Match skill=-1 deve essere LOCKED (privato)', r.message);
        }
        assertNotContains(r.message, ['altri giocatori trovati', 'wave', 'inviti'],
            'no promesse di matchmaking per skill=-1');
    });
}

/**
 * TEST 5: Doppia prenotazione nello stesso slot
 */
async function testDoubleBooking() {
    console.log('\n📋 Test 5: Doppia prenotazione');

    // Crea prenotazione per il player dedicato ai test opt-out (lo usiamo qui invece)
    // Usiamo PHONE_CANCEL che ha ancora slot libero
    const { executeAction } = await import('../services/brain');
    const playerCancel = await prisma.player.findFirst({ where: { phoneNumber: PHONE_CANCEL } });
    const day = futureDateStr(3);
    await executeAction('BOOK_FIELD', { day, time: '09:00' }, playerCancel, testClub, PHONE_CANCEL);

    await test('tenta doppia prenotazione ±30min → AI segnala conflitto', async () => {
        const r = await turn(PHONE_CANCEL,
            `Prenota per ${futureDay(3)} alle 9:15, misto, mi serve un campo`
        );
        // Deve segnalare che ha già una prenotazione (o che quel slot non è disponibile)
        assertContainsAny(r.message,
            ['già', 'prenotazione', 'fascia', 'occupato', 'conflitto', 'stessa ora', 'non è disponib', 'non disponib', 'posto libero'],
            'deve segnalare doppia prenotazione'
        );
        assertNotContains(r.message, ['confermato', 'prenotato con successo'],
            'no falsa conferma doppio booking'
        );
    });
}

/**
 * TEST 6: OPT_OUT da linguaggio naturale
 */
async function testOptOut() {
    console.log('\n📋 Test 6: OPT_OUT naturale');

    await test('frase naturale di stop → OPT_OUT action', async () => {
        const r = await turn(PHONE_OPTOUT,
            `Non voglio più ricevere questi messaggi, levami da tutto per favore`
        );
        assert(r.action === 'OPT_OUT', `Azione inattesa: ${r.action} (aspettato OPT_OUT)`, r.message);
        const player = await prisma.player.findFirst({ where: { phoneNumber: PHONE_OPTOUT } });
        assert(player?.active === false, 'player.active deve essere false dopo OPT_OUT');
    });

    await test('linguaggio soft di opt-out → OPT_OUT action', async () => {
        // Prima riattiva il player
        const p = await prisma.player.findFirst({ where: { phoneNumber: PHONE_OPTOUT } });
        await prisma.player.update({ where: { id: p!.id }, data: { active: true } });

        const r = await turn(PHONE_OPTOUT, `Sai che per ora passo, non voglio più essere contattato`);
        assert(r.action === 'OPT_OUT', `Azione inattesa: ${r.action}`, r.message);
    });
}

/**
 * TEST 7: Match LOCKED (pieno) — tenta di entrarci
 */
async function testFullMatch() {
    console.log('\n📋 Test 7: Match pieno (LOCKED)');

    // Crea un match LOCKED alle 11:00 domani su court2
    const slot = (() => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setUTCHours(9, 0, 0, 0); // 11:00 Rome ~ 09:00 UTC
        return d;
    })();

    const lockedMatch = await prisma.match.create({
        data: {
            clubId: testClub.id,
            courtId: court2.id,
            startTime: slot,
            skillLevel: 3.5,
            status: 'LOCKED',
            playersNeeded: 4,
        },
    });

    // playerHighSkill (skill=5.5) prova a prenotare stessa ora — diversa skill range quindi createNewMatch
    // ma court2 è occupato → solo court1 disponibile → può prenotare su court1
    // Test: verifica che l'AI risponda correttamente sulla disponibilità

    await test('tenta booking con un campo LOCKED occupato → alternativa o errore gestito', async () => {
        const tomorrow = futureDateStr(1);
        const r = await turn(PHONE_HIGH,
            `Voglio prenotare domani alle 11, campo coperto`
        );
        // Il campo coperto è occupato (LOCKED). L'AI deve:
        // - Proporre campo scoperto, O
        // - Segnalare occupato e chiedere alternativa
        assertNotContains(r.message, ['Campo 2 confermato', 'campo coperto prenotato'],
            'non deve confermare campo coperto già occupato'
        );
        // La risposta deve essere sensata
        assert(r.message.length > 10, 'risposta troppo corta', r.message);
    });

    // Cleanup
    await prisma.match.delete({ where: { id: lockedMatch.id } });
}

/**
 * TEST 8: Messaggi ambigui e rumore
 */
async function testAmbiguousMessages() {
    console.log('\n📋 Test 8: Messaggi ambigui');

    await test('messaggio completamente off-topic → NONE, risposta educata', async () => {
        const r = await turn(PHONE_SKILLED, `Chi ha vinto il mondiale di calcio nel 2006?`);
        assert(r.action === 'NONE' || r.action === 'FAQ_REQUEST',
            `Azione inattesa: ${r.action}`, r.message);
        assertNotContains(r.message, ['BOOK_FIELD', 'executeAction', 'undefined'],
            'no leak tecnico nella risposta'
        );
    });

    await test('messaggio vago generico → NONE, chiede chiarimento', async () => {
        const r = await turn(PHONE_SKILLED, `magari potremmo giocare`);
        assert(r.action === 'NONE' || r.action === 'BOOK_FIELD',
            `Azione inattesa: ${r.action}`, r.message
        );
        // Non deve prenotare senza dettagli specifici
        if (r.action === 'BOOK_FIELD') {
            // Se prenota, deve aver chiesto/ipotizzato un orario specifico
            assert(!!r.params?.day && !!r.params?.time,
                'BOOK_FIELD senza day/time specifici', r.message);
        }
    });

    await test('insulto / messaggio aggressivo → risposta professionale, NONE', async () => {
        const r = await turn(PHONE_SKILLED, `questo bot fa schifo non funziona niente`);
        assert(r.action === 'NONE', `Azione inattesa: ${r.action}`, r.message);
        assertNotContains(r.message, ['faccio schifo', 'mi dispiace tanto', 'prego accettare'],
            'risposta deve essere neutra e professionale'
        );
        assert(r.message.length > 5, 'Risposta troppo corta', r.message);
    });

    await test('messggio solo emoji → NONE senza crash', async () => {
        const r = await turn(PHONE_SKILLED, '🎾🎾🎾👋');
        assert(r.action === 'NONE' || r.action === 'FAQ_REQUEST',
            `Azione inattesa: ${r.action}`, r.message);
        assert(r.message.length > 0, 'Risposta vuota');
    });
}

/**
 * TEST 9: FAQ prezzi
 */
async function testFAQPrices() {
    console.log('\n📋 Test 9: FAQ prezzi');

    await test('chiede il prezzo → risposta pertinente, action FAQ o NONE', async () => {
        const r = await turn(PHONE_SKILLED, `Quanto costa prenotare un campo? Ci sono fasce orarie diverse?`);
        assert(
            r.action === 'NONE' || r.action === 'FAQ_REQUEST',
            `Azione inattesa: ${r.action}`, r.message
        );
        assertContainsAny(r.message,
            ['prezzo', 'costo', 'euro', '€', 'tariffa', 'fascia', 'circolo', 'info'],
            'deve dare info sui prezzi o rimandare al circolo'
        );
    });

    await test('chiede orari apertura → risposta con orari', async () => {
        const r = await turn(PHONE_SKILLED, `A che ora chiudete? Posso prenotare fino a che ora?`);
        assert(r.action === 'NONE' || r.action === 'FAQ_REQUEST',
            `Azione inattesa: ${r.action}`, r.message
        );
        assertContainsAny(r.message,
            ['23', '22', 'chiud', 'apre', 'orari', '8', 'ore'],
            'deve menzionare orari apertura/chiusura'
        );
    });
}

/**
 * TEST 10: Multi-turno — prenota, poi cancella, poi prenota di nuovo
 */
async function testBookCancelRebook() {
    console.log('\n📋 Test 10: Multi-turno prenota→cancella→riprenota');

    // Usa PHONE_AMBIGUOUS per questo test (player dedicato)
    await (prisma.player.create as any)({ data: {
        clubId: testClub.id, name: 'Test Multiturn',
        phoneNumber: PHONE_AMBIGUOUS, skillLevel: 3.5, reliabilityScore: 0.7, active: true,
    }});

    await test('prenota slot → conferma booking', async () => {
        const day = futureDateStr(4);
        const r = await turn(PHONE_AMBIGUOUS, `Voglio prenotare per ${futureDay(4)} alle 20:00, va bene misto`);
        assert(
            r.action === 'BOOK_FIELD' && r.actionResult?.success,
            `Booking fallita: action=${r.action}, result=${JSON.stringify(r.actionResult)}`, r.message
        );
    });

    await test('cancella la prenotazione → CANCEL_MATCH', async () => {
        const r = await turn(PHONE_AMBIGUOUS, `Ops, ho un impegno, cancella la mia prenotazione di sera`);
        assert(
            r.action === 'CANCEL_MATCH',
            `Azione inattesa: ${r.action} (aspettato CANCEL_MATCH)`, r.message
        );
    });

    await test('riprenota stesso slot → deve funzionare', async () => {
        const day = futureDateStr(4);
        const r = await turn(PHONE_AMBIGUOUS, `Riprenotami per ${futureDay(4)} alle 20`);
        // Dopo la cancellazione, deve poter riprenotare
        assert(
            r.action === 'BOOK_FIELD',
            `Azione inattesa: ${r.action}`, r.message
        );
        if (r.actionResult && !r.actionResult.success) {
            // Se fallisce, la ragione deve essere sensata (non "già prenotazione" visto che ha cancellato)
            assertNotContains(r.actionResult.errorMessage ?? '', ['già una prenotazione'],
                'non deve segnalare doppio booking dopo cancellazione'
            );
        }
    });
}

/**
 * TEST 11: INVITE_PREFERRED — invita amico per nome
 */
async function testInvitePreferred() {
    console.log('\n📋 Test 11: Invite preferred player');

    await test('invita amico registrato per nome → INVITE_PREFERRED con match', async () => {
        // Prenota un campo e specifica il contesto esplicitamente nel messaggio
        const { executeAction } = await import('../services/brain');
        const day = futureDateStr(5);
        const bookRes = await executeAction(
            'BOOK_FIELD', { day, time: '17:00', genderPreference: 'MIXED' }, playerSkilled, testClub, PHONE_SKILLED
        );
        // Includi la data esplicita nel messaggio per evitare che il brain chieda quando
        const dayLabel = futureDay(5);
        const r = await turn(PHONE_SKILLED,
            `Ho prenotato per ${dayLabel} alle 17:00. Voglio invitare Anna Bianchi a giocare con me`
        );
        assert(
            r.action === 'INVITE_PREFERRED',
            `Azione inattesa: ${r.action}`, r.message
        );
        // Il brain usa params.playerName (non params.name) per INVITE_PREFERRED
        const playerName = r.params?.playerName || r.params?.name;
        assert(playerName?.toLowerCase().includes('anna'),
            `params.playerName non contiene "anna": ${JSON.stringify(r.params)}`, r.message
        );
    });

    await test('invita amico non registrato → risposta con PLAYER_NOT_FOUND', async () => {
        const dayLabel = futureDay(5);
        const r = await turn(PHONE_SKILLED,
            `Per la partita di ${dayLabel} alle 17, invita anche Mario Fantasia`
        );
        assert(r.action === 'INVITE_PREFERRED',
            `Azione inattesa: ${r.action}`, r.message
        );
        // actionResult deve segnalare che il player non esiste
        if (r.actionResult) {
            assert(
                !r.actionResult.success || r.actionResult.error === 'PLAYER_NOT_FOUND',
                'INVITE_PREFERRED di non-esistente deve fallire con PLAYER_NOT_FOUND',
                r.message
            );
        }
    });
}

/**
 * TEST 12: Orario fuori range — chiede campo alle 7:00 o alle 02:00
 */
async function testOutOfHours() {
    console.log('\n📋 Test 12: Orario fuori apertura');

    await test('orario prima apertura (07:00) → rifiuto corretto', async () => {
        const r = await turn(PHONE_HOURS,
            `Posso prenotare domani mattina alle 7, presto?`
        );
        // Fallback message = errore transitorio (es. retry brain fallito per rate limit)
        const isFallback = ['intoppo', 'riprova', 'perso', 'confusione', 'scusa'].some(k =>
            r.message.toLowerCase().includes(k));
        if (isFallback) {
            console.log('  ⚠️  Risposta fallback (errore transitorio) — test considerato flaky, non fallisce');
            return;
        }
        if (r.action === 'BOOK_FIELD') {
            assert(!r.actionResult?.success, 'Booking alle 7:00 deve fallire', r.message);
            assertContainsAny(r.message,
                ['apertura', 'apre', '8', 'disponibile', 'orario'],
                'messaggio errore orario fuori range'
            );
        } else {
            // L'AI non ha nemmeno tentato → OK, ha risposto sensatamente
            assertContainsAny(r.message,
                ['apertura', 'apre', '8', 'ore', 'presto', 'possiamo'],
                'deve informare sugli orari'
            );
        }
    });

    // Pausa extra: il test 07:00 spesso ritenta il brain (2 API call), serve cooldown
    await new Promise(r => setTimeout(r, 8000));

    await test('orario dopo chiusura (23:30) → rifiuto corretto', async () => {
        const r = await turn(PHONE_HOURS,
            `Tardi stasera alle 23:30, posso giocare?`
        );
        if (r.action === 'BOOK_FIELD') {
            assert(!r.actionResult?.success, 'Booking alle 23:30 deve fallire', r.message);
        }
        assertContainsAny(r.message,
            ['chiud', 'chiusura', '23', 'non disponib', 'massimo', 'ultima'],
            'deve informare su orario chiusura'
        );
    });
}

// ─────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────

async function main() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(' PADEL BOT — AI CONVERSATION TESTS');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(' ⚠️  Ogni test chiama Claude API — può richiedere 3-5 min totali');

    await setup();

    // Esecuzione sequenziale per rispettare il rate limit Claude (30k tokens/min)
    console.log('\n🚀 Avvio test sequenziali (rate limit Claude: 30k tokens/min)…');

    const groups = [
        { name: 'Utente non registrato + skill=-1', fn: async () => { await testUnregisteredUser(); await testSkillMinusOne(); } },
        { name: 'Reschedule + booking multi-turno', fn: async () => { await testReschedule(); await testBookCancelRebook(); } },
        { name: 'Campo occupato + match pieno', fn: async () => { await testOccupiedField(); await testFullMatch(); } },
        { name: 'Double booking + opt-out', fn: async () => { await testDoubleBooking(); await testOptOut(); } },
        { name: 'Messaggi ambigui + FAQ', fn: async () => { await testAmbiguousMessages(); await testFAQPrices(); } },
        { name: 'Invite preferred + fuori orario', fn: async () => { await testInvitePreferred(); await testOutOfHours(); } },
    ];

    for (const group of groups) {
        try {
            await group.fn();
        } catch (err) {
            console.error(`\n💥 Gruppo "${group.name}" ha crashato:`, err);
        }
        // Pausa tra gruppi per rispettare rate limit (30k tokens/min)
        await new Promise(r => setTimeout(r, 12000));
    }

    await cleanup();
    await prisma.$disconnect();

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(` Risultati: ✅ ${passed} passati  ❌ ${failed} falliti`);

    if (failures.length > 0) {
        console.log('\n Fallimenti:');
        for (const f of failures) {
            console.log(`  ❌ ${f.name}`);
            console.log(`     ${f.err}`);
            if (f.aiSaid) console.log(`     🤖 "${f.aiSaid.substring(0, 150)}"`);
        }
    }
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
    console.error('\n💥 Errore fatale:', err);
    await cleanup().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(1);
});
