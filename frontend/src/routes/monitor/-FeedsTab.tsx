import { useEffect, useRef, useState } from "react";
import {
  getCurrencies, updateCurrency, setCurrencyFeed, probeCurrency, getHealerStatus,
  getAdminActions, getExchangeConfig,
} from "@/lib/api";
import type { CurrencyInfo, AdminActionRow, ExchangeTuning } from "@/lib/api";
import { useCanModify } from "@/lib/access";
import InfoTip from "@/components/InfoTip";
import RepairRangePanel from "./-RepairRangePanel";

// Stable venue order for the feed table.
const SOURCES = ["binance", "bybit", "kraken", "coinbase", "bitfinex", "okx", "gate", "bitget"];

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Probed max history depth (minutes) → compact label. Depths in
// exchange_config.json are BTC-only today, so non-BTC currencies read "—".
function fmtDepth(min: number | null | undefined): string {
  if (min == null) return "—";
  const d = min / 1440;
  if (d < 2) return `${Math.round(min / 60)}h`;
  if (d < 730) return `${Math.round(d)}d`;
  return `${(d / 365).toFixed(1)}y`;
}

export default function FeedsTab() {
  // All feed mutations are PUT /currencies/* (requirePerm CAN_MODIFY) — disable
  // every control without that perm; the status table stays fully readable.
  const ro = !useCanModify();
  const [currencies, setCurrencies] = useState<CurrencyInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState<Set<string>>(new Set());
  // Signature of the active-backfill set; when it changes (a backfill starts or
  // finishes) we re-pull currencies so the latch value + updatedAt stay fresh.
  const prevBfSig = useRef("");

  // source → most-recent feed.enable/disable action for the selected currency
  // (from the admin_actions audit log), surfaced inline as "who changed it".
  const [feedHistory, setFeedHistory] = useState<Record<string, AdminActionRow>>({});

  // Editable number fields are CONTROLLED + auto-save (debounced) — no save
  // button, and no lost edits: they're seeded only when the selected currency
  // changes (below), so a background reload can't clobber an in-progress edit.
  const [minSrcInput, setMinSrcInput] = useState("");
  const [retInput, setRetInput] = useState("");
  const minSrcTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Per-venue probed depths (read-only) for the Max-depth column. Static-ish;
  // fetched once on mount.
  const [exConfig, setExConfig] = useState<Record<string, ExchangeTuning | null>>({});

  async function reload() {
    const r = await getCurrencies();
    setCurrencies(r.currencies);
    setSelected(prev => prev ?? (r.currencies.find(c => c.code !== "BTC")?.code ?? r.currencies[0]?.code ?? null));
  }

  async function loadHistory(code: string) {
    try {
      const r = await getAdminActions(100, undefined, `${code}/`);
      const map: Record<string, AdminActionRow> = {};
      for (const a of r.actions) { // DESC order → first seen per source is latest
        const src = a.target?.split("/")[1];
        if (src && !map[src] && a.action.startsWith("feed.")) map[src] = a;
      }
      setFeedHistory(map);
    } catch { setFeedHistory({}); }
  }

  useEffect(() => { reload().catch(e => flash(String(e))); }, []);
  useEffect(() => { getExchangeConfig().then(r => setExConfig(r.config)).catch(() => {}); }, []);
  useEffect(() => { if (selected) loadHistory(selected); }, [selected]);

  // Seed the editable fields from the SELECTED currency only — keyed on
  // `selected`, NOT `currencies`, so the every-5s healer reload doesn't reset a
  // field the operator is mid-edit.
  useEffect(() => {
    const c = currencies.find(x => x.code === selected);
    setMinSrcInput(c?.minSources != null ? String(c.minSources) : "");
    setRetInput(c?.sourceRetentionDays != null ? String(c.sourceRetentionDays) : "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // Poll healer status to surface which currency is actively backfilling. The
  // runBackfill activity is tagged with { currency }.
  useEffect(() => {
    let alive = true;
    async function tick() {
      try {
        const r = await getHealerStatus();
        if (!alive) return;
        const s = new Set<string>();
        for (const a of r.activities) {
          if (a.name === "runBackfill" && typeof a.meta?.currency === "string") {
            s.add(a.meta.currency as string);
          }
        }
        setBackfilling(s);
        // On any start/finish transition, refresh currencies so the latch flips
        // (and its updatedAt) show up without a manual action.
        const sig = [...s].sort().join(",");
        if (sig !== prevBfSig.current) {
          prevBfSig.current = sig;
          reload().catch(() => {});
        }
      } catch { /* transient */ }
    }
    tick();
    const id = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  function flash(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 6000);
  }

  async function withBusy(fn: () => Promise<void>) {
    setBusy(true);
    try { await fn(); } catch (e) { flash(String(e)); } finally { setBusy(false); }
  }

  const cur = currencies.find(c => c.code === selected) ?? null;

  async function toggleEnabled(code: string, enabled: boolean) {
    await withBusy(async () => {
      const r = await updateCurrency(code, { enabled });
      if (enabled && r.backfill) {
        flash(r.backfill === "started"
          ? `${code} enabled — backfill started`
          : `${code} enabled — backfill deferred (queued behind an in-progress backfill)`);
      } else {
        flash(`${code} ${enabled ? "enabled" : "disabled"}`);
      }
      await reload();
    });
  }

  async function togglePremium(code: string, premiumEnabled: boolean) {
    await withBusy(async () => { await updateCurrency(code, { premiumEnabled }); await reload(); });
  }

  async function toggleFlatFill(code: string, flatFillEmpty: boolean) {
    await withBusy(async () => { await updateCurrency(code, { flatFillEmpty }); await reload(); });
  }

  async function changeMinSources(code: string, value: string) {
    const n = value.trim() === "" ? null : parseInt(value, 10);
    if (n !== null && (!Number.isInteger(n) || n < 1)) { flash("min sources must be a positive integer"); return; }
    await withBusy(async () => { await updateCurrency(code, { minSources: n }); await reload(); });
  }

  async function changeSourceRetention(code: string, value: string) {
    const n = value.trim() === "" ? null : parseInt(value, 10);
    if (n !== null && (!Number.isInteger(n) || n < 1)) { flash("retention must be a positive integer (days)"); return; }
    await withBusy(async () => { await updateCurrency(code, { sourceRetentionDays: n }); await reload(); });
  }

  async function toggleFeed(code: string, source: string, enabled: boolean) {
    await withBusy(async () => { await setCurrencyFeed(code, source, enabled); await reload(); await loadHistory(code); });
  }

  async function probe(code: string) {
    flash(`probing ${code}…`);
    await withBusy(async () => {
      const r = await probeCurrency(code);
      const avail = r.results.filter(x => x.available).map(x => x.source);
      flash(`${code} probe: ${avail.length}/${r.results.length} available (${avail.join(", ") || "none"})`);
      await reload();
    });
  }

  return (
    <div className="p-4 text-sm">
      {toast && (
        <div className="mb-3 px-3 py-2 rounded bg-gray-800 border border-gray-700 text-gray-200 text-xs">{toast}</div>
      )}

      {ro && (
        <div className="mb-3 px-3 py-2 rounded bg-gray-900 border border-gray-800 text-gray-500 text-xs">
          🔒 Read-only — feed configuration requires modify access.
        </div>
      )}

      {/* Per-currency tab group */}
      <div className="flex gap-1 border-b border-gray-800 mb-4">
        {currencies.map(c => (
          <button
            key={c.code}
            onClick={() => setSelected(c.code)}
            className={`px-3 py-2 text-xs border-b-2 transition-colors ${
              selected === c.code ? "border-blue-500 text-gray-50" : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            {c.code}
            {c.enabled && <span className="ml-1.5 w-1.5 h-1.5 inline-block rounded-full bg-green-400 align-middle" />}
            {backfilling.has(c.code) && <span className="ml-1 text-amber-400">⋯</span>}
          </button>
        ))}
      </div>

      {cur && (
        <div className="space-y-5 max-w-3xl">
          <div className="flex items-center gap-3">
            <h2 className="text-lg text-gray-50 font-medium">
              {cur.displayName} <span className="text-gray-500 text-sm">({cur.code})</span>
            </h2>
            {backfilling.has(cur.code) && (
              <span className="px-2 py-0.5 rounded bg-amber-900/40 text-amber-300 text-xs">backfilling…</span>
            )}
          </div>

          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={cur.enabled}
              disabled={ro || busy || cur.code === "BTC"}
              onChange={e => toggleEnabled(cur.code, e.target.checked)}
            />
            <span className="text-gray-200 flex items-center gap-1">Chain enabled <InfoTip id="feeds.chainEnabled" /></span>
            {cur.code === "BTC" && <span className="text-gray-600 text-xs">(BTC is always on)</span>}
          </label>

          <div>
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={cur.premiumEnabled}
                disabled={ro || busy}
                onChange={e => togglePremium(cur.code, e.target.checked)}
              />
              <span className="text-gray-200 flex items-center gap-1">Premium-offset correction <InfoTip id="feeds.premiumOffset" /></span>
            </label>
            <p className="text-gray-600 text-xs mt-1 ml-7">
              Inert until the token has ≥3 accepted venues — below that the plain pegged medians are used.
            </p>
          </div>

          <div>
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={cur.flatFillEmpty}
                disabled={ro || busy}
                onChange={e => toggleFlatFill(cur.code, e.target.checked)}
              />
              <span className="text-gray-200 flex items-center gap-1">Flat-fill empty minutes <InfoTip id="feeds.flatFillEmpty" /></span>
            </label>
            <p className="text-gray-600 text-xs mt-1 ml-7">
              On for thin tokens — a no-trade minute carries the previous close (volume 0) instead of striking the venue.
            </p>
          </div>

          <label className="flex items-center gap-3">
            <span className="text-gray-200 flex items-center gap-1">Min sources override <InfoTip id="feeds.minSources" /></span>
            <input
              type="number"
              min={1}
              value={minSrcInput}
              placeholder="(global default)"
              disabled={ro}
              onChange={e => {
                const v = e.target.value;
                setMinSrcInput(v);
                if (minSrcTimer.current) clearTimeout(minSrcTimer.current);
                minSrcTimer.current = setTimeout(() => changeMinSources(cur.code, v), 700);
              }}
              className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200 w-36 text-xs"
            />
          </label>

          {/* Source retention: per-currency archive depth + days-stored preview */}
          <div>
            <label className="flex items-center gap-3">
              <span className="text-gray-200 flex items-center gap-1">Source retention (days) <InfoTip id="feeds.sourceRetention" /></span>
              <input
                type="number"
                min={1}
                value={retInput}
                placeholder="(global default 180)"
                disabled={ro}
                onChange={e => {
                  const v = e.target.value;
                  setRetInput(v);
                  if (retTimer.current) clearTimeout(retTimer.current);
                  retTimer.current = setTimeout(() => changeSourceRetention(cur.code, v), 700);
                }}
                className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-gray-200 w-40 text-xs"
              />
            </label>
            <p className="text-gray-600 text-xs mt-1 ml-0 flex items-center gap-1">
              <InfoTip id="feeds.daysStored" />
              {(() => {
                const stored = cur.sourceDaysStored;
                const keep = cur.sourceRetentionDays ?? 180;
                const drop = Math.max(0, stored - keep);
                return `${stored} day(s) of source stored; keeping ${keep} → next prune drops ${drop} day(s). Composite index kept forever.`;
              })()}
            </p>
          </div>

          <div className="text-xs text-gray-500 flex items-center gap-1">
            <InfoTip id="feeds.inception" /> Inception:{" "}
            {cur.inceptionTs
              ? new Date(cur.inceptionTs).toISOString().slice(0, 10)
              : "not probed (gap/backfill floor = now − 90d)"}
          </div>

          {/* Backfill sync status — derived from the live healer activity +
              the per-currency backfillComplete:<code> latch. */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            <span className="text-gray-400">Sync:</span>
            <span className={
              backfilling.has(cur.code) ? "text-amber-300"
              : cur.backfill.complete ? "text-green-400"
              : "text-gray-400"
            }>
              {backfilling.has(cur.code) ? "backfilling…" : cur.backfill.complete ? "synced" : "pending"}
            </span>
            <span className="text-gray-600 font-mono">backfillComplete:{cur.code} = {String(cur.backfill.complete)}</span>
            {cur.backfill.updatedAt && (
              <span className="text-gray-600">· last updated {new Date(cur.backfill.updatedAt).toLocaleString()}</span>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-gray-300 flex items-center gap-1">Exchange feeds <span className="text-gray-600 text-xs">(LIVE collection)</span></h3>
              <span className="inline-flex items-center gap-1">
                <button
                  onClick={() => probe(cur.code)}
                  disabled={ro || busy}
                  className="px-2 py-1 text-xs rounded bg-gray-800 hover:bg-gray-700 text-gray-200 border border-gray-700 disabled:opacity-50"
                >
                  Re-probe availability
                </button>
                <InfoTip id="feeds.reprobe" />
              </span>
            </div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 text-left">
                  <th className="py-1 font-normal">Venue</th>
                  <th className="font-normal">Symbol</th>
                  <th className="font-normal"><span className="inline-flex items-center gap-1">Availability <InfoTip id="feeds.col.availability" /></span></th>
                  <th className="font-normal"><span className="inline-flex items-center gap-1">Max depth <InfoTip id="feeds.col.maxdepth" /></span></th>
                  <th className="font-normal"><span className="inline-flex items-center gap-1">Sync <InfoTip id="feeds.col.sync" /></span></th>
                  <th className="font-normal">Last change</th>
                </tr>
              </thead>
              <tbody>
                {SOURCES.map(src => {
                  const f = cur.feeds[src];
                  if (!f) return null;
                  return (
                    <tr key={src} className="border-t border-gray-900">
                      <td className="py-1.5 text-gray-300">{src}</td>
                      <td className="text-gray-500 font-mono">{f.symbol}</td>
                      <td>
                        {f.available
                          ? <span className="text-green-400">available</span>
                          : <span className="text-gray-600">unavailable</span>}
                      </td>
                      <td className="text-gray-400 font-mono">{fmtDepth(exConfig[src]?.candle_depth_minutes?.[cur.code])}</td>
                      <td>
                        <input
                          type="checkbox"
                          checked={f.enabled}
                          disabled={ro || busy || !f.available}
                          onChange={e => toggleFeed(cur.code, src, e.target.checked)}
                        />
                      </td>
                      <td className="text-gray-500">
                        {feedHistory[src]
                          ? <span>{feedHistory[src].action === "feed.enable" ? "enabled" : "disabled"} by{" "}
                              <span className="text-gray-400">{feedHistory[src].actor}</span> · {ago(feedHistory[src].createdAt)}</span>
                          : <span className="text-gray-700">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p className="text-gray-600 text-xs mt-2">
              Unavailable venues can't be synced until a probe finds the pair. Availability is host-dependent
              (e.g. okx is geo-blocked from some hosts).
            </p>
          </div>

          {/* Repair Range — collapsible disclosure below the LIVE feeds. Currency
              is this tab's selected token (no dropdown); key remounts per token. */}
          {!ro && (
            <details className="border-t border-gray-800 pt-4">
              <summary className="cursor-pointer text-gray-300 text-sm select-none">
                Repair Range <span className="text-gray-600">— historical fill / recompose for {cur.code}</span>
              </summary>
              <div className="mt-3">
                <RepairRangePanel key={cur.code} currency={cur.code} sourceNames={SOURCES} />
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
