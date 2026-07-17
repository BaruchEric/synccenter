/**
 * Validate a 5-field cron expression and describe the common shapes in plain
 * English. Uncommon-but-valid shapes fall back to a labeled field breakdown.
 */

export interface CronDescription {
  ok: boolean;
  text: string;
}

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: Record<string, number>;
}

const DOW_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MON_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const FIELDS: FieldSpec[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12, names: MON_NAMES },
  { name: "weekday", min: 0, max: 7, names: DOW_NAMES },
];

const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** One parsed field: `*`, `*\/step`, or a list of numbers (from N, N-M, names). */
interface Parsed {
  star: boolean;
  step?: number;
  values?: number[];
}

function parseField(raw: string, spec: FieldSpec): Parsed | string {
  if (raw === "*") return { star: true };
  const stepMatch = /^\*\/(\d+)$/.exec(raw);
  if (stepMatch) {
    const step = Number(stepMatch[1]);
    if (step < 1 || step > spec.max) return `${spec.name}: step ${step} out of range`;
    return { star: true, step };
  }
  const toNum = (b: string): number => {
    const named = spec.names?.[b.toLowerCase()];
    return named !== undefined ? named : /^\d+$/.test(b) ? Number(b) : NaN;
  };
  const values: number[] = [];
  for (const part of raw.split(",")) {
    // Each part is `body` or `body/step`, where body is `*`, `N`, or `N-M`.
    const slash = /^(.+)\/(\d+)$/.exec(part);
    const body = slash ? slash[1]! : part;
    const step = slash ? Number(slash[2]!) : 1;
    if (step < 1) return `${spec.name}: step in '${part}' must be at least 1`;
    let lo: number;
    let hi: number;
    if (body === "*") {
      lo = spec.min;
      hi = spec.max;
    } else {
      const range = /^([a-z0-9]+)-([a-z0-9]+)$/i.exec(body);
      if (range) {
        lo = toNum(range[1]!);
        hi = toNum(range[2]!);
      } else {
        lo = toNum(body);
        // A bare `N/step` means N, N+step, … up to the field max.
        hi = slash ? spec.max : lo;
      }
      if ([lo, hi].some((n) => Number.isNaN(n) || n < spec.min || n > spec.max)) {
        return `${spec.name}: '${part}' isn't valid (${spec.min}–${spec.max}${spec.names ? " or names" : ""})`;
      }
      if (lo > hi) return `${spec.name}: range '${part}' is backwards`;
    }
    for (let v = lo; v <= hi; v += step) values.push(v);
  }
  return { star: false, values };
}

const pad = (n: number) => String(n).padStart(2, "0");

function dowList(values: number[]): string {
  return [...new Set(values.map((v) => DOW_LABELS[v]))].join(", ");
}

export function describeCron(expr: string): CronDescription {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { ok: false, text: `needs 5 fields (minute hour day month weekday) — got ${fields.length}` };
  }
  const parsed: Parsed[] = [];
  for (let i = 0; i < 5; i++) {
    const p = parseField(fields[i]!, FIELDS[i]!);
    if (typeof p === "string") return { ok: false, text: p };
    parsed.push(p);
  }
  const [min, hour, dom, mon, dow] = parsed as [Parsed, Parsed, Parsed, Parsed, Parsed];

  // Plain-English descriptions for the shapes people actually write.
  const single = (p: Parsed) => (!p.star && p.values?.length === 1 ? p.values[0]! : undefined);
  const m = single(min);
  const h = single(hour);
  const anyDay = dom.star && !dom.step && mon.star && !mon.step;

  if (min.star && min.step && hour.star && !hour.step && anyDay && dow.star && !dow.step) {
    return { ok: true, text: `every ${min.step} minutes` };
  }
  if (min.star && !min.step && hour.star && !hour.step && anyDay && dow.star && !dow.step) {
    return { ok: true, text: "every minute" };
  }
  if (m !== undefined && hour.star && hour.step && anyDay && dow.star && !dow.step) {
    return { ok: true, text: `every ${hour.step} hours at :${pad(m)}` };
  }
  if (m !== undefined && hour.star && !hour.step && anyDay && dow.star && !dow.step) {
    return { ok: true, text: `hourly at :${pad(m)}` };
  }
  if (m !== undefined && h !== undefined && anyDay) {
    if (dow.star && !dow.step) return { ok: true, text: `daily at ${pad(h)}:${pad(m)}` };
    if (dow.values) return { ok: true, text: `${dowList(dow.values)} at ${pad(h)}:${pad(m)}` };
  }
  if (m !== undefined && h !== undefined && !dom.star && dom.values?.length === 1 && mon.star && dow.star) {
    return { ok: true, text: `monthly on day ${dom.values[0]} at ${pad(h)}:${pad(m)}` };
  }

  // Valid but unusual — labeled breakdown instead of prose.
  const breakdown = fields.map((f, i) => `${FIELDS[i]!.name} ${f}`).join(" · ");
  return { ok: true, text: breakdown };
}
