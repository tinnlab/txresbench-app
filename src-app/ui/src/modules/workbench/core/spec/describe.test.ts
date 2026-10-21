import { describe, it, expect, beforeEach } from 'vitest'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { ActionContext } from '@/core/actions/ctx'
import { __resetInstanceRegistryForTests } from '@/core/actions/instanceRegistry'
import { synthesizeDescribeAction } from './describe'
import { createViewStore } from '@/modules/workbench/core/runtime/store'
import { registerViewStore, __resetViewStoresForTests } from '@/modules/workbench/core/runtime/viewStores'
import { describeActionId } from './ids'
import type { InterpreterCtx } from '@/modules/workbench/core/runtime/interpreter'

// TEST-10 (PLAN.md ITEM-11) — the auto-synthesized `<view>.describe` read-action
// returns `{state, derived, _state_token}` and is AI-only
// (`surfaces:{palette:false, ai:true}`).

function spec(): ViewSpec {
  return {
    id: 'test/describe',
    title: 'Describe test view',
    permission: 'jobs::use',
    state: { selectedEmbedding: { type: 'string', default: 'umap' } },
    const: {},
    derived: { idents: { unique: '$data.obs.ident' } },
    widgets: [],
    actions: [],
  }
}

const data = { obs: { ident: ['A', 'A', 'B'] } }

beforeEach(() => {
  __resetInstanceRegistryForTests()
  __resetViewStoresForTests()
})

describe('synthesizeDescribeAction (ITEM-11)', () => {
  it('is an AI-only, non-mutating instance read-action', () => {
    const action = synthesizeDescribeAction(spec())
    expect(action.id).toBe(describeActionId('test/describe'))
    expect(action.kind).toBe('instance')
    expect(action.mutating).toBe(false)
    expect(action.surfaces).toEqual({ palette: false, ai: true })
    expect(action.permission).toBe('jobs::use')
  })

  it('returns the live state + derived + state token for a mounted view', () => {
    const s = spec()
    const store = createViewStore(s, 'desc-view-1', data)
    registerViewStore('desc-view-1', store)
    store.set('selectedEmbedding', 'tsne')

    const action = synthesizeDescribeAction(s)
    const ctx = { viewStore: () => store } as unknown as InterpreterCtx
    const result = action.run({ view_id: 'desc-view-1' }, ctx as ActionContext) as {
      state: Record<string, unknown>
      derived: Record<string, unknown>
      _state_token: string
    }

    expect(result.state.selectedEmbedding).toBe('tsne')
    expect(result.derived.idents).toEqual(['A', 'B'])
    expect(result._state_token).toBe(store.token)
    expect(typeof result._state_token).toBe('string')
    store.dispose()
  })

  it('returns empty state (not a throw) when no instance is mounted', () => {
    const action = synthesizeDescribeAction(spec())
    const ctx = { viewStore: () => undefined } as unknown as InterpreterCtx
    const result = action.run({ view_id: 'nope' }, ctx as ActionContext) as {
      _state_token: string | undefined
    }
    expect(result._state_token).toBeUndefined()
  })
})
