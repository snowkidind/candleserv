import { createRootRoute, Outlet, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { getHealth, logout } from "@/lib/api";

export const Route = createRootRoute({ component: RootLayout });

function RootLayout() {
  const navigate = useNavigate();
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
    <div className="min-h-screen bg-gray-950 text-gray-100 flex flex-col">
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
        <button
          onClick={handleLogout}
          className="text-xs text-gray-500 hover:text-gray-300 transition-colors"
        >
          logout
        </button>
      </header>
      <main className="flex-1 overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}
