import { C } from "./config";

export default function Spinner({ size = 16 }) {
  return <div style={{
    width: size, height: size, border: `2px solid ${C.border}`,
    borderTopColor: C.accent, borderRadius: "50%",
    animation: "spin 0.7s linear infinite", flexShrink: 0,
  }} />;
}
