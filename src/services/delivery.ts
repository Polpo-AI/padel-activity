/**
 * DELIVERY / RINVIO (Punto 3)
 *
 * Scansione periodica (maintenance worker) dei messaggi IMPORTANTI che non sono mai
 * usciti davvero (status 0=ERROR o 1=PENDING dopo 1h): rinvio UNA volta, verbatim (zero
 * costo AI). Gestisce inoltre:
 *  - numero cambiato/dismesso → onWhatsApp() → disattiva
 *  - dormienza (sospetto blocco): 5 non consegnati consecutivi OR 60 giorni senza
 *    consegne né risposte (e account abbastanza vecchio) → stop generazione+invio.
 *
 * ⚠️ Soglia `deliveryStatus < 2`, NON `< 3`. In produzione WhatsApp spesso non ritorna mai
 * il DELIVERY_ACK (status 3): ogni messaggio si ferma a SERVER_ACK (2). Usare `< 3` faceva
 * auto-rispedire OGNI invito important dopo 1h (anche quelli già ricevuti e accettati →
 * giocatore reinvitato a una partita in cui era già dentro). SERVER_ACK (2) significa che i
 * server WhatsApp hanno PRESO il messaggio: è "inviato", non va rispedito. Si rinvia solo ciò
 * che è genuinamente bloccato lato nostro (mai arrivato al server).
 */

import { prisma } from './db';
import { runWithContext } from '../utils/request-context';
import { sendMessage, isOnWhatsApp } from './whatsapp';
import pino from 'pino';

const logger = pino({ level: 'info' });

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DORMANT_DAYS = 60;
const DORMANT_CONSECUTIVE = 5;

export async function resendUndeliveredMessages(): Promise<void> {
    const now = Date.now();
    const oneHourAgo = new Date(now - HOUR);
    const dayAgo = new Date(now - DAY);

    // Importanti, mai usciti davvero (ERROR/PENDING), mai rinviati, inviati tra 1h e 24h fa.
    const stuck = await prisma.whatsAppMessage.findMany({
        where: {
            role: 'BOT',
            important: true,
            resentAt: null,
            deliveryStatus: { lt: 2 },
            timestamp: { gte: dayAgo, lte: oneHourAgo },
            messageId: { not: null },
        },
        orderBy: { timestamp: 'asc' },
        take: 50,
    });

    if (stuck.length === 0) return;
    logger.info({ count: stuck.length }, 'resendUndelivered: messaggi non consegnati da rinviare');

    const sixtyDaysAgo = new Date(now - DORMANT_DAYS * DAY);

    for (const msg of stuck) {
        const phone = msg.chatId.split('@')[0].replace(/\D/g, '');
        const player = await prisma.player.findFirst({
            where: { phoneNumber: phone, ...(msg.clubId ? { clubId: msg.clubId } : {}) },
        });

        // Marca resentAt SUBITO: evita doppio invio se la scansione si sovrappone.
        await prisma.whatsAppMessage.update({ where: { id: msg.id }, data: { resentAt: new Date() } }).catch(() => {});

        // Il giocatore ha SCRITTO dopo che abbiamo inviato questo messaggio?
        // Allora l'ha ricevuto eccome — la spunta di consegna (deliveryStatus 3) semplicemente
        // non è mai arrivata da WhatsApp (succede spesso). Rinviarlo creerebbe solo un duplicato:
        // è esattamente come un invito già accettato che viene riproposto a chi è già in partita.
        // Non rinviare.
        if (player?.lastInboundAt && player.lastInboundAt > msg.timestamp) {
            logger.info({ phone, msgId: msg.id }, 'resendUndelivered: skip — il giocatore ha risposto dopo l\'invio');
            continue;
        }

        // Già dormiente → non insistere (lo riattiva un suo messaggio in entrata).
        if (player?.dormantSince) continue;

        // Numero ancora su WhatsApp? Se no → cambiato/dismesso → disattiva.
        const onWa = await isOnWhatsApp(msg.chatId, msg.clubId);
        if (onWa === false) {
            if (player) {
                await prisma.player.update({ where: { id: player.id }, data: { active: false } }).catch(() => {});
                logger.info({ phone }, 'resendUndelivered: numero non più su WhatsApp → disattivato');
            }
            continue;
        }

        // Rinvio verbatim via il socket del club (nessun costo AI).
        try {
            await runWithContext({ clubId: msg.clubId ?? undefined } as any, async () => {
                await sendMessage(msg.chatId, msg.content);
            });
        } catch (err) {
            logger.warn({ err, msgId: msg.id }, 'resendUndelivered: rinvio fallito');
        }

        // Bookkeeping dormienza.
        if (player) {
            const newCount = (player.consecutiveUndelivered || 0) + 1;
            const oldEnough = player.createdAt < sixtyDaysAgo;
            const noRecentDelivery = !player.lastDeliveredAt || player.lastDeliveredAt < sixtyDaysAgo;
            const noRecentInbound = !player.lastInboundAt || player.lastInboundAt < sixtyDaysAgo;
            const dormant = newCount >= DORMANT_CONSECUTIVE || (oldEnough && noRecentDelivery && noRecentInbound);
            await prisma.player.update({
                where: { id: player.id },
                data: { consecutiveUndelivered: newCount, ...(dormant ? { dormantSince: new Date() } : {}) },
            }).catch(() => {});
            if (dormant) logger.info({ phone, newCount }, 'resendUndelivered: giocatore marcato dormiente');
        }
    }
}
