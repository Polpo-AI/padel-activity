const fs = require('fs');

// 1. messageHandler.ts
let mh = fs.readFileSync('src/services/messageHandler.ts', 'utf8');
mh = mh.replace(/downloadMediaMessage\(msg\.raw, /g, 'downloadMediaMessage(msg.raw as any, ');
// fix remaining findUnique
mh = mh.replace(/prisma\.player\.findUnique/g, 'prisma.player.findFirst');
fs.writeFileSync('src/services/messageHandler.ts', mh);

// 2. redirect.ts
let rd = fs.readFileSync('src/services/redirect.ts', 'utf8');
rd = rd.replace(/court: string;\n    startTime: Date;/g, 'court: string;\n    courtId?: string | null;\n    startTime: Date;');
rd = rd.replace(/court: match\.court\?\.name \|\| 'Campo',/g, "court: match.court?.name || 'Campo',\n                courtId: match.courtId,");

// line 344 createMatchForGroup
rd = rd.replace(/courtId: option\.court,/g, 'courtId: option.courtId || null,');

// findFreeSlots return
rd = rd.replace(/const courts = clubCourts\.map\(c => c\.name\);/g, 'const courts = clubCourts;');
rd = rd.replace(/const freeCourt = courts\.find\(c => !occupiedCourts\.has\(c\)\);/g, 'const freeCourt = courts.find(c => !occupiedCourts.has(c.name));');
rd = rd.replace(/return { court: freeCourt, startTime: nextDay };/g, 'return { court: freeCourt.name, courtId: freeCourt.id, startTime: nextDay };');

fs.writeFileSync('src/services/redirect.ts', rd);

console.log("Refactoring completato.");
