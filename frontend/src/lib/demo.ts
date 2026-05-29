/**
 * Public demo mode (Phase 10) — client side.
 *
 * The server injects `window.__DEMO__ = { isDemo, token }` into index.html only
 * when running in demo mode (src/app.ts serveDemoIndex). The token is a
 * same-origin signed page token; the client echoes it on every demo read
 * (X-Demo-Token header for fetch, ?demoToken= for the SSE EventSource, which
 * can't set headers). Absent the global, we're a normal authenticated install.
 */
interface DemoGlobal {
  isDemo: boolean;
  token: string;
}

declare global {
  interface Window {
    __DEMO__?: DemoGlobal;
  }
}

export function isDemo(): boolean {
  return !!window.__DEMO__?.isDemo;
}

export function demoToken(): string | undefined {
  return window.__DEMO__?.token;
}
