import { useState, useEffect, useCallback } from "react";
import { C, api, fmtTime, fmtDate, today, inputSt, btnPrimary, btnGhost, labelSt } from "../../shared/config";
import Spinner from "../../shared/Spinner";
import Badge from "../../shared/Badge";
import Toast from "../../shared/Toast";
import Modal from "../../shared/Modal";

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

// ─── UnavailabilityPanel ──────────────────────

function UnavailabilityPanel({ court, token, onClose }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ date: today(), startHour: "09:00", endHour: "10:30", reason: "", recurring: false });
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
    setSaving(true);
    try {
      const startTime = `${form.date}T${form.startHour}:00`;
      const endTime = `${form.date}T${form.endHour}:00`;
      const d = await api(`/courts/${court.id}/unavailability`, token, {
        method: "POST",
        body: JSON.stringify({ startTime, endTime, reason: form.reason, recurring: form.recurring }),
      });
      if (d.conflictingMatches?.length > 0) {
        setToast({ msg: `⚠ ${d.conflictingMatches.length} partite già create in questo slot — verifica manualmente`, type: "err" });
      } else {
        setToast({ msg: "Blocco aggiunto ✓", type: "ok" });
      }
      setShowForm(false);
      load();
    } catch (e) { setToast({ msg: e.message, type: "err" }); }
    finally { setSaving(false); }
  };

  const remove = async (uid) => {
    if (!confirm("Eliminare questo blocco?")) return;
    await api(`/courts/${court.id}/unavailability/${uid}`, token, { method: "DELETE" });
    load();
  };

  const DAYS = ["Dom", "Lun", "Mar", "Mer", "Gio", "Ven", "Sab"];

  return (
    <Modal title={`🔒 Indisponibilità — ${court.name}`} onClose={onClose}>
      <button onClick={() => setShowForm(!showForm)} style={btnPrimary}>
        {showForm ? "Annulla" : "+ Nuovo blocco"}
      </button>

      {showForm && (
        <div style={{ background: C.bg, border: `1px solid ${C.border}`, borderRadius: 10, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={labelSt}>Data {form.recurring && "(giorno settimana)"}</label>
              <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} style={inputSt} />
              {form.recurring && (
                <div style={{ fontSize: 11, color: C.accent, marginTop: 4 }}>
                  Si ripeterà ogni {DAYS[new Date(form.date + "T12:00").getDay()]}
                </div>
              )}
            </div>
            <div>
              <label style={labelSt}>Motivo</label>
              <input value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                placeholder="es. Lezione istruttore" style={inputSt} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div>
              <label style={labelSt}>Dalle</label>
              <input type="time" value={form.startHour} onChange={e => setForm(f => ({ ...f, startHour: e.target.value }))} style={inputSt} />
            </div>
            <div>
              <label style={labelSt}>Alle</label>
              <input type="time" value={form.endHour} onChange={e => setForm(f => ({ ...f, endHour: e.target.value }))} style={inputSt} />
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: C.text }}>
            <input type="checkbox" checked={form.recurring} onChange={e => setForm(f => ({ ...f, recurring: e.target.checked }))}
              style={{ accentColor: C.accent, width: 16, height: 16 }} />
            Ripeti ogni settimana (stesso giorno + orario)
          </label>
          <button onClick={create} disabled={saving} style={btnPrimary}>{saving ? "..." : "Salva blocco"}</button>
        </div>
      )}

      {loading ? <Spinner /> : list.length === 0 ? (
        <div style={{ textAlign: "center", color: C.muted, fontSize: 13, padding: "20px 0" }}>Nessun blocco configurato</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map(u => (
            <div key={u.id} style={{
              display: "flex", alignItems: "center", justifyContent: "space-between",
              background: C.bg, border: `1px solid ${C.dim}`, borderRadius: 8, padding: "10px 14px",
            }}>
              <div>
                <div style={{ fontSize: 13, color: C.text, display: "flex", alignItems: "center", gap: 8 }}>
                  {u.recurring && <span style={{ fontSize: 10, background: `${C.unavail}30`, color: C.unavail, padding: "2px 6px", borderRadius: 4, fontWeight: 700 }}>RICORRENTE</span>}
                  <span style={{ color: C.accent }}>{fmtTime(u.startTime)}–{fmtTime(u.endTime)}</span>
                  {u.recurring && <span style={{ color: C.muted, fontSize: 11 }}>ogni {DAYS[new Date(u.startTime).getDay()]}</span>}
                  {!u.recurring && <span style={{ color: C.muted, fontSize: 11 }}>{fmtDate(u.startTime)}</span>}
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

function CreateMatchModal({ courts, club, token, onClose, onCreated }) {
  const [courtId, setCourtId] = useState(courts[0]?.id || "");
  const [date, setDate] = useState(today());
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

// ─── MatchCard ────────────────────────────────

function MatchCard({ match, onCancel }) {
  const confirmed = match.MatchPlayer?.filter(mp => !mp.leftAt) || [];
  const pending = match.invitations?.length || 0;
  const spotsLeft = match.playersNeeded - confirmed.length;

  return (
    <div style={{ background: C.bg, border: `1px solid ${C.dim}`, borderRadius: 10, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>{fmtTime(match.startTime)}</div>
          <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>Liv. {match.skillLevel} · {match.playersNeeded}p</div>
        </div>
        <Badge status={match.status} />
      </div>

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

      <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
        {confirmed.map(mp => (
          <span key={mp.id} style={{ fontSize: 10, background: C.dim, color: C.muted, padding: "2px 7px", borderRadius: 4 }}>
            {mp.player?.name || mp.player?.phoneNumber?.slice(-4)}
          </span>
        ))}
        {Array.from({ length: spotsLeft }).map((_, i) => (
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

// ─── CourtsView ───────────────────────────────

export default function CourtsView({ token, onClubUpdate }) {
  const [courtData, setCourtData] = useState([]);
  const [club, setClub] = useState(null);
  const [loading, setLoading] = useState(true);
  const [date, setDate] = useState(today());
  const [showCreate, setShowCreate] = useState(false);
  const [unavailCourt, setUnavailCourt] = useState(null);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    try {
      const [courts, clubData] = await Promise.all([
        api(`/courts?date=${date}`, token),
        api("/club", token),
      ]);
      setCourtData(courts);
      setClub(clubData);
      onClubUpdate?.(clubData);
    } finally { setLoading(false); }
  }, [token, date]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);

  const cancelMatch = async (id) => {
    if (!confirm("Sicuro?")) return;
    try { await api(`/matches/${id}/cancel`, token, { method: "POST" }); load(); }
    catch (e) { setToast({ msg: e.message, type: "err" }); }
  };

  const allMatches = courtData.flatMap(c => c.matches || []);

  if (loading) return <div style={{ padding: 40, display: "flex", gap: 10, alignItems: "center" }}><Spinner /> <span style={{ color: C.muted, fontSize: 13 }}>Caricamento...</span></div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      {club && <HoursEditor token={token} club={club} onUpdated={d => setClub(prev => ({ ...prev, ...d }))} />}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={{ ...inputSt, width: "auto" }} />
          <span style={{ fontSize: 11, color: C.muted }}>● aggiornamento automatico 15s</span>
        </div>
        <button onClick={() => setShowCreate(true)} style={btnPrimary}>+ Nuova partita</button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12 }}>
        {[
          { l: "Partite aperte", v: allMatches.filter(m => m.status === "OPEN").length, c: C.open },
          { l: "Partite chiuse", v: allMatches.filter(m => m.status === "LOCKED").length, c: C.locked },
          { l: "Giocatori confermati", v: allMatches.filter(m => m.status === "LOCKED").reduce((s, m) => s + (m.MatchPlayer?.filter(mp => !mp.leftAt).length || 0), 0), c: C.accent },
        ].map(s => (
          <div key={s.l} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: "18px 20px" }}>
            <div style={{ fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>{s.l}</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: s.c, marginTop: 4, fontVariantNumeric: "tabular-nums" }}>{s.v}</div>
          </div>
        ))}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(courtData.length || 1, 3)}, 1fr)`, gap: 16 }}>
        {courtData.map(court => {
          const todayBlocks = (court.unavailabilities || []).filter(u => {
            if (!u.recurring) return true;
            return new Date(u.startTime).getDay() === new Date(date).getDay();
          });

          return (
            <div key={court.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, overflow: "hidden" }}>
              <div style={{ padding: "12px 16px", borderBottom: `1px solid ${C.border}`, display: "flex", justifyContent: "space-between", alignItems: "center", background: C.accentDim }}>
                <div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: C.accent }}>{court.name}</div>
                  {todayBlocks.length > 0 && (
                    <div style={{ fontSize: 10, color: C.unavail, marginTop: 2 }}>
                      🔒 {todayBlocks.length} blocco{todayBlocks.length > 1 ? "i" : ""} oggi
                    </div>
                  )}
                </div>
                <button onClick={() => setUnavailCourt(court)} style={{ ...btnGhost, fontSize: 11, color: C.unavail, borderColor: `${C.unavail}40` }}>
                  Gestisci blocchi
                </button>
              </div>

              <div style={{ padding: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                {todayBlocks.map(u => (
                  <div key={u.id} style={{ background: `${C.unavail}18`, border: `1px solid ${C.unavail}30`, borderRadius: 8, padding: "8px 12px" }}>
                    <div style={{ fontSize: 11, color: C.unavail, fontWeight: 600 }}>
                      🔒 {fmtTime(u.startTime)}–{fmtTime(u.endTime)}
                      {u.recurring && " (ricorrente)"}
                    </div>
                    {u.reason && <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>{u.reason}</div>}
                  </div>
                ))}
                {court.matches?.length === 0 && todayBlocks.length === 0 && (
                  <div style={{ textAlign: "center", padding: "16px 0", color: C.dim, fontSize: 12 }}>Nessuna partita oggi</div>
                )}
                {court.matches?.map(m => <MatchCard key={m.id} match={m} onCancel={cancelMatch} />)}
              </div>
            </div>
          );
        })}
      </div>

      {showCreate && <CreateMatchModal courts={courtData} club={club} token={token} onClose={() => setShowCreate(false)} onCreated={load} />}
      {unavailCourt && <UnavailabilityPanel court={unavailCourt} token={token} onClose={() => { setUnavailCourt(null); load(); }} />}
      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </div>
  );
}
