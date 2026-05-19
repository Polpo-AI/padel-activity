import { useState } from "react";
import { C, inputSt, btnPrimary } from "../../shared/config";

const API = "/api/dashboard";

export default function LoginPage({ onLogin }) {
  const [u, setU] = useState(""); const [p, setP] = useState("");
  const [loading, setLoading] = useState(false); const [err, setErr] = useState("");

  const submit = async () => {
    if (!u || !p) return;
    setLoading(true); setErr("");
    try {
      const d = await fetch(`${API}/login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: u, password: p }),
      }).then(r => r.json());
      if (d.error) throw new Error(d.error);
      onLogin(d.token, d.club);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div style={{
      minHeight: "100vh", background: C.bg,
      display: "flex", alignItems: "center", justifyContent: "center",
      fontFamily: "'Inter','Plus Jakarta Sans',-apple-system,BlinkMacSystemFont,sans-serif",
    }}>
      {/* Ambient orbs — aurora-bg da stunning-broccoli */}
      <div style={{ position: "fixed", top: -200, right: -150, width: 700, height: 700, borderRadius: "50%", background: "radial-gradient(circle, rgba(34,211,238,0.09) 0%, transparent 70%)", pointerEvents: "none" }} />
      <div style={{ position: "fixed", bottom: -150, left: -100, width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, rgba(139,92,246,0.08) 0%, transparent 70%)", pointerEvents: "none" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 900, height: 900, borderRadius: "50%", background: "radial-gradient(circle, rgba(255,61,138,0.07) 0%, transparent 60%)", pointerEvents: "none" }} />

      {/* Radial glow behind card */}
      <div style={{
        position: "fixed", top: "40%", left: "50%", transform: "translate(-50%, -50%)",
        width: 700, height: 700, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(34,211,238,0.12) 0%, transparent 65%)",
        pointerEvents: "none",
      }} />

      <div style={{
        width: 380, position: "relative",
        background: "rgba(13,20,40,0.80)",
        backdropFilter: "blur(24px) saturate(1.4)",
        border: "1px solid rgba(34,211,238,0.14)",
        borderTop: "2px solid rgba(34,211,238,0.45)",
        borderRadius: 18,
        padding: "40px 36px",
        display: "flex", flexDirection: "column", gap: 28,
        boxShadow: "0 8px 40px rgba(0,0,0,0.6), inset 0 1px 0 rgba(255,255,255,0.04)",
      }}>
        <div style={{ textAlign: "center" }}>
          <div style={{
            width: 56, height: 56, borderRadius: 16, fontSize: 26, margin: "0 auto 18px",
            background: `linear-gradient(135deg, ${C.accent}20, ${C.accent}08)`,
            border: `1px solid ${C.accent}30`,
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: `0 0 20px ${C.accent}20`,
          }}>🎾</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: C.text, letterSpacing: "-0.02em" }}>
            Padel Dashboard
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 5 }}>Accesso riservato</div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input
            value={u} onChange={e => setU(e.target.value)} placeholder="Username"
            style={{ ...inputSt, boxSizing: "border-box" }}
            onKeyDown={e => e.key === "Enter" && submit()}
          />
          <input
            type="password" value={p} onChange={e => setP(e.target.value)} placeholder="Password"
            style={{ ...inputSt, boxSizing: "border-box" }}
            onKeyDown={e => e.key === "Enter" && submit()}
          />
          {err && (
            <div style={{ fontSize: 12, color: C.cancelled, textAlign: "center", padding: "6px 0" }}>
              {err}
            </div>
          )}
          <button
            onClick={submit} disabled={loading}
            style={{ ...btnPrimary, display: "block", width: "100%", boxSizing: "border-box", marginTop: 4, padding: "12px 20px" }}
          >
            {loading ? "..." : "Accedi →"}
          </button>
        </div>
      </div>
    </div>
  );
}
