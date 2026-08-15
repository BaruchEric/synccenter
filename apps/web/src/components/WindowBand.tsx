import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type WindowView } from "@/lib/api";
import { bytes, elapsed } from "@/lib/format";
import { Spine } from "@/components/Spine";
import { Tag } from "@/components/Tag";

/**
 * A sync window in flight, drawn at `now` on the activity timeline.
 *
 * Blue like `SyncBand` — it is Syncthing moving the data — but with a stop
 * control like `RunBand`, because the dashboard opened this window and can
 * close it. Closing pauses the folder on that host again; nothing is lost,
 * the next window picks up where this one stopped.
 *
 * While Syncthing scans there is no denominator, so the meter travels. Once
 * data moves, `in sync / global` is a real fraction of the tree. `settling`
 * is the tail where this host is caught up and connected peers are still
 * pulling from it.
 */
export function WindowBand({ window: w, now }: { window: WindowView; now: Date }) {
  const qc = useQueryClient();
  const stop = useMutation({
    mutationFn: () => api.post(`/windows/${w.id}/stop`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["apply-history"] }),
  });

  const walking = w.phase === "starting" || w.phase === "scanning";
  const pct = w.fraction == null ? null : Math.round(w.fraction * 100);
  const behind = w.need_files;

  return (
    <li className="relative">
      <div className="flex items-stretch gap-3 py-1">
        <span className="w-20 shrink-0 pt-1 text-right font-mono text-xs tabular-nums text-run">
          {elapsed(w.started_at, now)}
        </span>

        <Spine fraction={w.fraction} indeterminate={walking} tone="run" />

        <div className="min-w-0 flex-1 pb-3 pt-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-sm text-slate-100">{w.folder}</span>
            <span className="font-mono text-xs text-dim">on {w.host}</span>
            <span className="font-mono text-xs text-run">{w.phase}</span>
            <Tag>sync window</Tag>
            {w.via === "schedule" && <Tag>scheduled</Tag>}
          </div>

          {/* Announce the phase and nothing else: the readout below changes on
              every poll, and a live region on it would talk over the user for
              the length of the window. */}
          <p className="sr-only" aria-live="polite">
            {`${w.folder} on ${w.host}: sync window ${w.phase}`}
          </p>

          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 font-mono text-xs tabular-nums text-slate-300">
            {walking ? (
              <span className="text-dim">
                {w.phase === "starting" ? "waking the folder…" : "walking the tree · no denominator yet"}
              </span>
            ) : (
              <>
                <span className="text-run">{pct == null ? "—" : `${pct}%`}</span>
                <span>
                  {bytes(w.in_sync_bytes)} <span className="text-dim">of</span> {bytes(w.global_bytes)}{" "}
                  <span className="text-dim">in sync</span>
                </span>
                {behind > 0 && (
                  <span className="text-dim">
                    {behind.toLocaleString()} behind · {bytes(w.need_bytes)} to go
                  </span>
                )}
                {w.phase === "settling" && w.peers_total > 0 && (
                  <span className="text-dim">
                    peers {w.peers_done}/{w.peers_total} caught up
                  </span>
                )}
              </>
            )}
          </div>

          {w.errors > 0 && (
            <div className="mt-1 font-mono text-[11px] text-fail">
              {w.errors.toLocaleString()} error{w.errors === 1 ? "" : "s"} on this folder
            </div>
          )}

          <div className="mt-1.5 flex items-center gap-2">
            <button
              type="button"
              onClick={() => stop.mutate()}
              disabled={stop.isPending}
              className="rounded border border-rule px-2 py-0.5 font-mono text-[11px] text-fail transition-colors hover:bg-fail/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:opacity-40"
            >
              {stop.isPending ? "Closing…" : "Close window"}
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
