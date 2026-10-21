import { describe, it, expect } from 'vitest'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { DatasetCatalog } from '@ziee/viz'
import { parseViewSpec, validateCanvasOption, ROW_PART_KEY, AXIS_ENTRY_VALUES_SOURCE_NAME } from './schema'
import { AXIS_ENTRY_VALUES_SOURCE } from '@/modules/workbench/core/runtime/axisEntries'

// TEST-1 (PLAN.md ITEM-1) — the `view_spec` parser/validator: a valid spec
// parses; an unknown widget `kind`, a permission-less action, and a dangling
// `$`-ref are each rejected.

function baseSpec(): ViewSpec {
  return {
    id: 'demo/spec',
    title: 'Filter rows',
    permission: 'studies::use',
    state: {
      threshold: { type: 'number', default: 0 },
      ranges: { type: 'map', default: {} },
    },
    data: { rowmeta: { source: 'job.result', args: { path: '/rowmeta' } } },
    const: { criteria: ['value'] },
    derived: {
      hidden: {
        filter_mask: {
          values: '$data.rowmeta.value',
          group_of: '$data.rowmeta.group',
          ranges: '$state.ranges',
        },
      },
    },
    widgets: [
      {
        id: 'sel',
        kind: 'select',
        label: 'Metric',
        options: '$const.criteria',
        value: '$state.threshold',
        onChange: 'demo.set',
      },
      {
        kind: 'group',
        label: 'Actions',
        children: [{ kind: 'button', label: 'Save', onClick: 'demo.save' }],
      },
    ],
    actions: [
      {
        id: 'demo.set',
        title: 'Set threshold',
        permission: 'studies::use',
        mutating: true,
        stateful: true,
        params: { value: 'number' },
        body: [{ set: { threshold: '$params.value' } }],
      },
      {
        id: 'demo.save',
        title: 'Save data',
        permission: 'studies::use',
        mutating: true,
        params: {},
        body: [{ toast: { success: 'Saved' } }],
      },
    ],
  }
}

describe('parseViewSpec (ITEM-1)', () => {
  it('accepts a valid view_spec', () => {
    const r = parseViewSpec(baseSpec())
    expect(r.ok).toBe(true)
    expect(r.value?.id).toBe('demo/spec')
    expect(r.errors).toBeUndefined()
  })

  it('rejects an unknown top-level widget kind', () => {
    const spec = baseSpec()
    ;(spec.widgets[0] as { kind: string }).kind = 'frobnicate'
    const r = parseViewSpec(spec)
    expect(r.ok).toBe(false)
    expect(r.errors?.some(e => /unknown widget kind/.test(e.message))).toBe(true)
  })

  it('rejects an unknown widget kind nested inside a group', () => {
    const spec = baseSpec()
    const group = spec.widgets[1] as { children: Array<{ kind: string }> }
    group.children[0].kind = 'bogus'
    const r = parseViewSpec(spec)
    expect(r.ok).toBe(false)
    expect(r.errors?.some(e => /unknown widget kind "bogus"/.test(e.message))).toBe(true)
  })

  it('rejects an action with no permission', () => {
    const spec = baseSpec()
    delete (spec.actions[0] as { permission?: string }).permission
    const r = parseViewSpec(spec)
    expect(r.ok).toBe(false)
    expect(r.errors?.some(e => /requires a non-empty "permission"/.test(e.message))).toBe(true)
  })

  it('rejects a dangling $-ref to an undeclared name', () => {
    const spec = baseSpec()
    ;(spec.widgets[0] as { value: string }).value = '$state.doesNotExist'
    const r = parseViewSpec(spec)
    expect(r.ok).toBe(false)
    expect(r.errors?.some(e => /dangling \$-reference "\$state\.doesNotExist"/.test(e.message))).toBe(true)
  })

  it('rejects a dangling $derived ref', () => {
    const spec = baseSpec()
    spec.derived = { hidden: { or_masks: '$derived.missingList' } }
    const r = parseViewSpec(spec)
    expect(r.ok).toBe(false)
    expect(r.errors?.some(e => /dangling \$-reference "\$derived\.missingList"/.test(e.message))).toBe(true)
  })

  it('rejects an unknown effect op in an action body (finding: validator gap)', () => {
    const spec = baseSpec()
    ;(spec.actions[0] as { body: unknown[] }).body = [{ zap: { foo: 1 } }]
    const r = parseViewSpec(spec)
    expect(r.ok).toBe(false)
    expect(r.errors?.some(e => /unknown effect op.*zap/.test(e.message))).toBe(true)
  })

  it('rejects a widget dispatch that names no declared action (finding: validator gap)', () => {
    const spec = baseSpec()
    ;(spec.widgets[0] as { onChange: string }).onChange = 'demo.doesNotExist'
    const r = parseViewSpec(spec)
    expect(r.ok).toBe(false)
    expect(
      r.errors?.some(e => /references undeclared action "demo\.doesNotExist"/.test(e.message)),
    ).toBe(true)
  })

  it('does NOT flag a $-ref that appears only in prose title/label/toast (finding: over-scan)', () => {
    const spec = baseSpec()
    // Prose mentioning an undeclared $state.foo must not raise a dangling-ref error.
    spec.title = 'Adjust $state.doesNotExist here'
    ;(spec.widgets[0] as { label: string }).label = 'Set $derived.notReal threshold'
    ;(spec.actions[1] as { body: unknown[] }).body = [
      { toast: { success: 'Done with $state.alsoNotReal' } },
    ]
    const r = parseViewSpec(spec)
    expect(r.ok).toBe(true)
    expect(r.errors).toBeUndefined()
  })

  // ITEM-1 — the optional `canvas` VizOption block: structural gate at load time.
  it('accepts a spec carrying a structurally-valid canvas VizOption block', () => {
    const spec = baseSpec() as ViewSpec & { canvas?: unknown }
    spec.canvas = {
      dataset: { id: 'rowmeta' },
      grid: [{ id: 'c1', region: { row: 0, col: 0 } }],
      series: [{ id: 'v', type: 'violin', coordId: 'c1', encode: { groupKey: 'group', valueKey: 'value' } }],
    }
    const r = parseViewSpec(spec)
    expect(r.ok).toBe(true)
  })

  it('rejects a canvas block that is not an object', () => {
    const spec = baseSpec() as ViewSpec & { canvas?: unknown }
    spec.canvas = 'not an option'
    const r = parseViewSpec(spec)
    expect(r.ok).toBe(false)
    expect(r.errors?.some(e => e.path === '$.canvas')).toBe(true)
  })

  it('rejects a canvas block with a non-array series', () => {
    const spec = baseSpec() as ViewSpec & { canvas?: unknown }
    spec.canvas = { dataset: { id: 'rowmeta' }, grid: [], series: {} }
    const r = parseViewSpec(spec)
    expect(r.ok).toBe(false)
    expect(r.errors?.some(e => e.path === '$.canvas.series')).toBe(true)
  })
})

// TEST-1 (ITEM-1) — LOUD per-field validation of the `canvas` VizOption against a resolved
// catalog, reusing `@ziee/viz` `parseOption`: an unknown series.type / coordId / datasetId /
// column each fails LOUD (the same validation the runtime `setOption` enforces).
describe('validateCanvasOption (ITEM-1)', () => {
  const catalog: DatasetCatalog = {
    datasetId: 'rowmeta',
    pointCount: 4,
    layouts: [{ id: 'metric', kind: 'layout', label: 'Metric space' }],
    valueColumns: ['value', 'score'],
    continuousColumns: [{ id: 'score', kind: 'continuous', label: 'score' }],
    categoricalColumns: [{ id: 'group', kind: 'categorical', label: 'group' }],
    hasImage: false,
  }

  function validCanvas(): Record<string, unknown> {
    return {
      dataset: { id: 'rowmeta' },
      grid: [{ id: 'c1', region: { row: 0, col: 0 } }],
      series: [{ id: 'v', type: 'violin', coordId: 'c1', encode: { groupKey: 'group', valueKey: 'score' } }],
    }
  }

  it('returns [] for a valid canvas VizOption (and for an absent block)', () => {
    expect(validateCanvasOption(validCanvas(), catalog)).toEqual([])
    expect(validateCanvasOption(undefined, catalog)).toEqual([])
  })

  it('fails LOUD on an unknown series.type', () => {
    const c = validCanvas()
    ;(c.series as Array<Record<string, unknown>>)[0].type = 'boguschart'
    const errs = validateCanvasOption(c, catalog)
    expect(errs).toHaveLength(1)
    expect(errs[0].message).toMatch(/unregistered type "boguschart"/)
  })

  it('fails LOUD on an unknown coordId', () => {
    const c = validCanvas()
    ;(c.series as Array<Record<string, unknown>>)[0].coordId = 'nope'
    const errs = validateCanvasOption(c, catalog)
    expect(errs[0].message).toMatch(/unknown coordId "nope"/)
  })

  it('fails LOUD on an unknown datasetId', () => {
    const c = validCanvas()
    ;(c.series as Array<Record<string, unknown>>)[0].datasetId = 'nope'
    const errs = validateCanvasOption(c, catalog)
    expect(errs[0].message).toMatch(/unknown datasetId "nope"/)
  })

  it('fails LOUD on an encode column absent from the dataset', () => {
    const c = validCanvas()
    ;((c.series as Array<Record<string, unknown>>)[0].encode as Record<string, unknown>).valueKey = 'not_a_column'
    const errs = validateCanvasOption(c, catalog)
    expect(errs[0].message).toMatch(/"not_a_column" which is not a value column/)
  })
})

// ITEM-1 (regression): the LOUD canvas validation is now WIRED at PARSE (`parseViewSpec`), not
// swallowed at drive-time — a malformed `canvas` block fails the parse. The catalog-free register
// path uses a permissive catalog so structural/registry errors (unknown series.type / coordId /
// datasetId) still fail LOUD here, while a valid block parses clean.
describe('parseViewSpec canvas validation AT PARSE (ITEM-1)', () => {
  function specWithCanvas(canvas: Record<string, unknown>) {
    return { ...(baseSpec() as unknown as Record<string, unknown>), canvas }
  }
  function validCanvas(): Record<string, unknown> {
    return {
      dataset: { id: 'rowmeta' },
      grid: [{ id: 'c1' }],
      series: [{ id: 'v', type: 'violin', coordId: 'c1', encode: { groupKey: 'group', valueKey: 'score' } }],
    }
  }

  it('accepts a valid canvas block (catalog-free permissive path)', () => {
    const r = parseViewSpec(specWithCanvas(validCanvas()))
    expect(r.ok).toBe(true)
  })

  it('rejects an unknown series.type at parse (LOUD, not swallowed at drive-time)', () => {
    const c = validCanvas()
    ;(c.series as Array<Record<string, unknown>>)[0].type = 'boguschart'
    const r = parseViewSpec(specWithCanvas(c))
    expect(r.ok).toBe(false)
    expect(r.errors?.some(e => /unregistered type "boguschart"/.test(e.message))).toBe(true)
  })

  it('rejects a dangling coordId at parse', () => {
    const c = validCanvas()
    ;(c.series as Array<Record<string, unknown>>)[0].coordId = 'nope'
    const r = parseViewSpec(specWithCanvas(c))
    expect(r.ok).toBe(false)
    expect(r.errors?.some(e => /unknown coordId "nope"/.test(e.message))).toBe(true)
  })

  it('rejects an unknown datasetId at parse', () => {
    const c = validCanvas()
    ;(c.series as Array<Record<string, unknown>>)[0].datasetId = 'nope'
    const r = parseViewSpec(specWithCanvas(c))
    expect(r.ok).toBe(false)
    expect(r.errors?.some(e => /unknown datasetId "nope"/.test(e.message))).toBe(true)
  })
})

// `run_processor.inputs_from` — validated AT PARSE, because a malformed binding here is the
// most invisible failure the effect vocabulary has. The launch still proceeds; the slot it
// should have bound is simply absent; and a compute for which that input is optional (every
// `column:<name>` is 0..N by construction) reports success over a filter that constrained
// nothing. A per-launch throw would be discovered by a user, not by the build.
describe('parseViewSpec — run_processor.inputs_from', () => {
  const withRun = (run_processor: unknown): ViewSpec => {
    const s = baseSpec()
    s.actions = [
      ...s.actions,
      {
        id: 'demo.run',
        title: 'Run',
        permission: 'studies::use',
        params: {},
        body: [{ run_processor } as never],
      },
    ]
    return s
  }

  it('accepts a well-formed binding list', () => {
    const res = parseViewSpec(
      withRun({
        id: 'p.one',
        inputs: { expression: '$state.threshold' },
        inputs_from: [
          { for_each: '$const.criteria as $c', when: '$c', slot: 'column:{$c}', artifact: '$data.rowmeta' },
        ],
      }),
    )
    expect(res.errors ?? []).toEqual([])
    expect(res.ok).toBe(true)
  })

  it('REJECTS a binding with no slot', () => {
    const res = parseViewSpec(withRun({ id: 'p.one', inputs_from: [{ artifact: '$data.rowmeta' }] }))
    expect(res.ok).toBe(false)
    expect(res.errors?.some(e => /non-empty "slot"/.test(e.message))).toBe(true)
  })

  it('REJECTS a binding with no artifact reference', () => {
    const res = parseViewSpec(withRun({ id: 'p.one', inputs_from: [{ slot: 'column:x' }] }))
    expect(res.ok).toBe(false)
    expect(res.errors?.some(e => /non-empty "artifact"/.test(e.message))).toBe(true)
  })

  it('REJECTS a non-array inputs_from', () => {
    const res = parseViewSpec(withRun({ id: 'p.one', inputs_from: { slot: 'x', artifact: '$state.threshold' } }))
    expect(res.ok).toBe(false)
    expect(res.errors?.some(e => /must be an array of input bindings/.test(e.message))).toBe(true)
  })

  it('still catches a DANGLING $-ref inside a binding (the refs walk reaches it)', () => {
    const res = parseViewSpec(
      withRun({ id: 'p.one', inputs_from: [{ slot: 'x', artifact: '$data.nosuchslice' }] }),
    )
    expect(res.ok).toBe(false)
    expect(res.errors?.some(e => /nosuchslice/.test(e.message))).toBe(true)
  })
})

describe('parseViewSpec — a check that lands on ONE ROW of a table (`at.part`)', () => {
  const withTable = (at: unknown): ViewSpec => {
    const s = baseSpec()
    s.widgets = [
      ...s.widgets,
      {
        id: 'rows',
        kind: 'table',
        rows: '$state.ranges',
        // A DEPENDENT binding, so INV-5 (ITEM-63) requires the emptiness be stated. Not this
        // block's subject — declared so the fixture is a spec the validator would accept.
        empty_text: 'No ranges yet.',
        columns: [
          { key: 'lo', title: 'Lo', value: '$row.lo' },
          { key: 'hi', title: 'Hi', value: '$row.hi' },
        ],
      } as never,
    ]
    s.checks = [{ id: 'c', fails_when: '$state.threshold', at, message: 'no' } as never]
    return s
  }

  it('accepts a part naming a DECLARED column of that table', () => {
    const res = parseViewSpec(withTable({ widget: 'rows', part: 'hi', index: '$i' }))
    expect(res.errors ?? []).toEqual([])
    expect(res.ok).toBe(true)
  })

  it('REJECTS a part naming no column — a message with nowhere to land is not a message', () => {
    // The same fail-closed posture `at.widget` already takes, and for the same reason: a part
    // key that matches no column produces a verdict no control ever reads, so the run is
    // refused and nothing on screen says why.
    const res = parseViewSpec(withTable({ widget: 'rows', part: 'nope' }))
    expect(res.ok).toBe(false)
    expect(res.errors?.some(e => /part/.test(e.message) && /nope/.test(e.message))).toBe(true)
  })

  it('REJECTS a part on a widget that has no columns at all', () => {
    const res = parseViewSpec(withTable({ widget: 'sel', part: 'hi' }))
    expect(res.ok).toBe(false)
    expect(res.errors?.some(e => /part/.test(e.message))).toBe(true)
  })

})

// ── a FOLDED column: several mutually-exclusive controls sharing one column ──────────────────
//
// The fold exists so a grid stops reserving permanent width for a control a row's own `when`
// will never draw. What the validator owes it is what it owes a column: the sub-parts must be
// REACHED (their dispatch targets checked, their `require` validated, their keys addressable by
// a `check`), and the container must not be able to say two things at once.
//
// The reach half is asserted through the SHIPPED validator rather than by inspecting
// `tableRowParts` directly: a flattening that the enumeration performed but the validator did
// not consult would pass a unit test on the enumeration and still let an undeclared dispatch
// target through — which is the failure mode this whole shared-reader arrangement exists for.
describe('parseViewSpec — a FOLDED column’s sub-parts are validated like columns', () => {
  const withFold = (folded: unknown): ViewSpec => {
    const s = baseSpec()
    s.widgets = [
      ...s.widgets,
      {
        id: 'rows',
        kind: 'table',
        rows: '$state.ranges',
        empty_text: 'No ranges yet.', // INV-5 (ITEM-63) — see the note above.
        columns: [folded],
      } as never,
    ]
    return s
  }
  const fold = (...parts: unknown[]): unknown => ({ key: 'bounds', title: 'Bounds', parts })

  it('REJECTS a sub-part whose dispatch target names no declared action', () => {
    const res = parseViewSpec(
      withFold(
        fold(
          { key: 'lo', [ROW_PART_KEY]: { editable_text: { value: '$row.lo', onChange: 'demo.set' } } },
          { key: 'hi', [ROW_PART_KEY]: { editable_text: { value: '$row.hi', onChange: 'demo.nosuch' } } },
        ),
      ),
    )
    expect(res.ok).toBe(false)
    expect(res.errors?.some(e => /demo\.nosuch/.test(e.message))).toBe(true)
    // …and it says WHERE, naming the sub-part's own position rather than only its container.
    expect(res.errors?.some(e => /columns\[0\]\.parts\[1\]/.test(e.path))).toBe(true)
  })

  it('REJECTS a malformed `require` on a sub-part’s primitive', () => {
    const res = parseViewSpec(
      withFold(
        fold({
          key: 'lo',
          [ROW_PART_KEY]: { editable_text: { value: '$row.lo', onChange: 'demo.set', require: { min_item: 2 } } },
        }),
      ),
    )
    expect(res.ok).toBe(false)
    expect(res.errors?.some(e => /unknown require key "min_item"/.test(e.message))).toBe(true)
  })

  it('REFUSES a container that ALSO declares its own primitive — the primitive would vanish', () => {
    // `tableRowParts` descends through a container, which is right for every reader that wants
    // the controls and is exactly why this cannot be left to it: the container's own primitive
    // is silently not returned, so without this rule it renders nowhere and reports nothing.
    const res = parseViewSpec(
      withFold({
        key: 'bounds',
        [ROW_PART_KEY]: { editable_text: { value: '$row.lo', onChange: 'demo.set' } },
        parts: [{ key: 'hi', [ROW_PART_KEY]: { editable_text: { value: '$row.hi', onChange: 'demo.set' } } }],
      }),
    )
    expect(res.ok).toBe(false)
    expect(res.errors?.some(e => /never both/.test(e.message))).toBe(true)
  })

  it('REFUSES a fold that is also a repetition, and an empty one', () => {
    const repeated = parseViewSpec(
      withFold({
        key: 'bounds',
        for_each: '$state.ranges as $r',
        parts: [{ key: 'hi', [ROW_PART_KEY]: { editable_text: { value: '$row.hi', onChange: 'demo.set' } } }],
      }),
    )
    expect(repeated.ok).toBe(false)
    expect(repeated.errors?.some(e => /for_each/.test(e.path))).toBe(true)

    const empty = parseViewSpec(withFold({ key: 'bounds', parts: [] }))
    expect(empty.ok).toBe(false)
    expect(empty.errors?.some(e => /non-empty/.test(e.message))).toBe(true)
  })

  it('lets a `check` land on a SUB-PART’s key, exactly as on a column’s', () => {
    // The fold's whole claim is that it changes where a control is DRAWN and not what it is
    // CALLED. A verdict address that stopped working under the fold would break that claim in
    // the one place it is load-bearing: a cross-field relation between two folded bounds.
    const s = withFold(
      fold({ key: 'hi', [ROW_PART_KEY]: { editable_text: { value: '$row.hi', onChange: 'demo.set' } } }),
    )
    s.checks = [
      { id: 'c', fails_when: '$state.threshold', at: { widget: 'rows', part: 'hi' }, message: 'no' } as never,
    ]
    const res = parseViewSpec(s)
    expect(res.errors ?? []).toEqual([])
    expect(res.ok).toBe(true)

    // NEGATIVE CONTROL: the CONTAINER's own key is not an address — it holds no control, so a
    // verdict filed there would be read by nothing.
    const atContainer = withFold(
      fold({ key: 'hi', [ROW_PART_KEY]: { editable_text: { value: '$row.hi', onChange: 'demo.set' } } }),
    )
    atContainer.checks = [
      { id: 'c', fails_when: '$state.threshold', at: { widget: 'rows', part: 'bounds' }, message: 'no' } as never,
    ]
    expect(parseViewSpec(atContainer).ok).toBe(false)
  })
})

describe('parseViewSpec — a folded sub-part must be NAMED', () => {
  it('REFUSES an unnamed sub-part — an unaddressable control is not a folded one', () => {
    // The fold's claim is that it moves where a control is DRAWN and not what it is CALLED.
    // An unnamed sub-part falls back to a POSITION it shares with the columns beside it, so two
    // controls can answer to one test id and one accessible name — and the claim quietly stops
    // being true in the only place anyone would notice.
    const s = baseSpec()
    s.widgets = [
      ...s.widgets,
      {
        id: 'rows',
        kind: 'table',
        rows: '$state.ranges',
        // A DEPENDENT binding, so INV-5 (ITEM-63) requires the emptiness be stated. Not this
        // block's subject — declared so the fixture is a spec the validator would accept.
        empty_text: 'No ranges yet.',
        columns: [
          {
            key: 'bounds',
            title: 'Bounds',
            parts: [{ [ROW_PART_KEY]: { editable_text: { value: '$row.lo', onChange: 'demo.set' } } }],
          },
        ],
      } as never,
    ]
    const res = parseViewSpec(s)
    expect(res.ok).toBe(false)
    expect(res.errors?.some(e => /non-empty "key"/.test(e.message))).toBe(true)
  })
})

// ── TEST-36 + TEST-A2 (ITEM-28, R1 / INV-2) — `""` is not an unset ──────────────────
//
// `StateFieldSpec.default` is `unknown` and `type` is enforced NOWHERE (`store.ts::initField`
// only resolves `$`-leaves and never reads `field.type`), so every shipped spec used `""` as its
// unset sentinel — and it only BEHAVED as unset two layers away, in `ClosedSetSelect`'s
// `value == null || String(value) === ''` and in the canvas binding's empty-encode rule. Two
// spellings of one state is how they drift: the moment one layer reads `""` as a chosen member
// of the set, the form shows a selection nobody made and the run receives it.
//
// The refusal is SCOPED, and the scoping is half the item. INV-2's own second sentence is
// *"`\"\"` is a chosen empty string"* — so this may not become "`\"\"` anywhere". It bites only
// where the empty string cannot have been offered: a closed set.
function closedSetSpec(over: {
  kind?: string
  value?: unknown
  state?: Record<string, unknown>
}): unknown {
  return {
    id: 'demo/spec',
    title: 'T',
    permission: 'studies::use',
    state: over.state ?? { pick: { type: 'string', default: '' } },
    widgets: [
      { id: 'w', kind: over.kind ?? 'select', options: '$const.opts', value: over.value ?? '$state.pick' },
    ],
    const: { opts: ['a'] },
    actions: [],
  }
}

const errorsOf = (spec: unknown): Array<{ path: string; message: string }> => {
  const res = parseViewSpec(spec)
  return res.ok ? [] : (res.errors ?? [])
}

describe('R1 / INV-2 — a closed-set default may not be the empty string (ITEM-28)', () => {
  for (const kind of ['select', 'artifact_ref']) {
    it(`REFUSES "" as the default of a field bound to a "${kind}", NAMING the field`, () => {
      const errs = errorsOf(closedSetSpec({ kind }))
      const hit = errs.find(e => e.path === '$.state.pick.default')
      expect(hit, JSON.stringify(errs)).toBeDefined()
      // The field is named IN the message too, not only in the path: an author reading a
      // parse-error list scans messages, and "some field defaults to ''" is not actionable.
      expect(hit!.message).toContain('"pick"')
      expect(hit!.message).toContain(kind)
    })
  }

  it('accepts `null` — the one unset', () => {
    expect(parseViewSpec(closedSetSpec({ state: { pick: { type: 'string', default: null } } })).ok).toBe(true)
  })

  it('accepts a field with NO default at all', () => {
    expect(parseViewSpec(closedSetSpec({ state: { pick: { type: 'string' } } })).ok).toBe(true)
  })

  it('does NOT refuse `[]` — a multi `artifact_ref`’s unset is the empty LIST', () => {
    const spec = closedSetSpec({ kind: 'artifact_ref', state: { pick: { type: 'list', default: [] } } })
    expect(parseViewSpec(spec).ok).toBe(true)
  })

  it('does NOT refuse `""` on an OPEN control — a text box legitimately starts empty', () => {
    // The scoping half. Without this the rule would refuse every free-text field in the repo,
    // and INV-2's second sentence would be false.
    const spec = {
      id: 'demo/spec',
      title: 'T',
      permission: 'studies::use',
      state: { note: { type: 'string', default: '' } },
      widgets: [{ id: 'w', kind: 'text', value: '$state.note' }],
      const: {},
      actions: [],
    }
    expect(parseViewSpec(spec).ok).toBe(true)
  })

  it('does NOT refuse a deliberate NON-EMPTY default on a closed set', () => {
    // A shipped spec defaults a closed-set field to a real word; that is a chosen value, not a
    // sentinel. Refusing every default would be a different (and wrong) rule.
    const spec = closedSetSpec({ state: { pick: { type: 'string', default: 'keep' } } })
    expect(parseViewSpec(spec).ok).toBe(true)
  })

  it('does not complain about a field the widget does not bind', () => {
    const spec = closedSetSpec({
      value: '$state.other',
      state: { pick: { type: 'string', default: '' }, other: { type: 'string', default: null } },
    })
    // `pick` still defaults to "" but nothing closed-set is bound to it, so it is not this
    // rule's business — a rule that fired on the whole `state` block would be the global
    // version this one is deliberately not.
    expect(errorsOf(spec).some(e => e.path.startsWith('$.state.pick'))).toBe(false)
  })

  it('reaches a control nested inside a `group`', () => {
    const spec = {
      id: 'demo/spec',
      title: 'T',
      permission: 'studies::use',
      state: { pick: { type: 'string', default: '' } },
      widgets: [
        { kind: 'group', label: 'G', children: [{ id: 'w', kind: 'select', options: '$const.o', value: '$state.pick' }] },
      ],
      const: { o: ['a'] },
      actions: [],
    }
    expect(errorsOf(spec).some(e => e.path === '$.state.pick.default')).toBe(true)
  })
})

// ── TEST-A5 (ITEM-63 / ITEM-23) [acceptance] [invariant: INV-5] ─────────────────────
//
// INV-5: the view cannot observe candidate availability, so a control whose candidates
// DEPEND on another choice must declare what its emptiness means — and `parseViewSpec`
// REQUIRES it rather than letting the engine invent a sentence.
//
// Why a parse refusal and not a render default: "No options" is simultaneously true of a
// project where nothing produced them, a row space nobody anchored, and an integrated space whose
// contributors' columns were never merged. Three situations, three remedies, one useless
// sentence — and only the author, in advance, can tell them apart (ITEM-63).
//
// The SCOPING is asserted as hard as the rule. A fixed `$const` list has an emptiness the
// engine can describe, and demanding a sentence there would be a different, noisier rule
// that every shipped spec would have to answer for.
describe('INV-5 — a DEPENDENT candidate binding must declare `empty_text` (ITEM-63)', () => {
  const spec = (widgets: unknown[], data?: Record<string, unknown>): unknown => ({
    id: 'demo/spec',
    title: 'T',
    permission: 'studies::use',
    state: { anchor: { type: 'string', default: null }, pick: { type: 'string', default: null } },
    ...(data ? { data } : {}),
    const: { fixed: ['a', 'b'] },
    widgets,
    actions: [],
  })
  const emptyTextErrors = (s: unknown): string[] =>
    (parseViewSpec(s).errors ?? []).filter(e => e.path.endsWith('.empty_text')).map(e => e.message)

  it('REFUSES a control whose `source` depends on ANOTHER CONTROL and states no emptiness', () => {
    const errs = emptyTextErrors(
      spec([{ id: 'coord', kind: 'artifact_ref', source: { of: '$state.anchor', datatype: 'demo/col' } }]),
    )
    expect(errs.length, JSON.stringify(errs)).toBe(1)
    // The control is NAMED: an author reading a parse-error list needs to know which one.
    expect(errs[0]).toContain('"coord"')
  })

  it('REFUSES a control whose candidates depend on `$scope.axis` THROUGH a data slice', () => {
    // The shape every shipped dependent control actually has: the widget binds `$data.<slice>`
    // and it is the SLICE whose args name the anchor. A rule reading only the widget's own
    // text would see none of them.
    const errs = emptyTextErrors(
      spec(
        [{ id: 'cols', kind: 'table', rows: '$data.categorical.columns' }],
        { categorical: { source: 'row_space_columns', args: { aligned_to: '$scope.axis' } } },
      ),
    )
    expect(errs.length, JSON.stringify(errs)).toBe(1)
    expect(errs[0]).toContain('"cols"')
  })

  it('ACCEPTS the same control once it declares the sentence', () => {
    expect(
      emptyTextErrors(
        spec([
          {
            id: 'coord',
            kind: 'artifact_ref',
            source: { of: '$state.anchor', datatype: 'demo/col' },
            empty_text: 'No coordinates in this project yet.',
          },
        ]),
      ),
    ).toEqual([])
  })

  it('does NOT accept a blank sentence — an empty string states nothing', () => {
    expect(
      emptyTextErrors(
        spec([
          { id: 'coord', kind: 'artifact_ref', source: { of: '$state.anchor' }, empty_text: '   ' },
        ]),
      ),
    ).toHaveLength(1)
  })

  it('does NOT require it of an INDEPENDENT binding (the scoping half)', () => {
    // A fixed list's emptiness does not vary with a choice nobody has made, so the engine
    // can describe it. Without this clause the rule would fire on every `$const` select in
    // the repo and INV-5 would be a different claim.
    expect(emptyTextErrors(spec([{ id: 'w', kind: 'select', options: '$const.fixed' }]))).toEqual([])
    expect(
      emptyTextErrors(
        spec([{ id: 'w', kind: 'artifact_ref', source: { datatype: 'demo/col' } }]),
      ),
    ).toEqual([])
  })

  it('reaches a dependent control nested inside a `group`', () => {
    const errs = emptyTextErrors(
      spec([
        {
          kind: 'group',
          label: 'G',
          children: [{ id: 'inner', kind: 'artifact_ref', source: { of: '$state.anchor' } }],
        },
      ]),
    )
    expect(errs.length, JSON.stringify(errs)).toBe(1)
    expect(errs[0]).toContain('"inner"')
  })
})

// TEST-35 (ITEM-27) + the parse half of the acceptance pin TEST-A19 (INV-19) — what a
// consumer does with an entry's N columns is DECLARED, and a declaration that leaves it
// undecided is REFUSED rather than resolved by taking the first.
describe('entry dispositions (ITEM-27 / INV-19)', () => {
  const errorsAt = (spec: unknown, prefix: string): string[] => {
    const res = parseViewSpec(spec)
    return (res.errors ?? []).filter(e => e.path.startsWith(prefix)).map(e => e.message)
  }

  function entrySpec(over: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 'demo/spec',
      title: 'T',
      permission: 'studies::use',
      state: { chosen: { type: 'list', default: [] } },
      data: { chosen: { source: 'axis_entry_values', args: { axis: 'entries' } } },
      widgets: [
        {
          id: 'entries',
          kind: 'entry_list',
          entries: '$data.offered',
          value: '$state.chosen',
          disposition: 'each',
        },
      ],
      const: {},
      actions: [],
      ...over,
    }
  }

  it('REFUSES an entry_list that declares no disposition', () => {
    const spec = entrySpec({
      widgets: [{ id: 'entries', kind: 'entry_list', entries: '$data.offered', value: '$state.chosen' }],
    })
    expect(errorsAt(spec, '$.widgets[0].disposition')).toHaveLength(1)
  })

  it('accepts each / combined / one, and refuses anything else', () => {
    for (const disposition of ['each', 'combined', 'one']) {
      const spec = entrySpec({
        widgets: [{ id: 'e', kind: 'entry_list', entries: '$data.offered', value: '$state.chosen', disposition }],
      })
      expect(errorsAt(spec, '$.widgets[0].disposition')).toEqual([])
    }
    const bad = entrySpec({
      widgets: [{ id: 'e', kind: 'entry_list', entries: '$data.offered', value: '$state.chosen', disposition: 'first' }],
    })
    expect(errorsAt(bad, '$.widgets[0].disposition')).toHaveLength(1)
  })

  it('REFUSES a many-valued entry slice bound into a single-valued channel with neither for_each nor where', () => {
    const spec = entrySpec({
      canvas: {
        datasets: [{ id: 'base' }],
        series: [{ id: 's', type: 'scatter', coordId: 'c', datasetId: 'base', encode: { colorBy: '$data.chosen' } }],
      },
    })
    const errs = errorsAt(spec, '$.canvas.series[0].encode.colorBy')
    expect(errs).toHaveLength(1)
    expect(errs[0]).toContain('for_each')
    expect(errs[0]).toContain('where')
  })

  it('accepts the SAME binding under a for_each — how `each` and `combined` both lower', () => {
    const spec = entrySpec({
      canvas: {
        datasets: [{ id: 'base' }],
        series: [
          {
            id: 's',
            for_each: '$state.chosen as $e',
            type: 'scatter',
            coordId: 'c-$e',
            datasetId: 'base',
            encode: { colorBy: '$data.chosen' },
          },
        ],
      },
    })
    expect(errorsAt(spec, '$.canvas.series[0]')).toEqual([])
  })

  it('accepts a channel narrowed by `where` — how `one` lowers', () => {
    const spec = entrySpec({
      canvas: {
        datasets: [{ id: 'base' }],
        series: [
          {
            id: 's',
            type: 'scatter',
            coordId: 'c',
            datasetId: 'base',
            encode: { colorBy: { entry: '$data.chosen', where: { datatype: 'demo/matrix' } } },
          },
        ],
      },
    })
    expect(errorsAt(spec, '$.canvas.series[0]')).toEqual([])
  })

  it('says nothing about a channel that has already NARROWED into the slice', () => {
    // `$data.chosen[$s.name]` is one column, not the map — the refused shape is the bare root.
    const spec = entrySpec({
      canvas: {
        datasets: [{ id: 'base' }],
        series: [{ id: 's', type: 'scatter', coordId: 'c', datasetId: 'base', encode: { colorBy: '$data.chosen[$s.name]' } }],
      },
    })
    expect(errorsAt(spec, '$.canvas.series[0]')).toEqual([])
  })

  it('says nothing about a slice that is NOT an entry-values source (the negative control)', () => {
    const spec = entrySpec({
      data: { chosen: { source: 'job.result', args: { path: '/x' } } },
      canvas: {
        datasets: [{ id: 'base' }],
        series: [{ id: 's', type: 'scatter', coordId: 'c', datasetId: 'base', encode: { colorBy: '$data.chosen' } }],
      },
    })
    expect(errorsAt(spec, '$.canvas.series[0]')).toEqual([])
  })
})

// ── INV-13 / ITEM-11: a field may join the PANE's state, and that set is CLOSED ───────────────
//
// The store enumerates the pane's values and a unit test pins that enumeration — which is only
// half a guard once a SPEC can opt a field in: a package could otherwise mint a third shared
// value simply by declaring one, and the enumeration would never see it. So the refusal is at
// PARSE, fail-closed, on the author's own file.
describe('pane-scoped state fields (ITEM-11 / INV-13)', () => {
  const withState = (state: Record<string, unknown>): ViewSpec =>
    ({ ...baseSpec(), state, widgets: [], data: undefined, derived: undefined, canvas: undefined }) as ViewSpec

  it('accepts `scope: pane` on a name the pane actually holds', () => {
    const r = parseViewSpec(withState({ coordinate: { type: 'string', default: null, scope: 'pane' } }))
    expect(r.ok).toBe(true)
  })

  it('REFUSES `scope: pane` on any other name, and names the field', () => {
    // `colorBy` is the specific one the design removed — *"there is no such fact"* — so a spec
    // reintroducing it as a shared value has to argue with this.
    const r = parseViewSpec(withState({ colorBy: { type: 'string', default: null, scope: 'pane' } }))
    expect(r.ok).toBe(false)
    expect(r.errors?.some(e => e.path === '$.state.colorBy.scope' && e.message.includes('colorBy'))).toBe(true)
  })

  it('REFUSES a scope value that is not `pane`', () => {
    const r = parseViewSpec(withState({ coordinate: { type: 'string', default: null, scope: 'section' } }))
    expect(r.ok).toBe(false)
    expect(r.errors?.some(e => e.path === '$.state.coordinate.scope')).toBe(true)
  })

  it('leaves an ORDINARY field alone — the negative control', () => {
    // A section's OWN value named after a pane value is legitimate and must not be caught: the
    // rule is about `scope: pane`, not about the name.
    const r = parseViewSpec(withState({ coordinate: { type: 'string', default: null } }))
    expect(r.ok).toBe(true)
  })
})

// ── the pin `schema.ts` claims (and, until this test, did not have) ────────────────────
//
// `core/spec` is the dependency-free parser, so it SPELLS the `axis_entry_values` source name
// rather than importing it from `core/runtime`. That duplication is deliberate and it is only
// safe while something proves the two spellings are the same string: without it, renaming the
// runtime constant leaves the parser matching a source nothing declares any more, and the
// entry-values binding refusal — a PARSE-time gate — silently stops firing. Nothing about that
// failure is visible: specs keep parsing, they just stop being checked.
//
// It imports both on purpose. `importCycles.test.ts` walks production files only (it skips
// `*.test.ts`), so the pin buys the guarantee without buying the edge.
//
// RED ON REVERT: change either constant and this fails, naming both values.
describe('the entry-values source name is single-valued across the parser/runtime split', () => {
  it('the two spellings are EQUAL', () => {
    expect(AXIS_ENTRY_VALUES_SOURCE_NAME).toBe(AXIS_ENTRY_VALUES_SOURCE)
  })

  it('and the parser really DISPATCHES on it — not merely holds it', () => {
    // Two constants can agree on a typo, so the pin above is only worth having if the value is
    // also the one the parser ACTS on. It is asserted through behaviour rather than by
    // re-spelling the literal a third time (which is what the pinned comment calls a tautology,
    // and what an earlier draft of this test did): a canvas channel bound to a slice DECLARED
    // with this source, with neither a series `for_each` nor a channel `where`, is the binding
    // the rule refuses — and it refuses it BY MATCHING THE SOURCE NAME.
    //
    // No shipped spec declares `axis_entry_values` today (the entry section resolves through
    // `axis_entry_rows`), so a "read the shipped specs" floor would be vacuous by construction.
    // The refusal itself is the floor.
    const bind = (source: string) => ({
      id: 'demo/spec',
      title: 'T',
      permission: 'p',
      state: {},
      data: { vals: { source, args: {} } },
      widgets: [],
      actions: [],
      canvas: {
        datasets: [{ id: 'vals' }],
        grid: [{ id: 'p', region: { row: 0, col: 0 } }],
        series: [
          { id: 's', type: 'scatter', coordId: 'p', datasetId: 'vals', encode: { valueKey: '$data.vals' } },
        ],
      },
    })
    const refused = parseViewSpec(bind(AXIS_ENTRY_VALUES_SOURCE))
    expect(refused.ok, 'a many-valued entry source bound to a single-valued channel must be refused').toBe(false)

    // NEGATIVE CONTROL: the identical spec with any OTHER source name parses. So the refusal
    // above is keyed on THIS string, and changing the constant would silently disable it —
    // which is precisely what the pin exists to prevent.
    expect(parseViewSpec(bind('some_other_source')).ok).toBe(true)
  })
})
