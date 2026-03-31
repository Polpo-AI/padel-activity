/**
 * ADMIN API — Super-admin dashboard cross-club
 *
 * Auth separata dal club dashboard: credenziali da env vars, JWT con role:superadmin
 *
 * Routes:
 * POST /admin/login            → JWT superadmin
 * GET  /admin/overview         → KPI aggregati (clubs, players, matches, revenue)
 * GET  /admin/clubs            → tutti i circoli con statistiche
 * GET  /admin/clubs/:id        → dettaglio circolo
 * PATCH /admin/clubs/:id       → aggiorna impostazioni circolo
 * GET  /admin/matches          → tutte le partite cross-club con filtri
 * GET  /admin/players          → tutti i giocatori cross-club con filtri
 * GET  /admin/system           → stato WA per circolo, health check
 */

import { Router, Request, Response, NextFunction } from 'express';
import { prisma } from '../services/db';
import { getAllClubStatuses } from '../services/whatsapp';
import { checkDbHealth } from '../services/db';
import { checkRedisHealth } from '../services/queue';
import * as jwt from 'jsonwebtoken';
import pino from 'pino';
import rateLimit from 'express-rate-limit';

const logger = pino({ level: 'info' });
const router = Router();

const ADMIN_JWT_SECRET = process.env.ADMIN_JWT_SECRET || 'padel-admin-secret-change-in-production';
const ADMIN_USERNAME   = process.env.ADMIN_USERNAME   || 'admin';
const ADMIN_PASSWORD   = process.env.ADMIN_PASSWORD   || 'admin123';

const loginRateLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Troppi tentativi. Riprova tra 15 minuti.' },
});

// ─────────────────────────────────────────────
// MIDDLEWARE AUTH SUPERADMIN
// ─────────────────────────────────────────────

function adminAuth(req: Request, res: Response, next: NextFunction) {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Token mancante' });

    try {
        const payload = jwt.verify(token, ADMIN_JWT_SECRET) as any;
        if (payload.role !== 'superadmin') return res.status(403).json({ error: 'Accesso negato' });
        next();
    } catch {
        return res.status(401).json({ error: 'Token non valido' });
    }
}

// ─────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────

router.post('/login', loginRateLimit, (req: Request, res: Response) => {
    const { username, password } = req.body || {};

    if (!username || !password) {
        return res.status(400).json({ error: 'Credenziali mancanti' });
    }

    if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: 'Credenziali non valide' });
    }

    const token = jwt.sign({ role: 'superadmin', username }, ADMIN_JWT_SECRET, { expiresIn: '12h' });
    res.json({ token });
});

// ─────────────────────────────────────────────
// OVERVIEW — KPI AGGREGATI
// ─────────────────────────────────────────────

router.get('/overview', adminAuth, async (_req: Request, res: Response) => {
    try {
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

        const [
            totalClubs,
            totalPlayers,
            activePlayers,
            matchesToday,
            matchesThisMonth,
            openMatches,
            lockedMatches,
            recentlyActivePlayers,
            totalInvitations,
            acceptedInvitations,
        ] = await Promise.all([
            prisma.club.count(),
            prisma.player.count(),
            prisma.player.count({ where: { active: true } }),
            prisma.match.count({ where: { startTime: { gte: todayStart }, type: 'MATCH' } }),
            prisma.match.count({ where: { startTime: { gte: thirtyDaysAgo }, type: 'MATCH' } }),
            prisma.match.count({ where: { status: 'OPEN', type: 'MATCH' } }),
            prisma.match.count({ where: { status: 'LOCKED', type: 'MATCH' } }),
            prisma.player.count({ where: { lastContactedAt: { gte: thirtyDaysAgo } } }),
            prisma.invitation.count({ where: { sentAt: { gte: thirtyDaysAgo } } }),
            prisma.invitation.count({ where: { status: 'ACCEPTED', sentAt: { gte: thirtyDaysAgo } } }),
        ]);

        const fillRate = totalInvitations > 0 ? (acceptedInvitations / totalInvitations) : 0;

        // Per-club summary
        const clubs = await prisma.club.findMany({
            select: {
                id: true, name: true, city: true,
                _count: {
                    select: {
                        players: true,
                        matches: { where: { startTime: { gte: thirtyDaysAgo }, type: 'MATCH' } },
                    },
                },
            },
            orderBy: { name: 'asc' },
        });

        const waStatuses = getAllClubStatuses();

        res.json({
            totals: { totalClubs, totalPlayers, activePlayers, openMatches, lockedMatches },
            period: { matchesToday, matchesThisMonth, recentlyActivePlayers, fillRate },
            clubs: clubs.map(c => ({
                id: c.id, name: c.name, city: c.city,
                players: c._count.players,
                matchesThisMonth: c._count.matches,
                waStatus: waStatuses[c.id] || 'disconnected',
            })),
        });
    } catch (err) {
        logger.error({ err }, 'Admin overview error');
        res.status(500).json({ error: 'Errore nel caricamento' });
    }
});

// ─────────────────────────────────────────────
// CLUBS
// ─────────────────────────────────────────────

router.get('/clubs', adminAuth, async (_req: Request, res: Response) => {
    try {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
        const waStatuses = getAllClubStatuses();

        const clubs = await prisma.club.findMany({
            select: {
                id: true, name: true, city: true, address: true,
                botPhoneNumber: true, adminPhone: true,
                matchLowerRange: true, matchUpperRange: true,
                maxDailyMessages: true, openTime: true, closeTime: true,
                _count: {
                    select: {
                        players: true,
                        courts: { where: { active: true } },
                        matches: true,
                    },
                },
                matches: {
                    where: { startTime: { gte: thirtyDaysAgo }, type: 'MATCH' },
                    select: { status: true },
                },
            },
            orderBy: { name: 'asc' },
        });

        res.json(clubs.map(c => {
            const total = c.matches.length;
            const locked = c.matches.filter(m => m.status === 'LOCKED').length;
            return {
                id: c.id, name: c.name, city: c.city, address: c.address,
                botPhoneNumber: c.botPhoneNumber, adminPhone: c.adminPhone,
                matchLowerRange: c.matchLowerRange,
                matchUpperRange: c.matchUpperRange, maxDailyMessages: c.maxDailyMessages,
                openTime: c.openTime, closeTime: c.closeTime,
                players: c._count.players,
                courts: c._count.courts,
                totalMatches: c._count.matches,
                matchesThisMonth: total,
                fillRate: total > 0 ? locked / total : 0,
                waStatus: waStatuses[c.id] || 'disconnected',
            };
        }));
    } catch (err) {
        logger.error({ err }, 'Admin clubs error');
        res.status(500).json({ error: 'Errore nel caricamento' });
    }
});

router.get('/clubs/:id', adminAuth, async (req: Request, res: Response) => {
    try {
        const club = await prisma.club.findUnique({
            where: { id: req.params.id },
            include: {
                courts: { where: { active: true } },
                _count: { select: { players: true, matches: true } },
            },
        });
        if (!club) return res.status(404).json({ error: 'Club non trovato' });
        res.json(club);
    } catch (err) {
        logger.error({ err }, 'Admin club detail error');
        res.status(500).json({ error: 'Errore nel caricamento' });
    }
});

router.patch('/clubs/:id', adminAuth, async (req: Request, res: Response) => {
    try {
        const { name, city, address, matchLowerRange, matchUpperRange, maxDailyMessages } = req.body;
        const updated = await prisma.club.update({
            where: { id: req.params.id },
            data: {
                name: name ?? undefined,
                city: city ?? undefined,
                address: address ?? undefined,
                matchLowerRange: matchLowerRange != null ? parseFloat(matchLowerRange) : undefined,
                matchUpperRange: matchUpperRange != null ? parseFloat(matchUpperRange) : undefined,
                maxDailyMessages: maxDailyMessages != null ? parseInt(maxDailyMessages) : undefined,
            },
        });
        res.json(updated);
    } catch (err) {
        logger.error({ err }, 'Admin club update error');
        res.status(500).json({ error: 'Errore nel salvataggio' });
    }
});

// ─────────────────────────────────────────────
// MATCHES CROSS-CLUB
// ─────────────────────────────────────────────

router.get('/matches', adminAuth, async (req: Request, res: Response) => {
    try {
        const { clubId, status, date, limit = '50', offset = '0' } = req.query as Record<string, string>;

        const where: any = { type: 'MATCH' };
        if (clubId) where.clubId = clubId;
        if (status) where.status = status;
        if (date) {
            const d = new Date(date);
            const nextDay = new Date(d.getTime() + 24 * 60 * 60 * 1000);
            where.startTime = { gte: d, lt: nextDay };
        } else {
            where.startTime = { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) };
        }

        const [matches, total] = await Promise.all([
            prisma.match.findMany({
                where,
                include: {
                    club: { select: { id: true, name: true } },
                    court: { select: { name: true } },
                    MatchPlayer: { where: { leftAt: null }, select: { player: { select: { name: true } } } },
                },
                orderBy: { startTime: 'desc' },
                take: parseInt(limit),
                skip: parseInt(offset),
            }),
            prisma.match.count({ where }),
        ]);

        res.json({
            matches: matches.map(m => ({
                id: m.id,
                clubId: m.clubId, clubName: m.club?.name,
                court: m.court?.name,
                startTime: m.startTime,
                status: m.status,
                skillLevel: m.skillLevel,
                playersNeeded: m.playersNeeded,
                playersConfirmed: m.MatchPlayer.length,
                players: m.MatchPlayer.map(mp => mp.player?.name).filter(Boolean),
            })),
            total,
        });
    } catch (err) {
        logger.error({ err }, 'Admin matches error');
        res.status(500).json({ error: 'Errore nel caricamento' });
    }
});

// ─────────────────────────────────────────────
// PLAYERS CROSS-CLUB
// ─────────────────────────────────────────────

router.get('/players', adminAuth, async (req: Request, res: Response) => {
    try {
        const { clubId, search, active, limit = '50', offset = '0' } = req.query as Record<string, string>;

        const where: any = {};
        if (clubId) where.clubId = clubId;
        if (active !== undefined) where.active = active === 'true';
        if (search) {
            where.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { phoneNumber: { contains: search } },
            ];
        }

        const [players, total] = await Promise.all([
            prisma.player.findMany({
                where,
                include: {
                    club: { select: { id: true, name: true } },
                    _count: { select: { MatchPlayer: true, invitations: true } },
                },
                orderBy: { lastContactedAt: 'desc' },
                take: parseInt(limit),
                skip: parseInt(offset),
            }),
            prisma.player.count({ where }),
        ]);

        res.json({
            players: players.map(p => ({
                id: p.id,
                name: p.name, phoneNumber: p.phoneNumber,
                skillLevel: p.skillLevel, active: p.active,
                reliabilityScore: p.reliabilityScore,
                clubId: p.clubId, clubName: p.club?.name,
                totalMatches: p._count.MatchPlayer,
                totalInvitations: p._count.invitations,
                lastContactedAt: p.lastContactedAt,
            })),
            total,
        });
    } catch (err) {
        logger.error({ err }, 'Admin players error');
        res.status(500).json({ error: 'Errore nel caricamento' });
    }
});

// ─────────────────────────────────────────────
// SYSTEM — STATO WA + HEALTH
// ─────────────────────────────────────────────

router.get('/system', adminAuth, async (_req: Request, res: Response) => {
    try {
        const [dbOk, redisOk] = await Promise.all([checkDbHealth(), checkRedisHealth()]);
        const waStatuses = getAllClubStatuses();

        const clubs = await prisma.club.findMany({
            select: { id: true, name: true, botPhoneNumber: true, adminPhone: true },
            orderBy: { name: 'asc' },
        });

        res.json({
            db: dbOk ? 'ok' : 'down',
            redis: redisOk ? 'ok' : 'down',
            clubs: clubs.map(c => ({
                id: c.id, name: c.name,
                botPhoneNumber: c.botPhoneNumber,
                adminPhone: c.adminPhone,
                waStatus: waStatuses[c.id] || 'disconnected',
            })),
            ts: new Date().toISOString(),
        });
    } catch (err) {
        logger.error({ err }, 'Admin system error');
        res.status(500).json({ error: 'Errore nel caricamento' });
    }
});

export default router;
