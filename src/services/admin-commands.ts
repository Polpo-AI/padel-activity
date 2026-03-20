/**
 * ADMIN COMMANDS
 *
 * Parsing e esecuzione di comandi DB via WhatsApp da parte dell'admin del circolo.
 * Scoped esclusivamente al club dell'admin.
 * Operazioni supportate: lista partite, lista giocatori, cancella partita,
 * modifica orario partita, modifica livello giocatore, rimuovi giocatore.
 */

import { prisma } from './db';
import { anthropic } from './ai';
import { simulateTypingAndSend, sendMessage } from './whatsapp';
import { waveQueue, getRedis } from './queue';
import pino from 'pino';

const logger = pino({ level: 'info' });

// Parole chiave che identificano un comando admin DB (non conversazione normale)
const ADMIN_COMMAND_KEYWORDS = [
    'cerca giocatori', 'lista giocatori', 'mostra giocatori', 'elenco giocatori',
    'mostra partite', 'lista partite', 'partite di', 'partite del', 'elenco partite',
    'cancella la partita', 'annulla la partita', 'elimina la partita',
    'modifica orario', 'cambia orario', 'sposta la partita', 'sposta partita',
    'elimina il giocatore', 'cancella il giocatore', 'rimuovi il giocatore', 'elimina giocatore',
    'cambia livello', 'modifica il livello', 'modifica livello', 'livello di',
];

// ─────────────────────────────────────────────
// FAQ FLOW (intelligente, senza formato hardcoded)
// ─────────────────────────────────────────────

/**
 * Gestisce il flusso FAQ lato admin via ragionamento AI.
 * Ritorna true se il messaggio è stato gestito dal flusso FAQ (e il caller deve fare return),
 * false se il messaggio deve proseguire nel flusso normale.
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

        // Non è un sì/no: potrebbe essere una risposta aggiornata → ri-classifica come nuova risposta
        await redis.del(`faq:awaiting_save_confirm:${clubId}`);
        // cade nel check pending_question qui sotto
    }

    // ── Stato 2: c'è una domanda pending → classifica se il messaggio è una risposta
    const pendingRaw = await redis.get(`faq:pending_question:${clubId}`);
    if (!pendingRaw) return false;

    const { question, askedBy } = JSON.parse(pendingRaw);

    const classification = await classifyAdminFaqResponse(question, text);

    if (!classification.isFaqAnswer) {
        // Non sembra una risposta alla domanda → lascia passare al flusso normale
        return false;
    }

    if (classification.isFaqAnswer && classification.confidence === 'high' && classification.faqWorthy) {
        // Alta confidenza: salva direttamente
        await prisma.faq.create({ data: { clubId, question, answer: text.trim(), askedBy: askedBy || null } });
        await redis.del(`faq:pending_question:${clubId}`);
        await sendMessage(jid, `Ho salvato la risposta come FAQ. Gli utenti la riceveranno direttamente la prossima volta che chiedono qualcosa di simile.`);
        return true;
    }

    // Bassa confidenza o risposta non abbastanza completa per essere FAQ: chiedi conferma
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
- faqWorthy: true se la risposta è sufficientemente completa e utile da salvare per utenti futuri

Esempi:
- Domanda "Quali sono gli orari?" / Risposta "Siamo aperti dalle 8 alle 23" → isFaqAnswer:true, confidence:high, faqWorthy:true
- Domanda "Ci sono tornei?" / Risposta "sì" → isFaqAnswer:true, confidence:high, faqWorthy:false
- Domanda "Quanto costa il campo?" / Risposta "ma di cosa parla?" → isFaqAnswer:false, confidence:high, faqWorthy:false`;

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
            if (start !== -1 && end !== -1) {
                return JSON.parse(raw.substring(start, end + 1));
            }
        }
    } catch (err) {
        logger.error({ err }, 'classifyAdminFaqResponse failed');
    }

    // Fallback conservativo: non intercettare
    return { isFaqAnswer: false, confidence: 'low', faqWorthy: false };
}

export function looksLikeAdminCommand(text: string): boolean {
    const lower = text.toLowerCase();
    return ADMIN_COMMAND_KEYWORDS.some(kw => lower.includes(kw));
}

export async function handleAdminCommand(text: string, club: any, jid: string): Promise<void> {
    const now = new Date().toLocaleString('it-IT', {
        timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric',
        month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });

    const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [upcomingMatches, allPlayers] = await Promise.all([
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
            take: 20,
        }),
        prisma.player.findMany({
            where: { clubId: club.id, active: true },
            select: { id: true, name: true, phoneNumber: true, skillLevel: true },
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
            return `ID:${m.id} | ${m.court?.name || 'Campo'} | ${fmtTime(m.startTime)} | ${m.status} | Giocatori: ${players || 'nessuno'}`;
        }).join('\n')
        : 'Nessuna partita nei prossimi 7 giorni';

    const playersStr = allPlayers.length > 0
        ? allPlayers.map(p => `ID:${p.id} | ${p.name || 'N/A'} | Tel:${p.phoneNumber} | Livello:${p.skillLevel}`).join('\n')
        : 'Nessun giocatore';

    const prompt = `Sei il parser di comandi per un admin di circolo padel.
L'admin ha scritto: "${text}"

Partite disponibili (prossimi 7 giorni):
${matchesStr}

Giocatori del circolo:
${playersStr}

Data e ora attuali: ${now}

Restituisci SOLO un JSON valido con questa struttura:
{
  "command": "LIST_MATCHES" | "LIST_PLAYERS" | "CANCEL_MATCH" | "RESCHEDULE_MATCH" | "UPDATE_PLAYER_SKILL" | "DELETE_PLAYER" | "UNKNOWN",
  "params": {}
}

Comandi e parametri:
- LIST_MATCHES: params: { "dateFrom": "YYYY-MM-DD"?, "dateTo": "YYYY-MM-DD"?, "courtName": "string"? }
- LIST_PLAYERS: params: { "skillMin": number?, "skillMax": number?, "nameQuery": "string"? }
- CANCEL_MATCH: params: { "matchId": "id dalla lista partite" }
- RESCHEDULE_MATCH: params: { "matchId": "...", "newDay": "YYYY-MM-DD", "newTime": "HH:MM" }
- UPDATE_PLAYER_SKILL: params: { "playerId": "id dalla lista giocatori", "newSkill": number }
- DELETE_PLAYER: params: { "playerId": "id dalla lista giocatori" }
- UNKNOWN: params: {}

Restituisci SOLO il JSON, niente altro.`;

    let parsed: { command: string; params: any } = { command: 'UNKNOWN', params: {} };

    try {
        const resp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 300,
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
        return;
    }

    await executeAdminCommand(parsed.command, parsed.params, club, jid, upcomingMatches, allPlayers);
}

async function executeAdminCommand(
    command: string,
    params: any,
    club: any,
    jid: string,
    upcomingMatches: any[],
    allPlayers: any[],
): Promise<void> {
    const fmtTimeLong = (d: Date) => d.toLocaleString('it-IT', {
        timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric',
        month: 'long', hour: '2-digit', minute: '2-digit',
    });

    if (command === 'LIST_MATCHES') {
        let filtered = [...upcomingMatches];
        if (params.courtName) {
            const cn = params.courtName.toLowerCase();
            filtered = filtered.filter(m => m.court?.name?.toLowerCase().includes(cn));
        }
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
            return;
        }

        const lines = filtered.map(m => {
            const players = m.MatchPlayer.map((mp: any) => mp.player.name || mp.player.phoneNumber).join(', ');
            const status = m.status === 'LOCKED' ? 'completa' : `aperta (${m.MatchPlayer.length}/4)`;
            return `${fmtTimeLong(m.startTime)}\n${m.court?.name || 'Campo'} (${status})\nGiocatori: ${players || 'nessuno'}`;
        });
        await simulateTypingAndSend(jid, `Partite trovate: ${filtered.length}\n\n${lines.join('\n\n')}`);
        return;
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
            return;
        }

        const lines = filtered.map((p: any) =>
            `${p.name || 'N/A'} (livello ${p.skillLevel > 0 ? p.skillLevel : 'da assegnare'}) — ${p.phoneNumber}`,
        );
        await simulateTypingAndSend(jid, `Giocatori trovati: ${filtered.length}\n\n${lines.join('\n')}`);
        return;
    }

    if (command === 'CANCEL_MATCH') {
        const match = upcomingMatches.find(m => m.id === params.matchId);
        if (!match) {
            await simulateTypingAndSend(jid, 'Partita non trovata. Prova a chiedere prima "mostra partite" per vedere gli ID disponibili.');
            return;
        }

        await prisma.match.update({
            where: { id: match.id },
            data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: 'Cancellazione admin' },
        });
        await prisma.invitation.updateMany({
            where: { matchId: match.id, status: 'PENDING' },
            data: { status: 'IGNORED' },
        });

        const timeStr = fmtTimeLong(match.startTime);
        const players = match.MatchPlayer;
        const { simulateTypingAndSend: sendWA } = await import('./whatsapp');
        let notified = 0;
        for (const mp of players) {
            try {
                await sendWA(
                    `${mp.player.phoneNumber}@s.whatsapp.net`,
                    `La partita di ${timeStr} sul ${match.court?.name || 'campo'} è stata annullata. Ci scusiamo per l'inconveniente!`,
                );
                notified++;
            } catch (err) {
                logger.error({ err, playerId: mp.player.id }, 'Failed to notify player of cancellation');
            }
        }

        await simulateTypingAndSend(jid, `Partita del ${timeStr} annullata. Ho notificato ${notified} giocatori.`);
        return;
    }

    if (command === 'RESCHEDULE_MATCH') {
        const match = upcomingMatches.find(m => m.id === params.matchId);
        if (!match) {
            await simulateTypingAndSend(jid, 'Partita non trovata. Prova a chiedere prima "mostra partite" per vedere gli ID disponibili.');
            return;
        }
        if (!params.newDay || !params.newTime) {
            await simulateTypingAndSend(jid, 'Specifica il nuovo giorno (YYYY-MM-DD) e orario (HH:MM) per spostare la partita.');
            return;
        }

        const [y, mo, d] = params.newDay.split('-').map(Number);
        const [h, m] = params.newTime.split(':').map(Number);
        if (isNaN(y) || isNaN(h)) {
            await simulateTypingAndSend(jid, 'Formato data/ora non valido. Usa YYYY-MM-DD e HH:MM.');
            return;
        }

        // Conversione UTC rispettando il fuso Europe/Rome
        const noon = new Date(Date.UTC(y, mo - 1, d, 12, 0));
        const noonRomeHour = Number(noon.toLocaleString('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }));
        const offsetH = noonRomeHour - 12;
        let utcH = h - offsetH;
        let dayOffset = 0;
        if (utcH < 0) { utcH += 24; dayOffset = -1; }
        if (utcH >= 24) { utcH -= 24; dayOffset = 1; }
        const newStartTime = new Date(Date.UTC(y, mo - 1, d + dayOffset, utcH, m, 0));

        const oldTimeStr = fmtTimeLong(match.startTime);
        const newTimeStr = fmtTimeLong(newStartTime);

        await prisma.match.update({ where: { id: match.id }, data: { startTime: newStartTime } });

        const { simulateTypingAndSend: sendWA } = await import('./whatsapp');
        let notified = 0;
        for (const mp of match.MatchPlayer) {
            try {
                await sendWA(
                    `${mp.player.phoneNumber}@s.whatsapp.net`,
                    `La tua partita è stata spostata! Nuovo orario: ${newTimeStr} (prima era: ${oldTimeStr}). Ci vediamo lì!`,
                );
                notified++;
            } catch (err) {
                logger.error({ err, playerId: mp.player.id }, 'Failed to notify player of reschedule');
            }
        }

        await simulateTypingAndSend(jid, `Partita spostata da ${oldTimeStr} a ${newTimeStr}. Ho notificato ${notified} giocatori.`);
        return;
    }

    if (command === 'UPDATE_PLAYER_SKILL') {
        const player = allPlayers.find((p: any) => p.id === params.playerId);
        if (!player) {
            await simulateTypingAndSend(jid, 'Giocatore non trovato. Prova "lista giocatori" per vedere gli ID disponibili.');
            return;
        }
        const newSkill = Number(params.newSkill);
        if (isNaN(newSkill) || newSkill < 1 || newSkill > 7) {
            await simulateTypingAndSend(jid, 'Il livello deve essere un numero tra 1.0 e 7.0.');
            return;
        }
        await prisma.player.update({ where: { id: player.id }, data: { skillLevel: newSkill } });
        await simulateTypingAndSend(jid, `Livello di ${player.name || player.phoneNumber} aggiornato a ${newSkill}.`);
        return;
    }

    if (command === 'DELETE_PLAYER') {
        const player = allPlayers.find((p: any) => p.id === params.playerId);
        if (!player) {
            await simulateTypingAndSend(jid, 'Giocatore non trovato. Prova "lista giocatori" per vedere gli ID disponibili.');
            return;
        }
        // Soft delete: imposta active=false per preservare lo storico partite
        await prisma.player.update({ where: { id: player.id }, data: { active: false } });
        await simulateTypingAndSend(jid, `${player.name || player.phoneNumber} rimosso dal circolo. Non riceverà più messaggi né inviti.`);
        return;
    }

    await simulateTypingAndSend(
        jid,
        'Non ho capito il comando. Puoi usare: "mostra partite di domani", "cancella la partita di venerdì", "modifica livello di Mario Rossi a 4.5", "lista giocatori livello 3-5", "elimina giocatore".',
    );
}
