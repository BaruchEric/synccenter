const BRACKET_RE = /\[(!?)([^\]]*)\]/g;

/**
 * Expand bracket expressions holding more than one range.
 *
 * Syncthing's glob engine accepts a single range (`[a-z]`) or a plain list
 * (`[abc]`), but not two ranges in one class (`[a-gi-z]`) — it rejects that
 * with "expected close range character". Crucially the failure is not local:
 * ONE bad pattern makes Syncthing discard the ENTIRE .stignore, so the folder
 * syncs with no ignores at all. That is silent — the folder just starts
 * replicating node_modules, .git, and anything the ruleset meant to keep out.
 *
 * These patterns are not exotic: `[._]ss[a-gi-z]` and `[._]s[a-rt-v][a-z]` are
 * verbatim lines from GitHub's Vim.gitignore, so any repo importing it trips
 * this. Expanding to an explicit character list is semantically identical, so
 * this needs no divergence warning — rclone accepts either form.
 */
function expandMultiRangeBrackets(pattern: string): string {
  return pattern.replace(BRACKET_RE, (whole, neg: string, body: string) => {
    const chars: string[] = [];
    let ranges = 0;
    for (let i = 0; i < body.length; ) {
      const lo = body[i]!;
      const hi = body[i + 2];
      if (body[i + 1] === "-" && hi !== undefined && lo <= hi) {
        ranges++;
        for (let c = lo.charCodeAt(0); c <= hi.charCodeAt(0); c++) chars.push(String.fromCharCode(c));
        i += 3;
      } else {
        chars.push(lo);
        i += 1;
      }
    }
    if (ranges <= 1) return whole;
    return `[${neg}${[...new Set(chars)].join("")}]`;
  });
}

export function emitStignore(patterns: string[], engineExtra: string[], header: string): string {
  // Syncthing is FIRST-match-wins (like rclone), while the unified pattern
  // list uses gitignore's last-match-wins — reverse so negations that follow
  // a broader exclude (e.g. `!.env.example` after `.env*`) actually fire.
  const body = [...patterns].reverse().map(expandMultiRangeBrackets);
  for (const x of engineExtra) body.push(expandMultiRangeBrackets(x));
  return `${[header, "", ...body].join("\n")}\n`;
}

export function emitRcloneFilter(patterns: string[], engineExtra: string[], header: string): string {
  const lines: string[] = [];
  // gitignore last-match-wins → rclone first-match-wins, so reverse order.
  for (let i = patterns.length - 1; i >= 0; i--) {
    const p = patterns[i]!;
    if (p.startsWith("!")) {
      lines.push(`+ ${p.slice(1)}`);
    } else {
      lines.push(`- ${p}`);
    }
  }
  for (const x of engineExtra) lines.push(x);
  // Treat any of `+ *`, `- *`, `+ **`, `- **` as the operator-supplied catch-all.
  const hasCatchAll = engineExtra.some((x) => /^[+-] \*{1,2}$/.test(x));
  if (!hasCatchAll) lines.push("+ **");
  return `${[header, "", ...lines].join("\n")}\n`;
}
