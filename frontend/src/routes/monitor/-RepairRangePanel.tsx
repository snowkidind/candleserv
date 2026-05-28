import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getFormula, previewRepair, runRepair, getRepairJob, getActiveRepairJob, cancelRepairJob,
  getCurrencies,
  type RepairPreview, type RepairJobState, type Formula,
} from "@/lib/api";

// ── helpers ──────────────────────────────────────────────────────────────────

// Format a Date into a UTC value for an <input type="datetime-local">. The
// HTML input has no timezone mode of its own — we populate it with the UTC
// components, label the field "(UTC)", and parse the returned string as UTC.
// Backend stores everything in UTC (server.ts sets TZ=UTC at boot), so the
// picker now matches what's actually queried.
function toUtcInputValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
// Parse a datetime-local input value as UTC (append :00Z and let Date parse it).
function fromUtcInputValue(s: string): Date | null {
  if (!s) return null;
  const d = new Date(`${s}:00Z`);
  if (isNaN(d.getTime())) return null;
  return d;
}
// Display helper for UTC times in the confirm modal.
function fmtUtc(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function setEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

// ── confirm modal ────────────────────────────────────────────────────────────

function RepairConfirmModal({
  preview, from, to, formulaOverride, onConfirm, onCancel, running,
}: {
  preview: RepairPreview;
  from: Date;
  to: Date;
  formulaOverride: string[];
  onConfirm: () => void;
  onCancel: () => void;
  running: boolean;
}) {
  const [typed, setTyped] = useState("");
  const days = Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-lg w-full p-5">
        <h3 className="text-lg font-medium text-gray-100 mb-3">Confirm repair operation</h3>
        <div className="text-sm text-gray-300 space-y-1.5">
          <div>Window: <span className="font-mono">{fmtUtc(from)} → {fmtUtc(to)}</span> ({days} days, {preview.willBeRecomposed.toLocaleString()} minutes)</div>
          <div>Formula override: <span className="font-mono">{formulaOverride.length ? `exclude ${formulaOverride.join(", ")}` : "(matches live)"}</span></div>
          <div>Archive holes to fill: <span className="font-mono">{preview.archiveHoles.toLocaleString()}</span></div>
        </div>
        <div className="mt-4 text-xs text-yellow-400/80 leading-relaxed">
          ⚠ This will overwrite {preview.willBeRecomposed.toLocaleString()} rows in candles_1m and update usedInFormula across the per-source archive.
          The previous composite values will be lost. Live formula will not be modified;
          the rows in this window will reflect the override formula until reconciled.
          REST candle-poll endpoints will return 503 for the duration (~{formatDuration(preview.estimatedWallMs)}).
        </div>
        <div className="mt-4">
          <label className="text-xs text-gray-400 block mb-1">Type <code className="font-mono text-gray-200">repair</code> to confirm:</label>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoFocus
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} disabled={running} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={running || typed !== "repair"}
            className="px-4 py-2 text-sm bg-red-700 hover:bg-red-600 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded transition-colors"
          >
            {running ? "Starting…" : "Run repair"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── progress panel ───────────────────────────────────────────────────────────

function RepairProgressPanel({
  jobId, sourceNames, onDismiss, onReconcile, liveFormula,
}: {
  jobId: string;
  sourceNames: string[];
  onDismiss: () => void;
  // Called with the original from/to from the completed job — the parent
  // re-runs runRepair with no formula override to bring the window back to
  // live-formula composites. One-click loop closure for the divergence case.
  onReconcile: (from: string, to: string, currency: string) => void;
  liveFormula: Formula | null;
}) {
  // Poll every 2s while not in a terminal state. React Query handles this via
  // the refetchInterval callback shape (returns false to stop).
  const { data } = useQuery({
    queryKey: ["repair", "jobs", jobId],
    queryFn: () => getRepairJob(jobId),
    refetchInterval: (q) => {
      const s = q.state.data?.state;
      if (!s) return 2000;
      return s === "done" || s === "failed" || s === "cancelled" ? false : 2000;
    },
  });

  const [cancelling, setCancelling] = useState(false);
  const cancel = async () => {
    setCancelling(true);
    try { await cancelRepairJob(jobId); } finally { setCancelling(false); }
  };

  // Hooks must run on every render to preserve order — keep useMemo above the
  // early return below. The memo body guards on `data` being undefined.
  const diverged = useMemo(() => {
    if (!data || data.state !== "done") return false;
    if (!liveFormula) return false;
    const jobExcluded = data.formula?.excludedSources ?? liveFormula.excludedSources;
    return !setEqual(jobExcluded, liveFormula.excludedSources);
  }, [data, liveFormula]);

  if (!data) {
    return (
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-500">
        Starting repair job…
      </div>
    );
  }

  const terminal = data.state === "done" || data.state === "failed" || data.state === "cancelled";
  const startedAt = new Date(data.startedAt);
  const elapsed = data.finishedAt
    ? new Date(data.finishedAt).getTime() - startedAt.getTime()
    : Date.now() - startedAt.getTime();

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-200">
          {data.state === "done"      ? "Repair complete"
          : data.state === "failed"    ? "Repair failed"
          : data.state === "cancelled" ? "Repair cancelled"
          : "Repair in progress"}
        </h3>
        <span className="text-xs text-gray-500 font-mono">job {data.jobId.slice(0, 8)}…</span>
      </div>

      <div className="text-xs text-gray-500 mb-3">
        State: <span className="text-gray-200 font-mono">{data.state}</span>
        {" · "}elapsed {formatDuration(elapsed)}
      </div>

      {/* Phase 1: ensure */}
      <div className="mb-3 text-sm">
        <div className="text-gray-300 mb-1">
          1. ensureSourceCoverage
          {data.ensure ? <span className="text-gray-500 ml-2 text-xs">
            ({data.ensure.rowsFetched.toLocaleString()} fetched, {data.ensure.sentinelsWritten.toLocaleString()} sentinels, {data.ensure.skipped.toLocaleString()} skipped)
          </span> : data.state === "ensuring" ? <span className="text-blue-400 ml-2 text-xs">running…</span> : null}
        </div>
        {data.ensure && Object.keys(data.ensure.failedPerSource).length > 0 && (
          <div className="text-xs text-red-400 mt-1">
            Failed tiles by source: {Object.entries(data.ensure.failedPerSource).map(([k, v]) => `${k}: ${v}`).join(", ")}
          </div>
        )}
      </div>

      {/* Phase 2: backfill stable rates */}
      <div className="mb-3 text-sm">
        <div className="text-gray-300 mb-1">
          2. backfillStableRates
          {data.backfill ? <span className="text-gray-500 ml-2 text-xs">
            ({data.backfill.rowsInserted.toLocaleString()} inserted, {data.backfill.rowsSkippedNoBtc.toLocaleString()} skipped no-btc)
          </span> : data.state === "backfilling" ? <span className="text-blue-400 ml-2 text-xs">running…</span> : null}
        </div>
        {data.backfill && Object.keys(data.backfill.failedPerSource).length > 0 && (
          <div className="text-xs text-red-400 mt-1">
            Failed tiles by source: {Object.entries(data.backfill.failedPerSource).map(([k, v]) => `${k}: ${v}`).join(", ")}
          </div>
        )}
      </div>

      {/* Phase 3: recompose */}
      <div className="mb-4 text-sm">
        <div className="text-gray-300 mb-1">
          3. recomposeRange
          {data.recompose ? <span className="text-gray-500 ml-2 text-xs">
            ({data.recompose.recomposed.toLocaleString()} recomposed, {data.recompose.skippedNoSources.toLocaleString()} skipped no-sources)
          </span> : data.state === "recomposing" ? <span className="text-blue-400 ml-2 text-xs">running…</span> : null}
        </div>
      </div>

      {/* Terminal outcomes */}
      {data.state === "done" && data.result && (
        <>
          <div className="text-sm text-green-400">
            ✓ {data.result.rowsWritten.toLocaleString()} composite rows recomposed
          </div>
          <div className="text-sm text-green-400">
            ✓ {data.result.archiveRowsFetched.toLocaleString()} archive rows fetched
          </div>
          {diverged && (
            <div className="mt-3 p-3 bg-yellow-900/30 border border-yellow-800 rounded text-xs">
              <div className="text-yellow-300 font-medium mb-1">⚠ Composite diverges from live formula</div>
              <div className="text-yellow-400/80">
                These {data.result.rowsWritten.toLocaleString()} rows were composed with{" "}
                <span className="font-mono">excludedSources=[{(data.formula?.excludedSources ?? []).join(", ")}]</span>.
                Live formula currently:{" "}
                <span className="font-mono">excludedSources=[{liveFormula?.excludedSources.join(", ") ?? ""}]</span>.
                candles_1m for this window stays off-live until reconciled.
              </div>
              <div className="mt-3">
                <button
                  onClick={() => onReconcile(data.from, data.to, data.currency)}
                  className="px-3 py-1.5 text-xs bg-yellow-700 hover:bg-yellow-600 text-yellow-100 rounded transition-colors"
                >
                  Reconcile: rerun with live formula
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {data.state === "failed" && data.error && (
        <div className="text-sm text-red-400 bg-red-900/20 border border-red-800 rounded p-2 mt-2">{data.error}</div>
      )}

      <div className="flex justify-end gap-2 mt-4">
        {!terminal && (
          <button
            onClick={cancel}
            disabled={cancelling}
            className="px-3 py-1.5 text-xs bg-yellow-700 hover:bg-yellow-600 text-white rounded transition-colors"
          >
            {cancelling ? "Cancelling…" : "Cancel"}
          </button>
        )}
        {terminal && (
          <button
            onClick={() => {
              if (data.state === "done") {
                // Recompose rewrote candles_1m for this window; the chart holds
                // its own imperative candle map (CandlesTab.tsx), so a page
                // reload is the simplest universal refresh.
                window.location.reload();
              } else {
                onDismiss();
              }
            }}
            className="px-3 py-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 rounded transition-colors"
          >
            {data.state === "done" ? "Dismiss & refresh" : "Dismiss"}
          </button>
        )}
      </div>
    </div>
  );
}

// ── main panel ───────────────────────────────────────────────────────────────

export default function RepairRangePanel({ sourceNames }: { sourceNames: string[] }) {
  const qc = useQueryClient();
  const { data: liveFormulaResp } = useQuery({ queryKey: ["formula"], queryFn: getFormula });
  const liveFormula: Formula | null = liveFormulaResp
    ? { excludedSources: liveFormulaResp.excludedSources }
    : null;

  // Which currency to repair. Enabled currencies only; defaults to BTC.
  const { data: currenciesResp } = useQuery({ queryKey: ["currencies"], queryFn: getCurrencies });
  const currencyOptions = useMemo(
    () => (currenciesResp?.currencies ?? []).filter((c) => c.enabled).map((c) => c.code),
    [currenciesResp],
  );
  const [currency, setCurrency] = useState("BTC");

  // Defaults: last 7 days, ending one minute ago.
  const [from, setFrom] = useState<string>(() => {
    const d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    return toUtcInputValue(d);
  });
  const [to, setTo] = useState<string>(() => {
    const d = new Date(Math.floor(Date.now() / 60000) * 60000 - 60000);
    return toUtcInputValue(d);
  });

  // Bounds for the datetime-local inputs. Computed per-render so a long-lived
  // page picks up the moving upper edge as minutes tick by. Server validates
  // independently; these are purely a UX guardrail against typing a date
  // outside the 180-day archive horizon or into the in-progress minute.
  const dpMin = toUtcInputValue(new Date(Date.now() - 180 * 24 * 60 * 60 * 1000));
  const dpMax = toUtcInputValue(new Date(Math.floor(Date.now() / 60000) * 60000 - 60000));

  const [formulaOverride, setFormulaOverride] = useState<string[]>([]);
  const [retryEmpty, setRetryEmpty] = useState(false);
  const [preview, setPreview] = useState<RepairPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Pick up an in-flight repair if the user navigated away mid-job and came
  // back. The server's single-flight flag is authoritative; we just need the
  // jobId to resume polling. Re-run on mount and whenever activeJobId clears
  // (so dismissing a terminal job doesn't immediately re-pick-up itself).
  useQuery({
    queryKey: ["repair", "current"],
    queryFn: async () => {
      const job = await getActiveRepairJob();
      if (job && !activeJobId) setActiveJobId(job.jobId);
      return job ?? null;
    },
    enabled: !activeJobId,
    staleTime: 0,
  });

  // Initialize formulaOverride from live formula on first load.
  useEffect(() => {
    if (liveFormula && formulaOverride.length === 0) {
      setFormulaOverride(liveFormula.excludedSources);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveFormula?.excludedSources.join(",")]);

  // Any window/override edit invalidates the preview.
  const invalidatePreview = () => { setPreview(null); setPreviewError(null); };

  const refreshPreview = async () => {
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const fromDate = fromUtcInputValue(from);
      const toDate   = fromUtcInputValue(to);
      if (!fromDate || !toDate) throw new Error("Invalid window");
      const resp = await previewRepair({
        currency,
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        formula: { excludedSources: formulaOverride },
        retryEmpty,
      });
      setPreview(resp.preview);
    } catch (err) {
      setPreviewError(String((err as Error).message ?? err));
    } finally {
      setPreviewLoading(false);
    }
  };

  const onRunRepair = async () => {
    setStarting(true);
    try {
      const fromDate = fromUtcInputValue(from);
      const toDate   = fromUtcInputValue(to);
      if (!fromDate || !toDate) return;
      const { jobId } = await runRepair({
        currency,
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        formula: { excludedSources: formulaOverride },
        retryEmpty,
      });
      setActiveJobId(jobId);
      setShowConfirm(false);
      // After job completes, refresh dependent queries.
      qc.invalidateQueries({ queryKey: ["sources", "status"] });
    } catch (err) {
      setPreviewError(String((err as Error).message ?? err));
    } finally {
      setStarting(false);
    }
  };

  const fromDate = fromUtcInputValue(from);
  const toDate = fromUtcInputValue(to);
  const windowValid = fromDate && toDate && fromDate.getTime() < toDate.getTime();

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-gray-300">Repair Range</h2>
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-4">
        <p className="text-xs text-gray-500 leading-relaxed">
          Recompose composite candles over a historical window using a custom source formula.
          Live formula is not modified. Window is bounded by the 180-day archive retention and
          cannot extend into the current in-progress minute.
        </p>

        {/* Currency */}
        <div>
          <label className="text-xs text-gray-400 block mb-1">Currency</label>
          <select
            value={currency}
            onChange={(e) => { setCurrency(e.target.value); invalidatePreview(); }}
            className="bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500"
          >
            {currencyOptions.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {/* Window picker */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-400 block mb-1">From <span className="text-gray-500">(UTC)</span></label>
            <input
              type="datetime-local"
              value={from}
              min={dpMin}
              max={dpMax}
              onChange={(e) => { setFrom(e.target.value); invalidatePreview(); }}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500"
            />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">To <span className="text-gray-500">(UTC)</span></label>
            <input
              type="datetime-local"
              value={to}
              min={dpMin}
              max={dpMax}
              onChange={(e) => { setTo(e.target.value); invalidatePreview(); }}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500"
            />
          </div>
        </div>

        {/* Formula override */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-gray-400">Formula (for this operation only)</label>
            <div className="flex gap-2">
              <button
                onClick={() => {
                  if (liveFormula) setFormulaOverride(liveFormula.excludedSources);
                  invalidatePreview();
                }}
                className="text-xs text-gray-500 hover:text-gray-300"
              >
                Copy live formula
              </button>
              <button
                onClick={() => { setFormulaOverride([]); invalidatePreview(); }}
                className="text-xs text-gray-500 hover:text-gray-300"
              >
                Include all
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {sourceNames.map((s) => {
              const liveExcluded = liveFormula?.excludedSources.includes(s) ?? false;
              const overrideExcluded = formulaOverride.includes(s);
              return (
                <label key={s} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={!overrideExcluded}
                    onChange={() => {
                      setFormulaOverride((arr) =>
                        arr.includes(s) ? arr.filter((x) => x !== s) : [...arr, s],
                      );
                      invalidatePreview();
                    }}
                    className="accent-blue-600"
                  />
                  <span className={overrideExcluded ? "text-gray-500 capitalize line-through" : "text-gray-200 capitalize"}>
                    {s}
                  </span>
                  {liveExcluded && !overrideExcluded && (
                    <span className="text-xs text-yellow-400/70" title="Live formula excludes this">⚠</span>
                  )}
                </label>
              );
            })}
          </div>
        </div>

        {/* retryEmpty */}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={retryEmpty}
            onChange={(e) => { setRetryEmpty(e.target.checked); invalidatePreview(); }}
            className="accent-blue-600"
          />
          <span className="text-gray-300">
            Retry previously-empty minutes
            <span className="text-xs text-gray-500 ml-2">(deletes 'no_data' sentinels and refetches)</span>
          </span>
        </label>

        {/* Preview */}
        <div className="border-t border-gray-800 pt-3">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-gray-400">Preview</label>
            <button
              onClick={refreshPreview}
              disabled={previewLoading || !windowValid}
              className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 disabled:bg-gray-900 disabled:text-gray-600 text-gray-200 rounded transition-colors"
            >
              {previewLoading ? "Loading…" : "Refresh preview"}
            </button>
          </div>
          {preview ? (
            <div className="text-xs text-gray-400 space-y-1 font-mono">
              <div>Composite rows in window: {preview.compositeRowsInWindow.toLocaleString()}</div>
              <div>Will be recomposed: {preview.willBeRecomposed.toLocaleString()}</div>
              <div>Archive holes to fill: {preview.archiveHoles.toLocaleString()}</div>
              {Object.entries(preview.missingBySource).filter(([, n]) => n > 0).map(([k, n]) => (
                <div key={k} className="ml-4 text-gray-500">↳ {k}: {n.toLocaleString()}</div>
              ))}
              <div>Sentinels to retry: {preview.sentinelsToRetry.toLocaleString()}</div>
              <div>Estimated wall time: {formatDuration(preview.estimatedWallMs)}</div>
              <div>Live formula: <span className="text-green-400">unchanged</span></div>
            </div>
          ) : previewError ? (
            <div className="text-xs text-red-400">{previewError}</div>
          ) : (
            <div className="text-xs text-gray-600">No preview yet. Click Refresh preview to compute.</div>
          )}
        </div>

        {/* Run */}
        <div className="border-t border-gray-800 pt-3 flex items-center justify-between">
          <span className="text-xs text-gray-500">
            {preview && "Refresh preview after editing the window or formula"}
          </span>
          <button
            onClick={() => setShowConfirm(true)}
            disabled={!preview || !windowValid || !!activeJobId}
            className="px-4 py-1.5 text-sm bg-red-700 hover:bg-red-600 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded transition-colors"
          >
            Run repair
          </button>
        </div>
      </div>

      {/* Progress panel — appears once a job starts */}
      {activeJobId && (
        <RepairProgressPanel
          jobId={activeJobId}
          sourceNames={sourceNames}
          liveFormula={liveFormula}
          onDismiss={() => {
            setActiveJobId(null);
            qc.invalidateQueries({ queryKey: ["sources", "status"] });
          }}
          onReconcile={async (origFrom, origTo, origCurrency) => {
            // One-click "rerun with live formula" — same window + currency, no
            // override. Replaces the active job; the previous progress panel
            // unmounts and a fresh one mounts against the new jobId.
            try {
              const { jobId } = await runRepair({
                currency: origCurrency,
                from: origFrom,
                to: origTo,
                // No formula override → server defaults to getCurrentFormula().
              });
              setActiveJobId(jobId);
            } catch (err) {
              setPreviewError(String((err as Error).message ?? err));
            }
          }}
        />
      )}

      {/* Confirm modal */}
      {showConfirm && preview && fromDate && toDate && (
        <RepairConfirmModal
          preview={preview}
          from={fromDate}
          to={toDate}
          formulaOverride={formulaOverride}
          onConfirm={onRunRepair}
          onCancel={() => setShowConfirm(false)}
          running={starting}
        />
      )}
    </div>
  );
}
