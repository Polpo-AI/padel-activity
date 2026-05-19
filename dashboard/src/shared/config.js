// ─── Colori ─────────────────────────────────────────────────────────────────
// Token esatti da github.com/Polpo-AI/stunning-broccoli (globals.css)
export const C = {
  // Sfondi — --bg-base / --bg-surface / --bg-raised / --bg-elevated
  bg:           "#0B1228",   // --bg-base
  surface:      "#0F1730",   // --bg-surface (sidebar + panel)
  surfaceHover: "#131C3D",   // --bg-raised (hover)
  card:         "#1A234A",   // --bg-elevated (card elevate)

  // Bordi — white-alpha (glass effect corretto del repo)
  border:       "rgba(255,255,255,0.10)",   // --border-default
  borderLight:  "rgba(255,255,255,0.16)",   // --border-strong
  borderAccent: "rgba(6,182,212,0.30)",     // --border-accent (cyan)

  // Accent primario — cyan  --cyan-400 / --cyan-500 / --cyan-600
  accent:       "#22d3ee",                  // --cyan-400
  accentDim:    "rgba(6,182,212,0.10)",     // cyan dim bg
  accentSoft:   "rgba(6,182,212,0.20)",     // cyan soft bg

  // Accent secondario — violet  --agenti-violet / --agenti-violet-2
  indigo:       "#a78bfa",                  // --agenti-violet-2
  indigoDim:    "rgba(139,92,246,0.10)",    // --shadow-violet base
  indigoSoft:   "rgba(139,92,246,0.22)",

  // Testi — --text-primary / --text-muted / --text-faint
  text:         "#f8fafc",   // --text-primary
  muted:        "#94a3b8",   // --text-muted (slate-400)
  dim:          "#0B1228",   // --bg-base (sfondo puro per ombre)

  // Status partite
  open:         "#22d3ee",   // cyan
  locked:       "#3b82f6",   // blue
  cancelled:    "#ef4444",   // --danger
  unfilled:     "#f97316",   // orange
  warning:      "#f59e0b",   // --warning
  unavail:      "#a855f7",   // violet
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
  background: "rgba(15,23,48,0.8)",
  border: "1px solid rgba(255,255,255,0.10)",
  borderRadius: 10,                              // --radius-sm
  padding: "10px 14px",
  color: C.text,
  fontSize: 13,
  fontFamily: "inherit",
  width: "100%",
  transition: "border-color 0.2s, box-shadow 0.2s",
};

// .btn-primary da globals.css — gradient cyan con background-size 200% per animation
export const btnPrimary = {
  background: "linear-gradient(135deg, #22d3ee 0%, #06b6d4 40%, #0891b2 70%, #22d3ee 100%)",
  backgroundSize: "200% 200%",
  color: "#030d16",
  border: "none",
  borderRadius: 10,
  padding: "10px 20px",
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  fontFamily: "inherit",
  transition: "transform 0.20s cubic-bezier(0.23,1,0.32,1), box-shadow 0.20s",
  letterSpacing: "0.01em",
  boxShadow: "0 8px 32px rgba(6,182,212,0.28), inset 0 1px 0 rgba(255,255,255,0.18)",
};

// .btn-outline — glass violet, --agenti-violet
export const btnSecondary = {
  background: "rgba(139,92,246,0.08)",
  color: C.indigo,
  border: "1px solid rgba(139,92,246,0.22)",
  borderRadius: 10,
  padding: "9px 18px",
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
  fontFamily: "inherit",
  transition: "opacity 0.15s, box-shadow 0.15s",
  backdropFilter: "blur(10px)",
};

export const btnGhost = {
  background: "transparent",
  color: C.muted,
  border: "1px solid rgba(255,255,255,0.10)",
  borderRadius: 8,
  padding: "7px 14px",
  fontSize: 12,
  cursor: "pointer",
  fontFamily: "inherit",
  transition: "border-color 0.15s, color 0.15s",
};

// .glass-card da globals.css — con highlight top
export const cardSt = {
  background: "rgba(15,23,48,0.60)",
  backdropFilter: "blur(16px) saturate(1.5)",
  border: "1px solid rgba(255,255,255,0.10)",
  borderRadius: 20,
  padding: "20px 22px",
  boxShadow: "0 4px 24px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.07)",
};

// Gradient text utility (inline style alternativo alla classe CSS)
export const gradientText = {
  background: "linear-gradient(135deg, #22d3ee 0%, #06b6d4 50%, #a78bfa 100%)",
  WebkitBackgroundClip: "text",
  WebkitTextFillColor: "transparent",
  backgroundClip: "text",
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
