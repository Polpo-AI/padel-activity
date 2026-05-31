/**
 * USAGE TRACKER (Punto B) — attribuzione costi API Claude per circolo.
 *
 * Ogni risposta di Claude porta `usage` (token input/output + cache). Qui li registriamo
 * in ApiUsage, aggregati per (clubId, giorno Rome, modello), così l'admin sa quanto pesa
 * ogni circolo sulla bolletta Anthropic — pur usando un'unica chiave.
 *
 * Le tariffe sono in USD per 1M token (valuta di fatturazione Anthropic). Aggiornabili qui.
 */

import { randomUUID } from 'crypto';
import { prisma } from './db';
import pino from 'pino';

const logger = pino({ level: 'info' });

// USD per 1M token. Match per sottostringa così i suffissi di versione non rompono nulla.
export const PRICING: Record<string, { in: number; out: number }> = {
    haiku:  { in: 1.0,  out: 5.0 },
    sonnet: { in: 3.0,  out: 15.0 },
    opus:   { in: 15.0, out: 75.0 },
};
const DEFAULT_RATES = { in: 3.0, out: 15.0 };

function ratesFor(model: string) {
    const m = (model || '').toLowerCase();
    for (const k of Object.keys(PRICING)) if (m.includes(k)) return PRICING[k];
    return DEFAULT_RATES;
}

/** Costo stimato in USD da token + modello (cache: read ~10% input, write ~125% input). */
export function costUsd(u: { model: string; inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }): number {
    const r = ratesFor(u.model);
    const cacheRead = (u.cacheReadTokens || 0) * (r.in * 0.1);
    const cacheWrite = (u.cacheWriteTokens || 0) * (r.in * 1.25);
    return (u.inputTokens * r.in + u.outputTokens * r.out + cacheRead + cacheWrite) / 1_000_000;
}

function romeDay(d = new Date()): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/**
 * Registra il consumo di una singola chiamata Claude (fire-and-forget, mai bloccante).
 * Upsert atomico via ON CONFLICT — niente race sugli incrementi.
 */
export function recordUsage(clubId: string | undefined, model: string, usage: any): void {
    if (!usage) return;
    const input = usage.input_tokens || 0;
    const output = usage.output_tokens || 0;
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return;

    const club = clubId || 'system';
    const day = romeDay();

    prisma.$executeRaw`
        INSERT INTO "ApiUsage" ("id","clubId","day","model","calls","inputTokens","outputTokens","cacheReadTokens","cacheWriteTokens")
        VALUES (${randomUUID()}, ${club}, ${day}, ${model || 'unknown'}, 1, ${input}, ${output}, ${cacheRead}, ${cacheWrite})
        ON CONFLICT ("clubId","day","model") DO UPDATE SET
            "calls" = "ApiUsage"."calls" + 1,
            "inputTokens" = "ApiUsage"."inputTokens" + ${input},
            "outputTokens" = "ApiUsage"."outputTokens" + ${output},
            "cacheReadTokens" = "ApiUsage"."cacheReadTokens" + ${cacheRead},
            "cacheWriteTokens" = "ApiUsage"."cacheWriteTokens" + ${cacheWrite}
    `.catch((err) => logger.warn({ err }, 'recordUsage failed'));
}
