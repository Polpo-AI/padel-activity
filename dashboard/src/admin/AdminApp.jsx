import { useState, useEffect } from "react";
import { useTheme } from "../shared/ThemeContext";
import ThemeToggle from "../shared/ThemeToggle";
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
  const { C, btnGhost, mode } = useTheme();
  const [token, setToken] = useState(() => sessionStorage.getItem("admin_token") || null);
  const [tab, setTab] = useState("overview");
  const [clubs, setClubs] = useState([]);
  const dark = mode === "dark";

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
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Inter','Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,sans-serif", color: C.text, transition: "background 0.3s, color 0.3s" }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slideUp { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        input:focus, select:focus { outline: none; border-color: rgba(6,182,212,0.55) !important; box-shadow: 0 0 0 3px rgba(6,182,212,0.18) !important; }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        button:not(:disabled):active { transform: scale(0.97); }
        button:focus-visible { box-shadow: 0 0 0 3px ${C.accentSoft} !important; outline: none; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: linear-gradient(to bottom, #22d3ee, #a78bfa); border-radius: 4px; }
        input[type="date"]::-webkit-calendar-picker-indicator { filter: ${dark ? "invert(0.4)" : "invert(0.3)"}; }
        ::selection { background: rgba(6,182,212,0.30); }
        .nav-btn:hover { background: ${dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)"} !important; color: ${C.text} !important; }
      `}</style>

      {/* Theme toggle pill — top-right fixed */}
      <ThemeToggle />

      {/* Aurora orbs — solo angoli */}
      <div style={{ position: "fixed", top: -200, right: -150, width: 600, height: 600, borderRadius: "50%", background: `radial-gradient(circle, ${C.orbCyan} 0%, transparent 70%)`, pointerEvents: "none", zIndex: 0, transition: "background 0.5s, opacity 0.5s", willChange: "opacity" }} />
      <div style={{ position: "fixed", bottom: -150, left: -100, width: 500, height: 500, borderRadius: "50%", background: `radial-gradient(circle, ${C.orbViolet} 0%, transparent 70%)`, pointerEvents: "none", zIndex: 0, transition: "background 0.5s, opacity 0.5s", willChange: "opacity" }} />

      {/* Sidebar */}
      <div style={{ position: "fixed", left: 0, top: 0, bottom: 0, width: 214, background: C.sidebarBg, borderRight: `1px solid ${C.sidebarBorder}`, display: "flex", flexDirection: "column", padding: "24px 0", zIndex: 10, transition: "background 0.3s, border-color 0.3s" }}>
        <div style={{ padding: "0 20px 24px", borderBottom: `1px solid ${C.sidebarSep}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: 12, background: "linear-gradient(135deg, rgba(167,139,250,0.22), rgba(139,92,246,0.12))", border: "1px solid rgba(167,139,250,0.30)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, boxShadow: "0 0 18px rgba(139,92,246,0.20)" }}>🛡️</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, fontFamily: "'Fraunces', Georgia, serif", color: C.titleColor }}>Polpo AI</div>
              <div style={{ fontSize: 10, color: C.muted, letterSpacing: "0.06em", textTransform: "uppercase" }}>Super Admin</div>
            </div>
          </div>
        </div>

        <nav style={{ padding: "12px 10px", flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          {NAV.map(n => {
            const active = tab === n.id;
            return (
              <button key={n.id} type="button" onClick={() => setTab(n.id)} aria-label={n.label} aria-current={active ? "page" : undefined} className={`nav-btn${active ? " active" : ""}`} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "9px 12px 9px 16px", borderRadius: 9, border: "none", cursor: "pointer",
                background: active ? "rgba(6,182,212,0.10)" : "transparent",
                fontSize: 12.5, textAlign: "left",
                transition: "all 0.15s cubic-bezier(0.23,1,0.32,1)",
                fontFamily: "inherit", fontWeight: active ? 600 : 400,
                position: "relative", color: active ? C.accent : C.muted,
              }}>
                {active && <div style={{ position: "absolute", left: 0, top: "18%", bottom: "18%", width: 3, borderRadius: 2, background: C.accent, boxShadow: `0 0 10px ${C.accentSoft}` }} />}
                <span style={{ fontSize: 14 }}>{n.icon}</span>
                <span>{n.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Footer — esci */}
        <div style={{ padding: "14px 10px", borderTop: `1px solid ${C.sidebarSep}` }}>
          <button type="button" onClick={() => { if (confirm("Vuoi uscire dalla console admin?")) logout(); }}
            style={{ ...btnGhost, width: "100%", fontSize: 11 }}>Esci</button>
        </div>
      </div>

      {/* Content */}
      <div style={{ marginLeft: 214, padding: "36px 44px", maxWidth: 1400, position: "relative", zIndex: 1 }}>
        <div style={{ marginBottom: 36 }}>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: C.accent, marginBottom: 10 }}>
            <span style={{ display: "block", width: 24, height: 2, borderRadius: 2, background: C.accent }} />
            {current?.label}
          </div>
          <div style={{ fontSize: 32, fontWeight: 300, letterSpacing: "-0.02em", lineHeight: 1.05, fontFamily: "'Fraunces', Georgia, serif", color: C.titleColor, marginBottom: 10 }}>{current?.label}</div>
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
