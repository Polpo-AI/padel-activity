import { createContext, useContext, useState } from "react";
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
