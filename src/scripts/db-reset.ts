import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import Redis from 'ioredis';

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

    // Flush Redis BullMQ queues to prevent ghost wave/maintenance jobs
    // from re-running on non-existent matchIds after a DB reset.
    // ⚠️ This deletes ALL Redis keys — do NOT run on production.
    const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
    await redis.flushdb();
    await redis.quit();
    console.log('Redis flushed OK');

    await prisma.$disconnect();
    await pool.end();
}

reset().catch(e => { console.error(e); process.exit(1); });
