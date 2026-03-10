import { Router } from 'express';
import { prisma } from '../services/db';
import { waveQueue } from '../services/queue';
import pino from 'pino';

const logger = pino({ level: 'info' });
const router = Router();

// Endpoint for receiving webhooks from the Booking System or Calendar
// Example body: { court: "Court 2", time: "2026-03-10T20:30", skill_level: "INTERMEDIATE", players_needed: 4 }
router.post('/slots', async (req, res) => {
    try {
        const { court, time, skill_level, players_needed = 4 } = req.body;

        // Validate Input
        if (!court || !time || !skill_level) {
            return res.status(400).json({ error: 'Missing required fields' });
        }

        // 1. Create a new Match in the system
        const match = await prisma.match.create({
            data: {
                court,
                startTime: new Date(time),
                skillLevel: skill_level.toUpperCase(),
                playersNeeded: parseInt(players_needed, 10),
                status: 'OPEN',
            },
        });

        logger.info(`Match ${match.id} created successfully for ${time} on ${court}`);

        // 2. Schedule the first Wave Job
        // The spec requires a random delay of 1 to 6 minutes before the *first* message is sent
        const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;
        const initialDelayMs = randomInt(1, 6) * 60 * 1000;

        await waveQueue.add(
            'process-wave',
            {
                matchId: match.id,
                waveNumber: 1,
                limit: 4, // 4 players spec
            },
            {
                delay: initialDelayMs,
                removeOnComplete: true, // Keep redis clean
            }
        );

        res.status(201).json({
            message: 'Match slotted and Initial Wave scheduled',
            matchId: match.id,
            plannedExecutionDelaySeconds: initialDelayMs / 1000
        });
    } catch (error) {
        logger.error({ error }, 'Error processing slot webhook');
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

export default router;
