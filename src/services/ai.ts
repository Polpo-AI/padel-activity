import Anthropic from '@anthropic-ai/sdk';
import dotenv from 'dotenv';
import pino from 'pino';

dotenv.config();
const logger = pino({ level: 'info' });

// We require ANTHROPIC_API_KEY to be set in .env
export const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
});

export async function generateInvitation(playerName: string, time: string, court: string): Promise<string> {
    const prompt = `
Sei un organizzatore di partite di padel. Scrivi un brevissimo messaggio WhatsApp in italiano informale (max 2 frasi) per invitare "${playerName}" a giocare.
Contesto: Partita confermata alle ore ${time} presso ${court}. Nessun form di registrazione da compilare.

REGOLE TASSATIVE ANTI-BOT:
1. Sembra un umano, usa un registro colloquiale, quasi pigro.
2. Inserisci intenzionalmente piccole imperfezioni (es. niente maiuscola dopo il ciao, punteggiatura minima).
3. Non ripetere mai lo stesso schema. Usa sinonimi per "padel" (partitella, gabbia, etc.) oppure omettilo se si capisce.
4. Ogni tanto (20% probabilita') usa un piccolo slang locale o dialetto (es. "daje", "ci sei?", "sei dei nostri?").
5. Finisci sempre con una chiamata all'azione sotto forma di domanda per incentivare una risposta (es. "Ci sei?", "Batti un colpo", "Ti intabello?").
6. Solo 1 emoji massimo, a volte zero.
  `;

    try {
        const response = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 150,
            temperature: 0.9, // High creativity
            messages: [{ role: 'user', content: prompt }],
        });

        const content = response.content[0];
        if (content.type === 'text') {
            return content.text;
        }
        throw new Error('Unexpected response type from Anthropic');
    } catch (error) {
        logger.error({ error }, 'Error generating invitation with Anthropic');
        return `Ciao, manchi solo tu per il padel alle ${time} al ${court}. Ci sei?`;
    }
}

export type Intent = 'YES' | 'NO' | 'QUESTION' | 'UNKNOWN';

export async function classifyIntent(messageText: string): Promise<Intent> {
    const prompt = `
Classifica ESATTAMENTE questa risposta WhatsApp ricevuta in seguito ad un invito a giocare a padel.

Rispondere SOLO con una di queste quattro parole, e nient'altro:
- YES (se l'utente accetta, acconsente o conferma la presenza).
- NO (se declina, si scusa o dice che non può).
- QUESTION (se fa una domanda su orari, costi, chi gioca etc. senza ancora confermare).
- UNKNOWN (se la risposta è incomprensibile o non rientra nei casi sopra).

NON aggiungere premesse, NON usare testo aggiuntivo.

Messaggio da valutare: "${messageText}"
  `;

    try {
        const response = await anthropic.messages.create({
            model: 'claude-3-haiku-20240307', // Haiku is faster and cheaper for classification
            max_tokens: 10,
            temperature: 0.1, // Low temp for strictly formatted classification
            messages: [{ role: 'user', content: prompt }],
        });

        const content = response.content[0];
        if (content.type === 'text') {
            const text = content.text.trim().toUpperCase();
            if (['YES', 'NO', 'QUESTION', 'UNKNOWN'].includes(text)) {
                return text as Intent;
            }
        }
        return 'UNKNOWN';
    } catch (error) {
        logger.error({ error }, 'Error classifying intent with Anthropic');
        return 'UNKNOWN';
    }
}
