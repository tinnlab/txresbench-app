// @vitest-environment jsdom
/**
 * `models.run` (the model-step Run, data-pickup-bugs bug 3 UI half): the
 * definition's metadata and its params contract. The end-to-end behavior
 * (the snapshot's selected ids, the stale-state refusal, the one guarded
 * Run the button and the action share) is driven through the mounted D/I
 * pages in `txrmodels/pages/*.test.tsx`; this is the declaration's pin:
 *
 * - `kind: 'instance'` (the live model list, `txr.model-list`), `mutating`
 *   + `stateful` — the read-before-write / stale-state guard's inputs
 *   (ARCHITECTURE.md Layer 6);
 * - `surfaces.palette: false` — the ⌘K palette cannot supply the state
 *   token an invoke requires (it auto-fills only `view_id`), and the Run
 *   button IS the human surface (it calls the same guarded function); the
 *   MCP manifest keeps it AI-drivable;
 * - params require BOTH `view_id` and `expected` (the state token from
 *   `view.describe`), so a direct `runAction` caller cannot skip the
 *   guard's input.
 */
import { describe, expect, it } from 'vitest'
import './modelRunActions'
import { getActionMeta, getActionRegistry } from '../defineAction'
import { MODELS_RUN, TXR_MODEL_LIST_CONTEXT } from '@/modules/txrmodels/lib/modelRun'

describe('models.run (the model-step Run action)', () => {
  it('is a permissioned, mutating, stateful INSTANCE action scoped to the model-list context', () => {
    const meta = getActionMeta(MODELS_RUN)
    expect(meta).toBeDefined()
    expect(meta?.permission).toBe('mcp::use')
    expect(meta?.kind).toBe('instance')
    expect(meta?.mutating).toBe(true)
    expect(meta?.stateful).toBe(true)
    expect(meta?.context).toBe(TXR_MODEL_LIST_CONTEXT)
    expect(meta?.group).toBe('Analysis')
    expect(meta?.surfaces).toEqual({ palette: false, ai: true })
  })

  it('requires the view_id and the expected state token (the stale-state guard\u2019s input)', () => {
    const params = getActionRegistry().get(MODELS_RUN)?.params
    expect(params).toBeDefined()
    expect(params?.safeParse({ view_id: 'v1', expected: 'v1@3' }).success).toBe(true)
    expect(params?.safeParse({ view_id: 'v1' }).success).toBe(false)
    expect(params?.safeParse({ expected: 'v1@3' }).success).toBe(false)
  })
})
