/**
 * MATCH NOTIFICATIONS
 *
 * Servizio unificato per notificare i giocatori di qualsiasi intervento
 * manuale su una partita (cancellazione, spostamento, campo disattivato, orari modificati).
 *
 * Logica:
 * - Match con 1 solo giocatore confermato (prenotazione singola): redirect solo a lui
 * - Match con 2+ giocatori confermati (matchmaking parziale o completo):
 *   redirect/notifica a tutti i confermati, se esiste un gruppo WA notifica anche quello
 * - Le invitation PENDING vengono sempre annullate (IGNORED)
 * - Se il match è OPEN dopo un reschedule, rilancia la wave (nuovo orario)
 */

import { prisma } from './db';
import { simulateTypingAndSend } from './whatsapp';
import { redirectGroup } from './redirect';
import pino from 'pino';

const logger = pino({ level: 'info' });

function fmtTime(d: Date): string {
    return d.toLocaleString('it-IT', {
        timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric',
        month: 'long', hour: '2-digit', minute: '2-digit',
    });
}

// ─────────────────────────────────────────────
// CANCELLAZIONE
// ─────────────────────────────────────────────

export async function notifyMatchCancelled(matchId: string, clubId: string): Promise<void> {
    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: { where: { leftAt: null }, include: { player: true } } },
    });
    if (!match) return;

    // Annulla subito tutti gli inviti PENDING
    await prisma.invitation.updateMany({
        where: { matchId, status: 'PENDING' },
        data: { status: 'IGNORED' },
    });

    const confirmed = match.MatchPlayer;

    // Aggiorna leftAt su tutti i MatchPlayer per coerenza dati
    if (confirmed.length > 0) {
        await prisma.matchPlayer.updateMany({
            where: { matchId, leftAt: null },
            data: { leftAt: new Date() },
        });
    }

    if (confirmed.length === 0) return;

    // Se esiste un gruppo WA (match LOCKED) notifica anche lì
    if (match.groupId && confirmed.length > 1) {
        await simulateTypingAndSend(
            match.groupId,
            `Purtroppo la partita del ${fmtTime(match.startTime)} è stata annullata dal circolo. Stiamo cercando alternative per tutti!`,
        ).catch(() => {});
    }

    // redirectGroup: al solo prenotante se 1 confermato, a tutti se matchmaking (2+)
    await redirectGroup({
        clubId,
        referentPhone: confirmed[0].player.phoneNumber,
        referentJid: confirmed[0].player.phoneNumber,
        playerPhones: confirmed.map(mp => mp.player.phoneNumber),
        playerCount: confirmed.length,
        originalMatchId: matchId,
        originalStartTime: match.startTime,
        originalSkillLevel: match.skillLevel ?? 0,
        reason: 'CANCELLED',
    });
}

// ─────────────────────────────────────────────
// SPOSTAMENTO ORARIO
// ─────────────────────────────────────────────

export async function notifyMatchRescheduled(
    matchId: string,
    oldStartTime: Date,
    newStartTime: Date,
    clubId: string,
): Promise<void> {
    const match = await prisma.match.findUnique({
        where: { id: matchId },
        include: { MatchPlayer: { where: { leftAt: null }, include: { player: true } } },
    });
    if (!match) return;

    const confirmed = match.MatchPlayer;
    if (confirmed.length === 0) return;

    const msg = `La tua partita è stata spostata al ${fmtTime(newStartTime)} (era il ${fmtTime(oldStartTime)}). Ci vediamo lì!`;

    // Notifica il gruppo WA se esiste
    if (match.groupId) {
        await simulateTypingAndSend(match.groupId, msg).catch(() => {});
    }

    // Notifica individuale a ogni giocatore confermato
    for (const mp of confirmed) {
        const jid = `${mp.player.phoneNumber}@s.whatsapp.net`;
        if (jid === match.groupId) continue; // non duplicare se coincide
        await simulateTypingAndSend(jid, msg).catch(err => {
            logger.error({ err, playerId: mp.player.id }, 'Failed to notify player of reschedule');
        });
    }

    // Annulla inviti PENDING (orario cambiato, non più validi)
    await prisma.invitation.updateMany({
        where: { matchId, status: 'PENDING' },
        data: { status: 'IGNORED' },
    });

    // Se il match è ancora OPEN e ci sono posti liberi, rilancia wave con nuovo orario
    if (match.status === 'OPEN' && confirmed.length < match.playersNeeded) {
        const firstSkill = confirmed[0]?.player?.skillLevel ?? 0;
        if (firstSkill > 0) {
            const { waveQueue } = await import('./queue');
            await waveQueue.add('process-wave', {
                matchId,
                waveNumber: 1,
                scheduledAt: Date.now() + 30000,
            }, { delay: 30000 }).catch(() => {});
        }
    }
}

// ─────────────────────────────────────────────
// QUERY DI IMPATTO (per conferma prima dell'azione)
// ─────────────────────────────────────────────

/** Partite future OPEN/LOCKED su un campo specifico. */
export async function findMatchesOnCourt(courtId: string): Promise<any[]> {
    return prisma.match.findMany({
        where: { courtId, status: { in: ['OPEN', 'LOCKED'] }, startTime: { gte: new Date() } },
        include: { MatchPlayer: { where: { leftAt: null }, include: { player: true } } },
        orderBy: { startTime: 'asc' },
    });
}

/** Partite future che cadono fuori dai nuovi orari di apertura del club. */
export async function findMatchesOutsideHours(
    clubId: string,
    newOpenTime: string,
    newCloseTime: string,
): Promise<any[]> {
    const matches = await prisma.match.findMany({
        where: { clubId, status: { in: ['OPEN', 'LOCKED'] }, startTime: { gte: new Date() } },
        include: { MatchPlayer: { where: { leftAt: null }, include: { player: true } } },
        orderBy: { startTime: 'asc' },
    });

    const [openH, openM] = newOpenTime.split(':').map(Number);
    const [closeH, closeM] = newCloseTime.split(':').map(Number);
    const openMins = openH * 60 + openM;
    const closeMins = closeH * 60 + closeM;

    return matches.filter(m => {
        const inRome = m.startTime.toLocaleString('en-US', {
            timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false,
        });
        const [h, min] = inRome.split(':').map(Number);
        const totalMins = h * 60 + min;
        return totalMins < openMins || totalMins >= closeMins;
    });
}

/** Cancella in batch una lista di match e notifica i giocatori. */
export async function cancelMatchesWithNotification(
    matchIds: string[],
    clubId: string,
    reason: string,
): Promise<number> {
    let notified = 0;
    for (const matchId of matchIds) {
        try {
            await prisma.match.update({
                where: { id: matchId },
                data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: reason },
            });
            await notifyMatchCancelled(matchId, clubId);
            notified++;
        } catch (err) {
            logger.error({ err, matchId }, 'Failed to cancel+notify match');
        }
    }
    return notified;
}
