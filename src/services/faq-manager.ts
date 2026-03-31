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
    suggestedQuestion?: string;  // only for MERGE
    suggestedAnswer?: string;    // only for MERGE
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

    const prompt = `Sei un curatore di FAQ per un circolo padel italiano. Analizza la nuova domanda+risposta e confrontala con le FAQ esistenti.

NUOVA FAQ:
${JSON.stringify({ question: newQuestion, answer: newAnswer })}

FAQ ESISTENTI:
${JSON.stringify(existingFaqs.map(f => ({ id: f.id, question: f.question, answer: f.answer })))}

Decidi una delle seguenti opzioni:
- "NEW": nessuna sovrapposizione significativa, salva come nuova FAQ
- "DUPLICATE": già completamente coperta da una FAQ esistente (restituisci il suo id)
- "CONFLICT": contraddice una FAQ esistente (restituisci l'id + la ragione)
- "MERGE": simile/complementare a una FAQ esistente, proponi una Q+A unificata (restituisci id + suggestedQuestion + suggestedAnswer)

Rispondi SOLO con JSON valido, nessun testo aggiuntivo. Schema:
{
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
