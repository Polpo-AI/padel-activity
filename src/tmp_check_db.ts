import { prisma } from './src/services/db';

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

  console.log('\n--- INVITATIONS ---');
  const invitations = await prisma.invitation.findMany({
    include: {
      player: true
    }
  });
  console.log(JSON.stringify(invitations, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect());
