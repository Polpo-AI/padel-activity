import { prisma } from '../src/services/db';
import { waveQueue } from '../src/services/queue';
import * as dotenv from 'dotenv';

dotenv.config();

async function run() {
    const clubId = 'ebff5173-3fd4-4beb-b919-f904343bd551';
    
    console.log(`🎾 Creazione diretta match per Club ${clubId}...`);

    try {
        const match = await prisma.match.create({
            data: {
                club: { connect: { id: clubId } },
                startTime: new Date(Date.now() + 2 * 60 * 1000 * 60), // +2h
                skillLevel: 3, // Intermedio
                playersNeeded: 1, // Bastano pochi per testare
                status: 'OPEN',
            }
        });

        console.log(`✅ Match creato! ID: ${match.id}`);

        const initialDelayMs = 5000; // 5 secondi per velocizzare il test
        await waveQueue.add(
            'process-wave',
            {
                matchId: match.id,
                waveNumber: 1,
                limit: 4,
                scheduledAt: Date.now() + initialDelayMs,
            },
            {
                delay: initialDelayMs,
                removeOnComplete: true,
            }
        );

        console.log("✅ Wave accodata su Redis! Controlla i log di PM2 sul server.");
    } catch (error) {
        console.error("❌ Errore:", error);
    }
}

run();
