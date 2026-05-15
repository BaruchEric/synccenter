import { NavLink, Outlet } from "react-router-dom";
import { clearToken } from "@/lib/auth";

export function Layout() {
  const links: Array<{ to: string; label: string }> = [
    { to: "/", label: "Dashboard" },
    { to: "/folders", label: "Folders" },
    { to: "/rules", label: "Rules" },
    { to: "/hosts", label: "Hosts" },
    { to: "/conflicts", label: "Conflicts" },
  ];
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 px-6 py-3">
        <div className="flex items-center gap-6">
          <div className="text-lg font-semibold">SyncCenter</div>
          <nav className="flex gap-4 text-sm">
            {links.map((l) => (
              <NavLink
                key={l.to}
                to={l.to}
                end={l.to === "/"}
                className={({ isActive }) =>
                  isActive ? "text-blue-400" : "text-slate-300 hover:text-slate-100"
                }
              >
                {l.label}
              </NavLink>
            ))}
          </nav>
        </div>
        <button
          onClick={() => {
            clearToken();
            location.reload();
          }}
          className="text-xs text-slate-500 hover:text-slate-300"
        >
          Sign out
        </button>
      </header>
      <main className="flex-1 overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}
