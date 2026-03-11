/**
 * DASHBOARD API
 *
 * Endpoint REST per la dashboard di controllo.
 * Auth: JWT semplice (no Supabase Auth — credenziali salvate su Club)
 *
 * Routes:
 * POST /dashboard/login              → restituisce JWT
 * GET  /dashboard/club               → dati circolo + campi
 * GET  /dashboard/courts             → lista campi con partite del giorno
 * GET  /dashboard/matches            → tutte le partite (con filtri)
 * POST /dashboard/matches            → crea nuova partita → parte wave
 * GET  /dashboard/matches/:id        → dettaglio partita
 * POST /dashboard/matches/:id/cancel → cancella partita
 * GET  /dashboard/players            → lista giocatori
 * POST /dashboard/players/toggle     → attiva/disattiva giocatore per telefono
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../services/db';
import { waveQueue } from '../services/queue';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import pino from 'pino';
import rateLimit from 'express-rate-limit';

const logger = pino({ level: 'info' });
const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'padel-dashboard-secret-change-in-production';

// ✅ FIX E (Sicurezza): rate-limit su /dashboard/login — max 10 tentativi / 15min per IP
const loginRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Troppi tentativi. Riprova tra 15 minuti.' },
});

// ─────────────────────────────────────────────
// MIDDLEWARE AUTH
// ─────────────────────────────────────────────

function authMiddleware(req: Request, res: Response, next: NextFunction) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token mancante' });

    try {
        const payload = jwt.verify(token, JWT_SECRET) as any;
        (req as any).clubId = payload.clubId;
        next();
    } catch {
        return res.status(401).json({ error: 'Token non valido' });
    }
}

// ─────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────

router.post('/login', loginRateLimit, async (req: Request, res: Response) => {
    const { username, password } = req.body;

    if (!username || !password) {
        return res.status(400).json({ error: 'Username e password richiesti' });
    }

    const club = await prisma.club.findUnique({ where: { dashboardUsername: username } });

    if (!club || !club.dashboardPasswordHash) {
        return res.status(401).json({ error: 'Credenziali non valide' });
    }

    const valid = await bcrypt.compare(password, club.dashboardPasswordHash);
    if (!valid) {
        return res.status(401).json({ error: 'Credenziali non valide' });
    }

    const token = jwt.sign({ clubId: club.id, clubName: club.name }, JWT_SECRET, { expiresIn: '24h' });

    res.json({
        token,
        club: {
            id: club.id,
            name: club.name,
            skillLevelCount: club.skillLevelCount,
            allowMixedLevels: club.allowMixedLevels,
            openTime: club.openTime,
            closeTime: club.closeTime,
            matchDuration: club.matchDuration,
        },
    });
});

// ─────────────────────────────────────────────
// CLUB INFO
// ─────────────────────────────────────────────

router.get('/club', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId;
    const club = await prisma.club.findUnique({
        where: { id: clubId },
        include: { courts: { where: { active: true } } },
    });
    res.json(club);
});

// ─────────────────────────────────────────────
// CAMPI CON STATO REAL-TIME
// ─────────────────────────────────────────────

router.get('/courts', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId;
    const { date } = req.query;

    const targetDate = date ? new Date(date as string) : new Date();
    const dayStart = new Date(targetDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(targetDate);
    dayEnd.setHours(23, 59, 59, 999);

    const courts = await prisma.court.findMany({
        where: { clubId, active: true },
        include: {
            matches: {
                where: { startTime: { gte: dayStart, lte: dayEnd } },
                include: {
                    MatchPlayer: { include: { player: true } },
                    invitations: {
                        where: { status: 'PENDING' },
                        include: { player: true },
                    },
                },
                orderBy: { startTime: 'asc' },
            },
        },
        orderBy: { name: 'asc' },
    });

    res.json(courts);
});

// ─────────────────────────────────────────────
// PARTITE
// ─────────────────────────────────────────────

router.get('/matches', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId;
    const { status, date, courtId } = req.query;

    const where: any = { clubId };
    if (status) where.status = status;
    if (courtId) where.courtId = courtId;
    if (date) {
        const d = new Date(date as string);
        const dayStart = new Date(d); dayStart.setHours(0, 0, 0, 0);
        const dayEnd = new Date(d); dayEnd.setHours(23, 59, 59, 999);
        where.startTime = { gte: dayStart, lte: dayEnd };
    }

    const matches = await prisma.match.findMany({
        where,
        include: {
            court: true,
            MatchPlayer: { include: { player: true } },
            invitations: {
                where: { status: 'PENDING' },
                select: { id: true, playerId: true, sentAt: true },
            },
        },
        orderBy: { startTime: 'asc' },
    });

    res.json(matches);
});

router.get('/matches/:id', authMiddleware, async (req: Request, res: Response) => {
    const match = await prisma.match.findUnique({
        where: { id: req.params.id as string },
        include: {
            court: true,
            MatchPlayer: { include: { player: true } },
            invitations: { include: { player: true } },
        },
    });
    if (!match) return res.status(404).json({ error: 'Partita non trovata' });
    res.json(match);
});

// ─────────────────────────────────────────────
// CREA PARTITA → parte wave
// ─────────────────────────────────────────────

router.post('/matches', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId;
    const { courtId, startTime, skillLevel, playersNeeded = 4 } = req.body;

    if (!courtId || !startTime || !skillLevel) {
        return res.status(400).json({ error: 'courtId, startTime e skillLevel sono richiesti' });
    }

    // Verifica che il campo appartenga al club
    const court = await prisma.court.findFirst({ where: { id: courtId, clubId } });
    if (!court) return res.status(404).json({ error: 'Campo non trovato' });

    const club = await prisma.club.findUnique({ where: { id: clubId } });

    const match = await prisma.match.create({
        data: {
            clubId,
            courtId,
            startTime: new Date(startTime),
            endTime: new Date(new Date(startTime).getTime() + (club?.matchDuration || 90) * 60000),
            skillLevel: parseInt(skillLevel),
            allowMixedLevels: club?.allowMixedLevels || false,
            playersNeeded: parseInt(playersNeeded),
            status: 'OPEN',
        },
        include: { court: true },
    });

    // Schedula prima wave con delay iniziale casuale (anti-bot)
    const initialDelayMs = Math.floor(Math.random() * 60000) + 30000; // 30-90s
    // ✅ FIX D: includere scheduledAt per staleness check nel wave.worker
    await waveQueue.add(
        'process-wave',
        { matchId: match.id, waveNumber: 1, scheduledAt: Date.now() + initialDelayMs },
        { delay: initialDelayMs, removeOnComplete: true }
    );

    logger.info(`Match ${match.id} created from dashboard, first wave in ${initialDelayMs / 1000}s`);

    res.status(201).json({
        match,
        waveScheduledInSeconds: Math.round(initialDelayMs / 1000),
    });
});

// ─────────────────────────────────────────────
// CANCELLA PARTITA
// ─────────────────────────────────────────────

router.post('/matches/:id/cancel', authMiddleware, async (req: Request, res: Response) => {
    const match = await prisma.match.findUnique({
        where: { id: req.params.id as string },
        include: { MatchPlayer: { include: { player: true } }, club: true },
    });

    if (!match) return res.status(404).json({ error: 'Partita non trovata' });
    if (match.status === 'CANCELLED') return res.status(400).json({ error: 'Partita già cancellata' });

    await prisma.match.update({
        where: { id: match.id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: 'MANUAL' },
    });

    // Notifica i giocatori confermati e dirottali
    const confirmed = match.MatchPlayer.filter(mp => !mp.leftAt);
    if (confirmed.length > 0) {
        const { redirectGroup } = await import('../services/redirect');
        await redirectGroup({
            clubId: match.clubId || '',
            referentPhone: confirmed[0].player.phoneNumber,
            referentJid: confirmed[0].player.phoneNumber,
            playerPhones: confirmed.map(mp => mp.player.phoneNumber),
            playerCount: confirmed.length,
            originalMatchId: match.id,
            originalStartTime: match.startTime,
            reason: 'CANCELLED',
        });
    }

    res.json({ success: true });
});

// ─────────────────────────────────────────────
// GIOCATORI
// ─────────────────────────────────────────────

router.get('/players', authMiddleware, async (req: Request, res: Response) => {
    const { search, active, skillLevel } = req.query;

    const clubId = (req as any).clubId;
    // ✅ FIX A: filtra sempre per clubId — nessun dato cross-club nella dashboard
    const where: any = { clubId };
    if (active !== undefined) where.active = active === 'true';
    if (skillLevel) where.skillLevel = parseInt(skillLevel as string);
    if (search) {
        where.OR = [
            { name: { contains: search as string, mode: 'insensitive' } },
            { phoneNumber: { contains: search as string } },
        ];
    }

    const players = await prisma.player.findMany({
        where,
        orderBy: [{ reliabilityScore: 'desc' }, { name: 'asc' }],
        take: 100,
    });

    res.json(players);
});

// ─────────────────────────────────────────────
// TOGGLE ACTIVE — form con solo numero telefono
// ─────────────────────────────────────────────

router.post('/players/toggle', authMiddleware, async (req: Request, res: Response) => {
    const { phoneNumber } = req.body;

    if (!phoneNumber) {
        return res.status(400).json({ error: 'phoneNumber richiesto' });
    }

    // Normalizza il numero
    const normalized = phoneNumber.replace(/\s/g, '').startsWith('+')
        ? phoneNumber.replace(/\s/g, '')
        : `+${phoneNumber.replace(/\D/g, '')}`;

    // ✅ FIX A: cerca il giocatore all'interno del club corretto
    const clubId = (req as any).clubId;
    const player = await prisma.player.findFirst({ where: { phoneNumber: normalized, clubId } });

    if (!player) {
        return res.status(404).json({ error: `Nessun giocatore trovato con numero ${normalized}` });
    }

    const updated = await prisma.player.update({
        where: { id: player.id },
        data: { active: !player.active },
    });

    logger.info(`Player ${normalized} toggled: active=${updated.active}`);

    res.json({
        phoneNumber: normalized,
        name: updated.name,
        active: updated.active,
        message: updated.active
            ? `${updated.name || normalized} riattivato ✅`
            : `${updated.name || normalized} disattivato 🚫`,
    });
});

export default router;
