import { createContext, useContext, useState, useEffect } from "react";
import { makeTheme } from "./config";

const ThemeContext = createContext(null);

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

export function useMobile(breakpoint = 640) {
  const [mobile, setMobile] = useState(() => window.innerWidth < breakpoint);
  useEffect(() => {
    const fn = () => setMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", fn, { passive: true });
    return () => window.removeEventListener("resize", fn);
  }, [breakpoint]);
  return mobile;
}
