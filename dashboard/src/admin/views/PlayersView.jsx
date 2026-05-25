import { useState, useEffect, useCallback } from "react";
import { useTheme } from "../../shared/ThemeContext";
import Spinner from "../../shared/Spinner";

export default function PlayersAdminView({ token, clubs }) {
  const { C, btnGhost, inputSt } = useTheme();
  const [players, setPlayers] = useState([]);
  const [total,   setTotal]   = useState(0);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ clubId: "", search: "", active: "" });
  const [page, setPage]       = useState(0);
  const PAGE = 40;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: PAGE, offset: page * PAGE });
      if (filters.clubId)  params.set("clubId",  filters.clubId);
      if (filters.search)  params.set("search",  filters.search);
      if (filters.active !== "") params.set("active", filters.active);
      const r = await fetch(`/api/admin/players?${params}`, { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setPlayers(d.players || []);
      setTotal(d.total || 0);
    } catch { setPlayers([]); }
    finally { setLoading(false); }
  }, [token, filters, page]);

  useEffect(() => { load(); }, [load]);

  const setFilter = (k, v) => { setFilters(f => ({ ...f, [k]: v })); setPage(0); };

  const reliabilityColor = v => v >= 0.7 ? C.open : v >= 0.4 ? C.warning : C.cancelled;

  const skillBadge = (level) => {
    if (level === -1) return <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 4, background: `${C.warning}18`, color: C.warning }}>Skill test pendente</span>;
    if (level <= 0)   return <span style={{ color: C.muted }}>—</span>;
    return <span style={{ color: C.accent, fontWeight: 600 }}>{level.toFixed(1)}</span>;
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>

      {/* Filtri */}
      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <select aria-label="Filtra per circolo" value={filters.clubId} onChange={e => setFilter("clubId", e.target.value)}
          style={{ ...inputSt, width: "auto", minWidth: 160 }}>
          <option value="">Tutti i circoli</option>
          {(clubs || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select aria-label="Filtra per stato" value={filters.active} onChange={e => setFilter("active", e.target.value)}
          style={{ ...inputSt, width: "auto", minWidth: 120 }}>
          <option value="">Tutti</option>
          <option value="true">Attivi</option>
          <option value="false">Inattivi</option>
        </select>
        <input aria-label="Cerca giocatore" placeholder="Cerca nome / telefono…" value={filters.search}
          onChange={e => setFilter("search", e.target.value)} style={{ ...inputSt, flex: "1 1 220px", maxWidth: 320 }} />
        <button type="button" onClick={() => { setFilters({ clubId: "", search: "", active: "" }); setPage(0); }} style={btnGhost}>Reset</button>
        <div style={{ marginLeft: "auto", fontSize: 12, color: C.muted, alignSelf: "center" }}>{total} giocatori</div>
      </div>

      {/* Tabella */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
        {loading ? (
          <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 32, justifyContent: "center" }}>
            <Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Caricamento...</span>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, minWidth: 700 }}>
              <thead>
                <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                  {["Nome", "Telefono", "Circolo", "Livello", "Affidabilità", "Partite", "Stato", "Ultimo contatto"].map(h => (
                    <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {players.map((p, i) => (
                  <tr key={p.id}
                    style={{ borderBottom: i < players.length - 1 ? `1px solid ${C.border}` : "none" }}
                    onMouseEnter={e => e.currentTarget.style.background = C.surfaceHover}
                    onMouseLeave={e => e.currentTarget.style.background = "transparent"}>
                    <td style={{ padding: "11px 16px", color: C.text, fontWeight: 600 }}>{p.name || "—"}</td>
                    <td style={{ padding: "11px 16px", color: C.muted, fontSize: 12 }}>{p.phoneNumber}</td>
                    <td style={{ padding: "11px 16px", color: C.muted }}>{p.clubName || "—"}</td>
                    <td style={{ padding: "11px 16px" }}>{skillBadge(p.skillLevel)}</td>
                    <td style={{ padding: "11px 16px" }}>
                      <span style={{ color: reliabilityColor(p.reliabilityScore || 0), fontWeight: 600 }}>
                        {Math.round((p.reliabilityScore || 0) * 100)}%
                      </span>
                    </td>
                    <td style={{ padding: "11px 16px", color: C.text }}>{p.totalMatches}</td>
                    <td style={{ padding: "11px 16px" }}>
                      <span style={{
                        fontSize: 11, padding: "2px 8px", borderRadius: 4,
                        background: p.active ? `${C.open}22` : `${C.cancelled}22`,
                        color: p.active ? C.open : C.cancelled,
                      }}>
                        {p.active ? "Attivo" : "Inattivo"}
                      </span>
                    </td>
                    <td style={{ padding: "11px 16px", color: C.muted, fontSize: 11 }}>
                      {p.lastContactedAt
                        ? new Date(p.lastContactedAt).toLocaleDateString("it-IT", { day: "numeric", month: "short", year: "2-digit" })
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!loading && !players.length && (
          <div style={{ padding: 40, textAlign: "center", color: C.muted, fontSize: 13 }}>Nessun giocatore trovato</div>
        )}
      </div>

      {/* Paginazione */}
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
