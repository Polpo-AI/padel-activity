/**
 * setup-test-data.ts
 * Ricrea giocatori e partite di test dopo un db-reset.
 * Eseguire sul VPS con:
 *   DATABASE_URL='postgresql://postgres.xxx:pw@host:5432/postgres' npx tsx src/scripts/setup-test-data.ts
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
            { id: 'pid-davide',    phoneNumber: '393762031767', name: 'Davide De Cupis',   gender: 'MALE',   skillLevel: 3.5, reliabilityScore: 0.33, dailyMessagesCount: 999, active: true, clubId: CLUB_ID },
            // Paola: reale, femmina, skill 3.0
            { id: 'pid-paola',     phoneNumber: '393293256828', name: 'Paola Belcastro',   gender: 'FEMALE', skillLevel: 3.0, reliabilityScore: 0.33, dailyMessagesCount: 0,   active: true, clubId: CLUB_ID },
            // Maschi
            { id: 'pid-roberto',   phoneNumber: '393288487837', name: 'Roberto De Cupis',  gender: 'MALE',   skillLevel: 3.0, reliabilityScore: 0.33, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
            { id: 'pid-christian', phoneNumber: '393517627462', name: 'Christian Giorgio', gender: 'MALE',   skillLevel: 3.5, reliabilityScore: 0.33, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
            { id: 'pid-gioele',    phoneNumber: '393278588089', name: 'Gioele De Cupis',   gender: 'MALE',   skillLevel: 3.0, reliabilityScore: 0.33, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
            { id: 'pid-alessio',   phoneNumber: '393202318987', name: 'Alessio Vannoni',   gender: 'MALE',   skillLevel: 4.0, reliabilityScore: 0.33, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
            { id: 'pid-sandro',    phoneNumber: '393888071206', name: 'Alessandro Gazzè',  gender: 'MALE',   skillLevel: 4.0, reliabilityScore: 0.33, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
            { id: 'pid-simone',    phoneNumber: '393278952301', name: 'Simone Gazzè',      gender: 'MALE',   skillLevel: 3.5, reliabilityScore: 0.33, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
            { id: 'pid-mattia',    phoneNumber: '393801871482', name: 'Mattia Vannoni',    gender: 'MALE',   skillLevel: 3.0, reliabilityScore: 0.33, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
            // Femmine
            { id: 'pid-sharon',    phoneNumber: '393762348858', name: 'Sharon Giorgio',    gender: 'FEMALE', skillLevel: 3.5, reliabilityScore: 0.33, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
            { id: 'pid-monica',    phoneNumber: '393498562866', name: 'Monica Messih',     gender: 'FEMALE', skillLevel: 3.0, reliabilityScore: 0.33, dailyMessagesCount: 0, active: true, clubId: CLUB_ID },
        ],
        skipDuplicates: true,
    });
    console.log('  ✓ 11 giocatori inseriti (reliabilityScore: 0.33)');

    // ── MATCHES ───────────────────────────────────────────────────────────────
    console.log('[2/3] Creazione partite...');

    /*
     * Scenari mirati ai fix recenti. Solo 5 OPEN attive (wave non brucia il pool).
     * Verificare i giorni: Apr 17=Ven, 18=Sab, 19=Dom, 20=Lun, 22=Mer, 24=Ven.
     *
     * VENERDÌ 17 APRILE
     * ─────────────────
     * M1  16:00 C2 cop  OPEN  solo maschi (2/4) [Roberto+Christian]
     *     → TEST join: Davide si unisce → diventa 3°; wave trova 4° → LOCKED → gruppo WA
     * M2  18:00 C4 cop  LOCKED privata (4/4) [Alessio+Sandro+Simone+Mattia]
     *     → sfondo, wave non parte
     *
     * SABATO 18 APRILE
     * ────────────────
     * M3  10:00 C1 scop OPEN  misto 2M (2/4) [Simone+Mattia]
     *     → TEST wave gender: invita solo donne (non altri maschi)
     *     → TEST cancel: Simone cancella → sblocco IGNORED donne → wave riparte
     * M4  16:00 C3 scop OPEN  solo donne (2/4) [Sharon+Monica]
     *     → TEST filtro genere: Paola PUÒ joinare, Davide NO
     * M5  20:00 C2 cop  LOCKED misto (4/4) [Roberto+Christian+Sharon+Monica]
     *     → sfondo
     *
     * DOMENICA 19 APRILE
     * ──────────────────
     * M6  10:00 C1 scop OPEN  solo maschi (1/4) [Gioele]
     *     → TEST cancellazione: Gioele cancella → wave riparte da 0/4
     * M7  16:00 C4 cop  LOCKED privata (4/4) [Alessio+Sandro+Roberto+Gioele]
     *     → sfondo
     *
     * LUNEDÌ 20 APRILE
     * ────────────────
     * M8  10:00 C3 scop OPEN  misto vuoto (0/4)
     *     → TEST preferredPlayerName: "io e Sharon vorremmo giocare, trovaci 2"
     *     → TEST wave misto normale
     *
     * MERCOLEDÌ 22 APRILE
     * ───────────────────
     * M9  16:00 C2 cop  LOCKED privata (4/4) [Christian+Simone+Mattia+Sharon]
     *     → sfondo
     *
     * VENERDÌ 24 APRILE
     * ─────────────────
     * M10 18:00 C1 scop OPEN  misto 1M+1F (2/4) [Roberto+Paola]
     *     → TEST misto bilanciato: Davide PUÒ (1M+1F già dentro, max 2 per genere OK)
     *     → TEST wave: cerca 1M e 1F rimanenti
     */

    const matches = [
        // ── VENERDÌ 17 ──
        { id: 'm1-maschi-2su4',   courtId: C2_COPE, startTime: utc(2026,4,17,16), isMixed: false, targetGender: 'MALE',   skillLevel: 3.5, status: 'OPEN',   isPrivateBooking: false },
        { id: 'm2-locked-priv',   courtId: C4_COPE, startTime: utc(2026,4,17,18), isMixed: false, targetGender: null,     skillLevel: 3.5, status: 'LOCKED', isPrivateBooking: true  },
        // ── SABATO 18 ──
        { id: 'm3-misto-2m',      courtId: C1_SCOP, startTime: utc(2026,4,18,10), isMixed: true,  targetGender: null,     skillLevel: 3.5, status: 'OPEN',   isPrivateBooking: false },
        { id: 'm4-donne-2su4',    courtId: C3_SCOP, startTime: utc(2026,4,18,16), isMixed: false, targetGender: 'FEMALE', skillLevel: 3.0, status: 'OPEN',   isPrivateBooking: false },
        { id: 'm5-locked-misto',  courtId: C2_COPE, startTime: utc(2026,4,18,20), isMixed: true,  targetGender: null,     skillLevel: 3.5, status: 'LOCKED', isPrivateBooking: false },
        // ── DOMENICA 19 ──
        { id: 'm6-cancel-test',   courtId: C1_SCOP, startTime: utc(2026,4,19,10), isMixed: false, targetGender: 'MALE',   skillLevel: 3.5, status: 'OPEN',   isPrivateBooking: false },
        { id: 'm7-locked-priv2',  courtId: C4_COPE, startTime: utc(2026,4,19,16), isMixed: false, targetGender: null,     skillLevel: 3.5, status: 'LOCKED', isPrivateBooking: true  },
        // ── LUNEDÌ 20 ──
        { id: 'm8-misto-vuoto',   courtId: C3_SCOP, startTime: utc(2026,4,20,10), isMixed: true,  targetGender: null,     skillLevel: 3.5, status: 'OPEN',   isPrivateBooking: false },
        // ── MERCOLEDÌ 22 ──
        { id: 'm9-locked-bg',     courtId: C2_COPE, startTime: utc(2026,4,22,16), isMixed: false, targetGender: null,     skillLevel: 3.5, status: 'LOCKED', isPrivateBooking: true  },
        // ── VENERDÌ 24 ──
        { id: 'm10-misto-1m1f',   courtId: C1_SCOP, startTime: utc(2026,4,24,18), isMixed: true,  targetGender: null,     skillLevel: 3.5, status: 'OPEN',   isPrivateBooking: false },
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
    console.log(`  ✓ ${matches.length} partite create (5 OPEN, 5 LOCKED)`);

    // ── MATCH PLAYERS ─────────────────────────────────────────────────────────
    console.log('[3/3] Associazione giocatori alle partite...');

    const mps: { matchId: string; playerId: string }[] = [
        // M1: 2 maschi (Davide si aggiunge → 3°, wave trova 4° → LOCKED+gruppo)
        { matchId: 'm1-maschi-2su4',   playerId: 'pid-roberto'   },
        { matchId: 'm1-maschi-2su4',   playerId: 'pid-christian' },
        // M2: LOCKED privata — solo chi ha prenotato (gli altri si organizzano fuori sistema)
        { matchId: 'm2-locked-priv',   playerId: 'pid-alessio'   },
        // M3: 2 maschi — wave deve invitare SOLO donne
        { matchId: 'm3-misto-2m',      playerId: 'pid-simone'    },
        { matchId: 'm3-misto-2m',      playerId: 'pid-mattia'    },
        // M4: 2 donne — Paola può entrare, Davide no
        { matchId: 'm4-donne-2su4',    playerId: 'pid-sharon'    },
        { matchId: 'm4-donne-2su4',    playerId: 'pid-monica'    },
        // M5: LOCKED misto (4/4)
        { matchId: 'm5-locked-misto',  playerId: 'pid-roberto'   },
        { matchId: 'm5-locked-misto',  playerId: 'pid-christian' },
        { matchId: 'm5-locked-misto',  playerId: 'pid-sharon'    },
        { matchId: 'm5-locked-misto',  playerId: 'pid-monica'    },
        // M6: 1 maschio — Gioele cancella → wave riparte 0/4
        { matchId: 'm6-cancel-test',   playerId: 'pid-gioele'    },
        // M7: LOCKED privata — solo chi ha prenotato
        { matchId: 'm7-locked-priv2',  playerId: 'pid-alessio'   },
        // M8: vuota — test preferredPlayerName
        // M9: LOCKED privata — solo chi ha prenotato
        { matchId: 'm9-locked-bg',     playerId: 'pid-christian' },
        // M10: 1M+1F — misto bilanciato, Davide PUÒ entrare
        { matchId: 'm10-misto-1m1f',   playerId: 'pid-roberto'   },
        { matchId: 'm10-misto-1m1f',   playerId: 'pid-paola'     },
    ];

    await prisma.matchPlayer.createMany({ data: mps, skipDuplicates: true });
    console.log(`  ✓ ${mps.length} MatchPlayer inseriti`);

    // ── RIEPILOGO ─────────────────────────────────────────────────────────────
    console.log('\n=== SCENARI DI TEST ===\n');
    console.log('VEN 17/04');
    console.log('  M1  16:00 C2 cop  OPEN  maschi (2/4)    [Roberto+Christian]  → Davide si unisce → LOCKED → gruppo WA');
    console.log('  M2  18:00 C4 cop  LOCKED privata (4/4)                       → sfondo');
    console.log('SAB 18/04');
    console.log('  M3  10:00 C1 scop OPEN  misto 2M (2/4)  [Simone+Mattia]      → wave invita SOLO donne; cancel Simone → sblocco');
    console.log('  M4  16:00 C3 scop OPEN  donne (2/4)     [Sharon+Monica]      → Paola PUÒ, Davide NO');
    console.log('  M5  20:00 C2 cop  LOCKED misto (4/4)                         → sfondo');
    console.log('DOM 19/04');
    console.log('  M6  10:00 C1 scop OPEN  maschi (1/4)    [Gioele]             → Gioele cancella → wave riparte 0/4');
    console.log('  M7  16:00 C4 cop  LOCKED privata (4/4)                       → sfondo');
    console.log('LUN 20/04');
    console.log('  M8  10:00 C3 scop OPEN  misto vuoto (0/4)                    → preferredPlayerName + wave misto');
    console.log('MER 22/04');
    console.log('  M9  16:00 C2 cop  LOCKED privata (4/4)                       → sfondo');
    console.log('VEN 24/04');
    console.log('  M10 18:00 C1 scop OPEN  misto 1M+1F (2/4) [Roberto+Paola]   → Davide PUÒ (bilanciato); wave 1M+1F');
    console.log('\nPool wave: Paola, Gioele, Alessio, Sandro, Sharon, Monica (non in tutte le partite)');

    await prisma.$disconnect();
    await pool.end();
    console.log('\nDone.');
}

main().catch(e => { console.error(e); process.exit(1); });
