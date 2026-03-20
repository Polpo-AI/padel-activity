import { useState, useEffect, useCallback } from "react";
import { C, btnGhost } from "../../shared/config";
import Spinner from "../../shared/Spinner";

const WA_COLOR = { open: C.open, connecting: C.warning, closed: C.cancelled, disconnected: C.muted };
const WA_LABEL = { open: "✅ Connesso", connecting: "⏳ Connessione…", closed: "❌ Chiuso", disconnected: "⚪ Non configurato" };

function StatusDot({ ok }) {
  return <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: "50%", background: ok ? C.open : C.cancelled, marginRight: 8 }} />;
}

export default function SystemView({ token }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/admin/system", { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setData(d);
    } catch { setData(null); }
    finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 40 }}><Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Caricamento...</span></div>;
  if (!data) return <div style={{ padding: 40, color: C.cancelled, fontSize: 13 }}>Errore nel caricamento</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 760 }}>
      {/* Infra health */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 24px" }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 16 }}>Infrastruttura</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, color: C.muted }}>PostgreSQL</span>
            <span style={{ fontSize: 13, color: data.db === "ok" ? C.open : C.cancelled, fontWeight: 600 }}>
              <StatusDot ok={data.db === "ok"} />{data.db === "ok" ? "OK" : "DOWN"}
            </span>
          </div>
          <div style={{ height: 1, background: C.border }} />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, color: C.muted }}>Redis</span>
            <span style={{ fontSize: 13, color: data.redis === "ok" ? C.open : C.cancelled, fontWeight: 600 }}>
              <StatusDot ok={data.redis === "ok"} />{data.redis === "ok" ? "OK" : "DOWN"}
            </span>
          </div>
        </div>
        <div style={{ fontSize: 11, color: C.muted, marginTop: 16 }}>
          Aggiornato: {new Date(data.ts).toLocaleString("it-IT")}
        </div>
      </div>

      {/* WhatsApp per circolo */}
      <div>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 14 }}>WhatsApp per circolo</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {(data.clubs || []).map(c => (
            <div key={c.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 12 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{c.name}</div>
                <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>
                  {c.botPhoneNumber ? `Bot: +${c.botPhoneNumber}` : "Bot non configurato"}
                  {c.adminPhone ? ` · Admin: +${c.adminPhone}` : ""}
                </div>
              </div>
              <div style={{ fontSize: 13, color: WA_COLOR[c.waStatus] || C.muted, fontWeight: 600 }}>
                {WA_LABEL[c.waStatus] || c.waStatus}
              </div>
            </div>
          ))}
          {!data.clubs?.length && (
            <div style={{ padding: 24, textAlign: "center", color: C.muted, fontSize: 13 }}>Nessun circolo</div>
          )}
        </div>
      </div>

      <button onClick={load} style={{ ...btnGhost, alignSelf: "flex-start" }}>↺ Aggiorna</button>
    </div>
  );
}
