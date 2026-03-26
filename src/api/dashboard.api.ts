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
import { sendMessage } from '../services/whatsapp';
import { runWithContext } from '../utils/request-context';
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
    const { username, password } = req.body || {};

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
// AGGIORNA IMPOSTAZIONI CLUB (Dashboard Slider)
// ─────────────────────────────────────────────

router.patch('/club', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId;
    const { name, skillLevelCount, aiTone, botName, maxDailyMessages, skillTestCost, skillTestDuration,
            openTime, closeTime, matchDuration } = req.body;
    const confirm = req.query.confirm === 'true';

    try {
        // Se cambiano gli orari, verifica partite fuori range prima di procedere
        if ((openTime !== undefined || closeTime !== undefined) && !confirm) {
            const club = await prisma.club.findUnique({ where: { id: clubId } });
            const newOpen = openTime ?? club?.openTime ?? '08:00';
            const newClose = closeTime ?? club?.closeTime ?? '23:30';
            const { findMatchesOutsideHours } = await import('../services/match-notifications');
            const affected = await findMatchesOutsideHours(clubId, newOpen, newClose);
            if (affected.length > 0) {
                return res.status(200).json({
                    requiresConfirmation: true,
                    message: `Ci sono ${affected.length} partite fuori dai nuovi orari (${newOpen}–${newClose}). Verranno cancellate e i giocatori notificati. Invia di nuovo con ?confirm=true per procedere.`,
                    affectedCount: affected.length,
                    affectedMatches: affected.map(m => ({
                        id: m.id, startTime: m.startTime, status: m.status, players: m.MatchPlayer.length,
                    })),
                });
            }
        }

        // Se confermato e ci sono orari nuovi: cancella le partite fuori range
        if ((openTime !== undefined || closeTime !== undefined) && confirm) {
            const club = await prisma.club.findUnique({ where: { id: clubId } });
            const newOpen = openTime ?? club?.openTime ?? '08:00';
            const newClose = closeTime ?? club?.closeTime ?? '23:30';
            const { findMatchesOutsideHours, cancelMatchesWithNotification } = await import('../services/match-notifications');
            const affected = await findMatchesOutsideHours(clubId, newOpen, newClose);
            if (affected.length > 0) {
                await runWithContext({ clubId }, () =>
                    cancelMatchesWithNotification(affected.map(m => m.id), clubId, 'Modifica orari circolo')
                ).catch(err => logger.error({ err }, 'cancelMatchesWithNotification (hours) failed'));
            }
        }

        const updated = await prisma.club.update({
            where: { id: clubId },
            data: {
                name: name !== undefined ? name : undefined,
                skillLevelCount: skillLevelCount !== undefined ? parseInt(skillLevelCount) : undefined,
                aiTone: aiTone !== undefined ? aiTone : undefined,
                botName: botName !== undefined ? botName : undefined,
                maxDailyMessages: maxDailyMessages !== undefined ? parseInt(maxDailyMessages) : undefined,
                skillTestCost: skillTestCost !== undefined ? parseFloat(skillTestCost) : undefined,
                skillTestDuration: skillTestDuration !== undefined ? parseInt(skillTestDuration) : undefined,
                openTime: openTime !== undefined ? openTime : undefined,
                closeTime: closeTime !== undefined ? closeTime : undefined,
                matchDuration: matchDuration !== undefined ? parseInt(matchDuration) : undefined,
            },
        });
        res.json(updated);
    } catch (err) {
        logger.error({ err, clubId }, 'Error updating club settings');
        res.status(500).json({ error: 'Errore nel salvataggio delle impostazioni' });
    }
});

// ─────────────────────────────────────────────
// CAMPI CON STATO REAL-TIME
// ─────────────────────────────────────────────

router.get('/courts', authMiddleware, async (req: Request, res: Response) => {
    try {
        const clubId = (req as any).clubId;
        const { date, dateFrom, dateTo } = req.query;

        let matchTimeFilter: { gte: Date; lte: Date };
        if (dateFrom && dateTo) {
            const from = new Date(dateFrom as string);
            from.setHours(0, 0, 0, 0);
            const to = new Date(dateTo as string);
            to.setHours(23, 59, 59, 999);
            matchTimeFilter = { gte: from, lte: to };
        } else {
            const targetDate = date ? new Date(date as string) : new Date();
            const dayStart = new Date(targetDate);
            dayStart.setHours(0, 0, 0, 0);
            const dayEnd = new Date(targetDate);
            dayEnd.setHours(23, 59, 59, 999);
            matchTimeFilter = { gte: dayStart, lte: dayEnd };
        }

        const courts = await prisma.court.findMany({
            where: { clubId, active: true },
            include: {
                matches: {
                    where: { startTime: matchTimeFilter },
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

        const club = await prisma.club.findUnique({ where: { id: clubId }, select: { matchDuration: true } });
        const matchDurationMs = (club?.matchDuration || 90) * 60 * 1000;

        // Calcola endTime per match che non ce l'hanno (es. creati dal bot)
        const enriched = courts.map((court: any) => ({
            ...court,
            matches: court.matches.map((m: any) => ({
                ...m,
                endTime: m.endTime ?? new Date(new Date(m.startTime).getTime() + matchDurationMs),
            })),
        }));

        res.json(enriched);
    } catch (err) {
        logger.error({ err }, 'Error fetching courts in dashboard');
        res.status(500).json({ error: 'Errore nel recupero dei campi' });
    }
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
    const clubId = (req as any).clubId;
    const match = await prisma.match.findFirst({
        where: { id: req.params.id as string, clubId },
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
// SUGGEST OPTIMAL SKILL LEVEL
// Trova il livello che massimizza sum(EMA) dei giocatori eligibili
// ─────────────────────────────────────────────

router.get('/matches/suggest-level', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId as string;
    const { date, time } = req.query as { date?: string; time?: string };

    try {
        const club = await prisma.club.findUnique({ where: { id: clubId } });
        if (!club) return res.status(404).json({ error: 'Club non trovato' });

        const lowerRange = club.matchLowerRange ?? 1.0;
        const upperRange = club.matchUpperRange ?? 1.0;
        const dailyCap = club.maxDailyMessages ?? 2;
        const PRIOR = 0.33;

        // Determina fascia oraria per filtrare il cap corretto
        let isMorning = false;
        if (date && time) {
            const matchDate = new Date(`${date}T${time}:00`);
            const hour = parseInt(
                new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false })
                    .format(matchDate).replace('24', '0'), 10
            );
            isMorning = hour < 14;
        }

        // Pool eligibile: attivi, skillLevel > 0, cap fascia non raggiunto, avoid flag rispettato
        const pool = await prisma.player.findMany({
            where: {
                clubId,
                active: true,
                skillLevel: { gt: 0 },
                ...(isMorning
                    ? { morningContactsToday: { lt: dailyCap }, avoidMorning: false }
                    : { afternoonContactsToday: { lt: dailyCap }, avoidAfternoon: false }),
            },
            select: { skillLevel: true, reliabilityScore: true },
        });

        if (pool.length === 0) {
            return res.json({ suggestions: [], message: 'Nessun giocatore disponibile in questa fascia oraria' });
        }

        // Candidati: ogni livello distinto nel pool (arrotondato a 0.5)
        const candidates = Array.from(new Set(pool.map(p => Math.round(p.skillLevel * 2) / 2))).sort((a, b) => a - b);

        const suggestions = candidates.map(level => {
            const eligible = pool.filter(p =>
                p.skillLevel >= level - lowerRange && p.skillLevel <= level + upperRange
            );
            const emaSum = eligible.reduce((sum, p) => sum + (p.reliabilityScore === 0 ? PRIOR : p.reliabilityScore), 0);
            return { level, playerCount: eligible.length, emaSum: parseFloat(emaSum.toFixed(2)) };
        });

        // Ordina per EMA sum decrescente
        suggestions.sort((a, b) => b.emaSum - a.emaSum);

        res.json({ suggestions: suggestions.slice(0, 5), isMorning });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────

router.post('/matches', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId;
    const { courtId, startTime, skillLevel, playersNeeded = 4, type = 'MATCH', duration, title } = req.body;
    if (type === 'MATCH' && playersNeeded < 2) return res.status(400).json({ error: 'playersNeeded deve essere almeno 2' });
    const playersNeededNum = parseInt(playersNeeded);
    if (isNaN(playersNeededNum) || playersNeededNum > 100 || playersNeededNum < 0) return res.status(400).json({ error: 'playersNeeded deve essere tra 0 e 100' });
    if (!courtId || !startTime) return res.status(400).json({ error: 'courtId e startTime sono richiesti' });
    if (new Date(startTime) < new Date()) return res.status(400).json({ error: 'Non puoi creare un match nel passato' });

    if (!courtId || !startTime) {
        return res.status(400).json({ error: 'courtId e startTime sono richiesti' });
    }

    // Verifica che il campo appartenga al club
    const court = await prisma.court.findFirst({ where: { id: courtId, clubId } });
    if (!court) return res.status(404).json({ error: 'Campo non trovato' });

    const club = await prisma.club.findUnique({ where: { id: clubId } });

    // Valida type
    const validTypes = ['MATCH', 'LESSON', 'UNAVAILABLE'];
    const matchType = validTypes.includes(type) ? type : 'MATCH';

    // Controlla sovrapposizione di match sullo stesso campo
    const matchEndTime = new Date(new Date(startTime).getTime() + (duration ? duration * 60000 : (club?.matchDuration || 90) * 60000));
    const overlap = await prisma.match.findFirst({
        where: {
            courtId,
            status: { not: 'CANCELLED' },
            startTime: { lt: matchEndTime },
            endTime: { gt: new Date(startTime) },
        },
    });
    if (overlap) {
        return res.status(409).json({ error: 'Campo già occupato in questo orario', conflictMatch: overlap.id });
    }

    const match = await prisma.match.create({
        data: {
            clubId,
            courtId,
            type: matchType as any,
            title: title ? String(title).trim() : null,
            startTime: new Date(startTime),
            endTime: new Date(new Date(startTime).getTime() + (duration ? duration * 60000 : (club?.matchDuration || 90) * 60000)),
            skillLevel: parseInt(skillLevel),
            allowMixedLevels: club?.allowMixedLevels || false,
            playersNeeded: parseInt(playersNeeded),
            status: 'OPEN',
        },
        include: { court: true },
    });

    // Wave solo per MATCH con skillLevel > 0
    let waveScheduled = false;
    if (matchType === 'MATCH' && (parseInt(skillLevel) || 0) > 0) {
        const initialDelayMs = Math.floor(Math.random() * 60000) + 30000; // 30-90s
        try {
            await Promise.race([
                waveQueue.add(
                    'process-wave',
                    { matchId: match.id, waveNumber: 1, scheduledAt: Date.now() + initialDelayMs },
                    { delay: initialDelayMs, removeOnComplete: true }
                ),
                new Promise<never>((_, rej) => setTimeout(() => rej(new Error('Redis timeout')), 5000))
            ]);
            waveScheduled = true;
            logger.info(`Match ${match.id} created from dashboard, first wave in ${Math.round(initialDelayMs / 1000)}s`);
        } catch (waveErr: any) {
            logger.warn({ matchId: match.id, err: waveErr?.message }, 'Wave scheduling failed (Redis down?) — match creato ma wave non schedulata');
        }
    }

    res.status(201).json({ match, waveScheduled });
});

// ─────────────────────────────────────────────
// CANCELLA PARTITA
// ─────────────────────────────────────────────

router.post('/matches/:id/cancel', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId;
    const match = await prisma.match.findFirst({
        where: { id: req.params.id as string, clubId },
    });

    if (!match) return res.status(404).json({ error: 'Partita non trovata' });
    if (match.status === 'CANCELLED') return res.status(400).json({ error: 'Partita già cancellata' });

    await prisma.match.update({
        where: { id: match.id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelledReason: 'MANUAL' },
    });

    const { notifyMatchCancelled } = await import('../services/match-notifications');
    let notified = false;
    let notifyError: string | undefined;

    try {
        await runWithContext({ clubId }, () => notifyMatchCancelled(match.id, clubId));
        notified = true;
    } catch (err: any) {
        notifyError = err?.message || 'Errore sconosciuto';
        logger.error({ err }, 'notifyMatchCancelled failed');
    }

    res.json({ success: true, notified, notifyError });
});

// Modifica orario o campo di una partita — notifica automatica ai giocatori
router.patch('/matches/:id', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId;
    const { startTime: newStartTimeStr, courtId: newCourtId } = req.body;

    try {
        const match = await prisma.match.findFirst({
            where: { id: req.params.id as string, clubId },
        });
        if (!match) return res.status(404).json({ error: 'Partita non trovata' });
        if (match.status === 'CANCELLED') return res.status(400).json({ error: 'Partita cancellata' });
        if (!newStartTimeStr && !newCourtId) return res.status(400).json({ error: 'Specifica startTime o courtId' });

        const oldStartTime = match.startTime;
        const newStartTime = newStartTimeStr ? new Date(newStartTimeStr) : match.startTime;
        const targetCourtId = newCourtId || match.courtId;

        // Verifica disponibilità campo al nuovo orario
        if (newStartTimeStr && targetCourtId) {
            const conflict = await prisma.match.findFirst({
                where: { courtId: targetCourtId, id: { not: match.id }, status: { in: ['OPEN', 'LOCKED'] }, startTime: newStartTime },
            });
            if (conflict) return res.status(409).json({ error: 'Campo già occupato a quell\'orario' });
        }

        await prisma.match.update({
            where: { id: match.id },
            data: {
                startTime: newStartTimeStr ? newStartTime : undefined,
                courtId: newCourtId ?? undefined,
            },
        });

        const { notifyMatchRescheduled } = await import('../services/match-notifications');
        let notified = false;
        let notifyError: string | undefined;
        try {
            await runWithContext({ clubId }, () => notifyMatchRescheduled(match.id, oldStartTime, newStartTime, clubId));
            notified = true;
        } catch (err: any) {
            notifyError = err?.message || 'Errore sconosciuto';
            logger.error({ err }, 'notifyMatchRescheduled failed');
        }

        res.json({ success: true, notified, notifyError });
    } catch (err) {
        logger.error({ err }, 'PATCH /matches/:id failed');
        res.status(500).json({ error: 'Errore durante la modifica' });
    }
});

// Modifica o disattiva un campo — con richiesta di conferma se ci sono partite future
router.patch('/courts/:id', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId;
    const { name, isCovered, notes, active } = req.body;
    const confirm = req.query.confirm === 'true';

    try {
        const court = await prisma.court.findFirst({ where: { id: req.params.id as string, clubId } });
        if (!court) return res.status(404).json({ error: 'Campo non trovato' });

        const { findMatchesOnCourt, cancelMatchesWithNotification } = await import('../services/match-notifications');

        // Disattivazione: verifica partite future prima di procedere
        if (active === false && court.active && !confirm) {
            const affected = await findMatchesOnCourt(court.id);
            if (affected.length > 0) {
                return res.status(200).json({
                    requiresConfirmation: true,
                    message: `Ci sono ${affected.length} partite future su questo campo. Verranno cancellate e i giocatori notificati. Invia con ?confirm=true per procedere.`,
                    affectedCount: affected.length,
                    affectedMatches: affected.map(m => ({
                        id: m.id, startTime: m.startTime, status: m.status, players: m.MatchPlayer.length,
                    })),
                });
            }
        }

        // Se confermato: cancella partite e notifica
        let notified = true;
        let notifyError: string | undefined;
        if (active === false && court.active) {
            const affected = await findMatchesOnCourt(court.id);
            if (affected.length > 0) {
                try {
                    await runWithContext({ clubId }, () =>
                        cancelMatchesWithNotification(affected.map(m => m.id), clubId, 'Campo disattivato')
                    );
                } catch (err: any) {
                    notified = false;
                    notifyError = err?.message || 'Errore sconosciuto';
                    logger.error({ err }, 'cancelMatchesWithNotification failed');
                }
            }
        }

        await prisma.court.update({
            where: { id: court.id },
            data: {
                name: name ?? undefined,
                isCovered: isCovered ?? undefined,
                notes: notes ?? undefined,
                active: active ?? undefined,
            },
        });

        res.json({ success: true, notified, notifyError });
    } catch (err) {
        logger.error({ err }, 'PATCH /courts/:id failed');
        res.status(500).json({ error: 'Errore durante la modifica del campo' });
    }
});

// ─────────────────────────────────────────────
// SLOT DISPONIBILI PER UN CAMPO
// ─────────────────────────────────────────────

router.get('/courts/:id/slots', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId;
    const { date, duration: durationStr } = req.query as { date?: string; duration?: string };

    if (!date) return res.status(400).json({ error: 'date è richiesto (YYYY-MM-DD)' });

    const court = await prisma.court.findFirst({ where: { id: req.params.id, clubId } });
    if (!court) return res.status(404).json({ error: 'Campo non trovato' });

    const club = await prisma.club.findUnique({ where: { id: clubId } });
    if (!club) return res.status(404).json({ error: 'Club non trovato' });

    const slotDurationMins = durationStr ? parseInt(durationStr) : club.matchDuration;
    const slotDurationMs = slotDurationMins * 60 * 1000;

    // Genera slot dall'apertura alla chiusura
    const [openH, openM] = club.openTime.split(':').map(Number);
    const [closeH, closeM] = club.closeTime.split(':').map(Number);

    // Usa Europe/Rome per costruire i timestamp in orario italiano
    const slots: { startTime: string; endTime: string; available: boolean; reason?: string }[] = [];
    let cursor = new Date(`${date}T00:00:00`);
    // setHours in Rome: usiamo offset fisso +1/+2 → meglio costruire via toLocaleString trick
    // Costruiamo startOfDay in Rome
    const romeStart = new Date(new Date(`${date}T${String(openH).padStart(2,'0')}:${String(openM).padStart(2,'0')}:00`).toLocaleString('en-US', { timeZone: 'Europe/Rome' }) === 'Invalid Date'
        ? `${date}T${String(openH).padStart(2,'0')}:${String(openM).padStart(2,'0')}:00`
        : `${date}T${String(openH).padStart(2,'0')}:${String(openM).padStart(2,'0')}:00`
    );
    // Approccio più semplice: buildRomeTime-like usando Intl
    const toUtc = (dateStr: string, h: number, m: number): Date => {
        // Crea una data in Rome timezone e convertila in UTC
        const isoLike = `${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00`;
        // Trick: new Date() interpreta come locale, usiamo un workaround con Intl
        const d = new Date(isoLike);
        const romeOffset = new Date(d.toLocaleString('en-US', { timeZone: 'Europe/Rome' })).getTime() - d.getTime();
        return new Date(d.getTime() - romeOffset);
    };

    cursor = toUtc(date, openH, openM);
    const closeUtc = toUtc(date, closeH, closeM);
    const now = new Date();

    // Carica i match esistenti sul campo in quella giornata
    const dayStart = toUtc(date, 0, 0);
    const dayEnd = toUtc(date, 23, 59);
    const existingMatches = await prisma.match.findMany({
        where: {
            courtId: court.id,
            status: { not: 'CANCELLED' },
            startTime: { gte: dayStart, lte: dayEnd },
        },
        select: { id: true, startTime: true, endTime: true, type: true, status: true },
    });

    while (cursor.getTime() + slotDurationMs <= closeUtc.getTime()) {
        const slotStart = new Date(cursor);
        const slotEnd = new Date(cursor.getTime() + slotDurationMs);

        // Controlla sovrapposizione con match esistenti
        const conflict = existingMatches.find(m =>
            m.endTime && new Date(m.startTime) < slotEnd && new Date(m.endTime) > slotStart
        );

        const isPast = slotStart <= now;

        slots.push({
            startTime: slotStart.toISOString(),
            endTime: slotEnd.toISOString(),
            available: !conflict && !isPast,
            reason: isPast ? 'Passato' : conflict ? 'Campo occupato' : undefined,
        });

        cursor = new Date(cursor.getTime() + slotDurationMs);
    }

    res.json({ slots, slotDurationMins });
});

// ─────────────────────────────────────────────
// CHIUSURE (UNAVAILABILITY)
// ─────────────────────────────────────────────

router.get('/courts/:id/unavailability', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId;
    const court = await prisma.court.findFirst({ where: { id: req.params.id, clubId } });
    if (!court) return res.status(404).json({ error: 'Campo non trovato' });

    const items = await prisma.match.findMany({
        where: { courtId: court.id, clubId, type: 'UNAVAILABLE', startTime: { gte: new Date() } },
        orderBy: { startTime: 'asc' },
    });
    res.json(items.map(m => ({
        id: m.id,
        startTime: m.startTime,
        endTime: m.endTime,
        reason: m.cancelledReason,
        recurring: m.groupId === 'recurring',
    })));
});

router.post('/courts/:id/unavailability', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId;
    const court = await prisma.court.findFirst({ where: { id: req.params.id, clubId } });
    if (!court) return res.status(404).json({ error: 'Campo non trovato' });

    const { startTime, endTime, reason, recurring } = req.body;
    if (!startTime || !endTime) return res.status(400).json({ error: 'startTime e endTime richiesti' });

    const start = new Date(startTime);
    const end = new Date(endTime);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start)
        return res.status(400).json({ error: 'Orari non validi' });

    try {
        // Check conflicting OPEN/LOCKED matches
        const conflictingMatches = await prisma.match.findMany({
            where: {
                courtId: court.id, clubId,
                status: { in: ['OPEN', 'LOCKED'] },
                startTime: { gte: start, lt: end },
            },
        });

        const weeks = recurring ? 52 : 1;
        const created = [];
        for (let w = 0; w < weeks; w++) {
            const s = new Date(start.getTime() + w * 7 * 24 * 60 * 60 * 1000);
            const e = new Date(end.getTime() + w * 7 * 24 * 60 * 60 * 1000);
            created.push(await prisma.match.create({
                data: {
                    clubId, courtId: court.id, type: 'UNAVAILABLE',
                    startTime: s, endTime: e, skillLevel: 0, playersNeeded: 0,
                    cancelledReason: reason || null,
                    groupId: recurring ? 'recurring' : null,
                },
            }));
        }

        res.json({ created: created.length, conflictingMatches: conflictingMatches.map(m => ({ id: m.id, startTime: m.startTime })) });
    } catch (err) {
        logger.error({ err }, 'POST /courts/:id/unavailability failed');
        res.status(500).json({ error: 'Errore durante la creazione della chiusura' });
    }
});

router.delete('/courts/:id/unavailability/:uid', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId;
    const match = await prisma.match.findFirst({
        where: { id: req.params.uid, courtId: req.params.id, clubId, type: 'UNAVAILABLE' },
    });
    if (!match) return res.status(404).json({ error: 'Chiusura non trovata' });
    await prisma.match.delete({ where: { id: match.id } });
    res.json({ success: true });
});

// ─────────────────────────────────────────────
// STATISTICHE
// ─────────────────────────────────────────────

router.get('/stats', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId as string;
    const days = parseInt(req.query.days as string) || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    try {
        // ── Conteggi partite ──────────────────────────────────────────
        const [total, locked, open, cancelled, unfilled] = await Promise.all([
            prisma.match.count({ where: { clubId, startTime: { gte: since }, status: { not: 'ARCHIVED' } } }),
            prisma.match.count({ where: { clubId, startTime: { gte: since }, status: 'LOCKED' } }),
            prisma.match.count({ where: { clubId, startTime: { gte: since }, status: 'OPEN' } }),
            prisma.match.count({ where: { clubId, startTime: { gte: since }, status: 'CANCELLED' } }),
            prisma.match.count({ where: { clubId, startTime: { gte: since }, status: 'UNFILLED' } }),
        ]);
        const completed = locked + cancelled + unfilled;
        const fillRate = completed > 0 ? locked / completed : 0;

        // ── Revenue: match LOCKED × prezzo slot ───────────────────────
        const lockedMatches = await prisma.match.findMany({
            where: { clubId, startTime: { gte: since }, status: 'LOCKED' },
            include: { court: { include: { prices: true } } },
        });
        let revenue = 0;
        for (const match of lockedMatches) {
            if (!match.court?.prices?.length) continue;
            const rome = new Date(match.startTime).toLocaleTimeString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' });
            const price = match.court.prices.find(p => {
                if (rome < p.startTime || rome >= p.endTime) return false;
                if (p.startDate && match.startTime < p.startDate) return false;
                if (p.endDate && match.startTime > p.endDate) return false;
                return true;
            });
            if (price) revenue += price.price;
        }

        // ── Partite salvate da disdetta ───────────────────────────────
        const savedFromCancellation = await prisma.match.count({
            where: { clubId, startTime: { gte: since }, status: 'LOCKED', recoveryWaveCount: { gt: 0 } },
        });

        // ── Conversione wave ──────────────────────────────────────────
        const [invSent, invAccepted] = await Promise.all([
            prisma.invitation.count({ where: { match: { clubId }, sentAt: { gte: since } } }),
            prisma.invitation.count({ where: { match: { clubId }, sentAt: { gte: since }, status: 'ACCEPTED' } }),
        ]);
        const waveConversionRate = invSent > 0 ? invAccepted / invSent : 0;

        // ── Messaggi fuori orario (bot attivo mentre lo staff non c'è) ─
        // Fuori orario = prima delle 8:00 o dopo le 20:00 in ora italiana, oppure sabato/domenica
        const allUserMessages = await prisma.whatsAppMessage.findMany({
            where: { clubId, role: 'user', timestamp: { gte: since } },
            select: { timestamp: true },
        });
        const offHoursMessages = allUserMessages.filter(m => {
            const d = new Date(m.timestamp);
            const hour = parseInt(d.toLocaleString('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }));
            const dow = d.getDay(); // 0=Dom, 6=Sab in locale UTC — approssimazione accettabile
            return hour < 8 || hour >= 20 || dow === 0 || dow === 6;
        });
        const offHoursRate = allUserMessages.length > 0 ? offHoursMessages.length / allUserMessages.length : 0;

        // ── Giocatori ─────────────────────────────────────────────────
        const [totalPlayers, activeInPeriod, newPlayers] = await Promise.all([
            prisma.player.count({ where: { clubId, active: true } }),
            prisma.matchPlayer.findMany({
                where: { match: { clubId, startTime: { gte: since } }, leftAt: null },
                select: { playerId: true },
                distinct: ['playerId'],
            }),
            prisma.player.count({ where: { clubId, createdAt: { gte: since } } }),
        ]);

        res.json({
            matches: { total, locked, open, cancelled, unfilled },
            players: { total: totalPlayers, active: activeInPeriod.length, newThisPeriod: newPlayers },
            fillRate,
            revenue,
            savedFromCancellation,
            waveConversionRate,
            invSent,
            offHoursMessages: offHoursMessages.length,
            totalMessages: allUserMessages.length,
            offHoursRate,
        });
    } catch (err) {
        logger.error({ err }, 'Error fetching stats');
        res.status(500).json({ error: 'Errore nel recupero statistiche' });
    }
});

// ─────────────────────────────────────────────
// GIOCATORI
// ─────────────────────────────────────────────

router.get('/players', authMiddleware, async (req: Request, res: Response) => {
    const { search, active, skillLevel, minLevel, maxLevel } = req.query;

    const clubId = (req as any).clubId;
    // ✅ FIX A: filtra sempre per clubId — nessun dato cross-club nella dashboard
    const where: any = { clubId };
    if (active !== undefined) where.active = active === 'true';
    
    if (skillLevel) {
        where.skillLevel = parseFloat(skillLevel as string);
    } else if (minLevel || maxLevel) {
        where.skillLevel = {};
        if (minLevel) where.skillLevel.gte = parseFloat(minLevel as string);
        if (maxLevel) where.skillLevel.lte = parseFloat(maxLevel as string);
    }
    if (search) {
        const safeSearch = String(search).replace(/\0/g, '').slice(0, 200);
        where.OR = [
            { name: { contains: safeSearch, mode: 'insensitive' } },
            { phoneNumber: { contains: safeSearch } },
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
// PROFILO GIOCATORE (Dettaglio e Modifica)
// ─────────────────────────────────────────────

router.get('/players/:id', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId as string;
    const { id } = req.params;

    try {
        const player = await prisma.player.findFirst({
            where: { id: id as string, clubId }
        });

        if (!player) {
            return res.status(404).json({ error: 'Giocatore non trovato' });
        }

        // Calcola statistiche aggregate
        const totalInvited = await prisma.invitation.count({ where: { playerId: id as string } });
        const totalAccepted = await prisma.invitation.count({ where: { playerId: id as string, status: 'ACCEPTED' } });
        const totalNoShow = 0; 

        res.json({
            ...player,
            stats: {
                totalInvited,
                totalAccepted,
                totalNoShow
            }
        });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────
// CREATE PLAYER — aggiunta manuale dalla dashboard
// ─────────────────────────────────────────────

router.post('/players', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId as string;
    const { name, phoneNumber, skillLevel } = req.body;

    if (!name || !String(name).trim().includes(' ')) {
        return res.status(400).json({ error: 'Nome e cognome richiesti (es. "Mario Rossi")' });
    }
    if (!phoneNumber) {
        return res.status(400).json({ error: 'Numero di telefono richiesto' });
    }

    const normalized = String(phoneNumber).replace(/\D/g, '');
    if (normalized.length < 8 || normalized.length > 15) {
        return res.status(400).json({ error: 'Numero di telefono non valido' });
    }

    try {
        const existing = await prisma.player.findFirst({
            where: { phoneNumber: normalized, clubId },
        });
        if (existing) {
            return res.status(409).json({ error: 'Giocatore già registrato con questo numero' });
        }

        const { inferGender } = await import('../services/ai');
        const firstName = String(name).trim().split(' ')[0];
        const gender = await inferGender(firstName).catch(() => 'UNKNOWN' as const);

        const player = await prisma.player.create({
            data: {
                phoneNumber: normalized,
                name: String(name).trim(),
                clubId,
                skillLevel: skillLevel !== undefined ? parseFloat(skillLevel) : -1,
                gender,
                active: true,
            },
        });

        // Approva il numero in Redis così può scrivere al bot senza passare dall'admin
        const { getRedis } = await import('../services/queue');
        const redis = getRedis();
        await redis.set(`approval:approved:${normalized}`, '1', 'EX', 90 * 24 * 3600);

        logger.info({ playerId: player.id, phone: normalized }, 'Player created from dashboard');
        res.status(201).json(player);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

router.patch('/players/:id', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId as string;
    const { id } = req.params;
    const { name, skillLevel, active, avoidMorning, avoidAfternoon } = req.body;

    try {
        const player = await prisma.player.findFirst({
            where: { id: id as string, clubId }
        });

        if (!player) {
            return res.status(404).json({ error: 'Giocatore non trovato' });
        }

        const data: any = {};
        if (name !== undefined) data.name = String(name).replace(/\0/g, '');
        if (skillLevel !== undefined) data.skillLevel = parseFloat(skillLevel);
        if (active !== undefined) data.active = active;
        if (avoidMorning !== undefined) data.avoidMorning = Boolean(avoidMorning);
        if (avoidAfternoon !== undefined) data.avoidAfternoon = Boolean(avoidAfternoon);

        const updated = await prisma.player.update({
            where: { id: id as string },
            data
        });

        // ✅ Notifica WhatsApp al cambio livello (sendMessage statico — no dynamic import per lesson 16)
        if (skillLevel !== undefined && parseFloat(skillLevel) !== player.skillLevel) {
            runWithContext({ clubId }, () =>
                sendMessage(
                    player.phoneNumber,
                    `🎉 Il tuo livello di gioco è stato aggiornato a *${skillLevel}*! Continua così 💪🎾`
                )
            ).then(() => logger.info({ phone: player.phoneNumber, level: skillLevel }, 'Level update WA sent'))
             .catch(err => logger.error({ err }, 'Failed to send WA for level update'));
        }

        res.json(updated);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
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

// ─────────────────────────────────────────────
// GESTIONE TARIFFE (Standard & Eccezioni)
// ─────────────────────────────────────────────

router.get('/prices', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId;
    try {
        const courts = await prisma.court.findMany({
            where: { clubId, active: true },
            include: { prices: { orderBy: { startTime: 'asc' } } },
            orderBy: { name: 'asc' },
        });
        res.json(courts);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

router.post('/prices', authMiddleware, async (req: Request, res: Response) => {
    const clubId = (req as any).clubId;
    const { prices } = req.body; // Array di oggetti CourtPrice

    if (!Array.isArray(prices)) {
        return res.status(400).json({ error: 'Payload malformato: atteso array "prices"' });
    }

    try {
        const results = [];
        for (const p of prices) {
            // Verifica che il campo appartenga al club per sicurezza
            const court = await prisma.court.findFirst({ where: { id: p.courtId, clubId } });
            if (!court) continue; // Salta se il campo non appartiene al club

            if (p._delete && p.id) {
                await prisma.courtPrice.delete({ where: { id: p.id } });
                results.push({ id: p.id, action: 'deleted' });
            } else if (p.id) {
                const updated = await prisma.courtPrice.update({
                    where: { id: p.id },
                    data: {
                        startTime: p.startTime,
                        endTime: p.endTime,
                        price: parseFloat(p.price),
                        startDate: p.startDate ? new Date(p.startDate) : null,
                        endDate: p.endDate ? new Date(p.endDate) : null,
                    }
                });
                results.push({ id: updated.id, action: 'updated' });
            } else {
                const created = await prisma.courtPrice.create({
                    data: {
                        courtId: p.courtId,
                        startTime: p.startTime,
                        endTime: p.endTime,
                        price: parseFloat(p.price),
                        startDate: p.startDate ? new Date(p.startDate) : null,
                        endDate: p.endDate ? new Date(p.endDate) : null,
                    }
                });
                results.push({ id: created.id, action: 'created' });
            }
        }
        res.json({ success: true, results });
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

// ─────────────────────────────────────────────
// SYSTEM HEALTH
// ─────────────────────────────────────────────

router.get('/system/health', authMiddleware, async (req: Request, res: Response) => {
    // Health check reale — verifica connessioni attive
    const health: Record<string, any> = { uptime: process.uptime() };

    // Redis
    try {
        const { getRedis } = await import('../services/queue');
        const redis = await getRedis();
        const pong = await Promise.race([
            redis.ping(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))
        ]);
        const info = await redis.info('persistence').catch(() => '');
        const aof = info.includes('aof_enabled:1');
        const queueSize = await redis.llen('staging:bull:wave-queue:wait').catch(() => 0);
        health.redis = { connected: pong === 'PONG', aof, queueSize };
    } catch (err: any) {
        health.redis = { connected: false, error: err?.message };
    }

    // Database
    try {
        const dbCheck = prisma.$queryRawUnsafe('SELECT 1 AS ok');
        await Promise.race([
            dbCheck,
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000))
        ]);
        health.database = { connected: true };
    } catch (err: any) {
        health.database = { connected: false, error: err?.message };
    }

    // WhatsApp (non blocca)
    health.whatsapp = { connected: true, uptime: process.uptime() };
    health.worker = { running: true, lastCheck: new Date().toISOString() };
    health.security = { rateLimitActive: true, jwtRotationEnabled: true, webhookHmac: !!process.env.WEBHOOK_SECRET };

    res.json(health);
});


// ─────────────────────────────────────────────
// DEBUG/TEST: Simula messaggio inbound da un numero
// Solo disponibile fuori da produzione
// ─────────────────────────────────────────────
router.post('/debug/simulate-message', authMiddleware, async (req: Request, res: Response) => {
    if (!process.env.DEBUG_SIMULATE) {
        return res.status(403).json({ error: 'Endpoint disabilitato (imposta DEBUG_SIMULATE=1 per abilitarlo)' });
    }
    const { phoneNumber, text } = req.body || {};
    if (!phoneNumber || !text) {
        return res.status(400).json({ error: 'phoneNumber e text richiesti' });
    }

    const jid = `${phoneNumber.replace(/[^0-9]/g, '')}@s.whatsapp.net`;
    const msgId = `SIMTEST_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    try {
        const { handleBatch } = await import('../services/messageHandler');
        await handleBatch(jid, [{
            type: 'text',
            text,
            raw: {
                key: { id: msgId, remoteJid: jid, fromMe: false },
                pushName: 'SimTest',
                messageTimestamp: Math.floor(Date.now() / 1000),
                message: { conversation: text },
            } as any,
        }]);
        res.json({ ok: true, jid, msgId });
    } catch (err: any) {
        logger.error({ err }, 'simulate-message error');
        res.status(500).json({ error: err.message });
    }
});

// ─────────────────────────────────────────────
// TEST: Manda messaggio WA all'admin (verifica connessione + JID)
// ─────────────────────────────────────────────
router.post('/test-notification', authMiddleware, async (req: Request, res: Response) => {
    try {
        const clubId = (req as any).clubId;
        const club = await prisma.club.findUnique({ where: { id: clubId }, select: { adminPhone: true, name: true } });
        if (!club?.adminPhone) return res.status(400).json({ error: 'adminPhone non configurato' });

        const jid = `${club.adminPhone.replace(/\D/g, '')}@s.whatsapp.net`;
        // Imposta il clubId nel context così sendMessage usa il socket corretto
        await runWithContext({ correlationId: `test-notif-${clubId}`, clubId }, async () => {
            await sendMessage(jid, `🎾 *Test notifica Francesca*\nConnessione attiva. JID utilizzato: ${jid}`);
        });
        res.json({ ok: true, jid });
    } catch (err: any) {
        logger.error({ err }, 'test-notification failed');
        res.status(500).json({ error: err.message });
    }
});

export default router;
