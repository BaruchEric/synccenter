# packages/importers

Resolvers for `imports:` entries in rulesets.

Owned by [`gitignore-importer`](../../.claude/agents/gitignore-importer.md). Populated in Phase 2.

Schemes:

- `github://github/gitignore/<NAME>` — github/gitignore main branch, weekly refresh
- `file://<path>` — relative to the ruleset YAML
- `ruleset://<name>` — another ruleset in the same repo
- `url://<https-url>` — arbitrary HTTPS with optional `sha256:` pinning

Allowlist of hosts at `synccenter-config/imports/allowlist.txt`.
