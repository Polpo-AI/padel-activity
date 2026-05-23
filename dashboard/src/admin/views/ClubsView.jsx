import { useState, useEffect, useCallback } from "react";
import { useTheme } from "../../shared/ThemeContext";
import Spinner from "../../shared/Spinner";
import Modal from "../../shared/Modal";

const WA_LABEL = { open: "Connesso", connecting: "Conn…", closed: "Chiuso", disconnected: "—" };

function EditModal({ club, token, onClose, onSaved }) {
  const { C, inputSt, btnPrimary, labelSt } = useTheme();
  const [form, setForm] = useState({
    name: club.name || "",
    city: club.city || "",
    address: club.address || "",
    matchLowerRange: club.matchLowerRange ?? 1,
    matchUpperRange: club.matchUpperRange ?? 1,
    maxDailyMessages: club.maxDailyMessages ?? 2,
  });
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

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
        {field("name", "Nome circolo")}
        {field("city", "Città")}
        {field("address", "Indirizzo")}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          {field("maxDailyMessages", "Max msg/giorno", "number", 1)}
          {field("matchLowerRange", "Range abilità −", "number", 0.5)}
          {field("matchUpperRange", "Range abilità +", "number", 0.5)}
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

export default function ClubsView({ token }) {
  const { C, inputSt, btnPrimary, btnGhost, labelSt } = useTheme();
  const [clubs, setClubs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);

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

  if (loading) return <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 40 }}><Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Caricamento...</span></div>;

  return (
    <>
      {editing && <EditModal club={editing} token={token} onClose={() => setEditing(null)} onSaved={load} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {clubs.map(c => (
          <div key={c.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px" }}>
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div style={{ flex: 1 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8 }}>
                  <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{c.name}</div>
                  <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, background: `${{ open: C.open, connecting: C.warning, closed: C.cancelled, disconnected: C.muted }[c.waStatus] || C.muted}22`, color: { open: C.open, connecting: C.warning, closed: C.cancelled, disconnected: C.muted }[c.waStatus] || C.muted }}>
                    WA: {WA_LABEL[c.waStatus] || c.waStatus}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 14 }}>
                  {[c.city, c.address].filter(Boolean).join(" · ") || "—"}
                </div>
                <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
                  {[
                    ["Giocatori", c.players],
                    ["Campi", c.courts],
                    ["Partite totali", c.totalMatches],
                    ["Partite (30gg)", c.matchesThisMonth],
                    ["Fill rate (30gg)", `${Math.round((c.fillRate || 0) * 100)}%`],
                    ["Max msg/gg", c.maxDailyMessages],
                  ].map(([label, val]) => (
                    <div key={label} style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      <span style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
                      <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{val}</span>
                    </div>
                  ))}
                </div>
                {c.botPhoneNumber && (
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 10 }}>
                    Bot: +{c.botPhoneNumber} · Admin: {c.adminPhone || "—"}
                  </div>
                )}
              </div>
              <button type="button" onClick={() => setEditing(c)} style={{ ...btnGhost, whiteSpace: "nowrap" }}>Modifica</button>
            </div>
          </div>
        ))}
        {!clubs.length && <div style={{ padding: 40, textAlign: "center", color: C.muted, fontSize: 13 }}>Nessun circolo configurato</div>}
      </div>
    </>
  );
}
