import { prisma } from './services/db';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
  console.log('--- PLAYERS ---');
  const players = await prisma.player.findMany();
  console.log(JSON.stringify(players, null, 2));

  console.log('\n--- MATCHES ---');
  const matches = await prisma.match.findMany({
    include: {
      MatchPlayer: {
        include: {
          player: true
        }
      }
    }
  });
  console.log(JSON.stringify(matches, null, 2));

  console.log('\n--- WHATSAPP MESSAGES ---');
  const messages = await prisma.whatsAppMessage.findMany({
    orderBy: { timestamp: 'asc' }
  });
  console.log(JSON.stringify(messages, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
