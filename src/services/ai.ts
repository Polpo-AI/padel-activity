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
import { loadPrompt } from '../utils/prompts';
import { claudeCircuitBreaker } from '../utils/circuit-breaker';
import { buildInvitation } from './invitation-templates';
import pino from 'pino';

const logger = pino({ level: 'info' });

const _anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 30000,
    maxRetries: 2, // SDK riprova su 429 e 5xx (incluso 529 Overloaded) con backoff esponenziale
});

// Proxy (Punto B): intercetta messages.create per registrare il consumo token per circolo
// (clubId dal request-context). Zero modifiche ai call site — usano sempre anthropic.messages.create.
export const anthropic = new Proxy(_anthropic, {
    get(target, prop, receiver) {
        if (prop === 'messages') {
            const messages = Reflect.get(target, prop, receiver);
            return new Proxy(messages, {
                get(mTarget, mProp, mRec) {
                    if (mProp === 'create') {
                        return async (...args: any[]) => {
                            const res: any = await (mTarget as any).create(...args);
                            try {
                                const { getClubId } = require('../utils/request-context');
                                const { recordUsage } = require('./usage-tracker');
                                recordUsage(getClubId(), args[0]?.model, res?.usage);
                            } catch { /* tracking non bloccante */ }
                            return res;
                        };
                    }
                    const v = Reflect.get(mTarget, mProp, mRec);
                    return typeof v === 'function' ? v.bind(mTarget) : v;
                },
            });
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
    },
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
    | 'WHOLE_COURT' | 'OPT_OUT' | 'QUESTION' | 'BOOK' | 'INVITE_PREFERRED' | 'UNKNOWN';

export async function classifyIntent(
    text: string,
    context?: string,
    history?: string
): Promise<{ intent: Intent; confident: boolean }> {
    return claudeCircuitBreaker.call(
        async () => {
            const result = await withRetry(
                () => anthropic.messages.create({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 40,
                    temperature: 0.1,
                    messages: [{
                        role: 'user',
                        content: loadPrompt('classify_intent', {
                            context: context ? `Contesto: ${context}` : '',
                            history: history ? `Cronologia recente:\n${history}` : '',
                            text: text
                        })
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
                const raw = content.text.trim();
                const startIdx = raw.indexOf('{');
                const endIdx = raw.lastIndexOf('}');
                if (startIdx !== -1 && endIdx !== -1) {
                    const parsed = JSON.parse(raw.substring(startIdx, endIdx + 1));
                    return { intent: parsed.intent as Intent, confident: parsed.confident === true };
                }
            }
            return { intent: 'UNKNOWN' as Intent, confident: false };
        },
        () => {
            logger.warn('classifyIntent: circuit open — UNKNOWN fallback');
            return { intent: 'UNKNOWN' as Intent, confident: false };
        }
    );
}

// ─────────────────────────────────────────────
// SECONDARY FAQ DETECTION
// Usato sui batch con 2+ messaggi: rileva se un singolo messaggio
// contiene una domanda separata sul circolo che richiede FAQ_REQUEST.
// Ritorna la domanda estratta (stringa) o null se non è una FAQ.
// ─────────────────────────────────────────────

export async function detectSecondaryFaqQuestion(text: string): Promise<string | null> {
    if (!text || text.trim().length < 5) return null;
    try {
        const result = await withRetry(
            () => anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 80,
                temperature: 0,
                messages: [{
                    role: 'user',
                    content: `Sei il filtro di un bot padel italiano. Devi stabilire se questo messaggio contiene una domanda rivolta al circolo su servizi, regole, assicurazioni, tornei, orari speciali o qualsiasi cosa che il gestore dovrebbe rispondere.
NON è una domanda FAQ se parla di: prenotazione, orario della partita, campo da prenotare, "sono disponibile", "vengo", "porto amici".
È una domanda FAQ se chiede: assicurazioni, spogliatoi, docce, regolamento, tornei, abbonamenti, parcheggio, servizi extra, qualsiasi cosa sul circolo in generale.

Messaggio: "${text.slice(0, 300)}"

Rispondi SOLO con:
- FAQ: <testo esatto della domanda estratta> (se è una FAQ)
- NO (se non è una FAQ)`,
                }],
            }),
            { maxAttempts: 2, baseDelayMs: 500, shouldRetry: isTransientNetworkError, context: 'detectSecondaryFaq' }
        );
        const raw = result.content[0].type === 'text' ? result.content[0].text.trim() : '';
        if (raw.startsWith('FAQ:')) return raw.slice(4).trim();
        return null;
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────
// REQUIRES RESPONSE — filtro messaggi offline
// Usato per evitare di rispondere a ringraziamenti,
// conferme, emoji o altri messaggi che non richiedono azione.
// ─────────────────────────────────────────────

export async function requiresResponse(text: string): Promise<boolean> {
    if (!text || text.trim().length === 0) return false;

    // Fast-path: messaggi chiaramente non-actionable (evita chiamata AI)
    const lower = text.trim().toLowerCase();
    const skipPatterns = [/^(ok|okay|ок)[\s!.]*$/, /^(grazie|grazie mille|grazie!)[\s!.]*$/, /^(👍|👌|🙏|✅|❤️|😊|🎾)+$/, /^(perfetto|ottimo|benissimo|capito|ricevuto|prego)[\s!.]*$/];
    if (skipPatterns.some(p => p.test(lower))) return false;

    try {
        const result = await withRetry(
            () => anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 5,
                temperature: 0,
                messages: [{
                    role: 'user',
                    content: `Sei il filtro di un bot padel. Il messaggio seguente richiede una risposta da parte del bot?\nRispondi SOLO con RESPOND o SKIP.\n- SKIP: ringraziamenti, conferme ("ok", "perfetto", "👍"), saluti senza richiesta, emoji, "ci vediamo", "a domani"\n- RESPOND: prenotazioni, domande, disdette, richieste, qualsiasi cosa che attende una risposta\n\nMessaggio: "${text.slice(0, 300)}"`
                }],
            }),
            { maxAttempts: 2, baseDelayMs: 500, shouldRetry: isTransientNetworkError, context: 'requiresResponse' }
        );
        const raw = result.content[0].type === 'text' ? result.content[0].text.trim().toUpperCase() : '';
        return raw.startsWith('RESPOND');
    } catch {
        // In caso di errore AI, processa il messaggio per sicurezza
        return true;
    }
}

// ─────────────────────────────────────────────
// GENERA INVITO
// ─────────────────────────────────────────────

export async function generateInvitation(
    playerName: string,
    matchTime: Date,
    courtId: string | null | undefined,
    clubId?: string | null,
    isFriend = false,
    socialContext?: import('./matchmaker').MatchSocialContext,
    matchType?: { isMixed: boolean; targetGender: string | null }
): Promise<string> {
    // Giorno+ora in priorità (Punto 5). weekday it-IT è già minuscolo → ok a metà frase.
    const weekday = matchTime.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', weekday: 'long' });
    const timeStr = matchTime.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
    const quando = `${weekday} alle ${timeStr}`;

    // Tipo partita (Punto 6): mai nome/tipo campo nell'invito, solo on-demand dal brain.
    const tg = matchType?.targetGender;
    const tipo = tg === 'MALE' ? 'maschile' : tg === 'FEMALE' ? 'femminile' : matchType?.isMixed ? 'mista' : '';

    const confirmedCount = socialContext?.players.length ?? 0;

    // Template random (no AI): l'invito è il messaggio a volume più alto → costo API zero.
    // I candidati sono già nella banda di livello della partita (scoring.ts) → "del tuo livello" è vero.
    return buildInvitation({ playerName, quando, tipo, confirmedCount, isFriend });
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
// ESTRAI NOME GIOCATORE CORRISPONDENTE (PREFERITO)
// ─────────────────────────────────────────────

export async function extractPreferredPlayerName(text: string): Promise<string | null> {
    try {
        const result = await withRetry(
            () => anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 30,
                temperature: 0,
                messages: [{
                    role: 'user',
                    content: `Estrai il nome e cognome del giocatore da invitare. 
Rispondi SOLO con "Nome Cognome" (es. "Giuseppe Rossi") o "NULL". 
Esempi: "invita Giuseppe Rossi" -> Giuseppe Rossi. "aggiungi Mario" -> Mario. "voglio Luca" -> Luca.
Dati: "${text}"`,
                }],
            }),
            { maxAttempts: 2, context: 'extractPreferredPlayerName' }
        );
        const content = result.content[0];
        if (content.type === 'text') {
            const val = content.text.trim();
            return val === 'NULL' ? null : val;
        }
    } catch (err) {
        logger.error({ err }, 'extractPreferredPlayerName failed');
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
// ─────────────────────────────────────────────
// GENERA RICHIESTA FEEDBACK POST-PARTITA
// ─────────────────────────────────────────────

export async function generateFeedbackRequest(
    playerName: string,
    courtName: string,
    timeStr: string,
): Promise<string> {
    const fallback = `Com'è andata la partita${timeStr ? ` delle ${timeStr}` : ''}? Raccontami! 🎾`;

    return claudeCircuitBreaker.call(
        async () => {
            const result = await withRetry(
                () => anthropic.messages.create({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 100,
                    temperature: 0.9,
                    system: 'Sei il bot di un circolo padel. Scrivi messaggi brevi e colloquiali in italiano.',
                    messages: [{
                        role: 'user',
                        content: loadPrompt('generate_feedback_request', {
                            playerName,
                            courtName,
                            timeStr,
                        })
                    }],
                }),
                {
                    maxAttempts: 2,
                    baseDelayMs: 1000,
                    shouldRetry: isTransientNetworkError,
                    context: 'generateFeedbackRequest',
                }
            );
            const content = result.content[0];
            if (content.type === 'text') return content.text.trim();
            return fallback;
        },
        () => {
            logger.warn({ playerName }, 'generateFeedbackRequest: circuit open — fallback text');
            return fallback;
        }
    );
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
