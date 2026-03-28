import dotenv from 'dotenv';
dotenv.config();
import { prisma } from '../services/db';
async function main() {
    const whereClause = {
        OR: [
            { id: '2a9f29fc-1d26-480d-bdd5-e7e344fa3d8f' },
            { clubId: { startsWith: 'ts-' } },
        ]
    };
    const matches = await prisma.match.findMany({ where: whereClause, select: { id: true } });
    const ids = matches.map(m => m.id);
    if (ids.length === 0) { console.log('No test matches found'); await prisma.$disconnect(); return; }
    await prisma.invitation.deleteMany({ where: { matchId: { in: ids } } });
    await prisma.matchPlayer.deleteMany({ where: { matchId: { in: ids } } });
    const deleted = await prisma.match.deleteMany({ where: { id: { in: ids } } });
    console.log('Deleted matches:', deleted.count);
    await prisma.$disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
