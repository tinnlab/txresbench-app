import { useEffect } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { createModule } from '@ziee/framework'
import { Permissions } from '@/api-client/permissions'
import { Session } from '@/modules/session/Session.store'
import { AppLayoutDef } from '@/modules/layouts/app-layout'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
import {
  ARTIFACT_DETAIL_ROUTE,
  LEGACY_RESULT_DETAIL_ROUTE,
  artifactDetailPath,
} from './artifactRoutes.ts'
import { discoverBuiltins, installWindowSeam } from './discover.ts'
import {
  loadDiscoveredProcessors,
  loadRuntimeProcessorsOnce,
} from '@/modules/workbench/core/runtime/loadProcessors.ts'
import { registerBuiltinShellViews } from './core/shell/builtinViews.ts'
import { registerBuiltinStatusItems } from './core/shell/statusBarItems.tsx'
import './workbench.css' // theme-aware canvas background (was the ITEM-15 force-dark scope)

// The deep-linkable artifact-detail route page (ITEM-46) — one renderer, three mounts.
const ArtifactDetailRoutePage = lazyWithPreload(() =>
  import('./extensions/jobs/ArtifactDetailRoutePage.tsx').then(m => ({ default: m.ArtifactDetailRoutePage })),
)

/**
 * The LEGACY `/projects/:id/results/:kind/:runId` mount (ITEM-25). The `result` → `artifact`
 * rename moved a bookmarkable url, so the old path stays registered and redirects — parameter for
 * parameter — onto the current one. `replace` keeps the dead path out of browser history (Back
 * from the artifact page returns where the user came from, not into a redirect loop). It renders
 * nothing itself, so it costs no chunk.
 */
function LegacyResultDetailRedirect() {
  const params = useParams<{ id: string; kind: string; runId: string }>()
  return <Navigate to={artifactDetailPath(params)} replace />
}

/**
 * Leg 2 of processor discovery: the runtime-dropped package delta, fetched from
 * `GET /api/processors/packages` ONCE the user is authenticated.
 *
 * WHY IT IS NOT AT MODULE SCOPE (the bug this fixes): that endpoint is gated by
 * `projects::use`, so issuing it at module-evaluation time meant every LOGGED-OUT visitor —
 * i.e. anyone on the login screen — sent a request that could only 401, and the api-client
 * logged `Error calling endpoint GET /api/processors/packages: …` to the console for it. A
 * doomed authenticated request on an unauthenticated boot is a real defect, not test noise;
 * it is also what tripped `tests/e2e/smoke.spec.ts`'s zero-JS-errors assertion.
 *
 * The mechanism is copied verbatim from `modules/datatypes/module.tsx`, which has the
 * IDENTICAL shape: a synchronous non-network seed at import + a `projects::use`-gated boot
 * fetch driven from a render-nothing `routerEffects` effect (the router mounts those ABOVE
 * the route guards, so this observes `isAuthenticated` flipping on login and on a
 * token-restored reload alike).
 *
 * Unlike `datatypes` there is no `else` branch: the served package set is deployment-wide
 * DATA (no per-account scoping to drop on logout), and `loadRuntimeProcessorsOnce` latches
 * so it runs exactly once per page session rather than on every auth transition.
 */
function RuntimeProcessorsBoot(): null {
  const { ready, user } = Session
  useEffect(() => {
    if (ready && user) void loadRuntimeProcessorsOnce()
  }, [ready, user])
  return null
}

/**
 * `workbench` module — the FE host that discovers + registers the built-in
 * workbench extensions into the `@/modules/workbench/core` contribution registry (P5).
 * Discovery is a build-time side-effect (the `import.meta.glob` pattern), so the
 * registry is populated the moment the app boots — no auth gate (contributions
 * are static metadata; RENDERING them is the shell's permission-gated concern,
 * built in P6). The `window.__workbenchRegistry` seam lets the e2e exercise the
 * REAL shipped registry in the browser (mirrors `core/datatypes`).
 *
 * This is the dogfood shell: when P11 lands the real data-io/embedding/clustering
 * modules they register the same way; when P6 lands it renders FROM this registry.
 */
discoverBuiltins()
// Generic processor-package loader (ITEM-3/23) — discovers `packages/<name>/` DATA packages
// and registers each contribution/view. Runs ADDITIVELY alongside `discoverBuiltins()` in Slice 1
// (no analysis package ships FE-manifest DATA yet, so this is a safe no-op on existing packages);
// later slices re-home each package to DATA and remove the glob.
//
// LEG 1 ONLY — the synchronous build-time glob. It MUST stay here at module scope: the
// contribution registry it fills is an import side effect the workbench's module-scope
// consumers rely on. Leg 2 (the runtime-dropped delta) is auth-gated below.
loadDiscoveredProcessors()
installWindowSeam()
// Register the built-in center/left/right shell surfaces as `center`/`left`/`right`
// `ViewContribution`s so `placeViews(area)` is the single dock-content source (ITEM-55/56).
// Descriptor-only (no deck import) — the named components register lazily at shell mount.
registerBuiltinShellViews()
// Register the built-in status-bar indicators into the `statusBarItems` registry so the
// bottom status strip is contribution-driven (an extension adds its own indicator the same
// way, no shell edit).
registerBuiltinStatusItems()

export default createModule({
  metadata: {
    name: 'workbench',
    version: '1.0.0',
    description: 'Workbench extension host — discovers + registers built-in contributions (P5).',
  },
  dependencies: ['router'],
  // The deep-linkable artifact-detail route (ITEM-46). Gated by the EXISTING
  // `provenance::read` permission (no new permission); the per-project role is
  // enforced in-page via `Project.access` (TEST-417). `one renderer, three mounts`.
  // The legacy `/results/…` alias (ITEM-25) is registered alongside it with the SAME auth +
  // permission gate, so a pre-rename bookmark resolves rather than 404s — and an unpermitted
  // user still meets the 403 panel on the legacy path, exactly as before the rename.
  routes: [
    {
      path: ARTIFACT_DETAIL_ROUTE,
      element: ArtifactDetailRoutePage,
      requiresAuth: true,
      permission: Permissions.ProvenanceRead,
      layout: AppLayoutDef,
    },
    {
      path: LEGACY_RESULT_DETAIL_ROUTE,
      element: <LegacyResultDetailRedirect />,
      requiresAuth: true,
      permission: Permissions.ProvenanceRead,
      layout: AppLayoutDef,
    },
  ],
  // Leg 2 of processor discovery, mounted post-auth (see RuntimeProcessorsBoot above).
  // `routerEffects` — not `components` — mirrors `modules/datatypes`, the sibling with the
  // same `projects::use`-gated boot fetch.
  slots: {
    routerEffects: [
      {
        id: 'workbench-runtime-processors-boot',
        component: RuntimeProcessorsBoot,
      },
    ],
  },
  // The per-project dock layout store (ITEM-2) and the Extensions store
  // (ITEM-15, which fetches `GET /api/extensions` on init so the workbench holds
  // the backend-declared converters/views as DATA) are both WHOLE-STORE-LAZY:
  // each calls `registerLazyStore` in its own file and self-registers, so the
  // shell chunk that imports the handle is what pulls them in. Listing them here
  // would re-add an eager module.tsx -> store import and drag both back into the
  // entry chunk.
  stores: [],
})
