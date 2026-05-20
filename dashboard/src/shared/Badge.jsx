import { useTheme } from "./ThemeContext";
import { STATUS } from "./config";

export default function Badge({ status }) {
  const { C } = useTheme();
  const m = STATUS[status] || { color: C.muted, label: status };
  return (
    <span style={{
      fontSize: 10, fontWeight: 700, letterSpacing: "0.06em",
      padding: "3px 8px", borderRadius: 20,
      background: `${m.color}18`, color: m.color, border: `1px solid ${m.color}30`,
    }}>● {m.label.toUpperCase()}</span>
  );
}
