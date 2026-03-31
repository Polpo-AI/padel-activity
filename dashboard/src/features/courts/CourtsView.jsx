import { useState, useEffect, useCallback } from "react";
import { C, api, fmtTime, fmtDate, today, inputSt, btnPrimary, btnGhost, labelSt } from "../../shared/config";
import Spinner from "../../shared/Spinner";
import Badge from "../../shared/Badge";
import Toast from "../../shared/Toast";
import Modal from "../../shared/Modal";

// ─── Calendar helpers ─────────────────────────

function getMonday(dateStr) {
  const d = new Date(dateStr + "T12:00:00");
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().split("T")[0];
}

function addDays(dateStr, n) {
  const d = new Date(dateStr + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
}

function getWeekDays(mondayStr) {
  return Array.from({ length: 7 }, (_, i) => addDays(mondayStr, i));
}

// Returns YYYY-MM-DD in Europe/Rome timezone (matches how users think of the day)
function matchDay(isoString) {
  return new Date(isoString).toLocaleString("sv-SE", { timeZone: "Europe/Rome" }).split(" ")[0];
}

// ─── HoursEditor ─────────────────────────────

function HoursEditor({ token, club, onUpdated }) {
  const [open, setOpen] = useState(club?.openTime || "08:00");
  const [close, setClose] = useState(club?.closeTime || "23:30");
  const [slot, setSlot] = useState(club?.slotDurationMinutes || club?.matchDuration || 90);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const save = async () => {
    setSaving(true);
    try {
      const d = await api("/club/hours", token, { method: "PUT", body: JSON.stringify({ openTime: open, closeTime: close, slotDurationMinutes: slot }) });
      onUpdated(d);
      setToast({ msg: "Orari salvati ✓", type: "ok" });
    } catch (e) { setToast({ msg: e.message, type: "err" }); }
    finally { setSaving(false); }
  };

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 16 }}>⏰ Orari apertura circolo</div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr auto", gap: 12, alignItems: "end" }}>
        <div>
          <label style={labelSt}>Apertura</label>
          <input type="time" value={open} onChange={e => setOpen(e.target.value)} style={inputSt} />
        </div>
        <div>
          <label style={labelSt}>Chiusura</label>
          <input type="time" value={close} onChange={e => setClose(e.target.value)} style={inputSt} />
        </div>
        <div>
          <label style={labelSt}>Durata slot (min)</label>
          <select value={slot} onChange={e => setSlot(parseInt(e.target.value))} style={inputSt}>
            {[60, 75, 90, 105, 120].map(v => <option key={v} value={v}>{v} min</option>)}
          </select>
        </div>
        <button onClick={save} disabled={saving} style={{ ...btnPrimary, whiteSpace: "nowrap" }}>
          {saving ? "..." : "Salva"}
        </button>
      </div>
      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </div>
  );
}

// ─── TimePillPicker ────────────────────────────

function TimePillPicker({ label, value, onChange, otherValue, isStart }) {
  const slots = [];
  for (let h = 7; h <= 23; h++) {
    for (let m = 0; m < 60; m += 30) {
      if (h === 23 && m === 30) continue;
      slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }

  return (
    <div>
      <label style={labelSt}>{label}</label>
      <div style={{
        display: "flex", flexWrap: "wrap", gap: 5, marginTop: 4,
        maxHeight: 120, overflowY: "auto",
        padding: "8px", background: C.bg, borderRadius: 8, border: `1px solid ${C.border}`,
      }}>
        {slots.map(t => {
          const selected = value === t;
          const disabled = isStart
            ? (otherValue !== "" && t >= otherValue)
            : (otherValue !== "" && t <= otherValue);
          return (
            <button
              key={t}
              onClick={() => !disabled && onChange(t)}
              style={{
                padding: "3px 9px", borderRadius: 6, fontSize: 12, cursor: disabled ? "default" : "pointer",
                border: selected ? `1px solid ${C.accent}` : `1px solid ${C.dim}`,
                background: selected ? C.accentDim : "transparent",
                color: selected ? C.accent : disabled ? C.dim : C.muted,
                fontWeight: selected ? 700 : 400,
                transition: "all 0.1s",
              }}
            >{t}</button>
          );
        })}
      </div>
    </div>
  );
}

// ─── UnavailabilityPanel ──────────────────────

function UnavailabilityPanel({ court, token, onClose }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ date: today(), startHour: "", endHour: "", reason: "", recurring: false });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    try {
      const d = await api(`/courts/${court.id}/unavailability`, token);
      setList(d);
    } finally { setLoading(false); }
  }, [court.id, token]);

  useEffect(() => { load(); }, [load]);

  const create = async () => {
    if (!form.startHour || !form.endHour) {
      setToast({ msg: "Seleziona orario di inizio e fine", type: "err" });
      return;
    }
    setSaving(true);
    try {
      const startTime = `${form.date}T${form.startHour}:00`;
      const endTime = `${form.date}T${form.endHour}:00`;
      const d = await api(`/courts/${court.id}/unavailability`, token, {
        method: "POST",
        body: JSON.stringify({ startTime, endTime, reason: form.reason, recurring: form.recurring }),
      });
      if (d.conflictingMatches?.length > 0) {
        setToast({ msg: `⚠ ${d.conflictingMatches.length} partite già create in questo slot — verifica manualmente`, type: "warn" });
      } else {
        setToast({ msg: "Evento aggiunto ✓", type: "ok" });
      }
      setShowForm(false);
      setForm({ date: today(), startHour: "", endHour: "", reason: "", recurring: false });
      load();
    } catch (e) { setToast({ msg: e.message, type: "err" }); }
    finally { setSaving(false); }
  };

  const remove = async (uid) => {
    if (!confirm("Eliminare questo evento?")) return;
    await api(`/courts/${court.id}/unavailability/${uid}`, token, { method: "DELETE" });
    load();
  };

  const DAYS = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];

  return (
    <Modal title={`📅 Eventi — ${court.name}`} onClose={onClose}>
      {!showForm ? (
        <button onClick={() => setShowForm(true)} style={{ ...btnPrimary, marginBottom: 16 }}>
          + Nuovo evento
        </button>
      ) : (
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, marginBottom: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Nuovo evento</span>
            <button onClick={() => setShowForm(false)} style={{ ...btnGhost, fontSize: 11, padding: "2px 8px" }}>Annulla</button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={labelSt}>
                {form.recurring ? `Giorno (si ripete ogni ${DAYS[new Date(form.date + "T12:00").getDay()]})` : "Data"}
              </label>
              <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={inputSt} />
            </div>
            <div>
              <label style={labelSt}>Motivo (opzionale)</label>
              <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                placeholder="es. Lezione istruttore" style={inputSt} />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <TimePillPicker
              label="Dalle"
              value={form.startHour}
              onChange={v => setForm(f => ({ ...f, startHour: v }))}
              otherValue={form.endHour}
              isStart={true}
            />
            <TimePillPicker
              label="Alle"
              value={form.endHour}
              onChange={v => setForm(f => ({ ...f, endHour: v }))}
              otherValue={form.startHour}
              isStart={false}
            />
          </div>

          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: C.text }}>
            <input type="checkbox" checked={form.recurring} onChange={e => setForm(f => ({ ...f, recurring: e.target.checked }))}
              style={{ accentColor: C.accent, width: 16, height: 16 }} />
            Ripeti ogni settimana (stesso giorno + orario)
          </label>

          <button onClick={create} disabled={saving} style={btnPrimary}>
            {saving ? "..." : "Salva evento"}
          </button>
        </div>
      )}

      {loading ? <Spinner /> : list.length === 0 ? (
        <div style={{ textAlign: "center", color: C.muted, fontSize: 13, padding: "20px 0" }}>Nessun evento configurato</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map(u => (
            <div key={u.id} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: C.bg, border: `1px solid ${C.dim}`, borderRadius: 8, padding: "10px 14px",
            }}>
              <div>
                <div style={{ fontSize: 13, color: C.text, display: "flex", alignItems: "center", gap: 8 }}>
                  {u.recurring && <span style={{ fontSize: 10, background: `${C.unavail ?? C.cancelled}30`, color: C.unavail ?? C.cancelled, padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>RICORRENTE</span>}
                  <span style={{ color: C.accent, fontWeight: 600 }}>{fmtTime(u.startTime)}–{fmtTime(u.endTime)}</span>
                  {u.recurring
                    ? <span style={{ color: C.muted, fontSize: 11 }}>ogni {DAYS[new Date(u.startTime).getDay()]}</span>
                    : <span style={{ color: C.muted, fontSize: 11 }}>{fmtDate(u.startTime)}</span>}
                </div>
                {u.reason && <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>{u.reason}</div>}
              </div>
              <button onClick={() => remove(u.id)} style={{ ...btnGhost, color: C.cancelled, borderColor: `${C.cancelled}30`, fontSize: 11 }}>Elimina</button>
            </div>
          ))}
        </div>
      )}

      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </Modal>
  );
}

// ─── CreateMatchModal ─────────────────────────

function CreateMatchModal({ courts, club, token, onClose, onCreated, defaultDate, defaultCourtId }) {
  const [courtId, setCourtId] = useState(defaultCourtId || courts[0]?.id || "");
  const [date, setDate] = useState(defaultDate || today());
  const [title, setTitle] = useState("");
  const [skillLevel, setSkillLevel] = useState(Math.ceil((club?.skillLevelCount || 3) / 2));
  const [matchType, setMatchType] = useState("MATCH");
  const [suggestions, setSuggestions] = useState(null);
  const [loadingSuggest, setLoadingSuggest] = useState(false);
  const [duration, setDuration] = useState(club?.matchDuration || 90);
  // Slot picker (MATCH / LESSON)
  const [slots, setSlots] = useState([]);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  // Time range picker (UNAVAILABLE)
  const [fromHour, setFromHour] = useState("");
  const [toHour, setToHour] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const loadSlots = useCallback(async () => {
    if (matchType === "UNAVAILABLE") return;
    if (!courtId || !date) return;
    setLoadingSlots(true); setSlots([]); setSelectedSlot(null);
    try {
      const d = await api(`/courts/${courtId}/slots?date=${date}&duration=${duration}`, token);
      setSlots(d.slots || []);
    } catch {}
    finally { setLoadingSlots(false); }
  }, [courtId, date, duration, matchType, token]);

  useEffect(() => { loadSlots(); }, [loadSlots]);

  const create = async () => {
    setSaving(true); setErr("");
    try {
      let startTime, dur;
      if (matchType === "UNAVAILABLE") {
        if (!fromHour || !toHour) { setErr("Seleziona orario di inizio e fine"); setSaving(false); return; }
        startTime = new Date(`${date}T${fromHour}:00`).toISOString();
        const [fh, fm] = fromHour.split(":").map(Number);
        const [th, tm] = toHour.split(":").map(Number);
        dur = (th * 60 + tm) - (fh * 60 + fm);
        if (dur <= 0) { setErr("L'orario di fine deve essere dopo l'inizio"); setSaving(false); return; }
      } else {
        if (!selectedSlot) { setErr("Seleziona un orario"); setSaving(false); return; }
        startTime = selectedSlot;
        dur = duration;
      }
      await api("/matches", token, { method: "POST", body: JSON.stringify({ courtId, startTime, skillLevel, type: matchType, duration: dur, title: title.trim() || undefined }) });
      onCreated(); onClose();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  const canSubmit = matchType === "UNAVAILABLE" ? (!!fromHour && !!toHour) : !!selectedSlot;

  return (
    <Modal title="Nuova partita" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", gap: 6, background: C.bg, padding: 4, borderRadius: 10, border: `1px solid ${C.dim}` }}>
          {[
            { id: "MATCH", label: "🎾 Partita" },
            { id: "LESSON", label: "👨‍🏫 Lezione" },
            { id: "UNAVAILABLE", label: "⛔ Occupato" }
          ].map(t => (
            <button key={t.id} onClick={() => { setMatchType(t.id); setErr(""); }} style={{
              flex: 1, padding: "8px 0", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer",
              background: matchType === t.id ? C.surface : "transparent",
              color: matchType === t.id ? C.text : C.muted,
              border: `1px solid ${matchType === t.id ? C.border : "transparent"}`,
              boxShadow: matchType === t.id ? "0 2px 4px rgba(0,0,0,0.2)" : "none"
            }}>{t.label}</button>
          ))}
        </div>

        <div>
          <label style={labelSt}>Campo</label>
          <select value={courtId} onChange={e => setCourtId(e.target.value)} style={inputSt}>
            {courts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div>
          <label style={labelSt}>Data</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputSt} />
        </div>

        <div>
          <label style={labelSt}>Nome evento <span style={{ color: C.muted, fontWeight: 400 }}>(opzionale)</span></label>
          <input value={title} onChange={e => setTitle(e.target.value)}
            placeholder={matchType === "MATCH" ? "es. Torneo amici" : matchType === "LESSON" ? "es. Lezione Marco" : "es. Manutenzione campo"}
            style={inputSt} />
        </div>

        {matchType === "MATCH" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={labelSt}>Livello di gioco</label>
                <input type="number" step="0.5" min="1" max="10" value={skillLevel}
                  onChange={e => { setSkillLevel(parseFloat(e.target.value) || 1); setSuggestions(null); }}
                  style={{ ...inputSt, width: "100%" }} />
              </div>
              <button
                disabled={loadingSuggest || !date}
                onClick={async () => {
                  setLoadingSuggest(true); setSuggestions(null);
                  try {
                    const slot = suggestions ? null : (selectedSlot ? new Date(selectedSlot).toTimeString().slice(0,5) : null);
                    const params = new URLSearchParams({ date });
                    if (slot) params.set("time", slot);
                    const d = await api(`/matches/suggest-level?${params}`, token);
                    setSuggestions(d.suggestions || []);
                    if (d.suggestions?.[0]) setSkillLevel(d.suggestions[0].level);
                  } catch {}
                  finally { setLoadingSuggest(false); }
                }}
                style={{ ...btnGhost, whiteSpace: "nowrap", color: C.accent, borderColor: `${C.accent}40`, padding: "8px 12px" }}
              >
                {loadingSuggest ? "..." : "🎯 Ottimizza"}
              </button>
            </div>
            {suggestions && suggestions.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                {suggestions.slice(0, 3).map((s, i) => (
                  <button key={s.level} onClick={() => setSkillLevel(s.level)} style={{
                    display: "flex", alignItems: "center", justifyContent: "space-between",
                    padding: "6px 10px", borderRadius: 8, fontSize: 11, cursor: "pointer", textAlign: "left",
                    background: s.level === skillLevel ? C.accentDim : C.bg,
                    border: `1px solid ${s.level === skillLevel ? C.accent : C.dim}`,
                    color: C.text,
                  }}>
                    <span>
                      {i === 0 && <span style={{ color: C.accent, fontWeight: 700, marginRight: 4 }}>★</span>}
                      Livello <strong>{s.level}</strong>
                    </span>
                    <span style={{ color: C.muted, fontSize: 10 }}>
                      {s.playerCount} giocatori · EMA {s.emaSum}
                    </span>
                  </button>
                ))}
                {suggestions[0]?.playerCount === 0 && (
                  <div style={{ fontSize: 11, color: C.cancelled }}>Nessun giocatore disponibile oggi</div>
                )}
              </div>
            )}
          </div>
        )}

        {matchType === "LESSON" && (
          <div>
            <label style={labelSt}>Durata (minuti)</label>
            <select value={duration} onChange={e => setDuration(parseInt(e.target.value))} style={inputSt}>
              {[30, 45, 60, 90, 120].map(v => <option key={v} value={v}>{v} minuti</option>)}
            </select>
          </div>
        )}

        {matchType === "UNAVAILABLE" ? (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <TimePillPicker label="Dalle" value={fromHour} onChange={setFromHour} otherValue={toHour} isStart={true} />
            <TimePillPicker label="Alle" value={toHour} onChange={setToHour} otherValue={fromHour} isStart={false} />
          </div>
        ) : (
          <div>
            <label style={labelSt}>Orario</label>
            {loadingSlots ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center", padding: "10px 0" }}><Spinner size={14} /><span style={{ fontSize: 12, color: C.muted }}>Carico slot...</span></div>
            ) : (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, maxHeight: 180, overflowY: "auto" }}>
                {slots.length === 0 && <div style={{ fontSize: 12, color: C.muted }}>Nessuno slot trovato</div>}
                {slots.map(s => {
                  const t = fmtTime(s.startTime);
                  const sel = selectedSlot === s.startTime;
                  return (
                    <button key={s.startTime} disabled={!s.available} onClick={() => setSelectedSlot(s.startTime)}
                      title={!s.available ? s.reason : ""}
                      style={{
                        padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: sel ? 700 : 400,
                        cursor: s.available ? "pointer" : "not-allowed", border: `1px solid`,
                        borderColor: !s.available ? C.dim : sel ? C.accent : C.border,
                        background: !s.available ? C.bg : sel ? C.accentDim : "transparent",
                        color: !s.available ? C.dim : sel ? C.accent : C.text,
                        textDecoration: !s.available ? "line-through" : "none",
                      }}>{t}</button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
      {err && <div style={{ fontSize: 12, color: C.cancelled, marginTop: 8 }}>{err}</div>}
      <div style={{ display: "flex", gap: 10, marginTop: 4 }}>
        <button onClick={onClose} style={{ ...btnGhost, flex: 1, padding: "10px 0" }}>Annulla</button>
        <button onClick={create} disabled={saving || !canSubmit} style={{ ...btnPrimary, flex: 2, opacity: canSubmit ? 1 : 0.4 }}>
          {saving ? "Creazione..." : matchType === "MATCH" ? "Crea e lancia wave →" : matchType === "LESSON" ? "Crea lezione →" : "Crea evento →"}
        </button>
      </div>
    </Modal>
  );
}

// ─── MatchChip (compact for calendar) ─────────

function MatchChip({ match, onCancel, onDeleteUnavailable }) {
  const [confirming, setConfirming] = useState(false);
  const [hovered, setHovered] = useState(false);
  const confirmed = match.MatchPlayer?.filter(mp => !mp.leftAt).length || 0;
  const pending = match.invitations?.length || 0;
  const colorMap = { OPEN: C.open, LOCKED: C.locked, CANCELLED: C.cancelled, UNFILLED: C.unfilled };
  const isUnavail = match.type === "UNAVAILABLE";
  const color = isUnavail ? C.muted : (colorMap[match.status] || C.muted);
  const typeIcon = match.type === "LESSON" ? "👨‍🏫" : isUnavail ? "⛔" : match.isPrivateBooking ? "🔒" : "🎾";
  const canDelete = (match.status === "OPEN" || match.status === "LOCKED") || isUnavail;

  const bookerName = match.isPrivateBooking
    ? (() => { const b = match.MatchPlayer?.find(mp => !mp.leftAt); return b?.player?.name || b?.player?.phoneNumber?.slice(-4) || null; })()
    : null;

  const sub = isUnavail
    ? (match.cancelledReason || null)
    : match.type === "MATCH" && !match.isPrivateBooking
      ? `${confirmed}/${match.playersNeeded}${pending > 0 ? ` +${pending}` : ""}`
      : bookerName;

  const handleDelete = () => {
    if (isUnavail) onDeleteUnavailable(match);
    else onCancel(match.id);
  };

  const isCancelled = match.status === 'CANCELLED';
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        background: isUnavail ? `${C.dim}` : `${color}15`,
        border: `1px solid ${isUnavail ? C.border : color + "40"}`,
        borderRadius: 6,
        padding: "4px 6px",
        opacity: isCancelled ? 0.45 : 1,
        textDecoration: isCancelled ? 'line-through' : 'none',
      }}>
      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
        <span style={{ fontSize: 9 }}>{typeIcon}</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: isUnavail ? C.muted : color, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>
          {fmtTime(match.startTime)}{match.endTime ? `–${fmtTime(match.endTime)}` : ""}
        </span>
      </div>
      {match.title && (
        <div style={{ fontSize: 9, fontWeight: 600, color: isUnavail ? C.muted : color, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {match.title}
        </div>
      )}
      {sub && !(hovered && bookerName) && (
        <div style={{ fontSize: 9, color: C.muted, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {sub}
        </div>
      )}
      {hovered && !isUnavail && match.type === "MATCH" && (
        <div style={{ marginTop: 4, borderTop: `1px solid ${C.border}`, paddingTop: 3 }}>
          {(match.MatchPlayer?.filter(mp => !mp.leftAt) || []).map(mp => (
            <div key={mp.player.id} style={{ fontSize: 9, color: C.muted, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {mp.player.name || mp.player.phoneNumber?.slice(-4)}
            </div>
          ))}
          {(match.MatchPlayer?.filter(mp => !mp.leftAt) || []).length === 0 && (
            <div style={{ fontSize: 9, color: C.dim }}>Nessun giocatore</div>
          )}
        </div>
      )}
      {canDelete && !confirming && (
        <button
          onClick={() => setConfirming(true)}
          style={{
            marginTop: 4, width: "100%", fontSize: 9, padding: "2px 0",
            background: `${C.cancelled}15`, border: `1px solid ${C.cancelled}40`,
            borderRadius: 4, color: C.cancelled, cursor: "pointer", fontWeight: 600,
          }}
        >Elimina</button>
      )}
      {canDelete && confirming && (
        <div style={{ marginTop: 4, display: "flex", gap: 3 }}>
          <button
            onClick={handleDelete}
            style={{
              flex: 1, fontSize: 9, padding: "2px 0",
              background: C.cancelled, border: "none",
              borderRadius: 4, color: "#fff", cursor: "pointer", fontWeight: 700,
            }}
          >Sì</button>
          <button
            onClick={() => setConfirming(false)}
            style={{
              flex: 1, fontSize: 9, padding: "2px 0",
              background: `${C.dim}`, border: `1px solid ${C.border}`,
              borderRadius: 4, color: C.muted, cursor: "pointer",
            }}
          >No</button>
        </div>
      )}
    </div>
  );
}

// ─── MatchCard (for day detail modal) ─────────

function MatchCard({ match, onCancel }) {
  const confirmed = match.MatchPlayer?.filter(mp => !mp.leftAt) || [];
  const pending = match.invitations?.length || 0;
  const spotsLeft = match.playersNeeded - confirmed.length;

  const isCancelled = match.status === 'CANCELLED';
  return (
    <div style={{ background: C.bg, border: `1px solid ${isCancelled ? C.cancelled + '40' : C.dim}`, borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10, opacity: isCancelled ? 0.6 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>
            {fmtTime(match.startTime)}{match.endTime ? `–${fmtTime(match.endTime)}` : ""}
          </div>
          {match.isPrivateBooking ? (() => {
            const booker = confirmed[0];
            const name = booker?.player?.name || booker?.player?.phoneNumber?.slice(-4);
            return <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>🔒 Prenotazione privata{name ? ` · ${name}` : ""}</div>;
          })() : (
            <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Liv. {match.skillLevel} · {match.playersNeeded}p</div>
          )}
        </div>
        <Badge status={match.status} />
      </div>

      {!match.isPrivateBooking && (
        <div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <span style={{ fontSize: 11, color: C.muted }}>{confirmed.length}/{match.playersNeeded}</span>
            {pending > 0 && <span style={{ fontSize: 10, color: C.warning, background: `${C.warning}15`, padding: "1px 6px", borderRadius: 8 }}>{pending} in attesa</span>}
          </div>
          <div style={{ height: 3, background: C.dim, borderRadius: 2, overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 2, transition: "width 0.3s",
              width: `${(confirmed.length / match.playersNeeded) * 100}%`,
              background: match.status === "LOCKED" ? C.locked : confirmed.length > 0 ? C.accent : C.muted,
            }} />
          </div>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {confirmed.map(mp => (
          <span key={mp.id} style={{ fontSize: 10, background: C.dim, color: C.muted, padding: "2px 7px", borderRadius: 4 }}>
            {mp.player?.name || mp.player?.phoneNumber?.slice(-4)}
          </span>
        ))}
        {!match.isPrivateBooking && Array.from({ length: spotsLeft }).map((_, i) => (
          <span key={i} style={{ fontSize: 10, color: C.dim, padding: "2px 7px", borderRadius: 4, border: `1px dashed ${C.dim}` }}>—</span>
        ))}
      </div>

      {(match.status === "OPEN" || match.status === "LOCKED") && (
        <button onClick={() => onCancel(match.id)} style={{ ...btnGhost, fontSize: 11, color: C.cancelled, borderColor: `${C.cancelled}30` }}>
          Cancella
        </button>
      )}
    </div>
  );
}

// ─── DayDetailModal ───────────────────────────

function DayDetailModal({ date, courts, onCancel, onClose }) {
  const dateLabel = new Date(date + "T12:00").toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
  const allMatches = courts.flatMap(c =>
    (c.matches || [])
      .filter(m => matchDay(m.startTime) === date)
      .map(m => ({ ...m, courtName: c.name }))
  ).sort((a, b) => new Date(a.startTime) - new Date(b.startTime));

  return (
    <Modal title={`📅 ${dateLabel}`} onClose={onClose}>
      {allMatches.length === 0 ? (
        <div style={{ textAlign: "center", color: C.muted, fontSize: 13, padding: "24px 0" }}>Nessuna partita in questa giornata</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {allMatches.map(m => (
            <div key={m.id}>
              <div style={{ fontSize: 11, color: C.accent, marginBottom: 4, fontWeight: 600 }}>{m.courtName}</div>
              <MatchCard match={m} onCancel={(id) => { onCancel(id); onClose(); }} />
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

// ─── WeekCalendar ─────────────────────────────

const DAY_NAMES = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];

function WeekCalendar({ courtData, weekDays, onCancel, onDeleteUnavailable, todayStr, onDayClick, onCourtManage, onQuickCreate }) {
  const thBase = {
    padding: "10px 8px", textAlign: "center",
    borderBottom: `1px solid ${C.border}`,
    fontWeight: 600,
  };
  const tdBase = {
    padding: 8, verticalAlign: "top",
    borderBottom: `1px solid ${C.dim}`,
    borderRight: `1px solid ${C.dim}`,
    minHeight: 80,
  };

  return (
    <div style={{ overflowX: "auto", borderRadius: 12, border: `1px solid ${C.border}`, background: C.surface }}>
      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
        <thead>
          <tr>
            {/* Court header */}
            <th style={{
              ...thBase, width: 110, textAlign: "left", padding: "10px 14px",
              background: C.surface, position: "sticky", left: 0, zIndex: 2,
              borderRight: `1px solid ${C.border}`,
            }}>
              <span style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>Campo</span>
            </th>
            {weekDays.map((d, i) => {
              const dt = new Date(d + "T12:00:00");
              const isToday = d === todayStr;
              const totalMatches = courtData.reduce((n, c) =>
                n + (c.matches || []).filter(m => matchDay(m.startTime) === d && m.status !== "CANCELLED").length, 0);
              return (
                <th key={d} style={{
                  ...thBase,
                  background: isToday ? C.accentDim : C.surface,
                  borderRight: i < 6 ? `1px solid ${C.border}` : "none",
                  minWidth: 110, cursor: "pointer",
                }} onClick={() => onDayClick(d)}>
                  <div style={{ fontSize: 10, color: isToday ? C.accent : C.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                    {DAY_NAMES[i]}
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: isToday ? C.accent : C.text, marginTop: 1 }}>
                    {dt.getDate()}
                  </div>
                  <div style={{ fontSize: 10, color: C.muted }}>
                    {dt.toLocaleDateString("it-IT", { month: "short" })}
                  </div>
                  {totalMatches > 0 && (
                    <div style={{ fontSize: 9, color: isToday ? C.accent : C.muted, marginTop: 2 }}>
                      {totalMatches} partit{totalMatches === 1 ? "a" : "e"}
                    </div>
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {courtData.map((court, ri) => (
            <tr key={court.id}>
              <td style={{
                ...tdBase,
                background: C.surface,
                position: "sticky", left: 0, zIndex: 1,
                borderRight: `1px solid ${C.border}`,
                borderBottom: ri < courtData.length - 1 ? `1px solid ${C.dim}` : "none",
              }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.accent }}>{court.name}</div>
                <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{court.isCovered ? "🏠 Coperto" : "☀️ Scoperto"}</div>
                <button
                  onClick={() => onCourtManage(court)}
                  style={{ ...btnGhost, fontSize: 9, color: C.unavail, borderColor: `${C.unavail}30`, marginTop: 6, padding: "2px 6px" }}>
                  Eventi
                </button>
              </td>
              {weekDays.map((d, ci) => {
                const dayMatches = (court.matches || []).filter(m => matchDay(m.startTime) === d);
                const isToday = d === todayStr;
                return (
                  <td key={d} style={{
                    ...tdBase,
                    background: isToday ? `${C.accentDim}` : "transparent",
                    borderRight: ci < 6 ? `1px solid ${C.dim}` : "none",
                    borderBottom: ri < courtData.length - 1 ? `1px solid ${C.dim}` : "none",
                    minWidth: 110,
                  }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                      {dayMatches.length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 160, overflowY: "auto" }}>
                          {dayMatches.map(m => <MatchChip key={m.id} match={m} onCancel={onCancel} onDeleteUnavailable={onDeleteUnavailable} />)}
                        </div>
                      )}
                      <button
                        onClick={() => onQuickCreate?.(d, court.id)}
                        style={{
                          display: "block", width: "100%", padding: dayMatches.length === 0 ? "10px 0" : "3px 0",
                          background: "transparent", border: `1px dashed ${C.dim}`,
                          borderRadius: 6, cursor: "pointer", color: C.muted,
                          fontSize: 11, transition: "all 0.15s",
                        }}
                        onMouseEnter={e => { e.currentTarget.style.borderColor = C.accent; e.currentTarget.style.color = C.accent; e.currentTarget.style.background = C.accentDim; }}
                        onMouseLeave={e => { e.currentTarget.style.borderColor = C.dim; e.currentTarget.style.color = C.muted; e.currentTarget.style.background = "transparent"; }}
                      >+</button>
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── CourtsView ───────────────────────────────

export default function CourtsView({ token, onClubUpdate }) {
  const [courtData, setCourtData] = useState([]);
  const [club, setClub] = useState(null);
  const [loading, setLoading] = useState(true);
  const [weekStart, setWeekStart] = useState(getMonday(today()));
  const [showCreate, setShowCreate] = useState(false);
  const [createDate, setCreateDate] = useState(null);
  const [createCourtId, setCreateCourtId] = useState(null);
  const [unavailCourt, setUnavailCourt] = useState(null);
  const [dayDetail, setDayDetail] = useState(null);
  const [toast, setToast] = useState(null);

  const weekDays = getWeekDays(weekStart);
  const weekEnd = weekDays[6];
  const todayStr = today();

  const load = useCallback(async () => {
    try {
      const [courts, clubData] = await Promise.all([
        api(`/courts?dateFrom=${weekStart}&dateTo=${weekEnd}`, token),
        api("/club", token),
      ]);
      setCourtData(courts);
      setClub(clubData);
      onClubUpdate?.(clubData);
    } finally { setLoading(false); }
  }, [token, weekStart]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  const deleteUnavailability = async (match) => {
    if (!confirm("Eliminare questo evento?")) return;
    try {
      await api(`/courts/${match.courtId}/unavailability/${match.id}`, token, { method: "DELETE" });
      load();
      setToast({ msg: "Evento eliminato ✓", type: "ok" });
    } catch (e) { setToast({ msg: e.message, type: "err" }); }
  };

  const cancelMatch = async (id) => {
    if (!confirm("Sicuro?")) return;
    try {
      const res = await api(`/matches/${id}/cancel`, token, { method: "POST" });
      load();
      if (!res.notified) {
        setToast({ msg: "⚠️ Partita cancellata, ma la notifica WhatsApp non è stata inviata (bot offline). Avvisa i giocatori manualmente.", type: "err" });
      } else {
        setToast({ msg: "Partita cancellata — giocatori notificati ✓", type: "ok" });
      }
    } catch (e) { setToast({ msg: e.message, type: "err" }); }
  };

  const prevWeek = () => setWeekStart(addDays(weekStart, -7));
  const nextWeek = () => setWeekStart(addDays(weekStart, 7));
  const goToday = () => setWeekStart(getMonday(todayStr));

  const weekLabel = () => {
    const from = new Date(weekStart + "T12:00");
    const to = new Date(weekEnd + "T12:00");
    if (from.getMonth() === to.getMonth()) {
      return `${from.getDate()} – ${to.getDate()} ${to.toLocaleDateString("it-IT", { month: "long", year: "numeric" })}`;
    }
    return `${from.getDate()} ${from.toLocaleDateString("it-IT", { month: "short" })} – ${to.getDate()} ${to.toLocaleDateString("it-IT", { month: "short", year: "numeric" })}`;
  };

  const allMatches = courtData.flatMap(c => c.matches || []);
  const weekMatches = allMatches.filter(m => m.status !== "CANCELLED");

  if (loading) return <div style={{ padding: 40, display: "flex", gap: 10, alignItems: "center" }}><Spinner /> <span style={{ color: C.muted, fontSize: 13 }}>Caricamento...</span></div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {club && <HoursEditor token={token} club={club} onUpdated={d => setClub(prev => ({ ...prev, ...d }))} />}

      {/* Week navigation + controls */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button onClick={prevWeek} style={{ ...btnGhost, padding: "7px 14px", fontSize: 16 }}>‹</button>
          <div style={{
            minWidth: 260, textAlign: "center", fontSize: 14, fontWeight: 600, color: C.text,
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 8, padding: "7px 16px",
          }}>
            {weekLabel()}
          </div>
          <button onClick={nextWeek} style={{ ...btnGhost, padding: "7px 14px", fontSize: 16 }}>›</button>
          {weekStart !== getMonday(todayStr) && (
            <button onClick={goToday} style={{ ...btnGhost, color: C.accent, borderColor: `${C.accent}40`, fontSize: 12 }}>
              Oggi
            </button>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ fontSize: 11, color: C.muted }}>● auto-refresh 30s</span>
          <button onClick={() => { setCreateDate(todayStr); setShowCreate(true); }} style={btnPrimary}>+ Nuova partita</button>
        </div>
      </div>

      {/* Weekly stats */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        {[
          { l: "Partite aperte (settimana)", v: weekMatches.filter(m => m.status === "OPEN").length, c: C.open },
          { l: "Partite chiuse (settimana)", v: weekMatches.filter(m => m.status === "LOCKED").length, c: C.locked },
          { l: "Giocatori confermati", v: weekMatches.filter(m => m.status === "LOCKED").reduce((s, m) => s + (m.MatchPlayer?.filter(mp => !mp.leftAt).length || 0), 0), c: C.accent },
        ].map(s => (
          <div key={s.l} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 20px" }}>
            <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>{s.l}</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: s.c, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{s.v}</div>
          </div>
        ))}
      </div>

      {/* Weekly calendar grid */}
      <WeekCalendar
        courtData={courtData}
        weekDays={weekDays}
        onCancel={cancelMatch}
        onDeleteUnavailable={deleteUnavailability}
        todayStr={todayStr}
        onDayClick={(d) => setDayDetail(d)}
        onCourtManage={(court) => setUnavailCourt(court)}
        onQuickCreate={(d, cId) => { setCreateDate(d); setCreateCourtId(cId); setShowCreate(true); }}
      />

      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 16, flexWrap: "wrap" }}>
        {[
          { color: C.open, label: "Aperta" },
          { color: C.locked, label: "Confermata" },
          { color: C.cancelled, label: "Cancellata" },
          { color: C.muted, label: "Evento" },
        ].map(({ color, label }) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div style={{ width: 10, height: 10, borderRadius: 3, background: `${color}40`, border: `1px solid ${color}80` }} />
            <span style={{ fontSize: 11, color: C.muted }}>{label}</span>
          </div>
        ))}
        <span style={{ fontSize: 11, color: C.dim }}>· Clicca + su cella vuota per creare · Clicca giorno per dettaglio</span>
      </div>

      {showCreate && (
        <CreateMatchModal
          courts={courtData}
          club={club}
          token={token}
          defaultDate={createDate}
          defaultCourtId={createCourtId}
          onClose={() => { setShowCreate(false); setCreateCourtId(null); }}
          onCreated={load}
        />
      )}
      {unavailCourt && <UnavailabilityPanel court={unavailCourt} token={token} onClose={() => { setUnavailCourt(null); load(); }} />}
      {dayDetail && (
        <DayDetailModal
          date={dayDetail}
          courts={courtData}
          onCancel={cancelMatch}
          onClose={() => setDayDetail(null)}
        />
      )}
      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </div>
  );
}
