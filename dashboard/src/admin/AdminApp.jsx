import { useState, useEffect } from "react";
import { C, btnGhost } from "../shared/config";
import AdminLoginPage from "./AdminLoginPage";
import OverviewView from "./views/OverviewView";
import ClubsView from "./views/ClubsView";
import MatchesView from "./views/MatchesView";
import PlayersAdminView from "./views/PlayersView";
import SystemView from "./views/SystemView";

const NAV = [
  { id: "overview",  label: "Overview",    icon: "📊", desc: "KPI aggregati su tutti i circoli." },
  { id: "clubs",     label: "Circoli",     icon: "🏟", desc: "Gestisci tutti i circoli, configurazioni e statistiche." },
  { id: "matches",   label: "Partite",     icon: "🎾", desc: "Tutte le partite cross-club con filtri." },
  { id: "players",   label: "Giocatori",   icon: "👥", desc: "Tutti i giocatori cross-club, ricerca e filtri." },
  { id: "system",    label: "Sistema",     icon: "⚙️", desc: "Stato WhatsApp per circolo, DB e Redis." },
];

export default function AdminApp() {
  const [token, setToken] = useState(() => sessionStorage.getItem("admin_token") || null);
  const [tab, setTab] = useState("overview");
  const [clubs, setClubs] = useState([]);

  // Precarica lista circoli (serve ai filtri di Matches e Players)
  useEffect(() => {
    if (!token) return;
    fetch("/api/admin/clubs", { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => { if (Array.isArray(d)) setClubs(d); })
      .catch(() => {});
  }, [token]);

  const login = (t) => { sessionStorage.setItem("admin_token", t); setToken(t); };
  const logout = () => { sessionStorage.removeItem("admin_token"); setToken(null); };

  if (!token) return <AdminLoginPage onLogin={login} />;

  const current = NAV.find(n => n.id === tab);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Inter','Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,sans-serif", color: C.text }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slideUp { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        input:focus, select:focus { outline: none; border-color: rgba(6,182,212,0.50) !important; box-shadow: 0 0 0 3px rgba(6,182,212,0.18) !important; }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        button:not(:disabled):active { transform: scale(0.97); }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.4); }
        ::selection { background: rgba(6,182,212,0.30); color: ${C.text}; }
      `}</style>

      {/* Ambient gradient orbs — aurora-bg da stunning-broccoli */}
      <div style={{ position: "fixed", top: -200, right: -150, width: 700, height: 700, borderRadius: "50%", background: "radial-gradient(circle, rgba(34,211,238,0.09) 0%, transparent 70%)", pointerEvents: "none", zIndex: 0 }} />
      <div style={{ position: "fixed", bottom: -150, left: -100, width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, rgba(139,92,246,0.08) 0%, transparent 70%)", pointerEvents: "none", zIndex: 0 }} />
      <div style={{ position: "fixed", top: "35%", left: "40%", transform: "translate(-50%,-50%)", width: 800, height: 800, borderRadius: "50%", background: "radial-gradient(circle, rgba(255,61,138,0.06) 0%, transparent 65%)", pointerEvents: "none", zIndex: 0 }} />

      {/* Sidebar */}
      <div style={{ position: "fixed", left: 0, top: 0, bottom: 0, width: 214, background: "rgba(11,18,40,0.90)", backdropFilter: "blur(24px) saturate(1.5)", borderRight: "1px solid rgba(255,255,255,0.08)", display: "flex", flexDirection: "column", padding: "24px 0", zIndex: 10 }}>
        <div style={{ padding: "0 20px 24px", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 12, background: "linear-gradient(135deg, rgba(167,139,250,0.22), rgba(139,92,246,0.12))", border: "1px solid rgba(167,139,250,0.30)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, boxShadow: "0 0 18px rgba(139,92,246,0.20)" }}>🛡️</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Fraunces', Georgia, serif", background: "linear-gradient(135deg, #f8fafc, #cbd5e1)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>Polpo AI</div>
              <div style={{ fontSize: 10, color: C.muted, letterSpacing: "0.06em", textTransform: "uppercase" }}>Super Admin</div>
            </div>
          </div>
        </div>

        <nav style={{ padding: "12px 10px", flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          {NAV.map(n => {
            const active = tab === n.id;
            return (
              <button key={n.id} onClick={() => setTab(n.id)} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "9px 12px 9px 16px", borderRadius: 9, border: "none", cursor: "pointer",
                background: active ? "rgba(6,182,212,0.10)" : "transparent",
                fontSize: 12.5, textAlign: "left",
                transition: "all 0.15s cubic-bezier(0.23,1,0.32,1)",
                fontFamily: "inherit", fontWeight: active ? 600 : 400,
                position: "relative",
                color: active ? "transparent" : C.muted,
              }}>
                {active && <div style={{ position: "absolute", left: 0, top: "18%", bottom: "18%", width: 3, borderRadius: 2, background: "linear-gradient(to bottom, #22d3ee, #a78bfa)", boxShadow: "0 0 10px rgba(34,211,238,0.60)" }} />}
                <span style={{ fontSize: 14, filter: active ? "drop-shadow(0 0 5px rgba(34,211,238,0.5))" : undefined }}>{n.icon}</span>
                {active
                  ? <span style={{ background: "linear-gradient(135deg, #22d3ee, #a78bfa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>{n.label}</span>
                  : <span>{n.label}</span>
                }
              </button>
            );
          })}
        </nav>

        <div style={{ padding: "16px 20px", borderTop: "1px solid rgba(255,255,255,0.07)" }}>
          <button onClick={() => { if (confirm("Vuoi uscire dalla console admin?")) logout(); }}
            style={{ ...btnGhost, width: "100%", fontSize: 11 }}>Esci</button>
        </div>
      </div>

      {/* Content */}
      <div style={{ marginLeft: 214, padding: "36px 44px", maxWidth: 1400, position: "relative", zIndex: 1 }}>
        <div style={{ marginBottom: 36 }}>
          {/* Eyebrow */}
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", background: "linear-gradient(135deg, #22d3ee, #a78bfa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text", marginBottom: 10 }}>
            <span style={{ display: "block", width: 24, height: 2, borderRadius: 2, background: "linear-gradient(90deg, #22d3ee, #a78bfa)", WebkitTextFillColor: "initial" }} />
            {current?.label}
          </div>
          {/* Title Fraunces */}
          <div style={{ fontSize: 32, fontWeight: 300, letterSpacing: "-0.02em", lineHeight: 1.05, fontFamily: "'Fraunces', Georgia, serif", background: "linear-gradient(135deg, #f8fafc 0%, #cbd5e1 60%, #94a3b8 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text", marginBottom: 10 }}>{current?.label}</div>
          <div style={{ fontSize: 13, color: C.muted }}>{current?.desc}</div>
        </div>

        {tab === "overview" && <OverviewView token={token} />}
        {tab === "clubs"    && <ClubsView    token={token} />}
        {tab === "matches"  && <MatchesView  token={token} clubs={clubs} />}
        {tab === "players"  && <PlayersAdminView token={token} clubs={clubs} />}
        {tab === "system"   && <SystemView   token={token} />}
      </div>
    </div>
  );
}
