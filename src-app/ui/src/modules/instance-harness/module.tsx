import { createModule } from '@ziee/framework'
import { Permissions } from '@/api-client/permissions'
import { AppLayoutDef } from '@/modules/layouts/app-layout'
import { lazyWithPreload } from '@/utils/lazyWithPreload'
// Side-effect import: registers `harness.setValue`/`harness.describe`
// (PLAN.md ITEM-9) into the action registry — the instance-action
// demonstrator this module's page proves out end to end (TEST-11).
import '@/core/actions/builtin/harnessActions'

const InstanceHarnessPage = lazyWithPreload(() => import('./InstanceHarnessPage'))

/**
 * `modules/instance-harness` — the slice-3 instance-action DEMONSTRATOR
 * (PLAN.md ITEM-9; DECISIONS.md DEC-4). A single real, always-reachable page
 * (`/instance-harness`) whose `InstanceHarnessPage` joins the instance
 * registry via `useAction` for as long as it's mounted — the REAL surface
 * TEST-11 (`tests/e2e/command-palette/instance-action.spec.ts`) drives
 * against as an external MCP client (`invoke_capability('harness.setValue',
 * ...)`) to prove the full `useAction -> engine -> agent-channel -> dispatch
 * -> stale-guard` path. Gated on `mcp::use` (same permission the agent
 * engine itself requires to be running at all — DEC-2, no new permission).
 */
export default createModule({
  metadata: {
    name: 'instance-harness',
    version: '1.0.0',
    description:
      'AI-controllable-actions instance demonstrator: a live useAction-registered surface proving the instance-action + stale-state-guard path end to end.',
  },
  dependencies: ['router'],
  routes: [
    {
      path: '/instance-harness',
      element: InstanceHarnessPage,
      requiresAuth: true,
      layout: AppLayoutDef,
      permission: Permissions.McpUse,
    },
  ],
})
