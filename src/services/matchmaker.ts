import { prisma } from './db';
import { Match, Player } from '@prisma/client';
import pino from 'pino';

const logger = pino({ level: 'info' });

export async function getPlayersForWave(matchId: string, limit: number): Promise<Player[]> {
    try {
        const match = await prisma.match.findUnique({
            where: { id: matchId },
            include: {
                invitations: true,
                MatchPlayer: true,
            },
        });

        if (!match) throw new Error('Match not found');

        const confirmedCount = match.MatchPlayer.length;
        const remainingSpots = match.playersNeeded - confirmedCount;

        if (remainingSpots <= 0 || match.status !== 'OPEN') {
            logger.info(`Match ${matchId} is no longer open or needs no more players.`);
            return [];
        }

        // Determine how many to invite for this wave (bounded by the limit and remaining spots)
        // The spec said "message 4 additional players" if not full. Let's just use the `limit` parameter.

        // Find players who:
        // 1. Have the same skill level
        // 2. dailyMessagesCount < 2
        // 3. Aren't already invited to this match
        // 4. Aren't already in this match
        const invitedPlayerIds = match.invitations.map((i) => i.playerId);
        const joinedPlayerIds = match.MatchPlayer.map((mp) => mp.playerId);

        const targetPlayers = await prisma.player.findMany({
            where: {
                skillLevel: match.skillLevel,
                dailyMessagesCount: { lt: 2 },
                id: {
                    notIn: [...invitedPlayerIds, ...joinedPlayerIds],
                },
            },
            orderBy: [
                { reliabilityScore: 'desc' },
                { lastContactedAt: 'asc' }, // nulls first is handled by PG natively
            ],
            take: limit, // Pull max X players for this wave
        });

        return targetPlayers;
    } catch (error) {
        logger.error({ error }, 'Error finding players for wave');
        return [];
    }
}
