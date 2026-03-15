/**
 * TEST LIVELLO 4 — Scoring e Selezione Giocatori
 * 
 * Verifica che selectPlayersForWave() applichi correttamente:
 * - Filtro per livello (range)
 * - Priorità per lastContactedAt (chi aspetta di più prima)
 * - Esclusione giocatori inattivi e sopra quota giornaliera
 */
import { prisma } from '../src/services/db';
import { selectPlayersForWave } from '../src/services/scoring';
import * as dotenv from 'dotenv';
dotenv.config();

const CLUB_ID = 'ebff5173-3fd4-4beb-b919-f904343bd551';

async function cleanup(phones: string[]) {
    await prisma.player.deleteMany({
        where: { clubId: CLUB_ID, phoneNumber: { in: phones } }
    });
}

async function run() {
    console.log('\n🧪 TEST LIVELLO 4 — Scoring e Selezione Giocatori\n');
    
    const TEST_PHONES = ['+39000001', '+39000002', '+39000003', '+39000004', '+39000005'];
    await cleanup(TEST_PHONES);
    
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60_000);
    const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60_000);
    
    // Creiamo 5 giocatori con caratteristiche diverse
    const [p1, p2, p3, p4, p5] = await Promise.all([
        prisma.player.create({ data: { clubId: CLUB_ID, phoneNumber: '+39000001', name: 'Giocatore A (lv 2, attivo, ultima contatatto ieri)', skillLevel: 2, active: true, lastContactedAt: yesterday, reliabilityScore: 0.8 } }),
        prisma.player.create({ data: { clubId: CLUB_ID, phoneNumber: '+39000002', name: 'Giocatore B (lv 2, attivo, ultima contatto settimana scorsa)', skillLevel: 2, active: true, lastContactedAt: lastWeek, reliabilityScore: 0.6 } }),
        prisma.player.create({ data: { clubId: CLUB_ID, phoneNumber: '+39000003', name: 'Giocatore C (lv 5 FUORI RANGE)', skillLevel: 5, active: true, lastContactedAt: lastWeek, reliabilityScore: 0.9 } }),
        prisma.player.create({ data: { clubId: CLUB_ID, phoneNumber: '+39000004', name: 'Giocatore D (lv 2, INATTIVO)', skillLevel: 2, active: false, lastContactedAt: lastWeek, reliabilityScore: 0.7 } }),
        prisma.player.create({ data: { clubId: CLUB_ID, phoneNumber: '+39000005', name: 'Giocatore E (lv 2, quota giornaliera esaurita)', skillLevel: 2, active: true, lastContactedAt: lastWeek, dailyMessagesCount: 99, reliabilityScore: 0.5 } }),
    ]);
    
    console.log('✅ 5 giocatori di test creati.');
    
    // Recuperiamo il club con le sue impostazioni
    const club = await prisma.club.findUnique({ where: { id: CLUB_ID } });
    if (!club) { console.error('❌ Club non trovato!'); return; }
    
    // Creiamo un match fittizio di livello 2.0
    const testMatch = await prisma.match.create({
        data: {
            clubId: CLUB_ID,
            startTime: new Date(now.getTime() + 4 * 60 * 60_000), // tra 4 ore
            skillLevel: 2.0,
            playersNeeded: 4,
            status: 'OPEN',
        }
    });
    console.log(`✅ Match di test creato (lv 2.0, tra 4 ore): ${testMatch.id}`);
    
    // Eseguiamo la selezione
    const selected = await selectPlayersForWave(testMatch.id, 1, club as any);
    
    console.log(`\n🔍 Giocatori selezionati (${selected.length}):`);
    for (const p of selected) {
        console.log(`   - ${p.name} (lv ${p.skillLevel}, contactedAt: ${p.lastContactedAt?.toLocaleDateString() ?? 'mai'})`);
    }
    
    const selectedPhones = selected.map((p: any) => p.phoneNumber);
    
    // ASSERTIONS
    let ok = true;
    
    if (selectedPhones.includes('+39000004')) {
        console.error('\n❌ FAIL: Giocatore INATTIVO è stato selezionato!');
        ok = false;
    } else {
        console.log('\n✅ PASS: Giocatore inattivo correttamente escluso.');
    }
    
    if (selectedPhones.includes('+39000003')) {
        console.error('❌ FAIL: Giocatore FUORI RANGE (lv 5) è stato selezionato!');
        ok = false;
    } else {
        console.log('✅ PASS: Giocatore fuori range correttamente escluso.');
    }
    
    if (selectedPhones.includes('+39000005') && club.maxDailyMessages > 0) {
        console.error('❌ FAIL: Giocatore con quota esaurita è stato selezionato!');
        ok = false;
    } else {
        console.log('✅ PASS: Giocatore con quota giornaliera esaurita correttamente escluso.');
    }
    
    // Verifica priorità: B (lastWeek) deve venire prima di A (yesterday)
    const indexA = selected.findIndex((p: any) => p.phoneNumber === '+39000001');
    const indexB = selected.findIndex((p: any) => p.phoneNumber === '+39000002');
    if (indexA !== -1 && indexB !== -1) {
        if (indexB < indexA) {
            console.log('✅ PASS: Priorità per lastContactedAt rispettata (B prima di A).');
        } else {
            console.error('❌ FAIL: Giocatore A (contactato ieri) è stato selezionato prima di B (settimana scorsa). Priorità errata!');
            ok = false;
        }
    }
    
    // Cleanup
    await prisma.match.delete({ where: { id: testMatch.id } });
    await cleanup(TEST_PHONES);
    console.log('\n🧹 Dati di test rimossi.');
    
    if (ok) {
        console.log('\n🎉 LIVELLO 4 — TUTTI I TEST PASSATI!\n');
    } else {
        console.log('\n⚠️ LIVELLO 4 — ALCUNI TEST FALLITI!\n');
    }
}

run().catch(e => { console.error('❌ Errore fatale:', e.message); });
