/**
 * ONBOARDING SERVICE
 *
 * Due modalità di importazione giocatori:
 *
 * A) GRUPPO WHATSAPP — il circolo aggiunge il bot a un gruppo esistente
 *    (es. "Padel Intermedi"). Il bot legge i partecipanti, deduce il livello
 *    dal nome del gruppo e li importa tutti silenziosi.
 *    Poi manda un messaggio di benvenuto personalizzato a ognuno.
 *
 * B) RUBRICA VCF — il circolo invia il file .vcf esportato dal telefono.
 *    Il bot filtra i contatti che contengono la keyword configurata
 *    (es. "Padel") nel nome, e li importa.
 *
 * ONBOARDING SINGOLO — flusso conversazionale per nuovi giocatori
 *    che scrivono spontaneamente o vengono portati da un amico.
 */

import { prisma } from './db';
import { getRedis } from './queue';
import { getSock, simulateTypingAndSend, sendMessage } from './whatsapp';
import { extractSkillLevel } from './ai';
import pino from 'pino';

const logger = pino({ level: 'info' });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const randomInt = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

// ─────────────────────────────────────────────
// TIPO: configurazione onboarding del circolo
// ─────────────────────────────────────────────

export interface ClubOnboardingConfig {
    clubId: string;
    botName: string;
    aiTone?: string;                    // tono del circolo — usato per generare i messaggi AI
    skipLevel?: boolean;                // se true, registra con skill 0 senza chiedere il livello
    welcomeMessage?: string;            // messaggio custom di benvenuto
    askAvailability: boolean;           // chiedi giorni preferiti?
    askTimePreference: boolean;         // chiedi orario preferito?
    vcfKeyword?: string;                // keyword per filtro rubrica (es. "Padel")
    allowMixedLevels: boolean;          // invita livelli misti?
    maxDailyMessages: number;           // default 2
    notifyAdminOnNewPlayer: boolean;
}

// ─────────────────────────────────────────────
// A) IMPORT DA GRUPPO WHATSAPP
// ─────────────────────────────────────────────

/**
 * Chiamato quando il bot viene aggiunto a un gruppo.
 * Deduce il livello dal nome del gruppo e importa tutti i partecipanti.
 *
 * Naming convention gruppi consigliata al cliente:
 *   "Padel Principianti", "Padel Intermedi", "Padel Avanzati"
 *   → il bot estrae il livello dalla parola chiave nel nome
 */
export async function importPlayersFromGroup(
    groupJid: string,
    groupName: string,
    config: ClubOnboardingConfig
): Promise<{ imported: number; skipped: number }> {
    const sock = getSock();
    if (!sock) throw new Error('WhatsApp socket not initialized');

    logger.info(`Importing players from group: "${groupName}" (${groupJid})`);

    // Deduci skill level dal nome del gruppo
    const skillLevel = guessSkillLevelFromGroupName(groupName);
    logger.info(`Detected skill level from group name: ${skillLevel}`);

    // Leggi i partecipanti del gruppo
    const groupMetadata = await sock.groupMetadata(groupJid);
    const participants = groupMetadata.participants;

    let imported = 0;
    let skipped = 0;

    for (const participant of participants) {
        const phone = participant.id.split('@')[0];

        // Salta il bot stesso e gli admin di sistema
        if (phone === process.env.BOT_PHONE_NUMBER?.replace('+', '')) {
            skipped++;
            continue;
        }

        // ✅ FIX K: cerca giocatore per club specifico (non globalmente)
        const existing = await prisma.player.findFirst({
            where: { phoneNumber: phone, clubId: config.clubId },
        });
        if (existing) {
            skipped++;
            continue;
        }

        // ✅ FIX K: nuovo giocatore sempre associato al clubId corretto
        await prisma.player.create({
            data: {
                phoneNumber: phone,
                clubId: config.clubId,
                skillLevel: skillLevel as any,
                groupIds: [groupJid],
                active: true,
            },
        });

        imported++;
        logger.info(`Imported player: ${phone} (${skillLevel})`);

        // Delay anti-ban tra un import e l'altro
        await sleep(randomInt(500, 1500));
    }

    logger.info(`Group import complete: ${imported} imported, ${skipped} skipped`);

    // Notifica admin
    if (config.notifyAdminOnNewPlayer) {
        const club = await prisma.club.findUnique({ where: { id: config.clubId } });
        if (club?.adminPhone) {
            await sendMessage(
                club.adminPhone,
                `[POLPO BOT] 📥 Import da gruppo completato\nGruppo: "${groupName}"\nLivello rilevato: ${skillLevel}\nNuovi: ${imported} | Già presenti: ${skipped}`
            );
        }
    }

    // Invia messaggi di benvenuto in batch con delay umani
    await sendWelcomeBatch(groupJid, skillLevel, config);

    return { imported, skipped };
}

// ─────────────────────────────────────────────
// B) IMPORT DA FILE VCF (rubrica)
// ─────────────────────────────────────────────

/**
 * Parsea un file .vcf e importa i contatti che contengono la keyword.
 * Il circolo esporta la rubrica del telefono e la manda al bot.
 */
export async function importPlayersFromVcf(
    vcfContent: string,
    defaultSkillLevel: 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED',
    config: ClubOnboardingConfig
): Promise<{ imported: number; skipped: number; notFound: string[] }> {
    const keyword = config.vcfKeyword?.toLowerCase() || 'padel';
    const contacts = parseVcf(vcfContent);

    logger.info(`VCF parsed: ${contacts.length} total contacts, filtering by keyword "${keyword}"`);

    const filtered = contacts.filter(c => c.name.toLowerCase().includes(keyword));
    logger.info(`VCF filtered: ${filtered.length} matching contacts`);

    let imported = 0;
    let skipped = 0;
    const notFound: string[] = [];

    for (const contact of filtered) {
        if (!contact.phone) {
            notFound.push(contact.name);
            continue;
        }

        const normalizedPhone = normalizeItalianPhone(contact.phone);
        if (!normalizedPhone) {
            notFound.push(`${contact.name} (${contact.phone})`);
            continue;
        }

        // ✅ FIX K: cerca per club
        const existing = await prisma.player.findFirst({
            where: { phoneNumber: normalizedPhone, clubId: config.clubId },
        });
        if (existing) {
            skipped++;
            continue;
        }

        const cleanName = contact.name
            .replace(new RegExp(keyword, 'gi'), '')
            .trim()
            .replace(/^[-–\s]+|[-–\s]+$/g, '');

        const skillFromName = guessSkillLevelFromGroupName(contact.name) || defaultSkillLevel;

        await prisma.player.create({
            data: {
                phoneNumber: normalizedPhone,
                clubId: config.clubId, // ✅ FIX K
                name: cleanName || null,
                skillLevel: skillFromName as any,
                active: true,
            },
        });

        imported++;
        await sleep(randomInt(200, 600));
    }

    logger.info(`VCF import complete: ${imported} imported, ${skipped} skipped, ${notFound.length} not found`);
    return { imported, skipped, notFound };
}

// ─────────────────────────────────────────────
// C) ONBOARDING SINGOLO — flusso conversazionale
// ─────────────────────────────────────────────

/**
 * Flusso per un giocatore nuovo che scrive spontaneamente al bot.
 * Gestito a step tramite stato conversazionale in WhatsAppMessage.
 *
 * Step:
 * 1. Benvenuto + chiedi nome
 * 2. Chiedi livello
 * 3. (opzionale) Chiedi disponibilità
 * 4. (opzionale) Chiedi orario preferito
 * 5. Salva e conferma
 */

export type OnboardingStep =
    | 'AWAITING_NAME'
    | 'AWAITING_LEVEL'
    | 'AWAITING_AVAILABILITY'
    | 'AWAITING_TIME_PREFERENCE'
    | 'COMPLETE';

// ─────────────────────────────────────────────
// ONBOARDING BRAIN — Sonnet con contesto circolo + storia conversazione
// Risponde naturalmente a tutto e segnala quando ha nome + cognome completi.
// ─────────────────────────────────────────────

async function callOnboardingBrain(
    senderJid: string,
    userMessage: string,
    config: ClubOnboardingConfig,
): Promise<{ message: string; extractedName: string | null }> {
    const club = await prisma.club.findUnique({ where: { id: config.clubId } });
    const botName = config.botName || 'Francesca';
    const clubLocation = [club?.address, club?.city].filter(Boolean).join(', ');
    const clubHours = club ? `${(club as any).openTime || '08:00'}–${(club as any).closeTime || '23:30'}` : null;
    const aiTone = club?.aiTone || 'calda, diretta, colloquiale — come un\'amica esperta del circolo';

    // Carica storia conversazione delle ultime 24h
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentMessages = await prisma.whatsAppMessage.findMany({
        where: { chatId: senderJid, timestamp: { gte: since } },
        orderBy: { timestamp: 'asc' },
        take: 12,
    });

    // Merge consecutivi stessa role (lesson #22) + drop trailing user
    const mergedHistory: { role: string; content: string }[] = [];
    for (const msg of recentMessages) {
        const last = mergedHistory[mergedHistory.length - 1];
        if (last && last.role === msg.role) {
            last.content += '\n' + msg.content;
        } else {
            mergedHistory.push({ role: msg.role, content: msg.content });
        }
    }
    if (mergedHistory.length > 0 && mergedHistory[mergedHistory.length - 1].role === 'user') {
        mergedHistory.pop();
    }

    const isEarlyConversation = recentMessages.length <= 4;

    const systemPrompt = `Sei ${botName}, l'assistente digitale del circolo padel "${club?.name || 'Padel Club'}".
Tono: ${aiTone}
Usa SEMPRE il "tu" — mai "voi" o "lei".
${clubLocation ? `Indirizzo: ${clubLocation}` : ''}
${clubHours ? `Orari: ${clubHours}` : ''}

Stai parlando con una persona che NON è ancora registrata.

OBIETTIVO: iscriverla raccogliendo nome e cognome, ma in modo completamente naturale — senza mai sembrare un form.

REGOLE FONDAMENTALI:
- Rispondi SEMPRE prima a quello che dice/chiede l'utente, come farebbe un'amica del circolo
${isEarlyConversation ? `- PRESENTATI come ${botName} in questo messaggio — è uno dei primi scambi e l'utente non sa ancora con chi parla. Fallo in modo naturale, dopo aver risposto alla domanda.` : `- Presentati come ${botName} solo se te lo chiedono o se non l'hai ancora fatto.`}
- Chiedi nome e cognome solo DOPO aver risposto, e solo quando è naturale farlo
- Se l'utente ha già dato nome E cognome in questo scambio → estraili
- Se ha dato solo il nome, rispondi naturalmente e chiedi il cognome con leggerezza
- MAI ignorare ciò che l'utente ha scritto per chiedere subito il nome
- MAI usare formule burocratiche come "per registrarti ho bisogno di..."
- MAX 3 frasi brevi. Caldo, umano, presente.
- MAI usare il trattino "–" o "-" nei messaggi. Usa la virgola o una nuova frase.

REGOLA EMOJI:
- Usa emoji con parsimonia: max 1-2 per risposta
- MAI iniziare con un'emoji
- Ogni emoji termina un pensiero: il sistema divide il testo in bolle separate su ogni emoji. Scrivi: [pensiero] 🎾 [pensiero successivo]. L'emoji chiude la bolla.

Rispondi SEMPRE con JSON valido:
{ "message": "...", "extractedName": "Nome Cognome" | null }

"extractedName": inserisci nome + cognome SOLO se entrambi sono stati forniti esplicitamente (anche in messaggi precedenti visibili nello storico). Se hai solo il nome, metti null e chiedi il cognome.`;

    const { anthropic } = await import('./ai');
    try {
        const response = await anthropic.messages.create({
            model: 'claude-sonnet-4-6',
            max_tokens: 300,
            temperature: 0.7,
            system: systemPrompt,
            messages: [
                ...mergedHistory.map(m => ({
                    role: (m.role === 'USER' ? 'user' : 'assistant') as 'user' | 'assistant',
                    content: m.content,
                })),
                { role: 'user', content: userMessage },
            ],
        });

        if (response.content[0].type === 'text') {
            const text = response.content[0].text.trim();
            const start = text.indexOf('{');
            const end = text.lastIndexOf('}');
            if (start !== -1 && end !== -1) {
                const parsed = JSON.parse(text.substring(start, end + 1));
                let extractedName = parsed.extractedName || null;
                // Sanity check: niente numeri, minimo 2 caratteri
                if (extractedName && (!/\d/.test(extractedName)) && extractedName.length >= 2) {
                    // Capitalizza ogni parola
                    extractedName = extractedName.split(' ')
                        .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
                        .join(' ');
                } else {
                    extractedName = null;
                }
                return { message: String(parsed.message || ''), extractedName };
            }
        }
    } catch (err) {
        logger.error({ err }, 'Onboarding brain call failed');
    }

    // Fallback minimale
    return { message: `Ciao! Sono ${botName} del circolo 🎾 Come ti chiami?`, extractedName: null };
}

export async function startSingleOnboarding(
    senderJid: string,
    config: ClubOnboardingConfig,
    firstMessage?: string,
): Promise<void> {
    // Lock Redis NX atomico: previene doppio messaggio se due batch concorrenti
    // passano entrambi il check "no state + no player" prima che il primo scriva su Redis
    const redis = getRedis();
    const lockKey = `onboarding_start:${senderJid}`;
    const acquired = await redis.set(lockKey, '1', 'EX', 60, 'NX');
    if (!acquired) return; // un'altra chiamata concorrente ha già avviato l'onboarding

    await setOnboardingState(senderJid, 'AWAITING_NAME', { config });

    if (firstMessage) {
        // Risponde al primo messaggio in modo contestuale invece di mandare un benvenuto generico
        const { message, extractedName } = await callOnboardingBrain(senderJid, firstMessage, config);
        const { splitAtEmoji } = await import('../utils/split-message');
        for (const part of splitAtEmoji(message)) {
            await simulateTypingAndSend(senderJid, part);
        }
        if (extractedName && extractedName.includes(' ')) {
            await finalizeOnboarding(senderJid, { config, name: extractedName, skillLevel: -1 });
        }
    } else {
        // Fallback: nessun messaggio iniziale (es. avvio manuale) → benvenuto generico
        const botName = config.botName || 'Francesca';
        await simulateTypingAndSend(senderJid, `Ciao! Sono ${botName} del circolo 🎾 Come ti chiami?`);
    }
}

export async function continueOnboarding(
    senderJid: string,
    messageText: string,
    step: OnboardingStep,
    stateData: any,
    messageKey?: any
): Promise<void> {
    const { config } = stateData;

    if (step === 'AWAITING_NAME') {
        const { message, extractedName } = await callOnboardingBrain(senderJid, messageText, config);
        const { splitAtEmoji } = await import('../utils/split-message');
        for (const part of splitAtEmoji(message)) {
            await simulateTypingAndSend(senderJid, part, messageKey);
        }

        if (extractedName && extractedName.includes(' ')) {
            // Nome + cognome completi → finalizza
            await finalizeOnboarding(senderJid, { ...stateData, name: extractedName, skillLevel: -1 }, messageKey);
        }
        // Se extractedName è solo nome (senza spazio) o null → il brain ha già chiesto il cognome nel message
        return;
    }

    if (step === 'AWAITING_AVAILABILITY') {
        const updatedState = { ...stateData, availability: messageText.trim() };

        if (config.askTimePreference) {
            await setOnboardingState(senderJid, 'AWAITING_TIME_PREFERENCE', updatedState);
            await simulateTypingAndSend(
                senderJid,
                `E che orario preferisci? (mattina, pomeriggio, sera)`,
                messageKey
            );
        } else {
            await finalizeOnboarding(senderJid, updatedState, messageKey);
        }
        return;
    }

    if (step === 'AWAITING_TIME_PREFERENCE') {
        const updatedState = { ...stateData, timePreference: messageText.trim() };
        await finalizeOnboarding(senderJid, updatedState, messageKey);
        return;
    }
}

async function finalizeOnboarding(senderJid: string, stateData: any, messageKey?: any): Promise<void> {
    const { name, skillLevel, availability, timePreference, config, resolvedPhone } = stateData;
    // Usa il numero già risolto (LID → italiano) se disponibile, altrimenti fallback al JID
    const phone = resolvedPhone || senderJid.split('@')[0];

    // ✅ FIX: chiave composta phoneNumber_clubId + relazione club per connect
    await prisma.player.upsert({
        where: { phoneNumber_clubId: { phoneNumber: phone, clubId: config.clubId } },
        update: { name, skillLevel, active: true },
        create: {
            phoneNumber: phone,
            club: { connect: { id: config.clubId } },
            name,
            skillLevel,
            active: true,
        },
    });

    await clearOnboardingState(senderJid);

    const firstName = name?.split(' ')[0] || name;
    const botName = config.botName || 'Francesca';

    // Genera il messaggio di benvenuto con Haiku adattato all'aiTone del circolo
    let welcomeText = `${firstName}, sei nella lista! 🎾 Ti abbinerò con giocatori del tuo livello — ogni partita sarà una bella sfida.\n\nPer giocare con altri ti serve una valutazione con il nostro maestro (rilassatissima, promesso). Scrivimi quando sei pronto e organizziamo! Nel frattempo puoi prenotare un campo quando vuoi 🙌`;
    try {
        const club = await prisma.club.findUnique({ where: { id: config.clubId } });
        const { anthropic } = await import('./ai');
        const aiTone = club?.aiTone || 'caldo, diretto, colloquiale';
        const prompt = `Scrivi un messaggio WhatsApp di benvenuto per ${firstName} che si è appena registrato al circolo padel.

TONO: ${aiTone}
MITTENTE: ${botName} (assistente del circolo)
MAX: 3 frasi brevi. Niente titoli o formattazione.

Il messaggio deve:
1. Confermare l'iscrizione alla community di giocatori dello stesso livello (trasmetti il valore: conoscere persone, migliorare, divertirsi)
2. Spiegare che per giocare con altri serve una valutazione con il maestro (lezione breve e tranquilla) — invitare a scrivere quando vuole fissarla
3. Ricordare che nel frattempo può già prenotare un campo

Non usare "benvenuto/a" come prima parola. Scrivi solo il messaggio, nient'altro.`;

        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            temperature: 0.7,
            messages: [{ role: 'user', content: prompt }],
        });
        if (response.content[0].type === 'text') {
            welcomeText = response.content[0].text.trim();
        }
    } catch (err) {
        logger.warn({ err }, 'Welcome message generation failed, using default');
    }

    await simulateTypingAndSend(senderJid, welcomeText, messageKey);

    // Controlla se c'era un intent pendente (es. prenotazione interrotta per onboarding)
    let hasPendingIntent = false;
    try {
        const { getState, clearState } = await import('./conversation-state');
        const pending = await getState(`state:pending-intent:${senderJid}`);
        if (pending?.intent && pending.intent !== 'UNKNOWN') {
            hasPendingIntent = true;
            await clearState(`state:pending-intent:${senderJid}`);

            // Riprende il booking flow con i parametri originali
            const { handleBatch } = await import('./messageHandler');
            const { getClubId } = await import('../utils/request-context');
            await handleBatch(senderJid, [{
                type: 'text',
                text: pending.combinedText,
                clubId: getClubId(), // propaga il clubId dal context corrente — evita override AsyncLocalStorage
                raw: {
                    key: { id: `RESUME_${Date.now()}`, remoteJid: senderJid, fromMe: false },
                    pushName: name,
                    messageTimestamp: Math.floor(Date.now() / 1000),
                    message: { conversation: pending.combinedText },
                } as any,
            }]);
        }
    } catch (err) {
        logger.error({ err }, 'Failed to resume pending intent after onboarding');
    }

    // Se non c'è pending intent, il welcome già invita a interagire — nessun follow-up necessario

    // Notifica admin
    if (config.notifyAdminOnNewPlayer) {
        const club = await prisma.club.findUnique({ where: { id: config.clubId } });
        if (club?.adminPhone) {
            await sendMessage(
                club.adminPhone,
                `[POLPO BOT] 👤 Nuovo giocatore onboardato\nNome: ${name}\nTelefono: ${phone}\nLivello: ${skillLevel}${availability ? `\nDisponibilità: ${availability}` : ''}${timePreference ? `\nOrario: ${timePreference}` : ''}\n➡️ Aggiungere al gruppo WhatsApp livello: ${skillLevel}`
            );
        }
    }
}

// ─────────────────────────────────────────────
// BENVENUTO IN BATCH
// Manda un messaggio di benvenuto a tutti i nuovi importati
// con delay random per evitare ban
// ─────────────────────────────────────────────

async function sendWelcomeBatch(
    groupJid: string,
    skillLevel: string,
    config: ClubOnboardingConfig
): Promise<void> {
    const players = await prisma.player.findMany({
        where: { groupIds: { has: groupJid } },
    });

    const botName = config.botName || 'Padel Bot';
    const customWelcome = config.welcomeMessage;

    logger.info(`Sending welcome messages to ${players.length} players from group import`);

    for (const player of players) {
        const msg = customWelcome ||
            `Ciao ${player.name ? player.name.split(' ')[0] : ''}! 👋\n\nSono ${botName}, l'assistente del tuo circolo padel.\n\nTi scrivo per una cosa sola: quando si apre un posto in una partita con giocatori del tuo livello, ti mando un messaggio. Niente newsletter, niente spam — solo una notifica quando c'è qualcosa che fa al caso tuo. 🎾\n\nA presto in campo! 💪`;

        await sleep(randomInt(8000, 25000)); // delay umano tra messaggi

        try {
            await simulateTypingAndSend(player.phoneNumber, msg);
        } catch (err) {
            logger.error({ err }, `Failed to send welcome to ${player.phoneNumber}`);
        }
    }
}

// ─────────────────────────────────────────────
// STATO ONBOARDING
// ─────────────────────────────────────────────

// Stato ONBOARDING — dual-write Redis + PostgreSQL tramite conversation-state
async function setOnboardingState(jid: string, step: OnboardingStep, data: any): Promise<void> {
    try {
        const { setState } = await import('./conversation-state');
        await setState(`state:onboarding:${jid}`, { step, data });
    } catch (err) {
        logger.error({ err, jid }, 'Failed to save onboarding state');
    }
}

export async function getOnboardingState(jid: string): Promise<{ step: OnboardingStep; data: any } | null> {
    try {
        const { getState } = await import('./conversation-state');
        return await getState(`state:onboarding:${jid}`);
    } catch (err) {
        logger.error({ err, jid }, 'Failed to read onboarding state');
        return null;
    }
}

export async function clearOnboardingState(jid: string): Promise<void> {
    try {
        const { clearState } = await import('./conversation-state');
        await clearState(`state:onboarding:${jid}`);
    } catch (err) {
        logger.error({ err, jid }, 'Failed to clear onboarding state');
    }
}

// ─────────────────────────────────────────────
// UTILITY: parser VCF minimale
// ─────────────────────────────────────────────

function parseVcf(vcfContent: string): { name: string; phone: string | null }[] {
    const contacts: { name: string; phone: string | null }[] = [];
    const cards = vcfContent.split('BEGIN:VCARD');

    for (const card of cards) {
        if (!card.includes('END:VCARD')) continue;

        const nameMatch = card.match(/FN:(.+)/);
        const phoneMatch = card.match(/TEL[^:]*:([+\d\s\-().]+)/);

        if (nameMatch) {
            contacts.push({
                name: nameMatch[1].trim(),
                phone: phoneMatch ? phoneMatch[1].trim() : null,
            });
        }
    }

    return contacts;
}

function normalizeItalianPhone(raw: string): string | null {
    const digits = raw.replace(/\D/g, '');

    if (digits.startsWith('39') && digits.length === 12) return `+${digits}`;
    if (digits.startsWith('3') && digits.length === 10) return `+39${digits}`;
    if (digits.startsWith('0039')) return `+${digits.slice(2)}`;

    return null;
}

// ─────────────────────────────────────────────
// UTILITY: deduci livello dal nome del gruppo
// ─────────────────────────────────────────────

function guessSkillLevelFromGroupName(name: string): 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' {
    const lower = name.toLowerCase();

    const beginnerKw = ['principiante', 'principianti', 'beginner', 'base', 'livello 1', 'lv1', 'newbie'];
    const advancedKw = ['avanzato', 'avanzati', 'advanced', 'agonistico', 'pro', 'livello 3', 'lv3', 'esperto', 'esperti'];

    if (beginnerKw.some(kw => lower.includes(kw))) return 'BEGINNER';
    if (advancedKw.some(kw => lower.includes(kw))) return 'ADVANCED';
    return 'INTERMEDIATE'; // default
}
