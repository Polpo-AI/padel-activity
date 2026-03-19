/**
 * SETUP API — Club Onboarding
 *
 * Endpoint unico protetto da SETUP_SECRET per creare un nuovo circolo.
 * Chiamato dalla pagina /setup (setup.html).
 *
 * Auth: Authorization: Bearer <SETUP_SECRET>
 * POST /api/setup/club
 */

import express from 'express';
import bcrypt from 'bcrypt';
import { prisma } from '../services/db';
import pino from 'pino';

const logger = pino({ level: 'info' });
const router = express.Router();

// ─────────────────────────────────────────────
// AUTH MIDDLEWARE — Bearer token da env SETUP_SECRET
// ─────────────────────────────────────────────

function requireSetupSecret(req: express.Request, res: express.Response, next: express.NextFunction) {
    const secret = process.env.SETUP_SECRET;
    if (!secret) {
        logger.warn('SETUP_SECRET not configured — setup endpoint disabled');
        return res.status(503).json({ error: 'Setup endpoint not configured on this server' });
    }
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token || token !== secret) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

// ─────────────────────────────────────────────
// POST /api/setup/club
// ─────────────────────────────────────────────

router.post('/club', requireSetupSecret, async (req, res) => {
    try {
        const {
            name,
            adminPhone,
            adminAlternativePhone,
            timezone,
            openTime,
            closeTime,
            matchDuration,
            courts,            // { name: string, covered: boolean }[]
            skillLevelCount,
            allowMixedLevels,
            allowMixedGenderMatchmaking,
            mixedLevelRange,
            matchUpperRange,
            matchLowerRange,
            deadlineMinutesBeforeMatch,
            skillTestDuration,
            skillTestCost,
            waveMultiplier,
            maxDailyMessages,
            aiTone,
            city,
            address,
            dashboardUsername,
            dashboardPassword,
        } = req.body;

        // ── Validazione minima ──────────────────
        if (!name || typeof name !== 'string' || name.trim().length < 2) {
            return res.status(400).json({ error: 'Nome circolo obbligatorio (min 2 caratteri)' });
        }
        if (!dashboardUsername || !dashboardPassword) {
            return res.status(400).json({ error: 'Username e password dashboard obbligatori' });
        }
        if (typeof dashboardPassword !== 'string' || dashboardPassword.length < 8) {
            return res.status(400).json({ error: 'Password dashboard minimo 8 caratteri' });
        }
        if (!Array.isArray(courts) || courts.length === 0) {
            return res.status(400).json({ error: 'Almeno un campo è obbligatorio' });
        }

        // ── Verifica unicità username ──────────
        const existing = await prisma.club.findFirst({ where: { dashboardUsername } });
        if (existing) {
            return res.status(409).json({ error: 'Username dashboard già in uso' });
        }

        const dashboardPasswordHash = await bcrypt.hash(String(dashboardPassword), 10);

        // courts arriva come { name: string, covered: boolean }[]
        const courtsData = (courts as { name: string; covered?: boolean }[]).map((c, idx) => ({
            name: (c.name ?? '').trim() || `Campo ${idx + 1}`,
            isCovered: Boolean(c.covered),
        }));

        const club = await prisma.club.create({
            data: {
                name: name.trim(),
                adminPhone: adminPhone ?? null,
                adminAlternativePhone: adminAlternativePhone || null,
                timezone: timezone || 'Europe/Rome',
                openTime: openTime || '08:00',
                closeTime: closeTime || '23:30',
                matchDuration: Number(matchDuration) || 90,
                skillLevelCount: Number(skillLevelCount) || 3,
                allowMixedLevels: Boolean(allowMixedLevels),
                allowMixedGenderMatchmaking: Boolean(allowMixedGenderMatchmaking),
                mixedLevelRange: Number(mixedLevelRange) || 1,
                matchUpperRange: Number(matchUpperRange) || 1.0,
                matchLowerRange: Number(matchLowerRange) || 1.0,
                deadlineMinutesBeforeMatch: Number(deadlineMinutesBeforeMatch) || 60,
                skillTestDuration: Number(skillTestDuration) || 60,
                skillTestCost: Number(skillTestCost) || 0,
                waveMultiplier: Number(waveMultiplier) || 3,
                maxDailyMessages: Number(maxDailyMessages) || 2,
                aiTone: aiTone || null,
                city: city || null,
                address: address || null,
                dashboardUsername: String(dashboardUsername).trim(),
                dashboardPasswordHash,
                courts: { create: courtsData },
            },
            include: { courts: true },
        });

        logger.info({ clubId: club.id, name: club.name }, 'Club created via setup wizard');

        res.status(201).json({
            ok: true,
            clubId: club.id,
            name: club.name,
            courts: club.courts.map(c => ({ id: c.id, name: c.name })),
        });
    } catch (err: any) {
        logger.error({ err }, 'Error creating club via setup');
        res.status(500).json({ error: 'Errore durante la creazione del circolo' });
    }
});

export default router;
