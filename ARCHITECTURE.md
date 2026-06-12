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

Un solo processo applicativo per ambiente (+ uno stub):

- **`src/index.ts`** — TUTTO: API HTTP (Express) + WhatsApp bot (Baileys) + worker BullMQ
  - Gestisce messaggi in entrata, booking, inviti
  - Espone `/api/webhooks`, `/api/dashboard`, `/api/setup`, `/health`, `/dashboard`, `/setup`
  - Registra i worker BullMQ (code: `wave`, `reminder`, `maintenance`) — girano qui perché serve il socket WA
  - **Multi-tenant:** connette N socket Baileys (uno per club con `botPhoneNumber` configurato), evento `wahEvents.emit('message', msg, clubId)`, enqueue con clubId

- **`src/worker.ts`** — stub keep-alive
  - NON consuma code: mantenuto solo per compatibilità con le unit systemd `padel-worker-*`

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
| `src/worker.ts` | Stub keep-alive (compat systemd) — i worker girano in index.ts |

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
| `src/services/ai.ts` | Wrapper AI: requiresResponse(), inferGender(), splitFaqQuestions(), trascrizione audio |

### Booking & Matchmaking
| File | Cosa fa |
|------|---------|
| `src/services/matchmaker.ts` | Orchestra wave di inviti, trova match aperto, buildMatchSocialContext() |
| `src/services/scoring.ts` | Selezione giocatori per wave (skill range, gender, reliability), processMatchOutcomes() |
| `src/services/redirect.ts` | Algoritmo P1-P5: trova 5 alternative quando slot è pieno (redirectGroup) |
| `src/services/recovery.ts` | Gestisce match non riempibili, checkMatchTimeouts, handleMatchUnfillable |
| `src/services/pricing.ts` | Calcolo prezzo per slot, copertura economica partita |

### Onboarding
⚠️ Il flusso onboarding è stato eliminato (file `onboarding*.ts` e `group-handler.ts` rimossi). Il brain gestisce direttamente la registrazione tramite `REGISTER_PLAYER`.

### Stato Conversazionale
| File | Cosa fa |
|------|---------|
| `src/services/conversation-state.ts` | setState/getState su Redis (primary) + PostgreSQL (fallback), TTL 24h default |

### Infrastruttura
| File | Cosa fa |
|------|---------|
| `src/services/db.ts` | Singleton Prisma client |
| `src/services/queue.ts` | Singleton BullMQ queues (wave, maintenance, recovery, reminder), checkSilentMatches |
| `src/utils/retry.ts` | Retry con backoff esponenziale per chiamate esterne |
| `src/utils/circuit-breaker.ts` | Circuit breaker per AI e servizi esterni |
| `src/utils/notify-admin.ts` | Notifiche admin su WhatsApp per eventi critici |

### Workers BullMQ
| File | Cosa fa |
|------|---------|
| `src/workers/wave.worker.ts` | Processa job `process-wave` → chiama matchmaker.processWave() |
| `src/workers/maintenance.worker.ts` | daily-reset, check-timeouts, check-silent-matches, process-match-outcomes, cleanup-messages, cleanup-pending-invitations, resend-undelivered, skill-test-reminder, archive-old-matches, prune-conversation-states |
| `src/workers/reminder.worker.ts` | Promemoria partite ai giocatori confermati |

### Prompts AI
In `src/prompts/*.md` solo classify_intent è ancora usato (gli altri .md sono orfani storici). Il prompt principale del brain è hardcoded in `src/services/brain.ts` (buildStaticRules + systemPrompt, con prompt caching); inviti wave e richiesta feedback post-partita sono template senza AI (`invitation-templates.ts`, `ai.ts`).

---

## Modello Dati (Prisma)

| Model | Ruolo |
|-------|-------|
| `Club` | Circolo — configura regole (matchLowerRange, matchUpperRange, waveMultiplier, maxDailyMessages, **city, address**) |
| `Player` | Giocatore — skillLevel float 1.0-7.0 (assegnato SOLO dal club), reliabilityScore, dailyMessagesCount |
| `Court` | Campo — nome, isCovered |
| `Match` | Partita — status: OPEN→LOCKED (→CANCELLED/UNFILLED) →ARCHIVED, skillLevel, playersNeeded |
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
| `state:role:{jid}:AWAITING_REDIRECT_CHOICE` | 10min | Scelta tra le opzioni del redirect |
| `state:booking_intent:{jid}` | 15min | Bozza prenotazione (giorno/ora/preferenze) tra un turno brain e l'altro |
| `state:feedback_pending:{jid}` | 48h | Risposta feedback post-partita attesa (brain → SAVE_FEEDBACK) |
| `wave_lock:{matchId}` | 15s | Mutex distributed lock per wave |
| `booking_lock:{clubId}` | 10s | Serializza selezione campo + creazione match |
| `redirect:sent:{jid}:{matchId}:{reason}:{ts}` | 90s | Dedup redirect paralleli |
| `feedback_requested:{matchId}:{playerId}` | 24h | Dedup invio richiesta feedback |
| `warning:timeout:{matchId}` | 1h | Dedup warning "ultima chiamata" |
| `outcomes_processed:{matchId}` | 30g | Idempotenza processMatchOutcomes |
| `approval:*` | 24h–90g | Gate approvazione numeri sconosciuti (APPROVAL_GATE) |
| `faq:pending_ids:{clubId}` + `faq:pending:{clubId}:{id}` | 7g | Coda domande FAQ in attesa di risposta admin |
| `faq:awaiting_*:{clubId}` | 24h | Stati conversazione FAQ admin (conflict/merge/save/improvement) |
| `alert:gender_unknown:{clubId}:{playerId}` | 7g | Dedup alert genere mancante |
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

**BrainAction types:** `NONE | ACCEPT_INVITATION | REJECT_INVITATION | CANCEL_MATCH | BOOK_FIELD | OPT_OUT | OPT_IN | INVITE_PREFERRED | SAVE_NOTE | REQUEST_LESSON | RESCHEDULE_MATCH | FAQ_REQUEST | REGISTER_PLAYER | OPEN_TO_MATCHMAKING | SAVE_GENDER | SET_RACKET_RENTAL | SAVE_FEEDBACK`

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
- Input utente (es. "alle 18"): convertito con `buildRomeTime()`/`parseBookingDateTime()` in `brain.ts` (gestisce DST) — clone `buildRomeTimestamp()` in `redirect.ts`
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
| `daily-reset` | 00:00 ogni notte | Azzera dailyMessagesCount + contatori mattina/pomeriggio su tutti i player |
| `check-timeouts` | ogni 30min | Cancella match OPEN scaduti senza abbastanza giocatori |
| `check-silent-matches` | ogni 30min | Rilancia wave su match OPEN senza attività |
| `process-match-outcomes` | ogni 2h | Chiude invitation PENDING di match terminati, aggiorna reliability |
| `cleanup-messages` | 03:00 ogni notte | Elimina WhatsAppMessage > 30 giorni |
| `cleanup-pending-invitations` | ogni ora | PENDING su match passati → IGNORED; PENDING > 48h → IGNORED |
| `resend-undelivered` | ogni 20min | Rinvia messaggi `important` mai usciti (status <2); gestisce dormienza e numeri dismessi |
| `skill-test-reminder` | lunedì 08:00 UTC | Promemoria admin: giocatori registrati senza valutazione col maestro |
| `archive-old-matches` | 1° del mese 04:00 | Match LOCKED/CANCELLED/UNFILLED > 30 giorni → ARCHIVED |
| `prune-conversation-states` | 04:30 ogni notte | Elimina righe ConversationState scadute (fallback Postgres) |
