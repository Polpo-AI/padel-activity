import { prisma } from './db';
import { anthropic } from './ai';
import { simulateTypingAndSend } from './whatsapp';
import pino from 'pino';

const logger = pino({ level: 'info' });

export interface ConversationalContext {
    jid: string;
    phoneNumber: string;
    player: any | null; // Database player object
    club: any;
    recentMessages: any[];
}

export interface FluidAction {
    intent: 'BOOK' | 'BRING_FRIEND' | 'UNKNOWN';
    params?: any;
}

/**
 * CONVERSATIONAL MANAGER
 * 
 * Handles interactions naturally using an AI-driven, non-blocking approach.
 * Instead of rigid states, it uses the current player status and context to
 * generate the next best response.
 */
export async function handleFluidConversation(
    context: ConversationalContext,
    userInput: string
): Promise<FluidAction | null> {
    const { jid, player, club, recentMessages } = context;

    // 1. Build the system prompt with current "missing" info
    const missingInfo: string[] = [];
    if (!player) {
        missingInfo.push("NAME (unknown)", "SKILL LEVEL (unknown)");
    } else {
        if (!player.name) missingInfo.push("NAME (missing)");
        if (!player.skillLevel) missingInfo.push("SKILL LEVEL (missing)");
    }

    const recentHistory = recentMessages
        .map(m => `${m.role === 'USER' ? 'User' : 'Bot'}: ${m.content}`)
        .join('\n');

    const systemPrompt = `
Sei l'assistente virtuale amichevole del circolo padel "${club.name}".
Il tuo obiettivo primario è aiutare i giocatori a prenotare campi e organizzare partite.

LINEE GUIDA:
- Sii colloquiale, empatico e professionale.
- **ESSERE ESTREMAMENTE CONCISO**: Non perderti in chiacchiere. Una o max due frasi brevi per messaggio. Vai dritto al punto.
- NON essere bloccante: se un utente vuole prenotare ma non conosci il suo nome, avvia la prenotazione e chiedi il nome "passando".
- Se l'utente ti saluta, rispondi cordialmente ma in modo asciutto.
- Usa emoticon a tema padel (🎾, 🏟️, 💪).
- Lingua: Italiano colloquiale.
- **DIVIETO DI RIPETIZIONE**: Non scrivere mai lo stesso identico messaggio due volte di seguito. Varia sempre la forma se devi ripetere un concetto.

STATO ATTUALE GIOCATORE:
- Nome: ${player?.name || 'Sconosciuto'}
- Livello: ${player?.skillLevel || 'Sconosciuto'}
- Telefono: ${player?.phoneNumber || context.phoneNumber}

CRITICAL RULES:
1. LEGGI SEMPRE LA CRONOLOGIA RECENTE. Se l'utente ha GIÀ detto il suo nome o l'orario martedì alle 18, NON chiederlo di nuovo.
2. Se mancano informazioni fondamentali (Nome o Livello), recuperale gradualmente.
3. Se hai appena ricevuto il nome/livello, conferma di averlo salvato.

CRONOLOGIA RECENTE (LEGGI ATTENTAMENTE):
${recentHistory}

Genera la risposta per l'utente. Mantieni il filo del discorso senza ricominciare da zero.
`;

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 350,
            temperature: 0.7,
            system: systemPrompt,
            messages: [{ role: 'user', content: userInput }],
        });

        const content = response.content[0];
        if (content.type === 'text') {
            await simulateTypingAndSend(jid, content.text.trim());
            
            // 2. Proactively extract and save profile data
            await tryExtractAndSaveData(jid, userInput, recentHistory, context);

            // 3. DETECT ACTION SIGNALS (Bridge to structured logic)
            return await detectActionSignal(userInput, recentHistory, content.text);
        }
    } catch (err) {
        logger.error({ err }, 'Error in fluid conversation');
        await simulateTypingAndSend(jid, "Scusa, ho un piccolo problema tecnico 😅 Cosa dicevamo?");
    }
    return null;
}

async function detectActionSignal(userInput: string, history: string, botResponse: string): Promise<FluidAction | null> {
    try {
        const prompt = `
Analizza la conversazione qui sotto tra un Assistente Padel e un Utente.
Determina se l'Assistente ha APPENA CONFERMATO una di queste azioni:
1. BOOK: L'utente vuole prenotare una partita/campo e sono stati definiti giorno e ora (es. "Prenotazione confermata per martedì alle 19").
2. BRING_FRIEND: L'utente ha indicato un amico da aggiungere alla partita (es. "Ho segnato Marco").

Rispondi SOLO con un JSON valido, SENZA markdown (no \`\`\`json).
Output: {"intent": "BOOK" | "BRING_FRIEND" | "UNKNOWN", "params": {}}
Parametri per BOOK: {"day": "string", "time": "string"}
Parametri per BRING_FRIEND: {"name": "string"}

CRONOLOGIA:
${history}
User: ${userInput}
Bot (Latest): ${botResponse}
`;

        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 150,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        });

        const content = response.content[0];
        if (content.type === 'text') {
            let text = content.text.trim();
            // Safety: rimuovi eventuali blocchi markdown se l'AI ignora l'istruzione
            if (text.includes('```')) {
                text = text.replace(/```json|```/g, '').trim();
            }
            
            const result = JSON.parse(text);
            if (result.intent !== 'UNKNOWN') {
                logger.info({ signal: result }, 'Fluid ACTION SIGNAL detected');
                return result as FluidAction;
            }
        }
    } catch (err) {
        logger.error({ err }, 'Action detection failed');
    }
    return null;
}

async function tryExtractAndSaveData(jid: string, text: string, recentHistory: string, context: ConversationalContext) {
    try {
        const prompt = `
Analizza questo messaggio utente e la cronologia della chat di padel.
Estrai se possibile i dati del GIOCATORE PRINCIPALE (l'utente con cui stai parlando):
- "name": il nome dell'utente
- "level": il livello (1=principiante, 2=intermedio, 3=avanzato/agonista)

NON estrarre i nomi degli amici, solo dell'utente principale.
Se i dati sono già presenti nella cronologia o nel messaggio, estraili.

Rispondi SOLO con un JSON: {"name": "stringa o null", "level": numero o null}

CRONOLOGIA:
${recentHistory}

MESSAGGIO ATTUALE: "${text}"
`;
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 100,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        });

        const content = response.content[0];
        if (content.type === 'text') {
            let textResp = content.text.trim();
            if (textResp.includes('```')) {
                textResp = textResp.replace(/```json|```/g, '').trim();
            }
            const data = JSON.parse(textResp);
            const updates: any = {};
            
            if (data.name && (!context.player || !context.player.name || context.player.name === 'Giocatore')) {
                updates.name = data.name;
            }
            if (data.level && (!context.player || !context.player.skillLevel)) {
                updates.skillLevel = data.level;
            }

            if (Object.keys(updates).length > 0) {
                if (context.player) {
                    await prisma.player.update({
                        where: { id: context.player.id },
                        data: updates
                    });
                    logger.info({ jid, updates }, 'Player profile updated fluidly');
                } else {
                    const phoneNumber = jid.split('@')[0];
                    await prisma.player.create({
                        data: {
                            phoneNumber,
                            clubId: context.club.id,
                            name: updates.name || 'Giocatore',
                            skillLevel: updates.skillLevel || 1,
                        }
                    });
                    logger.info({ jid, updates }, 'New player created fluidly');
                }
            }
        }
    } catch (err) {
        logger.error({ err }, 'Fluid data extraction failed');
    }
}
