import { useState } from "react";

/**
 * API tab — static, read-only reference for the consumer-facing /v1 API plus
 * /health. Mirrors docs/api/ (the Postman collection). No live calls: the
 * monitor is session-authed while /v1 is nonce-signed api-key authed, and key
 * secrets aren't stored after issue — so this documents the surface rather than
 * exercising it. Key management lives in the Admin tab.
 *
 * The Postman collection is served by the backend at /api-docs (express static
 * mount over docs/api), so the download links point at the canonical files —
 * no duplicated copy in the frontend bundle.
 */

const POSTMAN_COLLECTION = "/api-docs/candleserv.postman_collection.json";
const POSTMAN_ENVIRONMENT = "/api-docs/candleserv.postman_environment.json";

interface Param {
  name: string;
  required?: boolean;
  def?: string;
  desc: string;
}

interface Endpoint {
  method: "GET" | "POST";
  path: string;
  auth: boolean;
  badge?: string;
  summary: string;
  params?: Param[];
  body?: string;
  sample: string;
  notes?: string[];
}

interface Section {
  name: string;
  blurb: string;
  endpoints: Endpoint[];
}

const TIMEFRAMES = "1m, 5m, 10m, 15m, 30m, 1h, 2h, 4h, 6h, 12h, 1d, 3d, 7d, 30d";

const SOURCE_BITS: [string, number][] = [
  ["binance", 1], ["bybit", 2], ["kraken", 4], ["coinbase", 8],
  ["bitfinex", 16], ["okx", 32], ["gate", 64], ["bitget", 128],
];

const CANDLE_SHAPE = `{
  "timestamp": 1748649600000,   // bar open, unix ms
  "open": 77012.3, "high": 77140.0,
  "low": 76980.1, "close": 77098.7,
  "volume": 123.45,             // normalized (raw × baseline/sourceCount)
  "sourceCount": 7,
  "sourceCountBaseline": 7,
  "sources": 223,               // bitmask OR of contributing venues
  "confidence": 1.0             // [0,1] = sourceRatio × (1 − rejectedRatio)
}`;

const PREMIUM_BAR_SHAPE = `{
  "t": 1748649600000,  // bucket open, unix ms
  "o": 122.39,         // open-field offset, first minute (signed USD)
  "h": 167.48,         // widest the basis got in the bucket
  "l": 57.07,          // narrowest
  "c": 137.48,         // close-field offset, last minute
  "n": 60              // contributing minutes
}`;

const SECTIONS: Section[] = [
  {
    name: "Health",
    blurb: "Unauthenticated liveness + freshness probe.",
    endpoints: [
      {
        method: "GET",
        path: "/health",
        auth: false,
        summary: "Service liveness, latest-candle freshness, collection latency, and recent venue outages.",
        sample: `{
  "status": "ok",
  "uptime": 84213,
  "latestCandle": "2026-05-31T18:33:00.000Z",
  "gapsPending": 0,
  "activeSubscriptions": 2,
  "collectionLatency": { "avgMs": 5120, "minMs": 3000, "maxMs": 8800, "sampleSize": 60 },
  "recentOutages": []
}`,
      },
    ],
  },
  {
    name: "Candles",
    blurb: "Composite OHLCV reads. Higher timeframes are aggregated from 1m on the fly.",
    endpoints: [
      {
        method: "GET",
        path: "/v1/candles/latest",
        auth: true,
        summary: "The most recent n candles for a timeframe, ending now (oldest-first). Redis-cached with a boundary-aware TTL.",
        params: [
          { name: "tf", required: true, desc: "Timeframe. One of: " + TIMEFRAMES },
          { name: "n", def: "1", desc: "Number of candles, oldest-first. Max 5000." },
          { name: "currency", def: "BTC", desc: "Asset code. Pre-multi-currency consumers may omit it." },
        ],
        sample: `{ "candles": [ /* …candle objects… */ ] }`,
      },
      {
        method: "GET",
        path: "/v1/candles",
        auth: true,
        summary: "A window of limit candles ending at endingAt (oldest-first).",
        params: [
          { name: "tf", required: true, desc: "Timeframe (see above)." },
          { name: "endingAt", required: true, desc: "ISO-8601 instant the window ends at/just before." },
          { name: "limit", def: "100", desc: "Max 5000." },
          { name: "currency", def: "BTC", desc: "Asset code." },
          { name: "waitForFresh", def: "false", desc: "Long-poll: hold until the bar closing at endingAt is ingested. endingAt must align to the tf boundary. Supported: 1m,5m,15m,30m,1h,4h,6h,1d,7d." },
          { name: "maxWaitMs", def: "15000", desc: "Only with waitForFresh. Max 60000." },
        ],
        sample: `{ "candles": [ /* …candle objects… */ ] }`,
        notes: [
          "waitForFresh returns 504 (with lastAvailableTs) on timeout, 503 if a repair job is in flight.",
        ],
      },
      {
        method: "POST",
        path: "/v1/candles/multi",
        auth: true,
        summary: "Batched multi-timeframe read in a single auth/nonce pair. All-or-nothing: any invalid or failing entry fails the whole batch with its index.",
        body: `{
  "requests": [
    { "tf": "1h", "endingAt": "2026-05-31T00:00:00.000Z", "limit": 24 },
    { "tf": "1d", "endingAt": "2026-05-31T00:00:00.000Z", "limit": 30, "currency": "BTC" }
  ]
}`,
        sample: `{ "results": [ { "tf": "1h", "currency": "BTC", "endingAt": "…", "candles": [ … ] }, … ] }`,
        notes: [
          "Max 16 entries; each limit a positive integer capped at 5000. waitForFresh not supported here.",
          "Semantically a read — allowed on read-only replicas, blocked (503) during repair.",
        ],
      },
      {
        method: "GET",
        path: "/v1/candles/subscriptions",
        auth: true,
        summary: "Whether the calling API key currently has an active SSE stream open, plus its parameters.",
        sample: `{ "active": false }`,
      },
      {
        method: "GET",
        path: "/v1/candles/stream",
        auth: true,
        badge: "SSE",
        summary: "Server-Sent Events, 1m only. On connect pushes the last n candles per subscribed currency; thereafter pushes the rolling last n whenever a new 1m composite is ingested. One connection may subscribe to multiple currencies; each frame is tagged with its currency.",
        params: [
          { name: "n", def: "1", desc: "Rolling buffer size pushed per event. Clamped 1–200." },
          { name: "currency", def: "BTC", desc: "Comma-separated list (e.g. BTC,ETH,SOL). An event for an unsubscribed currency never wakes this stream." },
        ],
        sample: `event: candles
data: { "currency": "BTC", "candles": [ … ], "count": 5 }`,
        notes: [
          "Dropped briefly at the start of a repair job — reconnect on disconnect.",
        ],
      },
    ],
  },
  {
    name: "Premium",
    blurb: "Per-venue cross-exchange premium-offset (basis) history — the signed-USD leave-one-out deviation from cross-venue consensus the composite engine computes internally and discards. Bitfinex is the headline venue.",
    endpoints: [
      {
        method: "GET",
        path: "/v1/premium",
        auth: true,
        badge: "new",
        summary: "Per-venue OHLC-of-offset bars (signed USD). o/c are the open/close-field offset at the bucket's first/last minute; h/l are the widest/narrowest the basis got intraday (wick encloses body); n = contributing minutes. Offsets exist only for minutes with ≥3 accepted venues.",
        params: [
          { name: "currency", def: "BTC", desc: "Asset code." },
          { name: "tf", def: "1m", desc: "All standard timeframes except 30d." },
          { name: "endingAt", def: "now", desc: "ISO-8601 instant the window ends at." },
          { name: "limit", def: "200", desc: "Bars per venue. Capped at 5000 and by a ~93-day raw-minute budget (tf=1d reaches ~90d; tf=1m is bar-capped to ~3.5d/call)." },
          { name: "venue", def: "all", desc: "Restrict to one of: binance, bybit, kraken, coinbase, bitfinex, okx, gate, bitget." },
        ],
        sample: `{
  "currency": "BTC", "tf": "1h", "unit": "usd",
  "venues": {
    "bitfinex": [ { "t": 1748649600000, "o": 122.39, "h": 167.48, "l": 57.07, "c": 137.48, "n": 60 } ],
    "bybit":    [ … ]
  }
}`,
        notes: [
          "Rate-limited: per-key sliding 60s window, threshold = rateLimitPerMinute (default 120). 429 + Retry-After: 60 on breach.",
          "Returns 503 while a recompose/repair job runs.",
        ],
      },
      {
        method: "GET",
        path: "/v1/premium/venues",
        auth: true,
        summary: "Which venues have derivable premium history, whether each is peg-corrected (USDT) or USD-native, and the coverage window of its archived source data.",
        params: [
          { name: "currency", def: "BTC", desc: "Asset code." },
        ],
        sample: `{
  "currency": "BTC",
  "venues": [
    { "name": "bitfinex", "usdNative": true, "hasData": true, "oldest": 1745020800000, "newest": 1748649600000, "count": 50331 }
  ]
}`,
      },
    ],
  },
];

function MethodBadge({ method }: { method: "GET" | "POST" }) {
  const cls = method === "GET" ? "bg-green-500/15 text-green-400" : "bg-blue-500/15 text-blue-400";
  return <span className={`text-sm font-mono font-semibold px-1.5 py-0.5 rounded ${cls}`}>{method}</span>;
}

function Code({ children }: { children: string }) {
  return (
    <pre className="bg-gray-950 border border-gray-800 rounded p-3 text-sm font-mono text-gray-300 overflow-x-auto whitespace-pre">
      {children}
    </pre>
  );
}

function EndpointCard({ ep }: { ep: Endpoint }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
      <button
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-gray-800/30 transition-colors"
      >
        <MethodBadge method={ep.method} />
        <span className="font-mono text-sm text-gray-200">{ep.path}</span>
        {ep.badge && (
          <span className="text-[11px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400">
            {ep.badge}
          </span>
        )}
        {!ep.auth && <span className="text-[11px] text-gray-600 uppercase tracking-wide">public</span>}
        <span className="ml-auto text-gray-600 text-sm">{open ? "−" : "+"}</span>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-1 space-y-3 border-t border-gray-800/60">
          <p className="text-sm text-gray-400 leading-relaxed">{ep.summary}</p>

          {ep.params && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-500">
                    <th className="text-left px-2 py-1 font-medium">Param</th>
                    <th className="text-left px-2 py-1 font-medium">Default</th>
                    <th className="text-left px-2 py-1 font-medium">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {ep.params.map((p) => (
                    <tr key={p.name} className="border-t border-gray-800/50 align-top">
                      <td className="px-2 py-1 font-mono text-gray-300 whitespace-nowrap">
                        {p.name}
                        {p.required && <span className="text-red-400/80" title="required"> *</span>}
                      </td>
                      <td className="px-2 py-1 font-mono text-gray-500 whitespace-nowrap">{p.def ?? "—"}</td>
                      <td className="px-2 py-1 text-gray-400">{p.desc}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-gray-600 mt-1">* required</p>
            </div>
          )}

          {ep.body && (
            <div>
              <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Request body</div>
              <Code>{ep.body}</Code>
            </div>
          )}

          <div>
            <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Response</div>
            <Code>{ep.sample}</Code>
          </div>

          {ep.notes && (
            <ul className="space-y-1">
              {ep.notes.map((n, i) => (
                <li key={i} className="text-sm text-gray-500 flex gap-2">
                  <span className="text-gray-700">▸</span>
                  <span>{n}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

export default function ApiTab() {
  return (
    <div className="p-4 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-gray-100">API Reference</h1>
          <p className="text-sm text-gray-500 mt-1">
            Consumer endpoints for the candleserv composite. Base URL is the host serving this page.
            Manage API keys in the <span className="text-gray-400">Admin</span> tab.
          </p>
        </div>
        <div className="flex gap-2">
          <a
            href={POSTMAN_COLLECTION}
            download
            className="text-sm px-3 py-1.5 rounded border border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-gray-100 transition-colors"
          >
            ⤓ Postman collection
          </a>
          <a
            href={POSTMAN_ENVIRONMENT}
            download
            className="text-sm px-3 py-1.5 rounded border border-gray-800 text-gray-500 hover:bg-gray-800 hover:text-gray-300 transition-colors"
          >
            ⤓ environment
          </a>
        </div>
      </div>

      {/* Auth */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-3">
        <h2 className="text-sm font-medium text-gray-300">Authentication</h2>
        <p className="text-sm text-gray-400 leading-relaxed">
          <span className="font-mono text-gray-300">/health</span> is open. Every{" "}
          <span className="font-mono text-gray-300">/v1/*</span> route requires a per-request signed token in the{" "}
          <span className="font-mono text-gray-300">Authorization</span> header — the header value <em>is</em> the token
          (no <span className="font-mono">Bearer</span> prefix).
        </p>
        <Code>{`token = base64( apiKey + ":" + nonce + ":" + chop )
chop  = SHA256( apiSecret + ":" + nonce ).hex.slice(0, 19)`}</Code>
        <ul className="space-y-1">
          <li className="text-sm text-gray-500 flex gap-2">
            <span className="text-gray-700">▸</span>
            <span>
              <span className="text-gray-400">nonce</span> must strictly increase per key — the server rejects any
              nonce ≤ the last one it saw (<span className="font-mono">401 Nonce replay rejected</span>). Use{" "}
              <span className="font-mono">Date.now()</span> and persist the last value.
            </span>
          </li>
          <li className="text-sm text-gray-500 flex gap-2">
            <span className="text-gray-700">▸</span>
            <span>A key's secret is shown once at creation and never stored retrievably. The bundled Postman collection signs requests for you via a pre-request script.</span>
          </li>
          <li className="text-sm text-gray-500 flex gap-2">
            <span className="text-gray-700">▸</span>
            <span>In demo mode all <span className="font-mono">/v1/*</span> is disabled (<span className="font-mono">403 API disabled in demo mode</span>).</span>
          </li>
        </ul>
      </div>

      {/* Conventions */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-4">
        <h2 className="text-sm font-medium text-gray-300">Conventions</h2>

        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Timeframes</div>
          <p className="text-sm font-mono text-gray-400">{TIMEFRAMES}</p>
          <p className="text-xs text-gray-600 mt-1">/v1/premium supports all except 30d (calendar-month rollup).</p>
        </div>

        <div className="grid md:grid-cols-2 gap-4">
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Composite candle shape</div>
            <Code>{CANDLE_SHAPE}</Code>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Premium bar shape</div>
            <Code>{PREMIUM_BAR_SHAPE}</Code>
          </div>
        </div>

        <div>
          <div className="text-xs uppercase tracking-wide text-gray-500 mb-1">Source bitmask</div>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {SOURCE_BITS.map(([name, bit]) => (
              <span key={name} className="text-sm font-mono text-gray-400">
                {name}=<span className="text-gray-300">{bit}</span>
              </span>
            ))}
          </div>
          <p className="text-xs text-gray-600 mt-1">The candle's <span className="font-mono">sources</span> field is the OR of these.</p>
        </div>
      </div>

      {/* Endpoint sections */}
      {SECTIONS.map((section) => (
        <div key={section.name} className="space-y-2">
          <div>
            <h2 className="text-sm font-medium text-gray-300">{section.name}</h2>
            <p className="text-sm text-gray-500 mt-0.5 leading-relaxed">{section.blurb}</p>
          </div>
          <div className="space-y-2">
            {section.endpoints.map((ep) => (
              <EndpointCard key={ep.method + ep.path} ep={ep} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
