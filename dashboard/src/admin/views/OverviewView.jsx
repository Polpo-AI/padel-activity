import { useState, useEffect, useCallback } from "react";
import { useTheme } from "../../shared/ThemeContext";
import Spinner from "../../shared/Spinner";

const WA_LABEL  = { open: "Connesso", connecting: "Connessione…", closed: "Chiuso", disconnected: "—" };
const WA_COLOR  = (status, C) => ({ open: C.open, connecting: C.warning, closed: C.cancelled, disconnected: C.muted }[status] || C.muted);

function StatCard({ label, value, sub, color, icon }) {
  const { C } = useTheme();
  const c = color || C.accent;
  return (
    <div style={{
      position: "relative", overflow: "hidden",
      background: `linear-gradient(135deg, ${c}1A 0%, ${C.surface} 55%)`,
      border: `1px solid ${c}33`,
      borderRadius: 16, padding: "20px 22px",
      boxShadow: `0 8px 32px ${c}1f`,
    }}>
      <div style={{ position: "absolute", top: -26, right: -26, width: 120, height: 120, borderRadius: "50%", background: `radial-gradient(circle, ${c}26 0%, transparent 70%)`, pointerEvents: "none" }} />
      <div style={{ position: "relative", display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>{label}</div>
        <span style={{ fontSize: 18 }}>{icon}</span>
      </div>
      <div style={{ position: "relative", fontSize: 34, fontWeight: 800, color: c, fontVariantNumeric: "tabular-nums", lineHeight: 1, textShadow: `0 0 24px ${c}55` }}>{value}</div>
      {sub && <div style={{ position: "relative", fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.4 }}>{sub}</div>}
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
        <div style={{ height: "100%", width: `${pct}%`, background: color, borderRadius: 2, transition: "width 0.5s" }} />
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
  const convPct = Math.round((period.fillRate || 0) * 100);
  const convColor = convPct >= 30 ? C.open : convPct >= 15 ? C.warning : C.cancelled;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>

      {/* KPI principali */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 14 }}>
        <StatCard label="Revenue (30 giorni)" value={`€${Math.round(totals.totalRevenue || 0).toLocaleString("it-IT")}`} sub="Partite confermate × tariffa campo" icon="💰" color={C.emerald} />
        <StatCard label="Circoli attivi" value={totals.totalClubs} icon="🏟" color={C.accent} />
        <StatCard label="Giocatori totali" value={totals.totalPlayers} sub={`${totals.activePlayers} attivi`} icon="👥" color={C.indigo} />
        <StatCard label="Partite oggi" value={period.matchesToday} icon="🎾" color={C.emerald} />
        <StatCard label="Partite (30 giorni)" value={period.matchesThisMonth} sub={`${period.recentlyActivePlayers} giocatori attivi`} icon="📅" color={C.siteBlue} />
        <StatCard label="In corso / aperte" value={totals.openMatches} icon="🟢" color={C.open} />
        <StatCard label="Confermate" value={totals.lockedMatches} icon="🔒" color={C.locked} />
        <StatCard
          label="Accettazione inviti"
          value={`${convPct}%`}
          sub="Giocatori che accettano l'invito del bot"
          icon="📩"
          color={convColor}
          highlight={convPct >= 30}
        />
      </div>

      {/* Tabella per circolo */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 14 }}>Stato circoli</div>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 560 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {["Circolo", "Città", "Giocatori", "Partite (30gg)", "Accettazione", "WhatsApp"].map(h => (
                    <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(clubs || []).map((c, i) => (
                  <tr key={c.id}
                    style={{ borderBottom: i < clubs.length - 1 ? `1px solid ${C.border}` : "none", transition: "background 0.1s" }}
                    onMouseEnter={e => e.currentTarget.style.background = C.surfaceHover}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <td style={{ padding: "12px 16px", color: C.text, fontWeight: 600 }}>{c.name}</td>
                    <td style={{ padding: "12px 16px", color: C.muted }}>{c.city || "—"}</td>
                    <td style={{ padding: "12px 16px", color: C.text }}>{c.players}</td>
                    <td style={{ padding: "12px 16px", color: C.text }}>{c.matchesThisMonth}</td>
                    <td style={{ padding: "12px 16px", minWidth: 120 }}><FillBar value={c.fillRate} /></td>
                    <td style={{ padding: "12px 16px" }}>
                      <span style={{
                        fontSize: 11, padding: "3px 8px", borderRadius: 4,
                        background: `${WA_COLOR(c.waStatus, C)}22`,
                        color: WA_COLOR(c.waStatus, C),
                      }}>
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
