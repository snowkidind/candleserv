import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { CandleStreamProvider, useCandleStream } from "@/lib/CandleStreamContext";
import { AccessProvider } from "@/lib/access";
import CandlesTab from "@/routes/monitor/-CandlesTab";
import ConnectionsTab from "@/routes/monitor/-ConnectionsTab";
import FeedsTab from "@/routes/monitor/-FeedsTab";
import ErrorsTab from "@/routes/monitor/-ErrorsTab";
import EventsTab from "@/routes/monitor/-EventsTab";
import AdminTab from "@/routes/monitor/-AdminTab";

export const Route = createFileRoute("/")({ component: MonitorPage });

// The full tab group always renders for everyone (demo, view-only, and modify
// users alike). Visibility is NOT the access boundary — each tab shows its data
// read-only and gates its mutation controls on `useCanModify()` (lib/access),
// which mirrors the backend's requirePerm guards. Reads denied to a given viewer
// (e.g. API keys, or secrets in demo) fall back to a locked placeholder in-tab.
const ALL_TABS = ["Candles", "Connections", "Feeds", "Errors", "Events", "Admin"] as const;
type Tab = typeof ALL_TABS[number];

function MonitorPage() {
  return (
    <AccessProvider>
      <CandleStreamProvider>
        <MonitorContent />
      </CandleStreamProvider>
    </AccessProvider>
  );
}

function MonitorContent() {
  const [tab, setTab] = useState<Tab>("Candles");
  const tabs = ALL_TABS;
  const { newCandleTick } = useCandleStream();
  const [hasNewCandle, setHasNewCandle] = useState(false);
  const prevTick = useRef(newCandleTick);
  const dotTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (newCandleTick === prevTick.current) return;
    prevTick.current = newCandleTick;
    if (tab !== "Candles") {
      setHasNewCandle(true);
      if (dotTimer.current) clearTimeout(dotTimer.current);
      dotTimer.current = setTimeout(() => setHasNewCandle(false), 4000);
    }
  }, [newCandleTick, tab]);

  function handleTabChange(t: Tab) {
    setTab(t);
    if (t === "Candles") setHasNewCandle(false);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-0 border-b border-gray-800 px-4 shrink-0">
        {tabs.map(t => (
          <button
            key={t}
            onClick={() => handleTabChange(t)}
            className={`relative px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? "border-blue-500 text-gray-50"
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
        {tab === "Feeds"       && <FeedsTab />}
        {tab === "Errors"      && <ErrorsTab />}
        {tab === "Events"      && <EventsTab />}
        {tab === "Admin"       && <AdminTab />}
      </div>
    </div>
  );
}
