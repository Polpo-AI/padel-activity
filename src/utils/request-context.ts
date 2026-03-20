/**
 * REQUEST CONTEXT — Correlation ID via AsyncLocalStorage
 *
 * Permette di tracciare un singolo messaggio attraverso tutto il pipeline
 * (inbound → handler → wave → AI → outbound) senza passare l'id a mano.
 *
 * Uso:
 *   import { runWithContext, getCorrelationId } from '../utils/request-context';
 *
 *   // All'inizio del processing:
 *   runWithContext({ correlationId: `${jid}-${Date.now()}` }, () => processMessage(msg));
 *
 *   // Ovunque nel pipeline:
 *   logger.info({ correlationId: getCorrelationId() }, 'Doing something');
 */

import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
    correlationId: string;
    jid?: string;
    clubId?: string; // quale club sta processando questo messaggio/job
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

export function runWithContext(ctx: RequestContext, fn: () => void | Promise<void>) {
    return requestContext.run(ctx, fn);
}

export function getCorrelationId(): string | undefined {
    return requestContext.getStore()?.correlationId;
}

export function getContextStore(): RequestContext | undefined {
    return requestContext.getStore();
}

export function getClubId(): string | undefined {
    return requestContext.getStore()?.clubId;
}
