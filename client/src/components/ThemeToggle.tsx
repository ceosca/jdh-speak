import { useState } from "react";
import { Sun, Moon, Monitor } from "lucide-react";
import { applyTheme, loadTheme, saveTheme, type Theme } from "../lib/theme";
import { m } from "../paraglide/messages.js";

// Cycles Automático → Claro → Oscuro → Automático. "Automático" follows the OS /
// browser light/dark setting; the other two force it. Persisted. Icon-only but
// with a full screen-reader label AND a visible tooltip so a sighted first-timer
// (and a screen-reader user) both know exactly what it is and what it does. The
// button's accessible name updates on each press, so the reader announces the new
// mode as you cycle.
const ORDER: Theme[] = ["system", "light", "dark"];

function themeName(t: Theme): string {
  return t === "system" ? m.theme_system() : t === "light" ? m.theme_light() : m.theme_dark();
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() => loadTheme());

  const cycle = () => {
    const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
    setTheme(next);
    applyTheme(next);
    saveTheme(next);
  };

  const Icon = theme === "system" ? Monitor : theme === "light" ? Sun : Moon;

  return (
    <button
      onClick={cycle}
      className="flex items-center gap-1.5 rounded-lg bg-sonic-700 px-2 py-1 text-sonic-200 transition-colors hover:bg-sonic-600"
      aria-label={m.theme_button_label({ mode: themeName(theme) })}
      title={m.theme_button_title({ mode: themeName(theme) })}
    >
      <Icon aria-hidden="true" className="h-4 w-4" />
      {/* Visible short label so a sighted user reads "Tema: Oscuro", not a bare icon. */}
      <span aria-hidden="true" className="text-xs font-medium">
        {themeName(theme)}
      </span>
    </button>
  );
}
