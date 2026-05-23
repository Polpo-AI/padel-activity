import { useState, useEffect, useCallback } from "react";
import { useTheme } from "../../shared/ThemeContext";
import Spinner from "../../shared/Spinner";

const WA_COLOR = { open: "#22d3ee", connecting: "#f59e0b", closed: "#ef4444", disconnected: "#94a3b8" };
const WA_LABEL = { open: "Connesso", connecting: "Connessione…", closed: "Chiuso", disconnected: "—" };

function StatCard({ label, value, sub, color, icon }) {
  const { C } = useTheme();
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 22px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>{label}</div>
        <span style={{ fontSize: 18 }}>{icon}</span>
      </div>
      <div style={{ fontSize: 34, fontWeight: 700, color: color || C.accent, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted, marginTop: 6 }}>{sub}</div>}
    </div>
  );
}

function FillBar({ value }) {
  const { C } = useTheme();
  const pct = Math.round((value || 0) * 100);
  const color = pct >= 70 ? C.open : pct >= 40 ? C.warning : C.cancelled;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1 }}>
      <div style={{ flex: 1, height: 4, background: C.dim, borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: "100%", background: color, borderRadius: 2, transform: `scaleX(${pct / 100})`, transformOrigin: "left", transition: "transform 0.5s" }} />
      </div>
      <span style={{ fontSize: 11, color: C.muted, minWidth: 34, textAlign: "right" }}>{pct}%</span>
    </div>
  );
}

export default function OverviewView({ token }) {
  const { C } = useTheme();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/overview", { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setData(d);
    } catch { setData(null); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 40 }}><Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Caricamento...</span></div>;
  if (!data) return <div style={{ padding: 40, color: C.cancelled, fontSize: 13 }}>Errore nel caricamento</div>;

  const { totals, period, clubs } = data;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
      {/* KPI Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
        <StatCard label="Circoli attivi" value={totals.totalClubs} icon="🏟" color={C.accent} />
        <StatCard label="Giocatori totali" value={totals.totalPlayers} sub={`${totals.activePlayers} attivi`} icon="👥" />
        <StatCard label="Partite oggi" value={period.matchesToday} icon="🎾" />
        <StatCard label="Partite (30gg)" value={period.matchesThisMonth} icon="📅" />
        <StatCard label="Open ora" value={totals.openMatches} icon="🟢" color={C.open} />
        <StatCard label="Locked ora" value={totals.lockedMatches} icon="🔒" color={C.locked} />
        <StatCard label="Giocatori attivi (30gg)" value={period.recentlyActivePlayers} icon="✨" color={C.warning} />
        <StatCard label="Fill rate (30gg)" value={`${Math.round((period.fillRate || 0) * 100)}%`} icon="📊"
          color={(period.fillRate || 0) >= 0.7 ? C.open : (period.fillRate || 0) >= 0.4 ? C.warning : C.cancelled} />
      </div>

      {/* Per-club status table */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 14 }}>Stato circoli</div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 560 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {["Circolo", "Città", "Giocatori", "Partite (30gg)", "Fill rate", "WhatsApp"].map(h => (
                  <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(clubs || []).map((c, i) => (
                <tr key={c.id} style={{ borderBottom: i < clubs.length - 1 ? `1px solid ${C.border}` : "none", transition: "background 0.1s" }}
                  onMouseEnter={e => e.currentTarget.style.background = C.surfaceHover}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <td style={{ padding: "12px 16px", color: C.text, fontWeight: 600 }}>{c.name}</td>
                  <td style={{ padding: "12px 16px", color: C.muted }}>{c.city || "—"}</td>
                  <td style={{ padding: "12px 16px", color: C.text }}>{c.players}</td>
                  <td style={{ padding: "12px 16px", color: C.text }}>{c.matchesThisMonth}</td>
                  <td style={{ padding: "12px 16px", minWidth: 120 }}><FillBar value={c.fillRate} /></td>
                  <td style={{ padding: "12px 16px" }}>
                    <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, background: `${WA_COLOR[c.waStatus] || C.muted}22`, color: WA_COLOR[c.waStatus] || C.muted }}>
                      {WA_LABEL[c.waStatus] || c.waStatus}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {!clubs?.length && <div style={{ padding: 24, textAlign: "center", color: C.muted, fontSize: 13 }}>Nessun circolo</div>}
        </div>
      </div>
    </div>
  );
}
