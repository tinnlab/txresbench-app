// TEST-8 / TEST-25 (ITEM-8 / ITEM-25, DEC-25/DEC-10) — the QC declarative surface
// as DATA. Loads the SHIPPED `packages/qc/ui/qc.yaml` + `manifest.yaml` and asserts:
//   (1) the view_spec parses through the SAME `parseViewSpec` as any declared view;
//   (2) `state.qc_metrics` is SEEDED with the RNA preset FAMILY as DATA (grounded in
//       research/MULTIMODAL_qc_metrics.md — mito `^MT-|^mt-`, ribo `^RP[SL]`, the
//       builtins), and the per-modality preset families ship as `const.presets` DATA
//       (mechanism 12);
//   (3) the metric editor COMPOSES from GENERIC widget primitives (a `table` +
//       `button`s + a `select`) — there is NO bespoke `qc-metric-list`/`metricRow`
//       widget KIND (INV-6);
//   (4) `addMetric`/`removeMetric`/`addHb` mutate `state.qc_metrics` through the REAL
//       interpreter (`listAppend`/`listRemove`), and a custom `{name, pattern}` row is
//       driven by the declared control end-to-end;
//   (5) the QC engine is a GENERAL compute-any-column pass — no privileged metric set,
//       `pct_counts_isotype` is just one optional preset the user MAY add (DEC-24/25).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { parseViewSpec } from '@/modules/workbench/core/spec/schema'
import { interpretBody, type InterpreterCtx, type InterpreterStore } from './interpreter'
import { createViewStore } from './store'
import { resolveCanvasOption } from '@/modules/workbench/extensions/canvas/canvasBinding'
import { evalWhen, type Scope } from './expr'
import { evaluateForm } from '@/modules/workbench/core/form/validity'
import { createCapabilityBroker, type WorkbenchAPI } from '@/modules/workbench/core'
import type { DataApi } from '@/modules/workbench/extensions/data/contract'
import { resolveViewData, readSliceFromApi } from './viewData'

// ── load the shipped DATA package ───────────────────────────────────────────────
const QC_UI = fileURLToPath(new URL('../../../../../../packages/qc/ui/qc.yaml', import.meta.url))
const QC_MANIFEST = fileURLToPath(new URL('../../../../../../packages/qc/manifest.yaml', import.meta.url))

const rawView = parseYaml(readFileSync(QC_UI, 'utf8'))
const manifest = parseYaml(readFileSync(QC_MANIFEST, 'utf8')) as {
  id: string
  contributes: { analyses: Array<Record<string, unknown>> }
}

// ── a live-ish mock store (mirrors interpreter.test.ts) ─────────────────────────
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
    token: 'qc@0',
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

type Metric = {
  id?: string
  name?: string
  pattern?: string
  aggregation?: string
  builtin?: boolean
  modality?: string
  source?: string
}
type AggregationOption = { value?: string; label?: string; description?: string }

/** The CLOSED aggregation vocabulary, read off the SHIPPED view rather than restated here —
 *  so a fifth entry (or a renamed one) moves every assertion below with it instead of
 *  quietly making them assert a list nothing uses. */
const aggregationOptions = (spec: ViewSpec): AggregationOption[] =>
  (spec.const?.aggregations ?? []) as AggregationOption[]
const aggregationValues = (spec: ViewSpec): string[] =>
  aggregationOptions(spec).map(o => String(o.value))

describe('QC declarative surface (ITEM-8 / ITEM-25)', () => {
  it('parses the shipped qc.yaml through the general parseViewSpec (LOUD-clean)', () => {
    const res = parseViewSpec(rawView)
    expect(res.errors ?? []).toEqual([])
    expect(res.ok).toBe(true)
  })

  const spec = parseViewSpec(rawView).value as ViewSpec

  it('reuses an EXISTING real permission — no new gate introduced (DEC-2)', () => {
    expect(spec.permission).toBe('jobs::use')
    for (const a of spec.actions) expect(a.permission).toBe('jobs::use')
  })

  // `state.qc_metrics.default` is the `$const.defaultMetrics` REF, not an inline copy (the
  // patterns used to be written out four times across three files). `initField` resolves a
  // `$`-ref default against `const`/`data` at store-init, so the SEEDED value is that list —
  // the helper resolves the ref the same way the store does, which also makes a DANGLING ref
  // fail here instead of silently seeding `undefined`.
  const seededMetrics = (): Metric[] => {
    // RESOLVED, not read: the default names four entries of `const.metricPresets`, so the seed
    // and the catalog cannot drift. Going through the real store also makes a DANGLING ref fail
    // here instead of silently seeding `undefined`.
    const def = spec.state.qc_metrics?.default as string[]
    expect(Array.isArray(def), 'the seed REFERENCES the catalog rather than restating it').toBe(true)
    for (const ref of def) expect(String(ref).startsWith('$const.metricPresets.')).toBe(true)
    const store = createViewStore(spec, `qc-seed-${Math.random()}`)
    try {
      return store.state.qc_metrics as Metric[]
    } finally {
      store.dispose()
    }
  }

  it('seeds state.qc_metrics with the default metric set as DATA (grounded in the research doc)', () => {
    const seeded = seededMetrics()
    expect(Array.isArray(seeded)).toBe(true)
    const byName = new Map(seeded.map(m => [m.name, m]))
    // The two former BUILTINS are ordinary rows: a gene set of `.*` reduced by `sum` /
    // `count`. They used to carry `builtin: true` and no pattern, which made them
    // uneditable and gave them a second parse path in the compute.
    expect(byName.get('total_counts')).toMatchObject({ pattern: '.*', aggregation: 'sum' })
    expect(byName.get('n_genes')).toMatchObject({ pattern: '.*', aggregation: 'count' })
    // percentage metrics — SPECIES-aware (mito covers human AND mouse; ribo `^RP[SL]`).
    expect(byName.get('pct_mito')).toMatchObject({ pattern: '^MT-|^mt-', aggregation: 'percentage' })
    expect(byName.get('pct_ribo')).toMatchObject({
      pattern: '^(RP[SL]|Rp[sl])',
      aggregation: 'percentage',
    })
    // …and it MIRRORS the compute's own fallback set, which is the only other place these
    // patterns live (`qc-10x.py::DEFAULT_QC_METRICS`, for when `params.json` omits the key).
    expect([...byName.keys()].sort()).toEqual(['n_genes', 'pct_mito', 'pct_ribo', 'total_counts'])
    // NOTHING is left claiming the deleted special case.
    for (const m of seeded) expect(m.builtin, `"${m.name}" still claims builtin`).toBeUndefined()
  })

  // ── the AGGREGATION column: the one decision the system used to make silently ──────
  //
  // Every metric used to mean `100 × Σ(set) / total counts`, stated nowhere. It was not
  // configurable, not shown, and the emitted column name was the only place it surfaced —
  // after the run. So `pct_mito = 0` meant either "no mitochondrial reads" or "the regex
  // matched nothing", and nothing on screen distinguished them.

  it('every seeded row and every appended row STATES its aggregation, from the closed set', () => {
    // The migration property, asserted as an invariant rather than as a repair: the view
    // cannot PRODUCE a row the compute would refuse (DEC-4), so a stale row can only reach
    // the compute from OUTSIDE the form — where DEC-4 refuses it by name.
    const closed = aggregationValues(spec)
    expect(closed.length).toBeGreaterThan(0) // non-vacuity: the vocabulary exists
    const rows = [
      ...seededMetrics().map(row => ({ where: `seeded "${row.name}"`, row })),
      // Every PRESET, which is where an add affordance's row lives now — the add ACTION reads
      // the catalog, so a literal in an action body is no longer where a preset can hide.
      ...Object.entries(spec.const?.metricPresets as Record<string, { metric?: Metric }>).map(
        ([key, p]) => ({ where: `preset "${key}"`, row: p.metric as Metric }),
      ),
      // …and the blank custom row, which is still a literal because there is nothing to read.
      ...spec.actions.flatMap(a =>
        (a.body as Array<{ listAppend?: { path?: string; value?: Metric } }>)
          .filter(op => op.listAppend?.path === 'qc_metrics')
          .map(op => ({ where: `${a.id} appends`, row: op.listAppend!.value as Metric }))
          .filter(r => !String(r.row.aggregation ?? '').startsWith('$')),
      ),
    ]
    expect(rows.length).toBeGreaterThan(4) // non-vacuity: seeded rows AND the catalog
    for (const { where, row } of rows) {
      expect(
        closed,
        `${where} a row whose aggregation is ${JSON.stringify(row.aggregation)} — the compute ` +
          `REFUSES a row outside the closed set rather than defaulting it (DEC-4), so this row ` +
          `would fail the run it was added to`,
      ).toContain(row.aggregation)
    }
  })

  it('the closed set is exactly the four the compute accepts', () => {
    expect(aggregationValues(spec).slice().sort()).toEqual(['count', 'mean', 'percentage', 'sum'])
  })

  it('mean\'s DENOMINATOR is visible in the UI without running anything (DEC-2)', () => {
    // `Σ ÷ |set|` and `Σ ÷ |detected|` are both defensible and they give different numbers.
    // The one that was chosen has to be READABLE at the point of choice — a denominator the
    // system picks and never shows is the exact defect this column exists to remove, and
    // recording the choice only in a design doc leaves the gap one step further away.
    const mean = aggregationOptions(spec).find(o => o.value === 'mean')
    expect(mean, 'the closed set has no `mean` entry').toBeTruthy()
    const text = String(mean!.description ?? '')
    expect(
      /÷|\/|per|divided/i.test(text) && /set/i.test(text),
      `the \`mean\` option reads "${text}" — it does not say WHICH denominator it uses, so a ` +
        `user cannot tell \`Σ ÷ genes in the set\` from \`Σ ÷ genes detected\` without running it`,
    ).toBe(true)
  })

  // REPORTED: "the selected should show sum/count/... not the whole label. The rendered options
  // should show both, but in two lines."
  //
  // These are TWO fields because they answer two questions at two moments. The label is what the
  // control shows at rest, in a table column narrow enough that a sentence is a truncated stem;
  // the description is what the option MEANS, and it is only needed while the list is open. One
  // string could serve neither honestly — which is what shipped, and which the report is about.
  it('an option LABEL is its VALUE verbatim — what the column shows at rest is what the run receives', () => {
    for (const o of aggregationOptions(spec)) {
      expect(
        o.label,
        `the option for "${o.value}" is labelled "${o.label}" — a label that is not the value ` +
          `makes the column show one thing and the run receive another`,
      ).toBe(o.value)
    }
  })

  it('…and every one carries its DEFINITION separately, as the option row’s second line', () => {
    for (const o of aggregationOptions(spec)) {
      const description = String(o.description ?? '')
      expect(description, `the option for "${o.value}" explains nothing`).not.toBe('')
      // The explanation must not be smuggled back into the label — that is the reported state.
      expect(o.label).not.toContain(description)
      expect(String(o.label)).not.toMatch(/—|:/)
    }
  })

  it('ships the default metric set as ONE flat list — no modality-keyed families (INV-6)', () => {
    // This asserted `Object.keys(presets).sort() === ['atac','prot','rna']`: a closed
    // three-modality vocabulary, and the seed pointed at `rna` — a privileged modality
    // (INV-8 says none may be). `prot`/`atac` had NO consumer besides that assertion; the
    // per-family add affordances carry their own values inline, which is where the
    // isotype/TSS presets actually live and are asserted (see the addIsotype/addTss bodies).
    expect(spec.const?.presets).toBeUndefined()
    expect(spec.const?.defaultMetrics, 'the second list is gone — there is ONE catalog').toBeUndefined()
    // ONE flat catalog, keyed by the metric's own name. No family, no modality, no nesting: the
    // only thing an entry says about WHEN it applies is a capability the DATA declares.
    const catalog = spec.const?.metricPresets as Record<string, { metric?: Metric; when?: string }>
    for (const [key, p] of Object.entries(catalog)) {
      expect(p.metric?.name, `${key} is keyed by its own name`).toBe(key)
      expect(p.when === undefined || p.when.startsWith('has:'), `${key}'s gate is a capability`).toBe(true)
    }
    // NB: `hb` is deliberately NOT SEEDED — it is a user-driven optional column (DEC-25),
    // reached through the picker. Its HBP1-excluding `^HB[^(P)]` default (DEC-14) is asserted
    // on the catalog entry.
    expect(seededMetrics().some(m => m.name === 'pct_hb')).toBe(false)
    expect(catalog.pct_hb.metric?.pattern).toBe('^HB[^(P)]')
  })

  it('composes the metric editor from GENERIC widget kinds — NO bespoke qc-metric-list kind (INV-6)', () => {
    const kinds = new Set(spec.widgets.map(w => w.kind))
    // the row editor is a GENERIC `table`; the rest are generic select/button/alert.
    expect(kinds.has('table')).toBe(true)
    // NO analysis-named widget kind (the deleted MetricListWidget's `qc-metric-list`).
    for (const w of spec.widgets) {
      expect(w.kind).not.toBe('qc-metric-list')
      expect(w.kind).not.toBe('metricRow')
    }
    // the table edits name + gene-regex per row via GENERIC editable_text cells — and shows
    // NOTHING ELSE. A read-only `modality` column joined it when the modality PICKER was
    // deleted, described as coming from the artifact's `meta.modality`; it came from a literal
    // on the preset row (see the INV-6/INV-8 block below).
    const table = spec.widgets.find(w => w.kind === 'table') as {
      columns: Array<{ key: string; cell?: Record<string, unknown> }>
      selection?: unknown
    }
    // name + genes as editable text, aggregation as a CLOSED-SET choice, and a fourth
    // column holding the per-row REMOVE action — all three generic `table` column
    // primitives, no bespoke widget.
    expect(table.columns.map(c => c.key)).toEqual(['name', 'pattern', 'aggregation', 'remove'])
    expect(table.columns.filter(c => c.cell?.editable_text !== undefined).map(c => c.key)).toEqual([
      'name',
      'pattern',
    ])
    // Aggregation is a CLOSED-SET control bound to the row's own field, sourced from the
    // shipped vocabulary — not free text the user can mistype into a value the compute
    // refuses, and not a qc-named widget KIND (which is the INV-6 violation the generic
    // closed-set primitive exists to avoid).
    const aggColumn = table.columns.find(c => c.key === 'aggregation')?.cell as
      | { select?: { value?: string; options?: string; onChange?: string } }
      | undefined
    expect(aggColumn?.select, 'Aggregation is not a closed-set column').toBeTruthy()
    expect(aggColumn!.select!.value).toBe('$row.aggregation')
    expect(aggColumn!.select!.options).toBe('$const.aggregations')
    // …and it dispatches the SAME row-field action the text columns do, which is what makes
    // the new primitive additive rather than a second editing mechanism.
    const nameColumn = table.columns.find(c => c.key === 'name')?.cell as
      | { editable_text?: { onChange?: string } }
      | undefined
    expect(aggColumn!.select!.onChange).toBe(nameColumn?.editable_text?.onChange)
    expect(spec.actions.some(a => a.id === aggColumn!.select!.onChange)).toBe(true)
    // The delete is a LABELLED BUTTON, not the row-selection checkbox. Binding `selection`
    // to a destructive action gave the user a control named `select <row>` that deleted the
    // row — mis-labelled, pinned so it could never look checked, and (because the selection
    // column forwards the row's id where `listRemove` wants an index) inert. A destructive
    // affordance has to be discoverable as destructive.
    expect(table.selection, 'row selection must not be bound to a destructive action').toBeUndefined()
    const removeAction = spec.actions.find(a => a.body?.some(op => 'listRemove' in (op as object)))!
    const removeCell = table.columns.find(c => c.key === 'remove')?.cell as
      | { button?: { label?: string; variant?: string; onClick?: string } }
      | undefined
    expect(removeCell?.button?.onClick).toBe(removeAction.id)
    expect(String(removeCell?.button?.label ?? '')).toMatch(/remove|delete/i)
    expect(removeCell?.button?.variant).toBe('destructive')
  })

  it('declares a Run that bridges to the compute job via run_processor → wait_for (ITEM-8)', () => {
    const run = spec.actions.find(a => a.id === 'qc.run')
    expect(run).toBeTruthy()
    const ops = (run!.body as Array<Record<string, unknown>>).map(e => Object.keys(e)[0])
    expect(ops).toContain('run_processor')
    expect(ops).toContain('wait_for')
    const rp = (
      run!.body as Array<{
        run_processor?: { id: string; params: Record<string, unknown>; inputs?: Record<string, unknown> }
      }>
    ).find(e => e.run_processor)!.run_processor!
    expect(rp.id).toBe('qc.10x')
    // the metric list flows to the script as a param (the SOLE param bridge).
    expect(rp.params).toHaveProperty('qc_metrics')
    // `modality` is NOT a param any more, and its absence is the point: a single run-wide
    // modality was a CLOSED `[rna, prot, atac]` restatement of what the data declares (INV-6),
    // and the wrong pick became the emitted column prefix. Each metric row carries its own
    // `modality` inside `qc_metrics` instead, so one job covers every selected modality.
    expect(rp.params).not.toHaveProperty('modality')
    // INV-4 — every input the run consumes is passed EXPLICITLY from the state the form showed,
    // never auto-resolved between the click and the job.
    //
    // BOTH are LISTS, and that is load-bearing rather than cosmetic: `qc-10x.py` resolves
    // `gene_names` list-aligned with `matrices` (entry i is the gene-name artifact for matrix
    // i). The view used to bind ONE value for the whole run, so on a two-matrix run matrix 1
    // had no gene names and every pattern metric on it was dropped.
    expect(rp.inputs).toEqual({ matrices: '$state.matrices', gene_names: '$state.geneNames' })
    expect(spec.state.geneNames.type).toBe('list')
    expect(spec.state.geneNames.default).toEqual([])
  })

  it('offers ONE gene-names picker PER selected matrix, anchored on THAT matrix', () => {
    // The pairing has to be visible before Run (INV-4): a single picker for N matrices cannot
    // express "matrix 1's symbols live in this column of matrix 1's genes axis", and the axis
    // it offers columns from is a different dataset's for every matrix after the first.
    const picker = spec.widgets.find(w => w.id === 'geneNamesPicker') as {
      for_each?: string
      source?: { of?: string; axis?: string }
      value?: string
      args?: Record<string, string>
    }
    expect(picker).toBeTruthy()
    // repeated over the CHOSEN matrices…
    expect(picker.for_each).toBe('$state.matrices as $m, $i')
    // …each anchored on ITS OWN matrix, not a hardcoded `[0]`.
    expect(picker.source?.of).toBe('$m')
    expect(picker.source?.of).not.toContain('[0]')
    // …bound to ITS OWN slot in the aligned list, and writing back by index.
    expect(picker.value).toBe('$state.geneNames[$i]')
    expect(picker.args?.index).toBe('$i')
  })

  it('addMetric appends a blank custom {name, pattern} row via the REAL interpreter (listAppend)', async () => {
    const seeded = seededMetrics()
    const store = liveMockStore({ qc_metrics: [...seeded] })
    const add = spec.actions.find(a => a.id === 'qc.addMetric')!
    await interpretBody(add.body, { view_id: 'v' }, makeCtx({ viewStore: () => store }))
    const list = store.state.qc_metrics as Metric[]
    expect(list.length).toBe(seeded.length + 1)
    const added = list[list.length - 1]
    expect(added).toEqual({ id: '', name: '', pattern: '', aggregation: 'percentage' })
  })

  // `addHb appends the %hemoglobin preset` and `the per-family add affordances carry their own
  // values` stood here. Both asserted a metric row written INLINE in an action body, which is
  // exactly the shape the preset catalog removes: a preset existed only where somebody had
  // hand-written the action and the button. `pct_hb` and `pct_isotype` are still asserted, with
  // the same patterns and the same `pct_` names — as ENTRIES of `const.metricPresets`, where a
  // seventh preset costs a row rather than a widget. See the catalog describe at the foot.

  // This line used to read:
  //
  //   expect((await runAdd('qc.addTss'))[0]).toMatchObject({ name: 'tss_enrichment', source: 'fragments' })
  //
  // i.e. a PASSING test asserting a row with NO `pattern` and a `source` key nothing
  // reads. `qc-10x.py::parse_qc_metrics` keeps `{name, pattern}` and answers each row
  // with `re.match` over the bound gene names; a pattern-less row was compiled as `""`,
  // and the empty regex matches EVERY gene — so `pct_tss_enrichment` read ~100 % on
  // every cell, silently. The action and its button are deleted (TSS enrichment is a
  // fragment-position computation, not a gene-name regex, and this analysis has no
  // fragments input slot); what replaces the assertion is the INVARIANT, so the next
  // sourceless/patternless row cannot be added without failing here.
  it('every add affordance appends a metric the compute can actually answer', () => {
    const appended = spec.actions.flatMap(a =>
      (a.body as Array<{ listAppend?: { path?: string; value?: Metric } }>)
        .filter(op => op.listAppend?.path === 'qc_metrics')
        .map(op => ({ action: a.id, row: op.listAppend!.value as Metric })),
    )
    expect(appended.length).toBeGreaterThan(0) // non-vacuity: there ARE add affordances
    for (const { action, row } of appended) {
      // EVERY row is a gene-set metric now — there is no builtin arm to skip, which is
      // exactly what deleting the special case bought: one shape, one set of guarantees.
      expect(row.builtin, `${action} appends a row claiming the deleted builtin flag`).toBeUndefined()
      expect(row, `${action} appends a metric with no \`pattern\` key`).toHaveProperty('pattern')
      // `qc.addMetric`'s blank row is the ONE legitimate empty pattern: it is a row the
      // user is about to fill in, not a preset. Every preset ships a real regex.
      if (action !== 'qc.addMetric') {
        expect(row.pattern, `${action} appends a metric with an empty \`pattern\``).toBeTruthy()
      }
      // `source:` is not part of the contract — `parse_qc_metrics` has never read it, so
      // a row carrying it is claiming an input path that does not exist.
      expect(row.source, `${action} appends a row with an unread \`source\` key`).toBeUndefined()
    }
  })

  it('no widget or action references the retired TSS affordance', () => {
    expect(spec.actions.find(a => a.id === 'qc.addTss')).toBeUndefined()
    expect(spec.widgets.find(w => w.id === 'addTssBtn')).toBeUndefined()
    // …and nothing is left pointing at it (a button whose onClick names a missing
    // action renders and does nothing).
    const onClicks = spec.widgets.map(w => (w as { onClick?: string }).onClick).filter(Boolean)
    expect(onClicks).not.toContain('qc.addTss')
    for (const id of onClicks) expect(spec.actions.some(a => a.id === id)).toBe(true)
  })

  it('removeMetric drops the row at the given index via the REAL interpreter (listRemove)', async () => {
    const store = liveMockStore({
      qc_metrics: [
        { id: 'a', name: 'total_counts', pattern: '.*', aggregation: 'sum' },
        { id: 'b', name: 'pct_mito', pattern: '^MT-|^mt-', aggregation: 'percentage' },
      ],
    })
    const remove = spec.actions.find(a => a.id === 'qc.removeMetric')!
    // The per-row action button forwards `{ index }` — the row's POSITION, which is what
    // `listRemove` removes by.
    //
    // This used to pass `{ key: '0', selected: true }`, the row-SELECTION column's payload,
    // with `key` written as a stringified INDEX. The real column forwards the row's own
    // `id` (`m_total`), never an index — so the argument this test supplied was one no
    // control ever sent, and the action it exercised could not be reached from the UI at
    // all. The delete was inert in the app while green here, which is the shape of a test
    // that certifies a bug: it fed the code the input the code wanted.
    await interpretBody(remove.body, { view_id: 'v', index: 0 }, makeCtx({ viewStore: () => store }))
    const list = store.state.qc_metrics as Metric[]
    expect(list.map(m => m.name)).toEqual(['pct_mito'])
  })

  // The canvas suite that used to sit here asserted `['rna:total_counts', 'rna:pct_mito', …]`
  // from the SEEDED metric rows — i.e. it certified the very fabrication this round removes
  // (a `crispr` run emits `crispr:…` and the violins bound `rna:…`, drawing empty panes). It
  // is replaced by the result-driven assertions in the INV-6/INV-8 block below, which bind
  // the canvas to the columns a run ACTUALLY emitted, for arbitrary modality keys.

  // ── INV-6/INV-8: the modality is an OPEN set, read off the ARTIFACT ──────────────
  //
  // The modality PICKER was deleted for offering a closed `[rna, prot, atac]` — it could not
  // name `hto` or `crispr`, which the importer's own classifier produces, and the wrong pick
  // became the emitted column prefix. The closed list then reappeared one level down, as a
  // `modality:` literal on every metric ROW, presented in the table as though it came from
  // the artifact. It does not: `qc-10x.py` never reads it (`parse_qc_metrics` keeps only
  // `{name, pattern}`), and every metric is applied to EVERY bound matrix, each column
  // prefixed with THAT matrix's own `structure.modality`.
  //
  // So the row's `modality` was a fiction with one real consumer — the canvas `valueKey` —
  // which is exactly where it did damage: a `crispr` run emitted `crispr:total_counts` while
  // the violins bound `rna:total_counts`, i.e. empty plots and no error.
  it('no metric row declares a modality — the prefix is the ARTIFACT\'s, not the row\'s', () => {
    const seeded = seededMetrics()
    expect(seeded.length).toBeGreaterThan(0) // non-vacuity: there ARE seeded rows to check
    for (const row of seeded) {
      expect(row.modality, `seeded metric "${row.name}" restates a modality`).toBeUndefined()
    }
    // …and no CATALOG entry carries one either (the retired per-family affordances seeded
    // `rna`/`prot`/`atac`, and the catalog is where those families' one job now lives).
    const presets = Object.values(spec.const?.metricPresets as Record<string, { metric?: Metric }>)
    expect(presets.length).toBeGreaterThan(0) // non-vacuity: there ARE presets
    for (const p of presets) expect(p.metric?.modality).toBeUndefined()
  })

  it('the metric table has no Modality column — it claimed an artifact source it never had', () => {
    const table = spec.widgets.find(w => w.kind === 'table') as { columns: Array<{ key: string }> }
    expect(table.columns.map(c => c.key)).not.toContain('modality')
  })

  it('nothing in the view enumerates a modality vocabulary (INV-6 — an open set)', () => {
    // A structural scan of the whole spec: no value anywhere may be one of the three keys
    // the retired picker offered. `classify_feature_type` is open by construction, so any
    // literal from that list is a closed list re-entering by another route.
    const CLOSED = new Set(['rna', 'prot', 'atac'])
    const offenders: string[] = []
    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        if (CLOSED.has(node)) offenders.push(`${path} = ${node}`)
        return
      }
      if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`))
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, `${path}.${k}`)
      }
    }
    walk({ state: spec.state, const: spec.const, widgets: spec.widgets, actions: spec.actions, canvas: spec.canvas }, '$')
    expect(offenders).toEqual([])
  })

  // ── THIS ANALYSIS PLOTS NOTHING ─────────────────────────────────────────────────────
  //
  // Two tests stood here asserting that this view's `canvas:` block bound one series per
  // emitted metric column, and that it was empty before a run. Both PASSED. They were
  // careful about a behaviour that should not exist — the familiar shape where a green
  // test certifies the defect, so the defect survives every refactor that keeps it green.
  //
  // `docs/analysis-workbench/INTERFACE_DESIGN.md` §3.4 puts violins, thresholds and the
  // before/after delta in ONE surface: a distribution plot exists to support a threshold
  // DECISION. This analysis owns no criteria, so it owns no plot. The criteria — and
  // therefore the plots they drive — live in the downstream filtering analysis.
  //
  // This asserts the ABSENCE, not the removal of a line: there is one shared workbench
  // canvas, every view pushes series onto it, and a later author re-adding a `canvas:`
  // block here would silently repaint over the analysis that does own criteria.
  it('declares NO canvas series — it computes its columns and plots nothing', () => {
    expect(spec.canvas).toBeUndefined()

    // The plot needed a derived list of the emitted COLUMNS to iterate. `derived` is no longer
    // empty — it re-keys a declared CONSTANT so an action body can look a preset up — so the
    // proxy is replaced by the property it stood for: nothing derived reads a `data` slice, and
    // a canvas has nothing to bind to that is not derived from data.
    for (const [name, d] of Object.entries(spec.derived ?? {})) {
      expect(JSON.stringify(d), `$derived.${name} reads a data slice`).not.toContain('$data.')
    }

    // `data:` USED to be asserted absent here, as a proxy for "nothing to bind a plot to".
    // The view now declares one — the set of column names already taken on the axis it
    // writes to, which a `require` reads — so the proxy has to be replaced by the property
    // it was standing in for: every declared slice is consumed by a CONSTRAINT and by
    // nothing else. A slice read from anywhere else is a binding, and a binding is one edit
    // from being a plot's.
    const dataKeys = Object.keys(spec.data ?? {})
    const outsideRequire = new Set<string>()
    const walk = (node: unknown, inRequire: boolean): void => {
      if (typeof node === 'string') {
        if (inRequire) return
        for (const key of dataKeys) if (node.includes(`$data.${key}`)) outsideRequire.add(key)
        return
      }
      if (Array.isArray(node)) return void node.forEach(v => walk(v, inRequire))
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) walk(v, inRequire || k === 'require')
      }
    }
    walk({ widgets: spec.widgets, actions: spec.actions, canvas: spec.canvas, derived: spec.derived }, false)
    expect(
      [...outsideRequire],
      'a declared data slice is read from somewhere other than a `require` — this view resolves ' +
        'data only in order to CONSTRAIN, and anything else is a binding a plot could take over',
    ).toEqual([])

    // Nothing else in the view smuggles the same thing back under another key: no widget
    // or action may name a plot kind or a canvas coordinate.
    const serialized = JSON.stringify({ widgets: spec.widgets, actions: spec.actions, state: spec.state })
    for (const token of ['coordId', 'valueKey', 'violin', 'datasetId']) {
      expect(serialized, `the view still names "${token}" outside a canvas block`).not.toContain(token)
    }
  })

  // ── a name that is ALREADY TAKEN on the axis this run writes to ──────────────────────
  //
  // Storage does not key on the column NAME (`artifacts_natural_key` is
  // `(project_id, dataset_id, run_id, output_id)`), so re-running with a name that is
  // already there creates a SECOND column of that name; the reader then merges an axis'
  // columns by name, last one wins, and the rest are shadowed by row order. The form is
  // where that gets refused.
  //
  // Driven through the WHOLE chain — the SHIPPED yaml's own `data` declaration, the REAL
  // axis-columns resolver, the REAL engine — over a TWO-DATASET catalog, because the trap
  // here is a SCOPE trap and a one-dataset fixture cannot see it. The view seeds four metric
  // rows by default, and a user who has ever run this analysis on ANY dataset has columns
  // with those four names in the project. Scoped to "anywhere in the project" every seeded
  // row would be invalid the instant the form opened and the whole thing would be dead on
  // arrival; scoped to the axis instance the run writes to, the same project opens clean.
  //
  // Nothing below spells an axis name, a column name or a datatype: all three are read out
  // of the shipped package, so this test cannot drift from it and carries none of its
  // vocabulary.
  describe('a metric name that collides with the target axis', () => {
    const sliceKey = 'existingColumns'
    const sliceArgs = ((spec.data ?? {})[sliceKey]?.args ?? {}) as { of?: string; axis?: string }
    const AXIS = String(sliceArgs.axis)
    const ANCHOR_KEY = String(sliceArgs.of).replace('$state.', '')
    /** The rows the view SEEDS — the four a user meets on open. */
    const seededRows = (): Array<Record<string, unknown>> => {
      const store = createViewStore(spec, `qc-collide-${Math.random()}`)
      try {
        const key = Object.keys(store.state).find(k => {
          const v = store.state[k]
          return Array.isArray(v) && v.length > 0 && typeof (v[0] as { name?: unknown })?.name === 'string'
        })
        return JSON.parse(JSON.stringify(store.state[key as string])) as Array<Record<string, unknown>>
      } finally {
        store.dispose()
      }
    }
    const ROWS_KEY = String(
      (spec.widgets.find(w => w.kind === 'table') as { rows?: string }).rows,
    ).replace('$state.', '')
    // DERIVED from the run's own declaration, like the gate test above: the state key on
    // `run_processor.inputs` that is not the anchor. Spelling it here would put the
    // package's vocabulary in an app-side test and drift the day the key is renamed.
    const RUN_INPUTS = (
      spec.actions
        .find(a => (a.body as Array<Record<string, unknown>>).some(e => 'run_processor' in e))!
        .body as Array<{ run_processor?: { inputs?: Record<string, string> } }>
    ).find(e => e.run_processor)!.run_processor!.inputs!
    const PAIRED_KEY = Object.values(RUN_INPUTS)
      .map(ref => ref.replace('$state.', ''))
      .find(k => k !== ANCHOR_KEY) as string
    /** THE ANALYSIS THIS VIEW LAUNCHES — read off its own `run_processor`, never spelled
     *  here. It is the identity the "may I supersede my own output?" question turns on, and
     *  reading it from the spec keeps this app-side tier free of the package's vocabulary
     *  (the same rule `PAIRED_KEY` above follows). */
    const OWN_ANALYSIS = (
      spec.actions
        .find(a => (a.body as Array<Record<string, unknown>>).some(e => 'run_processor' in e))!
        .body as Array<{ run_processor?: { id?: string } }>
    ).find(e => e.run_processor)!.run_processor!.id as string
    /** Some OTHER producer — any generator that is not this view's own. Written as a
     *  self-describing placeholder rather than a real sibling analysis id, because what
     *  matters is only that it differs. */
    const FOREIGN_ANALYSIS = 'some.other.producer'

    const artifact = (id: string, dataset: string, structure: unknown): Record<string, unknown> => ({
      id,
      project_id: 'p',
      datatype: 'anchor',
      structure,
      created_at: '2026-01-01T00:00:00Z',
      source_dataset_id: dataset,
    })
    /** A one-column artifact on `AXIS` of `dataset`, named `name`, optionally attributed to
     *  the ANALYSIS whose run produced it (`generator_id`). Absent ⇒ unattributed: an
     *  imported column, or a run whose provenance was never recorded. */
    const column = (
      id: string,
      dataset: string,
      name: string,
      producedBy?: string,
    ): Record<string, unknown> => ({
      ...artifact(id, dataset, {
        encoding: 'zarr_v3',
        kind: 'table',
        axis: AXIS,
        n: 3,
        arrays: [],
        columns: [{ axis: AXIS, name, kind: 'string', path: name, dtype: 'utf8', shape: [3] }],
      }),
      generator_id: producedBy ?? null,
    })

    /** TWO datasets: one that has already been written to, one that has not. */
    function catalogFor(takenNames: string[], producedBy?: string): Array<Record<string, unknown>> {
      return [
        artifact('anchor-used', 'ds-used', { kind: 'sparse_csc', axes: [AXIS, 'other'], shape: [3, 3] }),
        artifact('anchor-fresh', 'ds-fresh', { kind: 'sparse_csc', axes: [AXIS, 'other'], shape: [3, 3] }),
        ...takenNames.map((n, i) => column(`col-${i}`, 'ds-used', n, producedBy)),
      ]
    }

    function apiFor(rows: Array<Record<string, unknown>>): WorkbenchAPI {
      const broker = createCapabilityBroker()
      broker.publish('data', '1.0.0', {
        catalog: async () => ({ project_id: 'p', axes: [], artifacts: rows }),
        artifacts: { query: async () => rows },
      } as unknown as DataApi)
      return { version: '1', extensionId: 't', capabilities: broker } as unknown as WorkbenchAPI
    }

    /** The shipped chain: resolve the view's declared slices for this state, then evaluate. */
    async function verdictsFor(
      state: Record<string, unknown>,
      rows: Array<Record<string, unknown>>,
    ): Promise<ReturnType<typeof evaluateForm>> {
      const api = apiFor(rows)
      const scope: Scope = { state }
      // The spec the reader sees is the one `resolveViewData` hands it, NOT this closure's:
      // a slice that narrows itself by a property of its own view (`produced_by`) must be
      // answered against the spec the resolver is walking, and closing over a second
      // reference is how a test comes to prove something production never does.
      const res = await resolveViewData(spec, (key, decl, declaredIn) =>
        readSliceFromApi(api, key, decl, scope, declaredIn),
      )
      return evaluateForm(spec, {
        params: {},
        state,
        derived: {},
        const: spec.const ?? {},
        data: res.data,
      } as Scope)
    }

    const stateOn = (anchor: string[], rowOverrides?: Array<Record<string, unknown>>) => ({
      [ANCHOR_KEY]: anchor,
      [PAIRED_KEY]: anchor.map((_, i) => `names-${i}`),
      [ROWS_KEY]: rowOverrides ?? seededRows(),
    })

    it('the seeded rows are not vacuous, and the fixture takes their names on ONE dataset', () => {
      const names = seededRows().map(r => String(r.name))
      expect(names.length, 'the view seeds no rows, so every case below asserts nothing').toBeGreaterThan(0)
      expect(new Set(names).size, 'the seeded names must be distinct').toBe(names.length)
    })

    it('opens CLEAN on a dataset that has not been written to — even when another one HAS', async () => {
      // The dead-on-arrival guard. Every seeded name exists in the project, on the OTHER
      // dataset. A check scoped to the project rather than to the axis instance fails here,
      // and fails for every real user of this form.
      const rows = catalogFor(seededRows().map(r => String(r.name)))
      const v = await verdictsFor(stateOn(['anchor-fresh']), rows)
      expect(
        v.gate.canSubmit,
        'the seeded form must be launchable on a fresh axis; a project-wide name check makes ' +
          'this red and takes the whole constraint with it',
      ).toBe(true)
    })

    it('REFUSES a name already on the axis this run writes to, and names the conflict', async () => {
      const rows = catalogFor(seededRows().map(r => String(r.name)))
      const v = await verdictsFor(stateOn(['anchor-used']), rows)
      expect(v.gate.canSubmit).toBe(false)
      const collisions = [...v.verdicts.values()].filter(x => x.kind === 'not_in')
      expect(collisions.length, 'every seeded name is taken on this axis').toBe(seededRows().length)
      // The offending value is IN the sentence — in the summary beside the run control the
      // field's own contents are not on screen, so a message that does not name it says
      // nothing about which row to fix.
      for (const name of seededRows().map(r => String(r.name))) {
        expect(
          collisions.some(c => c.message.includes(name)),
          `no message names the colliding value "${name}"`,
        ).toBe(true)
      }
    })

    // ── RE-RUNNING THE SAME ANALYSIS ON THE SAME DATA ───────────────────────────────────
    //
    // The four names a fresh form is seeded with are the four a first run EMITS, so after
    // one successful run every seeded row collided with a column of its own making and Run
    // never came back: the only way to run this analysis twice on one dataset was to rename
    // all four metrics. The gate was asking "is this name taken?" when the question it owes
    // the user is "is this name taken BY SOMEONE ELSE?".
    //
    // A run may supersede its OWN previous output. It may not quietly land a second column
    // beside one a different producer made — which is the case the constraint exists for,
    // and which the two cases below keep separated.
    it('a SECOND run on the same axis is launchable — this analysis may supersede its OWN columns', async () => {
      const rows = catalogFor(seededRows().map(r => String(r.name)), OWN_ANALYSIS)
      const v = await verdictsFor(stateOn(['anchor-used']), rows)
      expect(
        [...v.verdicts.values()].filter(x => x.kind === 'not_in').map(x => x.message),
        'a name this analysis itself produced is not a collision with someone else',
      ).toEqual([])
      expect(
        v.gate.canSubmit,
        'the seeded form must be launchable a second time on the SAME dataset; refusing it ' +
          'makes re-running the analysis impossible without renaming every metric',
      ).toBe(true)
    })

    it('…and a column some OTHER producer made on that axis still REFUSES the run', async () => {
      // The guard on the fix. Without it "may supersede its own" degrades into "never
      // blocks", and the constraint stops catching the case it was written for.
      const rows = catalogFor(seededRows().map(r => String(r.name)), FOREIGN_ANALYSIS)
      const v = await verdictsFor(stateOn(['anchor-used']), rows)
      expect(v.gate.canSubmit).toBe(false)
      expect(
        [...v.verdicts.values()].filter(x => x.kind === 'not_in').length,
        'every seeded name is taken on this axis by a different producer',
      ).toBe(seededRows().length)
    })

    it('an UNATTRIBUTED column still refuses — absence of a producer is not a claim of ownership', async () => {
      // An imported column, or one whose run recorded no provenance, names no producer. It
      // is therefore not THIS analysis' own output, and the conservative reading is the only
      // honest one: treating "I do not know who made this" as "I made this" would hand the
      // permission to every column on the axis and end the constraint.
      const rows = catalogFor(seededRows().map(r => String(r.name)))
      const v = await verdictsFor(stateOn(['anchor-used']), rows)
      expect(v.gate.canSubmit).toBe(false)
    })

    it('reports ONLY the foreign collision when the axis carries both kinds', async () => {
      // The discriminating case: same axis, same four names, one of them another producer's.
      // A fix that simply stopped resolving the slice passes both cases above and fails here.
      const names = seededRows().map(r => String(r.name))
      const rows = [
        ...catalogFor([]),
        ...names.map((n, i) => column(`col-${i}`, 'ds-used', n, i === 0 ? FOREIGN_ANALYSIS : OWN_ANALYSIS)),
      ]
      const v = await verdictsFor(stateOn(['anchor-used']), rows)
      expect(v.gate.canSubmit).toBe(false)
      const collisions = [...v.verdicts.values()].filter(x => x.kind === 'not_in')
      expect(collisions.length, 'one foreign name is taken; the other three are this run\'s own').toBe(1)
      expect(
        collisions[0].message.includes(names[0]),
        `the one reported collision must name "${names[0]}", the foreign one`,
      ).toBe(true)
    })

    it('accepts a name that is free on that axis — the positive control', async () => {
      const rows = catalogFor(seededRows().map(r => String(r.name)))
      const renamed = seededRows().map(r => ({ ...r, name: `${String(r.name)}_v2` }))
      const v = await verdictsFor(stateOn(['anchor-used'], renamed), rows)
      expect(v.gate.canSubmit).toBe(true)
    })

    it('covers EVERY anchored axis, not just the first — a collision on the second still counts', async () => {
      // The run writes to one axis per selected input, so resolving only the first anchor's
      // is a silent false negative: the form says yes and the second axis gets a duplicate.
      const rows = catalogFor(seededRows().map(r => String(r.name)))
      const v = await verdictsFor(stateOn(['anchor-fresh', 'anchor-used']), rows)
      expect(v.gate.canSubmit).toBe(false)
      expect([...v.verdicts.values()].some(x => x.kind === 'not_in')).toBe(true)
    })

    it('says nothing about names before an input is chosen', async () => {
      // With no anchor the slice is SKIPPED, so the taken-set is unknown rather than empty.
      // The form's complaint at that point is that no input is chosen, not that the names
      // are free — a message about names would be a claim the engine cannot support.
      const v = await verdictsFor(stateOn([]), catalogFor(seededRows().map(r => String(r.name))))
      expect(v.gate.canSubmit).toBe(false)
      expect([...v.verdicts.values()].some(x => x.kind === 'not_in')).toBe(false)
    })
  })

  it('manifest ships the analysis as DATA — annotate-only, raw-counts, code_ref stable', () => {
    const a = manifest.contributes.analyses.find(x => x.id === 'qc.10x') as Record<string, unknown>
    expect(a).toBeTruthy()
    expect(a.produces).toEqual(['metadata-column', 'report/qc']) // annotate-only (DEC-13)
    expect((a.run as { entry: string }).entry).toBe('compute/qc-10x.py') // stable code_ref
    // NO bespoke widget field — the metric UI is the declarative view, not a params widget.
    //
    // This used to walk `params.fields` looking for a `widget: qc-metric-list`. `params` is gone
    // from the contract entirely (INV-1: the manifest carries no form schema), so the property is
    // now structural rather than a scan: the manifest cannot name a widget because it has no key
    // that could hold one, and the UI it does name is a FILE it says nothing about.
    expect(a.params).toBeUndefined()
    expect(a.ui).toEqual(['ui/qc.yaml'])
    // …and the applicability fact that `params.fields` was wrapped around stands on its own.
    expect(a.appliesTo).toEqual([
      {
        slot: 'matrices',
        multiple: true,
        subtypes_of: 'single-cell/expression',
        excludes: ['single-cell/normalized'],
      },
    ])
  })

  // ── TEST-25's remaining clause: the keys the view may NOT carry ─────────────────
  //
  // `parseViewSpec` REFUSES `layout` (and the per-file `area`/`region`), so "parses
  // LOUD-clean" above already proves their absence — a spec that regained one would turn
  // the first case in this file red.
  //
  // `analysis:` is the exception, and that is why it needs its own line. The design says
  // the view carries "no `analysis:` key (the manifest declares the binding)", but the
  // parser is not key-denied at the top level, so a re-introduced back-pointer would be
  // ACCEPTED AND IGNORED — the precise shape DEC-3 rejected for the manifest's removed
  // keys ("a key that parses but is dropped leaves an author believing a declaration is
  // in force"). Nothing else in the tree would notice it.
  it('declares no `analysis:` back-pointer — the manifest owns the binding', () => {
    const top = rawView as Record<string, unknown>
    expect(top.analysis, 'the view names its own analysis; the `ui:` list is the binding').toBeUndefined()
    // …and the two the parser DOES refuse, asserted here as well so this reads as the
    // whole may-not set rather than one third of it.
    expect(top.layout).toBeUndefined()
    expect(top.area).toBeUndefined()
    expect(top.region).toBeUndefined()
  })

  // ── TEST-29's pane-content + run-gating clauses, over the SHIPPED spec ───────────
  //
  // Both were planned as browser assertions. The "…in ONE pane" half of that plan is now
  // STRUCTURAL rather than per-analysis (INV-3 keys the pane on the analysis; this one
  // declares a single `ui:` file), and it is pinned generically by
  // `loadProcessors.test.ts` + the INV-3 e2e. What remains specific to this view is that
  // its inputs are its OWN controls and that the primary action is gated on them — which
  // is a property of the shipped DATA, and therefore assertable here.
  it('the input control declares its OWN candidate source, and writes the state the run reads', () => {
    const picker = spec.widgets.find(w => w.id === 'matrixPicker') as {
      kind?: string
      multiple?: boolean
      value?: string
      onChange?: string
      source?: Record<string, unknown>
    }
    expect(picker, 'the view declares no input control at all').toBeTruthy()
    expect(picker.kind).toBe('artifact_ref')
    expect(picker.multiple).toBe(true)
    // The value it writes is the value the run block passes (asserted above as
    // `inputs.matrices === '$state.matrices'`), so the form and the launch agree.
    expect(picker.value).toBe('$state.matrices')
    expect(spec.actions.some(a => a.id === picker.onChange)).toBe(true)
    // INV-2 — the option set is the VIEW's own declaration. It is an inline `source`
    // object, not a `slot:` handing the question back to the manifest, and it carries a
    // narrowing the manifest could not express as a form field.
    expect(picker.source && typeof picker.source === 'object').toBe(true)
    expect(picker.source).not.toHaveProperty('slot')
    expect(Array.isArray(picker.source?.excludes)).toBe(true)
    expect((picker.source?.excludes as unknown[]).length).toBeGreaterThan(0)
  })

  it('Run is visible-but-DISABLED until every DECLARED requirement is met, and the gate discriminates', () => {
    // The Run control is found by FOLLOWING the declaration — the action that dispatches
    // the job, and the widget that names it — rather than by a written-down id. A renamed
    // action then moves this test with it instead of quietly making it find nothing.
    const runAction = spec.actions.find(a =>
      (a.body as Array<Record<string, unknown>>).some(e => 'run_processor' in e),
    )
    expect(runAction, 'the view declares no action that dispatches a job').toBeTruthy()
    const run = spec.widgets.find(w => (w as { onClick?: string }).onClick === runAction!.id) as {
      when?: string
      disabledWhen?: string
    }
    expect(run, 'the view declares no Run control').toBeTruthy()
    // NOT `when:` — hiding the primary action behind the message telling the user to
    // press it is the documented `DeclarativeRegion` deadlock.
    expect(run.when, 'a hidden Run button is the DeclarativeRegion deadlock').toBeUndefined()
    // …and NOT `disabledWhen` either, any more. The gate is DERIVED from the requirements
    // each control declares; a hand-written whole-form predicate beside them is a second
    // encoding of the same rule, and this view shipped one that was WRONG (see the
    // partially-answered case below).
    expect(
      run.disabledWhen,
      'the Run gate is derived from the controls\' own `require` declarations — a parallel ' +
        'predicate can disagree with what the fields say, and this one did',
    ).toBeUndefined()

    // The gate is driven through the REAL engine, over the REAL shipped spec. Each
    // requirement is broken independently, so a verdict that happens to be false for the
    // wrong reason cannot pass.
    const at = (state: Record<string, unknown>): boolean =>
      !evaluateForm(spec, { params: {}, state, derived: {}, const: spec.const ?? {}, data: {} } as Scope)
        .gate.canSubmit

    // Both list keys are read from the spec's own `run_processor` inputs rather than spelled
    // here. Two reasons, and the second is why it is worth the indirection: the test cannot
    // drift from the package it is testing (renaming the key in the yaml fails here instead of
    // silently testing a key nothing uses), and the app-side test carries none of the
    // package's vocabulary — which is the property the domain guard is defending.
    const inputs = (
      runAction!.body as Array<{ run_processor?: { inputs?: Record<string, string> } }>
    ).find(e => e.run_processor)!.run_processor!.inputs!
    const anchorKey = 'matrices'
    const pairedKey = Object.values(inputs)
      .map(ref => ref.replace('$state.', ''))
      .find(key => key !== anchorKey)
    expect(pairedKey, 'the run declares no per-anchor paired slot to gate on').toBeTruthy()

    // A valid ROW is built from the table's OWN declarations — DISCOVERED rather than
    // written out, so this test would not pass unchanged the day one of those fields stopped
    // being required. The discovery runs the engine over a row that answers NOTHING and reads
    // back which per-row addresses complained; the address vocabulary carries the column key,
    // which is precisely what makes "row N shows row N's message" expressible at all.
    const table = spec.widgets.find(w => w.kind === 'table') as { id?: string; rows?: string }
    const rowsKey = String(table.rows).replace('$state.', '')
    const probe = evaluateForm(spec, {
      params: {},
      state: { [rowsKey]: [{}] },
      derived: {},
      const: spec.const ?? {},
      data: {},
    } as Scope)
    const rowAddressPrefix = `${table.id}#0#`
    const requiredFields = [...probe.verdicts.keys()]
      .filter(k => k.startsWith(rowAddressPrefix))
      .map(k => k.slice(rowAddressPrefix.length).split(':')[0])
    // PINNED, not merely non-zero. The list is DISCOVERED, so a field that stopped being
    // required would silently shrink it and every loop below would keep passing over the
    // remainder — a test that adapts to the regression it exists to catch. Re-anchor this
    // number deliberately when the row editor gains or loses a required field.
    expect(
      requiredFields.length,
      'the number of required per-row fields moved. If that was intended, re-anchor this ' +
        'number in the same change; if it was not, a row field stopped being required and ' +
        'the blank-row cases below quietly stopped covering it.',
    ).toBe(2)
    const row = (suffix: string): Record<string, unknown> =>
      Object.fromEntries(requiredFields.map(f => [f, `${f}-${suffix}`]))

    // Each complaint is addressed to ONE column of ONE row. A verdict keyed on the table
    // alone would collide across every row, and a form that shows row 0's message on row 3
    // reads as completely normal.
    const perRow = evaluateForm(spec, {
      params: {},
      state: { ...{}, [rowsKey]: [row('a'), {}] },
      derived: {},
      const: spec.const ?? {},
      data: {},
    } as Scope)
    expect(
      [...perRow.verdicts.keys()].filter(k => k.startsWith(`${table.id}#0#`)).sort(),
      'only the second row is unanswered, so only the second row may be complained about',
    ).toEqual(requiredFields.map(f => `${table.id}#0#${f}:1`).sort())

    const ok: Record<string, unknown> = {
      [anchorKey]: ['art-1'],
      [rowsKey]: [row('a')],
      [pairedKey!]: ['g-1'],
    }

    expect(at({ ...ok, [anchorKey]: [] }), 'no anchor input — nothing to compute over').toBe(true)
    expect(
      at({ ...ok, [rowsKey]: [] }),
      'no metric rows — the run would emit no columns at all, and the compute says so',
    ).toBe(true)
    expect(
      at({ ...ok, [pairedKey!]: [] }),
      'the paired slot is list-ALIGNED with the anchor; unpaired, the compute exits 2 naming ' +
        'the slot it could not fill',
    ).toBe(true)
    expect(
      at({ ...ok, [anchorKey]: ['art-1', 'art-2'], [pairedKey!]: ['g-1'] }),
      'PARTIALLY paired is still unpaired — one entry for two anchors leaves the second with ' +
        'nothing to match patterns against',
    ).toBe(true)

    // ── the case the DELETED predicate let through ────────────────────────────────────
    //
    // The old gate compared LENGTHS: `paired.length < anchor.length`. The write-back assigns
    // BY INDEX, so answering only the THIRD picker leaves holes at 0 and 1 with `length === 3`
    // — `3 < 3` is false, Run enabled, and two anchors reached the compute with nothing bound.
    // That is not a hypothetical: it is the refusal the deleted predicate was added to
    // prevent, reachable by answering the pickers in any order but left-to-right.
    //
    // A per-instance requirement is asked once per rendered control, so the holes are exactly
    // what it sees. Reverting to the length comparison makes this line — and only this line —
    // go red, which is why it is built sparsely rather than by truncating the list.
    const sparse: unknown[] = []
    sparse[2] = 'g-3'
    expect(sparse.length, 'the sparse case must actually be sparse, or it proves nothing').toBe(3)
    expect(
      at({ ...ok, [anchorKey]: ['art-1', 'art-2', 'art-3'], [pairedKey!]: sparse }),
      'answering only the LAST picker leaves the earlier ones unanswered — a length comparison ' +
        'cannot see a hole, and a per-control requirement is asked once per control',
    ).toBe(true)

    // A row whose required fields are BLANK — reachable by one click of the add affordance,
    // and fatal in the compute, which refuses a row with an empty pattern rather than
    // substituting one (the empty regex matches everything and reports ~100 % everywhere).
    for (const field of requiredFields) {
      expect(
        at({ ...ok, [rowsKey]: [{ ...row('a'), [field]: '' }] }),
        `a row with a blank "${field}" is refused by the compute, so the form refuses first`,
      ).toBe(true)
    }

    // Two blank rows additionally COLLIDE (`DuplicateMetricName`, likewise fatal) — and that
    // is a different remedy from "fill this in", so it is reported as its own violation.
    const blank = Object.fromEntries(requiredFields.map(f => [f, '']))
    const twoBlank = evaluateForm(spec, {
      params: {},
      state: { ...ok, [rowsKey]: [blank, { ...blank }] },
      derived: {},
      const: spec.const ?? {},
      data: {},
    } as Scope)
    expect(twoBlank.gate.canSubmit).toBe(false)
    expect(
      [...twoBlank.verdicts.values()].some(v => v.kind === 'unique_by'),
      'two rows sharing a name must be reported AS a duplicate, not merely as two blanks',
    ).toBe(true)
    // …and a duplicate between two FILLED rows is caught on its own, so the assertion above
    // is not riding on the blanks.
    expect(
      at({ ...ok, [rowsKey]: [row('a'), { ...row('a') }] }),
      'two filled rows sharing every required field are still a duplicate',
    ).toBe(true)

    // …and it ENABLES only when every requirement is met — the control case, without which
    // every assertion above passes for a gate that is simply always closed.
    expect(at(ok), 'Run must enable once the anchor, a metric row and the pairing all exist').toBe(
      false,
    )
  })
})

// ── the PRESET CATALOG (REPORTED) ──────────────────────────────────────────────────────
//
// "there should be some add predefine metrics and show user the metrics they can add,
//  hemoglobin should be in there too, total counts, mito, robo should be in there too"
//
// Each preset used to be a BESPOKE action + button pair carrying a hardcoded row, so a preset
// existed if and only if somebody had hand-written a widget for it. The four seeded defaults had
// no add affordance at all: delete one and the only route back was a custom row where the user
// retypes its pattern from memory. The fix is the CLASS, not the instances — ONE catalog as
// DATA, ONE generic add action, and a browsable picker that says what each metric matches.
describe('the predefined metrics are ONE catalog, browsable, with ONE way in', () => {
  const spec = parseViewSpec(rawView).value as ViewSpec
  type Preset = {
    value?: string
    label?: string
    description?: string
    when?: string
    metric?: Metric
  }
  const catalog = (): Record<string, Preset> => spec.const?.metricPresets as Record<string, Preset>
  const presets = (): Preset[] => Object.values(catalog())
  /** The action each rendered affordance dispatches — read off the widget, never named here, so
   *  this tier states no id of the contributed package. */
  const actionOf = (widgetId: string): string =>
    String((spec.widgets.find(w => w.id === widgetId) as { onClick?: string }).onClick)
  /** The add action, read off the PICKER's own change. There is no Add button any more: choosing
   *  IS the action, so the affordance that dispatches it is the control that carries the choice. */
  const addPresetAction = (): string =>
    String((spec.widgets.find(w => w.id === 'presetPicker') as { onChange?: string }).onChange)
  /** A form whose ARTIFACT inputs are answered — one entry per list-valued input the run
   *  declares, named off the spec so this tier states no slot of its own. What is under test
   *  below is the metric list, and an unanswered input beside it would close the gate for a
   *  reason that has nothing to do with the question being asked. */
  const answeredInputs = (): Record<string, unknown> => {
    const run = spec.actions.find(a =>
      (a.body as Array<Record<string, unknown>>).some(op => 'run_processor' in op),
    )!
    const rp = (run.body as Array<{ run_processor?: { inputs?: Record<string, string> } }>).find(
      e => e.run_processor,
    )!.run_processor!
    const out: Record<string, unknown> = {}
    for (const binding of Object.values(rp.inputs ?? {})) {
      const field = /\$state\.([A-Za-z0-9_]+)/.exec(binding)?.[1]
      if (field) out[field] = ['a1']
    }
    return out
  }
  /** The names a FRESH form is pre-filled with, resolved through the real store. */
  const seededNames = (): string[] => {
    const store = createViewStore(spec, `qc-seeded-${Math.random()}`)
    try {
      return (store.state.qc_metrics as Metric[]).map(m => String(m.name))
    } finally {
      store.dispose()
    }
  }
  const customAddAction = (): string => actionOf('addMetricBtn')

  it('holds every predefined metric, including the ones that only had a hand-written button', () => {
    // The four that WERE seeded and had no add affordance, plus the two that WERE affordances
    // and lived nowhere else. The seeded four are read back from the SEED rather than restated
    // here, so this says the relation ("the catalog is the defaults plus the optional ones")
    // instead of a list that would have to be edited twice.
    const optional = ['pct_hb', 'pct_isotype']
    expect(Object.keys(catalog()).sort()).toEqual(
      [...seededNames(), ...optional].sort(),
    )
  })

  it('every entry is complete enough to BE a metric and to be BROWSED as one', () => {
    const closed = aggregationValues(spec)
    for (const [key, p] of Object.entries(catalog())) {
      expect(p.value, `${key} is addressed by its own value`).toBe(key)
      expect(p.label, `${key} is labelled`).toBe(key)
      expect(
        String(p.description ?? ''),
        `${key} says nothing about what it matches — a picker that lists names alone is a list ` +
          'of things the user has to already know',
      ).not.toBe('')
      // …and the row it appends is a real one: the compute REFUSES a row with no MATCH PATTERN
      // (an empty regex matches everything and reports ~100 % on every row) or with an
      // aggregation outside the closed set.
      expect(p.metric?.name, `${key} names its emitted column`).toBe(key)
      expect(String(p.metric?.pattern ?? ''), `${key} carries a real match pattern`).not.toBe('')
      expect(closed, `${key}'s aggregation is in the closed set`).toContain(p.metric?.aggregation)
    }
  })

  it('a capability requirement is carried by the ENTRY, so a gated metric is simply not offered', () => {
    // The isotype preset used to be gated by `when: has:protein` on its own BUTTON. The gate
    // survives into the catalog rather than into a widget, which is what makes adding the next
    // capability-gated preset a data change.
    expect(catalog().pct_isotype.when).toBe('has:protein')
    // …and it is the ONLY gated entry: a gate that crept onto the rest would make the picker
    // empty on ordinary data, which reads as a broken control rather than as a narrowed one.
    for (const [key, p] of Object.entries(catalog())) {
      if (key === 'pct_isotype') continue
      expect(p.when, `${key} needs no capability`).toBeUndefined()
    }
    // …and the gate is a real one, in the real grammar: false with no capabilities, true with
    // the one it names.
    const gate = (caps: string[]): boolean =>
      evalWhen(catalog().pct_isotype.when, { caps } as unknown as Scope)
    expect(gate([])).toBe(false)
    expect(gate(['protein'])).toBe(true)
  })

  it('there is exactly ONE add action, and NO per-preset action or button survives', () => {
    const appendActions = spec.actions.filter(a =>
      (a.body as Array<Record<string, unknown>>).some(
        op => (op as { listAppend?: { path?: string } }).listAppend?.path === 'qc_metrics',
      ),
    )
    // Two: the generic preset add, and the blank custom row — and both are the target of a
    // rendered affordance, read off the widgets rather than named here.
    expect(appendActions.map(a => a.id).sort()).toEqual(
      [addPresetAction(), customAddAction()].sort(),
    )
    for (const gone of ['qc.addHb', 'qc.addIsotype', 'qc.addTss']) {
      expect(spec.actions.some(a => a.id === gone), `${gone} still exists`).toBe(false)
    }
    for (const gone of ['addHbBtn', 'addIsotypeBtn', 'addTssBtn']) {
      expect(spec.widgets.some(w => w.id === gone), `${gone} still exists`).toBe(false)
    }
    // No add action carries a metric row INLINE any more — that literal is what made a preset a
    // widget rather than a datum.
    const addPreset = spec.actions.find(a => a.id === addPresetAction())!
    const appended = (addPreset.body as Array<{ listAppend?: { value?: unknown } }>).find(
      op => op.listAppend,
    )!.listAppend!.value as Record<string, string>
    for (const v of Object.values(appended)) {
      expect(String(v).startsWith('$'), `the appended row hardcodes ${JSON.stringify(v)}`).toBe(true)
    }
  })

  it('the picker OFFERS the catalog, with what each metric matches as the option’s second line', () => {
    const picker = spec.widgets.find(w => w.id === 'presetPicker') as {
      kind: string
      options?: string
      value?: string
      onChange?: string
    }
    expect(picker.kind).toBe('select')
    // Every entry, so a preset added to the catalog is offered without touching a widget.
    expect(picker.options).toBe('$const.metricPresets[*]')
    expect(spec.actions.some(a => a.id === picker.onChange)).toBe(true)
    // CHOOSING IS THE ACTION. There is no separate Add affordance, and there must not be one:
    // a second step whose only possible outcome is the thing the choice already said is a press
    // that carries no decision. Asserted as an ABSENCE, because re-adding a confirm step is the
    // regression, and it would otherwise pass silently beside a picker that still works.
    // Stated as "nothing ELSE dispatches the add", not "no widget is named add-something": the
    // custom-metric button is a different affordance that appends a blank row, and a name-shaped
    // assertion would forbid it for no reason while still permitting a confirm step called
    // anything else.
    const dispatchers = spec.widgets
      .filter(w => (w as { onClick?: string }).onClick === addPresetAction() ||
                   (w as { onChange?: string }).onChange === addPresetAction())
      .map(w => w.id)
    expect(
      dispatchers,
      'only the picker adds a preset — a second step whose one outcome is what the choice ' +
        'already said is a press that carries no decision',
    ).toEqual(['presetPicker'])
    expect((picker as { require?: unknown }).require, 'adding a preset is optional').toBeUndefined()
  })

  /** Run the shipped add action over a live store — the REAL interpreter, the REAL catalog. */
  const addChosen = async (choice: string, rows: Metric[]): Promise<Record<string, unknown>> => {
    // The choice arrives as a PARAM, exactly as the picker's change delivers it — not seeded into
    // state and read back, which would test a path the control no longer takes.
    const store = liveMockStore({ qc_metrics: rows, presetChoice: choice })
    const derived = { presetByValue: catalog() }
    const add = spec.actions.find(a => a.id === addPresetAction())!
    await interpretBody(
      add.body,
      { view_id: 'v', value: choice },
      makeCtx({ viewStore: () => ({ ...store, derived }) as unknown as InterpreterStore }),
    )
    return store.state
  }

  it('adds the CHOSEN preset’s row, and spends the choice so the affordance goes again', async () => {
    const state = await addChosen('pct_hb', [])
    expect(state.qc_metrics).toEqual([catalog().pct_hb.metric])
    // ITEM-28 / INV-2 — `null`, not `''`. The spent choice is UNSET, and null is now the only
    // spelling of unset a closed-set-bound field may hold; `''` would be a value somebody chose.
    expect(state.presetChoice, 'the choice is spent, not left standing').toBeNull()
  })

  it('adding a preset ALREADY in the table is REFUSED — never a silent second column', async () => {
    // Composed with the constraint that already exists rather than around it. `unique_by: name`
    // is not decoration here: each name becomes an EMITTED COLUMN, storage does not key on the
    // name, and the compute raises `DuplicateMetricName`. Driven all the way through — add the
    // same preset twice through the real action, then ask the real form what it thinks.
    const gate = (rows: unknown[]): ReturnType<typeof evaluateForm> =>
      evaluateForm(spec, {
        params: {},
        state: { ...answeredInputs(), presetChoice: '', qc_metrics: rows },
        derived: {},
        const: spec.const ?? {},
        data: { existingColumns: {} },
      } as Scope)
    const once = (await addChosen('pct_hb', [])).qc_metrics as Metric[]
    expect(gate(once).gate.canSubmit, 'one copy is fine — the positive control').toBe(true)
    const twice = (await addChosen('pct_hb', once)).qc_metrics as Metric[]
    expect(twice, 'the duplicate is not silently swallowed either').toHaveLength(2)
    const v = gate(twice)
    expect(v.gate.canSubmit, 'a duplicated metric is refused BEFORE the run').toBe(false)
    const duplicate = [...v.verdicts.values()].find(x => x.kind === 'unique_by')
    expect(duplicate, 'and it is refused AS a duplicate, by name').toBeTruthy()
    expect(duplicate!.message).toMatch(/name/i)
  })

  it('the SEEDED defaults are the catalog’s own entries — one source, not a second copy', () => {
    // "with defaultMetrics referencing a subset": the seeded rows are RESOLVED from the catalog
    // at store-init, so a pattern edited in the catalog moves the seed with it. A restated list
    // is how the four defaults came to be written out in three places.
    const store = createViewStore(spec, 'qc-seed-from-catalog')
    try {
      const seeded = store.state.qc_metrics as Metric[]
      expect(seeded, 'the seed is not empty').toHaveLength(4)
      for (const m of seeded) {
        expect(m, `${m.name} is the catalog's own row`).toEqual(catalog()[m.name!].metric)
      }
      // …and the catalog is STRICTLY larger: the optional presets are there to be ADDED, and a
      // seed that swallowed them would impose a metric nobody asked for.
      expect(Object.keys(catalog()).length).toBeGreaterThan(seeded.length)
      for (const key of ['pct_hb', 'pct_isotype']) {
        expect(seeded.some(m => m.name === key), `${key} is offered, not imposed`).toBe(false)
      }
    } finally {
      store.dispose()
    }
  })
})
