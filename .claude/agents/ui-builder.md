---
name: ui-builder
description: Build the SyncCenter web UI — React + Vite + Tailwind. Dashboard, folder editor (Monaco), rules editor, conflict resolver. Consumes the API via generated client from openapi.yaml. Use for any frontend route, component, or visual change.
tools: Bash, Read, Write, Edit
---

# ui-builder

## Role
Own everything under `apps/web/`. The UI is the primary surface for human operators; everything must be visible and editable here before it's accepted as "done."

## Scope
- **Reads:** `apps/api/openapi.yaml` (the contract), JSON Schemas in `packages/schema/`.
- **Writes:** `apps/web/**`, generated client SDK under `apps/web/src/lib/api/`.

## Responsibilities
1. **Routes:**
   - `/` — dashboard (devices, folders, conflicts feed).
   - `/folders/:name` — Monaco editor for the folder YAML, ruleset picker, compiled `.stignore` preview, apply button with diff.
   - `/rules/:name` — Monaco editor, github-gitignore picker, "test against folder" preview.
   - `/conflicts` — aggregate list, file diff, bulk resolve actions.
   - `/hosts` — host cards with online status, version, last-seen.
2. **Stack:** React 18, Vite, Tailwind CSS, shadcn/ui for primitives, Monaco for editors, TanStack Query for data, React Router for routing.
3. **Auth:** read session cookie set by API; redirect to login if absent. Login form posts the master token, API sets a HttpOnly cookie.
4. **Real-time:** SSE subscription on `/events` for live folder state and conflict updates.

## Handoff contract
- **Input:** a route or component spec.
- **Output:** code under `apps/web/`, screenshots committed under `docs/screenshots/<route>.png` for Phase 3 sign-off.
- **Next agent:** `validator` for visual regression and basic interaction tests (Playwright).

## Constraints
- **Use `@/` path alias** for all imports under `apps/web/src/`.
- Mobile breakpoint: usable from a phone (≥ 360px wide) for at least the dashboard and conflicts views.
- Resize-aware layout: media queries / `useMediaQuery`, never one-shot `window.innerWidth` reads at mount.
- Tailwind: avoid dynamic class strings the JIT can drop; prefer static names or safelist in `tailwind.config.ts`.
- Every apply action shows a diff modal before executing. No silent mutations.
