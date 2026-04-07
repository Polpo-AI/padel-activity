import { useState } from "react";
import { C, btnGhost, btnSecondary } from "./shared/config";
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
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'DM Mono','Fira Code','Courier New',monospace", color: C.text }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes slideUp { from { transform: translateY(12px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
        input:focus, select:focus { outline: none; border-color: ${C.accentSoft} !important; box-shadow: 0 0 0 3px ${C.accentDim}; }
        button:disabled { opacity: 0.4; cursor: not-allowed; }
        ::-webkit-scrollbar { width: 5px; } ::-webkit-scrollbar-track { background: ${C.bg}; } ::-webkit-scrollbar-thumb { background: ${C.dim}; border-radius: 3px; }
        input[type="date"]::-webkit-calendar-picker-indicator,
        input[type="time"]::-webkit-calendar-picker-indicator { filter: invert(0.4); }
        input[type="range"] { accent-color: ${C.accent}; }
      `}</style>

      {/* Sidebar */}
      <div style={{ position: "fixed", left: 0, top: 0, bottom: 0, width: 210, background: C.surface, borderRight: `1px solid ${C.border}`, display: "flex", flexDirection: "column", padding: "24px 0" }}>
        <div style={{ padding: "0 20px 24px", borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{
              width: 36, height: 36, borderRadius: 10, fontSize: 18,
              background: `linear-gradient(135deg, ${C.indigoDim}, ${C.accentDim})`,
              border: `1px solid ${C.indigo}50`,
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>🎾</div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: C.text }}>{club?.name || "Padel"}</div>
              <div style={{ fontSize: 10, color: C.muted }}>Dashboard</div>
            </div>
          </div>
        </div>

        <nav style={{ padding: "16px 12px", flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
          {NAV.map(n => {
            const active = tab === n.id;
            return (
              <button key={n.id} onClick={() => setTab(n.id)} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: "10px 12px", borderRadius: 8, cursor: "pointer",
                border: active ? `1px solid ${C.indigo}35` : "1px solid transparent",
                background: active ? C.indigoDim : "transparent",
                color: active ? C.indigo : C.muted,
                fontSize: 13, textAlign: "left", transition: "all 0.12s",
                fontFamily: "inherit", fontWeight: active ? 600 : 400,
              }}>
                <span style={{ fontSize: 15 }}>{n.icon}</span>
                <span>{n.label}</span>
                {active && <span style={{ marginLeft: "auto", width: 5, height: 5, borderRadius: "50%", background: C.indigo, flexShrink: 0 }} />}
              </button>
            );
          })}
        </nav>

        <div style={{ padding: "16px 20px", borderTop: `1px solid ${C.border}` }}>
          <button onClick={() => { if (confirm("Vuoi uscire dalla dashboard?")) setToken(null); }} style={{ ...btnGhost, width: "100%", fontSize: 11 }}>Esci</button>
        </div>
      </div>

      {/* Content */}
      <div style={{ marginLeft: 210, padding: "32px 36px", maxWidth: 1300 }}>
        <div style={{ marginBottom: 28, paddingBottom: 20, borderBottom: `1px solid ${C.border}` }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 20 }}>{current?.icon}</span>
            <div>
              <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>{current?.label}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{current?.desc}</div>
            </div>
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
