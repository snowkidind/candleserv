import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  getApiKeys, createApiKey, revokeApiKey, toggleApiKey,
  getConfig, saveConfig,
  type ApiKey,
} from "@/lib/api";

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

export default function AdminTab() {
  return (
    <div className="p-4 space-y-6 max-w-3xl">
      <ApiKeysSection />
      <ConfigSection />
    </div>
  );
}
