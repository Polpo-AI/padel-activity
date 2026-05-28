# ARCHITECTURE.md — Padel Matchmaking Bot

Riferimento architetturale. Per regole operative → vedi [CLAUDE.md](CLAUDE.md).

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

## Architettura dei Processi

Due processi separati per ambiente:

- **`src/index.ts`** — API HTTP (Express) + WhatsApp bot (Baileys)
  - Gestisce messaggi in entrata, booking, onboarding, inviti
  - Espone `/api/webhooks`, `/api/dashboard`, `/api/setup`, `/health`, `/dashboard`, `/setup`
  - **Multi-tenant:** connette N socket Baileys (uno per club con `botPhoneNumber` configurato), evento `wahEvents.emit('message', msg, clubId)`, enqueue con clubId

- **`src/worker.ts`** — Worker BullMQ
  - Consuma code: `wave`, `maintenance`, `recovery`, `reminder`
  - Non ha connessione WhatsApp diretta — manda messaggi via `simulateTypingAndSend`

### Multi-tenant: architettura socket

```
Club.botPhoneNumber != null → connectToWhatsApp(clubId, botPhone)
    → Map<clubId, ClubSocketState> in whatsapp.ts
    → auth folder: baileys_auth_info_<clubId>

Messaggio in entrata da socket del club X:
    wahEvents.emit('message', msg, clubId=X)
    → enqueue(msg, clubId=X)
    → NormalizedMessage.clubId = X
    → handleBatch(jid, msgs)
    → runWithContext({ clubId: X }, fn)
    → sendMessage/simulateTypingAndSend usa socket X via getClubId()

Wave per match di club X:
    processWave(matchId) → findUnique(matchId).clubId = X
    → runWithContext({ clubId: X }, fn)
    → tutti i simulateTypingAndSend nel pipeline usano socket X
```

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
| `src/services/messageHandler.ts` | Routing messaggi: brain per tutti (registrati e non). Dopo BOOK_FIELD invia scheda prenotazione dettagliata |
| `src/services/brain.ts` | **Cervello AI del bot** — unica chiamata Claude Sonnet con contesto completo → `{ message, action, params }`. Nessuna frase hardcodata |
| `src/services/inbound-queue.ts` | Debouncing messaggi in entrata (60s per JID), batch processing, recovery dopo crash |
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
⚠️ Il flusso onboarding è stato eliminato. Il brain gestisce direttamente la registrazione tramite `REGISTER_PLAYER`.
| File | Cosa fa |
|------|---------|
| `src/services/onboarding-flow.ts` | ⚠️ LEGACY — usato solo da `group-handler.ts`. Non più nel path principale |
| `src/services/onboarding.ts` | Gestione stati AWAITING_* su Redis (invitation choice, friend phone, ecc.) |

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
| `state:unclear:{jid}` | 24h | Retry classificazione intent |
| `state:role:{jid}:*` | 1h | AWAITING_REDIRECT_CHOICE |
| `wave_lock:{matchId}` | 15s | Mutex distributed lock per wave |
| `feedback_requested:{matchId}:{playerId}` | 24h | Dedup feedback request |
| `warning:timeout:{matchId}` | 1h | Dedup warning "ultima chiamata" |
| `{prefix}inbound:{jid}` | 10min | Coda messaggi in entrata (debounce) |

---

## Workflow Logico — Messaggio in Entrata

```
WhatsApp message
    ↓
inbound-queue.ts (debounce 60s, raggruppa batch per JID)
    ↓
messageHandler._handleBatchInner()
    ├── De-LID: risolve @lid → numero italiano reale
    ├── Deduplication check (WhatsAppMessage.messageId)
    ├── Carica club + adminPhone
    ├── [COMANDO ADMIN?] — "ok <numero>" → approva giocatore e ritorna (PRIMA di tutto)
    ├── Player lookup (by phoneNumber + clubId)
    │
    └── → brain.ts (SEMPRE — registrato o no)
        ├── buildBrainContext() — carica inviti, partite, messaggi recenti
        │   (se player=null: contesto semplificato, solo REGISTER_PLAYER/NONE/FAQ_REQUEST)
        ├── callBrain() → Claude Sonnet → { message, action, params }
        ├── simulateTypingAndSend(message)
        └── executeAction(action, params, player, club, phoneNumber)
            ├── REGISTER_PLAYER — crea Player nel DB + notifica admin
            ├── NONE — solo risposta conversazionale
            ├── ACCEPT_INVITATION — transazione con SELECT FOR UPDATE
            ├── REJECT_INVITATION
            ├── CANCEL_MATCH — riapre match se era LOCKED
            ├── BOOK_FIELD — crea/unisce match + wave → restituisce matchId
            │   └── ➜ messageHandler invia scheda prenotazione (campo, prezzo, indirizzo)
            ├── OPT_OUT — player.active = false + notifica admin
            └── INVITE_PREFERRED — cerca player per nome nel club
```

**BrainAction types:** `NONE | ACCEPT_INVITATION | REJECT_INVITATION | CANCEL_MATCH | BOOK_FIELD | OPT_OUT | OPT_IN | INVITE_PREFERRED | SAVE_NOTE | REQUEST_LESSON | RESCHEDULE_MATCH | FAQ_REQUEST | REGISTER_PLAYER`

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

**Algoritmo EMA individuale:** accumula giocatori uno per uno finché `Somma(EMA_i) >= posti_residui`. Wave più piccole con giocatori affidabili, più grandi con poco affidabili.

---

## Skill Level

- Float **1.0–7.0** (standard padel internazionale)
- Assegnato **ONLY** dal club: skill test fisico o modifica manuale dalla dashboard
- Il bot **non chiede mai** il livello all'utente
- Nuovi giocatori: `skillLevel: -1` (Skill Test non effettuato) — possono prenotare campi, non ricevono wave
- Le wave rispettano `matchLowerRange` / `matchUpperRange` del club (es. ±1.0)

---

## Timezone

- Prisma scrive i timestamp in **UTC**
- Il DB PostgreSQL ha `timezone = 'Europe/Rome'` → Supabase dashboard mostra orario italiano
- Output verso utenti: sempre `{ timeZone: 'Europe/Rome' }` in `toLocaleTimeString/toLocaleDateString`
- Input utente (es. "alle 18"): convertito con `buildRomeTime()` in `booking.ts` (gestisce DST)
- **MAI** `ALTER DATABASE ... SET timezone TO 'UTC'` — tornerebbe a mostrare UTC nel dashboard

---

## Convenzioni di Codice

- **No build step**: tsx esegue TypeScript direttamente in produzione
- **Import dinamici** per moduli pesanti o circolari: `await import('./recovery')`
- **Logger**: pino, sempre `logger.info/warn/error({ context }, 'message')`
- **Errori non fatali**: try/catch con log, mai propagare eccezioni da operazioni best-effort
- **Race condition**: transazioni Prisma con `SELECT ... FOR UPDATE` per operazioni critiche (accettazione invito)
- **Prompts**: in `src/prompts/*.md`, caricati a runtime — modificabili senza redeploy

---

## Scelte Architetturali Chiave

| Scelta | Motivazione |
|--------|-------------|
| Redis primary per stati conversazionali | TTL nativo, sub-ms, no schema migrations |
| PostgreSQL fallback per stati | Resilienza se Redis crasha |
| Distributed lock (wave_lock) 15s | Evita double-send in wave parallele |
| Debounce 60s per JID | WhatsApp spezza messaggi lunghi in più pezzi |
| `type=append` messaggi offline | Baileys emette append al reconnect — recuperati e filtrati con AI |
| De-LID in _handleBatchInner | WhatsApp LID (@lid) ≠ numero telefono — risolto da `remoteJidAlt` |
| buildRomeTime() | Evita doppia conversione UTC quando l'utente fornisce orario italiano |
| cleanup-pending-invitations ogni ora | PENDING su match passati inquinano acceptanceRate e statistiche |
| Brain + scheda separata per BOOK_FIELD | Il brain non conosce il campo al momento della risposta |
| OPT_OUT rilevato da AI | Nessun "rispondi stop" — il brain capisce naturalmente il contesto |
| `prisma db push` invece di `migrate dev` | Supabase ha drift dalla migration history |

---

## Job di Manutenzione

| Job | Frequenza | Cosa fa |
|-----|-----------|---------|
| `daily-reset` | 00:00 ogni notte | Azzera dailyMessagesCount su tutti i player |
| `check-timeouts` | ogni 30min | Cancella match OPEN scaduti senza abbastanza giocatori |
| `check-silent-matches` | ogni 30min | Rilancia wave su match OPEN senza attività |
| `process-match-outcomes` | ogni 2h | Chiude invitation PENDING di match terminati, aggiorna reliability |
| `cleanup-messages` | 03:00 ogni notte | Elimina WhatsAppMessage > 30 giorni |
| `cleanup-pending-invitations` | ogni ora | PENDING su match passati → IGNORED; PENDING > 48h → IGNORED |
