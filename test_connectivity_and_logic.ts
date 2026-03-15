
import * as dotenv from 'dotenv';
dotenv.config();

// We must use dynamic imports for everything else because 
// modules like 'ai.ts' initialize clients at top-level.
async function verify() {
    const { prisma } = await import('./src/services/db');
    const { getRedis } = await import('./src/services/queue');
    const { handleFluidConversation } = await import('./src/services/conversational-manager');

    console.log("🚀 Testing Padel Bot Connectivity & Logic...\n");

    // 1. Check DB
    try {
        console.log("📡 Checking Database...");
        const clubCount = await prisma.club.count();
        console.log(`✅ Database reachable! Found ${clubCount} clubs.`);
    } catch (err: any) {
        console.error("❌ Database Error:", err.message);
    }

    // 2. Check Redis
    try {
        console.log("📚 Checking Redis...");
        const redis = getRedis();
        await redis.set('test_connectivity', 'ok', 'EX', 10);
        const val = await redis.get('test_connectivity');
        console.log(`✅ Redis reachable! Test key: ${val}`);
    } catch (err: any) {
        console.error("❌ Redis Error:", err.message);
    }

    // 3. Check AI & Logic
    try {
        console.log("\n🧠 Testing Logic (Conversational Manager)...");
        const club = await prisma.club.findFirst();
        if (!club) throw new Error("No club found for logic test");

        const testJid = "393470000000@s.whatsapp.net";
        const testContext = {
            jid: testJid,
            phoneNumber: "393470000000",
            player: {
                id: "test-player-1",
                phoneNumber: "393470000000",
                name: "Davide",
                skillLevel: 2,
                gender: "MALE"
            } as any,
            club: club as any,
            recentMessages: []
        };

        console.log("Test Msg: 'Vorrei organizzare una partita livello 2 per domani alle 18'");
        const action = await handleFluidConversation(
            testContext,
            "Vorrei organizzare una partita livello 2 per domani alle 18"
        );

        if (action) {
            console.log("✅ Logic OK! Bot detected action:", JSON.stringify(action, null, 2));
        } else {
            console.log("⚠️ Logic Warning: Bot returned generic AI response (no structured action).");
        }
    } catch (err: any) {
        console.error("❌ Logic Error:", err.message);
    }

    console.log("\n✅ Verification sequence completed.");
    process.exit(0);
}

verify().catch(e => {
    console.error("💥 Fatal Error:", e);
    process.exit(1);
});
