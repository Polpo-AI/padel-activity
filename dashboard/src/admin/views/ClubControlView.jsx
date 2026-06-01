import { useState, useEffect, useCallback, useRef } from "react";
import { useTheme } from "../../shared/ThemeContext";
import Spinner from "../../shared/Spinner";
import PlayersView from "../../features/players/PlayersView";
import RevenueView from "../../features/revenue/RevenueView";

// Vista Circolo (superadmin): seleziona un circolo e opera sui suoi dati con gli
// STESSI componenti della dashboard circolo (edit/sort/filtri sui giocatori,
// confronto guadagni). Il token-circolo arriva da /api/admin/clubs/:id/impersonate
// (stesso JWT_SECRET → valido per /api/dashboard/*). Zero duplicazione di codice.

const SUB_TABS = [
  { id: "players", label: "Giocatori", icon: "👥" },
  { id: "revenue", label: "Guadagni",  icon: "💶" },
];

export default function ClubControlView({ token, clubs }) {
  const { C, inputSt } = useTheme();
  const [clubId, setClubId]       = useState("");
  const [clubToken, setClubToken] = useState(null);
  const [clubName, setClubName]   = useState("");
  const [sub, setSub]             = useState("players");
  const [loading, setLoading]     = useState(false);
  const [err, setErr]             = useState("");

  // Cache token per clubId: non rifirmare a ogni render/cambio sub-tab.
  const tokenCache = useRef({});

  const enterClub = useCallback(async (id) => {
    if (!id) { setClubToken(null); setClubName(""); return; }
    if (tokenCache.current[id]) {
      const cached = tokenCache.current[id];
      setClubToken(cached.token); setClubName(cached.clubName); setErr("");
      return;
    }
    setLoading(true); setErr("");
    try {
      const r = await fetch(`/api/admin/clubs/${id}/impersonate`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      const d = await r.json();
      if (!r.ok || d.error || !d.token) throw new Error(d.error || "Impossibile entrare nel circolo");
      tokenCache.current[id] = { token: d.token, clubName: d.clubName };
      setClubToken(d.token); setClubName(d.clubName || "");
    } catch (e) {
      setErr(e.message); setClubToken(null); setClubName("");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { enterClub(clubId); }, [clubId, enterClub]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* Selettore circolo */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <select
          aria-label="Seleziona circolo"
          value={clubId}
          onChange={e => setClubId(e.target.value)}
          style={{ ...inputSt, width: "auto", minWidth: 220 }}
        >
          <option value="">— Seleziona un circolo —</option>
          {(clubs || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>

        {clubToken && (
          <div style={{ display: "flex", gap: 6 }}>
            {SUB_TABS.map(t => {
              const active = sub === t.id;
              return (
                <button
                  type="button" key={t.id} onClick={() => setSub(t.id)}
                  style={{
                    display: "inline-flex", alignItems: "center", gap: 6,
                    padding: "8px 16px", borderRadius: 9, cursor: "pointer",
                    fontSize: 13, fontFamily: "inherit",
                    fontWeight: active ? 700 : 400,
                    border: `1px solid ${active ? `${C.accent}55` : C.border}`,
                    background: active ? C.accentDim : "transparent",
                    color: active ? C.accent : C.muted,
                  }}
                >
                  <span>{t.icon}</span>{t.label}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Banner tracciamento */}
      {clubToken && (
        <div style={{
          fontSize: 12, color: C.warning,
          background: `${C.warning}12`, border: `1px solid ${C.warning}30`,
          borderRadius: 8, padding: "8px 14px",
        }}>
          🛡️ Stai operando sul circolo <strong>{clubName}</strong> come gestore. Ogni modifica viene registrata nell'audit log.
        </div>
      )}

      {/* Stati */}
      {err && (
        <div style={{ fontSize: 13, color: C.cancelled, background: `${C.cancelled}12`, border: `1px solid ${C.cancelled}30`, borderRadius: 8, padding: "10px 14px" }}>
          ⚠ {err}
        </div>
      )}
      {loading && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 24 }}>
          <Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Entro nel circolo…</span>
        </div>
      )}
      {!clubId && !loading && (
        <div style={{ padding: 40, textAlign: "center", color: C.muted, fontSize: 13 }}>
          Seleziona un circolo per gestirne giocatori e guadagni.
        </div>
      )}

      {/* Viste circolo riusate — key={clubId+sub} forza il reset di stato al cambio circolo */}
      {clubToken && !loading && (
        sub === "players"
          ? <PlayersView key={`players-${clubId}`} token={clubToken} />
          : <RevenueView key={`revenue-${clubId}`} token={clubToken} />
      )}
    </div>
  );
}
