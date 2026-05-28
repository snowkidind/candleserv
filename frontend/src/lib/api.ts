const BASE = "";

async function req<T>(path: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  if (res.status === 401 && !path.includes("/login")) {
    window.location.href = "/login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// Auth
export const login = (email: string, password: string) =>
  req("/monitor/login", { method: "POST", body: JSON.stringify({ email, password }) });

export const logout = () =>
  req("/monitor/logout", { method: "POST" });

// Health
export interface HealthData {
  status: string;
  uptime: number;
  latestCandle: string | null;
  gapsPending: number;
  activeSubscriptions: number;
  collectionLatency: { avgMs: number; minMs: number; maxMs: number; sampleSize: number };
}
export const getHealth = () => req<HealthData>("/health");

// Candles
// `volume` carries the normalized value (Phase 2.5 plan).
export interface Candle {
  timestamp: number;
  open: number; high: number; low: number; close: number;
  volume: number;
  sourceCount: number; sourceCountBaseline: number;
  sources: number; confidence: number;
}
export const getLatestCandles = (tf: string, n: number, currency = "BTC") =>
  req<{ candles: Candle[] }>(`/monitor/candles/latest?tf=${tf}&n=${n}&currency=${currency}`);

export const getCandlesBefore = (tf: string, endingAtMs: number, limit: number, currency = "BTC") =>
  req<{ candles: Candle[] }>(
    `/monitor/candles?tf=${tf}&endingAt=${new Date(endingAtMs).toISOString()}&limit=${limit}&currency=${currency}`
  );

// Stats
export interface StatsData {
  totalRows: number;
  oldestCandle: string | null;
  newestCandle: string | null;
  sourceCountDistribution: Record<string, number>;
  collectionLatency: { avgMs: number; minMs: number; maxMs: number; sampleSize: number };
}
export const getStats = () => req<StatsData>("/monitor/stats");

// Sources
// Shape matches the server's getSourceStatus() — both legacy `paused` (alias
// for `excluded`) and the new formula-aware fields are present during the
// Phase 6 transition window.
export interface SourceStatus {
  // Live fetch metadata — null when excluded.
  fetching: boolean;
  failures24h: number;
  lastFetch: string | null;
  state: string;            // legacy fine-grained "on" | "error" | "unknown"
  paused: boolean;          // legacy alias for `excluded`

  // Formula state.
  excluded: boolean;
  excludedReason: "manual" | "auto-suspend" | null;
  excludedBy: string | null;
  excludedAt: string | null;
  reason: string | null;
  lastKnownAtExclusion: {
    failures24h: number | null;
    outlierRate24h: number | null;
    usedRate24h: number | null;
  } | null;
}
export const getSourcesStatus = () =>
  req<{ sources: Record<string, SourceStatus> }>("/monitor/sources/status");

// Formula
export interface Formula { excludedSources: string[] }
export interface FormulaChange {
  at: string;
  by: string;
  exchange: string;
  setOrUnset: "set" | "unset";
  reason: string | null;
}
export interface FormulaWithMeta {
  excludedSources: string[];
  lastChange: FormulaChange | null;
}
export const getFormula = () => req<FormulaWithMeta>("/monitor/formula");
export const setFormula = (formula: Formula) =>
  req<FormulaWithMeta>("/monitor/formula", {
    method: "PUT",
    body: JSON.stringify(formula),
  });

// Per-source history (180d daily bins for the history modal)
export interface SourceHistoryBin {
  day: string;            // ISO start-of-day UTC
  used: number;
  outlierRejected: number;
  formulaExcluded: number;
  missing: number;
}
export interface SourceHistorySummary {
  totalRows: number;
  used: number;
  outlierRejected: number;
  formulaExcluded: number;
  missing: number;
}
export interface SourceHistory {
  source: string;
  days: number;
  bins: SourceHistoryBin[];
  lifetime: SourceHistorySummary;
  last30d: SourceHistorySummary;
}
export const getSourceHistory = (source: string, days = 180) =>
  req<SourceHistory>(`/monitor/sources/${source}/history?days=${days}`);

// Repair operations
export interface RepairRequest {
  currency?: string;     // default BTC server-side
  from: string;          // ISO
  to: string;            // ISO
  sources?: string[];
  formula?: Formula;
  retryEmpty?: boolean;
}
export interface RepairPreview {
  compositeRowsInWindow: number;
  willBeRecomposed: number;
  archiveHoles: number;
  missingBySource: Record<string, number>;
  sentinelsToRetry: number;
  estimatedWallMs: number;
  liveFormulaUnchanged: boolean;
}
export interface RepairJobState {
  jobId: string;
  state: "queued" | "ensuring" | "backfilling" | "recomposing" | "done" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string | null;
  currency: string;
  from: string;
  to: string;
  sources?: string[];
  formula?: Formula;
  retryEmpty?: boolean;
  ensure: {
    rowsFetched: number;
    sentinelsWritten: number;
    skipped: number;
    failedPerSource: Record<string, number>;
  } | null;
  backfill: {
    rowsInserted: number;
    rowsSkippedNoBtc: number;
    failedPerSource: Record<string, number>;
  } | null;
  recompose: { recomposed: number; skippedNoSources: number; failed: number } | null;
  result?: { rowsWritten: number; archiveRowsFetched: number };
  error?: string;
}
export const previewRepair = (rq: RepairRequest) =>
  req<{ preview: RepairPreview }>("/monitor/repair?dry=true", {
    method: "POST",
    body: JSON.stringify(rq),
  });
export const runRepair = (rq: RepairRequest) =>
  req<{ jobId: string }>("/monitor/repair?dry=false", {
    method: "POST",
    body: JSON.stringify(rq),
  });
export const getRepairJob = (jobId: string) =>
  req<RepairJobState>(`/monitor/repair/jobs/${jobId}`);
export const getActiveRepairJob = () =>
  req<RepairJobState | null>("/monitor/repair/current");

// Healer activity (boot backfill, gap scan, low-confidence reheal).
export interface HealerActivity {
  name: string;
  startedAt: string;
  meta?: Record<string, unknown>;
}
export const getHealerStatus = () =>
  req<{ activities: HealerActivity[] }>("/monitor/healer/status");
export const cancelRepairJob = (jobId: string) =>
  req<{ ok: boolean }>(`/monitor/repair/jobs/${jobId}/cancel`, { method: "POST" });

// Gaps
export interface Gap {
  id: number; timestamp: string; durationMinutes: number;
  state: string; alertSent: boolean;
  detectedAt: string; healedAt: string | null;
}
export const getGaps = () => req<{ gaps: Gap[] }>("/monitor/gaps");
export const triggerHeal = () =>
  req("/monitor/heal", { method: "POST" });

// Stream events
export interface StreamEvent {
  id: number; source: string; state: string; createdAt: string;
}
export const getStreamEvents = (minutes: number, source?: string) =>
  req<{ events: StreamEvent[] }>(
    `/monitor/stream-events?minutes=${minutes}${source ? `&source=${source}` : ""}`
  );

// Errors
export interface ServiceError {
  id: number; service: string; location: string;
  message: string; stack: string | null; createdAt: string;
}
export const getErrors = (minutes: number, service?: string) =>
  req<{ errors: ServiceError[] }>(
    `/monitor/errors?minutes=${minutes}${service ? `&service=${service}` : ""}`
  );

// Config
export const getConfig = () => req<{ settings: Record<string, string> }>("/monitor/config");
export const saveConfig = (settings: Record<string, string>) =>
  req("/monitor/config", { method: "POST", body: JSON.stringify(settings) });

// API Keys
export interface ApiKey {
  id: number; label: string; apiKey: string;
  enabled: boolean; lastSeen: string | null; createdAt: string;
  // 'repair' when stored nonce > now and the key is wedged into permanent
  // 401-replay; 'ok' otherwise.
  nonceStatus: "ok" | "repair";
}
export const getApiKeys = () => req<{ keys: ApiKey[] }>("/monitor/admin/keys");
export const createApiKey = (label: string) =>
  req<{ apiKey: string; secret: string }>("/monitor/admin/keys", {
    method: "POST", body: JSON.stringify({ label }),
  });
export const revokeApiKey = (apiKey: string) =>
  req(`/monitor/admin/keys/${apiKey}`, { method: "DELETE" });
export const toggleApiKey = (apiKey: string, enabled: boolean) =>
  req(`/monitor/admin/keys/${apiKey}`, {
    method: "PATCH", body: JSON.stringify({ enabled }),
  });
export const repairApiKeyNonce = (apiKey: string) =>
  req(`/monitor/admin/keys/${apiKey}/repair-nonce`, { method: "POST" });

// Resume source
export const resumeSource = (source: string) =>
  req(`/monitor/sources/${source}/resume`, { method: "POST" });

// Session keepalive
export const ping = () => req<{ ok: boolean }>("/monitor/ping");

// Admin audit log — append-only history of operator/system mutations.
export interface AdminActionRow {
  id: number;
  actor: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
  createdAt: string;
}
export const getAdminActions = (limit = 200, action?: string, targetPrefix?: string) =>
  req<{ actions: AdminActionRow[] }>(
    `/monitor/admin/actions?limit=${limit}` +
    `${action ? `&action=${encodeURIComponent(action)}` : ""}` +
    `${targetPrefix ? `&targetPrefix=${encodeURIComponent(targetPrefix)}` : ""}`,
  );

// Per-venue rate-gate intervals (ms). overrideMs from app_settings rateLimit.<venue>;
// defaultMs is the built-in const fallback. Saved via saveConfig (rateLimit.<venue>).
export interface RateLimit {
  source: string;
  defaultMs: number;
  overrideMs: number | null;
}
export const getRateLimits = () => req<{ rateLimits: RateLimit[] }>("/monitor/rate-limits");

// Current user — permission map + demo flag, for tab gating (B5).
export interface Me {
  perms: Record<string, boolean>;
  isDemo: boolean;
}
export const getMe = () => req<Me>("/monitor/me");

// Currencies / Feeds control plane (Phase 9.3 API).
export interface CurrencyFeed {
  symbol: string;
  available: boolean;
  enabled: boolean;
}
export interface CurrencyInfo {
  code: string;
  displayName: string;
  enabled: boolean;
  premiumEnabled: boolean;
  minSources: number | null;
  inceptionTs: string | null;
  createdAt: string;
  updatedAt: string;
  feeds: Record<string, CurrencyFeed>;
  // Per-currency backfill latch (app_settings backfillComplete:<code>).
  backfill: { complete: boolean; updatedAt: string | null };
}
export const getCurrencies = () =>
  req<{ currencies: CurrencyInfo[] }>("/monitor/currencies");

export interface CurrencyPatch {
  enabled?: boolean;
  premiumEnabled?: boolean;
  minSources?: number | null;
  inceptionTs?: string | null;
}
export const updateCurrency = (code: string, patch: CurrencyPatch) =>
  req<{ ok: boolean; currency: CurrencyInfo; backfill?: "started" | "deferred" }>(
    `/monitor/currencies/${code}`,
    { method: "PUT", body: JSON.stringify(patch) },
  );

export const setCurrencyFeed = (code: string, source: string, enabled: boolean) =>
  req<{ ok: boolean; feeds: Record<string, CurrencyFeed> }>(
    `/monitor/currencies/${code}/feeds`,
    { method: "PUT", body: JSON.stringify({ source, enabled }) },
  );

export const probeCurrency = (code: string) =>
  req<{ ok: boolean; code: string; probedAt: string; results: { source: string; available: boolean; error?: string }[] }>(
    `/monitor/currencies/${code}/probe`,
    { method: "POST" },
  );

// Service events
export interface ServiceEvent {
  id: number; type: string;
  startedAt: string; endedAt: string;
  durationMinutes: number; notes: string | null;
  createdAt: string;
}
export const getServiceEvents = () =>
  req<{ events: ServiceEvent[] }>("/monitor/service-events");
