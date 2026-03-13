/**
 * AI SERVICE
 *
 * Wrapper per Anthropic Claude e OpenAI Whisper.
 * Ogni chiamata ha:
 * - Retry esponenziale (3 tentativi, backoff 1s/2s/4s)
 * - Fallback deterministico se tutti i tentativi falliscono
 * - Timeout esplicito per evitare hanging
 */

import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { withRetry, isTransientNetworkError } from '../utils/retry';
import pino from 'pino';

const logger = pino({ level: 'info' });

export const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 30000,
    maxRetries: 0, // gestiamo noi
});

export const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 60000,
    maxRetries: 0,
});

// ─────────────────────────────────────────────
// INTENT CLASSIFICATION
// ─────────────────────────────────────────────

export type Intent =
    | 'YES' | 'NO' | 'CANCEL' | 'BRING_FRIEND' | 'BRING_GROUP'
    | 'WHOLE_COURT' | 'OPT_OUT' | 'QUESTION' | 'BOOK' | 'UNKNOWN';

export async function classifyIntent(
    text: string,
    context?: string,
    history?: string
): Promise<{ intent: Intent; confident: boolean }> {
    try {
        const result = await withRetry(
            () => anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 30,
                temperature: 0.1,
                messages: [{
                    role: 'user',
                    content: `Classifica questa risposta WhatsApp (matchmaking padel).
${context ? `Contesto: ${context}` : ''}
${history ? `Cronologia recente:\n${history}` : ''}

Rispondi SOLO con JSON: {"intent":"VALORE","confident":true/false}
Valori: YES, NO, CANCEL, BRING_FRIEND, BRING_GROUP, WHOLE_COURT, OPT_OUT, QUESTION, BOOK, UNKNOWN
confident: true solo se molto sicuro basandoti anche sulla cronologia (es. se l'utente dice orario dopo che gli è stato chiesto).

Messaggio: "${text}"`,
                }],
            }),
            {
                maxAttempts: 3,
                baseDelayMs: 1000,
                shouldRetry: isTransientNetworkError,
                context: 'classifyIntent',
            }
        );

        const content = result.content[0];
        if (content.type === 'text') {
            const parsed = JSON.parse(content.text.trim());
            return { intent: parsed.intent as Intent, confident: parsed.confident === true };
        }
    } catch (err) {
        logger.error({ err }, 'classifyIntent failed after retries — UNKNOWN fallback');
    }

    return { intent: 'UNKNOWN', confident: false };
}

// ─────────────────────────────────────────────
// GENERA INVITO
// ─────────────────────────────────────────────

export async function generateInvitation(
    playerName: string,
    matchTime: Date,
    court: string,
    clubId?: string,
    isFriend = false
): Promise<string> {
    const timeStr = matchTime.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    const dateStr = matchTime.toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });

    const fallback = isFriend
        ? `Ciao ${playerName}! Un amico ti ha invitato a giocare a padel ${dateStr} alle ${timeStr} (${court}). Sei disponibile? 🎾`
        : `Ciao ${playerName}! C'è una partita di padel ${dateStr} alle ${timeStr} (${court}). Sei dei nostri? 🎾`;

    try {
        let aiTone = '';
        if (clubId) {
            const { prisma } = await import('./db');
            const club = await prisma.club.findUnique({ where: { id: clubId }, select: { aiTone: true } });
            aiTone = club?.aiTone || '';
        }

        const result = await withRetry(
            () => anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 150,
                temperature: 0.7,
                system: aiTone || 'Sei il bot di un circolo padel. Scrivi messaggi SUPER BREVI, diretti e amichevoli in italiano. Vai subito al punto.',
                messages: [{
                    role: 'user',
                    content: `Scrivi un invito WhatsApp brevissimo (max 10-15 parole) per ${playerName} per una partita ${dateStr} alle ${timeStr} al ${court}. ${isFriend ? 'Invito da un amico.' : ''} Solo il testo del messaggio.`,
                }],
            }),
            {
                maxAttempts: 3,
                baseDelayMs: 1000,
                shouldRetry: isTransientNetworkError,
                context: 'generateInvitation',
            }
        );

        const content = result.content[0];
        if (content.type === 'text') return content.text.trim();
    } catch (err) {
        logger.error({ err }, 'generateInvitation failed — using fallback');
    }

    logger.warn({ playerName }, '⚠️ generateInvitation using FALLBACK text');
    return fallback;
}

// ─────────────────────────────────────────────
// TRASCRIVI AUDIO (Whisper)
// ─────────────────────────────────────────────

export class TranscriptionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TranscriptionError';
    }
}

export async function transcribeAudio(
    audioBuffer: Buffer,
    format: string = 'ogg'
): Promise<string> {
    try {
        const result = await withRetry(
            async () => {
                const file = new File([audioBuffer as any], `audio.${format}`, { type: `audio/${format}` });
                return openai.audio.transcriptions.create({
                    file,
                    model: 'whisper-1',
                    language: 'it',
                });
            },
            {
                maxAttempts: 3,
                baseDelayMs: 2000,
                shouldRetry: isTransientNetworkError,
                context: 'transcribeAudio',
            }
        );
        return result.text.trim();
    } catch (err) {
        logger.error({ err }, 'transcribeAudio failed after retries');
        throw new TranscriptionError('Trascrizione audio non disponibile');
    }
}

// ─────────────────────────────────────────────
// ESTRAI NUMERO TELEFONO
// ─────────────────────────────────────────────

export async function extractPhoneNumber(text: string): Promise<string | null> {
    // Regex deterministico prima (zero costi, zero latenza)
    const phoneRegex = /(\+?39)?[\s.-]?3\d{2}[\s.-]?\d{6,7}/g;
    const match = text.match(phoneRegex);
    if (match) {
        const cleaned = match[0].replace(/[\s.-]/g, '');
        return cleaned.startsWith('+') ? cleaned : `+39${cleaned.replace(/^39/, '')}`;
    }

    // Fallback AI per formati non standard
    try {
        const result = await withRetry(
            () => anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 20,
                temperature: 0,
                messages: [{
                    role: 'user',
                    content: `Estrai il numero di telefono. Rispondi SOLO con +39XXXXXXXXXX o NULL. Testo: "${text}"`,
                }],
            }),
            { maxAttempts: 2, context: 'extractPhoneNumber' }
        );
        const content = result.content[0];
        if (content.type === 'text') {
            const val = content.text.trim();
            return val === 'NULL' ? null : val;
        }
    } catch (err) {
        logger.error({ err }, 'extractPhoneNumber AI failed');
    }

    return null;
}

// ─────────────────────────────────────────────
// ESTRAI LIVELLO DI GIOCO
// ─────────────────────────────────────────────

export async function extractSkillLevel(
    text: string,
    maxLevel: number = 3
): Promise<number | null> {
    // Deterministico prima
    const numMatch = text.match(/\b([1-5])\b/);
    if (numMatch) {
        const val = parseInt(numMatch[1]);
        if (val >= 1 && val <= maxLevel) return val;
    }

    const lower = text.toLowerCase();
    if (lower.includes('principiante') || lower.includes('base')) return 1;
    if (lower.includes('avanzato') || lower.includes('alto')) return maxLevel;
    if (lower.includes('intermedio') || lower.includes('medio')) return Math.ceil(maxLevel / 2);

    // Fallback AI
    try {
        const result = await withRetry(
            () => anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 5,
                temperature: 0,
                messages: [{
                    role: 'user',
                    content: `Sei un esperto di padel italiano. Devi classificare il livello di un giocatore da 1 a ${maxLevel} basandoti su quello che scrive, anche se usa espressioni colloquiali o dialettali.

Esempi:
- "principiante", "sono una schiappa", "non so giocare", "ho iniziato da poco" → 1
- "intermedio", "me la cavicchio", "gioco da qualche anno", "non sono male", "abbastanza bene", "discreto" → ${Math.ceil(maxLevel / 2)}
- "avanzato", "gioco a buon livello", "sono forte", "gioco in torneo", "agonista" → ${maxLevel}

Rispondi SOLO con il numero intero (da 1 a ${maxLevel}), nient'altro. Se il messaggio suggerisce un livello intermedio e il massimo è 3, rispondi 2. Se il massimo è 5, rispondi 3.
Messaggio del giocatore: "${text}"`,
                }],
            }),
            { maxAttempts: 2, context: 'extractSkillLevel' }
        );
        const content = result.content[0];
        if (content.type === 'text') {
            const val = parseInt(content.text.trim());
            if (!isNaN(val) && val >= 1 && val <= maxLevel) return val;
        }
    } catch (err) {
        logger.error({ err }, 'extractSkillLevel AI failed');
    }

    return null;
}
export async function inferGender(name: string): Promise<'MALE' | 'FEMALE' | 'UNKNOWN'> {
    if (!name || name === 'Giocatore') return 'UNKNOWN';

    try {
        const result = await withRetry(
            () => anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 10,
                temperature: 0,
                messages: [{
                    role: 'user',
                    content: `Determina il genere di una persona basandoti sul nome italiano: "${name}".
Rispondi SOLO con una di queste parole: MALE, FEMALE, UNKNOWN.
Se il nome è ambiguo o internazionale (es. Alex, Andrea), rispondi UNKNOWN.`,
                }],
            }),
            { maxAttempts: 2, context: 'inferGender' }
        );
        const content = result.content[0];
        if (content.type === 'text') {
            const val = content.text.trim().toUpperCase();
            if (['MALE', 'FEMALE', 'UNKNOWN'].includes(val)) return val as any;
        }
    } catch (err) {
        logger.error({ err }, 'inferGender failed');
    }

    return 'UNKNOWN';
}
