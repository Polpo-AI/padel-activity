import { useState, useEffect, useCallback, useRef } from "react";

// ─────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────

const API = "/api/dashboard";

const C = {
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

const STATUS = {
  OPEN:      { color: C.open,      label: "Aperta" },
  LOCKED:    { color: C.locked,    label: "Chiusa" },
  CANCELLED: { color: C.cancelled, label: "Cancellata" },
  UNFILLED:  { color: C.unfilled,  label: "Non riempita" },
};

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────

const api = async (path, token, opts = {}) => {
  const r = await fetch(`${API}${path}`, {
    ...opts,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(opts.headers || {}) },
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error || "Errore");
  return d;
};

const fmt = (d, opts) => new Date(d).toLocaleString("it-IT", opts);
const fmtTime = d => fmt(d, { hour: "2-digit", minute: "2-digit" });
const fmtDate = d => fmt(d, { weekday: "short", day: "numeric", month: "short" });
const today = () => new Date().toISOString().split("T")[0];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────
// SHARED STYLES
// ─────────────────────────────────────────────

const inputSt = {
  background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8,
  padding: "9px 12px", color: C.text, fontSize: 13, fontFamily: "inherit",
  width: "100%", transition: "border-color 0.15s",
};
const btnPrimary = {
  background: C.accent, color: C.bg, border: "none", borderRadius: 8,
  padding: "10px 18px", fontSize: 13, fontWeight: 700, cursor: "pointer",
  fontFamily: "inherit",
};
const btnGhost = {
  background: "transparent", color: C.muted, border: `1px solid ${C.border}`,
  borderRadius: 6, padding: "7px 12px", fontSize: 12, cursor: "pointer",
  fontFamily: "inherit",
};
const labelSt = {
  display: "block", fontSize: 11, color: C.muted,
  textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6,
};

// ─────────────────────────────────────────────
// ATOMS
// ─────────────────────────────────────────────

function Spinner({ size = 16 }) {
  return <div style={{
    width: size, height: size, border: `2px solid ${C.border}`,
    borderTopColor: C.accent, borderRadius: "50%",
    animation: "spin 0.7s linear infinite", flexShrink: 0,
  }} />;
}

function Badge({ status }) {
  const m = STATUS[status] || { color: C.muted, label: status };
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
      padding: "3px 8px", borderRadius: 20,
      background: `${m.color}18`, color: m.color, border: `1px solid ${m.color}30`,
    }}>● {m.label.toUpperCase()}</span>
  );
}

function Toast({ msg, type = "ok", onDone }) {
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, []);
  return (
    <div style={{
      position: "fixed", bottom: 28, right: 28, zIndex: 9999,
      background: type === "ok" ? C.accent : C.cancelled,
      color: type === "ok" ? C.bg : "#fff",
      padding: "12px 20px", borderRadius: 10, fontSize: 13, fontWeight: 600,
      boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
      animation: "slideUp 0.2s ease",
    }}>{msg}</div>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 500,
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16,
        padding: 32, width: 440, maxWidth: "95vw", maxHeight: "90vh", overflowY: "auto",
        display: "flex", flexDirection: "column", gap: 20,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{title}</div>
          <button onClick={onClose} style={{ ...btnGhost, border: "none", padding: "4px 8px" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// LOGIN
// ─────────────────────────────────────────────

function LoginPage({ onLogin }) {
  const [u, setU] = useState(""); const [p, setP] = useState("");
  const [loading, setLoading] = useState(false); const [err, setErr] = useState("");

  const submit = async () => {
    if (!u || !p) return;
    setLoading(true); setErr("");
    try {
      const d = await fetch(`${API}/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p }),
      }).then(r => r.json());
      if (d.error) throw new Error(d.error);
      onLogin(d.token, d.club);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>
      <div style={{ width: 360, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 40, display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{ fontSize: 36, marginBottom: 12 }}>🎾</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>Padel Dashboard</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Accesso riservato</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input value={u} onChange={e => setU(e.target.value)} placeholder="Username" style={inputSt} onKeyDown={e => e.key === "Enter" && submit()} />
          <input type="password" value={p} onChange={e => setP(e.target.value)} placeholder="Password" style={inputSt} onKeyDown={e => e.key === "Enter" && submit()} />
          {err && <div style={{ fontSize: 12, color: C.cancelled, textAlign: "center" }}>{err}</div>}
          <button onClick={submit} disabled={loading} style={btnPrimary}>{loading ? "..." : "Accedi →"}</button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// HOURS EDITOR (tabellina orari circolo)
// ─────────────────────────────────────────────

function HoursEditor({ token, club, onUpdated }) {
  const [open, setOpen] = useState(club?.openTime || "08:00");
  const [close, setClose] = useState(club?.closeTime || "23:30");
  const [slot, setSlot] = useState(club?.slotDurationMinutes || club?.matchDuration || 90);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const save = async () => {
    setSaving(true);
    try {
      const d = await api("/club/hours", token, { method: "PUT", body: JSON.stringify({ openTime: open, closeTime: close, slotDurationMinutes: slot }) });
      onUpdated(d);
      setToast({ msg: "Orari salvati ✓", type: "ok" });
    } catch (e) { setToast({ msg: e.message, type: "err" }); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 16 }}>⏰ Orari apertura circolo</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 12, alignItems: "end" }}>
        <div>
          <label style={labelSt}>Apertura</label>
          <input type="time" value={open} onChange={e => setOpen(e.target.value)} style={inputSt} />
        </div>
        <div>
          <label style={labelSt}>Chiusura</label>
          <input type="time" value={close} onChange={e => setClose(e.target.value)} style={inputSt} />
        </div>
        <div>
          <label style={labelSt}>Durata slot (min)</label>
          <select value={slot} onChange={e => setSlot(parseInt(e.target.value))} style={inputSt}>
            {[60, 75, 90, 105, 120].map(v => <option key={v} value={v}>{v} min</option>)}
          </select>
        </div>
        <button onClick={save} disabled={saving} style={{ ...btnPrimary, whiteSpace: "nowrap" }}>
          {saving ? "..." : "Salva"}
        </button>
      </div>
      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </div>
  );
}

// ─────────────────────────────────────────────
// UNAVAILABILITY PANEL per un singolo campo
// ─────────────────────────────────────────────

function UnavailabilityPanel({ court, token, onClose }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ date: today(), startHour: "09:00", endHour: "10:30", reason: "", recurring: false });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api(`/courts/${court.id}/unavailability`, token);
      setList(d);
    } finally { setLoading(false); }
  }, [court.id, token]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setSaving(true);
    try {
      const startTime = form.recurring
        ? `${form.date}T${form.startHour}:00`
        : `${form.date}T${form.startHour}:00`;
      const endTime = `${form.date}T${form.endHour}:00`;

      const d = await api(`/courts/${court.id}/unavailability`, token, {
        method: "POST",
        body: JSON.stringify({ startTime, endTime, reason: form.reason, recurring: form.recurring }),
      });

      if (d.conflictingMatches?.length > 0) {
        setToast({ msg: `⚠ ${d.conflictingMatches.length} partite già create in questo slot — verifica manualmente`, type: "err" });
      } else {
        setToast({ msg: "Blocco aggiunto ✓", type: "ok" });
      }
      setShowForm(false);
      load();
    } catch (e) { setToast({ msg: e.message, type: "err" }); }
    finally { setSaving(false); }
  };

  const remove = async (uid) => {
    if (!confirm("Eliminare questo blocco?")) return;
    await api(`/courts/${court.id}/unavailability/${uid}`, token, { method: "DELETE" });
    load();
  };

  const DAYS = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];

  return (
    <Modal title={`🔒 Indisponibilità — ${court.name}`} onClose={onClose}>
      <button onClick={() => setShowForm(!showForm)} style={btnPrimary}>
        {showForm ? "Annulla" : "+ Nuovo blocco"}
      </button>

      {showForm && (
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={labelSt}>Data {form.recurring && "(giorno settimana)"}</label>
              <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={inputSt} />
              {form.recurring && (
                <div style={{ fontSize: 11, color: C.accent, marginTop: 4 }}>
                  Si ripeterà ogni {DAYS[new Date(form.date + "T12:00").getDay()]}
                </div>
              )}
            </div>
            <div>
              <label style={labelSt}>Motivo</label>
              <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                placeholder="es. Lezione istruttore" style={inputSt} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={labelSt}>Dalle</label>
              <input type="time" value={form.startHour} onChange={e => setForm(f => ({ ...f, startHour: e.target.value }))} style={inputSt} />
            </div>
            <div>
              <label style={labelSt}>Alle</label>
              <input type="time" value={form.endHour} onChange={e => setForm(f => ({ ...f, endHour: e.target.value }))} style={inputSt} />
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: C.text }}>
            <input type="checkbox" checked={form.recurring} onChange={e => setForm(f => ({ ...f, recurring: e.target.checked }))}
              style={{ accentColor: C.accent, width: 16, height: 16 }} />
            Ripeti ogni settimana (stesso giorno + orario)
          </label>
          <button onClick={create} disabled={saving} style={btnPrimary}>{saving ? "..." : "Salva blocco"}</button>
        </div>
      )}

      {loading ? <Spinner /> : list.length === 0 ? (
        <div style={{ textAlign: "center", color: C.muted, fontSize: 13, padding: "20px 0" }}>Nessun blocco configurato</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map(u => (
            <div key={u.id} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: C.bg, border: `1px solid ${C.dim}`, borderRadius: 8, padding: "10px 14px",
            }}>
              <div>
                <div style={{ fontSize: 13, color: C.text, display: "flex", alignItems: "center", gap: 8 }}>
                  {u.recurring && <span style={{ fontSize: 10, background: `${C.unavail}30`, color: C.unavail, padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>RICORRENTE</span>}
                  <span style={{ color: C.accent }}>{fmtTime(u.startTime)}–{fmtTime(u.endTime)}</span>
                  {u.recurring && <span style={{ color: C.muted, fontSize: 11 }}>ogni {DAYS[new Date(u.startTime).getDay()]}</span>}
                  {!u.recurring && <span style={{ color: C.muted, fontSize: 11 }}>{fmtDate(u.startTime)}</span>}
                </div>
                {u.reason && <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{u.reason}</div>}
              </div>
              <button onClick={() => remove(u.id)} style={{ ...btnGhost, color: C.cancelled, borderColor: `${C.cancelled}30`, fontSize: 11 }}>Elimina</button>
            </div>
          ))}
        </div>
      )}

      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </Modal>
  );
}

// ─────────────────────────────────────────────
// CREATE MATCH MODAL — con slot disponibili
// ─────────────────────────────────────────────

function CreateMatchModal({ courts, club, token, onClose, onCreated }) {
  const [courtId, setCourtId] = useState(courts[0]?.id || "");
  const [date, setDate] = useState(today());
  const [skillLevel, setSkillLevel] = useState(Math.ceil((club?.skillLevelCount || 3) / 2));
  const [slots, setSlots] = useState([]);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const loadSlots = useCallback(async () => {
    if (!courtId || !date) return;
    setLoadingSlots(true); setSlots([]); setSelectedSlot(null);
    try {
      const d = await api(`/courts/${courtId}/slots?date=${date}`, token);
      setSlots(d.slots || []);
    } catch {}
    finally { setLoadingSlots(false); }
  }, [courtId, date, token]);

  useEffect(() => { loadSlots(); }, [loadSlots]);

  const create = async () => {
    if (!selectedSlot) return;
    setSaving(true); setErr("");
    try {
      await api("/matches", token, { method: "POST", body: JSON.stringify({ courtId, startTime: selectedSlot, skillLevel }) });
      onCreated(); onClose();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Modal title="Nuova partita" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={labelSt}>Campo</label>
          <select value={courtId} onChange={e => setCourtId(e.target.value)} style={inputSt}>
            {courts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label style={labelSt}>Data</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputSt} />
        </div>
        <div>
          <label style={labelSt}>Livello (1–{club?.skillLevelCount || 3})</label>
          <div style={{ display: "flex", gap: 8 }}>
            {Array.from({ length: club?.skillLevelCount || 3 }, (_, i) => i + 1).map(l => (
              <button key={l} onClick={() => setSkillLevel(l)} style={{
                flex: 1, padding: "8px 0", borderRadius: 8, border: `1px solid ${l === skillLevel ? C.accent : C.border}`,
                background: l === skillLevel ? C.accentDim : "transparent",
                color: l === skillLevel ? C.accent : C.muted, cursor: "pointer", fontSize: 13, fontWeight: 700,
              }}>{l}</button>
            ))}
          </div>
        </div>

        <div>
          <label style={labelSt}>Orario</label>
          {loadingSlots ? <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 0" }}><Spinner size={14} /><span style={{ fontSize: 12, color: C.muted }}>Carico slot...</span></div> : (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 180, overflowY: "auto" }}>
              {slots.length === 0 && <div style={{ fontSize: 12, color: C.muted }}>Nessuno slot trovato</div>}
              {slots.map(s => {
                const t = fmtTime(s.startTime);
                const sel = selectedSlot === s.startTime;
                return (
                  <button key={s.startTime} disabled={!s.available} onClick={() => setSelectedSlot(s.startTime)}
                    title={!s.available ? s.reason : ""}
                    style={{
                      padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: sel ? 700 : 400,
                      cursor: s.available ? "pointer" : "not-allowed", border: `1px solid`,
                      borderColor: !s.available ? C.dim : sel ? C.accent : C.border,
                      background: !s.available ? C.bg : sel ? C.accentDim : "transparent",
                      color: !s.available ? C.dim : sel ? C.accent : C.text,
                      textDecoration: !s.available ? "line-through" : "none",
                    }}>{t}</button>
                );
              })}
            </div>
          )}
        </div>
      </div>
      {err && <div style={{ fontSize: 12, color: C.cancelled }}>{err}</div>}
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={onClose} style={{ ...btnGhost, flex: 1, padding: "10px 0" }}>Annulla</button>
        <button onClick={create} disabled={saving || !selectedSlot} style={{ ...btnPrimary, flex: 2, opacity: selectedSlot ? 1 : 0.4 }}>
          {saving ? "Creazione..." : "Crea e lancia wave →"}
        </button>
      </div>
    </Modal>
  );
}

// ─────────────────────────────────────────────
// MATCH CARD
// ─────────────────────────────────────────────

function MatchCard({ match, onCancel }) {
  const confirmed = match.MatchPlayer?.filter(mp => !mp.leftAt) || [];
  const pending = match.invitations?.length || 0;
  const spotsLeft = match.playersNeeded - confirmed.length;

  return (
    <div style={{ background: C.bg, border: `1px solid ${C.dim}`, borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{fmtTime(match.startTime)}</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Liv. {match.skillLevel} · {match.playersNeeded}p</div>
        </div>
        <Badge status={match.status} />
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <span style={{ fontSize: 11, color: C.muted }}>{confirmed.length}/{match.playersNeeded}</span>
          {pending > 0 && <span style={{ fontSize: 10, color: C.warning, background: `${C.warning}15`, padding: "1px 6px", borderRadius: 8 }}>{pending} in attesa</span>}
        </div>
        <div style={{ height: 3, background: C.dim, borderRadius: 2, overflow: "hidden" }}>
          <div style={{
            height: "100%", borderRadius: 2, transition: "width 0.3s",
            width: `${(confirmed.length / match.playersNeeded) * 100}%`,
            background: match.status === "LOCKED" ? C.locked : confirmed.length > 0 ? C.accent : C.muted,
          }} />
        </div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {confirmed.map(mp => (
          <span key={mp.id} style={{ fontSize: 10, background: C.dim, color: C.muted, padding: "2px 7px", borderRadius: 4 }}>
            {mp.player?.name || mp.player?.phoneNumber?.slice(-4)}
          </span>
        ))}
        {Array.from({ length: spotsLeft }).map((_, i) => (
          <span key={i} style={{ fontSize: 10, color: C.dim, padding: "2px 7px", borderRadius: 4, border: `1px dashed ${C.dim}` }}>—</span>
        ))}
      </div>

      {match.status === "OPEN" && (
        <button onClick={() => onCancel(match.id)} style={{ ...btnGhost, fontSize: 11, color: C.cancelled, borderColor: `${C.cancelled}30` }}>
          Cancella
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
// COURTS VIEW
// ─────────────────────────────────────────────

function CourtsView({ token, onClubUpdate }) {
  const [courtData, setCourtData] = useState([]);
  const [club, setClub] = useState(null);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(today());
  const [showCreate, setShowCreate] = useState(false);
  const [unavailCourt, setUnavailCourt] = useState(null);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    try {
      const [courts, clubData] = await Promise.all([
        api(`/courts?date=${date}`, token),
        api("/club", token),
      ]);
      setCourtData(courts);
      setClub(clubData);
      onClubUpdate?.(clubData);
    } finally { setLoading(false); }
  }, [token, date]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  const cancelMatch = async (id) => {
    if (!confirm("Sicuro?")) return;
    try { await api(`/matches/${id}/cancel`, token, { method: "POST" }); load(); }
    catch (e) { setToast({ msg: e.message, type: "err" }); }
  };

  const allMatches = courtData.flatMap(c => c.matches || []);

  if (loading) return <div style={{ padding: 40, display: "flex", gap: 10, alignItems: "center" }}><Spinner /> <span style={{ color: C.muted, fontSize: 13 }}>Caricamento...</span></div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

      {/* Orari */}
      {club && <HoursEditor token={token} club={club} onUpdated={d => setClub(prev => ({ ...prev, ...d }))} />}

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...inputSt, width: "auto" }} />
          <span style={{ fontSize: 11, color: C.muted }}>● aggiornamento automatico 15s</span>
        </div>
        <button onClick={() => setShowCreate(true)} style={btnPrimary}>+ Nuova partita</button>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        {[
          { l: "Partite aperte", v: allMatches.filter(m => m.status === "OPEN").length, c: C.open },
          { l: "Partite chiuse", v: allMatches.filter(m => m.status === "LOCKED").length, c: C.locked },
          { l: "Giocatori confermati", v: allMatches.filter(m => m.status === "LOCKED").reduce((s, m) => s + (m.MatchPlayer?.filter(mp => !mp.leftAt).length || 0), 0), c: C.accent },
        ].map(s => (
          <div key={s.l} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 20px" }}>
            <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>{s.l}</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: s.c, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{s.v}</div>
          </div>
        ))}
      </div>

      {/* Griglia campi */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(courtData.length || 1, 3)}, 1fr)`, gap: 16 }}>
        {courtData.map(court => {
          // Conta blocchi attivi oggi
          const todayBlocks = (court.unavailabilities || []).filter(u => {
            if (!u.recurring) return true;
            return new Date(u.startTime).getDay() === new Date(date).getDay();
          });

          return (
            <div key={court.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", background: C.accentDim }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.accent }}>{court.name}</div>
                  {todayBlocks.length > 0 && (
                    <div style={{ fontSize: 10, color: C.unavail, marginTop: 2 }}>
                      🔒 {todayBlocks.length} blocco{todayBlocks.length > 1 ? "i" : ""} oggi
                    </div>
                  )}
                </div>
                <button onClick={() => setUnavailCourt(court)} style={{ ...btnGhost, fontSize: 11, color: C.unavail, borderColor: `${C.unavail}40` }}>
                  Gestisci blocchi
                </button>
              </div>

              <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                {/* Blocchi visibili */}
                {todayBlocks.map(u => (
                  <div key={u.id} style={{ background: `${C.unavail}18`, border: `1px solid ${C.unavail}30`, borderRadius: 8, padding: "8px 12px" }}>
                    <div style={{ fontSize: 11, color: C.unavail, fontWeight: 600 }}>
                      🔒 {fmtTime(u.startTime)}–{fmtTime(u.endTime)}
                      {u.recurring && " (ricorrente)"}
                    </div>
                    {u.reason && <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{u.reason}</div>}
                  </div>
                ))}

                {court.matches?.length === 0 && todayBlocks.length === 0 && (
                  <div style={{ textAlign: "center", padding: "16px 0", color: C.dim, fontSize: 12 }}>Nessuna partita oggi</div>
                )}
                {court.matches?.map(m => <MatchCard key={m.id} match={m} onCancel={cancelMatch} />)}
              </div>
            </div>
          );
        })}
      </div>

      {showCreate && <CreateMatchModal courts={courtData} club={club} token={token} onClose={() => setShowCreate(false)} onCreated={load} />}
      {unavailCourt && <UnavailabilityPanel court={unavailCourt} token={token} onClose={() => { setUnavailCourt(null); load(); }} />}
      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </div>
  );
}

// ─────────────────────────────────────────────
// PLAYER PROFILE MODAL
// ─────────────────────────────────────────────

function PlayerProfile({ playerId, token, onClose, onUpdated, skillLevelCount = 3 }) {
  const [player, setPlayer] = useState(null);
  const [loading, setLoading] = useState(true);
  const [editName, setEditName] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api(`/players/${playerId}`, token);
      setPlayer(d); setEditName(d.name || "");
    } finally { setLoading(false); }
  }, [playerId, token]);

  useEffect(() => { load(); }, [load]);

  const patch = async (data) => {
    setSaving(true);
    try {
      await api(`/players/${playerId}`, token, { method: "PATCH", body: JSON.stringify(data) });
      await load();
      onUpdated?.();
      setToast({ msg: "Salvato ✓", type: "ok" });
    } catch (e) { setToast({ msg: e.message, type: "err" }); }
    finally { setSaving(false); }
  };

  if (loading) return <Modal title="Profilo giocatore" onClose={onClose}><Spinner /></Modal>;
  if (!player) return null;

  const showRate = player.reliabilityScore === 0 ? 0.33 : player.reliabilityScore;
  const rateColor = showRate >= 0.6 ? C.open : showRate >= 0.3 ? C.warning : C.cancelled;

  return (
    <Modal title="Profilo giocatore" onClose={onClose}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, background: C.accentDim, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>
          {player.active ? "🎾" : "⛔"}
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input value={editName} onChange={e => setEditName(e.target.value)}
              placeholder="Nome giocatore"
              style={{ ...inputSt, fontSize: 16, fontWeight: 700, padding: "6px 10px" }}
              onBlur={() => editName !== player.name && patch({ name: editName })}
              onKeyDown={e => e.key === "Enter" && patch({ name: editName })}
            />
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4, fontFamily: "monospace" }}>{player.phoneNumber}</div>
        </div>
      </div>

      {/* Stats */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        {[
          { l: "Inviti", v: player.stats.totalInvited },
          { l: "Presenti", v: player.stats.totalAccepted },
          { l: "No-show", v: player.stats.totalNoShow, c: player.stats.totalNoShow > 0 ? C.cancelled : C.muted },
        ].map(s => (
          <div key={s.l} style={{ background: C.bg, border: `1px solid ${C.dim}`, borderRadius: 10, padding: "12px 14px", textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: s.c || C.text }}>{s.v}</div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{s.l}</div>
          </div>
        ))}
      </div>

      {/* Show-up rate bar */}
      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Affidabilità</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: rateColor }}>{(showRate * 100).toFixed(0)}%</span>
        </div>
        <div style={{ height: 6, background: C.dim, borderRadius: 3, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${showRate * 100}%`, background: rateColor, borderRadius: 3, transition: "width 0.5s" }} />
        </div>
      </div>

      {/* Livello */}
      <div>
        <label style={labelSt}>Livello di gioco</label>
        <div style={{ display: "flex", gap: 8 }}>
          {Array.from({ length: skillLevelCount }, (_, i) => i + 1).map(l => (
            <button key={l} disabled={saving} onClick={() => patch({ skillLevel: l })} style={{
              flex: 1, padding: "9px 0", borderRadius: 8, cursor: "pointer",
              border: `1px solid ${l === player.skillLevel ? C.accent : C.border}`,
              background: l === player.skillLevel ? C.accentDim : "transparent",
              color: l === player.skillLevel ? C.accent : C.muted,
              fontSize: 14, fontWeight: 700,
            }}>{l}</button>
          ))}
        </div>
      </div>

      {/* Active toggle */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: C.bg, border: `1px solid ${C.dim}`, borderRadius: 10, padding: "12px 16px" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            {player.active ? "✅ Giocatore attivo" : "🚫 Giocatore disattivato"}
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            {player.active ? "Riceve inviti alle partite" : "Non riceve inviti alle partite"}
          </div>
        </div>
        <button disabled={saving} onClick={() => patch({ active: !player.active })} style={{
          ...btnGhost,
          color: player.active ? C.cancelled : C.accent,
          borderColor: player.active ? `${C.cancelled}40` : `${C.accent}40`,
        }}>
          {saving ? "..." : player.active ? "Disattiva" : "Riattiva"}
        </button>
      </div>

      {/* Storico */}
      {player.history?.length > 0 && (
        <div>
          <label style={labelSt}>Ultime {player.history.length} partite</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {player.history.map((h, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                background: C.bg, border: `1px solid ${C.dim}`, borderRadius: 8, padding: "8px 12px", fontSize: 12,
              }}>
                <span style={{ color: C.muted }}>{fmtDate(h.date)} — {h.court}</span>
                <span style={{
                  fontWeight: 700, fontSize: 11, padding: "2px 8px", borderRadius: 8,
                  background: h.showed ? `${C.open}18` : `${C.cancelled}18`,
                  color: h.showed ? C.open : h.noShow ? C.cancelled : C.muted,
                }}>
                  {h.showed ? "✓ Presente" : h.noShow ? "✗ No-show" : h.invStatus}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </Modal>
  );
}

// ─────────────────────────────────────────────
// PLAYERS VIEW — sezione utenti completa
// ─────────────────────────────────────────────

function PlayersView({ token, club }) {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filterActive, setFilterActive] = useState("all");
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [togglePhone, setTogglePhone] = useState("");
  const [toggleResult, setToggleResult] = useState(null);
  const [toggleLoading, setToggleLoading] = useState(false);
  const [toggleErr, setToggleErr] = useState("");
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (search) p.set("search", search);
      if (filterActive !== "all") p.set("active", filterActive === "active" ? "true" : "false");
      const d = await api(`/players?${p}`, token);
      setPlayers(d);
    } finally { setLoading(false); }
  }, [token, search, filterActive]);

  useEffect(() => { const t = setTimeout(load, 300); return () => clearTimeout(t); }, [load]);

  const handleToggle = async () => {
    if (!togglePhone.trim()) return;
    setToggleLoading(true); setToggleErr(""); setToggleResult(null);
    try {
      const d = await api("/players/toggle", token, { method: "POST", body: JSON.stringify({ phoneNumber: togglePhone.trim() }) });
      setToggleResult(d); setTogglePhone(""); load();
    } catch (e) { setToggleErr(e.message); }
    finally { setToggleLoading(false); }
  };

  const rateColor = r => r >= 0.6 ? C.open : r >= 0.3 ? C.warning : C.cancelled;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Toggle per numero */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Attiva / Disattiva per numero</div>
        <div style={{ display: "flex", gap: 10 }}>
          <input value={togglePhone} onChange={e => setTogglePhone(e.target.value)}
            placeholder="+393471234567" style={{ ...inputSt, flex: 1 }}
            onKeyDown={e => e.key === "Enter" && handleToggle()} />
          <button onClick={handleToggle} disabled={toggleLoading || !togglePhone.trim()} style={btnPrimary}>
            {toggleLoading ? "..." : "Toggle"}
          </button>
        </div>
        {toggleErr && <div style={{ fontSize: 12, color: C.cancelled }}>⚠ {toggleErr}</div>}
        {toggleResult && (
          <div style={{ fontSize: 13, padding: "10px 14px", borderRadius: 8, color: toggleResult.active ? C.accent : C.muted, background: toggleResult.active ? C.accentDim : C.dim }}>
            {toggleResult.message}
          </div>
        )}
      </div>

      {/* Filtri */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Cerca per nome o numero..." style={{ ...inputSt, flex: 1, minWidth: 200 }} />
        {["all", "active", "inactive"].map(f => (
          <button key={f} onClick={() => setFilterActive(f)} style={{
            ...btnGhost, whiteSpace: "nowrap",
            background: filterActive === f ? C.accentDim : "transparent",
            color: filterActive === f ? C.accent : C.muted,
            borderColor: filterActive === f ? `${C.accent}40` : C.border,
          }}>
            {f === "all" ? "Tutti" : f === "active" ? "✅ Attivi" : "🚫 Disattivati"}
          </button>
        ))}
      </div>

      {/* Tabella */}
      {loading ? <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 20 }}><Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Caricamento...</span></div> : (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1.5fr 0.6fr 0.8fr 0.7fr 0.7fr", padding: "10px 16px", borderBottom: `1px solid ${C.border}`, fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>
            <span>Nome</span><span>Telefono</span><span>Liv.</span><span>Affidabilità</span><span>Inviti</span><span>Stato</span>
          </div>

          {players.length === 0 && <div style={{ padding: 32, textAlign: "center", color: C.muted, fontSize: 13 }}>Nessun giocatore trovato</div>}

          {players.map((p, i) => {
            const rate = p.reliabilityScore === 0 ? 0.33 : p.reliabilityScore;
            return (
              <div key={p.id}
                onClick={() => setSelectedPlayer(p.id)}
                style={{
                  display: "grid", gridTemplateColumns: "2fr 1.5fr 0.6fr 0.8fr 0.7fr 0.7fr",
                  padding: "11px 16px", borderBottom: i < players.length - 1 ? `1px solid ${C.border}` : "none",
                  fontSize: 12, color: C.text, alignItems: "center", cursor: "pointer",
                  background: !p.active ? `${C.cancelled}05` : "transparent",
                  transition: "background 0.1s",
                }}
                onMouseEnter={e => e.currentTarget.style.background = C.surfaceHover}
                onMouseLeave={e => e.currentTarget.style.background = !p.active ? `${C.cancelled}05` : "transparent"}
              >
                <span style={{ color: p.active ? C.text : C.muted }}>{p.name || <span style={{ color: C.dim }}>—</span>}</span>
                <span style={{ color: C.muted, fontFamily: "monospace", fontSize: 11 }}>{p.phoneNumber}</span>
                <span style={{ display: "inline-flex", width: 24, height: 24, alignItems: "center", justifyContent: "center", borderRadius: 6, background: C.accentDim, color: C.accent, fontSize: 11, fontWeight: 700 }}>{p.skillLevel}</span>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ flex: 1, height: 4, background: C.dim, borderRadius: 2, overflow: "hidden", maxWidth: 60 }}>
                    <div style={{ height: "100%", width: `${rate * 100}%`, background: rateColor(rate), borderRadius: 2 }} />
                  </div>
                  <span style={{ fontSize: 10, color: rateColor(rate), minWidth: 28 }}>{(rate * 100).toFixed(0)}%</span>
                </div>
                <span style={{ color: C.muted, fontSize: 11 }}>{p.dailyMessagesCount}/2</span>
                <span style={{ fontSize: 10, fontWeight: 600 }}>
                  {p.active ? <span style={{ color: C.open }}>● attivo</span> : <span style={{ color: C.cancelled }}>● off</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {selectedPlayer && (
        <PlayerProfile
          playerId={selectedPlayer}
          token={token}
          skillLevelCount={club?.skillLevelCount || 3}
          onClose={() => setSelectedPlayer(null)}
          onUpdated={load}
        />
      )}

      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </div>
  );
}

// ─────────────────────────────────────────────
// MAIN DASHBOARD
// ─────────────────────────────────────────────

export default function PadelDashboard() {
  const [token, setToken] = useState(null);
  const [club, setClub] = useState(null);
  const [tab, setTab] = useState("courts");

  const handleLogin = (t, c) => { setToken(t); setClub(c); };

  if (!token) return <LoginPage onLogin={handleLogin} />;

  const nav = [
    { id: "courts", label: "Campi & Partite", icon: "🏟" },
    { id: "players", label: "Utenti", icon: "👥" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'DM Mono','Fira Code','Courier New',monospace", color: C.text }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slideUp { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        input:focus, select:focus { outline: none; border-color: ${C.accentSoft} !important; box-shadow: 0 0 0 3px ${C.accentDim}; }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-track { background: ${C.bg}; } ::-webkit-scrollbar-thumb { background: ${C.dim}; border-radius: 3px; }
        input[type="date"]::-webkit-calendar-picker-indicator,
        input[type="time"]::-webkit-calendar-picker-indicator { filter: invert(0.4); }
        input[type="range"] { accent-color: ${C.accent}; }
      `}</style>

      {/* Sidebar */}
      <div style={{ position: "fixed", left: 0, top: 0, bottom: 0, width: 210, background: C.surface, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", padding: "24px 0" }}>
        <div style={{ padding: "0 20px 24px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: C.accentDim, border: `1px solid ${C.accentSoft}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🎾</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{club?.name || "Padel"}</div>
              <div style={{ fontSize: 10, color: C.muted }}>Dashboard</div>
            </div>
          </div>
        </div>

        <nav style={{ padding: "16px 12px", flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
          {nav.map(n => (
            <button key={n.id} onClick={() => setTab(n.id)} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 12px", borderRadius: 8, border: "none", cursor: "pointer",
              background: tab === n.id ? C.accentDim : "transparent",
              color: tab === n.id ? C.accent : C.muted,
              fontSize: 13, textAlign: "left", transition: "all 0.12s",
            }}>
              <span>{n.icon}</span><span>{n.label}</span>
            </button>
          ))}
        </nav>

        <div style={{ padding: "16px 20px", borderTop: `1px solid ${C.border}` }}>
          <button onClick={() => setToken(null)} style={{ ...btnGhost, width: "100%", fontSize: 11 }}>Esci</button>
        </div>
      </div>

      {/* Content */}
      <div style={{ marginLeft: 210, padding: "32px 36px", maxWidth: 1300 }}>
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.text }}>
            {nav.find(n => n.id === tab)?.label}
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
            {tab === "courts" ? "Griglia campi in tempo reale. Gestisci partite, orari e blocchi." : "Anagrafica giocatori. Cerca, modifica livello, attiva/disattiva."}
          </div>
        </div>

        {tab === "courts" && <CourtsView token={token} onClubUpdate={setClub} />}
        {tab === "players" && <PlayersView token={token} club={club} />}
      </div>
    </div>
  );
}
