// ─── Colori ───────────────────────────────────
export const C = {
  bg: "#07070d",
  surface: "#0f0f18",
  surfaceHover: "#161624",
  border: "#1c1c2e",
  borderLight: "#252538",
  accent: "#00e5a0",
  accentDim: "#00e5a012",
  accentSoft: "#00e5a030",
  text: "#e2e2f0",
  muted: "#5a5a7a",
  dim: "#2a2a42",
  open: "#00e5a0",
  locked: "#4a9eff",
  cancelled: "#ff4a6e",
  unfilled: "#ff9a00",
  warning: "#ffcc00",
  unavail: "#6b3fa0",
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
  background: C.accent, color: C.bg, border: "none", borderRadius: 8,
  padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer",
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
