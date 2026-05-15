# apps/web

React + Vite + Tailwind + shadcn/ui + Monaco. The SyncCenter dashboard, editors, and conflict resolver.

Owned by [`ui-builder`](../../.claude/agents/ui-builder.md). Populated in Phase 3.

Expected shape:

```
apps/web/
  src/
    routes/          /, /folders/:name, /rules/:name, /conflicts, /hosts
    components/
    lib/api/         generated client from ../api/openapi.yaml
    lib/sse/         live folder + conflict subscription
  index.html
  vite.config.ts
  tailwind.config.ts
```

Use `@/` alias for all imports under `src/`.
