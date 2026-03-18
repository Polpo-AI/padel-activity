/**
 * CIRCUIT BREAKER
 *
 * Protegge le chiamate AI da cascate di fallimenti.
 * Stati:
 *   CLOSED    → operazione normale
 *   OPEN      → fallback immediato, nessuna chiamata verso l'esterno
 *   HALF_OPEN → dopo il cooldown, prova una chiamata; se ok → CLOSED, altrimenti → OPEN
 */

import pino from 'pino';

const logger = pino({ level: 'info' });

type State = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class CircuitBreaker {
    private state: State = 'CLOSED';
    private failures = 0;
    private nextRetryAt = 0;

    constructor(
        private readonly name: string,
        private readonly threshold = 5,       // fallimenti consecutivi per aprire
        private readonly cooldownMs = 60_000  // ms in OPEN prima di HALF_OPEN
    ) {}

    async call<T>(fn: () => Promise<T>, fallback: () => T): Promise<T> {
        if (this.state === 'OPEN') {
            if (Date.now() < this.nextRetryAt) return fallback();
            this.state = 'HALF_OPEN';
            logger.info(`CircuitBreaker[${this.name}] → HALF_OPEN, testing...`);
        }

        try {
            const result = await fn();
            this.onSuccess();
            return result;
        } catch (err) {
            this.onFailure();
            return fallback();
        }
    }

    private onSuccess() {
        if (this.state !== 'CLOSED') {
            logger.info(`CircuitBreaker[${this.name}] → CLOSED (recovered)`);
        }
        this.failures = 0;
        this.state = 'CLOSED';
    }

    private onFailure() {
        this.failures++;
        if (this.state === 'HALF_OPEN' || this.failures >= this.threshold) {
            this.state = 'OPEN';
            this.nextRetryAt = Date.now() + this.cooldownMs;
            logger.error(
                `CircuitBreaker[${this.name}] → OPEN (${this.failures} failures, retry in ${this.cooldownMs / 1000}s)`
            );
            // Notifica admin in background — non blocca il fallback
            import('../utils/notify-admin').then(({ notifyAdmin }) =>
                notifyAdmin(
                    `⚠️ Circuit breaker *${this.name}* aperto — fallback attivo per ${this.cooldownMs / 1000}s`,
                    `circuit-breaker-${this.name}`
                )
            ).catch(() => {});
        }
    }

    get isOpen() { return this.state === 'OPEN'; }
}

// Singleton per le chiamate Claude — condiviso tra classifyIntent e generateInvitation
export const claudeCircuitBreaker = new CircuitBreaker('claude', 5, 60_000);
