import { useState, useEffect, useCallback } from "react";
import { C, api, btnGhost } from "../../shared/config";
import Spinner from "../../shared/Spinner";
import Toast from "../../shared/Toast";

function HealthDot({ ok, label }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{
        width: 8, height: 8, borderRadius: "50%",
        background: ok ? C.open : C.cancelled,
        boxShadow: ok ? `0 0 6px ${C.open}` : `0 0 6px ${C.cancelled}`,
      }} />
      <span style={{ fontSize: 12, color: ok ? C.text : C.cancelled }}>{label}</span>
    </div>
  );
}

export default function SystemView({ token }) {
  const [health, setHealth] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [toast, setToast] = useState(null);

  const load = useCallback(async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true); else setLoading(true);
    try {
      const d = await api("/system/health", token);
      setHealth(d);
    } catch {
      setHealth({
        redis: { connected: false, aof: false, queueSize: 0, version: "N/A" },
        whatsapp: { connected: false, jid: "N/A", uptime: 0 },
        database: { connected: false, version: "N/A" },
        worker: { running: false, lastRun: null, jobsProcessed: 0 },
        security: { rateLimitActive: false, jwtRotationEnabled: false, webhookHmac: false },
        uptime: 0,
      });
    } finally { setLoading(false); setRefreshing(false); }
  }, [token]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { const t = setInterval(() => load(true), 30000); return () => clearInterval(t); }, [load]);

  if (loading) return <div style={{ display: "flex", gap: 10, alignItems: "center", padding: 40 }}><Spinner /><span style={{ color: C.muted, fontSize: 13 }}>Controllo sistema...</span></div>;

  const h = health || {};
  const redis = h.redis || {};
  const ws = h.whatsapp || {};
  const db = h.database || {};
  const worker = h.worker || {};
  const sec = h.security || {};
  const fmt = (d, opts) => new Date(d).toLocaleString("it-IT", opts);

  const criticalIssues = [
    !redis.connected && "Redis non connesso",
    !redis.aof && "AOF Redis non attivo — rischio perdita dati",
    !sec.rateLimitActive && "Rate limiting non attivo — vulnerabilità dashboard",
    !sec.webhookHmac && "Webhook HMAC non configurato",
    !sec.jwtRotationEnabled && "JWT statico — rotazione non abilitata",
  ].filter(Boolean);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      {criticalIssues.length > 0 ? (
        <div style={{ background: `${C.cancelled}10`, border: `1px solid ${C.cancelled}40`, borderRadius: 12, padding: 20 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.cancelled, marginBottom: 12 }}>⚠ {criticalIssues.length} problema{criticalIssues.length > 1 ? "i critici" : " critico"} rilevato</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {criticalIssues.map((issue, i) => (
              <div key={i} style={{ fontSize: 12, color: C.cancelled, display: "flex", alignItems: "center", gap: 8 }}><span>✗</span><span>{issue}</span></div>
            ))}
          </div>
        </div>
      ) : (
        <div style={{ background: `${C.open}10`, border: `1px solid ${C.open}40`, borderRadius: 12, padding: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: C.open }}>✓ Sistema operativo — nessun problema critico</div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button onClick={() => load(true)} disabled={refreshing} style={{ ...btnGhost, fontSize: 11, display: "flex", alignItems: "center", gap: 6 }}>
          {refreshing ? <Spinner size={12} /> : "↻"} Aggiorna
        </button>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <div style={{ background: C.surface, border: `1px solid ${redis.connected ? C.border : `${C.cancelled}40`}`, borderRadius: 12, padding: 22 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Redis</div>
            <HealthDot ok={redis.connected} label={redis.connected ? "Connesso" : "Non connesso"} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, alignItems: "center" }}>
              <span style={{ color: C.muted }}>AOF Persistence</span>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 8, background: redis.aof ? `${C.open}18` : `${C.cancelled}18`, color: redis.aof ? C.open : C.cancelled }}>{redis.aof ? "ATTIVO" : "DISATTIVO"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span style={{ color: C.muted }}>Job in coda</span>
              <span style={{ color: redis.queueSize > 50 ? C.warning : C.text }}>{redis.queueSize ?? "—"}</span>
            </div>
          </div>
        </div>

        <div style={{ background: C.surface, border: `1px solid ${ws.connected ? C.border : `${C.cancelled}40`}`, borderRadius: 12, padding: 22 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>WhatsApp (Baileys)</div>
            <HealthDot ok={ws.connected} label={ws.connected ? "Connesso" : "Disconnesso"} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span style={{ color: C.muted }}>JID sessione</span>
              <span style={{ color: C.text, fontFamily: "monospace", fontSize: 11 }}>{ws.jid ? `...${ws.jid.slice(-10)}` : "—"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span style={{ color: C.muted }}>Uptime connessione</span>
              <span style={{ color: C.text }}>{ws.uptime ? `${Math.floor(ws.uptime / 3600)}h ${Math.floor((ws.uptime % 3600) / 60)}m` : "—"}</span>
            </div>
          </div>
        </div>

        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 22 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Database (Prisma)</div>
            <HealthDot ok={db.connected} label={db.connected ? "Connesso" : "Errore"} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span style={{ color: C.muted }}>Multi-tenancy</span>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 8, background: `${C.open}18`, color: C.open }}>ATTIVO</span>
            </div>
          </div>
        </div>

        <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 22 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>Worker</div>
            <HealthDot ok={worker.running} label={worker.running ? "Attivo" : "Fermo"} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span style={{ color: C.muted }}>Ultimo check</span>
              <span style={{ color: C.text, fontSize: 11 }}>{worker.lastCheck ? fmt(worker.lastCheck, { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span style={{ color: C.muted }}>Staleness check</span>
              <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 8, background: `${C.open}18`, color: C.open }}>ATTIVO</span>
            </div>
          </div>
        </div>
      </div>

      <div style={{ background: C.surface, border: `1px solid ${C.border}`, borderRadius: 12, padding: 22 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: C.text, marginBottom: 16 }}>🔐 Sicurezza API</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
          {[
            { label: "Rate Limiting", ok: sec.rateLimitActive, fix: "Aggiungere express-rate-limit middleware su /api/" },
            { label: "JWT Rotation", ok: sec.jwtRotationEnabled, fix: "Implementare refresh token e rotazione segreti" },
            { label: "Webhook HMAC", ok: sec.webhookHmac, fix: "Aggiungere firma HMAC-SHA256 sulla validazione webhook" },
          ].map(item => (
            <div key={item.label} style={{ background: C.bg, border: `1px solid ${item.ok ? `${C.open}30` : `${C.cancelled}30`}`, borderRadius: 10, padding: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <div style={{ width: 8, height: 8, borderRadius: "50%", background: item.ok ? C.open : C.cancelled }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: item.ok ? C.open : C.text }}>{item.label}</span>
              </div>
              {!item.ok && <div style={{ fontSize: 11, color: C.muted, lineHeight: 1.5 }}>{item.fix}</div>}
              {item.ok && <div style={{ fontSize: 11, color: C.open }}>✓ Configurato correttamente</div>}
            </div>
          ))}
        </div>
      </div>

      {toast && <Toast msg={toast.msg} type={toast.type} onDone={() => setToast(null)} />}
    </div>
  );
}
