import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { CandleStreamProvider, useCandleStream } from "@/lib/CandleStreamContext";
import CandlesTab from "@/routes/monitor/-CandlesTab";
import ConnectionsTab from "@/routes/monitor/-ConnectionsTab";
import ErrorsTab from "@/routes/monitor/-ErrorsTab";
import EventsTab from "@/routes/monitor/-EventsTab";
import AdminTab from "@/routes/monitor/-AdminTab";

export const Route = createFileRoute("/")({ component: MonitorPage });

const TABS = ["Candles", "Connections", "Errors", "Events", "Admin"] as const;
type Tab = typeof TABS[number];

function MonitorPage() {
  return (
    <CandleStreamProvider>
      <MonitorContent />
    </CandleStreamProvider>
  );
}

function MonitorContent() {
  const [tab, setTab] = useState<Tab>("Candles");
  const { newCandleTick } = useCandleStream();
  const [hasNewCandle, setHasNewCandle] = useState(false);
  const prevTick = useRef(newCandleTick);

  useEffect(() => {
    if (newCandleTick === prevTick.current) return;
    prevTick.current = newCandleTick;
    if (tab !== "Candles") setHasNewCandle(true);
  }, [newCandleTick, tab]);

  function handleTabChange(t: Tab) {
    setTab(t);
    if (t === "Candles") setHasNewCandle(false);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-0 border-b border-gray-800 px-4 shrink-0">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => handleTabChange(t)}
            className={`relative px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? "border-blue-500 text-white"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            {t}
            {t === "Candles" && hasNewCandle && (
              <span className="absolute top-2.5 right-2 w-1.5 h-1.5 bg-green-400 rounded-full" />
            )}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto">
        {tab === "Candles"     && <CandlesTab />}
        {tab === "Connections" && <ConnectionsTab />}
        {tab === "Errors"      && <ErrorsTab />}
        {tab === "Events"      && <EventsTab />}
        {tab === "Admin"       && <AdminTab />}
      </div>
    </div>
  );
}
