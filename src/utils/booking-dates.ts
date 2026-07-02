/**
 * BOOKING DATES — parsing di giorno/orario nel fuso del circolo (Europe/Rome).
 *
 * Funzioni pure, senza dipendenze da DB/Redis: estratte da brain.ts per essere
 * testabili in isolamento (vedi src/tests/booking-dates.test.ts).
 *
 * Regola fondamentale: TUTTI i calcoli di calendario partono dal giorno-calendario
 * di ROMA, mai da quello del server (il VPS è in UTC: tra mezzanotte e le 2 di notte
 * italiane il giorno UTC è ancora "ieri").
 */

import pino from 'pino';

const logger = pino({ level: 'info' });

/**
 * Costruisce l'istante UTC corrispondente alle h:m (wall-clock Rome) del giorno di baseDate.
 * Getter UTC: il risultato non deve dipendere dal timezone del server
 * (le baseDate sono costruite a mezzogiorno/mezzanotte UTC del giorno-calendario di Roma).
 * Gestisce DST calcolando l'offset reale del giorno richiesto.
 */
export function buildRomeTime(baseDate: Date, h: number, m: number): Date {
    const noon = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate(), 12, 0, 0));
    const noonRomeHour = Number(noon.toLocaleString('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }));
    const offsetH = noonRomeHour - 12;
    let utcH = h - offsetH;
    let dayOffset = 0;
    if (utcH < 0) { utcH += 24; dayOffset = -1; }
    if (utcH >= 24) { utcH -= 24; dayOffset = 1; }
    return new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth(), baseDate.getUTCDate() + dayOffset, utcH, m, 0));
}

/**
 * Converte i parametri del brain ("oggi" | "domani" | "dopodomani" | "martedì" |
 * "YYYY-MM-DD", "HH:MM") in un istante UTC. `now` è iniettabile per i test.
 * Giorno non riconosciuto → null (meglio fallire e ri-chiedere che prenotare oggi in silenzio).
 */
export function parseBookingDateTime(day: string, time: string, now: Date = new Date()): Date | null {
    if (!time) return null;
    const [h, m] = String(time).split(':').map(Number);
    if (isNaN(h) || isNaN(m)) return null;

    // Base = giorno-calendario di ROMA (non del server, che gira in UTC): tra mezzanotte
    // e le 2 ora di Roma il giorno UTC è ancora quello precedente → "domani"/giorni
    // della settimana calcolati col tz del server sbagliavano di un giorno.
    const romeDateStr = now.toLocaleString('sv-SE', { timeZone: 'Europe/Rome' }).split(' ')[0]; // "YYYY-MM-DD"
    const [ry, rmo, rd] = romeDateStr.split('-').map(Number);
    let targetDate = new Date(Date.UTC(ry, rmo - 1, rd, 12, 0));
    const addDays = (n: number) => { targetDate = new Date(targetDate.getTime() + n * 86_400_000); };

    // Normalizza: minuscole + senza accenti, così "lunedi"/"Lunedì"/"il lunedì" si equivalgono
    const dayNorm = (day || '').toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    if (!dayNorm || dayNorm === 'oggi' || dayNorm === 'stasera' || dayNorm === 'stamattina' || dayNorm === 'oggi pomeriggio') {
        // keep today
    } else if (dayNorm === 'domani') {
        addDays(1);
    } else if (dayNorm === 'dopodomani') {
        addDays(2);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(dayNorm)) {
        const [y, mo, d] = dayNorm.split('-').map(Number);
        targetDate = new Date(Date.UTC(y, mo - 1, d, 12, 0));
        // safety: se il brain ha passato una data ISO già passata (es. ha risolto
        // "martedì" a oggi invece di passare il nome del giorno), avanza di 7 giorni
        const candidate = buildRomeTime(targetDate, h, m);
        if (candidate && candidate.getTime() < now.getTime() - 5 * 60 * 1000) {
            logger.warn({ day, time }, 'parseBookingDateTime: ISO date in the past, advancing 7 days');
            addDays(7);
        }
    } else {
        const dayMap: Record<string, number> = {
            domenica: 0, lunedi: 1, martedi: 2, mercoledi: 3,
            giovedi: 4, venerdi: 5, sabato: 6,
        };
        // includes() tollera prefissi/suffissi tipo "sabato prossimo", "il sabato"
        const foundKey = Object.keys(dayMap).find(k => dayNorm.includes(k));
        if (foundKey === undefined) {
            // Giorno non riconosciuto: meglio fallire (il bot ri-chiede) che prenotare
            // silenziosamente OGGI come faceva prima.
            logger.warn({ day, time }, 'parseBookingDateTime: giorno non riconosciuto');
            return null;
        }
        const currentRomeDow = new Date(Date.UTC(ry, rmo - 1, rd)).getUTCDay();
        let diff = dayMap[foundKey] - currentRomeDow;
        if (diff <= 0) diff += 7;
        addDays(diff);
    }

    return buildRomeTime(targetDate, h, m);
}
