// Auto-synthesized AI READ-action for a declarative view (PLAN.md ITEM-11,
// ARCHITECTURE.md Layer 6). Every declarative view gets a `<view>.describe`
// action for FREE — an AI-only (`surfaces:{palette:false, ai:true}`),
// non-mutating `kind:'instance'` read that returns the live `{state, derived,
// _state_token}` snapshot for a `view_id`. So the agent PERCEIVES the view
// (what's selected, the current thresholds, the derived kept-counts) and gets
// the `_state_token` a subsequent mutating+stateful write must present — with no
// hand-written read per view. Mirrors the world-model read pattern.

import { z } from 'zod'
import type { ActionDefinition } from '@/core/actions/defineAction'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { describeActionId } from './ids'
import type { InterpreterCtx, InterpreterStore } from '@/modules/workbench/core/runtime/interpreter'
import { getViewStore } from '@/modules/workbench/core/runtime/viewStores'

/** What `<view>.describe` returns to the agent. */
export interface DescribeResult {
  state: Record<string, unknown>
  derived: Record<string, unknown>
  _state_token: string | undefined
}

const describeParams = z.object({ view_id: z.string() })

/**
 * Build (do not register — `registerViewSpecActions` registers it) the
 * `<view>.describe` read-action for `spec`. AI-only + non-mutating; resolves the
 * live store via `ctx.viewStore` (falling back to the module `getViewStore`
 * directory) and returns its token-stamped snapshot. A `view_id` with no mounted
 * instance yields empty `{state:{}, derived:{}, _state_token: undefined}` rather
 * than throwing (the agent reads "nothing mounted", not an error).
 */
export function synthesizeDescribeAction(
  spec: ViewSpec,
): ActionDefinition<{ view_id: string }, DescribeResult> {
  return {
    id: describeActionId(spec.id),
    title: `Describe ${spec.title}`,
    permission: spec.permission,
    mutating: false,
    kind: 'instance',
    stateful: false,
    surfaces: { palette: false, ai: true },
    description: `Read the live state + derived values of the "${spec.title}" view.`,
    params: describeParams,
    run: (p, ctx): DescribeResult => {
      const ic = ctx as InterpreterCtx
      const store: InterpreterStore | undefined = ic.viewStore?.(p.view_id) ?? getViewStore(p.view_id)
      if (!store) return { state: {}, derived: {}, _state_token: undefined }
      return { state: store.state, derived: store.derived, _state_token: store.token }
    },
  }
}
