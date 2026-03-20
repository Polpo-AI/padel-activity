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
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'DM Mono','Fira Code','Courier New',monospace", color: C.text }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slideUp { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        input:focus, select:focus { outline: none; border-color: ${C.accentSoft} !important; box-shadow: 0 0 0 3px ${C.accentDim}; }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-track { background: ${C.bg}; } ::-webkit-scrollbar-thumb { background: ${C.dim}; border-radius: 3px; }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: invert(0.4); }
      `}</style>

      {/* Sidebar */}
      <div style={{ position: "fixed", left: 0, top: 0, bottom: 0, width: 210, background: C.surface, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", padding: "24px 0" }}>
        <div style={{ padding: "0 20px 24px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 10, background: `#6b3fa022`, border: `1px solid #6b3fa066`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🛡️</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>Polpo AI</div>
              <div style={{ fontSize: 10, color: C.muted }}>Super Admin</div>
            </div>
          </div>
        </div>

        <nav style={{ padding: "16px 12px", flex: 1, display: "flex", flexDirection: "column", gap: 4 }}>
          {NAV.map(n => (
            <button key={n.id} onClick={() => setTab(n.id)} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "10px 12px", borderRadius: 8, border: "none", cursor: "pointer",
              background: tab === n.id ? C.accentDim : "transparent",
              color: tab === n.id ? C.accent : C.muted,
              fontSize: 13, textAlign: "left", transition: "all 0.12s",
              fontFamily: "inherit",
            }}>
              <span>{n.icon}</span><span>{n.label}</span>
            </button>
          ))}
        </nav>

        <div style={{ padding: "16px 20px", borderTop: `1px solid ${C.border}` }}>
          <button onClick={() => { if (confirm("Vuoi uscire dalla console admin?")) logout(); }}
            style={{ ...btnGhost, width: "100%", fontSize: 11 }}>Esci</button>
        </div>
      </div>

      {/* Content */}
      <div style={{ marginLeft: 210, padding: "32px 36px", maxWidth: 1400 }}>
        <div style={{ marginBottom: 28 }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: C.text }}>{current?.label}</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{current?.desc}</div>
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
