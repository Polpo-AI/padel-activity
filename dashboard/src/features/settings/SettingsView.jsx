import { useState, useEffect } from "react";
import { C, api, inputSt, btnPrimary, btnGhost, labelSt } from "../../shared/config";
import Toast from "../../shared/Toast";

const EMPTY = {
  // Circolo
  name: "", city: "", address: "", adminPhone: "", adminAlternativePhone: "",
  // Bot
  botName: "", aiTone: "friendly", maxDailyMessages: 2, racketPrice: "",
  // Orari & Partite
  openTime: "08:00", closeTime: "23:30", matchDuration: 90, deadlineMinutesBeforeMatch: 60,
  // Matchmaking
  skillLevelCount: 3, matchLowerRange: 1.0, matchUpperRange: 1.0,
  allowMixedLevels: false, allowMixedGenderMatchmaking: false, waveMultiplier: 3,
  // Skill test
  skillTestCost: 0, skillTestDuration: 60,
};

function Section({ title, children }) {
  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 24, display: "flex", flexDirection: "column", gap: 18 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>{title}</div>
      {children}
    </div>
  );
}

function F({ label, hint, children }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <label style={labelSt}>{label}</label>
      {hint && <div style={{ fontSize: 10, color: C.muted, marginTop: -4 }}>{hint}</div>}
      {children}
    </div>
  );
}

function Toggle({ value, onChange, labelOn = "Sì", labelOff = "No" }) {
  return (
    <div style={{ display: "flex", gap: 8 }}>
      {[true, false].map(v => (
        <button key={String(v)} onClick={() => onChange(v)} style={{
          flex: 1, padding: "9px 0", borderRadius: 8, cursor: "pointer", fontSize: 12,
          border: `1px solid ${value === v ? C.accent : C.border}`,
          background: value === v ? C.accentDim : "transparent",
          color: value === v ? C.accent : C.muted,
          fontFamily: "inherit",
        }}>{v ? labelOn : labelOff}</button>
      ))}
    </div>
  );
}

function Grid({ children }) {
  return <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 }}>{children}</div>;
}

export default function SettingsView({ token, club, onClubUpdate }) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [clubId, setClubId] = useState(null);
  const [confirmDialog, setConfirmDialog] = useState(null);

  useEffect(() => {
    api("/club", token).then(d => {
      setClubId(d.id);
      setForm({
        name: d.name || "",
        city: d.city || "",
        address: d.address || "",
        adminPhone: d.adminPhone || "",
        adminAlternativePhone: d.adminAlternativePhone || "",
        botName: d.botName || "",
        aiTone: d.aiTone || "friendly",
        maxDailyMessages: d.maxDailyMessages ?? 2,
        racketPrice: d.racketPrice ?? "",
        openTime: d.openTime || "08:00",
        closeTime: d.closeTime || "23:30",
        matchDuration: d.matchDuration ?? 90,
        deadlineMinutesBeforeMatch: d.deadlineMinutesBeforeMatch ?? 60,
        skillLevelCount: d.skillLevelCount ?? 3,
        matchLowerRange: d.matchLowerRange ?? 1.0,
        matchUpperRange: d.matchUpperRange ?? 1.0,
        allowMixedLevels: d.allowMixedLevels ?? false,
        allowMixedGenderMatchmaking: d.allowMixedGenderMatchmaking ?? false,
        waveMultiplier: d.waveMultiplier ?? 3,
        skillTestCost: d.skillTestCost ?? 0,
        skillTestDuration: d.skillTestDuration ?? 60,
      });
    }).catch(() => {});
  }, [token]);

  const f = (k, parse) => e => setForm(p => ({ ...p, [k]: parse ? parse(e.target.value) : e.target.value }));

  const doSave = async (confirm = false) => {
    setSaving(true);
    try {
      const url = confirm ? "/club?confirm=true" : "/club";
      const d = await api(url, token, { method: "PATCH", body: JSON.stringify(form) });
      if (d.requiresConfirmation) {
        setConfirmDialog(d);
        setSaving(false);
        return;
      }
      onClubUpdate?.(d);
      setToast({ msg: "Impostazioni salvate ✓", type: "ok" });
    } catch (e) {
      setToast({ msg: e.message || "Errore nel salvataggio", type: "err" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, maxWidth: 780 }}>

      {clubId && (
        <div style={{ background: `${C.accent}08`, border: `1px solid ${C.accentSoft}`, borderRadius: 10, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 16 }}>🏛</span>
          <div>
            <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em" }}>Club ID</div>
            <div style={{ fontSize: 13, fontFamily: "monospace", color: C.accent, marginTop: 2 }}>{clubId}</div>
          </div>
        </div>
      )}

      {/* ── 1. Circolo ── */}
      <Section title="🏟 Circolo">
        <F label="Nome circolo">
          <input value={form.name} onChange={f("name")} style={inputSt} placeholder="Es. Circolo Padel Roma" />
        </F>
        <Grid>
          <F label="Città">
            <input value={form.city} onChange={f("city")} style={inputSt} placeholder="Es. Roma" />
          </F>
          <F label="Indirizzo" hint="Appare in ogni conferma di prenotazione">
            <input value={form.address} onChange={f("address")} style={inputSt} placeholder="Via Roma 1" />
          </F>
          <F label="Telefono admin" hint="Riceve notifiche WhatsApp">
            <input value={form.adminPhone} onChange={f("adminPhone")} style={inputSt} placeholder="393457991255" />
          </F>
          <F label="Telefono alternativo" hint="Per lezioni/maestro">
            <input value={form.adminAlternativePhone} onChange={f("adminAlternativePhone")} style={inputSt} placeholder="393457991256" />
          </F>
        </Grid>
      </Section>

      {/* ── 2. Bot ── */}
      <Section title="🤖 Bot">
        <Grid>
          <F label="Nome bot">
            <input value={form.botName} onChange={f("botName")} style={inputSt} placeholder="Es. Francesca" />
          </F>
          <F label="Prezzo noleggio racchetta (€)" hint="0 = non mostrato in prenotazione">
            <input type="number" min="0" step="0.5" value={form.racketPrice} onChange={f("racketPrice", parseFloat)} style={inputSt} placeholder="5" />
          </F>
        </Grid>
        <F label="Tono AI">
          <div style={{ display: "flex", gap: 8 }}>
            {[{ id: "formal", label: "🧑‍💼 Formale" }, { id: "friendly", label: "😊 Amichevole" }, { id: "fun", label: "🎉 Divertente" }].map(t => (
              <button key={t.id} onClick={() => setForm(p => ({ ...p, aiTone: t.id }))} style={{
                flex: 1, padding: "9px 0", borderRadius: 8, cursor: "pointer", fontSize: 12,
                border: `1px solid ${form.aiTone === t.id ? C.accent : C.border}`,
                background: form.aiTone === t.id ? C.accentDim : "transparent",
                color: form.aiTone === t.id ? C.accent : C.muted,
                fontFamily: "inherit",
              }}>{t.label}</button>
            ))}
          </div>
        </F>
        <F label={`Max messaggi giornalieri per giocatore (${form.maxDailyMessages})`}>
          <input type="range" min={1} max={5} value={form.maxDailyMessages} onChange={f("maxDailyMessages", parseInt)} style={{ width: "100%" }} />
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: C.dim }}>
            {[1,2,3,4,5].map(v => <span key={v}>{v}</span>)}
          </div>
        </F>
      </Section>

      {/* ── 3. Orari & Partite ── */}
      <Section title="🕐 Orari & Partite">
        <Grid>
          <F label="Apertura circolo">
            <input type="time" value={form.openTime} onChange={f("openTime")} style={inputSt} />
          </F>
          <F label="Chiusura circolo">
            <input type="time" value={form.closeTime} onChange={f("closeTime")} style={inputSt} />
          </F>
          <F label="Durata partita (minuti)">
            <input type="number" min={30} max={180} step={15} value={form.matchDuration} onChange={f("matchDuration", parseInt)} style={inputSt} />
          </F>
          <F label="Deadline cancellazione (minuti prima)" hint="Dopo questo limite non si può cancellare">
            <input type="number" min={0} max={1440} step={15} value={form.deadlineMinutesBeforeMatch} onChange={f("deadlineMinutesBeforeMatch", parseInt)} style={inputSt} />
          </F>
        </Grid>
      </Section>

      {/* ── 4. Matchmaking ── */}
      <Section title="🎯 Matchmaking">
        <Grid>
          <F label="Range skill inferiore (±)" hint="Es. 1.0 = giocatori entro 1 livello sotto">
            <input type="number" min={0} max={3} step={0.5} value={form.matchLowerRange} onChange={f("matchLowerRange", parseFloat)} style={inputSt} />
          </F>
          <F label="Range skill superiore (±)" hint="Es. 1.0 = giocatori entro 1 livello sopra">
            <input type="number" min={0} max={3} step={0.5} value={form.matchUpperRange} onChange={f("matchUpperRange", parseFloat)} style={inputSt} />
          </F>
          <F label="Numero livelli skill (2–7)">
            <input type="number" min={2} max={7} value={form.skillLevelCount} onChange={f("skillLevelCount", parseInt)} style={inputSt} />
          </F>
          <F label="Wave multiplier" hint="Quante persone vengono invitate per posto libero">
            <input type="number" min={1} max={10} value={form.waveMultiplier} onChange={f("waveMultiplier", parseInt)} style={inputSt} />
          </F>
        </Grid>
        <Grid>
          <F label="Livelli misti nella stessa partita">
            <Toggle value={form.allowMixedLevels} onChange={v => setForm(p => ({ ...p, allowMixedLevels: v }))} />
          </F>
          <F label="Matchmaking misto maschi/femmine">
            <Toggle value={form.allowMixedGenderMatchmaking} onChange={v => setForm(p => ({ ...p, allowMixedGenderMatchmaking: v }))} />
          </F>
        </Grid>
      </Section>

      {/* ── 5. Skill test ── */}
      <Section title="📋 Skill Test">
        <Grid>
          <F label="Costo skill test (€)">
            <input type="number" min={0} step={1} value={form.skillTestCost} onChange={f("skillTestCost", parseFloat)} style={inputSt} />
          </F>
          <F label="Durata skill test (minuti)">
            <input type="number" min={15} max={120} step={15} value={form.skillTestDuration} onChange={f("skillTestDuration", parseInt)} style={inputSt} />
          </F>
        </Grid>
      </Section>

      <button onClick={() => doSave(false)} disabled={saving} style={{ ...btnPrimary, alignSelf: "flex-start", minWidth: 160 }}>
        {saving ? "Salvataggio..." : "Salva impostazioni"}
      </button>

      {/* Dialog conferma cambio orari */}
      {confirmDialog && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 14, padding: 28, maxWidth: 460, width: "90%" }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: C.text, marginBottom: 12 }}>⚠️ Conferma modifica orari</div>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 20, lineHeight: 1.6 }}>{confirmDialog.message}</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={() => setConfirmDialog(null)} style={{ ...btnGhost, fontSize: 12 }}>Annulla</button>
              <button onClick={async () => { setConfirmDialog(null); await doSave(true); }} style={{ ...btnPrimary, fontSize: 12, background: "#e53e3e" }}>
                Procedi e cancella le partite
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </div>
  );
}
