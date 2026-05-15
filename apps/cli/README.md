# apps/cli

The `sc` CLI — single Bun-built static binary. Wraps the API for terminal use.

Owned by [`cli-builder`](../../.claude/agents/cli-builder.md). Populated in Phase 3.

Build:

```sh
bun build apps/cli/src/index.ts --compile --outfile apps/cli/dist/sc
```

Commands: `status`, `folders`, `rules`, `conflicts`, `pause`, `resume`, `bisync trigger`, `apply`.
