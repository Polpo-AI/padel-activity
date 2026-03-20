/**
 * Divide un testo in bolle WhatsApp naturali.
 * Ogni emoji conclude il pensiero corrente — il testo dopo inizia una nuova bolla.
 * Nessuna bolla inizia con un'emoji.
 */
export function splitAtEmoji(text: string): string[] {
    const emojiRegex = /\p{Extended_Pictographic}+/gu;
    const segments: string[] = [];
    let last = 0;

    for (const match of text.matchAll(emojiRegex)) {
        const before = text.slice(last, match.index!).trimStart();
        const emojis = match[0];

        if (before.trim()) {
            // testo prima dell'emoji → segmento che termina con l'emoji
            segments.push((before + emojis).trim());
        } else if (segments.length > 0) {
            // emoji consecutiva o a inizio testo → appendila all'ultimo segmento
            segments[segments.length - 1] += emojis;
        }
        // emoji a inizio assoluto senza segmenti precedenti → droppata

        last = match.index! + emojis.length;
    }

    const tail = text.slice(last).trim();
    if (tail) segments.push(tail);

    return segments.filter(s => s.trim().length > 0);
}
