import { useEffect, useMemo, useState } from "react";
import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  api,
  type ApplyHistory,
  type FolderManifest,
  type FoldersList,
  type FolderState,
  type ScheduleList,
} from "@/lib/api";
import { nextRuns, relative } from "@/lib/cron";
import { FolderActions } from "@/components/FolderActions";
import { RunBand } from "@/components/RunBand";
import { SyncBand, type HostStatus } from "@/components/SyncBand";
import { useLive } from "@/lib/live";
import { LiveLamp } from "@/components/LiveLamp";

/**
 * One time axis, read top to bottom as time decreasing:
 *
 *   ┆  scheduled runs (cron knows them; nothing has happened yet)
 *   ●  ─────────── NOW ───────────
 *   ┃  applies that already happened, newest first
 *
 * The rule is dotted above the line and solid below it: the future is the part
 * that isn't written yet. Selecting any event fills the detail panel.
 */
export function Activity() {
  const [now, setNow] = useState(() => new Date());
  const [selected, setSelected] = useState<Event | null>(null);
  const { status, active } = useLive();

  // One clock for the whole view, so every relative time recomputes together.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const history = useQuery({
    queryKey: ["apply-history"],
    queryFn: () => api.get<ApplyHistory>("/apply-history"),
    refetchInterval: 15_000,
  });
  const schedule = useQuery({
    queryKey: ["schedule"],
    queryFn: () => api.get<ScheduleList>("/schedule"),
    refetchInterval: 60_000,
    retry: false,
  });
  const folders = useQuery({ queryKey: ["folders"], queryFn: () => api.get<FoldersList>("/folders") });
  const names = useMemo(() => folders.data?.folders ?? [], [folders.data]);

  // Hoisted out of the Right-now rows so the timeline can read the same poll:
  // a folder Syncthing is working on has to appear at `now`, not only in the
  // panel above it. One query per folder, one observer each.
  const states = useQueries({
    queries: names.map((n) => ({
      queryKey: ["folder-state", n],
      queryFn: () => api.get<FolderState>(`/folders/${encodeURIComponent(n)}/state`),
      refetchInterval: 10_000,
      retry: false,
    })),
  });

  // Idle is the resting state and paused is deliberate; neither is work in
  // flight. Everything else — scanning, syncing, cleaning, error — is.
  const busy = names.flatMap((name, i) =>
    (states[i]?.data?.perHost ?? [])
      .filter((h) => h.ok && h.status && h.status.state !== "idle" && h.status.state !== "paused")
      .map((h) => ({ folder: name, host: h.host, status: h.status as HostStatus })),
  );

  const upcoming = useMemo<Event[]>(() => {
    const jobs = schedule.data?.jobs ?? [];
    return jobs
      .flatMap((j) =>
        nextRuns(j.cron, 2, now).map((at) => ({
          kind: "scheduled" as const,
          at,
          title: j.folder,
          detail: `bisync → ${j.member}`,
          job: j,
        })),
      )
      .sort((a, b) => b.at.getTime() - a.at.getTime()); // furthest future at top
    // `now` intentionally omitted: re-deriving every second would remount rows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schedule.data]);

  const past = useMemo<Event[]>(
    () =>
      (history.data?.history ?? []).map((h) => ({
        kind: "history" as const,
        at: new Date(h.ts),
        title: h.target_name,
        // The note is the only part that says what actually happened — which
        // cloud member, how much moved, how long it took. `folder · api` is
        // the shape of the table, and it makes every row look like every
        // other row. A finished bisync reads as a bisync.
        detail: h.note ?? `apply · ${h.source}`,
        row: h,
      })),
    [history.data],
  );

  const loading = history.isLoading || schedule.isLoading;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0">
        <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
          <h1 className="font-mono text-3xl font-semibold tracking-tight text-slate-100">activity</h1>
          <div className="flex items-baseline gap-3 font-mono text-sm tabular-nums text-dim">
            <LiveLamp status={status} />
            <time dateTime={now.toISOString()}>
              {now.toLocaleTimeString([], { hour12: false })}
            </time>
          </div>
        </header>

        {/* Only folders the planner emits a bisync leg for can be "Run". */}
        <LegStrip
          names={names}
          states={states}
          cloudFolders={new Set((schedule.data?.jobs ?? []).map((j) => j.folder))}
        />

        <section aria-label="Timeline" className="mt-6">
          {loading && <p className="py-8 text-center text-sm text-dim">Reading the ledger…</p>}

          {!loading && (
            <ol className="relative">
              {upcoming.map((e, i) => (
                <Row key={`s-${i}`} event={e} now={now} selected={selected} onSelect={setSelected} />
              ))}

              <li className="relative flex items-center gap-3 py-2">
                <span className="w-20 shrink-0 text-right font-mono text-xs tabular-nums text-signal">
                  now
                </span>
                <span
                  className="relative z-10 h-2 w-2 shrink-0 rounded-full bg-signal ring-4 ring-ink"
                  aria-hidden
                />
                <span
                  className="h-px flex-1 bg-gradient-to-r from-signal/70 to-transparent"
                  aria-hidden
                />
              </li>

              {active.map((run) => (
                <RunBand key={run.id} run={run} now={now} />
              ))}

              {busy.map((b) => (
                <SyncBand
                  key={`${b.folder}@${b.host}`}
                  folder={b.folder}
                  host={b.host}
                  status={b.status}
                  now={now}
                />
              ))}

              {past.map((e) => (
                <Row key={`h-${e.row!.id}`} event={e} now={now} selected={selected} onSelect={setSelected} />
              ))}

              {past.length === 0 && (
                <li className="ml-[6.5rem] border-l border-rule py-6 pl-5 text-sm text-dim">
                  No applies recorded yet. Apply a folder and it lands here with who ran it and what
                  changed.
                </li>
              )}
            </ol>
          )}

          {/* The nightly legs shell out to the rclone CLI on the anchor, not to
              the rcd this server talks to, so nothing about them reaches the
              tracker. Better to say so than to let an empty stretch below the
              now line read as "the 04:00 run never happened". */}
          {!loading && (schedule.data?.jobs.length ?? 0) > 0 && (
            <p className="mt-6 border-l-2 border-rule py-2 pl-3 text-xs text-dim">
              The now line carries bisync runs started from this dashboard (amber) and whatever
              Syncthing is doing on its own (blue). Scheduled runs are neither: they execute on the
              anchor host directly and finish without reporting progress here.
            </p>
          )}

          {schedule.isError && (
            <p className="mt-4 border-l-2 border-fail py-2 pl-3 text-xs text-dim">
              Scheduled runs unavailable — the API could not read the schedule.
            </p>
          )}
        </section>
      </div>

      <Detail event={selected} now={now} />
    </div>
  );
}

type ScheduleJob = ScheduleList["jobs"][number];
type HistoryRow = ApplyHistory["history"][number];
interface Event {
  kind: "scheduled" | "history";
  at: Date;
  title: string;
  detail: string;
  job?: ScheduleJob;
  row?: HistoryRow;
}

const RESULT_TONE: Record<string, string> = {
  ok: "text-ok",
  error: "text-fail",
  "dry-run": "text-dry",
};

function Row({
  event,
  now,
  selected,
  onSelect,
}: {
  event: Event;
  now: Date;
  selected: Event | null;
  onSelect: (e: Event) => void;
}) {
  const future = event.kind === "scheduled";
  const result = event.row?.result;
  const isSelected =
    selected?.at.getTime() === event.at.getTime() && selected?.title === event.title;

  return (
    <li className="relative">
      {/* The spine is drawn on the <li>, not inside the button: row padding
          would otherwise break the rule into disconnected dashes and it would
          stop reading as one continuous axis. */}
      <span
        aria-hidden
        className={`absolute inset-y-0 left-24 -translate-x-1/2 ${
          future ? "border-l border-dashed border-rule" : "border-l border-rule"
        }`}
      />
      <button
        type="button"
        onClick={() => onSelect(event)}
        aria-current={isSelected || undefined}
        className={`group relative flex w-full items-start gap-3 rounded-sm py-2 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-signal ${
          isSelected ? "text-slate-100" : "text-slate-300 hover:text-slate-100"
        }`}
      >
        <span
          className={`w-20 shrink-0 pt-px text-right font-mono text-xs tabular-nums ${
            future ? "text-dim" : "text-slate-400"
          }`}
        >
          {event.at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}
        </span>

        <span className="flex w-2 shrink-0 justify-center" aria-hidden>
          <span
            className={`mt-1.5 h-2 w-2 rounded-full ring-4 ring-ink ${
              future
                ? "border border-dim bg-ink"
                : result === "error"
                  ? "bg-fail"
                  : result === "dry-run"
                    ? "bg-dry"
                    : "bg-ok"
            }`}
          />
        </span>

        <span className="min-w-0 flex-1 pb-1">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-sm">{event.title}</span>
            <span className="text-xs text-dim">{event.detail}</span>
            {result && (
              <span className={`font-mono text-xs ${RESULT_TONE[result] ?? "text-dim"}`}>{result}</span>
            )}
          </span>
          <span className="mt-0.5 block text-xs tabular-nums text-dim">{relative(event.at, now)}</span>
        </span>
      </button>
    </li>
  );
}

type StateQuery = UseQueryResult<FolderState, Error>;

/** Live per-folder state: one line per folder, one cell per member. */
function LegStrip({
  names,
  states,
  cloudFolders,
}: {
  names: string[];
  states: StateQuery[];
  cloudFolders: Set<string>;
}) {
  if (names.length === 0) return null;
  return (
    <section aria-label="Live folder state" className="rounded-lg border border-rule bg-panel">
      <h2 className="border-b border-rule px-4 py-2 text-xs uppercase tracking-wider text-dim">
        Right now
      </h2>
      <ul className="divide-y divide-rule">
        {names.map((n, i) => (
          <Leg key={n} name={n} q={states[i]} hasCloud={cloudFolders.has(n)} />
        ))}
      </ul>
    </section>
  );
}

function Leg({ name, q, hasCloud }: { name: string; q?: StateQuery; hasCloud: boolean }) {
  const manifest = useQuery({
    queryKey: ["folder", name],
    queryFn: () => api.get<FolderManifest & { paths?: Record<string, string> }>(
      `/folders/${encodeURIComponent(name)}`,
    ),
    retry: false,
  });
  const paused = q?.data?.perHost.some((h) => h.ok && h.status?.state === "paused");
  const disabled = manifest.data?.enabled === false;

  return (
    <li className={`px-4 py-2.5 ${disabled ? "opacity-55" : ""}`}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className="flex w-32 shrink-0 items-baseline gap-1.5">
        <span className="font-mono text-sm text-slate-200">{name}</span>
        {disabled && <span className="text-[10px] uppercase tracking-wider text-dim">off</span>}
      </span>
      {q?.isLoading && <span className="text-xs text-dim">checking…</span>}
      {q?.isError && <span className="text-xs text-dim">state unavailable</span>}
      {q?.data?.perHost.map((h) => {
        const host = typeof h.host === "string" ? h.host : (h.host as { name?: string })?.name;
        const state = h.ok ? h.status?.state : "unreachable";
        const need = h.status?.needFiles ?? 0;
        return (
          <span key={host} className="flex items-baseline gap-1.5 text-xs">
            <span className="font-mono text-slate-400">{host}</span>
            <span
              className={
                !h.ok ? "text-fail" : state === "idle" ? "text-ok" : "text-run"
              }
            >
              {state}
            </span>
            {need > 0 && <span className="tabular-nums text-dim">{need.toLocaleString()} behind</span>}
          </span>
        );
      })}
      </div>
      <div className="mt-2">
        <FolderActions
          name={name}
          manifest={manifest.data}
          hasCloudMember={hasCloud}
          paused={paused}
        />
      </div>
    </li>
  );
}

function Detail({ event, now }: { event: Event | null; now: Date }) {
  if (!event) {
    return (
      <aside className="h-fit rounded-lg border border-rule bg-panel p-4 text-sm text-dim lg:sticky lg:top-6">
        Select an event to see who ran it, what it targeted, and the result.
      </aside>
    );
  }
  const r = event.row;
  const j = event.job;
  return (
    <aside className="h-fit rounded-lg border border-rule bg-panel lg:sticky lg:top-6">
      <header className="border-b border-rule px-4 py-3">
        <h2 className="font-mono text-sm text-slate-100">{event.title}</h2>
        <p className="mt-0.5 font-mono text-xs tabular-nums text-dim">
          {event.at.toLocaleString()} · {relative(event.at, now)}
        </p>
      </header>
      <dl className="divide-y divide-rule text-xs">
        {r && (
          <>
            <Field label="Result" value={r.result} tone={RESULT_TONE[r.result]} />
            <Field label="Ran by" value={`${r.actor} · ${r.source}`} />
            <Field label="Target" value={`${r.target_kind} ${r.target_name}`} />
            {r.note && <Field label="Note" value={r.note} wrap />}
          </>
        )}
        {j && (
          <>
            <Field label="Status" value="scheduled" tone="text-dim" />
            <Field label="Schedule" value={j.cron} />
            <Field label="Anchor" value={j.anchor} />
            <Field label="Cloud member" value={j.member} />
            <Field label="Command" value={j.command} wrap />
          </>
        )}
      </dl>
    </aside>
  );
}

function Field({
  label,
  value,
  tone,
  wrap,
}: {
  label: string;
  value: string;
  tone?: string;
  wrap?: boolean;
}) {
  return (
    <div className="px-4 py-2.5">
      <dt className="text-[11px] uppercase tracking-wider text-dim">{label}</dt>
      <dd
        className={`mt-1 font-mono ${tone ?? "text-slate-300"} ${
          wrap ? "whitespace-pre-wrap break-words" : "truncate"
        }`}
      >
        {value}
      </dd>
    </div>
  );
}
