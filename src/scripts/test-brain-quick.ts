import dotenv from 'dotenv';
dotenv.config();
import { prisma } from '../services/db';
import { callBrain } from '../services/brain';

async function main() {
  const club = await prisma.club.findFirst({ include: { courts: { where: { active: true } } } });
  console.log('Club:', club?.name);
  try {
    const r = await callBrain('Ciao come funziona?', null, club as any);
    console.log('Brain OK:', r.action, r.message.substring(0, 80));
  } catch(e: any) {
    console.error('Brain error:', e.message);
    console.error(e.stack?.split('\n').slice(0, 8).join('\n'));
  }
  await prisma.$disconnect();
}
main();
