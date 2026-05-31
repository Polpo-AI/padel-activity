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
import { checkRedisHealth, waveQueue, recoveryQueue, reminderQueue, maintenanceQueue } from '../services/queue';
import { calculateCostFromPrices } from '../services/pricing';
import * as jwt from 'jsonwebtoken';
import pino from 'pino';
import rateLimit from 'express-rate-limit';

const logger = pino({ level: 'info' });
const router = Router();

// In staging/produzione i segreti DEVONO essere impostati via env var: niente fallback insicuri.
// Se mancano (o sono uguali al default noto) l'avvio fallisce di proposito.
const IS_LIVE_ENV = process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging';
function requireSecret(name: string, value: string | undefined, insecureDefault: string): string {
    if (!value || value === insecureDefault) {
        if (IS_LIVE_ENV) {
            throw new Error(
                `[SECURITY] ${name} non impostata o uguale al default insicuro in ambiente "${process.env.NODE_ENV}". ` +
                `Imposta una variabile d'ambiente sicura prima di avviare il servizio.`,
            );
        }
        logger.warn(`[SECURITY] ${name} usa il default insicuro — accettabile SOLO in sviluppo locale`);
        return value || insecureDefault;
    }
    return value;
}

const ADMIN_JWT_SECRET = requireSecret('ADMIN_JWT_SECRET', process.env.ADMIN_JWT_SECRET, 'padel-admin-secret-change-in-production');
const ADMIN_USERNAME   = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD   = requireSecret('ADMIN_PASSWORD', process.env.ADMIN_PASSWORD, 'admin123');

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
        (req as any).adminUser = payload.username || 'admin';
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

        // Revenue totale (30gg), rispettando l'azzeramento guadagni per circolo
        const revMatches = await prisma.match.findMany({
            where: { status: 'LOCKED', type: 'MATCH', startTime: { gte: thirtyDaysAgo } },
            select: { startTime: true, court: { select: { prices: true } }, club: { select: { revenueResetAt: true, matchDuration: true } } },
        });
        const totalRevenue = revMatches.reduce((sum, m: any) => {
            if (m.club?.revenueResetAt && m.startTime < m.club.revenueResetAt) return sum;
            if (!m.court?.prices?.length) return sum;
            return sum + calculateCostFromPrices(m.startTime, m.court.prices, m.club?.matchDuration || 90);
        }, 0);

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
            totals: { totalClubs, totalPlayers, activePlayers, openMatches, lockedMatches, totalRevenue },
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
                botName: true, botPhoneNumber: true, adminPhone: true,
                matchLowerRange: true, matchUpperRange: true,
                maxDailyMessages: true, openTime: true, closeTime: true,
                matchDuration: true, revenueResetAt: true,
                _count: {
                    select: {
                        players: true,
                        courts: { where: { active: true } },
                        matches: true,
                    },
                },
                matches: {
                    where: { startTime: { gte: thirtyDaysAgo }, type: 'MATCH' },
                    select: { status: true, startTime: true, court: { select: { prices: true } } },
                },
            },
            orderBy: { name: 'asc' },
        });

        res.json(clubs.map(c => {
            const total = c.matches.length;
            const locked = c.matches.filter(m => m.status === 'LOCKED').length;
            // Revenue ultimi 30gg: partite LOCKED dopo l'eventuale azzeramento guadagni
            const revSince = c.revenueResetAt && c.revenueResetAt > thirtyDaysAgo ? c.revenueResetAt : thirtyDaysAgo;
            const revenue = c.matches.reduce((sum, m: any) => {
                if (m.status !== 'LOCKED' || m.startTime < revSince || !m.court?.prices?.length) return sum;
                return sum + calculateCostFromPrices(m.startTime, m.court.prices, c.matchDuration || 90);
            }, 0);
            return {
                id: c.id, name: c.name, city: c.city, address: c.address,
                botName: c.botName, botPhoneNumber: c.botPhoneNumber, adminPhone: c.adminPhone,
                matchLowerRange: c.matchLowerRange,
                matchUpperRange: c.matchUpperRange, maxDailyMessages: c.maxDailyMessages,
                openTime: c.openTime, closeTime: c.closeTime,
                players: c._count.players,
                courts: c._count.courts,
                totalMatches: c._count.matches,
                matchesThisMonth: total,
                fillRate: total > 0 ? locked / total : 0,
                revenue,
                revenueResetAt: c.revenueResetAt,
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
        const { name, city, address, botName, matchLowerRange, matchUpperRange, maxDailyMessages } = req.body;
        const updated = await prisma.club.update({
            where: { id: req.params.id },
            data: {
                name:             name             ?? undefined,
                city:             city             ?? undefined,
                address:          address          ?? undefined,
                botName:          botName          ?? undefined,
                matchLowerRange:  matchLowerRange  != null ? parseFloat(matchLowerRange)  : undefined,
                matchUpperRange:  matchUpperRange  != null ? parseFloat(matchUpperRange)  : undefined,
                maxDailyMessages: maxDailyMessages != null ? parseInt(maxDailyMessages)   : undefined,
            },
        });
        res.json(updated);
    } catch (err) {
        logger.error({ err }, 'Admin club update error');
        res.status(500).json({ error: 'Errore nel salvataggio' });
    }
});

// Azzera i guadagni: il revenue conteggerà solo le partite da adesso in poi (non distruttivo)
router.post('/clubs/:id/reset-revenue', adminAuth, async (req: Request, res: Response) => {
    try {
        const updated = await prisma.club.update({
            where: { id: req.params.id },
            data: { revenueResetAt: new Date() },
            select: { id: true, revenueResetAt: true },
        });
        logger.info({ clubId: req.params.id }, 'Admin: revenue reset');
        res.json({ ok: true, revenueResetAt: updated.revenueResetAt });
    } catch (err) {
        logger.error({ err }, 'Admin reset-revenue error');
        res.status(500).json({ error: 'Errore nel reset guadagni' });
    }
});

// Impersonation (Punto 7): conia un token dashboard per il circolo → l'admin entra
// nella dashboard reale di quel circolo con poteri pieni. Firmato col JWT_SECRET dashboard.
router.post('/clubs/:id/impersonate', adminAuth, async (req: Request, res: Response) => {
    const clubId = req.params.id as string;
    const actor = (req as any).adminUser || 'admin';
    try {
        const club = await prisma.club.findUnique({ where: { id: clubId }, select: { id: true, name: true } });
        if (!club) return res.status(404).json({ error: 'Circolo non trovato' });
        const secret = process.env.JWT_SECRET;
        if (!secret) return res.status(500).json({ error: 'JWT_SECRET non configurato' });
        const token = jwt.sign({ clubId: club.id, clubName: club.name, impersonatedBy: actor }, secret, { expiresIn: '2h' });
        await prisma.adminAuditLog.create({
            data: { actor, clubId: club.id, action: 'IMPERSONATE_ENTER', detail: club.name },
        }).catch(() => {});
        logger.info({ clubId, actor }, 'Admin impersonation token issued');
        res.json({ token, clubName: club.name });
    } catch (err) {
        logger.error({ err, clubId }, 'Admin impersonate error');
        res.status(500).json({ error: 'Errore impersonation' });
    }
});

// Audit log dei superpoteri admin (Punto 7): ingressi impersonation + modifiche.
router.get('/audit', adminAuth, async (req: Request, res: Response) => {
    try {
        const clubId = req.query.clubId as string | undefined;
        const logs = await prisma.adminAuditLog.findMany({
            where: clubId ? { clubId } : {},
            orderBy: { createdAt: 'desc' },
            take: 200,
        });
        const clubIds = [...new Set(logs.map(l => l.clubId).filter(Boolean))] as string[];
        const clubs = clubIds.length
            ? await prisma.club.findMany({ where: { id: { in: clubIds } }, select: { id: true, name: true } })
            : [];
        const nameMap: Record<string, string> = {};
        for (const c of clubs) nameMap[c.id] = c.name;
        res.json(logs.map(l => ({
            id: l.id, actor: l.actor, action: l.action, detail: l.detail,
            createdAt: l.createdAt, clubId: l.clubId,
            clubName: l.clubId ? (nameMap[l.clubId] || l.clubId) : null,
        })));
    } catch (err) {
        logger.error({ err }, 'Admin audit fetch error');
        res.status(500).json({ error: 'Errore nel recupero audit log' });
    }
});

// Costi API Claude per circolo (Punto B): attribuzione spesa su chiave unica.
router.get('/usage', adminAuth, async (req: Request, res: Response) => {
    try {
        const days = Math.max(1, Math.min(365, parseInt(req.query.days as string) || 30));
        const sinceDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' })
            .format(new Date(Date.now() - days * 24 * 60 * 60 * 1000));
        const rows = await prisma.apiUsage.findMany({ where: { day: { gte: sinceDay } } });
        const { costUsd } = await import('../services/usage-tracker');

        const byClub: Record<string, any> = {};
        for (const r of rows) {
            const c = byClub[r.clubId] || (byClub[r.clubId] = { clubId: r.clubId, calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
            c.calls += r.calls;
            c.inputTokens += r.inputTokens;
            c.outputTokens += r.outputTokens;
            c.costUsd += costUsd({ model: r.model, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cacheReadTokens: r.cacheReadTokens, cacheWriteTokens: r.cacheWriteTokens });
        }
        const list: any[] = Object.values(byClub);
        const realIds = list.map(c => c.clubId).filter((id: string) => id !== 'system');
        const clubs = realIds.length ? await prisma.club.findMany({ where: { id: { in: realIds } }, select: { id: true, name: true } }) : [];
        const nameMap: Record<string, string> = {};
        for (const c of clubs) nameMap[c.id] = c.name;
        for (const c of list) c.clubName = c.clubId === 'system' ? 'Sistema (senza circolo)' : (nameMap[c.clubId] || c.clubId);
        list.sort((a, b) => b.costUsd - a.costUsd);

        res.json({
            days,
            clubs: list,
            totalCalls: list.reduce((s, c) => s + c.calls, 0),
            totalCostUsd: list.reduce((s, c) => s + c.costUsd, 0),
        });
    } catch (err) {
        logger.error({ err }, 'Admin usage fetch error');
        res.status(500).json({ error: 'Errore nel recupero costi API' });
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

        // Conteggi code BullMQ (best-effort: se Redis è giù, fallback a null)
        let queues: Record<string, any> | null = null;
        try {
            const defs: [string, any][] = [['wave', waveQueue], ['recovery', recoveryQueue], ['reminder', reminderQueue], ['maintenance', maintenanceQueue]];
            const counts = await Promise.all(defs.map(([, q]) => q.getJobCounts('waiting', 'active', 'delayed', 'failed')));
            queues = {};
            defs.forEach(([name], i) => { queues![name] = counts[i]; });
        } catch (e) {
            logger.warn({ e }, 'Admin system: queue counts unavailable');
        }

        const clubs = await prisma.club.findMany({
            select: { id: true, name: true, botPhoneNumber: true, adminPhone: true },
            orderBy: { name: 'asc' },
        });

        res.json({
            db: dbOk ? 'ok' : 'down',
            redis: redisOk ? 'ok' : 'down',
            queues,
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
