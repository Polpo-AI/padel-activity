/**
 * TEST: booking-dates.ts
 *
 * Funzioni pure di parsing giorno/orario nel fuso Europe/Rome.
 * Include i test di regressione per il "bug della mezzanotte":
 * sul VPS (UTC) tra le 00:00 e le 02:00 italiane il giorno UTC è ancora
 * "ieri" — "domani" e i nomi dei giorni devono risolvere sul calendario Rome.
 */

import { describe, it, expect } from 'vitest';
import { buildRomeTime, parseBookingDateTime } from '../utils/booking-dates';

// Helper: che ora è (wall-clock Rome) per un istante UTC
function romeString(d: Date): string {
    return d.toLocaleString('sv-SE', { timeZone: 'Europe/Rome' });
}

describe('buildRomeTime', () => {
    it('estate (CEST, UTC+2): le 18:00 Rome sono le 16:00 UTC', () => {
        const base = new Date(Date.UTC(2026, 6, 15, 12, 0)); // 15 luglio
        const result = buildRomeTime(base, 18, 0);
        expect(result.toISOString()).toBe('2026-07-15T16:00:00.000Z');
    });

    it('inverno (CET, UTC+1): le 18:00 Rome sono le 17:00 UTC', () => {
        const base = new Date(Date.UTC(2026, 0, 15, 12, 0)); // 15 gennaio
        const result = buildRomeTime(base, 18, 0);
        expect(result.toISOString()).toBe('2026-01-15T17:00:00.000Z');
    });

    it('orario a cavallo di mezzanotte UTC: 00:30 Rome estate = 22:30 UTC del giorno prima', () => {
        const base = new Date(Date.UTC(2026, 6, 15, 12, 0));
        const result = buildRomeTime(base, 0, 30);
        expect(result.toISOString()).toBe('2026-07-14T22:30:00.000Z');
    });
});

describe('parseBookingDateTime', () => {
    it('ritorna null senza orario o con orario malformato', () => {
        expect(parseBookingDateTime('domani', '')).toBeNull();
        expect(parseBookingDateTime('domani', 'boh')).toBeNull();
    });

    it('"oggi alle 18" risolve a oggi (Rome) alle 18:00', () => {
        // 15 luglio 2026, ore 10:00 Rome (08:00 UTC)
        const now = new Date('2026-07-15T08:00:00Z');
        const result = parseBookingDateTime('oggi', '18:00', now)!;
        expect(romeString(result)).toBe('2026-07-15 18:00:00');
    });

    it('"stasera"/"stamattina" equivalgono a oggi', () => {
        const now = new Date('2026-07-15T08:00:00Z');
        expect(romeString(parseBookingDateTime('stasera', '21:00', now)!)).toBe('2026-07-15 21:00:00');
        expect(romeString(parseBookingDateTime('stamattina', '09:00', now)!)).toBe('2026-07-15 09:00:00');
    });

    it('"domani alle 18" risolve a domani (Rome)', () => {
        const now = new Date('2026-07-15T08:00:00Z');
        const result = parseBookingDateTime('domani', '18:00', now)!;
        expect(romeString(result)).toBe('2026-07-16 18:00:00');
    });

    it('"dopodomani" risolve a +2 giorni', () => {
        const now = new Date('2026-07-15T08:00:00Z');
        const result = parseBookingDateTime('dopodomani', '18:00', now)!;
        expect(romeString(result)).toBe('2026-07-17 18:00:00');
    });

    it('REGRESSIONE mezzanotte: alle 00:30 Rome "domani" è il giorno Rome+1, non il giorno UTC+1', () => {
        // 00:30 del 16 luglio Rome = 22:30 UTC del 15 luglio.
        // Il vecchio codice (getDate del server UTC) avrebbe risolto "domani" al 16 (= oggi Rome!).
        const now = new Date('2026-07-15T22:30:00Z'); // 16 luglio, 00:30 Rome
        const result = parseBookingDateTime('domani', '18:00', now)!;
        expect(romeString(result)).toBe('2026-07-17 18:00:00');
    });

    it('REGRESSIONE mezzanotte: alle 00:30 Rome "oggi" è il giorno Rome corrente', () => {
        const now = new Date('2026-07-15T22:30:00Z'); // 16 luglio, 00:30 Rome
        const result = parseBookingDateTime('oggi', '18:00', now)!;
        expect(romeString(result)).toBe('2026-07-16 18:00:00');
    });

    it('nome giorno: "martedì" da un mercoledì risolve al martedì successivo', () => {
        // 15 luglio 2026 è un mercoledì
        const now = new Date('2026-07-15T08:00:00Z');
        const result = parseBookingDateTime('martedì', '18:00', now)!;
        expect(romeString(result)).toBe('2026-07-21 18:00:00');
    });

    it('nome giorno uguale a oggi: risolve alla settimana successiva', () => {
        // mercoledì → "mercoledì" = tra 7 giorni
        const now = new Date('2026-07-15T08:00:00Z');
        const result = parseBookingDateTime('mercoledì', '18:00', now)!;
        expect(romeString(result)).toBe('2026-07-22 18:00:00');
    });

    it('accenti e prefissi tollerati: "il Sabato prossimo" = sabato', () => {
        const now = new Date('2026-07-15T08:00:00Z'); // mercoledì
        const result = parseBookingDateTime('il Sabato prossimo', '18:00', now)!;
        expect(romeString(result)).toBe('2026-07-18 18:00:00');
    });

    it('REGRESSIONE mezzanotte: nome giorno calcolato sul calendario Rome', () => {
        // 22:30 UTC del 15/7 = 00:30 Rome del 16/7 (giovedì).
        // "venerdì" deve essere il 17, non calcolato dal mercoledì UTC.
        const now = new Date('2026-07-15T22:30:00Z'); // giovedì 16 luglio, 00:30 Rome
        const result = parseBookingDateTime('venerdì', '18:00', now)!;
        expect(romeString(result)).toBe('2026-07-17 18:00:00');
    });

    it('giorno non riconosciuto → null (il bot ri-chiede, non prenota oggi in silenzio)', () => {
        const now = new Date('2026-07-15T08:00:00Z');
        expect(parseBookingDateTime('boh', '18:00', now)).toBeNull();
        expect(parseBookingDateTime('la prossima settimana', '18:00', now)).toBeNull();
    });

    it('data ISO valida futura: usata così com\'è', () => {
        const now = new Date('2026-07-15T08:00:00Z');
        const result = parseBookingDateTime('2026-07-20', '18:00', now)!;
        expect(romeString(result)).toBe('2026-07-20 18:00:00');
    });

    it('data ISO nel passato: avanza di 7 giorni (safety per errori del brain)', () => {
        const now = new Date('2026-07-15T08:00:00Z');
        const result = parseBookingDateTime('2026-07-14', '18:00', now)!;
        expect(romeString(result)).toBe('2026-07-21 18:00:00');
    });
});
