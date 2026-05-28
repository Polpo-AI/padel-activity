# Padel Activity — Product Context

## Product Purpose

SaaS platform for padel clubs: a WhatsApp bot handles player registration, field booking, and automated matchmaking (wave invitations). A React dashboard lets club managers monitor courts, matches, players, pricing, and settings. A super-admin console manages multi-tenant club configuration and system health.

## Register

product

## Users

**Club managers** (primary dashboard users): non-technical, access via browser, manage daily operations — creating matches, setting prices, reviewing player lists, editing club settings. Expect clarity and speed over aesthetics.

**Players** (end users of the bot): interact exclusively via WhatsApp; never touch the dashboard.

**Super-admin** (Polpo AI team): monitors all clubs via the `/admin` console — infrastructure health, WhatsApp connection status, match overview across tenants.

## Brand

- **Name**: Padel Activity (product) / Polpo AI (company)
- **Tone**: Professional, direct, Italian-language UI. Functional first. No marketing fluff inside the dashboard.
- **Palette**: Cyan-400 (`#22d3ee`) accent on deep navy (`#0B1228`) dark mode; cyan-600 on sky-blue light mode. Violet (`#a78bfa`) secondary. Magenta (`#ff3d8a`) highlight.
- **Typography**: Inter (system fallback), tabular-nums for data, monospace for IDs/phone numbers.

## Design System

- **ThemeContext** (`src/shared/ThemeContext.jsx`): `useTheme()` hook → `{ C, inputSt, btnPrimary, btnGhost, btnSecondary, cardSt, labelSt }` tokens
- **Dark / light mode**: persisted in `localStorage['pd-theme']`, toggled via `ThemeToggle` pill (top-right, fixed)
- **All styles**: inline JS objects only — no Tailwind, no CSS modules
- **Color tokens**: `C.open` (cyan), `C.locked` (blue), `C.cancelled` (red), `C.unfilled` (orange), `C.warning` (amber), `C.muted` (slate), `C.accent`, `C.indigo`, `C.success`, `C.male` (blue), `C.female` (pink), `C.overlay`, `C.titleColor`
- **Progress bars**: `transform: scaleX()` with `transformOrigin: left` — never `width: %`
- **Responsive**: `useMobile(breakpoint)` hook from ThemeContext; breakpoint 640px

## Anti-references

- No glassmorphism cards as decoration (only Login page uses blur intentionally)
- No gradient text
- No side-stripe borders
- No identical card grids
- No SaaS-cream (#f8f9fa everywhere)

## Tech Stack

- React 18 + Vite (dashboard only)
- Node.js + Express + Prisma + PostgreSQL (backend)
- WhatsApp via Baileys
- Staging: `padel-staging.polpo-ai.com` / Production: `padel.polpo-ai.com`
