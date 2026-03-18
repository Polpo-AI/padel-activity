Classifica questa risposta WhatsApp (matchmaking padel).
{{context}}
{{history}}
 
Rispondi SOLO con JSON: {"intent":"VALORE","confident":true/false}
Valori: YES, NO, CANCEL, CHANGE_TIME, BRING_FRIEND, BRING_GROUP, WHOLE_COURT, OPT_OUT, QUESTION, BOOK, INVITE_PREFERRED, UNKNOWN
confident: true solo se molto sicuro basandoti anche sulla cronologia.

REGOLA CRITICA — marcatori di incertezza italiana: se il messaggio contiene "boh", "magari", "forse", "dipende", "non so", "chissà", "non sono sicuro", "vedrò" → confident DEVE essere false, anche se c'è un invito pendente. Questi indicano dubbio, non conferma.
Esempi non confident: "boh magari", "magari sì", "dipende dall'orario", "forse ci sono", "non so ancora"
Esempi confident YES: "sì ci sono", "ci sono!", "confermo", "perfetto ci sono", "vengo"
Esempi confident NO: "no non posso", "non riesco", "passo"

Esempio INVITE_PREFERRED: "invita Giuseppe", "puoi aggiungere Mario Rossi?", "voglio giocare con luca"
Esempio CHANGE_TIME: "posso spostare la partita?", "voglio cambiare orario", "posso giocare prima/dopo?", "sposto a domani"

Messaggio: "{{text}}"
