import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type RunView } from "@/lib/api";
import { bytes, duration, elapsed, rate, tailPath } from "@/lib/format";

/**
 * A bisync in flight, drawn at `now` on the activity timeline.
 *
 * The timeline already reads top-to-bottom as time passing, so the spine itself
 * carries the progress: an amber column that fills downward as the job
 * advances. A horizontal bar bolted next to the axis would be the same
 * information in a second, unrelated coordinate system.
 *
 * bisync walks both trees before it moves a byte — minutes, on a large folder —
 * and during that stretch there is no denominator to be a percentage of. Rather
 * than show a bar stuck at 0%, the meter runs a travelling segment and the
 * readout counts what is actually happening: paths checked.
 */
export function RunBand({ run, now }: { run: RunView; now: Date }) {
  const qc = useQueryClient();
  const stop = useMutation({
    mutationFn: () => api.post(`/runs/${run.id}/stop`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["apply-history"] }),
  });

  const checking = run.phase === "checking" || run.phase === "starting";
  const pct = run.fraction == null ? null : Math.round(run.fraction * 100);

  return (
    <li className="relative">
      <div className="flex items-stretch gap-3 py-1">
        <span className="w-20 shrink-0 pt-1 text-right font-mono text-xs tabular-nums text-signal">
          {elapsed(run.started_at, now)}
        </span>

        <Meter fraction={run.fraction} checking={checking} />

        <div className="min-w-0 flex-1 pb-3 pt-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-sm text-slate-100">{run.folder}</span>
            <span className="font-mono text-xs text-dim">→ {run.member ?? "cloud"}</span>
            <span className="font-mono text-xs text-signal">
              {checking ? "checking" : "transferring"}
            </span>
            {run.dry_run === 1 && <Tag>dry run</Tag>}
            {run.resync === 1 && <Tag>resync</Tag>}
          </div>

          {/* Announce the phase and nothing else: the readout below changes
              several times a second, and a live region on it would talk over
              the user continuously for the length of the run. */}
          <p className="sr-only" aria-live="polite">
            {`${run.folder}: ${checking ? "checking for changes" : "transferring"}`}
          </p>

          <div
            aria-live="off"
            className="mt-1 flex flex-wrap items-baseline gap-x-3 font-mono text-xs tabular-nums text-slate-300"
          >
            {checking ? (
              <>
                <span>{run.checks.toLocaleString()} checked</span>
                {run.listed > 0 && <span className="text-dim">{run.listed.toLocaleString()} listed</span>}
                <span className="text-dim">no transfers yet</span>
              </>
            ) : (
              <>
                <span className="text-signal">{pct}%</span>
                <span>
                  {bytes(run.bytes)} <span className="text-dim">of</span> {bytes(run.total_bytes)}
                </span>
                <span className="text-dim">{rate(run.speed)}</span>
                {run.eta != null && run.eta > 0 && (
                  <span className="text-dim">{duration(run.eta)} left</span>
                )}
                {run.transfers > 0 && (
                  <span className="text-dim">{run.transfers.toLocaleString()} files</span>
                )}
              </>
            )}
          </div>

          {run.current && (
            <div className="mt-1 truncate font-mono text-[11px] text-dim" title={run.current}>
              {tailPath(run.current)}
            </div>
          )}
          {run.errors > 0 && (
            <div className="mt-1 font-mono text-[11px] text-fail">
              {run.errors.toLocaleString()} error{run.errors === 1 ? "" : "s"} so far
            </div>
          )}

          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => stop.mutate()}
              disabled={stop.isPending}
              className="rounded border border-rule px-2 py-0.5 font-mono text-[11px] text-fail transition-colors hover:bg-fail/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:opacity-40"
            >
              {stop.isPending ? "Stopping…" : "Stop this run"}
            </button>
            {stop.error && (
              <span role="status" className="font-mono text-[11px] text-fail">
                {(stop.error as Error).message}
              </span>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

/** The spine segment for this run, doubling as the meter. */
function Meter({ fraction, checking }: { fraction: number | null; checking: boolean }) {
  return (
    <span className="relative flex w-2 shrink-0 justify-center" aria-hidden>
      <span className="relative w-0.5 overflow-hidden rounded-full bg-rule">
        {checking ? (
          <span className="sc-scan absolute inset-x-0 top-0 h-1/4 rounded-full bg-signal" />
        ) : (
          <span
            className="sc-meter-fill absolute inset-x-0 top-0 h-full origin-top bg-signal"
            style={{ transform: `scaleY(${fraction ?? 0})` }}
          />
        )}
      </span>
    </span>
  );
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-rule px-1 font-mono text-[10px] uppercase tracking-wider text-dim">
      {children}
    </span>
  );
}
