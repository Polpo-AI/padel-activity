import { prisma } from '../src/services/db';

async function seed() {
  console.log('🌱 Seeding test players...');

  const testPlayers = [
    {
      phoneNumber: '391234567890', // Sostituisci con numeri reali per i tuoi test
      name: 'Mario Rossi',
      skillLevel: 'INTERMEDIATE',
    },
    {
      phoneNumber: '390987654321',
      name: 'Luigi Bianchi',
      skillLevel: 'INTERMEDIATE',
    },
    {
      phoneNumber: '391122334455',
      name: 'Giuseppe Verdi',
      skillLevel: 'ADVANCED',
    },
    {
      phoneNumber: '395544332211',
      name: 'Antonio Neri',
      skillLevel: 'INTERMEDIATE',
    }
  ];

  for (const p of testPlayers) {
    await prisma.player.upsert({
      where: { phoneNumber: p.phoneNumber },
      update: p,
      create: p,
    });
    console.log(`✅ Player ${p.name} (${p.phoneNumber}) updated/created.`);
  }

  console.log('✨ Seeding complete!');
  await prisma.$disconnect();
}

seed().catch((e) => {
  console.error('❌ Error during seeding:', e);
  process.exit(1);
});
