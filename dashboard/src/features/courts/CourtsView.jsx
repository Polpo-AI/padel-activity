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

function CreateMatchModal({ courts, club, token, onClose, onCreated, defaultDate }) {
  const [courtId, setCourtId] = useState(courts[0]?.id || "");
  const [date, setDate] = useState(defaultDate || today());
  const [skillLevel, setSkillLevel] = useState(Math.ceil((club?.skillLevelCount || 3) / 2));
  const [matchType, setMatchType] = useState("MATCH");
  const [duration, setDuration] = useState(club?.matchDuration || 90);
  const [slots, setSlots] = useState([]);
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const loadSlots = useCallback(async () => {
    if (!courtId || !date) return;
    setLoadingSlots(true); setSlots([]); setSelectedSlot(null);
    try {
      const d = await api(`/courts/${courtId}/slots?date=${date}`, token);
      setSlots(d.slots || []);
    } catch {}
    finally { setLoadingSlots(false); }
  }, [courtId, date, token]);

  useEffect(() => { loadSlots(); }, [loadSlots]);

  const create = async () => {
    if (!selectedSlot) return;
    setSaving(true); setErr("");
    try {
      await api("/matches", token, { method: "POST", body: JSON.stringify({ courtId, startTime: selectedSlot, skillLevel, type: matchType, duration }) });
      onCreated(); onClose();
    } catch (e) { setErr(e.message); }
    finally { setSaving(false); }
  };

  return (
    <Modal title="Nuova partita" onClose={onClose}>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", gap: 6, background: C.bg, padding: 4, borderRadius: 10, border: `1px solid ${C.dim}` }}>
          {[
            { id: "MATCH", label: "🎾 Partita" },
            { id: "LESSON", label: "👨‍🏫 Lezione" },
            { id: "UNAVAILABLE", label: "⛔ Occupato" }
          ].map(t => (
            <button key={t.id} onClick={() => setMatchType(t.id)} style={{
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

        {matchType === "MATCH" && (
          <div>
            <label style={labelSt}>Livello di gioco</label>
            <input type="number" step="0.5" min="1" max="10" value={skillLevel}
              onChange={e => setSkillLevel(parseFloat(e.target.value) || 1)}
              style={{ ...inputSt, width: "100%" }} />
          </div>
        )}

        {matchType !== "MATCH" && (
          <div>
            <label style={labelSt}>Durata (minuti)</label>
            <select value={duration} onChange={e => setDuration(parseInt(e.target.value))} style={inputSt}>
              {[30, 45, 60, 90, 120].map(v => <option key={v} value={v}>{v} minuti</option>)}
            </select>
          </div>
        )}

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
      </div>
      {err && <div style={{ fontSize: 12, color: C.cancelled }}>{err}</div>}
      <div style={{ display: "flex", gap: 10 }}>
        <button onClick={onClose} style={{ ...btnGhost, flex: 1, padding: "10px 0" }}>Annulla</button>
        <button onClick={create} disabled={saving || !selectedSlot} style={{ ...btnPrimary, flex: 2, opacity: selectedSlot ? 1 : 0.4 }}>
          {saving ? "Creazione..." : matchType === "MATCH" ? "Crea e lancia wave →" : "Blocca Campo →"}
        </button>
      </div>
    </Modal>
  );
}

// ─── MatchChip (compact for calendar) ─────────

function MatchChip({ match, onCancel, onDeleteUnavailable }) {
  const [confirming, setConfirming] = useState(false);
  const confirmed = match.MatchPlayer?.filter(mp => !mp.leftAt).length || 0;
  const pending = match.invitations?.length || 0;
  const colorMap = { OPEN: C.open, LOCKED: C.locked, CANCELLED: C.cancelled, UNFILLED: C.unfilled };
  const isUnavail = match.type === "UNAVAILABLE";
  const color = isUnavail ? C.muted : (colorMap[match.status] || C.muted);
  const typeIcon = match.type === "LESSON" ? "👨‍🏫" : isUnavail ? "⛔" : match.isPrivateBooking ? "🔒" : "🎾";
  const canDelete = (match.status === "OPEN" && match.type === "MATCH") || isUnavail;

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

  return (
    <div style={{
      background: isUnavail ? `${C.dim}` : `${color}15`,
      border: `1px solid ${isUnavail ? C.border : color + "40"}`,
      borderRadius: 6,
      padding: "4px 6px",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 3 }}>
        <span style={{ fontSize: 9 }}>{typeIcon}</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: isUnavail ? C.muted : color, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", flex: 1 }}>
          {fmtTime(match.startTime)}{match.endTime ? `–${fmtTime(match.endTime)}` : ""}
        </span>
      </div>
      {sub && (
        <div style={{ fontSize: 9, color: C.muted, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {sub}
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

  return (
    <div style={{ background: C.bg, border: `1px solid ${C.dim}`, borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
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

      {match.status === "OPEN" && (
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

function WeekCalendar({ courtData, weekDays, onCancel, onDeleteUnavailable, todayStr, onDayClick, onCourtManage }) {
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
                    {dayMatches.length === 0 ? (
                      <div style={{ textAlign: "center", color: C.dim, fontSize: 10, padding: "12px 0", userSelect: "none" }}>—</div>
                    ) : (
                      <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: 160, overflowY: "auto" }}>
                        {dayMatches.map(m => <MatchChip key={m.id} match={m} onCancel={onCancel} onDeleteUnavailable={onDeleteUnavailable} />)}
                      </div>
                    )}
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
      />

      <div style={{ fontSize: 11, color: C.muted, textAlign: "center" }}>
        Clicca su un giorno per vedere il dettaglio · Usa "Elimina" sul chip per cancellare una partita
      </div>

      {showCreate && (
        <CreateMatchModal
          courts={courtData}
          club={club}
          token={token}
          defaultDate={createDate}
          onClose={() => setShowCreate(false)}
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
