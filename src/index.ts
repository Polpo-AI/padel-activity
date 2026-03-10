import express from 'express';
import dotenv from 'dotenv';
import pino from 'pino';
import { connectToWhatsApp } from './services/whatsapp';
import webhooksRouter from './api/webhooks';
// Import workers so they start processing queues
import './workers/wave.worker';
import './workers/reminder.worker';

dotenv.config();
const logger = pino({ level: 'info' });

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'padel-match-filler' });
});

// Register webhook routes
app.use('/api', webhooksRouter);

app.listen(PORT, async () => {
    logger.info(`Server is running on port ${PORT}...`);

    // Initialize Baileys WhatsApp Connection
    try {
        await connectToWhatsApp();
    } catch (error) {
        logger.error({ error }, 'Failed to start WhatsApp Service');
    }
});
