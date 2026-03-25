import { useState, useEffect, useCallback } from "react";
import { C, api, btnGhost } from "../../shared/config";
import Spinner from "../../shared/Spinner";

function StatCard({ label, value, sub, color, icon }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "20px 22px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>{label}</div>
        <span style={{ fontSize: 18 }}>{icon}</span>
      </div>
      <div style={{ fontSize: 32, fontWeight: 700, color: color || C.accent, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: C.muted }}>{sub}</div>}
    </div>
  );
}

function MiniBar({ value, max, color }) {
  const pct = Math.min(100, Math.round((value / (max || 1)) * 100));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ flex: 1, height: 5, background: C.dim, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct}%`, background: color || C.accent, borderRadius: 3, transition: "width 0.5s" }} />
      </div>
      <span style={{ fontSize: 10, color: C.muted, minWidth: 28, textAlign: "right" }}>{pct}%</span>
    </div>
  );
}

export default function StatsView({ token }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState(30);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api(`/stats?days=${range}`, token);
      setData(d);
    } catch {
      setData({
        matches: { total: 0, open: 0, locked: 0, cancelled: 0, unfilled: 0 },
        players: { total: 0, active: 0, newThisPeriod: 0 },
        reliability: { avg: 0, topPlayers: [] },
        fillRate: 0, wavesLaunched: 0, aiInteractions: 0, noShowRate: 0,
      });
    } finally { setLoading(false); }
  }, [token, range]);

  useEffect(() => { load(); }, [load]);

  if (loading) return <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 40 }}><Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Caricamento statistiche...</span></div>;
  if (!data) return null;

  const m = data.matches || {};
  const p = data.players || {};
  const r = data.reliability || {};
  const fillRate = data.fillRate || 0;
  const fillColor = fillRate >= 0.7 ? C.open : fillRate >= 0.4 ? C.warning : C.cancelled;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", gap: 8 }}>
        {[7, 30, 90].map(d => (
          <button key={d} onClick={() => setRange(d)} style={{
            ...btnGhost, fontSize: 12,
            background: range === d ? C.accentDim : "transparent",
            color: range === d ? C.accent : C.muted,
            borderColor: range === d ? `${C.accent}40` : C.border,
          }}>Ultimi {d}gg</button>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 14 }}>
        <StatCard label="Partite totali" value={m.total ?? "—"} icon="🎾" sub={`${m.locked ?? 0} chiuse con successo`} />
        <StatCard label="Fill rate" value={`${((fillRate) * 100).toFixed(0)}%`} icon="📊" color={fillColor} sub="Partite riempite / totali" />
        <StatCard label="Giocatori attivi" value={p.active ?? "—"} icon="👥" color={C.locked} sub={`${p.total ?? 0} totali nel circolo`} />
        <StatCard label="Wave lanciate" value={data.wavesLaunched ?? "—"} icon="📡" color={C.warning} sub="Inviti WhatsApp inviati" />
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 20 }}>📈 Distribuzione partite</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {[
            { label: "Chiuse (successo)", value: m.locked ?? 0, color: C.locked },
            { label: "Aperte", value: m.open ?? 0, color: C.open },
            { label: "Non riempite", value: m.unfilled ?? 0, color: C.unfilled },
            { label: "Cancellate", value: m.cancelled ?? 0, color: C.cancelled },
          ].map(row => (
            <div key={row.label} style={{ display: "grid", gridTemplateColumns: "160px 1fr 36px", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 12, color: C.muted }}>{row.label}</span>
              <MiniBar value={row.value} max={m.total || 1} color={row.color} />
              <span style={{ fontSize: 12, color: row.color, fontWeight: 700, textAlign: "right" }}>{row.value}</span>
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 6 }}>⭐ Affidabilità media</div>
          <div style={{ fontSize: 10, color: C.muted, marginBottom: 16 }}>basata su reliabilityScore del sistema</div>
          <div style={{ fontSize: 42, fontWeight: 700, color: (r.avg ?? 0) >= 0.6 ? C.open : C.warning, fontVariantNumeric: "tabular-nums" }}>
            {((r.avg ?? 0.33) * 100).toFixed(0)}<span style={{ fontSize: 20 }}>%</span>
          </div>
          <div style={{ height: 6, background: C.dim, borderRadius: 3, overflow: "hidden", marginTop: 12 }}>
            <div style={{ height: "100%", width: `${(r.avg ?? 0.33) * 100}%`, background: (r.avg ?? 0.33) >= 0.6 ? C.open : C.warning, borderRadius: 3 }} />
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 10 }}>No-show rate: <span style={{ color: C.cancelled }}>{((data.noShowRate ?? 0) * 100).toFixed(0)}%</span></div>
        </div>

        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 16 }}>🏆 Top giocatori affidabili</div>
          {(r.topPlayers ?? []).length === 0 ? (
            <div style={{ fontSize: 12, color: C.muted, padding: "20px 0", textAlign: "center" }}>Dati disponibili dopo le prime partite</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {(r.topPlayers ?? []).slice(0, 5).map((pl, i) => (
                <div key={pl.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ fontSize: 11, color: C.dim, width: 16, textAlign: "right" }}>{i + 1}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12, color: C.text }}>{pl.name || pl.phoneNumber}</div>
                    <MiniBar value={pl.reliabilityScore} max={1} color={C.open} />
                  </div>
                  <span style={{ fontSize: 11, color: C.open, fontWeight: 700 }}>{((pl.reliabilityScore ?? 0.33) * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, display: "flex", alignItems: "center", gap: 24 }}>
        <div style={{ fontSize: 32 }}>🤖</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Interazioni AI (Anthropic)</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Messaggi elaborati dal modello nel periodo selezionato</div>
        </div>
        <div style={{ fontSize: 28, fontWeight: 700, color: C.accent, fontVariantNumeric: "tabular-nums" }}>{data.aiInteractions ?? "—"}</div>
      </div>
    </div>
  );
}
