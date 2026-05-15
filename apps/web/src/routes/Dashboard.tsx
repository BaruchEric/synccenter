import { useQuery } from "@tanstack/react-query";
import { api, type ConflictsList, type FoldersList, type Health, type HostsList } from "@/lib/api";
import { Card } from "@/components/Card";

export function Dashboard() {
  const health = useQuery({ queryKey: ["health"], queryFn: () => api.get<Health>("/health") });
  const folders = useQuery({ queryKey: ["folders"], queryFn: () => api.get<FoldersList>("/folders") });
  const hosts = useQuery({ queryKey: ["hosts"], queryFn: () => api.get<HostsList>("/hosts") });
  const conflicts = useQuery({ queryKey: ["conflicts"], queryFn: () => api.get<ConflictsList>("/conflicts") });

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      <Card title="API">
        <div className="text-2xl font-semibold">
          {health.data ? "ok" : health.isError ? "down" : "…"}
        </div>
        <div className="text-xs text-slate-500">{health.data?.version}</div>
      </Card>
      <Card title="Hosts">
        <div className="text-2xl font-semibold">{hosts.data?.hosts.length ?? "…"}</div>
        <div className="text-xs text-slate-500">{hosts.data?.hosts.join(", ")}</div>
      </Card>
      <Card title="Folders">
        <div className="text-2xl font-semibold">{folders.data?.folders.length ?? "…"}</div>
        <div className="text-xs text-slate-500">{folders.data?.folders.join(", ")}</div>
      </Card>
      <Card title="Conflicts">
        <div className={`text-2xl font-semibold ${conflicts.data && conflicts.data.conflicts.length > 0 ? "text-conflict" : ""}`}>
          {conflicts.data?.conflicts.length ?? "…"}
        </div>
        <div className="text-xs text-slate-500">unresolved</div>
      </Card>
    </div>
  );
}
