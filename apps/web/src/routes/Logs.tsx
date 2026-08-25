import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  api,
  type FolderErrors,
  type FoldersList,
  type HostLog,
  type LogLevel,
  type LogLine,
  type LogList,
  type LogSource,
} from "@/lib/api";
import { LiveLamp } from "@/components/LiveLamp";
import { Tag } from "@/components/Tag";
import { useRcloneHosts } from "@/lib/hosts";
import { useLive } from "@/lib/live";

/**
 * Two logs, because there are two narrators.
 *
 * The first is SyncCenter's own: every window it opened and why it closed,
 * every bisync it started and how it ended, every apply, every re-pause by
 * the reconciler. Tailed live over the event stream, paged from SQLite.
 *
 * The second is Syncthing's, per host: what the daemon itself has to say,
 * and the per-file reasons behind a folder's `errors` count. Read on demand,
 * because that log lives in the daemon's memory, not ours.
 */
export function Logs() {
  const [params, setParams] = useSearchParams();
  const level = parseLevel(params.get("level"));
  const source = parseSource(params.get("source"));
  const folder = params.get("folder") ?? "";
  const [q, setQ] = useState(params.get("q") ?? "");
  const [debouncedQ, setDebouncedQ] = useState(q);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const { status, logLines } = useLive();
  const folders = useQuery({ queryKey: ["folders"], queryFn: () => api.get<FoldersList>("/folders") });

  const pages = useInfiniteQuery({
    queryKey: ["log", level, source, folder, debouncedQ],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: "100" });
      if (level) qs.set("level", level);
      if (source) qs.set("source", source);
      if (folder) qs.set("folder", folder);
      if (debouncedQ) qs.set("q", debouncedQ);
      if (pageParam) qs.set("before", String(pageParam));
      return api.get<LogList>(`/log?${qs}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });

  // The fetched pages are the record; lines pushed since the first page was
  // read go on top, filtered here the same way the server filtered the rest.
  const lines = useMemo(() => {
    const fetched = pages.data?.pages.flatMap((p) => p.lines) ?? [];
    const newest = fetched[0]?.id ?? 0;
    const live = logLines.filter(
      (l) =>
        l.id > newest &&
        (!level || l.level === level) &&
        (!source || l.source === source) &&
        (!folder || l.folder === folder) &&
        (!debouncedQ || l.message.toLowerCase().includes(debouncedQ.toLowerCase())),
    );
    return [...live, ...fetched];
  }, [pages.data, logLines, level, source, folder, debouncedQ]);

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-mono text-3xl font-semibold tracking-tight text-slate-100">logs</h1>
        <div className="font-mono text-sm text-dim">
          <LiveLamp status={status} />
        </div>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2 font-mono text-xs">
        <Select
          label="level"
          value={level ?? ""}
          onChange={(v) => set({ level: v })}
          options={[
            ["", "every level"],
            ["info", "info"],
            ["warn", "warn"],
            ["error", "error"],
          ]}
        />
        <Select
          label="source"
          value={source ?? ""}
          onChange={(v) => set({ source: v })}
          options={[["", "every source"], ...SOURCES.map((s) => [s, s] as [string, string])]}
        />
        <Select
          label="folder"
          value={folder}
          onChange={(v) => set({ folder: v })}
          options={[["", "every folder"], ...(folders.data?.folders ?? []).map((f) => [f, f] as [string, string])]}
        />
        <label className="flex items-center gap-1.5 text-dim">
          <span className="text-[11px] uppercase tracking-wider">find</span>
          <input
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              set({ q: e.target.value });
            }}
            placeholder="text in the message"
            className="w-56 rounded border border-rule bg-ink px-2 py-1 font-mono text-xs text-slate-200 placeholder:text-dim focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          />
        </label>
      </div>

      <section aria-label="SyncCenter log" className="rounded-lg border border-rule bg-panel">
        <h2 className="border-b border-rule px-4 py-2 text-xs uppercase tracking-wider text-dim">
          SyncCenter
        </h2>
        {pages.isLoading && <p className="px-4 py-8 text-center text-sm text-dim">Reading the log…</p>}
        {pages.isError && (
          <p role="alert" className="m-4 border-l-2 border-fail pl-3 text-sm text-fail">
            {pages.error instanceof Error ? pages.error.message : "could not load"}
          </p>
        )}
        {!pages.isLoading && !pages.isError && lines.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-dim">
            Nothing logged that matches. Windows, bisync runs, applies and the reconciler write here
            as they go.
          </p>
        )}
        {lines.length > 0 && (
          <ol className="divide-y divide-rule">
            {lines.map((l) => (
              <Line key={l.id} line={l} />
            ))}
          </ol>
        )}
        {pages.hasNextPage && (
          <div className="border-t border-rule px-4 py-2">
            <button
              type="button"
              onClick={() => pages.fetchNextPage()}
              disabled={pages.isFetchingNextPage}
              className="rounded border border-rule px-2 py-0.5 font-mono text-[11px] text-slate-300 transition-colors hover:bg-slate-100/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:opacity-40"
            >
              {pages.isFetchingNextPage ? "Loading…" : "Load older"}
            </button>
          </div>
        )}
      </section>

      <SyncthingPanel folders={folders.data?.folders ?? []} folder={folder} />
    </div>
  );
}

const SOURCES: LogSource[] = ["sync", "window", "schedule", "reconcile", "bisync", "apply", "folder", "system"];

function parseLevel(v: string | null): LogLevel | null {
  return v === "info" || v === "warn" || v === "error" ? v : null;
}
function parseSource(v: string | null): LogSource | null {
  return SOURCES.find((s) => s === v) ?? null;
}

const LEVEL_DOT: Record<LogLevel, string> = {
  info: "bg-dim",
  warn: "bg-signal",
  error: "bg-fail",
};

function Line({ line }: { line: LogLine }) {
  const [open, setOpen] = useState(false);
  const at = new Date(line.ts);
  const where = [line.folder, line.host].filter(Boolean).join(" @ ");
  const hasData = line.data !== null && Object.keys(line.data).length > 0;
  return (
    <li className="px-4 py-1.5 font-mono text-xs">
      <div className="flex items-start gap-3">
        <time
          dateTime={line.ts}
          title={at.toLocaleString()}
          className="w-[7.5rem] shrink-0 whitespace-nowrap tabular-nums text-dim"
        >
          {at.toLocaleDateString([], { month: "short", day: "2-digit" })}{" "}
          {at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
        </time>
        <span
          aria-label={line.level}
          title={line.level}
          className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${LEVEL_DOT[line.level]}`}
        />
        <span className="w-20 shrink-0">
          <Tag>{line.source}</Tag>
        </span>
        <span className="min-w-0 flex-1">
          {where && <span className="text-slate-400">{where} </span>}
          <span className={line.level === "error" ? "text-fail" : line.level === "warn" ? "text-signal" : "text-slate-200"}>
            {line.message}
          </span>
          {hasData && (
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              className="ml-2 text-dim hover:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            >
              {open ? "less" : "more"}
            </button>
          )}
          {open && hasData && (
            <pre className="mt-1 overflow-x-auto rounded border border-rule bg-ink p-2 text-[11px] text-slate-400">
              {JSON.stringify(line.data, null, 2)}
            </pre>
          )}
        </span>
      </div>
    </li>
  );
}

/** Syncthing's own log per host, and the per-file errors behind a folder's count. */
function SyncthingPanel({ folders, folder }: { folders: string[]; folder: string }) {
  const { syncthing } = useRcloneHosts();
  const [host, setHost] = useState("");
  const chosen = host || syncthing[0] || "";
  const [errFolder, setErrFolder] = useState("");
  const chosenFolder = errFolder || folder || folders[0] || "";

  const log = useQuery({
    queryKey: ["host-log", chosen],
    queryFn: () => api.get<HostLog>(`/hosts/${encodeURIComponent(chosen)}/log`),
    enabled: !!chosen,
    retry: false,
  });
  const errors = useQuery({
    queryKey: ["folder-errors", chosenFolder],
    queryFn: () => api.get<FolderErrors>(`/folders/${encodeURIComponent(chosenFolder)}/errors`),
    enabled: !!chosenFolder,
    retry: false,
  });

  // Newest first, like the log above; Syncthing hands them oldest first.
  const messages = useMemo(() => [...(log.data?.messages ?? [])].reverse(), [log.data]);

  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      <section aria-label="Syncthing log" className="min-w-0 rounded-lg border border-rule bg-panel">
        <h2 className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-4 py-2 text-xs uppercase tracking-wider text-dim">
          <span>Syncthing on</span>
          <span className="flex items-center gap-2 normal-case tracking-normal">
            <Select
              label=""
              value={chosen}
              onChange={setHost}
              options={syncthing.map((h) => [h, h] as [string, string])}
            />
            <button
              type="button"
              onClick={() => void log.refetch()}
              className="rounded border border-rule px-2 py-0.5 font-mono text-[11px] text-slate-300 transition-colors hover:bg-slate-100/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            >
              Refresh
            </button>
          </span>
        </h2>
        {!chosen && <p className="px-4 py-6 text-center text-sm text-dim">No Syncthing host known yet.</p>}
        {log.isLoading && <p className="px-4 py-6 text-center text-sm text-dim">Asking {chosen}…</p>}
        {log.isError && (
          <p role="alert" className="m-4 border-l-2 border-fail pl-3 text-sm text-fail">
            {chosen} did not answer: {log.error instanceof Error ? log.error.message : "unreachable"}
          </p>
        )}
        {log.isSuccess && messages.length === 0 && (
          <p className="px-4 py-6 text-center text-sm text-dim">The daemon's log ring is empty.</p>
        )}
        {messages.length > 0 && (
          <ol className="max-h-[32rem] divide-y divide-rule overflow-y-auto">
            {messages.map((m, i) => {
              const at = new Date(m.when);
              return (
                <li key={`${m.when}-${i}`} className="flex items-start gap-3 px-4 py-1.5 font-mono text-xs">
                  <time
                    dateTime={m.when}
                    title={at.toLocaleString()}
                    className="w-[7.5rem] shrink-0 whitespace-nowrap tabular-nums text-dim"
                  >
                    {at.toLocaleDateString([], { month: "short", day: "2-digit" })}{" "}
                    {at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}
                  </time>
                  <span className={`min-w-0 flex-1 break-words ${syncthingTone(m.level, m.message)}`}>{m.message}</span>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section aria-label="Folder errors" className="min-w-0 rounded-lg border border-rule bg-panel">
        <h2 className="flex flex-wrap items-center justify-between gap-2 border-b border-rule px-4 py-2 text-xs uppercase tracking-wider text-dim">
          <span>What cannot sync in</span>
          <span className="flex items-center gap-2 normal-case tracking-normal">
            <Select
              label=""
              value={chosenFolder}
              onChange={setErrFolder}
              options={folders.map((f) => [f, f] as [string, string])}
            />
            <button
              type="button"
              onClick={() => void errors.refetch()}
              className="rounded border border-rule px-2 py-0.5 font-mono text-[11px] text-slate-300 transition-colors hover:bg-slate-100/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            >
              Refresh
            </button>
          </span>
        </h2>
        {errors.isLoading && <p className="px-4 py-6 text-center text-sm text-dim">Asking every member…</p>}
        {errors.isError && (
          <p role="alert" className="m-4 border-l-2 border-fail pl-3 text-sm text-fail">
            {errors.error instanceof Error ? errors.error.message : "could not load"}
          </p>
        )}
        {errors.data && (
          <ul className="divide-y divide-rule">
            {errors.data.perHost.map((h) => (
              <li key={h.host} className="px-4 py-2 font-mono text-xs">
                <div className="flex items-baseline gap-2">
                  <span className="text-slate-400">{h.host}</span>
                  {!h.ok && <span className="text-fail">unreachable{h.error ? ` · ${h.error}` : ""}</span>}
                  {h.ok && h.errors.length === 0 && <span className="text-ok">nothing failing</span>}
                  {h.ok && h.errors.length > 0 && (
                    <span className="text-fail">
                      {h.errors.length} item{h.errors.length === 1 ? "" : "s"} failing
                    </span>
                  )}
                </div>
                {h.errors.length > 0 && (
                  <ol className="mt-1 max-h-64 space-y-1 overflow-y-auto">
                    {h.errors.map((e) => (
                      <li key={e.path} className="break-all">
                        <span className="text-slate-200">{e.path}</span>
                        <span className="text-dim"> — {e.error}</span>
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="border-t border-rule px-4 py-2 text-[11px] text-dim">
          This is the list behind a folder's <span className="font-mono">errors</span> count — the
          items a member keeps failing to pull. A window with errors here will not close as done.
        </p>
      </section>
    </div>
  );
}

/**
 * Syncthing's log level is an integer (slog-style, larger is louder); the
 * message text is the more reliable tell on daemons that omit it.
 */
function syncthingTone(level: number | undefined, message: string): string {
  const text = message.toLowerCase();
  if ((level !== undefined && level >= 3) || text.includes("failed") || text.includes("error")) return "text-fail";
  if ((level !== undefined && level >= 2) || text.includes("warn")) return "text-signal";
  return "text-slate-300";
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="flex items-center gap-1.5 text-dim">
      {label && <span className="text-[11px] uppercase tracking-wider">{label}</span>}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded border border-rule bg-ink px-2 py-1 font-mono text-xs text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
      >
        {options.map(([v, l]) => (
          <option key={v || "-"} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
