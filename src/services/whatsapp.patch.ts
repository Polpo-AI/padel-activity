// ─────────────────────────────────────────────────────────────────
// PATCH per whatsapp.ts
//
// Sostituire il listener messages.upsert esistente con questo:
// ─────────────────────────────────────────────────────────────────

// In cima al file, aggiungere import:
import { enqueue } from './inbound-queue';

// Sostituire il blocco sock.ev.on('messages.upsert', ...) con:
sock.ev.on('messages.upsert', (m) => {
    if (m.type !== 'notify') return;
    for (const msg of m.messages) {
        if (!msg.key.fromMe && msg.message) {
            enqueue(msg); // ← ora passa per la inbound queue (debounce 5s)
        }
    }
});

// Aggiungere DOPO il listener messages.upsert:
sock.ev.on('group-participants.update', async (update) => {
    const { handleGroupParticipantUpdate } = await import('./group-handler');
    await handleGroupParticipantUpdate(update).catch(err =>
        logger.error({ err }, 'Error in group-participants.update handler')
    );
});


// ─────────────────────────────────────────────────────────────────
// PATCH simulateTypingAndSend — integrare rate limiter globale
//
// In whatsapp.ts, la funzione simulateTypingAndSend deve wrappare
// l'invio effettivo con enqueueSend per serializzare tutti gli invii.
// Sostituire l'implementazione con:
// ─────────────────────────────────────────────────────────────────

import { enqueueSend } from './whatsapp-rate-limiter';

// Sostituire simulateTypingAndSend con:
export async function simulateTypingAndSend(
    jid: string,
    text: string,
    quotedKey?: any
): Promise<void> {
    return enqueueSend(jid, async () => {
        // Simula digitazione
        await sock.sendPresenceUpdate('composing', jid);
        const typingMs = Math.min(text.length * 40 + Math.random() * 1000, 4000);
        await new Promise(r => setTimeout(r, typingMs));
        await sock.sendPresenceUpdate('paused', jid);

        const msg: any = { text };
        if (quotedKey) msg.quoted = { key: quotedKey };
        await sock.sendMessage(jid, msg);

        // Persisti messaggio BOT
        try {
            const { prisma } = await import('./db');
            await prisma.whatsAppMessage.create({
                data: {
                    chatId: jid,
                    sender: 'BOT',
                    role: 'BOT',
                    content: text,
                },
            });
        } catch {}
    });
}

// getConnectionStatus — usato dal health check
export function getConnectionStatus(): 'open' | 'connecting' | 'closed' {
    if (!sock) return 'closed';
    // Baileys non espone direttamente lo stato — usiamo la variabile di modulo
    return connectionStatus;
}
// Aggiungere in cima al modulo whatsapp.ts:
// let connectionStatus: 'open' | 'connecting' | 'closed' = 'connecting';
// E nell'handler connection.update:
// if (connection === 'open') connectionStatus = 'open';
// if (connection === 'close') connectionStatus = 'closed';
