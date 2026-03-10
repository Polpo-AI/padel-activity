import { WAMessage } from '@whiskeysockets/baileys';
import { prisma } from './db';
import { classifyIntent } from './ai';
import pino from 'pino';
import { createGroupAndAddPlayers, simulateTypingAndSend } from './whatsapp';
import { reminderQueue } from './queue';

const logger = pino({ level: 'info' });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

// Use Prisma's inferred type for the transaction client
type PrismaTransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export async function handleIncomingMessage(msg: WAMessage) {
    const senderJid = msg.key.remoteJid;
    const phoneNumber = senderJid?.split('@')[0];
    const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text;

    if (!phoneNumber || !text) return;

    logger.info(`Received message from ${phoneNumber}: ${text}`);

    // 1. Find if this player exists and has a PENDING invitation
    const player = await prisma.player.findUnique({ where: { phoneNumber } });
    if (!player) return;

    const activeInvitations = await prisma.invitation.findMany({
        where: {
            playerId: player.id,
            status: 'PENDING',
            match: { status: 'OPEN' },
        },
        include: { match: true },
        orderBy: { sentAt: 'desc' },
    });

    if (activeInvitations.length === 0) return;
    const invitation = activeInvitations[0];
    const matchId = invitation.matchId;

    // 2. Classify intent via Anthropic
    const intent = await classifyIntent(text);
    logger.info(`Intent classified as ${intent} for message: "${text}"`);

    // [ANTI-BAN & HUMAN SIMULATION]
    // 15% chance of a long "I was busy" delay (60-240 seconds) — extremely human.
    // Otherwise: random 8-35 seconds of reaction time.
    const isBusy = Math.random() < 0.15;
    const thoughtfulDelay = isBusy ? randomInt(60, 240) * 1000 : randomInt(8, 35) * 1000;
    logger.info(`Waiting ${Math.round(thoughtfulDelay / 1000)}s (busy=${isBusy}) to mimic human reaction time...`);
    await sleep(thoughtfulDelay);

    if (intent === 'QUESTION') {
        await simulateTypingAndSend(senderJid!, "Aspetta, controllo e ti dico! (Sono un'intelligenza artificiale in test 🤖)", msg.key);
        return;
    }

    if (intent === 'NO') {
        await prisma.invitation.update({
            where: { id: invitation.id },
            data: { status: 'REJECTED' },
        });
        await simulateTypingAndSend(senderJid!, "Tranquillo! Sarà per la prossima volta 💪", msg.key);
        return;
    }

    if (intent === 'YES') {
        // 3. Player accepted! Let's lock them in
        try {
            const result = await prisma.$transaction(async (tx: PrismaTransactionClient) => {
                const match = await tx.match.findUnique({
                    where: { id: matchId },
                    include: { MatchPlayer: true }
                });

                if (!match || match.status !== 'OPEN') {
                    throw new Error('MATCH_CLOSED');
                }

                if (match.MatchPlayer.length >= match.playersNeeded) {
                    throw new Error('MATCH_FULL');
                }

                await tx.matchPlayer.create({
                    data: { matchId: match.id, playerId: player.id },
                });

                await tx.invitation.update({
                    where: { id: invitation.id },
                    data: { status: 'ACCEPTED' },
                });

                const updatedCount = match.MatchPlayer.length + 1;
                if (updatedCount >= match.playersNeeded) {
                    const filledMatch = await tx.match.update({
                        where: { id: match.id },
                        data: { status: 'LOCKED' },
                    });
                    return { status: 'JUST_FILLED', match: filledMatch };
                }

                return { status: 'ADDED', match };
            });

            if (result.status === 'MATCH_CLOSED' || result.status === 'MATCH_FULL') {
                throw new Error(result.status);
            }

            await simulateTypingAndSend(senderJid!, "Ottimo! Ti ho segnato. Ti scrivo non appena siamo in 4! 🎾", msg.key);

            if (result.status === 'JUST_FILLED') {
                await handleMatchFilled(result.match.id, result.match.startTime);
            }

        } catch (error: any) {
            logger.error({ error }, 'Error processing YES intent');
            if (error.message === 'MATCH_FULL' || error.message === 'MATCH_CLOSED') {
                await prisma.invitation.update({
                    where: { id: invitation.id },
                    data: { status: 'REJECTED' },
                });
                await simulateTypingAndSend(senderJid!, "Azz, sei arrivato un secondo in ritardo! Qualcuno ti ha soffiato l'ultimo posto. Alla prossima! 🥲", msg.key);
            }
        }
    }
}

async function handleMatchFilled(matchId: string, startTime: Date) {
    logger.info(`Match ${matchId} is now LOCKED. Executing closing sequence.`);

    const confirmed = await prisma.matchPlayer.findMany({
        where: { matchId },
        include: { player: true },
    });
    const playerPhones = confirmed.map((m: any) => m.player.phoneNumber as string);

    const timeStr = startTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const groupName = `Padel ${timeStr}`;
    const confirmationMsg = `Partita confermata 🎾\nCampo Prenotato\nOre: ${timeStr}\nBuona partita!`;

    try {
        const groupId = await createGroupAndAddPlayers(groupName, playerPhones, confirmationMsg);

        await prisma.match.update({
            where: { id: matchId },
            data: { groupId },
        });

        const pendingInvs = await prisma.invitation.findMany({
            where: { matchId, status: 'PENDING' },
            include: { player: true },
        });

        for (const inv of pendingInvs) {
            await prisma.invitation.update({
                where: { id: inv.id },
                data: { status: 'IGNORED' },
            });
            // Delay before mass broadcasting sorry messages
            await sleep(randomInt(2, 6) * 1000);
            await simulateTypingAndSend(inv.player.phoneNumber, "Grazie mille per la disponibilità, ma abbiamo appena riempito il campo! Sarà per la prossima volta 💪");
        }

        const reminderTime = new Date(startTime.getTime() - 60 * 60 * 1000);
        const delay = Math.max(0, reminderTime.getTime() - Date.now());

        logger.info(`Scheduling reminder job for Match ${matchId} in ${delay / 1000}s`);
        await reminderQueue.add('send-reminder', { matchId, groupId, timeStr }, { delay });

    } catch (err) {
        logger.error({ err }, `Error during closing sequence of Match ${matchId}`);
    }
}
