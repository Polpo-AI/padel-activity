import { createContext, useContext, useState, useEffect } from "react";
import { makeTheme } from "./config";

const ThemeContext = createContext(null);

// ─── useMobile singleton ─────────────────────────────────────────────────────
// One module-level listener shared across all consumers — no N-listener problem.
// 768px è l'unico breakpoint mobile dell'app: shell (sidebar→hamburger), griglie
// e toggle lo consumano tutti da qui, così non esiste più la zona morta 640–768.
const BREAKPOINT = 768;
let _mobile = window.innerWidth < BREAKPOINT;
const _listeners = new Set();

if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    const next = window.innerWidth < BREAKPOINT;
    if (next !== _mobile) {
      _mobile = next;
      _listeners.forEach(fn => fn(next));
    }
  }, { passive: true });
}

export function useMobile() {
  const [mobile, setMobile] = useState(() => _mobile);
  useEffect(() => {
    _listeners.add(setMobile);
    return () => _listeners.delete(setMobile);
  }, []);
  return mobile;
}

// ─── Theme context ────────────────────────────────────────────────────────────

export function ThemeProvider({ children }) {
  const [mode, setMode] = useState(
    () => localStorage.getItem("pd-theme") || "dark"
  );

  const toggle = () => setMode(m => {
    const next = m === "dark" ? "light" : "dark";
    localStorage.setItem("pd-theme", next);
    return next;
  });

  const theme = { ...makeTheme(mode), mode, toggle };
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
