import { useQuery } from "@tanstack/react-query";
import { api, type HostManifest, type HostsList } from "@/lib/api";
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
  const manifest = useQuery({
    queryKey: ["host", name],
    queryFn: () => api.get<HostManifest>(`/hosts/${encodeURIComponent(name)}`),
    retry: false,
  });
  // engine: rclone members (Google Drive, S3, …) are reached by scheduled
  // bisync from the anchor — they run no Syncthing daemon, so asking for
  // /status can only ever 503. Gate the poll on the engine.
  const isRclone = manifest.data?.engine === "rclone";
  const status = useQuery({
    queryKey: ["host-status", name],
    queryFn: () => api.get<HostStatus>(`/hosts/${encodeURIComponent(name)}/status`),
    retry: false,
    enabled: manifest.isSuccess && !isRclone,
  });

  return (
    <li className="rounded border border-slate-800 bg-slate-950/50 p-3">
      <div className="font-mono text-sm">{name}</div>
      {isRclone ? (
        <div className="mt-1 text-xs text-slate-400">
          bisync member{manifest.data?.remote ? ` · ${manifest.data.remote}:` : ""}
        </div>
      ) : (
        <>
          {(manifest.isLoading || status.isLoading) && (
            <div className="text-xs text-slate-500">checking…</div>
          )}
          {status.isError && (
            <div className="text-xs text-error" title={(status.error as Error).message}>
              unreachable
            </div>
          )}
          {status.data && (
            <div className="mt-1 text-xs text-slate-400">
              <span className="text-idle">online</span> · {status.data.version?.version}
            </div>
          )}
        </>
      )}
    </li>
  );
}
