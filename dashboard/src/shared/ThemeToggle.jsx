import { useTheme } from "./ThemeContext";

export default function ThemeToggle() {
  const { mode, toggle } = useTheme();
  const dark = mode === "dark";

  return (
    <div
      onClick={toggle}
      title={dark ? "Passa a light mode" : "Passa a dark mode"}
      style={{
        position: "fixed", top: 20, right: 24, zIndex: 200,
        width: 74, height: 36, borderRadius: 18, cursor: "pointer",
        background: dark ? "rgba(255,255,255,0.07)" : "rgba(8,145,178,0.12)",
        border: `1.5px solid ${dark ? "rgba(255,255,255,0.18)" : "rgba(8,145,178,0.30)"}`,
        backdropFilter: "blur(12px)",
        display: "flex", alignItems: "center",
        padding: "0 5px",
        transition: "background 0.3s, border-color 0.3s, box-shadow 0.3s",
        boxShadow: dark
          ? "0 4px 16px rgba(0,0,0,0.30)"
          : "0 4px 16px rgba(8,145,178,0.20)",
        userSelect: "none",
      }}
    >
      {/* 🌙 left — active in dark mode */}
      <span style={{
        position: "absolute", left: 8, fontSize: 13,
        pointerEvents: "none",
        opacity: dark ? 1 : 0.35,
        transition: "opacity 0.3s",
      }}>🌙</span>

      {/* ☀️ right — active in light mode */}
      <span style={{
        position: "absolute", right: 8, fontSize: 13,
        pointerEvents: "none",
        opacity: dark ? 0.35 : 1,
        transition: "opacity 0.3s",
      }}>☀️</span>

      {/* Sliding circle */}
      <div style={{
        width: 26, height: 26, borderRadius: 13, flexShrink: 0,
        background: dark
          ? "linear-gradient(135deg, #a78bfa, #22d3ee)"
          : "linear-gradient(135deg, #22d3ee, #f59e0b)",
        boxShadow: "0 2px 8px rgba(0,0,0,0.30)",
        transform: dark ? "translateX(0px)" : "translateX(36px)",
        transition: "transform 0.3s cubic-bezier(0.23,1,0.32,1), background 0.3s",
      }} />
    </div>
  );
}
