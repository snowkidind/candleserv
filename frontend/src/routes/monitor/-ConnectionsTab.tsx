import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getStats, getSourcesStatus, getGaps, getStreamEvents, triggerHeal,
  getFormula, setFormula,
  type StreamEvent, type SourceStatus,
} from "@/lib/api";
import { useCandleStream } from "@/lib/CandleStreamContext";
import SourceHistoryModal from "./-SourceHistoryModal";

const TIMELINE_MINUTES = [10, 60, 720, 1440, 10080] as const;
const TIMELINE_LABELS  = ["10m", "1h", "12h", "1d", "7d"] as const;

// Local-storage key for dismissing auto-suspend banners on a per-(source, ts) basis
const DISMISS_KEY_PREFIX = "candleserv:autosuspend-dismissed:";

// ── helpers ──────────────────────────────────────────────────────────────────

function setEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

function timeAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ── AutoSuspendBanner ────────────────────────────────────────────────────────

function AutoSuspendBanner({
  sources,
  onPrefillReinclude,
}: {
  sources: Record<string, SourceStatus>;
  onPrefillReinclude: (source: string) => void;
}) {
  // Find sources that were auto-suspended within the last 24h and are still excluded.
  // Plus filter out dismissed ones (keyed by source + excludedAt timestamp).
  const candidates = Object.entries(sources).filter(([, s]) =>
    s.excluded
    && s.excludedReason === "auto-suspend"
    && s.excludedAt
    && Date.now() - new Date(s.excludedAt).getTime() < 24 * 60 * 60 * 1000,
  );
  const visible = candidates.filter(([source, s]) => {
    const dismissKey = `${DISMISS_KEY_PREFIX}${source}:${s.excludedAt}`;
    return localStorage.getItem(dismissKey) !== "1";
  });
  if (visible.length === 0) return null;

  return (
    <div className="space-y-2">
      {visible.map(([source, s]) => (
        <div
          key={source}
          className="bg-yellow-900/30 border border-yellow-800 rounded-lg p-3 flex items-start justify-between gap-3"
        >
          <div className="flex-1 text-sm">
            <div className="text-yellow-300 font-medium">
              ⚠ <span className="capitalize">{source}</span> was auto-excluded from the formula
            </div>
            <div className="text-yellow-400/80 text-xs mt-1">
              Reason: {s.reason ?? "auto-suspend"} · Excluded {timeAgo(s.excludedAt)}
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => onPrefillReinclude(source)}
              className="px-3 py-1.5 text-xs bg-yellow-700 hover:bg-yellow-600 text-yellow-100 rounded transition-colors"
            >
              Re-include {source}
            </button>
            <button
              onClick={() => {
                localStorage.setItem(`${DISMISS_KEY_PREFIX}${source}:${s.excludedAt}`, "1");
                // Force a re-render
                window.dispatchEvent(new Event("storage"));
              }}
              className="px-3 py-1.5 text-xs text-yellow-400 hover:text-yellow-200"
            >
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── LiveFormulaEditor ────────────────────────────────────────────────────────

function FormulaDiffModal({
  current,
  draft,
  onConfirm,
  onCancel,
  saving,
}: {
  current: string[];
  draft: string[];
  onConfirm: () => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const cur = new Set(current);
  const drf = new Set(draft);
  const toExclude = draft.filter((s) => !cur.has(s));
  const toInclude = current.filter((s) => !drf.has(s));

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-md w-full p-5">
        <h3 className="text-lg font-medium text-gray-100 mb-3">Change live formula</h3>
        <div className="space-y-2 text-sm">
          {toExclude.map((s) => (
            <div key={s} className="text-gray-300">
              • Exclude <span className="font-mono text-yellow-300">{s}</span>
            </div>
          ))}
          {toInclude.map((s) => (
            <div key={s} className="text-gray-300">
              • Include <span className="font-mono text-green-300">{s}</span>
            </div>
          ))}
        </div>
        {toInclude.length > 0 && (
          <div className="mt-4 text-xs text-yellow-400/80 leading-relaxed">
            ⚠ Re-including a source resumes fetching from the next tick. The archive gap accumulated during the exclusion window will NOT be filled automatically — use Repair Range in the Admin tab if you need to backfill it.
          </div>
        )}
        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onCancel}
            disabled={saving}
            className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={saving}
            className="px-4 py-2 text-sm bg-blue-700 hover:bg-blue-600 disabled:bg-blue-900 text-white rounded transition-colors"
          >
            {saving ? "Saving…" : "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}

function LiveFormulaEditor({
  sourceNames,
  externalPrefill,
}: {
  sourceNames: string[];
  externalPrefill: { source: string; nonce: number } | null;
}) {
  const qc = useQueryClient();
  const { data: live } = useQuery({ queryKey: ["formula"], queryFn: getFormula });
  const [draft, setDraft] = useState<string[]>([]);
  const [showDiff, setShowDiff] = useState(false);
  const [minSources] = useState<number>(3);  // mirrors server default; could be fetched from /monitor/config

  // Re-init draft when live formula changes (server pushed an update, or our save landed).
  useEffect(() => {
    if (live) setDraft(live.excludedSources);
  }, [live]);

  // External prefill from the AutoSuspendBanner "Re-include" button.
  useEffect(() => {
    if (!externalPrefill || !live) return;
    setDraft(live.excludedSources.filter((s) => s !== externalPrefill.source));
  }, [externalPrefill, live]);

  const mut = useMutation({
    mutationFn: (excludedSources: string[]) => setFormula({ excludedSources }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["formula"] });
      qc.invalidateQueries({ queryKey: ["sources", "status"] });
      setShowDiff(false);
    },
  });

  const dirty = !!live && !setEqual(draft, live.excludedSources);
  const includedCount = sourceNames.length - draft.length;
  const belowMin = includedCount < minSources;

  const toggle = (source: string) => {
    setDraft((d) => (d.includes(source) ? d.filter((x) => x !== source) : [...d, source]));
  };
  const discard = () => { if (live) setDraft(live.excludedSources); };

  if (!live) return null;

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-200">Live formula</h3>
        {live.lastChange && (
          <span className="text-xs text-gray-500">
            Last change: {timeAgo(live.lastChange.at)} — {live.lastChange.by}
            {" "}{live.lastChange.setOrUnset === "set" ? "excluded" : "included"} {live.lastChange.exchange}
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {sourceNames.map((name) => {
          const included = !draft.includes(name);
          return (
            <label key={name} className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={included}
                onChange={() => toggle(name)}
                className="accent-blue-600"
              />
              <span className={included ? "text-gray-200 capitalize" : "text-gray-500 capitalize line-through"}>
                {name}
              </span>
            </label>
          );
        })}
      </div>
      <div className="flex items-center justify-between mt-3 text-xs">
        <span className="text-gray-500">
          {includedCount} of {sourceNames.length} sources included
          {belowMin && <span className="text-red-400 ml-2">⚠ below minSources={minSources}</span>}
        </span>
        <div className="flex gap-2">
          <button
            onClick={discard}
            disabled={!dirty}
            className="px-3 py-1.5 text-xs text-gray-400 hover:text-gray-200 disabled:text-gray-700"
          >
            Discard
          </button>
          <button
            onClick={() => setShowDiff(true)}
            disabled={!dirty || belowMin}
            className="px-3 py-1.5 text-xs bg-blue-700 hover:bg-blue-600 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded transition-colors"
          >
            Save changes
          </button>
        </div>
      </div>
      {showDiff && (
        <FormulaDiffModal
          current={live.excludedSources}
          draft={draft}
          onConfirm={() => mut.mutate(draft)}
          onCancel={() => setShowDiff(false)}
          saving={mut.isPending}
        />
      )}
    </div>
  );
}

// ── SourceCard (included + excluded variants) ─────────────────────────────────

function statePillColor(state: string): string {
  switch (state) {
    case "on":    return "bg-green-500";
    case "error": return "bg-red-500";
    default:      return "bg-gray-600";
  }
}

function pctOrDash(v: number | null): string {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function SourceCard({
  name,
  status,
  onOpenHistory,
}: {
  name: string;
  status: SourceStatus | undefined;
  onOpenHistory: (source: string) => void;
}) {
  if (!status) {
    return (
      <div
        className="bg-gray-900 border border-gray-800 rounded-lg p-4 cursor-pointer hover:border-gray-700"
        onClick={() => onOpenHistory(name)}
      >
        <div className="text-sm capitalize text-gray-200">{name}</div>
        <div className="text-xs text-gray-600 mt-1">unknown</div>
      </div>
    );
  }

  const excluded = status.excluded;
  const base = "border border-gray-800 rounded-lg p-4 cursor-pointer transition-colors";
  const cls = excluded
    ? `bg-gray-900/50 ${base} hover:border-gray-700 opacity-75`
    : `bg-gray-900 ${base} hover:border-gray-700`;

  return (
    <div className={cls} onClick={() => onOpenHistory(name)} role="button">
      <div className="flex items-center justify-between mb-2">
        <span className={`text-sm font-medium capitalize ${excluded ? "text-gray-400" : "text-gray-200"}`}>
          {name}
        </span>
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${excluded ? "bg-gray-600" : statePillColor(status.state)}`} />
          <span className="text-xs text-gray-500">{excluded ? "off" : status.state}</span>
        </div>
      </div>

      {!excluded ? (
        <div className="text-xs text-gray-500 space-y-1">
          <div>
            Failures 24h:{" "}
            <span className={status.failures24h > 5 ? "text-yellow-400" : "text-gray-300"}>
              {status.failures24h}
            </span>
          </div>
          <div>Last fetch: <span className="text-gray-300">{timeAgo(status.lastFetch)}</span></div>
          <div className="pt-1 text-gray-600">Formula: <span className="text-green-400">Included</span></div>
        </div>
      ) : (
        <div className="text-xs space-y-1">
          <div className="text-gray-400 italic">Excluded from formula</div>
          <div className="text-gray-500">Reason: <span className="text-gray-300">{status.excludedReason ?? "—"}</span></div>
          <div className="text-gray-500">Excluded: <span className="text-gray-300">{timeAgo(status.excludedAt)}</span></div>
          {status.lastKnownAtExclusion && (
            <div className="mt-2 pt-2 border-t border-gray-800 text-gray-500 space-y-0.5">
              <div className="text-gray-600 mb-1">Last seen at exclusion:</div>
              <div>Failures: <span className="text-gray-300">{status.lastKnownAtExclusion.failures24h ?? "—"}</span></div>
              <div>Outlier rate: <span className="text-gray-300">{pctOrDash(status.lastKnownAtExclusion.outlierRate24h)}</span></div>
              <div>Used: <span className="text-gray-300">{pctOrDash(status.lastKnownAtExclusion.usedRate24h)}</span></div>
            </div>
          )}
          <div className="pt-1 text-gray-600">Formula: <span className="text-gray-400">Excluded</span></div>
        </div>
      )}
    </div>
  );
}

// ── TimelineCanvas (unchanged — kept from prior implementation) ──────────────

function TimelineCanvas({
  events, minutes, sources,
}: { events: StreamEvent[]; minutes: number; sources: string[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    if (sources.length === 0) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    const W = canvas.width, H = canvas.height;
    const rowH = Math.floor(H / sources.length);
    const now = Date.now();
    const windowMs = minutes * 60 * 1000;

    ctx.clearRect(0, 0, W, H);
    sources.forEach((_, i) => {
      ctx.fillStyle = i % 2 === 0 ? "#111827" : "#0f172a";
      ctx.fillRect(0, i * rowH, W, rowH);
    });

    const bySource: Record<string, StreamEvent[]> = {};
    for (const s of sources) bySource[s] = [];
    for (const e of events) if (bySource[e.source]) bySource[e.source].push(e);

    sources.forEach((src, i) => {
      const evts = bySource[src].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      const y = i * rowH + 2;
      const h = rowH - 4;
      for (let j = 0; j < evts.length; j++) {
        const evtTs = new Date(evts[j].createdAt).getTime();
        const nextTs = j + 1 < evts.length ? new Date(evts[j + 1].createdAt).getTime() : now;
        const x1 = Math.max(0, ((evtTs - (now - windowMs)) / windowMs) * W);
        const x2 = Math.min(W, ((nextTs - (now - windowMs)) / windowMs) * W);
        if (x2 <= 0 || x1 >= W) continue;
        const st = evts[j].state;
        ctx.fillStyle = st === "on" ? "#166534"
          : st === "error" ? "#7f1d1d"
          : st === "paused" || st === "formula-excluded" ? "#1e3a5f"
          : "#374151";
        ctx.fillRect(x1, y, x2 - x1, h);
      }
      ctx.fillStyle = "#6b7280";
      ctx.font = "10px monospace";
      ctx.fillText(src, 4, i * rowH + rowH / 2 + 4);
    });

    ctx.strokeStyle = "#4b5563";
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(W - 1, 0);
    ctx.lineTo(W - 1, H);
    ctx.stroke();
    ctx.setLineDash([]);
  }, [events, minutes, sources]);

  return <canvas ref={canvasRef} width={800} height={120} className="w-full rounded" />;
}

// ── ConnectionsTab ───────────────────────────────────────────────────────────

export default function ConnectionsTab() {
  const [timelineMin, setTimelineMin] = useState<number>(60);
  const [healing, setHealing] = useState(false);
  const [historySource, setHistorySource] = useState<string | null>(null);
  // External-prefill nonce lets the editor re-react to the same source being clicked twice.
  const [prefill, setPrefill] = useState<{ source: string; nonce: number } | null>(null);
  const qc = useQueryClient();
  const { sourceStateTick } = useCandleStream();

  const { data: stats }   = useQuery({ queryKey: ["stats"],            queryFn: getStats,         refetchInterval: 60_000 });
  const { data: sources } = useQuery({ queryKey: ["sources", "status"], queryFn: getSourcesStatus, refetchInterval: 30_000 });
  const { data: gaps }    = useQuery({ queryKey: ["gaps"],             queryFn: getGaps,          refetchInterval: 60_000 });
  const { data: events }  = useQuery({
    queryKey: ["stream-events", timelineMin],
    queryFn: () => getStreamEvents(timelineMin),
    refetchInterval: 30_000,
  });

  // SSE-triggered invalidations — covers both legacy source_state and the new
  // formula-excluded / formula-included transitions.
  useEffect(() => {
    if (!sourceStateTick) return;
    qc.invalidateQueries({ queryKey: ["sources", "status"] });
    qc.invalidateQueries({ queryKey: ["formula"] });
    qc.invalidateQueries({ queryKey: ["stream-events"] });
  }, [sourceStateTick, qc]);

  const heal = async () => {
    setHealing(true);
    try { await triggerHeal(); } finally {
      setHealing(false);
      qc.invalidateQueries({ queryKey: ["gaps"] });
    }
  };

  const latency = stats?.collectionLatency;
  const latencyColor = !latency ? "text-gray-500"
    : latency.avgMs < 7000  ? "text-green-400"
    : latency.avgMs < 10000 ? "text-yellow-400"
    : "text-red-400";

  const sourceNames = useMemo(() => Object.keys(sources?.sources ?? {}), [sources]);
  const includedCount = useMemo(
    () => Object.values(sources?.sources ?? {}).filter((s) => !s.excluded).length,
    [sources],
  );

  return (
    <div className="p-4 space-y-4">
      {/* Auto-suspend banner — only visible when an auto-suspend trip is recent + un-dismissed */}
      {sources?.sources && (
        <AutoSuspendBanner
          sources={sources.sources}
          onPrefillReinclude={(source) => setPrefill({ source, nonce: Date.now() })}
        />
      )}

      {/* Live formula editor — top of tab */}
      <LiveFormulaEditor sourceNames={sourceNames} externalPrefill={prefill} />

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ["Total candles", stats?.totalRows?.toLocaleString() ?? "—"],
          ["Sources",        `${includedCount}/${sourceNames.length} included`],
          ["Gaps pending",   String(gaps?.gaps.filter(g => g.state !== "healed").length ?? "—")],
          ["Avg latency",    latency ? `${latency.avgMs}ms` : "—"],
        ].map(([label, value]) => (
          <div key={label} className="bg-gray-900 border border-gray-800 rounded-lg p-3">
            <div className="text-xs text-gray-500 mb-1">{label}</div>
            <div className={`text-sm font-medium ${label === "Avg latency" ? latencyColor : "text-white"}`}>{value}</div>
          </div>
        ))}
      </div>

      {/* Exchange grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {sourceNames.map(src => (
          <SourceCard
            key={src}
            name={src}
            status={sources?.sources[src]}
            onOpenHistory={(name) => setHistorySource(name)}
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
        <TimelineCanvas events={events?.events ?? []} minutes={timelineMin} sources={sourceNames} />
        <div className="flex gap-4 mt-2 text-xs text-gray-600">
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-green-800 inline-block" /> on</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-red-900 inline-block" /> error</span>
          <span className="flex items-center gap-1"><span className="w-2 h-2 rounded bg-blue-900 inline-block" /> excluded</span>
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

      {/* History modal */}
      {historySource && (
        <SourceHistoryModal source={historySource} onClose={() => setHistorySource(null)} />
      )}
    </div>
  );
}
