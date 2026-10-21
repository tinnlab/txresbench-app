// Declarative-engine GALLERY FIXTURES (declarative-rendering-hardening Slice 3, F4 —
// ITEM-11).
//
// Before this there was ZERO gallery / `gate:ui` coverage of ANY declarative surface — and
// EVERY processor UI renders through this engine, so its default quality was unverified at
// any width and a regression in the shared layer was invisible until a human noticed it
// in-app. Six of these fixtures are the representative surfaces the audit named; each is
// mounted at ~390px AND wide. The seventh — `criteria-table` — is mounted at the SIDE PANE's
// own width band instead (see {@link criteriaTableSpec}), because "fits" is a claim about a
// width and the widths that matter are the ones a dock pane can actually be. Every surface is
// enumerated automatically by the runtime-health + Layer-A passes.
//
// The fixtures are DATA, exactly like a real processor's `ui/<p>.yaml` — never bespoke React.
// That is deliberate: a fixture authored in the same language as the real thing cannot drift
// from the engine, and `fixtureSpecs.test.ts` parses every one of them through the SHIPPED
// `parseViewSpec` so a schema change breaks the fixtures loudly.
//
// Domain note: this file IS SCANNED by `scripts/lint-no-domain-in-builtin.mjs`. It used to
// claim the opposite — that a `/gallery/` path "exempts by construction" — and that stopped
// being true when WS-B retired the blanket `/gallery/` DIRECTORY exemption; the guard's own
// header now names `core/gallery/*.ts` as ordinary production core. The column names below
// are FIXTURE prose rather than app knowledge, and they are recorded in
// `scripts/domain-baseline.json` like every other retained hit — which is a weaker and
// truer statement than "exempt".

import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { ROW_PART_KEY } from '@/modules/workbench/core/spec/schema'
import {
  DEFAULT_REGION_PREFS,
  SIDE_REGION_WIDTH_MIN,
} from '@/modules/workbench/core/shell/regions/regionsPersistence'

/** The one CATEGORICAL column of the frame below — named, because the criteria-table fixture
 *  has to build a row ON it (a table of one control kind cannot show that a per-row gate picks
 *  between two), and a second spelling of the same column name would be a second entry in a
 *  ledger that only shrinks. */
const CATEGORICAL_COLUMN = 'sample'
/** The two CONTINUOUS columns the criteria-table fixture thresholds on. Same reason. */
const CONTINUOUS_COLUMN_A = 'count_a'
const CONTINUOUS_COLUMN_B = 'fraction_c'

/** The columnar frame the `loaded` / stress / long-label fixtures paint from. Small + synthetic.
 *  Named for what it IS to a reader outside this module (a `{ column: values[] }` frame) rather
 *  than for the slice key it happens to be served under. */
export const FIXTURE_FRAME: Record<string, unknown[]> = {
  [CATEGORICAL_COLUMN]: ['s1', 's1', 's2', 's2', 's2', 's3'],
  [CONTINUOUS_COLUMN_A]: [1000, 2000, 3000, 500, 1500, 2500],
  count_b: [300, 600, 900, 150, 450, 750],
  [CONTINUOUS_COLUMN_B]: [2, 5, 8, 40, 12, 3],
}

/** A 180-character label — the long-label case (a real processor CAN declare one, and the
 *  form must not break). */
export const LONG_LABEL =
  'Minimum number of detected features per cell, applied before normalization and after ' +
  'ambient-RNA correction, expressed as an absolute count rather than a percentile rank'

/** The shared control/action vocabulary every fixture reuses, so the fixtures differ ONLY in
 *  the dimension under test (data availability, repetition count, label length, validity). */
function baseActions(): ViewSpec['actions'] {
  return [
    {
      id: 'fx.setColumn',
      title: 'Set the picked column',
      permission: 'jobs::use',
      mutating: true,
      stateful: true,
      params: { value: 'string', index: 'number' },
      body: [{ set: { 'criteria.{$params.index}.column': '$params.value' } }],
    },
    {
      id: 'fx.setPick',
      title: 'Set the picked column',
      permission: 'jobs::use',
      mutating: true,
      stateful: true,
      params: { value: 'string' },
      body: [{ set: { pick: '$params.value' } }],
    },
    {
      id: 'fx.setKeep',
      title: 'Set the keep-set',
      permission: 'jobs::use',
      mutating: true,
      stateful: true,
      params: { value: 'string' },
      body: [{ set: { keep: '$params.value' } }],
    },
    {
      id: 'fx.addCriterion',
      title: 'Add a criterion',
      permission: 'jobs::use',
      mutating: true,
      stateful: true,
      params: {},
      body: [{ listAppend: { path: 'criteria', value: { column: '' } } }],
    },
    {
      id: 'fx.removeCriterion',
      title: 'Remove a criterion',
      permission: 'jobs::use',
      mutating: true,
      stateful: true,
      params: { index: 'number' },
      body: [{ listRemove: { path: 'criteria', index: '$params.index' } }],
    },
  ] as ViewSpec['actions']
}

/** Every fixture declares the SAME `data.obs` slice, so the ONLY thing that differs between
 *  the loaded / empty / error surfaces is what the host does — which is precisely the
 *  distinction F3 says the user must be able to see. */
const OBS_DECL = { obs: { source: 'job.result', args: { path: '/obs', datatype: 'fixture/obs' } } }

/** The `$`-ref every frame-consuming `derived` kernel below binds — the ONE slice the
 *  declaration above names, read off it rather than restated. Same reason the column names are
 *  named: a fixture that repeats the binding at each kernel repeats the slice key too. */
const FRAME_REF = `$data.${Object.keys(OBS_DECL)[0]}`

function baseSpec(id: string, title: string, criteria: unknown[]): ViewSpec {
  return {
    id,
    title,
    permission: 'jobs::use',
    state: {
      criteria: { type: 'list', default: criteria },
      pick: { type: 'string', default: null },
      keep: { type: 'list', default: [] },
    },
    const: {},
    data: OBS_DECL,
    derived: {
      // r3canvas: the kernel operand is spelled `frame:` — the domain-neutral name for a
      // `{ column: values[] }` map. The DATA key it points at is still `obs`: that is this
      // fixture's own choice of slice name, which core no longer knows anything about.
      columns: { columns_of: { frame: FRAME_REF } },
      catColumns: { columns_of: { frame: FRAME_REF, only: 'categorical' } },
    },
    widgets: [
      {
        id: 'criterionRow',
        kind: 'group',
        for_each: '$state.criteria as $c, $i',
        label: 'Criterion',
        children: [
          {
            id: 'critColumn',
            kind: 'select',
            label: 'Column',
            options: '$derived.columns',
            value: '$c.column',
            args: { index: '$i' },
            onChange: 'fx.setColumn',
          },
          {
            id: 'critRemove',
            kind: 'button',
            label: 'Remove criterion',
            args: { index: '$i' },
            onClick: 'fx.removeCriterion',
          },
        ],
      },
      { id: 'addCriterion', kind: 'button', label: 'Add criterion', variant: 'primary', onClick: 'fx.addCriterion' },
      {
        id: 'groupBy',
        kind: 'select',
        label: 'Group by',
        options: '$derived.catColumns',
        value: '$state.pick',
        onChange: 'fx.setPick',
      },
      {
        id: 'keepSet',
        kind: 'multiselect',
        label: 'Keep categories',
        options: '$derived.catColumns',
        value: '$state.keep',
        onChange: 'fx.setKeep',
      },
      { id: 'sourceDataset', kind: 'dataset-picker', label: 'Source dataset', value: '$state.pick' },
    ],
    actions: baseActions(),
  } as unknown as ViewSpec
}

function criteriaRows(n: number): unknown[] {
  return Array.from({ length: n }, (_, i) => ({ column: i % 2 === 0 ? 'count_a' : 'fraction_c' }))
}

// ── the six fixtures ─────────────────────────────────────────────────────────

/** LOADED — the populated control case. Two criterion rows, real data columns behind every
 *  picker. This is the surface the design-critic review reads. */
export const loadedSpec = (): ViewSpec => baseSpec('fixture/loaded', 'Fixture — loaded', criteriaRows(2))

/** EMPTY-DATA — identical spec; the host simply has no artifact of the declared datatype.
 *  Must render the explicit no-data state, NOT a dead form. */
export const emptyDataSpec = (): ViewSpec => baseSpec('fixture/empty', 'Fixture — no data yet', criteriaRows(2))

/** ERROR-DATA — identical spec; the host REJECTS. Must render a named, retryable alert —
 *  and must be visibly different from the empty case (INV-1). */
export const errorDataSpec = (): ViewSpec => baseSpec('fixture/error', 'Fixture — data failed to load', criteriaRows(2))

/** FOR_EACH STRESS — 50 repeated criterion groups (well under `FOR_EACH_MAX = 1000`, DEC-12):
 *  this measures render cost + the region's scroll/width behavior under many repeated blocks,
 *  not the cap. */
export const FOREACH_STRESS_COUNT = 50
export const foreachStressSpec = (): ViewSpec =>
  baseSpec('fixture/stress', 'Fixture — 50 criteria', criteriaRows(FOREACH_STRESS_COUNT))

/** LONG-LABEL — one control carrying a 180-char label. The label must wrap inside the form
 *  column instead of pushing the control out of the container at ANY width. */
export const longLabelSpec = (): ViewSpec => {
  const s = loadedSpec() as ViewSpec & { id: string; title: string; widgets: Array<Record<string, unknown>> }
  s.id = 'fixture/long-label'
  s.title = 'Fixture — long label'
  const groupBy = s.widgets.find(w => w.id === 'groupBy') as Record<string, unknown> | undefined
  if (groupBy) groupBy.label = LONG_LABEL
  return s
}

/**
 * MALFORMED-WIDGET — a widget whose `for_each` clause is syntactically INVALID
 * (`"$state.criteria"` with no `as $item`). It parses LOUD-clean (the schema does not
 * validate clause syntax) and THROWS inside `expandForEach` at render, which is exactly the
 * degrade path `WidgetErrorBoundary` exists for: the sibling widgets keep rendering and the
 * broken one becomes a NAMED, retryable placeholder (F8). A processor really can ship this.
 */
export const malformedWidgetSpec = (): ViewSpec => {
  const s = loadedSpec() as ViewSpec & {
    id: string
    title: string
    widgets: Array<Record<string, unknown>>
    layout: { regions: Record<string, unknown> }
  }
  s.id = 'fixture/malformed'
  s.title = 'Fixture — malformed widget'
  // The broken widget is a SEPARATE widget, not the criteria row: the criteria row stays
  // healthy so a test can drive a real state mutation (Add criterion → a visible new row) and
  // still observe that the broken widget's placeholder LATCHED through it. Reusing the
  // criteria row for both jobs made the latch test's control idle — it could not tell "the
  // boundary held" from "the click did nothing".
  s.widgets = [
    ...s.widgets,
    {
      id: 'brokenRow',
      kind: 'group',
      label: 'Broken',
      for_each: '$state.criteria', // missing `as $c, $i` → invalid clause → throws at render
      children: [{ id: 'brokenChild', kind: 'button', label: 'never rendered' }],
    },
  ]
  // (Appending to `widgets` IS the placement now — INV-3 removed `layout.regions`, so the
  // broken row no longer has to be named a second time to be rendered.)
  return s
}

/**
 * CRITERIA-TABLE — the `table` primitive as a real processor ships it, mounted at the widths a
 * side DOCK PANE can actually be.
 *
 * It exists because the table was the one widget in this engine with no width story. Every other
 * control composes `WidgetField`, which is `w-full max-w-md`, so it sizes to the form column;
 * the table returned a bare `<div>` into a `RegionBody` that is `items-start`, so it sized to its
 * own CONTENT and pushed straight out of the pane — the grid's own `overflow-x-auto` could never
 * engage, because its container was never narrower than what it held.
 *
 * Two properties make this fixture able to SHOW that, and neither is optional:
 *
 *   · the rows are a MIX. A per-row `when` picks a different control for a continuous row than
 *     for a categorical one, so a table of one kind cannot demonstrate that both fit — it can
 *     only demonstrate that the one it happens to hold does.
 *   · the frames are the DOCK's own widths (`SIDE_REGION_WIDTH_MIN` … `DEFAULT_REGION_PREFS`),
 *     imported rather than typed. A pane is user-resizable down to the minimum with one drag, so
 *     "fits at the default" is not the claim; "fits at the default and SCROLLS INSIDE ITSELF at
 *     the minimum" is.
 */
export const criteriaTableSpec = (): ViewSpec =>
  ({
    id: 'fixture/criteria-table',
    title: 'Fixture — criteria table',
    permission: 'jobs::use',
    state: {
      // A MIX, and one of each shape a row can be in: a two-sided range, a one-sided range
      // (blank upper bound is the ordinary case), and a keep-set. `column: ''` is deliberately
      // absent — an unanswered row is the `loaded` fixture's job, and here every row must
      // actually DRAW a control or the widths measure nothing.
      criteria: {
        type: 'list',
        default: [
          { column: CONTINUOUS_COLUMN_A, min: '500', max: '2500', keep: [] },
          { column: CATEGORICAL_COLUMN, min: '', max: '', keep: ['s2'] },
          { column: CONTINUOUS_COLUMN_B, min: '3', max: '', keep: [] },
        ],
      },
      pick: { type: 'string', default: null },
      label: { type: 'string', default: '' },
    },
    const: {},
    data: OBS_DECL,
    derived: {
      columns: { columns_of: { frame: FRAME_REF } },
      controlByColumn: { columns_of: { frame: FRAME_REF, keyed: true } },
      catColumns: { columns_of: { frame: FRAME_REF, only: 'categorical' } },
      categoriesByColumn: { categories_by_column: { frame: FRAME_REF } },
    },
    widgets: [
      {
        id: 'criteriaTable',
        kind: 'table',
        rows: '$state.criteria',
        // A DEPENDENT candidate binding, so INV-5 (ITEM-63) requires the emptiness be stated.
        // Declared here for the same reason ITEM-28's `null`-is-the-only-unset migration
        // touched these fixtures: they are parsed by the SHIPPED validator, so they have to be
        // specs the shipped validator accepts.
        empty_text: 'No criteria yet.',
        columns: [
          {
            key: 'column',
            title: 'Column',
            [ROW_PART_KEY]: {
              select: {
                value: '$row.column',
                options: '$derived.columns',
                onChange: 'fx.setCriterionField',
              },
            },
          },
          {
            // The MUTUALLY EXCLUSIVE controls, in ONE column. A row's column is either
            // continuous (bounds apply, a keep-set is meaningless) or categorical (the
            // reverse), so a column each reserves permanent width for a control that row can
            // never use — which is what pushed the grid past its pane.
            key: 'constraint',
            title: 'Constraint',
            parts: [
              {
                key: 'min',
                [ROW_PART_KEY]: {
                  editable_text: {
                    when: '$derived.controlByColumn[$row.column] == range',
                    value: '$row.min',
                    placeholder: 'Min',
                    onChange: 'fx.setCriterionField',
                    require: { number: {} },
                  },
                },
              },
              {
                key: 'max',
                [ROW_PART_KEY]: {
                  editable_text: {
                    when: '$derived.controlByColumn[$row.column] == range',
                    value: '$row.max',
                    placeholder: 'Max',
                    onChange: 'fx.setCriterionField',
                    require: { number: {} },
                  },
                },
              },
              {
                key: 'keep',
                [ROW_PART_KEY]: {
                  multiselect: {
                    when: '$derived.controlByColumn[$row.column] == multiselect',
                    value: '$row.keep',
                    options: '$derived.categoriesByColumn[$row.column]',
                    placeholder: 'All categories',
                    onChange: 'fx.setCriterionField',
                  },
                },
              },
            ],
          },
          {
            key: 'remove',
            title: '',
            [ROW_PART_KEY]: {
              button: {
                label: 'Remove',
                icon: 'remove',
                variant: 'destructive',
                onClick: 'fx.removeCriterion',
              },
            },
          },
        ],
      },
      { id: 'addCriterion', kind: 'button', label: 'Add criterion', variant: 'primary', onClick: 'fx.addCriterion' },
      {
        id: 'groupBy',
        kind: 'select',
        label: 'Group by',
        options: '$derived.catColumns',
        value: '$state.pick',
        onChange: 'fx.setPick',
      },
      { id: 'labelInput', kind: 'text', label: 'Label', value: '$state.label', onChange: 'fx.setLabel' },
    ],
    // The cross-field relation lands on the ROW's own Max — the address a folded part still
    // answers to, because folding changes where a part is DRAWN and not what it is CALLED.
    checks: [
      {
        id: 'minAboveMax',
        for_each: '$state.criteria as $c, $i',
        fails_when: "$c.min != '' && $c.max != '' && $c.min > $c.max",
        at: { widget: 'criteriaTable', part: 'max', index: '$i' },
        message: 'Min is above Max, so this criterion keeps nothing.',
      },
    ],
    actions: [
      ...(baseActions() ?? []),
      {
        id: 'fx.setCriterionField',
        title: 'Set a criterion field',
        permission: 'jobs::use',
        mutating: true,
        stateful: true,
        params: { index: 'number', key: 'string', value: 'string' },
        body: [{ set: { 'criteria.{$params.index}.{$params.key}': '$params.value' } }],
      },
      {
        id: 'fx.setLabel',
        title: 'Set the label',
        permission: 'jobs::use',
        mutating: true,
        stateful: true,
        params: { value: 'string' },
        body: [{ set: { label: '$params.value' } }],
      },
    ],
  }) as unknown as ViewSpec

/** The empty-state sentence the fresh-form fixture declares. A CONSTANT so the Layer-A spec can
 *  assert the DECLARED string reached the screen rather than matching prose it typed itself —
 *  which would pass for a renderer that hardcodes its own wording and ignores the declaration. */
export const FIXTURE_EMPTY_TEXT =
  'No entries yet. An entry is one line of the list this run works through — add the first with ' +
  'the button below.'

/**
 * FRESH FORM — a form in the state every user meets it in: nothing answered yet.
 *
 * It is the one state the other fixtures cannot show, and two engine promises are only visible in
 * it:
 *
 *   · a list-valued control with NOTHING in it must render an empty STATE, not a grid of headings
 *     over a void. A titled, populated-LOOKING frame at the moment the reader knows least reads as
 *     "this part is done", which is the opposite of true.
 *   · the control that STARTS the work must be findable as that control. It sits in a footer —
 *     a muted bar, action at the end — derived by the engine from the fact that its action
 *     dispatches a run, never declared per view.
 *
 * The list is deliberately REQUIRED and empty, so the footer is drawn in its full form: the
 * action, disabled, WITH the unmet requirement stated above it. A footer holding only an enabled
 * button would leave the half that has to be legible untested.
 *
 * `runBtn` and `addRow` differ ONLY in what their actions do — one dispatches a run, one appends a
 * row — so a spec that got the derivation wrong (footering everything, or nothing) is measurable
 * as a difference between two buttons in one form rather than as an absolute.
 */
export const freshFormSpec = (): ViewSpec =>
  ({
    id: 'fixture/fresh-form',
    title: 'Fixture — a form before anything is answered',
    permission: 'jobs::use',
    state: {
      rows: { type: 'list', default: [] },
      note: { type: 'string', default: '' },
    },
    const: {},
    // No `data` slice: this fixture is about the form's own shape, and a declared slice would
    // put a status surface above it that has nothing to do with the claim.
    derived: {},
    widgets: [
      {
        id: 'rowTable',
        kind: 'table',
        rows: '$state.rows',
        empty_text: FIXTURE_EMPTY_TEXT,
        require: {
          min_items: 1,
          message: 'Add at least one entry — a run over none does nothing.',
        },
        columns: [
          {
            key: 'label',
            title: 'Label',
            [ROW_PART_KEY]: {
              editable_text: { value: '$row.label', onChange: 'fx.setRowLabel' },
            },
          },
          {
            key: 'remove',
            title: '',
            [ROW_PART_KEY]: {
              button: { label: 'Remove', icon: 'remove', variant: 'destructive', onClick: 'fx.removeRow' },
            },
          },
        ],
      },
      { id: 'addRow', kind: 'button', label: 'Add entry', variant: 'primary', onClick: 'fx.addRow' },
      { id: 'note', kind: 'text', label: 'Note', value: '$state.note', onChange: 'fx.setNote' },
      { id: 'runBtn', kind: 'button', label: 'Start the run', variant: 'primary', onClick: 'fx.run' },
    ],
    actions: [
      {
        id: 'fx.addRow',
        title: 'Add an entry',
        permission: 'jobs::use',
        mutating: true,
        stateful: true,
        params: {},
        body: [{ listAppend: { path: 'rows', value: { label: '' } } }],
      },
      {
        id: 'fx.removeRow',
        title: 'Remove an entry',
        permission: 'jobs::use',
        mutating: true,
        stateful: true,
        params: { index: 'number' },
        body: [{ listRemove: { path: 'rows', index: '$params.index' } }],
      },
      {
        id: 'fx.setRowLabel',
        title: 'Set an entry label',
        permission: 'jobs::use',
        mutating: true,
        stateful: true,
        params: { index: 'number', key: 'string', value: 'string' },
        body: [{ set: { 'rows.{$params.index}.{$params.key}': '$params.value' } }],
      },
      {
        id: 'fx.setNote',
        title: 'Set the note',
        permission: 'jobs::use',
        mutating: true,
        stateful: true,
        params: { value: 'string' },
        body: [{ set: { note: '$params.value' } }],
      },
      {
        // THE SUBMIT. `run_processor` in the body is the whole signal — it is what
        // `core/form/validity.ts::submitActionIds` reads, and therefore what decides which
        // control gets the gate, the requirement summary, and the footer.
        id: 'fx.run',
        title: 'Start the run',
        permission: 'jobs::use',
        mutating: true,
        params: {},
        body: [{ run_processor: { id: 'fixture.run', params: { rows: '$state.rows' }, into: 'job' } }],
      },
    ],
  }) as unknown as ViewSpec

/**
 * How many list rows the run-feedback fixture's form is GROWN to, and how many runs sit behind
 * it.
 *
 * A form is not a fixed height — its list is rows a user ADDS — so the question this fixture
 * asks is what happens to everything BELOW the list as it grows. The row count is a REALISTIC
 * one, deliberately: the shipped form these model starts pre-filled and a user adds to it, and
 * a defect that only appears at the 50-row stress figure is dismissible as pathological. This
 * is the size an ordinary session reaches.
 *
 * The runs are what makes the claim about a RUN rather than about an empty region: the outcome
 * the pane exists to deliver is that the run you just launched is on screen, and an empty list
 * cannot show that.
 */
export const RUN_FEEDBACK_ROW_COUNT = 8
export const RUN_FEEDBACK_RUN_COUNT = 3

/**
 * RUN-FEEDBACK — a grown form with runs behind it: the surface the two-track pane exists for.
 *
 * It is `fresh-form`'s widgets (a list, an affordance that appends to it, a free-text field and
 * the action that starts the work, which the engine footers because its action dispatches a run)
 * with the list POPULATED and two extra pickers, so the form is the height a real one reaches
 * rather than the height of a fixture. Everything below the list — the footer AND the run band —
 * is what the growth used to push off the pane.
 *
 * It reuses `fresh-form`'s spec rather than declaring a second one, so the two surfaces cannot
 * come to disagree about what a form is; only the list's contents and the two pickers differ.
 */
export const runFeedbackSpec = (): ViewSpec => {
  const s = freshFormSpec() as ViewSpec & {
    id: string
    title: string
    state: Record<string, { type: string; default: unknown }>
    widgets: Array<Record<string, unknown>>
  }
  s.id = 'fixture/run-feedback'
  s.title = 'Fixture — a grown form with runs behind it'
  s.state.rows = {
    type: 'list',
    default: Array.from({ length: RUN_FEEDBACK_ROW_COUNT }, (_, i) => ({ label: `Entry ${i + 1}` })),
  }
  s.state.pick = { type: 'string', default: null }
  s.state.second = { type: 'string', default: null }
  // Two picker rows ABOVE the list, which is the shape a real form has: the inputs the run
  // consumes are chosen first and the list is edited under them. They are declared here rather
  // than in `fresh-form` because that fixture is about a form with NOTHING answered, and a pair
  // of populated pickers is the opposite claim.
  s.widgets = [
    { id: 'inputPicker', kind: 'select', label: 'Input', options: '$const.choices', value: '$state.pick', onChange: 'fx.setPick' },
    { id: 'secondPicker', kind: 'select', label: 'Second input', options: '$const.choices', value: '$state.second', onChange: 'fx.setPick' },
    ...s.widgets,
  ]
  ;(s as unknown as { const: Record<string, unknown> }).const = { choices: ['one', 'two', 'three'] }
  ;(s.actions as unknown as Array<Record<string, unknown>>).push({
    id: 'fx.setPick',
    title: 'Set the picked input',
    permission: 'jobs::use',
    mutating: true,
    stateful: true,
    params: { value: 'string' },
    body: [{ set: { pick: '$params.value' } }],
  })
  return s
}

// ── the registry the gallery registration + its test are generated from ───────

/**
 * The frame widths a fixture is mounted at.
 *
 * `narrow`/`wide` are the ORIGINAL pair — a phone-ish column and a frame far wider than
 * `RegionBody`'s cap, which is what the Slice-1 width-cap invariants are anchored to.
 *
 * `dock-min`/`dock-default` are the SIDE PANE's own band, imported from the store that clamps it
 * (`SIDE_REGION_WIDTH_MIN` / `DEFAULT_REGION_PREFS.rightWidth`). They are separate variants
 * rather than a re-pointing of `narrow`, because the two pairs answer different questions and a
 * surface can pass one while failing the other: 390px is wider than ANY default side pane, so a
 * grid that bursts a real pane fits comfortably in the `narrow` frame and reports nothing.
 *
 * `short` is the one variant that varies the HEIGHT rather than the width: a bottom region
 * dragged down to a strip. Every other frame is 720px tall, which is taller than anything a pane
 * footer can ask for — so the question "what happens when the pane is SHORTER than the thing
 * pinned to its bottom" has no frame that can ask it, and the guard for that case would be
 * unfalsifiable.
 */
export type FixtureVariant = 'narrow' | 'wide' | 'dock-min' | 'dock-default' | 'short'

/** The DEFAULT frames — the original pair, and what every fixture that declares none is mounted
 *  at. */
export const FIXTURE_VARIANTS: readonly FixtureVariant[] = ['narrow', 'wide'] as const

/** The SIDE-PANE band: the narrowest a pane can be dragged to, and the width it opens at. */
export const DOCK_VARIANTS: readonly FixtureVariant[] = ['dock-min', 'dock-default'] as const

/** The frame width, in px, each variant mounts at. Read from the store that owns the pane band,
 *  so a change to the clamp or the default moves every measurement written against it. */
export const VARIANT_WIDTH_PX: Record<FixtureVariant, number | undefined> = {
  narrow: 390,
  // `wide` is the one variant with no fixed width — it is "a pane much wider than the form's own
  // cap", which is a RELATION to `max-w-lg` rather than a number.
  wide: undefined,
  'dock-min': SIDE_REGION_WIDTH_MIN,
  'dock-default': DEFAULT_REGION_PREFS.rightWidth,
  short: 390,
}

/** The default frame HEIGHT — what a pane is, for every question about width. */
export const FRAME_HEIGHT_PX = 720

/** The frame height, in px, each variant mounts at. Only `short` differs, and it is chosen to be
 *  SHORTER THAN THE RUN BAND'S OWN NATURAL HEIGHT (~147px for three runs, plus a form above it):
 *  a taller strip would leave the band unconstrained and the surface would prove nothing. */
export const VARIANT_HEIGHT_PX: Record<FixtureVariant, number> = {
  narrow: FRAME_HEIGHT_PX,
  wide: FRAME_HEIGHT_PX,
  'dock-min': FRAME_HEIGHT_PX,
  'dock-default': FRAME_HEIGHT_PX,
  short: 220,
}

export interface DeclarativeFixture {
  /** Stable key, also the gallery slug stem (`declarative-<key>-<variant>`). */
  key: string
  title: string
  note: string
  spec: () => ViewSpec
  /** What the host does — the ONLY difference between loaded / empty / error. */
  host: 'data' | 'empty' | 'reject'
  /** How many RUNS the story seeds into the pane's run band. Omitted ⇒ none, which is every
   *  existing fixture (a gallery page has no authenticated session, so the live job poll refuses
   *  and the band renders its empty state). A fixture that sets it is asking a question ABOUT
   *  the band, and needs rows to ask it with. */
  runs?: number
  /**
   * The frame widths THIS fixture is mounted at. Absent ⇒ {@link FIXTURE_VARIANTS} (the
   * original narrow/wide pair), so every existing fixture is unchanged.
   *
   * Per-fixture rather than global because a variant is a QUESTION, not a decoration: mounting
   * the six original fixtures at the dock band as well would DOUBLE the gate's surface count
   * (12 → 24) to ask them something nobody is asking.
   */
  variants?: readonly FixtureVariant[]
}

/** Gallery coverage for the three generic widget kinds (ITEM-16/17/18): a `tabs` mode-switch
 *  whose first tab holds a `list-editor` in CARD mode (a card per row, each with a `text` +
 *  `token-input` child), and whose second tab holds a flat `token-input`. Domain-free by
 *  construction — generic labels only. */
export const widgetKitSpec = (): ViewSpec =>
  ({
    id: 'fixture/widget-kit',
    title: 'Fixture — tabs / token-input / list-editor',
    permission: 'jobs::use',
    state: {
      mode: { type: 'string', default: 'first' },
      tokens: { type: 'list', default: ['one', 'two'] },
      rows: { type: 'list', default: [{ name: 'Alpha', tokens: ['x', 'y'] }] },
    },
    const: {},
    derived: {},
    widgets: [
      {
        id: 'modes',
        kind: 'tabs',
        value: '$state.mode',
        onChange: 'wk.setMode',
        tabs: [
          {
            id: 'first',
            label: 'Cards',
            children: [
              {
                id: 'cards',
                kind: 'list-editor',
                items: '$state.rows',
                add: 'wk.addRow',
                remove: 'wk.removeRow',
                add_label: 'Add item',
                remove_label: 'Remove',
                item: {
                  children: [
                    { id: 'nm', kind: 'text', label: 'Name', value: '$item.name', onChange: 'wk.setField', args: { key: 'name', index: '$index' } },
                    { id: 'toks', kind: 'token-input', label: 'Tokens', value: '$item.tokens', onChange: 'wk.setRowTokens', args: { index: '$index' } },
                  ],
                },
              },
            ],
          },
          {
            id: 'second',
            label: 'Flat',
            children: [{ id: 'flat', kind: 'token-input', label: 'Tokens', value: '$state.tokens', onChange: 'wk.setTokens' }],
          },
        ],
      },
    ],
    actions: [
      { id: 'wk.setMode', title: 'Set mode', permission: 'jobs::use', mutating: true, stateful: true, params: { value: 'string' }, body: [{ set: { mode: '$params.value' } }] },
      { id: 'wk.setTokens', title: 'Set tokens', permission: 'jobs::use', mutating: true, stateful: true, params: { value: 'string' }, body: [{ set: { tokens: '$params.value' } }] },
      { id: 'wk.setRowTokens', title: 'Set a row’s tokens', permission: 'jobs::use', mutating: true, stateful: true, params: { index: 'number', value: 'string' }, body: [{ set: { 'rows.{$params.index}.tokens': '$params.value' } }] },
      { id: 'wk.setField', title: 'Set a row field', permission: 'jobs::use', mutating: true, stateful: true, params: { index: 'number', key: 'string', value: 'string' }, body: [{ set: { 'rows.{$params.index}.{$params.key}': '$params.value' } }] },
      { id: 'wk.addRow', title: 'Add a row', permission: 'jobs::use', mutating: true, stateful: true, params: {}, body: [{ listAppend: { path: 'rows', value: { name: '', tokens: [] } } }] },
      { id: 'wk.removeRow', title: 'Remove a row', permission: 'jobs::use', mutating: true, stateful: true, params: { index: 'number' }, body: [{ listRemove: { path: 'rows', index: '$params.index' } }] },
    ],
  }) as unknown as ViewSpec

/** The audit-named fixtures. The gallery registration and `fixtureSpecs.test.ts` BOTH
 *  read this list, so a surface cannot be silently dropped from one and not the other. */
export const DECLARATIVE_FIXTURES: readonly DeclarativeFixture[] = [
  {
    key: 'loaded',
    title: 'Declarative region — loaded',
    note: 'The populated control case: two for_each criterion groups over real obs columns, plus the action button, group-by, keep-set and dataset picker.',
    spec: loadedSpec,
    host: 'data',
  },
  {
    key: 'empty-data',
    title: 'Declarative region — no data yet',
    note: 'F3: the host has no artifact of the declared datatype. Must render the explicit no-data state, not a dead form.',
    spec: emptyDataSpec,
    host: 'empty',
  },
  {
    key: 'error-data',
    title: 'Declarative region — data failed to load',
    note: 'F3: the host REJECTS. Must render a named, retryable alert — visibly different from the no-data case.',
    spec: errorDataSpec,
    host: 'reject',
  },
  {
    key: 'foreach-stress',
    title: 'Declarative region — 50-criteria for_each stress',
    note: 'F2/F4: 50 repeated criterion groups. The column must stay scrollable and width-capped instead of blowing out the pane.',
    spec: foreachStressSpec,
    host: 'data',
  },
  {
    key: 'long-label',
    title: 'Declarative region — long label',
    note: 'F4: a 180-character control label must wrap inside the form column, not push the control out of the container.',
    spec: longLabelSpec,
    host: 'data',
  },
  {
    key: 'malformed-widget',
    title: 'Declarative region — malformed widget',
    note: 'F2/F8: a widget with an invalid for_each clause throws at render; the siblings keep rendering and the broken one becomes a NAMED, retryable placeholder.',
    spec: malformedWidgetSpec,
    host: 'data',
  },
  {
    key: 'criteria-table',
    title: 'Declarative region — criteria table in a dock pane',
    note: 'The table primitive at the widths a side pane clamps to. A MIXED row set (two continuous, one categorical) so the per-row gate has both branches to draw; nothing may spill the pane at either width.',
    spec: criteriaTableSpec,
    host: 'data',
    variants: DOCK_VARIANTS,
  },
  {
    key: 'widget-kit',
    title: 'Declarative region — tabs / token-input / list-editor',
    note: 'ITEM-16/17/18: the three generic widgets. A tabs mode-switch over a card-mode list-editor (a card per row, each a text + token-input child) and a flat token-input. Domain-free.',
    spec: widgetKitSpec,
    host: 'data',
  },
  {
    key: 'fresh-form',
    title: 'Declarative region — a form before anything is answered',
    note: 'The state every user meets a form in: an empty list, which must read as an empty STATE rather than headings over a void, and the action that starts the work, which sits in its own footer with the unmet requirement stated above it.',
    spec: freshFormSpec,
    host: 'data',
  },
  {
    key: 'run-feedback',
    title: 'Declarative region — a grown form with runs behind it',
    note: 'The form at the size a session reaches by adding rows, with runs already launched. Everything BELOW the list — the run footer and the per-analysis run band — must still be on screen: the feedback for pressing Run may not be displaced by the growth of the form that produces it.',
    spec: runFeedbackSpec,
    host: 'data',
    runs: RUN_FEEDBACK_RUN_COUNT,
    // The default pair PLUS a pane shorter than the band it pins. Pinning a footer is only safe
    // while the footer fits; `short` is the frame that can tell whether it still does.
    variants: [...FIXTURE_VARIANTS, 'short'],
  },
] as const

/** The frames a fixture is mounted at — its own, or the default pair. */
export function variantsOf(fixture: DeclarativeFixture): readonly FixtureVariant[] {
  return fixture.variants ?? FIXTURE_VARIANTS
}

/** `declarative-<key>-<variant>` — the gallery slug. One function so the registration, the
 *  Layer-A spec, and the behavioural e2e all address surfaces the same way. */
export function fixtureSlug(key: string, variant: FixtureVariant): string {
  return `declarative-${key}-${variant}`
}

/** Every slug this module contributes, in registration order. */
export function allFixtureSlugs(): string[] {
  return DECLARATIVE_FIXTURES.flatMap(f => variantsOf(f).map(v => fixtureSlug(f.key, v)))
}
