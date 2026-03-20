# Link Progetto Padel — Polpo AI

## Staging (`padel-staging.polpo-ai.com` → VPS:3001)

| Cosa | URL |
|------|-----|
| Dashboard circolo | https://padel-staging.polpo-ai.com/dashboard |
| Admin super-dashboard | https://padel-staging.polpo-ai.com/admin |
| Setup wizard | https://padel-staging.polpo-ai.com/setup |
| Health check | https://padel-staging.polpo-ai.com/health |

**Credenziali dashboard circolo:** salvate su `Club.dashboardUsername` / `Club.dashboardPasswordHash` nel DB
**Credenziali admin:** `ADMIN_USERNAME` / `ADMIN_PASSWORD` (default: `admin` / `admin123` — cambiare in prod!)

## Produzione (`padel.polpo-ai.com` → VPS:3000)

| Cosa | URL |
|------|-----|
| Dashboard circolo | https://padel.polpo-ai.com/dashboard |
| Admin super-dashboard | https://padel.polpo-ai.com/admin |
| Setup wizard | https://padel.polpo-ai.com/setup |
| Health check | https://padel.polpo-ai.com/health |

> ⚠️ Produzione attualmente non attiva (`padel-prod.service` fermo)

## VPS

| Cosa | Valore |
|------|--------|
| IP | `46.225.212.159` |
| SSH | `ssh -i ~/.ssh/id_ed25519 root@46.225.212.159` |
| Staging dir | `/root/padel-staging` |
| Produzione dir | `/root/padel-prod` |
| Staging services | `padel-staging.service` + `padel-worker-staging.service` |
| Prod services | `padel-prod.service` + `padel-worker-prod.service` |

## Altri domini sullo stesso VPS

| Dominio | Porta | Progetto |
|---------|-------|---------|
| `staging.polpo-ai.com` | 8001 | Assistente AI (altro progetto) |
| `api.polpo-ai.com` | 8000 | Assistente AI API |
| `dashboard.polpo-ai.com` | statico | Polpo Dashboard (altro progetto) |
| `dashboard-staging.polpo-ai.com` | statico | Polpo Dashboard staging |

## GitHub

| Branch | Ambiente |
|--------|---------|
| `main` | produzione |
| `preview` | staging |
