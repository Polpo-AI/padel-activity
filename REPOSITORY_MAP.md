# Repository Map — Padel Matchmaking Bot

Mappa sintetica di tutti i file del progetto, organizzata per cartella.
Esclusi: `node_modules/`, `dist/`, `.git/`, `.claude/worktrees/`.

---

## Root

| File | Descrizione |
|------|-------------|
| `.env` | Variabili d'ambiente (DATABASE_URL, REDIS_URL, API keys, DRY_RUN, ecc.) |
| `package.json` | Dipendenze e script npm (`dev`, `worker`, `test`) |
| `tsconfig.json` | Configurazione TypeScript |
| `vitest.config.ts` | Configurazione test Vitest |
| `prisma.config.ts` | Configurazione dinamica Prisma 7 |
| `docker-compose.yml` | Redis + Postgres locali per sviluppo |
| `ecosystem.config.cjs` | Configurazione PM2 (legacy, ora si usa systemd su VPS) |
| `ecosystem.remote.js` | Configurazione PM2 per deploy remoto (legacy) |
| `baileys_auth_info/` | Credenziali sessione WhatsApp Web (gitignored in prod) |
| `README.md` | Overview progetto, setup locale, istruzioni deploy |
| `REPOSITORY_MAP.md` | Questo file |
| `CLAUDE.md` | Manuale operativo completo (architettura, workflow, convenzioni) |

---

## src/

| File | Descrizione |
|------|-------------|
| `src/index.ts` | Entry point principale: avvia Express, Baileys WhatsApp e schedula job di manutenzione |
| `src/worker.ts` | Entry point worker: avvia i consumer BullMQ (wave, maintenance, recovery, reminder) |

### src/api/

| File | Descrizione |
|------|-------------|
| `src/api/dashboard.api.ts` | REST API per la dashboard (auth JWT, CRUD match/player/court, health check) |
| `src/api/webhooks.ts` | Webhook esterno per creare match da sistemi terzi (autenticato via HMAC) |

### src/services/

| File | Descrizione |
|------|-------------|
| `src/services/whatsapp.ts` | Connessione Baileys, invio messaggi con simulazione umana (typing, delay, chunking), reconnect |
| `src/services/messageHandler.ts` | Cervello del bot: routing intent → azione, gestione stati conversazionali |
| `src/services/inbound-queue.ts` | Debouncing messaggi in entrata (10s per JID), batch processing, recovery dopo crash |
| `src/services/ai.ts` | Wrapper AI: classificazione intent, generazione testi inviti, requiresResponse() |
| `src/services/intent-resolver.ts` | Classificazione intent con retry (max 5 tentativi), gestione stati UNCLEAR su Redis |
| `src/services/conversational-manager.ts` | Gestione conversazione fluida quando l'intent non è chiaro |
| `src/services/booking.ts` | Flusso prenotazione step-by-step, buildRomeTime() per timezone, ricerca match aperti |
| `src/services/matchmaker.ts` | Orchestra wave di inviti, selezione giocatori, buildMatchSocialContext() |
| `src/services/scoring.ts` | Selezione giocatori per wave (skill range, gender, reliability EMA), processMatchOutcomes() |
| `src/services/redirect.ts` | Algoritmo P1-P5: trova fino a 5 alternative quando uno slot è pieno |
| `src/services/recovery.ts` | Gestisce match non riempibili, checkMatchTimeouts, handleMatchUnfillable |
| `src/services/pricing.ts` | Calcolo prezzo per slot e copertura economica partita |
| `src/services/reliability.ts` | Aggiornamento EMA reliability score dopo ogni partita |
| `src/services/onboarding-flow.ts` | Flusso onboarding step-by-step (nome → telefono → finalizza) |
| `src/services/onboarding.ts` | Gestione stati AWAITING_* su Redis, bring friend/group, setAwaitingState/getAwaitingState |
| `src/services/conversation-state.ts` | setState/getState su Redis (primary) + PostgreSQL (fallback), TTL 24h |
| `src/services/db.ts` | Singleton Prisma client |
| `src/services/queue.ts` | Singleton BullMQ queues (wave, maintenance, recovery, reminder) |
| `src/services/whatsapp-rate-limiter.ts` | Rate limiting per l'invio messaggi WhatsApp in uscita |
| `src/services/group-handler.ts` | Gestione gruppi WhatsApp (creazione, aggiunta partecipanti) |

### src/workers/

| File | Descrizione |
|------|-------------|
| `src/workers/wave.worker.ts` | Processa job `process-wave` → chiama matchmaker.processWave() |
| `src/workers/maintenance.worker.ts` | Job ricorrenti: daily-reset, check-timeouts, check-silent-matches, cleanup |
| `src/workers/recovery.worker.ts` | Gestisce recovery partite in difficoltà |
| `src/workers/reminder.worker.ts` | Invia promemoria partite ai giocatori confermati |

### src/prompts/

| File | Descrizione |
|------|-------------|
| `src/prompts/classify_intent.md` | Prompt per classificazione intent messaggi in entrata (Haiku) |
| `src/prompts/generate_invitation.md` | Prompt per generazione testi inviti personalizzati (Sonnet) |
| `src/prompts/detect_action_signal.md` | Prompt per rilevare segnali d'azione nei messaggi offline (requiresResponse) |

### src/utils/

| File | Descrizione |
|------|-------------|
| `src/utils/retry.ts` | Retry con backoff esponenziale per chiamate a servizi esterni |
| `src/utils/circuit-breaker.ts` | Circuit breaker per AI e servizi esterni |
| `src/utils/notify-admin.ts` | Notifiche admin su WhatsApp per eventi critici |
| `src/utils/prompts.ts` | Utility per caricare i file `.md` da `src/prompts/` a runtime |
| `src/utils/request-context.ts` | Context propagation per request tracing |

### src/tests/

| File | Descrizione |
|------|-------------|
| `src/tests/matchmaker.test.ts` | Unit test logica wave e selezione giocatori |
| `src/tests/scoring.test.ts` | Unit test calcolo EMA reliability score |
| `src/tests/intent-resolver.test.ts` | Unit test classificazione intent e stati Redis UNCLEAR |
| `src/tests/integration.test.ts` | Test di integrazione flussi end-to-end |

---

## prisma/

| File | Descrizione |
|------|-------------|
| `prisma/schema.prisma` | Schema DB: Club, Player, Court, Match, MatchPlayer, Invitation, ConversationState, ecc. |

---

## scripts/

| File | Descrizione |
|------|-------------|
| `scripts/seed-players.ts` | Seed giocatori per ambiente di test |
| `scripts/setup-club.ts` | Configurazione iniziale circolo (campi, orari, regole) |
| `scripts/reseed-staging.ts` | Re-seed completo ambiente staging |
| `scripts/import-vcf.ts` | Import bulk giocatori da rubrica VCF |
| `scripts/import-group.ts` | Import giocatori da gruppo WhatsApp esistente |
| `scripts/trigger-match.ts` | Creazione manuale partita da CLI |
| `scripts/trigger-direct.ts` | Trigger diretto wave su una partita esistente |
| `scripts/discover-groups.ts` | Scansione automatica gruppi WhatsApp connessi |
| `scripts/generate-auth.ts` | Genera credenziali sessione Baileys |
| `scripts/setup-test-data.ts` | Setup dati per test di integrazione |
| `scripts/test-all-dashboard-apis.ts` | Test manuale di tutte le API dashboard |
| `scripts/test-dashboard-api.ts` | Test singolo endpoint dashboard |
| `scripts/test-level4-scoring.ts` | Test manuale logica scoring livello 4 |
| `scripts/test-level5-race.ts` | Test manuale race condition accettazione invito |
| `scripts/test-level6-booking.ts` | Test manuale flusso booking completo |
| `scripts/test-prompts.ts` | Test generazione testi prompt AI |

---

## dashboard/

Frontend React (Vite) per la gestione del circolo da browser.

| File/Cartella | Descrizione |
|---------------|-------------|
| `dashboard/src/main.jsx` | Entry point React |
| `dashboard/src/App.jsx` | Root component, routing tra le view |
| `dashboard/src/features/auth/LoginPage.jsx` | Pagina di login con JWT |
| `dashboard/src/features/stats/StatsView.jsx` | Statistiche partite e giocatori |
| `dashboard/src/features/players/PlayersView.jsx` | Gestione anagrafica giocatori e skill level |
| `dashboard/src/features/courts/CourtsView.jsx` | Gestione campi e disponibilità |
| `dashboard/src/features/prices/PricesView.jsx` | Configurazione prezzi per fascia oraria |
| `dashboard/src/features/settings/SettingsView.jsx` | Impostazioni circolo (range livello, wave, messaggi max) |
| `dashboard/src/features/system/SystemView.jsx` | Stato sistema, health check, log |
| `dashboard/src/shared/` | Componenti UI condivisi (Badge, Modal, Spinner, Toast) |
| `dashboard/src/shared/config.js` | URL base API e costanti frontend |
| `dashboard/vite.config.js` | Configurazione Vite (proxy API, build) |
| `dashboard/index.html` | HTML root per Vite |
