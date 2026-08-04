export function emitStignore(patterns: string[], engineExtra: string[], header: string): string {
  // Syncthing is FIRST-match-wins (like rclone), while the unified pattern
  // list uses gitignore's last-match-wins — reverse so negations that follow
  // a broader exclude (e.g. `!.env.example` after `.env*`) actually fire.
  const body = [...patterns].reverse();
  for (const x of engineExtra) body.push(x);
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
