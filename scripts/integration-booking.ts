/**
 * TEST DI INTEGRAZIONE LOCALE — logica di prenotazione REALE (no mock).
 *
 * Prerequisiti: Postgres su :5433 (scripts/local-pg.ts) + Redis su :6379,
 * .env con DRY_RUN=true e chiavi dummy (nessuna chiamata AI/WhatsApp reale).
 *
 * Esegue executeAction('BOOK_FIELD', ...) di brain.ts contro il DB vero:
 *   T1  booking privato → match LOCKED su campo scoperto
 *   T2  scoperto occupato → ONLY_COVERED_AVAILABLE; retry preferCovered → coperto
 *   T3  entrambi occupati → ALL_COURTS_TAKEN
 *   T4  RACE: 4 prenotazioni simultanee stesso slot → mai due match sullo stesso campo
 *   T5  matchmaking OPEN + RACE join ultimo posto (SELECT FOR UPDATE) → mai 5 in 4
 *   T6  court swap scoperto→coperto: vecchio CANCELLED, nuovo su coperto
 *   T7  displacement: prenotazione privata sposta match OPEN con 1 giocatore
 *   T8  wave job schedulato su BullMQ per il match di matchmaking
 *   T9  pricing per fasce orarie (calculateSlotCost)
 *   T10 cancellazione scoped per club (cross-club → skip)
 *   T11 selectPlayersForWave: esclude booker, rispetta skill range
 */
import 'dotenv/config';

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail?: string) {
    if (cond) { passed++; console.log(`  ✅ ${name}`); }
    else { failed++; failures.push(name); console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function main() {
    const { prisma } = await import('../src/services/db');
    const { executeAction } = await import('../src/services/brain');
    const { parseBookingDateTime } = await import('../src/utils/booking-dates');
    const { calculateSlotCost } = await import('../src/services/pricing');
    const { cancelMatchesWithNotification } = await import('../src/services/match-notifications');
    const { selectPlayersForWave } = await import('../src/services/scoring');
    const { waveQueue, getRedis } = await import('../src/services/queue');

    console.log('\n════ SETUP: pulizia DB + seed ════');
    await prisma.$executeRawUnsafe(`
        TRUNCATE "Invitation","MatchPlayer","MatchFeedback","WhatsAppMessage",
                 "CourtPrice","Match","Court","Player","Club","ConversationState" CASCADE
    `);
    await getRedis().flushdb();

    const clubA = await prisma.club.create({
        data: {
            name: 'Circolo Test A', openTime: '08:00', closeTime: '23:30', matchDuration: 90,
            matchLowerRange: 1.0, matchUpperRange: 1.0, maxDailyMessages: 10,
        },
    });
    const clubB = await prisma.club.create({ data: { name: 'Circolo Test B' } });

    const scoperto = await prisma.court.create({ data: { clubId: clubA.id, name: 'Campo 1', isCovered: false } });
    const coperto = await prisma.court.create({ data: { clubId: clubA.id, name: 'Campo 2', isCovered: true } });
    await prisma.court.create({ data: { clubId: clubB.id, name: 'Campo B1', isCovered: false } });

    // Prezzi sul campo scoperto: mattina 20€, sera 32€
    await prisma.courtPrice.createMany({
        data: [
            { courtId: scoperto.id, startTime: '08:00', endTime: '17:00', price: 20 },
            { courtId: scoperto.id, startTime: '17:00', endTime: '23:30', price: 32 },
        ],
    });

    const mkPlayer = (n: number, skill = 3.0, gender: 'MALE' | 'FEMALE' = 'MALE') =>
        prisma.player.create({
            data: { clubId: clubA.id, phoneNumber: `39333000${String(n).padStart(4, '0')}`, name: `Tester ${n}`, skillLevel: skill, gender, reliabilityScore: 0.8 },
        });
    const P: any[] = [];
    for (let i = 1; i <= 12; i++) P.push(await mkPlayer(i));

    const book = (player: any, params: Record<string, unknown>) =>
        executeAction('BOOK_FIELD', { day: 'domani', time: '18:00', ...params }, player, clubA, player.phoneNumber);

    // ════ T1: booking privato ════
    console.log('\n════ T1: booking privato → LOCKED su scoperto ════');
    const r1 = await book(P[0], { private: true });
    check('T1 success', r1.success === true, r1.errorMessage);
    const m1 = r1.matchId ? await prisma.match.findUnique({ where: { id: r1.matchId }, include: { MatchPlayer: true } }) : null;
    check('T1 match LOCKED', m1?.status === 'LOCKED');
    check('T1 isPrivateBooking', (m1 as any)?.isPrivateBooking === true);
    check('T1 campo scoperto assegnato', m1?.courtId === scoperto.id);
    check('T1 booker registrato nel match', m1?.MatchPlayer.length === 1 && m1?.MatchPlayer[0].playerId === P[0].id);
    const expectedStart = parseBookingDateTime('domani', '18:00')!;
    check('T1 orario corretto (18:00 Rome domani)', m1?.startTime.getTime() === expectedStart.getTime());

    // ════ T2: scoperto occupato → chiedi conferma coperto ════
    console.log('\n════ T2: solo coperto libero → ONLY_COVERED_AVAILABLE, poi retry esplicito ════');
    const r2a = await book(P[1], { private: true });
    check('T2 blocco con ONLY_COVERED_AVAILABLE', r2a.success === false && r2a.errorMessage === 'ONLY_COVERED_AVAILABLE', r2a.errorMessage);
    const r2b = await book(P[1], { private: true, preferCovered: true });
    check('T2 retry preferCovered → success', r2b.success === true, r2b.errorMessage);
    const m2 = r2b.matchId ? await prisma.match.findUnique({ where: { id: r2b.matchId } }) : null;
    check('T2 campo coperto assegnato', m2?.courtId === coperto.id);

    // ════ T3: tutto occupato ════
    console.log('\n════ T3: entrambi i campi presi → ALL_COURTS_TAKEN ════');
    const r3 = await book(P[2], { private: true, preferCovered: true });
    check('T3 ALL_COURTS_TAKEN', r3.success === false && r3.errorMessage === 'ALL_COURTS_TAKEN', r3.errorMessage);

    // ════ T4: RACE double-booking ════
    console.log('\n════ T4: 4 prenotazioni SIMULTANEE stesso slot (15:00) ════');
    const raceResults = await Promise.all([
        executeAction('BOOK_FIELD', { day: 'domani', time: '15:00', private: true }, P[3], clubA, P[3].phoneNumber),
        executeAction('BOOK_FIELD', { day: 'domani', time: '15:00', private: true }, P[4], clubA, P[4].phoneNumber),
        executeAction('BOOK_FIELD', { day: 'domani', time: '15:00', private: true }, P[5], clubA, P[5].phoneNumber),
        executeAction('BOOK_FIELD', { day: 'domani', time: '15:00', private: true }, P[6], clubA, P[6].phoneNumber),
    ]);
    const raceOk = raceResults.filter(r => r.success);
    const slot15 = parseBookingDateTime('domani', '15:00')!;
    const matchesAt15 = await prisma.match.findMany({ where: { clubId: clubA.id, startTime: slot15, status: { not: 'CANCELLED' } } });
    const courtCounts = new Map<string, number>();
    for (const m of matchesAt15) courtCounts.set(m.courtId!, (courtCounts.get(m.courtId!) || 0) + 1);
    const doubleBooked = [...courtCounts.values()].some(c => c > 1);
    check('T4 NESSUN double-booking (max 1 match per campo)', !doubleBooked, JSON.stringify([...courtCounts.entries()]));
    check('T4 almeno 1 prenotazione riuscita', raceOk.length >= 1, `riuscite: ${raceOk.length}`);
    check('T4 match totali ≤ 2 (2 campi)', matchesAt15.length <= 2, `creati: ${matchesAt15.length}`);
    console.log(`     (riuscite: ${raceOk.length}/4, match creati: ${matchesAt15.length}, errori: ${raceResults.filter(r => !r.success).map(r => r.errorMessage).join(' | ')})`);

    // ════ T5: matchmaking + RACE sull'ultimo posto ════
    console.log('\n════ T5: matchmaking OPEN + 4 join simultanei per 3 posti ════');
    const r5 = await executeAction('BOOK_FIELD', { day: 'domani', time: '10:00', private: false, preferMixed: false }, P[7], clubA, P[7].phoneNumber);
    check('T5 matchmaking success', r5.success === true, r5.errorMessage);
    const m5 = r5.matchId ? await prisma.match.findUnique({ where: { id: r5.matchId } }) : null;
    check('T5 match OPEN (cerca giocatori)', m5?.status === 'OPEN');
    check('T5 targetGender MALE (booker maschio, no misto)', (m5 as any)?.targetGender === 'MALE');

    const joiners = [P[8], P[9], P[10], P[11]];
    const joinResults = await Promise.all(
        joiners.map(p => executeAction('BOOK_FIELD', { day: 'domani', time: '10:00', joinMatchId: r5.matchId }, p, clubA, p.phoneNumber))
    );
    const joinOk = joinResults.filter(r => r.success).length;
    const m5After = await prisma.match.findUnique({ where: { id: r5.matchId! }, include: { MatchPlayer: { where: { leftAt: null } } } });
    check('T5 esattamente 3 join riusciti su 4', joinOk === 3, `riusciti: ${joinOk}`);
    check('T5 match ha ESATTAMENTE 4 giocatori (mai 5)', m5After?.MatchPlayer.length === 4, `giocatori: ${m5After?.MatchPlayer.length}`);
    check('T5 match LOCKED al completamento', m5After?.status === 'LOCKED');
    check('T5 il quarto riceve MATCH_FULL/MATCH_CLOSED', joinResults.some(r => r.errorMessage === 'MATCH_FULL' || r.errorMessage === 'MATCH_CLOSED'),
        joinResults.filter(r => !r.success).map(r => r.errorMessage).join('|'));

    // ════ T6: court swap ════
    console.log('\n════ T6: court swap scoperto → coperto (12:00) ════');
    const r6a = await executeAction('BOOK_FIELD', { day: 'domani', time: '12:00', private: true }, P[2], clubA, P[2].phoneNumber);
    check('T6 booking iniziale su scoperto', r6a.success === true && (await prisma.match.findUnique({ where: { id: r6a.matchId! } }))?.courtId === scoperto.id, r6a.errorMessage);
    const r6b = await executeAction('BOOK_FIELD', { day: 'domani', time: '12:00', private: true, preferCovered: true }, P[2], clubA, P[2].phoneNumber);
    check('T6 swap riuscito', r6b.success === true, r6b.errorMessage);
    const m6old = await prisma.match.findUnique({ where: { id: r6a.matchId! } });
    const m6new = r6b.matchId ? await prisma.match.findUnique({ where: { id: r6b.matchId } }) : null;
    check('T6 vecchio match CANCELLED (COURT_SWAP)', m6old?.status === 'CANCELLED' && (m6old as any)?.cancelledReason === 'COURT_SWAP', m6old?.status);
    check('T6 nuovo match su coperto', m6new?.courtId === coperto.id);

    // ════ T7: displacement ════
    // 13:30: a distanza ≥90min da tutti gli slot precedenti (12:00 e 15:00 sono esattamente al confine)
    console.log('\n════ T7: booking privato sposta match OPEN con 1 giocatore (13:30) ════');
    // Occupa il coperto con un LOCKED (hard) e lo scoperto con un OPEN 1-giocatore (soft)
    const r7hard = await executeAction('BOOK_FIELD', { day: 'domani', time: '13:30', private: true, preferCovered: true }, P[3], clubA, P[3].phoneNumber);
    const r7soft = await executeAction('BOOK_FIELD', { day: 'domani', time: '13:30', private: false, preferMixed: false }, P[4], clubA, P[4].phoneNumber);
    check('T7 setup: LOCKED su coperto + OPEN su scoperto', r7hard.success && r7soft.success,
        `${r7hard.errorMessage || ''} ${r7soft.errorMessage || ''}`);
    if (r7hard.success && r7soft.success) {
        const r7 = await executeAction('BOOK_FIELD', { day: 'domani', time: '13:30', private: true }, P[5], clubA, P[5].phoneNumber);
        check('T7 booking privato riuscito via displacement', r7.success === true, r7.errorMessage);
        const m7displaced = await prisma.match.findUnique({ where: { id: r7soft.matchId! } });
        const m7new = r7.matchId ? await prisma.match.findUnique({ where: { id: r7.matchId } }) : null;
        check('T7 match OPEN displaced → CANCELLED (DISPLACED_BY_BOOKING)',
            m7displaced?.status === 'CANCELLED' && (m7displaced as any)?.cancelledReason === 'DISPLACED_BY_BOOKING', `${m7displaced?.status}/${(m7displaced as any)?.cancelledReason}`);
        check('T7 nuovo booking sul campo liberato (scoperto)', m7new?.courtId === scoperto.id);
    } else {
        check('T7 booking privato riuscito via displacement', false, 'setup fallito');
        check('T7 match OPEN displaced → CANCELLED (DISPLACED_BY_BOOKING)', false, 'setup fallito');
        check('T7 nuovo booking sul campo liberato (scoperto)', false, 'setup fallito');
    }

    // ════ T8: wave job schedulato ════
    console.log('\n════ T8: wave BullMQ schedulata per il matchmaking ════');
    const delayed = await waveQueue.getDelayed();
    const waveForT5orT7 = delayed.filter(j => [r5.matchId, r7soft?.matchId].filter(Boolean).includes(j.data?.matchId));
    check('T8 job wave in coda (delayed) per i match di matchmaking', waveForT5orT7.length >= 1, `delayed totali: ${delayed.length}`);

    // ════ T9: pricing ════
    console.log('\n════ T9: pricing per fasce orarie ════');
    const priceEvening = await calculateSlotCost(scoperto.id, parseBookingDateTime('domani', '18:00')!, 90);
    const priceMorning = await calculateSlotCost(scoperto.id, parseBookingDateTime('domani', '10:00')!, 90);
    const priceBoundary = await calculateSlotCost(scoperto.id, parseBookingDateTime('domani', '16:30')!, 90); // 16:30-18:00 attraversa le fasce
    check('T9 sera (18:00) = 32€', priceEvening === 32, `${priceEvening}€`);
    check('T9 mattina (10:00) = 20€', priceMorning === 20, `${priceMorning}€`);
    check('T9 a cavallo (16:30) = max fascia = 32€', priceBoundary === 32, `${priceBoundary}€`);

    // ════ T10: cancellazione scoped per club ════
    console.log('\n════ T10: cancelMatchesWithNotification è scoped per club ════');
    const crossCount = await cancelMatchesWithNotification([m1!.id], clubB.id, 'tentativo cross-club');
    const m1AfterCross = await prisma.match.findUnique({ where: { id: m1!.id } });
    check('T10 club B NON cancella match di club A', crossCount === 0 && m1AfterCross?.status === 'LOCKED', `count=${crossCount}, status=${m1AfterCross?.status}`);
    const ownCount = await cancelMatchesWithNotification([m1!.id], clubA.id, 'annullato dal circolo');
    const m1AfterOwn = await prisma.match.findUnique({ where: { id: m1!.id } });
    check('T10 club A cancella il proprio match', ownCount === 1 && m1AfterOwn?.status === 'CANCELLED');

    // ════ T11: selezione wave ════
    console.log('\n════ T11: selectPlayersForWave (skill range, esclusioni) ════');
    // r7soft è stato displaced; usa un nuovo matchmaking a 20:30
    const r11 = await executeAction('BOOK_FIELD', { day: 'domani', time: '20:30', private: false, preferMixed: false }, P[6], clubA, P[6].phoneNumber);
    check('T11 matchmaking creato', r11.success === true, r11.errorMessage);
    const sel = await selectPlayersForWave(r11.matchId!, 3);
    const selIds = sel.players.map((p: any) => p.id);
    check('T11 booker NON invitato a se stesso', !selIds.includes(P[6].id));
    check('T11 pool selezionato non vuoto', sel.players.length > 0, `selezionati: ${sel.players.length}`);
    check('T11 tutti nello skill range 2.0–4.0', sel.players.every((p: any) => p.skillLevel >= 2 && p.skillLevel <= 4));
    check('T11 tutti del club A', sel.players.every((p: any) => p.clubId === clubA.id));

    // ════ RIEPILOGO ════
    console.log('\n══════════════════════════════════════');
    console.log(`RISULTATO: ${passed} passati, ${failed} falliti`);
    if (failures.length) console.log('Falliti:\n' + failures.map(f => `  - ${f}`).join('\n'));
    console.log('══════════════════════════════════════');

    await waveQueue.close().catch(() => {});
    await getRedis().quit().catch(() => {});
    await prisma.$disconnect().catch(() => {});
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error('ERRORE FATALE:', err); process.exit(2); });
