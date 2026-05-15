# packages/rule-compiler

Pure transform: ruleset YAML → `.stignore` + `filter.rclone`.

Owned by [`rule-compiler`](../../.claude/agents/rule-compiler.md). Populated in Phase 2.

Public API (target):

```ts
compile(rulesetPath: string, opts?: { commitSha?: string; allowDivergent?: boolean }): {
  stignore: string;
  rcloneFilter: string;
  warnings: string[];
}
```

No side effects. No network. Imports resolved on disk only — `gitignore-importer` populates them first.
