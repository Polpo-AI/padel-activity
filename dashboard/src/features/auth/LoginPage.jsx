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
      fontFamily: "'DM Mono','Fira Code','Courier New',monospace",
    }}>
      {/* Subtle radial glow behind card */}
      <div style={{
        position: "fixed", top: "40%", left: "50%", transform: "translate(-50%, -50%)",
        width: 500, height: 500, borderRadius: "50%",
        background: `radial-gradient(circle, ${C.accent}08 0%, transparent 70%)`,
        pointerEvents: "none",
      }} />

      <div style={{
        width: 380, position: "relative",
        background: C.surface,
        border: `1px solid ${C.border}`,
        borderRadius: 18,
        padding: "40px 36px",
        display: "flex", flexDirection: "column", gap: 28,
        boxShadow: "0 2px 4px rgba(0,0,0,0.5), 0 20px 60px rgba(0,0,0,0.4)",
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
