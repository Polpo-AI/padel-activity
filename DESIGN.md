---
name: Padel Activity Dashboard
description: Centro di controllo per gestori di circoli padel — denso, funzionale, orientato al dato.
colors:
  cyan-vivid: "#22d3ee"
  cyan-accessible: "#0891b2"
  violet-accent: "#a78bfa"
  violet-accessible: "#7c3aed"
  navy-deep: "#0B1228"
  navy-surface: "#0F1730"
  navy-card: "#1A234A"
  sky-bg: "#e8f4fd"
  sky-surface: "#f4faff"
  sky-card: "#edf7ff"
  text-light: "#f8fafc"
  text-dark: "#0f172a"
  muted-dark: "#94a3b8"
  muted-light: "#64748b"
  status-open: "#22d3ee"
  status-locked: "#3b82f6"
  status-cancelled: "#ef4444"
  status-unfilled: "#f97316"
  status-warning: "#f59e0b"
  status-success: "#22c55e"
  status-male: "#3b82f6"
  status-female: "#ec4899"
typography:
  label:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    letterSpacing: "0.1em"
    textTransform: "uppercase"
  body:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  title:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.2
  heading:
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 700
    letterSpacing: "-0.02em"
    lineHeight: 1.1
rounded:
  sm: "8px"
  md: "10px"
  lg: "12px"
  xl: "20px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "36px"
components:
  button-primary:
    backgroundColor: "#22d3ee"
    textColor: "#030d16"
    rounded: "{rounded.md}"
    padding: "10px 20px"
    typography: "{typography.body}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-dark}"
    rounded: "{rounded.sm}"
    padding: "7px 14px"
  button-secondary:
    backgroundColor: "{colors.violet-accent}"
    textColor: "{colors.violet-accessible}"
    rounded: "{rounded.md}"
    padding: "9px 18px"
  input-field:
    backgroundColor: "{colors.navy-surface}"
    textColor: "{colors.text-light}"
    rounded: "{rounded.md}"
    padding: "10px 14px"
  card-surface:
    backgroundColor: "{colors.navy-surface}"
    rounded: "{rounded.lg}"
    padding: "20px 24px"
---

# Design System: Padel Activity Dashboard

## 1. Overview

**Creative North Star: "Il Centro di Controllo"**

La dashboard è lo strumento di lavoro di un gestore di circolo padel: non decorazione, non marketing, ma comando. Come la plancia di un centro operativo professionale, ogni informazione è al suo posto, ogni azione è a portata di mano. La densità è una virtù. Il silenzio visivo è un premio, non un difetto.

Il sistema esiste in due modalità — un dark mode navy profondo per chi lavora in ambienti controllati o serali, un light mode azzurro-cielo saturo per chi gestisce il circolo in piena luce. Nessuna delle due è un default pigro: la scelta è funzionale, non decorativa.

Il colore primario è l'**Azzurro Padelístico**: il ciano brillante (`#22d3ee`) dei campi in resina, vivo e riconoscibile. Non è una scelta generica "AI tool blue" ma un colore specifico del dominio. Il violet secondario (`#a78bfa`) e il magenta (`#ff3d8a`) compaiono raramente, come segnali, non come sfondo.

**Key Characteristics:**
- Tipografia Inter, singola famiglia, senza display font separato
- Token cromatici per stato semantico (open/locked/cancelled/unfilled/warning/success) usati consistentemente in tutta l'app
- Profondit‌à attraverso strati tonali, non ombre decorative
- Densità calibrata: label uppercase 10px, dati 13px, titoli 28px — scala rigorosa
- Dark e light mode entrambi in produzione, persistiti in `localStorage['pd-theme']`

## 2. Colors: La Palette del Campo

Il sistema usa una strategia **Restrained**: il cyan occupa meno del 10% di ogni schermata, comparendo su azioni primarie, stati attivi, e indicatori numerici chiave. Il resto è neutro tondale.

### Primary
- **Azzurro Padelístico** (`#22d3ee` dark / `#0891b2` light): L'accento primario. Bottoni CTA, stati "Aperta", link attivi, focus ring. Il valore scuro è saturato e vivido — visibile sul navy. Il valore chiaro è più accessibile sul fondo azzurro-cielo.

### Secondary
- **Violet Profondo** (`#a78bfa` dark / `#7c3aed` light): Per azioni secondarie (btnSecondary), stati "non disponibile", badge speciali. Appare in coppia col cyan solo nella login aurora — mai in sovrapposizione nell'UI operativa.

### Neutral (Dark Mode)
- **Navy Profondo** (`#0B1228`): Background principale. Base su cui tutto poggia.
- **Navy Surface** (`#0F1730`): Card e pannelli di primo livello.
- **Navy Card** (`#1A234A`): Elementi interni ai card, superfici di terzo livello.
- **Testo Chiaro** (`#f8fafc`): Corpo principale del testo.
- **Grigio Slate** (`#94a3b8`): Testo secondario, label, valori vuoti.

### Neutral (Light Mode)
- **Azzurro Cielo** (`#e8f4fd`): Background principale — saturo, mai bianco puro.
- **Azzurro Superficie** (`#f4faff`): Card di primo livello.
- **Azzurro Card** (`#edf7ff`): Superfici interne.
- **Inchiostro** (`#0f172a`): Testo principale su fondo chiaro.
- **Slate Medio** (`#64748b`): Testo secondario in light mode.

### Status Vocabulary
Il vocabolario di stato è fisso e usato uniformemente su tutta l'app:

| Stato | Dark | Light | Uso |
|---|---|---|---|
| Open / Connesso | `#22d3ee` | `#0891b2` | Partite aperte, WA connesso |
| Locked | `#3b82f6` | `#1d4ed8` | Partite chiuse, confermato |
| Cancelled | `#ef4444` | `#dc2626` | Cancellazioni, errori |
| Unfilled | `#f97316` | `#ea580c` | Partite non riempite |
| Warning | `#f59e0b` | `#d97706` | Attenzione, modifiche non salvate |
| Success | `#22c55e` | `#16a34a` | Operazioni completate |

**The Semantic Lock Rule.** I colori di stato non si usano per decorazione. `#22d3ee` non è "blu bello", è "questa partita è aperta". Ogni uso fuori dal suo stato semantico corrompe il sistema.

## 3. Typography

**Font:** Inter (con fallback `-apple-system, BlinkMacSystemFont, system-ui, sans-serif`)

Un'unica famiglia per l'intera UI. Niente display font, niente serif. Inter porta la leggibilità nei dati densi senza cedere al sapore generico quando i pesi e gli spaziamenti vengono usati con precisione.

**Character:** Voce operativa. Titoli con tracking negativo (`-0.02em`) per autorevolezza. Label uppercase con letter-spacing ampio (`0.1em`) per gerarchia senza peso visivo aggiuntivo. Dati numerici con `font-variant-numeric: tabular-nums` per allineamento colonne.

### Hierarchy

- **Heading** (700, 28px, -0.02em, 1.1): Titoli di sezione in App.jsx e AdminApp.jsx. Comparsa unica per schermata.
- **Title** (700, 15–16px, 1.2): Intestazioni di card, titoli di modal, nome circolo.
- **Body** (400, 13px, 1.5): Testo corrente, righe di tabella, contenuto di form.
- **Label** (600, 10px, 0.1em, uppercase): Intestazioni di colonna tabella, field label, categorie. Non usare sotto i 10px.
- **Mono** (system monospace, 11–12px): Numeri di telefono, JID WhatsApp, ID sessione.

**The Tabular Numerals Rule.** Ogni contatore, percentuale, skill level, o dato numerico in tabella porta `font-variant-numeric: tabular-nums`. I numeri che saltano rompono l'allineamento visivo e fanno sembrare i dati non affidabili.

## 4. Elevation

Il sistema usa **profondit‌à tonale stratificata** senza ombre strutturali. La gerarchia è:

```
bg (layer 0)  →  surface (layer 1)  →  card (layer 2)
#0B1228            #0F1730               #1A234A        [dark]
#e8f4fd            #f4faff               #edf7ff        [light]
```

Ogni layer è leggermente più chiaro (light: più saturo) del precedente. La differenza è sottile e intenzionale — visibile, non urlata.

Le `cardSt` usano un backdrop-filter limitato (`blur(16px)`) solo dove necessario per separare pannelli sovrapposti. L'uso decorativo del blur è proibito.

**The Flat-By-Default Rule.** Le superfici sono piatte a riposo. Il glow cyan/violet (`box-shadow: 0 8px 32px rgba(6,182,212,0.28)`) compare solo sul `btnPrimary` — non sui card, non sui pannelli, non come decorazione. La login page è l'unica eccezione strutturale per l'aurora.

### Shadow Vocabulary
- **btn-primary glow** (`0 8px 32px rgba(6,182,212,0.28), inset 0 1px 0 rgba(255,255,255,0.18)`): Esclusivamente sul bottone CTA primario in dark mode.
- **card ambient** (`0 4px 24px rgba(8,145,178,0.12)`): Usato raramente su card di primo livello in light mode per percepibilità.

## 5. Components

### Buttons

**Tre varianti, gerarchicamente distinte.**

- **Primary (`btnPrimary`):** Gradient cyan orizzontale (`#22d3ee → #06b6d4 → #0891b2`), testo navy scuro (`#030d16`), 10px radius, `700` weight. Unico elemento che porta glow. Un solo bottone primario per schermata.
- **Ghost (`btnGhost`):** Background trasparente, testo `C.muted`, bordo `C.border` 1px, 8px radius. Per azioni secondarie e navigazione paginazione.
- **Secondary (`btnSecondary`):** Background violet tinted, testo `C.indigo`, bordo `C.indigoSoft`. Per azioni alternative che competono col primario in contesti modali.

**Tutti i `<button>` portano `type="button"` esplicito** salvo form submit espliciti.

### Cards / Containers

- **Corner style:** 12px (`C.border`) per card operativi; 20px per card glassmorphism nella login.
- **Background:** `C.surface` (layer 1) per card di primo livello; `C.bg` (layer 0) per sfondi interni a card.
- **Border:** `1px solid C.border` (white-alpha in dark, dark-alpha in light). Mai assente su superfici con background simile.
- **Internal padding:** `20px 24px` standard; `14px 18px` per card compatti (liste, row item).

### Inputs / Fields

- **Style:** 10px radius, `1px solid C.border`, background `C.surface` (dark) / `#ffffff` (light).
- **Focus:** `border-color: rgba(6,182,212,0.55)`, `box-shadow: 0 0 0 3px rgba(6,182,212,0.18)` — definito via CSS globale in App.jsx.
- **Label:** Sempre `labelSt` (10px uppercase 600, `C.muted`, `0.1em` letterSpacing) posizionato sopra.
- **Width:** `100%` di default; `auto` con `minWidth` per select filter nei pannelli admin.

### Labels

Campo, categoria, intestazione colonna. **Mai come elemento stand-alone senza un valore sotto.** Il pattern `F({ label, hint, children })` in SettingsView è il componente di riferimento: `<label>` come root per l'associazione implicita.

### Progress Bars

**Sempre `transform: scaleX(ratio)` con `transformOrigin: left`** — mai `width: percentage`. Il parent porta `overflow: hidden` per il clipping. Eliminato ogni uso di `transition: width` per zero layout thrash.

### Tables

Header: 10px uppercase, `C.muted`, `fontWeight 600`. Row: 13px, hover via `onMouseEnter/Leave` su `currentTarget.style.background`. Admin tables: wrapper `<div style={{ overflowX: "auto" }}>` intorno alla `<table>` con `minWidth` esplicito per scroll mobile.

### Modal / Dialog

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` obbligatori.
- Focus trap con `useEffect` sul mount: primo elemento focusable riceve focus; Tab/Shift+Tab rimangono dentro.
- ESC chiude via `keydown` listener.
- Backdrop `C.overlay` (calibrato per tema). Click su backdrop chiude.

### Navigation (Sidebar)

- Background `C.sidebarBg` con `backdropFilter: blur(20px)`.
- Voce attiva: `background: C.accentDim`, `color: C.accent`.
- Voce hover: `rgba(255,255,255,0.05)` dark / `rgba(0,0,0,0.04)` light via CSS globale `.nav-btn:hover`.
- Mobile: sidebar fissa overlay, hamburger in top-left, backdrop semitrasparente.

## 6. Do's and Don'ts

### Do:
- **Do** usare `C.*` token per ogni colore — mai hex/rgba diretto nel JSX.
- **Do** `type="button"` su ogni `<button>` che non è un form submit.
- **Do** `transform: scaleX()` con `transformOrigin: left` per progress bar.
- **Do** `font-variant-numeric: tabular-nums` su ogni numero in tabella o KPI.
- **Do** usare `C.overlay` per tutti gli overlay modali — il token è calibrato per entrambi i temi.
- **Do** `aria-label` o label implicita su ogni `<input>` visibile all'utente.
- **Do** mantenere la gerarchia tonale bg → surface → card — il layer 0 non va mai usato come superficie di contenuto.

### Don't:
- **Don't** usare glassmorphism fuori dalla login page. Il blur è uno strumento, non un'estetica.
- **Don't** usare gradient-text (`background-clip: text`). I titoli usano `C.titleColor` solido.
- **Don't** usare side-stripe border (`border-left > 1px` come accento colorato). Mai.
- **Don't** usare i colori di stato per decorazione: `#22d3ee` significa "aperta", non "bello".
- **Don't** hardcodare rgba bianchi/neri nel JSX. `rgba(255,255,255,0.85)` si rompe in light mode.
- **Don't** animare proprietà layout (`width`, `height`, `margin`). Solo `transform` e `opacity`.
- **Don't** usare card identiche con icon + heading + text in griglia. La dashboard è densa, non un catalogo.
- **Don't** usare il template hero-metric con gradient accent. I KPI portano `tabular-nums` e token semantici, niente gradiente decorativo sopra.
- **Don't** SaaS cream (`#f8f9fa`, bianco puro). Il light mode è azz urro-cielo saturo per dare profondità agli angoli.
- **Don't** animare l'ingresso delle pagine con sequenze orchestrate. L'utente è in un task; non vuole guardare il contenuto comparire.
