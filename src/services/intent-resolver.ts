/**
 * INTENT RESOLVER
 *
 * ✅ FIX CRITICITÀ B (Redis State):
 *    Gli stati conversazionali AWAITING_CLARIFICATION sono ora su Redis
 *    con TTL 24h, invece di query DB frequenti su WhatsAppMessage.
 *    Chiave: `state:unclear:{jid}` — zero query DB per read/write stato.
 *
 * ✅ FIX CRITICITÀ G (Loop UNCLEAR_INTENT):
 *    Contatore Redis `unclear:{jid}` con TTL 5min.
 *    Dopo MAX_ATTEMPTS tentativi → fallback menu deterministico + reset.
 *    Al tentativo CLOSED_QUESTION_AT → domanda chiusa con opzioni numerate.
 */

import { getRedis } from './queue';
import { anthropic } from './ai';
import { simulateTypingAndSend } from './whatsapp';
import pino from 'pino';

const logger = pino({ level: 'info' });

const MAX_ATTEMPTS = 5;
const CLOSED_QUESTION_AT = 4;
const STATE_TTL_SEC = 24 * 60 * 60;   // 24h — TTL stato conversazionale

// ─────────────────────────────────────────────
// CLASSIFICA CON CONFIDENZA
// ─────────────────────────────────────────────

export type Intent =
    | 'YES' | 'NO' | 'CANCEL' | 'BRING_FRIEND' | 'BRING_GROUP'
    | 'WHOLE_COURT' | 'OPT_OUT' | 'QUESTION' | 'BOOK' | 'UNKNOWN';

interface ClassificationResult {
    intent: Intent;
    confident: boolean;
}

export async function classifyWithConfidence(
    messageText: string,
    context?: string,
    history?: string
): Promise<ClassificationResult> {
    const prompt = `
Classifica questa risposta WhatsApp ricevuta da un sistema di matchmaking padel.

${context ? `Contesto immediato: ${context}` : ''}
${history ? `Cronologia chat recente:\n${history}` : ''}

Rispondi con un JSON esatto: {"intent": "VALORE", "confident": true/false}

Valori possibili per intent:
- YES (accetta, conferma, "ci sono", "vengo", "ok", "sì")
- NO (rifiuta, "non posso", "passo")
- CANCEL (disdice dopo aver già confermato)
- BRING_FRIEND (porta 1 amico)
- BRING_GROUP (porta 2+ persone)
- WHOLE_COURT (prenota tutto il campo)
- OPT_OUT (vuole uscire dalla lista)
- QUESTION (fa una domanda)
- BOOK (vuole prenotare una partita spontaneamente)
- UNKNOWN (non classificabile)

confident: true SOLO se sei molto sicuro basandoti anche sulla cronologia (es. se l'utente dice un orario dopo che gli è stato chiesto).

Messaggio: "${messageText}"

Rispondi SOLO con il JSON, nient'altro.
`;

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 30,
            temperature: 0.1,
            messages: [{ role: 'user', content: prompt }],
        });

        const content = response.content[0];
        if (content.type === 'text') {
            // ✅ FIX: rimuovi backtick markdown se l'AI li aggiunge (es. ```json ... ```)
            const clean = content.text.trim().replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
            const parsed = JSON.parse(clean);
            return {
                intent: parsed.intent as Intent,
                confident: parsed.confident === true,
            };
        }
    } catch (err) {
        logger.error({ err }, 'Error classifying intent with confidence');
    }

    return { intent: 'UNKNOWN', confident: false };
}

// ─────────────────────────────────────────────
// GESTIONE TENTATIVO FALLITO
// ─────────────────────────────────────────────

export async function handleUnclearIntent(
    jid: string,
    messageText: string,
    attemptNumber: number,
    context: string,
    availableIntents: Intent[],
    messageKey?: any
): Promise<{ shouldRetry: boolean; newAttempt: number }> {

    if (attemptNumber >= MAX_ATTEMPTS) {
        // ✅ FIX G: resa + reset stato Redis (non DB)
        await clearUnclearState(jid);
        await simulateTypingAndSend(
            jid,
            "Ok, lasciamo perdere per ora 😅 Scrivimi quando sei pronto e ripartiamo da capo!",
            messageKey
        );
        return { shouldRetry: false, newAttempt: 0 };
    }

    const nextAttempt = attemptNumber + 1;
    // ✅ FIX B: aggiorna stato su Redis, non su WhatsAppMessage
    await setUnclearState(jid, nextAttempt, context, availableIntents);

    if (nextAttempt >= CLOSED_QUESTION_AT) {
        const optionsText = buildClosedQuestion(availableIntents, context);
        await simulateTypingAndSend(jid, optionsText, messageKey);
    } else {
        const question = generateRephrasedQuestion(messageText, attemptNumber, context);
        await simulateTypingAndSend(jid, question, messageKey);
    }

    return { shouldRetry: true, newAttempt: nextAttempt };
}

// ─────────────────────────────────────────────
// GENERA DOMANDA RIFORMULATA (sincrona — nessuna call AI)
// ─────────────────────────────────────────────

function generateRephrasedQuestion(
    _originalText: string,
    attempt: number,
    context: string
): string {
    const rephrases = [
        `Scusa, non ho capito bene 😅 ${context} Puoi dirmi più chiaramente?`,
        `Perdonami, sono un po' lento oggi 😄 ${context} Cosa intendi esattamente?`,
        `Ancora non ti seguo bene, scusa! ${context} Prova a dirmelo in un altro modo?`,
    ];
    return rephrases[attempt % rephrases.length];
}

// ─────────────────────────────────────────────
// DOMANDA CHIUSA (tentativo 4)
// ─────────────────────────────────────────────

function buildClosedQuestion(intents: Intent[], _context: string): string {
    const intentLabels: Partial<Record<Intent, string>> = {
        YES: '✅ Sì, confermo',
        NO: '❌ No, non vengo',
        CANCEL: '🚫 Devo disdire',
        BRING_FRIEND: '👤 Porto un amico',
        BRING_GROUP: '👥 Porto più persone',
        WHOLE_COURT: '🎾 Prenotiamo tutto il campo',
        OPT_OUT: '🔕 Non voglio più ricevere inviti',
        BOOK: '📅 Voglio prenotare una partita',
    };

    const options = intents
        .filter(i => i !== 'UNKNOWN' && i !== 'QUESTION')
        .map((i, idx) => `${idx + 1}. ${intentLabels[i] || i}`)
        .join('\n');

    return `Ok proviamo così! Cosa volevi dirmi?\n\n${options}\n\nRispondimi con il numero 😊`;
}

// ─────────────────────────────────────────────
// STATO "INTENT POCO CHIARO" — ✅ FIX B+G: ora su Redis con TTL
// Chiave: state:unclear:{jid}
// ─────────────────────────────────────────────

function redisKey(jid: string): string {
    return `state:unclear:${jid}`;
}

export async function setUnclearState(
    jid: string,
    attempt: number,
    context: string,
    availableIntents: Intent[]
): Promise<void> {
    try {
        const redis = getRedis();
        const payload = JSON.stringify({ attempt, context, availableIntents });
        await redis.set(redisKey(jid), payload, 'EX', STATE_TTL_SEC);
        logger.debug({ jid, attempt }, 'Unclear state saved to Redis');
    } catch (err) {
        logger.error({ err, jid }, 'Failed to save unclear state to Redis');
    }
}

export async function getUnclearState(
    jid: string
): Promise<{ attempt: number; context: string; availableIntents: Intent[] } | null> {
    try {
        const redis = getRedis();
        const raw = await redis.get(redisKey(jid));
        if (!raw) return null;
        return JSON.parse(raw);
    } catch (err) {
        logger.error({ err, jid }, 'Failed to read unclear state from Redis');
        return null;
    }
}

export async function clearUnclearState(jid: string): Promise<void> {
    try {
        const redis = getRedis();
        await redis.del(redisKey(jid));
        logger.debug({ jid }, 'Unclear state cleared from Redis');
    } catch (err) {
        logger.error({ err, jid }, 'Failed to clear unclear state from Redis');
    }
}
