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
): Promise<void> {
    const lastSent = notificationCooldowns.get(key) || 0;
    if (Date.now() - lastSent < COOLDOWN_MS) {
        logger.debug({ key }, 'Admin notification suppressed (cooldown)');
        return;
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
                return;
            }
        } catch (err) {
            logger.error({ err }, 'Failed to resolve admin phone');
            return;
        }
    }

    if (!phone) {
        logger.warn('No admin phone configured');
        return;
    }

    try {
        const { sendMessage, getConnectionStatus } = await import('../services/whatsapp');
        
        if (getConnectionStatus() !== 'open') {
            logger.warn({ key }, 'Cannot send admin notification: WhatsApp not connected');
            return;
        }

        const adminJid = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
        await sendMessage(adminJid, `🚨 *${name ?? 'Padel Bot'} — Alert*\n\n${message}`);
        notificationCooldowns.set(key, Date.now());
        logger.info({ key }, 'Admin notification sent');
    } catch (err) {
        logger.error({ err }, 'Failed to send admin notification');
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
        if (!club?.adminPhone) return;
        await notifyAdmin(message, key, club.adminPhone, club.name);
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
