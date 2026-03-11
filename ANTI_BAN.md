# 🛡️ Strategia Anti-Ban e Simulazione Umana (Baileys)

Questo progetto non utilizza le API Cloud ufficiali di Meta. Invece, impiega un **workaround basato su [Baileys](https://github.com/WhiskeySockets/Baileys)** che simula una connessione WhatsApp Web. Per proteggere l'account dalla sospensione, abbiamo implementato diversi livelli di simulazione del comportamento umano.

## 🧠 Perché questo approccio?
Le API ufficiali sono costose, richiedono l'approvazione dei modelli di messaggio e sono pensate per le grandi aziende. Baileys ci permette di automatizzare un numero standard con totale flessibilità, rendendolo ideale per bot di messaggistica "informale" come il nostro.

## 🛠️ Livelli di Simulazione (In `src/services/whatsapp.ts`)

### 1. Read Receipts (Spunte Blu)
Il bot non risponde "al buio". Prima di ogni azione, invia un segnale di "messaggio letto" all'interlocutore. Questo imita il comportamento di un utente che apre la chat.

### 2. Delay di Reazione
Tra la ricezione di un messaggio e l'inizio della scrittura, il bot attende un tempo variabile (jittered sleep). Questo simula il tempo necessario a un umano per notificare il messaggio e leggerlo.

### 3. Composing Presence ("Sta scrivendo...")
Il bot attiva lo stato `composing` prima di inviare.
- **Typing Speed**: La durata della scrittura è proporzionale alla lunghezza del messaggio (3.3 caratteri al secondo mediamente).
- **Pause di Riflessione**: Esiste una probabilità del 30% che il bot "smetta di scrivere" a metà frase per 1-2 secondi, simulando un ripensamento, prima di riprendere.

### 4. Message Chunking
Se il messaggio è lungo (es. più di 80 caratteri), viene spezzato in due "bolle" distinte. La seconda bolla viene inviata dopo un breve intervallo, simulando l'invio di un pensiero aggiuntivo.

### 5. Jitter e Casualità
Ogni attesa temporale nel codice non è mai fissa (es. 2 secondi), ma include un "jitter" di ±500ms. Questo evita che i server di WhatsApp rilevino pattern con cadenza meccanica.

### 6. Fingerprinting del Browser
Il bot si identifica ai server di WhatsApp come un browser **Chrome su macOS**, rendendo il traffico indistinguibile da una normale sessione di WhatsApp Web.

## 🚀 Come Testare in Sicurezza
Usa la variabile `DRY_RUN=true` nel file `.env`. In questa modalità:
- Il bot logga tutto quello che farebbe nel terminale.
- **Nessun messaggio viene realmente inviato.**
- Puoi verificare tutta la logica di matchmaking e database senza rischiare nulla.

---
*Nota: Anche con queste precauzioni, l'uso di librerie non ufficiali comporta sempre un minimo rischio. Si consiglia di iniziare con numeri di test.*
