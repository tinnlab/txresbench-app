// THE EMIT MODEL, ASSERTED ON THE SHIPPED SECTIONS (visualize-pane ITEM-30 / ITEM-32 / ITEM-33 /
// ITEM-34 / ITEM-36 / ITEM-43 / ITEM-64) — covers TEST-41, TEST-46, TEST-47 and the declaration
// half of TEST-45 / TEST-49 / TEST-56.
//
// ── Why these read the REAL yaml off disk ───────────────────────────────────────────────
//
// Every rule here is a property of a DECLARATION, and the declaration is the product: the
// engine is generic and would happily render a section that toggled, or that used a radio, or
// whose ▶ was called "Plot" on all forty rows. A fixture spec would therefore assert that the
// TEST's author knows the rule, which is the tautology this file exists to avoid. So the
// subject is `packages/*/ui/*.yaml` as shipped, discovered rather than named — a package that
// stops declaring a section fails the discovery guard rather than making everything below
// vacuously pass.
//
// The BEHAVIOUR half (a click actually opening a second grid pane) cannot be seen from here and
// is not simulated here: it is `tests/e2e/15-visualize/emit-and-close.spec.ts`.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
// The declarative vocabulary's own name for a column's inner primitive, imported rather than
// spelled: the word collides with a domain noun the app tree may not carry, and one exported
// constant is also the only spelling that cannot drift from the parser's.
import { ROW_PART_KEY } from './schema'

const PROCESSORS_DIR = fileURLToPath(new URL('../../../../../../packages', import.meta.url))

interface Loaded {
  pkg: string
  file: string
  spec: Record<string, any>
}

/** Every shipped view spec a package names through `contributes.sections[]` — i.e. every
 *  VISUALIZE SECTION, discovered by the OWNERSHIP relation rather than by package name.
 *
 *  Ownership, not shape: an ANALYSIS view may perfectly legitimately drive a `for_each` canvas
 *  over its own state (one shipped analysis view does), and it is not a section — it has a Run,
 *  an analysis and a different set of rules. Selecting on the shape would drag it in here and
 *  assert the
 *  section model against a form. Selecting on the package NAME would carry a contributed
 *  package's vocabulary into the app tree and make this file about one package. The manifest
 *  says which files are sections; that is the answer both other gates in this tree use.
 */
function emitSections(): Loaded[] {
  const out: Loaded[] = []
  for (const pkg of readdirSync(PROCESSORS_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const manifestPath = `${PROCESSORS_DIR}/${pkg.name}/manifest.yaml`
    if (!existsSync(manifestPath)) continue
    const manifest = parseYaml(readFileSync(manifestPath, 'utf8')) as Record<string, any>
    for (const section of manifest?.contributes?.sections ?? []) {
      for (const rel of section?.ui ?? []) {
        const path = `${PROCESSORS_DIR}/${pkg.name}/${rel}`
        if (!existsSync(path)) continue
        out.push({ pkg: pkg.name, file: rel, spec: parseYaml(readFileSync(path, 'utf8')) as Record<string, any> })
      }
    }
  }
  return out
}

const sections = emitSections()

// ── PLOT-EMITTING section vs MANAGEMENT / LISTING section ──────────────────────────────────────
//
// The emit model below (a plots array in STATE, a `listAppend` emitter, canvas datasets, a plots
// BADGE) is about a section that DRAWS — it appends a tile to a canvas. A visualize section may
// legitimately draw NOTHING: a management surface (a frozen-artifact readout with New / Edit /
// Export actions + a picker) emits no plot, so every one of those rules is about a thing it has
// none of, and forcing a `canvas` onto it would fabricate one (the same INV-2 "absence is
// absence" main applied to the volcano's coordinate frame above/below).
//
// Keyed on the STRUCTURAL marker `canvas`, never on a package name or on the property under test:
// a section draws iff it declares a canvas. A plot section that silently LOSES its canvas in a
// refactor drops OUT of the plot tier — and is then caught red-handed by the non-plot positive
// rule (it declares no canvas AND is a real actionable surface), so the exclusion cannot become a
// place a broken plot section hides. This mirrors the volcano scoping (`isFramedSection` /
// `COORDINATE_DRAWN_SERIES`) the same file already applies one describe down.
const isPlotSection = (spec: Record<string, any>): boolean => spec?.canvas !== undefined
const plotSections = sections.filter(s => isPlotSection(s.spec))
const nonPlotSections = sections.filter(s => !isPlotSection(s.spec))

/** The canvas series `type`s that draw in a COORDINATE FRAME (positioned by a coordinate
 *  artifact + a captured row space) — as opposed to a chart drawn in its own intrinsic axes
 *  (a `volcano`, whose x/y are the de/result effect + significance columns). The coordinate /
 *  row-space / axis-browse rules below apply only to the former; a volcano legitimately has
 *  no coordinate frame to declare (INV-2). A NEW coordinate-drawn kind is one entry here. */
const COORDINATE_DRAWN_SERIES = new Set(['scatter'])

/** Whether a section draws its plots in a coordinate FRAME — it reads a `pane_frame` slice,
 *  which is where a captured `coordinate` / `row_space` come from. A volcano section reads no
 *  such slice. */
const isFramedSection = (spec: Record<string, any>): boolean =>
  Object.values(spec.data ?? {}).some((d: any) => d?.source === 'pane_frame')

/** The `source` of the data slice a widget's `$data.<slice>.…` reference reads from — used to
 *  tell an AXIS-scoped entry list (`axis_entry_rows`, which can be REFUSED as over-budget) from
 *  a bounded DOCUMENT list (e.g. a run's comparisons), which has no over-budget state. */
const sliceSourceOf = (spec: Record<string, any>, ref: unknown): string | undefined => {
  const slice = String(ref ?? '').match(/^\$data\.([^.[]+)/)?.[1]
  return slice ? (spec.data?.[slice] as any)?.source : undefined
}

/** Every action a spec declares, by id. */
const actionsOf = (spec: Record<string, any>): Record<string, any> =>
  Object.fromEntries((spec.actions ?? []).map((a: any) => [a.id, a]))

/**
 * EVERY PER-ROW EMIT A SPEC DECLARES, whatever widget declares it.
 *
 * It used to walk `table` columns only, and that was true of the pane it was written against:
 * The column section shipped two grids and its rows were table boxes. It is no longer true in any of
 * the three sections — the column section became an `entry_list` (owner, ledger #32), the entry-axis section
 * always was one, and § Coordinates declares its ▶ on the picker's `row_action` (ledger #27).
 * A table-only walk therefore found ZERO emit rows in the whole pane and every assertion below
 * it passed vacuously, which is the silent-zero-match failure this file's first test exists to
 * catch one level up.
 *
 * So it collects all three DECLARATION SHAPES. That they render one control is ledger #33's
 * job (`core/render/EmitControl.tsx`); that they are all found is this function's.
 */
function rowButtons(spec: Record<string, any>): any[] {
  const out: any[] = []
  const walk = (widgets: any[]): void => {
    for (const w of widgets ?? []) {
      // A per-row primitive lives under the column's own inner-part key — the column DECLARES what
      // its box holds, and reading the column itself would find nothing however many it declares.
      if (w?.kind === 'table') {
        for (const c of w.columns ?? []) if (c?.[ROW_PART_KEY]?.button) out.push(c[ROW_PART_KEY].button)
      }
      // A LIST's ▶ is declared once for the whole list, under `action:`.
      if (w?.kind === 'entry_list' && w.action) out.push(w.action)
      // A PICKER's ▶ is declared once per option, under `row_action:`.
      if (w?.kind === 'artifact_ref' && w.row_action) out.push(w.row_action)
      if (Array.isArray(w?.children)) walk(w.children)
    }
  }
  walk(spec.widgets ?? [])
  return out
}

/** The subset that can DECLARE a refusal — a table box and a picker option carry an
 *  `unavailableReason` expression; a list reads its refusal off the row the engine handed it
 *  (`plot_refusal`), so there is no declaration on the list to assert. */
const declaresRefusal = (b: any): boolean => b?.unavailableReason !== undefined

describe('the shipped Visualize sections implement the emit model', () => {
  it('discovers them (guards against a silent zero-match, which would pass everything below)', () => {
    // At least the coordinate frame (ITEM-43) and the colouring (ITEM-30). A change in either
    // direction is then a decision rather than an accident.
    expect(sections.length).toBeGreaterThanOrEqual(2)
    // …and the PLOT tier below must still cover the real plot sections. The de + the three
    // sc-viz sections are four plot-emitting sections, so this floor cannot reach zero without
    // failing loudly — the emit-model rules going vacuous the day the last plot section refactors
    // is exactly the silent-zero-match failure this discovery guard exists to prevent. Both
    // directions of the classifier are pinned synthetically so it can never quietly stop matching.
    expect(isPlotSection({ canvas: { series: [] } }), 'the plot classifier stopped recognising a canvas').toBe(true)
    expect(isPlotSection({ state: {} }), 'the plot classifier now claims a section that draws nothing').toBe(false)
    expect(plotSections.length, 'the plot tier stopped covering any real plot section').toBeGreaterThanOrEqual(2)
  })

  // A non-plot MANAGEMENT / LISTING section is a real, ACTIONABLE surface — not a plot section
  // that lost its canvas. Both directions, so the plot-tier exclusion cannot become a dumping
  // ground: it declares NO canvas (or it belongs in the plot tier), and it declares at least one
  // affordance (a button / picker / list), so it is a surface a user does something on rather than
  // an empty stub slipped past the emit rules.
  it.each(nonPlotSections)('$pkg/$file — a non-plot section is an actionable surface, not a canvas that lost its plots', ({ spec }) => {
    expect(spec.canvas, 'a section in the non-plot tier must declare no canvas').toBeUndefined()
    const affordances = allWidgets(spec).filter(w => ['button', 'artifact_ref', 'entry_list'].includes(w?.kind))
    expect(
      affordances.length,
      'a non-plot section declares no action, picker or list — it is an empty stub, not a management surface',
    ).toBeGreaterThanOrEqual(1)
  })

  it.each(plotSections)('$pkg/$file — a plot list is STATE, and the canvas is a projection of it', ({ spec }) => {
    // ITEM-31: the canvas is re-derived on every change, so "append a plot" as an effect op
    // would be a mutation of something re-derived — the shape the reopen-loop guard prevents.
    // Every emitted plot therefore lives in the section's own state and the canvas only reads it.
    const listed = Object.entries(spec.state ?? {}).filter(([, f]: [string, any]) => f?.type === 'array')
    expect(listed.length).toBeGreaterThanOrEqual(1)
    for (const [, field] of listed) expect((field as any).default).toEqual([])
  })

  it.each(plotSections)('$pkg/$file — the ▶ APPENDS; it never toggles and never replaces (DEC-9)', ({ spec }) => {
    // The owner's ruling: *"if they click twice then it will visualize it on 2 viz grid panes."*
    // A toggle or a replace is a different EFFECT, so the rule is checkable at the declaration:
    // an emit action's body appends, and nothing in it clears or overwrites the list.
    const actions = actionsOf(spec)
    const emitters = Object.values(actions).filter((a: any) =>
      (a.body ?? []).some((e: any) => 'listAppend' in e),
    )
    expect(emitters.length).toBeGreaterThanOrEqual(1)
    for (const a of emitters) {
      const ops = (a.body ?? []).map((e: any) => Object.keys(e)[0])
      expect(ops).toContain('listAppend')
      // Neither a removal nor a wholesale `set` of the list may ride along with the append.
      expect(ops).not.toContain('listRemove')
      for (const e of a.body ?? []) {
        if ('set' in e) expect(Object.keys(e.set)).not.toContain('plots')
      }
    }
  })

  it.each(plotSections)('$pkg/$file — every emitted plot can be CLOSED, through this section (ITEM-32)', ({ spec }) => {
    // One owner, one path: the close routes to the EMITTING section's own declared action, which
    // removes the entry from the list the `for_each` reads — so the next render cannot re-create
    // it (the reopen loop). A plot with no declared close would render an X that does nothing.
    const actions = actionsOf(spec)
    for (const s of spec.canvas?.series ?? []) {
      expect(s.controlled, `series ${s.id} must hand its close to the app`).toBe(true)
      expect(s.close?.action, `series ${s.id} declares no close action`).toBeTruthy()
      const closer = actions[s.close.action]
      expect(closer, `close action ${s.close?.action} is not declared by this section`).toBeTruthy()
      expect((closer.body ?? []).some((e: any) => 'listRemove' in e)).toBe(true)
    }
  })

  it.each(plotSections)('$pkg/$file — a plot carries WHOSE row space it is (ITEM-35)', ({ spec }) => {
    // R10 at the plot level, and what makes a canvas holding two row spaces readable. The title
    // is composed from values captured at EMIT time (`$c.…`), never re-read from the live frame,
    // so an open figure is not retitled under the user.
    for (const s of spec.canvas?.series ?? []) {
      expect(typeof s.title).toBe('string')
      expect(s.title).toMatch(/\$c\./)
      expect(s.title).not.toMatch(/\$data\./)
      expect(s.title).not.toMatch(/\$scope\./)
    }
  })

  it.each(plotSections)('$pkg/$file — a plot is drawn in the coordinates it DECLARED (ITEM-29)', ({ spec }) => {
    // Never the project's first plottable-xy artifact. Each base names the artifact its own plot
    // captured, so two plots from two row spaces are each drawn in their own positions.
    //
    // This is a COORDINATE-DRAWN rule: it is about a plot positioned by a coordinate frame (a
    // scatter over a reduced-space layout). A section drawn in its own INTRINSIC axes — a chart
    // whose x/y come from its result table's own columns via `encode.*Column` — has no
    // coordinate artifact, and forcing a `coords.artifact` onto its dataset would fabricate a
    // frame the plot has none of (INV-2: absence is absence). So the assertion keys on the
    // datasets a coordinate-drawn series actually consumes; it stays STRICT for scatter sections
    // (a scatter that drops its coords still fails) and exempts the volcano's dataset.
    const datasets = spec.canvas?.datasets ?? []
    expect(datasets.length).toBeGreaterThanOrEqual(1)
    const coordinateDrawn = new Set(
      (spec.canvas?.series ?? [])
        .filter((s: any) => COORDINATE_DRAWN_SERIES.has(String(s?.type)))
        .map((s: any) => String(s?.datasetId)),
    )
    for (const d of datasets) {
      if (!coordinateDrawn.has(String(d.id))) continue
      expect(d.coords?.artifact, `dataset ${d.id} declares no coordinates`).toMatch(/^\$c\./)
    }
  })

  it.each(plotSections)('$pkg/$file — states what it HOLDS, for its collapsed frame (ITEM-64 / R6)', ({ spec }) => {
    // Collapse is display, not reset. The host draws the mark and never reads a section's
    // fields, so the section has to say what counts.
    expect(typeof spec.badge).toBe('string')
    expect(spec.badge).toMatch(/^\$state\./)
  })
})

/** The registry key every emit row in the Visualize pane draws itself as
 *  (`ROW_ACTION_ICONS` in `extensions/widgets/renderers.tsx`). */
const EMIT_ICON = 'plot'

describe('a colour-by row is a VERB, not a choice (ITEM-34)', () => {
  /** The sections whose rows are the per-column list — the ones with a per-row `▶`. */
  const withRowButtons = sections.filter(s => rowButtons(s.spec).length > 0)

  it('discovers at least one', () => {
    expect(withRowButtons.length).toBeGreaterThanOrEqual(1)
  })

  it.each(withRowButtons)('$pkg/$file — the emit button is icon-only and names the ROW, not the verb', ({ spec }) => {
    // The renderer composes the accessible name as `<label> <row name>`, so the LABEL is the
    // verb and the ROW supplies the subject — which is how forty rows get forty distinct names.
    // An icon with no label would leave them all unnamed instead.
    //
    // The GLYPH is asserted as a registered emit glyph rather than as one literal: the property
    // that matters is that every emit row in the pane draws the SAME one and that the renderer
    // knows it (an unregistered name silently degrades to the wordy button, so a typo here would
    // otherwise ship as a layout change nobody asserted). `play` is deliberately NOT it — it is
    // transport, it is the RUN affordance's glyph, and this control draws a picture (owner
    // feedback #6).
    expect(new Set(rowButtons(spec).map(b => b.icon)).size).toBeLessThanOrEqual(1)
    for (const b of rowButtons(spec)) {
      expect(b.icon).toBe(EMIT_ICON)
      expect(b.icon).not.toBe('play')
      expect(typeof b.label).toBe('string')
      expect(b.label.length).toBeGreaterThan(0)
      // The label must NOT itself interpolate the row: the renderer already appends it, and a
      // label that repeated it would read "Plot a column a column".
      expect(b.label).not.toMatch(/\$row\./)
    }
  })

  it.each(withRowButtons)('$pkg/$file — a refused ▶ says WHY (ITEM-39 / ITEM-29c)', ({ spec }) => {
    // The reason IS the gate, so there is no way to refuse silently. It is bound to the ROW's
    // own fact, because a column heading cannot say "4,102 levels is too many" about one row.
    const declared = rowButtons(spec).filter(declaresRefusal)
    for (const b of declared) expect(b.unavailableReason).toMatch(/^\$(row|option)\./)
  })

  it.each(withRowButtons)('$pkg/$file — no row carries a SELECTED state (ITEM-34)', ({ spec }) => {
    // *"A row is not a choice, it is a verb."* Under DEC-9 a row can be plotted twice, which
    // "on"/"off" could not describe — so no radio, no checkbox, no select in these columns.
    const walk = (widgets: any[]): void => {
      for (const w of widgets ?? []) {
        if (w?.kind === 'table') {
          for (const c of w.columns ?? []) {
            const part = c[ROW_PART_KEY] ?? {}
            expect(part.select, `column ${c.key} offers a choice`).toBeUndefined()
            expect(part.checkbox, `column ${c.key} offers a choice`).toBeUndefined()
            expect(part.radio, `column ${c.key} offers a choice`).toBeUndefined()
          }
        }
        if (Array.isArray(w?.children)) walk(w.children)
      }
    }
    walk(spec.widgets ?? [])
  })

  it.each(withRowButtons)('$pkg/$file — every count is a PROJECTION of the same list (ITEM-33)', ({ spec }) => {
    // Not a second source of truth: every number the section states is derived from the list
    // the canvas renders, so the pane and the canvas cannot disagree.
    //
    // BOTH counting surfaces, because a section may carry either or both and this used to read
    // only the first: the section's own collapsed BADGE (R6/ITEM-64), and the per-row numeral's
    // `derived` (ITEM-33). § Coordinates declares the badge and no per-row numeral — its rows
    // are a radio, and a numeral beside a checked radio would read as part of the choice — so a
    // `derived`-only assertion failed it for not having a counter it deliberately does not have.
    const counted = JSON.stringify({ derived: spec.derived ?? {}, badge: spec.badge ?? '' })
    expect(counted, 'this section counts something that is not the emitted list').toMatch(/\$state\.plots/)
    // …and there is NO counter in `state` beside the list, which is what "projection" forbids.
    const counters = Object.entries(spec.state ?? {}).filter(([, f]: [string, any]) => f?.type === 'number')
    expect(counters).toEqual([])
  })
})

// ── THE DECLARATIONS ROUND 2 SHIPPED, PINNED ON THE SHIPPED FILES ──────────────────────
//
// Five behavioural declarations were added to these specs and NONE of them was asserted at any
// tier. A blind test-reality audit put it plainly: delete all five lines and every suite stays
// green, because the unit tests declare each behaviour INSIDE the test (`RADIO_SPEC()`,
// `spec({browsable: …})`) and so prove the RENDERER honours a declaration nobody has to ship.
// Reverting the emit note to the frame-only mark — re-introducing the exact defect the round
// says it fixed — was green.
//
// These read the shipped files. Each one names the defect that returns if the line goes.

/** Every widget of a spec, flattened — a declaration may sit under `children`. */
function allWidgets(spec: Record<string, any>): any[] {
  const out: any[] = []
  const walk = (widgets: any[]): void => {
    for (const w of widgets ?? []) {
      out.push(w)
      if (Array.isArray(w?.children)) walk(w.children)
    }
  }
  walk(spec.widgets ?? [])
  return out
}

/** The ONE section that declares an `artifact_ref` bound to the pane's coordinate — found by
 *  the BINDING, never by file name, so a rename of the package or the file does not silently
 *  drop the subject. */
const framePickers = sections.flatMap(({ pkg, file, spec }) =>
  allWidgets(spec)
    .filter(w => w?.kind === 'artifact_ref' && String(w?.value ?? '').includes('coordinate'))
    .map(w => ({ pkg, file, spec, widget: w })),
)

/** The sections that list AXIS ENTRIES — again by the widget kind, not by name. */
const entrySections = sections.filter(({ spec }) => allWidgets(spec).some(w => w?.kind === 'entry_list'))

/** The sections that list a row space's COLUMNS as tables bound to a `row_space_columns` slice. */
const columnSections = sections.filter(({ spec }) =>
  Object.values(spec.data ?? {}).some((d: any) => d?.source === 'row_space_columns'),
)

describe('the declarations this round shipped are DECLARED, not merely renderable', () => {
  it('the frame picker exists and is a RADIO (DEC-10)', () => {
    // The owner named a CONTROL. Without this, `control: radio` can be deleted from the shipped
    // spec and the picker silently returns to a dropdown whose alternatives cost a click to
    // discover — with this file's own prose still asserting "§ Coordinates IS the radio".
    expect(framePickers.length, 'no shipped section binds an artifact_ref to the pane coordinate').toBe(1)
    expect(framePickers[0].widget.control).toBe('radio')
  })

  it('an entry section tells the widget whether the list was actually LISTED', () => {
    // Without the binding, `entry_list` cannot tell "the axis resolved and holds nothing" from
    // "the axis was REFUSED as over-budget", and prints its own empty_text beside a refusal
    // saying the axis has millions of entries — two sentences, one of them false.
    expect(entrySections.length).toBeGreaterThanOrEqual(1)
    for (const { spec } of entrySections) {
      const list = allWidgets(spec).find(w => w?.kind === 'entry_list')
      // Only an AXIS-scoped list (`axis_entry_rows`) can be REFUSED as over-budget, so only it
      // needs `browsable` to tell "resolved and empty" from "refused". A bounded DOCUMENT list
      // (e.g. a run's per-comparison de-report) has no over-budget state, so `browsable` is
      // meaningless for it — asserting it there would demand a binding for a distinction that
      // cannot arise.
      if (sliceSourceOf(spec, list?.entries) !== 'axis_entry_rows') continue
      expect(String(list.browsable ?? '')).toMatch(/^\$data\./)
    }
  })

  // ── INVERTED A SECOND TIME, TO ZERO (owner, ledger #28 + #29) ───────────────────────
  //
  // This assertion has now been written three ways, and the history is the point. It first
  // REQUIRED the aggregate alert (ITEM-20: the case that needs the sentence is the ordinary
  // one). It was then capped at ONE PER PANE, because the same sentence was rendering in three
  // places at once and a fact stated three times is furniture. The owner has now asked for the
  // last one to go (*"remove the … warning please"*, #28) and for the mark an emitted plot
  // carried to go with it (#29) — which is the rule itself, not another instance of it.
  //
  // So the count is ZERO, and it is asserted over the WHOLE PANE and over every widget rather
  // than over the `alert` kind alone: the two previous rewrites both moved the sentence to a
  // different surface, and a bound that only counted alerts would pass while the words came
  // back as a row field, an `empty_text` or a plot note. The engine-side half is pinned in
  // `rowSpaceColumns.test.ts` / `paneFrame.test.ts` / `axisEntryRows.test.ts`, each over its
  // whole payload for the same reason.
  it('NOTHING in the pane tells anyone about alignment any more', () => {
    for (const { pkg, file, spec } of sections) {
      expect(
        JSON.stringify(spec).toLowerCase(),
        `${pkg}/${file} still states alignment somewhere`,
      ).not.toContain('alignment not declared')
    }
    const paneAlerts = sections.flatMap(({ spec }) =>
      allWidgets(spec).filter(w => w?.kind === 'alert' && /alignment/i.test(String(w.text ?? ''))),
    )
    expect(paneAlerts.length, `the pane states alignment in ${paneAlerts.length} places`).toBe(0)
  })

  // ── REWRITTEN (owner, ledger #29) ────────────────────────────────────────────────────
  //
  // *"an emitted entry plot carries the SOURCE's mark, not the frame's alone (R8)"* stood here,
  // pinning `action.args.note: $source.plot_note` and `listAppend.value.note: $params.note`. It
  // was pinning a real regression — reverting to the frame's mark alone drops R8's column half
  // — but the owner removed the mark from the plot entirely, so there is no note for either
  // half to be about.
  //
  // What replaces it is the assertion that the emitted RECORD is still complete without it: a
  // tile must still be born carrying its own coordinate, its own row space and its own name,
  // captured at emit (ITEM-57). That is the property the note rode alongside and the one whose
  // loss would actually break a picture, and it was never separately pinned here.
  it('an emitted plot is still born with everything it is a picture OF (ITEM-57)', () => {
    for (const { spec } of entrySections) {
      const list = allWidgets(spec).find(w => w?.kind === 'entry_list')
      const emitId = list?.action?.onClick
      expect(emitId, 'the entry list declares no ▶').toBeTruthy()
      // …and it forwards no alignment note, in either leg.
      expect(JSON.stringify(list.action ?? {})).not.toMatch(/note/i)
      const emit = actionsOf(spec)[emitId]
      const appended = (emit.body ?? []).find((e: any) => 'listAppend' in e)?.listAppend?.value ?? {}
      expect(appended.note, 'the emitted tile still carries a note').toBeUndefined()
      // ITEM-57 — the emitted tile is born carrying everything it is a picture OF, captured at
      // emit, so an open figure is not silently redrawn when the live selection moves. WHAT it
      // captures depends on the plot: a coordinate-drawn scatter captures its `coordinate` +
      // `row_space` (the frame it was born in); a volcano drawn in its own de/result axes has no
      // frame, and captures instead the source `artifact` it is a picture of. Either way the
      // record must be self-contained.
      if (isFramedSection(spec)) {
        expect(String(appended.coordinate ?? '')).toMatch(/^\$data\.frame\./)
        expect(String(appended.row_space ?? '')).toMatch(/^\$data\.frame\./)
      } else {
        expect(
          String(appended.artifact ?? ''),
          'the emitted tile captures no source artifact — it is not born with what it is a picture of',
        ).toMatch(/^\$params\./)
      }
    }
    // The same, for the section that emits the frame itself: no note, and the record still
    // names the artifact the pressed ROW declared rather than the pane's live selection.
    for (const { spec } of framePickers) {
      for (const a of spec.actions ?? []) {
        const appended = (a.body ?? []).find((e: any) => 'listAppend' in e)?.listAppend?.value
        if (!appended) continue
        expect(appended.note, 'the emitted frame tile still carries a note').toBeUndefined()
      }
    }
    // …and no series anywhere hands viz a provenance note built from one.
    for (const { spec } of sections) {
      for (const s of spec.canvas?.series ?? []) expect(s.provenanceNote).toBeUndefined()
    }
  })

  it('a column LIST only makes claims about an ANCHORED row space', () => {
    // Ungated, the empty state renders beside "No row space anchored yet" on the FIRST screen of
    // every project with two or more row spaces — telling the user to go run an analysis when
    // nothing is missing and nothing has been asked.
    //
    // It looked for `table` widgets until ledger #32 replaced them with one `entry_list`; the
    // GATE is the item and the control it sits on is not, so the subject is now "the widget
    // bound to the `row_space_columns` slice", whatever kind that widget is.
    expect(columnSections.length).toBeGreaterThanOrEqual(1)
    for (const { spec } of columnSections) {
      const bound = allWidgets(spec).filter(w =>
        [w?.rows, w?.entries].some(b => String(b ?? '').includes('.columns')),
      )
      expect(bound.length).toBeGreaterThanOrEqual(1)
      for (const t of bound) expect(String(t.when ?? '')).toMatch(/anchored/)
    }
  })
})
