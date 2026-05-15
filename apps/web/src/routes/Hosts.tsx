import { useQuery } from "@tanstack/react-query";
import { api, type HostsList } from "@/lib/api";
import { Card } from "@/components/Card";

interface HostStatus {
  host: string;
  online: boolean;
  version?: { version: string };
  status?: { uptime: number; myID: string };
}

export function Hosts() {
  const list = useQuery({ queryKey: ["hosts"], queryFn: () => api.get<HostsList>("/hosts") });

  return (
    <Card title={`Hosts (${list.data?.hosts.length ?? "…"})`}>
      {list.data ? (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {list.data.hosts.map((h) => (
            <HostCard key={h} name={h} />
          ))}
        </ul>
      ) : (
        <div className="text-slate-500">…</div>
      )}
    </Card>
  );
}

function HostCard({ name }: { name: string }) {
  const q = useQuery({
    queryKey: ["host-status", name],
    queryFn: () => api.get<HostStatus>(`/hosts/${encodeURIComponent(name)}/status`),
    retry: false,
  });
  return (
    <li className="rounded border border-slate-800 bg-slate-950/50 p-3">
      <div className="font-mono text-sm">{name}</div>
      {q.isLoading && <div className="text-xs text-slate-500">checking…</div>}
      {q.isError && <div className="text-xs text-error">{(q.error as Error).message}</div>}
      {q.data && (
        <div className="mt-1 text-xs text-slate-400">
          <span className="text-idle">online</span> · {q.data.version?.version}
        </div>
      )}
    </li>
  );
}
