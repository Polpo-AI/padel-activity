/**
 * NOTIFY ADMIN
 *
 * ✅ FIX M (Multi-Tenancy):
 *    notifyAdmin ora riceve adminPhone e clubName direttamente — zero query DB.
 *    I chiamanti (recovery, queue, worker) conoscono già il club dal contesto.
 *
 *    Per i chiamanti che non hanno il club a portata (es. queue.ts generici)
 *    esiste notifyAdminByClubId che fa una query mirata per clubId.
 *
 * Rate limiting: max 1 notifica per tipo di errore ogni 5 minuti.
 */

import pino from 'pino';
import { sendMessage } from '../services/whatsapp';
const logger = pino({ level: 'info' });

const notificationCooldowns = new Map<string, number>();
const COOLDOWN_MS = 5 * 60 * 1000;

// ─────────────────────────────────────────────
// NOTIFY DIRETTO — zero query DB
// ─────────────────────────────────────────────

export async function notifyAdmin(
    message: string,
    key: string = 'generic',
    adminPhone?: string,
    clubName?: string
): Promise<boolean> {
    const lastSent = notificationCooldowns.get(key) || 0;
    if (Date.now() - lastSent < COOLDOWN_MS) {
        logger.debug({ key }, 'Admin notification suppressed (cooldown)');
        return false;
    }

    let phone = adminPhone;
    let name = clubName;

    if (!phone) {
        try {
            const { prisma } = await import('../services/db');
            const count = await prisma.club.count();
            if (count === 1) {
                // ✅ FIX M: findFirst solo se c'è un solo club (single-tenant garantito)
                const club = await prisma.club.findFirst({ select: { adminPhone: true, name: true } });
                phone = club?.adminPhone ?? undefined;
                name = club?.name ?? undefined;
            } else {
                logger.warn({ key }, 'notifyAdmin called without adminPhone in multi-tenant mode');
                return false;
            }
        } catch (err) {
            logger.error({ err }, 'Failed to resolve admin phone');
            return false;
        }
    }

    if (!phone) {
        // Fallback (Punto 8): nessun numero admin configurato → manda nella chat del bot
        // con se stesso, così il segretario che gestisce il numero riceve comunque l'avviso.
        try {
            const { getBotJid, sendMessage: send } = await import('../services/whatsapp');
            const selfJid = await getBotJid();
            if (selfJid) {
                await send(selfJid, `🔔 *${name ?? 'Padel Bot'} — Admin*\n\n${message}`);
                notificationCooldowns.set(key, Date.now());
                logger.info({ key }, 'Admin notification sent to self-chat (no adminPhone)');
                return true;
            }
        } catch (err) {
            logger.warn({ err }, 'Self-chat admin notification fallback failed');
        }
        logger.warn('No admin phone configured and no self-chat available');
        return false;
    }

    try {
        const adminJid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
        await sendMessage(adminJid, `🚨 *${name ?? 'Padel Bot'} — Alert*\n\n${message}`);
        notificationCooldowns.set(key, Date.now());
        logger.info({ key }, 'Admin notification sent');
        return true;
    } catch (err) {
        logger.error({ err }, 'Failed to send admin notification');
        return false;
    }
}

// ─────────────────────────────────────────────
// NOTIFY PER CLUBID — query singola mirata
// ─────────────────────────────────────────────

export async function notifyAdminByClubId(
    message: string,
    key: string,
    clubId: string
): Promise<void> {
    try {
        const { prisma } = await import('../services/db');
        const club = await prisma.club.findUnique({
            where: { id: clubId },
            select: { adminPhone: true, name: true },
        });
        // In contesto del club: se manca adminPhone, notifyAdmin ripiega sulla self-chat (Punto 8).
        const { runWithContext } = await import('../utils/request-context');
        await runWithContext({ clubId } as any, async () => {
            await notifyAdmin(message, key, club?.adminPhone ?? undefined, club?.name ?? undefined);
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
    await notifyAdmin(message, 'critical', adminPhone, clubName);
}
