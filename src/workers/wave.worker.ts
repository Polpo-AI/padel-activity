import { Worker, Job } from 'bullmq';
import { redisOpts, waveQueue } from '../services/queue';
import { getPlayersForWave } from '../services/matchmaker';
import { generateInvitation } from '../services/ai';
import { prisma } from '../services/db';
import { simulateTypingAndSend } from '../services/whatsapp';
import pino from 'pino';

const logger = pino({ level: 'info' });

interface WaveJobData {
    matchId: string;
    waveNumber: number;
    limit: number;
}

// Utility to sleep
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
// Utility for random interval
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

export const waveWorker = new Worker<WaveJobData>(
    'wave-queue',
    async (job: Job<WaveJobData>) => {
        const { matchId, waveNumber, limit } = job.data;
        logger.info(`Starting Wave ${waveNumber} for Match ${matchId}`);

        // Check if match is still OPEN before doing any work
        const match = await prisma.match.findUnique({ where: { id: matchId } });
        if (!match || match.status !== 'OPEN') {
            logger.info(`Match ${matchId} is no longer OPEN. Aborting wave.`);
            return;
        }

        // 1. Get targets
        const targets = await getPlayersForWave(matchId, limit);
        if (targets.length === 0) {
            logger.info(`No players found for Wave ${waveNumber} (Match ${matchId}). Pool exhausted.`);
            return;
        }

        logger.info(`Found ${targets.length} players for Wave ${waveNumber}`);

        // 2. Iterate through targets with linear delays
        for (const player of targets) {
            // Create invitation record immediately to prevent them being pulled by another concurrent process
            const invitation = await prisma.invitation.create({
                data: {
                    matchId,
                    playerId: player.id,
                    status: 'PENDING',
                },
            });

            // Generate AI text
            const text = await generateInvitation('Amico', match.startTime.toISOString(), match.court);

            // Random Delay
            // Wave 1 rules: 40-180 seconds. Wave 2+: 60-240 seconds.
            let delayMs = 0;
            if (waveNumber === 1) {
                delayMs = randomInt(40, 180) * 1000;
            } else {
                delayMs = randomInt(60, 240) * 1000;
            }

            logger.info(`Sleeping ${delayMs / 1000}s before messaging player ${player.phoneNumber}`);
            await sleep(delayMs);

            // Re-check Match status (it could have filled up while we slept!)
            const currentMatch = await prisma.match.findUnique({ where: { id: matchId }, include: { MatchPlayer: true } });
            if (!currentMatch || currentMatch.status !== 'OPEN' || currentMatch.MatchPlayer.length >= currentMatch.playersNeeded) {
                logger.info(`Match filled while sleeping. Aborting current wave execution.`);
                break; // Stop iterating
            }

            try {
                // [ANTI-BAN] Simulate human typing presence dynamically based on the text length
                await simulateTypingAndSend(player.phoneNumber, text);
                logger.info(`[MOCK] WhatsApp message SENT to ${player.phoneNumber}: ${text}`);

                // Update player stats AFTER successful send
                await prisma.player.update({
                    where: { id: player.id },
                    data: {
                        lastContactedAt: new Date(),
                        dailyMessagesCount: { increment: 1 },
                    },
                });
            } catch (err) {
                logger.error({ err }, `Failed to send WA message to ${player.phoneNumber}`);
                // Optionally update invitation status to FAILED or leave PENDING
            }
        }

        // 3. Schedule next wave if needed
        // Wave 1 waits 8-12 minutes response time
        // Wave 2+ waits 10-15 minutes response time
        let nextDelayMs = 0;
        if (waveNumber === 1) {
            nextDelayMs = randomInt(8, 12) * 60 * 1000;
        } else {
            nextDelayMs = randomInt(10, 15) * 60 * 1000;
        }

        logger.info(`Wave ${waveNumber} finished sending. Scheduling next wave check in ${nextDelayMs / 1000}s`);

        // We enqueue the NEXT wave, which will execute after `nextDelayMs`.
        // It will silently abort if the match gets filled in the meantime.
        await waveQueue.add(
            'process-wave',
            {
                matchId,
                waveNumber: waveNumber + 1,
                limit: 4, // 4 players per wave
            },
            {
                delay: nextDelayMs,
                removeOnComplete: true,
            }
        );
    },
    { connection: redisOpts }
);

waveWorker.on('failed', (job, err) => {
    logger.error({ err }, `Wave worker failed for job ${job?.id}`);
});
