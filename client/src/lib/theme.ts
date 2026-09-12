// Light / dark theme wiring. Three states:
//   "system" — follow the OS/browser (prefers-color-scheme). The default, so the
//              platform adapts automatically to the phone/PC mode with no action.
//   "light" / "dark" — the user's explicit override (persisted).
// The actual colors live in index.css (the inverted `sonic` ramp); here we only
// stamp `data-theme` on <html> so that CSS picks the right palette.
export type Theme = "system" | "light" | "dark";

const KEY = "jdh-speak:theme";

export function loadTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* localStorage blocked (private mode) — fall back to system */
  }
  return "system";
}

// "system" removes the attribute so the CSS media query decides; an explicit
// choice stamps data-theme to override it.
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

export function saveTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* ignore — the choice just won't persist */
  }
}

// Apply the stored choice immediately on import, before React mounts, so the
// first paint is already in the right theme (no flash). main.tsx imports this
// for the side effect, ahead of rendering.
applyTheme(loadTheme());
