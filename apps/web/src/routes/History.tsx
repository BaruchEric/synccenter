import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import {
  api,
  type ApplyHistory,
  type FoldersList,
  type HistoryKind,
  type HistoryRow,
  type RunsList,
  type RunView,
  type WindowsList,
  type WindowView,
} from "@/lib/api";
import { relative } from "@/lib/cron";
import { bytes, duration } from "@/lib/format";
import { Tag } from "@/components/Tag";

/**
 * Everything that ever finished, as tables you can filter and page.
 *
 * The activity timeline shows the last few dozen ledger rows around "now";
 * this is the whole ledger, plus the two records that carry the numbers the
 * ledger's one-line note cannot: bisync runs (bytes, transfers, checks) and
 * sync windows (how much was in sync, what was still needed, which peers
 * caught up). Same folder filter across all three, so "what happened to
 * baruchrio" is one selection, not three searches.
 */
export function History() {
  const [params, setParams] = useSearchParams();
  // URL params are the boundary: anything not on the list falls back.
  const view = parseView(params.get("view"));
  const folder = params.get("folder") ?? "";
  const kind = parseKind(params.get("kind"));
  const result = parseResult(params.get("result"));
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    setParams(next, { replace: true });
  };

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  const folders = useQuery({ queryKey: ["folders"], queryFn: () => api.get<FoldersList>("/folders") });

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="font-mono text-3xl font-semibold tracking-tight text-slate-100">history</h1>
        <nav className="flex gap-1 font-mono text-xs" aria-label="Record">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              onClick={() => set({ view: v.key === "ledger" ? "" : v.key })}
              aria-current={view === v.key ? "page" : undefined}
              className={`rounded border px-2 py-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-signal ${
                view === v.key
                  ? "border-signal/60 text-signal"
                  : "border-rule text-slate-300 hover:bg-slate-100/5"
              }`}
            >
              {v.label}
            </button>
          ))}
        </nav>
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2 font-mono text-xs">
        <Select
          label="folder"
          value={folder}
          onChange={(v) => set({ folder: v })}
          options={[["", "every folder"], ...(folders.data?.folders ?? []).map((f) => [f, f] as [string, string])]}
        />
        {view === "ledger" && (
          <>
            <Select
              label="kind"
              value={kind}
              onChange={(v) => set({ kind: v })}
              options={[
                ["", "every kind"],
                ["apply", "apply"],
                ["bisync", "bisync"],
                ["sync-window", "sync window"],
              ]}
            />
            <Select
              label="result"
              value={result}
              onChange={(v) => set({ result: v })}
              options={[
                ["", "any result"],
                ["ok", "ok"],
                ["error", "error"],
                ["dry-run", "dry run"],
              ]}
            />
          </>
        )}
      </div>

      {view === "ledger" && <Ledger folder={folder} kind={kind} result={result} now={now} />}
      {view === "runs" && <Runs folder={folder} now={now} />}
      {view === "windows" && <Windows folder={folder} now={now} />}
    </div>
  );
}

type View = "ledger" | "runs" | "windows";
const VIEWS: Array<{ key: View; label: string }> = [
  { key: "ledger", label: "Ledger" },
  { key: "runs", label: "Bisync runs" },
  { key: "windows", label: "Sync windows" },
];

function parseView(v: string | null): View {
  return VIEWS.find((x) => x.key === v)?.key ?? "ledger";
}
function parseKind(v: string | null): HistoryKind | "" {
  return v === "apply" || v === "bisync" || v === "sync-window" ? v : "";
}
function parseResult(v: string | null): HistoryRow["result"] | "" {
  return v === "ok" || v === "error" || v === "dry-run" ? v : "";
}

const PAGE = 50;

const RESULT_TONE: Record<string, string> = {
  ok: "text-ok",
  error: "text-fail",
  "dry-run": "text-dry",
  done: "text-ok",
  failed: "text-fail",
  timeout: "text-signal",
  stopped: "text-dry",
  running: "text-run",
};

const KIND_LABEL: Record<HistoryKind, string> = {
  apply: "apply",
  bisync: "bisync",
  "sync-window": "sync window",
};

function Ledger({
  folder,
  kind,
  result,
  now,
}: {
  folder: string;
  kind: HistoryKind | "";
  result: HistoryRow["result"] | "";
  now: Date;
}) {
  const q = useInfiniteQuery({
    queryKey: ["apply-history", "page", folder, kind, result],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(PAGE) });
      if (folder) qs.set("folder", folder);
      if (kind) qs.set("kind", kind);
      if (result) qs.set("result", result);
      if (pageParam) qs.set("before", String(pageParam));
      return api.get<ApplyHistory>(`/apply-history?${qs}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: 30_000,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.history) ?? [], [q.data]);

  return (
    <Table
      state={q}
      count={rows.length}
      empty="Nothing in the ledger matches. Applies, bisync runs and sync windows land here as they finish."
      head={["when", "folder", "kind", "what happened", "result", "by"]}
    >
      {rows.map((h) => {
        const at = new Date(h.ts);
        return (
          <tr key={h.id} className="border-t border-rule align-top">
            <When at={at} now={now} />
            <td className="py-2 pr-4 font-mono text-slate-100">{h.target_name}</td>
            <td className="py-2 pr-4">
              <Tag>{KIND_LABEL[h.kind]}</Tag>
            </td>
            <td className="max-w-xl py-2 pr-4 text-slate-300">{h.note ?? `${h.target_kind} ${h.target_name}`}</td>
            <td className={`py-2 pr-4 font-mono ${RESULT_TONE[h.result] ?? "text-dim"}`}>{h.result}</td>
            <td className="py-2 font-mono text-dim">
              {h.actor} · {h.source}
            </td>
          </tr>
        );
      })}
    </Table>
  );
}

function Runs({ folder, now }: { folder: string; now: Date }) {
  const q = useInfiniteQuery({
    queryKey: ["runs", "page", folder],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(PAGE) });
      if (folder) qs.set("folder", folder);
      if (pageParam) qs.set("before", String(pageParam));
      return api.get<RunsList>(`/runs?${qs}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: 15_000,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.runs) ?? [], [q.data]);

  return (
    <Table
      state={q}
      count={rows.length}
      empty="No bisync runs recorded. Runs started from this dashboard land here; the nightly crontab legs run on the anchor host and do not report."
      head={["started", "folder → member", "state", "moved", "checked", "took", "detail"]}
    >
      {rows.map((r: RunView) => (
        <tr key={r.id} className="border-t border-rule align-top">
          <When at={new Date(r.started_at)} now={now} />
          <td className="whitespace-nowrap py-2 pr-4 font-mono">
            <span className="text-slate-100">{r.folder}</span>
            <span className="text-dim"> → {r.member ?? "cloud"}</span>
          </td>
          <td className={`py-2 pr-4 font-mono ${RESULT_TONE[r.state] ?? "text-dim"}`}>
            {r.state === "running" ? r.phase : r.state}
            {r.dry_run === 1 && (
              <>
                {" "}
                <Tag>dry run</Tag>
              </>
            )}
            {r.resync === 1 && (
              <>
                {" "}
                <Tag>resync</Tag>
              </>
            )}
          </td>
          <td className="whitespace-nowrap py-2 pr-4 font-mono tabular-nums text-slate-300">
            {bytes(r.bytes)}
            {r.transfers > 0 && <span className="text-dim"> · {r.transfers.toLocaleString()} files</span>}
          </td>
          <td className="whitespace-nowrap py-2 pr-4 font-mono tabular-nums text-slate-300">
            {r.checks.toLocaleString()}
            {r.listed > 0 && <span className="text-dim"> · {r.listed.toLocaleString()} listed</span>}
          </td>
          <td className="whitespace-nowrap py-2 pr-4 font-mono tabular-nums text-slate-300">
            {took(r.started_at, r.finished_at, now)}
          </td>
          <td className="max-w-md py-2 text-xs">
            {r.error ? (
              <span className="text-fail">{r.error}</span>
            ) : r.errors > 0 ? (
              <span className="text-fail">{r.errors.toLocaleString()} errors</span>
            ) : (
              <span className="text-dim">{r.actor} · {r.source}</span>
            )}
          </td>
        </tr>
      ))}
    </Table>
  );
}

function Windows({ folder, now }: { folder: string; now: Date }) {
  const q = useInfiniteQuery({
    queryKey: ["windows", "page", folder],
    queryFn: ({ pageParam }) => {
      const qs = new URLSearchParams({ limit: String(PAGE) });
      if (folder) qs.set("folder", folder);
      if (pageParam) qs.set("before", String(pageParam));
      return api.get<WindowsList>(`/windows?${qs}`);
    },
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: 15_000,
  });
  const rows = useMemo(() => q.data?.pages.flatMap((p) => p.windows) ?? [], [q.data]);

  return (
    <Table
      state={q}
      count={rows.length}
      empty="No sync windows recorded. Scheduled and manual members get one row per window."
      head={["opened", "folder on host", "via", "state", "in sync", "still needed", "peers", "took", "detail"]}
      wide
    >
      {rows.map((w: WindowView) => (
        <tr key={w.id} className="border-t border-rule align-top">
          <When at={new Date(w.started_at)} now={now} />
          <td className="whitespace-nowrap py-2 pr-4 font-mono">
            <span className="text-slate-100">{w.folder}</span>
            <span className="text-dim"> on {w.host}</span>
          </td>
          <td className="py-2 pr-4 font-mono text-dim">{w.via}</td>
          <td className={`py-2 pr-4 font-mono ${RESULT_TONE[w.state] ?? "text-dim"}`}>
            {w.state === "running" ? w.phase : w.state}
          </td>
          <td className="whitespace-nowrap py-2 pr-4 font-mono tabular-nums text-slate-300">
            {w.fraction == null ? "—" : `${Math.round(w.fraction * 100)}%`}
            <span className="text-dim"> of {bytes(w.global_bytes)}</span>
          </td>
          <td className="whitespace-nowrap py-2 pr-4 font-mono tabular-nums text-slate-300">
            {w.need_files > 0 ? (
              <>
                {w.need_files.toLocaleString()} files <span className="text-dim">· {bytes(w.need_bytes)}</span>
              </>
            ) : (
              <span className="text-dim">nothing</span>
            )}
          </td>
          <td className="py-2 pr-4 font-mono tabular-nums text-slate-300">
            {w.peers_total > 0 ? `${w.peers_done}/${w.peers_total}` : <span className="text-dim">—</span>}
          </td>
          <td className="whitespace-nowrap py-2 pr-4 font-mono tabular-nums text-slate-300">
            {took(w.started_at, w.finished_at, now)}
            <span className="text-dim"> / {w.max_minutes}m</span>
          </td>
          <td className="max-w-md py-2 text-xs">
            {w.error ? (
              <span className={w.state === "timeout" ? "text-signal" : "text-fail"}>{w.error}</span>
            ) : w.errors > 0 ? (
              <span className="text-fail">{w.errors.toLocaleString()} folder errors</span>
            ) : (
              <span className="text-dim">
                {w.actor} · {w.source}
                {w.sync_state ? ` · last ${w.sync_state}` : ""}
              </span>
            )}
          </td>
        </tr>
      ))}
    </Table>
  );
}

function When({ at, now }: { at: Date; now: Date }) {
  return (
    <td className="whitespace-nowrap py-2 pr-4 font-mono tabular-nums">
      <time dateTime={at.toISOString()} title={at.toLocaleString()} className="text-slate-300">
        {at.toLocaleDateString([], { month: "short", day: "2-digit" })}{" "}
        {at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
      </time>
      <span className="block text-[11px] text-dim">{relative(at, now)}</span>
    </td>
  );
}

function took(from: string, to: string | null, now: Date): string {
  const end = to ? new Date(to) : now;
  return duration((end.getTime() - new Date(from).getTime()) / 1000);
}

interface PagedState {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => unknown;
}

function Table({
  state,
  count,
  empty,
  head,
  wide,
  children,
}: {
  state: PagedState;
  count: number;
  empty: string;
  head: string[];
  /** Nine columns of numbers: keep the head on one line each. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-rule bg-panel">
      {state.isLoading && <p className="px-4 py-8 text-center text-sm text-dim">Reading the record…</p>}
      {state.isError && (
        <p role="alert" className="m-4 border-l-2 border-fail pl-3 text-sm text-fail">
          {state.error instanceof Error ? state.error.message : "could not load"}
        </p>
      )}
      {!state.isLoading && !state.isError && count === 0 && (
        <p className="px-4 py-8 text-center text-sm text-dim">{empty}</p>
      )}
      {count > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-dim">
              <tr>
                {head.map((h) => (
                  <th key={h} className={`px-4 py-2 font-normal first:pl-4 ${wide ? "whitespace-nowrap" : ""}`}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="[&>tr>td:first-child]:pl-4 [&>tr>td:last-child]:pr-4">{children}</tbody>
          </table>
        </div>
      )}
      {state.hasNextPage && (
        <div className="border-t border-rule px-4 py-2">
          <button
            type="button"
            onClick={() => state.fetchNextPage()}
            disabled={state.isFetchingNextPage}
            className="rounded border border-rule px-2 py-0.5 font-mono text-[11px] text-slate-300 transition-colors hover:bg-slate-100/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:opacity-40"
          >
            {state.isFetchingNextPage ? "Loading…" : "Load older"}
          </button>
        </div>
      )}
    </section>
  );
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
      <span className="text-[11px] uppercase tracking-wider">{label}</span>
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
