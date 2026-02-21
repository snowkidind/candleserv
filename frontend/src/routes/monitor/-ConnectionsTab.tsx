import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getStats, getSourcesStatus, getGaps, getStreamEvents, triggerHeal, resumeSource, type StreamEvent } from "@/lib/api";

const SOURCES = ["binance", "bybit", "kraken", "coinbase", "bitfinex"];
const TIMELINE_MINUTES = [10, 60, 720, 1440, 10080] as const;
const TIMELINE_LABELS  = ["10m", "1h", "12h", "1d", "7d"] as const;

function stateBg(state: string, stale = false): string {
  if (stale) return "bg-yellow-500";
  switch (state) {
    case "on":     return "bg-green-500";
    case "error":  return "bg-red-500";
    case "paused": return "bg-blue-500";
    case "stale":  return "bg-yellow-500";
    default:       return "bg-gray-600";
  }
}

function SourceCard({ name, status }: { name: string; status: { paused: boolean; failures24h: number; state: string } }) {
  const qc = useQueryClient();
  const resume = useMutation({
    mutationFn: () => resumeSource(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sources"] }),
  });
  const dot = stateBg(status.state);
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium capitalize text-gray-200">{name}</span>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${dot}`} />
          <span className="text-xs text-gray-500">{status.state}</span>
        </div>
      </div>
      <div className="text-xs text-gray-500 space-y-1">
        <div>Failures 24h: <span className={status.failures24h > 5 ? "text-yellow-400" : "text-gray-400"}>{status.failures24h}</span></div>
      </div>
      {status.paused && (
        <button
          onClick={() => resume.mutate()}
          className="mt-3 w-full text-xs bg-blue-900 hover:bg-blue-800 text-blue-300 rounded py-1 transition-colors"
        >
          Resume
        </button>
      )}
    </div>
  );
}

function TimelineCanvas({ events, minutes }: { events: StreamEvent[]; minutes: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width, H = canvas.height;
    const rowH = Math.floor(H / SOURCES.length);
    const now = Date.now();
    const windowMs = minutes * 60 * 1000;

    ctx.clearRect(0, 0, W, H);

    // Row backgrounds
    SOURCES.forEach((_, i) => {
      ctx.fillStyle = i % 2 === 0 ? "#111827" : "#0f172a";
      ctx.fillRect(0, i * rowH, W, rowH);
    });

    // Plot events as colored segments
    const bySource: Record<string, StreamEvent[]> = {};
    for (const s of SOURCES) bySource[s] = [];
    for (const e of events) {
      if (bySource[e.source]) bySource[e.source].push(e);
    }

    SOURCES.forEach((src, i) => {
      const evts = bySource[src].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      const y = i * rowH + 2;
      const h = rowH - 4;

      let cursor = now - windowMs;
      for (let j = 0; j < evts.length; j++) {
        const evtTs = new Date(evts[j].createdAt).getTime();
        const nextTs = j + 1 < evts.length ? new Date(evts[j + 1].createdAt).getTime() : now;
        const x1 = Math.max(0, ((evtTs - (now - windowMs)) / windowMs) * W);
        const x2 = Math.min(W, ((nextTs - (now - windowMs)) / windowMs) * W);
        if (x2 <= 0 || x1 >= W) { cursor = nextTs; continue; }
        ctx.fillStyle = evts[j].state === "on" ? "#166534"
          : evts[j].state === "error" ? "#7f1d1d"
          : evts[j].state === "paused" ? "#1e3a5f"
          : "#374151";
        ctx.fillRect(x1, y, x2 - x1, h);
        cursor = nextTs;
      }

      // Source label
      ctx.fillStyle = "#6b7280";
      ctx.font = "10px monospace";
      ctx.fillText(src, 4, i * rowH + rowH / 2 + 4);
    });

    // Now line
    ctx.strokeStyle = "#4b5563";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(W - 1, 0);
    ctx.lineTo(W - 1, H);
    ctx.stroke();
    ctx.setLineDash([]);
  }, [events, minutes]);

  return <canvas ref={canvasRef} width={800} height={120} className="w-full rounded" />;
}

export default function ConnectionsTab() {
  const [timelineMin, setTimelineMin] = useState<number>(60);
  const [healing, setHealing] = useState(false);
  const qc = useQueryClient();

  const { data: stats }   = useQuery({ queryKey: ["stats"],   queryFn: getStats,         refetchInterval: 60_000 });
  const { data: sources } = useQuery({ queryKey: ["sources"], queryFn: getSourcesStatus, refetchInterval: 30_000 });
  const { data: gaps }    = useQuery({ queryKey: ["gaps"],     queryFn: getGaps,          refetchInterval: 60_000 });
  const { data: events }  = useQuery({
    queryKey: ["stream-events", timelineMin],
    queryFn: () => getStreamEvents(timelineMin),
    refetchInterval: 30_000,
  });

  // Live SSE source state updates
  useEffect(() => {
    const es = new EventSource("/monitor/candles/stream?tf=1m");
    es.addEventListener("source_state", () => {
      qc.invalidateQueries({ queryKey: ["sources"] });
      qc.invalidateQueries({ queryKey: ["stream-events"] });
    });
    return () => es.close();
  }, [qc]);

  const heal = async () => {
    setHealing(true);
    try { await triggerHeal(); } finally {
      setHealing(false);
      qc.invalidateQueries({ queryKey: ["gaps"] });
    }
  };

  const latency = stats?.collectionLatency;
  const latencyColor = !latency ? "text-gray-500"
    : latency.avgMs < 7000 ? "text-green-400"
    : latency.avgMs < 10000 ? "text-yellow-400"
    : "text-red-400";

  return (
    <div className="p-4 space-y-4">
      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ["Total candles", stats?.totalRows?.toLocaleString() ?? "—"],
          ["Oldest candle", stats?.oldestCandle ? new Date(stats.oldestCandle).toLocaleDateString() : "—"],
          ["Gaps pending",  String(gaps?.gaps.filter(g => g.state !== "healed").length ?? "—")],
          ["Avg latency",   latency ? `${latency.avgMs}ms` : "—"],
        ].map(([label, value]) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <div className="text-xs text-gray-500 mb-1">{label}</div>
            <div className={`text-sm font-medium ${label === "Avg latency" ? latencyColor : "text-white"}`}>{value}</div>
          </div>
        ))}
      </div>

      {/* Exchange grid */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {SOURCES.map(src => (
          <SourceCard
            key={src}
            name={src}
            status={sources?.sources[src] ?? { paused: false, failures24h: 0, state: "unknown" }}
          />
        ))}
      </div>

      {/* Timeline */}
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <span className="text-sm text-gray-300 font-medium">Connection timeline</span>
          <div className="flex gap-1">
            {TIMELINE_MINUTES.map((m, i) => (
              <button
                key={m}
                onClick={() => setTimelineMin(m)}
                className={`px-2 py-1 text-xs rounded transition-colors ${
                  timelineMin === m ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
                }`}
              >
                {TIMELINE_LABELS[i]}
              </button>
            ))}
          </div>
        </div>
        <TimelineCanvas events={events?.events ?? []} minutes={timelineMin} />
        <div className="flex gap-4 mt-2 text-xs text-gray-600">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-green-800 inline-block" /> on</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-red-900 inline-block" /> error</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-blue-900 inline-block" /> paused</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-gray-700 inline-block" /> unknown</span>
        </div>
      </div>

      {/* Heal button + recent gaps */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-400">
          {gaps?.gaps.length ? `${gaps.gaps.length} gap records` : "No gaps"}
        </span>
        <button
          onClick={heal}
          disabled={healing}
          className="px-4 py-2 text-sm bg-gray-800 hover:bg-gray-700 disabled:bg-gray-900 disabled:text-gray-600 text-gray-200 rounded-lg transition-colors"
        >
          {healing ? "Healing…" : "Run heal scan"}
        </button>
      </div>
      {!!gaps?.gaps.length && (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-gray-800">
              <tr className="text-gray-500">
                <th className="text-left px-3 py-2">Timestamp</th>
                <th className="text-left px-3 py-2">Duration</th>
                <th className="text-left px-3 py-2">State</th>
                <th className="text-left px-3 py-2">Healed</th>
              </tr>
            </thead>
            <tbody>
              {gaps.gaps.slice(0, 20).map(g => (
                <tr key={g.id} className="border-b border-gray-800/50 hover:bg-gray-800/30">
                  <td className="px-3 py-2 font-mono text-gray-300">{new Date(g.timestamp).toLocaleString()}</td>
                  <td className="px-3 py-2 text-gray-400">{g.durationMinutes}m</td>
                  <td className="px-3 py-2">
                    <span className={`px-1.5 py-0.5 rounded text-xs ${
                      g.state === "healed" ? "bg-green-900/40 text-green-400"
                      : g.state === "unresolvable" ? "bg-red-900/40 text-red-400"
                      : "bg-yellow-900/40 text-yellow-400"
                    }`}>{g.state}</span>
                  </td>
                  <td className="px-3 py-2 text-gray-500">{g.healedAt ? new Date(g.healedAt).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
