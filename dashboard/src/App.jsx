import { useState } from "react";
import { C, btnGhost } from "./shared/config";
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
  const [token, setToken] = useState(null);
  const [club, setClub] = useState(null);
  const [tab, setTab] = useState("courts");

  if (!token) return <LoginPage onLogin={(t, c) => { setToken(t); setClub(c); }} />;

  const current = NAV.find(n => n.id === tab);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Inter','Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,sans-serif", color: C.text }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slideUp { from { transform: translateY(10px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        input:focus, select:focus, textarea:focus {
          outline: none;
          border-color: rgba(6,182,212,0.50) !important;
          box-shadow: 0 0 0 3px rgba(6,182,212,0.18) !important;
        }
        button:disabled { opacity: 0.35; cursor: not-allowed; }
        button:not(:disabled):active { transform: scale(0.97); }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 4px; }
        ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.22); }
        input[type="date"]::-webkit-calendar-picker-indicator,
        input[type="time"]::-webkit-calendar-picker-indicator { filter: invert(0.5); }
        input[type="range"] { accent-color: #06b6d4; }
        ::selection { background: rgba(6,182,212,0.30); color: ${C.text}; }
      `}</style>

      {/* Ambient gradient orbs */}
      <div style={{ position: "fixed", top: -200, right: -200, width: 700, height: 700, borderRadius: "50%", background: "radial-gradient(circle, rgba(34,211,238,0.09) 0%, transparent 70%)", pointerEvents: "none", zIndex: 0 }} />
      <div style={{ position: "fixed", bottom: -200, left: -100, width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, rgba(167,139,250,0.07) 0%, transparent 70%)", pointerEvents: "none", zIndex: 0 }} />

      {/* Sidebar */}
      <div style={{
        position: "fixed", left: 0, top: 0, bottom: 0, width: 220,
        background: "rgba(13,20,40,0.85)",
        backdropFilter: "blur(20px) saturate(1.4)",
        borderRight: `1px solid ${C.border}`,
        display: "flex", flexDirection: "column",
        zIndex: 10,
      }}>
        {/* Logo */}
        <div style={{ padding: "22px 20px 20px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 11 }}>
            <div style={{
              width: 34, height: 34, borderRadius: 10, fontSize: 16,
              background: `linear-gradient(135deg, ${C.accent}25, ${C.accent}08)`,
              border: `1px solid ${C.accent}35`,
              display: "flex", alignItems: "center", justifyContent: "center",
              boxShadow: `0 0 12px ${C.accent}20`,
            }}>🎾</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text, lineHeight: 1.2 }}>
                {club?.name || "Padel"}
              </div>
              <div style={{ fontSize: 10, color: C.muted, marginTop: 2, letterSpacing: "0.05em" }}>
                Dashboard
              </div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav style={{ padding: "12px 10px", flex: 1, display: "flex", flexDirection: "column", gap: 1, overflowY: "auto" }}>
          {NAV.map(n => {
            const active = tab === n.id;
            return (
              <button key={n.id} onClick={() => setTab(n.id)} style={{
                display: "flex", alignItems: "center", gap: 9,
                padding: "9px 12px",
                borderRadius: 8,
                cursor: "pointer",
                border: "none",
                background: active ? `${C.accent}10` : "transparent",
                color: active ? C.accent : C.muted,
                fontSize: 12, textAlign: "left", transition: "all 0.12s",
                fontFamily: "inherit", fontWeight: active ? 600 : 400,
                position: "relative",
                paddingLeft: 16,
              }}>
                {active && (
                  <div style={{
                    position: "absolute", left: 0, top: "20%", bottom: "20%",
                    width: 3, borderRadius: 2,
                    background: C.accent,
                    boxShadow: `0 0 8px ${C.accent}80`,
                  }} />
                )}
                <span style={{ fontSize: 14 }}>{n.icon}</span>
                <span>{n.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Footer */}
        <div style={{ padding: "14px 10px", borderTop: `1px solid ${C.border}` }}>
          <button
            onClick={() => { if (confirm("Vuoi uscire dalla dashboard?")) setToken(null); }}
            style={{ ...btnGhost, width: "100%", fontSize: 11, borderRadius: 8 }}
          >
            Esci
          </button>
        </div>
      </div>

      {/* Main content */}
      <div style={{ marginLeft: 220, padding: "32px 40px", maxWidth: 1320, position: "relative", zIndex: 1 }}>
        {/* Page header */}
        <div style={{ marginBottom: 32 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
            <span style={{ fontSize: 22 }}>{current?.icon}</span>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: C.text, letterSpacing: "-0.02em" }}>
              {current?.label}
            </h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 28, height: 2, borderRadius: 2, background: C.accent, boxShadow: `0 0 8px ${C.accent}60` }} />
            <div style={{ fontSize: 12, color: C.muted }}>{current?.desc}</div>
          </div>
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
