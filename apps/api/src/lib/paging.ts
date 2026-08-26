/**
 * The paging every list route speaks.
 *
 * `?limit=` is clamped to [1, max] and truncated to an integer: bun:sqlite
 * binds 2.5 as a REAL, and SQLite refuses a REAL in LIMIT with "datatype
 * mismatch", which would turn a stray query string into a 500. `?before=<id>`
 * is the cursor for "load older", present only when it is a positive integer.
 */
export function pageParams(
  query: { limit?: unknown; before?: unknown },
  { max, fallback }: { max: number; fallback: number },
): { limit: number; before?: number } {
  const limit = Math.trunc(Math.min(max, Math.max(1, Number(query.limit ?? fallback) || fallback)));
  const before = Number(query.before);
  return Number.isInteger(before) && before > 0 ? { limit, before } : { limit };
}

/** The cursor for the next page: the last row's id when this page came back full, null once it came back short. */
export function nextBefore(rows: Array<{ id: number }>, limit: number): number | null {
  return rows.length === limit ? rows[rows.length - 1]!.id : null;
}
