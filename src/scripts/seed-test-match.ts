import 'dotenv/config';
import { prisma } from '../services/db';

async function main() {
  console.log('Seeding database...');

  // 1. Create a Club
  const club = await prisma.club.upsert({
    where: { id: 'test-club-id' },
    update: {},
    create: {
      id: 'test-club-id',
      name: 'Polpo Padel Club',
      timezone: 'Europe/Rome',
      matchDuration: 90,
      openTime: '08:00',
      closeTime: '23:00',
      adminPhone: '393470000000',
    },
  });
  console.log('Club created/updated:', club.name);

  // 2. Create a Court
  const court = await prisma.court.upsert({
    where: { id: 'test-court-id' },
    update: {},
    create: {
      id: 'test-court-id',
      clubId: club.id,
      name: 'Campo Centrale',
      active: true,
    },
  });
  console.log('Court created/updated:', court.name);

  // 3. Create some Players
  const mario = await prisma.player.upsert({
    where: { phoneNumber_clubId: { phoneNumber: '393471234567', clubId: club.id } },
    update: {},
    create: {
      phoneNumber: '393471234567',
      name: 'Mario Rossi',
      skillLevel: 3,
      clubId: club.id,
      active: true,
    },
  });
  
  const davide = await prisma.player.upsert({
      where: { phoneNumber_clubId: { phoneNumber: '393481234567', clubId: club.id } },
      update: {},
      create: {
        phoneNumber: '393481234567',
        name: 'Davide',
        skillLevel: 3,
        clubId: club.id,
        active: true,
      },
  });

  console.log('Players created:', mario.name, davide.name);

  // 4. Create an OPEN match for tonight
  const tonight = new Date();
  tonight.setHours(20, 30, 0, 0);
  
  const match = await prisma.match.create({
      data: {
          clubId: club.id,
          courtId: court.id,
          startTime: tonight,
          playersNeeded: 4,
          status: 'OPEN',
          skillLevel: 3,
      }
  });
  
  // Add Davide to the match
  await prisma.matchPlayer.create({
      data: {
          matchId: match.id,
          playerId: davide.id
      }
  });

  console.log('Match created at:', match.startTime);
  console.log('Ready for testing!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
