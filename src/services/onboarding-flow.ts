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
    botName: string;                    // es. "Circolo Padel Roma Bot"
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

export async function startSingleOnboarding(
    senderJid: string,
    config: ClubOnboardingConfig
): Promise<void> {
    // Lock Redis NX atomico: previene doppio messaggio se due batch concorrenti
    // passano entrambi il check "no state + no player" prima che il primo scriva su Redis
    const redis = getRedis();
    const lockKey = `onboarding_start:${senderJid}`;
    const acquired = await redis.set(lockKey, '1', 'EX', 60, 'NX');
    if (!acquired) return; // un'altra chiamata concorrente ha già avviato l'onboarding

    await setOnboardingState(senderJid, 'AWAITING_NAME', { config });

    const welcome = config.welcomeMessage || `Ciao! Dimmi come ti chiami così metto un nome al numero 😄`;
    await simulateTypingAndSend(senderJid, welcome);
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
        // ✅ USA AI per estrarre il nome — gestisce "mi chiamo X", "sono X", "X" ecc.
        let name: string | null = null;
        try {
            const { anthropic } = await import('./ai');
            const response = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 20,
                temperature: 0,
                messages: [{ role: 'user', content: `Estrai solo il nome proprio da questo messaggio WhatsApp. Rispondi SOLO con il nome, nient'altro. Se non riesci a trovare un nome proprio rispondi con "NULL". Messaggio: "${messageText}"` }],
            });
            const extracted = response.content[0].type === 'text' ? response.content[0].text.trim() : null;
            if (extracted && extracted.length > 0 && extracted.length < 30 && extracted.toUpperCase() !== 'NULL') {
                name = extracted;
            }
        } catch { /* nessun nome estratto */ }

        // Se non abbiamo un nome valido, l'utente ha inviato qualcosa che non è un nome
        // (es. una richiesta di prenotazione). Aggiorna l'intent pendente e ri-chiedi il nome.
        if (!name) {
            const { setState } = await import('./conversation-state');
            await setState(`state:pending-intent:${senderJid}`, { intent: 'PENDING', combinedText: messageText }, 600);
            await simulateTypingAndSend(senderJid, `Capito! Ma prima dimmi il tuo nome così ti registro 😊`, messageKey);
            return;
        }

        // Capitalizza prima lettera
        name = name.charAt(0).toUpperCase() + name.slice(1).toLowerCase();
        // Livello -1 = pending skill test — assegnato solo dal circolo tramite skill test o dashboard
        const updatedState = { ...stateData, name, skillLevel: -1 };

        if (config.askAvailability) {
            await setOnboardingState(senderJid, 'AWAITING_AVAILABILITY', updatedState);
            await simulateTypingAndSend(
                senderJid,
                `Piacere ${name}! 🤝 Che giorni sei disponibile di solito? (es. "lunedì e mercoledì sera", "weekend", "qualsiasi")`,
                messageKey
            );
        } else if (config.askTimePreference) {
            await setOnboardingState(senderJid, 'AWAITING_TIME_PREFERENCE', updatedState);
            await simulateTypingAndSend(
                senderJid,
                `Piacere ${name}! 🤝 Hai preferenze sull'orario? (es. "mattina", "sera dopo le 18", "no preference")`,
                messageKey
            );
        } else {
            await finalizeOnboarding(senderJid, updatedState, messageKey);
        }
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

    // Messaggio di benvenuto — caldo, skill test menzionato en passant senza pressione
    await simulateTypingAndSend(
        senderJid,
        `Benvenuto ${name}! 🎾 Qui organizziamo partite tra giocatori dello stesso livello, così ogni match è sempre divertente e competitivo al punto giusto.\n\nPer abbinarti ai compagni giusti, ti contatteremo per una valutazione informale con il nostro maestro — niente di formale, solo per capire dove ti posizioni. Nel frattempo puoi già prenotare un campo quando vuoi!`,
        messageKey
    );

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
            await handleBatch(senderJid, [{
                type: 'text',
                text: pending.combinedText,
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

    if (!hasPendingIntent) {
        await simulateTypingAndSend(
            senderJid,
            `Nel frattempo, posso aiutarti a prenotare un campo? 🎾`,
            messageKey
        );
    }

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
