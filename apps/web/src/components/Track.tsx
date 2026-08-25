/**
 * One leg of a job's route, drawn station to station.
 *
 * The bar is the leg's progress meter: it fills left to right as the work
 * advances, the way the timeline's `Spine` fills top to bottom. While there
 * is no denominator (rclone still listing, Syncthing still scanning) a
 * travelling segment runs instead of a bar stuck at 0%. A finished leg is a
 * full bar in its result's colour.
 *
 * Tone keeps the app's rule: amber `signal` for a bisync the dashboard
 * started, blue `run` for Syncthing moving data, red `fail` for a leg that
 * did not get there, grey `dry` for one that was stopped.
 */
export function Track({
  fraction,
  indeterminate,
  tone,
}: {
  fraction: number | null;
  indeterminate: boolean;
  tone: "signal" | "run" | "fail" | "dry";
}) {
  // Whole literals so Tailwind's scanner sees every class.
  const fill =
    tone === "run" ? "bg-run" : tone === "fail" ? "bg-fail" : tone === "dry" ? "bg-dry" : "bg-signal";
  const text =
    tone === "run" ? "text-run" : tone === "fail" ? "text-fail" : tone === "dry" ? "text-dry" : "text-signal";
  return (
    <span className={`flex items-center ${text}`} aria-hidden>
      <span className="h-2 w-2 shrink-0 rounded-full border border-current bg-ink" />
      <span className="relative mx-0.5 h-1 flex-1 overflow-hidden rounded-full bg-rule">
        {indeterminate ? (
          <span className={`sc-scan-x absolute inset-y-0 left-0 w-1/4 rounded-full ${fill}`} />
        ) : (
          <span
            className={`sc-meter-fill absolute inset-y-0 left-0 w-full origin-left ${fill}`}
            style={{ transform: `scaleX(${fraction ?? 0})` }}
          />
        )}
      </span>
      <span className="h-0 w-0 shrink-0 border-y-[4px] border-l-[6px] border-y-transparent border-l-current" />
    </span>
  );
}
