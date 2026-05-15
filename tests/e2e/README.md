# tests/e2e

End-to-end sync propagation tests across real Syncthing daemons and a real rclone rcd.

Owned by [`validator`](../../.claude/agents/validator.md). Populated in Phase 1+.

Scenarios:

- Drop a file on host A → assert it appears on host B within N seconds.
- Drop a file on Mac → assert it appears in GDrive after the bisync window.
- Edit on both ends simultaneously → assert conflict surfaces in API and UI.

Tests use a dedicated `tests/e2e/sync-sandbox/` folder pair — **never user data**.

`__artifacts__/` is gitignored — logs, screenshots, and diff dumps land there on failure.
