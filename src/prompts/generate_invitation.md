Scrivi un invito WhatsApp per {{playerName}} per una partita di padel.

Dettagli della partita:
- Giorno: {{weekdayStr}} {{dateStr}} alle {{timeStr}} — usa ESATTAMENTE questo giorno della settimana, non inventarlo
- Campo: {{courtName}} ({{courtInfo}}) {{courtIcon}}
- Quota: €{{pricePerPerson}} a testa
- Stato gruppo: {{confirmedCount}}/{{totalNeeded}} confermati, mancano {{spotsLeft}} posti
- {{isFriend}}

Segnali sul gruppo già confermato:
{{playersInsight}}

Regola fondamentale — scegli l'apertura in base allo stato reale del gruppo:
- {{confirmedCount}} = 0 → il gruppo è ancora da formare, NON dire "manchi solo tu" o "siamo quasi al completo". Usa: "Si sta mettendo insieme una partita", "Ci sarebbe una partita interessante", "Ho pensato a te per questa partita"
- {{confirmedCount}} = 1 o 2 → gruppo in costruzione. Usa: "Si sta mettendo insieme un bel gruppo", "Abbiamo già qualcuno, mancano {{spotsLeft}} posti", "Esce fuori qualcosa di bello"
- {{confirmedCount}} = {{totalNeeded}} - 1 (manca 1 solo posto, cioè {{spotsLeft}} = 1) → SOLO in questo caso puoi usare: "Manchi solo tu", "Manca solo un posto", "Sei l'ultimo che cerchiamo"
- Non inventare mai quante persone ci sono — usa sempre i numeri forniti sopra

Altre regole:
- Max 3-4 frasi, tono colloquiale e diretto come un amico che scrive su WhatsApp
- Scegli 1-2 segnali tra quelli forniti per costruire il gancio: se giocano spesso → affidabilità; se ha già giocato con loro → familiarità
- Includi sempre data, ora, campo con icona coperto/scoperto
- Se c'è un prezzo, includilo
- Termina con una call to action breve tipo "Ci sei?" o "Ti aspettiamo!"
- Non usare false urgenze tipo "è l'ultimo posto" o "fai in fretta" — a meno che {{spotsLeft}} = 1
- Non iniziare il messaggio con "Ciao {{playerName}}" — il nome è già nel contesto WhatsApp
- Solo il testo del messaggio, niente prefissi o spiegazioni
