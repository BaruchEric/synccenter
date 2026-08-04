import { NavLink, Outlet } from "react-router-dom";
import { clearToken } from "@/lib/auth";
import { LiveLamp } from "@/components/LiveLamp";
import { useLive } from "@/lib/live";

export function Layout() {
  const { status, active } = useLive();
  const links: Array<{ to: string; label: string }> = [
    { to: "/", label: "Dashboard" },
    { to: "/activity", label: "Activity" },
    { to: "/folders", label: "Folders" },
    { to: "/rules", label: "Rules" },
    { to: "/hosts", label: "Hosts" },
    { to: "/conflicts", label: "Conflicts" },
  ];
  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-rule px-6 py-3">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="font-mono text-lg font-semibold tracking-tight">SyncCenter</div>
          <nav className="flex flex-wrap gap-4 text-sm">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.to === "/"}
                className={({ isActive }) =>
                  `focus:outline-none focus-visible:ring-2 focus-visible:ring-signal ${
                    isActive ? "text-signal" : "text-slate-300 hover:text-slate-100"
                  }`
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-4 font-mono text-xs text-dim">
          {/* Only shown when there is something to count — a permanent "0
              running" is noise on a board that is idle most of the day. */}
          {active.length > 0 && (
            <NavLink to="/activity" className="text-signal focus:outline-none focus-visible:ring-2 focus-visible:ring-signal">
              {active.length} running
            </NavLink>
          )}
          <LiveLamp status={status} />
          <button
            onClick={() => {
              clearToken();
              location.reload();
            }}
            className="text-dim hover:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          >
            Sign out
          </button>
        </div>
      </header>
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
