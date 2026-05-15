/**
 * Tiny unified diff for human display. NOT a real patch generator.
 * Output is line-oriented; matches `diff -u` shape for the simple case.
 */
export function unifiedDiff(before: string, after: string, label: string): string {
  if (before === after) return "";

  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const hunks = computeHunks(beforeLines, afterLines);

  const out: string[] = [
    `--- ${label} (on disk)`,
    `+++ ${label} (proposed)`,
  ];
  for (const h of hunks) {
    out.push(`@@ -${h.beforeStart},${h.beforeLen} +${h.afterStart},${h.afterLen} @@`);
    for (const line of h.lines) out.push(line);
  }
  return out.join("\n") + "\n";
}

interface Hunk {
  beforeStart: number;
  beforeLen: number;
  afterStart: number;
  afterLen: number;
  lines: string[];
}

/** Naive single-hunk diff: scan from each end to find changed range. Good enough for canonical-emit comparisons. */
function computeHunks(before: string[], after: string[]): Hunk[] {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;

  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) tail++;

  const beforeMid = before.slice(head, before.length - tail);
  const afterMid = after.slice(head, after.length - tail);

  const lines: string[] = [];
  // include a few context lines if available
  const ctxBefore = before.slice(Math.max(0, head - 2), head);
  const ctxAfter = before.slice(before.length - tail, Math.min(before.length, before.length - tail + 2));
  for (const c of ctxBefore) lines.push(` ${c}`);
  for (const l of beforeMid) lines.push(`-${l}`);
  for (const l of afterMid) lines.push(`+${l}`);
  for (const c of ctxAfter) lines.push(` ${c}`);

  return [{
    beforeStart: Math.max(1, head - ctxBefore.length + 1),
    beforeLen: ctxBefore.length + beforeMid.length + ctxAfter.length,
    afterStart: Math.max(1, head - ctxBefore.length + 1),
    afterLen: ctxBefore.length + afterMid.length + ctxAfter.length,
    lines,
  }];
}
