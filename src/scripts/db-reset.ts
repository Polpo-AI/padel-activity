import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function reset() {
    await prisma.invitation.deleteMany();
    await prisma.matchFeedback.deleteMany();
    await prisma.matchPlayer.deleteMany();
    await prisma.match.deleteMany();
    await prisma.pendingOnboarding.deleteMany();
    await prisma.conversationState.deleteMany();
    await prisma.whatsAppMessage.deleteMany();
    await prisma.player.deleteMany();
    console.log('DB reset OK');
    await prisma.$disconnect();
    await pool.end();
}

reset().catch(e => { console.error(e); process.exit(1); });
