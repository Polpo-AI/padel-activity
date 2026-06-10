import 'dotenv/config';
import { handleBatch } from '../services/messageHandler';

const phone = process.argv[2];
const text = process.argv[3] || 'Ciao';

async function run() {
    if (!phone) {
        console.error('Usage: npx tsx src/scripts/replay-pending.ts <phone> [text]');
        process.exit(1);
    }

    console.log(`Replaying message "${text}" for ${phone}...`);

    await handleBatch(`${phone}@s.whatsapp.net`, [{
        type: 'text',
        text,
        clubId: undefined,
        alreadyPersisted: true,
        raw: {
            key: { id: `REPLAY_${Date.now()}`, remoteJid: `${phone}@s.whatsapp.net`, fromMe: false },
            pushName: phone,
            messageTimestamp: Math.floor(Date.now() / 1000),
            message: { conversation: text },
        } as any,
    }]);

    console.log('Done.');
}

run().catch(e => { console.error(e); process.exit(1); });
