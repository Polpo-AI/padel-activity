import { useState, useEffect, useCallback } from "react";
import { useTheme, useMobile } from "../../shared/ThemeContext";
import Spinner from "../../shared/Spinner";

const fmtUsd = (v) => "$" + (v || 0).toLocaleString("it-IT", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = (v) => (v || 0).toLocaleString("it-IT");
const fmtTok = (v) => v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v || 0);

export default function UsageView({ token }) {
  const { C, btnGhost } = useTheme();
  const isMobile = useMobile();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [days, setDays] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/admin/usage?days=${days}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      setData(d.error ? null : d);
    } catch { setData(null); }
    finally { setLoading(false); }
  }, [token, days]);

  useEffect(() => { load(); }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {[7, 30, 90].map((d) => (
          <button type="button" key={d} onClick={() => setDays(d)} style={{
            ...btnGhost, fontSize: 12,
            background: days === d ? C.accentDim : "transparent",
            color: days === d ? C.accent : C.muted,
            borderColor: days === d ? `${C.accent}40` : C.border,
          }}>Ultimi {d}gg</button>
        ))}
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 11, color: C.muted }}>Stima in USD (valuta di fatturazione Anthropic)</span>
      </div>

      {loading ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 28, justifyContent: "center" }}>
          <Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Caricamento...</span>
        </div>
      ) : !data ? (
        <div style={{ padding: 32, textAlign: "center", color: C.muted, fontSize: 13 }}>Dati non disponibili</div>
      ) : (
        <>
          {/* Totale */}
          <div style={{
            background: `linear-gradient(135deg, ${C.accent}1c 0%, ${C.surface} 60%)`,
            border: `1px solid ${C.accent}3a`, borderRadius: 16, padding: "22px 24px",
            display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12,
          }}>
            <div>
              <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 600 }}>Spesa API totale · {data.days}gg</div>
              <div style={{ fontSize: 36, fontWeight: 800, color: C.accent, fontVariantNumeric: "tabular-nums", lineHeight: 1.05, marginTop: 6 }}>{fmtUsd(data.totalCostUsd)}</div>
              <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>{fmtNum(data.totalCalls)} chiamate Claude</div>
            </div>
            <span style={{ fontSize: 22 }}>🤖</span>
          </div>

          {data.clubs.length === 0 ? (
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 32, textAlign: "center", color: C.muted, fontSize: 13 }}>
              Nessun consumo registrato nel periodo.
            </div>
          ) : isMobile ? (
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
              {data.clubs.map((c, i) => (
                <div key={c.clubId} style={{ padding: "12px 14px", borderBottom: i < data.clubs.length - 1 ? `1px solid ${C.border}` : "none", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{c.clubName}</div>
                    <div style={{ fontSize: 11, color: C.muted }}>{fmtNum(c.calls)} chiamate · {fmtTok(c.inputTokens)}/{fmtTok(c.outputTokens)} tok</div>
                  </div>
                  <div style={{ fontSize: 16, fontWeight: 800, color: C.accent, fontVariantNumeric: "tabular-nums" }}>{fmtUsd(c.costUsd)}</div>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    {["Circolo", "Chiamate", "Token in", "Token out", "Costo stimato"].map((h, i) => (
                      <th key={h} style={{ padding: "10px 16px", textAlign: i === 0 ? "left" : "right", fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.clubs.map((c, i) => (
                    <tr key={c.clubId} style={{ borderBottom: i < data.clubs.length - 1 ? `1px solid ${C.dim}` : "none" }}>
                      <td style={{ padding: "10px 16px", color: C.text, fontWeight: 600 }}>{c.clubName}</td>
                      <td style={{ padding: "10px 16px", textAlign: "right", color: C.muted, fontVariantNumeric: "tabular-nums" }}>{fmtNum(c.calls)}</td>
                      <td style={{ padding: "10px 16px", textAlign: "right", color: C.muted, fontVariantNumeric: "tabular-nums" }}>{fmtNum(c.inputTokens)}</td>
                      <td style={{ padding: "10px 16px", textAlign: "right", color: C.muted, fontVariantNumeric: "tabular-nums" }}>{fmtNum(c.outputTokens)}</td>
                      <td style={{ padding: "10px 16px", textAlign: "right", color: C.accent, fontWeight: 700, fontVariantNumeric: "tabular-nums" }}>{fmtUsd(c.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, borderTop: `1px solid ${C.dim}`, paddingTop: 12 }}>
            Stima basata sui token consumati e sulle tariffe per modello (aggiornabili in <code>usage-tracker.ts</code>). "Sistema (senza circolo)" raccoglie le chiamate fuori dal contesto di un circolo.
          </div>
        </>
      )}
    </div>
  );
}
