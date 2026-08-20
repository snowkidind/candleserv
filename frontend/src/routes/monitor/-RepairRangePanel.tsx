import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  previewRepair, runRepair, getRepairJob, getActiveRepairJob, cancelRepairJob,
  getFormulaVersions, addFormulaVersion, deleteFormulaVersion, getExchangeConfig,
  type RepairPreview, type RepairJobState,
} from "@/lib/api";
import InfoTip from "@/components/InfoTip";

// ── helpers ──────────────────────────────────────────────────────────────────
// datetime-local has no timezone; we populate/parse it as UTC (backend is UTC).
function toUtcInputValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}
function fromUtcInputValue(s: string): Date | null {
  if (!s) return null;
  const d = new Date(`${s}:00Z`);
  return isNaN(d.getTime()) ? null : d;
}
function fmtUtc(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

type RunMode = "full" | "recompose";

// ── confirm modal ────────────────────────────────────────────────────────────
function RepairConfirmModal({
  preview, from, to, mode, suspendGlobal, onConfirm, onCancel, running,
}: {
  preview: RepairPreview; from: Date; to: Date; mode: RunMode; suspendGlobal: boolean;
  onConfirm: () => void; onCancel: () => void; running: boolean;
}) {
  const [typed, setTyped] = useState("");
  const days = Math.round((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-gray-900 border border-gray-700 rounded-lg max-w-lg w-full p-5">
        <h3 className="text-lg font-medium text-gray-100 mb-3">
          {mode === "recompose" ? "Confirm recompose-only" : "Confirm repair operation"}
        </h3>
        <div className="text-sm text-gray-300 space-y-1.5">
          <div>Window: <span className="font-mono">{fmtUtc(from)} → {fmtUtc(to)}</span> ({days} days, {preview.willBeRecomposed.toLocaleString()} minutes)</div>
          <div>Mode: <span className="font-mono">{mode === "recompose" ? "recompose-only (no exchange fetches)" : "fetch → stables → recompose"}</span></div>
          {mode === "full" && <div>Archive holes to fill: <span className="font-mono">{preview.archiveHoles.toLocaleString()}</span></div>}
        </div>
        <div className="mt-4 text-xs text-yellow-400/80 leading-relaxed">
          ⚠ This rewrites up to {preview.willBeRecomposed.toLocaleString()} rows in candles_1m using the formula in
          effect at each minute (this token's formula timeline). The previous composite values will be lost.
          {suspendGlobal
            ? " Candle-read REST returns 503 for ALL currencies during the run (shared pegs)."
            : ` Candle-read REST for this currency returns 503 for the duration (~${formatDuration(preview.estimatedWallMs)}).`}
        </div>
        <div className="mt-4">
          <label className="text-xs text-gray-400 block mb-1">Type <code className="font-mono text-gray-200">repair</code> to confirm:</label>
          <input
            value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus
            className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500"
          />
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onCancel} disabled={running} className="px-4 py-2 text-sm text-gray-400 hover:text-gray-200">Cancel</button>
          <button
            onClick={onConfirm} disabled={running || typed !== "repair"}
            className="px-4 py-2 text-sm bg-red-700 hover:bg-red-600 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded transition-colors"
          >
            {running ? "Starting…" : mode === "recompose" ? "Recompose" : "Run repair"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── progress panel ───────────────────────────────────────────────────────────
function RepairProgressPanel({ jobId, onDismiss }: { jobId: string; onDismiss: () => void }) {
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
  const cancel = async () => { setCancelling(true); try { await cancelRepairJob(jobId); } finally { setCancelling(false); } };

  if (!data) return <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 text-sm text-gray-500">Starting repair job…</div>;

  const terminal = data.state === "done" || data.state === "failed" || data.state === "cancelled";
  const runs = (step: "fetch" | "stables" | "recompose") => data.steps?.includes(step) ?? true;
  const startedAt = new Date(data.startedAt);
  const elapsed = (data.finishedAt ? new Date(data.finishedAt).getTime() : Date.now()) - startedAt.getTime();

  return (
    <div className="bg-gray-900 border border-gray-700 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-200">
          {data.state === "done" ? "Repair complete"
          : data.state === "failed" ? "Repair failed"
          : data.state === "cancelled" ? "Repair cancelled" : "Repair in progress"}
        </h3>
        <span className="text-xs text-gray-500 font-mono">{data.currency} · job {data.jobId.slice(0, 8)}… · steps [{(data.steps ?? []).join(",")}]</span>
      </div>
      <div className="text-xs text-gray-500 mb-3">State: <span className="text-gray-200 font-mono">{data.state}</span>{" · "}elapsed {formatDuration(elapsed)}</div>

      {runs("fetch") && (
        <div className="mb-3 text-sm">
          <div className="text-gray-300 mb-1 flex items-center gap-1">
            Step 1: fetch <InfoTip id="step.fetch" />
            {data.ensure ? <span className="text-gray-500 ml-2 text-xs">
              ({data.ensure.rowsFetched.toLocaleString()} fetched, {data.ensure.sentinelsWritten.toLocaleString()} sentinels, {data.ensure.skipped.toLocaleString()} skipped, {data.ensure.tilesSkipped.toLocaleString()} tiles skipped)
            </span> : data.state === "fetching" ? <span className="text-blue-400 ml-2 text-xs">running…</span> : null}
          </div>
          {data.ensure && Object.keys(data.ensure.failedPerSource).length > 0 && (
            <div className="text-xs text-red-400 mt-1">Failed by source: {Object.entries(data.ensure.failedPerSource).map(([k, v]) => `${k}: ${v}`).join(", ")}</div>
          )}
        </div>
      )}
      {runs("stables") && (
        <div className="mb-3 text-sm">
          <div className="text-gray-300 mb-1 flex items-center gap-1">
            Step 2: stables <InfoTip id="step.stables" />
            {data.backfill ? <span className="text-gray-500 ml-2 text-xs">
              ({data.backfill.rowsInserted.toLocaleString()} inserted, {data.backfill.rowsSkippedNoBtc.toLocaleString()} skipped no-btc)
            </span> : data.state === "stables" ? <span className="text-blue-400 ml-2 text-xs">running…</span> : null}
          </div>
          {data.backfill && Object.keys(data.backfill.failedPerSource).length > 0 && (
            <div className="text-xs text-red-400 mt-1">Failed by source: {Object.entries(data.backfill.failedPerSource).map(([k, v]) => `${k}: ${v}`).join(", ")}</div>
          )}
        </div>
      )}
      {runs("recompose") && (
        <div className="mb-4 text-sm">
          <div className="text-gray-300 mb-1 flex items-center gap-1">
            Step 3: recompose <InfoTip id="step.recompose" />
            {data.recompose ? <span className="text-gray-500 ml-2 text-xs">
              ({data.recompose.recomposed.toLocaleString()} recomposed, {data.recompose.skippedNoSources.toLocaleString()} skipped no-sources)
            </span> : data.state === "recomposing" ? <span className="text-blue-400 ml-2 text-xs">running…</span> : null}
          </div>
        </div>
      )}

      {data.state === "done" && data.result && (
        <div className="text-sm text-green-400">✓ {data.result.rowsWritten.toLocaleString()} composite rows recomposed · {data.result.archiveRowsFetched.toLocaleString()} archive rows fetched</div>
      )}
      {data.state === "failed" && data.error && (
        <div className="text-sm text-red-400 bg-red-900/20 border border-red-800 rounded p-2 mt-2">{data.error}</div>
      )}

      <div className="flex justify-end gap-2 mt-4">
        {!terminal && (
          <span className="inline-flex items-center gap-1">
            <button onClick={cancel} disabled={cancelling} className="px-3 py-1.5 text-xs bg-yellow-700 hover:bg-yellow-600 text-white rounded transition-colors">
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
            <InfoTip id="repair.cancel" />
          </span>
        )}
        {terminal && (
          <button
            onClick={() => { if (data.state === "done") window.location.reload(); else onDismiss(); }}
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
// `currency` is driven by the Feeds tab's selected currency sub-tab — no
// independent dropdown. Remounted by key={currency} in FeedsTab, so
// per-currency state (preview, formula timeline, active job) starts clean.
export default function RepairRangePanel({ currency, sourceNames }: { currency: string; sourceNames: string[] }) {
  const qc = useQueryClient();

  const [from, setFrom] = useState<string>(() => toUtcInputValue(new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)));
  const [to, setTo] = useState<string>(() => toUtcInputValue(new Date(Math.floor(Date.now() / 60000) * 60000 - 60000)));
  const dpMin = toUtcInputValue(new Date(Date.now() - 180 * 24 * 60 * 60 * 1000));
  const dpMax = toUtcInputValue(new Date(Math.floor(Date.now() / 60000) * 60000 - 60000));

  // Repair feed selection → formula timeline.
  const { data: versionsResp } = useQuery({ queryKey: ["formula-versions", currency], queryFn: () => getFormulaVersions(currency) });
  const { data: exConfigResp } = useQuery({ queryKey: ["exchange-config"], queryFn: getExchangeConfig });
  const [venueSel, setVenueSel] = useState<string[]>(sourceNames);
  const [versionReason, setVersionReason] = useState("");
  const [savingVersion, setSavingVersion] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Existing-minute toggles + suspend-global.
  const [repairExistingTokenMinutes, setRepairExistingTokenMinutes] = useState(false);
  const [repairExistingStableMinutes, setRepairExistingStableMinutes] = useState(false);
  const [suspendGlobal, setSuspendGlobal] = useState(false);

  const [preview, setPreview] = useState<RepairPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmMode, setConfirmMode] = useState<RunMode | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Resume an in-flight job after navigating away/back.
  useQuery({
    queryKey: ["repair", "current"],
    queryFn: async () => { const job = await getActiveRepairJob(); if (job && !activeJobId) setActiveJobId(job.jobId); return job ?? null; },
    enabled: !activeJobId, staleTime: 0,
  });

  const invalidatePreview = () => { setPreview(null); setError(null); };
  const fromDate = fromUtcInputValue(from);
  const toDate = fromUtcInputValue(to);
  const windowValid = !!(fromDate && toDate && fromDate.getTime() < toDate.getTime());

  const toggleVenue = (s: string) =>
    setVenueSel((arr) => arr.includes(s) ? arr.filter((x) => x !== s) : [...arr, s]);

  const saveVersion = async () => {
    if (!fromDate) { setError("set a valid From date first"); return; }
    if (venueSel.length === 0) { setError("select at least one venue"); return; }
    setSavingVersion(true); setError(null);
    try {
      await addFormulaVersion(currency, fromDate.toISOString(), venueSel, versionReason || undefined);
      setVersionReason("");
      qc.invalidateQueries({ queryKey: ["formula-versions", currency] });
    } catch (e) { setError(String((e as Error).message ?? e)); }
    finally { setSavingVersion(false); }
  };

  const removeVersion = async (effectiveFrom: string) => {
    try { await deleteFormulaVersion(currency, effectiveFrom); qc.invalidateQueries({ queryKey: ["formula-versions", currency] }); }
    catch (e) { setError(String((e as Error).message ?? e)); }
  };

  const refreshPreview = async () => {
    if (!fromDate || !toDate) { setError("Invalid window"); return; }
    setPreviewLoading(true); setError(null);
    try {
      const resp = await previewRepair({
        currency, from: fromDate.toISOString(), to: toDate.toISOString(),
        repairExistingTokenMinutes, repairExistingStableMinutes,
      });
      setPreview(resp.preview);
    } catch (e) { setError(String((e as Error).message ?? e)); }
    finally { setPreviewLoading(false); }
  };

  const onRun = async () => {
    if (!fromDate || !toDate || !confirmMode) return;
    setStarting(true);
    try {
      const { jobId } = await runRepair({
        currency, from: fromDate.toISOString(), to: toDate.toISOString(),
        steps: confirmMode === "recompose" ? ["recompose"] : undefined,
        repairExistingTokenMinutes, repairExistingStableMinutes,
        suspendGlobal: repairExistingStableMinutes && suspendGlobal,
      });
      setActiveJobId(jobId);
      setConfirmMode(null);
      qc.invalidateQueries({ queryKey: ["sources", "status"] });
    } catch (e) { setError(String((e as Error).message ?? e)); }
    finally { setStarting(false); }
  };

  const versions = versionsResp?.versions ?? [];

  return (
    <div className="space-y-3">
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-4">
        <p className="text-xs text-gray-500 leading-relaxed">
          Repair fills/overwrites a historical window for <span className="text-gray-300 font-mono">{currency}</span> and
          re-derives the composite using this token's formula timeline as of each minute. The live formula and live
          feeds are not affected.
        </p>

        {/* Window */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-gray-400 mb-1 flex items-center gap-1">From <span className="text-gray-500">(UTC)</span> <InfoTip id="repair.window" /></label>
            <input type="datetime-local" value={from} min={dpMin} max={dpMax}
              onChange={(e) => { setFrom(e.target.value); invalidatePreview(); }}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500" />
          </div>
          <div>
            <label className="text-xs text-gray-400 mb-1 flex items-center gap-1">To <span className="text-gray-500">(UTC)</span></label>
            <input type="datetime-local" value={to} min={dpMin} max={dpMax}
              onChange={(e) => { setTo(e.target.value); invalidatePreview(); }}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500" />
          </div>
        </div>

        {/* Repair feed selection → formula timeline */}
        <div className="border-t border-gray-800 pt-3">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-gray-400 flex items-center gap-1">Repair feed selection <InfoTip id="repair.feedEnable" /></label>
            <div className="flex gap-2">
              <button onClick={() => setVenueSel(sourceNames)} className="text-xs text-gray-500 hover:text-gray-300">All</button>
              <button onClick={() => setVenueSel([])} className="text-xs text-gray-500 hover:text-gray-300">None</button>
            </div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {sourceNames.map((s) => (
              <label key={s} className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={venueSel.includes(s)} onChange={() => toggleVenue(s)} className="accent-blue-600" />
                <span className={venueSel.includes(s) ? "text-gray-200 capitalize" : "text-gray-500 capitalize line-through"}>{s}</span>
              </label>
            ))}
          </div>
          <div className="flex items-center gap-2 mt-3">
            <input
              value={versionReason} onChange={(e) => setVersionReason(e.target.value)} placeholder="reason (optional)"
              className="flex-1 bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 outline-none focus:border-blue-500"
            />
            <button
              onClick={saveVersion} disabled={savingVersion || !windowValid || venueSel.length === 0}
              className="px-3 py-1 text-xs bg-blue-700 hover:bg-blue-600 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded transition-colors"
            >
              {savingVersion ? "Saving…" : "Save as timeline version (effective from From)"}
            </button>
            <InfoTip id="repair.saveVersion" />
          </div>
          {/* Current timeline */}
          <div className="mt-3 text-xs">
            <div className="text-gray-500 mb-1">Formula timeline ({currency}), what each minute composes from:</div>
            {versions.length === 0 ? (
              <div className="text-gray-600">No versions yet. Repair lazily seeds an epoch baseline from the current live feeds on first run.</div>
            ) : (
              <div className="space-y-1 font-mono">
                {versions.map((v) => (
                  <div key={v.effectiveFrom} className="flex items-center gap-2 text-gray-400">
                    <span className="text-gray-300">{v.effectiveFrom.replace("T", " ").slice(0, 16)}Z</span>
                    <span className="text-gray-500">→ [{v.sources.join(", ")}]</span>
                    {v.by && <span className="text-gray-600">· {v.by}{v.reason ? ` (${v.reason})` : ""}</span>}
                    <button onClick={() => removeVersion(v.effectiveFrom)} className="text-red-500/70 hover:text-red-400 ml-1">✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Advanced: per-venue tuning (read-only) */}
        <div className="border-t border-gray-800 pt-3">
          <button onClick={() => setShowAdvanced((v) => !v)} className="text-xs text-gray-400 hover:text-gray-200">
            {showAdvanced ? "▾" : "▸"} Per-venue tuning &amp; depth (read-only)
          </button>
          {showAdvanced && exConfigResp && (
            <table className="w-full text-xs mt-2 font-mono">
              <thead><tr className="text-gray-500 text-left">
                <th className="font-normal py-1">Venue</th>
                <th className="font-normal flex items-center gap-1">tile <InfoTip id="repair.tileSize" /></th>
                <th className="font-normal">throttle <InfoTip id="repair.throttle" /></th>
                <th className="font-normal">timeout <InfoTip id="repair.timeout" /></th>
                <th className="font-normal">candle depth (d)</th>
                <th className="font-normal">peg depth (d)</th>
              </tr></thead>
              <tbody>
                {sourceNames.map((s) => {
                  const t = exConfigResp.config[s];
                  if (!t) return null;
                  const cd = t.candle_depth_minutes?.[currency];
                  return (
                    <tr key={s} className="border-t border-gray-900 text-gray-400">
                      <td className="py-1 text-gray-300">{s}</td>
                      <td>{t.tile_size}</td>
                      <td>{(t.throttle_ms / 1000).toFixed(0)}s</td>
                      <td>{(t.timeout_ms / 1000).toFixed(0)}s</td>
                      <td>{cd != null ? Math.floor(cd / 1440) : "—"}</td>
                      <td>{t.peg_depth_minutes != null ? Math.floor(t.peg_depth_minutes / 1440) : "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Existing-minute toggles */}
        <div className="border-t border-gray-800 pt-3 space-y-2">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={repairExistingTokenMinutes} onChange={(e) => { setRepairExistingTokenMinutes(e.target.checked); invalidatePreview(); }} className="accent-blue-600" />
            <span className="text-gray-300 flex items-center gap-1">Repair Existing Token Minutes <InfoTip id="repair.existingToken" /></span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={repairExistingStableMinutes} onChange={(e) => { setRepairExistingStableMinutes(e.target.checked); if (!e.target.checked) setSuspendGlobal(false); invalidatePreview(); }} className="accent-blue-600" />
            <span className="text-gray-300 flex items-center gap-1">Repair Existing Stable Minutes <InfoTip id="repair.existingStable" /></span>
          </label>
          {repairExistingStableMinutes && (
            <label className="flex items-center gap-2 text-sm ml-7">
              <input type="checkbox" checked={suspendGlobal} onChange={(e) => setSuspendGlobal(e.target.checked)} className="accent-blue-600" />
              <span className="text-amber-300/90 flex items-center gap-1">Suspend REST globally <InfoTip id="repair.suspendGlobal" /></span>
            </label>
          )}
        </div>

        {/* Preview */}
        <div className="border-t border-gray-800 pt-3">
          <div className="flex items-center justify-between mb-2">
            <label className="text-xs text-gray-400 flex items-center gap-1">Preview <InfoTip id="repair.preview" /></label>
            <button onClick={refreshPreview} disabled={previewLoading || !windowValid}
              className="px-3 py-1 text-xs bg-gray-800 hover:bg-gray-700 disabled:bg-gray-900 disabled:text-gray-600 text-gray-200 rounded transition-colors">
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
              <div>Estimated wall time: {formatDuration(preview.estimatedWallMs)}</div>
            </div>
          ) : error ? <div className="text-xs text-red-400">{error}</div>
          : <div className="text-xs text-gray-600">No preview yet. Click Refresh preview to compute.</div>}
        </div>

        {/* Run */}
        <div className="border-t border-gray-800 pt-3 flex items-center justify-end gap-2">
          <span className="inline-flex items-center gap-1">
            <button
              onClick={() => setConfirmMode("recompose")}
              disabled={!windowValid || !!activeJobId}
              className="px-4 py-1.5 text-sm bg-gray-700 hover:bg-gray-600 disabled:bg-gray-800 disabled:text-gray-600 text-gray-100 rounded transition-colors"
            >
              Recompose only
            </button>
            <InfoTip id="repair.recomposeOnly" />
          </span>
          <button
            onClick={() => setConfirmMode("full")}
            disabled={!preview || !windowValid || !!activeJobId}
            className="px-4 py-1.5 text-sm bg-red-700 hover:bg-red-600 disabled:bg-gray-800 disabled:text-gray-600 text-white rounded transition-colors"
          >
            Run repair
          </button>
        </div>
      </div>

      {activeJobId && (
        <RepairProgressPanel jobId={activeJobId} onDismiss={() => { setActiveJobId(null); qc.invalidateQueries({ queryKey: ["sources", "status"] }); }} />
      )}

      {confirmMode && preview && fromDate && toDate && (
        <RepairConfirmModal
          preview={preview} from={fromDate} to={toDate} mode={confirmMode}
          suspendGlobal={repairExistingStableMinutes && suspendGlobal}
          onConfirm={onRun} onCancel={() => setConfirmMode(null)} running={starting}
        />
      )}
      {confirmMode === "recompose" && !preview && fromDate && toDate && (
        <RepairConfirmModal
          preview={{ compositeRowsInWindow: 0, willBeRecomposed: Math.max(0, Math.floor((toDate.getTime() - fromDate.getTime()) / 60000)), archiveHoles: 0, missingBySource: {}, sentinelsToRetry: 0, estimatedWallMs: 0, liveFormulaUnchanged: true }}
          from={fromDate} to={toDate} mode="recompose" suspendGlobal={false}
          onConfirm={onRun} onCancel={() => setConfirmMode(null)} running={starting}
        />
      )}
    </div>
  );
}
