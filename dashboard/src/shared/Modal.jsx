import { useEffect, useRef, useId } from "react";
import { useTheme } from "./ThemeContext";

export default function Modal({ title, onClose, children }) {
  const { C, btnGhost } = useTheme();
  const titleId = useId();
  const dialogRef = useRef(null);

  // Focus trap + ESC close
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusable = Array.from(dialog.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    ));
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (first) first.focus();

    const onKeyDown = (e) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key !== "Tab" || !focusable.length) return;
      if (e.shiftKey) {
        if (document.activeElement === first) { e.preventDefault(); last.focus(); }
      } else {
        if (document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      style={{
        position: "fixed", inset: 0, background: C.overlay,
        display: "flex", alignItems: "center", justifyContent: "center", zIndex: 500,
      }}
      onClick={e => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        style={{
          background: C.surface, border: `1px solid ${C.border}`, borderRadius: 16,
          padding: 32, width: 440, maxWidth: "95vw", maxHeight: "90vh", overflowY: "auto",
          display: "flex", flexDirection: "column", gap: 20,
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div id={titleId} style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{title}</div>
          <button type="button" onClick={onClose} aria-label="Chiudi" style={{ ...btnGhost, border: "none", padding: "4px 8px" }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}
