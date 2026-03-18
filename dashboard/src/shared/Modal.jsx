import { C, btnGhost } from "./config";

export default function Modal({ title, onClose, children }) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 500,
    }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{
        background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16,
        padding: 32, width: 440, maxWidth: "95vw", maxHeight: "90vh", overflowY: "auto",
        display: "flex", flexDirection: "column", gap: 20,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{title}</div>
          <button onClick={onClose} style={{ ...btnGhost, border: "none", padding: "4px 8px" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
