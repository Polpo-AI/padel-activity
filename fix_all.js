const fs = require('fs');

// 1. ai.ts
let ai = fs.readFileSync('src/services/ai.ts', 'utf8');
ai = ai.replace(/new Blob\(\[buffer\]\)/g, 'new Blob([buffer as any])');
fs.writeFileSync('src/services/ai.ts', ai);

// 2. dashboard.api.ts
let dash = fs.readFileSync('src/api/dashboard.api.ts', 'utf8');
dash = dash.replace(/where: { id: req\.params\.id }/g, 'where: { id: req.params.id as string }');
dash = dash.replace(/referentPhone: confirmed\[0\]\.player\.phoneNumber,/g, 'clubId: match.clubId,\n            referentPhone: confirmed[0].player.phoneNumber,');
fs.writeFileSync('src/api/dashboard.api.ts', dash);

// 3. booking.ts
let book = fs.readFileSync('src/services/booking.ts', 'utf8');
book = book.replace(/referentPhone: referent\.phoneNumber,/g, 'clubId: targetMatch.clubId,\n            referentPhone: referent.phoneNumber,');
book = book.replace(/targetMatch\.court/g, 'targetMatch.court?.name || "Campo"');
book = book.replace(/include: \{ MatchPlayer: \{ include: \{ player: true \} \}, invitations: \{ include: \{ player: true \} \}, club: true \},/g, 'include: { MatchPlayer: { include: { player: true } }, invitations: { include: { player: true } }, club: true, court: true },');
fs.writeFileSync('src/services/booking.ts', book);

// 4. redirect.ts
let redir = fs.readFileSync('src/services/redirect.ts', 'utf8');
redir = redir.replace(/include: \{ MatchPlayer: true \},/g, 'include: { MatchPlayer: true, court: true },');
redir = redir.replace(/include: \{\n            court: true,/g, 'include: {\n            court: true,\n            MatchPlayer: true,');
fs.writeFileSync('src/services/redirect.ts', redir);

// 5. messageHandler.ts - handleOpenMatchCancellation & resolveDoubleInvitation
let mh = fs.readFileSync('src/services/messageHandler.ts', 'utf8');
mh = mh.replace(/async function handleOpenMatchCancellation\(\s*jid: string,\s*phoneNumber: string,\s*confirmedMatchPlayer: any,\s*messageKey\?: any\s*\)/g, 'async function handleOpenMatchCancellation(jid: string, phoneNumber: string, confirmedMatchPlayer: any)');
mh = mh.replace(/async function resolveDoubleInvitation\(\s*jid: string,\s*combinedText: string,\s*invitations: any\[\],\s*messageKey\?: any\s*\)/g, 'async function resolveDoubleInvitation(jid: string, combinedText: string, invitations: any[])');
fs.writeFileSync('src/services/messageHandler.ts', mh);

console.log("Fix script executed");
