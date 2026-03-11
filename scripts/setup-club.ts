/**
 * SETUP CLUB
 *
 * Script interattivo da girare una sola volta per configurare il circolo.
 * Crea il record Club, i Court, le credenziali dashboard.
 *
 * Usage: npx ts-node scripts/setup-club.ts
 */

import { PrismaClient } from '@prisma/client';
import * as readline from 'readline';
import * as bcrypt from 'bcrypt';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> => new Promise(resolve => rl.question(q, resolve));
const askBool = async (q: string): Promise<boolean> => {
    const r = await ask(`${q} (s/n): `);
    return r.toLowerCase().startsWith('s');
};
const askInt = async (q: string, def: number): Promise<number> => {
    const r = await ask(`${q} [default: ${def}]: `);
    return parseInt(r) || def;
};

async function main() {
    console.log('\n🎾 SETUP CIRCOLO PADEL BOT\n');
    console.log('━'.repeat(40));

    // ── Dati base ──────────────────────────────
    const name = await ask('\nNome del circolo: ');
    const adminPhone = await ask('Numero WhatsApp admin (es. +393471234567): ');
    const timezone = await ask('Timezone [default: Europe/Rome]: ') || 'Europe/Rome';
    const openTime = await ask('Orario apertura campi [default: 08:00]: ') || '08:00';
    const closeTime = await ask('Orario chiusura campi [default: 23:30]: ') || '23:30';
    const matchDuration = await askInt('Durata partita in minuti', 90);

    // ── Campi ──────────────────────────────────
    console.log('\n━'.repeat(40));
    console.log('📋 CONFIGURAZIONE CAMPI');
    const courtCount = await askInt('\nQuanti campi ha il circolo?', 2);
    const courts: string[] = [];
    for (let i = 1; i <= courtCount; i++) {
        const courtName = await ask(`Nome campo ${i} [default: Campo ${i}]: `) || `Campo ${i}`;
        courts.push(courtName);
    }

    // ── Livelli ────────────────────────────────
    console.log('\n━'.repeat(40));
    console.log('🏆 CONFIGURAZIONE LIVELLI');
    const skillLevelCount = await askInt('\nQuanti livelli di bravura hai? (3 = Principiante/Intermedio/Avanzato, 5 = scala completa)', 3);

    const allowMixedLevels = await askBool('\nVuoi permettere partite miste tra livelli adiacenti?');
    let mixedLevelRange = 1;
    if (allowMixedLevels) {
        mixedLevelRange = await askInt('Quanti livelli adiacenti possono giocare insieme?', 1);
    }

    // ── Wave ───────────────────────────────────
    console.log('\n━'.repeat(40));
    console.log('📡 CONFIGURAZIONE WAVE');
    const waveMultiplier = await askInt('\nMoltiplicatore wave (posti_mancanti × X = persone da contattare)', 3);
    const deadlineMinutesBeforeMatch = await askInt('Minuti prima della partita oltre cui si cancella se non è piena', 60);

    // ── Tono AI ────────────────────────────────
    console.log('\n━'.repeat(40));
    console.log('🤖 PERSONALITÀ BOT');
    console.log('Descrivi il tono che vuoi per i messaggi del bot');
    console.log('Es. "Sei il bot del Circolo Roma Padel, usa un tono amichevole e informale"');
    const aiTone = await ask('\nTono AI [invio per default]: ') ||
        `Sei il bot di ${name}, usa un tono amichevole e informale tipico della cultura padel italiana.`;

    // ── Credenziali dashboard ──────────────────
    console.log('\n━'.repeat(40));
    console.log('🔐 CREDENZIALI DASHBOARD');
    const dashboardUsername = await ask('\nUsername dashboard: ');
    const dashboardPassword = await ask('Password dashboard: ');
    const dashboardPasswordHash = await bcrypt.hash(dashboardPassword, 10);

    // ── Conferma ───────────────────────────────
    console.log('\n━'.repeat(40));
    console.log('\n📋 RIEPILOGO CONFIGURAZIONE:\n');
    console.log(`  Circolo:        ${name}`);
    console.log(`  Admin WA:       ${adminPhone}`);
    console.log(`  Campi (${courtCount}):     ${courts.join(', ')}`);
    console.log(`  Livelli:        ${skillLevelCount}`);
    console.log(`  Livelli misti:  ${allowMixedLevels ? `sì (±${mixedLevelRange})` : 'no'}`);
    console.log(`  Wave ×:         ${waveMultiplier}`);
    console.log(`  Deadline:       ${deadlineMinutesBeforeMatch} min prima`);
    console.log(`  Dashboard user: ${dashboardUsername}`);

    const confirm = await askBool('\nConfermi la configurazione?');
    if (!confirm) {
        console.log('\nSetup annullato.\n');
        process.exit(0);
    }

    // ── Salva su DB ────────────────────────────
    console.log('\n⏳ Salvataggio in corso...');

    const club = await prisma.club.create({
        data: {
            name,
            adminPhone,
            timezone,
            openTime,
            closeTime,
            matchDuration,
            skillLevelCount,
            allowMixedLevels,
            mixedLevelRange,
            waveMultiplier,
            deadlineMinutesBeforeMatch,
            aiTone,
            dashboardUsername,
            dashboardPasswordHash,
            courts: {
                create: courts.map(courtName => ({ name: courtName })),
            },
        },
        include: { courts: true },
    });

    console.log(`\n✅ Circolo "${club.name}" creato con ID: ${club.id}`);
    console.log(`✅ ${club.courts.length} campi creati: ${club.courts.map(c => c.name).join(', ')}`);
    console.log(`✅ Dashboard: http://tuoserver.com/padel-dashboard (username: ${dashboardUsername})`);
    console.log('\n🎾 Setup completato! Ora puoi importare i giocatori:\n');
    console.log('   npx ts-node scripts/discover-groups.ts');
    console.log('   npx ts-node scripts/import-group.ts --jid=XXX --level=3');
    console.log('   npx ts-node scripts/import-vcf.ts --file=rubrica.vcf --keyword=Padel --level=3\n');

    rl.close();
    await prisma.$disconnect();
}

main().catch(err => {
    console.error('Errore:', err);
    rl.close();
    prisma.$disconnect();
    process.exit(1);
});
