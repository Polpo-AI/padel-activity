import { prisma } from '../src/services/db';
import * as dotenv from 'dotenv';

dotenv.config();

const CLUB_ID = 'ebff5173-3fd4-4beb-b919-f904343bd551';

async function run() {
    console.log(`🛠️ Verifico e aggiorno dati test per Club ${CLUB_ID}...`);

    try {
        // 1. Aggiorna adminPhone del Club
        const club = await prisma.club.update({
            where: { id: CLUB_ID },
            data: {
                adminPhone: '3457991255',
            }
        });
        console.log(`✅ Club aggiornato! adminPhone impostato a: ${club.adminPhone}`);

        // 2. Verifica e forza i Campi (Coperto e Scoperto)
        const courts = await prisma.court.findMany({
            where: { clubId: CLUB_ID }
        });

        console.log(`Found ${courts.length} courts.`);

        let hasCovered = courts.some(c => c.isCovered);
        let hasUncovered = courts.some(c => !c.isCovered);

        if (!hasCovered) {
             const cCourts = courts.filter(c => !c.isCovered);
             if (cCourts.length > 0) {
                 await prisma.court.update({
                     where: { id: cCourts[0].id },
                     data: { isCovered: true, name: 'Campo Interno (Coperto)' }
                 });
                 console.log("✅ Aggiornato un campo esistente per essere COPERTO.");
             } else {
                 await prisma.court.create({
                     data: {
                         clubId: CLUB_ID,
                         name: 'Campo Centrale Coperto',
                         isCovered: true,
                         active: true
                     }
                 });
                 console.log("✅ Creato un nuovo campo COPERTO.");
             }
        } else {
             console.log("✅ Un campo COPERTO è già presente.");
        }

        if (!hasUncovered) {
             const uCourts = courts.filter(c => c.isCovered);
             if (uCourts.length > 0) {
                 await prisma.court.update({
                     where: { id: uCourts[0].id },
                     data: { isCovered: false, name: 'Campo Esterno (Scoperto)' }
                 });
                 console.log("✅ Aggiornato un campo esistente per essere SCOPERTO.");
             } else {
                 await prisma.court.create({
                     data: {
                         clubId: CLUB_ID,
                         name: 'Campo Esterno Scoperto',
                         isCovered: false,
                         active: true
                     }
                 });
                 console.log("✅ Creato un nuovo campo SCOPERTO.");
             }
        } else {
             console.log("✅ Un campo SCOPERTO è già presente.");
        }

        console.log("\n=== ✅ SETUP DATI TEST COMPLETATO ===");

    } catch (error) {
        console.error("❌ Errore:", error);
    }
}

run();
