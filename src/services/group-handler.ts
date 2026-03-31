/**
 * GROUP HANDLER
 *
 * ✅ FIX CRITICITÀ A (Multi-Tenancy):
 * Il clubId viene ora risolto dal groupJid tramite Court.groupJid o
 * da una mappatura JID→Club nel DB, invece di prisma.club.findFirst().
 * Ogni operazione DB filtra sempre per clubId esplicito.
 */

import { prisma } from './db';
import { importPlayersFromGroup } from './onboarding-flow';
import { getSock } from './whatsapp';
import pino from 'pino';

const logger = pino({ level: 'info' });

// ─────────────────────────────────────────────
// RISOLVI CLUB DA GROUP JID
// Cerca il Club che ha questo groupJid registrato.
// Fallback: se c'è un solo club nel DB usa quello (single-tenant safe).
// ─────────────────────────────────────────────

async function resolveClubFromGroupJid(groupJid: string): Promise<{ id: string; name: string; adminPhone: string | null } | null> {
    // Prima: cerca club che ha questo gruppo registrato
    const club = await prisma.club.findFirst({
        where: { groupJids: { has: groupJid } },
        select: { id: true, name: true, adminPhone: true },
    });
    if (club) return club;

    // Fallback sicuro: se c'è esattamente 1 club usa quello (modalità single-tenant)
    const count = await prisma.club.count();
    if (count === 1) {
        return prisma.club.findFirst({ select: { id: true, name: true, adminPhone: true } });
    }

    // Multi-tenant senza mappatura: non possiamo procedere in sicurezza
    logger.warn({ groupJid }, 'Cannot resolve club from groupJid — multi-tenant with no mapping');
    return null;
}

export async function handleGroupParticipantUpdate(update: {
    id: string;
    participants: string[];
    action: 'add' | 'remove' | 'promote' | 'demote';
}) {
    const { id: groupJid, participants, action } = update;
    const botPhone = process.env.BOT_PHONE_NUMBER?.replace('+', '');

    // ✅ FIX: risolvi club dal JID del gruppo, non con findFirst() generico
    const club = await resolveClubFromGroupJid(groupJid);
    if (!club) {
        logger.warn({ groupJid }, 'No club configured for this group, skipping');
        return;
    }

    const config = {
        clubId: club.id,  // ✅ clubId esplicito propagato a tutti i sotto-handler
        botName: club.name,
        welcomeMessage: undefined,
        askAvailability: false,
        askTimePreference: false,
        maxDailyMessages: 2,
        notifyAdminOnNewPlayer: !!club.adminPhone,
    };

    const botWasAdded = action === 'add' && participants.some(p => p.includes(botPhone || ''));

    if (botWasAdded) {
        logger.info({ groupJid, clubId: club.id }, 'Bot added to group — starting mass import');
        const sock = getSock();
        if (!sock) return;

        try {
            const meta = await sock.groupMetadata(groupJid);
            await importPlayersFromGroup(groupJid, meta.subject, config);
        } catch (err) {
            logger.error({ err }, `Failed to import from group ${groupJid}`);
        }
        return;
    }

    if (action === 'add') {
        const sock = getSock();
        if (!sock) return;

        try {
            const meta = await sock.groupMetadata(groupJid);
            const skillLevel = guessSkillLevelFromGroupName(meta.subject);

            for (const participantJid of participants) {
                const phone = participantJid.split('@')[0];
                if (phone === botPhone) continue;

                // ✅ FIX: query filtrata per clubId
                const existing = await prisma.player.findFirst({
                    where: { phoneNumber: phone, clubId: club.id },
                });

                if (existing) {
                    if (!existing.groupIds.includes(groupJid)) {
                        await prisma.player.update({
                            where: { id: existing.id },
                            data: { groupIds: { push: groupJid } },
                        });
                    }
                    continue;
                }

                // ✅ FIX: nuovo giocatore sempre associato al clubId corretto
                await prisma.player.create({
                    data: {
                        phoneNumber: phone,
                        clubId: club.id,
                        skillLevel: skillLevel as any,
                        groupIds: [groupJid],
                        active: true,
                    },
                });

                logger.info({ phone, skillLevel, clubId: club.id }, 'New player auto-imported from group');

                if (club.adminPhone) {
                    const { sendMessage } = await import('./whatsapp');
                    await sendMessage(
                        club.adminPhone,
                        `[POLPO BOT] 👤 Nuovo membro aggiunto al gruppo "${meta.subject}"\nTelefono: ${phone}\nLivello rilevato: ${skillLevel}`
                    );
                }
            }
        } catch (err) {
            logger.error({ err }, 'Failed to handle new group member');
        }
    }

    if (action === 'remove' && participants.some(p => p.includes(botPhone || ''))) {
        logger.warn({ groupJid, clubId: club.id }, 'Bot was removed from group');
    }
}

function guessSkillLevelFromGroupName(name: string): 'BEGINNER' | 'INTERMEDIATE' | 'ADVANCED' {
    const lower = name.toLowerCase();
    const beginnerKw = ['principiante', 'principianti', 'beginner', 'base', 'livello 1', 'lv1'];
    const advancedKw = ['avanzato', 'avanzati', 'advanced', 'agonistico', 'pro', 'livello 3', 'lv3'];
    if (beginnerKw.some(kw => lower.includes(kw))) return 'BEGINNER';
    if (advancedKw.some(kw => lower.includes(kw))) return 'ADVANCED';
    return 'INTERMEDIATE';
}
