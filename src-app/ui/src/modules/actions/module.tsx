import { useEffect } from 'react'
import { createModule } from '@txresbench/framework'
import { Session } from '@/modules/session/Session.store'
import { usePermission } from '@/core/permissions'
import { Permissions } from '@/api-client/permissions'
import { RouterBridge } from '@/core/actions/navigateBridge'
import { start as startActionsEngine, stop as stopActionsEngine } from '@/core/actions/engine'
// Side-effect imports: register the built-in global actions into the action
// registry (`@/core/actions/defineAction`). This is the sole import site for
// the FOUNDATION actions — the module system doesn't auto-discover
// `defineAction` calls (the compile-time collector, `scripts/collect-
// actions.mjs`, scans source files directly and doesn't need an import site
// at all; only the RUNTIME registry needs one).
//   - `appActions` (slice 1): `app.navigate`.
//   - `worldModel` (slice 3, PLAN.md ITEM-6): the world-model read actions
//     (`views.list`/`view.describe`/`selection.get`) — global, not tied to
//     any one instance surface, so they live here rather than under
//     `modules/instance-harness`.
import '@/core/actions/builtin/appActions'
import '@/core/actions/builtin/worldModel'
import { installActionsSeam } from '@/core/actions/e2eSeam'

// Install the read/drive `window.__actions` e2e seam (adds no capability beyond the
// palette/AI — `runAction` is server-permission-gated).
installActionsSeam()

// `modules/actions` — the AI-controllable-actions FOUNDATION module
// (PLAN.md ITEM-13/14/16; ARCHITECTURE.md Layers 1/3/5/7, GLOBAL-actions
// slice only). Registers no routes/pages of its own (that's `modules/mcp/`,
// owned by another agent this slice — the "Connect to txresbench" settings
// surface). This module only:
//   1. mounts `RouterBridge` (DEC-9 — captures `useNavigate` for
//      `ctx.navigate` / `app.navigate` from outside React) via the SDK
//      router's `routerEffects` slot, and
//   2. starts/stops the agent engine (`@/core/actions/engine`) based on
//      auth + the `mcp::use` permission.

// The engine runs only for a user who holds `mcp::use` (the AI-control gate).
const MCP_USE_PERMISSION = Permissions.McpUse

/**
 * Headless controller: starts the agent engine while the user is
 * authenticated AND holds `mcp::use`, stops it otherwise (logout,
 * permission revoked, or unmount). No router context needed here —
 * `RouterBridge` (mounted separately, inside the router) is what lets
 * `ctx.navigate` work; this controller only flips the engine's
 * connection on/off.
 */
function ActionsEngineController(): null {
  const { ready, user } = Session
  const canUseAgent = usePermission(MCP_USE_PERMISSION)

  useEffect(() => {
    if (ready && user && canUseAgent) {
      startActionsEngine()
    } else {
      stopActionsEngine()
    }
  }, [ready, user, canUseAgent])

  // Unmount safety net (module unload / HMR) — the effect above already
  // covers the normal logout path via `isAuthenticated` flipping false.
  useEffect(() => stopActionsEngine, [])

  return null
}

export default createModule({
  metadata: {
    name: 'actions',
    version: '1.0.0',
    description:
      "AI-controllable actions: the global action registry + agent engine that let a paired txresbench assistant drive TxResBench on the user's behalf.",
  },
  dependencies: ['router'],
  components: [
    {
      id: 'actions-engine-controller',
      component: <ActionsEngineController />,
      order: 5,
    },
  ],
  slots: {
    routerEffects: [
      {
        id: 'actions-router-bridge',
        component: RouterBridge,
      },
    ],
  },
})
