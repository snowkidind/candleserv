import type { Response } from "express";
import type { SseClient } from "../types/index.js";

// Active API consumer SSE connections, keyed by apiKey
const clients = new Map<string, SseClient>();

export function addClient(client: SseClient): void {
  clients.set(client.apiKey, client);
}

export function removeClient(apiKey: string): void {
  clients.delete(apiKey);
}

export function getClient(apiKey: string): SseClient | undefined {
  return clients.get(apiKey);
}

export function getSubscriptionStatus(apiKey: string): {
  active: boolean;
  n?: number;
  currencies?: string[];
  connectedSince?: string;
  lastPushAt?: string | null;
} {
  const c = clients.get(apiKey);
  if (!c) return { active: false };
  return {
    active: true,
    n: c.n,
    currencies: c.currencies,
    connectedSince: c.connectedSince.toISOString(),
    lastPushAt: c.lastPushAt?.toISOString() ?? null,
  };
}

// Push one currency's rolling buffer to the client. The frame is tagged with the
// currency so a multi-currency subscriber demuxes on the wire.
export function pushToClient(apiKey: string, currency: string, candles: unknown[]): void {
  const c = clients.get(apiKey);
  if (!c) return;
  try {
    c.res.write(`event: candles\ndata: ${JSON.stringify({ currency, candles, count: candles.length })}\n\n`);
    c.lastPushAt = new Date();
  } catch {
    removeClient(apiKey);
  }
}

export function getAllClients(): SseClient[] {
  return Array.from(clients.values());
}
