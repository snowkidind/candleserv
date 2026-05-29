/**
 * Light/dark theme toggle, persisted in localStorage (per-browser, no backend).
 *
 * The UI is built entirely in hardcoded-dark Tailwind utility classes, so rather
 * than retheme every component we flip a single `light` class on <html> and let
 * CSS invert the page (see index.css). The chart canvas + media are counter-
 * inverted there so candle colors stay true.
 */
const KEY = "candleserv:theme";
export type Theme = "dark" | "light";

export function getTheme(): Theme {
  return localStorage.getItem(KEY) === "light" ? "light" : "dark";
}

export function applyTheme(t: Theme): void {
  document.documentElement.classList.toggle("light", t === "light");
}

export function setTheme(t: Theme): void {
  localStorage.setItem(KEY, t);
  applyTheme(t);
}

/** Apply the stored theme before first paint (called from main.tsx). */
export function initTheme(): void {
  applyTheme(getTheme());
}
