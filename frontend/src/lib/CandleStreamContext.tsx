import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Candle } from "@/lib/api";
import { isDemo, demoToken } from "@/lib/demo";

interface CandleStreamCtx {
  snapshot: Candle[];         // latest N-candle snapshot from SSE
  latestCandle: Candle | null;
  connected: boolean;
  newCandleTick: number;      // increments on each new candle event — use as useEffect dep
  sourceStateTick: number;    // increments on each source_state event — use as useEffect dep
  tf: string;
  setTf: (tf: string) => void;
  currency: string;
  setCurrency: (currency: string) => void;
}

const CandleStreamContext = createContext<CandleStreamCtx>({
  snapshot: [],
  latestCandle: null,
  connected: false,
  newCandleTick: 0,
  sourceStateTick: 0,
  tf: "15m",
  setTf: () => {},
  currency: "BTC",
  setCurrency: () => {},
});

export function useCandleStream(): CandleStreamCtx {
  return useContext(CandleStreamContext);
}

export function CandleStreamProvider({ children }: { children: React.ReactNode }) {
  const [tf, setTfState] = useState(() => localStorage.getItem("candleserv:tf") ?? "15m");
  const [currency, setCurrencyState] = useState(() => localStorage.getItem("candleserv:currency") ?? "BTC");
  const [snapshot, setSnapshot] = useState<Candle[]>([]);
  const [latestCandle, setLatestCandle] = useState<Candle | null>(null);
  const [connected, setConnected] = useState(false);
  const [newCandleTick, setNewCandleTick] = useState(0);
  const [sourceStateTick, setSourceStateTick] = useState(0);

  const esRef       = useRef<EventSource | null>(null);
  const tfRef       = useRef(tf);
  const currencyRef = useRef(currency);
  const timerRef    = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Monotonic connection generation. Every connect() bumps it; event handlers
  // captured by a superseded connection compare against it and bail. Without
  // this, an in-flight message from the previous currency's stream (closed but
  // not yet GC'd) merges into the chart alongside the new currency — mixing
  // e.g. BTC (~73k) and ETH (~$2k) bars into one out-of-order, wrong-scale set.
  const genRef = useRef(0);

  useEffect(() => { tfRef.current = tf; }, [tf]);
  useEffect(() => { currencyRef.current = currency; }, [currency]);

  function connect(currentTf: string) {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }

    const myGen = ++genRef.current;
    // EventSource can't set headers, so the demo page token rides as a query param.
    const demoQ = isDemo() && demoToken() ? `&demoToken=${encodeURIComponent(demoToken()!)}` : "";
    const es = new EventSource(`/monitor/candles/stream?currency=${currencyRef.current}&tf=${currentTf}&n=200${demoQ}`);
    esRef.current = es;

    es.addEventListener("candles", (e) => {
      if (myGen !== genRef.current) return; // superseded connection — ignore
      const candles = JSON.parse(e.data) as Candle[];
      if (!candles.length) return;
      setConnected(true);
      setSnapshot(candles);
      setLatestCandle(candles.at(-1) ?? null);
      setNewCandleTick(n => n + 1);
    });

    es.addEventListener("source_state", () => {
      if (myGen !== genRef.current) return;
      setSourceStateTick(n => n + 1);
    });

    es.onerror = () => {
      if (myGen !== genRef.current) return; // superseded connection erroring — ignore
      if (document.hidden) return; // visibilitychange will reconnect
      setConnected(false);
      esRef.current?.close();
      esRef.current = null;
      timerRef.current = setTimeout(() => connect(tfRef.current), 3000);
    };
  }

  useEffect(() => {
    function handleVisibilityChange() {
      if (document.hidden) {
        esRef.current?.close();
        esRef.current = null;
        setConnected(false);
      } else {
        if (!esRef.current) connect(tfRef.current);
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    connect(tf);

    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      if (timerRef.current) clearTimeout(timerRef.current);
      esRef.current?.close();
      esRef.current = null;
    };
  }, [tf, currency]); // eslint-disable-line react-hooks/exhaustive-deps

  function setTf(newTf: string) {
    localStorage.setItem("candleserv:tf", newTf);
    setSnapshot([]);
    setLatestCandle(null);
    setConnected(false);
    setTfState(newTf);
  }

  function setCurrency(newCurrency: string) {
    localStorage.setItem("candleserv:currency", newCurrency);
    setSnapshot([]);
    setLatestCandle(null);
    setConnected(false);
    setCurrencyState(newCurrency);
  }

  return (
    <CandleStreamContext.Provider value={{ snapshot, latestCandle, connected, newCandleTick, sourceStateTick, tf, setTf, currency, setCurrency }}>
      {children}
    </CandleStreamContext.Provider>
  );
}
