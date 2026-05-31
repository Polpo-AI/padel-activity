# ✅ Checklist messa in produzione

Stato preparato dall'assistente. Il **codice** (tutti gli 8 blocchi + audit) è su `preview`.
Il **DB di produzione è stato svuotato completamente** (0 club/giocatori/partite): slate pulito.
`main` NON è ancora aggiornato → il push vero lo fai tu quando sei pronto.

---

## 1. Cosa DEVI modificare nel `.env` di produzione (`/root/padel-prod/.env`)

Senza queste cose alcune funzioni non partono. SSH: `ssh root@46.225.212.159`, poi `cd /root/padel-prod && nano .env`.

### ⛔ MANCANTI — da AGGIUNGERE (necessarie)
| Variabile | Perché serve | Se manca |
|-----------|--------------|----------|
| `JWT_SECRET` | Login dashboard circolo + impersonation admin | Impersonation dà **errore 500**; login dashboard usa un default insicuro |
| `ADMIN_JWT_SECRET` | Login console admin (`/admin`) | Usa un default insicuro pubblicamente noto |
| `ADMIN_USERNAME` | Utente console admin | Default `admin` |
| `ADMIN_PASSWORD` | Password console admin | Default `admin123` (insicuro!) |
| `SETUP_SECRET` | Accesso al wizard `/setup?secret=...` per onboardare i circoli | Non riesci ad aggiungere clienti |

> Genera i segreti forti con: `openssl rand -hex 32`

### 🔧 GIÀ PRESENTI — da VERIFICARE / MODIFICARE
| Variabile | Azione |
|-----------|--------|
| `ANTHROPIC_API_KEY` | Metti la chiave **Claude di produzione** (questa è quella che volevi modificare) |
| `OPENAI_API_KEY` | Chiave prod (serve per trascrizione audio Whisper) |
| `DATABASE_URL` / `DIRECT_URL` | Confermare che puntino alla **Supabase PROD** (non staging) — già configurate |
| `DRY_RUN` | Deve essere `false` ✅ (già così) |
| `REDIS_*` | Confermare Redis **prod separato** da staging. Se condividono lo stesso Redis → aggiungi `QUEUE_PREFIX=prod` (altrimenti i job BullMQ si mescolano) |
| `ADMIN_PHONE` | Legacy single-tenant; con multi-tenant l'admin è per-circolo. Con i circoli nuovi che fai da `/setup` puoi anche lasciare l'adminPhone vuoto → si usa la self-chat del bot |

### 🚫 NON aggiungere
- `APPROVAL_GATE` → lascialo **assente** (è la feature "approva numero" anti-nonna, deve restare OFF in prod). ✅ già assente.

---

## 2. Come funziona l'onboarding di un cliente (a slate pulito)

A DB vuoto **il bot non parla con nessuno** (nessun circolo connesso). Per attivare un cliente:
1. Vai su `https://padel.polpo-ai.com/setup?secret=<SETUP_SECRET>`
2. Compila il wizard (nome circolo, campi, orari, prezzi… il telefono admin ora è **opzionale**).
3. Il circolo viene creato con le sue credenziali dashboard.
4. Per far connettere il bot WhatsApp di quel circolo serve il suo `botPhoneNumber` + scansione QR (Baileys) — passo operativo lato WhatsApp.

---

## 3. Sequenza del push (la eseguo io quando dici "vai")

```bash
# locale: merge preview → main
git checkout main && git merge origin/preview --no-edit && git push origin main

# VPS produzione
ssh root@46.225.212.159
cd /root/padel-prod
git pull origin main
npx prisma db push          # applica le nuove colonne (racchette/consegna/dormienza/audit)
npx prisma generate
cd dashboard && npm run build && cd ..
systemctl restart padel-prod padel-worker-prod
```

> Nota: lo schema è cambiato (Blocco 1) → il `db push` su prod è **obbligatorio**, altrimenti crash a runtime.

---

## 4. Smoke test post-deploy
- `https://padel.polpo-ai.com/health` → 200
- `/admin` → login con le nuove credenziali admin
- `/setup?secret=...` → wizard con look navy+ciano
- Onboarda un circolo di prova → verifica dashboard
