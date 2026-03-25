import { useState, useEffect, useCallback } from "react";
import { C, api, btnGhost } from "../../shared/config";
import Spinner from "../../shared/Spinner";

function HeroCard({ label, value, sub, color, icon, highlight }) {
  return (
    <div style={{
      background: highlight ? `linear-gradient(135deg, ${C.surface} 0%, ${color}18 100%)` : C.surface,
      border: `1px solid ${highlight ? color + "50" : C.border}`,
      borderRadius: 14, padding: "24px 26px",
      display: "flex", flexDirection: "column", gap: 10,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 600 }}>{label}</div>
        <span style={{ fontSize: 22 }}>{icon}</span>
      </div>
      <div style={{ fontSize: 38, fontWeight: 700, color: color || C.accent, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.4 }}>{sub}</div>}
    </div>
  );
}

function MetricRow({ label, value, detail, color }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 0", borderBottom: `1px solid ${C.dim}` }}>
      <div>
        <div style={{ fontSize: 13, color: C.text }}>{label}</div>
        {detail && <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{detail}</div>}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, color: color || C.text, fontVariantNumeric: "tabular-nums" }}>{value}</div>
    </div>
  );
}

function DonutFill({ rate, color, label, sub }) {
  const pct = Math.round(rate * 100);
  const r = 36;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
      <div style={{ position: "relative", width: 100, height: 100 }}>
        <svg width="100" height="100" style={{ transform: "rotate(-90deg)" }}>
          <circle cx="50" cy="50" r={r} fill="none" stroke={C.dim} strokeWidth="8" />
          <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="8"
            strokeDasharray={`${dash} ${circ}`} strokeLinecap="round"
            style={{ transition: "stroke-dasharray 0.6s ease" }} />
        </svg>
        <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          <span style={{ fontSize: 18, fontWeight: 700, color, lineHeight: 1 }}>{pct}%</span>
        </div>
      </div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 12, color: C.text, fontWeight: 600 }}>{label}</div>
        {sub && <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{sub}</div>}
      </div>
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
      setData(null);
    } finally { setLoading(false); }
  }, [token, range]);

  useEffect(() => { load(); }, [load]);

  if (loading) return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 40 }}>
      <Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Caricamento...</span>
    </div>
  );

  if (!data) return (
    <div style={{ padding: 40, textAlign: "center", color: C.muted, fontSize: 13 }}>
      Dati non disponibili
    </div>
  );

  const m = data.matches || {};
  const fillColor = data.fillRate >= 0.7 ? C.open : data.fillRate >= 0.4 ? C.warning : C.cancelled;
  const convColor = data.waveConversionRate >= 0.3 ? C.open : data.waveConversionRate >= 0.15 ? C.warning : C.cancelled;
  const hasRevenue = data.revenue > 0;
  const hasOffHours = data.totalMessages > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

      {/* Range selector */}
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

      {/* Hero: revenue + partite completate */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <HeroCard
          label="Revenue generata"
          value={hasRevenue ? `€${data.revenue.toLocaleString("it-IT")}` : "—"}
          sub={hasRevenue ? `${m.locked ?? 0} partite completate con successo` : "Configura i prezzi dei campi per abilitare"}
          color={C.open}
          icon="💰"
          highlight={hasRevenue}
        />
        <HeroCard
          label="Disdette recuperate"
          value={data.savedFromCancellation ?? 0}
          sub={data.savedFromCancellation > 0
            ? `Il bot ha trovato un sostituto ${data.savedFromCancellation} volt${data.savedFromCancellation === 1 ? "a" : "e"} — partite che sarebbero saltate`
            : "Nessuna disdetta da gestire nel periodo"}
          color={C.locked}
          icon="🚨"
          highlight={data.savedFromCancellation > 0}
        />
      </div>

      {/* Metriche di efficienza */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 20 }}>📊 Efficienza del bot</div>
        <div style={{ display: "flex", justifyContent: "space-around", flexWrap: "wrap", gap: 24 }}>
          <DonutFill
            rate={data.fillRate}
            color={fillColor}
            label="Campi riempiti"
            sub={`${m.locked ?? 0} su ${(m.locked ?? 0) + (m.cancelled ?? 0) + (m.unfilled ?? 0)} partite completate`}
          />
          <DonutFill
            rate={data.waveConversionRate}
            color={convColor}
            label="Giocatori che accettano"
            sub={`su ${data.invSent ?? 0} inviti inviati dal bot`}
          />
          {hasOffHours && (
            <DonutFill
              rate={data.offHoursRate}
              color={C.warning}
              label="Gestiti di notte o weekend"
              sub="Messaggi ricevuti fuori orario lavorativo"
            />
          )}
        </div>
      </div>

      {/* Partite nel periodo */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 4 }}>🎾 Partite negli ultimi {range} giorni</div>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 16 }}>{m.total ?? 0} totali</div>
        <div>
          {[
            { label: "Giocate (campo pieno)", value: m.locked ?? 0, color: C.locked },
            { label: "In attesa di giocatori", value: m.open ?? 0, color: C.open },
            { label: "Annullate per pochi giocatori", value: m.unfilled ?? 0, color: C.unfilled },
            { label: "Cancellate", value: m.cancelled ?? 0, color: C.cancelled },
          ].map((row, i, arr) => (
            <div key={row.label} style={{
              display: "flex", justifyContent: "space-between", alignItems: "center",
              padding: "11px 0",
              borderBottom: i < arr.length - 1 ? `1px solid ${C.dim}` : "none",
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: row.color, flexShrink: 0 }} />
                <span style={{ fontSize: 13, color: C.text }}>{row.label}</span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 80, height: 4, background: C.dim, borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${((row.value / (m.total || 1)) * 100)}%`, background: row.color, borderRadius: 2 }} />
                </div>
                <span style={{ fontSize: 14, fontWeight: 700, color: row.color, minWidth: 28, textAlign: "right" }}>{row.value}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Giocatori */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 24 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 4 }}>👥 Community</div>
        <div style={{ fontSize: 11, color: C.muted, marginBottom: 16 }}>Giocatori nel circolo</div>
        <MetricRow
          label="Nuovi iscritti"
          detail={`Si sono registrati negli ultimi ${range} giorni`}
          value={data.players?.newThisPeriod ?? 0}
          color={C.accent}
        />
        <MetricRow
          label="Hanno giocato almeno una partita"
          detail="Nel periodo selezionato"
          value={data.players?.active ?? 0}
          color={C.locked}
        />
        <MetricRow
          label="Totale iscritti al circolo"
          detail="Giocatori attivi registrati"
          value={data.players?.total ?? 0}
          color={C.text}
        />
      </div>

    </div>
  );
}
