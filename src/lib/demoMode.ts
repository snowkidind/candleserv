/**
 * Public demo mode.
 *
 * A demo droplet runs its own DB (≤180d) and serves a read-only public page.
 * Demo posture (D4): api-key auth disabled, monitor reads require a same-origin
 * request carrying a server-injected signed page token, read `limit`/`n` clamped
 * to 200, an optional IP rate-limit, and only the Candles tab in the UI.
 *
 * This module is the single source of truth for "are we in demo" + the page
 * token + which paths the public may read. demoGate / demoRateLimit / app.ts /
 * the monitor read handlers all consume it.
 */
import crypto from "crypto";
import type { Request } from "express";
import { getSettingBool } from "../db/appSettings.js";
import { logError } from "./log.js";

// Max rows a demo read may return.
export const DEMO_READ_CAP = 200;

// Page-token lifetime. Re-minted on every index.html serve (so a normal browsing
// session always has a fresh one), with this ceiling so a scraped token can't be
// replayed indefinitely. The token is a soft anti-abuse layer over public data —
// rate-limit + same-origin + 200-row cap are the other layers — so a session-
// length ceiling is the right trade, not a tight 30s.
const TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6h

/**
 * Demo is a full READ-ONLY mirror of the admin view: every GET under /monitor is
 * public-readable EXCEPT these secret-bearing reads, which stay denied (greying a
 * control doesn't help if the secret is on screen). All mutations (non-GET) and
 * all /v1 are denied wholesale in demoGate.
 *
 * ⚠ POLARITY: this is a DENY-list, so /monitor GETs are PUBLIC BY DEFAULT in
 * demo. Any NEW GET route added under /monitor is exposed to the public the
 * moment it ships. If a new route returns anything secret/sensitive (credentials,
 * PII, operator identity, internal addresses), you MUST add its path here — or
 * redact at the handler gated on `req.demoRead`. Default-open is intentional
 * (feed-health IS the product) but it puts the burden on the route author.
 */
const DEMO_READ_DENY = new Set<string>([
  "/monitor/config",         // redisUrl + any secret-flagged settings
  "/monitor/admin/keys",     // API key material
  "/monitor/admin/actions",  // audit log — operator emails + api-key IDs in target/detail
]);

/**
 * Resolve demo mode. The env var IS_DEMO wins (deploy-level override:
 * `true`/`false`); otherwise the app_settings IS_DEMO key (default false). Both
 * the env check and getSettingBool's 1h cache make this cheap on the hot path.
 */
export async function isDemoMode(): Promise<boolean> {
  if (process.env.IS_DEMO === "true") return true;
  if (process.env.IS_DEMO === "false") return false;
  return getSettingBool("IS_DEMO", false);
}

/** Clamp a read limit: demo caps at DEMO_READ_CAP, otherwise the normal cap. */
export async function readCap(normalCap: number): Promise<number> {
  return (await isDemoMode()) ? Math.min(normalCap, DEMO_READ_CAP) : normalCap;
}

/** A demo-allowed read: any /monitor GET that isn't a secret-bearing path. */
export function isDemoReadPath(req: Request): boolean {
  return req.method === "GET"
    && req.path.startsWith("/monitor/")
    && !DEMO_READ_DENY.has(req.path);
}

function tokenSecret(): string {
  const s = process.env.DEMO_TOKEN_SECRET;
  // Fail loud — a missing secret in demo means we'd silently sign with nothing.
  if (!s) throw new Error("[demoMode] DEMO_TOKEN_SECRET is required to sign demo page tokens");
  return s;
}

/**
 * base64( expiryMs + '.' + hmacSHA256(expiryMs, DEMO_TOKEN_SECRET) ) — D4 / 10.3.
 * Injected into index.html as window.__DEMO__.token on each serve.
 */
export function mintDemoToken(): string {
  const expiry = Date.now() + TOKEN_TTL_MS;
  const sig = crypto.createHmac("sha256", tokenSecret()).update(String(expiry)).digest("hex");
  return Buffer.from(`${expiry}.${sig}`).toString("base64");
}

/** Verify HMAC + non-expiry. Constant-time signature compare. */
export function verifyDemoToken(token: string | undefined): boolean {
  if (!token) return false;
  try {
    const decoded = Buffer.from(token, "base64").toString("utf8");
    const dot = decoded.indexOf(".");
    if (dot < 0) return false;
    const expiryStr = decoded.slice(0, dot);
    const sig = decoded.slice(dot + 1);
    const expiry = parseInt(expiryStr, 10);
    if (isNaN(expiry) || expiry < Date.now()) return false;
    const expected = crypto.createHmac("sha256", tokenSecret()).update(expiryStr).digest("hex");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Per-token request budget (the "enough is enough" backstop). A copied/harvested
// token can do at most this many demo reads before it's spent — forcing a fresh
// page fetch (itself IP-rate-limited) to continue. Generous enough that a human
// browsing never notices. A const, not an app_setting: it's a fixed abuse
// ceiling, not a per-deploy tuning knob (promote to a setting only if a real
// reason emerges).
const DEMO_TOKEN_BUDGET = 1000;
const TOKEN_SWEEP_INTERVAL_MS = 5 * 60_000;
// Hard ceiling on distinct tracked tokens, so a flood of unique tokens can't grow
// the map without bound and OOM the process. ~50k entries ≈ low tens of MB worst
// case; a real demo has at most thousands of concurrent tokens, so this is pure
// headroom. A genuine volumetric flood (millions of tokens) is an edge/CDN
// problem — see DEMO_TOKEN_SECRET notes — not something an in-process Map should
// try to absorb; this cap just makes it degrade loudly instead of crashing.
const MAX_TRACKED_TOKENS = 50_000;

// token → { requests so far, when the token expires (for the sweep) }. In-process,
// ephemeral, single-droplet — mirrors demoRateLimit's storage model.
const tokenHits = new Map<string, { count: number; expiresAt: number }>();
let lastTokenSweep = 0;

function pruneExpiredTokens(now: number): void {
  for (const [tok, rec] of tokenHits) {
    if (rec.expiresAt <= now) tokenHits.delete(tok);
  }
}

function sweepTokens(now: number): void {
  if (now - lastTokenSweep < TOKEN_SWEEP_INTERVAL_MS) return;
  lastTokenSweep = now;
  pruneExpiredTokens(now);
}

/**
 * Charge one request against a token's budget. Call ONLY after the token has
 * been verified (the expiry is trusted here). Returns ok=false once the budget
 * is exceeded OR the tracking map is at capacity; the caller 429s. The map entry
 * is reaped at the token's expiry. `capacity` flags the over-capacity case (a
 * distinct-token flood) so the caller/log can distinguish it from a real
 * budget burn.
 */
export function chargeDemoToken(token: string): { ok: boolean; count: number; capacity?: boolean } {
  const now = Date.now();
  sweepTokens(now);
  let rec = tokenHits.get(token);
  if (!rec) {
    // New token: enforce the size cap before allocating. Force a prune first in
    // case the throttled sweep hasn't run; if still full, refuse to track more.
    if (tokenHits.size >= MAX_TRACKED_TOKENS) {
      pruneExpiredTokens(now);
      if (tokenHits.size >= MAX_TRACKED_TOKENS) {
        logError(
          `[demoMode] token-budget map at capacity (${MAX_TRACKED_TOKENS}) — rejecting new tokens. ` +
          `This indicates a distinct-token flood; put an edge rate-limit (nginx/CDN) in front of the demo.`,
        );
        return { ok: false, count: 0, capacity: true };
      }
    }
    // expiry is the cleartext payload (already validated upstream).
    let expiresAt = now;
    try {
      const decoded = Buffer.from(token, "base64").toString("utf8");
      const exp = parseInt(decoded.slice(0, decoded.indexOf(".")), 10);
      if (!isNaN(exp)) expiresAt = exp;
    } catch { /* keep now — defensive only */ }
    rec = { count: 0, expiresAt };
    tokenHits.set(token, rec);
  }
  rec.count += 1;
  return { ok: rec.count <= DEMO_TOKEN_BUDGET, count: rec.count };
}

/** Current count of tracked page tokens (for ops visibility — see cli/ctl.ts). */
export function tokenBudgetMapSize(): number {
  return tokenHits.size;
}

/** Pull the page token from the X-Demo-Token header or ?demoToken= (SSE can't set headers). */
export function demoTokenFromReq(req: Request): string | undefined {
  const header = req.headers["x-demo-token"];
  if (typeof header === "string" && header) return header;
  const q = req.query.demoToken;
  if (typeof q === "string" && q) return q;
  return undefined;
}

/**
 * Same-origin check: the page making the read must have been loaded from the
 * same host that's serving the API (its Origin/Referer host == our Host). A
 * curl with no Origin/Referer fails. Config-free — no demo-host knob to drift.
 */
export function isSameOrigin(req: Request): boolean {
  const host = req.headers.host;
  if (!host) return false;
  const ref = (req.headers.origin as string) || (req.headers.referer as string);
  if (!ref) return false;
  try {
    return new URL(ref).host === host;
  } catch {
    return false;
  }
}
