import { useState, useEffect, useCallback, useRef } from "react";

const API_BASE = "/api/dashboard";

// ─────────────────────────────────────────────
// THEME
// ─────────────────────────────────────────────

const theme = {
  bg: "#0a0a0f",
  surface: "#12121a",
  surfaceHover: "#1a1a26",
  border: "#1e1e2e",
  borderLight: "#2a2a3e",
  accent: "#00e5a0",
  accentDim: "#00e5a015",
  accentHover: "#00ffb3",
  text: "#e8e8f0",
  textMuted: "#6b6b8a",
  textDim: "#3a3a5c",
  open: "#00e5a0",
  locked: "#4a9eff",
  cancelled: "#ff4a6e",
  unfilled: "#ff9a00",
  pending: "#ffd700",
};

const STATUS_META: Record<string, { color: string; label: string; dot: string }> = {
  OPEN:      { color: theme.open,      label: "Aperta",     dot: "●" },
  LOCKED:    { color: theme.locked,    label: "Chiusa",     dot: "●" },
  CANCELLED: { color: theme.cancelled, label: "Cancellata", dot: "●" },
  UNFILLED:  { color: theme.unfilled,  label: "Non riempita", dot: "●" },
};

// ─────────────────────────────────────────────
// API HELPERS
// ─────────────────────────────────────────────

async function apiFetch(path: string, token: string, opts: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Errore di rete" }));
    throw new Error(err.error || "Errore sconosciuto");
  }
  return res.json();
}

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────

function formatTime(d: string) {
  return new Date(d).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
}
function formatDate(d: string) {
  return new Date(d).toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" });
}
function today() {
  return new Date().toISOString().split("T")[0];
}

// ─────────────────────────────────────────────
// COMPONENTS
// ─────────────────────────────────────────────

function Spinner() {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, color: theme.textMuted }}>
      <div style={{
        width: 16, height: 16, border: `2px solid ${theme.border}`,
        borderTopColor: theme.accent, borderRadius: "50%",
        animation: "spin 0.8s linear infinite",
      }} />
      <span style={{ fontSize: 13 }}>Caricamento...</span>
    </div>
  );
}

function Badge({ status }: { status: string }) {
  const meta = STATUS_META[status] || { color: theme.textMuted, label: status, dot: "●" };
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 5,
      fontSize: 11, fontWeight: 600, letterSpacing: "0.05em",
      padding: "3px 8px", borderRadius: 20,
      background: `${meta.color}15`, color: meta.color,
      border: `1px solid ${meta.color}30`,
    }}>
      <span style={{ fontSize: 8 }}>{meta.dot}</span>
      {meta.label.toUpperCase()}
    </span>
  );
}

function Pill({ count, label, color }: { count: number; label: string; color: string }) {
  return (
    <span style={{
      fontSize: 11, color, background: `${color}15`,
      padding: "2px 7px", borderRadius: 10, border: `1px solid ${color}25`,
    }}>
      {count} {label}
    </span>
  );
}

function StatCard({ label, value, sub, accent }: { label: string; value: string | number; sub?: string; accent?: string }) {
  return (
    <div style={{
      background: theme.surface, border: `1px solid ${theme.border}`,
      borderRadius: 12, padding: "20px 24px",
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      <span style={{ fontSize: 11, color: theme.textMuted, textTransform: "uppercase", letterSpacing: "0.1em" }}>{label}</span>
      <span style={{ fontSize: 28, fontWeight: 700, color: accent || theme.text, fontVariantNumeric: "tabular-nums" }}>{value}</span>
      {sub && <span style={{ fontSize: 12, color: theme.textMuted }}>{sub}</span>}
    </div>
  );
}

// ─────────────────────────────────────────────
// LOGIN PAGE
// ─────────────────────────────────────────────

function LoginPage({ onLogin }: { onLogin: (token: string, club: any) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async () => {
    if (!username || !password) return;
    setLoading(true); setError("");
    try {
      const data = await fetch(`${API_BASE}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      }).then(r => r.json());
      if (data.error) throw new Error(data.error);
      onLogin(data.token, data.club);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      minHeight: "100vh", background: theme.bg, display: "flex",
      alignItems: "center", justifyContent: "center",
      fontFamily: "'DM Mono', 'Fira Code', monospace",
    }}>
      <div style={{
        width: 380, background: theme.surface,
        border: `1px solid ${theme.border}`, borderRadius: 16,
        padding: 40, display: "flex", flexDirection: "column", gap: 24,
      }}>
        {/* Logo */}
        <div style={{ textAlign: "center" }}>
          <div style={{
            width: 56, height: 56, borderRadius: 16, margin: "0 auto 16px",
            background: theme.accentDim, border: `1px solid ${theme.accent}30`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 28,
          }}>🎾</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: theme.text }}>Padel Dashboard</div>
          <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 4 }}>Accesso riservato</div>
        </div>

        {/* Form */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <input
            value={username} onChange={e => setUsername(e.target.value)}
            placeholder="Username"
            style={inputStyle}
            onKeyDown={e => e.key === "Enter" && handleSubmit()}
          />
          <input
            type="password" value={password} onChange={e => setPassword(e.target.value)}
            placeholder="Password"
            style={inputStyle}
            onKeyDown={e => e.key === "Enter" && handleSubmit()}
          />
          {error && <div style={{ fontSize: 12, color: theme.cancelled, textAlign: "center" }}>{error}</div>}
          <button onClick={handleSubmit} disabled={loading} style={btnPrimary}>
            {loading ? "Accesso in corso..." : "Accedi →"}
          </button>
        </div>
      </div>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─────────────────────────────────────────────
// MATCH CARD
// ─────────────────────────────────────────────

function MatchCard({ match, onCancel }: { match: any; onCancel: (id: string) => void }) {
  const confirmed = match.MatchPlayer?.filter((mp: any) => !mp.leftAt) || [];
  const pending = match.invitations?.length || 0;
  const spotsLeft = match.playersNeeded - confirmed.length;

  return (
    <div style={{
      background: theme.surface, border: `1px solid ${theme.border}`,
      borderRadius: 10, padding: "14px 16px",
      display: "flex", flexDirection: "column", gap: 10,
      transition: "border-color 0.15s",
    }}
      onMouseEnter={e => (e.currentTarget.style.borderColor = theme.borderLight)}
      onMouseLeave={e => (e.currentTarget.style.borderColor = theme.border)}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 600, color: theme.text }}>{formatTime(match.startTime)}</div>
          <div style={{ fontSize: 12, color: theme.textMuted, marginTop: 2 }}>
            Liv. {match.skillLevel} · {match.playersNeeded}v{match.playersNeeded}
          </div>
        </div>
        <Badge status={match.status} />
      </div>

      {/* Progress bar */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: theme.textMuted }}>
            {confirmed.length}/{match.playersNeeded} giocatori
          </span>
          {pending > 0 && <Pill count={pending} label="in attesa" color={theme.pending} />}
        </div>
        <div style={{ height: 4, background: theme.border, borderRadius: 2, overflow: "hidden" }}>
          <div style={{
            height: "100%", borderRadius: 2, transition: "width 0.3s",
            width: `${(confirmed.length / match.playersNeeded) * 100}%`,
            background: match.status === "LOCKED" ? theme.locked :
              confirmed.length > 0 ? theme.accent : theme.textDim,
          }} />
        </div>
      </div>

      {/* Players */}
      {confirmed.length > 0 && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
          {confirmed.map((mp: any) => (
            <span key={mp.id} style={{
              fontSize: 10, background: theme.border, color: theme.textMuted,
              padding: "2px 6px", borderRadius: 4,
            }}>
              {mp.player?.name || mp.player?.phoneNumber?.slice(-4)}
            </span>
          ))}
          {spotsLeft > 0 && Array.from({ length: spotsLeft }).map((_, i) => (
            <span key={i} style={{
              fontSize: 10, background: "transparent", color: theme.textDim,
              padding: "2px 6px", borderRadius: 4, border: `1px dashed ${theme.textDim}`,
            }}>—</span>
          ))}
        </div>
      )}

      {/* Actions */}
      {match.status === "OPEN" && (
        <button
          onClick={() => onCancel(match.id)}
          style={{
            ...btnSmall, background: "transparent",
            color: theme.cancelled, border: `1px solid ${theme.cancelled}30`,
          }}
        >
          Cancella partita
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// CREATE MATCH MODAL
// ─────────────────────────────────────────────

function CreateMatchModal({ courts, club, onClose, onCreated, token }: any) {
  const [courtId, setCourtId] = useState(courts[0]?.id || "");
  const [date, setDate] = useState(today());
  const [time, setTime] = useState("18:00");
  const [skillLevel, setSkillLevel] = useState(Math.ceil((club?.skillLevelCount || 3) / 2));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleCreate = async () => {
    if (!courtId || !date || !time) return;
    setLoading(true); setError("");
    try {
      const startTime = new Date(`${date}T${time}:00`).toISOString();
      const data = await apiFetch("/matches", token, {
        method: "POST",
        body: JSON.stringify({ courtId, startTime, skillLevel }),
      });
      onCreated(data);
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: theme.surface, border: `1px solid ${theme.border}`,
        borderRadius: 16, padding: 32, width: 400,
        display: "flex", flexDirection: "column", gap: 20,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: theme.text }}>Nuova partita</div>
          <button onClick={onClose} style={{ ...btnSmall, color: theme.textMuted, border: "none", background: "none" }}>✕</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div>
            <label style={labelStyle}>Campo</label>
            <select value={courtId} onChange={e => setCourtId(e.target.value)} style={inputStyle}>
              {courts.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={labelStyle}>Data</label>
              <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
            </div>
            <div>
              <label style={labelStyle}>Ora</label>
              <input type="time" value={time} onChange={e => setTime(e.target.value)} style={inputStyle} />
            </div>
          </div>
          <div>
            <label style={labelStyle}>Livello (1–{club?.skillLevelCount || 3})</label>
            <input
              type="range" min={1} max={club?.skillLevelCount || 3}
              value={skillLevel} onChange={e => setSkillLevel(parseInt(e.target.value))}
              style={{ width: "100%", accentColor: theme.accent }}
            />
            <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
              {Array.from({ length: club?.skillLevelCount || 3 }, (_, i) => (
                <span key={i} style={{ fontSize: 11, color: i + 1 === skillLevel ? theme.accent : theme.textMuted }}>
                  {i + 1}
                </span>
              ))}
            </div>
          </div>
        </div>

        {error && <div style={{ fontSize: 12, color: theme.cancelled }}>{error}</div>}

        <div style={{ display: "flex", gap: 10 }}>
          <button onClick={onClose} style={{ ...btnSmall, flex: 1, padding: "10px 0" }}>Annulla</button>
          <button onClick={handleCreate} disabled={loading} style={{ ...btnPrimary, flex: 2 }}>
            {loading ? "Creazione..." : "Crea e lancia wave →"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// TOGGLE PLAYER PANEL
// ─────────────────────────────────────────────

function TogglePlayerPanel({ token }: { token: string }) {
  const [phone, setPhone] = useState("");
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleToggle = async () => {
    if (!phone.trim()) return;
    setLoading(true); setError(""); setResult(null);
    try {
      const data = await apiFetch("/players/toggle", token, {
        method: "POST",
        body: JSON.stringify({ phoneNumber: phone.trim() }),
      });
      setResult(data);
      setPhone("");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{
      background: theme.surface, border: `1px solid ${theme.border}`,
      borderRadius: 12, padding: 24, display: "flex", flexDirection: "column", gap: 16,
    }}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: theme.text, marginBottom: 4 }}>
          Attiva / Disattiva giocatore
        </div>
        <div style={{ fontSize: 12, color: theme.textMuted }}>
          Inserisci il numero per attivare o disattivare i messaggi
        </div>
      </div>

      <div style={{ display: "flex", gap: 10 }}>
        <input
          value={phone}
          onChange={e => setPhone(e.target.value)}
          placeholder="+393471234567"
          style={{ ...inputStyle, flex: 1 }}
          onKeyDown={e => e.key === "Enter" && handleToggle()}
        />
        <button onClick={handleToggle} disabled={loading || !phone.trim()} style={btnPrimary}>
          {loading ? "..." : "Toggle"}
        </button>
      </div>

      {error && (
        <div style={{
          fontSize: 12, color: theme.cancelled,
          background: `${theme.cancelled}10`, border: `1px solid ${theme.cancelled}20`,
          padding: "8px 12px", borderRadius: 8,
        }}>
          ⚠ {error}
        </div>
      )}

      {result && (
        <div style={{
          fontSize: 13,
          color: result.active ? theme.accent : theme.textMuted,
          background: result.active ? `${theme.accent}10` : `${theme.textMuted}10`,
          border: `1px solid ${result.active ? theme.accent : theme.textMuted}20`,
          padding: "10px 14px", borderRadius: 8,
          display: "flex", alignItems: "center", gap: 8,
        }}>
          <span style={{ fontSize: 16 }}>{result.active ? "✅" : "🚫"}</span>
          {result.message}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// COURTS VIEW — griglia campi
// ─────────────────────────────────────────────

function CourtsView({ token, courts, onMatchCreated }: any) {
  const [courtData, setCourtData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState(today());
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [club, setClub] = useState<any>(null);

  const load = useCallback(async () => {
    try {
      const [data, clubData] = await Promise.all([
        apiFetch(`/courts?date=${selectedDate}`, token),
        apiFetch("/club", token),
      ]);
      setCourtData(data);
      setClub(clubData);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [token, selectedDate]);

  useEffect(() => { load(); }, [load]);

  // Polling ogni 15s per aggiornamenti real-time
  useEffect(() => {
    const interval = setInterval(load, 15000);
    return () => clearInterval(interval);
  }, [load]);

  const handleCancel = async (matchId: string) => {
    if (!confirm("Sicuro di voler cancellare questa partita?")) return;
    try {
      await apiFetch(`/matches/${matchId}/cancel`, token, { method: "POST" });
      load();
    } catch (e: any) {
      alert(e.message);
    }
  };

  if (loading) return <div style={{ padding: 40 }}><Spinner /></div>;

  // Stats del giorno
  const allMatches = courtData.flatMap(c => c.matches || []);
  const openCount = allMatches.filter(m => m.status === "OPEN").length;
  const lockedCount = allMatches.filter(m => m.status === "LOCKED").length;
  const totalPlayers = allMatches
    .filter(m => m.status === "LOCKED")
    .reduce((sum, m) => sum + (m.MatchPlayer?.filter((mp: any) => !mp.leftAt).length || 0), 0);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <input
            type="date" value={selectedDate}
            onChange={e => setSelectedDate(e.target.value)}
            style={{ ...inputStyle, width: "auto" }}
          />
          <span style={{ fontSize: 12, color: theme.textMuted }}>
            Aggiornato automaticamente ogni 15s
          </span>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          style={btnPrimary}
        >
          + Nuova partita
        </button>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        <StatCard label="Partite aperte" value={openCount} accent={theme.open} />
        <StatCard label="Partite chiuse" value={lockedCount} accent={theme.locked} />
        <StatCard label="Giocatori confermati" value={totalPlayers} sub="oggi" accent={theme.accent} />
      </div>

      {/* Griglia campi */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(courtData.length, 3)}, 1fr)`, gap: 16 }}>
        {courtData.map(court => (
          <div key={court.id} style={{
            background: theme.surface, border: `1px solid ${theme.border}`,
            borderRadius: 12, overflow: "hidden",
          }}>
            {/* Header campo */}
            <div style={{
              padding: "14px 16px",
              borderBottom: `1px solid ${theme.border}`,
              display: "flex", justifyContent: "space-between", alignItems: "center",
              background: theme.accentDim,
            }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: theme.accent }}>
                {court.name}
              </div>
              <div style={{ fontSize: 11, color: theme.textMuted }}>
                {court.matches?.length || 0} partite
              </div>
            </div>

            {/* Lista partite */}
            <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
              {court.matches?.length === 0 && (
                <div style={{ textAlign: "center", padding: "20px 0", color: theme.textDim, fontSize: 12 }}>
                  Nessuna partita oggi
                </div>
              )}
              {court.matches?.map((match: any) => (
                <MatchCard key={match.id} match={match} onCancel={handleCancel} />
              ))}
            </div>
          </div>
        ))}
      </div>

      {showCreateModal && (
        <CreateMatchModal
          courts={courtData}
          club={club}
          token={token}
          onClose={() => setShowCreateModal(false)}
          onCreated={() => { load(); onMatchCreated?.(); }}
        />
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// PLAYERS VIEW
// ─────────────────────────────────────────────

function PlayersView({ token }: { token: string }) {
  const [players, setPlayers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterActive, setFilterActive] = useState<"all" | "active" | "inactive">("all");

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (search) params.set("search", search);
      if (filterActive !== "all") params.set("active", filterActive === "active" ? "true" : "false");
      const data = await apiFetch(`/players?${params}`, token);
      setPlayers(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [token, search, filterActive]);

  useEffect(() => {
    const t = setTimeout(load, 300);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Toggle panel */}
      <TogglePlayerPanel token={token} />

      {/* Filters */}
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <input
          value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Cerca per nome o numero..."
          style={{ ...inputStyle, flex: 1 }}
        />
        {(["all", "active", "inactive"] as const).map(f => (
          <button key={f} onClick={() => setFilterActive(f)} style={{
            ...btnSmall,
            background: filterActive === f ? theme.accentDim : "transparent",
            color: filterActive === f ? theme.accent : theme.textMuted,
            border: `1px solid ${filterActive === f ? theme.accent + "40" : theme.border}`,
          }}>
            {f === "all" ? "Tutti" : f === "active" ? "✅ Attivi" : "🚫 Disattivati"}
          </button>
        ))}
      </div>

      {/* Table */}
      {loading ? <Spinner /> : (
        <div style={{
          background: theme.surface, border: `1px solid ${theme.border}`,
          borderRadius: 12, overflow: "hidden",
        }}>
          {/* Header */}
          <div style={{
            display: "grid", gridTemplateColumns: "2fr 1.5fr 0.8fr 1fr 0.8fr",
            padding: "10px 16px", borderBottom: `1px solid ${theme.border}`,
            fontSize: 10, color: theme.textMuted, textTransform: "uppercase", letterSpacing: "0.1em",
          }}>
            <span>Nome</span>
            <span>Telefono</span>
            <span>Livello</span>
            <span>Score</span>
            <span>Stato</span>
          </div>

          {players.length === 0 && (
            <div style={{ padding: 32, textAlign: "center", color: theme.textMuted, fontSize: 13 }}>
              Nessun giocatore trovato
            </div>
          )}

          {players.map((p, i) => (
            <div key={p.id} style={{
              display: "grid", gridTemplateColumns: "2fr 1.5fr 0.8fr 1fr 0.8fr",
              padding: "12px 16px",
              borderBottom: i < players.length - 1 ? `1px solid ${theme.border}` : "none",
              fontSize: 13, color: theme.text, alignItems: "center",
              background: !p.active ? `${theme.cancelled}05` : "transparent",
            }}>
              <span style={{ color: p.active ? theme.text : theme.textMuted }}>
                {p.name || <span style={{ color: theme.textDim }}>—</span>}
              </span>
              <span style={{ color: theme.textMuted, fontFamily: "monospace", fontSize: 12 }}>
                {p.phoneNumber}
              </span>
              <span style={{
                display: "inline-flex", alignItems: "center", justifyContent: "center",
                width: 24, height: 24, borderRadius: 6,
                background: theme.accentDim, color: theme.accent,
                fontSize: 12, fontWeight: 700,
              }}>
                {p.skillLevel}
              </span>
              <span style={{
                color: p.reliabilityScore < 0 ? theme.cancelled :
                  p.reliabilityScore > 3 ? theme.accent : theme.textMuted,
                fontVariantNumeric: "tabular-nums",
              }}>
                {p.reliabilityScore > 0 ? "+" : ""}{p.reliabilityScore.toFixed(1)}
              </span>
              <span style={{ fontSize: 11 }}>
                {p.active
                  ? <span style={{ color: theme.open }}>● attivo</span>
                  : <span style={{ color: theme.cancelled }}>● disattivato</span>
                }
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// MAIN DASHBOARD
// ─────────────────────────────────────────────

export default function PadelDashboard() {
  const [token, setToken] = useState<string | null>(null);
  const [club, setClub] = useState<any>(null);
  const [activeTab, setActiveTab] = useState<"courts" | "players">("courts");
  const [courts, setCourts] = useState<any[]>([]);

  const handleLogin = async (t: string, c: any) => {
    setToken(t);
    setClub(c);
    // Carica i campi
    try {
      const data = await apiFetch("/courts", t);
      setCourts(data);
    } catch {}
  };

  if (!token) return <LoginPage onLogin={handleLogin} />;

  return (
    <div style={{
      minHeight: "100vh", background: theme.bg,
      fontFamily: "'DM Mono', 'Fira Code', 'Courier New', monospace",
      color: theme.text,
    }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes spin { to { transform: rotate(360deg); } }
        input:focus, select:focus { outline: none; border-color: ${theme.accent}60 !important; }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        ::-webkit-scrollbar { width: 6px; }
        ::-webkit-scrollbar-track { background: ${theme.bg}; }
        ::-webkit-scrollbar-thumb { background: ${theme.border}; border-radius: 3px; }
        input[type="date"]::-webkit-calendar-picker-indicator,
        input[type="time"]::-webkit-calendar-picker-indicator { filter: invert(0.5); }
      `}</style>

      {/* Sidebar */}
      <div style={{
        position: "fixed", left: 0, top: 0, bottom: 0, width: 220,
        background: theme.surface, borderRight: `1px solid ${theme.border}`,
        display: "flex", flexDirection: "column", padding: "24px 0",
      }}>
        {/* Logo */}
        <div style={{ padding: "0 20px 24px", borderBottom: `1px solid ${theme.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10,
              background: theme.accentDim, border: `1px solid ${theme.accent}30`,
              display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18,
            }}>🎾</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: theme.text }}>{club?.name || "Padel"}</div>
              <div style={{ fontSize: 10, color: theme.textMuted }}>Dashboard</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ padding: "16px 12px", flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
          {([
            { id: "courts", label: "Campi & Partite", icon: "🏟" },
            { id: "players", label: "Giocatori", icon: "👥" },
          ] as const).map(item => (
            <button key={item.id} onClick={() => setActiveTab(item.id)} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 12px", borderRadius: 8, border: "none", cursor: "pointer",
              background: activeTab === item.id ? theme.accentDim : "transparent",
              color: activeTab === item.id ? theme.accent : theme.textMuted,
              fontSize: 13, textAlign: "left", transition: "all 0.15s",
            }}>
              <span>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        {/* Footer */}
        <div style={{ padding: "16px 20px", borderTop: `1px solid ${theme.border}` }}>
          <button
            onClick={() => setToken(null)}
            style={{ ...btnSmall, width: "100%", color: theme.textMuted }}
          >
            Esci
          </button>
        </div>
      </div>

      {/* Main content */}
      <div style={{ marginLeft: 220, padding: 32, maxWidth: 1200 }}>
        {/* Page header */}
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: theme.text }}>
            {activeTab === "courts" ? "Campi & Partite" : "Gestione Giocatori"}
          </div>
          <div style={{ fontSize: 13, color: theme.textMuted, marginTop: 4 }}>
            {activeTab === "courts"
              ? "Stato in tempo reale dei campi. Crea partite e parte la wave automaticamente."
              : "Lista giocatori. Attiva o disattiva i messaggi per numero di telefono."
            }
          </div>
        </div>

        {activeTab === "courts" && (
          <CourtsView token={token} courts={courts} onMatchCreated={() => {}} />
        )}
        {activeTab === "players" && (
          <PlayersView token={token} />
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// SHARED STYLES
// ─────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  background: theme.bg, border: `1px solid ${theme.border}`,
  borderRadius: 8, padding: "9px 12px",
  color: theme.text, fontSize: 13,
  fontFamily: "inherit", width: "100%",
  transition: "border-color 0.15s",
};

const btnPrimary: React.CSSProperties = {
  background: theme.accent, color: theme.bg,
  border: "none", borderRadius: 8,
  padding: "10px 18px", fontSize: 13, fontWeight: 700,
  cursor: "pointer", fontFamily: "inherit",
  transition: "background 0.15s",
};

const btnSmall: React.CSSProperties = {
  background: theme.border, color: theme.textMuted,
  border: `1px solid ${theme.borderLight}`, borderRadius: 6,
  padding: "7px 12px", fontSize: 12, cursor: "pointer",
  fontFamily: "inherit", transition: "all 0.15s",
};

const labelStyle: React.CSSProperties = {
  display: "block", fontSize: 11, color: theme.textMuted,
  textTransform: "uppercase", letterSpacing: "0.08em",
  marginBottom: 6,
};
