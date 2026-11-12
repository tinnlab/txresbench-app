/**
 * TEST-UR-12 — txrresults AppEvents declaration + emitters (PROV-UR-3,
 * INV-4; ITEM-2) and the reconcile-growth TEST-UR-10 rows that also belong to
 * ITEM-2 (both save-model events declared + emitted with their payloads; the
 * H one-method button's "only for a produced model" gate is ITEM-9's).
 *
 * The framework EventBus runs FOR REAL (no mock): the events are declared on
 * the framework's `AppEvents` via declaration merging (the documented seam,
 * `sdk/packages/framework/src/events/types.ts` — "Modules add their events via
 * declaration merging"), and `emitSaveModels` / `emitSaveOneModel` emit
 * through the bus, so a subscriber receives exactly the cross-node payload
 * `{type, runId, methodIds}` / `{type, runId, methodId}` plus the bus-added
 * `timestamp` (the payload ui-models binds, PROV-UI-MODELS-2).
 *
 * Module-augmentation note (the reason the emitters spell `K` explicitly):
 * `emit`'s generic appears only inside `Omit<AppEvents[K], 'timestamp'>`, so
 * it cannot be inferred from the argument; the pre-existing `sync` producers
 * (`core/sync/localEcho.ts`, `catalogInvalidation.test.tsx`) gained the same
 * explicit `K` — see the node's DRIFT-1 ITEM-2 entry.
 */
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { useEventBusStore } from '@txresbench/framework/events'
import type { AppEvents, BaseEvent } from '@txresbench/framework/events'
import { emitSaveModels, emitSaveOneModel } from './events'

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url))

/**
 * The module's published surface for the INV-4 scan: every module `.ts`/`.tsx`
 * file EXCEPT the test files (the tests may name the scanned tokens — the
 * same exclusion ITEM-1's scan uses), plus the README and the future
 * `fixtures.ts` when it exists (TESTS.md names module + README + fixtures).
 */
function publishedSurface(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...publishedSurface(p))
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(p)
    }
  }
  const readme = path.join(dir, 'README.md')
  if (existsSync(readme)) out.push(readme)
  const fixtures = path.join(dir, 'fixtures.ts')
  if (existsSync(fixtures)) out.push(fixtures)
  return out
}

beforeEach(() => {
  useEventBusStore.getState().clear()
})

afterEach(() => {
  useEventBusStore.getState().clear()
})

describe('txrresults events (TEST-UR-12 / growth TEST-UR-10)', () => {
  it('declares both txr events on the framework AppEvents with the planned payloads', () => {
    expectTypeOf<AppEvents['txr:save-models-requested']>().toEqualTypeOf<
      BaseEvent & {
        type: 'txr:save-models-requested'
        runId: string
        methodIds: string[]
      }
    >()
    expectTypeOf<AppEvents['txr:save-one-model-requested']>().toEqualTypeOf<
      BaseEvent & {
        type: 'txr:save-one-model-requested'
        runId: string
        methodId: string
      }
    >()
    // The keys are real `keyof AppEvents` members — the typed `on`/`emit`
    // surface of the bus accepts them (the consumer side `ui-models` binds).
    expectTypeOf<'txr:save-models-requested'>().toMatchTypeOf<keyof AppEvents>()
    expectTypeOf<'txr:save-one-model-requested'>().toMatchTypeOf<keyof AppEvents>()
  })

  it('emitSaveModels delivers {type, runId, methodIds} to a subscriber', async () => {
    const received: AppEvents['txr:save-models-requested'][] = []
    const off = useEventBusStore
      .getState()
      .on('txr:save-models-requested', e => void received.push(e))

    await emitSaveModels('run-7', ['landmark-cox-current', 'cox-cutpoint-risk'])
    off()

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({
      type: 'txr:save-models-requested',
      runId: 'run-7',
      methodIds: ['landmark-cox-current', 'cox-cutpoint-risk'],
      timestamp: expect.any(Number),
    })
  })

  it('emitSaveOneModel delivers {type, runId, methodId} to a subscriber', async () => {
    const received: AppEvents['txr:save-one-model-requested'][] = []
    const off = useEventBusStore
      .getState()
      .on('txr:save-one-model-requested', e => void received.push(e))

    await emitSaveOneModel('run-7', 'cox-cutpoint-risk')
    off()

    expect(received).toHaveLength(1)
    expect(received[0]).toEqual({
      type: 'txr:save-one-model-requested',
      runId: 'run-7',
      methodId: 'cox-cutpoint-risk',
      timestamp: expect.any(Number),
    })
  })

  it('emits into an unsubscribed bus as a benign no-op (the pre-ui-models state)', async () => {
    // Until ui-models' dialog host mounts (wave 7), the events have no
    // listener: the click must not throw or reject (DEC-8), and it must not
    // leave a handler behind.
    await expect(emitSaveModels('run-7', ['landmark-cox-current'])).resolves.toBeUndefined()
    await expect(emitSaveOneModel('run-7', 'landmark-cox-current')).resolves.toBeUndefined()
    expect(useEventBusStore.getState().getHandlerCount('txr:save-models-requested')).toBe(0)
    expect(useEventBusStore.getState().getHandlerCount('txr:save-one-model-requested')).toBe(0)
  })

  it('spells no status words and no the-scanned literal in the published surface (INV-4)', () => {
    // Same precision as module.test.ts's scan (DRIFT-1 ITEM-6): the kit
    // input-hint prop occurrences are INPUT AFFORDANCES, not copy marks.
    const kitHintProp = new RegExp('place' + 'holder' + '\\s*=\\s*"[^"]*"', 'gi')
    const own = publishedSurface(MODULE_DIR)
      .map(p => readFileSync(p, 'utf8'))
      .join('\n')
      .replace(kitHintProp, '')
      .toLowerCase()
    const statusWords = [
      'to' + 'do',
      't' + 'bd',
      'place' + 'holder',
      'coming so' + 'on',
      'in pro' + 'gress',
    ]
    for (const word of statusWords) {
      expect(own).not.toContain(word)
    }
    const studyRe = new RegExp('st' + 'ud(y|ies)', 'i')
    expect(studyRe.test(own)).toBe(false)
  })
})
