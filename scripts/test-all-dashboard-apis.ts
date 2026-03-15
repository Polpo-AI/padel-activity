import { prisma } from '../src/services/db';
import * as jwt from 'jsonwebtoken';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as bcrypt from 'bcrypt';

dotenv.config();

const PORT = process.env.STAGING_PORT || process.env.PORT || '3000';
const BASE_URL = `http://localhost:${PORT}/api/dashboard`;
const JWT_SECRET = process.env.JWT_SECRET || 'padel-dashboard-secret-change-in-production';
const CLUB_ID = 'ebff5173-3fd4-4beb-b919-f904343bd551';
const TEST_USER = 'admin_test';
const TEST_PASS = 'password_test';

async function run() {
    console.log(`\n🧪 INIZIO TEST COMPLETO DASHBOARD API SU ${BASE_URL}\n`);

    try {
        console.log("🛠️ Prepariamo le credenziali del Club nel database...");
        const hashedPass = await bcrypt.hash(TEST_PASS, 10);
        await prisma.club.update({
            where: { id: CLUB_ID },
            data: { dashboardUsername: TEST_USER, dashboardPasswordHash: hashedPass }
        });

        // 1. LOGIN
        console.log("\n1️⃣ Test POST /login");
        const resLogin = await axios.post(`${BASE_URL}/login`, { username: TEST_USER, password: TEST_PASS });
        console.log(`✅ Login riuscito! Status: ${resLogin.status}`);
        const token = resLogin.data.token;
        const headers = { Authorization: `Bearer ${token}` };

        // 2. CLUB INFO
        console.log("\n2️⃣ Test GET /club");
        const resClub = await axios.get(`${BASE_URL}/club`, { headers });
        console.log(`✅ Club: ${resClub.data.name} (Timezone: ${resClub.data.timezone})`);

        // 3. CAMPI E PARTITE DEL GIORNO
        console.log("\n3️⃣ Test GET /courts");
        const resCourts = await axios.get(`${BASE_URL}/courts`, { headers });
        console.log(`✅ Campi trovati: ${resCourts.data.length}`);

        // 4. LISTA PARTITE
        console.log("\n4️⃣ Test GET /matches");
        const resMatches = await axios.get(`${BASE_URL}/matches`, { headers });
        console.log(`✅ Partite trovate a sistema: ${resMatches.data.length}`);

        // 5. GIOCATORI E TOGGLE
        console.log("\n5️⃣ Test Giocatori (Lista, Toggle, Profilo e Livello)");
        let resPlayers = await axios.get(`${BASE_URL}/players`, { headers });
        
        let testPlayer = resPlayers.data.find((p: any) => p.phoneNumber === '+393457991255');
        if (!testPlayer) {
            console.log("🛠️ Inserisco un giocatore di test a DB...");
            await prisma.player.create({
                data: {
                    clubId: CLUB_ID,
                    phoneNumber: '+393457991255',
                    name: 'Test Dashboard Completo',
                    skillLevel: 2.0,
                    active: true
                }
            });
            resPlayers = await axios.get(`${BASE_URL}/players`, { headers });
            testPlayer = resPlayers.data.find((p: any) => p.phoneNumber === '+393457991255');
        }

        const pid = testPlayer.id;
        console.log(`👉 Giocatore di Test selezionato: ${testPlayer.name} (${testPlayer.phoneNumber})`);

        // Toggle Player
        console.log(`   🔸 Test POST /players/toggle per ${testPlayer.phoneNumber}`);
        const resToggle1 = await axios.post(`${BASE_URL}/players/toggle`, { phoneNumber: testPlayer.phoneNumber }, { headers });
        console.log(`      Toggle 1: ${resToggle1.data.message}`);
        const resToggle2 = await axios.post(`${BASE_URL}/players/toggle`, { phoneNumber: testPlayer.phoneNumber }, { headers });
        console.log(`      Toggle 2: ${resToggle2.data.message}`);

        // Get Player Detail
        console.log(`   🔸 Test GET /players/${pid}`);
        const resDetail = await axios.get(`${BASE_URL}/players/${pid}`, { headers });
        console.log(`      Dettaglio stats recuperate:`, resDetail.data.stats);

        // Update Skill Level (PATCH)
        const oldLv = resDetail.data.skillLevel;
        const newLv = oldLv === 3 ? 2.5 : 3;
        console.log(`   🔸 Test PATCH /players/${pid} (Set Livello a ${newLv})`);
        const resPatch = await axios.patch(`${BASE_URL}/players/${pid}`, { skillLevel: newLv }, { headers });
        console.log(`      Livello modificato con successo a ${resPatch.data.skillLevel}`);

        // 6. TARIFFE
        console.log("\n6️⃣ Test GET /prices");
        const resPrices = await axios.get(`${BASE_URL}/prices`, { headers });
        console.log(`✅ Risposta /prices ricevuta con ${resPrices.data.length} campi configurati.`);

        console.log("\n🎉 === TUTTI I TEST ENDPOINTS SONO PASSATI CON SUCCESSO! === 🎉\n");
    } catch (error: any) {
        console.error("\n❌ ERRORE ENDPOINT:");
        console.error("Status:", error.response?.status);
        console.error("Data:", error.response?.data);
        console.error("Message:", error.message);
    }
}

run();
