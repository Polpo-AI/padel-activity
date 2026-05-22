import { useState, useEffect } from "react";
import { useTheme } from "../../shared/ThemeContext";
import { api } from "../../shared/config";
import Toast from "../../shared/Toast";

export default function PricesView({ token }) {
  const { C, inputSt, btnPrimary, btnGhost, labelSt } = useTheme();
  const [courts, setCourts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [showExceptionModal, setShowExceptionModal] = useState(false);
  const [excForm, setExcForm] = useState({ courtId: "", startDate: "", endDate: "", startTime: "08:00", endTime: "22:00", price: "" });

  const load = () => {
    setLoading(true);
    api("/prices", token)
      .then(d => {
        setCourts(d);
        if (d.length > 0 && !excForm.courtId) setExcForm(f => ({ ...f, courtId: d[0].id }));
      })
      .catch(e => setToast({ msg: e.message, type: "err" }))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, [token]);

  const addStandardSlot = (courtId) => {
    setCourts(prev => prev.map(c => c.id !== courtId ? c : {
      ...c,
      prices: [...c.prices, { courtId, startTime: "08:00", endTime: "22:00", price: 0, startDate: null, endDate: null }],
    }));
  };

  const updatePriceRow = (courtId, index, data) => {
    setCourts(prev => prev.map(c => {
      if (c.id !== courtId) return c;
      const newPrices = [...c.prices];
      newPrices[index] = { ...newPrices[index], ...data };
      return { ...c, prices: newPrices };
    }));
  };

  const deletePriceRow = async (courtId, index, priceId) => {
    if (priceId) {
      try {
        await api("/prices", token, { method: "POST", body: JSON.stringify({ prices: [{ id: priceId, courtId, _delete: true }] }) });
      } catch {
        return setToast({ msg: "Errore", type: "err" });
      }
    }
    setCourts(prev => prev.map(c => c.id !== courtId ? c : { ...c, prices: c.prices.filter((_, i) => i !== index) }));
    setToast({ msg: "Rimosso ✓", type: "ok" });
  };

  const saveStandard = async () => {
    setSaving(true);
    try {
      const payload = courts.flatMap(c =>
        c.prices.filter(p => !p.startDate && !p.endDate).map(p => ({
          id: p.id, courtId: c.id, startTime: p.startTime, endTime: p.endTime, price: parseFloat(p.price || 0),
        }))
      );
      await api("/prices", token, { method: "POST", body: JSON.stringify({ prices: payload }) });
      setToast({ msg: "Tariffe salvate ✓", type: "ok" });
      load();
    } catch (e) { setToast({ msg: e.message, type: "err" }); }
    finally { setSaving(false); }
  };

  const saveException = async () => {
    if (!excForm.price || !excForm.startDate || !excForm.endDate) return alert("Compila tutti i campi!");
    setSaving(true);
    try {
      await api("/prices", token, {
        method: "POST",
        body: JSON.stringify({ prices: [{ courtId: excForm.courtId, startTime: excForm.startTime, endTime: excForm.endTime, price: parseFloat(excForm.price), startDate: excForm.startDate, endDate: excForm.endDate }] }),
      });
      setToast({ msg: "Eccezione salvata ✓", type: "ok" });
      setShowExceptionModal(false);
      load();
    } catch (e) { setToast({ msg: e.message, type: "err" }); }
    finally { setSaving(false); }
  };

  if (loading) return <div style={{ color: C.muted, fontSize: 13 }}>Caricamento...</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <button type="button" onClick={() => setShowExceptionModal(true)} style={{ ...btnPrimary, background: "transparent", border: `1px solid ${C.accent}`, color: C.accent }}>
          ➕ Aggiungi Eccezione
        </button>
        <button type="button" onClick={saveStandard} disabled={saving} style={btnPrimary}>
          {saving ? "Salvataggio..." : "Salva Tariffe Standard"}
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(400px, 1fr))", gap: 16 }}>
        {courts.map(c => {
          const standardPrices = c.prices.filter(p => !p.startDate && !p.endDate);
          const exceptionPrices = c.prices.filter(p => p.startDate || p.endDate);
          return (
            <div key={c.id} style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 20 }}>
              <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 12, display: "flex", justifyContent: "space-between" }}>
                <span>🏟 {c.name}</span>
                <span style={{ fontSize: 11, color: C.muted }}>Prezzi Base</span>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {standardPrices.map((p, idx) => (
                  <div key={idx} style={{ display: "flex", alignItems: "center", gap: 8, background: C.bg, padding: 8, borderRadius: 8 }}>
                    <input type="time" value={p.startTime}
                      onChange={e => updatePriceRow(c.id, c.prices.indexOf(p), { startTime: e.target.value })}
                      style={{ ...inputSt, padding: "4px 8px", width: 85, fontSize: 12 }} />
                    <span style={{ color: C.dim }}>-</span>
                    <input type="time" value={p.endTime}
                      onChange={e => updatePriceRow(c.id, c.prices.indexOf(p), { endTime: e.target.value })}
                      style={{ ...inputSt, padding: "4px 8px", width: 85, fontSize: 12 }} />
                    <div style={{ position: "relative", flex: 1 }}>
                      <input type="number" step="0.5" value={p.price}
                        onChange={e => updatePriceRow(c.id, c.prices.indexOf(p), { price: e.target.value })}
                        style={{ ...inputSt, padding: "4px 8px 4px 18px", width: "100%", fontSize: 12 }} />
                      <span style={{ position: "absolute", left: 6, top: 7, fontSize: 11, color: C.dim }}>€</span>
                    </div>
                    <button type="button" onClick={() => deletePriceRow(c.id, c.prices.indexOf(p), p.id)}
                      style={{ border: "none", background: "transparent", cursor: "pointer", color: C.cancelled, fontSize: 13 }}>✕</button>
                  </div>
                ))}
                <button type="button" onClick={() => addStandardSlot(c.id)} style={{
                  background: "transparent", border: `1px dashed ${C.border}`,
                  padding: 8, borderRadius: 8, cursor: "pointer", color: C.muted, fontSize: 12, textAlign: "center", fontFamily: "inherit",
                }}>+ Aggiungi fascia</button>
              </div>

              {exceptionPrices.length > 0 && (
                <div style={{ marginTop: 16, borderTop: `1px solid ${C.border}`, paddingTop: 12 }}>
                  <div style={{ fontSize: 11, fontWeight: 600, color: C.muted, marginBottom: 6 }}>Eccezioni Calendario:</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {exceptionPrices.map((e, idx) => (
                      <div key={idx} style={{ fontSize: 11, color: C.text, display: "flex", justifyContent: "space-between", background: `${C.accent}08`, padding: "6px 8px", borderRadius: 4, alignItems: "center" }}>
                        <span>📅 {new Date(e.startDate).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" })}-{new Date(e.endDate).toLocaleDateString("it-IT", { day: "2-digit", month: "2-digit" })}</span>
                        <span>🕒 {e.startTime}-{e.endTime}</span>
                        <span style={{ fontWeight: 700 }}>€{e.price}</span>
                        <button type="button" onClick={() => deletePriceRow(c.id, c.prices.indexOf(e), e.id)}
                          style={{ border: "none", background: "transparent", color: C.cancelled, fontSize: 10, cursor: "pointer" }}>✕</button>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {showExceptionModal && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, bottom: 0, background: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
          <div style={{ background: C.surface, borderRadius: 12, padding: 24, width: 420, display: "flex", flexDirection: "column", gap: 14, border: `1px solid ${C.border}` }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: C.text }}>📅 Nuova Eccezione Calendario</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={labelSt}>Campo</label>
              <select value={excForm.courtId} onChange={e => setExcForm(f => ({ ...f, courtId: e.target.value }))} style={inputSt}>
                {courts.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={labelSt}>Dal</label>
                <input type="date" value={excForm.startDate} onChange={e => setExcForm(f => ({ ...f, startDate: e.target.value }))} style={inputSt} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={labelSt}>Al</label>
                <input type="date" value={excForm.endDate} onChange={e => setExcForm(f => ({ ...f, endDate: e.target.value }))} style={inputSt} />
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={labelSt}>Dalle Ore</label>
                <input type="time" value={excForm.startTime} onChange={e => setExcForm(f => ({ ...f, startTime: e.target.value }))} style={inputSt} />
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                <label style={labelSt}>Alle Ore</label>
                <input type="time" value={excForm.endTime} onChange={e => setExcForm(f => ({ ...f, endTime: e.target.value }))} style={inputSt} />
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <label style={labelSt}>Prezzo Ora</label>
              <input type="number" step="0.5" value={excForm.price} onChange={e => setExcForm(f => ({ ...f, price: e.target.value }))} style={inputSt} placeholder="Es. 40" />
            </div>
            <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
              <button type="button" onClick={() => setShowExceptionModal(false)} style={{ ...btnGhost, flex: 1 }}>Annulla</button>
              <button type="button" onClick={saveException} disabled={saving} style={{ ...btnPrimary, flex: 1 }}>
                {saving ? "Salvataggio..." : "Crea Eccezione"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </div>
  );
}
