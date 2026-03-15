/**
 * TEST LIVELLO 6 — Booking e Onboarding
 *
 * Verifica che extractBookingContext() estragga correttamente
 * data, ora, campo, numero giocatori e livello di gioco da messaggi in linguaggio naturale.
 */
import { extractBookingContext } from '../src/services/booking';
import * as dotenv from 'dotenv';
dotenv.config();

const TEST_CASES = [
    { msg: "Ciao! Vorrei prenotare per sabato prossimo alle 18 campo coperto", desc: "Messaggio naturale con data, ora e preferenza campo" },
    { msg: "Campo 1 domani mattina 10:00 per 4 giocatori livello 2", desc: "Messagio strutturato con tutti i parametri" },
    { msg: "Voglio giocare", desc: "Messaggio vago senza parametri specifici" },
    { msg: "Prenota per stasera alle 21:30", desc: "Ora specifica senza data esplicita" },
    { msg: "Ho bisogno di un campo per 2 ore con 4 amici livello 3", desc: "Livello e numero giocatori espliciti" },
];

async function run() {
    console.log('\n🧪 TEST LIVELLO 6 — Booking Context Extraction (AI)\n');

    let passed = 0;
    let total = TEST_CASES.length;

    for (const tc of TEST_CASES) {
        console.log(`\n📝 Test: "${tc.desc}"`);
        console.log(`   Messaggio: "${tc.msg}"`);

        try {
            const ctx = await extractBookingContext(tc.msg, 3);
            console.log(`   📊 Contesto estratto:`, JSON.stringify(ctx, null, 2).split('\n').map(l => '   ' + l).join('\n').trim());
            console.log(`   ✅ PASS: Contesto estratto con successo.`);
            passed++;
        } catch (e: any) {
            console.error(`   ❌ FAIL: Errore durante l'estrazione: ${e.message}`);
        }
    }

    console.log(`\n📊 RISULTATO: ${passed}/${total} test superati.`);
    if (passed === total) {
        console.log('🎉 LIVELLO 6 — TUTTI I TEST PASSATI!\n');
    } else {
        console.log('⚠️  LIVELLO 6 — ALCUNI TEST FALLITI!\n');
    }
}

run().catch(e => console.error('❌ Errore fatale:', e.message));
