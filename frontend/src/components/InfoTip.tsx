import { useState } from "react";
import { HELP_TEXT } from "@/lib/helpText";

/**
 * Hover/tap ⓘ → popover with the help text for a control id. Tailwind only, no
 * heavy dep. Hover for desktop,
 * click/tap to pin for touch. Unknown ids render nothing (so a not-yet-written
 * id is a no-op, not a crash).
 */
export default function InfoTip({ id, className = "" }: { id: string; className?: string }) {
  const [open, setOpen] = useState(false);
  const text = HELP_TEXT[id];
  if (!text) return null;
  return (
    <span
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label="help"
        onClick={(e) => { e.preventDefault(); setOpen((v) => !v); }}
        className="w-4 h-4 inline-flex items-center justify-center rounded-full border border-gray-600 text-gray-500 hover:text-gray-200 hover:border-gray-400 text-[10px] leading-none cursor-help"
      >
        i
      </button>
      {open && (
        <span
          role="tooltip"
          className="absolute left-5 top-0 z-50 w-72 p-2.5 rounded bg-gray-950 border border-gray-700 text-gray-300 text-xs leading-relaxed shadow-lg normal-case font-normal"
        >
          {text}
        </span>
      )}
    </span>
  );
}
