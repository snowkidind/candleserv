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
export interface Candle {
  timestamp: number;
  open: number; high: number; low: number; close: number;
  volume: number; volumeNormalized: number;
  sourceCount: number; sourceCountBaseline: number;
  sources: number; confidence: number;
}
export const getLatestCandles = (tf: string, n: number) =>
  req<{ candles: Candle[] }>(`/monitor/candles/latest?tf=${tf}&n=${n}`);

export const getCandlesBefore = (tf: string, endingAtMs: number, limit: number) =>
  req<{ candles: Candle[] }>(
    `/monitor/candles?tf=${tf}&endingAt=${new Date(endingAtMs).toISOString()}&limit=${limit}`
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
export interface SourceStatus {
  paused: boolean;
  failures24h: number;
  state: string;
}
export const getSourcesStatus = () =>
  req<{ sources: Record<string, SourceStatus> }>("/monitor/sources/status");

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

// Resume source
export const resumeSource = (source: string) =>
  req(`/monitor/sources/${source}/resume`, { method: "POST" });

// Session keepalive
export const ping = () => req<{ ok: boolean }>("/monitor/ping");

// Service events
export interface ServiceEvent {
  id: number; type: string;
  startedAt: string; endedAt: string;
  durationMinutes: number; notes: string | null;
  createdAt: string;
}
export const getServiceEvents = () =>
  req<{ events: ServiceEvent[] }>("/monitor/service-events");
