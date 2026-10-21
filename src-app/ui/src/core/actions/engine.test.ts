import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { defineAction } from './defineAction'
import {
  registerActiveContext,
  unregisterActiveContext,
  getActiveContextSnapshot,
} from './activeContext'
import { checkContextGuard } from './engine'

// TEST-107 (PLAN.md ITEM-4) — `checkContextGuard`, the sibling of
// `checkInstanceGuard`, rejects an invoke whose declared non-global `context`
// is inactive with `CONTEXT_INACTIVE: <context>` BEFORE `run`, and passes
// through when the context is active or `'global'`.

// Register the actions under test once (module-load semantics — ids are
// unique so no duplicate-registration throw).
defineAction({
  id: 'test107.workbenchAction',
  title: 'A workbench-scoped action',
  permission: 'jobs::use',
  mutating: true,
  context: 'workbench',
  params: z.object({}),
  run: () => {},
})
defineAction({
  id: 'test107.globalAction',
  title: 'A global action',
  permission: 'mcp::use',
  mutating: true,
  params: z.object({}),
  run: () => {},
})

function frameFor(actionId: string) {
  return { type: 'agent_invoke' as const, request_id: 'req-1', action_id: actionId, params: {} }
}

function clearContexts(): void {
  for (const name of Object.keys(getActiveContextSnapshot().byName)) {
    unregisterActiveContext(name)
  }
}

describe('engine.checkContextGuard (ITEM-4)', () => {
  beforeEach(clearContexts)

  it('rejects a context-scoped action when its context is INACTIVE', () => {
    const verdict = checkContextGuard(frameFor('test107.workbenchAction'))
    expect(verdict).toBe('CONTEXT_INACTIVE: workbench')
  })

  it('passes through once the context is ACTIVE', () => {
    registerActiveContext('workbench')
    expect(checkContextGuard(frameFor('test107.workbenchAction'))).toBeNull()
  })

  it('always passes a "global"-context action', () => {
    expect(checkContextGuard(frameFor('test107.globalAction'))).toBeNull()
  })

  it('passes an unknown action id (runAction reports the unknown id itself)', () => {
    expect(checkContextGuard(frameFor('test107.doesNotExist'))).toBeNull()
  })
})
