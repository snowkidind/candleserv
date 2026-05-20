import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getSourceHistory, type SourceHistoryBin } from "@/lib/api";

interface Props {
  source: string;
  onClose: () => void;
}

// Stacked bar chart on a canvas — same pattern as TimelineCanvas. One bar per
// day, height proportional to 1440 minutes/day. Categories stack bottom-to-top:
// used (green), formulaExcluded (gray), outlierRejected (red), missing (white).
function HistoryCanvas({ bins, onHover }: { bins: SourceHistoryBin[]; onHover: (idx: number | null) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    if (bins.length === 0) return;
    const barW = W / bins.length;
    const total = 1440; // minutes per day

    bins.forEach((b, i) => {
      const x = i * barW;
      let yCursor = H;
      const sections: Array<[number, string]> = [
        [b.used,            "#16a34a"],   // green
        [b.formulaExcluded, "#6b7280"],   // gray
        [b.outlierRejected, "#b91c1c"],   // red
        [b.missing,         "#1f2937"],   // dark — visually faint
      ];
      for (const [count, color] of sections) {
        if (count <= 0) continue;
        const h = (count / total) * H;
        ctx.fillStyle = color;
        ctx.fillRect(x, yCursor - h, Math.max(1, barW - 0.5), h);
        yCursor -= h;
      }
    });
  }, [bins]);

  return (
    <canvas
      ref={canvasRef}
      width={900}
      height={140}
      className="w-full rounded border border-gray-800"
      onMouseMove={(e) => {
        const rect = (e.target as HTMLCanvasElement).getBoundingClientRect();
        const xpct = (e.clientX - rect.left) / rect.width;
        const idx = Math.min(bins.length - 1, Math.max(0, Math.floor(xpct * bins.length)));
        onHover(idx);
      }}
      onMouseLeave={() => onHover(null)}
    />
  );
}

function StatRow({ label, value, total }: { label: string; value: number; total: number }) {
  const pct = total > 0 ? ((value / total) * 100).toFixed(1) : "0.0";
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-gray-400">{label}</span>
      <span className="text-gray-200 font-mono">
        {pct}% <span className="text-gray-600">({value.toLocaleString()})</span>
      </span>
    </div>
  );
}

export default function SourceHistoryModal({ source, onClose }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ["sources", source, "history", 180],
    queryFn: () => getSourceHistory(source, 180),
  });
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const hover = hoverIdx !== null && data ? data.bins[hoverIdx] : null;

  return (
    <div
      className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-gray-900 border border-gray-700 rounded-lg max-w-4xl w-full p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-medium text-gray-100 capitalize">
            {source} — 180 day history
          </h2>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-gray-300 text-sm"
          >
            ✕ close
          </button>
        </div>

        {isLoading || !data ? (
          <div className="text-gray-500 text-sm py-12 text-center">Loading…</div>
        ) : (
          <>
            <HistoryCanvas bins={data.bins} onHover={setHoverIdx} />
            <div className="flex gap-4 mt-3 text-xs text-gray-500">
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded bg-green-700 inline-block" /> used
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded bg-gray-500 inline-block" /> formula-excluded
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded bg-red-800 inline-block" /> outlier-rejected
              </span>
              <span className="flex items-center gap-1">
                <span className="w-2 h-2 rounded bg-gray-800 border border-gray-700 inline-block" /> missing
              </span>
            </div>

            {hover && (
              <div className="mt-3 text-xs text-gray-400 font-mono">
                {new Date(hover.day).toISOString().slice(0, 10)} —
                used {hover.used}, formula-excluded {hover.formulaExcluded},
                outlier-rejected {hover.outlierRejected}, missing {hover.missing}
              </div>
            )}

            <div className="grid grid-cols-2 gap-6 mt-5">
              <div>
                <div className="text-xs text-gray-500 mb-2 uppercase tracking-wider">
                  Lifetime (last 180d)
                </div>
                <div className="space-y-1.5">
                  <StatRow label="Used in formula"  value={data.lifetime.used}            total={data.lifetime.totalRows + data.lifetime.missing} />
                  <StatRow label="Formula excluded" value={data.lifetime.formulaExcluded} total={data.lifetime.totalRows + data.lifetime.missing} />
                  <StatRow label="Outlier rejected" value={data.lifetime.outlierRejected} total={data.lifetime.totalRows + data.lifetime.missing} />
                  <StatRow label="Missing"          value={data.lifetime.missing}         total={data.lifetime.totalRows + data.lifetime.missing} />
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-2 uppercase tracking-wider">
                  Last 30 days
                </div>
                <div className="space-y-1.5">
                  <StatRow label="Used in formula"  value={data.last30d.used}            total={data.last30d.totalRows + data.last30d.missing} />
                  <StatRow label="Formula excluded" value={data.last30d.formulaExcluded} total={data.last30d.totalRows + data.last30d.missing} />
                  <StatRow label="Outlier rejected" value={data.last30d.outlierRejected} total={data.last30d.totalRows + data.last30d.missing} />
                  <StatRow label="Missing"          value={data.last30d.missing}         total={data.last30d.totalRows + data.last30d.missing} />
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
