import { useEffect, useRef, useState } from "react";
import { createChart, IChartApi, ISeriesApi, CandlestickData, Time } from "lightweight-charts";
import type { Candle } from "@/lib/api";

const TFS = ["1m","5m","10m","15m","1h","2h","4h","6h","12h","1d","3d","7d","30d"];

function candleToLw(c: Candle): CandlestickData {
  return {
    time: Math.floor(c.timestamp / 1000) as Time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  };
}

export default function CandlesTab() {
  const [tf, setTf] = useState("15m");
  const chartRef    = useRef<HTMLDivElement>(null);
  const chart       = useRef<IChartApi | null>(null);
  const series      = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const initialized = useRef(false);
  const [latest, setLatest] = useState<Candle | null>(null);
  const [loading, setLoading] = useState(true);

  // Init chart once
  useEffect(() => {
    if (!chartRef.current) return;
    const el = chartRef.current;
    const instance = createChart(el, {
      width:  el.clientWidth,
      height: el.clientHeight,
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

    const handleResize = () => {
      instance.applyOptions({ width: el.clientWidth, height: el.clientHeight });
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      instance.remove();
      chart.current  = null;
      series.current = null;
    };
  }, []);

  // Reset initialized flag when tf changes so the new series gets a proper initial view
  useEffect(() => { initialized.current = false; }, [tf]);

  // Subscribe to N-candle snapshots — full setData on every event
  useEffect(() => {
    setLoading(true);
    const es = new EventSource(`/monitor/candles/stream?tf=${tf}&n=200`);

    es.addEventListener("candles", (e) => {
      const candles = JSON.parse(e.data) as Candle[];
      if (!series.current || !candles.length) return;
      const lw = candles.map(candleToLw).sort((a, b) => (a.time as number) - (b.time as number));
      try {
        series.current.setData(lw);
        if (!initialized.current) {
          // First load: show the most recent 100 bars at a comfortable zoom
          const from = Math.max(0, lw.length - 100);
          chart.current?.timeScale().setVisibleLogicalRange({ from, to: lw.length });
          initialized.current = true;
        } else {
          // Live updates: scroll to latest without resetting zoom
          chart.current?.timeScale().scrollToRealTime();
        }
        setLatest(candles.at(-1) ?? null);
        setLoading(false);
      } catch (err) {
        console.error("[CandlesTab] setData error:", err);
      }
    });

    es.onerror = (e) => console.error("[CandlesTab] SSE error:", e);
    return () => es.close();
  }, [tf]);

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
          {loading && <span className="text-gray-600">loading…</span>}
        </div>
      </div>
      {/* Chart */}
      <div ref={chartRef} className="flex-1" />
    </div>
  );
}
