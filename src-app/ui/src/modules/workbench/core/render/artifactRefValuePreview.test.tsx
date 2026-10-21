// @vitest-environment jsdom
//
// The VALUE PREVIEW on the `artifact_ref` control — the excerpt of a chosen column's own
// values, shown under the control.
//
// ## What it is for, and why the assertions are shaped this way
//
// A picker offers artifacts by NAME. On a real dataset two candidates on one axis — an
// identifier column and a label column — render as two strings a user cannot tell apart,
// and picking wrong is SILENT: the run matches its patterns against identifiers, finds
// nothing, and reports zero rather than failing. So the BEHAVIOUR is a CONTRAST — two
// selections, two different excerpts — and `the contrast is visible` is the first test
// below, not an afterthought.
//
// Everything else here is a cost or a degradation property, and every one of them is
// asserted on what the control DID (the port calls it issued, the DOM it produced), never
// on timing and never on the absence of a crash:
//
//   · nothing is read before a selection exists, and nothing is read for a column that
//     cannot be excerpted (DEC-1, DEC-3);
//   · the commonest case is answered by the catalog row with NO port call at all;
//   · a pending read shows nothing rather than the previous column's values;
//   · a failed read leaves the form fully operable.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor, act } from '@testing-library/react'
import { z } from 'zod'
import { defineAction } from '@/core/actions/defineAction'
import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { ArtifactRow } from '@/modules/workbench/core/artifacts/catalog'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { CATALOG_SCOPE_KEY } from '@/modules/workbench/core/artifacts/catalog'
import {
  VALUE_PREVIEW_SCOPE_KEY,
  type ArtifactValuePreviewSource,
  type ValuePreview,
  type ValuePreviewRequest,
} from '@/modules/workbench/core/artifacts/valuePreview'
import { choosePicker, pickerOptions } from '@/modules/workbench/core/__testutil__/pickerDriver'
import { __clearWidgetsForTests, registerWidget } from './registry'
import { ArtifactRefRenderer, ARTIFACT_REF_COPY } from './ArtifactRefWidget'
import { WidgetList } from './WidgetHost'

// ── the catalog rows, shaped as a real producer declares them ────────────────────────
//
// A metadata column is a ONE-member Zarr table whose member path is the constant
// `"values"`, the column's display name is in `meta.name`, and the member's `kind` is the
// STORED ENCODING (`string` = inline utf8, `categorical` = dictionary-encoded). That is
// the shape the live catalog serves; the two spellings matter because the preview
// dispatches on the encoding and nothing else.

function columnRow(
  id: string,
  kind: 'string' | 'categorical' | 'numeric',
  meta: Record<string, unknown> = {},
  memberOver: Record<string, unknown> = {},
): ArtifactRow {
  return {
    id,
    project_id: 'p1',
    datatype: 'demo/column',
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: 'cols',
      n: 100,
      arrays: [],
      columns: [{ path: 'values', name: 'values', kind, axis: 'cols', ...memberOver }],
    },
    meta: { name: id, ...meta },
    created_at: '2026-01-01T00:00:00Z',
    source_dataset_id: 'ds-a',
  }
}

const MATRIX: ArtifactRow = {
  id: 'm1',
  project_id: 'p1',
  datatype: 'demo/matrix',
  structure: { encoding: 'zarr_v3', kind: 'sparse_csc', axes: ['rows', 'cols'], shape: [10, 20] },
  meta: { name: 'matrix' },
  created_at: '2026-01-01T00:00:00Z',
  source_dataset_id: 'ds-a',
}

/** A recording preview port. The call LOG is the assertion surface for every cost claim
 *  below — "issues no read" is a statement about requests, and inferring it from timing or
 *  from the rendered result is exactly what lets a full read pass unnoticed. */
function recordingSource(
  answer: (request: ValuePreviewRequest) => Promise<ValuePreview | undefined>,
): ArtifactValuePreviewSource & { calls: ValuePreviewRequest[] } {
  const calls: ValuePreviewRequest[] = []
  return {
    calls,
    previewValues: request => {
      calls.push(request)
      return answer(request)
    },
  }
}

/** A port whose answers are held open until the test releases them — the only way to
 *  observe the PENDING state, which is where a stale preview would show. */
function deferredSource(): ArtifactValuePreviewSource & {
  calls: ValuePreviewRequest[]
  release(id: string, preview: ValuePreview | undefined): Promise<void>
  fail(id: string, error: Error): Promise<void>
} {
  const calls: ValuePreviewRequest[] = []
  const pending = new Map<string, { resolve(p: ValuePreview | undefined): void; reject(e: Error): void }>()
  return {
    calls,
    previewValues: request => {
      calls.push(request)
      return new Promise((resolve, reject) => pending.set(request.artifactId, { resolve, reject }))
    },
    async release(id, preview) {
      await act(async () => {
        pending.get(id)?.resolve(preview)
        await Promise.resolve()
      })
    },
    async fail(id, error) {
      await act(async () => {
        pending.get(id)?.reject(error)
        await Promise.resolve()
      })
    },
  }
}

function scopeWith(
  artifacts: ArtifactRow[],
  state: Record<string, unknown> = {},
  preview?: ArtifactValuePreviewSource,
): Scope {
  return {
    params: {},
    state,
    derived: {},
    const: {},
    data: {},
    [CATALOG_SCOPE_KEY]: { artifacts },
    [VALUE_PREVIEW_SCOPE_KEY]: preview,
  }
}

function mount(spec: WidgetSpec, scope: Scope) {
  registerWidget('artifact_ref', ArtifactRefRenderer)
  return render(<WidgetList specs={[spec]} scope={scope} viewId="v1" specId="s1" />)
}

let actionSeq = 0
function captureAction(): { id: string; calls: Array<Record<string, unknown>> } {
  const localId = `previewRef${++actionSeq}`
  const calls: Array<Record<string, unknown>> = []
  defineAction({
    id: `s1::${localId}`,
    title: localId,
    permission: 'jobs::use',
    mutating: true,
    params: z.object({}).passthrough(),
    run: async (params: Record<string, unknown>) => {
      calls.push(params)
    },
  })
  return { id: localId, calls }
}

const PICKER = (onChange = 'noop'): WidgetSpec => ({
  id: 'cols',
  kind: 'artifact_ref',
  label: 'Names from',
  source: { axis: 'cols', of: '$state.matrix', values: 'text' },
  value: '$state.cols',
  onChange,
})

const previewNode = () => screen.queryByTestId('widget-cols-preview')

/** The picker's trigger. */
const picker = (): HTMLElement => screen.getByTestId('widget-cols-select')
/** The artifact the control DISPLAYS as chosen (its own selected rendering names it). */
const displayedId = (): string | undefined =>
  picker().querySelector('[data-artifact-id]')?.getAttribute('data-artifact-id') ?? undefined

// jsdom gaps the kit's base-ui controls probe at mount / on activation.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent !== 'function') {
    ;(globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {} as never
    ;(window as unknown as { PointerEvent?: unknown }).PointerEvent = (
      globalThis as { PointerEvent?: unknown }
    ).PointerEvent
  }
})

beforeEach(() => {
  __clearWidgetsForTests()
  cleanup()
})
afterEach(() => {
  __clearWidgetsForTests()
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// THE BEHAVIOUR — the contrast between two candidates that read alike
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('the preview distinguishes two columns a picker renders as two names', () => {
  // The two rows differ ONLY in their values; both are text-valued columns on one axis,
  // both offered, neither preferable on any structural ground. That is the real situation
  // the surrounding control was built for and could not resolve.
  const IDS = columnRow('ids', 'string', { categories: ['ID-0001', 'ID-0002', 'ID-0003'] })
  const LABELS = columnRow('labels', 'categorical', { categories: ['alpha', 'beta', 'gamma'] })
  const artifacts = [MATRIX, IDS, LABELS]

  it('shows one column’s values, and the OTHER column’s when the choice changes', () => {
    // Chosen: the identifier column.
    const first = mount(PICKER(), scopeWith(artifacts, { matrix: 'm1', cols: 'ids' }))
    expect(previewNode()?.textContent).toContain('ID-0001, ID-0002, ID-0003')
    expect(previewNode()?.textContent).not.toContain('alpha')
    expect(previewNode()?.getAttribute('data-artifact-id')).toBe('ids')
    first.unmount()

    // Chosen: the label column. Same control, same candidates, different excerpt.
    mount(PICKER(), scopeWith(artifacts, { matrix: 'm1', cols: 'labels' }))
    expect(previewNode()?.textContent).toContain('alpha, beta, gamma')
    expect(previewNode()?.textContent).not.toContain('ID-0001')
    expect(previewNode()?.getAttribute('data-artifact-id')).toBe('labels')
  })

  it('says `e.g.` and never claims the values are the FIRST rows (DEC-2)', () => {
    // Two of the three sources are the column's VOCABULARY, which carries no row order at
    // all — a declared level set includes levels the data never uses. A rendering that
    // said "first 5" would be a confident claim about an ordering the data does not have.
    mount(PICKER(), scopeWith(artifacts, { matrix: 'm1', cols: 'labels' }))
    const text = previewNode()?.textContent ?? ''
    expect(text).toContain(ARTIFACT_REF_COPY.previewPrefix)
    expect(text.toLowerCase()).not.toMatch(/\bfirst\b|\brow\b|\bstarts? with\b/)
  })

  it('is programmatically associated with the control, not merely adjacent', () => {
    // A fact about the current value that a screen reader never reads WITH the control is
    // not shown to the user who most needs it.
    mount(PICKER(), scopeWith(artifacts, { matrix: 'm1', cols: 'labels' }))
    const select = picker()
    const describedBy = (select.getAttribute('aria-describedby') ?? '').split(/\s+/)
    expect(describedBy).toContain(previewNode()?.parentElement?.getAttribute('id'))
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// WHAT IT COSTS — asserted on the reads issued
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('what the preview reads', () => {
  it('reads NOTHING before a selection exists (acceptance 5)', async () => {
    const source = recordingSource(async () => ({ values: ['x'], source: 'rows' }))
    mount(
      PICKER(),
      scopeWith([MATRIX, columnRow('a', 'string'), columnRow('b', 'string')], { matrix: 'm1' }, source),
    )
    // Two candidates, an unbound picker: the control is fully rendered and has asked for
    // nothing. Previewing all N candidates would turn one control into N data-plane reads
    // on every mount, for a question the user has not asked yet (DEC-1).
    expect(picker()).toBeTruthy()
    await act(async () => {
      await Promise.resolve()
    })
    expect(source.calls).toEqual([])
    expect(previewNode()).toBeNull()
  })

  it('reads NOTHING when the row already carries the producer’s own excerpt', async () => {
    // The cheapest source, and on real data the usual one: `meta.categories` is
    // `colsummary`'s compact preview, capped at the producer and riding the catalog row
    // the picker already holds.
    const source = recordingSource(async () => ({ values: ['from-the-port'], source: 'rows' }))
    mount(
      PICKER(),
      scopeWith(
        [MATRIX, columnRow('labels', 'categorical', { categories: ['alpha', 'beta'] })],
        { matrix: 'm1', cols: 'labels' },
        source,
      ),
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(previewNode()?.textContent).toContain('alpha, beta')
    expect(source.calls).toEqual([])
  })

  it('reads NOTHING for a column whose declared ENCODING carries no text (DEC-3)', async () => {
    // The ENCODING governs, and this is the case where the two vocabularies disagree on
    // real data: a bool column is stamped `numeric` in `structure` and `categorical` in
    // `meta`, with a `categories` list sitting right there ready to be rendered. Five
    // numbers are not a summary of a numeric column, so nothing is shown and — the part
    // that is only visible in the call log — nothing is fetched either.
    //
    // The control here declares NO `values:` term on purpose. A term-filtered picker never
    // offers a numeric column at all, so binding one to it would leave the control in its
    // empty arm and this assertion would pass having never reached the gate it is about.
    const source = recordingSource(async () => ({ values: ['nope'], source: 'rows' }))
    const anyColumn: WidgetSpec = {
      id: 'cols',
      kind: 'artifact_ref',
      label: 'Any column',
      source: { axis: 'cols', of: '$state.matrix' },
      value: '$state.cols',
    }
    const flag = columnRow('flag', 'numeric', { kind: 'categorical', categories: [false, true] })
    mount(
      anyColumn,
      scopeWith([MATRIX, flag, columnRow('labels', 'categorical')], { matrix: 'm1', cols: 'flag' }, source),
    )
    // POSITIVE CONTROL on the setup: the numeric column really IS offered and really IS
    // the bound one, so "no preview" is the gate's doing rather than the control's.
    expect(await pickerOptions(picker())).toContain('flag')
    expect(displayedId()).toBe('flag')

    await act(async () => {
      await Promise.resolve()
    })
    expect(previewNode()).toBeNull()
    expect(source.calls).toEqual([])
  })

  it('asks the PORT exactly once, with the row’s own declaration, when the row cannot answer', async () => {
    const source = recordingSource(async () => ({ values: ['MT-CO1', 'ACTB'], source: 'levels' }))
    const row = columnRow('labels', 'categorical') // no `meta.categories`
    mount(PICKER(), scopeWith([MATRIX, row], { matrix: 'm1', cols: 'labels' }, source))
    await waitFor(() => expect(previewNode()?.textContent).toContain('MT-CO1, ACTB'))
    // The `structure` rides along, which is what makes the read cost no control-plane
    // re-fetch just to learn how to decode.
    expect(source.calls).toEqual([{ artifactId: 'labels', structure: row.structure, limit: 5 }])
    expect(previewNode()?.getAttribute('data-preview-source')).toBe('levels')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// SWITCHING — a pending read shows nothing, never the previous column
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('switching the selection', () => {
  const A = columnRow('a', 'categorical')
  const B = columnRow('b', 'categorical')

  it('shows NOTHING while the new column’s read is in flight (acceptance 3)', async () => {
    const source = deferredSource()
    const spec = PICKER()
    const { rerender } = mount(spec, scopeWith([MATRIX, A, B], { matrix: 'm1', cols: 'a' }, source))
    await source.release('a', { values: ['a-one', 'a-two'], source: 'levels' })
    expect(previewNode()?.textContent).toContain('a-one, a-two')

    // Switch to B. Its read has not landed.
    await act(async () => {
      rerender(
        <WidgetList
          specs={[spec]}
          scope={scopeWith([MATRIX, A, B], { matrix: 'm1', cols: 'b' }, source)}
          viewId="v1"
          specId="s1"
        />,
      )
    })
    // THE assertion. A stale preview here would be a confident statement about column B
    // made out of column A's values — the exact shape of wrongness this whole control
    // exists to remove, and it would look completely normal.
    expect(previewNode()).toBeNull()

    await source.release('b', { values: ['b-one'], source: 'levels' })
    expect(previewNode()?.textContent).toContain('b-one')
    expect(previewNode()?.getAttribute('data-artifact-id')).toBe('b')
    expect(source.calls.map(c => c.artifactId)).toEqual(['a', 'b'])
  })

  it('never renders a late answer for a column that is no longer chosen', async () => {
    const source = deferredSource()
    const spec = PICKER()
    const { rerender } = mount(spec, scopeWith([MATRIX, A, B], { matrix: 'm1', cols: 'a' }, source))
    await act(async () => {
      rerender(
        <WidgetList
          specs={[spec]}
          scope={scopeWith([MATRIX, A, B], { matrix: 'm1', cols: 'b' }, source)}
          viewId="v1"
          specId="s1"
        />,
      )
    })
    // A's read finishes AFTER the user moved on.
    await source.release('a', { values: ['a-one'], source: 'levels' })
    expect(previewNode()).toBeNull()
    await source.release('b', { values: ['b-one'], source: 'levels' })
    expect(previewNode()?.textContent).toContain('b-one')
    expect(previewNode()?.textContent).not.toContain('a-one')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// DEGRADATION — the preview is an aid, never a gate (DEC-4)
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('when the preview cannot be produced', () => {
  it('a FAILED read renders nothing and leaves the control fully operable (acceptance 4)', async () => {
    // This is the ORDINARY path on the dev data this was built against: its object store
    // holds no bytes for any of the project's artifacts, so every data-plane read 404s.
    const source = deferredSource()
    const act1 = captureAction()
    const spec = PICKER(act1.id)
    mount(spec, scopeWith([MATRIX, columnRow('a', 'categorical'), columnRow('b', 'categorical')], { matrix: 'm1', cols: 'a' }, source))
    await source.fail('a', new Error('workstore a/values/zarr.json → 404 Blob not found'))

    expect(previewNode()).toBeNull()
    // …and the form still works: no error surface, and the picker still dispatches.
    expect(picker().hasAttribute('disabled')).toBe(false)
    await choosePicker(picker(), 'b')
    await waitFor(() => expect(act1.calls).toHaveLength(1))
    expect(act1.calls[0]).toMatchObject({ value: 'b' })
  })

  it('a port that answers "nothing to preview" renders nothing, and does not retry forever', async () => {
    const source = recordingSource(async () => undefined)
    // The catalog is re-fetched on every epoch, so the SAME artifact arrives as a NEW row
    // object. An effect keyed on the row's `structure` by identity re-issues the read each
    // time, for an answer that cannot have changed — an artifact is immutable and
    // content-addressed. Rebuilding the rows here is what makes that observable.
    const rows = () => [MATRIX, columnRow('a', 'categorical'), columnRow('b', 'categorical')]
    const { rerender } = mount(PICKER(), scopeWith(rows(), { matrix: 'm1', cols: 'a' }, source))
    await act(async () => {
      await Promise.resolve()
    })
    expect(previewNode()).toBeNull()
    await act(async () => {
      rerender(
        <WidgetList
          specs={[PICKER()]}
          scope={scopeWith(rows(), { matrix: 'm1', cols: 'a' }, source)}
          viewId="v1"
          specId="s1"
        />,
      )
    })
    expect(source.calls).toHaveLength(1)
  })

  it('a host that publishes NO preview port leaves the control exactly as it was', async () => {
    // A bare unit mount, or a plane written before this read existed. The control must be
    // its previous self, not broken and not silently degraded into an error state.
    mount(
      PICKER(),
      scopeWith([MATRIX, columnRow('a', 'categorical'), columnRow('b', 'categorical')], {
        matrix: 'm1',
        cols: 'a',
      }),
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(previewNode()).toBeNull()
    expect(displayedId()).toBe('a')
  })

  it('a malformed port (no `previewValues`) is ignored rather than thrown from', async () => {
    // `readValuePreviewScope`'s structural check. A host injecting a partial plane would
    // otherwise TypeError at the instant a user made a selection — an absent AID becoming
    // a broken FORM.
    const scope = scopeWith(
      [MATRIX, columnRow('a', 'categorical'), columnRow('b', 'categorical')],
      { matrix: 'm1', cols: 'a' },
    )
    ;(scope as Record<string, unknown>)[VALUE_PREVIEW_SCOPE_KEY] = { somethingElse: true }
    mount(PICKER(), scope)
    await act(async () => {
      await Promise.resolve()
    })
    expect(previewNode()).toBeNull()
    expect(displayedId()).toBe('a')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// DEC-5 — the distinct count is supplementary, never the preview itself
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('the declared distinct count', () => {
  it('is shown BESIDE the values when the producer declared one', () => {
    mount(
      PICKER(),
      scopeWith(
        [MATRIX, columnRow('labels', 'categorical', { categories: ['alpha', 'beta'], n_categories: 35468 })],
        { matrix: 'm1', cols: 'labels' },
      ),
    )
    expect(previewNode()?.textContent).toContain('alpha, beta')
    expect(screen.getByTestId('widget-cols-preview-distinct').textContent).toContain('35,468')
  })

  it('falls back to the member’s own `n_levels` when `meta` carries no count', async () => {
    const source = recordingSource(async () => ({ values: ['alpha'], source: 'levels' }))
    mount(
      PICKER(),
      scopeWith(
        [MATRIX, columnRow('labels', 'categorical', {}, { n_levels: 22 })],
        { matrix: 'm1', cols: 'labels' },
        source,
      ),
    )
    await waitFor(() => expect(previewNode()).not.toBeNull())
    expect(screen.getByTestId('widget-cols-preview-distinct').textContent).toContain('22')
  })

  it('is NEVER shown on its own — a count cannot substitute for values', async () => {
    // The count separates an annotation-like column from an identifier-like one; it can
    // never separate two identifier-like columns from each other, which is the confusion
    // that caused the defect. A lone "35,468 distinct" under both candidates would look
    // like information and resolve nothing.
    const source = deferredSource()
    mount(
      PICKER(),
      scopeWith(
        [MATRIX, columnRow('labels', 'categorical', { n_categories: 35468 })],
        { matrix: 'm1', cols: 'labels' },
        source,
      ),
    )
    await source.fail('labels', new Error('404'))
    expect(screen.queryByTestId('widget-cols-preview-distinct')).toBeNull()
    expect(document.body.textContent).not.toContain('35,468')
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// the OTHER control arms
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('across the control’s three cardinalities', () => {
  it('the SOLE-candidate summary previews the BOUND value, and nothing while it is resolving', async () => {
    // ITEM-29b — the summary arm is reachable only WITH `auto_bind_sole_candidate` declared.
    // Without it a lone candidate is an ordinary picker holding one option, and there is no
    // summary because nothing has been chosen. The declaration is scaffolding for this spec,
    // whose subject is the PREVIEW.
    const AUTO = (onChange?: string): WidgetSpec =>
      ({ ...PICKER(), onChange, auto_bind_sole_candidate: true }) as WidgetSpec
    const only = columnRow('only', 'categorical', { categories: ['alpha', 'beta'] })
    // Unbound: the summary reads "Selecting…" because the pre-selection has not landed.
    // The preview attaches to the same bound value, so it must be absent too — anything
    // else would name a column the run has not been given.
    const pending = mount(AUTO(undefined), scopeWith([MATRIX, only], { matrix: 'm1' }))
    expect(screen.getByTestId('widget-cols-summary').textContent).toBe(ARTIFACT_REF_COPY.resolving)
    expect(previewNode()).toBeNull()
    pending.unmount()

    mount(AUTO(undefined), scopeWith([MATRIX, only], { matrix: 'm1', cols: 'only' }))
    expect(previewNode()?.textContent).toContain('alpha, beta')
  })

  it('a MULTIPLE picker previews its ONE bound column, and nothing once several are bound', () => {
    const a = columnRow('a', 'categorical', { categories: ['alpha'] })
    const b = columnRow('b', 'categorical', { categories: ['beta'] })
    const multi = (): WidgetSpec => ({ ...PICKER(), multiple: true }) as WidgetSpec

    const one = mount(multi(), scopeWith([MATRIX, a, b], { matrix: 'm1', cols: ['a'] }))
    expect(previewNode()?.textContent).toContain('alpha')
    one.unmount()

    // Two bound: there is no single column to excerpt. Showing one of them would be an
    // excerpt the user cannot attribute; stacking both is noise in a form.
    mount(multi(), scopeWith([MATRIX, a, b], { matrix: 'm1', cols: ['a', 'b'] }))
    expect(previewNode()).toBeNull()
  })

  it('the EMPTY arm previews nothing (there is no value to describe)', () => {
    mount(PICKER(), scopeWith([MATRIX], { matrix: 'm1' }))
    expect(screen.getByTestId('widget-cols-empty')).toBeTruthy()
    expect(previewNode()).toBeNull()
  })
})
