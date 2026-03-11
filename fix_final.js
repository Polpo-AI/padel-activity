const fs = require('fs');

// 1. ai.ts
let ai = fs.readFileSync('src/services/ai.ts', 'utf8');
ai = ai.replace(/new Blob\(\[buffer\]\)/g, 'new Blob([buffer as unknown as BlobPart])');
ai = ai.replace(/new Blob\(\[buffer as any\]\)/g, 'new Blob([buffer as unknown as BlobPart])');
fs.writeFileSync('src/services/ai.ts', ai);

// 2. redirect.ts (findJollySlot)
let rd = fs.readFileSync('src/services/redirect.ts', 'utf8');

// select { name: true } -> { id: true, name: true }
rd = rd.replace(/select: \{ name: true \},/g, 'select: { id: true, name: true },');

// select { court: true } -> select { courtId: true }
rd = rd.replace(/select: \{ court: true \},/g, 'select: { courtId: true },');

// occupiedCourts
rd = rd.replace(/const occupiedCourts = new Set\(existingNextDay\.map\(m => m\.court\)\);/gi, 'const occupiedCourtIds = new Set(existingNextDay.map(m => m.courtId).filter(Boolean));');

// freeCourt
rd = rd.replace(/const freeCourt = courts\.find\(c => !occupiedCourts\.has\(c\.name\)\);/gi, 'const freeCourt = courts.find(c => !occupiedCourtIds.has(c.id));');

rd = rd.replace(/return \{ court: freeCourt\.name, /g, 'return { court: freeCourt.name, ');

// Fix findFreeSlots return type (se serve)
rd = rd.replace(/Promise<\{ court: string; startTime: Date \}\[\]>/g, 'Promise<{ court: string; courtId?: string | null; startTime: Date }[]>');

// Fix findFreeSlots push
rd = rd.replace(/slots\.push\(\{ court, startTime: new Date\(current\) \}\);/g, 'slots.push({ court: court.name, courtId: court.id, startTime: new Date(current) });');
rd = rd.replace(/for \(const court of courts\) \{/g, 'for (const court of courts) {');

// Fix findFreeSlots select courtId
rd = rd.replace(/const occupiedKeys = new Set\(/g, 'const occupiedKeys = new Set(');

fs.writeFileSync('src/services/redirect.ts', rd);

console.log("Fix final applicati.");
