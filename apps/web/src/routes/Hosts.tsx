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
          <SyncthingGui url={manifest.data?.syncthing?.api_url} />
        </>
      )}
    </li>
  );
}

/**
 * Link to a host's Syncthing web GUI — the same listener the API talks to.
 *
 * Labelled with the host:port rather than a bare "open GUI" on purpose: the
 * manifest records `api_url` from the API's vantage point, so `qnap-ts453d`
 * carries a LAN address while `mac-studio` carries `127.0.0.1`, which reaches
 * that daemon only from that machine. Showing the address makes the link say
 * what it will actually open instead of promising something it can't keep.
 */
function SyncthingGui({ url }: { url?: string }) {
  if (!url) return null;
  let label: string;
  try {
    const u = new URL(url);
    label = u.host;
  } catch {
    return null; // a malformed api_url is a config bug, not something to render
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 inline-block font-mono text-xs text-signal hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
    >
      {label} ↗
    </a>
  );
}
