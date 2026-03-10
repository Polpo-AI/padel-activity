import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();

const PORT = process.env.PORT || 3000;

async function triggerMatch() {
  console.log('🎾 Triggering a new match via webhook...');

  try {
    const response = await axios.post(`http://localhost:${PORT}/api/slots`, {
      court: 'Campo Centale',
      time: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // Partita tra 2 ore
      skill_level: 'INTERMEDIATE',
      players_needed: 4
    });

    console.log('✅ Webhook successful!');
    console.log('Match ID:', response.data.matchId);
    console.log('Delay for first wave:', response.data.plannedExecutionDelaySeconds, 'seconds');
  } catch (error: any) {
    console.error('❌ Error triggering webhook:', error.response?.data || error.message);
  }
}

triggerMatch();
