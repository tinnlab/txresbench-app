import { z } from 'zod'
import { Permissions } from '@/api-client/permissions'
import { defineAction } from '../defineAction'
import { getInstanceRecord, listAllInstances } from '../instanceRegistry'

// World-model READ actions (PLAN.md ITEM-6; ARCHITECTURE.md Layer 4/6): how
// the AI resolves "what live views/selections exist" BEFORE acting on one —
// the read half of the read-before-write discipline. All three are
// `kind: 'global'` (they enumerate/describe across the instance directory,
// they don't address one instance's mutation) + `mutating: false`.
// Permission = `Permissions.McpUse` (DEC-2 — no new permission; every
// `mcp::use` holder that can drive the app at all can read its world model).

defineAction({
  id: 'views.list',
  title: 'List every live, AI-drivable view instance',
  permission: Permissions.McpUse,
  mutating: false,
  params: z.object({}),
  run: () => ({
    views: listAllInstances().map(({ id, type, snapshot }) => ({
      view_id: id,
      type,
      _state_token: snapshot['_state_token'] ?? null,
    })),
  }),
})

defineAction({
  id: 'view.describe',
  title: 'Describe a live view instance (its current state + state token)',
  permission: Permissions.McpUse,
  mutating: false,
  params: z.object({ view_id: z.string() }),
  run: ({ view_id }) => {
    const record = getInstanceRecord(view_id)
    if (!record) {
      throw new Error(`NOT_FOUND: no live view "${view_id}"; call views.list to see live instances`)
    }
    return { view_id, type: record.type, ...record.getSnapshot() }
  },
})

defineAction({
  id: 'selection.get',
  title: 'Get the current selection, if any (best-effort)',
  permission: Permissions.McpUse,
  mutating: false,
  params: z.object({ view_id: z.string().optional() }),
  run: () => ({
    // Best-effort this round (DECISIONS.md DEC-4): no rich viz surface with
    // a real selection model exists yet (that lands with the P6/P7
    // workbench). Always answers rather than erroring, so an AI probing the
    // world model gets a clean "nothing selected" instead of a tool failure.
    selection: null,
    note: 'no selection-bearing surface is registered yet',
  }),
})
