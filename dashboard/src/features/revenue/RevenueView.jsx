import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { useTheme, useMobile } from "../../shared/ThemeContext";
import { api } from "../../shared/config";
import Spinner from "../../shared/Spinner";

const MONTHS_IT = [
  "Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno",
  "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre",
];

const fmtEuro = (v) => "€" + Math.round(v || 0).toLocaleString("it-IT");

// Anno/mese correnti in fuso Europe/Rome (coerente col backend).
function romeNow() {
  const s = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Rome", year: "numeric", month: "2-digit" }).format(new Date());
  const [y, mo] = s.split("-").map(Number);
  return { y, mo };
}

// Somma progressiva: trasforma i guadagni per-bucket in una curva di crescita
// (stile grafico azionario) che sale fino al totale del periodo.
function cumulative(arr) {
  let run = 0;
  return arr.map((v) => (run += v));
}

// Larghezza reale del contenitore → SVG senza distorsioni da scaling.
function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(560);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0].contentRect.width;
      if (cw) setW(cw);
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ─── Grafico crescita cumulata (1 o 2 serie sovrapposte) ───────────────────────

function RevenueChart({ seriesList, labels, height = 168 }) {
  const { C } = useTheme();
  const [ref, W] = useWidth();
  const H = height;
  const padL = 6, padR = 16, padT = 16, padB = 24;
  const gid = useMemo(() => "rg" + Math.random().toString(36).slice(2, 8), []);

  const n = Math.max(1, ...seriesList.map((s) => s.values.length));
  const maxRaw = Math.max(0, ...seriesList.flatMap((s) => s.values));
  const maxV = maxRaw <= 0 ? 1 : maxRaw;
  const innerW = Math.max(1, W - padL - padR);
  const innerH = H - padT - padB;
  const X = (i) => padL + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const Y = (v) => padT + (1 - v / maxV) * innerH;

  const showLabel = (i) => (n <= 12 ? true : i === 0 || i === n - 1 || (i + 1) % 5 === 0);
  const empty = maxRaw <= 0;

  return (
    <div ref={ref} style={{ width: "100%", position: "relative" }}>
      <svg width={W} height={H} style={{ display: "block", overflow: "visible" }}>
        <defs>
          {seriesList.map((s, si) => (
            <linearGradient key={si} id={`${gid}-${si}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.26" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>

        {/* Gridlines orizzontali */}
        {[0, 0.5, 1].map((g, i) => (
          <line key={i} x1={padL} y1={Y(maxV * g)} x2={W - padR} y2={Y(maxV * g)}
            stroke={C.dim} strokeWidth="1" strokeDasharray={g === 0 ? "0" : "3 5"} opacity={g === 0 ? 0.7 : 0.4} />
        ))}

        {/* Etichetta valore massimo (asse Y) */}
        {!empty && (
          <text x={W - padR} y={Y(maxV) - 4} textAnchor="end" fontSize="9" fill={C.muted} fontFamily="Inter, sans-serif">
            {fmtEuro(maxV)}
          </text>
        )}

        {/* Serie */}
        {seriesList.map((s, si) => {
          const vals = s.values;
          if (vals.length < 1) return null;
          const linePts = vals.map((v, i) => `${X(i)},${Y(v)}`).join(" ");
          const lastI = vals.length - 1;
          const areaD = `M ${X(0)},${Y(0)} ` + vals.map((v, i) => `L ${X(i)},${Y(v)}`).join(" ") + ` L ${X(lastI)},${Y(0)} Z`;
          return (
            <g key={si}>
              {seriesList.length === 1 && <path d={areaD} fill={`url(#${gid}-${si})`} stroke="none" />}
              <polyline points={linePts} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
              <circle cx={X(lastI)} cy={Y(vals[lastI])} r="4" fill={s.color} stroke={C.surface} strokeWidth="1.5" />
            </g>
          );
        })}

        {/* Etichette asse X */}
        {labels.map((lab, i) =>
          showLabel(i) ? (
            <text key={i} x={X(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === n - 1 ? "end" : "middle"}
              fontSize="9" fill={C.muted} fontFamily="Inter, sans-serif">
              {lab}
            </text>
          ) : null
        )}
      </svg>
      {empty && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: C.muted, fontSize: 12, pointerEvents: "none" }}>
          Nessun guadagno registrato nel periodo
        </div>
      )}
    </div>
  );
}

// ─── Box riepilogo (mese / anno) con grafico ───────────────────────────────────

function DeltaBadge({ current, previous, periodLabel }) {
  const { C } = useTheme();
  if (previous == null) return null;
  if (previous <= 0) {
    return current > 0
      ? <span style={{ fontSize: 11, fontWeight: 600, color: C.open }}>nuovo · {periodLabel} precedente a €0</span>
      : null;
  }
  const pct = ((current - previous) / previous) * 100;
  const up = pct >= 0;
  const col = up ? C.open : C.cancelled;
  return (
    <span style={{ fontSize: 11, fontWeight: 700, color: col, fontVariantNumeric: "tabular-nums" }}>
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(0)}% <span style={{ color: C.muted, fontWeight: 400 }}>vs {periodLabel} prec.</span>
    </span>
  );
}

function RevenueBox({ title, icon, color, data, prevTotal, prevLabel }) {
  const { C } = useTheme();
  if (!data) return null;
  const elapsed = data.elapsed ?? data.series.length;
  const slice = data.series.slice(0, Math.max(1, elapsed));
  const values = cumulative(slice);
  const labels = data.labels.slice(0, Math.max(1, elapsed));
  const hasData = data.total > 0;

  return (
    <div style={{
      position: "relative", overflow: "hidden",
      background: `linear-gradient(135deg, ${color}${hasData ? "1c" : "10"} 0%, ${C.surface} 60%)`,
      border: `1px solid ${color}${hasData ? "3a" : "24"}`,
      borderRadius: 16, padding: "22px 24px",
      boxShadow: hasData ? `0 8px 32px ${color}1f` : "none",
      display: "flex", flexDirection: "column", gap: 14,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 600 }}>{title}</div>
          <div style={{ fontSize: 36, fontWeight: 800, color, fontVariantNumeric: "tabular-nums", lineHeight: 1.05, marginTop: 6, textShadow: hasData ? `0 0 22px ${color}44` : "none" }}>
            {fmtEuro(data.total)}
          </div>
          <div style={{ marginTop: 4 }}>
            <DeltaBadge current={data.total} previous={prevTotal} periodLabel={prevLabel} />
          </div>
        </div>
        <span style={{ fontSize: 22 }}>{icon}</span>
      </div>
      <RevenueChart seriesList={[{ values, color }]} labels={labels} />
      <div style={{ fontSize: 11, color: C.muted }}>
        {data.matchCount > 0
          ? `${data.matchCount} partit${data.matchCount === 1 ? "a giocata" : "e giocate"} nel periodo`
          : "Nessuna partita giocata · configura i prezzi dei campi se mancano"}
      </div>
    </div>
  );
}

// ─── Pannello confronto ─────────────────────────────────────────────────────────

function Selector({ type, value, onChange, years }) {
  const { inputSt } = useTheme();
  const sel = { ...inputSt, width: "auto", minWidth: 0, padding: "8px 10px", fontSize: 13 };
  return (
    <div style={{ display: "flex", gap: 8 }}>
      {type === "month" && (
        <select value={value.month} onChange={(e) => onChange({ ...value, month: parseInt(e.target.value) })} style={sel}>
          {MONTHS_IT.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
        </select>
      )}
      <select value={value.year} onChange={(e) => onChange({ ...value, year: parseInt(e.target.value) })} style={sel}>
        {years.map((y) => <option key={y} value={y}>{y}</option>)}
      </select>
    </div>
  );
}

function ComparePanel({ token, years }) {
  const { C, btnGhost } = useTheme();
  const isMobile = useMobile();
  const now = romeNow();
  const [type, setType] = useState("month"); // "month" | "year"
  const [a, setA] = useState({ year: now.y, month: now.mo });
  const [b, setB] = useState({ year: now.y - 1, month: now.mo });
  const [dataA, setDataA] = useState(null);
  const [dataB, setDataB] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const q = (s) => type === "month"
        ? `/revenue?period=month&year=${s.year}&month=${s.month}`
        : `/revenue?period=year&year=${s.year}`;
      const [ra, rb] = await Promise.all([api(q(a), token), api(q(b), token)]);
      setDataA(ra); setDataB(rb);
    } catch { setDataA(null); setDataB(null); }
    finally { setLoading(false); }
  }, [token, type, a, b]);

  useEffect(() => { load(); }, [load]);

  const labelOf = (s) => type === "month" ? `${MONTHS_IT[s.month - 1]} ${s.year}` : `${s.year}`;
  const COL_A = C.accent, COL_B = C.indigo || "#a78bfa";

  // Allinea le due serie alla stessa lunghezza (giorni del mese più lungo / 12 mesi)
  const len = Math.max(dataA?.series.length || 0, dataB?.series.length || 0, 1);
  const padTo = (arr) => { const c = cumulative(arr); while (c.length < len) c.push(c[c.length - 1] ?? 0); return c; };
  const seriesList = [];
  if (dataA) seriesList.push({ values: padTo(dataA.series), color: COL_A, name: labelOf(a) });
  if (dataB) seriesList.push({ values: padTo(dataB.series), color: COL_B, name: labelOf(b) });
  const labels = (dataA?.labels.length >= (dataB?.labels.length || 0) ? dataA?.labels : dataB?.labels) || [];

  const deltaPct = dataA && dataB && dataB.total > 0 ? ((dataA.total - dataB.total) / dataB.total) * 100 : null;

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 20, display: "flex", flexDirection: "column", gap: 16 }}>
      {/* Toggle tipo */}
      <div style={{ display: "flex", gap: 8 }}>
        {[["month", "Mesi"], ["year", "Anni"]].map(([t, lab]) => (
          <button type="button" key={t} onClick={() => setType(t)} style={{
            ...btnGhost, fontSize: 12,
            background: type === t ? C.accentDim : "transparent",
            color: type === t ? C.accent : C.muted,
            borderColor: type === t ? `${C.accent}40` : C.border,
          }}>{lab}</button>
        ))}
      </div>

      {/* Selettori A vs B */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: COL_A, flexShrink: 0 }} />
          <Selector type={type} value={a} onChange={setA} years={years} />
        </div>
        <span style={{ fontSize: 12, color: C.muted, fontWeight: 600 }}>vs</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: COL_B, flexShrink: 0 }} />
          <Selector type={type} value={b} onChange={setB} years={years} />
        </div>
      </div>

      {loading ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 30 }}>
          <Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Carico il confronto...</span>
        </div>
      ) : (
        <>
          <RevenueChart seriesList={seriesList} labels={labels} height={200} />
          {/* Totali + delta */}
          <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr auto", gap: 14, alignItems: "center" }}>
            <div>
              <div style={{ fontSize: 11, color: C.muted }}>{labelOf(a)}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: COL_A, fontVariantNumeric: "tabular-nums" }}>{fmtEuro(dataA?.total)}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: C.muted }}>{labelOf(b)}</div>
              <div style={{ fontSize: 22, fontWeight: 800, color: COL_B, fontVariantNumeric: "tabular-nums" }}>{fmtEuro(dataB?.total)}</div>
            </div>
            {deltaPct != null && (
              <div style={{
                justifySelf: isMobile ? "start" : "end",
                padding: "8px 14px", borderRadius: 10,
                background: deltaPct >= 0 ? `${C.open}18` : `${C.cancelled}18`,
                color: deltaPct >= 0 ? C.open : C.cancelled,
                fontSize: 15, fontWeight: 800, fontVariantNumeric: "tabular-nums",
              }}>
                {deltaPct >= 0 ? "▲" : "▼"} {Math.abs(deltaPct).toFixed(1)}%
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Vista principale ───────────────────────────────────────────────────────────

export default function RevenueView({ token }) {
  const { C, btnPrimary, btnGhost } = useTheme();
  const isMobile = useMobile();
  const now = romeNow();
  const [month, setMonth] = useState(null);
  const [prevMonth, setPrevMonth] = useState(null);
  const [year, setYear] = useState(null);
  const [prevYear, setPrevYear] = useState(null);
  const [loading, setLoading] = useState(true);
  const [compareOpen, setCompareOpen] = useState(false);

  const years = useMemo(() => {
    const out = [];
    for (let y = now.y; y >= now.y - 3; y--) out.push(y);
    return out;
  }, [now.y]);

  const prevMonthSpec = now.mo === 1 ? { y: now.y - 1, mo: 12 } : { y: now.y, mo: now.mo - 1 };

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const [m, pm, y, py] = await Promise.all([
          api(`/revenue?period=month&year=${now.y}&month=${now.mo}`, token),
          api(`/revenue?period=month&year=${prevMonthSpec.y}&month=${prevMonthSpec.mo}`, token),
          api(`/revenue?period=year&year=${now.y}`, token),
          api(`/revenue?period=year&year=${now.y - 1}`, token),
        ]);
        setMonth(m); setPrevMonth(pm); setYear(y); setPrevYear(py);
      } catch { /* box mostrano stato vuoto */ }
      finally { setLoading(false); }
    })();
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 40 }}>
      <Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Carico i guadagni...</span>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {/* Box mese + anno */}
      <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr", gap: 16 }}>
        <RevenueBox
          title={`Mese corrente · ${MONTHS_IT[now.mo - 1]} ${now.y}`}
          icon="📅" color={C.open} data={month}
          prevTotal={prevMonth?.total} prevLabel="mese"
        />
        <RevenueBox
          title={`Anno corrente · ${now.y}`}
          icon="📈" color={C.locked} data={year}
          prevTotal={prevYear?.total} prevLabel="anno"
        />
      </div>

      {/* Confronta */}
      <div>
        <button type="button" onClick={() => setCompareOpen((o) => !o)} style={compareOpen ? { ...btnGhost } : { ...btnPrimary }}>
          {compareOpen ? "Chiudi confronto" : "⚖ Confronta periodi"}
        </button>
      </div>
      {compareOpen && <ComparePanel token={token} years={years} />}

      {/* Nota trasparenza: cosa è incluso nel calcolo */}
      <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5, borderTop: `1px solid ${C.dim}`, paddingTop: 14 }}>
        Conteggia il <strong style={{ color: C.text }}>noleggio campo</strong> delle partite effettivamente giocate, applicando le tariffe per fascia oraria, le differenze tra campi e le eventuali eccezioni di calendario. Non include il noleggio racchette (non viene tracciato chi lo richiede).
      </div>
    </div>
  );
}
