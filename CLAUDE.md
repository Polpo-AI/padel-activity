# CLAUDE.md — Padel Matchmaking Bot

Questo file è la mappa operativa del progetto. Leggilo prima di toccare qualsiasi cosa.

---

## ⚠️ LESSONS LEARNED — Leggi sempre prima di toccare codice

Questi errori sono già stati commessi. Non ripeterli.

### 1. Locale e VPS devono essere sempre allineati
**Regola:** ogni modifica va committata + pushata su `main` + pullata sul VPS. MAI modificare file direttamente sul VPS senza poi aggiornare il locale (o viceversa). Verificare sempre con `git log --oneline -3` su entrambi prima di iniziare.
**Workflow corretto:**
```bash
# Locale
git add <files> && git commit && git push origin main
# VPS
cd /root/padel-staging && git pull origin main
systemctl restart padel-staging padel-worker-staging
git push origin HEAD:preview
```

### 2. Lock Redis NX in `startSingleOnboarding` — non rimuoverlo mai
**Bug reale (doppio):** (a) stato impostato DOPO il messaggio → race condition col debounce. (b) due `_handleBatchInner` concorrenti trovano entrambi "no state + no player" prima che il primo scriva Redis → doppio messaggio.
**Fix in place:** `redis.set(lockKey, '1', 'EX', 60, 'NX')` all'inizio di `startSingleOnboarding` — atomico, garantisce un solo avvio per JID. NON rimuovere questo lock.
**Regola aggiuntiva:** non hardcodiare `welcomeMessage` nelle config che chiamano `startSingleOnboarding` — usare il default della funzione.

### 3. Il nome del giocatore NON va mai estratto con fallback al testo grezzo
**Bug reale:** `let name = messageText.trim()` come fallback → il messaggio intero ("voglio prenotare domani alle 18") diventava il nome del giocatore.
**Regola:** il prompt AI deve restituire esplicitamente `"NULL"` se il nome non è trovato. Se è NULL, ri-chiedere — MAI usare il testo del messaggio come nome.

### 4. Nessun gruppo, nessun playerCount
**Bug reale:** il brain estraeva `playerCount` dal testo ("siamo in 3", "campo da 7") e creava partite con 3 o 7 giocatori.
**Regola:** il padel è sempre 4 giocatori. `playerCount` non esiste. Ogni giocatore prenota per sé. `INVITE_PREFERRED` è l'unico modo per coinvolgere un amico specifico.

### 5. skillLevel = 0 o negativo = nessuna wave
**Regola:** se `player.skillLevel <= 0`, la partita viene creata ma NON si avvia la wave. Il brain non deve promettere abbinamento con altri giocatori. Skill Test in attesa = può prenotare campo, non può ricevere inviti automatici.

### 6. `simulateTypingAndSend` già salva il messaggio nel DB
**Bug reale:** `messageHandler` salvava manualmente ogni risposta del bot → ogni messaggio veniva duplicato nel log `WhatsAppMessage`.
**Regola:** non salvare mai manualmente i messaggi outbound — `simulateTypingAndSend` lo fa già.

### 7. Fallback AI MAI identico due volte
**Regola:** il catch di `callBrain` deve restituire uno di N messaggi random, mai sempre lo stesso. Utente che riceve "Scusa, ho un problema tecnico" due volte di fila → pessima esperienza.

### 8. Reset DB locale: usare DIRECT_URL_STAGING (porta 5432), non DATABASE_URL (pgBouncer 6543)
**Regola:** per operazioni dirette (script, `db push`, `migrate dev`) usare sempre il valore letterale di `DIRECT_URL_STAGING` / porta 5432. Il pgBouncer su 6543 non supporta prepared statements. Il parsing `$(grep DIRECT_URL .env ...)` può estrarre la variabile sbagliata — passare sempre il valore esplicito.
```bash
DATABASE_URL="postgresql://postgres.ildhffoxuufcbvmmqitj:...@aws-1-eu-west-1.pooler.supabase.com:5432/postgres" npx tsx src/scripts/db-reset.ts
```

### 9. `prisma db push` invece di `migrate dev` su DB condiviso
**Regola:** il DB Supabase ha drift rispetto alla migration history → `migrate dev` va in errore. Usare sempre `prisma db push` per sincronizzare lo schema senza toccare la history.

### 12. Dopo ogni `prisma db push`, rigenerare il client su VPS con `prisma generate`
**Bug reale:** `notes` aggiunto allo schema, `db push` ok, ma il client JS sul VPS era vecchio → `Unknown argument 'notes'` a runtime → errore Prisma grezzo inviato all'utente.
**Regola:** dopo ogni `prisma db push` sul VPS, eseguire sempre `npx prisma generate` + restart.
```bash
cd /root/padel-staging
npx prisma generate
systemctl restart padel-staging padel-worker-staging
```

### 11. Ogni modifica schema va applicata sia a staging che a produzione
**Regola:** `prisma db push` va eseguito su **entrambi** i DB dopo ogni modifica a `schema.prisma`. Staging usa `DIRECT_URL_STAGING`, produzione usa `DIRECT_URL`.
```bash
# Staging
DATABASE_URL="<DIRECT_URL_STAGING>" npx prisma db push
# Produzione
DATABASE_URL="<DIRECT_URL>" npx prisma db push
```
MAI dimenticare la produzione — uno schema disallineato causa crash silenziosi a runtime.

### 10. Il brain genera il messaggio PRIMA che `executeAction` venga eseguita
**Conseguenza:** il brain non conosce il campo assegnato, il prezzo, ecc. al momento della risposta.
**Pattern corretto:** il brain manda una conferma breve e generica. `executeAction` restituisce `{ matchId }`. Il messageHandler manda poi una scheda strutturata separata con i dettagli reali (campo, coperto/scoperto, prezzo, indirizzo).

---

---

## Stack Tecnologico

| Layer | Tecnologia |
|-------|-----------|
| Runtime | Node.js 20 + TypeScript (tsx, no build step) |
| Framework HTTP | Express |
| ORM / DB | Prisma + PostgreSQL (Supabase) |
| Cache / Code | Redis (ioredis) — `127.0.0.1:6379` sul VPS |
| Code WhatsApp | Baileys (`@whiskeysockets/baileys`) |
| AI | Anthropic Claude (Haiku per classificazioni veloci, Sonnet 4.6 per brain/conversazione) |
| Code interne | BullMQ su Redis |
| Process manager | systemd (NON PM2 — rimosso) |
| Test | Vitest |

---

## Ambienti

| Ambiente | Cartella VPS | Branch GH | Systemd |
|----------|-------------|-----------|---------|
| Staging | `/root/padel-staging` | `preview` | `padel-staging.service` + `padel-worker-staging.service` |
| Produzione | `/root/padel-prod` | `main` | `padel-prod.service` + `padel-worker-prod.service` |

VPS: `root@46.225.212.159` (SSH con chiave `~/.ssh/id_ed25519`)

Comandi utili sul VPS:
```bash
systemctl restart padel-staging padel-worker-staging
journalctl -u padel-staging -f           # log in tempo reale
journalctl -u padel-staging --since "10 min ago" --no-pager
```

**Workflow deploy staging:**
1. Commit + push locale → `main`
2. Sul VPS: `cd /root/padel-staging && git pull origin main`
3. `systemctl restart padel-staging padel-worker-staging`
4. Push da VPS a `preview`: `git push origin HEAD:preview`

---

## Architettura dei Processi

Due processi separati per ambiente:

- **`src/index.ts`** — API HTTP (Express) + WhatsApp bot (Baileys)
  - Gestisce messaggi in entrata, booking, onboarding, inviti
  - Espone `/api/webhooks`, `/api/dashboard`, `/api/setup`, `/health`, `/dashboard`, `/setup`

- **`src/worker.ts`** — Worker BullMQ
  - Consuma code: `wave`, `maintenance`, `recovery`, `reminder`
  - Non ha connessione WhatsApp diretta — manda messaggi via `simulateTypingAndSend`

---

## Mappa File → Responsabilità

### Entry point
| File | Cosa fa |
|------|---------|
| `src/index.ts` | Avvia Express, Baileys, schedula job manutenzione |
| `src/worker.ts` | Avvia worker BullMQ per le code |

### API
| File | Cosa fa |
|------|---------|
| `src/api/dashboard.api.ts` | REST API dashboard club (auth JWT, CRUD match/player/court, health check reale) |
| `src/api/webhooks.ts` | Webhook esterno per creare match da sistemi terzi (autenticato via HMAC) |
| `src/api/setup.api.ts` | Endpoint `POST /api/setup/club` — wizard onboarding circolo (auth via `SETUP_SECRET`) |
| `src/setup.html` | Wizard HTML 6-step per onboarding circolo, accessibile a `/setup` |

### Core Services
| File | Cosa fa |
|------|---------|
| `src/services/whatsapp.ts` | Connessione Baileys, invio messaggi, gestione reconnect, recovery messaggi offline |
| `src/services/messageHandler.ts` | Routing messaggi: onboarding attivo → brain. Dopo BOOK_FIELD invia scheda prenotazione dettagliata |
| `src/services/brain.ts` | **Cervello AI del bot** — unica chiamata Claude Sonnet con contesto completo → `{ message, action, params }`. Nessuna frase hardcodata |
| `src/services/inbound-queue.ts` | Debouncing messaggi in entrata (10s per JID), batch processing, recovery dopo crash |
| `src/services/ai.ts` | Wrapper AI: generazione testi inviti, requiresResponse(), inferGender() |
| `src/services/conversational-manager.ts` | ⚠️ LEGACY — ancora presente ma non più nel path principale. Il brain gestisce tutto |

### Booking & Matchmaking
| File | Cosa fa |
|------|---------|
| `src/services/booking.ts` | buildRomeTime() per timezone IT — ancora usato per conversione orari. Flusso step-by-step legacy |
| `src/services/matchmaker.ts` | Orchestra wave di inviti, trova match aperto, buildMatchSocialContext() |
| `src/services/scoring.ts` | Selezione giocatori per wave (skill range, gender, reliability), processMatchOutcomes() |
| `src/services/redirect.ts` | Algoritmo P1-P5: trova 5 alternative quando slot è pieno (redirectGroup) |
| `src/services/recovery.ts` | Gestisce match non riempibili, checkMatchTimeouts, handleMatchUnfillable |
| `src/services/pricing.ts` | Calcolo prezzo per slot, copertura economica partita |

### Onboarding
| File | Cosa fa |
|------|---------|
| `src/services/onboarding-flow.ts` | Flusso onboarding step-by-step (nome → telefono → finalizza) |
| `src/services/onboarding.ts` | Gestione stati AWAITING_* su Redis, bring friend/group, setAwaitingState/getAwaitingState |

### Stato Conversazionale
| File | Cosa fa |
|------|---------|
| `src/services/conversation-state.ts` | setState/getState su Redis (primary) + PostgreSQL (fallback), TTL 24h default |

### Infrastruttura
| File | Cosa fa |
|------|---------|
| `src/services/db.ts` | Singleton Prisma client |
| `src/services/queue.ts` | Singleton BullMQ queues (wave, maintenance, recovery, reminder), checkSilentMatches |
| `src/services/whatsapp-rate-limiter.ts` | Rate limiting invio messaggi WA |
| `src/utils/retry.ts` | Retry con backoff esponenziale per chiamate esterne |
| `src/utils/circuit-breaker.ts` | Circuit breaker per AI e servizi esterni |
| `src/utils/notify-admin.ts` | Notifiche admin su WhatsApp per eventi critici |

### Workers BullMQ
| File | Cosa fa |
|------|---------|
| `src/workers/wave.worker.ts` | Processa job `process-wave` → chiama matchmaker.processWave() |
| `src/workers/maintenance.worker.ts` | daily-reset, check-timeouts, check-silent-matches, cleanup-messages, cleanup-pending-invitations |
| `src/workers/recovery.worker.ts` | Gestisce recovery partite in difficoltà |
| `src/workers/reminder.worker.ts` | Promemoria partite ai giocatori confermati |

### Prompts AI
Tutti in `src/prompts/*.md` — modificabili senza toccare codice TypeScript.

---

## Modello Dati (Prisma)

| Model | Ruolo |
|-------|-------|
| `Club` | Circolo — configura regole (matchLowerRange, matchUpperRange, waveMultiplier, maxDailyMessages, **city, address**) |
| `Player` | Giocatore — skillLevel float 1.0-7.0 (assegnato SOLO dal club), reliabilityScore, dailyMessagesCount |
| `Court` | Campo — nome, isCovered |
| `Match` | Partita — status: OPEN→LOCKED→ARCHIVED, skillLevel, playersNeeded |
| `MatchPlayer` | Join Player↔Match — joinedAt, leftAt |
| `Invitation` | Invito wave — status: PENDING→ACCEPTED/REJECTED/IGNORED |
| `WhatsAppMessage` | Log audit messaggi in/out — NON usato per stato conversazionale |
| `ConversationState` | Fallback DB per stati Redis (primary è sempre Redis) |
| `MatchFeedback` | Feedback post-partita |
| `CourtPrice` | Prezzi per fascia oraria |

---

## Architettura Redis vs PostgreSQL

**Regola fondamentale:** Redis = effimero con TTL, DB = persistente.

| Chiave Redis | TTL | Scopo |
|-------------|-----|-------|
| `state:awaiting:{jid}` | 24h | Stati AWAITING_* (invitation choice, friend phone, ecc.) |
| `state:booking:{jid}` | 24h | Flusso prenotazione step-by-step |
| `state:onboarding:{jid}` | 24h | Flusso onboarding step-by-step |
| `state:unclear:{jid}` | 24h | Retry classificazione intent |
| `state:role:{jid}:*` | 1h | AWAITING_REDIRECT_CHOICE |
| `state:pending-intent:{jid}` | 10min | Intent pendente durante onboarding |
| `wave_lock:{matchId}` | 15s | Mutex distributed lock per wave |
| `feedback_requested:{matchId}:{playerId}` | 24h | Dedup feedback request |
| `warning:timeout:{matchId}` | 1h | Dedup warning "ultima chiamata" |
| `{prefix}inbound:{jid}` | 10min | Coda messaggi in entrata (debounce) |

---

## Workflow Logico — Messaggio in Entrata

```
WhatsApp message
    ↓
inbound-queue.ts (debounce 10s, raggruppa batch per JID)
    ↓
messageHandler._handleBatchInner()
    ├── De-LID: risolve @lid → numero italiano reale
    ├── Deduplication check (WhatsAppMessage.messageId)
    ├── Player lookup (by phoneNumber + clubId)
    │
    ├── [ONBOARDING ATTIVO?] — controlla Redis:
    │   └── onboarding state → continueOnboarding()
    │       (nome → finalizzazione → pending-intent replay)
    │
    ├── [PLAYER NON TROVATO] → startSingleOnboarding() con pending-intent
    │   ⚠️ setState PRIMA di simulateTypingAndSend (evita race condition)
    │
    └── [PLAYER TROVATO, NESSUN ONBOARDING] → brain.ts
        ├── buildBrainContext() — carica inviti, partite, messaggi recenti
        ├── callBrain() → Claude Sonnet → { message, action, params }
        ├── simulateTypingAndSend(message)
        └── executeAction(action, params)
            ├── NONE — solo risposta conversazionale
            ├── ACCEPT_INVITATION — transazione con SELECT FOR UPDATE
            ├── REJECT_INVITATION
            ├── CANCEL_MATCH — riapre match se era LOCKED
            ├── BOOK_FIELD — crea/unisce match + wave → restituisce matchId
            │   └── ➜ messageHandler invia scheda prenotazione (campo, prezzo, indirizzo)
            ├── OPT_OUT — player.active = false + notifica admin
            └── INVITE_PREFERRED — cerca player per nome nel club
```

**BrainAction types:** `NONE | ACCEPT_INVITATION | REJECT_INVITATION | CANCEL_MATCH | BOOK_FIELD | OPT_OUT | INVITE_PREFERRED`

---

## Workflow Wave (Inviti)

```
Match creato (dashboard o webhook)
    ↓
waveQueue.add('process-wave', { matchId, waveNumber: 1 }, { delay: 30-90s })
    ↓
wave.worker.ts → matchmaker.processWave()
    │
    ├── FASE 1 (con distributed lock 15s):
    │   ├── Verifica match ancora OPEN e posti disponibili
    │   ├── selectPlayersForWave() — skill range, gender, reliability, excludedIds
    │   ├── Wave 1: prepend preferred players se presenti
    │   └── createMany invitations PENDING (bulk, atomico)
    │
    ├── FASE 2 (senza lock):
    │   ├── Per ogni player: buildMatchSocialContext() → generateInvitation() → sendWA
    │   ├── Ricarica stato match ogni 3 invii (anti N+1)
    │   └── Sleep 15-45s tra un invio e l'altro
    │
    └── Schedula wave successiva (computeNextWaveDelayMs)
```

**Algoritmo di selezione per ondata (EMA individuale):**
La dimensione di ogni wave non usa un moltiplicatore fisso, ma accumula giocatori uno per uno finché la somma cumulativa delle loro EMA individuali raggiunge il numero di posti da coprire nella wave corrente (`while Somma(EMA_i) < posti_residui: aggiungi prossimo`). Questo produce wave più piccole con giocatori affidabili e più grandi con giocatori poco affidabili. Se la lista degli eligibili si esaurisce prima di raggiungere la soglia, il sistema attende le risposte degli invitati già inviati prima di dichiarare la partita non riempibile.

---

## Skill Level

- Float **1.0–7.0** (standard padel internazionale)
- Assegnato **ONLY** dal club: skill test fisico o modifica manuale dalla dashboard
- Il bot **non chiede mai** il livello all'utente
- Nuovi giocatori registrati con `skillLevel: 0` in attesa di skill test (non ricevono wave, possono prenotare campi)
- Le wave rispettano `matchLowerRange` / `matchUpperRange` del club (es. ±1.0)

---

## Timezone

- Tutti gli orari in DB sono **UTC**
- Output verso utenti: sempre `{ timeZone: 'Europe/Rome' }` in `toLocaleTimeString/toLocaleDateString`
- Input utente (es. "alle 18"): convertito con `buildRomeTime()` in `booking.ts` che gestisce DST automaticamente

---

## Convenzioni di Codice

- **No build step**: tsx esegue TypeScript direttamente in produzione
- **Import dinamici** per moduli pesanti o circolari: `await import('./recovery')`
- **Logger**: pino, sempre `logger.info/warn/error({ context }, 'message')`
- **Errori non fatali**: try/catch con log, mai propagare eccezioni da operazioni best-effort (es. DB fallback)
- **Race condition**: transazioni Prisma con `SELECT ... FOR UPDATE` per operazioni critiche (accettazione invito)
- **Prompts**: in `src/prompts/*.md`, caricati a runtime — modificabili senza redeploy del codice
- **Nessun livello self-assigned**: skillLevel solo da club, mai da onboarding o conversazione
- **Nessun playerCount**: ogni giocatore prenota sempre per sé solo (4 posti totali). `INVITE_PREFERRED` è l'unico modo per coinvolgere un amico specifico
- **DB reset script**: `src/scripts/db-reset.ts` — usare con `DATABASE_URL="$DIRECT_URL_STAGING" npx tsx src/scripts/db-reset.ts`

---

## Scelte Architetturali Chiave

| Scelta | Motivazione |
|--------|-------------|
| Redis primary per stati conversazionali | TTL nativo, sub-ms, no schema migrations |
| PostgreSQL fallback per stati | Resilienza se Redis crasha |
| Distributed lock (wave_lock) 15s | Evita double-send in wave parallele |
| Debounce 10s per JID | WhatsApp spezza messaggi lunghi in più pezzi — li raggruppiamo |
| `type=append` messaggi offline | Baileys emette append al reconnect — recuperati e filtrati con AI (requiresResponse) |
| De-LID in _handleBatchInner | WhatsApp LID (@lid) ≠ numero telefono — risolto da `remoteJidAlt` |
| buildRomeTime() | Evita doppia conversione UTC quando l'utente fornisce orario italiano |
| cleanup-pending-invitations ogni ora | Invitation PENDING su match passati inquinano acceptanceRate e statistiche |
| selectPlayersForWave esclude tutti gli invitati | Evita reinviti per lo stesso match (qualsiasi status) |
| Brain + scheda separata per BOOK_FIELD | Il brain non conosce il campo al momento della risposta — scheda inviata dopo executeAction con dati reali |
| OPT_OUT rilevato da AI (brain) | Nessun "rispondi stop" nei messaggi — il brain capisce naturalmente "non voglio più messaggi" e simili |
| `prisma db push` invece di `migrate dev` | DB Supabase condiviso ha drift dalla migration history — db push sincronizza senza toccarla |

---

## Job di Manutenzione (ogni quanto girano)

| Job | Frequenza | Cosa fa |
|-----|-----------|---------|
| `daily-reset` | 00:00 ogni notte | Azzera dailyMessagesCount su tutti i player |
| `check-timeouts` | ogni 30min | Cancella match OPEN scaduti senza abbastanza giocatori |
| `check-silent-matches` | ogni 30min | Rilancia wave su match OPEN che non ricevono inviti da troppo tempo |
| `process-match-outcomes` | ogni 2h | Chiude invitation PENDING di match terminati, aggiorna reliability |
| `cleanup-messages` | 03:00 ogni notte | Elimina WhatsAppMessage > 30 giorni |
| `cleanup-pending-invitations` | ogni ora | PENDING su match passati → IGNORED; PENDING > 48h → IGNORED |
