/**
 * ADMIN COMMANDS
 *
 * Parsing e esecuzione di comandi DB via WhatsApp da parte dell'admin del circolo.
 * Scoped esclusivamente al club dell'admin.
 *
 * Supporta operazioni singole, multiple e combinate:
 *   es. "cancella tutte le partite di domani"
 *       "porta il livello di tutti i giocatori con skill 2 a 2.5"
 *       "disattiva il campo 1 e cancella le partite"
 *
 * L'AI capisce l'intent, costruisce una lista di step ed — se distruttivo —
 * chiede conferma prima di eseguire. In caso di ambiguità chiede chiarimento.
 */

import { prisma } from './db';
import { anthropic } from './ai';
import { simulateTypingAndSend, sendMessage } from './whatsapp';
import { getRedis } from './queue';
import pino from 'pino';

const logger = pino({ level: 'info' });

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

type AdminCommand =
    | 'LIST_MATCHES'
    | 'LIST_PLAYERS'
    | 'CANCEL_MATCH'       // params: { matchIds: string[] }
    | 'RESCHEDULE_MATCH'   // params: { matchId: string, newDay: string, newTime: string }
    | 'UPDATE_PLAYER_SKILL'// params: { playerIds: string[], newSkill: number }
    | 'DELETE_PLAYER'      // params: { playerId: string }
    | 'DEACTIVATE_COURT'   // params: { courtId: string }
    | 'CHANGE_CLUB_HOURS'  // params: { openTime?: string, closeTime?: string }
    | 'NEEDS_CLARIFICATION'// params: { question: string }
    | 'UNKNOWN';           // non è un comando admin → passa al brain normale

type AdminStep = {
    command: AdminCommand;
    params: any;
};

type ParsedAdminRequest = {
    steps: AdminStep[];
    requiresConfirmation: boolean;
    confirmPrompt: string; // mostrato all'admin prima di eseguire
};

// ─────────────────────────────────────────────
// FAQ FLOW
// ─────────────────────────────────────────────

type PendingFaqItem = { id: string; question: string; askedBy: string; playerJid: string };

/**
 * Gestisce il flusso FAQ lato admin.
 * Pipeline completa: routing → analisi conflitti/merge → salvataggio → risposta utente.
 */
export async function handleAdminFaqFlow(text: string, club: any, jid: string): Promise<boolean> {
    if (!club?.id || !text.trim()) return false;
    const redis = getRedis();
    const clubId = club.id;

    // ── Stato A: risoluzione conflitto in corso
    const conflictRaw = await redis.get(`faq:awaiting_conflict_resolve:${clubId}`);
    if (conflictRaw) {
        const { newQuestion, newAnswer, conflictingFaqId, conflictingQuestion, conflictingAnswer, askedBy, playerJid } = JSON.parse(conflictRaw);
        const t = text.trim().toLowerCase();
        const choseNew = /\b(nuov[ao]|second[ao]|questa|aggiorn|corrett[ao]|quella nuova)\b/.test(t) || t === '2';
        const choseOld = /\b(vecchi[ao]|prim[ao]|original[e]|quella vecchia|mantieni|tieni)\b/.test(t) || t === '1';
        // Se regex non risolve, usa AI
        let resolvedNew = choseNew;
        let resolvedOld = choseOld;
        if (!choseNew && !choseOld) {
            const conf = await classifyAdminConfirmation(text.trim());
            if (conf === 'affirm') resolvedNew = true;
            else if (conf === 'deny') resolvedOld = true;
        }

        if (!resolvedNew && !resolvedOld) {
            await sendMessage(jid, `Non ho capito. Rispondi:\n1 — tieni la FAQ esistente\n2 — sostituisci con la nuova risposta`);
            return true;
        }

        await redis.del(`faq:awaiting_conflict_resolve:${clubId}`);

        if (resolvedNew) {
            // Sostituisce la FAQ conflittuale con la nuova
            await prisma.faq.delete({ where: { id: conflictingFaqId } }).catch(() => {});
            await prisma.faq.create({ data: { clubId, question: newQuestion, answer: newAnswer, askedBy: askedBy || null } });
            if (playerJid) await simulateTypingAndSend(playerJid, newAnswer).catch(() => {});
            await sendMessage(jid, `Conflitto risolto ✅ — vecchia FAQ rimossa, nuova salvata e risposta inoltrata a ${askedBy || 'utente'}.`);
            notifyPendingFaqUsers(clubId, newQuestion, newAnswer).catch(() => {});
        } else {
            // Mantiene la vecchia, non salva la nuova ma risponde all'utente con la vecchia risposta
            if (playerJid) await simulateTypingAndSend(playerJid, conflictingAnswer).catch(() => {});
            await sendMessage(jid, `Conflitto risolto — FAQ esistente mantenuta. Risposta precedente inoltrata a ${askedBy || 'utente'}.`);
            notifyPendingFaqUsers(clubId, conflictingQuestion, conflictingAnswer).catch(() => {});
        }
        return true;
    }

    // ── Stato B: conferma merge in corso
    const mergeRaw = await redis.get(`faq:awaiting_merge_confirm:${clubId}`);
    if (mergeRaw) {
        const { newQuestion, proposedMergedAnswer, existingFaqId, askedBy, playerJid } = JSON.parse(mergeRaw);
        const affirmative = /^(s[iì]|yes|ok|va bene|certo|giusto|esatto|salvala?|conferm|mergia|unisci)/i.test(text.trim());
        const negative = /^(no|nope|lascia perdere|skip|non merge|non unire)/i.test(text.trim());
        // Se regex non risolve, chiedi all'AI
        const mergeConf = (!affirmative && !negative) ? await classifyAdminConfirmation(text.trim()) : null;
        const isMergeAffirm = affirmative || mergeConf === 'affirm';
        const isMergeDeny = negative || mergeConf === 'deny';

        if (!isMergeAffirm && !isMergeDeny) {
            // L'admin sta fornendo una versione custom del merge → usala
            const customMerge = text.trim();
            await redis.del(`faq:awaiting_merge_confirm:${clubId}`);
            await prisma.faq.update({ where: { id: existingFaqId }, data: { answer: customMerge } });
            if (playerJid) await simulateTypingAndSend(playerJid, customMerge).catch(() => {});
            await sendMessage(jid, `FAQ aggiornata con la tua versione ✅ Risposta inoltrata a ${askedBy || 'utente'}.`);
            notifyPendingFaqUsers(clubId, newQuestion, customMerge).catch(() => {});
            return true;
        }

        await redis.del(`faq:awaiting_merge_confirm:${clubId}`);

        if (isMergeAffirm) {
            await prisma.faq.update({ where: { id: existingFaqId }, data: { answer: proposedMergedAnswer } });
            if (playerJid) await simulateTypingAndSend(playerJid, proposedMergedAnswer).catch(() => {});
            await sendMessage(jid, `FAQ aggiornata con la versione unificata ✅ Risposta inoltrata a ${askedBy || 'utente'}.`);
            notifyPendingFaqUsers(clubId, newQuestion, proposedMergedAnswer).catch(() => {});
        } else {
            // Non merge: risponde all'utente con la risposta originale dell'admin (già salvata nel mergeRaw)
            const { originalAnswer } = JSON.parse(mergeRaw);
            if (playerJid) await simulateTypingAndSend(playerJid, originalAnswer).catch(() => {});
            await sendMessage(jid, `Ok, non unisco. Risposta inoltrata a ${askedBy || 'utente'} senza modifiche.`);
            notifyPendingFaqUsers(clubId, newQuestion, originalAnswer).catch(() => {});
        }
        return true;
    }

    // ── Stato C: conferma salvataggio semplice (sì/no)
    const confirmRaw = await redis.get(`faq:awaiting_save_confirm:${clubId}`);
    if (confirmRaw) {
        const { question, answer, askedBy, playerJid } = JSON.parse(confirmRaw);
        const affirmative = /^(s[iì]|yes|ok|va bene|certo|giusto|esatto|salvala?|conferm)/i.test(text.trim());
        const negative = /^(no|nope|non salvare|non va bene|sbagliato|lascia perdere|skip)/i.test(text.trim());
        const saveConf = (!affirmative && !negative) ? await classifyAdminConfirmation(text.trim()) : null;
        const isSaveAffirm = affirmative || saveConf === 'affirm';
        const isSaveDeny = negative || saveConf === 'deny';

        if (isSaveAffirm) {
            await prisma.faq.create({ data: { clubId, question, answer, askedBy: askedBy || null } });
            await redis.del(`faq:awaiting_save_confirm:${clubId}`);
            await sendMessage(jid, `Salvata come FAQ ✅`);
            notifyPendingFaqUsers(clubId, question, answer).catch(() => {});
            return true;
        }
        if (isSaveDeny) {
            await redis.del(`faq:awaiting_save_confirm:${clubId}`);
            await sendMessage(jid, `Ok, non salvo.`);
            return true;
        }
        // Non è sì/no → ri-classifica come nuova risposta
        await redis.del(`faq:awaiting_save_confirm:${clubId}`);
    }

    // idsKey usato sia in Stato E che in Stato D
    const idsKey = `faq:pending_ids:${clubId}`;

    // ── Stato F: conferma versione migliorata risposta FAQ
    const improvementRaw = await redis.get(`faq:awaiting_improvement:${clubId}`);
    if (improvementRaw) {
        const { question, originalAnswer, improvedAnswer, askedBy, playerJid } = JSON.parse(improvementRaw);
        await redis.del(`faq:awaiting_improvement:${clubId}`);

        const affirmative = /^(s[iì]|yes|ok|va bene|certo|conferm|esatto|giusto|migliora|usa questa|usala)/i.test(text.trim());
        const negative = /^(no|nope|originale|lascia|tieni|va bene cos)/i.test(text.trim());
        const improveConf = (!affirmative && !negative) ? await classifyAdminConfirmation(text.trim()) : null;
        const finalAnswer = (affirmative || improveConf === 'affirm') ? improvedAnswer
            : (negative || improveConf === 'deny') ? originalAnswer
            : text.trim();

        await prisma.faq.create({ data: { clubId, question, answer: finalAnswer, askedBy: askedBy || null } });
        if (playerJid) await simulateTypingAndSend(playerJid, finalAnswer).catch(() => {});
        const remAfterImpr = await redis.llen(idsKey);
        const remNoteImpr = remAfterImpr > 0 ? `\n\n⚠️ Hai ancora ${remAfterImpr} domanda${remAfterImpr > 1 ? 'e' : ''} in sospeso.` : '';
        await sendMessage(jid, `FAQ salvata e risposta inoltrata a ${askedBy || 'utente'} ✅${remNoteImpr}`);
        notifyPendingFaqUsers(clubId, question, finalAnswer).catch(() => {});
        return true;
    }

    // ── Stato E: conferma "covers_all" in corso
    const coversAllRaw = await redis.get(`faq:awaiting_covers_all:${clubId}`);
    if (coversAllRaw) {
        const { answerText: savedAnswer, items } = JSON.parse(coversAllRaw);
        const affirmative = /^(s[iì]|yes|ok|va bene|certo|conferm|esatto|giusto)/i.test(text.trim());
        const negative = /^(no|nope|non|lascia perdere|skip|separa)/i.test(text.trim());
        const coversConf = (!affirmative && !negative) ? await classifyAdminConfirmation(text.trim()) : null;
        const isCoversAffirm = affirmative || coversConf === 'affirm';
        const isCoversDeny = negative || coversConf === 'deny';

        if (!isCoversAffirm && !isCoversDeny) {
            await sendMessage(jid, `Non ho capito — vuoi salvare questa risposta per tutte le domande? Rispondi sì o no.`);
            return true;
        }
        await redis.del(`faq:awaiting_covers_all:${clubId}`);

        if (isCoversAffirm) {
            for (const item of items) {
                await prisma.faq.create({ data: { clubId, question: item.question, answer: savedAnswer, askedBy: item.askedBy || null } });
                if (item.playerJid) await simulateTypingAndSend(item.playerJid, savedAnswer).catch(() => {});
                await redis.lrem(idsKey, 1, item.id);
                await redis.del(`faq:pending:${clubId}:${item.id}`);
                notifyPendingFaqUsers(clubId, item.question, savedAnswer).catch(() => {});
            }
            await sendMessage(jid, `Risposta salvata per tutte e ${items.length} le domande e inoltrata agli utenti ✅`);
        } else {
            await sendMessage(jid, `Ok, rispondi separatamente. Quali domande hai in sospeso:\n${items.map((it: any, i: number) => `${i + 1}. ${it.askedBy}: "${it.question}"`).join('\n')}`);
        }
        return true;
    }

    // ── Stato D: carica la coda FAQ in sospeso
    const pendingIds = await redis.lrange(idsKey, 0, -1);
    if (pendingIds.length === 0) return false;

    const pendingItems: PendingFaqItem[] = (
        await Promise.all(pendingIds.map(id => redis.get(`faq:pending:${clubId}:${id}`)))
    ).filter(Boolean).map(raw => JSON.parse(raw!));

    if (pendingItems.length === 0) { await redis.del(idsKey); return false; }

    // ── Routing AI: classifica il messaggio admin contro tutte le FAQ in sospeso
    const routing = await classifyFaqResponse(text.trim(), pendingItems);

    // AMBIGUOUS → chiede a quale domanda si riferisce, senza numerazione
    if (routing.type === 'ambiguous') {
        const list = pendingItems.map(item => `• ${item.askedBy}: "${item.question}"`).join('\n');
        await sendMessage(jid, `A quale domanda ti stai riferendo?\n\n${list}`);
        return true;
    }

    // COVERS_ALL → una risposta copre tutte le domande, chiede conferma
    if (routing.type === 'covers_all') {
        await redis.set(
            `faq:awaiting_covers_all:${clubId}`,
            JSON.stringify({ answerText: routing.answerText, items: pendingItems }),
            'EX', 24 * 3600,
        );
        const domande = pendingItems.map(it => `• "${it.question}"`).join('\n');
        await sendMessage(jid, `Questa risposta copre tutte e ${pendingItems.length} le domande?\n\n${domande}\n\nR: ${routing.answerText}\n\nRispondi sì per salvarla per ognuna, no per rispondere separatamente.`);
        return true;
    }

    // MULTI → risposte separate per FAQ diverse nello stesso messaggio
    if (routing.type === 'multi') {
        const rawFaqs = await prisma.faq.findMany({ where: { clubId }, select: { id: true, question: true, answer: true } });
        const existingFaqs = rawFaqs.map(f => ({ id: f.id, question: f.question, answer: f.answer ?? '' }));

        // Salvataggio + improvement check in parallelo per ogni risposta
        const results = await Promise.all(routing.answers.map(async ({ index, answerText }) => {
            const item = pendingItems[index];
            if (!item) return null;
            await redis.lrem(idsKey, 1, item.id);
            await redis.del(`faq:pending:${clubId}:${item.id}`);
            await prisma.faq.create({ data: { clubId, question: item.question, answer: answerText, askedBy: item.askedBy || null } });
            if (item.playerJid) await simulateTypingAndSend(item.playerJid, answerText).catch(() => {});
            notifyPendingFaqUsers(clubId, item.question, answerText).catch(() => {});
            // conflict check + improvement check in parallelo
            const [, suggestion] = await Promise.all([
                analyzeNewFaqAgainstExisting(item.question, answerText, existingFaqs).then(async analysis => {
                    if (analysis.type === 'conflict') {
                        await sendMessage(jid, `⚠️ La FAQ su "${item.question}" potrebbe essere in conflitto con una esistente. Controlla la dashboard.`).catch(() => {});
                    }
                }).catch(() => {}),
                suggestFaqImprovement(item.question, answerText),
            ]);
            return { question: item.question, suggestion };
        }));

        const savedCount = results.filter(Boolean).length;
        const remaining = await redis.llen(idsKey);
        const remainingNote = remaining > 0 ? `\n\n⚠️ Hai ancora ${remaining} domanda${remaining > 1 ? 'e' : ''} in sospeso.` : '';

        // Note miglioramenti (non-bloccanti, a fine messaggio)
        const improvementNotes = results
            .filter((r): r is { question: string; suggestion: { hasSuggestions: true; improvedAnswer: string; notes: string[] } } =>
                !!r && r.suggestion.hasSuggestions === true)
            .map(r => `📝 "${r.question}":\n${r.suggestion.notes.map(n => `  • ${n}`).join('\n')}\n  → Suggerito: "${r.suggestion.improvedAnswer}"`);

        const notesBlock = improvementNotes.length > 0
            ? `\n\n${improvementNotes.join('\n\n')}\n\nPuoi modificare le FAQ dalla dashboard.`
            : '';

        await sendMessage(jid, `${savedCount} risposte salvate come FAQ e inoltrate agli utenti ✅${remainingNote}${notesBlock}`);
        return true;
    }

    // SINGLE → risponde a una sola FAQ
    const targetItem = pendingItems[routing.targetIndex];
    if (!targetItem) return false;
    const answerText = routing.answerText;

    // Verifica che sia effettivamente una risposta
    const classification = await classifyAdminFaqResponse(targetItem.question, answerText);
    if (!classification.isFaqAnswer) return false;

    // Rimuove dalla coda
    await redis.lrem(idsKey, 1, targetItem.id);
    await redis.del(`faq:pending:${clubId}:${targetItem.id}`);
    const remaining = await redis.llen(idsKey);
    const remainingNote = remaining > 0 ? `\n\n⚠️ Hai ancora ${remaining} domanda${remaining > 1 ? 'e' : ''} in sospeso.` : '';

    if (!classification.faqWorthy) {
        if (targetItem.playerJid) await simulateTypingAndSend(targetItem.playerJid, answerText).catch(() => {});
        await sendMessage(jid, `Risposta inoltrata a ${targetItem.askedBy || 'utente'}.${remainingNote}`);
        return true;
    }

    // Analisi anti-conflitto e merge
    const rawFaqs = await prisma.faq.findMany({ where: { clubId }, select: { id: true, question: true, answer: true } });
    const existingFaqs = rawFaqs.map(f => ({ id: f.id, question: f.question, answer: f.answer ?? '' }));
    const analysis = await analyzeNewFaqAgainstExisting(targetItem.question, answerText, existingFaqs);

    if (analysis.type === 'conflict') {
        await redis.set(
            `faq:awaiting_conflict_resolve:${clubId}`,
            JSON.stringify({
                newQuestion: targetItem.question, newAnswer: answerText,
                conflictingFaqId: analysis.existingFaqId, conflictingQuestion: analysis.existingQuestion, conflictingAnswer: analysis.existingAnswer,
                askedBy: targetItem.askedBy, playerJid: targetItem.playerJid,
            }),
            'EX', 24 * 3600,
        );
        await sendMessage(jid,
            `⚠️ *Conflitto rilevato*\n\nHo una FAQ esistente:\nD: ${analysis.existingQuestion}\nR: ${analysis.existingAnswer}\n\nLa tua nuova risposta:\nR: ${answerText}\n\nQuale è corretta? Rispondi "nuova" per aggiornare o "vecchia" per mantenere quella esistente${remainingNote}`,
        );
        return true;
    }

    if (analysis.type === 'merge') {
        await redis.set(
            `faq:awaiting_merge_confirm:${clubId}`,
            JSON.stringify({
                newQuestion: targetItem.question, originalAnswer: answerText,
                proposedMergedAnswer: analysis.proposedMergedAnswer,
                existingFaqId: analysis.existingFaqId,
                askedBy: targetItem.askedBy, playerJid: targetItem.playerJid,
            }),
            'EX', 24 * 3600,
        );
        await sendMessage(jid,
            `Ho trovato una FAQ simile che dice meno. Propongo di unirle:\n\nD: ${targetItem.question}\nR: ${analysis.proposedMergedAnswer}\n\nRispondi sì per usare questa versione unificata, no per non unire, oppure scrivi la tua versione${remainingNote}`,
        );
        return true;
    }

    // clean → analisi miglioramenti prima di salvare
    const suggestion = await suggestFaqImprovement(targetItem.question, answerText);
    if (suggestion.hasSuggestions) {
        await redis.set(
            `faq:awaiting_improvement:${clubId}`,
            JSON.stringify({ question: targetItem.question, originalAnswer: answerText, improvedAnswer: suggestion.improvedAnswer, askedBy: targetItem.askedBy, playerJid: targetItem.playerJid }),
            'EX', 24 * 3600,
        );
        const notesStr = suggestion.notes.map(n => `• ${n}`).join('\n');
        await sendMessage(jid, `📝 Note sulla risposta:\n${notesStr}\n\nVersione suggerita:\n"${suggestion.improvedAnswer}"\n\nRispondi sì per usarla, no per tenere l'originale, oppure scrivi la tua versione.${remainingNote}`);
        return true;
    }

    // Nessun miglioramento necessario — salva e inoltra
    if (classification.confidence === 'high') {
        await prisma.faq.create({ data: { clubId, question: targetItem.question, answer: answerText, askedBy: targetItem.askedBy || null } });
        if (targetItem.playerJid) await simulateTypingAndSend(targetItem.playerJid, answerText).catch(() => {});
        await sendMessage(jid, `Risposta inoltrata a ${targetItem.askedBy || 'utente'} e salvata come FAQ ✅${remainingNote}`);
        notifyPendingFaqUsers(clubId, targetItem.question, answerText).catch(() => {});
        return true;
    }

    // Confidence bassa → chiedi conferma
    if (targetItem.playerJid) await simulateTypingAndSend(targetItem.playerJid, answerText).catch(() => {});
    await redis.set(
        `faq:awaiting_save_confirm:${clubId}`,
        JSON.stringify({ question: targetItem.question, answer: answerText, askedBy: targetItem.askedBy, playerJid: targetItem.playerJid }),
        'EX', 24 * 3600,
    );
    await sendMessage(jid,
        `Risposta inoltrata a ${targetItem.askedBy || 'utente'}.\n\nVuoi salvarla come FAQ?\n\nD: ${targetItem.question}\nR: ${answerText}\n\nRispondi sì o no.${remainingNote}`,
    );
    return true;
}

// ─────────────────────────────────────────────
// AI HELPERS — FAQ
// ─────────────────────────────────────────────

/**
 * Classifica una risposta admin come affermativa, negativa o non chiara.
 * Usa Haiku per capire frasi naturali come "copre entrambe", "va bene così",
 * "tieni quella vecchia", "no meglio separare", ecc. — senza regex rigidi.
 */
async function classifyAdminConfirmation(text: string): Promise<'affirm' | 'deny' | 'unclear'> {
    const prompt = `L'admin di un circolo padel ha risposto a una domanda di conferma sì/no.
Messaggio: "${text}"
Rispondi SOLO con uno di questi valori JSON: {"result":"affirm"} oppure {"result":"deny"} oppure {"result":"unclear"}
- "affirm": l'admin approva/conferma (es. "sì", "ok", "va bene", "certo", "esatto", "confermo", "copre entrambe", "sì per tutte", "esatto tienila", "quella nuova", "aggiorna", ecc.)
- "deny": l'admin rifiuta/vuole altro (es. "no", "non va bene", "separa", "lascia stare", "tieni quella vecchia", ecc.)
- "unclear": non è chiaro se sta confermando o rifiutando`;
    try {
        const resp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001', max_tokens: 30, temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        });
        const raw = resp.content[0].type === 'text' ? resp.content[0].text.trim() : '';
        const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
        if (s !== -1 && e !== -1) {
            const parsed = JSON.parse(raw.substring(s, e + 1));
            if (parsed.result === 'affirm' || parsed.result === 'deny' || parsed.result === 'unclear') {
                return parsed.result;
            }
        }
    } catch (err) { logger.warn({ err }, 'classifyAdminConfirmation failed — defaulting to unclear'); }
    return 'unclear';
}

async function classifyAdminFaqResponse(
    pendingQuestion: string,
    adminMessage: string,
): Promise<{ isFaqAnswer: boolean; confidence: 'high' | 'low'; faqWorthy: boolean }> {
    const prompt = `L'admin di un circolo padel ha una domanda in sospeso: "${pendingQuestion}".
Ha scritto: "${adminMessage}"
È una risposta alla domanda? Restituisci SOLO JSON:
{"isFaqAnswer":true/false,"confidence":"high"/"low","faqWorthy":true/false}
- isFaqAnswer: true se risponde (anche parzialmente)
- confidence: high se è chiaramente una risposta
- faqWorthy: true se è abbastanza completa da salvare per utenti futuri`;

    try {
        const resp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001', max_tokens: 80, temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        });
        const raw = resp.content[0].type === 'text' ? resp.content[0].text.trim() : '';
        const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
        if (s !== -1 && e !== -1) return JSON.parse(raw.substring(s, e + 1));
    } catch (err) { logger.error({ err }, 'classifyAdminFaqResponse failed'); }
    return { isFaqAnswer: false, confidence: 'low', faqWorthy: false };
}

async function suggestFaqImprovement(
    question: string,
    answer: string,
): Promise<{ hasSuggestions: false } | { hasSuggestions: true; improvedAnswer: string; notes: string[] }> {
    const prompt = `Sei un assistente che aiuta a migliorare le risposte FAQ di un circolo padel prima di salvarle.

DOMANDA: "${question}"
RISPOSTA ATTUALE: "${answer}"

Analizza la risposta e verifica:
1. COMPLETEZZA: mancano informazioni importanti che l'utente si aspetterebbe? (es. prezzi, orari, dettagli pratici)
2. GRAMMATICA/SINTASSI: errori di ortografia, punteggiatura, apostrofi mancanti, spaziatura
3. MORFOLOGIA: articoli errati, accordi di genere/numero, preposizioni
4. CHIAREZZA: la risposta è chiara e ben formulata?

Se la risposta è già completa e corretta, restituisci {"hasSuggestions":false}.

Se ci sono miglioramenti possibili, restituisci:
{"hasSuggestions":true,"improvedAnswer":"la versione migliorata completa","notes":["cosa manca o è stato corretto"]}

Regole per la versione migliorata:
- Mantieni lo stesso tono dell'originale (informale se informale, formale se formale)
- Per informazioni mancanti (es. prezzo): usa frasi come "verifica con la segreteria per i dettagli" se il dato non è noto — non inventare mai numeri specifici non menzionati
- Correggi errori grammaticali/sintattici (apostrofi, accordi, punteggiatura)
- Rimani conciso`;

    try {
        const resp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001', max_tokens: 400, temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        });
        const raw = resp.content[0].type === 'text' ? resp.content[0].text.trim() : '';
        const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
        if (s !== -1 && e !== -1) {
            const result = JSON.parse(raw.substring(s, e + 1));
            if (result.hasSuggestions === false) return { hasSuggestions: false };
            if (result.hasSuggestions === true && result.improvedAnswer) {
                return {
                    hasSuggestions: true,
                    improvedAnswer: result.improvedAnswer,
                    notes: Array.isArray(result.notes) ? result.notes : [],
                };
            }
        }
    } catch (err) { logger.error({ err }, 'suggestFaqImprovement failed'); }
    return { hasSuggestions: false };
}

type FaqRoutingResult =
    | { type: 'single'; targetIndex: number; answerText: string }
    | { type: 'multi'; answers: Array<{ index: number; answerText: string }> }
    | { type: 'covers_all'; answerText: string }
    | { type: 'ambiguous' };

async function classifyFaqResponse(
    adminText: string,
    pendingItems: PendingFaqItem[],
): Promise<FaqRoutingResult> {
    if (pendingItems.length === 1) {
        return { type: 'single', targetIndex: 0, answerText: adminText };
    }

    const list = pendingItems.map((item, i) => `[${i}] ${item.askedBy}: "${item.question}"`).join('\n');
    const prompt = `L'admin di un circolo padel ha scritto: "${adminText}"

Domande FAQ in sospeso:
${list}

Analizza il messaggio e determina:
- "single": risponde chiaramente a UNA sola domanda (specifica quale con targetIndex 0-based)
- "multi": contiene risposte separate a PIÙ domande diverse nello stesso messaggio
- "covers_all": una risposta che va bene per TUTTE le domande
- "ambiguous": non è chiaro a quale domanda risponde

Estrai il testo della risposta per ogni domanda coperta.

Restituisci SOLO JSON:
{
  "type": "single" | "multi" | "covers_all" | "ambiguous",
  "targetIndex": number | null,
  "answerText": "..." | null,
  "answers": [{"index": number, "answerText": "..."}] | null
}
- "single": targetIndex = indice domanda, answerText = testo risposta
- "multi": answers = array con indice e risposta per ogni domanda coperta
- "covers_all": answerText = risposta unificata (di solito il testo completo)
- "ambiguous": tutti null`;

    try {
        const resp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001', max_tokens: 400, temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        });
        const raw = resp.content[0].type === 'text' ? resp.content[0].text.trim() : '';
        const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
        if (s !== -1 && e !== -1) {
            const result = JSON.parse(raw.substring(s, e + 1));
            if (result.type === 'single' && result.targetIndex !== null && result.targetIndex !== undefined) {
                const idx = Number(result.targetIndex);
                if (idx >= 0 && idx < pendingItems.length) {
                    return { type: 'single', targetIndex: idx, answerText: result.answerText || adminText };
                }
            }
            if (result.type === 'multi' && Array.isArray(result.answers) && result.answers.length > 0) {
                const validAnswers = result.answers
                    .filter((a: any) => typeof a.index === 'number' && a.index >= 0 && a.index < pendingItems.length)
                    .map((a: any) => ({ index: Number(a.index), answerText: a.answerText || adminText }));
                if (validAnswers.length > 0) return { type: 'multi', answers: validAnswers };
            }
            if (result.type === 'covers_all') {
                return { type: 'covers_all', answerText: result.answerText || adminText };
            }
        }
    } catch (err) { logger.error({ err }, 'classifyFaqResponse failed'); }
    return { type: 'ambiguous' };
}

async function routeFaqResponse(
    adminText: string,
    pendingItems: PendingFaqItem[],
): Promise<{ targetIndex?: number; ambiguous: boolean }> {
    if (pendingItems.length === 1) return { targetIndex: 0, ambiguous: false };

    const list = pendingItems.map((item, i) => `${i + 1}. "${item.question}"`).join('\n');
    const prompt = `L'admin ha scritto: "${adminText}"
Queste sono le domande in sospeso:
${list}
A quale domanda risponde il messaggio? Restituisci SOLO JSON:
{"targetIndex":0,"ambiguous":false}
- targetIndex: indice 0-based della domanda a cui risponde (null se non è chiaro)
- ambiguous: true se non sei sicuro a quale risponde`;

    try {
        const resp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001', max_tokens: 60, temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        });
        const raw = resp.content[0].type === 'text' ? resp.content[0].text.trim() : '';
        const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
        if (s !== -1 && e !== -1) {
            const result = JSON.parse(raw.substring(s, e + 1));
            if (result.ambiguous || result.targetIndex === null || result.targetIndex === undefined) {
                return { ambiguous: true };
            }
            const idx = Number(result.targetIndex);
            if (idx >= 0 && idx < pendingItems.length) return { targetIndex: idx, ambiguous: false };
        }
    } catch (err) { logger.error({ err }, 'routeFaqResponse failed'); }
    return { ambiguous: true };
}

async function analyzeNewFaqAgainstExisting(
    newQuestion: string,
    newAnswer: string,
    existingFaqs: Array<{ id: string; question: string; answer: string }>,
): Promise<{
    type: 'clean' | 'merge' | 'conflict';
    existingFaqId?: string;
    existingQuestion?: string;
    existingAnswer?: string;
    proposedMergedAnswer?: string;
}> {
    if (existingFaqs.length === 0) return { type: 'clean' };

    const faqList = existingFaqs.map((f, i) => `[${i}] ID:${f.id}\nD: ${f.question}\nR: ${f.answer}`).join('\n\n');
    const prompt = `Stai analizzando una nuova risposta FAQ prima di salvarla.

NUOVA FAQ:
D: ${newQuestion}
R: ${newAnswer}

FAQ ESISTENTI:
${faqList}

Analizza se c'è:
- Un CONFLITTO: una FAQ esistente che dice il contrario o dà informazioni incompatibili
- Un MERGE: una FAQ esistente sullo stesso argomento che dice MENO della nuova (la nuova la supera o la completa)
- CLEAN: nessun problema, la nuova FAQ è indipendente

Se MERGE, proponi una versione unificata che combina il meglio delle due.

Restituisci SOLO JSON:
{
  "type": "clean" | "merge" | "conflict",
  "existingIndex": number | null,
  "proposedMergedAnswer": "..." | null
}
- existingIndex: indice [N] della FAQ coinvolta (null se clean)
- proposedMergedAnswer: solo se type=merge, la versione unificata proposta`;

    try {
        const resp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001', max_tokens: 300, temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        });
        const raw = resp.content[0].type === 'text' ? resp.content[0].text.trim() : '';
        const s = raw.indexOf('{'); const e = raw.lastIndexOf('}');
        if (s !== -1 && e !== -1) {
            const result = JSON.parse(raw.substring(s, e + 1));
            if (result.type === 'clean' || result.existingIndex === null || result.existingIndex === undefined) {
                return { type: 'clean' };
            }
            const existing = existingFaqs[Number(result.existingIndex)];
            if (!existing) return { type: 'clean' };
            return {
                type: result.type,
                existingFaqId: existing.id,
                existingQuestion: existing.question,
                existingAnswer: existing.answer,
                proposedMergedAnswer: result.proposedMergedAnswer || undefined,
            };
        }
    } catch (err) { logger.error({ err }, 'analyzeNewFaqAgainstExisting failed'); }
    return { type: 'clean' };
}

// ─────────────────────────────────────────────
// NOTIFY PENDING FAQ USERS
// ─────────────────────────────────────────────

/**
 * Chiamata dopo ogni creazione/aggiornamento FAQ (dashboard o WhatsApp).
 * Controlla la coda Redis dei pending e risponde agli utenti le cui domande
 * sono coperte dalla nuova FAQ.
 */
export async function notifyPendingFaqUsers(
    clubId: string,
    faqQuestion: string,
    faqAnswer: string,
): Promise<void> {
    const redis = getRedis();
    const idsKey = `faq:pending_ids:${clubId}`;
    const pendingIds = await redis.lrange(idsKey, 0, -1);
    if (pendingIds.length === 0) return;

    const pendingItems: PendingFaqItem[] = (
        await Promise.all(pendingIds.map(id => redis.get(`faq:pending:${clubId}:${id}`)))
    ).filter(Boolean).map(raw => JSON.parse(raw!));

    if (pendingItems.length === 0) return;

    // Dedup: ogni giocatore riceve AL MASSIMO un messaggio per questa chiamata, anche se
    // ha più pending coperte dalla stessa risposta (domanda duplicata o follow-up correlato).
    // Le pending matchate vengono comunque tutte rimosse dalla coda.
    const notifiedJids = new Set<string>();

    // Per ogni pending, chiede all'AI se la nuova FAQ risponde alla domanda
    for (const item of pendingItems) {
        try {
            const covered = await isFaqCoveringQuestion(faqQuestion, faqAnswer, item.question);
            if (!covered) continue;

            // Risponde all'utente — solo se non già notificato in questa chiamata
            if (item.playerJid && !notifiedJids.has(item.playerJid)) {
                notifiedJids.add(item.playerJid);
                const { runWithContext } = await import('../utils/request-context');
                await runWithContext({ correlationId: `faq-notify-${item.id}`, clubId }, () =>
                    simulateTypingAndSend(item.playerJid, faqAnswer).catch(() => {})
                );
                logger.info({ clubId, faqQuestion, askedBy: item.askedBy }, 'Pending FAQ user notified via new FAQ');
            }

            // Rimuove dalla coda (sempre, anche se l'invio è stato deduplicato)
            await redis.lrem(idsKey, 1, item.id);
            await redis.del(`faq:pending:${clubId}:${item.id}`);
        } catch (err) {
            logger.warn({ err, itemId: item.id }, 'notifyPendingFaqUsers: error processing item');
        }
    }
}

async function isFaqCoveringQuestion(
    faqQuestion: string,
    faqAnswer: string,
    pendingQuestion: string,
): Promise<boolean> {
    const prompt = `Una nuova FAQ è stata aggiunta:
D: ${faqQuestion}
R: ${faqAnswer}

Un utente aveva fatto questa domanda in sospeso: "${pendingQuestion}"

La nuova FAQ risponde (anche parzialmente) alla domanda dell'utente?
Restituisci SOLO: true oppure false`;

    try {
        const resp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001', max_tokens: 10, temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        });
        const raw = resp.content[0].type === 'text' ? resp.content[0].text.trim().toLowerCase() : '';
        return raw.startsWith('true');
    } catch (err) {
        logger.error({ err }, 'isFaqCoveringQuestion failed');
        return false;
    }
}

// ─────────────────────────────────────────────
// MAIN COMMAND HANDLER
// ─────────────────────────────────────────────

/**
 * Tenta di interpretare il messaggio come un comando admin.
 * Ritorna true se il messaggio è stato gestito (anche solo per chiedere conferma).
 * Ritorna false se non è un comando → passa al brain normale.
 */
export async function handleAdminCommand(text: string, club: any, jid: string): Promise<boolean> {
    const now = new Date().toLocaleString('it-IT', {
        timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric',
        month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });

    const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const [upcomingMatches, allPlayers, allCourts] = await Promise.all([
        prisma.match.findMany({
            where: {
                clubId: club.id,
                startTime: { gte: new Date(), lte: sevenDaysOut },
                status: { in: ['OPEN', 'LOCKED'] },
            },
            include: {
                court: true,
                MatchPlayer: { where: { leftAt: null }, include: { player: true } },
            },
            orderBy: { startTime: 'asc' },
            take: 30,
        }),
        prisma.player.findMany({
            where: { clubId: club.id, active: true },
            select: { id: true, name: true, phoneNumber: true, skillLevel: true },
            orderBy: { name: 'asc' },
        }),
        prisma.court.findMany({
            where: { clubId: club.id },
            select: { id: true, name: true, active: true, isCovered: true },
            orderBy: { name: 'asc' },
        }),
    ]);

    const fmtTime = (d: Date) => d.toLocaleString('it-IT', {
        timeZone: 'Europe/Rome', weekday: 'short', day: 'numeric',
        month: 'short', hour: '2-digit', minute: '2-digit',
    });

    const matchesStr = upcomingMatches.length > 0
        ? upcomingMatches.map(m => {
            const players = m.MatchPlayer.map((mp: any) => mp.player.name || mp.player.phoneNumber).join(', ');
            return `ID:${m.id} | ${m.court?.name || 'Campo'} | ${fmtTime(m.startTime)} | ${m.status} | Giocatori: [${players || 'nessuno'}]`;
        }).join('\n')
        : 'Nessuna partita nei prossimi 7 giorni';

    const playersStr = allPlayers.length > 0
        ? allPlayers.map(p => `ID:${p.id} | ${p.name || 'N/A'} | Tel:${p.phoneNumber} | Livello:${p.skillLevel}`).join('\n')
        : 'Nessun giocatore';

    const courtsStr = allCourts.length > 0
        ? allCourts.map((c: any) => `ID:${c.id} | ${c.name} | ${c.active ? 'attivo' : 'disattivato'} | ${c.isCovered ? 'coperto' : 'scoperto'}`).join('\n')
        : 'Nessun campo';

    const prompt = `Sei il parser di comandi per un admin di un circolo padel.
L'admin ha scritto: "${text}"

Dati disponibili:

PARTITE (prossimi 7 giorni):
${matchesStr}

GIOCATORI:
${playersStr}

CAMPI:
${courtsStr}

Orari circolo: ${club.openTime || '08:00'} – ${club.closeTime || '23:30'}
Data/ora attuali: ${now}

Analizza se il messaggio è un comando di gestione del circolo. Se non lo è (es. saluto, domanda generica, conversazione), restituisci UNKNOWN.

Se è un comando, costruisci la lista di step necessari per eseguirlo — anche se sono più operazioni combinate (es. "disattiva il campo E cancella le partite" = 2 step).

Restituisci SOLO un JSON valido:
{
  "steps": [
    { "command": "NOME_COMANDO", "params": { ... } }
  ],
  "requiresConfirmation": true/false,
  "confirmPrompt": "Descrizione chiara di cosa verrà fatto, mostrata all'admin prima di confermare"
}

Comandi disponibili e parametri:
- LIST_MATCHES: { "dateFrom": "YYYY-MM-DD"?, "dateTo": "YYYY-MM-DD"?, "courtId": "id"? }
- LIST_PLAYERS: { "skillMin": number?, "skillMax": number?, "nameQuery": "string"? }
- CANCEL_MATCH: { "matchIds": ["id1", "id2", ...] }  ← array, anche con un solo elemento
- RESCHEDULE_MATCH: { "matchId": "id", "newDay": "YYYY-MM-DD", "newTime": "HH:MM" }
- UPDATE_PLAYER_SKILL: { "playerIds": ["id1", "id2", ...], "newSkill": number }  ← array
- DELETE_PLAYER: { "playerId": "id" }
- DEACTIVATE_COURT: { "courtId": "id" }
- CHANGE_CLUB_HOURS: { "openTime": "HH:MM"?, "closeTime": "HH:MM"? }
- NEEDS_CLARIFICATION: { "question": "domanda da fare all'admin per capire meglio" }
- UNKNOWN: {}

Regole:
- requiresConfirmation: true se almeno uno step è distruttivo (CANCEL, DELETE, DEACTIVATE) o modifica dati (UPDATE, CHANGE_CLUB_HOURS, RESCHEDULE)
- Per LIST_* e UNKNOWN: requiresConfirmation: false
- confirmPrompt: descrizione esatta dell'impatto (quante partite, quali giocatori, ecc.)
- Se l'admin dice "tutte le partite di domani", includi tutti i matchIds corrispondenti
- Se l'admin menziona una persona per nome, trova l'ID corrispondente nella lista giocatori
- Se non trovi un riferimento (es. nome non presente nella lista), usa NEEDS_CLARIFICATION
- UNKNOWN: non è un comando admin, è conversazione normale → steps: [{ "command": "UNKNOWN", "params": {} }]

Esempi:
- "mostra partite di domani" → LIST_MATCHES, requiresConfirmation: false
- "cancella tutte le partite di domani" → CANCEL_MATCH con tutti i matchIds di domani, requiresConfirmation: true
- "porta il livello di Mario Rossi a 4" → UPDATE_PLAYER_SKILL con il suo playerId, requiresConfirmation: true
- "disattiva il campo 1 e cancella le sue partite" → [CANCEL_MATCH, DEACTIVATE_COURT], requiresConfirmation: true
- "ciao come stai" → UNKNOWN, requiresConfirmation: false
- "quanti giocatori ho con livello 3?" → LIST_PLAYERS con skillMin:3, skillMax:3, requiresConfirmation: false`;

    let parsed: ParsedAdminRequest = {
        steps: [{ command: 'UNKNOWN', params: {} }],
        requiresConfirmation: false,
        confirmPrompt: '',
    };

    try {
        const resp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 600,
            temperature: 0,
            messages: [{ role: 'user', content: prompt }],
        });
        const content = resp.content[0];
        if (content.type === 'text') {
            const raw = content.text.trim();
            const start = raw.indexOf('{');
            const end = raw.lastIndexOf('}');
            if (start !== -1 && end !== -1) {
                parsed = JSON.parse(raw.substring(start, end + 1));
            }
        }
    } catch (err) {
        logger.error({ err }, 'Admin command parse failed');
        await simulateTypingAndSend(jid, 'Non sono riuscita a capire il comando. Puoi riformulare?');
        return true;
    }

    // Solo UNKNOWN → non è un comando admin
    if (parsed.steps.length === 1 && parsed.steps[0].command === 'UNKNOWN') {
        return false;
    }

    // NEEDS_CLARIFICATION → chiedi e aspetta
    const clarStep = parsed.steps.find(s => s.command === 'NEEDS_CLARIFICATION');
    if (clarStep) {
        await simulateTypingAndSend(jid, clarStep.params?.question || 'Puoi specificare meglio?');
        return true;
    }

    // Operazioni di sola lettura → esegui subito
    if (!parsed.requiresConfirmation) {
        await executeAdminSteps(parsed.steps, club, jid, upcomingMatches, allPlayers, allCourts);
        return true;
    }

    // Operazioni distruttive/modificanti → chiedi conferma
    const redis = getRedis();
    await redis.set(
        `admin:pending_action:${club.id}`,
        JSON.stringify({ steps: parsed.steps }),
        'EX', 3600,
    );
    await simulateTypingAndSend(jid, `${parsed.confirmPrompt}\n\nConfermi? Rispondi sì o no.`);
    return true;
}

// ─────────────────────────────────────────────
// PENDING ACTION CONFIRMATION
// ─────────────────────────────────────────────

/**
 * Gestisce la conferma sì/no per azioni che richiedono approvazione esplicita.
 * Ritorna true se il messaggio è stato gestito.
 */
export async function handleAdminPendingAction(text: string, club: any, jid: string): Promise<boolean> {
    if (!club?.id) return false;
    const redis = getRedis();
    const pendingRaw = await redis.get(`admin:pending_action:${club.id}`);
    if (!pendingRaw) return false;

    const affirmative = /^(s[iì]|yes|ok|va bene|certo|conferm|procedi|esegui)/i.test(text.trim());
    const negative = /^(no|nope|annulla|lascia perdere|stop|non fare)/i.test(text.trim());

    if (!affirmative && !negative) return false;

    const { steps } = JSON.parse(pendingRaw);
    await redis.del(`admin:pending_action:${club.id}`);

    if (negative) {
        await sendMessage(jid, `Capito, operazione annullata.`);
        return true;
    }

    // Ricarica i dati freschi prima di eseguire
    const sevenDaysOut = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [upcomingMatches, allPlayers, allCourts] = await Promise.all([
        prisma.match.findMany({
            where: { clubId: club.id, startTime: { gte: new Date(), lte: sevenDaysOut }, status: { in: ['OPEN', 'LOCKED'] } },
            include: { court: true, MatchPlayer: { where: { leftAt: null }, include: { player: true } } },
            orderBy: { startTime: 'asc' },
            take: 30,
        }),
        prisma.player.findMany({
            where: { clubId: club.id, active: true },
            select: { id: true, name: true, phoneNumber: true, skillLevel: true },
        }),
        prisma.court.findMany({
            where: { clubId: club.id },
            select: { id: true, name: true, active: true, isCovered: true },
        }),
    ]);

    await executeAdminSteps(steps, club, jid, upcomingMatches, allPlayers, allCourts);
    return true;
}

// ─────────────────────────────────────────────
// EXECUTE STEPS
// ─────────────────────────────────────────────

async function executeAdminSteps(
    steps: AdminStep[],
    club: any,
    jid: string,
    upcomingMatches: any[],
    allPlayers: any[],
    allCourts: any[],
): Promise<void> {
    const fmtTimeLong = (d: Date) => d.toLocaleString('it-IT', {
        timeZone: 'Europe/Rome', weekday: 'long', day: 'numeric',
        month: 'long', hour: '2-digit', minute: '2-digit',
    });

    for (const step of steps) {
        const { command, params } = step;

        if (command === 'LIST_MATCHES') {
            let filtered = [...upcomingMatches];
            if (params.courtId) filtered = filtered.filter(m => m.courtId === params.courtId);
            if (params.dateFrom) {
                const from = new Date(params.dateFrom);
                filtered = filtered.filter(m => m.startTime >= from);
            }
            if (params.dateTo) {
                const to = new Date(params.dateTo + 'T23:59:59');
                filtered = filtered.filter(m => m.startTime <= to);
            }

            if (filtered.length === 0) {
                await simulateTypingAndSend(jid, 'Nessuna partita trovata per i criteri indicati.');
                continue;
            }

            const lines = filtered.map(m => {
                const players = m.MatchPlayer.map((mp: any) => mp.player.name || mp.player.phoneNumber).join(', ');
                const status = m.status === 'LOCKED' ? 'completa' : `aperta (${m.MatchPlayer.length}/4)`;
                return `${fmtTimeLong(m.startTime)}\n${m.court?.name || 'Campo'} (${status})\nGiocatori: ${players || 'nessuno'}`;
            });
            await simulateTypingAndSend(jid, `Partite trovate: ${filtered.length}\n\n${lines.join('\n\n')}`);
            continue;
        }

        if (command === 'LIST_PLAYERS') {
            let filtered = [...allPlayers];
            if (params.skillMin !== undefined) filtered = filtered.filter((p: any) => p.skillLevel >= params.skillMin);
            if (params.skillMax !== undefined) filtered = filtered.filter((p: any) => p.skillLevel <= params.skillMax);
            if (params.nameQuery) {
                const q = params.nameQuery.toLowerCase();
                filtered = filtered.filter((p: any) => (p.name || '').toLowerCase().includes(q));
            }

            if (filtered.length === 0) {
                await simulateTypingAndSend(jid, 'Nessun giocatore trovato per i criteri indicati.');
                continue;
            }

            const lines = filtered.map((p: any) =>
                `${p.name || 'N/A'} (livello ${p.skillLevel > 0 ? p.skillLevel : 'da assegnare'}) — ${p.phoneNumber}`,
            );
            await simulateTypingAndSend(jid, `Giocatori trovati: ${filtered.length}\n\n${lines.join('\n')}`);
            continue;
        }

        if (command === 'CANCEL_MATCH') {
            const matchIds: string[] = Array.isArray(params.matchIds) ? params.matchIds : [params.matchId].filter(Boolean);
            if (matchIds.length === 0) {
                await simulateTypingAndSend(jid, 'Nessuna partita specificata da cancellare.');
                continue;
            }

            const { cancelMatchesWithNotification } = await import('./match-notifications');
            const cancelled = await cancelMatchesWithNotification(matchIds, club.id, 'Cancellazione admin');
            await simulateTypingAndSend(jid, `${cancelled} partita${cancelled !== 1 ? 'e' : ''} cancellata${cancelled !== 1 ? 'e' : ''} e giocatori notificati.`);
            continue;
        }

        if (command === 'RESCHEDULE_MATCH') {
            const match = upcomingMatches.find(m => m.id === params.matchId);
            if (!match) {
                await simulateTypingAndSend(jid, 'Partita non trovata.');
                continue;
            }
            if (!params.newDay || !params.newTime) {
                await simulateTypingAndSend(jid, 'Specifica il nuovo giorno (YYYY-MM-DD) e orario (HH:MM).');
                continue;
            }

            const [y, mo, d] = params.newDay.split('-').map(Number);
            const [h, m] = params.newTime.split(':').map(Number);
            if (isNaN(y) || isNaN(h)) {
                await simulateTypingAndSend(jid, 'Formato data/ora non valido. Usa YYYY-MM-DD e HH:MM.');
                continue;
            }

            const noon = new Date(Date.UTC(y, mo - 1, d, 12, 0));
            const noonRomeHour = Number(noon.toLocaleString('en-US', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }));
            const offsetH = noonRomeHour - 12;
            let utcH = h - offsetH;
            let dayOffset = 0;
            if (utcH < 0) { utcH += 24; dayOffset = -1; }
            if (utcH >= 24) { utcH -= 24; dayOffset = 1; }
            const newStartTime = new Date(Date.UTC(y, mo - 1, d + dayOffset, utcH, m, 0));

            const durationMin = (club as any)?.matchDuration || 90;
            const slotMs = durationMin * 60 * 1000;
            if (match.courtId) {
                // Conflitto con overlap (non solo orario esatto): una partita da `durationMin` min si sovrappone
                const candidates = await prisma.match.findMany({
                    where: {
                        courtId: match.courtId, id: { not: match.id }, status: { in: ['OPEN', 'LOCKED'] },
                        startTime: { gte: new Date(newStartTime.getTime() - slotMs), lte: new Date(newStartTime.getTime() + slotMs) },
                    },
                    select: { startTime: true },
                });
                const conflict = candidates.some(c => Math.abs(c.startTime.getTime() - newStartTime.getTime()) < slotMs);
                if (conflict) {
                    await simulateTypingAndSend(jid, `Il campo è già occupato a quell'orario. Scegli un altro orario.`);
                    continue;
                }
            }

            const oldStartTime = match.startTime;
            await prisma.match.update({ where: { id: match.id }, data: { startTime: newStartTime, endTime: new Date(newStartTime.getTime() + slotMs) } });

            const { notifyMatchRescheduled } = await import('./match-notifications');
            await notifyMatchRescheduled(match.id, oldStartTime, newStartTime, club.id)
                .catch(err => logger.error({ err }, 'notifyMatchRescheduled failed'));

            const nPlayers = match.MatchPlayer.length;
            await simulateTypingAndSend(jid, `Partita spostata da ${fmtTimeLong(oldStartTime)} a ${fmtTimeLong(newStartTime)}. ${nPlayers > 0 ? `Ho avvisato ${nPlayers} giocatori.` : ''}`);
            continue;
        }

        if (command === 'UPDATE_PLAYER_SKILL') {
            const playerIds: string[] = Array.isArray(params.playerIds) ? params.playerIds : [params.playerId].filter(Boolean);
            if (playerIds.length === 0) {
                await simulateTypingAndSend(jid, 'Nessun giocatore specificato.');
                continue;
            }
            const newSkill = Number(params.newSkill);
            if (isNaN(newSkill) || newSkill < 1 || newSkill > 7) {
                await simulateTypingAndSend(jid, 'Il livello deve essere un numero tra 1.0 e 7.0.');
                continue;
            }

            // Scope per club (difesa in profondità): gli ID arrivano dal prompt LLM, mai mutare player di altri club
            await prisma.player.updateMany({ where: { id: { in: playerIds }, clubId: club.id }, data: { skillLevel: newSkill } });
            const names = allPlayers
                .filter((p: any) => playerIds.includes(p.id))
                .map((p: any) => p.name || p.phoneNumber);
            await simulateTypingAndSend(jid, `Livello aggiornato a ${newSkill} per: ${names.join(', ')}.`);

            // GAP #21: cancella PENDING invitation fuori range per i player aggiornati
            const lowerRange = club?.matchLowerRange ?? 1.0;
            const upperRange = club?.matchUpperRange ?? 1.0;
            const invalidInvitations = await prisma.invitation.findMany({
                where: {
                    playerId: { in: playerIds },
                    status: 'PENDING',
                    match: {
                        status: 'OPEN',
                        OR: [
                            { skillLevel: { lt: newSkill - upperRange } },
                            { skillLevel: { gt: newSkill + lowerRange } },
                        ],
                    },
                },
                select: { id: true },
            });
            if (invalidInvitations.length > 0) {
                await prisma.invitation.updateMany({
                    where: { id: { in: invalidInvitations.map((i: any) => i.id) } },
                    data: { status: 'IGNORED' },
                });
                logger.info({ playerIds, count: invalidInvitations.length, newSkill }, 'Cancelled out-of-range PENDING invitations after skill update');
            }
            continue;
        }

        if (command === 'DELETE_PLAYER') {
            const player = allPlayers.find((p: any) => p.id === params.playerId);
            if (!player) {
                await simulateTypingAndSend(jid, 'Giocatore non trovato.');
                continue;
            }
            await prisma.player.update({ where: { id: player.id }, data: { active: false } });
            await simulateTypingAndSend(jid, `${player.name || player.phoneNumber} rimosso dal circolo. Non riceverà più messaggi né inviti.`);
            continue;
        }

        if (command === 'DEACTIVATE_COURT') {
            const court = allCourts.find((c: any) => c.id === params.courtId);
            if (!court) {
                await simulateTypingAndSend(jid, 'Campo non trovato.');
                continue;
            }
            if (!court.active) {
                await simulateTypingAndSend(jid, `${court.name} è già disattivato.`);
                continue;
            }
            await prisma.court.update({ where: { id: court.id }, data: { active: false } });
            await simulateTypingAndSend(jid, `${court.name} disattivato.`);
            continue;
        }

        if (command === 'CHANGE_CLUB_HOURS') {
            const newOpen = params.openTime ?? club.openTime ?? '08:00';
            const newClose = params.closeTime ?? club.closeTime ?? '23:30';
            await prisma.club.update({ where: { id: club.id }, data: { openTime: newOpen, closeTime: newClose } });
            await simulateTypingAndSend(jid, `Orari aggiornati: ${newOpen}–${newClose}.`);
            continue;
        }

        logger.warn({ command, params }, 'executeAdminSteps: unhandled command');
    }
}
