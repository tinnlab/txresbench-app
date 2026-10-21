// TEST-9 (ITEM-9 / ITEM-17 / ITEM-27, DEC-14/18/25/27) — the Cell-filter declarative surface as
// DATA. Loads the SHIPPED `packages/cell-filter/ui/cell-filter.yaml` + `manifest.yaml` and
// asserts:
//   (1) the view_spec parses through the SAME `parseViewSpec` as any declared view (incl. the
//       DYNAMIC `for_each` before/after `canvas` block — LOUD-clean);
//   (2) `state.criteria` is an EMPTY list; `cf.addCriterion`/`cf.removeCriterion`/
//       `cf.setCriterionField` mutate it through the REAL interpreter (`listAppend`/`listRemove`/
//       `set`) — NO bespoke `cell-filter-criteria` widget KIND (INV-6);
//   (3) the criteria rows + before/after plots are a `for_each: $state.criteria` guarded so an
//       empty-column criterion does NOT plot (`when: controlByColumn[$c.column] == …`); the
//       control-type FOLLOWS the column type (continuous → range, categorical → multiselect,
//       DEC-18);
//   (4) the combined keep-mask is the `keep_mask` `$derived` (AND over criteria, DEC-27 joint
//       drop); the before/after cells are `controlled: true` and close to `cf.removeCriterion`
//       (ITEM-17 reopen guard);
//   (5) Run bridges to the compute job via `run_processor(cell.filter) → wait_for` (ITEM-9).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { parseViewSpec, tableRowParts, tableRowPrimitives } from '@/modules/workbench/core/spec/schema'
import { createViewStore } from './store'
import { interpretBody, type InterpreterCtx, type InterpreterStore } from './interpreter'
import { evalWhen, type Scope } from './expr'
import { evaluateForm } from '@/modules/workbench/core/form/validity'
import { createCapabilityBroker, type WorkbenchAPI } from '@/modules/workbench/core'
import type { DataApi } from '@/modules/workbench/extensions/data/contract'
import { resolveViewData, readSliceFromApi } from './viewData'

const CF_UI = fileURLToPath(new URL('../../../../../../packages/cell-filter/ui/cell-filter.yaml', import.meta.url))
const CF_MANIFEST = fileURLToPath(new URL('../../../../../../packages/cell-filter/manifest.yaml', import.meta.url))

const rawView = parseYaml(readFileSync(CF_UI, 'utf8'))
const manifest = parseYaml(readFileSync(CF_MANIFEST, 'utf8')) as {
  id: string
  contributes: { analyses: Array<Record<string, unknown>> }
}

// A live-ish mock store (mirrors qcSurface.test.ts) — dotted `set` writes into a plain object.
function setIn(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (typeof cur[k] !== 'object' || cur[k] == null) cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}
function liveMockStore(initial: Record<string, unknown> = {}): InterpreterStore {
  let s: Record<string, unknown> = { ...initial }
  return {
    get state() {
      return s
    },
    derived: {},
    token: 'cf@0',
    set(field, value) {
      const next = { ...s }
      setIn(next, field, value)
      s = next
    },
  }
}
function makeCtx(over: Partial<InterpreterCtx> = {}): InterpreterCtx {
  return {
    navigate: () => {},
    progress: () => {},
    log: () => {},
    instance: () => undefined,
    instances: () => [],
    stores: { instance: () => undefined, instances: () => [] },
    ...over,
  } as InterpreterCtx
}

type Criterion = { column?: string; control?: string; min?: unknown; max?: unknown; keep?: unknown[] }
type TableColumn = { key?: string; title?: string }
type Series = { id: string; for_each?: string; when?: string; type: string; coordId: string; controlled?: boolean; close?: { action: string } }

describe('Cell-filter declarative surface (ITEM-9 / ITEM-17 / ITEM-27)', () => {
  it('parses the shipped cell-filter.yaml through the general parseViewSpec (LOUD-clean, incl. the dynamic for_each canvas)', () => {
    const res = parseViewSpec(rawView)
    expect(res.errors ?? []).toEqual([])
    expect(res.ok).toBe(true)
  })

  const spec = parseViewSpec(rawView).value as ViewSpec

  /** The shipped criteria builder — read off the spec rather than restated, so a renamed
   *  widget moves every assertion below with it instead of leaving them asserting a shape
   *  nothing renders. */
  const criteriaTable = (): { kind: string; rows?: string; columns?: TableColumn[]; row_detail?: TableColumn } =>
    spec.widgets.find(w => w.id === 'criteriaTable') as unknown as {
      kind: string
      rows?: string
      columns?: TableColumn[]
      /** Read only to assert it is ABSENT — the criteria row carries no band under it. */
      row_detail?: TableColumn
    }
  const columnKeys = (): string[] => (criteriaTable().columns ?? []).map(c => String(c.key))
  /** Every ROW-SCOPED part the builder declares — its columns AND its detail band — through the
   *  ONE enumeration the validator, the form-validity pre-pass and the conformance tier all
   *  read. Spelling it `.columns` here is how this tier would come to assert a shape that no
   *  longer covers everything the row renders. */
  const rowParts = (): TableColumn[] =>
    tableRowParts(criteriaTable()).map(c => c.decl as TableColumn)
  /** Which per-row PRIMITIVE each row-scoped part declares — through the ONE enumeration the
   *  validator and the form-validity pre-pass both read, so this tier cannot come to disagree
   *  with them about what a per-row primitive is. One part, one primitive: a part declaring two
   *  would render one of them and silently drop the other. */
  const primitiveKeys = (): Record<string, string[]> =>
    Object.fromEntries(
      rowParts().map(c => [String(c.key), tableRowPrimitives(c).map(p => p.primitive)]),
    )
  /** The per-row primitive DECLARATION of one row-scoped part. */
  const primitiveOf = (key: string): Record<string, string | undefined> => {
    const col = rowParts().find(c => String(c.key) === key)
    expect(col, `the criteria table declares no "${key}" part`).toBeTruthy()
    const found = tableRowPrimitives(col)
    expect(found, `the "${key}" part declares no per-row primitive`).toHaveLength(1)
    return found[0].decl as Record<string, string | undefined>
  }

  it('reuses an EXISTING real permission — no new gate (DEC-2)', () => {
    expect(spec.permission).toBe('jobs::use')
    for (const a of spec.actions) expect(a.permission).toBe('jobs::use')
  })

  it('holds state.criteria as an EMPTY list (user-built; DEC-25)', () => {
    expect(spec.state.criteria?.type).toBe('list')
    expect(spec.state.criteria?.default).toEqual([])
  })

  it('composes the criteria builder from GENERIC widget kinds — NO bespoke cell-filter-criteria kind (INV-6)', () => {
    for (const w of spec.widgets) {
      expect(w.kind).not.toBe('cell-filter-criteria')
      expect(w.kind).not.toBe('criterionRow')
    }
    // REPORTED: the criteria are a TABLE, the same generic primitive the metric editor uses —
    // one row per criterion, one column per field, so two thresholds can be compared by
    // reading down a column instead of across two stacked cards.
    expect(criteriaTable().kind).toBe('table')
    expect(criteriaTable().rows).toBe('$state.criteria')
    expect(columnKeys()).toEqual(['column', 'constraint', 'remove'])
  })

  // The MUTUALLY EXCLUSIVE controls share ONE column, and that is a WIDTH decision with a
  // correctness precondition: a row's column is either continuous or categorical, so bounds and
  // a keep-set can never both be drawn on one row — three columns therefore reserved permanent
  // width for a control the row could not use, and the grid was wider than the pane it lives in.
  //
  // Asserted as a PAIR, because either half alone is satisfiable by a mistake: that the folded
  // column holds exactly those three parts, and that they are STILL row-scoped parts under the
  // shared enumeration (which is what keeps their verdict addresses, their testids and their
  // per-row gates identical to when they were columns).
  it('the mutually exclusive bound / keep-set controls FOLD into one column', () => {
    const folded = (criteriaTable().columns ?? []).find(c => String(c.key) === 'constraint')
    expect(folded, 'the criteria table declares no folded constraint column').toBeTruthy()
    const subs = (folded as { parts?: Array<{ key?: string }> }).parts ?? []
    expect(subs.map(p => String(p.key))).toEqual(['min', 'max', 'keep'])
    // One heading over both readings — a heading naming one branch is wrong on every row of the
    // other, so the fold cannot keep "Min"/"Max"/"Keep".
    expect(String((folded as { title?: string }).title ?? '')).not.toBe('')
    // …and they are reached by the enumeration every reader shares, so nothing that walked them
    // as columns stopped seeing them.
    for (const key of ['min', 'max', 'keep']) {
      expect(
        rowParts().map(c => String(c.key)),
        `the folded "${key}" part is unreachable through tableRowParts`,
      ).toContain(key)
    }
  })

  // The row's destructive action is an ICON, which is the idiom for a per-row action in a dense
  // grid — and the SECOND half of the width fix (measured on this surface, a 95px text button
  // in a 268px form column; 32px as an icon). The label is kept, because it is what names the
  // control to anyone not looking at the screen.
  it('the row action is an icon with the label kept as its accessible name', () => {
    const action = primitiveOf('remove')
    expect(action.icon, 'the row action draws no icon — it is back to a full-width text button').toBeTruthy()
    expect(action.label, 'an icon-only action with no label has no accessible name at all').toBeTruthy()
  })

  // REPORTED, third and last reading of the same report, reversing the second: there is no
  // range control under the row. The bounds are the two numeric inputs and nothing else — ONE
  // hand on one answer.
  //
  // Asserted on the SHARED enumeration rather than on `.row_detail` alone, because the removal
  // has to hold wherever a row-scoped part can be declared: a slider that migrated back into a
  // column, or into a fold, would pass a `row_detail === undefined` check while rendering
  // exactly the control this removes.
  it('the row offers NO range control — neither in a column nor in a band under it', () => {
    expect(
      criteriaTable().row_detail,
      'the criteria table declares a per-row detail band again',
    ).toBeUndefined()
    for (const part of rowParts()) {
      expect(
        tableRowPrimitives(part).map(p => p.primitive),
        `the "${String(part.key)}" part declares a range control`,
      ).not.toContain('range_slider')
    }
    expect(columnKeys()).not.toContain('range')
    // …and the track it spanned is not derived for nobody.
    expect(spec.derived?.extentsByColumn).toBeUndefined()
  })

  it('every criterion field is a GENERIC per-row primitive — no analysis-named widget kind', () => {
    // The per-row vocabulary, in the order the row reads: a closed set for the column, two
    // free-text bounds, a keep-set, a remove.
    expect(primitiveKeys()).toEqual({
      column: ['select'],
      min: ['editable_text'],
      max: ['editable_text'],
      keep: ['multiselect'],
      remove: ['button'],
    })
  })

  it('control-type FOLLOWS the column type via a per-ROW `when` over the columns_of derived (DEC-18)', () => {
    expect((spec.derived?.controlByColumn as { columns_of?: unknown })?.columns_of).toBeTruthy()
    // Both directions are gated, and both matter. A keep-set offered on a numeric column
    // silently RECLASSIFIES the criterion (a non-empty keep list is what makes it categorical),
    // so the bounds stop being applied; bounds offered on a textual column coerce its values to
    // NaN and drop every row.
    expect(primitiveOf('min').when).toBe('$derived.controlByColumn[$row.column] == range')
    expect(primitiveOf('max').when).toBe('$derived.controlByColumn[$row.column] == range')
    expect(primitiveOf('keep').when).toBe('$derived.controlByColumn[$row.column] == multiselect')
  })

  it('declares $derived.keptMask as the combined keep_mask over the criteria (ITEM-9 / DEC-27)', () => {
    const km = spec.derived?.keptMask as { keep_mask?: { criteria: string; obs: string } }
    expect(km.keep_mask?.criteria).toBe('$state.criteria')
    expect(km.keep_mask?.obs).toBe('$data.obs')
  })

  it('emits before/after canvas cells as for_each over $state.criteria, guarded by column pick, controlled + close-bound (ITEM-17)', () => {
    const canvas = spec.canvas as { datasets: Array<{ id: string }>; series: Series[] }
    expect(canvas.datasets.map(d => d.id).sort()).toEqual(['obs', 'obs.kept'])
    const critSeries = canvas.series.filter(s => s.for_each === '$state.criteria as $c, $i')
    // one before + one after per control family (violin / bar) = 4 criterion-derived templates.
    expect(critSeries.length).toBe(4)
    for (const s of critSeries) {
      expect(s.controlled).toBe(true)
      expect(s.close?.action).toBe('cf.removeCriterion')
      // an empty criterion does not plot — every criterion series is column-gated.
      expect(s.when).toMatch(/controlByColumn\[\$c\.column\]/)
    }
    // before over `obs`, after over `obs.kept` (per control family — distinct coordIds so the two
    // when-gated variants never collide at parse; only the matching family emits at runtime).
    const before = critSeries.find(s => s.coordId === 'before-violin-$i')!
    const after = critSeries.find(s => s.coordId === 'after-violin-$i')!
    expect((before as unknown as { datasetId: string }).datasetId).toBe('obs')
    expect((after as unknown as { datasetId: string }).datasetId).toBe('obs.kept')
  })

  it('addCriterion appends a blank criterion via the REAL interpreter (listAppend)', async () => {
    const store = liveMockStore({ criteria: [] })
    const add = spec.actions.find(a => a.id === 'cf.addCriterion')!
    await interpretBody(add.body, { view_id: 'v' }, makeCtx({ viewStore: () => store }))
    const list = store.state.criteria as Criterion[]
    expect(list.length).toBe(1)
    expect(list[0]).toMatchObject({ column: '', control: '', keep: [] })
  })

  it('setCriterionField sets the picked column at the given index via the REAL interpreter (set)', async () => {
    const store = liveMockStore({ criteria: [{ column: '', control: '', min: '', max: '', keep: [] }] })
    const setField = spec.actions.find(a => a.id === 'cf.setCriterionField')!
    await interpretBody(
      setField.body,
      { view_id: 'v', index: 0, key: 'column', value: 'pct_mito' },
      makeCtx({ viewStore: () => store }),
    )
    // The `criteria.0.column` set updates element 0's column…
    expect((store.state.criteria as Criterion[])[0].column).toBe('pct_mito')
    // …WITHOUT clobbering the ARRAY into a `{0:…}` object (the P8 bug: `setIn` replaced the array
    // with a plain object, so `for_each: $state.criteria` rendered nothing and the row vanished)…
    expect(Array.isArray(store.state.criteria), 'criteria stays an array after a `criteria.N.field` set').toBe(true)
    expect((store.state.criteria as Criterion[]).length).toBe(1)
    // …and PRESERVES the criterion's sibling fields (not reset to a bare `{column}`).
    expect((store.state.criteria as Criterion[])[0]).toMatchObject({ column: 'pct_mito', control: '', min: '', max: '', keep: [] })
  })

  it('removeCriterion drops the criterion at the given index (listRemove) — the reopen-guard close target', async () => {
    const store = liveMockStore({ criteria: [{ column: 'a' }, { column: 'b' }] })
    const remove = spec.actions.find(a => a.id === 'cf.removeCriterion')!
    await interpretBody(remove.body, { view_id: 'v', index: 0 }, makeCtx({ viewStore: () => store }))
    expect((store.state.criteria as Criterion[]).map(c => c.column)).toEqual(['b'])
  })

  it('declares a Run that bridges to the compute job via run_processor(cell.filter) → wait_for (ITEM-9)', () => {
    const run = spec.actions.find(a => a.id === 'cf.run')!
    const rp = (run.body as Array<{ run_processor?: { id: string; params: Record<string, unknown> } }>).find(
      e => e.run_processor,
    )!.run_processor!
    expect(rp.id).toBe('cell.filter')
    expect(rp.params).toHaveProperty('criteria')
    expect(rp.params).toHaveProperty('label')
    const ops = (run.body as Array<Record<string, unknown>>).map(e => Object.keys(e)[0])
    expect(ops).toContain('wait_for')
  })

  // ── TEST-21 (filter-provenance ITEM-13, DEC-2/DEC-6) ─────────────────────────────────
  it('cf.run carries criteria/label — and NO second encoding of the same filter (ITEM-4)', () => {
    const run = spec.actions.find(a => a.id === 'cf.run')!
    const rp = (run.body as Array<{ run_processor?: { id: string; params: Record<string, unknown> } }>).find(
      e => e.run_processor,
    )!.run_processor!
    expect(rp.params.criteria).toBe('$state.criteria')
    expect(rp.params.label).toBe('$state.label')
    // The run used to ALSO carry `predicate: $derived.criteriaPredicate` — the same
    // filter lifted into a DSL, which the kernel never read and which could describe a
    // different cell set than the mask it was committed beside. `criteria` is the record.
    expect(rp.params.predicate).toBeUndefined()
  })

  it('cf.run records the selection at the SAVE point via call_action — no `api:` effect (ITEM-13)', () => {
    const run = spec.actions.find(a => a.id === 'cf.run')!
    const ops = (run.body as Array<Record<string, unknown>>).map(e => Object.keys(e)[0])
    // the recording runs AFTER the mask is committed (run_processor → wait_for → call_action).
    expect(ops).toEqual(['run_processor', 'wait_for', 'call_action', 'toast'])
    // the already-wired `call_action` effect — NOT the unwired `api` effect / `ctx.api`
    // arbitrary-route capability (DEC-4, withdrawn).
    expect(ops).not.toContain('api')
    const ca = (run.body as Array<{ call_action?: { id: string; params: Record<string, unknown> } }>).find(
      e => e.call_action,
    )!.call_action!
    expect(ca.id).toBe('provenance.record-selection')
    // DEC-6 Carrier A: the project + the run's OWN resolved input come off the run bag.
    expect(ca.params.project_id).toBe('$filterJob.projectId')
    expect(ca.params.input_artifact_id).toBe('$filterJob.inputs[0].artifactId')
    expect(ca.params.label).toBe('$state.label')
    // F2-33 / ITEM-4 — `criteria` is LOAD-BEARING, not decoration: it is now the RECORD
    // itself, not a side-channel used to explain away a `predicate: null`. Delete this
    // one YAML line and the action sees no constraining criteria, returns
    // `{recorded:false}` WITHOUT throwing, and `cf.run`'s trailing
    // `toast: {success: "Keep-mask committed"}` fires over a filter that recorded
    // nothing — the DEC-15 silent-success path this feature exists to remove.
    expect(ca.params.criteria).toBe('$state.criteria')
    // …and there is no second encoding riding alongside it.
    expect(ca.params.predicate).toBeUndefined()
  })

  // ── the DERIVED branch is the WIRE, and it is live ────────────────────────────────
  // `declarative/store.ts`'s `keep_mask` arm is what turns the YAML `$derived.keptMask`
  // into an actual mask at runtime. The yaml key and the primitive are each covered; the
  // branch BETWEEN them is what this drives — deleting it would leave the rest of the
  // suite green while the live preview showed nothing. This runs the SHIPPED spec through
  // the REAL view store, so the yaml → derived-dispatch → primitive chain is exercised
  // end to end.
  //
  // ITEM-4: the same assertion used to be made for `$derived.criteriaPredicate`, the
  // second encoding. It is deleted, so `keptMask` — the one the user actually sees and
  // the one the kernel reproduces — is the wire under test.
  it('the shipped spec’s $derived.keptMask computes through the REAL view store', () => {
    // The thresholded column is NAMED ONCE, then reused by the slice it lives in and by every
    // criterion built on it — so what the store was handed and what the criteria name cannot
    // drift apart.
    const column = 'pct_mito'
    const store = createViewStore(spec, 'cf-derived-wire', {
      obs: { [column]: [1, 5, 20], cell_type: ['T', 'B', 'T'] },
    })
    try {
      // a constraining criterion ⇒ the live keep-mask, recomputed reactively.
      store.set('criteria', [{ column, control: '', min: '', max: '10', keep: [] }])
      expect(store.derived.keptMask).toEqual([true, true, false])

      // an all-no-op criterion constrains nothing — every cell is kept.
      store.set('criteria', [{ column, control: '', min: '', max: '', keep: [] }])
      expect(store.derived.keptMask).toEqual([true, true, true])

      // …and the SAME wire carries a bound written as a NUMBER rather than as typed text. There
      // is ONE place the range lives, so whatever wrote it is the value the Min column displays
      // and the value the live mask filters on — both read the same two fields.
      store.set('criteria', [{ column, control: '', min: 2, max: 10, keep: [] }])
      expect(primitiveOf('min').value, 'the Min column displays that field').toBe('$row.min')
      expect(store.derived.keptMask, 'and the mask filters on it').toEqual([false, true, false])
    } finally {
      store.dispose()
    }
  })

  it('manifest ships the analysis as DATA — annotate-only keep-mask, stable code_ref', () => {
    const a = manifest.contributes.analyses.find(x => x.id === 'cell.filter') as Record<string, unknown>
    expect(a).toBeTruthy()
    // ANNOTATE-ONLY asserted as a PROPERTY, not as an exact list. The guarantee this test
    // exists for is the manifest's own "the matrix is never filtered or copied" — this
    // analysis commits its keep-mask column and never emits a new matrix. The produced SET
    // is allowed to grow (it legitimately gained a report output); the no-new-matrix promise is
    // not. `toEqual([...])` conflated the two, so a legitimate addition broke main.
    // The excluded id is DERIVED from the analysis's own `appliesTo` slot, so it tracks what
    // the analysis actually consumes instead of restating it as a literal that can drift.
    const consumedMatrix = (a.appliesTo as { subtypes_of: string }[])[0].subtypes_of
    expect(a.produces).toContain('metadata-column')
    expect(a.produces).not.toContain(consumedMatrix)
    expect((a.run as { entry: string }).entry).toBe('compute/cell-filter.py')
  })

  // ── the BOUNDS, and the relation between them ────────────────────────────────────────
  //
  // These two controls are free text going into the one coercion in the app that maps an
  // ungrammatical value to UNBOUNDED rather than to an error — deliberately, so the live
  // preview, the committed mask and the attested replay cannot disagree. The consequence is
  // that a typo is not merely tolerated, it SILENTLY REMOVES the constraint: the criterion
  // filters nothing, every row survives, rc=0, green report. The form is the only layer that
  // can catch it, and until now it did not look.
  //
  // Driven through the REAL engine over the SHIPPED spec. The bound controls are `when`-gated
  // on the column being continuous, so the gate's own derived map is supplied — a widget that
  // is not drawn is correctly not constrained, and asserting on one that never rendered would
  // be asserting nothing.

  /** The declared column of the criterion row, and the two bound COLUMNS it renders. */
  const bounds = (): { column: string; controls: Array<{ id: string; field: string }> } => {
    // Through `rowParts()`, the SHARED enumeration — never `.columns`. The bounds are sub-parts
    // of ONE folded column now, so a `.columns` walk finds neither of them and this helper would
    // report "no control declares the requirement" as an empty list rather than as a failure.
    const controls = rowParts()
      .filter(c => {
        const decl = tableRowPrimitives(c)[0]?.decl as { require?: { number?: unknown } } | undefined
        return decl?.require?.number !== undefined
      })
      .map(c => ({ id: String(c.key), field: String(c.key) }))
    return { column: 'metric', controls }
  }

  const gateWith = (criteria: Array<Record<string, unknown>>): ReturnType<typeof evaluateForm> =>
    evaluateForm(spec, {
      params: {},
      // A NON-BLANK mask name: it is `require.required` now, and a blank one would refuse
      // the run for a reason none of the bound assertions below are about.
      state: { expression: 'art-1', criteria, groupBy: '', label: 'keep' },
      // the column is continuous, which is what makes the bound controls render at all.
      derived: {
        controlByColumn: { metric: 'range' },
        columns: [{ value: 'metric' }],
        categoriesByColumn: {},
      },
      const: spec.const ?? {},
      data: {},
    } as Scope)

  it('both bound controls declare the numeric requirement, so neither is unguarded', () => {
    const { controls } = bounds()
    // A per-control assertion, not a count: it is the one that fails when ONE of the pair
    // loses its requirement, which is the realistic half-migration.
    expect(controls.map(c => c.id).sort()).toEqual(['max', 'min'])
  })

  it('the requirement is on the FIELD, so it holds a NUMERIC bound exactly as a typed one', () => {
    // The constraint is declared on `min`/`max`, not on a control, and this is the assertion
    // that says so: the gate is evaluated over STATE, and it cannot see what wrote it. Kept
    // after the range band was removed — it covers the field-vs-control placement of the
    // requirement, which is what any future second writer of these bounds would rely on.
    const { column } = bounds()
    expect(gateWith([{ column, min: 12, max: 40, keep: [] }]).gate.canSubmit).toBe(true)
    expect(gateWith([{ column, min: Number.NaN, max: 40, keep: [] }]).gate.canSubmit).toBe(false)
  })

  it('an UNGRAMMATICAL bound refuses the run — the silent unbounded-instead-of-error case', () => {
    const { column, controls } = bounds()
    for (const control of controls) {
      for (const bad of ['1O', '1_000', '0x10', 'Infinity', '10 ']) {
        const v = gateWith([{ column, min: '', max: '', keep: [], [control.field]: bad }])
        expect(
          v.gate.canSubmit,
          `${control.id} = ${JSON.stringify(bad)} is UNBOUNDED to every reader of a bound, so ` +
            'the criterion would filter nothing and the run would report success over it',
        ).toBe(false)
      }
    }
  })

  it('a plain decimal bound, and an OMITTED one, are both accepted — the positive controls', () => {
    const { column, controls } = bounds()
    expect(gateWith([{ column, min: '', max: '', keep: [] }]).gate.canSubmit).toBe(true)
    for (const control of controls) {
      const v = gateWith([{ column, min: '', max: '', keep: [], [control.field]: '10' }])
      expect(v.gate.canSubmit, `${control.id} = "10" is plain decimal notation`).toBe(true)
    }
  })

  it('a bound control that is NOT drawn constrains nothing — an invisible requirement is unmeetable', () => {
    // The same garbage, on a criterion whose column is categorical: the bound controls are
    // `when`-gated off, so there is nothing on screen for the user to correct.
    const v = evaluateForm(spec, {
      params: {},
      state: {
        expression: 'art-1',
        criteria: [{ column: 'kind', min: '1O', max: '', keep: ['a'] }],
        groupBy: '',
        // Named, because the mask name is `require.required` — a blank one would refuse the
        // run for a reason that has nothing to do with the undrawn bound this test is about.
        label: 'keep',
      },
      derived: { controlByColumn: { kind: 'multiselect' }, columns: [], categoriesByColumn: { kind: ['a'] } },
      const: spec.const ?? {},
      data: {},
    } as Scope)
    expect(v.gate.canSubmit).toBe(true)
  })

  it('MIN ABOVE MAX is refused, and the message lands on THAT row’s upper bound', () => {
    const { column } = bounds()
    const v = gateWith([
      { column, min: '1', max: '9', keep: [] },
      { column, min: '5', max: '1', keep: [] },
    ])
    expect(v.gate.canSubmit, 'a keep-range that keeps nothing, with no error, is the failure').toBe(false)
    const keys = [...v.verdicts.keys()]
    expect(keys, 'exactly one row is inverted, so exactly one message exists').toHaveLength(1)
    // `criteriaTable#0#max:1` — the table instance, then the COLUMN and the ROW. It is the
    // address the Max column's own control reads its message from, which is what makes the
    // relation land where the requirement would.
    expect(keys[0], 'it belongs to the SECOND row, and to its upper bound').toBe('criteriaTable#0#max:1')
  })

  it('an UNBOUNDED side is never "above" or "below" anything — the positive control', () => {
    // `evalWhen` coerces with `Number`, and `Number('') === 0`, so an unguarded predicate
    // would fire on every ordinary lower bound. That is the same reads-correctly-means-
    // something-else shape this whole construct replaces.
    const { column } = bounds()
    for (const row of [
      { min: '5', max: '' },
      { min: '', max: '1' },
      { min: '', max: '' },
      { min: '1', max: '5' },
    ]) {
      expect(
        gateWith([{ column, keep: [], ...row }]).gate.canSubmit,
        `min=${JSON.stringify(row.min)} max=${JSON.stringify(row.max)} is a coherent range`,
      ).toBe(true)
    }
  })
})

// A standalone before/after pair can be HIDDEN where it was shown.
//
// Both hide actions were declared and wired to their pair's own close affordance on the canvas —
// so hiding worked, from a different region, via a control nothing pointed at.
// In the form the control read "Show …" whether or not the pair was already on screen, and there
// was no second state for it to be in. A toggle that cannot be untoggled where it was toggled is
// the defect this pins, and the shape it pins is complementary gating: for each pair, exactly one
// of {show, hide} is offered at any time, and the one offered is the one that changes something.
describe('the standalone plot toggles are two-way', () => {
  // Parsed here rather than reached for: the sibling block's `spec` is scoped to that block, and
  // this reads the SHIPPED yaml for the same reason it does — a restated widget id would only
  // assert what this file believes.
  const view = parseViewSpec(rawView).value as ViewSpec

  const evalGate = (when: string | undefined, state: Record<string, unknown>, caps: string[]): boolean =>
    evalWhen(when, {
      params: {},
      state,
      derived: {},
      const: {},
      data: {},
      caps: Object.fromEntries(caps.map(c => [c, true])),
    } as unknown as Scope)

  const btn = (id: string) =>
    view.widgets.find(w => w.id === id) as { when?: string; onClick?: string } | undefined

  // The pairs are DISCOVERED, not listed: every widget whose id starts `show` and has a `hide`
  // twin. Naming them here would restate the package's own vocabulary in app-scanned source, and
  // would also let a third pair be added with no coverage at all.
  const pairs = view.widgets
    .map(w => String(w.id))
    .filter(id => id.startsWith('show') && view.widgets.some(o => String(o.id) === id.replace(/^show/, 'hide')))
    .map(show => {
      const hide = show.replace(/^show/, 'hide')
      const flag = show.replace(/Btn$/, '')
      const gate = String((view.widgets.find(w => w.id === show) as { when?: string }).when ?? '')
      const cap = /has:(\w+)/.exec(gate)?.[1] ?? ''
      return [flag, cap, show, hide] as const
    })
  expect(pairs.length, 'the view declares at least one show/hide pair to check').toBeGreaterThan(0)

  for (const [flag, cap, show, hide] of pairs) {
    it(`${flag}: exactly one of show/hide is offered, and it is the one that changes something`, () => {
      const s = btn(show)
      const h = btn(hide)
      expect(s, `${show} is declared`).toBeTruthy()
      expect(h, `${hide} is declared — without it the toggle is one-way`).toBeTruthy()

      // HIDDEN → offer "show" only.
      expect(evalGate(s!.when, { [flag]: false }, [cap]), `${show} is offered while hidden`).toBe(true)
      expect(evalGate(h!.when, { [flag]: false }, [cap]), `${hide} is NOT offered while hidden`).toBe(false)

      // SHOWN → offer "hide" only. This is the arm that did not exist.
      expect(evalGate(h!.when, { [flag]: true }, [cap]), `${hide} is offered while shown`).toBe(true)
      expect(evalGate(s!.when, { [flag]: true }, [cap]), `${show} is NOT offered while shown`).toBe(false)

      // The capability gate still governs both, so a dataset without it offers neither.
      expect(evalGate(s!.when, { [flag]: false }, []), 'no capability ⇒ no show').toBe(false)
      expect(evalGate(h!.when, { [flag]: true }, []), 'no capability ⇒ no hide').toBe(false)

      // …and each button dispatches the action that moves the flag its own way.
      expect(s!.onClick).toContain('how')
      expect(h!.onClick).toContain('ide')
    })
  }
})

// ── SWITCHING THE DATASET, with criteria already built on the previous one ───────────────
//
// The dataset picker's own setter writes ONE field. Nothing else in the view reacts to a
// switch, so a criterion built on dataset A survives onto B unchanged — naming a column B may
// not carry. The LAUNCH is protected (`inputs_from` gates on the criterion having a column and
// ERRORS on one it cannot resolve), so a bad run cannot start; the gap was the FORM in between,
// which showed a row that plotted nothing and explained nothing: `controlByColumn[$row.column]`
// is undefined for an off-axis column, so both bound arms and the keep-set are gated off and
// the row draws its column name over three empty slots.
//
// The behaviour chosen — and the reason it is a `check` rather than a new construct — is that
// the DECLARED validation vocabulary already expresses "one row of this list is invalid, for
// this reason, at this control": `checks[].for_each` + `at: {widget, part, index}` is exactly
// the address `minAboveMax` already lands on, and it feeds the same three consumers (the
// field's message, the form summary, the submit gate) from one declaration. So the criteria
// are KEPT — a switch back to A restores a working form with no retyping — and the ones the
// new dataset cannot resolve are marked IN PLACE.
//
// Driven through the REAL actions, the REAL store and the REAL validity pre-pass over the
// SHIPPED yaml: the switch is dispatched the way the picker dispatches it, and the new frame
// is landed the way `resolveAndApplyViewData` lands it (`setData`).
//
// Every id this block drives is DISCOVERED from the shipped spec — the picker's own
// `onChange`, the action whose body appends to the list, the setter the column control
// dispatches, and the name of the slice the column list is derived from. That is not
// ceremony: a restated id asserts what this file believes rather than what the package
// declares, and a renamed action would leave these tests green against a shape nothing
// dispatches.
describe('switching the dataset reconciles the criteria built on the one before it', () => {
  const view = parseViewSpec(rawView).value as ViewSpec

  // Two datasets that SHARE one column and each carry one the other does not. That shape is
  // what makes the outcome observable at all: with identical column sets, "the form
  // re-anchored" and "the form kept reading the dataset it was on" produce the same answer.
  const FRAME_A = { shared_metric: [1, 5, 20], only_on_a: [2, 4, 6] }
  const FRAME_B = { shared_metric: [3, 7, 9], only_on_b: [8, 2, 9] }

  /** The DECLARED slice the column list is derived from — read off the shipped `columns_of`
   *  binding, so the fixture lands under whatever key the package actually reads. */
  const COLUMN_SLICE = String(
    Object.values((view.derived?.columns as { columns_of?: Record<string, unknown> })?.columns_of ?? {})[0] ?? '',
  ).replace(/^\$data\./, '')

  /** The criteria builder's own per-row column control, through the shared enumeration. */
  const columnPrimitive = (): Record<string, string | undefined> => {
    const table = view.widgets.find(w => w.id === 'criteriaTable')
    const part = tableRowParts(table).find(c => String((c.decl as { key?: string }).key) === 'column')
    expect(part, 'the criteria builder declares no column part').toBeTruthy()
    return tableRowPrimitives(part!.decl)[0].decl as Record<string, string | undefined>
  }

  /** The dataset picker's setter: the input control's own declared `onChange`. */
  const SET_INPUT = String(
    (view.widgets.find(w => w.kind === 'artifact_ref') as { onChange?: string }).onChange,
  )
  /** The action that APPENDS a criterion — identified by what its body DOES. */
  const ADD_ROW = String(
    view.actions.find(a =>
      (a.body as Array<Record<string, unknown>>).some(op => op && typeof op === 'object' && 'listAppend' in op),
    )?.id,
  )
  /** The per-row field setter the column control dispatches. */
  const SET_FIELD = String(columnPrimitive().onChange)

  const dispatch = async (
    store: InterpreterStore,
    id: string,
    params: Record<string, unknown>,
  ): Promise<void> => {
    const action = view.actions.find(a => a.id === id)
    expect(action, `the view declares no "${id}" action`).toBeTruthy()
    await interpretBody(action!.body, { view_id: 'cf-switch', ...params }, makeCtx({ viewStore: () => store }))
  }

  /** The scope the region evaluates its form against — the store's OWN live state + derived,
   *  never a hand-written stand-in, so the verdicts are about what the pane would show. */
  const scopeOf = (store: { state: Record<string, unknown>; derived: Record<string, unknown> }): Scope =>
    ({
      params: {},
      state: store.state,
      derived: store.derived,
      const: view.const ?? {},
      data: {},
    }) as Scope

  it('every id this block drives is the SHIPPED one — the discovery, pinned', () => {
    // Without this, a `String(undefined)` would make every dispatch below a silent no-op and
    // the suite would go green having exercised nothing.
    expect(COLUMN_SLICE, 'the column list is derived from a $data slice').toMatch(/^\w+$/)
    for (const id of [SET_INPUT, ADD_ROW, SET_FIELD]) {
      expect(view.actions.some(a => a.id === id), `${id} is a declared action`).toBe(true)
    }
    expect(new Set([SET_INPUT, ADD_ROW, SET_FIELD]).size, 'three distinct actions').toBe(3)
  })

  it('KEEPS every criterion, marks the ones the new dataset cannot resolve, and refuses the run', async () => {
    const store = createViewStore(view, 'cf-switch-keeps', { [COLUMN_SLICE]: FRAME_A })
    try {
      await dispatch(store, SET_INPUT, { value: 'artifact-A' })
      await dispatch(store, ADD_ROW, {})
      await dispatch(store, SET_FIELD, { index: 0, key: 'column', value: 'only_on_a' })
      await dispatch(store, ADD_ROW, {})
      await dispatch(store, SET_FIELD, { index: 1, key: 'column', value: 'shared_metric' })
      // The precondition: on A the form is complete and the run is offered. Without this the
      // assertions below could hold on a form that was refusing the run for some other reason.
      expect(evaluateForm(view, scopeOf(store)).gate.canSubmit).toBe(true)

      // THE SWITCH — dispatched exactly as the dataset picker dispatches it…
      await dispatch(store, SET_INPUT, { value: 'artifact-B' })
      // …and then the anchored frame re-resolves onto B, which is what the resolver lands
      // (`axis_columns { of: $state.expression }` is re-requested on the new anchor).
      store.setData({ [COLUMN_SLICE]: FRAME_B })

      // 1. NOTHING was silently thrown away. Switching back must restore a working form, and a
      //    reconcile that deletes rows makes that a retype.
      expect(
        (store.state.criteria as Criterion[]).map(c => c.column),
        'the switch discarded criteria the user built',
      ).toEqual(['only_on_a', 'shared_metric'])

      const v = evaluateForm(view, scopeOf(store))
      // 2. The run is REFUSED at the form. `inputs_from` would refuse it at the launch either
      //    way; the point is that the refusal is now legible BEFORE the user presses Run.
      expect(v.gate.canSubmit, 'a criterion naming a column the dataset does not carry ran unremarked').toBe(false)
      // 3. …and it is exactly ONE row that is wrong, addressed at that row's COLUMN control —
      //    the same address that control reads its own message from.
      expect([...v.verdicts.keys()]).toEqual(['criteriaTable#0#column:0'])
      const verdict = v.verdicts.get('criteriaTable#0#column:0')!
      // 4. …and the sentence names the CAUSE (the dataset changed), not just the symptom.
      expect(verdict.message).toMatch(/dataset/i)
      expect(verdict.kind).toBe('check')
    } finally {
      store.dispose()
    }
  })

  it('SWITCHING BACK clears the mark — the kept criterion is usable again, with no retyping', async () => {
    // The other half of "keep, do not delete": the work survives the round trip. A reconcile
    // that cleared the list would pass every assertion above and fail this one.
    const store = createViewStore(view, 'cf-switch-back', { [COLUMN_SLICE]: FRAME_A })
    try {
      await dispatch(store, SET_INPUT, { value: 'artifact-A' })
      await dispatch(store, ADD_ROW, {})
      await dispatch(store, SET_FIELD, { index: 0, key: 'column', value: 'only_on_a' })
      await dispatch(store, SET_FIELD, { index: 0, key: 'max', value: '5' })

      await dispatch(store, SET_INPUT, { value: 'artifact-B' })
      store.setData({ [COLUMN_SLICE]: FRAME_B })
      expect(evaluateForm(view, scopeOf(store)).gate.canSubmit).toBe(false)

      await dispatch(store, SET_INPUT, { value: 'artifact-A' })
      store.setData({ [COLUMN_SLICE]: FRAME_A })
      const v = evaluateForm(view, scopeOf(store))
      expect([...v.verdicts.keys()], 'the mark outlived the condition that produced it').toEqual([])
      expect(v.gate.canSubmit).toBe(true)
      // …and the BOUND the user typed came back with it.
      expect((store.state.criteria as Criterion[])[0]).toMatchObject({ column: 'only_on_a', max: '5' })
    } finally {
      store.dispose()
    }
  })

  it('a criterion with NO column yet is never accused — a blank row is unanswered, not wrong', async () => {
    // The add affordance seeds a blank row, and the very next thing the user does is switch or
    // pick. An accusation there would fire on every freshly-added row on every surface.
    const store = createViewStore(view, 'cf-switch-blank', { [COLUMN_SLICE]: FRAME_A })
    try {
      await dispatch(store, SET_INPUT, { value: 'artifact-A' })
      await dispatch(store, ADD_ROW, {})
      await dispatch(store, SET_INPUT, { value: 'artifact-B' })
      store.setData({ [COLUMN_SLICE]: FRAME_B })
      expect([...evaluateForm(view, scopeOf(store)).verdicts.keys()]).toEqual([])
    } finally {
      store.dispose()
    }
  })
})


// ── the committed column's NAME ───────────────────────────────────────────────────────
//
// Three properties, and the third is the one a single-run test structurally cannot see.
//
//   1. What the user types IS the column name. The package no longer rewrites it into a
//      prefixed slug, so the value this control holds and the name the artifact declares
//      are the same string — which is what makes a `require` on the typed text a check on
//      the committed name, with no resolution step in between for it to miss.
//   2. A name already declared on the axis this run writes to is REFUSED. The taken set is
//      the WHOLE axis, so it covers both ways a name can already be taken in one: a column
//      the data itself arrived with (which names no producer) and a column some run put
//      there. Namespacing by prefix used to do half of that job invisibly.
//   3. THE SECOND USE. A uniqueness constraint is broken by the first run's OWN output, and
//      a form driven once is a form whose output has not landed yet. The decisive case is
//      therefore: run, let the artifact land on the axis, open the form again — the same
//      name must now be refused. It is also where this view deliberately parts company with
//      its sibling in this tree, whose slice narrows to `produced_by: others` because a
//      re-run there SUPERSEDES its own output. These outputs coexist immutably, so this
//      view's own earlier column is as real a clash as anyone else's.
describe('the committed column is NAMED by the user, and a taken name is refused', () => {
  const spec = parseViewSpec(rawView).value as ViewSpec

  /** Read off the shipped declarations rather than spelled here — the same rule the
   *  dataset-switch block follows, so a rename moves the fixture with it instead of leaving
   *  a test that passes against a set it no longer resolves. */
  const TAKEN_SET_REF = String(
    (spec.widgets.find(w => w.id === 'labelInput') as { require?: { not_in?: string } }).require?.not_in,
  )
  const TAKEN_SLICE = TAKEN_SET_REF.replace(/^\$data\./, '')
  const AXIS = String((spec.data?.[TAKEN_SLICE] as { args?: { axis?: string } })?.args?.axis)
  /** The analysis this view launches — the id its own runs stamp as `generator_id`. */
  const OWN_ANALYSIS = (
    spec.actions
      .find(a => (a.body as Array<Record<string, unknown>>).some(e => 'run_processor' in e))!
      .body as Array<{ run_processor?: { id?: string } }>
  ).find(e => e.run_processor)!.run_processor!.id as string
  /** Any producer that is not this view's own. A self-describing placeholder: all that
   *  matters is that it differs. */
  const FOREIGN_ANALYSIS = 'some.other.producer'
  /** The DEFAULT the form opens with, read from the package. */
  const DEFAULT_NAME = String((spec.state?.label as { default?: unknown } | undefined)?.default ?? '')
  /** The input state key the taken-set slice is anchored on — again, off the declaration. */
  const ANCHOR_KEY = String(
    (spec.data?.[TAKEN_SLICE] as { args?: { of?: string } })?.args?.of,
  ).replace(/^\$state\./, '')

  const ANCHOR = 'anchor-1'
  const artifact = (id: string, structure: unknown): Record<string, unknown> => ({
    id,
    project_id: 'p',
    datatype: 'anchor',
    structure,
    created_at: '2026-01-01T00:00:00Z',
    source_dataset_id: 'ds',
  })
  /** One column source on the anchored axis, optionally attributed to the run that made it.
   *  `producedBy` absent ⇒ unattributed, which is what an IMPORTED column looks like. */
  const column = (id: string, name: string, producedBy?: string): Record<string, unknown> => ({
    ...artifact(id, {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: AXIS,
      n: 3,
      arrays: [],
      columns: [{ axis: AXIS, name, kind: 'string', path: name, dtype: 'utf8', shape: [3] }],
    }),
    generator_id: producedBy ?? null,
  })
  const catalogWith = (cols: Array<Record<string, unknown>>): Array<Record<string, unknown>> => [
    artifact(ANCHOR, { kind: 'sparse_csc', axes: [AXIS, 'other'], shape: [3, 3] }),
    ...cols,
  ]

  function apiFor(rows: Array<Record<string, unknown>>): WorkbenchAPI {
    const broker = createCapabilityBroker()
    broker.publish('data', '1.0.0', {
      catalog: async () => ({ project_id: 'p', axes: [], artifacts: rows }),
      artifacts: { query: async () => rows },
    } as unknown as DataApi)
    return { version: '1', extensionId: 't', capabilities: broker } as unknown as WorkbenchAPI
  }

  /** The state the form evaluates against: the package's OWN declared defaults, with only
   *  the anchor and the name overridden. Hand-listing the fields would silently stop
   *  covering any the package adds. */
  const stateWith = (name: string, anchor: string): Record<string, unknown> => {
    const st: Record<string, unknown> = {}
    for (const [k, decl] of Object.entries(spec.state ?? {})) {
      st[k] = (decl as { default?: unknown }).default
    }
    st[ANCHOR_KEY] = anchor
    st.label = name
    return st
  }

  /** The shipped chain: resolve the view's own declared slices against this catalog, then
   *  evaluate the form. Never a hand-written `data` bag — the whole question is whether the
   *  DECLARED slice reaches the constraint. */
  const verdictsFor = async (
    name: string,
    rows: Array<Record<string, unknown>>,
    anchor: string = ANCHOR,
  ): Promise<ReturnType<typeof evaluateForm>> => {
    const state = stateWith(name, anchor)
    const scope = { state } as Scope
    const res = await resolveViewData(spec, (key, decl, declaredIn) =>
      readSliceFromApi(apiFor(rows), key, decl, scope, declaredIn),
    )
    return evaluateForm(spec, {
      params: {},
      state,
      derived: { controlByColumn: {}, columns: [], categoriesByColumn: {} },
      const: spec.const ?? {},
      data: res.data,
    } as Scope)
  }
  const clashes = (v: ReturnType<typeof evaluateForm>): string[] =>
    [...v.verdicts.values()].filter(x => x.kind === 'not_in').map(x => x.message)

  it('the fixture is wired to the SHIPPED declarations, not to strings written here', () => {
    // Without this every `String(undefined)` below would resolve to nothing and the whole
    // block would go green having constrained an empty set.
    expect(TAKEN_SET_REF, 'labelInput declares no require.not_in').toMatch(/^\$data\.\w+$/)
    expect(spec.data?.[TAKEN_SLICE], `the view declares no "${TAKEN_SLICE}" slice`).toBeTruthy()
    expect(AXIS, 'the taken-set slice names no axis').toMatch(/^\w+$/)
    expect(ANCHOR_KEY, 'the taken-set slice is anchored on no state field').toMatch(/^\w+$/)
    expect(OWN_ANALYSIS).toMatch(/\w/)
  })

  it('opens with a DEFAULT name, so the form is launchable without inventing one', async () => {
    expect(DEFAULT_NAME, 'the name field ships blank, so the form opens invalid').not.toBe('')
    const v = await verdictsFor(DEFAULT_NAME, catalogWith([]))
    expect(v.gate.canSubmit, 'a fresh input offers the run with no typing at all').toBe(true)
  })

  it('REFUSES a blank name — the run will not invent one, so the form does not offer it', async () => {
    const v = await verdictsFor('', catalogWith([]))
    expect(v.gate.canSubmit).toBe(false)
    const kinds = [...v.verdicts.values()].filter(x => x.widgetId === 'labelInput').map(x => x.kind)
    // `required`, NOT `not_in`: "you have not answered" and "that answer is taken" are two
    // different problems with two different remedies, and reporting an empty field as
    // already-taken would be a second, wrong sentence about the same blank.
    expect(kinds).toEqual(['required'])
  })

  // ── THE SECOND USE ────────────────────────────────────────────────────────────────────
  it('refuses the SECOND run under the same name — the first run\'s OWN output is a clash', async () => {
    const NAME = DEFAULT_NAME
    // Run 1: the axis carries nothing, the default name is free, the run is offered.
    expect(
      (await verdictsFor(NAME, catalogWith([]))).gate.canSubmit,
      'the precondition: without this the assertion below could hold for any reason',
    ).toBe(true)
    // …the run lands. The committed column declares the name VERBATIM — that identity is
    // what this fixture encodes, and it is why a check on the typed text is a check on the
    // committed name.
    const afterRun1 = catalogWith([column('made-1', NAME, OWN_ANALYSIS)])
    // Run 2, same form, same default.
    const v = await verdictsFor(NAME, afterRun1)
    expect(
      v.gate.canSubmit,
      'a second column under one name leaves two a reader merges by name, keeping whichever ' +
        'came last — the run must not be offered',
    ).toBe(false)
    expect(clashes(v).length, 'the refusal is the uniqueness one').toBe(1)
    // The message names the RESOLVED name, which under this rule is the typed text — a
    // refusal the user cannot map onto anything is a refusal they cannot act on.
    expect(clashes(v)[0]).toContain(NAME)
  })

  it('…and this view does NOT get to supersede its own columns, unlike its sibling', async () => {
    // The discriminating case for the ABSENT `produced_by: others`. The sibling narrows its
    // slice because its seeded rows ARE its own output and a re-run there is a redo; these
    // outputs coexist immutably, so this view's own earlier column is as real a clash as
    // anyone else's. A fix that copied the sibling's slice verbatim passes every other test
    // in this block and fails this one.
    const own = await verdictsFor('m', catalogWith([column('c', 'm', OWN_ANALYSIS)]))
    const foreign = await verdictsFor('m', catalogWith([column('c', 'm', FOREIGN_ANALYSIS)]))
    expect(own.gate.canSubmit, 'its own earlier output must block').toBe(false)
    expect(foreign.gate.canSubmit, 'another producer\'s column must block').toBe(false)
  })

  it('refuses a name the DATA ITSELF already carries — the namespacing the prefix was doing', async () => {
    // Before this change the prefix was what kept a typed name away from the data's own
    // columns: it was rewritten into a prefixed one and collided with nothing. Verbatim, it
    // collides with the real thing — and an imported column names no producer, so the taken
    // set has to count unattributed columns too or that whole job is lost.
    const v = await verdictsFor('already_here', catalogWith([column('imported-1', 'already_here')]))
    expect(v.gate.canSubmit).toBe(false)
    expect(clashes(v)[0]).toContain('already_here')
  })

  it('accepts a free name — the positive control', async () => {
    const rows = catalogWith([column('imported-1', 'already_here'), column('made-1', DEFAULT_NAME, OWN_ANALYSIS)])
    const v = await verdictsFor('strict', rows)
    expect(v.gate.canSubmit).toBe(true)
    expect(clashes(v)).toEqual([])
  })

  it('names that differ only in punctuation are DIFFERENT names, because nothing collapses them', async () => {
    // Under the old rewrite `abc-1`, `abc 1` and `abc_1` all became ONE name, so a check on
    // the typed text would have passed all three and let the third collide anyway. Verbatim
    // they are three names, and the negative control is that taking one does not refuse the
    // others — the constraint compares names, it does not fuzz them.
    const taken = catalogWith([column('made-1', 'abc-1', OWN_ANALYSIS)])
    expect((await verdictsFor('abc-1', taken)).gate.canSubmit, 'the taken one is refused').toBe(false)
    for (const free of ['abc 1', 'abc_1']) {
      expect((await verdictsFor(free, taken)).gate.canSubmit, `"${free}" is a different name`).toBe(true)
    }
  })

  it('says nothing about names before an input is chosen', async () => {
    // With no anchor the slice resolves to nothing, so the taken set is UNKNOWN rather than
    // empty. The form's complaint at that point is that no input is chosen; telling the user
    // their name is free would be a claim the engine cannot support.
    const v = await verdictsFor(DEFAULT_NAME, catalogWith([column('made-1', DEFAULT_NAME, OWN_ANALYSIS)]), '')
    expect(v.gate.canSubmit).toBe(false)
    expect(clashes(v)).toEqual([])
  })
})
