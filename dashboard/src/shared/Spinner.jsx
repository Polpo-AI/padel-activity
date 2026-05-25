import { useTheme } from "./ThemeContext";

export default function Spinner({ size = 16 }) {
  const { C } = useTheme();
  return <div role="status" aria-label="Caricamento..." style={{
    width: size, height: size, border: `2px solid ${C.border}`,
    borderTopColor: C.accent, borderRadius: "50%",
    animation: "spin 0.7s linear infinite", flexShrink: 0,
  }} />;
}
