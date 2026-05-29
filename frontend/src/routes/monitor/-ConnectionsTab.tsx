import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getStats, getSourcesStatus, getGaps, triggerHeal,
  getFormula, setFormula, getConfig, getCurrencies,
  type SourceStatus,
} from "@/lib/api";
import { useCandleStream } from "@/lib/CandleStreamContext";
import { isDemo } from "@/lib/demo";
import SourceHistoryModal from "./-SourceHistoryModal";

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
  readOnly = false,
}: {
  sources: Record<string, SourceStatus>;
  onPrefillReinclude: (source: string) => void;
  readOnly?: boolean;
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
            {!readOnly && (
              <button
                onClick={() => onPrefillReinclude(source)}
                className="px-3 py-1.5 text-xs bg-yellow-700 hover:bg-yellow-600 text-yellow-100 rounded transition-colors"
              >
                Re-include {source}
              </button>
            )}
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
  readOnly = false,
}: {
  sourceNames: string[];
  externalPrefill: { source: string; nonce: number } | null;
  readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const { data: live } = useQuery({ queryKey: ["formula"], queryFn: getFormula });
  // config carries secrets (redisUrl) and is denied in demo — skip it when
  // read-only; minSources falls back to the server default (3) below.
  const { data: config } = useQuery({ queryKey: ["config"], queryFn: getConfig, enabled: !readOnly });
  const [draft, setDraft] = useState<string[]>([]);
  const [showDiff, setShowDiff] = useState(false);
  // app_settings stores values as text. Fall back to the server default of 3
  // until the config query resolves so the editor stays usable on first paint.
  const minSources = Number(config?.settings?.minSources ?? 3);

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
                disabled={readOnly}
                className="accent-blue-600 disabled:cursor-default"
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
        {!readOnly && (
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
        )}
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
  pollingCurrencies,
  onOpenHistory,
}: {
  name: string;
  status: SourceStatus | undefined;
  pollingCurrencies: string[];   // enabled currencies this venue is actively feeding
  onOpenHistory: (source: string) => void;
}) {
  const pollingLine = (
    <div className="mt-2 pt-2 border-t border-gray-800 text-xs">
      <span className="text-gray-500">Polling: </span>
      {pollingCurrencies.length
        ? <span className="text-gray-300 font-mono">{pollingCurrencies.join(" ")}</span>
        : <span className="text-gray-600">none</span>}
    </div>
  );

  if (!status) {
    return (
      <div
        className="bg-gray-900 border border-gray-800 rounded-lg p-4 cursor-pointer hover:border-gray-700"
        onClick={() => onOpenHistory(name)}
      >
        <div className="text-sm capitalize text-gray-200">{name}</div>
        <div className="text-xs text-gray-600 mt-1">unknown</div>
        {pollingLine}
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
      {pollingLine}
    </div>
  );
}

// ── ConnectionsTab ───────────────────────────────────────────────────────────

export default function ConnectionsTab() {
  const [healing, setHealing] = useState(false);
  const [historySource, setHistorySource] = useState<string | null>(null);
  // External-prefill nonce lets the editor re-react to the same source being clicked twice.
  const [prefill, setPrefill] = useState<{ source: string; nonce: number } | null>(null);
  const qc = useQueryClient();
  const { sourceStateTick } = useCandleStream();

  const { data: stats }      = useQuery({ queryKey: ["stats"],            queryFn: getStats,         refetchInterval: 60_000 });
  const { data: sources }    = useQuery({ queryKey: ["sources", "status"], queryFn: getSourcesStatus, refetchInterval: 30_000 });
  const { data: gaps }       = useQuery({ queryKey: ["gaps"],             queryFn: getGaps,          refetchInterval: 60_000 });
  const { data: currencies } = useQuery({ queryKey: ["currencies"],       queryFn: getCurrencies,    refetchInterval: 30_000 });

  // SSE-triggered invalidations — covers both legacy source_state and the new
  // formula-excluded / formula-included transitions.
  useEffect(() => {
    if (!sourceStateTick) return;
    qc.invalidateQueries({ queryKey: ["sources", "status"] });
    qc.invalidateQueries({ queryKey: ["formula"] });
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

  // Which enabled currencies each venue is actively feeding: enabled currency
  // AND that venue's feed is probed-available AND operator-enabled. (The global
  // formula kill-switch is applied per-card below via status.excluded.)
  const pollingByVenue = useMemo(() => {
    const map: Record<string, string[]> = {};
    for (const c of currencies?.currencies ?? []) {
      if (!c.enabled) continue;
      for (const [venue, f] of Object.entries(c.feeds)) {
        if (f.available && f.enabled) (map[venue] ??= []).push(c.code);
      }
    }
    return map;
  }, [currencies]);

  return (
    <div className="p-4 space-y-4">
      {/* Auto-suspend banner — read-only in demo (re-include CTA hidden). */}
      {sources?.sources && (
        <AutoSuspendBanner
          sources={sources.sources}
          onPrefillReinclude={(source) => setPrefill({ source, nonce: Date.now() })}
          readOnly={isDemo()}
        />
      )}

      {/* Live formula editor — venue kill-switch. Read-only in demo: the source
          included/excluded status stays visible, the toggles + save are inert. */}
      <LiveFormulaEditor sourceNames={sourceNames} externalPrefill={prefill} readOnly={isDemo()} />

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
            <div className={`text-sm font-medium ${label === "Avg latency" ? latencyColor : "text-gray-50"}`}>{value}</div>
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
            pollingCurrencies={sources?.sources[src]?.excluded ? [] : (pollingByVenue[src] ?? [])}
            onOpenHistory={(name) => setHistorySource(name)}
          />
        ))}
      </div>

      {/* Heal button + recent gaps */}
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-400">
          {gaps?.gaps.length ? `${gaps.gaps.length} gap records` : "No gaps"}
        </span>
        <button
          onClick={heal}
          disabled={healing || isDemo()}
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
