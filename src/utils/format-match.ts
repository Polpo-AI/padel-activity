/**
 * Formattazione partita per i messaggi (Punto 5).
 * Regola: giorno + ora in priorità. Mai nome o tipo campo nei messaggi conversazionali
 * (annullata/rischedulata/posto preso): quelli restano solo nelle card, conferme e proposte slot.
 */

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// "Sabato 7 Giugno alle 18:30"
export function formatMatchSlot(d: Date): string {
  const tz = { timeZone: 'Europe/Rome' } as const;
  const weekday = cap(d.toLocaleString('it-IT', { ...tz, weekday: 'long' }));
  const day = d.toLocaleString('it-IT', { ...tz, day: 'numeric' });
  const month = cap(d.toLocaleString('it-IT', { ...tz, month: 'long' }));
  const time = d.toLocaleString('it-IT', { ...tz, hour: '2-digit', minute: '2-digit' });
  return `${weekday} ${day} ${month} alle ${time}`;
}
