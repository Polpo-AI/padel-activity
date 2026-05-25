import { useState, useEffect, useCallback } from "react";
import { useTheme } from "../../shared/ThemeContext";
import Spinner from "../../shared/Spinner";

const STATUS_LABEL = { OPEN: "Aperta", LOCKED: "Chiusa", CANCELLED: "Cancellata", UNFILLED: "Non riempita" };

export default function MatchesView({ token, clubs }) {
  const { C, btnGhost, inputSt } = useTheme();
  const [matches, setMatches] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ clubId: "", status: "", date: "" });
  const [page, setPage] = useState(0);
  const PAGE = 30;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: PAGE, offset: page * PAGE });
      if (filters.clubId) params.set("clubId", filters.clubId);
      if (filters.status) params.set("status", filters.status);
      if (filters.date) params.set("date", filters.date);
      const r = await fetch(`/api/admin/matches?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setMatches(d.matches || []);
      setTotal(d.total || 0);
    } catch { setMatches([]); }
    finally { setLoading(false); }
  }, [token, filters, page]);

  useEffect(() => { load(); }, [load]);

  const setFilter = (k, v) => { setFilters(f => ({ ...f, [k]: v })); setPage(0); };

  const fmtDt = d => new Date(d).toLocaleString("it-IT", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      {/* Filters */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div style={{ minWidth: 160 }}>
          <select aria-label="Filtra per circolo" value={filters.clubId} onChange={e => setFilter("clubId", e.target.value)}
            style={{ ...inputSt, width: "auto", minWidth: 160 }}>
            <option value="">Tutti i circoli</option>
            {(clubs || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <select aria-label="Filtra per stato" value={filters.status} onChange={e => setFilter("status", e.target.value)}
            style={{ ...inputSt, width: "auto", minWidth: 140 }}>
            <option value="">Tutti gli stati</option>
            {Object.entries(STATUS_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div>
          <input aria-label="Filtra per data" type="date" value={filters.date} onChange={e => setFilter("date", e.target.value)}
            style={{ ...inputSt, width: "auto" }} />
        </div>
        <button type="button" onClick={() => { setFilters({ clubId: "", status: "", date: "" }); setPage(0); }} style={btnGhost}>Reset</button>
        <div style={{ marginLeft: "auto", fontSize: 12, color: C.muted, alignSelf: "center" }}>{total} partite</div>
      </div>

      {/* Table */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
        {loading ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 32, justifyContent: "center" }}><Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Caricamento...</span></div>
        ) : (
          <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 640 }}>
            <thead>
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {["Circolo", "Campo", "Data/ora", "Stato", "Livello", "Giocatori", "Squadra"].map(h => (
                  <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matches.map((m, i) => (
                <tr key={m.id} style={{ borderBottom: i < matches.length - 1 ? `1px solid ${C.border}` : "none" }}
                  onMouseEnter={e => e.currentTarget.style.background = C.surfaceHover}
                  onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                  <td style={{ padding: "11px 16px", color: C.text, fontWeight: 600 }}>{m.clubName}</td>
                  <td style={{ padding: "11px 16px", color: C.muted }}>{m.court || "—"}</td>
                  <td style={{ padding: "11px 16px", color: C.text, whiteSpace: "nowrap" }}>{fmtDt(m.startTime)}</td>
                  <td style={{ padding: "11px 16px" }}>
                    <span style={{ fontSize: 11, padding: "3px 8px", borderRadius: 4, background: `${{ OPEN: C.open, LOCKED: C.locked, CANCELLED: C.cancelled, UNFILLED: C.unfilled }[m.status] || C.muted}22`, color: { OPEN: C.open, LOCKED: C.locked, CANCELLED: C.cancelled, UNFILLED: C.unfilled }[m.status] || C.muted }}>
                      {STATUS_LABEL[m.status] || m.status}
                    </span>
                  </td>
                  <td style={{ padding: "11px 16px", color: C.muted }}>{m.skillLevel?.toFixed(1) || "—"}</td>
                  <td style={{ padding: "11px 16px" }}>
                    <span style={{ color: m.playersConfirmed >= m.playersNeeded ? C.open : C.muted }}>
                      {m.playersConfirmed}/{m.playersNeeded}
                    </span>
                  </td>
                  <td style={{ padding: "11px 16px", color: C.muted, fontSize: 12 }}>{m.players?.join(", ") || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        {!loading && !matches.length && (
          <div style={{ padding: 40, textAlign: "center", color: C.muted, fontSize: 13 }}>Nessuna partita trovata</div>
        )}
      </div>

      {/* Pagination */}
      {total > PAGE && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", justifyContent: "center" }}>
          <button type="button" onClick={() => setPage(p => Math.max(0, p - 1))} disabled={page === 0} style={btnGhost}>← Prec</button>
          <span style={{ fontSize: 12, color: C.muted }}>Pagina {page + 1} / {Math.ceil(total / PAGE)}</span>
          <button type="button" onClick={() => setPage(p => p + 1)} disabled={(page + 1) * PAGE >= total} style={btnGhost}>Succ →</button>
        </div>
      )}
    </div>
  );
}
