# CLAUDE.md — Padel Matchmaking Bot

Questo file è la mappa operativa del progetto. Leggilo prima di toccare qualsiasi cosa.

---

## Stack Tecnologico

| Layer | Tecnologia |
|-------|-----------|
| Runtime | Node.js 20 + TypeScript (tsx, no build step) |
| Framework HTTP | Express |
| ORM / DB | Prisma + PostgreSQL (Supabase) |
| Cache / Code | Redis (ioredis) — `127.0.0.1:6379` sul VPS |
| Code WhatsApp | Baileys (`@whiskeysockets/baileys`) |
| AI | Anthropic Claude (Haiku per classificazioni veloci, Sonnet per testo) |
| AI fallback | OpenAI (usato in alcuni prompt) |
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
  - Espone `/api/webhooks`, `/api/dashboard`, `/health`, `/dashboard`

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

### Core Services
| File | Cosa fa |
|------|---------|
| `src/services/whatsapp.ts` | Connessione Baileys, invio messaggi, gestione reconnect, recovery messaggi offline |
| `src/services/messageHandler.ts` | **Cervello del bot** — routing intent → azione, gestione stati conversazionali |
| `src/services/inbound-queue.ts` | Debouncing messaggi in entrata (10s per JID), batch processing, recovery dopo crash |
| `src/services/ai.ts` | Wrapper AI: classificazione intent, generazione testi inviti, requiresResponse() |
| `src/services/intent-resolver.ts` | Classificazione intent con retry (max 5 tentativi), stati UNCLEAR su Redis |
| `src/services/conversational-manager.ts` | Gestione conversazione fluida (fallback quando intent non chiaro) |

### Booking & Matchmaking
| File | Cosa fa |
|------|---------|
| `src/services/booking.ts` | Flusso prenotazione step-by-step, buildRomeTime() per timezone IT, cerca match aperti |
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
| `Club` | Circolo — configura regole (matchLowerRange, matchUpperRange, waveMultiplier, maxDailyMessages) |
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
    ├── [STATO ATTIVO?] — controlla Redis in ordine:
    │   ├── onboarding state → continueOnboarding()
    │   ├── AWAITING_REDIRECT_CHOICE → confirmRedirectChoice()
    │   ├── AWAITING_INVITATION_CHOICE → handleInvitationChoiceReply()
    │   ├── booking state → continueBookingFlow()
    │   └── altri AWAITING_* → handler specifico
    │
    ├── [NESSUNO STATO] → classifica intent (AI Haiku)
    │   ├── YES/NO → gestione invitation PENDING
    │   ├── BOOK → startBookingFlow()
    │   ├── CANCEL → handleCancellation()
    │   ├── BRING_FRIEND/GROUP/WHOLE_COURT → handler dedicato
    │   ├── OPT_OUT → handleOptOut()
    │   ├── INVITE_PREFERRED → gestione giocatori preferiti
    │   └── UNKNOWN/UNCLEAR → conversational manager (fluido)
    │
    └── [PLAYER NON TROVATO] → startSingleOnboarding() con pending-intent
```

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

---

## Skill Level

- Float **1.0–7.0** (standard padel internazionale)
- Assegnato **ONLY** dal club: skill test fisico o modifica manuale dalla dashboard
- Il bot **non chiede mai** il livello all'utente
- Nuovi giocatori registrati con `skillLevel: 0` in attesa di skill test
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
