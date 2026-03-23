import { prisma } from './db';
import pino from 'pino';

const logger = pino({ level: 'info' });

/**
 * Calcola il costo dello slot dai prezzi caricati.
 * Applica la regola: Priorità alle Eccezioni (con startDate/endDate) rispetto agli standard.
 */
export function calculateCostFromPrices(startTime: Date, prices: any[]): number {
    if (!prices || prices.length === 0) return 0;

    const endTime = new Date(startTime.getTime() + 90 * 60 * 1000); // 90 min

    // 1. Filtra per periodo (startDate / endDate)
    const validPrices = prices.filter((p: any) => {
        if (p.startDate && startTime < new Date(p.startDate)) return false;
        if (p.endDate && startTime > new Date(p.endDate)) return false;
        return true;
    });

    // 2. Separa Standard (no dates) da Eccezioni (con dates)
    const exceptionPrices = validPrices.filter((p: any) => p.startDate || p.endDate);
    const standardPrices = validPrices.filter((p: any) => !p.startDate && !p.endDate);

    // 3. Trova la tariffa massima tra le intersezioni.
    // Se ci sono eccezioni sovrapposte, hanno la precedenza!
    let maxPrice = 0;
    let itemsToProcess = exceptionPrices.length > 0 ? exceptionPrices : standardPrices;

    // Se per caso le eccezioni non coprono lo slot, potremmo dover fare un fallback su standard?
    // Come da richiesta: "quello andrà a scrivere il vecchio prezzo" -> Sostituisce.
    // Verifichiamo se ci sono intersezioni vere nelle eccezioni prima di escludere gli standard.
    const hasExceptionIntersect = exceptionPrices.some((p: any) => {
        const [hStart, mStart] = p.startTime.split(':').map(Number);
        const [hEnd, mEnd] = p.endTime.split(':').map(Number);
        const slotStart = new Date(startTime); slotStart.setHours(hStart, mStart, 0, 0);
        const slotEnd = new Date(startTime); slotEnd.setHours(hEnd, mEnd, 0, 0);
        if (slotEnd < slotStart) slotEnd.setDate(slotEnd.getDate() + 1);
        return Math.max(startTime.getTime(), slotStart.getTime()) < Math.min(endTime.getTime(), slotEnd.getTime());
    });

    if (hasExceptionIntersect) {
        itemsToProcess = exceptionPrices;
    } else {
        itemsToProcess = standardPrices;
    }

    for (const p of itemsToProcess) {
        const [hStart, mStart] = p.startTime.split(':').map(Number);
        const [hEnd, mEnd] = p.endTime.split(':').map(Number);

        const slotStart = new Date(startTime);
        slotStart.setHours(hStart, mStart, 0, 0);

        const slotEnd = new Date(startTime);
        slotEnd.setHours(hEnd, mEnd, 0, 0);

        if (slotEnd < slotStart) {
            slotEnd.setDate(slotEnd.getDate() + 1);
        }

        const intersect = Math.max(startTime.getTime(), slotStart.getTime()) < Math.min(endTime.getTime(), slotEnd.getTime());

        if (intersect) {
            if (p.price > maxPrice) {
                maxPrice = p.price;
            }
        }
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
