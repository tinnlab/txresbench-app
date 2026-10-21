// @vitest-environment jsdom
//
// TEST-17 (ITEM-12) — THE PIPELINE FORM SHOWED A VALUE THE RUN NEVER RECEIVED.
//
// `FieldEditor`'s enum arm rendered `value ?? field.default ?? field.options[0]`, while the
// form's `params` starts `{}` and is written ONLY by `onChange`. So an untouched enum field
// with no declared `default` DISPLAYED its first option and SUBMITTED nothing for that key —
// two different claims about the same parameter, in the same form, with nothing to tell them
// apart. Which option was displayed came from declaration order, so it was a `[0]` as well.
//
// The assertion that matters is the PAIR: what the control reads as, and what
// `buildProcessSpec` hands to `runProcessor`, checked in the same act. A test of either half
// alone passes against the defect — that is exactly how it shipped.
//
// This drives the REAL `PipelineTimeline` → real `FieldEditor` → real `params` state → real
// `buildProcessSpec`. Two boundaries are stubbed and no more: the store (the network) and
// `fallbackParamsFor` (the FIELD SOURCE — see the note on it below).

import { act } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AnalysisContribution, ParamField } from '@/modules/workbench/core'

/** The store stands in for the network: `runProcessor` is the SUBMIT boundary, so what it is
 *  handed IS "what the run receives". */
const store = {
  submitting: false,
  processJob: null as unknown,
  processError: null as string | null,
  runProcessor: vi.fn(async (_datasetId: string, _spec: Record<string, unknown>, _opts?: unknown) => {}),
}
vi.mock('@/modules/datasets/stores/DatasetDetail.store', () => ({ DatasetDetail: store }))

/**
 * The field SOURCE is stubbed, and it is worth saying why rather than leaving it looking like
 * convenience.
 *
 * `PipelineTimeline` derives its fields from `fallbackParamsFor(contribution)`, which today
 * synthesizes ONE artifact-ref control per input slot and nothing else — so no enum field can
 * reach `FieldEditor` through the live path, and a test that went through it would assert
 * nothing about the enum arm. The arm is still real, shipped, reachable code the moment that
 * synthesis learns any scalar field, and the display/submit disagreement it carried is the
 * defect under test. So the schema is injected here and EVERYTHING downstream of it — the
 * editor, the `params` state, the spec builder, the submit — is the production path.
 */
const FIELDS: ParamField[] = [
  { id: 'method', type: 'enum', title: 'Method', options: ['choice_a', 'louvain'] } as ParamField,
  { id: 'metric', type: 'enum', title: 'Metric', options: ['euclidean', 'cosine'], default: 'cosine' } as ParamField,
]
vi.mock('@/modules/workbench/extensions/analysis/inputEconomy', () => ({
  fallbackParamsFor: () => ({ fields: FIELDS }),
}))

beforeAll(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  globalThis.matchMedia ??= ((q: string) => ({
    matches: false, media: q, onchange: null,
    addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {},
    dispatchEvent() { return false },
  })) as never
  ;(Element.prototype as { getAnimations?: () => unknown[] }).getAnimations ??= () => []
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
})

const { PipelineTimeline } = await import('./PipelineTimeline')

const CONTRIBUTION = {
  id: 'demo.cluster',
  title: 'Cluster',
  extensionId: 'demo',
  apiVersion: '^1.0',
  category: 'demo',
  appliesTo: [],
  produces: [],
  run: { kind: 'sandbox', runtime: 'python', entry: 'compute/cluster.py' },
} as unknown as AnalysisContribution

const PROCESSORS = [{ contribution: CONTRIBUTION, availability: { available: true, runnable: true } }]

afterEach(cleanup)
beforeEach(() => {
  store.runProcessor.mockClear()
  store.submitting = false
})

const byTestId = (id: string): HTMLElement => {
  const el = document.querySelector<HTMLElement>(`[data-testid="${id}"]`)
  if (!el) throw new Error(`no [data-testid="${id}"]`)
  return el
}

const text = (el: Element): string => (el.textContent ?? '').replace(/\s+/g, ' ').trim()

/** Mount the pipeline and open the processor's param form (the surface under test). */
async function openForm(): Promise<void> {
  await act(async () => {
    render(
      <PipelineTimeline
        datasetId="ds-1"
        datatype="demo/thing"
        processorsOverride={PROCESSORS as never}
      />,
    )
  })
  await act(async () => {
    fireEvent.click(byTestId('pipeline-processor-demo.cluster'))
  })
}

/** Press Run and return the `params` the spec actually carried to the submit boundary. */
async function submittedParams(): Promise<Record<string, unknown>> {
  await act(async () => {
    fireEvent.click(byTestId('pipeline-form-run'))
  })
  expect(store.runProcessor, 'the run must have reached the submit boundary').toHaveBeenCalled()
  const spec = store.runProcessor.mock.calls[0][1] as unknown as { params: Record<string, unknown> }
  return spec.params
}

describe('TEST-17: the pipeline enum shows exactly what it submits', () => {
  it('an untouched enum with no declared default shows NO value and submits NO key', async () => {
    await openForm()
    const shown = text(byTestId('pipe-field-method'))
    // Pre-fix this read "choice_a" — the first option, displayed as though chosen.
    expect(shown, 'nothing was chosen, so no option may be displayed as chosen').not.toContain('choice_a')
    expect(shown).not.toContain('louvain')

    const params = await submittedParams()
    expect(
      Object.hasOwn(params, 'method'),
      'and the run receives no `method` — which is what the empty control says',
    ).toBe(false)
  })

  it('choosing an option shows it AND submits it (the positive control)', async () => {
    await openForm()
    // Open + choose the way the kit's own select tests do (one click, then a flush — base-ui
    // opens on click and mounts its popup a microtask later).
    await act(async () => {
      fireEvent.click(byTestId('pipe-field-method'))
      await Promise.resolve()
    })
    await act(async () => { await Promise.resolve() })
    const opt = byTestId('pipe-field-method-opt-louvain')
    await act(async () => {
      // base-ui's Select commits on the pointer sequence, not on a bare synthetic `click`.
      fireEvent.pointerDown(opt, { pointerType: 'mouse', button: 0, bubbles: true })
      fireEvent.mouseDown(opt, { button: 0, bubbles: true })
      fireEvent.pointerUp(opt, { pointerType: 'mouse', button: 0, bubbles: true })
      fireEvent.mouseUp(opt, { button: 0, bubbles: true })
      fireEvent.click(opt, { bubbles: true })
      await Promise.resolve()
    })
    await act(async () => { await Promise.resolve() })
    expect(text(byTestId('pipe-field-method'))).toContain('louvain')
    expect(await submittedParams()).toMatchObject({ method: 'louvain' })
  })

  it('a DECLARED default is displayed — and is the value an absent key resolves to', async () => {
    // Not the same disagreement: `params.json` is where an absent key takes the declared
    // default, so "shows `cosine`, submits nothing" is one claim, not two. What the fix
    // removes is the INVENTED `options[0]`, not the author's own declaration.
    await openForm()
    expect(text(byTestId('pipe-field-metric'))).toContain('cosine')
    expect(Object.hasOwn(await submittedParams(), 'metric')).toBe(false)
  })
})
