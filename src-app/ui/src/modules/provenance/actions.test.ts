// TEST-21/25 (frontend half) — `provenance.record-selection`, the SAVE-POINT recorder that
// finally gives `Provenance.recordCapture` a production caller (ITEM-13, DEC-2).
//
// Asserts that what gets recorded is the run's `criteria` — the SAME encoding the compute
// kernel filters on — persisted as a flat recipe under the `subset.filter` action type
// (the server `action_registry` arm that reads `recipe["criteria"]`), and the INV-1 guard:
// criteria that constrain NOTHING record nothing, rather than an all-true "selection".
//
// ITEM-4: this used to assert a two-call save contract (`POST /selection/by-predicate` →
// `POST /provenance/selections`) with a client-side `buildRecipe` fallback for when the
// server hop could not evaluate the predicate. That hop recorded a SECOND encoding of the
// filter (the criteria lifted into a DSL), which could describe a different cell set than
// the mask committed beside it. The lift, the hop and the fallback are deleted, and with
// them the whole class of test below them: there is no evaluation that can fail, so there
// is no fallback to gate and no unliftable-criterion diagnosis to surface.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const recordCapture = vi.fn()

// `actions.ts` imports the store's DIRECT handle (the `registerLazyStore` proxy),
// not a global registry — so the mock must intercept the STORE MODULE specifier.
// Mocking the old `@/core/stores` shim here would be a silent no-op: the real
// store would run and the assertions would pass vacuously.
vi.mock('@/modules/provenance/stores/Provenance.store', () => ({
  Provenance: { recordCapture: (...a: unknown[]) => recordCapture(...a) },
}))

const { recordSelectionAction } = await import('./actions')
const run = recordSelectionAction.run

const CRITERIA = [{ column: 'pct_mito', control: 'range', max: '10' }]

const BASE = {
  project_id: 'proj-1',
  input_artifact_id: 'art-1',
  criteria: CRITERIA,
  label: 'lowqc',
} as const

/** A ctx with the `toast` capability a declarative `call_action` supplies, so the
 *  tests can assert the user actually SEES a failure (see FINDING 8). */
const toast = vi.fn()
const ctx = { toast } as unknown as Parameters<typeof run>[1]

/** An error shaped like the real `ApiClient` rejection (`core.ts` attaches
 *  `status` + `error_code` to every non-2xx). */
function httpError(status: number, message = `HTTP error! status: ${status}`) {
  return Object.assign(new Error(message), { status })
}

describe('provenance.record-selection', () => {
  beforeEach(() => {
    recordCapture.mockReset()
    recordCapture.mockResolvedValue(undefined)
    toast.mockReset()
  })

  it('is registered with the id the declarative save step calls', () => {
    expect(recordSelectionAction.id).toBe('provenance.record-selection')
    expect(recordSelectionAction.mutating).toBe(true)
  })

  it('records the run CRITERIA as a flat recipe — the same encoding the kernel filtered on', async () => {
    const out = await run({ ...BASE }, ctx)

    expect(recordCapture).toHaveBeenCalledWith(
      'proj-1',
      'art-1',
      // The action type the server's `action_registry` dispatches for THIS recipe shape:
      // its `subset.filter` arm reads `recipe["criteria"]` as an array and emits the
      // replay script through `emit_criteria_script`.
      'subset.filter',
      { criteria: CRITERIA },
      'lowqc',
    )
    expect(out).toEqual({ recorded: true, source: 'criteria' })
  })

  // The action type is the ONE carrier of "what kind of action this was". Posting it as
  // an explicit argument (rather than smuggling a `kind` inside the recipe for the server
  // to re-derive) is what routes the capture to the emitter that can actually reproduce a
  // criteria list — the `selection.column` arm a `kind: 'column'` recipe reached demands
  // string `col`/`op`/`val` fields and answers `MalformedRecipe` for criteria.
  it('posts the action type EXPLICITLY as `subset.filter`, and the recipe carries no `kind`', async () => {
    await run({ ...BASE }, ctx)
    const [, , actionType, recipe] = recordCapture.mock.calls[0]
    expect(actionType).toBe('subset.filter')
    expect(recipe).toEqual({ criteria: CRITERIA })
    // INV-10: no second encoding of the action type inside the recipe.
    expect(recipe).not.toHaveProperty('kind')
  })

  it('records no SECOND encoding — the persisted recipe carries no predicate or version envelope', async () => {
    await run({ ...BASE }, ctx)
    const [, , , recipe] = recordCapture.mock.calls[0]
    expect(recipe).not.toHaveProperty('predicate')
    expect(recipe).not.toHaveProperty('dslVersion')
    expect(recipe).not.toHaveProperty('evaluatorVersion')
    expect(recipe).not.toHaveProperty('axisVersion')
  })

  // ITEM-4, the behaviour change worth naming. A categorical keep-set was the one filter
  // the DSL could NOT express (`in` is a numeric membership test whose column-side
  // coercion differs from the keep path's string comparison), so this exact save used to
  // record NOTHING and throw a "not reproducible" failure at the user. With `criteria` as
  // the record there is nothing to express it in — it IS the record — so it just records.
  it('records a CATEGORICAL keep-set, which the DSL encoding could not express', async () => {
    const criteria = [{ column: 'cell_type', keep: ['T', 'NK'] }]
    const out = await run({ ...BASE, criteria }, ctx)

    expect(out).toEqual({ recorded: true, source: 'criteria' })
    expect(recordCapture).toHaveBeenCalledWith(
      'proj-1',
      'art-1',
      'subset.filter',
      { criteria },
      'lowqc',
    )
    expect(toast).not.toHaveBeenCalled()
  })

  // INV-1. "Nothing was recorded" must mean "nothing was filtered", and the rules that
  // decide it are the SAME ones the keep-mask applies (`criterionColumn` / `parseBound` /
  // `isCategoricalCriterion`) — so this can never disagree with what the kernel did.
  it.each([
    ['absent criteria', undefined],
    ['null criteria', null],
    ['an empty list', []],
    ['a criterion with no column', [{ min: '1' }]],
    ['UNTOUCHED range controls (`min: ""` is not a bound)', [{ column: 'pct_mito', min: '', max: '' }]],
    ['an ungrammatical bound', [{ column: 'pct_mito', max: '0x10' }]],
    ['an empty keep-set', [{ column: 'cell_type', control: 'multiselect', keep: [] }]],
  ])('records NOTHING for %s (no all-true selection — INV-1)', async (_label, criteria) => {
    const out = await run({ ...BASE, criteria } as Parameters<typeof run>[0], ctx)
    expect(out).toEqual({ recorded: false, source: 'none' })
    expect(recordCapture).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })

  it('drops the non-constraining criteria from a MIXED list, keeping the rest', async () => {
    const out = await run(
      { ...BASE, criteria: [{ column: 'pct_mito', max: '' }, ...CRITERIA] },
      ctx,
    )
    expect(out).toEqual({ recorded: true, source: 'criteria' })
    const [, , , recipe] = recordCapture.mock.calls[0]
    expect(recipe).toEqual({ criteria: CRITERIA })
  })

  // F2-36 — ONE failure, ONE message. The persist used to sit in a try whose body
  // ALSO carried `if (!recorded) surfaceFailure(…)`; `surfaceFailure` THROWS, so
  // that throw fell into the enclosing catch, which called `surfaceFailure` again —
  // two toasts for one failure, the second nesting the first's whole sentence inside
  // its own parentheses. `markSurfaced` cannot dedupe it (each call mints a fresh
  // Error), and it is the exact duplicate-message defect that mechanism exists to
  // remove. The guard was ALSO dead code (the store has no `return false` path), so
  // it is gone: the try wraps only the call. Any re-introduction of a second
  // `surfaceFailure` inside it fails here.
  it.each([
    ['a rejecting persist', () => recordCapture.mockRejectedValue(httpError(500, 'boom'))],
    // A store that (contrary to its `Promise<void>` contract) resolves falsy must not
    // resurrect the second toast either.
    ['a falsy-resolving persist', () => recordCapture.mockResolvedValue(false)],
  ])('toasts EXACTLY ONCE for one failure — %s', async (_label, arrange) => {
    arrange()
    await Promise.resolve(run({ ...BASE }, ctx)).catch(() => undefined)
    expect(toast.mock.calls.length).toBeLessThanOrEqual(1)
    for (const [msg] of toast.mock.calls) {
      const text = String((msg as { error?: string }).error ?? '')
      // the self-nested duplicate: the same sentence twice inside one message.
      expect(text.split('NOT recorded').length - 1).toBeLessThanOrEqual(1)
    }
  })

  // FINDING 8(a): `recordCapture` THROWS on an API failure (it used to swallow to
  // `false`). The user-visible outcome is a surfaced error + a rejection, so the
  // caller's unconditional success toast never renders.
  it('a persist that throws is surfaced AND rejects', async () => {
    recordCapture.mockRejectedValue(httpError(403, 'PROJECT_READ_ONLY'))
    await expect(run({ ...BASE }, ctx)).rejects.toThrow(/NOT recorded/)
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/PROJECT_READ_ONLY/) }),
    )
  })

  // The success path must NOT toast an error (a guard against over-firing).
  it('a successful capture surfaces no error', async () => {
    const out = await run({ ...BASE }, ctx)
    expect(out).toEqual({ recorded: true, source: 'criteria' })
    expect(toast).not.toHaveBeenCalled()
  })
})
