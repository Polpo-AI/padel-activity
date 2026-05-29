/**
 * test-faq-review.ts
 * Valuta la review automatica FAQ (analyzeFaq): riscrittura domanda + rilevamento duplicati.
 * Eseguire SUL VPS staging:
 *   npx tsx src/scripts/test-faq-review.ts
 */

import 'dotenv/config';
import { analyzeFaq } from '../services/faq-manager';

const BALLS_ANSWER = 'Il circolo fornisce gratuitamente le palle da padel, che devono essere riconsegnate in segreteria a fine partita.';
const BALLS_FAQ = { id: 'f-balls', question: 'Il circolo fornisce le palline per le partite?', answer: BALLS_ANSWER };

type Scenario = {
    name: string;
    question: string;
    answer: string;
    existing: { id: string; question: string; answer: string }[];
    expectDecision: string[];           // decisioni accettabili
    expectRewritten?: boolean;          // se la domanda deve risultare riformulata
    questionMustDiffer?: boolean;       // normalizedQuestion ≠ domanda grezza
    questionMustNotContain?: string[];  // frammenti che NON devono comparire
};

const scenarios: Scenario[] = [
    {
        name: 'A) Frammento "Se sì, qual è il costo?" con duplicato esistente',
        question: 'Se sì, qual è il costo?',
        answer: BALLS_ANSWER,
        existing: [BALLS_FAQ],
        expectDecision: ['DUPLICATE', 'MERGE'],
        expectRewritten: true,
        questionMustDiffer: true,
        questionMustNotContain: ['se sì', 'se si'],
    },
    {
        name: 'B) Formulazione alternativa "fornisce palline da padel?" → duplicato',
        question: 'Il circolo fornisce palline da padel?',
        answer: BALLS_ANSWER,
        existing: [BALLS_FAQ],
        expectDecision: ['DUPLICATE', 'MERGE'],
    },
    {
        name: 'C) Domanda nuova e chiara (orari sabato)',
        question: 'a che ora chiudete il sabato?',
        answer: 'Il sabato il circolo chiude alle 22:00.',
        existing: [BALLS_FAQ],
        expectDecision: ['NEW'],
        questionMustDiffer: true, // dovrebbe diventare "A che ora chiude il circolo il sabato?"
    },
    {
        name: 'D) Frammento "e le docce?" SENZA FAQ esistenti (fast-path)',
        question: 'e le docce?',
        answer: 'Sì, gli spogliatoi hanno docce con acqua calda.',
        existing: [],
        expectDecision: ['NEW'],
        expectRewritten: true,
        questionMustDiffer: true,
        questionMustNotContain: ['e le docce'],
    },
];

async function main() {
    console.log('\n╔════════════════════════════════════════════╗');
    console.log('║        TEST FAQ REVIEW — analyzeFaq         ║');
    console.log('╚════════════════════════════════════════════╝\n');

    let passed = 0;
    let failed = 0;

    for (const s of scenarios) {
        const r = await analyzeFaq(s.question, s.answer, s.existing);
        const norm = (r.normalizedQuestion || '').trim();
        const fails: string[] = [];

        if (!s.expectDecision.includes(r.decision))
            fails.push(`decision atteso ${s.expectDecision.join('|')}, ricevuto ${r.decision}`);
        if (!norm)
            fails.push('normalizedQuestion mancante');
        if (s.questionMustDiffer && norm && norm.toLowerCase() === s.question.trim().toLowerCase())
            fails.push('normalizedQuestion identica alla grezza (non riscritta)');
        if (s.expectRewritten && r.questionRewritten !== true)
            fails.push(`questionRewritten atteso true, ricevuto ${r.questionRewritten}`);
        if (s.questionMustNotContain) {
            for (const frag of s.questionMustNotContain) {
                if (norm.toLowerCase().includes(frag.toLowerCase()))
                    fails.push(`normalizedQuestion contiene il frammento "${frag}"`);
            }
        }

        const ok = fails.length === 0;
        ok ? passed++ : failed++;

        console.log(`${ok ? '✅' : '❌'} ${s.name}`);
        console.log(`   grezza:      "${s.question}"`);
        console.log(`   normalizzata:"${norm}"`);
        console.log(`   decision:    ${r.decision}${r.relatedFaqId ? ` (→ ${r.relatedFaqId})` : ''}  rewritten:${r.questionRewritten}`);
        console.log(`   reason:      ${r.reason}`);
        if (!ok) console.log(`   ⚠ FAIL: ${fails.join(' | ')}`);
        console.log();
    }

    console.log('────────────────────────────────────────────');
    console.log(`  Risultato: ${passed} passati, ${failed} falliti su ${scenarios.length}`);
    console.log('────────────────────────────────────────────\n');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
