/**
 * FAQ MANAGER
 *
 * AI-powered FAQ curator using Claude Haiku.
 * Analyzes new Q+A pairs against existing FAQs to detect:
 * - NEW: no overlap, save as is
 * - DUPLICATE: already fully covered by an existing FAQ
 * - CONFLICT: contradicts an existing FAQ
 * - MERGE: similar/complementary, propose a unified Q+A
 */

import { anthropic } from './ai';
import { withRetry, isTransientNetworkError } from '../utils/retry';
import pino from 'pino';

const logger = pino({ level: 'info' });

export type FaqDecision = 'NEW' | 'DUPLICATE' | 'CONFLICT' | 'MERGE';

export interface FaqAnalysisResult {
    decision: FaqDecision;
    relatedFaqId?: string;
    reason: string;
    suggestedQuestion?: string;  // for MERGE
    suggestedAnswer?: string;    // for MERGE
    /** Domanda riscritta in forma chiara, completa e autonoma (sempre presente). */
    normalizedQuestion?: string;
    /** true se la domanda originale era un frammento/ambigua ed è stata riformulata. */
    questionRewritten?: boolean;
}

export async function analyzeFaq(
    newQuestion: string,
    newAnswer: string,
    existingFaqs: { id: string; question: string; answer: string }[]
): Promise<FaqAnalysisResult> {
    // Fast-path: no existing FAQs → always NEW
    if (!existingFaqs || existingFaqs.length === 0) {
        return { decision: 'NEW', reason: 'Nessuna FAQ esistente.' };
    }

    const prompt = `Sei un curatore di FAQ per un circolo padel italiano. Fai due cose: (1) RISCRIVI la domanda in forma pulita, e (2) confrontala con le FAQ esistenti.

NUOVA FAQ (domanda grezza, estratta da una chat):
${JSON.stringify({ question: newQuestion, answer: newAnswer })}

FAQ ESISTENTI:
${JSON.stringify(existingFaqs.map(f => ({ id: f.id, question: f.question, answer: f.answer })))}

═══ PASSO 1 — RISCRITTURA DOMANDA (normalizedQuestion) ═══
La domanda grezza spesso è un frammento dipendente dal contesto (es. "se sì quali?", "e il costo?", "a che ora?"), incompleta o sgrammaticata. Devi SEMPRE produrre "normalizedQuestion": una domanda autonoma, chiara, completa e generica (riutilizzabile da chiunque), ricavando il vero significato dalla RISPOSTA.
Esempi:
- "se sì quali?" + risposta sulle palline fornite → "Il circolo fornisce le palline per le partite?"
- "e il costo?" + risposta sul noleggio racchette → "Quanto costa noleggiare una racchetta?"
Imposta "questionRewritten": true se l'hai modificata in modo sostanziale, false se era già chiara e autonoma.

═══ PASSO 2 — CONFRONTO CON ESISTENTI ═══
Confronta la normalizedQuestion (NON la grezza) con le FAQ esistenti e decidi:
- "NEW": nessuna sovrapposizione significativa, salva come nuova FAQ
- "DUPLICATE": stessa domanda/argomento già coperto da una FAQ esistente (restituisci il suo id). Due formulazioni diverse della stessa domanda sono DUPLICATE, non NEW.
- "CONFLICT": contraddice una FAQ esistente (restituisci l'id + la ragione)
- "MERGE": simile/complementare a una FAQ esistente sullo stesso tema, proponi una Q+A unificata (restituisci id + suggestedQuestion + suggestedAnswer)

Rispondi SOLO con JSON valido, nessun testo aggiuntivo. Schema:
{
  "normalizedQuestion": "string (SEMPRE — domanda riscritta e autonoma)",
  "questionRewritten": true | false,
  "decision": "NEW" | "DUPLICATE" | "CONFLICT" | "MERGE",
  "relatedFaqId": "string (solo per DUPLICATE, CONFLICT, MERGE)",
  "reason": "string (spiega brevemente la decisione)",
  "suggestedQuestion": "string (solo per MERGE)",
  "suggestedAnswer": "string (solo per MERGE)"
}`;

    try {
        const result = await withRetry(
            () => anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 600,
                temperature: 0,
                messages: [{ role: 'user', content: prompt }],
            }),
            {
                maxAttempts: 3,
                baseDelayMs: 1000,
                shouldRetry: isTransientNetworkError,
                context: 'analyzeFaq',
            }
        );

        const content = result.content[0];
        if (content.type !== 'text') {
            logger.warn('analyzeFaq: unexpected response type');
            return { decision: 'NEW', reason: 'Risposta AI non valida, trattata come nuova.' };
        }

        const raw = content.text.trim();
        const startIdx = raw.indexOf('{');
        const endIdx = raw.lastIndexOf('}');
        if (startIdx === -1 || endIdx === -1) {
            logger.warn({ raw }, 'analyzeFaq: no JSON found in response');
            return { decision: 'NEW', reason: 'Risposta AI non parsabile, trattata come nuova.' };
        }

        const parsed = JSON.parse(raw.substring(startIdx, endIdx + 1)) as FaqAnalysisResult;

        // Validate decision field
        const validDecisions: FaqDecision[] = ['NEW', 'DUPLICATE', 'CONFLICT', 'MERGE'];
        if (!validDecisions.includes(parsed.decision)) {
            logger.warn({ parsed }, 'analyzeFaq: invalid decision value');
            return { decision: 'NEW', reason: 'Decisione AI non valida, trattata come nuova.' };
        }

        return parsed;
    } catch (err) {
        logger.error({ err }, 'analyzeFaq: error calling AI');
        return { decision: 'NEW', reason: 'Errore AI, trattata come nuova FAQ.' };
    }
}
