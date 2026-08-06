import { type FolderState } from "@/lib/api";
import { bytes, elapsed } from "@/lib/format";
import { Spine } from "@/components/Spine";

export type HostStatus = NonNullable<FolderState["perHost"][number]["status"]>;

/**
 * A Syncthing member doing work, drawn at `now` on the activity timeline.
 *
 * This is deliberately a sibling of `RunBand`, not the same thing. A run is a
 * bisync this dashboard started and can stop; this is Syncthing moving on its
 * own, and the only lever over it is Pause. So the band is read-only and blue,
 * and it says which host it is describing — the same folder is usually busy on
 * two machines at once, doing two unrelated amounts of work.
 *
 * States divide into two readouts. While Syncthing is walking a tree there is
 * no denominator for the walk itself, so the meter travels and the numbers
 * report the backlog. Once it is moving data, `inSync/global` is a real
 * fraction — of the tree, not of this pass, which is why it is labelled
 * "in sync" rather than given as bare progress.
 */
const WALKING = /^(scanning|scan-waiting|cleaning|sync-preparing)$/;

export function SyncBand({
  folder,
  host,
  status,
  now,
}: {
  folder: string;
  host: string;
  status: HostStatus;
  now: Date;
}) {
  const failed = status.state === "error";
  const walking = WALKING.test(status.state);
  // A host that answered with a partial status would otherwise print "NaN%".
  const ratio = status.inSyncBytes / status.globalBytes;
  const fraction = status.globalBytes > 0 && Number.isFinite(ratio) ? Math.min(1, ratio) : null;
  const pct = fraction == null ? null : Math.round(fraction * 100);
  const behind = status.needFiles ?? 0;

  // How long it has been in this state, which is the closest thing Syncthing
  // gives us to a start time. Older builds omit it, and an unparseable date
  // would render as NaN:NaN, so fall back to the bare `now` label.
  const since =
    status.stateChanged && Number.isFinite(Date.parse(status.stateChanged))
      ? sinceLabel(status.stateChanged, now)
      : "now";

  return (
    <li className="relative">
      <div className="flex items-stretch gap-3 py-1">
        <span
          className={`w-20 shrink-0 pt-1 text-right font-mono text-xs tabular-nums ${
            failed ? "text-fail" : "text-run"
          }`}
          title={
            status.stateChanged
              ? `${status.state} since ${new Date(status.stateChanged).toLocaleString()}`
              : undefined
          }
        >
          {since}
        </span>

        <Spine
          fraction={failed ? null : fraction}
          indeterminate={!failed && walking}
          tone={failed ? "fail" : "run"}
        />

        <div className="min-w-0 flex-1 pb-3 pt-0.5">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-mono text-sm text-slate-100">{folder}</span>
            <span className="font-mono text-xs text-dim">on {host}</span>
            <span className={`font-mono text-xs ${failed ? "text-fail" : "text-run"}`}>
              {status.state}
            </span>
            <Tag>syncthing</Tag>
          </div>

          {/* Announce the state and nothing else: the readout below changes on
              every poll, and a live region on it would talk over the user for
              as long as the folder stays busy. */}
          <p className="sr-only" aria-live="polite">
            {`${folder} on ${host}: ${status.state}`}
          </p>

          <div
            aria-live="off"
            className="mt-1 flex flex-wrap items-baseline gap-x-3 font-mono text-xs tabular-nums text-slate-300"
          >
            {walking ? (
              behind > 0 ? (
                <>
                  <span>{behind.toLocaleString()} behind</span>
                  <span className="text-dim">{bytes(status.needBytes)} to go</span>
                  <span className="text-dim">no denominator while scanning</span>
                </>
              ) : (
                <span className="text-dim">walking the tree · nothing pending</span>
              )
            ) : (
              <>
                <span className="text-run">{pct == null ? "—" : `${pct}%`}</span>
                <span>
                  {bytes(status.inSyncBytes)} <span className="text-dim">of</span>{" "}
                  {bytes(status.globalBytes)} <span className="text-dim">in sync</span>
                </span>
                {behind > 0 && (
                  <span className="text-dim">
                    {behind.toLocaleString()} behind · {bytes(status.needBytes)} to go
                  </span>
                )}
              </>
            )}
          </div>

          {status.errors > 0 && (
            <div className="mt-1 font-mono text-[11px] text-fail">
              {status.errors.toLocaleString()} error{status.errors === 1 ? "" : "s"} on this folder
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * `elapsed` is built for bisync runs that last seconds, and it keeps counting
 * in H:MM:SS. A folder can sit in one Syncthing state for days — `51:20:27`
 * next to `06:32` reads as a clock time, not a duration — so anything past an
 * hour gets the coarse form instead. The exact instant stays in the title.
 */
function sinceLabel(iso: string, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 3600) return elapsed(iso, now);
  const h = Math.floor(s / 3600);
  return h < 24 ? `${h}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded border border-rule px-1 font-mono text-[10px] uppercase tracking-wider text-dim">
      {children}
    </span>
  );
}
