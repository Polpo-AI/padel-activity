// ─── Theme factory ────────────────────────────────────────────────────────────
// Ritorna { C, inputSt, cardSt, btnPrimary, btnSecondary, btnGhost, labelSt, gradientText }
// in funzione del mode ('dark' | 'light').
// Importare direttamente C/stili è deprecato — usare useTheme() da ThemeContext.jsx.

export function makeTheme(mode = 'dark') {
  const dark = mode === 'dark';

  const C = dark ? {
    // ── Sfondi — navy luminoso (meno cupo, vicino all'hero del sito) ──
    bg:           "#131D40",
    surface:      "#1C2A52",
    surfaceHover: "#25345F",
    card:         "#2E3C6B",

    // ── Bordi — white-alpha ──────────────────────────────
    border:       "rgba(255,255,255,0.10)",
    borderLight:  "rgba(255,255,255,0.16)",
    borderAccent: "rgba(6,182,212,0.30)",

    // ── Accent primario — cyan ───────────────────────────
    accent:       "#22d3ee",
    accentBright: "#67e8f9",
    accentDim:    "rgba(6,182,212,0.10)",
    accentSoft:   "rgba(6,182,212,0.20)",

    // ── Accent secondario — violet ───────────────────────
    indigo:       "#a78bfa",
    indigoDim:    "rgba(139,92,246,0.10)",
    indigoSoft:   "rgba(139,92,246,0.22)",

    // ── Palette brand estesa (allineata al sito Polpo AI) ──
    siteBlue:  "#38bdf8",
    teal:      "#14b8a6",
    emerald:   "#34d399",
    magenta:   "#ff3d8a",
    amber:     "#ffb547",
    rose:      "#fb7185",

    // ── Gradienti & glow firma (dal sito) ─────────────────
    accentGradient: "linear-gradient(135deg, #22d3ee 0%, #06b6d4 45%, #0891b2 100%)",
    brandGradient:  "linear-gradient(120deg, #22d3ee 0%, #38bdf8 32%, #8b5cf6 68%, #ff3d8a 100%)",
    glowCyan:    "0 8px 32px rgba(6,182,212,0.25)",
    glowViolet:  "0 8px 32px rgba(139,92,246,0.22)",
    glowEmerald: "0 8px 32px rgba(16,185,129,0.22)",

    // ── Testi ────────────────────────────────────────────
    text:         "#f8fafc",
    muted:        "#94a3b8",
    dim:          "#0B1228",

    // ── Status ───────────────────────────────────────────
    open:         "#22d3ee",
    locked:       "#3b82f6",
    cancelled:    "#ef4444",
    unfilled:     "#f97316",
    warning:      "#f59e0b",
    unavail:      "#a855f7",

    // ── Extra (tema-specifici) ───────────────────────────
    titleGradient: "linear-gradient(135deg, #f8fafc 0%, #cbd5e1 60%, #94a3b8 100%)", // legacy
    titleColor:    "#f8fafc",
    overlay:       "rgba(0,0,0,0.75)",
    male:          "#3b82f6",
    female:        "#ec4899",
    success:       "#10b981",

    // ── Sidebar ──────────────────────────────────────────
    sidebarBg:     "#17214C",
    sidebarBorder: "rgba(255,255,255,0.08)",
    sidebarSep:    "rgba(255,255,255,0.07)",

    // ── Orbs opacity (aurora — più vivida, come l'hero del sito) ──
    orbCyan:    "rgba(34,211,238,0.26)",
    orbViolet:  "rgba(139,92,246,0.22)",
    orbPink:    "rgba(255,61,138,0.16)",
    orbEmerald: "rgba(16,185,129,0.14)",
  } : {
    // ── Sfondi ──────────────────────────────────────────
    bg:           "#e8f4fd",
    surface:      "#f4faff",
    surfaceHover: "#dbeef8",
    card:         "#edf7ff",

    // ── Bordi — dark-alpha ───────────────────────────────
    border:       "rgba(15,23,42,0.14)",
    borderLight:  "rgba(15,23,42,0.22)",
    borderAccent: "rgba(8,145,178,0.35)",

    // ── Accent primario — cyan-600 (più leggibile su bianco) ──
    accent:       "#0891b2",
    accentBright: "#06b6d4",
    accentDim:    "rgba(8,145,178,0.10)",
    accentSoft:   "rgba(8,145,178,0.18)",

    // ── Accent secondario — violet-700 ───────────────────
    indigo:       "#7c3aed",
    indigoDim:    "rgba(124,58,237,0.08)",
    indigoSoft:   "rgba(124,58,237,0.18)",

    // ── Palette brand estesa (varianti accessibili su fondo chiaro) ──
    siteBlue:  "#0284c7",
    teal:      "#0d9488",
    emerald:   "#059669",
    magenta:   "#db2777",
    amber:     "#d97706",
    rose:      "#e11d48",

    // ── Gradienti & glow firma (dal sito) ─────────────────
    accentGradient: "linear-gradient(135deg, #06b6d4 0%, #0891b2 100%)",
    brandGradient:  "linear-gradient(120deg, #0891b2 0%, #38bdf8 32%, #8b5cf6 68%, #db2777 100%)",
    glowCyan:    "0 6px 24px rgba(8,145,178,0.20)",
    glowViolet:  "0 6px 24px rgba(124,58,237,0.18)",
    glowEmerald: "0 6px 24px rgba(5,150,105,0.18)",

    // ── Testi ────────────────────────────────────────────
    text:         "#0f172a",
    muted:        "#64748b",
    dim:          "#cce7f7",

    // ── Status ───────────────────────────────────────────
    open:         "#0891b2",
    locked:       "#1d4ed8",
    cancelled:    "#dc2626",
    unfilled:     "#ea580c",
    warning:      "#d97706",
    unavail:      "#7c3aed",

    // ── Extra (tema-specifici) ───────────────────────────
    titleGradient: "linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #475569 100%)", // legacy
    titleColor:    "#0f172a",
    overlay:       "rgba(15,23,42,0.40)",
    male:          "#1d4ed8",
    female:        "#be185d",
    success:       "#059669",

    // ── Sidebar ──────────────────────────────────────────
    sidebarBg:     "#ddeef8",
    sidebarBorder: "rgba(15,23,42,0.14)",
    sidebarSep:    "rgba(15,23,42,0.10)",

    // ── Orbs opacity (aurora — più vivi in light per dare profondità) ─
    orbCyan:    "rgba(34,211,238,0.28)",
    orbViolet:  "rgba(139,92,246,0.22)",
    orbPink:    "rgba(255,61,138,0.16)",
    orbEmerald: "rgba(16,185,129,0.16)",
  };

  // ── Stili derivati ──────────────────────────────────────────────────────────

  const inputSt = {
    background:  dark ? "rgba(28,42,82,0.85)" : "#ffffff",
    border:      `1px solid ${C.border}`,
    borderRadius: 10,
    padding:     "10px 14px",
    color:        C.text,
    fontSize:     13,
    fontFamily:  "inherit",
    width:       "100%",
    transition:  "border-color 0.2s, box-shadow 0.2s",
  };

  const btnPrimary = {
    background:     "linear-gradient(135deg, #22d3ee 0%, #06b6d4 40%, #0891b2 70%, #22d3ee 100%)",
    backgroundSize: "200% 200%",
    color:          "#030d16",
    border:         "none",
    borderRadius:    10,
    padding:        "10px 20px",
    fontSize:        13,
    fontWeight:      700,
    cursor:         "pointer",
    fontFamily:     "inherit",
    transition:     "transform 0.20s cubic-bezier(0.23,1,0.32,1), box-shadow 0.20s",
    letterSpacing:  "0.01em",
    boxShadow:      dark
      ? "0 8px 32px rgba(6,182,212,0.30), 0 2px 14px rgba(139,92,246,0.12), inset 0 1px 0 rgba(255,255,255,0.18)"
      : "0 4px 20px rgba(8,145,178,0.30), inset 0 1px 0 rgba(255,255,255,0.25)",
  };

  const btnSecondary = {
    background:     dark ? "rgba(139,92,246,0.08)" : "rgba(124,58,237,0.07)",
    color:           C.indigo,
    border:         `1px solid ${C.indigoSoft}`,
    borderRadius:    10,
    padding:        "9px 18px",
    fontSize:        13,
    fontWeight:      600,
    cursor:         "pointer",
    fontFamily:     "inherit",
    transition:     "opacity 0.15s, box-shadow 0.15s",
    backdropFilter: "blur(10px)",
  };

  const btnGhost = {
    background:  "transparent",
    color:        C.muted,
    border:      `1px solid ${C.border}`,
    borderRadius: 8,
    padding:     "7px 14px",
    fontSize:     12,
    cursor:      "pointer",
    fontFamily:  "inherit",
    transition:  "border-color 0.15s, color 0.15s",
  };

  const cardSt = dark ? {
    background:     "rgba(28,42,82,0.62)",
    backdropFilter: "blur(16px) saturate(1.5)",
    border:         "1px solid rgba(255,255,255,0.10)",
    borderRadius:    20,
    padding:        "20px 22px",
    boxShadow:      "0 4px 24px rgba(0,0,0,0.35), 0 0 24px rgba(34,211,238,0.05), inset 0 1px 0 rgba(255,255,255,0.07)",
  } : {
    background:     "rgba(244,250,255,0.90)",
    backdropFilter: "blur(12px)",
    border:         `1px solid ${C.border}`,
    borderRadius:    20,
    padding:        "20px 22px",
    boxShadow:      "0 4px 24px rgba(8,145,178,0.12), inset 0 1px 0 rgba(255,255,255,0.90)",
  };

  const labelSt = {
    display:       "block",
    fontSize:       10,
    color:          C.muted,
    textTransform: "uppercase",
    letterSpacing: "0.1em",
    marginBottom:   7,
    fontWeight:     600,
  };

  const gradientText = {
    color: C.accent,
  };

  return { C, inputSt, btnPrimary, btnSecondary, btnGhost, cardSt, labelSt, gradientText };
}

// ─── STATUS map (invariato, non dipende dal tema) ─────────────────────────────
// Nota: STATUS usa valori string, non C.* — è safe come costante.
export const STATUS = {
  OPEN:      { color: "#22d3ee", label: "Aperta" },
  LOCKED:    { color: "#3b82f6", label: "Chiusa" },
  CANCELLED: { color: "#ef4444", label: "Cancellata" },
  UNFILLED:  { color: "#f97316", label: "Non riempita" },
};

// ─── API ──────────────────────────────────────────────────────────────────────
const API = "/api/dashboard";

export const api = async (path, token, opts = {}) => {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  // Risposta non-JSON (proxy 502, HTML di errore): non far esplodere r.json()
  let d;
  try { d = await r.json(); } catch { d = {}; }
  // 401 = token scaduto/invalido → pulisci la sessione e torna al login
  if (r.status === 401) {
    try { sessionStorage.removeItem("dash_token"); sessionStorage.removeItem("dash_club"); } catch {}
    window.location.reload();
    throw new Error(d.error || "Sessione scaduta");
  }
  if (!r.ok) throw new Error(d.error || `Errore ${r.status}`);
  return d;
};

// ─── Utils ────────────────────────────────────────────────────────────────────
const fmt = (d, opts) => new Date(d).toLocaleString("it-IT", opts);
export const fmtTime = d => fmt(d, { hour: "2-digit", minute: "2-digit" });
export const fmtDate = d => fmt(d, { weekday: "short", day: "numeric", month: "short" });
export const today = () => new Date().toISOString().split("T")[0];
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Legacy export (compatibilità durante migrazione) ─────────────────────────
// Componenti non ancora migrati possono ancora importare C dal dark theme.
// Rimuovere dopo aver migrato tutti i file.
const _dark = makeTheme('dark');
export const C         = _dark.C;
export const inputSt   = _dark.inputSt;
export const btnPrimary   = _dark.btnPrimary;
export const btnSecondary = _dark.btnSecondary;
export const btnGhost     = _dark.btnGhost;
export const cardSt    = _dark.cardSt;
export const labelSt   = _dark.labelSt;
export const gradientText = _dark.gradientText;
