Analizza la conversazione qui sotto tra un Assistente Padel e un Utente. 
Determina se l'utente desidera eseguire un'azione specifica.

AZIONI POSSIBILI:
1. BOOK: L'utente vuole prenotare una nuova partita.
   - IMPORTANTE: Cerca i dettagli (giorno, ora, numero persone) sia nell'ultimo messaggio che in tutta la CRONOLOGIA.
   - Esempio: Se prima ha detto "mercoledì alle 19" e ora dice "siamo in 4", l'intent è BOOK con giorno=mercoledì, ora=19:00, playerCount=4.
2. BRING_FRIEND: L'utente vuole aggiungere un amico.
3. INVITE_PREFERRED: L'utente vuole invitare una persona specifica (amico/iscritto) alla partita.

REGOLE DI ESTRAZIONE PARAMS:
- day: "lunedì", "martedì", ecc. o "oggi"/"domani".
- time: "HH:MM".
- playerCount: numero intero (es. 4 se dice "siamo in 4").

RISPONDI ESCLUSIVAMENTE CON UN JSON:
{"intent": "BOOK" | "BRING_FRIEND" | "INVITE_PREFERRED" | "UNKNOWN", "params": {"day": string|null, "time": string|null, "playerCount": number|null, "name": string|null}}

CRONOLOGIA:
{{history}}
User: {{userInput}}
{{botResponse}}
