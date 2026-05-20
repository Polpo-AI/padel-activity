import { useState } from "react";
import { useTheme } from "./shared/ThemeContext";
import LoginPage from "./features/auth/LoginPage";
import CourtsView from "./features/courts/CourtsView";
import PricesView from "./features/prices/PricesView";
import PlayersView from "./features/players/PlayersView";
import StatsView from "./features/stats/StatsView";
import SystemView from "./features/system/SystemView";
import SettingsView from "./features/settings/SettingsView";
import FaqsView from "./features/faqs/FaqsView";

const NAV = [
  { id: "courts",   label: "Campi & Partite", icon: "🏟", desc: "Griglia campi in tempo reale. Gestisci partite, orari e blocchi." },
  { id: "prices",   label: "Tariffe",         icon: "💵", desc: "Gestisci prezzi standard ed eccezioni di calendario." },
  { id: "players",  label: "Utenti",           icon: "👥", desc: "Anagrafica giocatori. Cerca, modifica livello, attiva/disattiva." },
  { id: "stats",    label: "Statistiche",      icon: "📊", desc: "Performance del circolo. Fill rate, affidabilità, wave lanciate." },
  { id: "faqs",     label: "FAQ",              icon: "💬", desc: "Gestisci le domande frequenti. Analisi AI per deduplicazione e merge automatici." },
  { id: "system",   label: "Sistema",          icon: "⚙️", desc: "Health check infrastruttura. Redis, WhatsApp, sicurezza API." },
  { id: "settings", label: "Impostazioni",     icon: "🛠", desc: "Configurazione circolo e checklist SaaS readiness." },
];

export default function PadelDashboard() {
  const { C, btnGhost, mode, toggle } = useTheme();
  const [token, setToken] = useState(null);
  const [club, setClub] = useState(null);
  const [tab, setTab] = useState("courts");

  if (!token) return <LoginPage onLogin={(t, c) => { setToken(t); setClub(c); }} />;

  const current = NAV.find(n => n.id === tab);
  const dark = mode === "dark";

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Inter','Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,sans-serif", color: C.text, transition: "background 0.3s, color 0.3s" }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slideUp { from { transform: translateY(10px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        input:focus, select:focus, textarea:focus {
          outline: none;
          border-color: rgba(6,182,212,0.55) !important;
          box-shadow: 0 0 0 3px rgba(6,182,212,0.18) !important;
        }
        button:disabled { opacity: 0.35; cursor: not-allowed; }
        button:not(:disabled):active { transform: scale(0.97); }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: linear-gradient(to bottom, #22d3ee, #a78bfa); border-radius: 4px; }
        input[type="date"]::-webkit-calendar-picker-indicator,
        input[type="time"]::-webkit-calendar-picker-indicator { filter: ${dark ? "invert(0.5)" : "invert(0.3)"}; }
        input[type="range"] { accent-color: #06b6d4; }
        ::selection { background: rgba(6,182,212,0.30); }
        .gradient-text {
          background: linear-gradient(135deg, #22d3ee 0%, #06b6d4 50%, #a78bfa 100%);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
        }
        .eyebrow {
          display: inline-flex; align-items: center; gap: 8px;
          font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
          background: linear-gradient(135deg, #22d3ee, #a78bfa);
          -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
        }
        .eyebrow::before {
          content: ''; display: block; width: 24px; height: 2px; border-radius: 2px;
          background: linear-gradient(90deg, #22d3ee, #a78bfa); flex-shrink: 0;
        }
        .nav-btn:hover { background: ${dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)"} !important; color: ${C.text} !important; }
        .nav-btn.active { background: rgba(6,182,212,0.10) !important; }
      `}</style>

      {/* Aurora orbs */}
      <div style={{ position: "fixed", top: -180, right: -120, width: 750, height: 750, borderRadius: "50%", background: `radial-gradient(circle, ${C.orbCyan} 0%, transparent 70%)`, pointerEvents: "none", zIndex: 0, transition: "0.5s" }} />
      <div style={{ position: "fixed", bottom: -120, left: -80, width: 650, height: 650, borderRadius: "50%", background: `radial-gradient(circle, ${C.orbViolet} 0%, transparent 70%)`, pointerEvents: "none", zIndex: 0, transition: "0.5s" }} />
      <div style={{ position: "fixed", top: "40%", left: "45%", transform: "translate(-50%,-50%)", width: 900, height: 900, borderRadius: "50%", background: `radial-gradient(circle, ${C.orbPink} 0%, transparent 65%)`, pointerEvents: "none", zIndex: 0, transition: "0.5s" }} />

      {/* Sidebar */}
      <div style={{
        position: "fixed", left: 0, top: 0, bottom: 0, width: 224,
        background: C.sidebarBg,
        backdropFilter: "blur(24px) saturate(1.5)",
        borderRight: `1px solid ${C.sidebarBorder}`,
        display: "flex", flexDirection: "column",
        zIndex: 10, transition: "background 0.3s, border-color 0.3s",
      }}>
        {/* Logo */}
        <div style={{ padding: "24px 20px 20px", borderBottom: `1px solid ${C.sidebarSep}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 12, fontSize: 18,
              background: "linear-gradient(135deg, rgba(34,211,238,0.20), rgba(167,139,250,0.12))",
              border: "1px solid rgba(34,211,238,0.30)",
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: "0 0 20px rgba(34,211,238,0.20), inset 0 1px 0 rgba(255,255,255,0.08)",
            }}>🎾</div>
            <div>
              <div style={{
                fontSize: 14, fontWeight: 700, lineHeight: 1.2,
                fontFamily: "'Fraunces', Georgia, serif",
                background: C.titleGradient,
                WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
              }}>
                {club?.name || "Padel"}
              </div>
              <div style={{ fontSize: 10, color: C.muted, marginTop: 2, letterSpacing: "0.06em", textTransform: "uppercase" }}>
                Dashboard
              </div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ padding: "12px 10px", flex: 1, display: "flex", flexDirection: "column", gap: 2, overflowY: "auto" }}>
          {NAV.map(n => {
            const active = tab === n.id;
            return (
              <button key={n.id} onClick={() => setTab(n.id)}
                className={`nav-btn${active ? " active" : ""}`}
                style={{
                  display: "flex", alignItems: "center", gap: 9,
                  padding: "9px 12px 9px 16px",
                  borderRadius: 9, cursor: "pointer", border: "none",
                  background: active ? "rgba(6,182,212,0.10)" : "transparent",
                  fontSize: 12.5, textAlign: "left",
                  transition: "all 0.15s cubic-bezier(0.23,1,0.32,1)",
                  fontFamily: "inherit", fontWeight: active ? 600 : 400,
                  position: "relative", color: active ? "transparent" : C.muted,
                }}>
                {active && (
                  <div style={{
                    position: "absolute", left: 0, top: "18%", bottom: "18%",
                    width: 3, borderRadius: 2,
                    background: "linear-gradient(to bottom, #22d3ee, #a78bfa)",
                    boxShadow: "0 0 10px rgba(34,211,238,0.60)",
                  }} />
                )}
                {active ? (
                  <>
                    <span style={{ fontSize: 14, filter: "drop-shadow(0 0 6px rgba(34,211,238,0.5))" }}>{n.icon}</span>
                    <span style={{ background: "linear-gradient(135deg, #22d3ee, #a78bfa)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>{n.label}</span>
                  </>
                ) : (
                  <>
                    <span style={{ fontSize: 14 }}>{n.icon}</span>
                    <span>{n.label}</span>
                  </>
                )}
              </button>
            );
          })}
        </nav>

        {/* Footer — toggle + esci */}
        <div style={{ padding: "14px 10px", borderTop: `1px solid ${C.sidebarSep}`, display: "flex", gap: 6 }}>
          <button
            onClick={toggle}
            title={dark ? "Passa a light mode" : "Passa a dark mode"}
            style={{ ...btnGhost, padding: "7px 10px", borderRadius: 8, fontSize: 15, lineHeight: 1, flexShrink: 0 }}
          >
            {dark ? "☀️" : "🌙"}
          </button>
          <button
            onClick={() => { if (confirm("Vuoi uscire dalla dashboard?")) setToken(null); }}
            style={{ ...btnGhost, flex: 1, fontSize: 11, borderRadius: 8 }}
          >
            Esci
          </button>
        </div>
      </div>

      {/* Main content */}
      <div style={{ marginLeft: 224, padding: "36px 44px", maxWidth: 1340, position: "relative", zIndex: 1 }}>
        {/* Page header */}
        <div style={{ marginBottom: 36 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>{current?.label}</div>
          <h1 style={{
            fontSize: 32, fontWeight: 300, letterSpacing: "-0.02em", lineHeight: 1.05,
            fontFamily: "'Fraunces', Georgia, serif",
            background: C.titleGradient,
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
            marginBottom: 10,
          }}>
            {current?.label}
          </h1>
          <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5 }}>{current?.desc}</div>
        </div>

        {tab === "courts"   && <CourtsView   token={token} onClubUpdate={setClub} />}
        {tab === "prices"   && <PricesView   token={token} />}
        {tab === "players"  && <PlayersView  token={token} club={club} />}
        {tab === "stats"    && <StatsView    token={token} />}
        {tab === "faqs"     && <FaqsView     token={token} />}
        {tab === "system"   && <SystemView   token={token} />}
        {tab === "settings" && <SettingsView token={token} club={club} onClubUpdate={setClub} />}
      </div>
    </div>
  );
}
