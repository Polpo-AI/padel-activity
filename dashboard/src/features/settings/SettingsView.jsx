import { useState, useEffect } from "react";
import { C, api, inputSt, btnPrimary, labelSt } from "../../shared/config";
import Toast from "../../shared/Toast";

export default function SettingsView({ token, club, onClubUpdate }) {
  const [form, setForm] = useState({
    name: club?.name || "",
    skillLevelCount: club?.skillLevelCount || 3,
    playersPerMatch: club?.playersPerMatch || 4,
    aiTone: club?.aiTone || "friendly",
    maxDailyMessages: club?.maxDailyMessages || 2,
  });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [clubId, setClubId] = useState(null);

  useEffect(() => {
    api("/club", token).then(d => {
      setClubId(d.id);
      setForm({
        name: d.name || "",
        skillLevelCount: d.skillLevelCount || 3,
        playersPerMatch: d.playersPerMatch || 4,
        aiTone: d.aiTone || "friendly",
        maxDailyMessages: d.maxDailyMessages || 2,
      });
    }).catch(() => {});
  }, [token]);

  const save = async () => {
    setSaving(true);
    try {
      const d = await api("/club", token, { method: "PATCH", body: JSON.stringify(form) });
      onClubUpdate?.(d);
      setToast({ msg: "Impostazioni salvate ✓", type: "ok" });
    } catch (e) { setToast({ msg: e.message, type: "err" }); }
    finally { setSaving(false); }
  };

  const F = ({ label, children }) => (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={labelSt}>{label}</label>
      {children}
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 680 }}>

      {clubId && (
        <div style={{ background: `${C.accent}08`, border: `1px solid ${C.accentSoft}`, borderRadius: 10, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 16 }}>🏛</span>
          <div>
            <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Club ID (usato per multi-tenancy)</div>
            <div style={{ fontSize: 13, fontFamily: "monospace", color: C.accent, marginTop: 2 }}>{clubId}</div>
          </div>
        </div>
      )}

      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 24, display: "flex", flexDirection: "column", gap: 18 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>🎾 Configurazione Circolo</div>

        <F label="Nome circolo">
          <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputSt} placeholder="Es. Circolo Padel Roma" />
        </F>

        <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 14 }}>
          <F label="Giocatori per partita">
            <select value={form.playersPerMatch} onChange={e => setForm(f => ({ ...f, playersPerMatch: parseInt(e.target.value) }))} style={inputSt}>
              {[2, 4].map(v => <option key={v} value={v}>{v} giocatori</option>)}
            </select>
          </F>
        </div>

        <F label="Tono AI">
          <div style={{ display: "flex", gap: 8 }}>
            {[
              { id: "formal", label: "🧑‍💼 Formale" },
              { id: "friendly", label: "😊 Amichevole" },
              { id: "fun", label: "🎉 Divertente" },
            ].map(t => (
              <button key={t.id} onClick={() => setForm(f => ({ ...f, aiTone: t.id }))} style={{
                flex: 1, padding: "9px 0", borderRadius: 8, cursor: "pointer", fontSize: 12,
                border: `1px solid ${form.aiTone === t.id ? C.accent : C.border}`,
                background: form.aiTone === t.id ? C.accentDim : "transparent",
                color: form.aiTone === t.id ? C.accent : C.muted,
                fontFamily: "inherit",
              }}>{t.label}</button>
            ))}
          </div>
        </F>

        <F label={`Max messaggi giornalieri per giocatore (attuale: ${form.maxDailyMessages})`}>
          <input type="range" min={1} max={5} value={form.maxDailyMessages}
            onChange={e => setForm(f => ({ ...f, maxDailyMessages: parseInt(e.target.value) }))}
            style={{ width: "100%" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.dim }}>
            <span>1</span><span>2</span><span>3</span><span>4</span><span>5</span>
          </div>
        </F>

        <button onClick={save} disabled={saving} style={{ ...btnPrimary, alignSelf: "flex-start", minWidth: 140 }}>
          {saving ? "Salvataggio..." : "Salva impostazioni"}
        </button>
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 16 }}>📋 Checklist SaaS Readiness</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {[
            { label: "Context Injection clubId implementato", done: true, priority: "CRITICO" },
            { label: "State conversazionale su Redis (non DB)", done: true, priority: "CRITICO" },
            { label: "AOF Redis attivo in docker-compose", done: true, priority: "ALTO" },
            { label: "Staleness check sui job scaduti", done: true, priority: "ALTO" },
            { label: "Rate limiting su /api/", done: true, priority: "ALTO" },
            { label: "Webhook HMAC validation", done: true, priority: "ALTO" },
            { label: "Soft-delete match storici", done: true, priority: "MEDIO" },
            { label: "Fallback deterministico UNCLEAR_INTENT", done: true, priority: "MEDIO" },
          ].map((item, i) => (
            <div key={i} style={{
              display: "flex", alignItems: "center", gap: 12, padding: "10px 14px",
              background: C.bg, borderRadius: 8, border: `1px solid ${item.done ? `${C.open}30` : C.dim}`,
            }}>
              <span style={{ fontSize: 14 }}>{item.done ? "✅" : "⬜"}</span>
              <span style={{ flex: 1, fontSize: 12, color: item.done ? C.muted : C.text }}>{item.label}</span>
              <span style={{
                fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 6,
                background: item.priority === "CRITICO" ? `${C.cancelled}18` : item.priority === "ALTO" ? `${C.warning}18` : `${C.locked}18`,
                color: item.priority === "CRITICO" ? C.cancelled : item.priority === "ALTO" ? C.warning : C.locked,
              }}>{item.priority}</span>
            </div>
          ))}
        </div>
      </div>

      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </div>
  );
}
