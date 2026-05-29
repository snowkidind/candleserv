/**
 * Theme selection, persisted in localStorage. Each theme is a real palette
 * defined as CSS variables in index.css (the gray scale) — no color inversion.
 * Applied via <html data-theme="…">. Built to scale past two themes: add a name
 * to THEMES + a `[data-theme="name"]` block in index.css (+ optional chart palette).
 */
const KEY = "candleserv:theme";

export const THEMES = ["dark", "dim", "light"] as const;
export type Theme = (typeof THEMES)[number];

export function getTheme(): Theme {
  const t = localStorage.getItem(KEY);
  return (THEMES as readonly string[]).includes(t ?? "") ? (t as Theme) : "dark";
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
}

export function setTheme(t: Theme): void {
  localStorage.setItem(KEY, t);
  applyTheme(t);
  // Canvas views (the chart) set their own palette and listen for this.
  window.dispatchEvent(new Event("themechange"));
}

/** Next theme in the cycle — drives the header toggle (works for N themes). */
export function nextTheme(t: Theme): Theme {
  return THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
}

/** Apply the stored theme before first paint (called from main.tsx). */
export function initTheme(): void {
  applyTheme(getTheme());
}
