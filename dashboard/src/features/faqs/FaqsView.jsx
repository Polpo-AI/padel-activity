import { useState, useEffect, useCallback } from "react";
import { C, api, inputSt, btnPrimary, btnGhost, labelSt } from "../../shared/config";
import Spinner from "../../shared/Spinner";
import Toast from "../../shared/Toast";

// ─── Badge helpers ──────────────────────────

const DECISION_CONFIG = {
  NEW:       { color: C.open,      bg: `${C.open}15`,      label: "Nuova FAQ" },
  DUPLICATE: { color: C.warning,   bg: `${C.warning}15`,   label: "Già coperta" },
  CONFLICT:  { color: C.cancelled, bg: `${C.cancelled}15`, label: "Conflitto" },
  MERGE:     { color: C.locked,    bg: `${C.locked}15`,    label: "Suggerisci merge" },
};

function DecisionBadge({ decision }) {
  const cfg = DECISION_CONFIG[decision] || DECISION_CONFIG.NEW;
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 6,
      background: cfg.bg, color: cfg.color, textTransform: "uppercase", letterSpacing: "0.06em",
    }}>
      {cfg.label}
    </span>
  );
}

// ─── PendingFaqCard ──────────────────────────

function PendingFaqCard({ faq, token, onUpdated, onDelete }) {
  const [answer, setAnswer] = useState("");
  const [notifyPlayer, setNotifyPlayer] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [relatedFaq, setRelatedFaq] = useState(null);
  const [mergedQ, setMergedQ] = useState("");
  const [mergedA, setMergedA] = useState("");
  const [toast, setToast] = useState(null);

  const handleAnalyze = async () => {
    if (!answer.trim()) return;
    setAnalyzing(true);
    setAnalysisResult(null);
    try {
      const result = await api("/faqs/analyze", token, {
        method: "POST",
        body: JSON.stringify({ question: faq.question, answer: answer.trim() }),
      });
      setAnalysisResult(result);
      if (result.suggestedQuestion) setMergedQ(result.suggestedQuestion);
      if (result.suggestedAnswer) setMergedA(result.suggestedAnswer);
      // Load related FAQ for CONFLICT side-by-side view
      if (result.relatedFaqId && (result.decision === "CONFLICT" || result.decision === "MERGE" || result.decision === "DUPLICATE")) {
        try {
          const faqs = await api("/faqs", token);
          const found = faqs.find(f => f.id === result.relatedFaqId);
          setRelatedFaq(found || null);
        } catch {}
      }
    } catch (e) {
      setToast({ msg: e.message, type: "err" });
    } finally {
      setAnalyzing(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await api(`/faqs/${faq.id}/answer`, token, {
        method: "POST",
        body: JSON.stringify({ answer: answer.trim(), notifyPlayer }),
      });
      setToast({ msg: "Risposta salvata", type: "ok" });
      onUpdated();
    } catch (e) {
      setToast({ msg: e.message, type: "err" });
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = async () => {
    if (!confirm("Scartare questa FAQ?")) return;
    try {
      await api(`/faqs/${faq.id}`, token, { method: "DELETE" });
      onUpdated();
    } catch (e) {
      setToast({ msg: e.message, type: "err" });
    }
  };

  const handleMerge = async (keepId, deleteId) => {
    if (!mergedQ.trim() || !mergedA.trim()) return;
    setSaving(true);
    try {
      await api("/faqs/merge", token, {
        method: "POST",
        body: JSON.stringify({
          keepId,
          deleteId,
          mergedQuestion: mergedQ.trim(),
          mergedAnswer: mergedA.trim(),
        }),
      });
      setToast({ msg: "Merge completato", type: "ok" });
      onUpdated();
    } catch (e) {
      setToast({ msg: e.message, type: "err" });
    } finally {
      setSaving(false);
    }
  };

  const handleKeepBoth = async () => {
    setSaving(true);
    try {
      await api(`/faqs/${faq.id}/answer`, token, {
        method: "POST",
        body: JSON.stringify({ answer: answer.trim(), notifyPlayer }),
      });
      setToast({ msg: "Salvata come nuova FAQ", type: "ok" });
      onUpdated();
    } catch (e) {
      setToast({ msg: e.message, type: "err" });
    } finally {
      setSaving(false);
    }
  };

  const handleUpdateExisting = async () => {
    if (!analysisResult?.relatedFaqId) return;
    setSaving(true);
    try {
      await api(`/faqs/${analysisResult.relatedFaqId}`, token, {
        method: "PUT",
        body: JSON.stringify({ answer: answer.trim() }),
      });
      await api(`/faqs/${faq.id}`, token, { method: "DELETE" });
      setToast({ msg: "FAQ esistente aggiornata", type: "ok" });
      onUpdated();
    } catch (e) {
      setToast({ msg: e.message, type: "err" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 12 }}>
      <div>
        <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 4 }}>Domanda</div>
        <div style={{ fontSize: 13, color: C.text, fontWeight: 500 }}>{faq.question}</div>
        {faq.askedBy && (
          <div style={{ fontSize: 11, color: C.muted, marginTop: 4, fontFamily: "monospace" }}>
            Da: {faq.askedBy}
          </div>
        )}
      </div>

      <div>
        <label style={labelSt}>Risposta</label>
        <textarea
          value={answer}
          onChange={e => { setAnswer(e.target.value); setAnalysisResult(null); }}
          placeholder="Scrivi la risposta..."
          rows={3}
          style={{ ...inputSt, resize: "vertical", lineHeight: 1.5 }}
        />
      </div>

      {faq.askedBy && (
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: C.muted, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={notifyPlayer}
            onChange={e => setNotifyPlayer(e.target.checked)}
            style={{ accentColor: C.accent }}
          />
          Notifica il giocatore via WhatsApp
        </label>
      )}

      {/* Analyze button */}
      {!analysisResult && (
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button onClick={handleDiscard} style={{ ...btnGhost, color: C.cancelled, borderColor: `${C.cancelled}40` }} disabled={saving}>
            Scarta
          </button>
          <button onClick={handleAnalyze} disabled={!answer.trim() || analyzing || saving} style={btnPrimary}>
            {analyzing ? "Analisi..." : "Analizza & Salva"}
          </button>
        </div>
      )}

      {/* Analysis result */}
      {analysisResult && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 12, background: C.bg, border: `1px solid ${C.borderLight || C.border}`, borderRadius: 10 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <DecisionBadge decision={analysisResult.decision} />
            <span style={{ fontSize: 12, color: C.muted }}>{analysisResult.reason}</span>
          </div>

          {/* NEW */}
          {analysisResult.decision === "NEW" && (
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button onClick={() => setAnalysisResult(null)} style={btnGhost} disabled={saving}>Rianalizza</button>
              <button onClick={handleSave} style={btnPrimary} disabled={saving}>
                {saving ? "Salvo..." : "Salva"}
              </button>
            </div>
          )}

          {/* DUPLICATE */}
          {analysisResult.decision === "DUPLICATE" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {relatedFaq && (
                <div style={{ fontSize: 12, padding: "8px 12px", background: `${C.warning}10`, border: `1px solid ${C.warning}30`, borderRadius: 8, color: C.muted }}>
                  <strong style={{ color: C.warning }}>FAQ esistente:</strong> {relatedFaq.question}
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={handleDiscard} style={{ ...btnGhost, color: C.cancelled, borderColor: `${C.cancelled}40` }} disabled={saving}>
                  Scarta
                </button>
                <button onClick={handleSave} style={{ ...btnGhost, color: C.text }} disabled={saving}>
                  Salva comunque
                </button>
              </div>
            </div>
          )}

          {/* CONFLICT */}
          {analysisResult.decision === "CONFLICT" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {relatedFaq && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <div style={{ padding: "10px 12px", background: `${C.cancelled}10`, border: `1px solid ${C.cancelled}30`, borderRadius: 8, fontSize: 12 }}>
                    <div style={{ color: C.cancelled, fontWeight: 700, marginBottom: 4 }}>FAQ in conflitto</div>
                    <div style={{ color: C.text, marginBottom: 4 }}>{relatedFaq.question}</div>
                    <div style={{ color: C.muted }}>{relatedFaq.answer}</div>
                  </div>
                  <div style={{ padding: "10px 12px", background: `${C.locked}10`, border: `1px solid ${C.locked}30`, borderRadius: 8, fontSize: 12 }}>
                    <div style={{ color: C.locked, fontWeight: 700, marginBottom: 4 }}>Nuova risposta</div>
                    <div style={{ color: C.text, marginBottom: 4 }}>{faq.question}</div>
                    <div style={{ color: C.muted }}>{answer}</div>
                  </div>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={handleKeepBoth} style={btnGhost} disabled={saving}>
                  Tieni entrambe
                </button>
                <button onClick={handleUpdateExisting} style={{ ...btnGhost, color: C.warning, borderColor: `${C.warning}40` }} disabled={saving}>
                  {saving ? "..." : "Aggiorna quella esistente"}
                </button>
              </div>
            </div>
          )}

          {/* MERGE */}
          {analysisResult.decision === "MERGE" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 12, color: C.muted }}>Q+A unificata proposta (modificabile):</div>
              <div>
                <label style={labelSt}>Domanda unificata</label>
                <input
                  value={mergedQ}
                  onChange={e => setMergedQ(e.target.value)}
                  style={inputSt}
                />
              </div>
              <div>
                <label style={labelSt}>Risposta unificata</label>
                <textarea
                  value={mergedA}
                  onChange={e => setMergedA(e.target.value)}
                  rows={3}
                  style={{ ...inputSt, resize: "vertical" }}
                />
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={handleKeepBoth} style={btnGhost} disabled={saving}>
                  Salva separatamente
                </button>
                <button
                  onClick={() => handleMerge(analysisResult.relatedFaqId, faq.id)}
                  style={btnPrimary}
                  disabled={saving || !mergedQ.trim() || !mergedA.trim()}
                >
                  {saving ? "Merge..." : "Approva merge"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </div>
  );
}

// ─── AnsweredFaqCard ──────────────────────────

function AnsweredFaqCard({ faq, token, onUpdated }) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editQ, setEditQ] = useState(faq.question);
  const [editA, setEditA] = useState(faq.answer || "");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);

  const handleSave = async () => {
    setSaving(true);
    try {
      await api(`/faqs/${faq.id}`, token, {
        method: "PUT",
        body: JSON.stringify({ question: editQ.trim(), answer: editA.trim() }),
      });
      setEditing(false);
      setToast({ msg: "FAQ aggiornata", type: "ok" });
      onUpdated();
    } catch (e) {
      setToast({ msg: e.message, type: "err" });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm("Eliminare questa FAQ?")) return;
    try {
      await api(`/faqs/${faq.id}`, token, { method: "DELETE" });
      onUpdated();
    } catch (e) {
      setToast({ msg: e.message, type: "err" });
    }
  };

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 10, overflow: "hidden" }}>
      <div
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", cursor: "pointer" }}
        onClick={() => !editing && setExpanded(x => !x)}
      >
        <span style={{ color: C.muted, fontSize: 12, flex: 1, fontWeight: expanded ? 600 : 400, color: expanded ? C.text : C.muted }}>
          {editing ? (
            <input
              value={editQ}
              onChange={e => setEditQ(e.target.value)}
              onClick={e => e.stopPropagation()}
              style={{ ...inputSt, fontSize: 12 }}
            />
          ) : faq.question}
        </span>
        {!editing && (
          <>
            <button
              onClick={e => { e.stopPropagation(); setEditing(true); setExpanded(true); }}
              style={{ ...btnGhost, padding: "4px 8px", fontSize: 11, color: C.muted }}
              title="Modifica"
            >
              ✏
            </button>
            <button
              onClick={e => { e.stopPropagation(); handleDelete(); }}
              style={{ ...btnGhost, padding: "4px 8px", fontSize: 11, color: C.cancelled, borderColor: `${C.cancelled}30` }}
              title="Elimina"
            >
              ✕
            </button>
            <span style={{ color: C.muted, fontSize: 12, userSelect: "none" }}>{expanded ? "▲" : "▼"}</span>
          </>
        )}
      </div>

      {expanded && (
        <div style={{ padding: "0 14px 14px", borderTop: `1px solid ${C.border}` }}>
          {editing ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingTop: 12 }}>
              <div>
                <label style={labelSt}>Risposta</label>
                <textarea
                  value={editA}
                  onChange={e => setEditA(e.target.value)}
                  rows={4}
                  style={{ ...inputSt, resize: "vertical" }}
                />
              </div>
              <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                <button onClick={() => { setEditing(false); setEditQ(faq.question); setEditA(faq.answer || ""); }} style={btnGhost} disabled={saving}>
                  Annulla
                </button>
                <button onClick={handleSave} style={btnPrimary} disabled={saving || !editQ.trim() || !editA.trim()}>
                  {saving ? "Salvo..." : "Salva"}
                </button>
              </div>
            </div>
          ) : (
            <div style={{ paddingTop: 10, fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
              {faq.answer}
            </div>
          )}
        </div>
      )}

      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </div>
  );
}

// ─── AddFaqForm ──────────────────────────────

function AddFaqForm({ token, onCreated }) {
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!question.trim()) { setErr("Domanda richiesta"); return; }
    if (!answer.trim()) { setErr("Risposta richiesta"); return; }
    setSaving(true);
    setErr("");
    try {
      await api("/faqs", token, {
        method: "POST",
        body: JSON.stringify({ question: question.trim(), answer: answer.trim() }),
      });
      setQuestion("");
      setAnswer("");
      onCreated();
    } catch (e) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Aggiungi FAQ manualmente</div>
      <div>
        <label style={labelSt}>Domanda</label>
        <input
          value={question}
          onChange={e => setQuestion(e.target.value)}
          placeholder="es. Quali sono gli orari del circolo?"
          style={inputSt}
        />
      </div>
      <div>
        <label style={labelSt}>Risposta</label>
        <textarea
          value={answer}
          onChange={e => setAnswer(e.target.value)}
          placeholder="es. Il circolo è aperto dalle 8:00 alle 22:00..."
          rows={2}
          style={{ ...inputSt, resize: "vertical" }}
        />
      </div>
      {err && <div style={{ fontSize: 12, color: C.cancelled }}>⚠ {err}</div>}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={submit} disabled={saving || !question.trim() || !answer.trim()} style={btnPrimary}>
          {saving ? "Aggiungendo..." : "Aggiungi"}
        </button>
      </div>
    </div>
  );
}

// ─── FaqsView ────────────────────────────────

export default function FaqsView({ token }) {
  const [faqs, setFaqs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api("/faqs", token);
      setFaqs(data);
    } catch (e) {
      setToast({ msg: e.message, type: "err" });
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => { load(); }, [load]);

  const pending = faqs.filter(f => f.answer === null || f.answer === undefined);
  const answered = faqs.filter(f => f.answer !== null && f.answer !== undefined);

  if (loading) return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 20 }}>
      <Spinner />
      <span style={{ color: C.muted, fontSize: 13 }}>Caricamento FAQ...</span>
    </div>
  );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>

      {/* Pending section */}
      <div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text }}>In attesa di risposta</div>
          {pending.length > 0 && (
            <span style={{
              fontSize: 11, fontWeight: 700, padding: "2px 8px", borderRadius: 20,
              background: `${C.warning}18`, color: C.warning,
            }}>
              {pending.length}
            </span>
          )}
        </div>

        {pending.length === 0 ? (
          <div style={{
            background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12,
            padding: 24, textAlign: "center", color: C.muted, fontSize: 13,
          }}>
            Nessuna domanda in attesa
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            {pending.map(faq => (
              <PendingFaqCard
                key={faq.id}
                faq={faq}
                token={token}
                onUpdated={load}
                onDelete={load}
              />
            ))}
          </div>
        )}
      </div>

      {/* Knowledge base section */}
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 14 }}>
          Knowledge base
          {answered.length > 0 && (
            <span style={{ fontSize: 11, fontWeight: 400, color: C.muted, marginLeft: 8 }}>
              {answered.length} {answered.length === 1 ? "risposta" : "risposte"}
            </span>
          )}
        </div>

        <AddFaqForm token={token} onCreated={load} />

        {answered.length === 0 ? (
          <div style={{
            marginTop: 12, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12,
            padding: 24, textAlign: "center", color: C.muted, fontSize: 13,
          }}>
            Nessuna FAQ nella knowledge base
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12 }}>
            {answered.map(faq => (
              <AnsweredFaqCard
                key={faq.id}
                faq={faq}
                token={token}
                onUpdated={load}
              />
            ))}
          </div>
        )}
      </div>

      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </div>
  );
}
