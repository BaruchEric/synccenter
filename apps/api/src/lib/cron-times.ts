// Minimal 5-field cron evaluator, the server-side twin of apps/web/src/lib/cron.ts
// ("0 */4 * * *", "*/15 * * * *", "30 2 * * 1-5"). Supports *, n, a-b, a,b, */n.
// The scheduler only needs "does this expression match this minute", evaluated
// in the server's local time — the same clock the crontab renderer assumes.

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

/** Does this cron fire on the minute containing `d` (local time)? */
export function cronMatches(sets: Array<Set<number>>, d: Date): boolean {
  // Cron semantics: when BOTH day-of-month and day-of-week are restricted the
  // match is a union, not an intersection.
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

/**
 * Every minute mark in (after, upTo] where the cron fires. The scheduler calls
 * this each sweep, so a sweep that slipped (laptop asleep, event loop busy)
 * still finds the minutes it missed rather than skipping them.
 */
export function firesBetween(expr: string, after: Date, upTo: Date): Date[] {
  const sets = parseCron(expr);
  if (!sets) return [];
  const cursor = new Date(after);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const out: Date[] = [];
  // A sweep gap is seconds, not days — cap the walk so a wildly wrong clock
  // cannot spin this loop for a year.
  for (let i = 0; i < 24 * 60 && cursor.getTime() <= upTo.getTime(); i++) {
    if (cronMatches(sets, cursor)) out.push(new Date(cursor));
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return out;
}
