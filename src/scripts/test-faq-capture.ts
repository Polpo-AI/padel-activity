/**
 * test-faq-capture.ts
 * Valuta che il brain produca una domanda FAQ AUTOCONTENUTA risolvendo il contesto
 * della conversazione (frammenti follow-up tipo "quanto costano?" → "Quanto costano le palline?").
 * Eseguire SUL VPS staging:
 *   npx tsx src/scripts/test-faq-capture.ts
 */

import 'dotenv/config';
import { buildBrainContext, callBrain, BrainContext } from '../services/brain';

const JID = '393334318834@s.whatsapp.net';
const PHONE = '393334318834';

// Cronologia (oldest → newest)
const M = (role: 'USER' | 'BOT', content: string) => ({ role, content });

type Scenario = {
    name: string;
    history: { role: string; content: string }[];
    userMessage: string;
    mustMention: string[];       // la domanda generata deve contenere uno di questi
    mustNotEqual?: string;       // non deve essere identica al frammento grezzo
};

const scenarios: Scenario[] = [
    {
        name: 'T1) Prima domanda chiara (baseline)',
        history: [],
        userMessage: 'le palline sono comprese nel prezzo del campo?',
        mustMention: ['pallin'],
    },
    {
        name: 'T2) Follow-up "quanto costano?" dopo aver parlato di palline',
        history: [
            M('USER', 'le palline sono comprese nel prezzo del campo?'),
            M('BOT', 'Non ho questa info al momento, la verifico col circolo e ti rispondo presto.'),
        ],
        userMessage: 'quanto costano?',
        mustMention: ['pallin'],
        mustNotEqual: 'quanto costano?',
    },
    {
        name: 'T3) Follow-up "e quante sono?" nello stesso filo',
        history: [
            M('USER', 'le palline sono comprese nel prezzo del campo?'),
            M('BOT', 'Non ho questa info al momento, la verifico col circolo e ti rispondo presto.'),
            M('USER', 'quanto costano le palline?'),
            M('BOT', 'Anche su questo verifico col circolo e ti aggiorno!'),
        ],
        userMessage: 'e quante sono?',
        mustMention: ['pallin'],
        mustNotEqual: 'e quante sono?',
    },
];

async function main() {
    console.log('\n╔════════════════════════════════════════════╗');
    console.log('║   TEST FAQ CAPTURE — brain context resolve  ║');
    console.log('╚════════════════════════════════════════════╝\n');

    const base = await buildBrainContext(JID, PHONE);
    // Isola il comportamento FAQ: nessuna FAQ già nota, nessun invito/partita che distragga
    const ctx: BrainContext = {
        ...base,
        faqs: [],
        pendingInvitations: [],
        confirmedMatches: [],
        availableMatches: [],
    };

    let passed = 0, failed = 0;

    for (const s of scenarios) {
        const r = await callBrain({ ...ctx, recentMessages: s.history }, s.userMessage);
        const q = (r.params?.question || '').trim();
        const fails: string[] = [];

        if (r.action !== 'FAQ_REQUEST')
            fails.push(`action attesa FAQ_REQUEST, ricevuta ${r.action}`);
        if (r.action === 'FAQ_REQUEST') {
            if (!q) fails.push('params.question vuota');
            if (q && !s.mustMention.some(m => q.toLowerCase().includes(m)))
                fails.push(`la domanda non menziona [${s.mustMention.join(',')}]: "${q}"`);
            if (s.mustNotEqual && q.toLowerCase() === s.mustNotEqual.toLowerCase())
                fails.push('la domanda è identica al frammento grezzo (contesto non risolto)');
        }

        const ok = fails.length === 0;
        ok ? passed++ : failed++;

        console.log(`${ok ? '✅' : '❌'} ${s.name}`);
        console.log(`   utente:   "${s.userMessage}"`);
        console.log(`   action:   ${r.action}`);
        console.log(`   question: "${q}"`);
        if (!ok) console.log(`   ⚠ FAIL: ${fails.join(' | ')}`);
        console.log();
        await new Promise(res => setTimeout(res, 2500)); // rispetta rate limit
    }

    console.log('────────────────────────────────────────────');
    console.log(`  Risultato: ${passed} passati, ${failed} falliti su ${scenarios.length}`);
    console.log('────────────────────────────────────────────\n');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
