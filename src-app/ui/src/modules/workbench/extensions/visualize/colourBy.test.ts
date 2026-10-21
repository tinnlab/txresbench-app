// TEST-58 (visualize-pane ITEM-45, as resolved by DRIFT-1.61) — **`Groups` AND `Values` ARE TWO
// HEADINGS OVER ONE DECLARED SPLIT, AND NEITHER NEEDED A NEW FIELD.**
//
// ── what changed under this ID, and why the ID did not move ──────────────────────────────
//
// ITEM-45 was planned as *"the `── Groups ──` / `── Values ──` headings, rendered through
// ITEM-22's group structure"* — one options list carrying two group headings, with the kind
// qualifier and level count riding in `description`. **DRIFT-1.61 (verdict: impl-wins) replaced
// the substrate**: ITEM-44's `columns_of` classifies a column by reading its VALUES, so a
// section built on it would have downloaded every column body on merely OPENING the pane —
// INV-11's own eager read, in a new costume. The column section is therefore built on a meta-only
// source (`row_space_columns`) and presents the split as TWO TABLES, headed `Groups` and
// `Values`.
//
// The ID is kept rather than retired because ITEM-45's actual CLAIM survived the substrate
// change intact, and it is the claim worth testing:
//
//   · the two headings the user reads are `Groups` and `Values`;
//   · the split is the PRODUCER'S DECLARED `kind`, not an inference from values;
//   · a row's level count / range rides in a field the shape already had — ITEM-45's
//     "no new field" clause, which is the half most likely to be quietly reversed;
//   · and the two halves are INDEPENDENT — separate slices, separate emptinesses.
//
// What is NOT asserted here, stated rather than left as a silent gap: the `── … ──` heading
// GLYPHS. They belong to the grouped-options renderer, which this section does not use; the
// grouped-options path itself is covered by `extensions/widgets/renderers.test.tsx`. Asserting
// a rule the shipped surface does not implement would be asserting a state the app never enters.
//
// The file is FOUND by the widget ids it declares, never named — same reason as its siblings.

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

import { shapeOf } from '@/modules/workbench/core/runtime/rowSpaceColumns'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../../../../..')
const PACKAGES = path.join(REPO, 'src-app/packages')

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
      // FOUND BY THE TWO HEADINGS THE USER READS, not by widget ids. It used to be
      // `id: categoricalColumns` + `id: continuousColumns` — the two TABLES this section
      // shipped before ledger #32 replaced them with one `entry_list`. The headings survived
      // the change of control (they are what the owner reads, and this file's first test is
      // about them), so they are the more durable locator as well as the more honest one.
      if (src.includes('heading: Groups') && src.includes('heading: Values')) hits.push(p)
    }
  }
  if (hits.length !== 1) {
    throw new Error(`expected exactly ONE shipped view declaring the column section, found ${hits.length}: ${hits}`)
  }
  return hits[0]
}

interface EntryListWidget {
  id?: string
  kind?: string
  entries?: string
  groups?: string
  grouped?: string
  browsable?: string
  counts?: string
  disposition?: string
  search?: { placeholder?: string }
  empty_text?: string
  action?: { label?: string; icon?: string; onClick?: string; args?: Record<string, string> }
}
interface Doc {
  widgets?: EntryListWidget[]
  data?: Record<string, { source?: string; args?: Record<string, unknown> }>
}

const DOC = parseYaml(readFileSync(colourByFile(), 'utf8')) as Doc
const byId = (id: string): EntryListWidget | undefined => (DOC.widgets ?? []).find(w => w.id === id)
/** The declared kind groups, in their declared ORDER — this section's domain claim. */
const KINDS = (DOC.data?.columns?.args?.kinds ?? []) as { kind?: string; heading?: string }[]

// ── REWRITTEN FOR THE LIST (owner, ledger #31 + #32) ──────────────────────────────────────
//
//   *"why can't we make it look like how entries look? With a search box, no need to use
//    table, each should have max heights for scrolling"*
//   *"each row in the group and values are too tall, we do not need row line"*
//
// This file used to assert the shape of TWO `table` widgets: their `heading`s, their column
// `title`s, that both read `$row.shape` under differently-titled columns, and that their key
// lists were identical. Every one of those assertions was about a control the owner asked to
// stop using. They are rewritten, not deleted — the FACTS underneath them are the section's
// contract and none of them was withdrawn:
//
//   · `Groups` and `Values` are still the two words the user reads, and are still the ONLY two;
//   · the split is still the producer's DECLARED kind and still never an inference from values;
//   · a row still states its shape, in the row's own vocabulary rather than in a grid tile;
//   · the ORDER is still the package's declaration and still nothing core decides.
//
// What is genuinely new — and is asserted because it is the owner's actual request — is the
// SHAPE: one control, a search box, a bounded scrolling list.

describe('TEST-58 — the column section presents ONE split under TWO headings (ITEM-45 / ledger #32)', () => {
  it('the two headings the user reads are `Groups` and `Values`, and they are the group headings', () => {
    // They used to be two `table.heading`s over two grids. They are now the headings of the two
    // GROUPS inside one list — which is exactly what they always described (the entry-axis section's `RNA` /
    // `ADT` are the same thing), and which is why the owner's "make it look like entries"
    // costs the section nothing it was saying.
    expect(KINDS.map(g => g.heading)).toEqual(['Groups', 'Values'])
  })

  it('the split is the PRODUCER\'S DECLARED kind, not an inference from values', () => {
    // ONE meta-only source now (INV-11: no column body is read to describe a column), carrying
    // the kinds as data rather than two copies of itself narrowed by `kind:`. `columns_of` —
    // the values-reading primitive DRIFT-1.61 refused — must not reappear here.
    expect(DOC.data?.columns?.source).toBe('row_space_columns')
    expect(KINDS.map(g => g.kind)).toEqual(['categorical', 'continuous'])
    const sources = Object.values(DOC.data ?? {}).map(s => s.source)
    expect(sources, 'a values-reading source is back in the section').not.toContain('columns_of')
  })

  it('CATEGORICAL IS FIRST, and that order lives in this file and nowhere else', () => {
    // The clause the two-slice form used to carry structurally (two `data:` keys in order).
    // With one slice the order is the array's, so it is asserted as the array's — and the
    // reason it is asserted at all is unchanged: a categorical column answers *what are the
    // groups*, which is the question people open the pane with.
    expect(KINDS[0]?.kind).toBe('categorical')
    expect(KINDS[1]?.kind).toBe('continuous')
  })

  it('it is the entry-axis section\' control — a searchable, bounded list, not a table', () => {
    const list = byId('columns')
    expect(list?.kind, 'the column section is not rendering the list control').toBe('entry_list')
    // The three things the owner named, each a declaration on this widget.
    expect(list?.search?.placeholder, 'no search box').toBeTruthy()
    expect(list?.entries).toBe('$data.columns.rows')
    expect(list?.groups).toBe('$data.columns.groups')
    // …and NO table is left behind. Asserted over every widget rather than over the two ids
    // that used to hold them, because the point is that the section stopped using the control.
    expect((DOC.widgets ?? []).filter(w => w.kind === 'table')).toEqual([])
  })

  it('an entry IS a column, so the disposition says so rather than leaving it open', () => {
    // INV-19 — the engine never decides what happens to an entry's N columns. Here N is 1 by
    // construction (an entry is the column), which is `one`, and declaring it is what stops
    // the per-source sub-affordances `each` brings from appearing over nothing.
    expect(byId('columns')?.disposition).toBe('one')
  })

  it('a row still states its shape — in the row, now, rather than in a grid tile', () => {
    // ITEM-45's "no new field" clause, which is the half most likely to be quietly reversed.
    // The level count (categorical) and the range (continuous) are the SAME engine-side field
    // they always were (`RowSpaceColumn.shape`); what changed is the slot it is printed in.
    // Asserted against the RESOLVER rather than the yaml, because with one control there is no
    // per-kind column title left in the declaration to read — and the resolver is where the
    // "one field, both halves" rule actually lives.
    expect(shapeOf({ kind: 'categorical', levels: 23 }).shape).toBe('23 levels')
    expect(shapeOf({ kind: 'continuous', min: 0, max: 9 }).shape).toBe('0 – 9')
  })

  it('the emit control is the SHARED one, declared by name and styled by nobody here', () => {
    // Ledger #33 — one emit control across the three sections. A section that could declare a
    // variant here is a section that can re-create the divergence, so what it declares is the
    // ICON NAME the shared control answers to, and nothing about how it looks.
    const action = byId('columns')?.action
    expect(action?.icon).toBe('plot')
    expect(action?.onClick).toBeTruthy()
    expect(JSON.stringify(action)).not.toMatch(/variant|border|ghost|outline/i)
  })

  it('ONE list is ONE emptiness — and it says which one it is', () => {
    // ── A DELIBERATE COLLAPSE, RECORDED (ledger #32) ────────────────────────────────────
    //
    // Two tables had two `empty_text`s, and ITEM-63's rule made that mandatory: they failed
    // INDEPENDENTLY, so one message covering both would have been wrong half the time. One
    // list cannot fail twice. "This row space declares no columns" is a single fact now, and a
    // group whose kind has no members simply renders no heading (a heading over nothing
    // inverts what a heading is) rather than a second sentence.
    //
    // What is LOST is the continuous half's remedy — *"an analysis has to compute them"* — in
    // the case where categorical columns exist and continuous ones do not. That is a real
    // subtraction and it is stated here rather than absorbed: the owner asked for the entry-axis section's
    // shape, the entry-axis section has one sentence, and adding a per-group empty line back would be the
    // prose-in-a-300px-rail the owner has objected to three times.
    const text = byId('columns')?.empty_text ?? ''
    expect(text.length).toBeGreaterThan(0)
    expect(text, 'the emptiness is a line, not a paragraph').toMatch(/^.{0,90}$/s)
    expect(text).toMatch(/analysis|compute/i)
  })
})
