/** Byte/rate/duration formatting for the live readouts. */

const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function bytes(n: number, digits = 1): string {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const i = Math.min(UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  // Bytes are never fractional, and a three-digit value doesn't need decimals.
  return `${v.toFixed(i === 0 ? 0 : v >= 100 ? 0 : digits)} ${UNITS[i]}`;
}

export function rate(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  return `${bytes(bytesPerSecond, 1)}/s`;
}

/** Compact duration: 48s, 4m 12s, 1h 06m. */
export function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/** Stopwatch since an ISO timestamp, as mm:ss / h:mm:ss. */
export function elapsed(sinceIso: string, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - new Date(sinceIso).getTime()) / 1000));
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** Last two segments of a path — enough to recognise the file, short enough to fit. */
export function tailPath(p: string, segments = 2): string {
  const parts = p.split("/").filter(Boolean);
  return parts.length <= segments ? p : `…/${parts.slice(-segments).join("/")}`;
}
