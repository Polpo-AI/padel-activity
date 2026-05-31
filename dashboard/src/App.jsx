import { useState, useEffect } from "react";
import { useTheme, useMobile } from "./shared/ThemeContext";
import ThemeToggle from "./shared/ThemeToggle";
import LoginPage from "./features/auth/LoginPage";
import CourtsView from "./features/courts/CourtsView";
import PricesView from "./features/prices/PricesView";
import PlayersView from "./features/players/PlayersView";
import StatsView from "./features/stats/StatsView";
import RevenueView from "./features/revenue/RevenueView";
import SystemView from "./features/system/SystemView";
import SettingsView from "./features/settings/SettingsView";
import FaqsView from "./features/faqs/FaqsView";

const NAV = [
  { id: "courts",   label: "Campi & Partite", icon: "🏟", desc: "Griglia campi in tempo reale. Gestisci partite, orari e blocchi." },
  { id: "prices",   label: "Tariffe",         icon: "💵", desc: "Gestisci prezzi standard ed eccezioni di calendario." },
  { id: "players",  label: "Giocatori",         icon: "👥", desc: "Anagrafica giocatori. Cerca, modifica livello, attiva/disattiva." },
  { id: "stats",    label: "Statistiche",      icon: "📊", desc: "Performance del circolo. Fill rate, affidabilità, wave lanciate." },
  { id: "revenue",  label: "Guadagni",         icon: "💰", desc: "Quanto incassa il circolo grazie al bot. Mese, anno e confronto tra periodi." },
  { id: "faqs",     label: "FAQ",              icon: "💬", desc: "Gestisci le domande frequenti. Analisi AI per deduplicazione e merge automatici." },
  { id: "system",   label: "Sistema",          icon: "⚙️", desc: "Health check infrastruttura. Redis, WhatsApp, sicurezza API." },
  { id: "settings", label: "Impostazioni",     icon: "🛠", desc: "Configurazione circolo e checklist SaaS readiness." },
];

const SIDEBAR_W = 224;

export default function PadelDashboard() {
  const { C, btnGhost, mode } = useTheme();
  const dark = mode === "dark";
  const [token, setToken] = useState(null);
  const [club, setClub] = useState(null);
  const [tab, setTab] = useState("courts");
  const [impersonation, setImpersonation] = useState(null); // nome circolo se admin sta impersonando
  const isMobile = useMobile();

  // Impersonation admin (Punto 7): token passato via #imp=<token>&club=<nome>.
  useEffect(() => {
    const h = window.location.hash || "";
    if (h.startsWith("#imp=")) {
      const params = new URLSearchParams(h.slice(1));
      const impToken = params.get("imp");
      const clubName = params.get("club");
      if (impToken) {
        setToken(impToken);
        setClub(clubName ? { name: clubName } : null);
        setImpersonation(clubName || "circolo");
        // Pulisci l'URL (non lasciare il token nella barra)
        window.history.replaceState(null, "", window.location.pathname);
      }
    }
  }, []);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Tornando a desktop, chiudi sempre l'overlay sidebar mobile.
  useEffect(() => {
    if (!isMobile) setSidebarOpen(false);
  }, [isMobile]);

  const navigate = (id) => {
    setTab(id);
    if (isMobile) setSidebarOpen(false);
  };

  if (!token) return <LoginPage onLogin={(t, c) => { setToken(t); setClub(c); }} />;

  const current = NAV.find(n => n.id === tab);

  return (
    <div style={{ minHeight: "100vh", background: C.bg, fontFamily: "'Inter',-apple-system,BlinkMacSystemFont,sans-serif", color: C.text, transition: "background 0.3s, color 0.3s" }}>
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
        button:focus-visible, [tabindex]:focus-visible { box-shadow: 0 0 0 3px ${C.accentSoft} !important; outline: none; }
        @media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: ${C.accent}; border-radius: 4px; }
        input[type="date"]::-webkit-calendar-picker-indicator,
        input[type="time"]::-webkit-calendar-picker-indicator { filter: ${dark ? "invert(0.5)" : "invert(0.3)"}; }
        input[type="range"] { accent-color: #06b6d4; }
        ::selection { background: rgba(6,182,212,0.30); }
        .gradient-text { color: ${C.accent}; }
        .eyebrow {
          display: inline-flex; align-items: center; gap: 8px;
          font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase;
          color: ${C.accent};
        }
        .eyebrow::before {
          content: ''; display: block; width: 24px; height: 2px; border-radius: 2px;
          background: ${C.accent}; flex-shrink: 0;
        }
        .nav-btn:hover { background: ${dark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.04)"} !important; color: ${C.text} !important; }
        .nav-btn.active { background: linear-gradient(90deg, ${C.accentSoft} 0%, ${C.indigoDim} 100%) !important; box-shadow: inset 0 0 0 1px ${C.accentDim}; }
      `}</style>

      {/* Theme toggle pill — top-right fixed */}
      <ThemeToggle />

      {/* Banner impersonation admin (Punto 7) */}
      {impersonation && (
        <div style={{
          position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 400,
          background: C.warning, color: "#1a1200",
          padding: "10px 16px", display: "flex", alignItems: "center", justifyContent: "center",
          gap: 14, flexWrap: "wrap", fontSize: 13, fontWeight: 600,
          boxShadow: "0 -4px 18px rgba(0,0,0,0.28)",
          paddingBottom: "calc(10px + env(safe-area-inset-bottom, 0px))",
        }}>
          <span>⚠️ Modalità admin — stai operando come <strong>{impersonation}</strong>. Ogni modifica è tracciata.</span>
          <button type="button"
            onClick={() => { try { window.close(); } catch {} window.location.href = "/admin"; }}
            style={{ background: "#1a1200", color: C.warning, border: "none", borderRadius: 8, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
            Torna all'admin
          </button>
        </div>
      )}

      {/* Hamburger — solo mobile */}
      {isMobile && (
        <button
          type="button"
          onClick={() => setSidebarOpen(o => !o)}
          aria-label={sidebarOpen ? "Chiudi menu" : "Apri menu"}
          aria-expanded={sidebarOpen}
          style={{
            position: "fixed",
            top: "calc(16px + env(safe-area-inset-top, 0px))",
            left: "calc(16px + env(safe-area-inset-left, 0px))",
            zIndex: 30,
            width: 40, height: 40, borderRadius: 10,
            background: C.surface, border: `1px solid ${C.border}`,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            gap: 5, cursor: "pointer", padding: 0,
          }}
        >
          <span style={{ display: "block", width: 18, height: 2, background: C.text, borderRadius: 2, transition: "transform 0.25s", transform: sidebarOpen ? "rotate(45deg) translate(5px, 5px)" : "none" }} />
          <span style={{ display: "block", width: 18, height: 2, background: C.text, borderRadius: 2, transition: "opacity 0.25s", opacity: sidebarOpen ? 0 : 1 }} />
          <span style={{ display: "block", width: 18, height: 2, background: C.text, borderRadius: 2, transition: "transform 0.25s", transform: sidebarOpen ? "rotate(-45deg) translate(5px, -5px)" : "none" }} />
        </button>
      )}

      {/* Overlay — solo mobile quando sidebar è aperta */}
      {isMobile && sidebarOpen && (
        <div
          onClick={() => setSidebarOpen(false)}
          style={{ position: "fixed", inset: 0, background: C.overlay, zIndex: 9 }}
        />
      )}

      {/* Aurora orbs — angoli, multi-hue come l'hero del sito */}
      <div style={{ position: "fixed", top: -200, right: -150, width: 600, height: 600, borderRadius: "50%", background: `radial-gradient(circle, ${C.orbCyan} 0%, transparent 70%)`, pointerEvents: "none", zIndex: 0, transition: "background 0.5s, opacity 0.5s", willChange: "opacity" }} />
      <div style={{ position: "fixed", bottom: -150, left: -100, width: 500, height: 500, borderRadius: "50%", background: `radial-gradient(circle, ${C.orbViolet} 0%, transparent 70%)`, pointerEvents: "none", zIndex: 0, transition: "background 0.5s, opacity 0.5s", willChange: "opacity" }} />
      <div style={{ position: "fixed", top: "38%", right: -180, width: 420, height: 420, borderRadius: "50%", background: `radial-gradient(circle, ${C.orbEmerald} 0%, transparent 70%)`, pointerEvents: "none", zIndex: 0, transition: "background 0.5s, opacity 0.5s", willChange: "opacity" }} />
      <div style={{ position: "fixed", bottom: -120, right: "30%", width: 360, height: 360, borderRadius: "50%", background: `radial-gradient(circle, ${C.orbPink} 0%, transparent 70%)`, pointerEvents: "none", zIndex: 0, transition: "background 0.5s, opacity 0.5s", willChange: "opacity" }} />

      {/* Sidebar */}
      <div style={{
        position: "fixed", left: 0, top: 0, bottom: 0, width: SIDEBAR_W,
        background: C.sidebarBg,
        borderRight: `1px solid ${C.sidebarBorder}`,
        display: "flex", flexDirection: "column",
        zIndex: 10,
        transition: "background 0.3s, border-color 0.3s, transform 0.3s cubic-bezier(0.23,1,0.32,1)",
        transform: isMobile && !sidebarOpen ? `translateX(-${SIDEBAR_W}px)` : "translateX(0)",
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
                fontFamily: "'Inter',-apple-system,BlinkMacSystemFont,sans-serif",
                color: C.titleColor,
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
              <button type="button" key={n.id} type="button" onClick={() => navigate(n.id)} aria-label={n.label} aria-current={active ? "page" : undefined}
                className={`nav-btn${active ? " active" : ""}`}
                style={{
                  display: "flex", alignItems: "center", gap: 9,
                  padding: "11px 12px 11px 16px",
                  borderRadius: 9, cursor: "pointer", border: "none",
                  background: active ? "rgba(6,182,212,0.10)" : "transparent",
                  fontSize: 13, textAlign: "left",
                  transition: "all 0.15s cubic-bezier(0.23,1,0.32,1)",
                  fontFamily: "inherit", fontWeight: active ? 600 : 400,
                  position: "relative", color: active ? C.accent : C.muted,
                  minHeight: 44,
                }}>
                {active && (
                  <div style={{
                    position: "absolute", left: 0, top: "18%", bottom: "18%",
                    width: 3, borderRadius: 2,
                    background: C.accent,
                    boxShadow: `0 0 10px ${C.accentSoft}`,
                  }} />
                )}
                <span style={{ fontSize: 15 }}>{n.icon}</span>
                <span>{n.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Footer — esci */}
        <div style={{ padding: "14px 10px", borderTop: `1px solid ${C.sidebarSep}` }}>
          <button
            type="button"
            onClick={() => { if (confirm("Vuoi uscire dalla dashboard?")) setToken(null); }}
            style={{ ...btnGhost, width: "100%", fontSize: 11, borderRadius: 8, minHeight: 44 }}
          >
            Esci
          </button>
        </div>
      </div>

      {/* Main content */}
      <div style={{
        marginLeft: isMobile ? 0 : SIDEBAR_W,
        padding: isMobile
          ? "calc(72px + env(safe-area-inset-top, 0px)) 16px 32px"
          : "36px 44px",
        maxWidth: 1340, position: "relative", zIndex: 1,
      }}>
        {/* Page header */}
        <div style={{ marginBottom: isMobile ? 24 : 36 }}>
          <h1 style={{
            fontSize: isMobile ? 22 : 28,
            fontWeight: 700, letterSpacing: "-0.02em", lineHeight: 1.1,
            fontFamily: "'Inter',-apple-system,BlinkMacSystemFont,sans-serif",
            color: C.titleColor,
            marginBottom: 6,
          }}>
            {current?.label}
          </h1>
          {!isMobile && <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5 }}>{current?.desc}</div>}
        </div>

        {tab === "courts"   && <CourtsView   token={token} onClubUpdate={setClub} />}
        {tab === "prices"   && <PricesView   token={token} />}
        {tab === "players"  && <PlayersView  token={token} club={club} />}
        {tab === "stats"    && <StatsView    token={token} />}
        {tab === "revenue"  && <RevenueView  token={token} />}
        {tab === "faqs"     && <FaqsView     token={token} />}
        {tab === "system"   && <SystemView   token={token} />}
        {tab === "settings" && <SettingsView token={token} club={club} onClubUpdate={setClub} />}
      </div>
    </div>
  );
}
