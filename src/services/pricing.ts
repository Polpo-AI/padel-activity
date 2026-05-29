import { prisma } from './db';
import pino from 'pino';

const logger = pino({ level: 'info' });

/**
 * Calcola il costo dello slot dai prezzi caricati.
 * Applica la regola: Priorità alle Eccezioni (con startDate/endDate) rispetto agli standard.
 */
export function calculateCostFromPrices(startTime: Date, prices: any[]): number {
    if (!prices || prices.length === 0) return 0;

    // Confronto fasce in "minuti dalla mezzanotte" nel fuso Europe/Rome: le fasce "HH:MM" sono
    // definite in ora locale del circolo, ma startTime è un istante UTC. Senza convertire al fuso
    // Rome, su server UTC lo slot finirebbe nella fascia sbagliata (prezzo errato).
    const romeMinutes = (d: Date): number => {
        const s = d.toLocaleString('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false });
        const [h, m] = s.split(':').map(Number);
        return h * 60 + m;
    };
    const slotStartMin = romeMinutes(startTime);
    const slotEndMin = slotStartMin + 90; // partite da 90 min

    const bandIntersects = (p: any): boolean => {
        const [hStart, mStart] = p.startTime.split(':').map(Number);
        const [hEnd, mEnd] = p.endTime.split(':').map(Number);
        let bandStart = hStart * 60 + mStart;
        let bandEnd = hEnd * 60 + mEnd;
        if (bandEnd < bandStart) bandEnd += 24 * 60; // fascia che scavalca la mezzanotte
        return Math.max(slotStartMin, bandStart) < Math.min(slotEndMin, bandEnd);
    };

    // 1. Filtra per periodo (startDate / endDate)
    const validPrices = prices.filter((p: any) => {
        if (p.startDate && startTime < new Date(p.startDate)) return false;
        if (p.endDate && startTime > new Date(p.endDate)) return false;
        return true;
    });

    // 2. Separa Standard (no dates) da Eccezioni (con dates)
    const exceptionPrices = validPrices.filter((p: any) => p.startDate || p.endDate);
    const standardPrices = validPrices.filter((p: any) => !p.startDate && !p.endDate);

    // 3. Le eccezioni hanno la precedenza solo se intersecano davvero lo slot; altrimenti standard.
    const hasExceptionIntersect = exceptionPrices.some(bandIntersects);
    const itemsToProcess = hasExceptionIntersect ? exceptionPrices : standardPrices;

    // 4. Tariffa massima tra le fasce che intersecano lo slot
    let maxPrice = 0;
    for (const p of itemsToProcess) {
        if (bandIntersects(p) && p.price > maxPrice) maxPrice = p.price;
    }

    if (maxPrice === 0 && itemsToProcess.length > 0) {
        maxPrice = Math.max(...itemsToProcess.map((p: any) => p.price));
    }

    return maxPrice;
}

/**
 * Calcola il costo totale di una partita (90 minuti) leggendo il matchId
 */
export async function calculateMatchCost(matchId: string): Promise<number> {
    try {
        const match = await prisma.match.findUnique({
            where: { id: matchId },
            include: { court: { include: { prices: true } } },
        });

        if (!match || !match.court) return 0;
        return calculateCostFromPrices(match.startTime, match.court.prices);
    } catch (err) {
        logger.error({ err, matchId }, 'Error calculating match cost');
        return 0;
    }
}

/**
 * Calcola il costo prima che la partita esista
 */
export async function calculateSlotCost(courtId: string, startTime: Date): Promise<number> {
    try {
        const court = await prisma.court.findUnique({
            where: { id: courtId },
            include: { prices: true },
        });

        if (!court) return 0;
        return calculateCostFromPrices(startTime, court.prices);
    } catch (err) {
        logger.error({ err, courtId }, 'Error calculating slot cost');
        return 0;
    }
}
