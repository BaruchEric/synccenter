// Minimal 5-field cron evaluator — enough for the schedules SyncCenter emits
// ("0 4 * * *", "*/15 * * * *", "30 2 * * 1-5"). Supports *, n, a-b, a,b, */n.
// Brute-forces forward a minute at a time: with a handful of jobs and a 14-day
// horizon that is a few thousand cheap comparisons, and it avoids pulling a
// cron dependency into the bundle for one view.

const FIELD_RANGES: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 6], // day of week (0 = Sunday)
];

/** Expand one cron field into the set of values it matches. */
function expand(field: string, [lo, hi]: [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [spec, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let from = lo;
    let to = hi;
    if (spec !== "*" && spec !== undefined) {
      const range = spec.split("-");
      from = Number(range[0]);
      to = range.length > 1 ? Number(range[1]) : from;
      // A bare `n/step` means "from n to the end of the range", not just n.
      if (range.length === 1 && stepRaw) to = hi;
      if (!Number.isInteger(from) || !Number.isInteger(to)) return null;
      if (from < lo || to > hi || from > to) return null;
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

/** Parsed cron, or null when the expression isn't one we understand. */
export function parseCron(expr: string): Array<Set<number>> | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets: Array<Set<number>> = [];
  for (let i = 0; i < 5; i++) {
    const s = expand(fields[i]!, FIELD_RANGES[i]!);
    if (!s) return null;
    sets.push(s);
  }
  return sets;
}

function matches(sets: Array<Set<number>>, d: Date): boolean {
  // Cron semantics: when BOTH day-of-month and day-of-week are restricted the
  // match is a union, not an intersection. Our schedules never do that, but
  // getting it wrong silently shifts every weekday job.
  const domRestricted = sets[2]!.size !== 31;
  const dowRestricted = sets[4]!.size !== 7;
  const dayOk =
    domRestricted && dowRestricted
      ? sets[2]!.has(d.getDate()) || sets[4]!.has(d.getDay())
      : sets[2]!.has(d.getDate()) && sets[4]!.has(d.getDay());
  return (
    sets[0]!.has(d.getMinutes()) &&
    sets[1]!.has(d.getHours()) &&
    dayOk &&
    sets[3]!.has(d.getMonth() + 1)
  );
}

/** The next `count` fire times at or after `from`, in local time. */
export function nextRuns(expr: string, count = 1, from: Date = new Date()): Date[] {
  const sets = parseCron(expr);
  if (!sets) return [];
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const out: Date[] = [];
  const horizon = 60 * 24 * 400; // a year and a bit, so yearly-ish crons resolve
  for (let i = 0; i < horizon && out.length < count; i++) {
    if (matches(sets, cursor)) out.push(new Date(cursor));
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return out;
}

/** "in 4h 12m" / "2h ago" — one unit of precision past the first. */
export function relative(target: Date, now: Date = new Date()): string {
  const ms = target.getTime() - now.getTime();
  const future = ms >= 0;
  let s = Math.floor(Math.abs(ms) / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  let text: string;
  if (d > 0) text = `${d}d ${h}h`;
  else if (h > 0) text = `${h}h ${m}m`;
  else if (m > 0) text = `${m}m`;
  else text = "under a minute";
  return future ? `in ${text}` : `${text} ago`;
}
