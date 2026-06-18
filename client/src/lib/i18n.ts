// App-wide locale wiring on top of Paraglide's generated runtime.
// The app is Spanish-only (a single `es` locale), so there is no picker and
// no language resolution — Paraglide's m.*() always return Spanish.
import { getLocale, setLocale, isLocale, locales, baseLocale } from "../paraglide/runtime.js";

// Single supported locale, derived from the generated `locales` tuple.
export type Locale = (typeof locales)[number];

// Keep <html lang> correct from the first paint (a11y, hyphenation, SEO).
document.documentElement.lang = "es";

export { getLocale, setLocale, isLocale, locales, baseLocale };
