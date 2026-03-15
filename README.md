# 🎾 Padel Matchmaking Bot (Polpo AI)

Bot WhatsApp intelligente per la gestione delle prenotazioni e del matchmaking dinamico per i Circoli di Padel. 
Sviluppato con **TypeScript**, **Prisma (PostgreSQL)**, **Redis** e potenziato da **Anthropic Claude** per conversazioni fluide.

---

## 🛡️ 1. Strategia Anti-Ban (Simulazione Umana)

Il bot utilizza la libreria [Baileys](https://github.com/WhiskeySockets/Baileys) per simulare una sessione WhatsApp Web, applicando tecniche avanzate per proteggere l'account dalla sospensione:

*   **Spunte Blu (Read Receipts)**: Invia la conferma di lettura prima di elaborare la risposta.
*   **Delay di Reazione (Jitter)**: Attende un tempo casuale (jittered) simulando la lettura del messaggio.
*   **Composing Presence ("Sta scrivendo...")**: 
    - Attiva lo stato di scrittura proporzionale alla lunghezza del testo (~3.3 char/sec).
    - Simula pause di riflessione casuali (durata 1-2s) nel 30% dei messaggi lunghi.
*   **Message Chunking**: Messaggi lunghi vengono spezzati in più nuvolette inviate a breve distanza.
*   **Fingerprinting**: Si presenta ai server come un browser Chrome su macOS standard.

> ⚠️ **Dry Run**: Imposta `DRY_RUN=true` nel `.env` per testare la logica in sicurezza senza inviare reali messaggi WhatsApp.

---

## 🧠 2. Logica di Matchmaking & Regole (Implementate)

### 📊 Sistema Livelli (1.0 - 7.0)
*   I giocatori vengono valutati su scala decimale (es. 2.5 principiante, 4.0 intermedio).
*   **Nuovi Giocatori (Livello 0)**: Non possono giocare subito. Vengono invitati a fare uno **Skill Test** (lezione di valutazione) con il maestro del circolo.

### ⚖️ Range di Livello Asimmetrico
*   Ogni Club configura margini superiori ed inferiori (es. −0.3 / +0.5).
*   Il sistema invita solo giocatori compatibili con il range per garantire partite equilibrate.

### 🤝 Giocatori Preferiti & On-Demand
*   **Preferiti**: All'apertura del match, il creatore può indicare nomi prioritari da invitare istantaneamente nella prima Wave.
*   **On-Demand**: In qualsiasi momento è possibile scrivere *"Invita Mario Rossi"* per forzare una ricerca, controllo livello ed invio invito diretto.

### 🚫 No Guest Anonimi e Limiti Configurato
*   Disattivata la creazione di guest "+1" anonimi per tracciare correttamente le anagrafiche.
*   **Configurazione da Dashboard**: Il numero massimo di messaggi giornalieri inviabili a un giocatore è regolabile da Slider (campo `maxDailyMessages`).

---

## 🛠️ 3. Setup Tech & Comandi

### Prerequisiti
*   Node.js (v18+) & Docker (per Redis/Postgres se locale).

### Installazione
```bash
npm install
npx prisma generate
npx prisma db push
```

### Avvio (PM2 Consigliato)
```bash
# Avvio Bot Principale
npx pm2 start ecosystem.config.cjs

# Avvio Dashboard (Front-End)
cd dashboard && npm run dev
```

### Manutenzione Automatica
La pulizia e i trigger timeout partono in Background via Workers (`maintenance.worker.ts`) gestiti da code Redis (BullMQ).

---
*Sviluppato con cura dal Team Polpo AI* 🐙
