import { prisma } from '../services/db';
import pino from 'pino';

const logger = pino({ level: 'info' });

export async function resetDailyStats() {
    logger.info('Resetting daily message counts for all players...');
    try {
        const res = await prisma.player.updateMany({
            data: { dailyMessagesCount: 0 },
        });
        logger.info(`Reset ${res.count} players.`);
    } catch (err) {
        logger.error({ err }, 'Failed to reset daily stats');
    }
}

// Called when a player bails out of a locked match
export async function decreaseReliability(playerId: string, points: number = 10) {
    try {
        const player = await prisma.player.update({
            where: { id: playerId },
            data: { reliabilityScore: { decrement: points } },
        });
        logger.info(`Decreased reliability for player ${player.phoneNumber}. New score: ${player.reliabilityScore}`);
    } catch (err) {
        logger.error({ err }, `Failed to decrease reliability for player ${playerId}`);
    }
}

// Called after a successful match
export async function increaseReliability(playerId: string, points: number = 2) {
    try {
        const player = await prisma.player.update({
            where: { id: playerId },
            data: { reliabilityScore: { increment: points } },
        });
        // Cap at 100
        if (player.reliabilityScore > 100) {
            await prisma.player.update({
                where: { id: playerId },
                data: { reliabilityScore: 100 },
            });
        }
        logger.info(`Increased reliability for player ${player.phoneNumber}`);
    } catch (err) {
        logger.error({ err }, `Failed to increase reliability for player ${playerId}`);
    }
}
