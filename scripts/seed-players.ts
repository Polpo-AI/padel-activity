import { prisma } from '../src/services/db';
import { SkillLevel } from '@prisma/client';

async function seed() {
  console.log('🌱 Seeding test players...');

  const testPlayers = [
    {
      phoneNumber: '+393762031767',
      name: 'Davide',
      skillLevel: SkillLevel.INTERMEDIATE,
    }
  ];
  const playerPhoneNumbers = testPlayers.map(p => p.phoneNumber);

  // 1. Clear all old match and invitation data for a fresh test
  await prisma.matchPlayer.deleteMany({});
  await prisma.invitation.deleteMany({});
  await prisma.match.deleteMany({});
  await prisma.club.deleteMany({});

  // 2. Create Default Club
  const club = await prisma.club.create({
    data: {
      name: 'Padel Club Roma',
      timezone: 'UTC',
      matchDuration: 90,
      openTime: '08:00',
      closeTime: '23:30',
      aiTone: 'Sei un organizzatore di padel molto amichevole ma professionale. Usa un linguaggio colloquiale.'
    }
  });
  console.log(`🏢 Created Club: ${club.name}`);

  // 3. Clean up "inventati" players and their relations
  await prisma.matchPlayer.deleteMany({
    where: { player: { phoneNumber: { notIn: playerPhoneNumbers } } }
  });
  await prisma.invitation.deleteMany({
    where: { player: { phoneNumber: { notIn: playerPhoneNumbers } } }
  });
  const deleted = await prisma.player.deleteMany({
    where: { phoneNumber: { notIn: playerPhoneNumbers } }
  });
  
  if (deleted.count > 0) {
    console.log(`🧹 Deleted ${deleted.count} "inventati" players.`);
  }

  for (const p of testPlayers) {
    await prisma.player.upsert({
      where: { phoneNumber: p.phoneNumber },
      update: {
        ...p,
        dailyMessagesCount: 0,
        lastContactedAt: null
      },
      create: {
        ...p,
        dailyMessagesCount: 0,
      },
    });
    console.log(`✅ Player (${p.phoneNumber}) updated/created with reset limits.`);
  }

  console.log('✨ Seeding complete!');
  await prisma.$disconnect();
}

seed().catch((e) => {
  console.error('❌ Error during seeding:', e);
  process.exit(1);
});
