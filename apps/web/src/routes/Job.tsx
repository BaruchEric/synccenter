import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import {
  api,
  ApiError,
  type FolderManifest,
  type JobView,
  type LogList,
  type LogLine,
  type RunView,
  type WindowView,
} from "@/lib/api";
import { relative } from "@/lib/cron";
import { bytes, duration, rate } from "@/lib/format";
import { useRcloneHosts } from "@/lib/hosts";
import { useLive } from "@/lib/live";
import { Tag } from "@/components/Tag";
import { Track } from "@/components/Track";

/**
 * One job, read like a waybill.
 *
 * A job is freight moving over hops: the Mac's changes reach the NAS inside
 * a sync window, then the NAS pushes them to Drive with a bisync. So the
 * page is laid out the way a shipping document is: the route across the top
 * with each leg drawn station to station, a timetable of the legs below it
 * (opened, closed, took, what moved), and a ruled sum at the foot. The
 * route's bars are live meters while the job runs; when it is over they are
 * the record.
 */
export function Job() {
  const { id = "" } = useParams<{ id: string }>();
  const jobId = Number(id);
  const valid = Number.isInteger(jobId) && jobId > 0;
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["job", id],
    queryFn: () => api.get<{ job: JobView }>(`/jobs/${jobId}`),
    enabled: valid,
    retry: false,
    // Legs push their own events; the row itself only changes on settle.
    refetchInterval: (query) => (query.state.data?.job.state === "running" ? 3_000 : false),
  });
  const { runs: liveRuns, windows: liveWindows } = useLive();
  // The event stream has fresher legs than the last fetch of the job row;
  // read the numbers from there when it has them.
  const job = useMemo(() => {
    const j = q.data?.job;
    if (!j) return null;
    return {
      ...j,
      windows: j.windows.map((w) => liveWindows.find((l) => l.id === w.id) ?? w),
      runs: j.runs.map((r) => liveRuns.find((l) => l.id === r.id) ?? r),
    };
  }, [q.data, liveRuns, liveWindows]);
  const running = job?.state === "running";

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), running ? 1_000 : 30_000);
    return () => clearInterval(t);
  }, [running]);

  const manifest = useQuery({
    queryKey: ["folder", job?.folder ?? ""],
    queryFn: () => api.get<FolderManifest>(`/folders/${encodeURIComponent(job?.folder ?? "")}`),
    enabled: !!job,
    retry: false,
  });
  const { rclone, edge } = useRcloneHosts();

  const story = useQuery({
    queryKey: ["log", "job", id, job?.state ?? ""],
    queryFn: () => {
      // The first line of a Sync now ("requested by…") is written a few ms
      // before the job row; a little slack on both ends keeps it in.
      const qs = new URLSearchParams({ folder: job?.folder ?? "", limit: "200" });
      qs.set("since", shifted(job?.started_at ?? "", -2_000));
      if (job?.finished_at) qs.set("until", shifted(job.finished_at, 2_000));
      return api.get<LogList>(`/log?${qs}`);
    },
    enabled: !!job,
    refetchInterval: running ? 5_000 : false,
  });

  const stop = useMutation({
    mutationFn: () => api.post(`/jobs/${jobId}/stop`),
    onSuccess: () => {
      for (const k of ["job", "jobs", "windows", "runs", "apply-history"]) {
        void qc.invalidateQueries({ queryKey: [k] });
      }
    },
  });

  if (!valid || (q.isError && q.error instanceof ApiError && q.error.status === 404)) {
    return (
      <Frame id={id}>
        <p className="rounded-lg border border-dashed border-rule px-6 py-12 text-center text-sm text-dim">
          There is no job #{id}. Jobs are recorded from the moment SyncCenter started keeping them; runs
          and windows from before that are in their own tables under{" "}
          <Link to="/history?view=runs" className="text-slate-300 underline decoration-rule underline-offset-2 hover:text-signal">
            History
          </Link>
          .
        </p>
      </Frame>
    );
  }
  if (q.isError) {
    return (
      <Frame id={id}>
        <p role="alert" className="border-l-2 border-fail pl-3 text-sm text-fail">
          {q.error instanceof Error ? q.error.message : "could not load this job"}
        </p>
      </Frame>
    );
  }
  if (!job) {
    return (
      <Frame id={id}>
        <p className="py-12 text-center text-sm text-dim">Reading the record…</p>
      </Frame>
    );
  }

  const legs = legsOf(job);
  const route = routeOf(job, legs, manifest.data, rclone, edge);
  const t = job.totals;
  // A window that failed at resume reports nothing; "nothing left behind" would be a lie about it.
  const reported = job.windows.some((w) => w.global_bytes > 0);
  const started = new Date(job.started_at);
  const finished = job.finished_at ? new Date(job.finished_at) : null;
  const notes = job.note ? job.note.split(" · ") : [];

  return (
    <Frame id={id} state={job.state}>
      <header className="mb-6">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <Link
            to={`/history?view=jobs&folder=${encodeURIComponent(job.folder)}`}
            className="font-mono text-lg text-slate-100 hover:text-signal focus:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          >
            {job.folder}
          </Link>
          <span className="font-mono text-sm text-slate-300">{KIND_LABEL[job.kind]}</span>
          <span className="font-mono text-xs text-dim">
            {job.via === "schedule" ? "on schedule" : `by ${job.actor} · ${job.source}`}
          </span>
        </div>
        <p className="mt-1 font-mono text-xs tabular-nums text-dim">
          <time dateTime={started.toISOString()} title={started.toLocaleString()}>
            {stamp(started)}
          </time>
          {finished ? (
            <>
              {" → "}
              <time dateTime={finished.toISOString()} title={finished.toLocaleString()}>
                {sameDay(started, finished) ? clock(finished) : stamp(finished)}
              </time>
            </>
          ) : (
            " → open"
          )}
          {" · "}
          <span className="text-slate-300">{duration(t.seconds)}</span>
          {" · "}
          {relative(finished ?? started, now)}
        </p>
        {running && (
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => stop.mutate()}
              disabled={stop.isPending}
              className="rounded border border-rule px-2 py-0.5 font-mono text-[11px] text-fail transition-colors hover:bg-fail/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:opacity-40"
            >
              {stop.isPending ? "Stopping…" : "Stop this job"}
            </button>
            <span className="text-[11px] text-dim">
              Closes any open window (the folder is paused again on that host) and cancels the bisync.
              Nothing is lost; the next window picks up where this one stopped.
            </span>
            {stop.error && (
              <span role="status" className="font-mono text-[11px] text-fail">
                {(stop.error as Error).message}
              </span>
            )}
          </div>
        )}
      </header>

      <Section label="route">
        {route.segments.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-dim">
            No leg ever left: {notes.length > 0 ? notes.join(". ") : "nothing was opened or started."}
          </p>
        ) : (
          <div className="overflow-x-auto px-4 pb-4 pt-3">
            <div
              className="grid gap-y-2"
              style={{ gridTemplateColumns: `repeat(${route.stations.length}, minmax(9rem, 1fr))` }}
            >
              {route.stations.map((s) => (
                <div key={s.name} className="min-w-0 px-1 text-center">
                  <div className="truncate font-mono text-sm text-slate-100" title={s.name}>
                    {s.name}
                  </div>
                  <div className="text-[10px] uppercase tracking-wider text-dim">{s.role}</div>
                </div>
              ))}
              {route.segments.map((seg) => {
                const a = route.stations.findIndex((s) => s.name === seg.from);
                const b = route.stations.findIndex((s) => s.name === seg.to);
                const [lo, hi] = a <= b ? [a, b] : [b, a];
                const span = hi - lo + 1;
                const leg = seg.leg;
                return (
                  <div key={leg.key} style={{ gridColumn: `${lo + 1} / ${hi + 2}` }} className="pt-1">
                    <div style={{ marginLeft: `calc(50% / ${span})`, marginRight: `calc(50% / ${span})` }}>
                      <Track fraction={meter(leg)} indeterminate={walking(leg)} tone={toneOf(leg)} />
                      <p className={`mt-1.5 text-center font-mono text-[11px] tabular-nums ${TEXT_TONE[toneOf(leg)]}`}>
                        {legLine(leg, now)}
                      </p>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Section>

      <Section label="legs" className="mt-6">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-dim">
              <tr>
                {["", "leg", "opened", "closed", "took", "moved / in sync", "files", "checked", "errors", "result"].map(
                  (h, i) => (
                    <th key={i} className="whitespace-nowrap px-3 py-2 font-normal">
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {legs.map((leg, i) => (
                <LegRow key={leg.key} n={i + 1} leg={leg} now={now} />
              ))}
              {legs.length === 0 && (
                <tr className="border-t border-rule">
                  <td colSpan={10} className="px-4 py-6 text-center text-dim">
                    No leg got as far as a row.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <tr className="border-t-[3px] border-double border-rule font-mono tabular-nums text-slate-100">
                <td className="px-3 py-2.5" />
                <td className="px-3 py-2.5 text-[11px] uppercase tracking-wider text-dim">sum</td>
                <td className="whitespace-nowrap px-3 py-2.5">{clock(started)}</td>
                <td className="whitespace-nowrap px-3 py-2.5">{finished ? clock(finished) : <span className="text-dim">—</span>}</td>
                <td className="whitespace-nowrap px-3 py-2.5">{duration(t.seconds)}</td>
                <td className="whitespace-nowrap px-3 py-2.5">{bytes(t.bytes)}</td>
                <td className="whitespace-nowrap px-3 py-2.5">{t.transfers.toLocaleString()}</td>
                <td className="whitespace-nowrap px-3 py-2.5">{t.checks.toLocaleString()}</td>
                <td className={`whitespace-nowrap px-3 py-2.5 ${t.errors > 0 ? "text-fail" : ""}`}>{t.errors.toLocaleString()}</td>
                <td className={`whitespace-nowrap px-3 py-2.5 ${STATE_TONE[job.state]}`}>
                  {job.state}
                  <span className="text-dim">
                    {" "}
                    · {t.legsDone}/{t.legs} leg{t.legs === 1 ? "" : "s"}
                  </span>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        {(notes.length > 0 || job.cloudPending) && (
          <ul className="border-t border-rule px-4 py-2 text-xs">
            {job.cloudPending && (
              <li className="py-0.5 font-mono text-signal">
                bisync → {job.cloud.join(", ")} follows once the window{job.after.length === 1 ? "" : "s"} close
                {job.after.length === 1 ? "s" : ""}
              </li>
            )}
            {notes.map((n, i) => (
              <li key={i} className={`py-0.5 font-mono ${job.state === "stopped" ? "text-dry" : "text-fail"}`}>
                {n}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Section label="figures">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 py-3 text-xs">
            <Figure label="throughput" value={t.runSeconds > 0 && t.bytes > 0 ? rate(t.bytes / t.runSeconds) : "—"} hint="moved ÷ bisync time" />
            <Figure
              label="cap use"
              value={t.capSeconds > 0 ? `${Math.round((t.windowSeconds / t.capSeconds) * 100)}%` : "—"}
              hint={t.capSeconds > 0 ? `${duration(t.windowSeconds)} of ${duration(t.capSeconds)}` : "no window"}
            />
            <Figure
              label="left behind"
              value={t.needFiles > 0 ? `${t.needFiles.toLocaleString()} files` : reported ? "nothing" : "—"}
              hint={t.needFiles > 0 ? `${bytes(t.needBytes)} still needed at close` : reported ? "at the windows' close" : "no window reported"}
            />
            <Figure label="peers" value={peersLine(job.windows)} hint="caught up when the window closed" />
            <Figure label="listed" value={t.listed > 0 ? t.listed.toLocaleString() : "—"} hint="paths rclone walked" />
            <Figure
              label="planned"
              value={[...job.hosts.map((h) => `window ${h}`), ...job.cloud.map((c) => `bisync ${c}`)].join(", ") || "—"}
              hint={
                t.legsRunning > 0
                  ? `${t.legsRunning} in flight`
                  : t.legsFailed > 0
                    ? `${t.legsFailed} of ${t.legs} did not finish${job.legsFailed > 0 ? `, ${job.legsFailed} never left` : ""}`
                    : "every leg finished"
              }
            />
          </dl>
          {(job.runs.some((r) => r.dry_run === 1) || job.runs.some((r) => r.resync === 1)) && (
            <div className="flex gap-1.5 border-t border-rule px-4 py-2">
              {job.runs.some((r) => r.dry_run === 1) && <Tag>dry run</Tag>}
              {job.runs.some((r) => r.resync === 1) && <Tag>resync</Tag>}
            </div>
          )}
        </Section>

        <Section label="story">
          <Story lines={story.data?.lines ?? []} loading={story.isLoading} />
        </Section>
      </div>
    </Frame>
  );
}

/** The page chrome every state of the page shares: the crumb and the title. */
function Frame({ id, state, children }: { id: string; state?: JobView["state"]; children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-6xl">
      <nav aria-label="Breadcrumb" className="mb-1 font-mono text-xs text-dim">
        <Link to="/history" className="hover:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal">
          history
        </Link>
        {" / "}
        <Link to="/history?view=jobs" className="hover:text-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal">
          jobs
        </Link>
      </nav>
      <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h1 className="font-mono text-3xl font-semibold tracking-tight text-slate-100">job #{id}</h1>
        {state && (
          <span className={`font-mono text-sm ${STATE_TONE[state]}`}>
            {state === "running" ? (
              <>
                <span className="sc-pulse mr-1.5 inline-block h-2 w-2 rounded-full bg-signal align-middle" aria-hidden />
                running
              </>
            ) : (
              state
            )}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Section({ label, className, children }: { label: string; className?: string; children: React.ReactNode }) {
  return (
    <section aria-label={label} className={`rounded-lg border border-rule bg-panel ${className ?? ""}`}>
      <h2 className="border-b border-rule px-4 py-2 text-[11px] uppercase tracking-wider text-dim">{label}</h2>
      {children}
    </section>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wider text-dim">{label}</dt>
      <dd className="mt-0.5 truncate font-mono tabular-nums text-slate-100" title={value}>
        {value}
      </dd>
      {hint && <dd className="truncate text-[11px] text-dim">{hint}</dd>}
    </div>
  );
}

/* ---------- legs ---------- */

type Leg =
  | { key: string; kind: "window"; at: string; end: string | null; window: WindowView }
  | { key: string; kind: "run"; at: string; end: string | null; run: RunView };

/** Every leg with a row, in the order it started. */
function legsOf(job: JobView): Leg[] {
  const legs: Leg[] = [
    ...job.windows.map((w): Leg => ({ key: `w${w.id}`, kind: "window", at: w.started_at, end: w.finished_at, window: w })),
    ...job.runs.map((r): Leg => ({ key: `r${r.id}`, kind: "run", at: r.started_at, end: r.finished_at, run: r })),
  ];
  return legs.sort((a, b) => a.at.localeCompare(b.at) || a.key.localeCompare(b.key));
}

function stateOf(leg: Leg): string {
  return leg.kind === "window" ? leg.window.state : leg.run.state;
}

function toneOf(leg: Leg): "signal" | "run" | "fail" | "dry" {
  const s = stateOf(leg);
  if (s === "failed" || s === "timeout") return "fail";
  if (s === "stopped") return "dry";
  return leg.kind === "window" ? "run" : "signal";
}

function meter(leg: Leg): number | null {
  const s = stateOf(leg);
  if (s !== "running") return s === "done" ? 1 : (leg.kind === "window" ? leg.window.fraction : leg.run.fraction) ?? 1;
  return leg.kind === "window" ? leg.window.fraction : leg.run.fraction;
}

function walking(leg: Leg): boolean {
  if (stateOf(leg) !== "running") return false;
  return leg.kind === "window"
    ? leg.window.phase === "starting" || leg.window.phase === "scanning"
    : leg.run.phase === "starting" || leg.run.phase === "checking";
}

/** One line under a route segment: what the leg is, or was. */
function legLine(leg: Leg, now: Date): string {
  const took = span(leg.at, leg.end, now);
  if (leg.kind === "window") {
    const w = leg.window;
    const head = w.state === "running" ? w.phase : w.state;
    const pct = w.fraction == null ? null : `${Math.round(w.fraction * 100)}%`;
    return [head, took, pct ? `${pct} of ${bytes(w.global_bytes)}` : null].filter(Boolean).join(" · ");
  }
  const r = leg.run;
  const head = r.state === "running" ? r.phase : r.state;
  return [head, took, r.bytes > 0 || r.state !== "running" ? bytes(r.bytes) : null, r.transfers > 0 ? `${r.transfers.toLocaleString()} files` : null]
    .filter(Boolean)
    .join(" · ");
}

function LegRow({ n, leg, now }: { n: number; leg: Leg; now: Date }) {
  const s = stateOf(leg);
  const tone = toneOf(leg);
  const cell = "whitespace-nowrap px-3 py-2 font-mono tabular-nums text-slate-300";
  // The reason a leg ended badly can be a sentence; it gets a row of its own
  // under the leg rather than a squeezed last column.
  const why = leg.kind === "window" ? leg.window.error : leg.run.error;
  const reason = why ? (
    <tr>
      <td />
      <td colSpan={9} className={`px-3 pb-2 pt-0 text-[11px] ${tone === "dry" ? "text-dry" : "text-fail"}`}>
        {why}
      </td>
    </tr>
  ) : null;
  if (leg.kind === "window") {
    const w = leg.window;
    return (
      <>
      <tr className="border-t border-rule align-top">
        <td className="px-3 py-2 font-mono text-dim">{n}</td>
        <td className="whitespace-nowrap px-3 py-2 font-mono">
          <span className="text-slate-100">window</span> <span className="text-dim">on</span> {w.host}
          {w.via === "schedule" && (
            <>
              {" "}
              <Tag>scheduled</Tag>
            </>
          )}
        </td>
        <td className={cell}>{clock(new Date(w.started_at))}</td>
        <td className={cell}>{w.finished_at ? clock(new Date(w.finished_at)) : <span className="text-dim">open</span>}</td>
        <td className={cell}>
          {span(w.started_at, w.finished_at, now)} <span className="text-dim">/ {w.max_minutes}m</span>
        </td>
        <td className={cell}>
          {w.global_bytes === 0 ? (
            <span className="text-dim">—</span>
          ) : (
            <>
              {w.fraction == null ? <span className="text-dim">—</span> : `${Math.round(w.fraction * 100)}%`}
              <span className="text-dim"> of {bytes(w.global_bytes)}</span>
            </>
          )}
          {w.need_files > 0 && (
            <span className="block text-[11px] text-dim">
              {w.need_files.toLocaleString()} behind · {bytes(w.need_bytes)}
            </span>
          )}
        </td>
        <td className={`${cell} text-dim`}>—</td>
        <td className={`${cell} text-dim`}>—</td>
        <td className={`${cell} ${w.errors > 0 ? "text-fail" : ""}`}>{w.errors.toLocaleString()}</td>
        <td className={`whitespace-nowrap px-3 py-2 font-mono ${TEXT_TONE[tone]}`}>{s === "running" ? w.phase : s}</td>
      </tr>
      {reason}
      </>
    );
  }
  const r = leg.run;
  return (
    <>
    <tr className="border-t border-rule align-top">
      <td className="px-3 py-2 font-mono text-dim">{n}</td>
      <td className="whitespace-nowrap px-3 py-2 font-mono">
        <span className="text-slate-100">bisync</span> <span className="text-dim">→</span> {r.member ?? "cloud"}
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
      <td className={cell}>{clock(new Date(r.started_at))}</td>
      <td className={cell}>{r.finished_at ? clock(new Date(r.finished_at)) : <span className="text-dim">running</span>}</td>
      <td className={cell}>{span(r.started_at, r.finished_at, now)}</td>
      <td className={cell}>
        {bytes(r.bytes)}
        {r.total_bytes > r.bytes && <span className="text-dim"> of {bytes(r.total_bytes)}</span>}
      </td>
      <td className={cell}>{r.transfers.toLocaleString()}</td>
      <td className={cell}>{r.checks.toLocaleString()}</td>
      <td className={`${cell} ${r.errors > 0 ? "text-fail" : ""}`}>{r.errors.toLocaleString()}</td>
      <td className={`whitespace-nowrap px-3 py-2 font-mono ${TEXT_TONE[tone]}`}>{s === "running" ? r.phase : s}</td>
    </tr>
    {reason}
    </>
  );
}

/* ---------- route ---------- */

interface Station {
  name: string;
  role: "peers" | "mesh" | "held" | "anchor" | "cloud";
}
interface Segment {
  leg: Leg;
  from: string;
  to: string;
}

/**
 * The stations a job's legs run between, in travel order, and one segment
 * per leg. A window's origin is the folder's other Syncthing members (the
 * mesh the held host catches up with); a bisync's origin is the anchor the
 * rclone daemon runs on, which on this mesh is the held host itself, so a
 * two-leg job draws as one chain. Origins fall back to a generic station
 * when the manifest cannot be read (a folder since deleted).
 */
function routeOf(
  job: JobView,
  legs: Leg[],
  manifest: FolderManifest | undefined,
  rclone: Set<string>,
  edge: string | null,
): { stations: Station[]; segments: Segment[] } {
  const windowHosts = [...new Set(job.windows.map((w) => w.host))];
  const members = manifest ? Object.keys(manifest.paths ?? {}).filter((h) => !rclone.has(h)) : [];
  const peers = members.filter((h) => !windowHosts.includes(h));
  const origin: Station = peers.length > 0 ? { name: peers.join(" · "), role: "peers" } : { name: "mesh", role: "mesh" };
  const anchorName = manifest?.bisync?.anchor ?? edge ?? windowHosts[0] ?? peers[0] ?? "anchor";

  const stations: Station[] = [];
  const add = (s: Station) => {
    if (!stations.some((x) => x.name === s.name)) stations.push(s);
  };
  const segments: Segment[] = [];
  for (const leg of legs) {
    if (leg.kind === "window") {
      add(origin);
      add({ name: leg.window.host, role: "held" });
      segments.push({ leg, from: origin.name, to: leg.window.host });
    } else {
      add({ name: anchorName, role: windowHosts.includes(anchorName) ? "held" : "anchor" });
      const to = leg.run.member ?? "cloud";
      add({ name: to, role: "cloud" });
      segments.push({ leg, from: anchorName, to });
    }
  }
  return { stations, segments };
}

/* ---------- story ---------- */

function Story({ lines, loading }: { lines: LogLine[]; loading: boolean }) {
  // The API hands back newest first; a story reads the other way.
  const ordered = useMemo(() => [...lines].reverse(), [lines]);
  if (loading) return <p className="px-4 py-6 text-center text-sm text-dim">Reading the log…</p>;
  if (ordered.length === 0) {
    return <p className="px-4 py-6 text-center text-sm text-dim">Nothing in the log for this stretch.</p>;
  }
  return (
    <ol className="divide-y divide-rule">
      {ordered.map((l) => (
        <li key={l.id} className="flex gap-3 px-4 py-1.5 text-xs">
          <span className="w-16 shrink-0 font-mono tabular-nums text-dim">{clock(new Date(l.ts))}</span>
          <span className={`w-10 shrink-0 font-mono ${LEVEL_TONE[l.level]}`}>{l.level}</span>
          <span className="min-w-0 flex-1 break-words text-slate-300">
            {l.message}
            {l.host && <span className="text-dim"> · {l.host}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ---------- labels, tones, time ---------- */

const KIND_LABEL: Record<JobView["kind"], string> = {
  sync: "full sync",
  bisync: "bisync",
  window: "sync window",
};

const STATE_TONE: Record<JobView["state"], string> = {
  running: "text-signal",
  done: "text-ok",
  partial: "text-signal",
  failed: "text-fail",
  stopped: "text-dry",
};

const TEXT_TONE = {
  signal: "text-signal",
  run: "text-run",
  fail: "text-fail",
  dry: "text-dry",
} as const;

const LEVEL_TONE: Record<LogLine["level"], string> = {
  info: "text-dim",
  warn: "text-signal",
  error: "text-fail",
};

function peersLine(windows: WindowView[]): string {
  const seen = windows.filter((w) => w.peers_total > 0);
  if (seen.length === 0) return "—";
  return seen.map((w) => `${w.host} ${w.peers_done}/${w.peers_total}`).join(", ");
}

function span(from: string, to: string | null, now: Date): string {
  const end = to ? new Date(to) : now;
  return duration((end.getTime() - new Date(from).getTime()) / 1000);
}

function clock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function stamp(d: Date): string {
  return `${d.toLocaleDateString([], { month: "short", day: "2-digit" })} ${clock(d)}`;
}

function sameDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

function shifted(iso: string, ms: number): string {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso : new Date(t + ms).toISOString();
}
