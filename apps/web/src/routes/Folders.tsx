import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api, type FolderManifest, type FoldersList, type ScheduleList } from "@/lib/api";
import { FolderActions } from "@/components/FolderActions";
import { useFolderRuns } from "@/lib/live";
import { nextRuns, relative } from "@/lib/cron";

/**
 * Every managed folder, with the verbs that act on it.
 *
 * A folder's whole story fits on one line here — what governs it, where it
 * lives, when it next runs — so the list is the working surface rather than an
 * index of pages you have to visit to find anything out.
 */
export function Folders() {
  const folders = useQuery({ queryKey: ["folders"], queryFn: () => api.get<FoldersList>("/folders") });
  const schedule = useQuery({
    queryKey: ["schedule"],
    queryFn: () => api.get<ScheduleList>("/schedule"),
    retry: false,
  });

  const names = folders.data?.folders ?? [];
  const cloud = new Set((schedule.data?.jobs ?? []).map((j) => j.folder));
  const crons = new Map((schedule.data?.jobs ?? []).map((j) => [j.folder, j.cron]));

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-mono text-3xl font-semibold tracking-tight text-slate-100">folders</h1>
        <Link
          to="/folders/new"
          className="rounded border border-signal/60 px-3 py-1.5 font-mono text-xs text-signal transition-colors hover:bg-signal/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
        >
          New folder
        </Link>
      </header>

      {folders.isLoading && <p className="py-12 text-center text-sm text-dim">Reading folders/…</p>}
      {folders.isError && (
        <p role="alert" className="border-l-2 border-fail pl-3 text-sm text-fail">
          {(folders.error as Error).message}
        </p>
      )}

      {folders.isSuccess && names.length === 0 && (
        <div className="rounded-lg border border-dashed border-rule px-6 py-12 text-center">
          <p className="text-sm text-slate-300">No folders yet.</p>
          <p className="mx-auto mt-1 max-w-sm text-xs text-dim">
            A folder is one directory tree and the hosts that carry it. Create one, then apply it to
            push the ignore rules out to every host.
          </p>
          <Link
            to="/folders/new"
            className="mt-4 inline-block rounded border border-signal/60 px-3 py-1.5 font-mono text-xs text-signal transition-colors hover:bg-signal/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          >
            Create the first folder
          </Link>
        </div>
      )}

      {names.length > 0 && (
        <ul className="divide-y divide-rule rounded-lg border border-rule bg-panel">
          {names.map((name) => (
            <Row key={name} name={name} hasCloud={cloud.has(name)} cron={crons.get(name)} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ name, hasCloud, cron }: { name: string; hasCloud: boolean; cron?: string }) {
  const manifest = useQuery({
    queryKey: ["folder", name],
    queryFn: () => api.get<FolderManifest>(`/folders/${encodeURIComponent(name)}`),
    retry: false,
  });
  const runs = useFolderRuns(name);
  const m = manifest.data;
  const disabled = m?.enabled === false;
  const upcoming = cron ? nextRuns(cron, 1, new Date()) : [];

  return (
    <li className={`px-4 py-3 ${disabled ? "opacity-55" : ""}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <Link
            to={`/folders/${encodeURIComponent(name)}`}
            className="font-mono text-sm text-slate-100 hover:text-signal focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          >
            {name}
          </Link>
          {disabled && (
            <span className="text-[10px] uppercase tracking-wider text-dim">off</span>
          )}
          {m && <span className="font-mono text-xs text-dim">{m.ruleset}</span>}
          {m && <span className="font-mono text-xs text-dim">{m.type}</span>}
        </div>
        <div className="font-mono text-xs tabular-nums text-dim">
          {disabled
            ? "no scheduled runs"
            : upcoming.length > 0
              ? `next ${relative(upcoming[0]!, new Date())}`
              : hasCloud
                ? "no schedule"
                : "local mesh only"}
        </div>
      </div>

      {m && (
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 font-mono text-[11px] text-dim">
          {Object.entries(m.paths ?? {}).map(([host, path]) => (
            <span key={host} className="truncate">
              <span className="text-slate-400">{host}</span> {path}
            </span>
          ))}
        </div>
      )}

      {runs.map((r) => (
        <p key={r.id} className="mt-1 font-mono text-[11px] text-signal">
          running now — {r.phase === "transferring" ? `${Math.round((r.fraction ?? 0) * 100)}%` : "checking"}
        </p>
      ))}

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Link
          to={`/folders/${encodeURIComponent(name)}/edit`}
          className="rounded border border-rule px-2 py-0.5 font-mono text-[11px] text-slate-300 transition-colors hover:bg-slate-100/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
        >
          Edit
        </Link>
        <FolderActions name={name} manifest={m} hasCloudMember={hasCloud} />
      </div>
    </li>
  );
}
