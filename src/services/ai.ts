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
import pino from 'pino';

const logger = pino({ level: 'info' });

export const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: 30000,
    maxRetries: 2, // SDK riprova su 429 e 5xx (incluso 529 Overloaded) con backoff esponenziale
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
    socialContext?: import('./matchmaker').MatchSocialContext
): Promise<string> {
    const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
    const timeStr = matchTime.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
    const weekdayStr = cap(matchTime.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', weekday: 'long' })); // fonte autorevole — mai lasciare a Claude
    const rawDateStr = matchTime.toLocaleDateString('it-IT', { timeZone: 'Europe/Rome', day: 'numeric', month: 'long' });
    const dateStr = rawDateStr.replace(/([a-zàèéìòù]+)$/i, m => cap(m)); // capitalizza il mese in fondo

    let courtName = 'il campo';
    let courtCovered = false;
    let pricePerPerson = 0;

    if (courtId) {
        const { prisma } = await import('./db');
        const court = await prisma.court.findUnique({
            where: { id: courtId },
            include: { prices: true }
        });
        if (court) {
            courtName = court.name;
            courtCovered = court.isCovered;

            const matchTimeStr = `${matchTime.getHours().toString().padStart(2, '0')}:${matchTime.getMinutes().toString().padStart(2, '0')}`;
            let matchedPrice = court.prices.find(p => p.startTime <= matchTimeStr && p.endTime > matchTimeStr);
            if (!matchedPrice && court.prices.length > 0) matchedPrice = court.prices[0];
            if (matchedPrice) pricePerPerson = matchedPrice.price / 4;
        }
    }

    const courtInfo = courtCovered ? 'coperto' : 'scoperto';
    const courtIcon = courtCovered ? '🏠' : '☀️';

    // Stato gruppo — sempre presente, indipendentemente dal numero di confermati
    const confirmedCount = socialContext?.players.length ?? 0;
    const spotsLeft = socialContext?.spotsLeft ?? 3;
    const totalNeeded = confirmedCount + spotsLeft;

    // Costruisce segnali comportamentali reali per l'AI (solo se ci sono già giocatori)
    let playersInsight = '';
    if (socialContext && socialContext.players.length > 0) {
        const signals: string[] = [];

        // Nomi con livello (solo first name + Lv. se disponibile)
        const names = socialContext.players
            .map(p => p.skillLevel > 0 ? `${p.name} (Lv.${p.skillLevel})` : p.name)
            .join(', ');
        signals.push(`Già confermati: ${names}.`);

        // Frequenza di gioco
        const frequent = socialContext.players.filter(p => p.matchesLast30Days >= 3);
        if (frequent.length > 0) {
            const freqNames = frequent.map(p => p.name).join(' e ');
            signals.push(`${freqNames} ${frequent.length === 1 ? 'gioca' : 'giocano'} più volte a settimana.`);
        }

        // Tasso di risposta — indica affidabilità
        const reliable = socialContext.players.filter(p => p.acceptanceRate >= 0.7);
        if (reliable.length > 0) {
            signals.push(`${reliable.length === socialContext.players.length ? 'Sono' : 'Alcuni sono'} giocatori affidabili.`);
        }

        // Familiarità
        if (socialContext.hasPlayedWithBefore) {
            signals.push(`Ha già giocato con loro.`);
        }

        // Fascia oraria
        const slotLabels: Record<string, string> = { mattina: 'Fascia mattutina.', pomeriggio: 'Fascia pomeridiana.', sera: 'Fascia serale.' };
        signals.push(slotLabels[socialContext.timeOfDay] ?? '');

        playersInsight = signals.filter(Boolean).join(' ');
    }

    const fallback = isFriend
        ? `Ciao ${playerName}! Un amico ti ha invitato a padel ${weekdayStr} ${dateStr} alle ${timeStr} · ${courtName} ${courtIcon} · €${pricePerPerson.toFixed(2)} a testa. Sei disponibile? 🎾`
        : `Ciao ${playerName}! Partita di padel ${weekdayStr} ${dateStr} alle ${timeStr} · ${courtName} ${courtIcon}${pricePerPerson > 0 ? ` · €${pricePerPerson.toFixed(2)} a testa` : ''}. ${playersInsight} Ci sei? 🎾`;

    let aiTone = '';
    if (clubId) {
        const { prisma } = await import('./db');
        const club = await prisma.club.findUnique({ where: { id: clubId }, select: { aiTone: true } });
        aiTone = club?.aiTone || '';
    }

    return claudeCircuitBreaker.call(
        async () => {
            const result = await withRetry(
                () => anthropic.messages.create({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 220,
                    temperature: 0.8,
                    system: aiTone || 'Sei il bot di un circolo padel. Scrivi messaggi brevi, diretti e coinvolgenti in italiano. Vai subito al punto.',
                    messages: [{
                        role: 'user',
                        content: loadPrompt('generate_invitation', {
                            playerName,
                            weekdayStr,
                            dateStr,
                            timeStr,
                            courtName,
                            courtInfo,
                            courtIcon,
                            pricePerPerson: pricePerPerson.toFixed(2),
                            isFriend: isFriend ? 'Invito da un amico.' : '',
                            confirmedCount: String(confirmedCount),
                            spotsLeft: String(spotsLeft),
                            totalNeeded: String(totalNeeded),
                            playersInsight: playersInsight || 'Il gruppo è ancora da formare.',
                        })
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
            return fallback;
        },
        () => {
            logger.warn({ playerName }, 'generateInvitation: circuit open — fallback text');
            return fallback;
        }
    );
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
