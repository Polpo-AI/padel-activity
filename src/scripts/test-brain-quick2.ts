import dotenv from 'dotenv';
dotenv.config();
import { prisma } from '../services/db';
import { callBrain, buildBrainContext } from '../services/brain';

async function main() {
  const clubId = process.env.CLUB_ID;
  const club = clubId
    ? await prisma.club.findUnique({ where: { id: clubId }, include: { courts: { where: { active: true } } } })
    : await prisma.club.findFirst({ include: { courts: { where: { active: true } } } });
  console.log('Club:', club?.name, 'id:', club?.id);
  console.log('Courts:', (club as any)?.courts?.map((c: any) => c.name).join(', '));
  
  try {
    const ctx = await buildBrainContext('39201000001@s.whatsapp.net', '39201000001');
    console.log('Context player:', ctx.player?.name ?? 'null (unregistered)');
    console.log('Context club:', ctx.club?.name);
    const r = await callBrain(ctx, 'Ciao come funziona?');
    console.log('Brain OK:', r.action);
    console.log('Message:', r.message.substring(0, 150));
  } catch(e: any) {
    console.error('Brain error:', e.message);
    console.error(e.stack?.split('\n').slice(0, 8).join('\n'));
  }
  await prisma.$disconnect();
}
main();
