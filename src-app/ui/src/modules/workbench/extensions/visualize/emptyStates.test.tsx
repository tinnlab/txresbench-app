// TEST-81 (visualize-pane ITEM-63 / ITEM-66) — § Colour by's TWO emptinesses are two
// different sentences, and the merge case ships NO launch button.
//
// ── what is actually at stake ───────────────────────────────────────────────────────
//
// ITEM-63's rule is that every emptiness says WHICH one it is. § Colour by can be empty for
// two unrelated reasons that a single "no columns" message would flatten:
//
//   · the row space carries no CATEGORICAL column — and if it is an INTEGRATED space, the
//     specific reason is that a column each contributor carries is not automatically a
//     column of the integrated space. That is a remedy the user can act on, and it is
//     invisible unless the sentence says it.
//   · the row space carries no CONTINUOUS column — measurements arrive from an analysis
//     that computes them, and none has run.
//
// The two fail INDEPENDENTLY, so one message covering both would be wrong half the time.
//
// ── the absence half, which is the part that rots ───────────────────────────────────
//
// ITEM-66 descoped the "merge them for me" affordance. The remedy is STATED, not offered.
// An absence is exactly the kind of decision that gets quietly reversed by someone adding
// a helpful button, so it is asserted here: re-adding the affordance fails this test and
// re-opens the decision rather than sliding through.
//
// The subject is the SHIPPED DECLARATION that owns § Colour by, because that is where both
// facts live — the sentences are the view's own (INV-2), and the button that does not exist
// would have to be declared there to exist at all.
//
// The file is FOUND by the widget ids it declares, never named. Naming the owning package
// would put that package's vocabulary in the app tree, which is exactly what the domain
// guard forbids, and would also pin this test to which package happens to ship the section.
import { describe, test, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../../../../..')
const PACKAGES = path.join(REPO, 'src-app/packages')

/** The shipped view file that declares § Colour by's two column tables — located by the
 *  widget ids it declares, so no package name appears in the app tree. */
function colourByFile(): string {
  const hits: string[] = []
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const uiDir = path.join(PACKAGES, pkg.name, 'ui')
    if (!existsSync(uiDir)) continue
    for (const f of readdirSync(uiDir)) {
      if (!f.endsWith('.yaml')) continue
      const p = path.join(uiDir, f)
      const src = readFileSync(p, 'utf8')
      // The two HEADINGS the user reads, not the two table ids this section shipped before
      // ledger #32 replaced both grids with one `entry_list`. See `colourBy.test.ts` for the
      // same locator and the same reason.
      if (src.includes('heading: Groups') && src.includes('heading: Values')) hits.push(p)
    }
  }
  // Exactly one, asserted rather than `[0]`: two files declaring the same section is a
  // different bug, and picking the first would hide it.
  if (hits.length !== 1) {
    throw new Error(`expected exactly ONE shipped view declaring § Colour by, found ${hits.length}: ${hits}`)
  }
  return hits[0]
}
const COLOUR_BY = colourByFile()

interface Widget {
  id?: string
  kind?: string
  empty_text?: string
  columns?: unknown[]
  children?: Widget[]
}

function widgets(): Widget[] {
  const doc = parseYaml(readFileSync(COLOUR_BY, 'utf8')) as { widgets?: Widget[] }
  return doc.widgets ?? []
}

const byId = (id: string): Widget | undefined => widgets().find(w => w.id === id)

describe('TEST-81 — § Colour by states WHICH emptiness it is (ITEM-63)', () => {
  test('the shipped section exists and declares its list (positive control)', () => {
    // An absence test on a file that moved would pass for the wrong reason.
    expect(existsSync(COLOUR_BY), `the shipped section is missing: ${COLOUR_BY}`).toBe(true)
    expect(byId('columns')?.kind, 'the column list').toBe('entry_list')
  })

  // ── REWRITTEN (owner, ledger #32) ────────────────────────────────────────────────────
  //
  // TWO tests stood here: *"the CATEGORICAL emptiness is stated, and stated SHORT"* and *"the
  // CONTINUOUS emptiness is a DIFFERENT sentence"*. They were the section's half of ITEM-63,
  // and they were right about two grids: two tables fail INDEPENDENTLY, so one message covering
  // both would be wrong half the time.
  //
  // § Colour by is ONE list now, and one list cannot fail twice — "this row space declares no
  // columns" is a single fact. So the two tests become one, and it keeps every clause that
  // still applies: the emptiness is STATED, it is a LINE and not a paragraph (the owner has
  // objected to prose in a ~300px rail three times), and it names its own remedy.
  //
  // The subtraction is recorded rather than absorbed: the continuous half's remedy no longer
  // appears in the case where categorical columns exist and continuous ones do not. See the
  // matching note in `colourBy.test.ts`.
  test('the ONE emptiness is stated, stated SHORT, and names its remedy', () => {
    const text = byId('columns')?.empty_text ?? ''
    expect(text.length, 'the column list states no emptiness').toBeGreaterThan(0)
    expect(text, 'the emptiness is a line, not a paragraph').toMatch(/^.{0,90}$/s)
    expect(text).toMatch(/analysis|compute/i)
  })

  test('ITEM-66 descope: the merge state offers NO launch button', () => {
    // Asserted over the whole section, not just the categorical table, because a "merge
    // them" affordance added anywhere in this pane is the same reversal.
    const flat: Widget[] = []
    const walk = (ws: Widget[]): void => {
      for (const w of ws) {
        flat.push(w)
        if (Array.isArray(w.children)) walk(w.children)
      }
    }
    walk(widgets())
    const topLevelButtons = flat.filter(w => w.kind === 'button').map(w => w.id ?? '(unnamed)')
    expect(
      topLevelButtons,
      'a button was added to § Colour by — ITEM-66 descoped the merge affordance; the remedy ' +
        'is STATED, not offered. Re-open the decision rather than re-adding it.',
    ).toEqual([])
    // Belt and braces on the wording an affordance would carry, since a future one might be
    // declared with a different `kind`.
    const raw = readFileSync(COLOUR_BY, 'utf8')
    expect(/onClick:\s*\S*merge/i.test(raw), 'a merge action is wired into § Colour by').toBe(false)
  })
})

// ── TEST-77 (visualize-pane ITEM-63) — EIGHT EMPTINESSES, EIGHT SENTENCES ──────────────────
//
// ITEM-63's rule is that every emptiness says WHICH one it is. That rule is only meaningful as
// a DISCRIMINATION claim: eight `empty_text` keys that all read "nothing here" satisfy every
// per-surface test in this file while flattening exactly what the item forbids. So what is
// asserted below is the whole set at once — every pair distinct, and each one recognisable by
// the fact it names.
//
// ── two corrections to the enumeration, recorded rather than quietly absorbed ──────────────
//
// TESTS.md enumerated the eighth as the EMPTY CANVAS reading *"Pick a column and press ▶ to
// plot it"*. That string never shipped: the canvas empty state is owned by the canvas host
// (`extensions/canvas/CanvasView.tsx`), not by this pane, and it reads *"Nothing to plot yet /
// Run an analysis that produces a plottable artifact…"*. TEST-78's disposition recorded the
// same fact from the e2e side — this pane mounts no canvas surface of its own before anything
// is emitted. It is asserted here as a NINTH sentence, distinct from the pane's eight, rather
// than dropped: the claim worth keeping is that the canvas's emptiness is not confusable with
// any of the pane's.
//
// And the enumeration omitted one the pane really does own: the entry axis that RESOLVED and
// holds no entries — a different fact from "declares no such axis" and from "too many to list".
// It is included, so the set is the shipped set rather than the planned one.

import { entryAxisRefusal, entryBrowseRefusal } from '@/modules/workbench/core/runtime/axisEntries'
import { ENTRY_LIST_COPY } from '@/modules/workbench/extensions/visualize/EntryListWidget'

/** A shipped view found by widget ids it declares — same rule as `colourByFile`: no package
 *  name reaches the app tree. */
function viewDeclaring(...ids: string[]): Record<string, unknown> {
  const hits: string[] = []
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const uiDir = path.join(PACKAGES, pkg.name, 'ui')
    if (!existsSync(uiDir)) continue
    for (const f of readdirSync(uiDir)) {
      if (!f.endsWith('.yaml')) continue
      const p = path.join(uiDir, f)
      const src = readFileSync(p, 'utf8')
      if (ids.every(id => src.includes(`id: ${id}`))) hits.push(p)
    }
  }
  if (hits.length !== 1) throw new Error(`expected ONE view declaring ${ids.join('+')}, found ${hits.length}`)
  return parseYaml(readFileSync(hits[0], 'utf8')) as Record<string, unknown>
}

/** The axis term the ENGINE is handed by a declaration. Deliberately a word no domain owns:
 *  the sentence can only carry it by echoing the declaration back, which is what INV-14 says. */
const AXIS_TERM = 'widget'

const widgetsOf = (doc: Record<string, unknown>): Widget[] => (doc.widgets as Widget[] | undefined) ?? []
const pick = (doc: Record<string, unknown>, id: string): Widget | undefined =>
  widgetsOf(doc).find(w => w.id === id)

// SEVEN, NOT EIGHT (owner, ledger #32). `no_categorical` + `no_continuous` were two sentences
// because § Colour by was two tables; it is one list now and they are one fact. The
// DISCRIMINATION claim below is unchanged and is what this block is actually for — it just runs
// over the shipped set rather than over a number written down once.
describe('TEST-77 — the pane\'s emptinesses are all distinct sentences (ITEM-63)', () => {
  // The coordinate view is now found by its picker alone: its second locator id was
  // `coordinateAlignmentAlert`, and that widget was DELETED by ledger #28.
  const coordinates = viewDeclaring('coordinatePicker')
  const entries = viewDeclaring('entries', 'axisRefusalAlert')

  /** Each keyed by the FACT it states. Built once and asserted as a set. */
  const SENTENCES: Record<string, string> = {
    no_anchor: (byId('noAnchorAlert') as unknown as { text?: string } | undefined)?.text ?? '',
    no_coordinates: pick(coordinates, 'coordinatePicker')?.empty_text ?? '',
    no_columns: byId('columns')?.empty_text ?? '',
    // ENGINE-written: only the engine knows which of these it is, so the section renders the
    // string rather than guessing between them.
    no_such_axis: entryAxisRefusal(AXIS_TERM, 'no_such_axis', 0) ?? '',
    axis_too_large: entryBrowseRefusal(AXIS_TERM, 4_100_000),
    axis_lists_nothing: pick(entries, 'entries')?.empty_text ?? '',
    search_matched_nothing: ENTRY_LIST_COPY.noMatch,
  }

  test('all of them are STATED — none is blank', () => {
    for (const [fact, text] of Object.entries(SENTENCES)) {
      expect(text.trim().length, `the "${fact}" emptiness states nothing`).toBeGreaterThan(0)
    }
    expect(Object.keys(SENTENCES)).toHaveLength(7)
  })

  test('all of them are DISTINCT — no two emptinesses share a sentence', () => {
    const seen = new Map<string, string>()
    for (const [fact, text] of Object.entries(SENTENCES)) {
      const norm = text.replace(/\s+/g, ' ').trim().toLowerCase()
      const clash = seen.get(norm)
      expect(clash, `"${fact}" and "${clash}" state the same sentence — ITEM-63 forbids the flattening`).toBeUndefined()
      seen.set(norm, fact)
    }
    expect(seen.size).toBe(7)
  })

  test('each names the fact it is ABOUT, so a reader can tell them apart', () => {
    // The A0 sentence names WHAT IS MISSING, which is now a COORDINATE SET and not an axis
    // nobody chooses (owner, 2026-08-13): the pane's first block is § Coordinates, so the one
    // thing a reader can act on is picking one there.
    expect(SENTENCES.no_anchor).toMatch(/coordinate/i)
    expect(SENTENCES.no_coordinates).toMatch(/coordinates/i)
    expect(SENTENCES.no_columns).toMatch(/columns/i)
    // The axis TERM is echoed back from the DECLARATION — asserted with a term the domain
    // lattice does not contain, which is the stronger form of INV-14's claim: the engine can
    // only be repeating what it was handed, because it could not have known this word.
    expect(SENTENCES.no_such_axis).toMatch(new RegExp(`declare no ${AXIS_TERM} axis`, 'i'))
    // The SIZE is the reason, so the sentence carries it.
    expect(SENTENCES.axis_too_large).toMatch(/4,100,000/)
    expect(SENTENCES.axis_too_large).toMatch(/too many to list/i)
    // Resolved-and-empty is NOT "no results": no search has happened.
    expect(SENTENCES.axis_lists_nothing).toMatch(/lists no entries/i)
    expect(SENTENCES.axis_lists_nothing).not.toMatch(/search|result/i)
    expect(SENTENCES.search_matched_nothing).toMatch(/search/i)
  })

  test('the CANVAS emptiness is a ninth sentence, owned elsewhere and confusable with none of them', () => {
    // Read from the canvas host's own source, so this stays true if the pane never learns it.
    const canvasSrc = readFileSync(
      path.join(REPO, 'src-app/ui/src/modules/workbench/extensions/canvas/CanvasView.tsx'),
      'utf8',
    )
    const title = /data-testid="workbench-canvas-empty"[\s\S]*?title="([^"]+)"/.exec(canvasSrc)?.[1] ?? ''
    expect(title.length, 'the canvas states no emptiness').toBeGreaterThan(0)
    for (const [fact, text] of Object.entries(SENTENCES)) {
      expect(
        text.replace(/\s+/g, ' ').trim().toLowerCase(),
        `the canvas emptiness is indistinguishable from "${fact}"`,
      ).not.toBe(title.toLowerCase())
    }
  })
})
