# Repository Map — Padel Matchmaking Bot

Mappa sintetica di tutti i file del progetto, organizzata per cartella.
Esclusi: `node_modules/`, `dist/`, `.git/`, `.claude/worktrees/`.

> Aggiornata a luglio 2026 — allineata allo stato reale del codice dopo la pulizia
> dei moduli legacy (booking, onboarding, intent-resolver, conversational-manager, ecc.).

---

## Root

| File | Descrizione |
|------|-------------|
| `.env` | Variabili d'ambiente (DATABASE_URL, REDIS_URL, API keys, DRY_RUN, ecc.) |
| `package.json` | Dipendenze e script npm (`start`, `worker`, `test`, `db:push`) |
| `tsconfig.json` | Configurazione TypeScript (strict, no build step: tsx esegue direttamente) |
| `vitest.config.ts` | Configurazione test Vitest |
| `prisma.config.ts` | Configurazione dinamica Prisma 7 |
| `docker-compose.yml` | Redis + Postgres locali per sviluppo |
| `baileys_auth_info/` | Credenziali sessione WhatsApp Web (⚠️ da NON committare) |
| `README.md` | Overview progetto, setup locale, istruzioni deploy |
| `REPOSITORY_MAP.md` | Questo file |
| `CLAUDE.md` | Manuale operativo completo (architettura, workflow, convenzioni) |
| `ARCHITECTURE.md` | Riferimento architetturale |

---

## src/

| File | Descrizione |
|------|-------------|
| `src/index.ts` | Entry point principale: avvia Express, socket Baileys multi-tenant e schedula job di manutenzione |
| `src/worker.ts` | Entry point worker: avvia i consumer BullMQ (wave, maintenance, recovery, reminder) |
| `src/setup.html` | Wizard HTML 6-step per onboarding circolo (`/setup`) |
| `src/hub.html` | Hub Polpo AI (landing interna) |

### src/api/

| File | Descrizione |
|------|-------------|
| `src/api/dashboard.api.ts` | REST API dashboard circolo (auth JWT, CRUD match/player/court/prezzi/FAQ, health check) |
| `src/api/admin.api.ts` | REST API super-admin Polpo (gestione circoli, impersonation con audit log, usage API) |
| `src/api/webhooks.ts` | Webhook esterno per creare match da sistemi terzi (autenticato via HMAC-SHA256) |
| `src/api/setup.api.ts` | `POST /api/setup/club` — onboarding circolo via wizard, protetto da `SETUP_SECRET` |

### src/services/

| File | Descrizione |
|------|-------------|
| `src/services/brain.ts` | **Cervello AI del bot** — unica chiamata Claude con contesto completo → `{ message, action, params }`. Contiene executeAction, bookSlotForPlayer (con lock anti double-booking), joinExistingMatch (SELECT FOR UPDATE) |
| `src/services/messageHandler.ts` | Routing messaggi: de-LID, dedup, comandi admin, brain per tutti, scheda prenotazione post-BOOK_FIELD, azioni secondarie |
| `src/services/whatsapp.ts` | Connessione Baileys multi-tenant (Map clubId→socket), humanSend (typing, delay, chunking), recovery messaggi offline, self-chat admin |
| `src/services/inbound-queue.ts` | Debounce 60s per JID, batch processing, persistenza Redis con recovery dopo crash |
| `src/services/ai.ts` | Wrapper Anthropic Claude + OpenAI Whisper (trascrizione vocali), generateInvitation, inferGender |
| `src/services/matchmaker.ts` | Orchestra wave di inviti (distributed lock 15s), findOpenMatchForPlayer, buildMatchSocialContext |
| `src/services/scoring.ts` | Selezione giocatori wave (skill range, gender, EMA reliability con α adattivo), night window, delay anti-bot |
| `src/services/redirect.ts` | Algoritmo P1-P5: trova alternative quando lo slot è pieno, notifica displacement |
| `src/services/recovery.ts` | Match non riempibili, checkMatchTimeouts, handleMatchUnfillable |
| `src/services/pricing.ts` | Calcolo prezzo per slot (fasce standard + eccezioni con date), costo partita |
| `src/services/match-notifications.ts` | Notifiche cancellazione/spostamento partite (individuali + gruppo WA), findMatchesOutsideHours |
| `src/services/admin-commands.ts` | Comandi DB via WhatsApp dall'admin del circolo (self-chat), scoped al club |
| `src/services/faq-manager.ts` | FAQ curator AI (Haiku): dedup, merge, review delle Q+A |
| `src/services/delivery.ts` | Rinvio one-shot dei messaggi IMPORTANT mai usciti (scan periodico dal maintenance worker) |
| `src/services/invitation-templates.ts` | Template random per inviti recruiting (non AI: volume alto → costo zero) |
| `src/services/usage-tracker.ts` | Attribuzione costi API Claude per circolo (ApiUsage per clubId/giorno/modello) |
| `src/services/conversation-state.ts` | setState/getState su Redis (primary) + PostgreSQL (fallback), TTL 24h |
| `src/services/queue.ts` | Singleton BullMQ queues (wave, maintenance, recovery, reminder) + getRedis |
| `src/services/db.ts` | Singleton Prisma client |

### src/workers/

| File | Descrizione |
|------|-------------|
| `src/workers/wave.worker.ts` | Processa job `process-wave` → matchmaker.processWave() (staleness check) |
| `src/workers/maintenance.worker.ts` | daily-reset, check-timeouts, check-silent-matches, cleanup messaggi/inviti |
| `src/workers/recovery.worker.ts` | Recovery partite in difficoltà |
| `src/workers/reminder.worker.ts` | Promemoria partite ai giocatori confermati |

### src/prompts/

| File | Descrizione |
|------|-------------|
| `src/prompts/classify_intent.md` | Classificazione intent messaggi (Haiku) |
| `src/prompts/generate_invitation.md` | Generazione testi inviti personalizzati |
| `src/prompts/generate_feedback_request.md` | Richiesta feedback post-partita |
| `src/prompts/detect_action_signal.md` | Rilevamento segnali d'azione nei messaggi offline |

### src/utils/

| File | Descrizione |
|------|-------------|
| `src/utils/booking-dates.ts` | buildRomeTime + parseBookingDateTime — parsing date nel fuso Rome (funzioni pure, testate) |
| `src/utils/request-context.ts` | AsyncLocalStorage: correlationId + clubId propagati nel pipeline |
| `src/utils/retry.ts` | Retry con backoff esponenziale |
| `src/utils/circuit-breaker.ts` | Circuit breaker per AI e servizi esterni |
| `src/utils/notify-admin.ts` | Notifiche admin su WhatsApp per eventi critici |
| `src/utils/prompts.ts` | Caricamento dei file `.md` da `src/prompts/` a runtime |
| `src/utils/format-match.ts` | Formattazione partita nei messaggi (giorno+ora, mai nome campo nei conversazionali) |
| `src/utils/split-message.ts` | Divisione testo in bolle WhatsApp naturali (emoji = fine bolla) |

### src/tests/ (Vitest — tutti mockati, nessun servizio esterno richiesto)

| File | Descrizione |
|------|-------------|
| `src/tests/scoring.test.ts` | Reliability v2 (finestra outcome, smoothing bayesiano), computeNextWaveDelayMs |
| `src/tests/booking-dates.test.ts` | buildRomeTime/parseBookingDateTime — incluse regressioni "bug mezzanotte" |
| `src/tests/matchmaker.test.ts` | findOpenMatchForPlayer (scoped per club) |
| `src/tests/conversation.test.ts` | Flussi bot end-to-end: onboarding, booking, opt-out, dedup, prompt del brain |
| `src/tests/multitenant.test.ts` | Propagazione clubId (inbound-queue → handler → context) |
| `src/tests/notifications.test.ts` | Notifiche cancellazione/spostamento (scoped per club) |
| `src/tests/integration.test.ts` | CircuitBreaker, ConversationState dual-write, correlation ID, wave lock |
| `src/tests/audit-fixes.test.ts` | 46 test a difficoltà crescente sui fix degli audit workflow |
| `src/tests/audit-dashboard.test.ts` | Test sui fix dashboard/API emersi dall'audit |
| `src/tests/audit-redirect.test.ts` | Test su priorità e filtro genere del redirect |

### src/scripts/ (utility manuali)

| File | Descrizione |
|------|-------------|
| `src/scripts/db-reset.ts` | Reset DB + Redis (ambiente di test) |
| `src/scripts/setup-prices.ts` | Setup prezzi per fascia oraria |
| `src/scripts/setup-test-data.ts` | Setup dati per test manuali |
| `src/scripts/seed-test-match.ts` | Crea una partita di test |
| `src/scripts/ai-conversation-tests.ts` | Test manuali conversazioni AI |
| `src/scripts/delete-orphan.ts` | Pulizia record orfani |

---

## prisma/

| File | Descrizione |
|------|-------------|
| `prisma/schema.prisma` | Schema DB: Club, Player, Court, Match, MatchPlayer, Invitation, WhatsAppMessage, ConversationState, MatchFeedback, CourtPrice, Faq, ApiUsage, AdminAuditLog |

---

## scripts/ (CLI operative)

| File | Descrizione |
|------|-------------|
| `scripts/seed-players.ts` | Seed giocatori per ambiente di test |
| `scripts/setup-club.ts` | Configurazione iniziale circolo |
| `scripts/reseed-staging.ts` | Re-seed completo ambiente staging (`npx prisma db seed`) |
| `scripts/import-vcf.ts` | Import bulk giocatori da rubrica VCF |
| `scripts/import-group.ts` | Import giocatori da gruppo WhatsApp esistente |
| `scripts/trigger-match.ts` | Creazione manuale partita da CLI |
| `scripts/trigger-direct.ts` | Trigger diretto wave su partita esistente |
| `scripts/discover-groups.ts` | Scansione gruppi WhatsApp connessi |
| `scripts/generate-auth.ts` | Genera credenziali sessione Baileys |

---

## dashboard/

Frontend React (Vite) — due app nello stesso bundle, switch su pathname:
`/dashboard` = dashboard circolo, `/admin` = super-admin Polpo.

| File/Cartella | Descrizione |
|---------------|-------------|
| `dashboard/src/main.jsx` | Entry point — monta App (circolo) o AdminApp (super-admin) in base al path |
| `dashboard/src/App.jsx` | Root dashboard circolo: sidebar, routing tab, sessione persistita (sessionStorage) |
| `dashboard/src/features/auth/LoginPage.jsx` | Login circolo con JWT |
| `dashboard/src/features/courts/CourtsView.jsx` | Griglia campi in tempo reale, gestione partite/blocchi |
| `dashboard/src/features/players/PlayersView.jsx` | Anagrafica giocatori, skill level, attiva/disattiva |
| `dashboard/src/features/prices/PricesView.jsx` | Prezzi standard + eccezioni di calendario |
| `dashboard/src/features/stats/StatsView.jsx` | Fill rate, affidabilità, wave lanciate |
| `dashboard/src/features/revenue/RevenueView.jsx` | Incassi generati dal bot (mese/anno/confronti) |
| `dashboard/src/features/faqs/FaqsView.jsx` | Gestione FAQ con analisi AI (dedup/merge) |
| `dashboard/src/features/system/SystemView.jsx` | Health check: Redis, WhatsApp, sicurezza API |
| `dashboard/src/features/settings/SettingsView.jsx` | Impostazioni circolo |
| `dashboard/src/admin/AdminApp.jsx` | Root super-admin (🛡️ Polpo AI) |
| `dashboard/src/admin/AdminLoginPage.jsx` | Login super-admin |
| `dashboard/src/admin/views/` | OverviewView, ClubsView (con impersonation), ClubControlView (vista circolo: giocatori e guadagni), MatchesView, PlayersView, UsageView (costi API), AuditView, SystemView |
| `dashboard/src/shared/` | Badge, Modal, Spinner, Toast, ThemeContext/Toggle (dark/light) |
| `dashboard/src/shared/config.js` | Theme factory, helper `api()` (gestione 401 globale), utils formato |
| `dashboard/vite.config.js` | Base `/dashboard/`, proxy `/api` → localhost:3000 |
