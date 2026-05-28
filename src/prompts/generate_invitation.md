Scrivi un invito WhatsApp per {{playerName}} per una partita di padel.

Dati certi (usa ESATTAMENTE questi, non inventare nulla):
- Giorno: {{weekdayStr}} (usa esattamente questo nome del giorno)
- Fascia: {{timeOfDay}} (mattina/pomeriggio/sera)
- Ora: {{timeStr}}
- Tipo partita: {{matchTypeLabel}} (maschile/femminile/mista — vuoto se non specificato)
- Campo: {{courtInfo}} (scoperto/coperto — menziona SOLO se coperto)
- Amico che invita: {{isFriend}} (true/false)

Stato del gruppo (usa solo fatti veri):
- Confermati: {{confirmedCount}}
- Posti liberi: {{spotsLeft}}
- Info giocatori: {{playersInsight}} (vuoto se il gruppo è ancora da formare — NON inventare presenze)

Struttura del messaggio:
1. Apertura con saluto personale: "Ciao {{playerName}}, come va?" — varia la formula tra: "come va?", "come stai?", "tutto bene?", "tutto ok?". Tono tranquillo, come un amico che ti scrive.
2. Poi la partita, come frase a sé: "[giorno] [fascia] c'è una partita di padel[tipo] alle [ora]"
   - Se isFriend=true: "un amico ti ha invitato a padel [giorno] [fascia] alle [ora]"
3. Solo se confirmedCount > 0: aggiungi una frase breve usando playersInsight (es. "ci sono già 3 persone di livello 3.0–3.5"). MAI nominare i giocatori, MAI inventare o esagerare.
4. Chiudi SEMPRE con una domanda secca (obbligatoria): "Ti può interessare?", "Ci sei?", "Sei dei nostri?", "Ti unisci?", "Che dici?"

Regole:
- Max 3-4 frasi brevi totali (saluto + partita + eventuale info gruppo + domanda)
- Tono colloquiale, come un amico che scrive su WhatsApp
- Max 1 emoji per messaggio, preferibilmente nessuna
- MAI iniziare con "Ciao {{playerName}}" seguito da punto esclamativo — tono normale, non entusiasta
- MAI menzionare il nome del campo
- MAI dire che "sarà una bella partita" o "promette bene" se il gruppo è ancora vuoto (confirmedCount = 0)
- NON usare asterischi o grassetto
- Solo il testo del messaggio, niente prefissi
