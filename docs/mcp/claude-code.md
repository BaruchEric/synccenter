# Registering the SyncCenter MCP server with Claude Code

```sh
# One-time setup. Replace the URL + token with your real values.
claude mcp add synccenter \
  --command "bun run /Users/eric/Arik/dev/synccenter/apps/mcp/src/index.ts" \
  --env SC_API_URL=https://sync.beric.ca \
  --env SC_MCP_TOKEN=<your-scoped-mcp-token>
```

Or edit `~/.claude/mcp.json` directly:

```json
{
  "mcpServers": {
    "synccenter": {
      "command": "bun",
      "args": ["run", "/Users/eric/Arik/dev/synccenter/apps/mcp/src/index.ts"],
      "env": {
        "SC_API_URL": "https://sync.beric.ca",
        "SC_MCP_TOKEN": "..."
      }
    }
  }
}
```

For Claude Desktop the same config slots into `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS).

## Tools exposed

Read-only:
- `sc_health`, `sc_list_folders`, `sc_get_folder`, `sc_folder_state`
- `sc_list_hosts`, `sc_host_status`
- `sc_list_conflicts`, `sc_recent_changes`
- `sc_compile_rules`
- `sc_rclone_job`

Mutating (require `confirm: true`):
- `sc_pause_folder`, `sc_resume_folder`
- `sc_apply` (also accepts `dryRun: true` without `confirm`)
- `sc_trigger_bisync`

Every mutating call is logged to `apply_history` in the API's SQLite store.
