import { createRootRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getHealth, logout, ping } from "@/lib/api";
import { isDemo } from "@/lib/demo";
import { getTheme, setTheme, nextTheme, type Theme } from "@/lib/theme";

export const Route = createRootRoute({ component: RootLayout });

function RootLayout() {
  const navigate = useNavigate();
  const demo = isDemo();
  const [theme, setThemeState] = useState<Theme>(getTheme);

  const toggleTheme = () => {
    const next = nextTheme(theme);
    setTheme(next);
    setThemeState(next);
  };
  const THEME_ICON: Record<Theme, string> = { dark: "🌙 dark", dim: "🌫 dim", light: "☀ light" };

  // Keep session alive — ping every 4 minutes. Skipped in demo (no session).
  // If the session has been lost, the 401 handler in api.ts redirects to /login.
  useEffect(() => {
    if (demo) return;
    const interval = setInterval(() => {
      ping().catch(() => {});
    }, 4 * 60 * 1000);
    return () => clearInterval(interval);
  }, [demo]);

  const { data: health } = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    refetchInterval: 60_000,
  });

  const handleLogout = async () => {
    await logout();
    navigate({ to: "/login" });
  };

  const latestTs = health?.latestCandle
    ? new Date(health.latestCandle).toLocaleTimeString()
    : "—";

  const latencyMs = health?.collectionLatency?.avgMs ?? null;
  const latencyColor =
    latencyMs === null ? "text-gray-500"
    : latencyMs < 7000 ? "text-green-400"
    : latencyMs < 10000 ? "text-yellow-400"
    : "text-red-400";

  return (
    <div className="h-screen bg-gray-950 text-gray-100 flex flex-col overflow-hidden">
      <header className="border-b border-gray-800 px-6 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <a
            href="https://github.com/snowkidind/candleserv"
            target="_blank"
            rel="noopener noreferrer"
            className="text-gray-50 font-semibold text-sm tracking-wide hover:text-blue-400 transition-colors"
          >
            CANDLESERV COMPOSITE
          </a>
          {health && (
            <span className={`text-xs ml-4 ${latencyColor}`}>
              {latencyMs !== null ? `avg ${latencyMs}ms` : ""}
            </span>
          )}
          {health && (
            <span className="text-xs text-gray-500 ml-2">latest {latestTs}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <a
            href={`https://github.com/snowkidind/candleserv/commit/${__GIT_COMMIT__}`}
            target="_blank"
            rel="noopener noreferrer"
            title="Commit this frontend was built from"
            className="text-xs text-gray-600 hover:text-gray-300 font-mono transition-colors"
          >
            {__GIT_COMMIT__}
          </a>
          <button
            onClick={toggleTheme}
            title={`Theme: ${theme} — click to switch to ${nextTheme(theme)}`}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            {THEME_ICON[theme] ?? theme}
          </button>
          {demo ? (
            <span className="text-xs text-gray-600">demo</span>
          ) : (
            <button
              onClick={handleLogout}
              className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
            >
              logout
            </button>
          )}
        </div>
      </header>
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
      <Footer />
    </div>
  );
}

const TIP_ADDR = "0x07344205314207059daeBD225E400dCCA644E54D";

function Footer() {
  const [tips, setTips] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyTip = () => {
    navigator.clipboard?.writeText(TIP_ADDR).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  const link = "hover:text-gray-300 transition-colors";
  const sep = <span className="text-gray-700">|</span>;
  return (
    <footer className="border-t border-gray-800 shrink-0 min-h-[96px] px-6 py-6 flex flex-col items-center justify-center gap-3 text-center">
      <div className="flex items-center gap-4 text-sm text-gray-400">
        <a href="https://github.com/snowkidind/candleserv" target="_blank" rel="noopener noreferrer" className={link}>github</a>
        {sep}
        <a href="https://medium.com/@snowkidind" target="_blank" rel="noopener noreferrer" className={link}>medium</a>
        {sep}
        <span className="relative" onMouseEnter={() => setTips(true)} onMouseLeave={() => setTips(false)}>
          <button onClick={copyTip} title="Click to copy address" className={`${link} cursor-pointer`}>tips</button>
          {(tips || copied) && (
            <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-3 z-30 bg-gray-900 border border-gray-700 rounded p-2 shadow-lg">
              <img
                src={`https://api.qrserver.com/v1/create-qr-code/?size=150x150&margin=6&data=${TIP_ADDR}`}
                alt="EVM tip address QR"
                width={150}
                height={150}
                className="rounded bg-white"
              />
              {copied ? (
                <div className="mt-1 w-[150px] text-center text-[11px] font-medium text-green-400">✓ Address copied</div>
              ) : (
                <button
                  onClick={copyTip}
                  title="Click to copy"
                  className="mt-1 w-[150px] break-all font-mono text-[10px] text-left text-gray-400 hover:text-gray-200 cursor-pointer"
                >
                  EVM {TIP_ADDR}
                </button>
              )}
            </div>
          )}
        </span>
      </div>
      <div className="flex items-center gap-4 text-xs text-gray-600">
        <a href="https://claude.com/claude-code" target="_blank" rel="noopener noreferrer" className={link}>Built with Claude</a>
        {sep}
        <a href="https://github.com/snowkidind/candleserv/blob/master/LICENSE.md" target="_blank" rel="noopener noreferrer" className={link}>License: PolyForm NC</a>
      </div>
    </footer>
  );
}
