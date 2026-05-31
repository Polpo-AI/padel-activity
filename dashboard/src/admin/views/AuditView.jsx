import { useState, useEffect, useCallback } from "react";
import { useTheme, useMobile } from "../../shared/ThemeContext";
import Spinner from "../../shared/Spinner";

// Colore/etichetta per tipo di azione
function actionMeta(action, C) {
  if (action === "IMPERSONATE_ENTER") return { color: C.accent, label: "Ingresso circolo" };
  if (action.startsWith("DELETE")) return { color: C.cancelled, label: action };
  if (action.startsWith("POST") || action.startsWith("PATCH")) return { color: C.warning, label: action };
  return { color: C.muted, label: action };
}

export default function AuditView({ token, clubs }) {
  const { C, inputSt } = useTheme();
  const isMobile = useMobile();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [clubId, setClubId] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = clubId ? `?clubId=${clubId}` : "";
      const r = await fetch(`/api/admin/audit${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      setLogs(Array.isArray(d) ? d : []);
    } catch { setLogs([]); }
    finally { setLoading(false); }
  }, [token, clubId]);

  useEffect(() => { load(); }, [load]);

  const fmt = (d) => new Date(d).toLocaleString("it-IT", {
    timeZone: "Europe/Rome", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: C.muted }}>Traccia di chi è entrato nei circoli e cosa ha modificato in modalità admin.</span>
        <div style={{ flex: 1 }} />
        <select value={clubId} onChange={(e) => setClubId(e.target.value)} style={{ ...inputSt, width: "auto", minWidth: 160 }}>
          <option value="">Tutti i circoli</option>
          {(clubs || []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      {loading ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 28, justifyContent: "center" }}>
          <Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Caricamento...</span>
        </div>
      ) : logs.length === 0 ? (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 32, textAlign: "center", color: C.muted, fontSize: 13 }}>
          Nessuna attività admin registrata.
        </div>
      ) : isMobile ? (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
          {logs.map((l, i) => {
            const m = actionMeta(l.action, C);
            return (
              <div key={l.id} style={{ padding: "12px 14px", borderBottom: i < logs.length - 1 ? `1px solid ${C.border}` : "none", display: "flex", flexDirection: "column", gap: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 600, color: m.color }}>{m.label}</span>
                  <span style={{ fontSize: 11, color: C.muted }}>{fmt(l.createdAt)}</span>
                </div>
                <div style={{ fontSize: 12, color: C.muted }}>
                  <strong style={{ color: C.text }}>{l.actor}</strong>{l.clubName ? ` · ${l.clubName}` : ""}{l.detail ? ` · ${l.detail}` : ""}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 620 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {["Quando", "Admin", "Circolo", "Azione", "Dettaglio"].map((h) => (
                    <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.map((l, i) => {
                  const m = actionMeta(l.action, C);
                  return (
                    <tr key={l.id} style={{ borderBottom: i < logs.length - 1 ? `1px solid ${C.dim}` : "none" }}>
                      <td style={{ padding: "10px 16px", color: C.muted, whiteSpace: "nowrap" }}>{fmt(l.createdAt)}</td>
                      <td style={{ padding: "10px 16px", color: C.text, fontWeight: 600 }}>{l.actor}</td>
                      <td style={{ padding: "10px 16px", color: C.muted }}>{l.clubName || "—"}</td>
                      <td style={{ padding: "10px 16px", color: m.color, fontWeight: 600 }}>{m.label}</td>
                      <td style={{ padding: "10px 16px", color: C.muted }}>{l.detail || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
