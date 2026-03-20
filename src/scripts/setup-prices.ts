import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function main() {
    const clubs = await prisma.club.findMany({ select: { id: true, name: true, racketPrice: true } });
    console.log('Clubs:', JSON.stringify(clubs, null, 2));

    const courts = await prisma.court.findMany({ include: { prices: true } });
    console.log('Courts:', JSON.stringify(courts, null, 2));

    if (clubs.length === 0) {
        console.log('No clubs found — nothing to update');
        await prisma.$disconnect();
        pool.end();
        return;
    }

    const club = clubs[0];

    // Set racketPrice = 5 on first club
    await prisma.club.update({
        where: { id: club.id },
        data: { racketPrice: 5.0 },
    });
    console.log(`Updated ${club.name} racketPrice → 5€`);

    // For each court without a price, add a default 40€ price
    for (const court of courts) {
        if (court.clubId !== club.id) continue;
        if (court.prices.length === 0) {
            await prisma.courtPrice.create({
                data: {
                    courtId: court.id,
                    startTime: '08:00',
                    endTime: '23:30',
                    price: 40.0,
                },
            });
            console.log(`Created CourtPrice 40€ for court ${court.name}`);
        } else {
            console.log(`Court ${court.name} already has ${court.prices.length} price(s) — skipping`);
        }
    }

    await prisma.$disconnect();
    pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
