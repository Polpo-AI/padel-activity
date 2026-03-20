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
import { simulateTypingAndSend } from './whatsapp';
import { waveQueue } from './queue';
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
