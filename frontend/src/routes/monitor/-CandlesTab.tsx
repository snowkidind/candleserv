import { useEffect, useRef, useState } from "react";
import { createChart, IChartApi, ISeriesApi, CandlestickData, HistogramData, WhitespaceData, LineData, Time, LogicalRange, MouseEventParams } from "lightweight-charts";
import type { Candle } from "@/lib/api";
import { getCandlesBefore, getGaps, getErrors, getCurrencies, getSourceCandles, type SourceCandleRow } from "@/lib/api";
import { useCandleStream } from "@/lib/CandleStreamContext";

// Short venue labels for the per-source hover popup (BN=binance, BFX=bitfinex …).
const SOURCE_ABBR: Record<string, string> = {
  binance: "BN", bybit: "BY", kraken: "KR", coinbase: "CB",
  bitfinex: "BFX", okx: "OKX", gate: "GT", bitget: "BG",
};
const srcAbbr = (s: string) => SOURCE_ABBR[s] ?? s.slice(0, 3).toUpperCase();
const fmtPrice = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
import { getTheme, type Theme } from "@/lib/theme";

// The chart is a <canvas> counter-inverted out of the global light-mode CSS
// invert, so it must carry its own palette rather than ride the page filter.
const CHART_THEME: Record<Theme, { background: string; text: string; grid: string; border: string }> = {
  dark:  { background: "#030712", text: "#9ca3af", grid: "#111827", border: "#1f2937" },
  dim:   { background: "#22272e", text: "#768390", grid: "#2d333b", border: "#444c56" },
  light: { background: "#ffffff", text: "#374151", grid: "#e5e7eb", border: "#d1d5db" },
};

function applyChartTheme(chart: IChartApi, t: Theme): void {
  const c = CHART_THEME[t];
  chart.applyOptions({
    layout: { background: { color: c.background }, textColor: c.text },
    grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    timeScale: { borderColor: c.border },
    rightPriceScale: { borderColor: c.border },
  });
}

const TFS = ["1m","5m","10m","15m","1h","2h","4h","6h","12h","1d","3d","7d","30d"];
const HISTORY_FETCH_LIMIT = 500;
const HISTORY_TRIGGER_BARS = 50; // fetch when scrolled within 50 bars of the left edge

const TF_SECONDS: Record<string, number> = {
  "1m": 60, "5m": 300, "10m": 600, "15m": 900,
  "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600,
  "12h": 43200, "1d": 86400, "3d": 259200, "7d": 604800, "30d": 2592000,
};

// Multi-exchange confidence averaging was introduced 2026-02-21T17:52:00Z.
// Candles before this date carry a confidence value that isn't meaningful for opacity.
const CONFIDENCE_CUTOFF_MS = new Date("2026-02-21T17:52:00Z").getTime();

// ---------------------------------------------------------------------------
// SMA / EMA — ported from ssModelJs/src/pipeline.ts
// ---------------------------------------------------------------------------

function fillSmaSeries(signal: number[], length: number): number[] {
  const n = signal.length;
  const out = new Array<number>(n).fill(NaN);
  if (length === 0 || n < length) return out;
  for (let i = length - 1; i < n; i++) {
    let sum = 0;
    for (let j = i + 1 - length; j <= i; j++) sum += signal[j];
    out[i] = sum / length;
  }
  return out;
}

function fillEmaSeries(signal: number[], length: number): number[] {
  const n = signal.length;
  const out = new Array<number>(n).fill(NaN);
  if (length === 0 || n < length) return out;
  let prev: number | null = null;
  for (let i = length - 1; i < n; i++) {
    if (prev === null) {
      let sum = 0;
      for (let j = 0; j < length; j++) sum += signal[j];
      prev = sum / length;
    } else {
      const mult = 2 / (length + 1);
      prev = (signal[i] - prev) * mult + prev;
    }
    out[i] = prev;
  }
  return out;
}

// ---------------------------------------------------------------------------
// MA overlay settings — persisted in localStorage
// ---------------------------------------------------------------------------

interface MaSettings {
  showEma: boolean;
  showSma: boolean;
  slowLength: number;
  fastLength: number;
}

const MA_DEFAULTS: MaSettings = { showEma: false, showSma: false, slowLength: 26, fastLength: 12 };

function loadMaSettings(): MaSettings {
  try {
    const raw = localStorage.getItem("candleserv:ma");
    if (raw) return { ...MA_DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return { ...MA_DEFAULTS };
}

function saveMaSettings(s: MaSettings) {
  localStorage.setItem("candleserv:ma", JSON.stringify(s));
}

function candleToLw(c: Candle): CandlestickData {
  const alpha = c.timestamp >= CONFIDENCE_CUTOFF_MS
    ? Math.max(0.001, c.confidence)
    : 1;
  const color = c.close >= c.open
    ? `rgba(34,197,94,${alpha})`
    : `rgba(239,68,68,${alpha})`;
  return {
    time: Math.floor(c.timestamp / 1000) as Time,
    open: c.open, high: c.high, low: c.low, close: c.close,
    color, borderColor: color, wickColor: color,
  };
}

function candleToVolume(c: Candle): HistogramData {
  return {
    time: Math.floor(c.timestamp / 1000) as Time,
    value: c.volume,
    color: c.close >= c.open ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)",
  };
}

export default function CandlesTab() {
  const { snapshot, latestCandle: latest, tf, setTf, currency, setCurrency } = useCandleStream();
  const chartRef       = useRef<HTMLDivElement>(null);
  const chart          = useRef<IChartApi | null>(null);
  const series         = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeries   = useRef<ISeriesApi<"Histogram"> | null>(null);
  const gapSeries      = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaSlowSeries  = useRef<ISeriesApi<"Line"> | null>(null);
  const emaFastSeries  = useRef<ISeriesApi<"Line"> | null>(null);
  const smaSlowSeries  = useRef<ISeriesApi<"Line"> | null>(null);
  const smaFastSeries  = useRef<ISeriesApi<"Line"> | null>(null);
  const initialized    = useRef(false);
  const [loading, setLoading]         = useState(true);
  const [fetchingHistory, setFetchingHistory] = useState(false);
  const [atHistoryStart, setAtHistoryStart]   = useState(false);
  const [showGoLive, setShowGoLive]           = useState(false);
  const [errorTooltip, setErrorTooltip]       = useState<{ x: number; y: number; messages: string[] } | null>(null);
  const [ohlcLabel, setOhlcLabel]             = useState<{ o: number; h: number; l: number; c: number; v: number } | null>(null);
  const [aspectRatio, setAspectRatio]         = useState<string | null>(null);
  const [ma, setMaState] = useState<MaSettings>(loadMaSettings);

  function setMa(partial: Partial<MaSettings>) {
    setMaState(prev => { const u = { ...prev, ...partial }; saveMaSettings(u); return u; });
  }

  // Per-source hover popup (1m only). Toggled by the bottom-row checkbox; the
  // 7-day per-source dataset is fetched once per currency and cached (no refresh).
  const [showSources, setShowSourcesState] = useState<boolean>(() => localStorage.getItem("candleserv:showSources") !== "0");
  function setShowSources(v: boolean) { localStorage.setItem("candleserv:showSources", v ? "1" : "0"); setShowSourcesState(v); }
  const [sourceTip, setSourceTip] = useState<{ x: number; y: number; rows: SourceCandleRow[]; composite: number | null } | null>(null);
  const sourceData     = useRef<Map<number, SourceCandleRow[]>>(new Map()); // sec → rows
  const sourceDataCcy  = useRef<string>("");                                 // currency the cache holds
  const showSourcesRef = useRef(showSources);
  useEffect(() => { showSourcesRef.current = showSources; }, [showSources]);

  // Feed-error markers (1m only). Errors are currently not currency-scoped, so
  // every currency's errors show on every tab — this toggle hides them all.
  // Sticky in localStorage, default OFF.
  const [showErrors, setShowErrorsState] = useState<boolean>(() => localStorage.getItem("candleserv:showErrors") === "1");
  function setShowErrors(v: boolean) { localStorage.setItem("candleserv:showErrors", v ? "1" : "0"); setShowErrorsState(v); }
  const showErrorsRef = useRef(showErrors);
  useEffect(() => {
    showErrorsRef.current = showErrors;
    updateErrorMarkers();
    if (!showErrors) setErrorTooltip(null);
  }, [showErrors]); // eslint-disable-line react-hooks/exhaustive-deps

  // All loaded candles, keyed by Unix-seconds timestamp to deduplicate across
  // SSE updates and historical fetches
  const allCandles     = useRef<Map<number, CandlestickData>>(new Map());
  const allVolume      = useRef<Map<number, HistogramData>>(new Map());
  const allCloses      = useRef<Map<number, number>>(new Map());
  const gapRanges      = useRef<{startSec: number, endSec: number}[]>([]);
  const errorBars      = useRef<Map<number, string[]>>(new Map());
  const loadingHistory = useRef(false);
  const noMoreHistory  = useRef(false);
  // Track whether the user has scrolled back so we don't snap them to live on each tick
  const userScrolledBack = useRef(false);
  // Keep current tf accessible inside effects without re-subscribing
  const tfRef = useRef(tf);
  useEffect(() => { tfRef.current = tf; }, [tf]);
  const currencyRef = useRef(currency);
  useEffect(() => { currencyRef.current = currency; }, [currency]);
  const maRef = useRef(ma);
  useEffect(() => { maRef.current = ma; }, [ma]);

  // Enabled-currency list for the selector dropdown.
  const [currencyOptions, setCurrencyOptions] = useState<string[]>([currency]);
  useEffect(() => {
    getCurrencies()
      .then(r => setCurrencyOptions(r.currencies.filter(c => c.enabled).map(c => c.code)))
      .catch(() => {});
  }, []);

  // ── Chart init — runs once ──────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return;
    const el = chartRef.current;
    const pal = CHART_THEME[getTheme()];
    const instance = createChart(el, {
      autoSize: true,
      layout: { background: { color: pal.background }, textColor: pal.text },
      grid: { vertLines: { color: pal.grid }, horzLines: { color: pal.grid } },
      crosshair: { mode: 0 },
      timeScale: { borderColor: pal.border, timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: pal.border },
    });
    chart.current  = instance;
    series.current = instance.addCandlestickSeries({
      upColor: "#22c55e", downColor: "#ef4444",
      borderUpColor: "#22c55e", borderDownColor: "#ef4444",
      wickUpColor: "#22c55e", wickDownColor: "#ef4444",
    });
    // Push candlesticks up to leave the bottom 25% for volume
    series.current.priceScale().applyOptions({
      scaleMargins: { top: 0.1, bottom: 0.25 },
    });

    // Volume histogram in the bottom quarter, on its own price scale
    volumeSeries.current = instance.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    volumeSeries.current.priceScale().applyOptions({
      scaleMargins: { top: 0.75, bottom: 0 },
      visible: false,
    });

    // Gap background bands — full pane height, own scale
    gapSeries.current = instance.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "gap-bg",
      lastValueVisible: false,
      priceLineVisible: false,
    });
    gapSeries.current.priceScale().applyOptions({
      scaleMargins: { top: 0, bottom: 0 },
      visible: false,
    });

    // MA overlay line series — share the main price scale
    emaSlowSeries.current = instance.addLineSeries({
      color: "#2dd4bf", lineWidth: 1, priceScaleId: "right",
      lastValueVisible: false, priceLineVisible: false,
    });
    emaFastSeries.current = instance.addLineSeries({
      color: "#f472b6", lineWidth: 1, priceScaleId: "right",
      lastValueVisible: false, priceLineVisible: false,
    });
    smaSlowSeries.current = instance.addLineSeries({
      color: "#60a5fa", lineWidth: 1, priceScaleId: "right",
      lastValueVisible: false, priceLineVisible: false,
    });
    smaFastSeries.current = instance.addLineSeries({
      color: "#fbbf24", lineWidth: 1, priceScaleId: "right",
      lastValueVisible: false, priceLineVisible: false,
    });

    // ── Scroll handler — fetch history when user nears the left edge ──────────
    const handleRangeChange = async (range: LogicalRange | null) => {
      if (!range || !series.current) return;

      const from = range.from as number;
      const to   = range.to as number;

      // Detect whether the user has scrolled away from the live edge
      const total = allCandles.current.size;
      const scrolledBack = to < total - 10;
      userScrolledBack.current = scrolledBack;
      setShowGoLive(scrolledBack);

      if (from > HISTORY_TRIGGER_BARS) return;
      if (loadingHistory.current || noMoreHistory.current) return;

      loadingHistory.current = true;
      setFetchingHistory(true);

      try {
        const sorted = [...allCandles.current.keys()].sort((a, b) => a - b);
        if (!sorted.length) return;
        // Fetch candles strictly before the oldest loaded bar
        const endingAtMs = sorted[0] * 1000 - 1;
        const result = await getCandlesBefore(tfRef.current, endingAtMs, HISTORY_FETCH_LIMIT, currencyRef.current);

        if (!result.candles.length) {
          noMoreHistory.current = true;
          setAtHistoryStart(true);
          return;
        }

        for (const c of result.candles) {
          const sec = Math.floor(c.timestamp / 1000);
          if (!allCandles.current.has(sec)) {
            allCandles.current.set(sec, candleToLw(c));
            allVolume.current.set(sec, candleToVolume(c));
            allCloses.current.set(sec, c.close);
          }
        }

        series.current.setData(sortedCandlesWithGaps());
        volumeSeries.current?.setData(sortedVolume());
        gapSeries.current?.setData(sortedGapHistogram());
        updateErrorMarkers();
        updateMaOverlays();

        // End-of-history is detected by an EMPTY page (above), not "fewer than
        // requested" — the demo read cap (200) clamps every response below
        // HISTORY_FETCH_LIMIT, which would otherwise false-trigger end-of-history
        // after one page. Pages just keep advancing (oldest-1) until one is empty.
      } catch (err) {
        console.error("[CandlesTab] history fetch error:", err);
      } finally {
        loadingHistory.current = false;
        setFetchingHistory(false);
      }
    };

    instance.timeScale().subscribeVisibleLogicalRangeChange(handleRangeChange);

    // ── Crosshair handler — OHLC+V label (all TFs) + error tooltip (1m only) ──
    const handleCrosshairMove = (params: MouseEventParams) => {
      if (!params.point || !params.time) {
        setOhlcLabel(null);
        setErrorTooltip(null);
        setSourceTip(null);
        return;
      }
      const sec = params.time as number;

      // OHLC+V label — extract the hovered bar from our local data maps.
      const d = allCandles.current.get(sec);
      const v = allVolume.current.get(sec);
      if (d) setOhlcLabel({ o: d.open, h: d.high, l: d.low, c: d.close, v: v?.value ?? 0 });
      else setOhlcLabel(null);

      // Error + per-source popups are 1m-only.
      if (tfRef.current !== "1m") {
        setErrorTooltip(null);
        setSourceTip(null);
        return;
      }

      // Error tooltip — marked bars only, and only when the cursor is in the
      // bottom band (the volume pane, where the error squares are drawn). Keeps
      // the error messages out of the candlestick area.
      const chartH = chartRef.current?.clientHeight ?? 1;
      const inErrorZone = params.point.y / chartH >= 0.75;
      const msgs = errorBars.current.get(sec);
      setErrorTooltip(showErrorsRef.current && inErrorZone && msgs && msgs.length > 0
        ? { x: params.point.x, y: params.point.y, messages: msgs } : null);

      // Per-source popup — only when enabled + the cache holds this currency.
      if (showSourcesRef.current && sourceDataCcy.current === currencyRef.current) {
        const rows = sourceData.current.get(sec);
        setSourceTip(rows && rows.length
          ? { x: params.point.x, y: params.point.y, rows, composite: allCloses.current.get(sec) ?? null }
          : null);
      } else {
        setSourceTip(null);
      }
    };
    instance.subscribeCrosshairMove(handleCrosshairMove);

    return () => {
      instance.unsubscribeCrosshairMove(handleCrosshairMove);
      instance.timeScale().unsubscribeVisibleLogicalRangeChange(handleRangeChange);
      instance.remove();
      chart.current        = null;
      series.current       = null;
      volumeSeries.current = null;
      gapSeries.current    = null;
      emaSlowSeries.current = null;
      emaFastSeries.current = null;
      smaSlowSeries.current = null;
      smaFastSeries.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Reset per-tf state when timeframe changes ───────────────────────────────
  useEffect(() => {
    initialized.current    = false;
    loadingHistory.current = false;
    noMoreHistory.current  = false;
    userScrolledBack.current = false;
    allCandles.current.clear();
    allVolume.current.clear();
    allCloses.current.clear();
    gapRanges.current = [];
    errorBars.current = new Map();
    setAtHistoryStart(false);
    // Blank the chart immediately so the previous tf/currency's bars don't
    // linger (or visually mix) until the first new snapshot lands.
    series.current?.setData([]);
    volumeSeries.current?.setData([]);
    gapSeries.current?.setData([]);
    emaSlowSeries.current?.setData([]);
    emaFastSeries.current?.setData([]);
    smaSlowSeries.current?.setData([]);
    smaFastSeries.current?.setData([]);
  }, [tf, currency]);

  // Re-theme the chart on the global light/dark toggle (canvas is counter-inverted
  // out of the CSS invert, so it sets its own palette).
  useEffect(() => {
    const onThemeChange = () => { if (chart.current) applyChartTheme(chart.current, getTheme()); };
    window.addEventListener("themechange", onThemeChange);
    return () => window.removeEventListener("themechange", onThemeChange);
  }, []);

  // Lazy-load the 7-day per-source dataset once per currency when the popup is on
  // (never auto-refreshes — hard reload to update). Grouped by minute for O(1) hover.
  useEffect(() => {
    if (!showSources) return;
    if (sourceDataCcy.current === currency && sourceData.current.size) return;
    let alive = true;
    getSourceCandles(currency, 7).then(({ rows }) => {
      if (!alive) return;
      const m = new Map<number, SourceCandleRow[]>();
      for (const r of rows) {
        const arr = m.get(r.t);
        if (arr) arr.push(r); else m.set(r.t, [r]);
      }
      sourceData.current = m;
      sourceDataCcy.current = currency;
    }).catch(err => console.error("[CandlesTab] getSourceCandles error:", err));
    return () => { alive = false; };
  }, [showSources, currency]);

  // ── Fetch gap ranges and service errors on TF change ────────────────────────
  useEffect(() => {
    gapRanges.current = [];
    errorBars.current = new Map();

    getGaps().then(result => {
      gapRanges.current = result.gaps.map(g => ({
        startSec: Math.floor(new Date(g.timestamp).getTime() / 1000),
        endSec:   Math.floor(new Date(g.timestamp).getTime() / 1000) + g.durationMinutes * 60,
      }));
      series.current?.setData(sortedCandlesWithGaps());
      gapSeries.current?.setData(sortedGapHistogram());
    }).catch(err => console.error("[CandlesTab] getGaps error:", err));

    // Feed errors are part of the observability the product exists to show —
    // rendered in demo too (the endpoint is in the demo read set).
    getErrors(60 * 24 * 30).then(result => {
      const step = TF_SECONDS[tfRef.current];
      const bars = new Map<number, string[]>();
      for (const err of result.errors) {
        const tSec = Math.floor(new Date(err.createdAt).getTime() / 1000);
        const barT = Math.floor(tSec / step) * step;
        const msgs = bars.get(barT) ?? [];
        msgs.push(err.message);
        bars.set(barT, msgs);
      }
      errorBars.current = bars;
      updateErrorMarkers();
    }).catch(err => console.error("[CandlesTab] getErrors error:", err));
  }, [tf, currency]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Merge SSE snapshot from context into the chart candle map ───────────────
  useEffect(() => {
    if (!snapshot.length || !series.current) return;

    for (const c of snapshot) {
      const sec = Math.floor(c.timestamp / 1000);
      allCandles.current.set(sec, candleToLw(c));
      allVolume.current.set(sec, candleToVolume(c));
      allCloses.current.set(sec, c.close);
    }

    try {
      const data = sortedCandlesWithGaps();
      series.current.setData(data);
      volumeSeries.current?.setData(sortedVolume());
      gapSeries.current?.setData(sortedGapHistogram());
      updateErrorMarkers();
      updateMaOverlays();
      if (!initialized.current) {
        // First load: show the most recent 100 bars at a comfortable zoom
        const from = Math.max(0, data.length - 100);
        chart.current?.timeScale().setVisibleLogicalRange({ from, to: data.length });
        initialized.current = true;
      } else if (!userScrolledBack.current) {
        // Live update and user is at the live edge — follow it
        chart.current?.timeScale().scrollToRealTime();
      }
      setLoading(false);
    } catch (err) {
      console.error("[CandlesTab] setData error:", err);
    }
  }, [snapshot]); // eslint-disable-line react-hooks/exhaustive-deps

  function sortedCandles(): CandlestickData[] {
    return [...allCandles.current.values()].sort(
      (a, b) => (a.time as number) - (b.time as number)
    );
  }

  function sortedVolume(): HistogramData[] {
    return [...allVolume.current.values()].sort(
      (a, b) => (a.time as number) - (b.time as number)
    );
  }

  function getGapBars(): number[] {
    if (!gapRanges.current.length || !allCandles.current.size) return [];
    const step = TF_SECONDS[tfRef.current];
    const keys = [...allCandles.current.keys()];
    const minT = Math.min(...keys);
    const maxT = Math.max(...keys);
    // Set + sort: gap ranges can overlap or arrive out of time order, which would
    // otherwise emit duplicate / non-ascending times. lightweight-charts requires
    // strictly-ascending unique times in setData — a violation corrupts the
    // histogram's internal index and throws ensureNotNull ("Value is null") on
    // crosshair render. Dedupe + sort here so every consumer gets clean data.
    const result = new Set<number>();
    for (const { startSec, endSec } of gapRanges.current) {
      const alignedStart = Math.floor(startSec / step) * step;
      const alignedEnd   = Math.ceil(endSec / step) * step;
      for (let t = alignedStart; t < alignedEnd; t += step) {
        if (t >= minT && t <= maxT && !allCandles.current.has(t)) result.add(t);
      }
    }
    return [...result].sort((a, b) => a - b);
  }

  function sortedCandlesWithGaps(): (CandlestickData | WhitespaceData)[] {
    const gaps = getGapBars().map(t => ({ time: t as Time }));
    const merged = [...sortedCandles(), ...gaps]
      .sort((a, b) => (a.time as number) - (b.time as number));
    // Defensive: collapse duplicate timestamps (real candle wins over a gap
    // whitespace bar, since candles are placed first before the stable sort) so
    // lightweight-charts' strict-ascending setData can never throw and blank the
    // chart. The currency stream is generation-guarded upstream, so this should
    // be a no-op in practice — it's belt-and-suspenders.
    const out: (CandlestickData | WhitespaceData)[] = [];
    let lastT = -Infinity;
    for (const d of merged) {
      const t = d.time as number;
      if (t === lastT) continue;
      out.push(d);
      lastT = t;
    }
    return out;
  }

  function sortedGapHistogram(): HistogramData[] {
    return getGapBars().map(t => ({
      time: t as Time, value: 1, color: "rgba(107,114,128,0.12)",
    }));
  }

  function updateErrorMarkers() {
    if (!volumeSeries.current) return;
    // Error timestamps are 1m-resolution events. On higher TFs the confidence
    // field already captures data quality, so markers are only shown at 1m.
    if (tfRef.current !== "1m" || !showErrorsRef.current) {
      volumeSeries.current.setMarkers([]);
      return;
    }
    const markers = [...errorBars.current.keys()]
      .filter(t => allCandles.current.has(t))
      .sort((a, b) => a - b)
      .map(t => ({
        time: t as Time,
        position: "aboveBar" as const,
        color: "#ef4444",
        shape: "square" as const,
        size: 0.5,
      }));
    volumeSeries.current.setMarkers(markers);
  }

  useEffect(() => {
    updateMaOverlays();
  }, [ma]); // eslint-disable-line react-hooks/exhaustive-deps

  function updateMaOverlays() {
    const m = maRef.current;
    const sorted = [...allCloses.current.entries()]
      .sort(([a], [b]) => a - b);
    const times = sorted.map(([t]) => t);
    const closes = sorted.map(([, v]) => v);

    function toLineData(values: number[]): LineData[] {
      const out: LineData[] = [];
      for (let i = 0; i < values.length; i++) {
        if (!isFinite(values[i])) continue;
        out.push({ time: times[i] as Time, value: values[i] });
      }
      return out;
    }

    if (m.showEma) {
      emaSlowSeries.current?.setData(toLineData(fillEmaSeries(closes, m.slowLength)));
      emaFastSeries.current?.setData(toLineData(fillEmaSeries(closes, m.fastLength)));
    } else {
      emaSlowSeries.current?.setData([]);
      emaFastSeries.current?.setData([]);
    }

    if (m.showSma) {
      smaSlowSeries.current?.setData(toLineData(fillSmaSeries(closes, m.slowLength)));
      smaFastSeries.current?.setData(toLineData(fillSmaSeries(closes, m.fastLength)));
    } else {
      smaSlowSeries.current?.setData([]);
      smaFastSeries.current?.setData([]);
    }
  }

  const conf = latest?.confidence ?? null;
  const confColor = conf === null ? "text-gray-500"
    : conf >= 0.8 ? "text-green-400"
    : conf >= 0.5 ? "text-yellow-400"
    : "text-red-400";

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-gray-800 shrink-0">
        <select
          value={currency}
          onChange={e => setCurrency(e.target.value)}
          className="bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 font-medium"
          title="Currency"
        >
          {currencyOptions.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <div className="flex gap-1">
          {TFS.map(t => (
            <button
              key={t}
              onClick={() => setTf(t)}
              className={`px-2 py-1 text-xs rounded transition-colors ${
                tf === t ? "bg-blue-600 text-white" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-4 ml-auto text-xs">
          {latest && (
            <>
              <span className="text-gray-50 font-mono">${latest.close.toLocaleString()}</span>
              <span className="text-gray-500">{latest.sourceCount}/{latest.sourceCountBaseline} sources</span>
              <span className={confColor}>conf {(latest.confidence * 100).toFixed(0)}%</span>
            </>
          )}
          {fetchingHistory && <span className="text-blue-400">loading history…</span>}
          {atHistoryStart && !fetchingHistory && <span className="text-gray-600">full history loaded</span>}
          {!fetchingHistory && !atHistoryStart && loading && (
            <span className="text-gray-600">loading…</span>
          )}
        </div>
      </div>
      {/* Chart — outer div is a size container so the inner div can use cqw/cqh */}
      <div className="flex-1 min-h-0" style={{ containerType: 'size' }}>
        <div
          className={`relative pb-6 ${aspectRatio ? 'mx-auto' : ''}`}
          style={(() => {
            if (!aspectRatio) return { width: '100%', height: '100%' };
            const [w, h] = aspectRatio.split('/').map(Number);
            const r = w / h;
            return {
              width:  `min(100cqw, calc(100cqh * ${r}))`,
              height: `min(100cqh, calc(100cqw / ${r}))`,
            };
          })()}
        >
        <div ref={chartRef} className="w-full h-full" />
        {ohlcLabel && (
          <div className="absolute top-2 left-2 z-10 pointer-events-none flex gap-3 text-xs font-mono">
            <span className="text-gray-500">O <span className="text-gray-300">{ohlcLabel.o.toLocaleString()}</span></span>
            <span className="text-gray-500">H <span className="text-gray-300">{ohlcLabel.h.toLocaleString()}</span></span>
            <span className="text-gray-500">L <span className="text-gray-300">{ohlcLabel.l.toLocaleString()}</span></span>
            <span className="text-gray-500">C <span className={ohlcLabel.c >= ohlcLabel.o ? "text-green-400" : "text-red-400"}>{ohlcLabel.c.toLocaleString()}</span></span>
            <span className="text-gray-500">V <span className="text-gray-300">{ohlcLabel.v.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span></span>
          </div>
        )}
        {errorTooltip && (
          <div
            className="absolute z-20 pointer-events-none bg-gray-900 border border-red-900 rounded px-2 py-1 text-xs text-gray-200 max-w-sm"
            style={{ left: errorTooltip.x + 14, top: errorTooltip.y - 8 }}
          >
            {errorTooltip.messages.map((m, i) => (
              <div key={i} className={i > 0 ? "mt-1 pt-1 border-t border-gray-700" : ""}>{m}</div>
            ))}
          </div>
        )}
        {sourceTip && (() => {
          const chartW = chartRef.current?.clientWidth ?? 800;
          const onRight = sourceTip.x > chartW / 2;
          const style = onRight
            ? { right: chartW - sourceTip.x + 14, top: sourceTip.y + 14 }
            : { left: sourceTip.x + 14, top: sourceTip.y + 14 };
          const comp = sourceTip.composite;
          // Dominant source = highest-volume accepted venue this minute → row tint.
          const nonRej = sourceTip.rows.filter(r => !r.rejected);
          const dominant = nonRej.length ? nonRej.reduce((a, b) => (b.v > a.v ? b : a)).source : null;
          const num = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 2 });
          return (
            <div
              className="absolute z-20 pointer-events-none bg-gray-900/95 border border-gray-700 rounded px-1.5 py-1 text-[11px] font-mono shadow-lg"
              style={style}
            >
              <table className="border-collapse tabular-nums whitespace-nowrap">
                <tbody>
                  {sourceTip.rows.map(r => {
                    // pm: premium in dollars vs composite close. peg: the tether
                    // price itself (USD per USDT, e.g. $0.9989) — how traders read it.
                    const extra = r.peg != null
                      ? <span className="text-sky-400">{`peg: $${r.peg.toFixed(4)}`}</span>
                      : comp != null
                        ? (() => {
                            const d = r.c - comp;
                            return <span className={d >= 0 ? "text-green-400" : "text-red-400"}>{`pm: ${d >= 0 ? "+" : "-"}$${fmtPrice(Math.abs(d))}`}</span>;
                          })()
                        : null;
                    const rowCls = `${r.rejected ? "opacity-40 line-through" : ""} ${r.source === dominant ? "bg-amber-500/25" : ""}`;
                    const cell = "px-1.5 py-px text-gray-500 text-right";
                    return (
                      <tr key={r.source} className={rowCls}>
                        <td className="px-1.5 py-px text-amber-400 text-left">{srcAbbr(r.source)}</td>
                        <td className={cell}>o:<span className="text-gray-300">{fmtPrice(r.o)}</span></td>
                        <td className={cell}>h:<span className="text-gray-300">{fmtPrice(r.h)}</span></td>
                        <td className={cell}>l:<span className="text-gray-300">{fmtPrice(r.l)}</span></td>
                        <td className={cell}>c:<span className="text-gray-300">{fmtPrice(r.c)}</span></td>
                        <td className={cell}>v:<span className="text-gray-300">{num(r.v)}</span></td>
                        <td className="px-1.5 py-px text-right">{extra}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        })()}
        {showGoLive && (
          <button
            onClick={() => {
              userScrolledBack.current = false;
              setShowGoLive(false);
              chart.current?.timeScale().scrollToRealTime();
            }}
            className="absolute bottom-8 right-4 z-10 px-3 py-1 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded shadow-lg transition-colors"
          >
            Go live
          </button>
        )}
        <div className="absolute bottom-1 left-0 right-0 z-10 flex items-center px-4">
          <div className="flex gap-1">
            {["21:9", "16:9", "4:3", "3:2"].map(label => {
              const value = label.replace(":", "/");
              return (
                <button
                  key={label}
                  onClick={() => setAspectRatio(aspectRatio === value ? null : value)}
                  className={`px-1.5 py-0.5 text-xs rounded transition-colors ${
                    aspectRatio === value
                      ? "bg-gray-600 text-gray-50"
                      : "text-gray-700 hover:text-gray-400"
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-3 ml-auto text-xs">
            <label className="flex items-center gap-1 cursor-pointer" style={{ color: showErrors ? "#ef4444" : "#4b5563" }} title="Show feed-error markers (1m only)">
              <input type="checkbox" checked={showErrors} onChange={e => setShowErrors(e.target.checked)} />
              Errors
            </label>
            <label className="flex items-center gap-1 cursor-pointer" style={{ color: showSources ? "#fbbf24" : "#4b5563" }} title="Show per-source OHLC on hover (1m only)">
              <input type="checkbox" checked={showSources} onChange={e => setShowSources(e.target.checked)} />
              Sources
            </label>
            <label className="flex items-center gap-1 cursor-pointer" style={{ color: ma.showEma ? "#2dd4bf" : "#4b5563" }}>
              <input type="checkbox" checked={ma.showEma} onChange={e => setMa({ showEma: e.target.checked })} />
              EMA
            </label>
            <label className="flex items-center gap-1 cursor-pointer" style={{ color: ma.showSma ? "#60a5fa" : "#4b5563" }}>
              <input type="checkbox" checked={ma.showSma} onChange={e => setMa({ showSma: e.target.checked })} />
              SMA
            </label>
            <label className="flex items-center gap-1 text-gray-500">
              Slow
              <input type="number" min={2} value={ma.slowLength}
                onChange={e => setMa({ slowLength: parseInt(e.target.value) || 26 })}
                className="bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-gray-300 w-12 text-xs" />
            </label>
            <label className="flex items-center gap-1 text-gray-500">
              Fast
              <input type="number" min={2} value={ma.fastLength}
                onChange={e => setMa({ fastLength: parseInt(e.target.value) || 12 })}
                className="bg-gray-900 border border-gray-700 rounded px-1 py-0.5 text-gray-300 w-12 text-xs" />
            </label>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}
