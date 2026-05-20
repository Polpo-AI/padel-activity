import { useEffect } from "react";
import { useTheme } from "./ThemeContext";

export default function Toast({ msg, type = "ok", onDone }) {
  const { C } = useTheme();
  useEffect(() => { const t = setTimeout(onDone, 3000); return () => clearTimeout(t); }, []);
  return (
    <div style={{
      position: "fixed", bottom: 28, right: 28, zIndex: 9999,
      background: type === "ok" ? C.accent : C.cancelled,
      color: type === "ok" ? C.bg : "#fff",
      padding: "12px 20px", borderRadius: 10, fontSize: 13, fontWeight: 600,
      boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
      animation: "slideUp 0.2s ease",
    }}>{msg}</div>
  );
}
