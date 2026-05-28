import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getApiKeys, createApiKey, revokeApiKey, toggleApiKey, repairApiKeyNonce,
  getConfig, saveConfig, getSourcesStatus,
  getHealerStatus, getAdminActions, getRateLimits,
  type ApiKey,
} from "@/lib/api";
import RepairRangePanel from "./-RepairRangePanel";

// ── healer activity card ─────────────────────────────────────────────────────

function formatHealerElapsed(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m}m ${Math.floor((ms % 60_000) / 1000)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function HealerStatusCard() {
  // Poll every 10s. Short healer activities (gapScan, often <1s) will be
  // missed at this cadence — that's acceptable since the card's purpose is
  // to surface the long-running cases (boot backfill, low-confidence reheal).
  const { data } = useQuery({
    queryKey: ["healer", "status"],
    queryFn: getHealerStatus,
    refetchInterval: 10_000,
  });
  const activities = data?.activities ?? [];
  const now = Date.now();
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-medium text-gray-200">Healer</h3>
        <span className={`text-xs font-mono ${activities.length ? "text-blue-400" : "text-gray-500"}`}>
          {activities.length ? `${activities.length} active` : "idle"}
        </span>
      </div>
      {activities.length === 0 ? (
        <div className="text-xs text-gray-500">
          No heal activity. Runs automatically: ~30s after boot, hourly gap scan, on &gt;100 detected gaps.
        </div>
      ) : (
        <ul className="space-y-1.5">
          {activities.map((a) => (
            <li key={a.name} className="text-sm text-gray-300 flex items-baseline justify-between">
              <span className="font-mono">{a.name}</span>
              <span className="text-xs text-gray-500">
                {a.meta && Object.keys(a.meta).length > 0
                  ? Object.entries(a.meta).map(([k, v]) => `${k}=${String(v)}`).join(" ") + " · "
                  : null}
                running {formatHealerElapsed(now - new Date(a.startedAt).getTime())}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function KeyRow({ k }: { k: ApiKey }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);

  const toggle = useMutation({
    mutationFn: () => toggleApiKey(k.apiKey, !k.enabled),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });
  const revoke = useMutation({
    mutationFn: () => revokeApiKey(k.apiKey),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });
  const repair = useMutation({
    mutationFn: () => repairApiKeyNonce(k.apiKey),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  return (
    <tr className="border-b border-gray-800/50">
      <td className="px-3 py-2 text-sm text-gray-200">{k.label}</td>
      <td className="px-3 py-2 font-mono text-xs text-gray-400">{k.apiKey}</td>
      <td className="px-3 py-2 text-xs text-gray-500">
        {k.lastSeen ? new Date(k.lastSeen).toLocaleString() : "Never"}
      </td>
      <td className="px-3 py-2">
        <span className={`text-xs px-1.5 py-0.5 rounded ${k.enabled ? "bg-green-900/40 text-green-400" : "bg-gray-800 text-gray-500"}`}>
          {k.enabled ? "active" : "disabled"}
        </span>
      </td>
      <td className="px-3 py-2">
        {k.nonceStatus === "ok" ? (
          <span className="text-xs text-gray-500">ok</span>
        ) : (
          <button
            onClick={() => repair.mutate()}
            disabled={repair.isPending}
            className="text-xs px-1.5 py-0.5 rounded bg-yellow-900/40 text-yellow-300 hover:bg-yellow-900/60 transition-colors disabled:opacity-50"
            title="Stored nonce exceeds wall-clock ms; every legit request is being rejected as a replay. Click to reset to 0."
          >
            repair
          </button>
        )}
      </td>
      <td className="px-3 py-2">
        <div className="flex gap-2">
          <button
            onClick={() => toggle.mutate()}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            {k.enabled ? "Disable" : "Enable"}
          </button>
          {!confirm ? (
            <button onClick={() => setConfirm(true)} className="text-xs text-red-600 hover:text-red-400 transition-colors">
              Revoke
            </button>
          ) : (
            <>
              <button onClick={() => revoke.mutate()} className="text-xs text-red-400 font-medium">Confirm</button>
              <button onClick={() => setConfirm(false)} className="text-xs text-gray-500">Cancel</button>
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

function ApiKeysSection() {
  const qc = useQueryClient();
  const [label, setLabel] = useState("");
  const [newKey, setNewKey] = useState<{ apiKey: string; secret: string } | null>(null);

  const { data } = useQuery({ queryKey: ["api-keys"], queryFn: getApiKeys });

  const issue = useMutation({
    mutationFn: () => createApiKey(label),
    onSuccess: (k) => {
      setNewKey(k);
      setLabel("");
      qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-gray-300">API Keys</h2>

      {/* Issue new key */}
      <div className="flex gap-2">
        <input
          value={label}
          onChange={e => setLabel(e.target.value)}
          placeholder="Label (e.g. ltfserv prod)"
          className="flex-1 bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500"
        />
        <button
          onClick={() => issue.mutate()}
          disabled={!label || issue.isPending}
          className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded transition-colors"
        >
          Issue key
        </button>
      </div>

      {/* Show newly issued key — shown once */}
      {newKey && (
        <div className="bg-gray-900 border border-green-800 rounded-lg p-3 text-xs space-y-1">
          <div className="text-green-400 font-medium mb-2">Key issued — copy secret now, it will not be shown again</div>
          <div><span className="text-gray-500">apiKey: </span><span className="font-mono text-gray-200">{newKey.apiKey}</span></div>
          <div><span className="text-gray-500">secret: </span><span className="font-mono text-yellow-300">{newKey.secret}</span></div>
          <button onClick={() => setNewKey(null)} className="text-gray-600 hover:text-gray-400 mt-2 block">Dismiss</button>
        </div>
      )}

      {/* Key table */}
      {data?.keys.length ? (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full">
            <thead className="border-b border-gray-800">
              <tr className="text-xs text-gray-500">
                <th className="text-left px-3 py-2">Label</th>
                <th className="text-left px-3 py-2">Key</th>
                <th className="text-left px-3 py-2">Last seen</th>
                <th className="text-left px-3 py-2">Status</th>
                <th className="text-left px-3 py-2">Nonce</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {data.keys.map(k => <KeyRow key={k.id} k={k} />)}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-gray-600">No keys issued yet.</p>
      )}
    </div>
  );
}

function ConfigSection() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["config"], queryFn: getConfig });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);

  const settings = { ...(data?.settings ?? {}), ...draft };

  const save = useMutation({
    mutationFn: () => saveConfig(draft),
    onSuccess: () => {
      setSaved(true);
      setDraft({});
      qc.invalidateQueries({ queryKey: ["config"] });
      setTimeout(() => setSaved(false), 2000);
    },
  });

  const CONFIG_KEYS = [
    { key: "minSources",                 label: "Min sources",              hint: "Min sources required before outlier guard fires (default 3)" },
    { key: "sourceAutoSuspendThreshold", label: "Auto-suspend threshold",   hint: "Failures in 24h before a source is paused (default 10)" },
    { key: "alertWebhookUrl",            label: "Alert webhook URL",        hint: "HTTP POST for gap/source alerts. Leave blank to disable." },
    { key: "redisUrl",                   label: "Redis URL",                hint: "e.g. redis://localhost:6379. Blank = auto-detect." },
  ];

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-gray-300">Configuration</h2>
      <div className="bg-gray-900 border border-gray-800 rounded-lg p-4 space-y-4">
        {CONFIG_KEYS.map(({ key, label, hint }) => (
          <div key={key}>
            <label className="text-xs text-gray-400 block mb-1">{label}</label>
            <input
              value={draft[key] ?? settings[key] ?? ""}
              onChange={e => setDraft(d => ({ ...d, [key]: e.target.value }))}
              className="w-full bg-gray-800 border border-gray-700 rounded px-3 py-1.5 text-sm text-gray-200 outline-none focus:border-blue-500"
            />
            <p className="text-xs text-gray-600 mt-1">{hint}</p>
          </div>
        ))}
        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={() => save.mutate()}
            disabled={!Object.keys(draft).length || save.isPending}
            className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded transition-colors"
          >
            Save
          </button>
          {saved && <span className="text-xs text-green-400">Saved</span>}
        </div>
      </div>
    </div>
  );
}

// ── rate limits ──────────────────────────────────────────────────────────────

function RateLimitsSection() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["rate-limits"], queryFn: getRateLimits });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const rows = data?.rateLimits ?? [];

  const save = useMutation({
    mutationFn: () => {
      const payload: Record<string, string> = {};
      for (const [source, v] of Object.entries(draft)) payload[`rateLimit.${source}`] = v;
      return saveConfig(payload);
    },
    onSuccess: () => {
      setSaved(true);
      setDraft({});
      qc.invalidateQueries({ queryKey: ["rate-limits"] });
      setTimeout(() => setSaved(false), 2000);
    },
  });

  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-gray-300">Rate limits</h2>
      <p className="text-xs text-gray-600">
        Minimum ms between API calls per venue (per-IP gate, applied across live / backfill / repair / probe).
        Blank = built-in default; 0 = no limit.
      </p>
      <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
        <table className="w-full text-xs">
          <thead className="border-b border-gray-800">
            <tr className="text-gray-500 text-left">
              <th className="px-3 py-2 font-normal">Venue</th>
              <th className="px-3 py-2 font-normal">Default</th>
              <th className="px-3 py-2 font-normal">Override (ms)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.source} className="border-b border-gray-800/50">
                <td className="px-3 py-1.5 text-gray-300">{r.source}</td>
                <td className="px-3 py-1.5 text-gray-500 font-mono">{r.defaultMs}</td>
                <td className="px-3 py-1.5">
                  <input
                    type="number"
                    min={0}
                    defaultValue={r.overrideMs ?? ""}
                    placeholder={String(r.defaultMs)}
                    onChange={(e) => setDraft((d) => ({ ...d, [r.source]: e.target.value }))}
                    className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-gray-200 w-24"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-3">
        <button
          onClick={() => save.mutate()}
          disabled={!Object.keys(draft).length || save.isPending}
          className="px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded transition-colors"
        >
          Save
        </button>
        {saved && <span className="text-xs text-green-400">Saved</span>}
      </div>
    </div>
  );
}

// ── audit log ────────────────────────────────────────────────────────────────

function actionColor(action: string): string {
  if (action.endsWith(".disable") || action.endsWith(".revoke") || action === "formula.exclude") return "text-yellow-400";
  if (action.endsWith(".enable") || action === "formula.include" || action === "apikey.create") return "text-green-400";
  if (action === "repair.start") return "text-red-400";
  return "text-gray-300";
}

function AuditSection() {
  // Pull the recent window once; filter client-side so the dropdown options
  // stay stable regardless of the active filter.
  const { data } = useQuery({
    queryKey: ["admin-actions"],
    queryFn: () => getAdminActions(200),
    refetchInterval: 15_000,
  });
  const all = data?.actions ?? [];
  const actionTypes = [...new Set(all.map((a) => a.action))].sort();
  const [filter, setFilter] = useState("");
  const rows = filter ? all.filter((a) => a.action === filter) : all;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-gray-300">Audit log</h2>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200"
        >
          <option value="">all actions ({all.length})</option>
          {actionTypes.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>
      {rows.length ? (
        <div className="bg-gray-900 border border-gray-800 rounded-lg overflow-hidden">
          <table className="w-full text-xs">
            <thead className="border-b border-gray-800">
              <tr className="text-gray-500 text-left">
                <th className="px-3 py-2 font-normal">Time</th>
                <th className="px-3 py-2 font-normal">Actor</th>
                <th className="px-3 py-2 font-normal">Action</th>
                <th className="px-3 py-2 font-normal">Target</th>
                <th className="px-3 py-2 font-normal">Detail</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.id} className="border-b border-gray-800/50 align-top">
                  <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{new Date(a.createdAt).toLocaleString()}</td>
                  <td className="px-3 py-1.5 text-gray-300 whitespace-nowrap">{a.actor}</td>
                  <td className={`px-3 py-1.5 font-mono whitespace-nowrap ${actionColor(a.action)}`}>{a.action}</td>
                  <td className="px-3 py-1.5 text-gray-400 font-mono whitespace-nowrap">{a.target ?? "—"}</td>
                  <td className="px-3 py-1.5 text-gray-600 font-mono break-all">{a.detail ? JSON.stringify(a.detail) : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-xs text-gray-600">No admin actions recorded yet.</p>
      )}
    </div>
  );
}

// ── tab shell ────────────────────────────────────────────────────────────────

const SUBTABS = ["API Keys", "Healer / Repair", "Config", "Audit"] as const;
type SubTab = typeof SUBTABS[number];

export default function AdminTab() {
  const { data: sources } = useQuery({ queryKey: ["sources", "status"], queryFn: getSourcesStatus });
  const sourceNames = Object.keys(sources?.sources ?? {});
  const [sub, setSub] = useState<SubTab>("API Keys");

  return (
    <div className="p-4">
      <div className="flex gap-1 border-b border-gray-800 mb-4">
        {SUBTABS.map((t) => (
          <button
            key={t}
            onClick={() => setSub(t)}
            className={`px-3 py-2 text-xs border-b-2 transition-colors ${
              sub === t ? "border-blue-500 text-white" : "border-transparent text-gray-500 hover:text-gray-300"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="max-w-3xl">
        {sub === "API Keys" && <ApiKeysSection />}
        {sub === "Healer / Repair" && (
          <div className="space-y-6">
            <HealerStatusCard />
            <RepairRangePanel sourceNames={sourceNames} />
          </div>
        )}
        {sub === "Config" && (
          <div className="space-y-8">
            <ConfigSection />
            <RateLimitsSection />
          </div>
        )}
        {sub === "Audit"  && <AuditSection />}
      </div>
    </div>
  );
}
