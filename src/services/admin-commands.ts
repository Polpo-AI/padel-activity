/**
 * ADMIN COMMANDS
 *
 * Parsing e esecuzione di comandi DB via WhatsApp da parte dell'admin del circolo.
 * Scoped esclusivamente al club dell'admin.
 *
 * Supporta operazioni singole, multiple e combinate:
 *   es. "cancella tutte le partite di domani"
 *       "porta il livello di tutti i giocatori con skill 2 a 2.5"
 *       "disattiva il campo 1 e cancella le partite"
 *
 * L'AI capisce l'intent, costruisce una lista di step ed — se distruttivo —
 * chiede conferma prima di eseguire. In caso di ambiguità chiede chiarimento.
 */

import { prisma } from './db';
import { anthropic } from './ai';
import { simulateTypingAndSend, sendMessage } from './whatsapp';
import { getRedis } from './queue';
import pino from 'pino';

const logger = pino({ level: 'info' });

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

type AdminCommand =
    | 'LIST_MATCHES'
    | 'LIST_PLAYERS'
    | 'CANCEL_MATCH'       // params: { matchIds: string[] }
    | 'RESCHEDULE_MATCH'   // params: { matchId: string, newDay: string, newTime: string }
    | 'UPDATE_PLAYER_SKILL'// params: { playerIds: string[], newSkill: number }
    | 'DELETE_PLAYER'      // params: { playerId: string }
    | 'DEACTIVATE_COURT'   // params: { courtId: string }
    | 'CHANGE_CLUB_HOURS'  // params: { openTime?: string, closeTime?: string }
    | 'NEEDS_CLARIFICATION'// params: { question: string }
    | 'UNKNOWN';           // non è un comando admin → passa al brain normale

type AdminStep = {
    command: AdminCommand;
    params: any;
};

type ParsedAdminRequest = {
    steps: AdminStep[];
    requiresConfirmation: boolean;
    confirmPrompt: string; // mostrato all'admin prima di eseguire
};

// ─────────────────────────────────────────────
// FAQ FLOW (intelligente, senza formato hardcoded)
// ─────────────────────────────────────────────

/**
 * Gestisce il flusso FAQ lato admin via ragionamento AI.
 * Ritorna true se il messaggio è stato gestito dal flusso FAQ.
 */
export async function handleAdminFaqFlow(text: string, club: any, jid: string): Promise<boolean> {
    if (!club?.id || !text.trim()) return false;
    const redis = getRedis();
    const clubId = club.id;

    // ── Stato 1: admin ha già visto la proposta di salvataggio e deve confermare sì/no
    const confirmRaw = await redis.get(`faq:awaiting_save_confirm:${clubId}`);
    if (confirmRaw) {
        const { question, answer, askedBy } = JSON.parse(confirmRaw);
        const affirmative = /^(s[iì]|yes|ok|va bene|certo|giusto|esatto|salvala?|conferm)/i.test(text.trim());
        const negative = /^(no|nope|non salvare|non va bene|sbagliato|lascia perdere|skip)/i.test(text.trim());

        if (affirmative) {
            await prisma.faq.create({ data: { clubId, question, answer, askedBy: askedBy || null } });
            await redis.del(`faq:awaiting_save_confirm:${clubId}`);
            await redis.del(`faq:pending_question:${clubId}`);
            await sendMessage(jid, `Salvato! La risposta sarà disponibile agli utenti da ora.`);
            return true;
        }

        if (negative) {
            await redis.del(`faq:awaiting_save_confirm:${clubId}`);
            await sendMessage(jid, `Ok, non salvo. La domanda resta in sospeso se vuoi rispondere diversamente.`);
            return true;
        }

        // Non è un sì/no: potrebbe essere una risposta aggiornata → ri-classifica
        await redis.del(`faq:awaiting_save_confirm:${clubId}`);
    }

    // ── Stato 2: c'è una domanda pending → classifica se il messaggio è una risposta
    const pendingRaw = await redis.get(`faq:pending_question:${clubId}`);
    if (!pendingRaw) return false;

    const { question, askedBy } = JSON.parse(pendingRaw);

    const classification = await classifyAdminFaqResponse(question, text);

    if (!classification.isFaqAnswer) return false;

    if (classification.isFaqAnswer && classification.confidence === 'high' && classification.faqWorthy) {
        await prisma.faq.create({ data: { clubId, question, answer: text.trim(), askedBy: askedBy || null } });
        await redis.del(`faq:pending_question:${clubId}`);
        await sendMessage(jid, `Ho salvato la risposta come FAQ. Gli utenti la riceveranno direttamente la prossima volta che chiedono qualcosa di simile.`);
        return true;
    }

    await redis.set(
        `faq:awaiting_save_confirm:${clubId}`,
        JSON.stringify({ question, answer: text.trim(), askedBy }),
        'EX', 24 * 3600,
    );
    await sendMessage(
        jid,
        `Vuoi che salvi questa risposta come FAQ per le prossime domande simili?\n\nD: ${question}\nR: ${text.trim()}\n\nRispondi sì o no.`,
    );
    return true;
}

async function classifyAdminFaqResponse(
    pendingQuestion: string,
    adminMessage: string,
): Promise<{ isFaqAnswer: boolean; confidence: 'high' | 'low'; faqWorthy: boolean }> {
    const prompt = `L'admin di un circolo padel ha ricevuto questa notifica: un utente ha chiesto "${pendingQuestion}".

L'admin ha scritto: "${adminMessage}"

Analizza se il messaggio dell'admin è una risposta alla domanda dell'utente.

Restituisci SOLO un JSON valido:
{
  "isFaqAnswer": true/false,
  "confidence": "high"/"low",
  "faqWorthy": true/false
}

Criteri:
- isFaqAnswer: true se il messaggio risponde (anche parzialmente) alla domanda
- confidence: "high" se è chiaramente una risposta, "low" se hai dubbi
- faqWorthy: true se la risposta è sufficientemente completa e utile da salvare per utenti futuri`;

    try {
        const resp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 100,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        });
        const content = resp.content[0];
        if (content.type === 'text') {
            const raw = content.text.trim();
            const start = raw.indexOf('{');
            const end = raw.lastIndexOf('}');
            if (start !== -1 && end !== -1) return JSON.parse(raw.substring(start, end + 1));
        }
    } catch (err) {
        logger.error({ err }, 'classifyAdminFaqResponse failed');
    }
    return { isFaqAnswer: false, confidence: 'low', faqWorthy: false };
}

// ─────────────────────────────────────────────
// MAIN COMMAND HANDLER
// ─────────────────────────────────────────────

/**
 * Tenta di interpretare il messaggio come un comando admin.
 * Ritorna true se il messaggio è stato gestito (anche solo per chiedere conferma).
 * Ritorna false se non è un comando → passa al brain normale.
 */
export async function handleAdminCommand(text: string, club: any, jid: string): Promise<boolean> {
    const now = new Date().toLocaleString('it-IT', {
        timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric',
        month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });

    const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [upcomingMatches, allPlayers, allCourts] = await Promise.all([
        prisma.match.findMany({
            where: {
                clubId: club.id,
                startTime: { gte: new Date(), lte: sevenDaysOut },
                status: { in: ['OPEN', 'LOCKED'] },
            },
            include: {
                court: true,
                MatchPlayer: { where: { leftAt: null }, include: { player: true } },
            },
            orderBy: { startTime: 'asc' },
            take: 30,
        }),
        prisma.player.findMany({
            where: { clubId: club.id, active: true },
            select: { id: true, name: true, phoneNumber: true, skillLevel: true },
            orderBy: { name: 'asc' },
        }),
        prisma.court.findMany({
            where: { clubId: club.id },
            select: { id: true, name: true, active: true, isCovered: true },
            orderBy: { name: 'asc' },
        }),
    ]);

    const fmtTime = (d: Date) => d.toLocaleString('it-IT', {
        timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric',
        month: 'short', hour: '2-digit', minute: '2-digit',
    });

    const matchesStr = upcomingMatches.length > 0
        ? upcomingMatches.map(m => {
            const players = m.MatchPlayer.map((mp: any) => mp.player.name || mp.player.phoneNumber).join(', ');
            return `ID:${m.id} | ${m.court?.name || 'Campo'} | ${fmtTime(m.startTime)} | ${m.status} | Giocatori: [${players || 'nessuno'}]`;
        }).join('\n')
        : 'Nessuna partita nei prossimi 7 giorni';

    const playersStr = allPlayers.length > 0
        ? allPlayers.map(p => `ID:${p.id} | ${p.name || 'N/A'} | Tel:${p.phoneNumber} | Livello:${p.skillLevel}`).join('\n')
        : 'Nessun giocatore';

    const courtsStr = allCourts.length > 0
        ? allCourts.map((c: any) => `ID:${c.id} | ${c.name} | ${c.active ? 'attivo' : 'disattivato'} | ${c.isCovered ? 'coperto' : 'scoperto'}`).join('\n')
        : 'Nessun campo';

    const prompt = `Sei il parser di comandi per un admin di un circolo padel.
L'admin ha scritto: "${text}"

Dati disponibili:

PARTITE (prossimi 7 giorni):
${matchesStr}

GIOCATORI:
${playersStr}

CAMPI:
${courtsStr}

Orari circolo: ${club.openTime || '08:00'} – ${club.closeTime || '23:30'}
Data/ora attuali: ${now}

Analizza se il messaggio è un comando di gestione del circolo. Se non lo è (es. saluto, domanda generica, conversazione), restituisci UNKNOWN.

Se è un comando, costruisci la lista di step necessari per eseguirlo — anche se sono più operazioni combinate (es. "disattiva il campo E cancella le partite" = 2 step).

Restituisci SOLO un JSON valido:
{
  "steps": [
    { "command": "NOME_COMANDO", "params": { ... } }
  ],
  "requiresConfirmation": true/false,
  "confirmPrompt": "Descrizione chiara di cosa verrà fatto, mostrata all'admin prima di confermare"
}

Comandi disponibili e parametri:
- LIST_MATCHES: { "dateFrom": "YYYY-MM-DD"?, "dateTo": "YYYY-MM-DD"?, "courtId": "id"? }
- LIST_PLAYERS: { "skillMin": number?, "skillMax": number?, "nameQuery": "string"? }
- CANCEL_MATCH: { "matchIds": ["id1", "id2", ...] }  ← array, anche con un solo elemento
- RESCHEDULE_MATCH: { "matchId": "id", "newDay": "YYYY-MM-DD", "newTime": "HH:MM" }
- UPDATE_PLAYER_SKILL: { "playerIds": ["id1", "id2", ...], "newSkill": number }  ← array
- DELETE_PLAYER: { "playerId": "id" }
- DEACTIVATE_COURT: { "courtId": "id" }
- CHANGE_CLUB_HOURS: { "openTime": "HH:MM"?, "closeTime": "HH:MM"? }
- NEEDS_CLARIFICATION: { "question": "domanda da fare all'admin per capire meglio" }
- UNKNOWN: {}

Regole:
- requiresConfirmation: true se almeno uno step è distruttivo (CANCEL, DELETE, DEACTIVATE) o modifica dati (UPDATE, CHANGE_CLUB_HOURS, RESCHEDULE)
- Per LIST_* e UNKNOWN: requiresConfirmation: false
- confirmPrompt: descrizione esatta dell'impatto (quante partite, quali giocatori, ecc.)
- Se l'admin dice "tutte le partite di domani", includi tutti i matchIds corrispondenti
- Se l'admin menziona una persona per nome, trova l'ID corrispondente nella lista giocatori
- Se non trovi un riferimento (es. nome non presente nella lista), usa NEEDS_CLARIFICATION
- UNKNOWN: non è un comando admin, è conversazione normale → steps: [{ "command": "UNKNOWN", "params": {} }]

Esempi:
- "mostra partite di domani" → LIST_MATCHES, requiresConfirmation: false
- "cancella tutte le partite di domani" → CANCEL_MATCH con tutti i matchIds di domani, requiresConfirmation: true
- "porta il livello di Mario Rossi a 4" → UPDATE_PLAYER_SKILL con il suo playerId, requiresConfirmation: true
- "disattiva il campo 1 e cancella le sue partite" → [CANCEL_MATCH, DEACTIVATE_COURT], requiresConfirmation: true
- "ciao come stai" → UNKNOWN, requiresConfirmation: false
- "quanti giocatori ho con livello 3?" → LIST_PLAYERS con skillMin:3, skillMax:3, requiresConfirmation: false`;

    let parsed: ParsedAdminRequest = {
        steps: [{ command: 'UNKNOWN', params: {} }],
        requiresConfirmation: false,
        confirmPrompt: '',
    };

    try {
        const resp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 600,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        });
        const content = resp.content[0];
        if (content.type === 'text') {
            const raw = content.text.trim();
            const start = raw.indexOf('{');
            const end = raw.lastIndexOf('}');
            if (start !== -1 && end !== -1) {
                parsed = JSON.parse(raw.substring(start, end + 1));
            }
        }
    } catch (err) {
        logger.error({ err }, 'Admin command parse failed');
        await simulateTypingAndSend(jid, 'Non sono riuscita a capire il comando. Puoi riformulare?');
        return true;
    }

    // Solo UNKNOWN → non è un comando admin
    if (parsed.steps.length === 1 && parsed.steps[0].command === 'UNKNOWN') {
        return false;
    }

    // NEEDS_CLARIFICATION → chiedi e aspetta
    const clarStep = parsed.steps.find(s => s.command === 'NEEDS_CLARIFICATION');
    if (clarStep) {
        await simulateTypingAndSend(jid, clarStep.params?.question || 'Puoi specificare meglio?');
        return true;
    }

    // Operazioni di sola lettura → esegui subito
    if (!parsed.requiresConfirmation) {
        await executeAdminSteps(parsed.steps, club, jid, upcomingMatches, allPlayers, allCourts);
        return true;
    }

    // Operazioni distruttive/modificanti → chiedi conferma
    const redis = getRedis();
    await redis.set(
        `admin:pending_action:${club.id}`,
        JSON.stringify({ steps: parsed.steps }),
        'EX', 3600,
    );
    await simulateTypingAndSend(jid, `${parsed.confirmPrompt}\n\nConfermi? Rispondi sì o no.`);
    return true;
}

// ─────────────────────────────────────────────
// PENDING ACTION CONFIRMATION
// ─────────────────────────────────────────────

/**
 * Gestisce la conferma sì/no per azioni che richiedono approvazione esplicita.
 * Ritorna true se il messaggio è stato gestito.
 */
export async function handleAdminPendingAction(text: string, club: any, jid: string): Promise<boolean> {
    if (!club?.id) return false;
    const redis = getRedis();
    const pendingRaw = await redis.get(`admin:pending_action:${club.id}`);
    if (!pendingRaw) return false;

    const affirmative = /^(s[iì]|yes|ok|va bene|certo|conferm|procedi|esegui)/i.test(text.trim());
    const negative = /^(no|nope|annulla|lascia perdere|stop|non fare)/i.test(text.trim());

    if (!affirmative && !negative) return false;

    const { steps } = JSON.parse(pendingRaw);
    await redis.del(`admin:pending_action:${club.id}`);

    if (negative) {
        await sendMessage(jid, `Capito, operazione annullata.`);
        return true;
    }

    // Ricarica i dati freschi prima di eseguire
    const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [upcomingMatches, allPlayers, allCourts] = await Promise.all([
        prisma.match.findMany({
            where: { clubId: club.id, startTime: { gte: new Date(), lte: sevenDaysOut }, status: { in: ['OPEN', 'LOCKED'] } },
            include: { court: true, MatchPlayer: { where: { leftAt: null }, include: { player: true } } },
            orderBy: { startTime: 'asc' },
            take: 30,
        }),
        prisma.player.findMany({
            where: { clubId: club.id, active: true },
            select: { id: true, name: true, phoneNumber: true, skillLevel: true },
        }),
        prisma.court.findMany({
            where: { clubId: club.id },
            select: { id: true, name: true, active: true, isCovered: true },
        }),
    ]);

    await executeAdminSteps(steps, club, jid, upcomingMatches, allPlayers, allCourts);
    return true;
}

// ─────────────────────────────────────────────
// EXECUTE STEPS
// ─────────────────────────────────────────────

async function executeAdminSteps(
    steps: AdminStep[],
    club: any,
    jid: string,
    upcomingMatches: any[],
    allPlayers: any[],
    allCourts: any[],
): Promise<void> {
    const fmtTimeLong = (d: Date) => d.toLocaleString('it-IT', {
        timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric',
        month: 'long', hour: '2-digit', minute: '2-digit',
    });

    for (const step of steps) {
        const { command, params } = step;

        if (command === 'LIST_MATCHES') {
            let filtered = [...upcomingMatches];
            if (params.courtId) filtered = filtered.filter(m => m.courtId === params.courtId);
            if (params.dateFrom) {
                const from = new Date(params.dateFrom);
                filtered = filtered.filter(m => m.startTime >= from);
            }
            if (params.dateTo) {
                const to = new Date(params.dateTo + 'T23:59:59');
                filtered = filtered.filter(m => m.startTime <= to);
            }

            if (filtered.length === 0) {
                await simulateTypingAndSend(jid, 'Nessuna partita trovata per i criteri indicati.');
                continue;
            }

            const lines = filtered.map(m => {
                const players = m.MatchPlayer.map((mp: any) => mp.player.name || mp.player.phoneNumber).join(', ');
                const status = m.status === 'LOCKED' ? 'completa' : `aperta (${m.MatchPlayer.length}/4)`;
                return `${fmtTimeLong(m.startTime)}\n${m.court?.name || 'Campo'} (${status})\nGiocatori: ${players || 'nessuno'}`;
            });
            await simulateTypingAndSend(jid, `Partite trovate: ${filtered.length}\n\n${lines.join('\n\n')}`);
            continue;
        }

        if (command === 'LIST_PLAYERS') {
            let filtered = [...allPlayers];
            if (params.skillMin !== undefined) filtered = filtered.filter((p: any) => p.skillLevel >= params.skillMin);
            if (params.skillMax !== undefined) filtered = filtered.filter((p: any) => p.skillLevel <= params.skillMax);
            if (params.nameQuery) {
                const q = params.nameQuery.toLowerCase();
                filtered = filtered.filter((p: any) => (p.name || '').toLowerCase().includes(q));
            }

            if (filtered.length === 0) {
                await simulateTypingAndSend(jid, 'Nessun giocatore trovato per i criteri indicati.');
                continue;
            }

            const lines = filtered.map((p: any) =>
                `${p.name || 'N/A'} (livello ${p.skillLevel > 0 ? p.skillLevel : 'da assegnare'}) — ${p.phoneNumber}`,
            );
            await simulateTypingAndSend(jid, `Giocatori trovati: ${filtered.length}\n\n${lines.join('\n')}`);
            continue;
        }

        if (command === 'CANCEL_MATCH') {
            const matchIds: string[] = Array.isArray(params.matchIds) ? params.matchIds : [params.matchId].filter(Boolean);
            if (matchIds.length === 0) {
                await simulateTypingAndSend(jid, 'Nessuna partita specificata da cancellare.');
                continue;
            }

            const { cancelMatchesWithNotification } = await import('./match-notifications');
            const cancelled = await cancelMatchesWithNotification(matchIds, club.id, 'Cancellazione admin');
            await simulateTypingAndSend(jid, `${cancelled} partita${cancelled !== 1 ? 'e' : ''} cancellata${cancelled !== 1 ? 'e' : ''} e giocatori notificati.`);
            continue;
        }

        if (command === 'RESCHEDULE_MATCH') {
            const match = upcomingMatches.find(m => m.id === params.matchId);
            if (!match) {
                await simulateTypingAndSend(jid, 'Partita non trovata.');
                continue;
            }
            if (!params.newDay || !params.newTime) {
                await simulateTypingAndSend(jid, 'Specifica il nuovo giorno (YYYY-MM-DD) e orario (HH:MM).');
                continue;
            }

            const [y, mo, d] = params.newDay.split('-').map(Number);
            const [h, m] = params.newTime.split(':').map(Number);
            if (isNaN(y) || isNaN(h)) {
                await simulateTypingAndSend(jid, 'Formato data/ora non valido. Usa YYYY-MM-DD e HH:MM.');
                continue;
            }

            const noon = new Date(Date.UTC(y, mo - 1, d, 12, 0));
            const noonRomeHour = Number(noon.toLocaleString('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }));
            const offsetH = noonRomeHour - 12;
            let utcH = h - offsetH;
            let dayOffset = 0;
            if (utcH < 0) { utcH += 24; dayOffset = -1; }
            if (utcH >= 24) { utcH -= 24; dayOffset = 1; }
            const newStartTime = new Date(Date.UTC(y, mo - 1, d + dayOffset, utcH, m, 0));

            if (match.courtId) {
                const conflict = await prisma.match.findFirst({
                    where: { courtId: match.courtId, id: { not: match.id }, status: { in: ['OPEN', 'LOCKED'] }, startTime: newStartTime },
                });
                if (conflict) {
                    await simulateTypingAndSend(jid, `Il campo è già occupato a quell'orario. Scegli un altro orario.`);
                    continue;
                }
            }

            const oldStartTime = match.startTime;
            await prisma.match.update({ where: { id: match.id }, data: { startTime: newStartTime } });

            const { notifyMatchRescheduled } = await import('./match-notifications');
            await notifyMatchRescheduled(match.id, oldStartTime, newStartTime, club.id)
                .catch(err => logger.error({ err }, 'notifyMatchRescheduled failed'));

            const nPlayers = match.MatchPlayer.length;
            await simulateTypingAndSend(jid, `Partita spostata da ${fmtTimeLong(oldStartTime)} a ${fmtTimeLong(newStartTime)}. ${nPlayers > 0 ? `Ho avvisato ${nPlayers} giocatori.` : ''}`);
            continue;
        }

        if (command === 'UPDATE_PLAYER_SKILL') {
            const playerIds: string[] = Array.isArray(params.playerIds) ? params.playerIds : [params.playerId].filter(Boolean);
            if (playerIds.length === 0) {
                await simulateTypingAndSend(jid, 'Nessun giocatore specificato.');
                continue;
            }
            const newSkill = Number(params.newSkill);
            if (isNaN(newSkill) || newSkill < 1 || newSkill > 7) {
                await simulateTypingAndSend(jid, 'Il livello deve essere un numero tra 1.0 e 7.0.');
                continue;
            }

            await prisma.player.updateMany({ where: { id: { in: playerIds } }, data: { skillLevel: newSkill } });
            const names = allPlayers
                .filter((p: any) => playerIds.includes(p.id))
                .map((p: any) => p.name || p.phoneNumber);
            await simulateTypingAndSend(jid, `Livello aggiornato a ${newSkill} per: ${names.join(', ')}.`);
            continue;
        }

        if (command === 'DELETE_PLAYER') {
            const player = allPlayers.find((p: any) => p.id === params.playerId);
            if (!player) {
                await simulateTypingAndSend(jid, 'Giocatore non trovato.');
                continue;
            }
            await prisma.player.update({ where: { id: player.id }, data: { active: false } });
            await simulateTypingAndSend(jid, `${player.name || player.phoneNumber} rimosso dal circolo. Non riceverà più messaggi né inviti.`);
            continue;
        }

        if (command === 'DEACTIVATE_COURT') {
            const court = allCourts.find((c: any) => c.id === params.courtId);
            if (!court) {
                await simulateTypingAndSend(jid, 'Campo non trovato.');
                continue;
            }
            if (!court.active) {
                await simulateTypingAndSend(jid, `${court.name} è già disattivato.`);
                continue;
            }
            await prisma.court.update({ where: { id: court.id }, data: { active: false } });
            await simulateTypingAndSend(jid, `${court.name} disattivato.`);
            continue;
        }

        if (command === 'CHANGE_CLUB_HOURS') {
            const newOpen = params.openTime ?? club.openTime ?? '08:00';
            const newClose = params.closeTime ?? club.closeTime ?? '23:30';
            await prisma.club.update({ where: { id: club.id }, data: { openTime: newOpen, closeTime: newClose } });
            await simulateTypingAndSend(jid, `Orari aggiornati: ${newOpen}–${newClose}.`);
            continue;
        }

        logger.warn({ command, params }, 'executeAdminSteps: unhandled command');
    }
}
