import { classifyIntent, generateInvitation } from '../src/services/ai';
import { detectActionSignal } from '../src/services/conversational-manager';
import * as dotenv from 'dotenv';

dotenv.config();

async function run() {
    console.log("=== 🧪 TEST PROMPTS MODULARI ===");

    try {
        console.log("\n1. Test classifyIntent...");
        const intent1 = await classifyIntent("Sì certo, contami!");
        console.log("Risposta 'Sì certo, contami!':", intent1);

        const intent2 = await classifyIntent("Invita pure Giuseppe Rossi");
        console.log("Risposta 'Invita pure Giuseppe Rossi':", intent2);

        console.log("\n2. Test detectActionSignal...");
        const signal = await detectActionSignal(
            "Siamo in 4 per mercoledì alle 19", 
            "User: Ciao volevo prenotare\nBot: Ciao! Dicci pure quando"
        );
        console.log("Risposta 'Siamo in 4...':", JSON.stringify(signal, null, 2));

        console.log("\n3. Test generateInvitation...");
        const inv = await generateInvitation("Mario Rossi", new Date(), "Campo Centrale 1");
        console.log("Invito generato:", inv);

        console.log("\n=== ✅ TEST CONCLUSO CON SUCCESSO ===");
    } catch (error) {
        console.error("❌ Errore durante i test:", error);
    }
}

run();
