import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTheme } from "../../shared/ThemeContext";
import { api } from "../../shared/config";
import Spinner from "../../shared/Spinner";
import Toast from "../../shared/Toast";
import Modal from "../../shared/Modal";

// ─── Helpers ──────────────────────────────────

const fmtPhone   = (p) => p?.startsWith("39") && p.length > 4 ? p.slice(2) : (p || "");
const genderIcon  = (g) => g === "MALE" ? "♂" : g === "FEMALE" ? "♀" : "—";
const GENDER_COLORS = { MALE: "#3b82f6", FEMALE: "#ec4899", UNKNOWN: "#94a3b8" };
const genderColor = (g) => GENDER_COLORS[g] || "#94a3b8";
const rateColor   = (C, r) => r >= 0.6 ? C.open : r >= 0.3 ? C.warning : C.cancelled;

const fmtDate = (d) => {
  if (!d) return "mai";
  const dt = new Date(d), diff = Math.floor((Date.now() - dt.getTime()) / 86400000);
  if (diff === 0) return "oggi";
  if (diff === 1) return "ieri";
  if (diff < 7)  return `${diff}g fa`;
  if (diff < 30) return `${Math.floor(diff / 7)}sett fa`;
  return dt.toLocaleDateString("it-IT", { day: "numeric", month: "short" });
};

// ─── SortArrow — freccia ordinamento ──────────────────────────────────────────

function SortArrow({ field, sortBy, sortDir, onSort }) {
  const { C } = useTheme();
  const active = sortBy === field;
  return (
    <span
      onClick={(e) => { e.stopPropagation(); onSort(field, active && sortDir === "asc" ? "desc" : "asc"); }}
      title={active ? (sortDir === "asc" ? "Ordina decrescente" : "Ordina crescente") : "Ordina"}
      style={{
        cursor: "pointer", fontSize: 11, marginLeft: 3, lineHeight: 1,
        color: active ? C.accent : C.dim,
        display: "inline-block", userSelect: "none",
      }}
    >
      {!active ? "↕" : sortDir === "asc" ? "↑" : "↓"}
    </span>
  );
}

// ─── Th — intestazione colonna (DEVE stare fuori da PlayersView per non smontarsi ad ogni render) ──

function Th({ label, sortField, sortBy, sortDir, onSort, filterEl }) {
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap" }}>
      {label}
      {sortField && <SortArrow field={sortField} sortBy={sortBy} sortDir={sortDir} onSort={onSort} />}
      {filterEl}
    </div>
  );
}

// ─── FilterDropdown — contenitore popup ───────────────────────────────────────

function FilterDropdown({ trigger, children, active }) {
  const { C } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    // composedPath() attraversa il shadow DOM (necessario per il thumb del range input)
    const close = (e) => {
      if (ref.current && e.composedPath().includes(ref.current)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <span ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <span
        onClick={(e) => { e.stopPropagation(); setOpen(v => !v); }}
        style={{
          cursor: "pointer", fontSize: 16, padding: "1px 5px", borderRadius: 5, lineHeight: 1,
          background: active ? C.accentDim : "rgba(255,255,255,0.85)",
          color: active ? C.accent : "#888",
          border: `1px solid ${active ? `${C.accent}50` : "rgba(0,0,0,0.12)"}`,
          userSelect: "none", display: "inline-block",
        }}
        title="Filtra"
      >
        {trigger}
      </span>
      {open && (
        <div
          onMouseDown={(e) => e.stopPropagation()}
          style={{
            position: "absolute", top: "calc(100% + 6px)", left: 0, zIndex: 300,
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10,
            boxShadow: "0 8px 28px rgba(0,0,0,0.16)", minWidth: 200,
            padding: "8px 0",
          }}>
          {children({ close: () => setOpen(false) })}
        </div>
      )}
    </span>
  );
}

// ─── TextFilterDropdown ────────────────────────────────────────────────────────

function TextFilterDropdown({ value, onChange, placeholder, active }) {
  return (
    <FilterDropdown trigger="⌕" active={active}>
      {({ close }) => (
        <div style={{ padding: "8px 12px" }}>
          <input
            autoFocus
            value={value}
            onChange={e => onChange(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter") { e.preventDefault(); close(); }
              if (e.key === "Escape") { e.preventDefault(); onChange(""); close(); }
            }}
            placeholder={placeholder}
            style={{ ...inputSt, fontSize: 12, padding: "6px 10px", width: "100%" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
            <span style={{ fontSize: 10, color: C.muted }}>↵ applica &nbsp;•&nbsp; Esc cancella</span>
            {value && (
              <button onClick={() => { onChange(""); close(); }} style={{ ...btnGhost, fontSize: 11, padding: "3px 10px" }}>
                ✕ Cancella
              </button>
            )}
          </div>
        </div>
      )}
    </FilterDropdown>
  );
}

// ─── MultiSelectFilterDropdown ────────────────────────────────────────────────

function MultiSelectFilterDropdown({ options, selected, onChange, active }) {
  const allSelected = selected.size === 0;

  const toggle = (value) => {
    const next = new Set(selected);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    onChange(next);
  };

  return (
    <FilterDropdown trigger="⌕" active={active}>
      {({ close }) => (
        <div
          tabIndex={0}
          onKeyDown={e => {
            if (e.key === "Enter") { e.preventDefault(); close(); }
            if (e.key === "Escape") { e.preventDefault(); onChange(new Set()); close(); }
          }}
          style={{ padding: "4px 0", outline: "none" }}
        >
          {/* Tutti */}
          <div
            onClick={() => onChange(new Set())}
            style={{
              padding: "7px 16px", fontSize: 12, cursor: "pointer",
              display: "flex", alignItems: "center", gap: 8,
              color: allSelected ? C.accent : C.text,
              fontWeight: allSelected ? 700 : 400,
              background: allSelected ? C.accentDim : "transparent",
            }}
            onMouseEnter={e => !allSelected && (e.currentTarget.style.background = C.surfaceHover)}
            onMouseLeave={e => !allSelected && (e.currentTarget.style.background = "transparent")}
          >
            <span style={{
              width: 14, height: 14, border: `1.5px solid ${allSelected ? C.accent : C.border}`,
              borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center",
              background: allSelected ? C.accent : "transparent", flexShrink: 0,
            }}>
              {allSelected && <span style={{ color: "#fff", fontSize: 9, fontWeight: 700 }}>✓</span>}
            </span>
            Tutti
          </div>

          <div style={{ height: 1, background: C.border, margin: "4px 0" }} />

          {options.map(opt => {
            const checked = selected.has(opt.value);
            return (
              <div key={opt.value} onClick={() => toggle(opt.value)} style={{
                padding: "7px 16px", fontSize: 12, cursor: "pointer",
                display: "flex", alignItems: "center", gap: 8,
                color: checked ? C.accent : C.text,
                background: checked ? `${C.accent}08` : "transparent",
              }}
                onMouseEnter={e => !checked && (e.currentTarget.style.background = C.surfaceHover)}
                onMouseLeave={e => !checked && (e.currentTarget.style.background = "transparent")}
              >
                <span style={{
                  width: 14, height: 14, border: `1.5px solid ${checked ? C.accent : C.border}`,
                  borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center",
                  background: checked ? C.accent : "transparent", flexShrink: 0,
                }}>
                  {checked && <span style={{ color: "#fff", fontSize: 9, fontWeight: 700 }}>✓</span>}
                </span>
                {opt.label}
              </div>
            );
          })}

          {/* Bottone OK + hints */}
          <div style={{ padding: "8px 12px 4px", borderTop: `1px solid ${C.border}`, marginTop: 4 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
              <span style={{ fontSize: 10, color: C.muted }}>↵ applica &nbsp;•&nbsp; Esc cancella</span>
            </div>
            <button onClick={close} style={{ ...btnPrimary, width: "100%", fontSize: 12, padding: "6px 0" }}>
              OK
            </button>
          </div>
        </div>
      )}
    </FilterDropdown>
  );
}

// ─── ReliabilityFilterDropdown ─────────────────────────────────────────────────

function ReliabilityFilterDropdown({ minReliability, onChange, active }) {
  // localPct: valore durante il drag (anteprima) — il filtro si applica solo al rilascio
  const [localPct, setLocalPct] = useState(Math.round(minReliability * 100));
  const [dragging, setDragging] = useState(false);

  // Sincronizza localPct se il valore esterno cambia (es. reset)
  useEffect(() => { if (!dragging) setLocalPct(Math.round(minReliability * 100)); }, [minReliability, dragging]);

  const displayPct = dragging ? localPct : Math.round(minReliability * 100);
  const color = displayPct >= 60 ? C.open : displayPct >= 30 ? C.warning : C.cancelled;

  return (
    <FilterDropdown trigger="⌕" active={active}>
      {() => (
        <div style={{ padding: "12px 16px", width: 240, boxSizing: "border-box", overflow: "hidden" }}>
          {/* Intestazione con valore live */}
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, fontSize: 12 }}>
            <span style={{ color: C.muted }}>Affidabilità minima</span>
            <span style={{
              color, fontWeight: 700, fontSize: 13,
              transition: dragging ? "none" : "color 0.2s",
              minWidth: 80, textAlign: "right",
            }}>
              ≥ {displayPct}%
              {dragging && <span style={{ fontSize: 10, color: C.muted, fontWeight: 400, marginLeft: 4 }}>(lascia per applicare)</span>}
            </span>
          </div>

          {/* Barra di anteprima */}
          <div style={{ height: 4, background: C.dim, borderRadius: 2, overflow: "hidden", marginBottom: 8 }}>
            <div style={{
              height: "100%", width: "100%", background: color, borderRadius: 2,
              transform: `scaleX(${displayPct / 100})`, transformOrigin: "left",
              transition: "transform 0.05s, background 0.2s",
            }} />
          </div>

          {/* Slider */}
          <input
            type="range" min={0} max={100} step={5}
            value={localPct}
            onChange={e => { setLocalPct(parseInt(e.target.value)); setDragging(true); }}
            onPointerUp={e => { const v = parseInt(e.target.value); setLocalPct(v); setDragging(false); onChange(v / 100); }}
            style={{ width: "100%", accentColor: color, cursor: "pointer" }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.dim, marginTop: 2 }}>
            <span>0%</span><span>50%</span><span>100%</span>
          </div>

          {minReliability > 0 && !dragging && (
            <button onClick={() => { setLocalPct(0); onChange(0); }}
              style={{ ...btnGhost, fontSize: 11, padding: "4px 10px", marginTop: 8, width: "100%" }}>
              ✕ Rimuovi filtro
            </button>
          )}
        </div>
      )}
    </FilterDropdown>
  );
}

// ─── PlayerProfile ────────────────────────────

function PlayerProfile({ playerId, token, onClose, onUpdated }) {
  const { C, inputSt, btnPrimary, btnGhost, labelSt } = useTheme();
  const [player, setPlayer]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [editName, setEditName] = useState("");
  const [editGender, setEditGender] = useState("UNKNOWN");
  const [saving, setSaving]     = useState(false);
  const [toast, setToast]       = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api(`/players/${playerId}`, token);
      setPlayer(d); setEditName(d.name || ""); setEditGender(d.gender || "UNKNOWN");
    } finally { setLoading(false); }
  }, [playerId, token]);

  useEffect(() => { load(); }, [load]);

  const patch = async (data) => {
    setSaving(true);
    try {
      await api(`/players/${playerId}`, token, { method: "PATCH", body: JSON.stringify(data) });
      await load(); onUpdated?.();
      setToast({ msg: "Salvato ✓", type: "ok" });
    } catch (e) { setToast({ msg: e.message, type: "err" }); }
    finally { setSaving(false); }
  };

  if (loading) return <Modal title="Profilo giocatore" onClose={onClose}><Spinner /></Modal>;
  if (!player) return null;

  const showRate = player.reliabilityScore || 0.33;
  const rColor   = rateColor(C, showRate);

  return (
    <Modal title="Profilo giocatore" onClose={onClose}>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ width: 48, height: 48, borderRadius: 12, background: C.accentDim, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>
          {player.active ? "🎾" : "⛔"}
        </div>
        <div style={{ flex: 1 }}>
          <input value={editName} onChange={e => setEditName(e.target.value)}
            placeholder="Nome giocatore"
            style={{ ...inputSt, fontSize: 16, fontWeight: 700, padding: "6px 10px" }}
            onBlur={() => editName !== player.name && patch({ name: editName })}
            onKeyDown={e => e.key === "Enter" && patch({ name: editName })} />
          <div style={{ fontSize: 12, color: C.muted, marginTop: 4, fontFamily: "monospace" }}>{player.phoneNumber}</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
        {[
          { l: "Inviti",   v: player.stats.totalInvited },
          { l: "Presenti", v: player.stats.totalAccepted },
          { l: "No-show",  v: player.stats.totalNoShow, c: player.stats.totalNoShow > 0 ? C.cancelled : C.muted },
        ].map(s => (
          <div key={s.l} style={{ background: C.bg, border: `1px solid ${C.dim}`, borderRadius: 10, padding: "12px 14px", textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: s.c || C.text }}>{s.v}</div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{s.l}</div>
          </div>
        ))}
      </div>

      <div>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Affidabilità</span>
          <span style={{ fontSize: 13, fontWeight: 700, color: rColor }}>{(showRate * 100).toFixed(0)}%</span>
        </div>
        <div style={{ height: 6, background: C.dim, borderRadius: 3, overflow: "hidden" }}>
          <div style={{ height: "100%", width: "100%", background: rColor, borderRadius: 3, transform: `scaleX(${showRate})`, transformOrigin: "left", transition: "transform 0.5s" }} />
        </div>
      </div>

      <div>
        <label style={labelSt}>Livello di gioco</label>
        <input type="number" step="0.5" min="1" max="10" defaultValue={player.skillLevel} disabled={saving}
          style={{ ...inputSt, fontSize: 16, fontWeight: 700, textAlign: "center" }}
          onBlur={e => { const v = parseFloat(e.target.value); if (!isNaN(v) && v !== player.skillLevel) patch({ skillLevel: v }); }}
          onKeyDown={e => { if (e.key === "Enter") { const v = parseFloat(e.currentTarget.value); if (!isNaN(v) && v !== player.skillLevel) patch({ skillLevel: v }); } }} />
        <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Premi Invio o esci dal campo per salvare (es. 2.5)</div>
      </div>

      <div>
        <label style={labelSt}>Sesso</label>
        <div style={{ display: "flex", gap: 8 }}>
          {[
            { v: "MALE",    label: "♂ Uomo",         color: GENDER_COLORS.MALE },
            { v: "FEMALE",  label: "♀ Donna",        color: GENDER_COLORS.FEMALE },
            { v: "UNKNOWN", label: "— Non definito",  color: C.muted  },
          ].map(({ v, label, color }) => (
            <button key={v} disabled={saving}
              onClick={() => { setEditGender(v); patch({ gender: v }); }}
              style={{
                ...btnGhost, flex: 1,
                background: editGender === v ? `${color}18` : "transparent",
                color: editGender === v ? color : C.muted,
                borderColor: editGender === v ? `${color}50` : C.border,
                fontWeight: editGender === v ? 700 : 400,
              }}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: C.bg, border: `1px solid ${C.dim}`, borderRadius: 10, padding: "12px 16px" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            {player.active ? "✅ Giocatore attivo" : "🚫 Giocatore disattivato"}
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
            {player.active ? "Riceve inviti alle partite" : "Non riceve inviti alle partite"}
          </div>
        </div>
        <button disabled={saving} onClick={() => patch({ active: !player.active })} style={{
          ...btnGhost,
          color: player.active ? C.cancelled : C.accent,
          borderColor: player.active ? `${C.cancelled}40` : `${C.accent}40`,
        }}>
          {saving ? "..." : player.active ? "Disattiva" : "Riattiva"}
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <label style={labelSt}>Preferenze orario (da matchmaking)</label>
        {[
          { key: "avoidMorning",   label: "Evita mattina",         sub: "Non invitare prima delle 14:00", icon: "☀️" },
          { key: "avoidAfternoon", label: "Evita pomeriggio/sera", sub: "Non invitare dopo le 14:00",    icon: "🌙" },
        ].map(({ key, label, sub, icon }) => (
          <div key={key} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: C.bg, border: `1px solid ${C.dim}`, borderRadius: 10, padding: "10px 14px" }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{icon} {label}</div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 1 }}>{sub}</div>
            </div>
            <button disabled={saving} onClick={() => patch({ [key]: !player[key] })} style={{
              ...btnGhost,
              color: player[key] ? C.warning : C.muted,
              borderColor: player[key] ? `${C.warning}50` : C.border,
              background: player[key] ? `${C.warning}12` : "transparent",
            }}>
              {saving ? "..." : player[key] ? "Attivo" : "Off"}
            </button>
          </div>
        ))}
        <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
          Contatti odierni: {player.morningContactsToday ?? 0} ☀ mattina — {player.afternoonContactsToday ?? 0} 🌙 sera
        </div>
      </div>

      {player.history?.length > 0 && (
        <div>
          <label style={labelSt}>Ultime {player.history.length} partite</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {player.history.map((h, i) => (
              <div key={i} style={{
                display: "flex", alignItems: "center", justifyContent: "space-between",
                background: C.bg, border: `1px solid ${C.dim}`, borderRadius: 8, padding: "8px 12px", fontSize: 12,
              }}>
                <span style={{ color: C.muted }}>{h.date} — {h.court}</span>
                <span style={{
                  fontWeight: 700, fontSize: 11, padding: "2px 8px", borderRadius: 8,
                  background: h.showed ? `${C.open}18` : `${C.cancelled}18`,
                  color: h.showed ? C.open : h.noShow ? C.cancelled : C.muted,
                }}>
                  {h.showed ? "✓ Presente" : h.noShow ? "✗ No-show" : h.invStatus}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </Modal>
  );
}

// ─── AddPlayerModal ────────────────────────────

function AddPlayerModal({ token, onClose, onCreated }) {
  const [name, setName]         = useState("");
  const [phone, setPhone]       = useState("");
  const [skillLevel, setSkill]  = useState("");
  const [gender, setGender]     = useState("UNKNOWN");
  const [saving, setSaving]     = useState(false);
  const [err, setErr]           = useState("");

  const submit = async () => {
    if (!name.trim() || !name.trim().includes(" ")) { setErr("Inserisci nome e cognome"); return; }
    if (!phone.trim()) { setErr("Inserisci il numero di telefono"); return; }
    setSaving(true); setErr("");
    try {
      await api("/players", token, {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(), phoneNumber: phone.trim(), gender,
          ...(skillLevel !== "" ? { skillLevel: parseFloat(skillLevel) } : {}),
        }),
      });
      onCreated(); onClose();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Modal title="Aggiungi giocatore" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={labelSt}>Nome e cognome *</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Mario Rossi" style={inputSt} autoFocus onKeyDown={e => e.key === "Enter" && submit()} />
        </div>
        <div>
          <label style={labelSt}>Numero di telefono *</label>
          <input value={phone} onChange={e => setPhone(e.target.value)} placeholder="393471234567" style={inputSt} onKeyDown={e => e.key === "Enter" && submit()} />
          <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Solo cifre, con prefisso (es. 393471234567)</div>
        </div>
        <div>
          <label style={labelSt}>Sesso</label>
          <div style={{ display: "flex", gap: 8 }}>
            {[
              { v: "MALE",    label: "♂ Uomo",   color: "#3b82f6" },
              { v: "FEMALE",  label: "♀ Donna",  color: "#ec4899" },
              { v: "UNKNOWN", label: "— N/D",     color: C.muted  },
            ].map(({ v, label, color }) => (
              <button key={v} type="button" onClick={() => setGender(v)} style={{
                ...btnGhost, flex: 1,
                background: gender === v ? `${color}18` : "transparent",
                color: gender === v ? color : C.muted,
                borderColor: gender === v ? `${color}50` : C.border,
                fontWeight: gender === v ? 700 : 400,
              }}>{label}</button>
            ))}
          </div>
        </div>
        <div>
          <label style={labelSt}>Livello di gioco (opzionale)</label>
          <input type="number" step="0.5" min="1" max="7" value={skillLevel}
            onChange={e => setSkill(e.target.value)}
            placeholder="es. 3.0 — lascia vuoto se da assegnare" style={inputSt}
            onKeyDown={e => e.key === "Enter" && submit()} />
          <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>Se non assegnato, il giocatore potrà prenotare ma non riceverà inviti automatici</div>
        </div>
        {err && <div style={{ fontSize: 12, color: "#ef4444", padding: "8px 12px", background: "#fef2f2", borderRadius: 8 }}>⚠ {err}</div>}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button onClick={onClose} style={btnGhost} disabled={saving}>Annulla</button>
          <button onClick={submit} style={btnPrimary} disabled={saving}>{saving ? "Creando..." : "Aggiungi giocatore"}</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── PlayersView ──────────────────────────────

export default function PlayersView({ token }) {
  const { C, inputSt, btnPrimary, btnGhost, labelSt } = useTheme();
  const [players, setPlayers]   = useState([]);
  const [loading, setLoading]   = useState(true);
  const [sortBy, setSortBy]     = useState("name");
  const [sortDir, setSortDir]   = useState("asc");

  // Filtri per colonna
  const [fName,        setFName]        = useState("");         // text
  const [fPhone,       setFPhone]       = useState("");         // text
  const [fGender,      setFGender]      = useState(new Set());  // multiselect
  const [fSkill,       setFSkill]       = useState(new Set());  // multiselect ("no-skill" | "1.0" | "2.0" ...)
  const [fStatus,      setFStatus]      = useState(new Set());  // multiselect ("active" | "inactive")
  const [fReliability, setFReliability] = useState(0);         // slider 0-1

  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [showAddPlayer,  setShowAddPlayer]  = useState(false);
  const [togglePhone,    setTogglePhone]    = useState("");
  const [toggleResult,   setToggleResult]   = useState(null);
  const [toggleLoading,  setToggleLoading]  = useState(false);
  const [toggleErr,      setToggleErr]      = useState("");
  const [toast,          setToast]          = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api("/players", token);
      setPlayers(d);
    } finally { setLoading(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  // Opzioni dinamiche per livello (da dati reali)
  const skillOptions = useMemo(() => {
    const levels = new Set(players.filter(p => p.skillLevel > 0).map(p => String(p.skillLevel)));
    return [
      { value: "no-skill", label: "⚠ Senza livello" },
      ...[...levels].sort((a, b) => parseFloat(a) - parseFloat(b)).map(l => ({ value: l, label: `Livello ${l}` })),
    ];
  }, [players]);

  const genderOptions = [
    { value: "MALE",    label: "♂ Uomini" },
    { value: "FEMALE",  label: "♀ Donne" },
    { value: "UNKNOWN", label: "— N/D" },
  ];

  const statusOptions = [
    { value: "active",   label: "✅ Attivi" },
    { value: "inactive", label: "🚫 Disattivati" },
  ];

  // ─── Filtro + sort lato client ────────────────

  const filtered = useMemo(() => {
    let list = [...players];

    if (fName.trim())  list = list.filter(p => (p.name || "").toLowerCase().includes(fName.trim().toLowerCase()));
    if (fPhone.trim()) list = list.filter(p => fmtPhone(p.phoneNumber).includes(fPhone.trim()));

    if (fGender.size > 0) list = list.filter(p => fGender.has(p.gender || "UNKNOWN"));

    if (fSkill.size > 0) {
      list = list.filter(p => {
        if (fSkill.has("no-skill") && p.skillLevel <= 0) return true;
        if (fSkill.has(String(p.skillLevel)) && p.skillLevel > 0) return true;
        return false;
      });
    }

    if (fStatus.size > 0) {
      list = list.filter(p => {
        if (fStatus.has("active")   &&  p.active) return true;
        if (fStatus.has("inactive") && !p.active) return true;
        return false;
      });
    }

    if (fReliability > 0) list = list.filter(p => (p.reliabilityScore || 0.33) >= fReliability);

    list.sort((a, b) => {
      let va, vb;
      if (sortBy === "name")             { va = (a.name || "").toLowerCase(); vb = (b.name || "").toLowerCase(); }
      else if (sortBy === "skillLevel")  { va = a.skillLevel;                 vb = b.skillLevel; }
      else if (sortBy === "reliability") { va = a.reliabilityScore || 0.33;   vb = b.reliabilityScore || 0.33; }
      else if (sortBy === "contacted")   { va = a.lastContactedAt ? new Date(a.lastContactedAt).getTime() : 0; vb = b.lastContactedAt ? new Date(b.lastContactedAt).getTime() : 0; }
      if (va < vb) return sortDir === "asc" ? -1 : 1;
      if (va > vb) return sortDir === "asc" ?  1 : -1;
      return 0;
    });

    return list;
  }, [players, fName, fPhone, fGender, fSkill, fStatus, fReliability, sortBy, sortDir]);

  const onSort = (field, dir) => { setSortBy(field); setSortDir(dir); };

  const hasAnyFilter = fName || fPhone || fGender.size > 0 || fSkill.size > 0 || fStatus.size > 0 || fReliability > 0;

  const clearAll = () => {
    setFName(""); setFPhone(""); setFGender(new Set()); setFSkill(new Set()); setFStatus(new Set()); setFReliability(0);
  };

  const exportCsv = () => {
    const rows = [
      ["Nome", "Telefono", "Sesso", "Livello", "Affidabilità %", "Stato", "Ultimo contatto"],
      ...filtered.map(p => [
        p.name || "", p.phoneNumber,
        p.gender === "MALE" ? "M" : p.gender === "FEMALE" ? "F" : "N/D",
        p.skillLevel > 0 ? p.skillLevel : "N/A",
        ((p.reliabilityScore || 0.33) * 100).toFixed(0) + "%",
        p.active ? "Attivo" : "Disattivato",
        p.lastContactedAt ? new Date(p.lastContactedAt).toLocaleDateString("it-IT") : "Mai",
      ]),
    ];
    const csv = rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(";")).join("\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "giocatori.csv"; a.click();
    URL.revokeObjectURL(url);
  };

  const handleToggle = async () => {
    if (!togglePhone.trim()) return;
    setToggleLoading(true); setToggleErr(""); setToggleResult(null);
    try {
      const d = await api("/players/toggle", token, { method: "POST", body: JSON.stringify({ phoneNumber: togglePhone.trim() }) });
      setToggleResult(d); setTogglePhone(""); load();
    } catch (e) { setToggleErr(e.message); }
    finally { setToggleLoading(false); }
  };

  const totalActive  = players.filter(p => p.active).length;
  const noSkillCount = players.filter(p => p.skillLevel <= 0).length;

  // Layout colonne: Nome | Telefono | Sesso | Livello | Affidabilità | Contattato | Stato
  const COLS = "2fr 1.2fr 0.45fr 0.65fr 1fr 0.85fr 0.6fr";

  // Th è definito a livello modulo (fuori da PlayersView) — non cambia riferimento ad ogni render

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>

      {/* ── Attiva/Disattiva ── */}
      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Attiva / Disattiva per numero</div>
        <div style={{ display: "flex", gap: 10 }}>
          <input value={togglePhone} onChange={e => setTogglePhone(e.target.value)}
            placeholder="+393471234567" style={{ ...inputSt, flex: 1 }}
            onKeyDown={e => e.key === "Enter" && handleToggle()} />
          <button onClick={handleToggle} disabled={toggleLoading || !togglePhone.trim()} style={btnPrimary}>
            {toggleLoading ? "..." : "Toggle"}
          </button>
        </div>
        {toggleErr && <div style={{ fontSize: 12, color: C.cancelled }}>⚠ {toggleErr}</div>}
        {toggleResult && (
          <div style={{ fontSize: 13, padding: "10px 14px", borderRadius: 8, color: toggleResult.active ? C.accent : C.muted, background: toggleResult.active ? C.accentDim : C.dim }}>
            {toggleResult.message}
          </div>
        )}
      </div>

      {/* ── Stats + azioni ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12, color: C.muted }}>
          <strong style={{ color: C.text }}>{players.length}</strong> totali ·{" "}
          <strong style={{ color: C.open }}>{totalActive}</strong> attivi
          {noSkillCount > 0 && <> · <strong style={{ color: C.warning }}>{noSkillCount}</strong> senza livello</>}
          {filtered.length !== players.length && <> · <strong style={{ color: C.accent }}>{filtered.length}</strong> visibili</>}
        </span>
        <div style={{ flex: 1 }} />
        {hasAnyFilter && (
          <button onClick={clearAll} style={{ ...btnGhost, fontSize: 11, padding: "4px 12px", color: C.cancelled, borderColor: `${C.cancelled}40` }}>
            ✕ Rimuovi filtri
          </button>
        )}
        <button onClick={() => setShowAddPlayer(true)} style={{ ...btnPrimary, whiteSpace: "nowrap" }}>+ Aggiungi</button>
        <button onClick={exportCsv} style={{ ...btnGhost, fontSize: 11, whiteSpace: "nowrap" }}>↓ CSV</button>
      </div>

      {/* ── Tabella ── */}
      {loading ? (
        <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 20 }}>
          <Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Caricamento...</span>
        </div>
      ) : (
        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "visible" }}>

          {/* Header */}
          <div style={{
            display: "grid", gridTemplateColumns: COLS,
            padding: "10px 16px", borderBottom: `1px solid ${C.border}`,
            fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em",
            position: "relative",
          }}>
            <Th label="Nome" sortField="name" sortBy={sortBy} sortDir={sortDir} onSort={onSort}
              filterEl={<TextFilterDropdown value={fName} onChange={setFName} placeholder="Cerca nome…" active={!!fName} />} />
            <Th label="Telefono" sortBy={sortBy} sortDir={sortDir} onSort={onSort}
              filterEl={<TextFilterDropdown value={fPhone} onChange={setFPhone} placeholder="Cerca numero…" active={!!fPhone} />} />
            <Th label="Sesso" sortBy={sortBy} sortDir={sortDir} onSort={onSort}
              filterEl={<MultiSelectFilterDropdown options={genderOptions} selected={fGender} onChange={setFGender} active={fGender.size > 0} />} />
            <Th label="Liv." sortField="skillLevel" sortBy={sortBy} sortDir={sortDir} onSort={onSort}
              filterEl={<MultiSelectFilterDropdown options={skillOptions} selected={fSkill} onChange={setFSkill} active={fSkill.size > 0} />} />
            <Th label="Affidabilità" sortField="reliability" sortBy={sortBy} sortDir={sortDir} onSort={onSort}
              filterEl={<ReliabilityFilterDropdown minReliability={fReliability} onChange={setFReliability} active={fReliability > 0} />} />
            <Th label="Contattato" sortField="contacted" sortBy={sortBy} sortDir={sortDir} onSort={onSort} />
            <Th label="Stato" sortBy={sortBy} sortDir={sortDir} onSort={onSort}
              filterEl={<MultiSelectFilterDropdown options={statusOptions} selected={fStatus} onChange={setFStatus} active={fStatus.size > 0} />} />
          </div>

          {filtered.length === 0 && (
            <div style={{ padding: 32, textAlign: "center", color: C.muted, fontSize: 13 }}>Nessun giocatore trovato</div>
          )}

          {filtered.map((p, i) => {
            const rate = p.reliabilityScore || 0.33;
            return (
              <div key={p.id} onClick={() => setSelectedPlayer(p.id)} style={{
                display: "grid", gridTemplateColumns: COLS,
                padding: "11px 16px",
                borderBottom: i < filtered.length - 1 ? `1px solid ${C.border}` : "none",
                fontSize: 12, color: C.text, alignItems: "center", cursor: "pointer",
                background: !p.active ? `${C.cancelled}05` : "transparent",
                transition: "background 0.1s",
              }}
                onMouseEnter={e => e.currentTarget.style.background = C.surfaceHover}
                onMouseLeave={e => e.currentTarget.style.background = !p.active ? `${C.cancelled}05` : "transparent"}
              >
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: p.active ? C.text : C.muted }}>
                  {p.name || <span style={{ color: C.dim }}>—</span>}
                </span>
                <span style={{ color: C.muted, fontFamily: "monospace", fontSize: 11 }}>{fmtPhone(p.phoneNumber)}</span>
                <span style={{ fontSize: 14, fontWeight: 700, color: genderColor(p.gender) }}>{genderIcon(p.gender)}</span>
                <span style={{
                  display: "inline-flex", width: 28, height: 22, alignItems: "center", justifyContent: "center",
                  borderRadius: 6,
                  background: p.skillLevel > 0 ? C.accentDim : `${C.warning}20`,
                  color: p.skillLevel > 0 ? C.accent : C.warning,
                  fontSize: 11, fontWeight: 700,
                }}>
                  {p.skillLevel > 0 ? p.skillLevel : "—"}
                </span>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <div style={{ flex: 1, height: 4, background: C.dim, borderRadius: 2, overflow: "hidden", maxWidth: 54 }}>
                    <div style={{ height: "100%", width: `${rate * 100}%`, background: rateColor(C, rate), borderRadius: 2 }} />
                  </div>
                  <span style={{ fontSize: 10, color: rateColor(C, rate), minWidth: 28 }}>{(rate * 100).toFixed(0)}%</span>
                </div>
                <span style={{ fontSize: 11, color: p.lastContactedAt ? C.muted : C.dim }}>{fmtDate(p.lastContactedAt)}</span>
                <span style={{ fontSize: 10, fontWeight: 600 }}>
                  {p.active ? <span style={{ color: C.open }}>● attivo</span> : <span style={{ color: C.cancelled }}>● off</span>}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {selectedPlayer && (
        <PlayerProfile playerId={selectedPlayer} token={token} onClose={() => setSelectedPlayer(null)} onUpdated={load} />
      )}
      {showAddPlayer && (
        <AddPlayerModal token={token} onClose={() => setShowAddPlayer(false)}
          onCreated={() => { load(); setToast({ msg: "Giocatore aggiunto ✓", type: "ok" }); }} />
      )}
      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </div>
  );
}
