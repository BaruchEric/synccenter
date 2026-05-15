# apps/mcp

SyncCenter MCP server. Exposes read-only and (guarded) mutating tools to Claude.

Owned by [`mcp-publisher`](../../.claude/agents/mcp-publisher.md). Populated in Phase 4.

Tools:

- Read-only: `sc_list_folders`, `sc_get_folder`, `sc_list_conflicts`, `sc_recent_changes`, `sc_health`
- Compute: `sc_compile_rules`
- Mutating (require `confirm: true`): `sc_resolve_conflict`, `sc_pause_folder`, `sc_resume_folder`, `sc_trigger_bisync`, `sc_apply`

Transport: stdio for Claude Code; optional SSE for remote Claude Desktop.
