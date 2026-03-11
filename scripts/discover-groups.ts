/**
 * DISCOVER GROUPS
 * 
 * Stampa tutti i gruppi WA di cui fa parte il bot con il relativo JID.
 * 
 * Usage: npx ts-node scripts/discover-groups.ts
 */

import { makeWASocket, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import pino from 'pino';

async function main() {
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

        console.log('\n📋 Gruppi trovati:\n');

        const groups = await sock.groupFetchAllParticipating();
        const entries = Object.entries(groups);

        if (entries.length === 0) {
            console.log('Nessun gruppo trovato. Assicurati che il bot sia stato aggiunto ad almeno un gruppo.');
            process.exit(0);
        }

        // Stampa tabella leggibile
        entries.forEach(([jid, meta]) => {
            const memberCount = meta.participants.length;
            console.log(`  "${meta.subject}"`);
            console.log(`   JID: ${jid}`);
            console.log(`   Membri: ${memberCount}`);
            console.log('');
        });

        console.log('─────────────────────────────────────────');
        console.log('Copia i JID che ti servono e usali con:');
        console.log('  npx ts-node scripts/import-group.ts --jid=<JID> --level=INTERMEDIATE');
        console.log('─────────────────────────────────────────\n');

        process.exit(0);
    });
}

main().catch(err => {
    console.error('Errore:', err);
    process.exit(1);
});
