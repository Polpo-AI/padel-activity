/**
 * NOTIFY ADMIN
 *
 * Doppio canale (Punto 8 esteso):
 *  1. Self-chat del telefono del circolo ("Messaggi a te stesso") — riceve SEMPRE
 *     tutte le notifiche. È il canale primario: chi gestisce il numero del bot
 *     vede tutto senza bisogno di un secondo telefono.
 *  2. Telefono admin (Club.adminPhone) — riceve SOLO le categorie abilitate in
 *     Club.adminNotifyCategories (configurabili da onboarding e dashboard).
 *
 * Categorie: system (errori critici), matches (partite a rischio/cancellate),
 * faq (domande in sospeso), players (iscrizioni, opt-out, genere, skill test).
 *
 * Rate limiting: max 1 notifica per tipo di errore ogni 5 minuti.
 */

import pino from 'pino';
import { sendMessage } from '../services/whatsapp';
const logger = pino({ level: 'info' });

export type AdminNotifyCategory = 'system' | 'matches' | 'faq' | 'players';

export const ADMIN_NOTIFY_CATEGORIES: AdminNotifyCategory[] = ['system', 'matches', 'faq', 'players'];

export const ADMIN_NOTIFY_CATEGORY_LABELS: Record<AdminNotifyCategory, string> = {
    system: 'Errori di sistema',
    matches: 'Partite a rischio o cancellate',
    faq: 'Domande in attesa di risposta',
    players: 'Giocatori (iscrizioni, opt-out, livelli)',
};

const notificationCooldowns = new Map<string, number>();
const COOLDOWN_MS = 5 * 60 * 1000;

// ─────────────────────────────────────────────
// NOTIFY — self-chat sempre + adminPhone se categoria abilitata
// ─────────────────────────────────────────────

export async function notifyAdmin(
    message: string,
    key: string = 'generic',
    adminPhone?: string,
    clubName?: string,
    category: AdminNotifyCategory = 'system'
): Promise<boolean> {
    const lastSent = notificationCooldowns.get(key) || 0;
    if (Date.now() - lastSent < COOLDOWN_MS) {
        logger.debug({ key }, 'Admin notification suppressed (cooldown)');
        return false;
    }

    let phone = adminPhone;
    let name = clubName;
    let categories: string[] | undefined;
    let clubId: string | undefined;

    // Risolvi il club: dal contesto multi-tenant se presente, altrimenti
    // single-tenant garantito (un solo club). Serve comunque una query per
    // le categorie abilitate, anche quando il chiamante passa adminPhone.
    try {
        const { prisma } = await import('../services/db');
        const { getClubId } = await import('../utils/request-context');
        clubId = getClubId();
        let club: { adminPhone: string | null; name: string | null; adminNotifyCategories: string[] } | null = null;
        if (clubId) {
            club = await prisma.club.findUnique({
                where: { id: clubId },
                select: { adminPhone: true, name: true, adminNotifyCategories: true },
            });
        } else {
            const count = await prisma.club.count();
            if (count === 1) {
                club = await prisma.club.findFirst({ select: { adminPhone: true, name: true, adminNotifyCategories: true } });
            } else if (!phone) {
                logger.warn({ key }, 'notifyAdmin called without club context in multi-tenant mode');
            }
        }
        if (club) {
            phone = phone ?? club.adminPhone ?? undefined;
            name = name ?? club.name ?? undefined;
            categories = club.adminNotifyCategories;
        }
    } catch (err) {
        logger.error({ err }, 'Failed to resolve club for admin notification');
    }

    let sentAny = false;

    // Canale 1 (sempre): self-chat del telefono del circolo.
    try {
        const { getBotJid, sendMessage: send } = await import('../services/whatsapp');
        const selfJid = await getBotJid(clubId);
        if (selfJid) {
            await send(selfJid, `🔔 *${name ?? 'Padel Bot'} — Admin*\n\n${message}`);
            sentAny = true;
            logger.info({ key, category }, 'Admin notification sent to self-chat');
        }
    } catch (err) {
        logger.warn({ err, key }, 'Self-chat admin notification failed');
    }

    // Canale 2 (filtrato): telefono admin, solo per le categorie abilitate.
    // Se le preferenze non sono risolvibili (club non trovato) si inoltra comunque:
    // meglio un avviso in più che un errore critico perso.
    const categoryEnabled = !categories || categories.includes(category);
    if (phone && categoryEnabled) {
        try {
            const adminJid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
            await sendMessage(adminJid, `🚨 *${name ?? 'Padel Bot'} — Alert*\n\n${message}`);
            sentAny = true;
            logger.info({ key, category }, 'Admin notification sent to adminPhone');
        } catch (err) {
            logger.error({ err, key }, 'Failed to send admin notification to adminPhone');
        }
    }

    if (sentAny) notificationCooldowns.set(key, Date.now());
    else logger.warn({ key }, 'Admin notification not delivered on any channel');
    return sentAny;
}

// ─────────────────────────────────────────────
// NOTIFY PER CLUBID — query singola mirata
// ─────────────────────────────────────────────

export async function notifyAdminByClubId(
    message: string,
    key: string,
    clubId: string,
    category: AdminNotifyCategory = 'system'
): Promise<void> {
    try {
        const { runWithContext } = await import('../utils/request-context');
        await runWithContext({ clubId } as any, async () => {
            await notifyAdmin(message, key, undefined, undefined, category);
        });
    } catch (err) {
        logger.error({ err, clubId }, 'notifyAdminByClubId failed');
    }
}

// ─────────────────────────────────────────────
// NOTIFY CRITICAL — bypassa cooldown
// ─────────────────────────────────────────────

export async function notifyAdminCritical(
    message: string,
    adminPhone?: string,
    clubName?: string
): Promise<void> {
    notificationCooldowns.clear();
    await notifyAdmin(message, 'critical', adminPhone, clubName, 'system');
}
