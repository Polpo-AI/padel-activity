/**
 * IMPORT VCF
 * 
 * Importa contatti da un file .vcf esportato dalla rubrica del telefono.
 * Filtra per keyword nel nome del contatto (es. "Padel").
 * 
 * Usage:
 *   npx ts-node scripts/import-vcf.ts --file=rubrica.vcf --keyword=Padel --level=INTERMEDIATE
 *   npx ts-node scripts/import-vcf.ts --file=rubrica.vcf --keyword=Padel --level=INTERMEDIATE --dry-run
 * 
 * Come esportare la rubrica:
 *   iPhone:  Contatti → seleziona tutti → condividi → salva come .vcf
 *   Android: Contatti → menu → Importa/Esporta → Esporta in .vcf
 */

import { PrismaClient } from '@prisma/client';
import fs from 'fs';
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

const filePath = args['file'] as string;
const keyword = (args['keyword'] as string) || 'Padel';
const level = (args['level'] as string)?.toUpperCase() || 'INTERMEDIATE';
const dryRun = args['dry-run'] === true || args['dry-run'] === 'true';

const VALID_LEVELS = ['BEGINNER', 'INTERMEDIATE', 'ADVANCED'];

if (!filePath || !VALID_LEVELS.includes(level)) {
    console.error('\n❌ Parametri mancanti o errati.');
    console.error('Usage: npx ts-node scripts/import-vcf.ts --file=rubrica.vcf --keyword=Padel --level=BEGINNER|INTERMEDIATE|ADVANCED\n');
    process.exit(1);
}

if (!fs.existsSync(filePath)) {
    console.error(`\n❌ File non trovato: ${filePath}\n`);
    process.exit(1);
}

// ── Parser VCF ─────────────────────────────────────────────────────

interface Contact {
    name: string;
    phones: string[];
}

function parseVcf(content: string): Contact[] {
    const contacts: Contact[] = [];
    const cards = content.split(/BEGIN:VCARD/i);

    for (const card of cards) {
        if (!card.toUpperCase().includes('END:VCARD')) continue;

        // Nome completo (FN) o nome strutturato (N)
        const fnMatch = card.match(/^FN:(.+)$/m);
        const name = fnMatch ? fnMatch[1].trim() : '';
        if (!name) continue;

        // Tutti i numeri di telefono nel contatto
        const phoneMatches = [...card.matchAll(/^TEL[^:]*:([+\d\s\-().]+)$/gm)];
        const phones = phoneMatches
            .map(m => normalizePhone(m[1].trim()))
            .filter(Boolean) as string[];

        contacts.push({ name, phones });
    }

    return contacts;
}

function normalizePhone(raw: string): string | null {
    const digits = raw.replace(/\D/g, '');

    if (digits.startsWith('39') && digits.length === 12) return `+${digits}`;
    if (digits.startsWith('3') && digits.length === 10) return `+39${digits}`;
    if (digits.startsWith('0039') && digits.length === 14) return `+${digits.slice(2)}`;

    // Numero estero con prefisso internazionale
    if (digits.startsWith('1') && digits.length === 11) return `+${digits}`; // US/CA
    if (digits.length > 8 && raw.startsWith('+')) return `+${digits}`;

    return null;
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
    const content = fs.readFileSync(filePath, 'utf-8');
    const allContacts = parseVcf(content);

    console.log(`\n🎾 Import VCF`);
    console.log(`   File:     ${filePath}`);
    console.log(`   Keyword:  "${keyword}"`);
    console.log(`   Livello:  ${level}`);
    console.log(`   Totale contatti nel file: ${allContacts.length}`);
    if (dryRun) console.log(`   ⚠️  DRY RUN — nessuna scrittura su DB`);

    // Filtra per keyword (case-insensitive)
    const filtered = allContacts.filter(c =>
        c.name.toLowerCase().includes(keyword.toLowerCase())
    );

    console.log(`   Contatti filtrati per "${keyword}": ${filtered.length}\n`);

    if (filtered.length === 0) {
        console.log('Nessun contatto trovato con questa keyword.');
        console.log('Verifica che i contatti siano salvati con il formato "Nome Cognome Padel".\n');
        process.exit(0);
    }

    let imported = 0;
    let alreadyPresent = 0;
    let noPhone = 0;
    let invalidPhone = 0;

    for (const contact of filtered) {
        if (contact.phones.length === 0) {
            console.log(`  ⚠️  ${contact.name} — nessun numero valido trovato`);
            noPhone++;
            continue;
        }

        // Usa il primo numero valido
        const phone = contact.phones[0];

        // Pulisci il nome rimuovendo la keyword
        const cleanName = contact.name
            .replace(new RegExp(keyword, 'gi'), '')
            .trim()
            .replace(/^[-–\s]+|[-–\s]+$/g, '');

        const existing = await prisma.player.findUnique({ where: { phoneNumber: phone } });

        if (existing) {
            console.log(`  ⏭  ${contact.name} (${phone}) — già nel DB`);
            alreadyPresent++;
            continue;
        }

        console.log(`  ✅ ${contact.name} → "${cleanName}" (${phone}) — importato come ${level}`);

        if (!dryRun) {
            await prisma.player.create({
                data: {
                    phoneNumber: phone,
                    name: cleanName || null,
                    skillLevel: level as any,
                    active: true,
                },
            });
        }

        imported++;
    }

    console.log('\n─────────────────────────────────────────');
    console.log(`  Importati:        ${imported}`);
    console.log(`  Già presenti:     ${alreadyPresent}`);
    console.log(`  Senza numero:     ${noPhone}`);
    if (dryRun) console.log('\n  ⚠️  DRY RUN: nessuna modifica effettuata');
    console.log('─────────────────────────────────────────\n');

    await prisma.$disconnect();
}

main().catch(err => {
    console.error('Errore fatale:', err);
    prisma.$disconnect();
    process.exit(1);
});
