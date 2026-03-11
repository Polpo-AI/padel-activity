# Repository Map: Padel Bot Pro

Structured overview of the project's architecture and file organization.

## 📂 Root (Configuration & Environment)
- `.env` - Environment variables (API Keys, Database URL, Redis).
- `package.json` - Dependencies and scripts (start, dev, worker).
- `tsconfig.json` - TypeScript configuration.
- `docker-compose.yml` - Setup for Redis and local database.
- `prisma.config.ts` - Dynamic Prisma 7 configuration.
- `READY_TO_LAUNCH.md` - Production deployment checklist.
- `ANTI_BAN.md` - WhatsApp anti-ban strategies and parameters.
- `REPOSITORY_MAP.md` - This file.

## 📂 src/ (Core Application)
- `index.ts` - Entry point for **API and WhatsApp Socket**.
- `worker.ts` - Dedicated entry point for **background workers** (BullMQ).
- `ecosystem.config.js` - PM2 configuration for process management.

### 📁 src/api/ (HTTP Endpoints)
- `webhooks.ts` - Webhook for matching slot notifications.
- `dashboard.api.ts` - Dashboard-specific APIs (Login, Stats, Court Management).

### 📁 src/services/ (Business Logic)
- `whatsapp.ts` - Baileys integration (connection, messaging, typing emulation).
- `messageHandler.ts` - **Main Logic**: interprets incoming messages and manages responses.
- `ai.ts` - Claude integration (Haiku 4.5) for invitations and intent classification.
- `matchmaker.ts` - Player selection logic (Wave) based on skill and rotation.
- `onboarding.ts` / `onboarding-flow.ts` - Automatic onboarding for new players.
- `redirect.ts` - Slot allocation and alternatives when matches are full.
- `reliability.ts` / `scoring.ts` - Reliability score calculation and updates.
- `booking.ts` - External booking system interface.
- `queue.ts` - BullMQ configuration (Wave, Reminders, Maintenance).
- `db.ts` - Prisma Client initialization.
- `intent-resolver.ts` - Advanced intent interpretation.
- `whatsapp-rate-limiter.ts` - Throttling for WhatsApp outgoing messages.
- `whatsapp.patch.ts` - Hot patches for Baileys connectivity.
- `inbound-queue.ts` - Buffer for incoming messages.
- `group-handler.ts` - WhatsApp group management (creation, participants).

### 📁 src/workers/ (Background Jobs)
- `wave.worker.ts` - Executes invitation waves.
- `reminder.worker.ts` - Sends pre-match automated reminders.
- `maintenance.worker.ts` - Automated cleanup (timeouts, daily resets).
- `recovery.worker.ts` - Handles unfilled slots or lost connections.

### 📁 src/utils/ (Utilities)
- `retry.ts` - Exponential backoff logic for external services.
- `notify-admin.ts` - Emergency alert system for admins.

### 📁 src/components/ (Frontend Dashboard)
- `PadelDashboard2.jsx` - Advanced Pro Dashboard (v2).
- `PadelDashboard.jsx` - Baseline Dashboard (v1).

## 📂 prisma/ & scripts/ (Data & DevOps)
- `schema.prisma` - Database schema (Player, Match, Court, Invitation).
- `seed-players.ts` - Database seeding for testing.
- `setup-club.ts` - Initial club configuration (courts, business hours).
- `import-vcf.ts` / `import-group.ts` - Bulk player import scripts.
- `trigger-match.ts` - Manual match creation triggers.
- `discover-groups.ts` - Automated WhatsApp group scanning.
