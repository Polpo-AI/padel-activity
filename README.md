# Padel Matchmaking Bot — Polpo AI

Bot WhatsApp per la gestione automatica delle prenotazioni e del matchmaking in circoli di padel.
Riceve messaggi dai giocatori, gestisce inviti a ondate (wave), onboarding, booking e feedback post-partita,
il tutto con simulazione di comportamento umano per ridurre il rischio di ban WhatsApp.

---

## Stack

| Layer | Tecnologia |
|-------|-----------|
| Runtime | Node.js 20 + TypeScript (tsx, nessun build step) |
| Framework HTTP | Express |
| ORM / DB | Prisma + PostgreSQL (Supabase) |
| Cache / Code | Redis (ioredis) + BullMQ |
| WhatsApp | Baileys (`@whiskeysockets/baileys`) |
| AI | Anthropic Claude (Haiku per classificazioni, Sonnet per testo) |
| Process manager | systemd (produzione/staging su VPS) |
| Test | Vitest |

---

## Avvio in locale

```bash
# 1. Installa dipendenze
npm install
cd dashboard && npm install && cd ..

# 2. Configura variabili d'ambiente
cp .env.example .env   # poi modifica DATABASE_URL, REDIS_URL, ANTHROPIC_API_KEY, ecc.

# 3. Applica lo schema al database
npx prisma db push

# 4. Avvia il bot (processo principale)
npm run dev

# 5. In un altro terminale, avvia il worker BullMQ
npm run worker

# 6. Opzionale: avvia la dashboard React in dev
cd dashboard && npm run dev
```

> Imposta `DRY_RUN=true` nel `.env` per testare senza inviare messaggi WhatsApp reali.

---

## Deploy su VPS

Il progetto gira su due ambienti separati, entrambi gestiti via systemd:

| Ambiente | Cartella VPS | Branch GH | Servizi systemd |
|----------|-------------|-----------|----------------|
| Staging | `/root/padel-staging` | `preview` | `padel-staging` + `padel-worker-staging` |
| Produzione | `/root/padel-prod` | `main` | `padel-prod` + `padel-worker-prod` |

**Workflow deploy staging:**
```bash
# Locale: commit + push su main
git push origin main

# Sul VPS (root@46.225.212.159):
cd /root/padel-staging && git pull origin main
systemctl restart padel-staging padel-worker-staging

# Per pubblicare su branch preview:
git push origin HEAD:preview
```

**Log in tempo reale:**
```bash
journalctl -u padel-staging -f
journalctl -u padel-staging --since "10 min ago" --no-pager
```

---

## Documentazione

- [CLAUDE.md](CLAUDE.md) — Manuale operativo completo per sviluppatori e AI: architettura, modello dati, workflow, convenzioni di codice
- [REPOSITORY_MAP.md](REPOSITORY_MAP.md) — Mappa sintetica di tutti i file del progetto organizzata per cartella
