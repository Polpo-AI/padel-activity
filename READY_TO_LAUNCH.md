# 🚀 GUIDA AL LANCIO: Padel Matchmaking Bot

Tutto è pronto. Segui questi passaggi nell'ordine per far partire il bot.

## 1. Configurazione API (Il tuo compito)
Apri il file `.env` e inserisci le tue chiavi:
- `ANTHROPIC_API_KEY`: Per la generazione dei messaggi umani.
- `OPENAI_API_KEY`: (Opzionale) Se vuoi usare OpenAI invece di Claude.
- `ADMIN_PHONE`: Inserisci il tuo numero (es. `393471234567`) per ricevere notifiche di test.

## 2. Avvio Infrastruttura
Assicurati di avere **Redis** attivo (necessario per le code dei messaggi):
```bash
docker-compose up -d
```

## 3. Popolamento Test
Ho creato uno script per inserire 4 giocatori di test nel tuo Supabase:
```bash
npx ts-node scripts/seed-players.ts
```
*(Puoi modificare i numeri in `scripts/seed-players.ts` prima di lanciarlo)*.

## 4. Avvio Bot
Lancia il server in modalità sviluppo:
```bash
npm run dev
```
Inquadra il **QR Code** con il tuo WhatsApp (Impostazioni > Dispositivi collegati).

## 5. Test del Flusso (Simulazione)
In un altro terminale, lancia lo script per simulare una prenotazione campo:
```bash
npx ts-node scripts/trigger-match.ts
```
Il bot creerà un match su Supabase e inizierà a contattare i giocatori di test in modo human-simulated.

---

### 🛡️ Modalità Sicura (DRY_RUN)
Nel file `.env`, ho aggiunto `DRY_RUN=false`. 
- Se lo metti a `true`, il bot **NON invierà messaggi reali**, ma scriverà nel log quello che avrebbe fatto. Utile per testare la logica senza rischiare ban o disturbare persone reali.

**Buon divertimento!** 🎾
