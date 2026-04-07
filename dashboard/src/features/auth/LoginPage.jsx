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
    <div style={{ minHeight: "100vh", background: C.bg, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit" }}>
      <div style={{ width: 360, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16, padding: 40, display: "flex", flexDirection: "column", gap: 24 }}>
        <div style={{ textAlign: "center" }}>
          <div style={{
            width: 60, height: 60, borderRadius: 18, fontSize: 28, margin: "0 auto 16px",
            background: `linear-gradient(135deg, ${C.indigoDim}, ${C.accentDim})`,
            border: `1px solid ${C.indigo}50`,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>🎾</div>
          <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>Padel Dashboard</div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>Accesso riservato</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input value={u} onChange={e => setU(e.target.value)} placeholder="Username" style={{ ...inputSt, boxSizing: "border-box" }} onKeyDown={e => e.key === "Enter" && submit()} />
          <input type="password" value={p} onChange={e => setP(e.target.value)} placeholder="Password" style={{ ...inputSt, boxSizing: "border-box" }} onKeyDown={e => e.key === "Enter" && submit()} />
          {err && <div style={{ fontSize: 12, color: C.cancelled, textAlign: "center" }}>{err}</div>}
          <button onClick={submit} disabled={loading} style={{ ...btnPrimary, display: "block", width: "100%", boxSizing: "border-box" }}>{loading ? "..." : "Accedi →"}</button>
        </div>
      </div>
    </div>
  );
}
