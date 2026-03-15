import { prisma } from './db';
import pino from 'pino';

const logger = pino({ level: 'info' });

/**
 * Calcola il costo totale di una partita (90 minuti)
 * Regola: (Tariffa oraria più alta tra gli slot coinvolti) * 1.5
 */
export async function calculateMatchCost(matchId: string): Promise<number> {
    try {
        const match = await prisma.match.findUnique({
            where: { id: matchId },
            include: { court: { include: { prices: true } } },
        });

        if (!match || !match.court) {
            return 0;
        }

        const startTime = match.startTime;
        const endTime = new Date(startTime.getTime() + 90 * 60 * 1000); // 90 min

        const prices = match.court.prices;
        if (prices.length === 0) {
            return 0; // fallback se il gestore non ha configurato prezzi
        }

        // 1. Filtra per periodo (startDate / endDate)
        const validPrices = prices.filter((p: any) => {
            if (p.startDate && startTime < p.startDate) return false;
            if (p.endDate && startTime > p.endDate) return false;
            return true;
        });

        // 2. Trova la tariffa massima tra quelle che si intersecano con [startTime, endTime]
        let maxPrice = 0;

        for (const p of validPrices) {
            const [hStart, mStart] = p.startTime.split(':').map(Number);
            const [hEnd, mEnd] = p.endTime.split(':').map(Number);

            const slotStart = new Date(startTime);
            slotStart.setHours(hStart, mStart, 0, 0);

            const slotEnd = new Date(startTime);
            slotEnd.setHours(hEnd, mEnd, 0, 0);

            if (slotEnd < slotStart) {
                // Se lo slot passa la mezzanotte (raro)
                slotEnd.setDate(slotEnd.getDate() + 1);
            }

            // Condizione intersezione: max(start) < min(end)
            const intersect = Math.max(startTime.getTime(), slotStart.getTime()) < Math.min(endTime.getTime(), slotEnd.getTime());

            if (intersect) {
                if (p.price > maxPrice) {
                    maxPrice = p.price;
                }
            }
        }

        // Se non troviamo match orari (es. slot non configurato), prendiamo la prima tariffa come fallback
        if (maxPrice === 0 && validPrices.length > 0) {
            maxPrice = Math.max(...validPrices.map((p: any) => p.price));
        }

        return maxPrice * 1.5;
    } catch (err) {
        logger.error({ err, matchId }, 'Error calculating match cost');
        return 0;
    }
}
