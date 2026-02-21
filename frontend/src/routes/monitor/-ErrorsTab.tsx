import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getErrors, type ServiceError } from "@/lib/api";

const WINDOWS = [
  { label: "1h",  minutes: 60 },
  { label: "6h",  minutes: 360 },
  { label: "24h", minutes: 1440 },
  { label: "7d",  minutes: 10080 },
];
const SERVICES = ["", "collector", "healer", "composite", "api"];

function ErrorRow({ err }: { err: ServiceError }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr
        className="border-b border-gray-800/50 hover:bg-gray-800/30 cursor-pointer"
        onClick={() => setOpen(o => !o)}
      >
        <td className="px-3 py-2 font-mono text-xs text-gray-500 whitespace-nowrap">
          {new Date(err.createdAt).toLocaleString()}
        </td>
        <td className="px-3 py-2">
          <span className="text-xs bg-gray-800 text-gray-300 px-1.5 py-0.5 rounded">{err.service}</span>
        </td>
        <td className="px-3 py-2 text-xs text-gray-400 font-mono">{err.location}</td>
        <td className="px-3 py-2 text-xs text-gray-200 max-w-xs truncate">{err.message}</td>
        <td className="px-3 py-2 text-xs text-gray-600">{err.stack ? "▾" : ""}</td>
      </tr>
      {open && err.stack && (
        <tr className="bg-gray-900/50">
          <td colSpan={5} className="px-3 py-2">
            <pre className="text-xs text-gray-400 whitespace-pre-wrap font-mono overflow-auto max-h-40">
              {err.stack}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

export default function ErrorsTab() {
  const [minutes, setMinutes] = useState(60);
  const [service, setService] = useState("");
  const [search, setSearch] = useState("");

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["errors", minutes, service],
    queryFn: () => getErrors(minutes, service || undefined),
    refetchInterval: 30_000,
  });

  const errors = (data?.errors ?? []).filter(e =>
    !search || e.message.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-4 space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1">
          {WINDOWS.map(w => (
            <button
              key={w.label}
              onClick={() => setMinutes(w.minutes)}
              className={`px-3 py-1.5 text-xs rounded transition-colors ${
                minutes === w.minutes ? "bg-gray-700 text-white" : "text-gray-500 hover:text-gray-300"
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
        <select
          value={service}
          onChange={e => setService(e.target.value)}
          className="bg-gray-800 border border-gray-700 text-xs text-gray-300 rounded px-2 py-1.5 outline-none"
        >
          <option value="">All services</option>
          {SERVICES.filter(Boolean).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search message…"
          className="bg-gray-800 border border-gray-700 text-xs text-gray-300 rounded px-2 py-1.5 outline-none flex-1 min-w-40"
        />
        <button
          onClick={() => refetch()}
          className="ml-auto text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          Refresh
        </button>
      </div>

      {/* Table */}
      {isLoading ? (
        <div className="text-gray-600 text-sm py-8 text-center">Loading…</div>
      ) : !errors.length ? (
        <div className="text-gray-600 text-sm py-8 text-center">No errors in selected window.</div>
      ) : (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="border-b border-gray-800">
              <tr className="text-gray-500 text-xs">
                <th className="text-left px-3 py-2">Time</th>
                <th className="text-left px-3 py-2">Service</th>
                <th className="text-left px-3 py-2">Location</th>
                <th className="text-left px-3 py-2">Message</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {errors.map(e => <ErrorRow key={e.id} err={e} />)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
