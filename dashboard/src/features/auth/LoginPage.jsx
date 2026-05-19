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
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        input:focus { outline: none; border-color: rgba(6,182,212,0.55) !important; box-shadow: 0 0 0 3px rgba(6,182,212,0.18) !important; }
        ::selection { background: rgba(6,182,212,0.30); }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: linear-gradient(to bottom, #22d3ee, #a78bfa); border-radius: 4px; }
      `}</style>

      {/* Aurora orbs — vividi come sul sito */}
      <div style={{ position: "fixed", top: -180, right: -120, width: 750, height: 750, borderRadius: "50%", background: "radial-gradient(circle, rgba(34,211,238,0.18) 0%, rgba(6,182,212,0.07) 40%, transparent 70%)", pointerEvents: "none" }} />
      <div style={{ position: "fixed", bottom: -120, left: -80, width: 650, height: 650, borderRadius: "50%", background: "radial-gradient(circle, rgba(139,92,246,0.16) 0%, rgba(99,102,241,0.05) 40%, transparent 70%)", pointerEvents: "none" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", width: 1000, height: 1000, borderRadius: "50%", background: "radial-gradient(circle, rgba(255,61,138,0.10) 0%, rgba(255,91,158,0.04) 35%, transparent 60%)", pointerEvents: "none" }} />

      {/* Card */}
      <div style={{
        width: 400, position: "relative",
        background: "rgba(11,18,40,0.82)",
        backdropFilter: "blur(28px) saturate(1.6)",
        border: "1px solid rgba(255,255,255,0.10)",
        borderTop: "2px solid rgba(34,211,238,0.50)",
        borderRadius: 20,
        padding: "44px 40px",
        display: "flex", flexDirection: "column", gap: 32,
        boxShadow: "0 8px 48px rgba(0,0,0,0.60), 0 0 80px rgba(34,211,238,0.06), inset 0 1px 0 rgba(255,255,255,0.06)",
      }}>
        {/* Header */}
        <div style={{ textAlign: "center" }}>
          <div style={{
            width: 60, height: 60, borderRadius: 18, fontSize: 28, margin: "0 auto 20px",
            background: "linear-gradient(135deg, rgba(34,211,238,0.20), rgba(167,139,250,0.14))",
            border: "1px solid rgba(34,211,238,0.30)",
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 0 28px rgba(34,211,238,0.22), inset 0 1px 0 rgba(255,255,255,0.10)",
          }}>🎾</div>

          {/* Title — Fraunces gradient */}
          <div style={{
            fontSize: 26, fontWeight: 300, letterSpacing: "-0.01em", lineHeight: 1.1,
            fontFamily: "'Fraunces', Georgia, serif",
            background: "linear-gradient(135deg, #f8fafc 0%, #cbd5e1 70%)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
            marginBottom: 6,
          }}>
            Padel Dashboard
          </div>

          {/* Eyebrow subtitle */}
          <div style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            fontSize: 11, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase",
            background: "linear-gradient(135deg, #22d3ee, #a78bfa)",
            WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text",
          }}>
            Accesso riservato
          </div>
        </div>

        {/* Form */}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
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
            <div style={{ fontSize: 12, color: C.cancelled, textAlign: "center", padding: "4px 0" }}>
              {err}
            </div>
          )}
          <button
            onClick={submit} disabled={loading}
            style={{
              ...btnPrimary,
              display: "block", width: "100%", boxSizing: "border-box",
              marginTop: 4, padding: "13px 20px", borderRadius: 12, fontSize: 14,
            }}
          >
            {loading ? "..." : "Accedi →"}
          </button>
        </div>
      </div>
    </div>
  );
}
