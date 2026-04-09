// ─── Colori ───────────────────────────────────
export const C = {
  // Sfondi — neutral puri, lifted ~20pt rispetto al nero piatto
  bg:           "#141414",   // main content background
  surface:      "#1c1c1c",   // sidebar + panel backgrounds
  surfaceHover: "#242424",   // hover su voci sidebar/liste
  card:         "#222222",   // card elevate su surface

  // Bordi — più visibili per gerarchia chiara
  border:       "#303030",   // bordo standard
  borderLight:  "#404040",   // bordo su focus/highlight

  // Accent primario — lime elettrico (sportswear energy)
  accent:       "#c8ff00",
  accentDim:    "#c8ff0010",
  accentSoft:   "#c8ff0030",

  // Accent secondario — violet
  indigo:       "#a78bfa",
  indigoDim:    "#a78bfa15",
  indigoSoft:   "#a78bfa35",

  // Testi
  text:         "#f0f0f0",
  muted:        "#909090",   // era #737373 — testi secondari più leggibili
  dim:          "#2a2a2a",

  // Status partite
  open:         "#c8ff00",
  locked:       "#3b82f6",
  cancelled:    "#ef4444",
  unfilled:     "#f97316",
  warning:      "#f59e0b",
  unavail:      "#a855f7",
};

export const STATUS = {
  OPEN:      { color: C.open,      label: "Aperta" },
  LOCKED:    { color: C.locked,    label: "Chiusa" },
  CANCELLED: { color: C.cancelled, label: "Cancellata" },
  UNFILLED:  { color: C.unfilled,  label: "Non riempita" },
};

// ─── API ──────────────────────────────────────
const API = "/api/dashboard";

export const api = async (path, token, opts = {}) => {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Errore");
  return d;
};

// ─── Utils ────────────────────────────────────
const fmt = (d, opts) => new Date(d).toLocaleString("it-IT", opts);
export const fmtTime = d => fmt(d, { hour: "2-digit", minute: "2-digit" });
export const fmtDate = d => fmt(d, { weekday: "short", day: "numeric", month: "short" });
export const today = () => new Date().toISOString().split("T")[0];
export const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Stili condivisi ──────────────────────────
export const inputSt = {
  background: C.card, border: `1px solid ${C.border}`, borderRadius: 10,
  padding: "10px 14px", color: C.text, fontSize: 13, fontFamily: "inherit",
  width: "100%", transition: "border-color 0.15s, box-shadow 0.15s",
};

export const btnPrimary = {
  background: C.accent, color: "#050505", border: "none", borderRadius: 10,
  padding: "10px 20px", fontSize: 13, fontWeight: 700, cursor: "pointer",
  fontFamily: "inherit", transition: "opacity 0.15s, transform 0.1s",
  letterSpacing: "0.01em",
};

export const btnSecondary = {
  background: C.indigoDim, color: C.indigo, border: `1px solid ${C.indigoSoft}`,
  borderRadius: 10, padding: "9px 18px", fontSize: 13, fontWeight: 600, cursor: "pointer",
  fontFamily: "inherit", transition: "opacity 0.15s",
};

export const btnGhost = {
  background: "transparent", color: C.muted, border: `1px solid ${C.border}`,
  borderRadius: 8, padding: "7px 14px", fontSize: 12, cursor: "pointer",
  fontFamily: "inherit", transition: "border-color 0.15s, color 0.15s",
};

export const cardSt = {
  background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14,
  padding: "20px 22px", boxShadow: "0 1px 3px rgba(0,0,0,0.4), 0 4px 16px rgba(0,0,0,0.2)",
};

export const labelSt = {
  display: "block", fontSize: 10, color: C.muted,
  textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 7, fontWeight: 600,
};
