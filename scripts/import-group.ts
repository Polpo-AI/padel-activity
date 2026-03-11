/**
 * IMPORT GROUP
 * 
 * Importa tutti i membri di un gruppo WA nel DB con il livello specificato.
 * I membri già presenti vengono skippati (non sovrascritti).
 * 
 * Usage:
 *   npx ts-node scripts/import-group.ts --jid=120363XXXXXX@g.us --level=INTERMEDIATE
 *   npx ts-node scripts/import-group.ts --jid=120363XXXXXX@g.us --level=ADVANCED --dry-run
 * 
 * Livelli validi: BEGINNER | INTERMEDIATE | ADVANCED
 */

import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { PrismaClient } from '@prisma/client';
import pino from 'pino';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

// ── Parsing argomenti ──────────────────────────────────────────────
const args = Object.fromEntries(
    process.argv.slice(2)
        .filter(a => a.startsWith('--'))
        .map(a => {
            const [key, val] = a.slice(2).split('=');
            return [key, val ?? true];
        })
);

const groupJid = args['jid'] as string;
const level = (args['level'] as string)?.toUpperCase();
const dryRun = args['dry-run'] === true || args['dry-run'] === 'true';

const VALID_LEVELS = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'];

if (!groupJid || !level || !VALID_LEVELS.includes(level)) {
    console.error('\n❌ Parametri mancanti o errati.');
    console.error('Usage: npx ts-node scripts/import-group.ts --jid=<JID> --level=BEGINNER|INTERMEDIATE|ADVANCED\n');
    process.exit(1);
}

async function main() {
    console.log(`\n🎾 Import gruppo`);
    console.log(`   JID:    ${groupJid}`);
    console.log(`   Livello: ${level}`);
    if (dryRun) console.log(`   ⚠️  DRY RUN — nessuna scrittura su DB\n`);

    const { state, saveCreds } = await useMultiFileAuthState('baileys_auth_info');
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }) as any,
        browser: ['Polpo AI', 'MacOS', '120.0'],
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async ({ connection }) => {
        if (connection !== 'open') return;

        const botPhone = process.env.BOT_PHONE_NUMBER?.replace('+', '').replace(/\D/g, '');

        try {
            const meta = await sock.groupMetadata(groupJid);
            console.log(`📋 Gruppo: "${meta.subject}" — ${meta.participants.length} partecipanti\n`);

            let imported = 0;
            let skipped = 0;
            let alreadyPresent = 0;

            for (const participant of meta.participants) {
                const phone = participant.id.split('@')[0];

                // Salta il bot stesso
                if (botPhone && phone.includes(botPhone)) {
                    skipped++;
                    continue;
                }

                const existing = await prisma.player.findUnique({ where: { phoneNumber: phone } });

                if (existing) {
                    console.log(`  ⏭  ${phone} — già nel DB (livello: ${existing.skillLevel})`);
                    alreadyPresent++;
                    continue;
                }

                console.log(`  ✅ ${phone} — importato come ${level}`);

                if (!dryRun) {
                    await prisma.player.create({
                        data: {
                            phoneNumber: phone,
                            skillLevel: level as any,
                            groupIds: [groupJid],
                            active: true,
                        },
                    });
                }

                imported++;
            }

            console.log('\n─────────────────────────────────────────');
            console.log(`  Importati:      ${imported}`);
            console.log(`  Già presenti:   ${alreadyPresent}`);
            console.log(`  Saltati (bot):  ${skipped}`);
            if (dryRun) console.log('\n  ⚠️  DRY RUN: nessuna modifica effettuata');
            console.log('─────────────────────────────────────────\n');

        } catch (err: any) {
            if (err?.message?.includes('not-authorized') || err?.message?.includes('not a participant')) {
                console.error(`\n❌ Il bot non è membro del gruppo ${groupJid}`);
                console.error('   Aggiungi prima il bot al gruppo e riprova.\n');
            } else {
                console.error('\n❌ Errore:', err);
            }
        } finally {
            await prisma.$disconnect();
            process.exit(0);
        }
    });
}

main().catch(err => {
    console.error('Errore fatale:', err);
    process.exit(1);
});
