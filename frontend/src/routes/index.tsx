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
import ApiTab from "@/routes/monitor/-ApiTab";

export const Route = createFileRoute("/")({ component: MonitorPage });

// The full tab group always renders for everyone (demo, view-only, and modify
// users alike). Visibility is NOT the access boundary — each tab shows its data
// read-only and gates its mutation controls on `useCanModify()` (lib/access),
// which mirrors the backend's requirePerm guards. Reads denied to a given viewer
// (e.g. API keys, or secrets in demo) fall back to a locked placeholder in-tab.
const ALL_TABS = ["Candles", "Connections", "Feeds", "Errors", "Events", "Admin", "API"] as const;
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

// This product is built for a wide desktop layout — the chart toolbars and the
// price/volume panes don't reflow to a phone. Surface a dismissible notice on
// narrow/touch viewports rather than silently rendering a broken layout.
function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px), (pointer: coarse)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isMobile;
}

function MonitorContent() {
  const [tab, setTab] = useState<Tab>("Candles");
  const tabs = ALL_TABS;
  const isMobile = useIsMobile();
  const [mobileNoticeDismissed, setMobileNoticeDismissed] = useState(
    () => sessionStorage.getItem("candleserv:mobileNoticeDismissed") === "1"
  );
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
      {isMobile && !mobileNoticeDismissed && (
        <div className="flex items-start gap-3 bg-amber-900/40 border-b border-amber-700 px-4 py-2 text-xs text-amber-100 shrink-0">
          <span className="flex-1">
            This dashboard is built for a desktop screen — the charts and controls don't fit a phone.
            For the full experience, open it on a larger display.
          </span>
          <button
            onClick={() => {
              sessionStorage.setItem("candleserv:mobileNoticeDismissed", "1");
              setMobileNoticeDismissed(true);
            }}
            className="shrink-0 text-amber-300 hover:text-amber-100"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}
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
        {tab === "API"         && <ApiTab />}
      </div>
    </div>
  );
}
