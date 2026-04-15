/**
 * setup-test-data.ts
 * Ricrea giocatori e partite di test dopo un db-reset.
 * Eseguire sul VPS con:
 *   DATABASE_URL="$(grep '^DIRECT_URL=' .env | cut -d'=' -f2-)" npx tsx src/scripts/setup-test-data.ts
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const CLUB_ID = '72fedeff-b228-42ac-b7b9-ad1339dfcb0b';

// Courts
const C1_SCOP = '38dadb7e-ced3-41a6-b08a-971b14e7e91a'; // Campo 1 scoperto
const C2_COPE = '51553bb9-44ca-4749-ac2f-77df37d4efb0'; // Campo 2 coperto
const C3_SCOP = '33848e08-3f53-4bac-b53f-ef66dd4a885b'; // Campo 3 scoperto
const C4_COPE = '9f398b9d-590e-4835-a248-bef57ff8dc88'; // Campo 4 coperto

/** Rome → UTC (CEST = UTC+2) */
function utc(y: number, mo: number, d: number, h: number, m = 0): Date {
    return new Date(Date.UTC(y, mo - 1, d, h - 2, m, 0));
}

async function main() {
    console.log('=== SETUP TEST DATA ===\n');

    // ── PLAYERS ──────────────────────────────────────────────────────────────
    console.log('[1/3] Inserimento giocatori...');
    await prisma.player.createMany({
        data: [
            // Davide: admin, dailyMessages=999 (escluso da wave), skill 3.5
            { id: 'pid-davide',    phoneNumber: '393762031767', name: 'Davide De Cupis',   gender: 'MALE',   skillLevel: 3.5, reliabilityScore: 0.90, dailyMessagesCount: 999, active: true, clubId: CLUB_ID },
            // Paola: reale, femmina, skill 3.0
            { id: 'pid-paola',     phoneNumber: '393293256828', name: 'Paola Belcastro',   gender: 'FEMALE', skillLevel: 3.0, reliabilityScore: 0.80, dailyMessagesCount: 0,   active: true, clubId: CLUB_ID },
            // Maschi sintetici
            { id: 'pid-roberto',   phoneNumber: '393288487837', name: 'Roberto De Cupis',  gender: 'MALE',   skillLevel: 3.0, reliabilityScore: 0.85, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
            { id: 'pid-christian', phoneNumber: '393517627462', name: 'Christian Giorgio', gender: 'MALE',   skillLevel: 3.5, reliabilityScore: 0.80, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
            { id: 'pid-gioele',    phoneNumber: '393278588089', name: 'Gioele De Cupis',   gender: 'MALE',   skillLevel: 3.0, reliabilityScore: 0.75, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
            { id: 'pid-alessio',   phoneNumber: '393202318987', name: 'Alessio Vannoni',   gender: 'MALE',   skillLevel: 4.0, reliabilityScore: 0.90, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
            { id: 'pid-sandro',    phoneNumber: '393888071206', name: 'Alessandro Gazzè',  gender: 'MALE',   skillLevel: 4.0, reliabilityScore: 0.85, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
            { id: 'pid-simone',    phoneNumber: '393278952301', name: 'Simone Gazzè',      gender: 'MALE',   skillLevel: 3.5, reliabilityScore: 0.80, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
            { id: 'pid-mattia',    phoneNumber: '393801871482', name: 'Mattia Vannoni',    gender: 'MALE',   skillLevel: 3.0, reliabilityScore: 0.75, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
            // Femmine
            { id: 'pid-sharon',    phoneNumber: '393762348858', name: 'Sharon Giorgio',    gender: 'FEMALE', skillLevel: 3.5, reliabilityScore: 0.85, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
            { id: 'pid-monica',    phoneNumber: '393498562866', name: 'Monica Messih',     gender: 'FEMALE', skillLevel: 3.0, reliabilityScore: 0.80, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
        ],
        skipDuplicates: true,
    });
    console.log('  ✓ 11 giocatori inseriti');

    // ── MATCHES ───────────────────────────────────────────────────────────────
    console.log('[2/3] Creazione partite...');

    /*
     * GIOVEDÌ 16 APRILE (domani)
     * ──────────────────────────
     * G1  10:00 C1  OPEN  solo donne (3/4)   → Davide NON la vede [gender filter]
     * G2  12:00 C3  OPEN  misto 2M già (2/4) → Davide NON la vede [isMixed max 2 same]
     * G3  16:00 C2  OPEN  solo maschi (3/4)  → Davide PUÒ joinare → LOCKED → gruppo WA
     * G4  18:00 C4  OPEN  misto 1M+1F (2/4)  → Davide PUÒ joinare (misto bilanciato)
     * G5  20:00 C1  OPEN  solo maschi (1/4)  → Davide PUÒ joinare (matchmaking normale)
     *
     * VENERDÌ 17 APRILE
     * ─────────────────
     * G6  10:00 C1  OPEN  solo donne (2/4)   → Paola PUÒ, Davide NO [gender filter]
     * G7  16:00 C3  OPEN  skill 5.5 (2/4)    → Davide NON la vede [fuori skill range]
     * G8  18:00 C4  LOCKED isPrivate         → non joinabile
     *
     * SABATO 18 APRILE
     * ────────────────
     * G9  10:00 C1  OPEN  solo maschi (0/4)  → Wave parte subito (nessun giocatore)
     * G10 16:00 C3  LOCKED misto (4/4)       → piena, non joinabile
     *
     * DOMENICA 19 APRILE
     * ──────────────────
     * G11 10:00 C1  OPEN  solo maschi (2/4)  → Davide PUÒ (genere OK, skill OK)
     * G12 16:00 C2  OPEN  misto (1M, 0/4→1)  → background per wave
     *
     * SETTIMANA PROSSIMA (20-24 Aprile)
     * ───────────────────────────────────
     * G13 Lun 20 10:00 C1  OPEN  solo maschi (1/4)  → test cancellazione
     * G14 Mer 22 16:00 C3  LOCKED private (4/4)     → background
     * G15 Ven 24 18:00 C1  OPEN  misto (0/4)        → test reschedule
     */

    const matches = [
        // ── GIOVEDÌ 16 ──
        { id: 'g1-donne-3su4',    courtId: C1_SCOP, startTime: utc(2026,4,16,10), isMixed: false, targetGender: 'FEMALE', skillLevel: 3.0, status: 'OPEN',   isPrivateBooking: false },
        { id: 'g2-misto-2maschi', courtId: C3_SCOP, startTime: utc(2026,4,16,12), isMixed: true,  targetGender: null,     skillLevel: 3.5, status: 'OPEN',   isPrivateBooking: false },
        { id: 'g3-maschi-3su4',   courtId: C2_COPE, startTime: utc(2026,4,16,16), isMixed: false, targetGender: 'MALE',   skillLevel: 3.5, status: 'OPEN',   isPrivateBooking: false },
        { id: 'g4-misto-1m1f',    courtId: C4_COPE, startTime: utc(2026,4,16,18), isMixed: true,  targetGender: null,     skillLevel: 3.5, status: 'OPEN',   isPrivateBooking: false },
        { id: 'g5-maschi-1su4',   courtId: C1_SCOP, startTime: utc(2026,4,16,20), isMixed: false, targetGender: 'MALE',   skillLevel: 3.5, status: 'OPEN',   isPrivateBooking: false },
        // ── VENERDÌ 17 ──
        { id: 'g6-donne-2su4',    courtId: C1_SCOP, startTime: utc(2026,4,17,10), isMixed: false, targetGender: 'FEMALE', skillLevel: 3.0, status: 'OPEN',   isPrivateBooking: false },
        { id: 'g7-skill-alto',    courtId: C3_SCOP, startTime: utc(2026,4,17,16), isMixed: false, targetGender: 'MALE',   skillLevel: 5.5, status: 'OPEN',   isPrivateBooking: false },
        { id: 'g8-locked-priv',   courtId: C4_COPE, startTime: utc(2026,4,17,18), isMixed: true,  targetGender: null,     skillLevel: 3.5, status: 'LOCKED', isPrivateBooking: true  },
        // ── SABATO 18 ──
        { id: 'g9-vuota-wave',    courtId: C1_SCOP, startTime: utc(2026,4,18,10), isMixed: false, targetGender: 'MALE',   skillLevel: 3.5, status: 'OPEN',   isPrivateBooking: false },
        { id: 'g10-piena-locked', courtId: C3_SCOP, startTime: utc(2026,4,18,16), isMixed: true,  targetGender: null,     skillLevel: 3.5, status: 'LOCKED', isPrivateBooking: false },
        // ── DOMENICA 19 ──
        { id: 'g11-maschi-2su4',  courtId: C1_SCOP, startTime: utc(2026,4,19,10), isMixed: false, targetGender: 'MALE',   skillLevel: 3.0, status: 'OPEN',   isPrivateBooking: false },
        { id: 'g12-misto-bg',     courtId: C2_COPE, startTime: utc(2026,4,19,16), isMixed: true,  targetGender: null,     skillLevel: 3.5, status: 'OPEN',   isPrivateBooking: false },
        // ── SETTIMANA PROSSIMA ──
        { id: 'g13-cancel-test',  courtId: C1_SCOP, startTime: utc(2026,4,20,10), isMixed: false, targetGender: 'MALE',   skillLevel: 3.5, status: 'OPEN',   isPrivateBooking: false },
        { id: 'g14-locked-bg',    courtId: C3_SCOP, startTime: utc(2026,4,22,16), isMixed: true,  targetGender: null,     skillLevel: 3.5, status: 'LOCKED', isPrivateBooking: true  },
        { id: 'g15-reschedule',   courtId: C1_SCOP, startTime: utc(2026,4,24,18), isMixed: true,  targetGender: null,     skillLevel: 3.5, status: 'OPEN',   isPrivateBooking: false },
    ] as const;

    for (const m of matches) {
        await (prisma.match as any).create({
            data: {
                id: m.id,
                clubId: CLUB_ID,
                courtId: m.courtId,
                startTime: m.startTime,
                skillLevel: m.skillLevel,
                isMixed: m.isMixed,
                targetGender: m.targetGender,
                status: m.status,
                isPrivateBooking: m.isPrivateBooking,
                playersNeeded: 4,
            },
        });
    }
    console.log(`  ✓ ${matches.length} partite create`);

    // ── MATCH PLAYERS ─────────────────────────────────────────────────────────
    console.log('[3/3] Associazione giocatori alle partite...');

    const mps: { matchId: string; playerId: string }[] = [
        // G1: 3 donne
        { matchId: 'g1-donne-3su4',    playerId: 'pid-sharon'    },
        { matchId: 'g1-donne-3su4',    playerId: 'pid-monica'    },
        { matchId: 'g1-donne-3su4',    playerId: 'pid-paola'     },
        // G2: 2 maschi (per testare isMixed max 2 same gender)
        { matchId: 'g2-misto-2maschi', playerId: 'pid-roberto'   },
        { matchId: 'g2-misto-2maschi', playerId: 'pid-christian' },
        // G3: 3 maschi (manca solo Davide per completare)
        { matchId: 'g3-maschi-3su4',   playerId: 'pid-roberto'   },
        { matchId: 'g3-maschi-3su4',   playerId: 'pid-christian' },
        { matchId: 'g3-maschi-3su4',   playerId: 'pid-gioele'    },
        // G4: 1M + 1F (misto equilibrato)
        { matchId: 'g4-misto-1m1f',    playerId: 'pid-simone'    },
        { matchId: 'g4-misto-1m1f',    playerId: 'pid-sharon'    },
        // G5: 1 maschio solo
        { matchId: 'g5-maschi-1su4',   playerId: 'pid-mattia'    },
        // G6: 2 donne
        { matchId: 'g6-donne-2su4',    playerId: 'pid-sharon'    },
        { matchId: 'g6-donne-2su4',    playerId: 'pid-monica'    },
        // G7: 2 maschi alto livello
        { matchId: 'g7-skill-alto',    playerId: 'pid-alessio'   },
        { matchId: 'g7-skill-alto',    playerId: 'pid-sandro'    },
        // G8: LOCKED private (4 giocatori)
        { matchId: 'g8-locked-priv',   playerId: 'pid-roberto'   },
        { matchId: 'g8-locked-priv',   playerId: 'pid-christian' },
        { matchId: 'g8-locked-priv',   playerId: 'pid-simone'    },
        { matchId: 'g8-locked-priv',   playerId: 'pid-mattia'    },
        // G9: vuota (wave parte)
        // G10: LOCKED misto (4 giocatori)
        { matchId: 'g10-piena-locked', playerId: 'pid-roberto'   },
        { matchId: 'g10-piena-locked', playerId: 'pid-christian' },
        { matchId: 'g10-piena-locked', playerId: 'pid-sharon'    },
        { matchId: 'g10-piena-locked', playerId: 'pid-monica'    },
        // G11: 2 maschi
        { matchId: 'g11-maschi-2su4',  playerId: 'pid-simone'    },
        { matchId: 'g11-maschi-2su4',  playerId: 'pid-gioele'    },
        // G12: 1 maschio (misto)
        { matchId: 'g12-misto-bg',     playerId: 'pid-mattia'    },
        // G13: 1 maschio (test cancellazione)
        { matchId: 'g13-cancel-test',  playerId: 'pid-roberto'   },
        // G14: LOCKED private (4 giocatori)
        { matchId: 'g14-locked-bg',    playerId: 'pid-alessio'   },
        { matchId: 'g14-locked-bg',    playerId: 'pid-sandro'    },
        { matchId: 'g14-locked-bg',    playerId: 'pid-simone'    },
        { matchId: 'g14-locked-bg',    playerId: 'pid-mattia'    },
        // G15: vuota (test reschedule)
    ];

    await prisma.matchPlayer.createMany({ data: mps, skipDuplicates: true });
    console.log(`  ✓ ${mps.length} MatchPlayer inseriti`);

    // ── RIEPILOGO ─────────────────────────────────────────────────────────────
    console.log('\n=== SCENARI DI TEST ===\n');
    console.log('GIO 16/04');
    console.log('  G1  10:00 C1 scoperto — OPEN solo donne (3/4) → Davide NON la vede');
    console.log('  G2  12:00 C3 scoperto — OPEN misto 2M (2/4)  → Davide NON la vede (max 2 stessi)');
    console.log('  G3  16:00 C2 coperto  — OPEN solo maschi (3/4)→ Davide PUÒ entrare → LOCKED → gruppo WA');
    console.log('  G4  18:00 C4 coperto  — OPEN misto 1M+1F (2/4)→ Davide PUÒ entrare');
    console.log('  G5  20:00 C1 scoperto — OPEN solo maschi (1/4)→ matchmaking normale');
    console.log('VEN 17/04');
    console.log('  G6  10:00 C1 scoperto — OPEN solo donne (2/4) → Paola PUÒ, Davide NO');
    console.log('  G7  16:00 C3 scoperto — OPEN skill 5.5 (2/4)  → Davide NON la vede (range ±1)');
    console.log('  G8  18:00 C4 coperto  — LOCKED privata (4/4)  → non joinabile');
    console.log('SAB 18/04');
    console.log('  G9  10:00 C1 scoperto — OPEN vuota (0/4)      → wave parte (test wave)');
    console.log('  G10 16:00 C3 scoperto — LOCKED misto (4/4)    → non joinabile');
    console.log('DOM 19/04');
    console.log('  G11 10:00 C1 scoperto — OPEN maschi (2/4)     → Davide PUÒ');
    console.log('  G12 16:00 C2 coperto  — OPEN misto (1/4)      → background wave');
    console.log('SETTIMANA PROSSIMA');
    console.log('  G13 Lun 20 10:00 C1  — OPEN maschi (1/4)      → test cancellazione');
    console.log('  G14 Mer 22 16:00 C3  — LOCKED privata          → background');
    console.log('  G15 Ven 24 18:00 C1  — OPEN misto (0/4)       → test reschedule');

    await prisma.$disconnect();
    await pool.end();
    console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
