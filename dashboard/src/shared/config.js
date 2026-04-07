// ─── Colori ───────────────────────────────────
export const C = {
  // Sfondi — tre livelli distinti per profondità visiva
  bg:           "#06061a",   // main content background (deep navy-black)
  surface:      "#0d0d28",   // sidebar + panel backgrounds
  surfaceHover: "#141440",   // hover su voci sidebar/liste
  card:         "#111132",   // card elevate su surface

  // Bordi — molto più visibili del precedente #1c1c2e
  border:       "#28285e",   // bordo standard
  borderLight:  "#3a3a7a",   // bordo su focus/highlight

  // Accent primario — verde
  accent:       "#00e5a0",
  accentDim:    "#00e5a015",
  accentSoft:   "#00e5a040",

  // Accent secondario — indigo/violet (nuovo)
  indigo:       "#7c6fff",
  indigoDim:    "#7c6fff15",
  indigoSoft:   "#7c6fff40",

  // Testi
  text:         "#eaeaf8",   // leggermente più bianco
  muted:        "#6868a8",   // più cromatico (purple-blue invece di grigio)
  dim:          "#1e1e44",   // divisori interni

  // Status partite
  open:         "#00e5a0",   // verde — aperta
  locked:       "#4a9eff",   // blu — chiusa/completata
  cancelled:    "#ff4a6e",   // rosso — cancellata
  unfilled:     "#ff9a00",   // arancio — non riempita
  warning:      "#ffcc00",   // giallo — warning
  unavail:      "#9b5cf6",   // viola — non disponibile
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
  background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
  padding: "9px 12px", color: C.text, fontSize: 13, fontFamily: "inherit",
  width: "100%", transition: "border-color 0.15s",
};

export const btnPrimary = {
  background: C.accent, color: "#04040f", border: "none", borderRadius: 8,
  padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer",
  fontFamily: "inherit",
};

export const btnSecondary = {
  background: C.indigoDim, color: C.indigo, border: `1px solid ${C.indigoSoft}`,
  borderRadius: 8, padding: "9px 16px", fontSize: 13, fontWeight: 600, cursor: "pointer",
  fontFamily: "inherit",
};

export const btnGhost = {
  background: "transparent", color: C.muted, border: `1px solid ${C.border}`,
  borderRadius: 6, padding: "7px 12px", fontSize: 12, cursor: "pointer",
  fontFamily: "inherit",
};

export const labelSt = {
  display: "block", fontSize: 11, color: C.muted,
  textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6,
};
