# packages/adapters

Typed clients for the two engines SyncCenter orchestrates.

Owned by [`api-builder`](../../.claude/agents/api-builder.md). Populated in Phase 3.

- **syncthing** — REST client for `:8384`, multi-host (one instance per host manifest).
- **rclone** — `rcd` HTTP client for `:5572`, basic-auth.

Both expose strict TypeScript types. Auth keys are passed in by the API layer; adapters never read secrets directly.
