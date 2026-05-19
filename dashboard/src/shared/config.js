// ─── Colori ───────────────────────────────────
export const C = {
  // Sfondi — deep navy (Polpo AI stunning-broccoli)
  bg:           "#07091a",                      // navy-black main bg
  surface:      "#0d1428",                      // sidebar + panel
  surfaceHover: "#131d38",                      // hover
  card:         "#0f1932",                      // card elevate su surface

  // Bordi — cyan sottilissimo
  border:       "rgba(34,211,238,0.12)",         // bordo standard
  borderLight:  "rgba(34,211,238,0.28)",         // focus/highlight

  // Accent primario — cyan (Polpo AI primary)
  accent:       "#22d3ee",
  accentDim:    "rgba(34,211,238,0.08)",
  accentSoft:   "rgba(34,211,238,0.16)",

  // Accent secondario — violet
  indigo:       "#a78bfa",
  indigoDim:    "rgba(167,139,250,0.08)",
  indigoSoft:   "rgba(167,139,250,0.18)",

  // Testi
  text:         "#e8f4f8",                      // quasi-bianco con tinta blu
  muted:        "#6b8ca8",                      // blu-grigio secondario
  dim:          "#060818",

  // Status partite
  open:         "#22d3ee",
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
  background: C.card,
  border: `1px solid ${C.border}`,
  borderRadius: 10,
  padding: "10px 14px",
  color: C.text,
  fontSize: 13,
  fontFamily: "inherit",
  width: "100%",
  transition: "border-color 0.15s, box-shadow 0.15s",
};

export const btnPrimary = {
  background: "linear-gradient(135deg, #38bdf8 0%, #06b6d4 60%, #0891b2 100%)",
  color: "#030d16",
  border: "none",
  borderRadius: 10,
  padding: "10px 20px",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: "inherit",
  transition: "opacity 0.18s, transform 0.12s, box-shadow 0.18s",
  letterSpacing: "0.01em",
  boxShadow: "0 4px 20px rgba(34,211,238,0.25)",
};

export const btnSecondary = {
  background: C.indigoDim,
  color: C.indigo,
  border: `1px solid ${C.indigoSoft}`,
  borderRadius: 10,
  padding: "9px 18px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
  transition: "opacity 0.15s",
  backdropFilter: "blur(10px)",
};

export const btnGhost = {
  background: "transparent",
  color: C.muted,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: "7px 14px",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
  transition: "border-color 0.15s, color 0.15s",
};

export const cardSt = {
  background: "rgba(13,20,40,0.7)",
  backdropFilter: "blur(20px) saturate(1.4)",
  border: "1px solid rgba(34,211,238,0.12)",
  borderRadius: 16,
  padding: "20px 22px",
  boxShadow: "0 4px 24px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.04)",
};

export const labelSt = {
  display: "block",
  fontSize: 10,
  color: C.muted,
  textTransform: "uppercase",
  letterSpacing: "0.1em",
  marginBottom: 7,
  fontWeight: 600,
};
