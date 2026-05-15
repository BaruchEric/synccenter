# packages/schema

JSON Schemas — the single source of truth for every YAML in `synccenter-config/`.

Owned by [`repo-init`](../../.claude/agents/repo-init.md) (initial draft) and updated by each builder agent as the data model evolves.

Files (Phase 0–2):

- `folder.schema.json`
- `ruleset.schema.json`
- `host.schema.json`
- `schedule.schema.json`

Consumed by:

- The `rule-compiler` (validates rulesets before compiling)
- The API (validates payloads on POST/PATCH)
- The web UI Monaco editors (autocomplete + inline errors)
- The CLI (`sc folders apply` validates locally before calling the API)
