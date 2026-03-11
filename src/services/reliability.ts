import { prisma } from './db';
import pino from 'pino';

const logger = pino({ level: 'info' });

const MAX_SCORE = 150;
const MIN_SCORE = 0;

export async function increaseReliability(playerId: string, amount: number = 2): Promise<void> {
    try {
        const player = await prisma.player.findUnique({ where: { id: playerId } });
        if (!player) return;
        const newScore = Math.min(MAX_SCORE, player.reliabilityScore + amount);
        await prisma.player.update({
            where: { id: playerId },
            data: { reliabilityScore: newScore },
        });
        logger.info(`Player ${playerId} reliability: ${player.reliabilityScore} → ${newScore} (+${amount})`);
    } catch (err) {
        logger.error({ err }, 'Failed to increase reliability');
    }
}

export async function decreaseReliability(playerId: string, amount: number = 10): Promise<void> {
    try {
        const player = await prisma.player.findUnique({ where: { id: playerId } });
        if (!player) return;
        const newScore = Math.max(MIN_SCORE, player.reliabilityScore - amount);
        await prisma.player.update({
            where: { id: playerId },
            data: { reliabilityScore: newScore },
        });
        logger.info(`Player ${playerId} reliability: ${player.reliabilityScore} → ${newScore} (-${amount})`);

        // Se score troppo basso, disabilita temporaneamente
        if (newScore < 30) {
            logger.warn(`Player ${playerId} reliability critically low (${newScore}). Consider disabling.`);
        }
    } catch (err) {
        logger.error({ err }, 'Failed to decrease reliability');
    }
}
