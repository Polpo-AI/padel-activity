import { prisma } from '../src/services/db';
import * as jwt from 'jsonwebtoken';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

const PORT = process.env.STAGING_PORT || process.env.PORT || '3000';
const BASE_URL = `http://localhost:${PORT}/api/dashboard`;
const JWT_SECRET = process.env.JWT_SECRET || 'padel-dashboard-secret-change-in-production';
const CLUB_ID = 'ebff5173-3fd4-4beb-b919-f904343bd551';

async function run() {
    console.log(`🧪 Test Endpoints Dashboard API su ${BASE_URL}...`);

    const token = jwt.sign({ clubId: CLUB_ID }, JWT_SECRET, { expiresIn: '1h' });
    const headers = { Authorization: `Bearer ${token}` };

    try {
        console.log("\n1. Test GET /players...");
        let resPlayers = await axios.get(`${BASE_URL}/players`, { headers });
        console.log(`✅ GET /players: ${resPlayers.status} ok. Trovati ${resPlayers.data.length} giocatori.`);

        if (resPlayers.data.length === 0) {
            console.log("🛠️ Inserisco un giocatore di test a DB...");
            await prisma.player.create({
                data: {
                    clubId: CLUB_ID,
                    phoneNumber: '+393457991255',
                    name: 'Test Dashboard',
                    skillLevel: 2.0,
                    active: true
                }
            });
            resPlayers = await axios.get(`${BASE_URL}/players`, { headers });
        }

        const testPlayer = resPlayers.data[0];
        const pid = testPlayer.id;
        console.log(`👉 Uso giocatore di Test: ${testPlayer.name || 'Senza Nome'} (${pid}) - Livello attuale: ${testPlayer.skillLevel}`);

        // 3. Test GET /players/:id
        console.log(`\n2. Test GET /players/${pid}...`);
        const resDetail = await axios.get(`${BASE_URL}/players/${pid}`, { headers });
        console.log(`✅ GET /players/:id: ${resDetail.status} ok.`);
        console.log("📊 Statistiche aggregate:", resDetail.data.stats);

        // 4. Test PATCH /players/:id (Aggiorna Livello)
        const newLevel = testPlayer.skillLevel === 3 ? 2 : 3; // toggla
        console.log(`\n3. Test PATCH /players/${pid} (Set Livello a ${newLevel})...`);
        const resPatch = await axios.patch(`${BASE_URL}/players/${pid}`, {
            skillLevel: newLevel
        }, { headers });

        console.log(`✅ PATCH /players/:id: ${resPatch.status} ok.`);
        console.log(`🤖 Risposta: Modificato livello a ${resPatch.data.skillLevel}`);

        console.log("\n=== ✅ TUTTI I TEST DASHBOARD API COMPLETATI CON SUCCESSO ===");

    } catch (error: any) {
        console.error("❌ Errore:", error.response?.data || error.message);
    }
}

run();
