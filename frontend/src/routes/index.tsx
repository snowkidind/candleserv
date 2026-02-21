import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import CandlesTab from "@/routes/monitor/-CandlesTab";
import ConnectionsTab from "@/routes/monitor/-ConnectionsTab";
import ErrorsTab from "@/routes/monitor/-ErrorsTab";
import AdminTab from "@/routes/monitor/-AdminTab";

export const Route = createFileRoute("/")({ component: MonitorPage });

const TABS = ["Candles", "Connections", "Errors", "Admin"] as const;
type Tab = typeof TABS[number];

function MonitorPage() {
  const [tab, setTab] = useState<Tab>("Candles");

  return (
    <div className="flex flex-col h-full">
      <div className="flex gap-0 border-b border-gray-800 px-4 shrink-0">
        {TABS.map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? "border-blue-500 text-white"
                : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-auto">
        {tab === "Candles"     && <CandlesTab />}
        {tab === "Connections" && <ConnectionsTab />}
        {tab === "Errors"      && <ErrorsTab />}
        {tab === "Admin"       && <AdminTab />}
      </div>
    </div>
  );
}
