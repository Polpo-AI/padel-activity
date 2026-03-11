import { connectToWhatsApp } from '../src/services/whatsapp';

async function run() {
    console.log("Starting local WA authentication to generate the session locally...");
    await connectToWhatsApp();
}

run();
