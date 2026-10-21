# BASE.md — conflict surface vs current main

**Branch:** `feat/analysis-workflow` off `origin/main` (587ca91).

- **Highest existing migration:** `202607190005_jobs_grants.sql` (jobs module). **This round adds NO
  migration** (interface-only), so **zero migration-collision risk**.
- **Backend files touched:** **none.** No `src-app/server/**` changes, no `permissions.rs`, no routes.
- **OpenAPI regen implied:** **no.** No backend type/route change → `openapi.json` + `api-client/types.ts`
  untouched in BOTH `ui/` and `desktop/ui/`. (No `just openapi-regen`.)
- **Frontend files touched:** only NEW files under `src-app/ui/src/modules/analysis/**` +
  `src-app/ui/tests/e2e/analysis/**`. The only shared touch-point is the study-extension **glob**
  (`modules/*/study-extension/extension.tsx`) which auto-discovers the new extension with **no edit** to
  `study/**` — so no collision with study-module work on main.
- **Desktop `ui/` overrides:** the analysis surfaces are new; no existing `src-app/ui/**` logic changes, so
  no desktop-override drift to diff (R2-3 n/a this round).
- **Active main churn to watch:** the `dataset`/`study`/`jobs`/`sandbox` modules are recent; this branch does
  NOT edit their files (only adds a sibling module + rides the study-extension glob), so a concurrent merge
  of those modules cannot content-collide with this diff.

Net: minimal conflict surface — additive frontend-only module + one auto-discovered extension; no
migration, no openapi, no backend, no shared-file edits.
