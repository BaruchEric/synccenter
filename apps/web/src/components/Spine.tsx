/**
 * The timeline's vertical rule, doubling as the progress meter for whatever is
 * happening at `now`.
 *
 * The axis already reads top-to-bottom as time passing, so progress belongs on
 * the axis itself: a column that fills downward as the work advances. A
 * horizontal bar bolted next to it would be the same information in a second,
 * unrelated coordinate system.
 *
 * `indeterminate` covers the stretch where there is no denominator to be a
 * percentage of — rclone walking both trees before it moves a byte, Syncthing
 * walking one. Rather than a bar stuck at 0%, the meter runs a travelling
 * segment.
 *
 * Tone separates who is doing the work: amber `signal` for a bisync this
 * dashboard started, blue `run` for Syncthing moving on its own, red `fail`
 * for a folder that has stopped being either. That is the same pairing the
 * Right-now panel already uses for folder state.
 */
export function Spine({
  fraction,
  indeterminate,
  tone = "signal",
}: {
  fraction: number | null;
  indeterminate: boolean;
  tone?: "signal" | "run" | "fail";
}) {
  // Written as whole literals so Tailwind's scanner sees them.
  const fill = tone === "run" ? "bg-run" : tone === "fail" ? "bg-fail" : "bg-signal";
  return (
    <span className="relative flex w-2 shrink-0 justify-center" aria-hidden>
      <span className="relative w-0.5 overflow-hidden rounded-full bg-rule">
        {indeterminate ? (
          <span className={`sc-scan absolute inset-x-0 top-0 h-1/4 rounded-full ${fill}`} />
        ) : (
          <span
            className={`sc-meter-fill absolute inset-x-0 top-0 h-full origin-top ${fill}`}
            style={{ transform: `scaleY(${fraction ?? 0})` }}
          />
        )}
      </span>
    </span>
  );
}
