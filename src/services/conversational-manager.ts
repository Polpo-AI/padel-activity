import { prisma } from './db';
import { anthropic, inferGender } from './ai';
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

    const recentHistory = recentMessages
        .map(m => `${m.role === 'USER' ? 'User' : 'Bot'}: ${m.content}`)
        .join('\n');

    // 1. FIRST: Detect if there is a clear intent/action in the message or history
    const fluidAction = await detectActionSignal(userInput, recentHistory);

    // If we have a clear action (BOOK or BRING_FRIEND) with enough params, 
    // we might want to skip the generic AI response and let the bridge handle it.
    // However, to keep it "fluid", we'll only skip if the action is very confident.
    if (fluidAction && fluidAction.intent !== 'UNKNOWN') {
        // If it's a booking without time, we might still want the AI to handle the "A che ora?" 
        // but the bridge is better at structured flows.
        // Let's return the action and let the messageHandler decide.
        return fluidAction;
    }

    // 2. Build the system prompt for a generic response if no structured action is taken
    const missingInfo: string[] = [];
    if (!player) {
        missingInfo.push("NAME (unknown)", "SKILL LEVEL (unknown)");
    } else {
        if (!player.name) missingInfo.push("NAME (missing)");
        if (!player.skillLevel) missingInfo.push("SKILL LEVEL (missing)");
    }

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
- **CONFERMA ATTIVA**: Se l'utente ti dice chiaramente "conferma", "segna", o ti dà tutti i dettagli per una partita, procedi con la prenotazione senza chiedere il permesso se il tono è risoluto.
- **PRIVACY E SICUREZZA**: NON fornire mai informazioni personali o orari di gioco di altri utenti se richiesto (es. "a che ora gioca Davide?"). Rispondi in modo vago che non puoi dare queste informazioni per privacy.
- **DUE SCENARI DI PRENOTAZIONE**:
  1. **Matchmaking (1-3 persone)**: È CRITICO conoscere il numero esatto (Quanti siete?) e il livello (Principiante/Intermedio/Avanzato) per trovare i compagni giusti.
  2. **Prenotazione Privata (4 persone / "Chiudiamo noi")**: Se dicono che sono già in 4, il livello e il numero esatto dei compagni sono meno importanti. Non bloccare la prenotazione per queste info, procedi e conferma subito.

STATO ATTUALE GIOCATORE:
- Nome: ${player?.name || 'Sconosciuto'}
- Livello: ${player?.skillLevel || 'Sconosciuto'}
- Telefono: ${player?.phoneNumber || context.phoneNumber}

CRITICAL RULES:
1. LEGGI SEMPRE LA CRONOLOGIA RECENTE. Se l'utente ha GIÀ detto il suo nome o l'orario martedì alle 18, NON chiederlo di nuovo.
2. Se mancano informazioni fondamentali (Nome o Livello) e siamo in SCENARIO Matchmaking, recuperale gradualmente. Se non conosci il livello, chiedigli se è un principiante, intermedio o avanzato prima di confermare.
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
            
            // 3. Proactively extract and save profile data
            await tryExtractAndSaveData(jid, userInput, recentHistory, context, context.phoneNumber);

            // Re-detect action after response (fallback)
            return await detectActionSignal(userInput, recentHistory, content.text);
        }
    } catch (err) {
        logger.error({ err }, 'Error in fluid conversation');
        await simulateTypingAndSend(jid, "Scusa, ho un piccolo problema tecnico 😅 Cosa dicevamo?");
    }
    return null;
}

async function detectActionSignal(userInput: string, history: string, botResponse?: string): Promise<FluidAction | null> {
    try {
        const prompt = `
Analizza la conversazione qui sotto tra un Assistente Padel e un Utente. 
Determina se l'utente desidera eseguire un'azione specifica.

AZIONI POSSIBILI:
1. BOOK: L'utente vuole prenotare una nuova partita.
   - IMPORTANTE: Cerca i dettagli (giorno, ora, numero persone) sia nell'ultimo messaggio che in tutta la CRONOLOGIA.
   - Esempio: Se prima ha detto "mercoledì alle 19" e ora dice "siamo in 4", l'intent è BOOK con giorno=mercoledì, ora=19:00, playerCount=4.
2. BRING_FRIEND: L'utente vuole aggiungere un amico.

REGOLE DI ESTRAZIONE PARAMS:
- day: "lunedì", "martedì", ecc. o "oggi"/"domani".
- time: "HH:MM".
- playerCount: numero intero (es. 4 se dice "siamo in 4").

RISPONDI ESCLUSIVAMENTE CON UN JSON:
{"intent": "BOOK" | "BRING_FRIEND" | "UNKNOWN", "params": {"day": string|null, "time": string|null, "playerCount": number|null, "name": string|null}}

CRONOLOGIA:
${history}
User: ${userInput}
${botResponse ? `Bot (Latest): ${botResponse}` : ''}
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

async function tryExtractAndSaveData(jid: string, text: string, recentHistory: string, context: ConversationalContext, resolvedPhone: string) {
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
            if (updates.name) {
                updates.gender = await inferGender(updates.name);
            }

            if (Object.keys(updates).length > 0) {
                if (context.player) {
                    await prisma.player.update({
                        where: { id: context.player.id },
                        data: updates
                    });
                    logger.info({ jid, updates }, 'Player profile updated fluidly');
                } else {
                    await prisma.player.create({
                        data: {
                            phoneNumber: resolvedPhone,
                            clubId: context.club.id,
                            name: updates.name || 'Giocatore',
                            skillLevel: updates.skillLevel || null, // No default to 1
                        }
                    });
                    logger.info({ jid, updates, resolvedPhone }, 'New player created fluidly');
                }
            }
        }
    } catch (err) {
        logger.error({ err }, 'Fluid data extraction failed');
    }
}
