import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { InstanceNotFoundError, InstanceHandlerMissingError } from '../instanceErrors'

// The instance-action DEMONSTRATOR (PLAN.md ITEM-9; DECISIONS.md DEC-4). No
// rich per-analysis viz instance surface exists yet (that's P6/P7) — this is
// a small REAL component (`src/modules/instance-harness/InstanceHarnessPage.
// tsx`) proving the REAL `useAction -> engine -> agent-channel -> dispatch ->
// stale-guard` path end to end (TEST-11), not a synthetic no-op.
//
// Both actions are `kind: 'instance'`, addressed by `view_id` (the harness
// page's own freshly-minted instance id). `harness.setValue` is
// `mutating: true, stateful: true` — the engine (`../engine.ts`) requires a
// valid `expected` state token before ever calling this `run` (ARCHITECTURE.
// md Layer 6); `harness.describe` is a read (`mutating: false`), the
// per-instance counterpart to the world-model's generic `view.describe`
// (`./worldModel.ts`) — same data, reached via `ctx.instance` instead of the
// instance directory directly, exercising `ctx.instance`'s resolution path.

const HARNESS_STORE_KEY = 'harness'

defineAction({
  id: 'harness.setValue',
  title: 'Set the demo instance harness value',
  kind: 'instance',
  mutating: true,
  stateful: true,
  permission: Permissions.McpUse,
  params: z.object({
    view_id: z.string(),
    value: z.number(),
    expected: z.string(),
  }),
  run: ({ view_id, value, expected }, ctx) => {
    const inst = ctx.instance(HARNESS_STORE_KEY, view_id)
    if (!inst) throw new InstanceNotFoundError(view_id)
    const handler = inst.handlers['harness.setValue']
    if (!handler) throw new InstanceHandlerMissingError(view_id, 'harness.setValue')
    return handler({ value, expected }, ctx)
  },
})

defineAction({
  id: 'harness.describe',
  title: 'Describe the demo instance harness (its current value + state token)',
  kind: 'instance',
  mutating: false,
  permission: Permissions.McpUse,
  params: z.object({ view_id: z.string() }),
  run: ({ view_id }, ctx) => {
    const inst = ctx.instance(HARNESS_STORE_KEY, view_id)
    if (!inst) throw new InstanceNotFoundError(view_id)
    const handler = inst.handlers['harness.describe']
    if (!handler) throw new InstanceHandlerMissingError(view_id, 'harness.describe')
    return handler({}, ctx)
  },
})
