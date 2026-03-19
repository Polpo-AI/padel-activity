/**
 * BOOKING SERVICE
 *
 * Gestisce il flusso quando un giocatore scrive spontaneamente
 * per prenotare una partita.
 *
 * Flusso:
 * 1. AI estrae: quante persone, fascia oraria preferita
 * 2. Cerca partite OPEN compatibili per livello e orario
 * 3. Propone opzioni con algoritmo priorità (chiusura prima)
 * 4. Se nessuna partita → chiede orario preciso → crea match → wave
 * 5. Edge case: Mario garantisce di chiudere il campo → svuota partita
 *    esistente, dirottta gli altri con redirect
 */

import { prisma } from './db';
import { getRedis } from './queue';
import { anthropic } from './ai';
import { simulateTypingAndSend } from './whatsapp';
import { findRedirectOptions, confirmRedirectChoice } from './redirect';
import { waveQueue } from './queue';
import pino from 'pino';

const logger = pino({ level: 'info' });

// ─────────────────────────────────────────────
// ESTRAI CONTESTO PRENOTAZIONE
// ─────────────────────────────────────────────

interface BookingContext {
    playerCount: number;        // quante persone (incluso Mario)
    timeSlot: 'morning' | 'afternoon' | 'evening' | 'specific' | 'unknown';
    specificTime?: string;      // es. "20:30" se specificato
    specificDay?: string | null; // es. "martedì"
    guaranteesFull: boolean;    // Mario dice "siamo già in 4" o simile
    isCountExplicit: boolean;   // l'utente ha detto apertamente quanti sono?
    isMixed?: boolean;          // true se mista, false se uomo/donna, null se any
}

export async function extractBookingContext(messageText: string, maxLevel: number = 3): Promise<BookingContext> {
    const prompt = `
Analizza questo messaggio di un giocatore di padel che vuole prenotare una partita.

Estrai le seguenti informazioni e rispondi SOLO con un JSON:
{
  "playerCount": numero intero (quante persone vengono, incluso chi scrive, default 1),
  "timeSlot": "morning" | "afternoon" | "evening" | "specific" | "unknown",
  "specificTime": "HH:MM" oppure null,
  "specificDay": "lunedì" | "martedì" | "mercoledì" | "giovedì" | "venerdì" | "sabato" | "domenica" | "oggi" | "domani" | null,
  "guaranteesFull": true se dice che sono già in 4, "siamo al completo", "chiudiamo il campo", "siamo già completi", false altrimenti,
  "isCountExplicit": true se l'utente ha specificato un numero di giocatori (es: "siamo in 2", "siamo in 4", "uno per stasera", "veniamo in 3"), false se è un'intenzione generica senza quantità,
  "isMixed": true se specifica "mista" o "misto", false se uomo/donna o se non specifica nulla (default false)
}

Regole per timeSlot:
- "morning": mattina, mattinata, prima delle 13
- "afternoon": pomeriggio, tra le 13 e le 18
- "evening": sera, stasera, dopo le 18
- "specific": ha dato un orario preciso
- "unknown": non specificato

Regole per specificTime:
- "h18", "alle 18", "18:00", "18", "ore 18" → "18:00"
- "20:30", "alle 20:30", "h20:30" → "20:30"
- Usa sempre formato HH:MM a 24 ore. Se solo ore senza minuti → ":00"

Messaggio: "${messageText}"

Rispondi SOLO con il JSON.
`;

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 80,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        });

        const content = response.content[0];
        if (content.type === 'text') {
            let text = content.text.trim();
            if (text.includes('```')) {
                text = text.replace(/```json|```/g, '').trim();
            }
            return JSON.parse(text);
        }
    } catch (err) {
        logger.error({ err }, 'Error extracting booking context');
    }

    return { playerCount: 1, timeSlot: 'unknown', guaranteesFull: false, specificDay: null, isCountExplicit: false, isMixed: false };
}

// ─────────────────────────────────────────────
// ENTRY POINT — avvia flusso prenotazione
// ─────────────────────────────────────────────

export async function startBookingFlow(
    jid: string,
    phoneNumber: string,
    messageText: string,
    messageKey?: any,
    overrides?: Partial<BookingContext>
): Promise<void> {
    const player = await prisma.player.findFirst({ where: { phoneNumber }, include: { club: true } });
    if (!player) return;

    const maxLevel = player.club?.skillLevelCount ?? 3;
    const context = await extractBookingContext(messageText, maxLevel);
    
    // Apply overrides from action detection (e.g. extracted day/time)
    if (overrides) {
        if (overrides.specificDay) context.specificDay = overrides.specificDay;
        if (overrides.specificTime) {
            context.specificTime = overrides.specificTime;
            context.timeSlot = 'specific';
        }
        if (overrides.playerCount) context.playerCount = overrides.playerCount;
        if (overrides.isCountExplicit) context.isCountExplicit = overrides.isCountExplicit;
    }

    // Se l'AI non ha rilevato un conteggio esplicito, default a solo matchmaking (1 giocatore)
    if (!context.isCountExplicit && !context.guaranteesFull) {
        context.playerCount = 1;
        context.isCountExplicit = true;
    }

    logger.info(`Booking context: ${JSON.stringify(context)}`);

    // Edge case: Mario garantisce di chiudere il campo
    if (context.guaranteesFull && context.playerCount >= 4) {
        await handleGuaranteedFull(jid, phoneNumber, context, messageKey);
        return;
    }

    // Determina finestra oraria
    const now = new Date();
    const { from, to } = getTimeWindow(context, now);

    if (!from || !to) {
        // Non sappiamo l'orario — chiediamo
        await simulateTypingAndSend(
            jid,
            `${["Certo!", "Perfetto!", "Ottimo!", "Bene!"][Math.floor(Math.random() * 4)]} A che ora vorresti giocare? 🎾`,
            messageKey
        );
        await setBookingState(jid, { ...context, step: 'AWAITING_TIME' });
        return;
    }

    // Cerca partite OPEN compatibili
    await searchAndProposeMatches(jid, player, context, from, to, messageKey);
}

// ─────────────────────────────────────────────
// CERCA E PROPONI PARTITE
// ─────────────────────────────────────────────

async function searchAndProposeMatches(
    jid: string,
    player: any,
    context: BookingContext,
    from: Date,
    to: Date,
    messageKey?: any
): Promise<void> {
    const openMatches = await prisma.match.findMany({
        where: {
            clubId: player.clubId,
            status: 'OPEN',
            isMixed: context.isMixed ?? false,
            skillLevel: { 
                gte: player.skillLevel - (player.club?.matchLowerRange ?? 1.0), 
                lte: player.skillLevel + (player.club?.matchUpperRange ?? 1.0) 
            },
            startTime: { gte: from, lte: to },
        },
        include: { MatchPlayer: true, court: { include: { prices: true } } },
        orderBy: [
            { startTime: 'asc' },
        ],
    });

    // Filtra solo quelle con spazio sufficiente per il gruppo
    const suitable = openMatches.filter(m => {
        const spotsLeft = m.playersNeeded - m.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
        return spotsLeft >= context.playerCount;
    });

    // Priorità: livelli esatti prima, misti dopo
    suitable.sort((a, b) => {
        if (a.skillLevel === player.skillLevel && b.skillLevel !== player.skillLevel) return -1;
        if (a.skillLevel !== player.skillLevel && b.skillLevel === player.skillLevel) return 1;
        return 0;
    });

    // Ordina: prima quelle che si chiudono esattamente
    const closing = suitable.filter(m => {
        const spotsLeft = m.playersNeeded - m.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
        return spotsLeft === context.playerCount;
    });
    const notClosing = suitable.filter(m => {
        const spotsLeft = m.playersNeeded - m.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
        return spotsLeft > context.playerCount;
    });

    const ordered = [...closing, ...notClosing];

    if (ordered.length === 0) {
        // Nessuna partita disponibile — chiedi orario e crea
        const slotDescription = getSlotDescription(context.timeSlot);
        await simulateTypingAndSend(
            jid,
            `${["Non ho partite aperte", "Non trovo partite disponibili", "Non ci sono slot liberi"][Math.floor(Math.random() * 3)]} ${slotDescription} per il tuo livello 😕 A che ora esatta vorresti giocare? Ti apro io un campo 🎾`,
            messageKey
        );
        await setBookingState(jid, { ...context, step: 'AWAITING_TIME_FOR_NEW_MATCH' });
        return;
    }

    const { calculateCostFromPrices } = await import('./pricing');

    const options = ordered.slice(0, 5).map((m: any, i) => {
        const spotsLeft = m.playersNeeded - m.MatchPlayer.filter((mp: any) => !mp.leftAt).length;
        const timeStr = m.startTime.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
        const willLock = spotsLeft === context.playerCount;

        const cost = calculateCostFromPrices(m.startTime, m.court.prices);
        const costPerPerson = m.playersNeeded > 0 ? cost / m.playersNeeded : cost / 4;
        const costStr = cost > 0 ? ` [€${costPerPerson.toFixed(2)}/testa]` : '';
        const mixedStr = m.isMixed ? ' (Mista 👫)' : ' (Genere Unico 👥)';
        const coveredStr = m.court.isCovered ? ' (Coperto 🏠)' : ' (Scoperto ☀️)';

        return `${i + 1}. ${m.court.name}${coveredStr}${mixedStr} alle ${timeStr}${costStr} — ${willLock
            ? `mancate solo voi ${context.playerCount > 1 ? `${context.playerCount}` : ''}, se confermi chiudo 🔒`
            : `mancano ${spotsLeft} posti, voi ${context.playerCount > 1 ? 'entrate' : 'entri'} e cerco gli altri`
        }`;
    });

    const intro = context.playerCount > 1
        ? `Ho trovato queste partite per voi ${context.playerCount}:`
        : 'Ho trovato queste partite:';

    await simulateTypingAndSend(
        jid,
        `${intro}\n\n${options.join('\n')}\n\nQuale ti va? Dimmi il numero e ti segno subito 🎾`,
        messageKey
    );

    await setBookingState(jid, {
        ...context,
        step: 'AWAITING_MATCH_CHOICE',
        matchOptions: ordered.slice(0, 5).map(m => m.id),
    });
}

// ─────────────────────────────────────────────
// EDGE CASE: CAMPO GARANTITO
// Mario dice "siamo già in 4" → svuota una partita OPEN e dirottta gli altri
// ─────────────────────────────────────────────

async function handleGuaranteedFull(
    jid: string,
    phoneNumber: string,
    context: BookingContext,
    messageKey?: any
): Promise<void> {
    const player = await prisma.player.findFirst({ where: { phoneNumber } });
    if (!player) return;

    const now = new Date();
    const { from, to, exact } = getTimeWindow(context, now);

    if (!from || !to) {
        // If we don't even have a day/slot, we must ask
        await simulateTypingAndSend(
            jid,
            ["Ottimo! Siete già in 4? 🎾 A che ora vorreste giocare?", "Perfetti! Siete al completo 🎾 Che orario vi va?", "Bene! A che ora pensate di giocare? 🏟️"][Math.floor(Math.random() * 3)],
            messageKey
        );
        await setBookingState(jid, { ...context, step: 'AWAITING_TIME_FOR_GUARANTEED' });
        return;
    }

    // Cerca partita OPEN da "liberare" per Mario e i suoi
    // ✅ FIX J: filtra per clubId del player
    const targetMatch = await prisma.match.findFirst({
        where: {
            clubId: (player as any).clubId,
            status: 'OPEN',
            skillLevel: player.skillLevel,
            startTime: { gte: from, lte: to },
        },
        include: { MatchPlayer: { include: { player: true } }, invitations: { include: { player: true } }, club: true, court: true },
        orderBy: { startTime: 'asc' },
    });

    if (!targetMatch) {
        // Nessuna partita da liberare — se abbiamo l'orario esatto, creiamo subito
        if (context.specificTime && (exact ?? from)) {
            await createNewMatch(jid, player, exact ?? from!, context, messageKey);
        }
 else {
            await simulateTypingAndSend(
                jid,
                ["Non ho partite aperte in quella fascia. Vi creo io un campo 🎾 A che ora esatta?", "Nessuna partita disponibile in quella fascia, ma vi apro io uno slot! 🎾 Che orario preferite?", "Niente di aperto in quell'orario, ma posso crearvi un campo! ⏰ A che ora esatta?"][Math.floor(Math.random() * 3)],
                messageKey
            );
            await setBookingState(jid, { ...context, step: 'AWAITING_TIME_FOR_GUARANTEED' });
        }
        return;
    }

    // Raccogli i giocatori da spostare (confirmed + pending)
    const confirmedPlayers = targetMatch.MatchPlayer
        .filter((mp: any) => !mp.leftAt)
        .map((mp: any) => mp.player);
    const pendingPlayers = targetMatch.invitations
        .filter((inv: any) => inv.status === 'PENDING')
        .map((inv: any) => inv.player);

    const playersToRedirect = [...confirmedPlayers, ...pendingPlayers];

    if (playersToRedirect.length === 0) {
        // Partita vuota — assegna direttamente a Mario
        await assignMatchToGroup(targetMatch.id, jid, phoneNumber, context);
        return;
    }

    // Svuota la partita
    await prisma.matchPlayer.updateMany({
        where: { matchId: targetMatch.id, leftAt: null },
        data: { leftAt: new Date() },
    });
    await prisma.invitation.updateMany({
        where: { matchId: targetMatch.id, status: 'PENDING' },
        data: { status: 'IGNORED' },
    });

    // Assegna la partita a Mario e gruppo
    await assignMatchToGroup(targetMatch.id, jid, phoneNumber, context);

    // Dirottta i giocatori rimossi con algoritmo redirect
    if (playersToRedirect.length > 0) {
        const referent = playersToRedirect[0];
        const { redirectGroup } = await import('./redirect');
        await redirectGroup({
            clubId: targetMatch.clubId || '',
            referentPhone: referent.phoneNumber,
            referentJid: referent.phoneNumber,
            playerPhones: playersToRedirect.map((p: any) => p.phoneNumber),
            playerCount: playersToRedirect.length,
            originalMatchId: targetMatch.id,
            originalStartTime: targetMatch.startTime,
            reason: 'CANCELLATION',
        });
    }

    const timeStr = targetMatch.startTime.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
    await simulateTypingAndSend(
        jid,
        `Perfetto! Ho riservato il ${targetMatch.court?.name || "Campo"} ${targetMatch.court?.isCovered ? '🏠' : '☀️'} alle ${timeStr} per voi 4 🎾 Confermate e chiudiamo!`,
        messageKey
    );
}

async function assignMatchToGroup(
    matchId: string,
    referentJid: string,
    referentPhone: string,
    context: BookingContext
): Promise<void> {
    const player = await prisma.player.findFirst({ where: { phoneNumber: referentPhone } });
    if (!player) return;

    await prisma.matchPlayer.create({ data: { matchId, playerId: player.id } });
    await prisma.invitation.create({
        data: { matchId, playerId: player.id, status: 'ACCEPTED' },
    });

    // Salva stato per raccogliere i numeri degli altri del gruppo
    await setBookingState(referentJid, {
        ...context,
        step: 'AWAITING_GROUP_CARDS',
        matchId,
        collectedCount: 1,
    });

    await simulateTypingAndSend(
        referentJid,
        `${["Ti ho segnato!", "Perfetto, sei dentro!", "Registrato! 🎾"][Math.floor(Math.random() * 3)]} Mandami i contatti degli altri ${context.playerCount - 1} e chiudo il campo 🎾`
    );
}

// ─────────────────────────────────────────────
// CONTINUAZIONE FLUSSO BOOKING
// ─────────────────────────────────────────────

export async function continueBookingFlow(
    jid: string,
    messageText: string,
    contactInfo: { phone?: string; name?: string } | null,
    state: any,
    messageKey?: any
): Promise<void> {
    const phoneNumber = jid.split('@')[0];
    const phoneVariants = [phoneNumber, '+' + phoneNumber, phoneNumber.replace(/^\+/, '')];
    const player = await prisma.player.findFirst({ where: { phoneNumber: { in: phoneVariants } } });
    if (!player) return;

    try {
        await _continueBookingFlowInner(jid, phoneNumber, messageText, contactInfo, state, messageKey, player);
    } catch (err) {
        // Cleanup stato in caso di errore — evita che il player rimanga bloccato
        await clearBookingState(jid).catch(() => {});
        throw err;
    }
}

async function _continueBookingFlowInner(
    jid: string,
    phoneNumber: string,
    messageText: string,
    contactInfo: { phone?: string; name?: string } | null,
    state: any,
    messageKey: any,
    player: any
): Promise<void> {

    if (state.step === 'AWAITING_POST_MATCH_FEEDBACK') {
        const { simulateTypingAndSend } = await import('./whatsapp');
        const { clearBookingState } = await import('./booking');
        
        try {
            await prisma.matchFeedback.create({
                data: {
                    matchId: state.matchId,
                    playerId: player.id,
                    courtId: state.courtId || '',
                    content: messageText,
                }
            });
            await simulateTypingAndSend(jid, ["Grazie per il tuo feedback! Lo terremo in considerazione 🎾", "Grazie! Il tuo feedback è prezioso 🙏", "Perfetto, annotato! Grazie per la segnalazione 🎾", "Grazie mille per il feedback! Ci aiuta a migliorare 💪"][Math.floor(Math.random() * 4)], messageKey);
        } catch (err) {
            logger.error({ err }, 'Error saving match feedback');
            await simulateTypingAndSend(jid, ["Grazie per il messaggio! 🎾", "Ricevuto, grazie! 👍", "Messaggio ricevuto 🎾"][Math.floor(Math.random() * 3)], messageKey);
        }
        await clearBookingState(jid);
        return;
    }

    if (state.step === 'AWAITING_SKILL_TEST_CONFIRMATION') {
        const stResp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 10,
            temperature: 0,
            messages: [{ role: 'user', content: `L'utente ha risposto a "vuoi essere contattato per lo Skill Test?". Risposta: "${messageText}". Ha detto SI (vuole essere contattato/vuole fissarlo) o NO (aspetta/non ora)? Rispondi solo SI o NO.` }],
        });
        const stAnswer = (stResp.content[0] as any).text?.trim().toUpperCase();
        if (stAnswer === 'SI' || stAnswer === 'SÌ') {
            await simulateTypingAndSend(jid, 'Perfetto! Ti abbiamo messo in lista 🎾 Il nostro maestro ti contatterà presto per fissare lo Skill Test. Nel frattempo, se hai domande scrivimi pure!', messageKey);
        } else {
            await simulateTypingAndSend(jid, 'Nessun problema! Saremo noi a contattarti a breve 😊 Se cambi idea o hai domande, sono qui.', messageKey);
        }
        await clearBookingState(jid);
        return;
    }

    if (state.step === 'AWAITING_PLAYER_COUNT') {
        const ctx = await extractBookingContext(messageText);
        if (ctx.isCountExplicit) {
            const updatedState = { ...state, playerCount: ctx.playerCount, isCountExplicit: true };
            await startBookingFlow(jid, phoneNumber, messageText, messageKey, updatedState as any);
        } else {
            await simulateTypingAndSend(jid, ["Non ho capito quanti siete 😅 Dimmi un numero (es. 2, 3, 4)!", "In quanti volete giocare? Scrivimi il numero 🎾", "Quanti siete? Bastano poche parole tipo \"siamo in 3\" 😊"][Math.floor(Math.random() * 3)], messageKey);
        }
        return;
    }

    if (state.step === 'AWAITING_TIME' || state.step === 'AWAITING_TIME_FOR_NEW_MATCH') {
        // Estrai orario dal testo
        const timeContext = await extractBookingContext(messageText);
        const now = new Date();
        const { from, to, exact } = getTimeWindow(timeContext, now);

        if (!from) {
            await simulateTypingAndSend(jid, ["Non ho capito l'orario 😅 Prova con qualcosa tipo \"20:30\" o \"stasera alle 20\"", "Non sono riuscito a capire l'orario 🕐 Scrivimelo così: \"20:30\"", "L'orario non è chiaro 😅 Dimmi tipo \"21:00\" o \"alle 8 di sera\""][Math.floor(Math.random() * 3)], messageKey);
            return;
        }

        if (state.step === 'AWAITING_TIME_FOR_NEW_MATCH') {
            // Usa orario esatto (non -30min) per creare la partita
            await createNewMatch(jid, player, exact ?? from, state, messageKey);
        } else {
            await searchAndProposeMatches(jid, player, state, from, to!, messageKey);
        }
        await clearBookingState(jid);
        return;
    }

    if (state.step === 'AWAITING_MATCH_CHOICE') {
        // Risolvi scelta con AI
        const matchIds: string[] = state.matchOptions || [];
        const matches = await prisma.match.findMany({
            where: { id: { in: matchIds } },
            include: { MatchPlayer: true, court: true },
        });

        const choiceIndex = await resolveMatchChoice(messageText, matches);
        if (choiceIndex === null) {
            await simulateTypingAndSend(jid, ["Non ho capito quale partita vuoi 😅 Dimmi il numero (es. \"la prima\", \"2\")", "Non sono sicuro di quale preferisci 🤔 Dimmi il numero!", "Quale scegli? Scrivimi il numero della partita 🎾"][Math.floor(Math.random() * 3)], messageKey);
            return;
        }

        const chosenMatch = matches[choiceIndex];
        await addPlayerToMatch(jid, player, chosenMatch.id, state, messageKey);
        await clearBookingState(jid);
        return;
    }

    if (state.step === 'AWAITING_GROUP_CARDS') {
        const friendLevel = await extractSkillLevel(messageText);
        let phone: string | undefined = contactInfo?.phone;
        let name: string | undefined = contactInfo?.name;

        if (!phone) {
            // Prova a estrarre numero dal testo
            const phoneMatch = messageText.match(/(\+?\d{10,15})/);
            if (phoneMatch) {
                phone = phoneMatch[1];
                name = messageText.replace(phoneMatch[0], '').replace(/\b[1-4]\b/, '').trim() || undefined;
            }
        }

        if (phone) {
            await addFriendToMatch(jid, phone, name, state.matchId, friendLevel ?? undefined, messageKey);
            const newCount = state.collectedCount + 1;

            if (newCount >= state.playerCount) {
                const match = await prisma.match.findUnique({ where: { id: state.matchId } });
                const isFull = state.playerCount >= 4;
                await simulateTypingAndSend(
                    jid, 
                    `Perfetto! Ho aggiunto tutti. ${isFull ? 'Campo chiuso! 🎾' : `Ora mancano solo ${4 - newCount} giocatori per completare la sfida.`}`, 
                    messageKey
                );
                await clearBookingState(jid);
            } else {
                await setBookingState(jid, { ...state, collectedCount: newCount });
                await simulateTypingAndSend(
                    jid,
                    `${newCount}/${state.playerCount} registrati. Mandami ancora ${state.playerCount - newCount} compagno/i (numero e livello)! 👋`,
                    messageKey
                );
            }
        } else {
            await simulateTypingAndSend(jid, "Mandami i contatti come card WhatsApp o scrivi il numero (es. +393471234567) seguito dal livello (1-4) 😊", messageKey);
        }
        return;
    }

    if (state.step === 'AWAITING_FRIEND_LEVEL') {
        const level = await extractSkillLevel(messageText);
        if (level !== null) {
            await prisma.player.updateMany({
                where: { phoneNumber: { startsWith: `FRIEND_${state.matchId}` } },
                data: { skillLevel: level }
            });
            await simulateTypingAndSend(jid, `Ottimo, ho aggiornato il livello! Cerco sostituti adatti 🎾`, messageKey);
            await clearBookingState(jid);
        } else {
            await simulateTypingAndSend(jid, `Non ho capito il livello 😅 Dimmi un numero (es. "livello 3" o "gioca a 4") 🎾`, messageKey);
        }
        return;
    }
    if (state.step === 'AWAITING_TIME_FOR_GUARANTEED') {
        const timeContext = await extractBookingContext(messageText);
        const now = new Date();
        const { from } = getTimeWindow(timeContext, now);

        if (!from) {
            await simulateTypingAndSend(jid, ["Non ho capito l'orario 😅 Prova con qualcosa tipo \"20:30\"", "Non ho capito l'ora 🕐 Scrivimela tipo \"20:30\"", "Che orario? Scrivilo così: \"21:00\" 😊"][Math.floor(Math.random() * 3)], messageKey);
            return;
        }

        // Usa specificTime dall'AI (orario italiano) — non from.toTimeString() che è UTC
        const italianSpecificTime = timeContext.specificTime ?? from.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
        await handleGuaranteedFull(jid, phoneNumber, { ...state, specificTime: italianSpecificTime }, messageKey);
        await clearBookingState(jid);
    }
}

// ─────────────────────────────────────────────
// CREA NUOVA PARTITA
// ─────────────────────────────────────────────

async function createNewMatch(
    jid: string,
    player: any,
    startTime: Date,
    context: BookingContext,
    messageKey?: any
): Promise<void> {
    const playerCount = context.playerCount;
    // ✅ FIX J/M: usa clubId dal player — non findFirst()
    const clubId = player.clubId;
    const maxLevel = player.club?.skillLevelCount ?? 3;

    // Assegna il primo campo disponibile del club in quell'orario
    const occupiedCourtIds = await prisma.match.findMany({
        where: { clubId, status: { in: ['OPEN', 'LOCKED'] }, startTime },
        select: { courtId: true },
    });
    const occupiedIds = occupiedCourtIds.map(m => m.courtId).filter(Boolean);
    const freeCourt = await prisma.court.findFirst({
        where: { clubId, active: true, id: { notIn: occupiedIds as string[] } },
        orderBy: { name: 'asc' },
    });

    // Tutti i campi occupati — proponi alternative tramite redirect service
    if (!freeCourt) {
        const { redirectGroup } = await import('./redirect');
        const tempMatchId = `temp-${Date.now()}`;
        await simulateTypingAndSend(
            jid,
            ["Ops! Tutti i campi sono occupati a quell'ora 😕 Guarda qui le alternative:", "Peccato, quell'orario è tutto esaurito! Ti propongo qualche alternativa:", "Nessun campo libero a quell'ora 😕 Ho trovato però queste opzioni per te:"][Math.floor(Math.random() * 3)],
            messageKey
        );
        await redirectGroup({
            referentPhone: player.phoneNumber,
            referentJid: jid,
            playerPhones: [player.phoneNumber],
            playerCount: playerCount,
            originalMatchId: tempMatchId,
            originalStartTime: startTime,
            reason: 'SLOT_TAKEN',
            clubId,
        });
        return;
    }

    // Giocatori senza livello (pending skill test) non possono fare matchmaking —
    // creiamo il campo ma senza wave. Il match è OPEN ma nessuno viene invitato.
    const isPendingSkillTest = player.skillLevel <= 0;
    const matchSkillLevel = isPendingSkillTest ? 1.0 : player.skillLevel;

    const match = await prisma.match.create({
        data: {
            clubId,
            courtId: freeCourt?.id,
            startTime,
            isMixed: context.isMixed ?? false,
            skillLevel: matchSkillLevel,
            allowMixedLevels: player.club?.allowMixedLevels ?? false,
            playersNeeded: 4,
            status: playerCount >= 4 ? 'LOCKED' : 'OPEN',
        },
    });

    await prisma.matchPlayer.create({ data: { matchId: match.id, playerId: player.id } });
    await prisma.invitation.create({ data: { matchId: match.id, playerId: player.id, status: 'ACCEPTED' } });

    // Lancia wave solo se il giocatore ha un livello valido
    const spotsNeeded = match.playersNeeded - 1;
    if (spotsNeeded > 0 && !isPendingSkillTest) {
        await waveQueue.add('process-wave', {
            matchId: match.id,
            waveNumber: 1,
            limit: spotsNeeded,
        }, {
            delay: Math.floor(Math.random() * 60000) + 30000,
        });
    }

    const { calculateMatchCost } = await import('./pricing');
    const cost = await calculateMatchCost(match.id);

    const courtName = freeCourt?.name || 'Campo';
    const timeStr = startTime.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
    const searchingMsg = isPendingSkillTest
        ? `Campo prenotato! 🏟️ ${courtName} ${freeCourt?.isCovered ? '🏠' : '☀️'} · ${timeStr}${cost > 0 ? ` · €${(cost / 4).toFixed(2)} a testa` : ''} · Porta i tuoi amici e divertitevi! 🎾`
        : `Partita aperta! 🏟️ ${courtName} ${freeCourt?.isCovered ? '🏠' : '☀️'} · ${timeStr}${cost > 0 ? ` · €${(cost / 4).toFixed(2)} a testa` : ''} · Cerco altri ${spotsNeeded} giocatori!`;
    await simulateTypingAndSend(jid, searchingMsg, messageKey);
}

// ─────────────────────────────────────────────
// AGGIUNGI GIOCATORE A PARTITA
// ─────────────────────────────────────────────

async function addPlayerToMatch(
    jid: string,
    player: any,
    matchId: string,
    context: BookingContext,
    messageKey?: any
): Promise<void> {
    const playerCount = context.playerCount;
    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: true, court: true },
    });

    if (!match || match.status !== 'OPEN') {
        await simulateTypingAndSend(jid, ["Mi dispiace, quella partita si è nel frattempo chiusa! Vuoi cercarne un'altra?", "Purtroppo quella partita è già piena 😕 Cerco un'altra opzione?", "Ops, qualcuno mi ha battuto sul tempo! 🎾 Quella partita è chiusa. Ne cerco un'altra?"][Math.floor(Math.random() * 3)], messageKey);
        return;
    }

    await prisma.matchPlayer.upsert({
        where: { matchId_playerId: { matchId, playerId: player.id } },
        create: { matchId, playerId: player.id },
        update: {},
    });

    // Cerca invitation esistente, aggiorna o crea — upsert con id UUID non funziona
    const existingInv = await prisma.invitation.findFirst({
        where: { matchId, playerId: player.id },
        orderBy: { sentAt: 'desc' },
    });
    if (existingInv) {
        await prisma.invitation.update({
            where: { id: existingInv.id },
            data: { status: 'ACCEPTED', respondedAt: new Date() },
        });
    } else {
        await prisma.invitation.create({
            data: { matchId, playerId: player.id, status: 'ACCEPTED', respondedAt: new Date() },
        });
    }

    const { calculateMatchCost } = await import('./pricing');
    const cost = await calculateMatchCost(match.id);

    const timeStr = match.startTime.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
    const updatedMatch = await prisma.match.findUnique({ where: { id: matchId }, include: { MatchPlayer: true } });
    const spotsLeft = (updatedMatch?.playersNeeded ?? 4) - (updatedMatch?.MatchPlayer.filter((mp: any) => !mp.leftAt).length ?? 1);
    await simulateTypingAndSend(
        jid,
        `Fatto! ${match.court?.name ? match.court.name + (match.court.isCovered ? ' 🏠' : ' ☀️') + ' · ' : ''}sei in per le ${timeStr} 🏟️ ${cost > 0 ? `€${(cost / 4).toFixed(2)} a testa. ` : ''}${spotsLeft > 0 ? `Cerco altri ${spotsLeft} giocatori, ti avviso!` : 'Siete al completo! 🎾'}`,
        messageKey
    );
}

async function addFriendToMatch(
    referentJid: string,
    friendPhone: string,
    friendName: string | undefined,
    matchId: string,
    skillLevel?: number,
    messageKey?: any
): Promise<void> {
    const match = await prisma.match.findUnique({ where: { id: matchId } });
    if (!match) return;

    let friend = await prisma.player.findFirst({ where: { phoneNumber: friendPhone } });

    if (!friend) {
        const referentPlayer = await prisma.player.findFirst({ where: { phoneNumber: referentJid.split('@')[0] } });
        friend = await prisma.player.create({
            data: {
                phoneNumber: friendPhone,
                name: friendName || null,
                skillLevel: skillLevel ?? referentPlayer?.skillLevel ?? 3,
                active: true,
                clubId: match.clubId
            },
        });
    } else if (skillLevel) {
        await prisma.player.update({ where: { id: friend.id }, data: { skillLevel } });
    }

    await prisma.matchPlayer.upsert({
        where: { matchId_playerId: { matchId, playerId: friend.id } },
        create: { matchId, playerId: friend.id },
        update: {},
    });

    // Se il livello dell'amico è diverso da quello della partita, abilita Mixed Levels
    if (skillLevel && skillLevel !== match.skillLevel && !match.allowMixedLevels) {
        await prisma.match.update({
            where: { id: matchId },
            data: { allowMixedLevels: true }
        });
        logger.info({ matchId, friendLevel: skillLevel }, 'Enabling mixed levels for match due to diverse friend level');
    }
}

// ─────────────────────────────────────────────
// UTILITY
// ─────────────────────────────────────────────

function getTimeWindow(
    context: BookingContext,
    now: Date
): { from: Date | null; to: Date | null; exact: Date | null } {
    let targetDate = new Date(now);

    if (context.specificDay) {
        const dayMap: Record<string, number> = {
            'domenica': 0, 'lunedì': 1, 'martedì': 2, 'mercoledì': 3,
            'giovedì': 4, 'venerdì': 5, 'sabato': 6
        };

        if (context.specificDay === 'domani') {
            targetDate.setDate(targetDate.getDate() + 1);
        } else if (context.specificDay !== 'oggi' && dayMap[context.specificDay] !== undefined) {
            const targetDay = dayMap[context.specificDay];
            const currentDay = targetDate.getDay();
            let diff = targetDay - currentDay;
            if (diff <= 0) diff += 7; // Prossimo occorrenza del giorno
            targetDate.setDate(targetDate.getDate() + diff);
        }
    }

    if (context.specificTime) {
        const [h, m] = context.specificTime.split(':').map(Number);
        const specific = buildRomeTime(targetDate, h, m);
        return {
            from: new Date(specific.getTime() - 30 * 60 * 1000),
            to: new Date(specific.getTime() + 30 * 60 * 1000),
            exact: specific,
        };
    }

    const slots: Record<string, { from: number; to: number }> = {
        morning: { from: 7, to: 13 },
        afternoon: { from: 13, to: 18 },
        evening: { from: 18, to: 23 },
    };

    const slot = slots[context.timeSlot];
    if (!slot) return { from: null, to: null, exact: null };

    return {
        from: buildRomeTime(targetDate, slot.from, 0),
        to: buildRomeTime(targetDate, slot.to, 0),
        exact: null,
    };
}

/**
 * Costruisce un Date UTC interpretando h:m come orario italiano (Europe/Rome).
 * Gestisce automaticamente DST (UTC+1 inverno, UTC+2 estate).
 */
function buildRomeTime(baseDate: Date, h: number, m: number): Date {
    // Usa mezzogiorno UTC come riferimento DST-safe per trovare l'offset Rome
    const noon = new Date(Date.UTC(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), 12, 0, 0));
    const noonRomeHour = Number(noon.toLocaleString('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }));
    const offsetH = noonRomeHour - 12; // +1 in inverno, +2 in estate

    // h:m è ora italiana → sottrai offset per ottenere UTC
    let utcH = h - offsetH;
    let dayOffset = 0;
    if (utcH < 0) { utcH += 24; dayOffset = -1; }
    if (utcH >= 24) { utcH -= 24; dayOffset = 1; }

    return new Date(Date.UTC(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate() + dayOffset, utcH, m, 0));
}

function getSlotDescription(timeSlot: string): string {
    const desc: Record<string, string> = {
        morning: 'stamattina',
        afternoon: 'questo pomeriggio',
        evening: 'stasera',
        unknown: 'in questo momento',
    };
    return desc[timeSlot] || '';
}

async function extractSkillLevel(text: string): Promise<number | null> {
    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 5,
            temperature: 0,
            messages: [{ role: 'user', content: `Qual è il livello di padel (numero intero da 1 a 7) menzionato in questo messaggio? Rispondi SOLO con il numero o "null".\nMessaggio: "${text}"` }],
        });
        const val = (response.content[0] as any).text?.trim();
        const n = parseInt(val);
        if (!isNaN(n) && n >= 1 && n <= 7) return n;
    } catch (err) {
        logger.error({ err }, 'extractSkillLevel failed');
    }
    return null;
}

async function resolveMatchChoice(text: string, matches: any[]): Promise<number | null> {
    const { anthropic } = await import('./ai');
    const list = matches.map((m, i) =>
        `${i + 1}. ${m.court} alle ${m.startTime.toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' })}`
    ).join('\n');

    try {
        const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 5,
            temperature: 0,
            messages: [{
                role: 'user',
                content: `Lista opzioni:\n${list}\n\nL'utente ha risposto: "${text}"\n\nQuale numero ha scelto? Rispondi SOLO con il numero o UNCLEAR.`,
            }],
        });

        const content = response.content[0];
        if (content.type === 'text') {
            const val = content.text.trim();
            if (val === 'UNCLEAR') return null;
            const idx = parseInt(val) - 1;
            if (idx >= 0 && idx < matches.length) return idx;
        }
    } catch (err) {
        logger.error({ err }, 'Error resolving match choice');
    }

    return null;
}

// ─────────────────────────────────────────────
// STATO BOOKING
// ─────────────────────────────────────────────

// Stato BOOKING_FLOW — dual-write Redis + PostgreSQL tramite conversation-state
export async function setBookingState(jid: string, data: any): Promise<void> {
    try {
        const { setState } = await import('./conversation-state');
        await setState(`state:booking:${jid}`, data);
    } catch (err) {
        logger.error({ err, jid }, 'Failed to save booking state');
    }
}

export async function getBookingState(jid: string): Promise<any | null> {
    try {
        const { getState } = await import('./conversation-state');
        return await getState(`state:booking:${jid}`);
    } catch (err) {
        logger.error({ err, jid }, 'Failed to read booking state');
        return null;
    }
}

export async function clearBookingState(jid: string): Promise<void> {
    try {
        const { clearState } = await import('./conversation-state');
        await clearState(`state:booking:${jid}`);
    } catch (err) {
        logger.error({ err, jid }, 'Failed to clear booking state');
    }
}
