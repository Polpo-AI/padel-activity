/**
 * TRIGGER MATCH — script di test
 *
 * ✅ FIX A: aggiunto clubId nel body del webhook (ora obbligatorio).
 *    Impostare CLUB_ID nell'env o passarlo come argomento CLI.
 *
 * Usage:
 *   CLUB_ID=<uuid> npx ts-node scripts/trigger-match.ts
 *   npx ts-node scripts/trigger-match.ts --clubId=<uuid>
 */

import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const PORT = process.env.PORT || 3000;

// Supporta --clubId=xxx come argomento CLI
const cliClubId = process.argv.find(a => a.startsWith('--clubId='))?.split('=')[1];
const CLUB_ID = cliClubId || process.env.CLUB_ID;

async function triggerMatch() {
    if (!CLUB_ID) {
        console.error('❌ CLUB_ID non impostato. Usa: CLUB_ID=<uuid> npx ts-node scripts/trigger-match.ts');
        process.exit(1);
    }

    console.log(`🎾 Triggering a new match via webhook (club: ${CLUB_ID})...`);

    try {
        const url = `http://46.225.212.159:${PORT}/api/slots`;
        const response = await axios.post(url, {
            court: 'Campo Centrale',
            time: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
            skill_level: 'INTERMEDIATE',
            players_needed: 1,
            clubId: CLUB_ID,  // ✅ FIX A: ora richiesto dal webhook
        });

        console.log('✅ Webhook successful!');
        console.log('Match ID:', response.data.matchId);
        console.log('Club ID:', response.data.clubId);
        console.log('Delay for first wave:', response.data.plannedExecutionDelaySeconds, 'seconds');
    } catch (error: any) {
        console.error('❌ Error triggering webhook:', error.response?.data || error.message);
    }
}

triggerMatch();
