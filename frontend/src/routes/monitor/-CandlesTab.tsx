import { useEffect, useRef, useState } from "react";
import { createChart, IChartApi, ISeriesApi, CandlestickData, HistogramData, Time, LogicalRange } from "lightweight-charts";
import type { Candle } from "@/lib/api";
import { getCandlesBefore } from "@/lib/api";

const TFS = ["1m","5m","10m","15m","1h","2h","4h","6h","12h","1d","3d","7d","30d"];
const HISTORY_FETCH_LIMIT = 500;
const HISTORY_TRIGGER_BARS = 50; // fetch when scrolled within 50 bars of the left edge

function candleToLw(c: Candle): CandlestickData {
  return {
    time: Math.floor(c.timestamp / 1000) as Time,
    open: c.open, high: c.high, low: c.low, close: c.close,
  };
}

function candleToVolume(c: Candle): HistogramData {
  return {
    time: Math.floor(c.timestamp / 1000) as Time,
    value: c.volumeNormalized,
    color: c.close >= c.open ? "rgba(34,197,94,0.4)" : "rgba(239,68,68,0.4)",
  };
}

export default function CandlesTab() {
  const [tf, setTf] = useState("15m");
  const chartRef       = useRef<HTMLDivElement>(null);
  const chart          = useRef<IChartApi | null>(null);
  const series         = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeSeries   = useRef<ISeriesApi<"Histogram"> | null>(null);
  const initialized    = useRef(false);
  const [latest, setLatest]           = useState<Candle | null>(null);
  const [loading, setLoading]         = useState(true);
  const [retryCount, setRetryCount]   = useState(0);
  const [fetchingHistory, setFetchingHistory] = useState(false);
  const [atHistoryStart, setAtHistoryStart]   = useState(false);
  const [showGoLive, setShowGoLive]           = useState(false);

  // All loaded candles, keyed by Unix-seconds timestamp to deduplicate across
  // SSE updates and historical fetches
  const allCandles     = useRef<Map<number, CandlestickData>>(new Map());
  const allVolume      = useRef<Map<number, HistogramData>>(new Map());
  const loadingHistory = useRef(false);
  const noMoreHistory  = useRef(false);
  // Track whether the user has scrolled back so we don't snap them to live on each tick
  const userScrolledBack = useRef(false);
  // Keep current tf accessible inside effects without re-subscribing
  const tfRef = useRef(tf);
  useEffect(() => { tfRef.current = tf; }, [tf]);

  // ── Chart init — runs once ──────────────────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return;
    const el = chartRef.current;
    const instance = createChart(el, {
      autoSize: true,
      layout: { background: { color: "#030712" }, textColor: "#9ca3af" },
      grid: { vertLines: { color: "#111827" }, horzLines: { color: "#111827" } },
      crosshair: { mode: 1 },
      timeScale: { borderColor: "#1f2937", timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: "#1f2937" },
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
        const result = await getCandlesBefore(tfRef.current, endingAtMs, HISTORY_FETCH_LIMIT);

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
          }
        }

        const data = sortedCandles();
        series.current.setData(data);
        volumeSeries.current?.setData(sortedVolume());

        if (result.candles.length < HISTORY_FETCH_LIMIT) {
          noMoreHistory.current = true;
          setAtHistoryStart(true);
        }
      } catch (err) {
        console.error("[CandlesTab] history fetch error:", err);
      } finally {
        loadingHistory.current = false;
        setFetchingHistory(false);
      }
    };

    instance.timeScale().subscribeVisibleLogicalRangeChange(handleRangeChange);

    return () => {
      instance.timeScale().unsubscribeVisibleLogicalRangeChange(handleRangeChange);
      instance.remove();
      chart.current        = null;
      series.current       = null;
      volumeSeries.current = null;
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
    setAtHistoryStart(false);
  }, [tf]);

  // ── SSE stream — merges into the shared candle map ──────────────────────────
  useEffect(() => {
    setLoading(true);
    const es = new EventSource(`/monitor/candles/stream?tf=${tf}&n=200`);

    es.addEventListener("candles", (e) => {
      const candles = JSON.parse(e.data) as Candle[];
      if (!series.current || !candles.length) return;

      for (const c of candles) {
        const sec = Math.floor(c.timestamp / 1000);
        allCandles.current.set(sec, candleToLw(c));
        allVolume.current.set(sec, candleToVolume(c));
      }

      const data = sortedCandles();
      try {
        series.current.setData(data);
        volumeSeries.current?.setData(sortedVolume());
        if (!initialized.current) {
          // First load: show the most recent 100 bars at a comfortable zoom
          const from = Math.max(0, data.length - 100);
          chart.current?.timeScale().setVisibleLogicalRange({ from, to: data.length });
          initialized.current = true;
        } else if (!userScrolledBack.current) {
          // Live update and user is at the live edge — follow it
          chart.current?.timeScale().scrollToRealTime();
        }
        setLatest(candles.at(-1) ?? null);
        setLoading(false);
      } catch (err) {
        console.error("[CandlesTab] setData error:", err);
      }
    });

    es.onerror = () => {
      console.error("[CandlesTab] SSE connection lost, reconnecting in 3s...");
      es.close();
      setTimeout(() => setRetryCount(n => n + 1), 3000);
    };

    return () => es.close();
  }, [tf, retryCount]);

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

  const conf = latest?.confidence ?? null;
  const confColor = conf === null ? "text-gray-500"
    : conf >= 0.8 ? "text-green-400"
    : conf >= 0.5 ? "text-yellow-400"
    : "text-red-400";

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center gap-4 px-4 py-2 border-b border-gray-800 shrink-0">
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
              <span className="text-white font-mono">${latest.close.toLocaleString()}</span>
              <span className="text-gray-500">{latest.sourceCount}/{latest.sourceCountBaseline} sources</span>
              <span className={confColor}>conf {(latest.confidence * 100).toFixed(0)}%</span>
            </>
          )}
          {fetchingHistory && <span className="text-blue-400">loading history…</span>}
          {atHistoryStart && !fetchingHistory && <span className="text-gray-600">full history loaded</span>}
          {!fetchingHistory && !atHistoryStart && loading && (
            <span className="text-gray-600">{retryCount > 0 ? "reconnecting…" : "loading…"}</span>
          )}
        </div>
      </div>
      {/* Chart */}
      <div className="relative flex-1">
        <div ref={chartRef} className="w-full h-full" />
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
      </div>
    </div>
  );
}
