import type { Request } from "express";

export interface CandleRow {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  volumeNormalized: number;
  sourceCount: number;
  sourceCountBaseline: number;
  sources: number;
  confidence: number;
  createdAt: Date;
  updatedAt: Date;
}

// Public candle JSON surface. `volume` carries the NORMALIZED value (raw ×
// baseline/sourceCount). The two-column distinction lives only in the DB
// schema and CandleRow; consumers see one `volume` field. See plan
// candleserv-exchange-expansion §Phase 2.5.
export interface CandleJson {
  timestamp: number;   // Unix ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  sourceCount: number;
  sourceCountBaseline: number;
  sources: number;
  confidence: number;
}

export interface SourceCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SourceResult {
  source: string;
  candle: SourceCandle | null;
  error?: string;
  durationMs?: number;
}

export interface ApiKeyRow {
  id: number;
  label: string;
  apiKey: string;
  secret: string;
  nonce: bigint;
  enabled: boolean;
  lastSeen: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface GapRow {
  id: number;
  timestamp: Date;
  durationMinutes: number;
  state: string;
  sourcesAvailable: number;
  alertSent: boolean;
  detectedAt: Date;
  healedAt: Date | null;
  updatedAt: Date;
}

export interface AppSettingRow {
  key: string;
  value: string;
  updatedAt: Date;
}

export interface SseClient {
  apiKeyId: number;
  apiKey: string;
  n: number;
  currency: string;
  res: import("express").Response;
  connectedSince: Date;
  lastPushAt: Date | null;
}

// Express request augmentation
declare global {
  namespace Express {
    interface Request {
      sessionId?: string;
      userId?: number;
      apiKeyId?: number;
      apiKey?: string;
      isAuthenticated?: boolean;
      perms?: Record<string, boolean>;
      // Set by demoGate when a public demo read passed the token+origin check.
      // sessionAuth.authenticate honors it as view-only access (no session).
      demoRead?: boolean;
    }
  }
}
