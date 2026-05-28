import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { generateInvitation } from '../services/ai';
import type { MatchSocialContext } from '../services/matchmaker';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const PLAYER_NAME = 'Davide';
const REPEATS = 3; // ripetizioni per scenario → mostra la varietà del saluto

async function run(label: string, fn: () => Promise<string>) {
    console.log(`\n=== ${label} ===`);
    for (let i = 0; i < REPEATS; i++) {
        const text = await fn();
        console.log(`  [${i + 1}] ${text.replace(/\n/g, '\n      ')}`);
    }
}

async function main() {
    // Club + court reali → aiTone, nome campo e prezzo come in produzione
    const club = await prisma.club.findFirst({ include: { courts: true } });
    if (!club) { console.error('Nessun club nel DB'); return; }
    const court = club.courts[0] ?? null;
    const clubId = club.id;
    const courtId = court?.id ?? null;
    console.log(`Club: ${club.name} | Campo: ${court?.name ?? '—'} | aiTone: ${club.aiTone ? 'sì' : 'default'}`);

    // Sabato pomeriggio fittizio
    const matchTime = new Date();
    matchTime.setDate(matchTime.getDate() + 3);
    matchTime.setHours(18, 30, 0, 0);

    const ctxEmpty: MatchSocialContext = { spotsLeft: 3, timeOfDay: 'sera', players: [], hasPlayedWithBefore: false };
    const ctxThree: MatchSocialContext = {
        spotsLeft: 1,
        timeOfDay: 'sera',
        players: [
            { name: 'A', skillLevel: 3.0, matchesLast30Days: 4, acceptanceRate: 0.8 },
            { name: 'B', skillLevel: 3.5, matchesLast30Days: 2, acceptanceRate: 0.6 },
            { name: 'C', skillLevel: 3.2, matchesLast30Days: 5, acceptanceRate: 0.9 },
        ],
        hasPlayedWithBefore: true,
    };

    await run('Gruppo vuoto (confirmedCount=0)', () =>
        generateInvitation(PLAYER_NAME, matchTime, courtId, clubId, false, ctxEmpty, { isMixed: false, targetGender: null }));

    await run('3 confermati + ha già giocato con loro', () =>
        generateInvitation(PLAYER_NAME, matchTime, courtId, clubId, false, ctxThree, { isMixed: false, targetGender: null }));

    await run('Partita mista', () =>
        generateInvitation(PLAYER_NAME, matchTime, courtId, clubId, false, ctxEmpty, { isMixed: true, targetGender: null }));

    await run('Invito da amico (isFriend=true)', () =>
        generateInvitation(PLAYER_NAME, matchTime, courtId, clubId, true, ctxEmpty, { isMixed: false, targetGender: null }));

    await prisma.$disconnect();
    await pool.end();
}

main().catch(err => { console.error(err); process.exit(1); });
