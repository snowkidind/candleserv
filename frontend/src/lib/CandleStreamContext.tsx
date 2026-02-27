import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { Candle } from "@/lib/api";

interface CandleStreamCtx {
  snapshot: Candle[];         // latest N-candle snapshot from SSE
  latestCandle: Candle | null;
  connected: boolean;
  newCandleTick: number;      // increments on each new candle event — use as useEffect dep
  tf: string;
  setTf: (tf: string) => void;
}

const CandleStreamContext = createContext<CandleStreamCtx>({
  snapshot: [],
  latestCandle: null,
  connected: false,
  newCandleTick: 0,
  tf: "15m",
  setTf: () => {},
});

export function useCandleStream(): CandleStreamCtx {
  return useContext(CandleStreamContext);
}

export function CandleStreamProvider({ children }: { children: React.ReactNode }) {
  const [tf, setTfState] = useState(() => localStorage.getItem("candleserv:tf") ?? "15m");
  const [snapshot, setSnapshot] = useState<Candle[]>([]);
  const [latestCandle, setLatestCandle] = useState<Candle | null>(null);
  const [connected, setConnected] = useState(false);
  const [newCandleTick, setNewCandleTick] = useState(0);

  const esRef    = useRef<EventSource | null>(null);
  const tfRef    = useRef(tf);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { tfRef.current = tf; }, [tf]);

  function connect(currentTf: string) {
    if (esRef.current) { esRef.current.close(); esRef.current = null; }
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }

    const es = new EventSource(`/monitor/candles/stream?tf=${currentTf}&n=200`);
    esRef.current = es;

    es.addEventListener("candles", (e) => {
      const candles = JSON.parse(e.data) as Candle[];
      if (!candles.length) return;
      setConnected(true);
      setSnapshot(candles);
      setLatestCandle(candles.at(-1) ?? null);
      setNewCandleTick(n => n + 1);
    });

    es.onerror = () => {
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
  }, [tf]); // eslint-disable-line react-hooks/exhaustive-deps

  function setTf(newTf: string) {
    localStorage.setItem("candleserv:tf", newTf);
    setSnapshot([]);
    setLatestCandle(null);
    setConnected(false);
    setTfState(newTf);
  }

  return (
    <CandleStreamContext.Provider value={{ snapshot, latestCandle, connected, newCandleTick, tf, setTf }}>
      {children}
    </CandleStreamContext.Provider>
  );
}
