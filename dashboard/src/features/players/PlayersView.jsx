import { useState, useEffect, useCallback } from "react";
import { C, api, inputSt, btnPrimary, btnGhost, labelSt } from "../../shared/config";
import Spinner from "../../shared/Spinner";
import Toast from "../../shared/Toast";
import Modal from "../../shared/Modal";

// ─── PlayerProfile ────────────────────────────

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
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, background: C.accentDim, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>
          {player.active ? "🎾" : "⛔"}
        </div>
        <div style={{ flex: 1 }}>
          <input value={editName} onChange={e => setEditName(e.target.value)}
            placeholder="Nome giocatore"
            style={{ ...inputSt, fontSize: 16, fontWeight: 700, padding: "6px 10px" }}
            onBlur={() => editName !== player.name && patch({ name: editName })}
            onKeyDown={e => e.key === "Enter" && patch({ name: editName })}
          />
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4, fontFamily: "monospace" }}>{player.phoneNumber}</div>
        </div>
      </div>

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

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Affidabilità</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: rateColor }}>{(showRate * 100).toFixed(0)}%</span>
        </div>
        <div style={{ height: 6, background: C.dim, borderRadius: 3, overflow: "hidden" }}>
          <div style={{ height: "100%", width: `${showRate * 100}%`, background: rateColor, borderRadius: 3, transition: "width 0.5s" }} />
        </div>
      </div>

      <div>
        <label style={labelSt}>Livello di gioco</label>
        <div style={{ display: "flex", gap: 8 }}>
          <input type="number" step="0.5" min="1" max="10"
            defaultValue={player.skillLevel} disabled={saving}
            style={{ ...inputSt, flex: 1, fontSize: 16, fontWeight: 700, textAlign: "center" }}
            onBlur={e => { const val = parseFloat(e.target.value); if (!isNaN(val) && val !== player.skillLevel) patch({ skillLevel: val }); }}
            onKeyDown={e => { if (e.key === "Enter") { const val = parseFloat(e.currentTarget.value); if (!isNaN(val) && val !== player.skillLevel) patch({ skillLevel: val }); } }}
          />
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Premi Invio o esci dal campo per salvare (es. 2.5)</div>
      </div>

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

      {player.history?.length > 0 && (
        <div>
          <label style={labelSt}>Ultime {player.history.length} partite</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {player.history.map((h, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                background: C.bg, border: `1px solid ${C.dim}`, borderRadius: 8, padding: "8px 12px", fontSize: 12,
              }}>
                <span style={{ color: C.muted }}>{h.date} — {h.court}</span>
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

// ─── PlayersView ──────────────────────────────

export default function PlayersView({ token, club }) {
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

      {loading ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 20 }}><Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Caricamento...</span></div>
      ) : (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1.5fr 0.6fr 0.8fr 0.7fr 0.7fr", padding: "10px 16px", borderBottom: `1px solid ${C.border}`, fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>
            <span>Nome</span><span>Telefono</span><span>Liv.</span><span>Affidabilità</span><span>Inviti</span><span>Stato</span>
          </div>

          {players.length === 0 && <div style={{ padding: 32, textAlign: "center", color: C.muted, fontSize: 13 }}>Nessun giocatore trovato</div>}

          {players.map((p, i) => {
            const rate = p.reliabilityScore === 0 ? 0.33 : p.reliabilityScore;
            return (
              <div key={p.id} onClick={() => setSelectedPlayer(p.id)} style={{
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
