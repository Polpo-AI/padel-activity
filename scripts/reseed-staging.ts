import { prisma } from '../src/services/db';
import * as bcrypt from 'bcrypt';

async function main() {
  console.log('🌱 Reseeding staging database...');

  const passwordHash = await bcrypt.hash('padel123', 10);

  const club = await prisma.club.create({
    data: {
      name: 'Padel Staging Club',
      adminPhone: '+393471234567',
      timezone: 'Europe/Rome',
      openTime: '08:00',
      closeTime: '23:30',
      matchDuration: 90,
      skillLevelCount: 3,
      allowMixedLevels: true,
      mixedLevelRange: 1,
      waveMultiplier: 3,
      deadlineMinutesBeforeMatch: 60,
      aiTone: 'Sei il bot amichevole del Padel Staging Club. Sii estremamente conciso e professionale.',
      dashboardUsername: 'admin',
      dashboardPasswordHash: passwordHash,
      courts: {
        create: [
          { name: 'Campo 1' },
          { name: 'Campo 2' }
        ]
      }
    }
  });

  console.log(`✅ Default club created: ${club.name} (ID: ${club.id})`);
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
