# tests/golden

Golden-file tests for the rule compiler. Each case is an input ruleset YAML + the expected `.stignore` and `filter.rclone` outputs.

Owned by [`validator`](../../.claude/agents/validator.md). Populated in Phase 2.

Layout:

```
golden/
  node/
    input/dev-monorepo.yaml
    expected/.stignore
    expected/filter.rclone
  python/
  macos/
  custom-imports/
  ...
__received__/      # gitignored; written by the test runner on failure for diffing
```

Run: `bun test tests/golden`. Update with `bun test tests/golden --update-snapshots` after verifying the diff is intentional.
