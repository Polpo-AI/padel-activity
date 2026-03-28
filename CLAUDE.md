# CLAUDE.md — Padel Matchmaking Bot

Questo file è la mappa operativa del progetto. Leggilo prima di toccare qualsiasi cosa.

---

## ⚠️ LESSONS LEARNED — Leggi sempre prima di toccare codice

Questi errori sono già stati commessi. Non ripeterli.

### 1. Workflow deploy — staging prima, poi produzione
**Regola:** lavorare SEMPRE prima su staging. Le modifiche vanno fatte direttamente sul VPS staging, poi pushate su `preview` e pullate in locale. `main` viene toccato SOLO quando si vuole deployare in produzione, esplicitamente.
**Workflow corretto:**
```bash
# Sul VPS staging (modifiche dirette o git pull)
cd /root/padel-staging
# ... edit files ...
git add src/services/file.ts && git commit -m "..."
git push origin HEAD:preview      # → GitHub preview branch

# In locale (sync)
git fetch origin && git merge origin/preview --no-edit

# Deploy produzione (solo quando esplicitamente richiesto)
cd /root/padel-prod && git pull origin main
cd dashboard && npm run build && cd ..
systemctl restart padel-prod padel-worker-prod
```
MAI pushare su `main` durante sviluppo — solo `preview`.

**⚠️ IMPORTANTE — build dashboard obbligatoria:**
La dashboard è una React/Vite app. Il VPS serve `dashboard/dist` (build statica), NON i file `.jsx` sorgente.
Dopo ogni `git pull` che tocca file in `dashboard/src/`, eseguire SEMPRE:
```bash
cd /root/padel-staging/dashboard && npm run build && cd ..
systemctl restart padel-staging
```
Senza build, le modifiche ai componenti React non sono visibili agli utenti.

### 2. Il brain gestisce anche gli utenti non registrati (REGISTER_PLAYER)
**Architettura attuale:** non esiste più una state machine di onboarding. Tutti i messaggi — da utenti registrati E non — passano dal brain (`callBrain`). Quando player è null, il system prompt mostra `═══ UTENTE NON REGISTRATO ═══` con istruzioni per raccogliere nome+cognome naturalmente. Quando il brain raccoglie entrambi → action `REGISTER_PLAYER` → `executeAction` crea il player nel DB.
**Cosa NON fare:** non re-introdurre `startSingleOnboarding`, `continueOnboarding`, `getOnboardingState` o stati Redis `state:onboarding:*`. Sono stati rimossi deliberatamente.

### 3. Il nome del giocatore NON va mai estratto con fallback al testo grezzo
**Bug reale:** `let name = messageText.trim()` come fallback → il messaggio intero ("voglio prenotare domani alle 18") diventava il nome del giocatore.
**Regola:** il brain usa `REGISTER_PLAYER` solo quando ha nome+cognome certi. Se `params.name` non contiene uno spazio, `executeAction` ritorna `success: true` senza creare il player (brain riprova al prossimo turno).

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

### 34. `prisma db push` su staging: eseguire SEMPRE sul VPS, non in locale
**Bug reale:** `prisma db push` lanciato in locale con `DATABASE_URL="...DIRECT_URL_STAGING..."` viene intercettato da `prisma.config.ts` che legge `DIRECT_URL` dal `.env` locale (diverso da staging) → il push finisce sul DB sbagliato. Il VPS poi ricarica il client già rigenerato che conosce le nuove colonne, ma il DB staging non le ha → crash con `column X does not exist`.
**Regola:** per applicare schema changes al DB staging, eseguire `prisma db push` DIRETTAMENTE sul VPS:
```bash
ssh root@46.225.212.159
cd /root/padel-staging
DATABASE_URL="postgresql://postgres.ildhffoxuufcbvmmqitj:<pw>@aws-1-eu-west-1.pooler.supabase.com:5432/postgres" npx prisma db push
npx prisma generate
systemctl restart padel-staging padel-worker-staging
```
Le credenziali corrette sono in `/root/padel-staging/.env` → `DIRECT_URL` (porta 5432).

### 8. Reset DB locale: usare DIRECT_URL_STAGING (porta 5432), non DATABASE_URL (pgBouncer 6543)
**Regola:** per operazioni dirette (script, `db push`, `migrate dev`) usare sempre il valore letterale di `DIRECT_URL_STAGING` / porta 5432. Il pgBouncer su 6543 non supporta prepared statements. Il parsing `$(grep DIRECT_URL .env ...)` può estrarre la variabile sbagliata — passare sempre il valore esplicito.
```bash
DATABASE_URL="postgresql://postgres.ildhffoxuufcbvmmqitj:...@aws-1-eu-west-1.pooler.supabase.com:5432/postgres" npx tsx src/scripts/db-reset.ts
```

### 9. `prisma db push` invece di `migrate dev` su DB condiviso
**Regola:** il DB Supabase ha drift rispetto alla migration history → `migrate dev` va in errore. Usare sempre `prisma db push` per sincronizzare lo schema senza toccare la history.

### 13. MAI usare `prisma db push --force-reset` — cancella tutto, Club incluso
**Bug reale:** usato `--force-reset` per fixare `column notes does not exist` → ha droppato e ricreato tutte le tabelle, cancellando Club, Courts, dashboard credentials e CLUB_ID.
**Regola:** usare sempre `prisma db push` (senza `--force-reset`). Se il client è desincronizzato dallo schema, il fix è `npx prisma generate` + restart — mai toccare i dati.
**Per resettare solo i dati transienti:** usare `db-reset.ts` (cancella partite/giocatori/messaggi, non il Club, e fa anche `redis.flushdb()` per evitare wave fantasma).

### 14. Quando si resetta il DB di test, flushare anche Redis
**Bug reale:** dopo un reset DB, BullMQ aveva job delayed in Redis per match che non esistevano più → wave partita su match ID inesistente → comportamento imprevisto (es. partita di Davide cancellata nonostante skill -1).
**Regola:** `db-reset.ts` ora esegue anche `redis.flushdb()` automaticamente. Se si resetta il DB manualmente (es. cancellando tabelle a mano), eseguire anche `redis-cli flushdb` sul VPS.
**Attenzione:** `flushdb` cancella TUTTI i job BullMQ — usare SOLO in ambiente di test/staging, MAI in produzione.

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

### 15. `adminPhone` deve avere il prefisso internazionale completo
**Bug reale:** `adminPhone` salvato come `3457991255` invece di `393457991255` → `notifyAdmin` costruisce `3457991255@s.whatsapp.net` che non esiste su WhatsApp → tutte le notifiche admin silenziosamente perse.
**Regola:** salvare sempre con prefisso internazionale senza `+` (es. `393457991255`). Il setup wizard deve validare e normalizzare il numero prima di salvarlo.

### 16. MAI importare `whatsapp.ts` con dynamic import dentro route handler
**Bug reale:** `await import('../services/whatsapp')` dentro un route handler crea un modulo isolato dove `sock` è sempre `null` e `connectionStatus` è sempre `'connecting'` → `sendMessage` lancia "socket not initialized" e `getConnectionStatus()` restituisce sempre 'connecting' anche a WA connesso.
**Regola:** importare `sendMessage` e `simulateTypingAndSend` sempre staticamente in cima al file. Il dynamic import è accettabile solo per moduli che non dipendono da stato singleton (es. `notify-admin`, `recovery`).

### 17. I riavvii WA non sono necessariamente crash — verificare sempre la causa
**Regola:** prima di allarmarsi per riavvii multipli del bot, controllare se sono `SIGTERM received — graceful shutdown` (riavvii intenzionali nostri via `systemctl restart`) o crash reali (`code=exited status=1/FAILURE`). Usare: `journalctl -u padel-staging | grep -E 'SIGTERM|exited|Failed'`.

### 18. `getConnectionStatus()` da dynamic import restituisce sempre il valore iniziale
**Bug reale:** `connectionStatus` è una variabile module-level in `whatsapp.ts`. Se importata dinamicamente da un route handler, il modulo è una istanza separata → il valore è sempre quello iniziale (`'connecting'`), mai aggiornato dall'event loop principale.
**Fix:** usare solo import statici per `whatsapp.ts`. Per verificare lo stato WA dall'esterno usare l'endpoint `/health` che usa l'import statico di `index.ts`.

### 19. Multi-tenant: AsyncLocalStorage per propagare clubId senza cambiare firme
**Architettura:** ogni circolo ha il proprio socket Baileys in `Map<clubId, ClubSocketState>` in `whatsapp.ts`. Il `clubId` viene propagato automaticamente a tutti i `sendMessage`/`simulateTypingAndSend` tramite `AsyncLocalStorage` (request-context).
**Come funziona:** `messageHandler._handleBatchInner` setta il `clubId` nel context tramite `runWithContext(ctx, fn)`. `processWave` in matchmaker fa lo stesso. Tutte le funzioni downstream (onboarding, redirect, scoring, brain) usano automaticamente il socket corretto senza cambiamenti alle loro firme.
**Regola:** NON passare `clubId` come parametro esplicito a ogni funzione — usare `runWithContext` al punto di ingresso e leggere con `getClubId()` dove necessario.

### 20. Multi-tenant deploy: botPhoneNumber nel DB, fallback su env vars
**Regola:** all'avvio, `index.ts` cerca i club con `botPhoneNumber != null` e li connette. Se nessun club ha `botPhoneNumber`, usa `BOT_PHONE_NUMBER` env var (legacy single-tenant). Per attivare multi-tenant su un circolo: aggiungere `botPhoneNumber` al record Club nel DB.
**Schema:** `Club.botPhoneNumber String?` + `WhatsAppMessage.clubId String?` (nullable per record legacy).
**Auth folder Baileys:** `baileys_auth_info_{clubId}` per ogni club, `baileys_auth_info` per default/legacy.

### 23. Query DB rapide: usare psql diretto, MAI `npx tsx -e` inline
**Bug reale (ripetuto):** `npx tsx -e "... await p.$disconnect() ..."` → esbuild errore `Expected identifier but found "("` perché `$` viene interpretato come shell. `node -e "SELECT ..."` → `bash: SELECT: command not found`.
**Regola:** per leggere il DB al volo usare SEMPRE psql direttamente:
```bash
PGPASSWORD=<password> psql -h <host> -p 5432 -U <user> -d postgres -c 'SELECT role, content FROM "WhatsAppMessage" ORDER BY timestamp DESC LIMIT 20;'
```
Credenziali da `DIRECT_URL_STAGING` nel `.env` locale. Per script più complessi, scrivere un file `.ts` e poi `npx tsx file.ts` — mai `-e` inline con Prisma.
**Dove trovare le credenziali:**
```bash
grep DIRECT_URL_STAGING .env   # → host, porta 5432, user, password
grep REDIS_PASSWORD .env       # → per redis-cli -a <password>
```

### 22. Messaggi USER consecutivi in history causano Anthropic 400
**Bug reale:** il debounce raggruppa più messaggi dello stesso utente in un batch. `_handleBatchInner` salva OGNI messaggio individualmente nel DB come `role=USER`. `buildBrainContext` li ricarica come `recentMessages`. `callBrain` li passa ad Anthropic tutti insieme + aggiunge il `userMessage` (testo combinato) → tre `user` di fila → Anthropic rigetta con 400 "roles must alternate" → catch → fallback casuale.
**Fix in place:** in `callBrain` (brain.ts), prima di costruire il payload per Anthropic: (1) fonde i messaggi con lo stesso ruolo consecutivi con `\n`; (2) rimuove l'ultimo messaggio se è `user` (il `userMessage` lo sostituisce già). In questo modo Anthropic riceve sempre alternanza corretta.
**Regola:** MAI passare ad Anthropic una lista di messaggi senza prima verificare che i ruoli si alternino correttamente.

### 27. skillLevel -1 per nuovi giocatori + gender inference dal nome
**Regola:** REGISTER_PLAYER crea il player con `skillLevel: -1` (non 0). `skillLevel <= 0` esclude già dalle wave. Il genere viene inferito dal primo nome via `inferGender(firstName)` al momento della registrazione.
**Dettagli:** `skillLevel: -1` significa "registrato ma Skill Test non ancora effettuato". Il bot può prenotare campi (`BOOK_FIELD`) per questi giocatori ma NON avvia wave. Il brain ha una nota esplicita su questo comportamento nel system prompt.

### 28. INVITE_PREFERRED NON va usato per "amici" generici
**Regola:** INVITE_PREFERRED richiede un nome specifico (es. "voglio giocare con Marco Rossi"). Se l'utente dice "vengo con degli amici", "siamo in gruppo", "veniamo in 4" senza nomi → BOOK_FIELD direttamente. Il campo tiene fino a 4 giocatori.
**Bug reale:** il bot chiedeva "i tuoi amici sono iscritti al circolo?" quando l'utente diceva genericamente "amici" → domanda inutile e fastidiosa.

### 29. Il brain NON deve promettere il campo prima di eseguire BOOK_FIELD
**Regola:** nella risposta JSON del brain (campo `message`), mai menzionare il nome del campo, il tipo (coperto/scoperto) o altri dettagli specifici. Il brain non sa quale campo verrà assegnato. Usare frasi neutre: "Perfetto, prenoto subito! 🎾" o "Vedo subito se c'è posto!". I dettagli arrivano nella scheda separata inviata da messageHandler DOPO executeAction.
**Bug reale:** Roberto ha visto il bot "promettere" il campo scoperto, poi assegnare silenziosamente il coperto.

### 30. Campo coperto silenzioso quando lo scoperto è pieno — chiedere conferma
**Regola:** se l'utente non richiede esplicitamente il coperto ma tutti gli scoperti sono occupati a quell'orario, `createNewMatchAction` ritorna `ONLY_COVERED_AVAILABLE`. `messageHandler` intercetta questo errore e chiede conferma: "A quell'orario gli scoperti sono tutti occupati. Posso prenotarti il campo coperto?". La risposta sì/no è gestita nel successivo turno da `state:pending_covered:{jid}` (TTL 5min).
**Scope:** si applica solo se nel circolo esistono campi scoperti (altrimenti il coperto è l'unico tipo disponibile e non serve conferma).

### 31. Doppia prenotazione nello stesso slot — check pre-booking
**Regola:** `bookSlotForPlayer` controlla PRIMA di creare/joinare una partita se il player ha già una `MatchPlayer` (leftAt=null) in un match OPEN/LOCKED nella finestra ±30min. Se sì, ritorna errore "Hai già una prenotazione in quella fascia oraria." — mai creare duplicati.

### 32. Slot availability nel system prompt del brain
**Architettura:** `buildBrainContext` calcola per i prossimi 10 giorni quali slot sono completamente occupati (`fullSlots`) e quali hanno solo campo coperto disponibile (`onlyCoveredSlots`). Questi vengono mostrati nel system prompt come sezione `═══ DISPONIBILITÀ CAMPI ═══`. Il brain usa queste info per gestire proattivamente le situazioni (es. chiedere conferma coperto PRIMA di tentare il booking).

### 33. Messaggi replay (APPROVED_*) salvati due volte nel DB
**Bug reale:** quando admin approva un numero (`ok +393...`), il messaggio originale è già in DB. Il replay viene inviato con ID fake `APPROVED_1234567` → messageHandler non trova il duplcato → salva di nuovo.
**Fix:** `NormalizedMessage` ha campo `alreadyPersisted?: boolean`. Il replay viene creato con `alreadyPersisted: true`. In `_handleBatchInner`, i messaggi con questo flag vengono aggiunti a `filteredMessages` senza passare dal DB.

### 26. Messaggi `append` persi nella finestra di 5s dopo reconnect
**Bug reale:** al `connection: 'open'`, `isResyncing` veniva impostato a `true` solo dentro un `setTimeout` di 5s. I messaggi `append` (offline recovery da WA) arrivano immediatamente dopo il connect — in quei 5s venivano scartati silenziosamente.
**Fix in place:** i messaggi `append` vengono ora raccolti sempre, indipendentemente da `isResyncing`. Il `syncTimer` (15s debounce) parte all'arrivo del primo `append` e processa tutto dopo l'ultimo. I messaggi `notify` (real-time) non vengono mai bloccati durante il resync.
**Regola:** MAI condizionare la raccolta degli `append` a un flag che viene impostato con ritardo. `append` e `notify` devono avere pipeline indipendenti.

### 24. Admin check DEVE venire prima dell'onboarding state check
**Bug reale (doppio):** (a) admin scriveva al bot dopo DB reset → colpiva gate `!player` → bloccato silenziosamente. (b) admin inviava `ok 393…` → `getOnboardingState` lo intercettava come risposta al nome → niente sblocco.
**Fix in place:** in `messageHandler._handleBatchInner`, l'ordine corretto è:
1. Carica club + adminPhone
2. Controlla comando admin `ok <numero>` → gestisci e ritorna (PRIMA di tutto il resto)
3. `getOnboardingState` check
4. Carica player
5. Gate `!approved` con `isFromAdmin` bypass: `const approved = isFromAdmin || await redis.get(…)`
**Regola:** MAI controllare onboarding state prima di aver gestito i comandi admin. L'admin deve sempre poter operare indipendentemente dal proprio stato conversazionale.

### 25. Ogni emoji nel testo del bot = separatore di bolla WhatsApp
**UX:** gli esseri umani inviano l'emoji come chiusura del pensiero, poi iniziano un nuovo messaggio. Nessuna bolla inizia con un'emoji.
**Implementazione:** `splitAtEmoji()` in `src/utils/split-message.ts` — testo prima dell'emoji forma la bolla corrente (con l'emoji in coda), testo dopo inizia la bolla successiva. Applicato in `messageHandler` (risposta brain), `onboarding-flow` (risposta onboarding brain) e ovunque si inviino testi generati da AI.
**Regola:** ridurre le emoji del 50% nei prompt. MAI iniziare un messaggio con un'emoji. Usare `simulateTypingAndSend` per ogni segmento restituito da `splitAtEmoji()`.

### 21. Vi.mock e module caching in Vitest: usare mockImplementation per catturare ctx
**Problema:** `mockRunWithContext.mock.calls` è vuoto anche se il codice viene eseguito → il modulo crea il suo reference al momento dell'import, che può essere diverso dall'oggetto nella closure del test.
**Fix:** usare `mockRunWithContext.mockImplementation((ctx, fn) => { capturedCtx.push(ctx); return fn(); })` nel `beforeEach` di ogni suite, oppure verificare il comportamento indirettamente (es. verificare che la prima query al DB sia quella corretta).

### 35. `waveQueue.add()` deve essere fire-and-forget, mai awaited
**Bug reale:** `await waveQueue.add(...)` in `createNewMatchAction` e nei path di cancel/reschedule bloccava indefinitamente quando Redis non era raggiungibile — con `maxRetriesPerRequest: null` ioredis non lancia mai eccezione, aspetta all'infinito. Questo causava hang di booking/cancellazioni.
**Regola:** tutti i `waveQueue.add()` in `brain.ts` vanno fatti con `.catch()` fire-and-forget, mai `await`. `checkSilentMatches` (ogni 30min) rilancia automaticamente le wave per i match OPEN senza attività.
```typescript
// ✅ Corretto
waveQueue.add('process-wave', { matchId, ... }, { delay: ... })
    .catch(err => logger.warn({ err, matchId }, 'Wave scheduling failed'));

// ❌ Sbagliato
await waveQueue.add('process-wave', { matchId, ... }, { delay: ... });
```

### 36. Express route ordering: rotte specifiche PRIMA di quelle parametriche
**Bug reale:** `GET /matches/suggest-level` registrata DOPO `GET /matches/:id` → Express trattava la stringa `"suggest-level"` come valore dell'`:id` → sempre 404.
**Regola:** in Express, registrare SEMPRE le rotte letterali (specifiche) prima delle rotte con parametri (`:id`, `:matchId`, ecc.). Commentare esplicitamente l'ordine quando non è ovvio.
```typescript
// ✅ Corretto
router.get('/matches/suggest-level', ...);   // specifica prima
router.get('/matches/:id', ...);              // parametrica dopo

// ❌ Sbagliato
router.get('/matches/:id', ...);              // cattura TUTTO, incluso "suggest-level"
router.get('/matches/suggest-level', ...);    // MAI raggiunta
```

### 37. Test suite locale: usa DIRECT_URL (porta 5432), non DATABASE_URL (pgBouncer 6543)
**Regola:** per eseguire `src/scripts/test-suite.ts` (o altri script che usano Prisma direttamente) in locale, passare sempre `DATABASE_URL` con il valore di `DIRECT_URL_STAGING` (porta 5432). pgBouncer su 6543 non supporta prepared statements.
```bash
DATABASE_URL="postgresql://postgres.ildhffoxuufcbvmmqitj:<pw>@aws-1-eu-west-1.pooler.supabase.com:5432/postgres" \
  DASH_USER=admin_test DASH_PASS=password_test \
  npx tsx src/scripts/test-suite.ts
```
**Nota:** BullMQ con `maxRetriesPerRequest: null` blocca `queue.add()` quando Redis non è raggiungibile da locale — per questo i test che scheduleano wave vanno eseguiti sul VPS, oppure il timeout del test runner (12s) li gestisce come falliti attesi.

### 38. Prisma client locale da rigenerare dopo schema changes sul VPS
**Bug reale:** `npx prisma generate` non era stato eseguito in locale dopo che il VPS aveva aggiunto `clubId` come scalar field su `Match` → il client locale non riconosceva `clubId` → `Unknown argument 'clubId'` a runtime nei test locali.
**Regola:** dopo ogni `prisma db push` sul VPS che aggiunge/modifica campi, eseguire anche in locale `npx prisma generate` per aggiornare i tipi. Il client locale non si aggiorna automaticamente: è legato allo schema.prisma locale, non al DB remoto.

### 39. AI conversation tests (ai-conversation-tests.ts): eseguire sul VPS, non in locale
**Regola:** `src/scripts/ai-conversation-tests.ts` simula conversazioni WhatsApp reali chiamando Claude API tramite brain.ts. Deve girare SOLO sul VPS (`ssh root@46.225.212.159 "cd /root/padel-staging && npx tsx src/scripts/ai-conversation-tests.ts"`).
**Motivi:** (1) Redis non raggiungibile da locale → BullMQ blocca; (2) Schema Prisma diverge tra locale e VPS (es. `Player.name` vs `firstName/lastName`, `openTime` come String vs Int); (3) Rate limit Claude 30k tokens/min — test sequenziali con 2.5s delay/turno e 12s tra gruppi.
**Comportamenti noti del brain:**
- Il brain chiede gender preference ("misto o solo donne?") PRIMA di BOOK_FIELD → aggiungere "misto" ai messaggi di prenotazione nei test
- `INVITE_PREFERRED` usa `params.playerName` (non `params.name`) — l'executeAction cerca il giocatore per nome
- La conferma campo occupato/coperto è in `messageHandler`, non nel brain — il brain si limita a BOOK_FIELD e non menziona sempre la situazione del campo
- Il brain a volte risponde in linguaggio naturale (non JSON) → callBrain ha un retry a temp=0; se il retry fallisce (rate limit), restituisce fallback random
- Ogni telefono di test deve avere una propria storia conversazionale pulita — non riusare lo stesso numero in test diversi o si accumula contesto che confonde il brain

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

### URL Staging (`padel-staging.polpo-ai.com`)
| Cosa | URL |
|------|-----|
| Dashboard circolo | https://padel-staging.polpo-ai.com/dashboard |
| Admin super-dashboard | https://padel-staging.polpo-ai.com/admin |
| Setup wizard | https://padel-staging.polpo-ai.com/setup |
| Health check | https://padel-staging.polpo-ai.com/health |

### URL Produzione (`padel.polpo-ai.com`)
| Cosa | URL |
|------|-----|
| Dashboard circolo | https://padel.polpo-ai.com/dashboard |
| Admin super-dashboard | https://padel.polpo-ai.com/admin |
| Health check | https://padel.polpo-ai.com/health |

> Vedi `LINKS.md` per il quadro completo di tutti i domini sul VPS.

Comandi utili sul VPS:
```bash
systemctl restart padel-staging padel-worker-staging
journalctl -u padel-staging -f           # log in tempo reale
journalctl -u padel-staging --since "10 min ago" --no-pager
```

**Workflow deploy staging:**
1. Modifica direttamente sul VPS staging (o git pull da `preview`)
2. `git add <files> && git commit && git push origin HEAD:preview`
3. `systemctl restart padel-staging padel-worker-staging`
4. In locale: `git fetch origin && git merge origin/preview --no-edit`

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

- Prisma scrive i timestamp in **UTC** (comportamento standard di Node.js `new Date()`)
- Il DB PostgreSQL ha `timezone = 'Europe/Rome'` impostato a livello database (`ALTER DATABASE postgres SET timezone TO 'Europe/Rome'`) → Supabase dashboard mostra orario italiano automaticamente
- Prisma e le query non sono influenzati dal timezone del DB (usa il protocollo binario wire, sempre UTC)
- Output verso utenti: sempre `{ timeZone: 'Europe/Rome' }` in `toLocaleTimeString/toLocaleDateString`
- Input utente (es. "alle 18"): convertito con `buildRomeTime()` in `booking.ts` che gestisce DST automaticamente
- **Non usare mai** `ALTER DATABASE ... SET timezone TO 'UTC'` — tornerebbe a mostrare UTC nel dashboard

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
| Debounce 60s per JID | WhatsApp spezza messaggi lunghi in più pezzi — li raggruppiamo |
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
