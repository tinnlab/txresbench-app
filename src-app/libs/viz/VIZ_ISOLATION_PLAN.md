# Per-Instance Viz Isolation — store-factory + context

Make every `<Viz>` (grid/option mode AND data/raster mode, same realm OR popup) a FULLY INDEPENDENT
instance: its own selection, grid layout, color overrides, dataZoom/filters, view states — no
cross-talk. Enables multiple plots on one page + a `createPortal`-into-popup + several independent
grids side-by-side.

## Today (the problem)
Four coordination stores are **module-level zustand singletons** — `useCoordinationStore`,
`useGridWorkspaceStore`, `useColorOverrideStore`, `usePlotInteractionStore` — shared by ALL consumers
(~256 call sites across ~30 files). Two `<Viz option>` instances share one grid + selection +
overrides; a second `setOption` clobbers the first. `<Viz data>` (CpuRasterView) is ALREADY isolated
(touches zero singletons — per-instance worker + local state). A separate popup WINDOW is also already
isolated (separate JS realm ⇒ separate module singletons); the existing pop-out deliberately MIRRORS
via BroadcastChannel. The gap is same-realm grid instances.

## The design: store factory + React context, default singleton for back-compat

1. **Store factories.** Each `X.store.ts` exposes `createXStore()` (returns a fresh vanilla/react
   zustand store) AND keeps a module `export const useXStore = createXStore()` — the DEFAULT instance.
   Existing behavior preserved: the default singleton is byte-identical to today.
2. **Context.** `adapter/vizStores.ts`: `VizStores = { coordination, gridWorkspace, colorOverride,
   plotInteraction }`; `VizStoresContext` **defaults to the module-singleton set**; `VizStoresProvider`;
   `useVizStores()` (returns the contextual set, else the default). Scoped hooks
   `useCoordination(sel)` = `useStore(useVizStores().coordination, sel)` etc.
3. **Consumers migrate** (mechanical): a component does `const s = useVizStores()` once, then
   `useStore(s.coordination, sel)` (reactive read) / `s.coordination.getState()` (imperative) /
   `s.coordination.subscribe(...)`. NON-React modules (`VizController`, sync/session-state bridges)
   ACCEPT the `VizStores` set as a param (they can't read context).
4. **`<Viz>` provides a fresh set.** `<Viz>` creates `useMemo(() => createVizStores(), [])` and wraps
   its subtree in `<VizStoresProvider value={stores}>` → everything under it is isolated. Pass the same
   set to the `VizController` + session-state capture/restore + the sync bridge.

## Why this is SAFE to do incrementally
The context **defaults to the module singletons**. So until a `<Viz>` adds a provider, a migrated
consumer (`useVizStores()`) and an un-migrated one (`useXStore` directly) BOTH resolve to the SAME
default set → behavior unchanged. Isolation only "turns on" when a provider wraps the subtree. So
each file can migrate independently with zero behavior change; the regression stays green throughout.

## Waves
- **W1 — foundation.** Factories on the 4 stores (+ default singletons kept), `adapter/vizStores.ts`
  (context + provider + `useVizStores` + scoped hooks), unit tests (two `createVizStores()` sets are
  independent; the default context = the singletons). Zero consumer change ⇒ byte-identical.
- **W2 — consumer migration (parallel, disjoint file-groups).** Migrate the ~30 files: reactive reads
  → scoped hook / `useStore(s.X, sel)`; imperative → `s.X.getState()`; NON-React (`VizController`,
  `sessionState`, `coordinationHandle`, sync) → accept `VizStores`. Each group is behavior-preserving
  (defaults to singletons, no provider yet).
- **W3 — `<Viz>` provides + threads.** `<Viz>` mounts a fresh `VizStores` + provider; hand it to the
  controller + session-state + sync. Data-mode `<Viz data>` already isolated; wrap it too for a
  uniform contract. Popout: an independent popup mounts its own `<Viz>` (its realm's default set is
  already separate; no BroadcastChannel mirroring unless sharing is wanted).
- **W4 — verify.** A multi-instance story + e2e: two `<Viz>` on one page — a selection / grid-edit /
  color-override / dataZoom in instance A does NOT affect instance B (and vice-versa, both active).
  Full regression (single-instance byte-identical). A `createPortal`-into-popup isolation check.

## Invariants to hold
- Single-instance (no provider / the default `<Viz>`) is byte-identical throughout.
- Session-state capture/restore, sync (BroadcastChannel), events, pop-out mirror still work per-instance.
- No store read escapes to the module singleton from INSIDE a provided `<Viz>` (that would leak across
  instances) — the W4 test is the guard.
- Hooks stay top-level; `useVizStores()` is a hook (render-only); imperative paths take the set explicitly.
</content>
