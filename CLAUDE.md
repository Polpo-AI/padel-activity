# CLAUDE.md — Padel Matchmaking Bot

Regole operative del progetto. Leggile prima di toccare qualsiasi cosa.
Per architettura, stack, workflow e mappa file → [ARCHITECTURE.md](ARCHITECTURE.md).

---

## ⚠️ LESSONS LEARNED

### Deploy & Infra

#### Deploy: staging → preview → main
Lavorare SEMPRE su staging. MAI pushare su `main` durante sviluppo — solo `preview`.

**⚠️ Il VPS staging è la fonte di lavoro autoritativa, non il locale.** Si sviluppa, si committa e si pusha DAL VPS (`/root/padel-staging`). GitHub (`preview`) e la copia locale sono solo backup/mirror: in locale si fa SOLO sync (`git fetch && git merge origin/preview`), MAI sviluppo+push da locale. Un push da uno stato locale stale può riportare indietro `preview` e cancellare feature già salite da altri o dal VPS. Prima di OGNI push: `git fetch` e verifica che `origin/preview` non abbia commit che non hai; mai force/backward push. La cosa deve funzionare sul VPS in primis.
```bash
# Sul VPS staging
cd /root/padel-staging
git add ... && git commit && git push origin HEAD:preview

# In locale (sync)
git fetch origin && git merge origin/preview --no-edit

# Deploy produzione (solo quando esplicitamente richiesto)
cd /root/padel-prod && git pull origin main
cd dashboard && npm run build && cd ..
systemctl restart padel-prod padel-worker-prod
```
**⚠️ Build dashboard obbligatoria:** il VPS serve `dashboard/dist` (build statica React/Vite), NON i `.jsx` sorgente. Dopo ogni pull che tocca `dashboard/src/`:
```bash
cd /root/padel-staging/dashboard && npm run build && cd ..
systemctl restart padel-staging
```

#### Pagine dashboard bianche (Utenti/FAQ) = dist STALE, non un bug di codice
Sintomo ricorrente: alcune view (es. Utenti, FAQ) si caricano bianche. Causa quasi sempre la stessa: la
`dashboard/dist` servita è una build vecchia che NON corrisponde ai sorgenti (es. manca un fix già
committato come `a917aa8` "useTheme nei sub-componenti", o le migliorie impeccable). **NON è un bug nuovo
nel codice** — è build non rifatta. Insidia: committare i file `dist/` senza aver lanciato `npm run build`
li lascia stale anche se il commit si chiama "rebuild".
**Verifica e fix:**
```bash
# 1. Confronta il bundle servito con un rebuild fresco: se l'hash cambia, la dist era stale
cd /root/padel-staging/dashboard && npm run build   # nota il nuovo index-XXXX.js
grep -oE 'assets/index-[A-Za-z0-9]+\.js' dist/index.html   # deve puntare al bundle appena buildato
# 2. Conferma dal bundle servito pubblicamente (stringhe attuali presenti = sorgenti aggiornati)
curl -s https://padel-staging.polpo-ai.com/dashboard/$(curl -s https://padel-staging.polpo-ai.com/dashboard/ | grep -oE 'assets/index-[A-Za-z0-9]+\.js' | head -1) | grep -c "In attesa di risposta"
systemctl restart padel-staging
```
`npm run build` svuota `dist/` e rigenera l'hash: se cambia rispetto a quello committato, la dist era vecchia.
Committare sempre la dist APPENA buildata, mai una pre-esistente nel working tree.

#### Query DB rapide: psql diretto, MAI `npx tsx -e` inline
`$` in `tsx -e` viene interpretato come shell → errore esbuild. `node -e "SELECT ..."` → bash: command not found. Usare sempre psql:
```bash
PGPASSWORD=<pw> psql -h <host> -p 5432 -U <user> -d postgres -c 'SELECT ...'
# Credenziali: grep DIRECT_URL_STAGING .env
```
Per script complessi: file `.ts` + `npx tsx file.ts`, mai `-e` inline con Prisma.

#### I riavvii WA non sono necessariamente crash
`SIGTERM received` = restart intenzionale via `systemctl restart`. Distinguere da crash reali (`code=exited status=1`):
```bash
journalctl -u padel-staging | grep -E 'SIGTERM|exited|Failed'
```

---

### Prisma & Schema

#### `prisma db push` invece di `migrate dev`
Supabase ha drift dalla migration history → `migrate dev` va in errore. Sempre `prisma db push`.

#### `db push` va eseguito SUL VPS, non in locale
`prisma.config.ts` locale intercetta con il `DIRECT_URL` sbagliato → push finisce sul DB locale.
```bash
ssh root@46.225.212.159
cd /root/padel-staging
DATABASE_URL='<DIRECT_URL_STAGING>' npx prisma db push
npx prisma generate
systemctl restart padel-staging padel-worker-staging
```
Credenziali in `/root/padel-staging/.env` → `DIRECT_URL` (porta 5432).

#### Dopo ogni `db push`: `prisma generate` + restart (VPS E locale)
Il client JS usa il vecchio schema → `Unknown argument 'X'` a runtime. Rigenerare su VPS dopo ogni push; in locale dopo ogni push sul VPS.

#### Ogni `db push` va applicato su staging E produzione
Schema disallineato causa crash silenziosi. `DIRECT_URL_STAGING` per staging, `DIRECT_URL` per produzione.

#### MAI `prisma db push --force-reset`
Droppa e ricrea tutto: Club, Courts, credentials. Per reset dati transienti usare `db-reset.ts`.

#### Script e operazioni dirette: porta 5432 (non pgBouncer 6543)
pgBouncer su 6543 non supporta prepared statements. Usare sempre `DIRECT_URL_STAGING`.
MAI estrarre l'URL con `$(grep '^DIRECT_URL=' .env | cut ...)` — le virgolette nel `.env` corrompono l'URL. Passare sempre il valore letterale esplicito:
```bash
DATABASE_URL='postgresql://postgres.xxx:pw@host:5432/postgres' npx tsx src/scripts/db-reset.ts
```

#### Reset DB di test: flushare anche Redis
`db-reset.ts` esegue `redis.flushdb()` automaticamente. Se reset manuale: `redis-cli flushdb` sul VPS.
**MAI in produzione** — `flushdb` cancella TUTTI i job BullMQ.

---

### Bot / AI

#### Il brain gestisce anche gli utenti non registrati
Non re-introdurre `startSingleOnboarding`, `continueOnboarding`, `getOnboardingState` o stati Redis `state:onboarding:*`. Rimossi deliberatamente. Tutti i messaggi passano da `callBrain` — player null → brain riceve contesto ridotto → action `REGISTER_PLAYER`.

#### Nome del giocatore: nessun fallback al testo grezzo
`REGISTER_PLAYER` solo con nome+cognome certi (deve contenere uno spazio). Se `params.name` non ha spazio, `executeAction` ritorna `success: true` senza creare il player — brain riprova al prossimo turno.

#### Nessun gruppo, nessun playerCount
Il padel è sempre 4 giocatori. `playerCount` non esiste. `INVITE_PREFERRED` è l'unico modo per coinvolgere un amico specifico.

#### skillLevel ≤ 0 = nessuna wave
Match creato, ma NO wave. Il bot non promette abbinamento. `skillLevel: -1` = registrato, Skill Test in attesa.

#### Il brain genera il messaggio PRIMA che `executeAction` venga eseguita
Il brain non conosce campo, prezzo, ecc. → usare frasi neutre ("Perfetto, prenoto subito!"). I dettagli arrivano nella scheda separata inviata da messageHandler DOPO `executeAction`.

#### Fallback AI: mai identico due volte
Il catch di `callBrain` usa un array di N messaggi random — mai lo stesso due volte di fila.

#### `simulateTypingAndSend` già salva il messaggio nel DB
Non salvare manualmente i messaggi outbound — `simulateTypingAndSend` lo fa già, il duplicato è garantito.

#### Messaggi USER consecutivi in history causano Anthropic 400
`callBrain` fonde i messaggi con lo stesso ruolo consecutivi e rimuove l'ultimo `user` prima di inviare. MAI passare ad Anthropic una lista senza verificare che i ruoli si alternino.

#### Ogni emoji nel testo del bot = separatore di bolla WhatsApp
`splitAtEmoji()` in `src/utils/split-message.ts`. MAI iniziare un messaggio con un'emoji. Ridurre le emoji del 50% nei prompt.

#### INVITE_PREFERRED NON per "amici" generici
Richiede un nome specifico. "vengo con degli amici" senza nomi → `BOOK_FIELD` direttamente, senza chiedere se sono iscritti.

#### Il brain NON deve promettere il campo prima di BOOK_FIELD
Mai menzionare nome campo o tipo (coperto/scoperto) nella risposta JSON del brain — il brain non sa quale verrà assegnato.

#### Campo coperto: chiedere conferma quando lo scoperto è pieno
`createNewMatchAction` ritorna `ONLY_COVERED_AVAILABLE`. `messageHandler` intercetta e chiede conferma. Stato `state:pending_covered:{jid}` (TTL 5min). Si applica solo se esistono campi scoperti nel circolo.

#### Doppia prenotazione: check pre-booking
`bookSlotForPlayer` verifica `MatchPlayer` esistente (leftAt=null) in ±30min prima di creare/joinare.

#### Slot availability nel system prompt del brain
`buildBrainContext` calcola `fullSlots`/`onlyCoveredSlots` per i prossimi 10 giorni → sezione `═══ DISPONIBILITÀ CAMPI ═══` nel prompt.

#### Messaggi replay (APPROVED_*): flag alreadyPersisted
`NormalizedMessage.alreadyPersisted = true` evita che `_handleBatchInner` salvi di nuovo il replay.

#### Admin check DEVE venire prima dell'onboarding state check
Ordine in `_handleBatchInner`: (1) carica club+adminPhone, (2) gestisci comando admin `ok <numero>` e ritorna, (3) onboarding state, (4) player lookup. L'admin deve sempre poter operare indipendentemente.

#### skillLevel -1 per nuovi giocatori + gender inference
`REGISTER_PLAYER` crea con `skillLevel: -1` + `inferGender(firstName)` dal primo nome.

#### `waveQueue.add()` fire-and-forget, mai awaited
Con `maxRetriesPerRequest: null`, `await waveQueue.add()` blocca all'infinito se Redis non è raggiungibile.
```typescript
// ✅
waveQueue.add('process-wave', { matchId }, { delay })
  .catch(err => logger.warn({ err, matchId }, 'Wave scheduling failed'));
// ❌
await waveQueue.add('process-wave', { matchId }, { delay });
```

#### `adminPhone` con prefisso internazionale completo
`393457991255` non `3457991255` — altrimenti `notifyAdmin` costruisce un JID inesistente e le notifiche sono silenziosamente perse.

---

### WhatsApp / Baileys

#### MAI importare `whatsapp.ts` con dynamic import in route handler
Crea istanza isolata del modulo → `sock = null`, `connectionStatus = 'connecting'` sempre. Solo import statici in cima al file. Dynamic import ok solo per moduli senza stato singleton.

#### Messaggi `append` persi nella finestra dopo reconnect
`append` (offline recovery) arrivano immediatamente dopo il connect — raccolti sempre, indipendentemente da `isResyncing`. Pipeline `append` e `notify` indipendenti. `syncTimer` (15s debounce) processa tutto dopo l'ultimo `append`.

---

### Multi-tenant

#### AsyncLocalStorage per propagare clubId
NON passare `clubId` come parametro esplicito a ogni funzione. `runWithContext` al punto di ingresso (messageHandler, processWave), `getClubId()` dove serve. Tutto il downstream usa automaticamente il socket corretto.

#### botPhoneNumber nel DB, fallback su env vars
`index.ts` connette i club con `botPhoneNumber != null`. Legacy single-tenant: `BOT_PHONE_NUMBER` env var.
Auth folder Baileys: `baileys_auth_info_{clubId}` per club multi-tenant, `baileys_auth_info` per legacy.

---

### Testing

#### AI conversation tests: eseguire sul VPS, non in locale
```bash
ssh root@46.225.212.159 "cd /root/padel-staging && npx tsx src/scripts/ai-conversation-tests.ts"
```
Motivi: (1) Redis non raggiungibile da locale → BullMQ blocca; (2) schema Prisma diverge (es. `Player.name` vs `firstName/lastName`); (3) rate limit Claude 30k tokens/min.
Comportamenti noti: il brain chiede gender preference prima di BOOK_FIELD → aggiungere "misto" nei test. Non riusare lo stesso numero in test diversi.

#### Date negli script: verificare il giorno della settimana
JS mesi 0-indexed (`new Date(2026, 3, 17)` = aprile 17). `utc(y, mo, d, h)` nel progetto è 1-indexed (aprile=4). Non mischiare i due sistemi.
```bash
node -e "console.log(new Date(2026,3,17).toLocaleDateString('it-IT',{weekday:'long',day:'numeric',month:'long'}))"
```

#### Vitest: mockImplementation per catturare ctx di runWithContext
`mockRunWithContext.mock.calls` può essere vuoto per module caching. Usare `.mockImplementation((ctx, fn) => { capturedCtx.push(ctx); return fn(); })` in `beforeEach`.

#### Express: rotte specifiche PRIMA di quelle parametriche
`/matches/suggest-level` va registrata PRIMA di `/matches/:id` — altrimenti Express cattura la stringa letterale come valore di `:id` → 404.

---

## Ambienti

| Ambiente | Cartella VPS | Branch GH | Systemd |
|----------|-------------|-----------|---------|
| Staging | `/root/padel-staging` | `preview` | `padel-staging.service` + `padel-worker-staging.service` |
| Produzione | `/root/padel-prod` | `main` | `padel-prod.service` + `padel-worker-prod.service` |

VPS: `root@46.225.212.159` (SSH con chiave `~/.ssh/id_ed25519`)

| Staging | URL |
|---------|-----|
| Dashboard | https://padel-staging.polpo-ai.com/dashboard |
| Admin | https://padel-staging.polpo-ai.com/admin |
| Setup | https://padel-staging.polpo-ai.com/setup |
| Health | https://padel-staging.polpo-ai.com/health |

| Produzione | URL |
|-----------|-----|
| Dashboard | https://padel.polpo-ai.com/dashboard |
| Admin | https://padel.polpo-ai.com/admin |
| Health | https://padel.polpo-ai.com/health |

> Vedi `LINKS.md` per il quadro completo di tutti i domini sul VPS.

```bash
systemctl restart padel-staging padel-worker-staging
journalctl -u padel-staging -f
journalctl -u padel-staging --since "10 min ago" --no-pager
```
