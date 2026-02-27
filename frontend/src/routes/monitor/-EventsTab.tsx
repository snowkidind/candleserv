import { useQuery } from "@tanstack/react-query";
import { getServiceEvents, type ServiceEvent } from "@/lib/api";

const TYPE_STYLES: Record<string, string> = {
  outage: "bg-orange-900/50 text-orange-300 border border-orange-800",
};

function typeBadge(type: string) {
  const cls = TYPE_STYLES[type] ?? "bg-gray-800 text-gray-300";
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-mono ${cls}`}>
      {type}
    </span>
  );
}

function fmt(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric", month: "short", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
}

function EventRow({ ev }: { ev: ServiceEvent }) {
  return (
    <tr className="border-b border-gray-800/50 hover:bg-gray-800/30">
      <td className="px-3 py-2">{typeBadge(ev.type)}</td>
      <td className="px-3 py-2 font-mono text-xs text-gray-300 whitespace-nowrap">{fmt(ev.startedAt)}</td>
      <td className="px-3 py-2 font-mono text-xs text-gray-300 whitespace-nowrap">{fmt(ev.endedAt)}</td>
      <td className="px-3 py-2 text-xs text-gray-400 tabular-nums">{ev.durationMinutes} min</td>
      <td className="px-3 py-2 text-xs text-gray-500 max-w-xs truncate">{ev.notes ?? "—"}</td>
    </tr>
  );
}

export default function EventsTab() {
  const { data, isLoading, refetch } = useQuery({
    queryKey: ["service-events"],
    queryFn: getServiceEvents,
    refetchInterval: 60_000,
  });

  const events = data?.events ?? [];

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm text-gray-400">
          {events.length} event{events.length !== 1 ? "s" : ""}
        </span>
        <button
          onClick={() => refetch()}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          Refresh
        </button>
      </div>

      {isLoading ? (
        <div className="text-gray-600 text-sm py-8 text-center">Loading…</div>
      ) : !events.length ? (
        <div className="text-gray-600 text-sm py-8 text-center">No service events recorded yet.</div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="border-b border-gray-800">
              <tr className="text-gray-500 text-xs">
                <th className="text-left px-3 py-2">Type</th>
                <th className="text-left px-3 py-2">Started</th>
                <th className="text-left px-3 py-2">Ended</th>
                <th className="text-left px-3 py-2">Duration</th>
                <th className="text-left px-3 py-2">Notes</th>
              </tr>
            </thead>
            <tbody>
              {events.map(ev => <EventRow key={ev.id} ev={ev} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
