import { useState, useEffect, useCallback } from "react";
import { useTheme } from "../../shared/ThemeContext";
import Spinner from "../../shared/Spinner";
import Modal from "../../shared/Modal";

const WA_LABEL = { open: "Connesso", connecting: "Conn…", closed: "Chiuso", disconnected: "—" };
const WA_COLOR = (status, C) => ({ open: C.open, connecting: C.warning, closed: C.cancelled, disconnected: C.muted }[status] || C.muted);

function EditModal({ club, token, onClose, onSaved }) {
  const { C, inputSt, btnPrimary, btnGhost, labelSt } = useTheme();
  const [form, setForm] = useState({
    name:             club.name             || "",
    city:             club.city             || "",
    address:          club.address          || "",
    botName:          club.botName          || "",
    matchLowerRange:  club.matchLowerRange  ?? 1,
    matchUpperRange:  club.matchUpperRange  ?? 1,
    maxDailyMessages: club.maxDailyMessages ?? 2,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr]       = useState("");

  const save = async () => {
    setSaving(true); setErr("");
    try {
      const r = await fetch(`/api/admin/clubs/${club.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(form),
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      onSaved();
      onClose();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const field = (key, label, type = "text", step) => (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={labelSt}>{label}</span>
      <input type={type} step={step} value={form[key]}
        onChange={e => setForm(f => ({ ...f, [key]: type === "number" ? parseFloat(e.target.value) : e.target.value }))}
        style={inputSt} />
    </label>
  );

  return (
    <Modal onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 16, minWidth: 340 }}>
        <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{club.name}</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {field("name", "Nome circolo")}
          {field("botName", "Nome bot")}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {field("city", "Città")}
          {field("address", "Indirizzo")}
        </div>
        <div style={{ height: 1, background: C.border }} />
        <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>Matchmaking</div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
          {field("maxDailyMessages", "Max msg/giorno", "number", 1)}
          {field("matchLowerRange",  "Range skill −",  "number", 0.5)}
          {field("matchUpperRange",  "Range skill +",  "number", 0.5)}
        </div>
        {err && <div style={{ fontSize: 12, color: C.cancelled }}>{err}</div>}
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" onClick={save} disabled={saving} style={{ ...btnPrimary, flex: 1 }}>{saving ? "…" : "Salva"}</button>
          <button type="button" onClick={onClose} style={btnGhost}>Annulla</button>
        </div>
      </div>
    </Modal>
  );
}

function StatChip({ label, value }) {
  const { C } = useTheme();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
      <span style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{label}</span>
      <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{value}</span>
    </div>
  );
}

const STATUS_LABEL = { OPEN: "Aperta", LOCKED: "Confermata", CANCELLED: "Cancellata", UNFILLED: "Non riempita" };

function ClubDetailView({ club, token, onBack, onEdit }) {
  const { C, btnGhost } = useTheme();
  const c = club;
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const waColor = WA_COLOR(c.waStatus, C);
  const fillPct = Math.round((c.fillRate || 0) * 100);
  const fillColor = fillPct >= 70 ? C.open : fillPct >= 40 ? C.warning : C.cancelled;

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/admin/matches?clubId=${c.id}`, { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json();
        if (alive) setMatches(Array.isArray(d.matches) ? d.matches.slice(0, 15) : []);
      } catch { if (alive) setMatches([]); }
      finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [c.id, token]);

  const fmtDt = (s) => new Date(s).toLocaleString("it-IT", { timeZone: "Europe/Rome", weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <button type="button" onClick={onBack} style={btnGhost}>← Circoli</button>
        <div style={{ fontSize: 18, fontWeight: 700, color: C.text }}>{c.name}</div>
        <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: `${waColor}22`, color: waColor }}>WA: {WA_LABEL[c.waStatus] || c.waStatus}</span>
        <button type="button" onClick={() => onEdit(c)} style={{ ...btnGhost, marginLeft: "auto" }}>Modifica config</button>
      </div>

      {/* Config + KPI */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 14, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 20px" }}>
        <StatChip label="Giocatori" value={c.players} />
        <StatChip label="Campi" value={c.courts} />
        <StatChip label="Partite totali" value={c.totalMatches} />
        <StatChip label="Partite (30gg)" value={c.matchesThisMonth} />
        <StatChip label="Accettazione" value={`${fillPct}%`} />
        <StatChip label="Orari" value={`${c.openTime || "?"}–${c.closeTime || "?"}`} />
        <StatChip label="Range skill" value={`−${c.matchLowerRange ?? 1} / +${c.matchUpperRange ?? 1}`} />
        <StatChip label="Max msg/gg" value={c.maxDailyMessages} />
        {c.botName && <StatChip label="Bot" value={c.botName} />}
        {c.adminPhone && <StatChip label="Admin" value={`+${c.adminPhone}`} />}
      </div>

      {/* Recent matches */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 10 }}>Partite recenti</div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
          {loading ? (
            <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 28, justifyContent: "center" }}><Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Caricamento...</span></div>
          ) : matches.length ? (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 520 }}>
                <thead><tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {["Campo", "Data/ora", "Stato", "Giocatori"].map(h => <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {matches.map((m, i) => {
                    const sc = { OPEN: C.open, LOCKED: C.locked, CANCELLED: C.cancelled, UNFILLED: C.unfilled }[m.status] || C.muted;
                    return (
                      <tr key={m.id} style={{ borderBottom: i < matches.length - 1 ? `1px solid ${C.border}` : "none" }}>
                        <td style={{ padding: "10px 16px", color: C.muted }}>{m.court || "—"}</td>
                        <td style={{ padding: "10px 16px", color: C.text, whiteSpace: "nowrap" }}>{fmtDt(m.startTime)}</td>
                        <td style={{ padding: "10px 16px" }}><span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, background: `${sc}22`, color: sc }}>{STATUS_LABEL[m.status] || m.status}</span></td>
                        <td style={{ padding: "10px 16px", color: m.playersConfirmed >= m.playersNeeded ? C.open : C.muted }}>{m.playersConfirmed}/{m.playersNeeded}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <div style={{ padding: 32, textAlign: "center", color: C.muted, fontSize: 13 }}>Nessuna partita</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function ClubsView({ token }) {
  const { C, btnGhost } = useTheme();
  const [clubs, setClubs]   = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/clubs", { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (!Array.isArray(d)) throw new Error();
      setClubs(d);
    } catch { setClubs([]); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 40 }}>
      <Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Caricamento...</span>
    </div>
  );

  if (detail) return (
    <>
      {editing && <EditModal club={editing} token={token} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      <ClubDetailView club={detail} token={token} onBack={() => setDetail(null)} onEdit={setEditing} />
    </>
  );

  return (
    <>
      {editing && <EditModal club={editing} token={token} onClose={() => setEditing(null)} onSaved={load} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        {clubs.map(c => {
          const waColor = WA_COLOR(c.waStatus, C);
          const fillPct = Math.round((c.fillRate || 0) * 100);
          const fillColor = fillPct >= 70 ? C.open : fillPct >= 40 ? C.warning : C.cancelled;
          return (
            <div key={c.id} onClick={() => setDetail(c)}
              onMouseEnter={e => { e.currentTarget.style.borderColor = C.accentSoft; e.currentTarget.style.background = C.surfaceHover; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = C.border; e.currentTarget.style.background = C.surface; }}
              style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px", cursor: "pointer", transition: "border-color 0.15s, background 0.15s" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 0 }}>

                  {/* Header */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{c.name}</div>
                    <span style={{
                      fontSize: 11, padding: "2px 8px", borderRadius: 4,
                      background: `${waColor}22`, color: waColor,
                    }}>
                      WA: {WA_LABEL[c.waStatus] || c.waStatus}
                    </span>
                  </div>

                  {/* Location + orari */}
                  <div style={{ fontSize: 12, color: C.muted, marginBottom: 16, display: "flex", gap: 12, flexWrap: "wrap" }}>
                    {[c.city, c.address].filter(Boolean).join(" · ") || "—"}
                    {(c.openTime || c.closeTime) && (
                      <span style={{ color: C.muted }}>
                        · {c.openTime || "?"} – {c.closeTime || "?"}
                      </span>
                    )}
                  </div>

                  {/* Stats */}
                  <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-end" }}>
                    <StatChip label="Giocatori" value={c.players} />
                    <StatChip label="Campi" value={c.courts} />
                    <StatChip label="Partite totali" value={c.totalMatches} />
                    <StatChip label="Partite (30gg)" value={c.matchesThisMonth} />
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <span style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>Accettazione inviti</span>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ width: 64, height: 4, background: C.dim, borderRadius: 2, overflow: "hidden" }}>
                          <div style={{ height: "100%", width: `${fillPct}%`, background: fillColor, borderRadius: 2 }} />
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 600, color: fillColor }}>{fillPct}%</span>
                      </div>
                    </div>
                    <StatChip label="Max msg/gg" value={c.maxDailyMessages} />
                  </div>

                  {/* Bot info */}
                  {(c.botPhoneNumber || c.adminPhone || c.botName) && (
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 12, display: "flex", gap: 14, flexWrap: "wrap" }}>
                      {c.botName       && <span>Bot: <strong style={{ color: C.text }}>{c.botName}</strong></span>}
                      {c.botPhoneNumber && <span>+{c.botPhoneNumber}</span>}
                      {c.adminPhone    && <span>Admin: +{c.adminPhone}</span>}
                    </div>
                  )}
                </div>

                <button type="button" onClick={(e) => { e.stopPropagation(); setEditing(c); }} style={{ ...btnGhost, whiteSpace: "nowrap", flexShrink: 0 }}>
                  Modifica
                </button>
              </div>
            </div>
          );
        })}
        {!clubs.length && (
          <div style={{ padding: 40, textAlign: "center", color: C.muted, fontSize: 13 }}>Nessun circolo configurato</div>
        )}
      </div>
    </>
  );
}
