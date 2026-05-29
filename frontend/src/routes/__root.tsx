import { createRootRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { getHealth, logout, ping } from "@/lib/api";
import { isDemo } from "@/lib/demo";
import { getTheme, setTheme, type Theme } from "@/lib/theme";

export const Route = createRootRoute({ component: RootLayout });

function RootLayout() {
  const navigate = useNavigate();
  const demo = isDemo();
  const [theme, setThemeState] = useState<Theme>(getTheme);

  const toggleTheme = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setThemeState(next);
  };

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
          <span className="text-white font-semibold text-sm tracking-wide">CANDLESERV</span>
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
          <button
            onClick={toggleTheme}
            title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
          >
            {theme === "dark" ? "☀ light" : "🌙 dark"}
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
    </div>
  );
}
