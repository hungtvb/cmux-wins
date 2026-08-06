/**
 * Theme management: SF (Apple HIG-inspired) light/dark with lime accent.
 *
 * - `data-theme` is set on <html> before first paint by an inline script in
 *   index.html (avoids flash of unstyled content).
 * - Persisted choice wins; otherwise follows `prefers-color-scheme`.
 * - Switching themes dispatches a `tm:themechange` CustomEvent so live
 *   components (xterm terminals) can update their palette without remounting.
 */

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "tm-theme";
export const THEME_CHANGE_EVENT = "tm:themechange";

export function getInitialTheme(): Theme {
  if (typeof document === "undefined") return "dark";
  const stored = document.documentElement.dataset.theme;
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function getCurrentTheme(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

export function setTheme(theme: Theme): void {
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // storage may be unavailable in hardened WebView2 contexts; theme still applies.
  }
  window.dispatchEvent(new CustomEvent<Theme>(THEME_CHANGE_EVENT, { detail: theme }));
}

export function toggleTheme(): Theme {
  const next: Theme = getCurrentTheme() === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

/** xterm.js palette that follows the app theme (GitHub-ish dark/light). */
export function getXtermTheme(theme: Theme): Record<string, string> {
  if (theme === "light") {
    return {
      background: "#ffffff",
      foreground: "#1d1d1f",
      cursor: "#7fae00",
      cursorAccent: "#ffffff",
      selectionBackground: "rgba(127, 174, 0, 0.28)",
      black: "#1d1d1f",
      brightBlack: "#86868b",
      red: "#cf222e",
      brightRed: "#a40e26",
      green: "#1f883d",
      brightGreen: "#2da44e",
      yellow: "#9a6700",
      brightYellow: "#bf8700",
      blue: "#0969da",
      brightBlue: "#218bff",
      magenta: "#8250df",
      brightMagenta: "#bf3989",
      cyan: "#1b7c83",
      brightCyan: "#3192a0",
      white: "#eaeef2",
      brightWhite: "#f6f8fa",
    };
  }
  return {
    background: "#1a1a1c",
    foreground: "#d1d1d6",
    cursor: "#d4ff40",
    cursorAccent: "#10100f",
    selectionBackground: "#3a4216",
    black: "#10100f",
    brightBlack: "#73736e",
    red: "#ff9aa8",
    brightRed: "#ffc2cb",
    green: "#86d9a5",
    brightGreen: "#a9e8be",
    yellow: "#f1bd72",
    brightYellow: "#f8d59b",
    blue: "#7aa7ff",
    brightBlue: "#a7c4ff",
    magenta: "#c5a8ff",
    brightMagenta: "#dccaff",
    cyan: "#78d4d4",
    brightCyan: "#a4e6e6",
    white: "#d4d4d0",
    brightWhite: "#f5f5f4",
  };
}
