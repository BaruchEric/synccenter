const BRACKET_RE = /\[(!?)([^\]]*)\]/g;

/** A range must be the ENTIRE class body for Syncthing to accept it. */
const LONE_RANGE_RE = /^.-.$/;

/** Expanding a range this wide is never what a ruleset meant; bail instead. */
const MAX_RANGE_SPAN = 256;

/**
 * Rewrite bracket expressions Syncthing's glob engine cannot parse into the
 * explicit character list it can.
 *
 * The rule is narrower than it looks. Syncthing (gobwas/glob) accepts a class
 * that is EXACTLY one range (`[a-z]`), or a plain list (`[abc]`) — but once it
 * has read a range's high character it requires the very next character to be
 * `]`. So `[a-gi-z]` fails, and so do `[a-z_]`, `[0-9.]` and `[a-z-]`: it is
 * not "more than one range", it is "a range with anything at all beside it".
 * All of them raise "expected close range character".
 *
 * Crucially the failure is not local: ONE bad pattern makes Syncthing discard
 * the ENTIRE .stignore, so the folder syncs with no ignores at all. That is
 * silent — the folder just starts replicating node_modules, .git, and anything
 * the ruleset meant to keep out.
 *
 * These patterns are not exotic: `[._]ss[a-gi-z]` and `[._]s[a-rt-v][a-z]` are
 * verbatim lines from GitHub's Vim.gitignore, so any repo importing it trips
 * this. Expanding to an explicit character list is semantically identical, so
 * this needs no divergence warning — rclone accepts either form.
 *
 * A class whose body starts with a literal is also worth rewriting even though
 * it parses: gobwas reads `[_a-z]` as the four literals `_ a - z`, while
 * gitignore and rclone read it as `_` plus `a`-`z`. Expanding makes the two
 * engines agree.
 */
type BodyVerdict =
  | { kind: "native" }
  | { kind: "rewrite"; body: string }
  | { kind: "fatal"; reason: string };

/**
 * Decide what to do with one bracket class body. Single source of truth: the
 * rewriter and `findFatalBrackets` both read this, so the emitter can never
 * silently pass through something the compiler believes it fixed.
 */
function classifyBody(body: string): BodyVerdict {
  // Already in a form Syncthing parses the same way rclone does. A lone range
  // is checked FIRST, so a deliberately wide one (`[\x00-￿]`) stays native
  // and never reaches the span guard below.
  if (LONE_RANGE_RE.test(body) || !body.includes("-")) return { kind: "native" };

  const chars: string[] = [];
  let ranges = 0;
  for (let i = 0; i < body.length; ) {
    const lo = body[i]!;
    const hi = body[i + 2];
    if (body[i + 1] === "-" && hi !== undefined && lo <= hi) {
      const from = lo.charCodeAt(0);
      const to = hi.charCodeAt(0);
      if (to - from > MAX_RANGE_SPAN) {
        return {
          kind: "fatal",
          reason: `range ${lo}-${hi} spans ${to - from + 1} chars (limit ${MAX_RANGE_SPAN}) and is not the whole class`,
        };
      }
      ranges++;
      for (let c = from; c <= to; c++) chars.push(String.fromCharCode(c));
      i += 3;
    } else {
      chars.push(lo);
      i += 1;
    }
  }
  // Dashes present but no range parsed (`[-abc]`, `[a-]`) — nothing to expand.
  if (ranges === 0) return { kind: "native" };

  const set = [...new Set(chars)];
  // `]` closes the class and `\` escapes whatever follows it, so a span that
  // crosses either one cannot be written as a literal list.
  if (set.includes("]") || set.includes("\\")) {
    return { kind: "fatal", reason: "expanded range crosses ']' or '\\', which cannot be written as a literal list" };
  }

  // `-` is the range operator unless it is last, and a `!` in first position
  // reads as negation, so park both where they are inert.
  const dash = set.includes("-");
  const rest = set.filter((c) => c !== "-");
  if (rest[0] === "!" && rest.length > 1) rest.push(rest.shift()!);
  return { kind: "rewrite", body: `${rest.join("")}${dash ? "-" : ""}` };
}

function expandMultiRangeBrackets(pattern: string): string {
  return pattern.replace(BRACKET_RE, (whole, neg: string, body: string) => {
    const verdict = classifyBody(body);
    // `fatal` falls through unchanged on purpose — there is no safe rewrite.
    // `compile()` refuses to emit these at all, so in practice they never get
    // here; this stays a passthrough rather than a throw so that emitting is
    // still a pure string operation.
    return verdict.kind === "rewrite" ? `[${neg}${verdict.body}]` : whole;
  });
}

/**
 * Bracket classes Syncthing will reject that `emitStignore` cannot rewrite.
 *
 * Bailing out of the rewrite is safe for rclone, which accepts these — but the
 * pattern is still fatal to Syncthing, and Syncthing discards the ENTIRE
 * .stignore over one bad line. Silently emitting it produces precisely the
 * outcome this module exists to prevent: a folder syncing with no ignores at
 * all, secrets included. `compile()` turns this into a hard error instead.
 */
export function findFatalBrackets(pattern: string): string[] {
  const out: string[] = [];
  for (const m of pattern.matchAll(BRACKET_RE)) {
    const verdict = classifyBody(m[2]!);
    if (verdict.kind === "fatal") out.push(`"${pattern}" → class ${m[0]}: ${verdict.reason}`);
  }
  return out;
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
