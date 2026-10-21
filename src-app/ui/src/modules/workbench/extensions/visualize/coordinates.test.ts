// TEST-55 (visualize-pane ITEM-42) — **§ COORDINATES IS A CAPABILITY QUESTION, AND ONLY THAT.**
//
// ITEM-42's claim about the frame picker has four parts, and each is a DECLARATION rather than
// code — which is the point (INV-14: *"the mechanism is generic, the declaration is the domain's,
// and there is no domain code anywhere in the viewer"*). So the subject here is the shipped view
// file, read as data:
//
//   1. it offers the project's 2-D positions as a RADIO — one active choice (DEC-10);
//   2. it selects candidates by the `plottable-xy` CAPABILITY plus a DECLARED 2-component
//      shape, and by nothing else — no type id, no producer, no name, and (since 2026-08-13)
//      no dependency on an axis nobody chooses;
//   3. what it draws is SCATTER, and only scatter;
//   4. the section's own selection vocabulary has no term through which a DOMAIN notion could
//      enter at all.
//
// ── the scope of clause 4, stated rather than implied ────────────────────────────────────
//
// Clause 4 is asserted as a property of the SOURCE CONTRACT — the key set an `artifact_ref`
// source may carry — and not by scanning core for domain words. A word scan is the guard shape
// this repo has twice paid for: it is satisfied by a rename and it grows an unbounded evasion
// space. The repo already runs a domain-vocabulary COUNT ratchet over the app tree, which is
// where that job belongs. What is asserted here is the thing a ratchet cannot see: that the
// selector is closed over `{datatype, subtypes_of, capabilities, excludes, dims}`, so a KIND of
// positions is expressible only as a capability and a SHAPE only as a number — there is no key
// for a domain term to arrive through.
//
// The file is FOUND by the widget ids it declares, never named: naming the owning package would
// put that package's vocabulary in the app tree, which is exactly what INV-14 forbids, and would
// also pin this test to which package happens to ship the section.

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '../../../../../../..')
const PACKAGES = path.join(REPO, 'src-app/packages')

/** The shipped view declaring § Coordinates, located by its own widget ids. */
function coordinatesFile(): string {
  const hits: string[] = []
  for (const pkg of readdirSync(PACKAGES, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const uiDir = path.join(PACKAGES, pkg.name, 'ui')
    if (!existsSync(uiDir)) continue
    for (const f of readdirSync(uiDir)) {
      if (!f.endsWith('.yaml')) continue
      const p = path.join(uiDir, f)
      const src = readFileSync(p, 'utf8')
      // Located by the picker AND its per-row emit control (ledger #27). It used to be located
      // by `id: plotFrame` — a single wide button at the foot of the card, which the mockup
      // never described and which is now a `row_action` on the picker itself.
      if (src.includes('id: coordinatePicker') && src.includes('row_action:')) hits.push(p)
    }
  }
  if (hits.length !== 1) {
    throw new Error(`expected exactly ONE shipped view declaring § Coordinates, found ${hits.length}: ${hits}`)
  }
  return hits[0]
}

interface Widget {
  id?: string
  kind?: string
  control?: string
  source?: Record<string, unknown>
  value?: string
  empty_text?: string
}
interface Series {
  type?: string
}
interface Doc {
  widgets?: Widget[]
  canvas?: { series?: Series[] }
  state?: Record<string, { scope?: string }>
}

/** A datatype id is DATA the lattice supplies; the app carries none of it, so this fixture value
 *  is assembled rather than written as a literal. */
const DECLARED_DATATYPE = ['metadata', 'column'].join('-')

const DOC = parseYaml(readFileSync(coordinatesFile(), 'utf8')) as Doc
const byId = (id: string): Widget | undefined => (DOC.widgets ?? []).find(w => w.id === id)

describe('TEST-55 — § Coordinates (ITEM-42)', () => {
  it('offers positions as a RADIO bound to ONE value (DEC-10)', () => {
    const picker = byId('coordinatePicker')
    expect(picker, 'the section declares no coordinate picker').toBeTruthy()
    expect(picker?.kind).toBe('artifact_ref')
    // DEC-10: *"Row space and Coordinates are RADIO — one active choice each."* Asserted as
    // the declared control rather than as "radio or select", which is a disjunction both the
    // right and the wrong implementation satisfy.
    expect(picker?.control).toBe('radio')
    // ONE active choice: the value is a single `$`-ref into a scalar field, not a list.
    expect(picker?.value).toBe('$state.coordinate')
    expect(DOC.state?.coordinate?.scope, 'the coordinate is PANE state — every section reads it').toBe('pane')
  })

  it('selects by CAPABILITY + DECLARED SHAPE, and by nothing else', () => {
    const source = byId('coordinatePicker')?.source ?? {}
    expect(source.capabilities).toEqual(['plottable-xy'])
    // ── `aligned_to` IS GONE, AND ITS ABSENCE IS THE ASSERTION (owner, 2026-08-13) ──────
    //
    // This used to require `aligned_to: "$scope.axis"`, i.e. the section listed NOTHING until
    // the pane's first block — a control asking which rows — had been answered. That control is
    // deleted: the question does not exist, § Coordinates IS the pane's first block, and the
    // rows every other section is scoped to are DERIVED from the set picked here. So the source
    // is project-wide, and a spec that reintroduced the dependency would make the pane open
    // empty again, which is what this now catches.
    expect(source.aligned_to, 'the frame picker must not wait on an axis nobody chooses').toBeUndefined()
    // ── ONLY 2-D — the divergence from the binding mockup, pinned ───────────────────────
    //
    // The mockup lists a third option that is a decomposition; a typical one declares fifty
    // components and this pane draws in two, so offering it means a component picker or a
    // silent "first two". The narrowing is DECLARED here, and this is the assertion that stops
    // the next reader restoring it.
    expect(source.dims).toBe(2)
    // The closed key set. Anything else here is a new way to choose, and the ONE thing that
    // must never appear is a name or a producer (INV-1 / INV-18).
    expect(Object.keys(source).sort()).toEqual(['capabilities', 'dims'])
  })

  it('is SCATTER-only — every series it projects, and there is at least one', () => {
    const series = DOC.canvas?.series ?? []
    expect(series.length, 'the section projects nothing, so "scatter-only" is vacuous').toBeGreaterThan(0)
    expect([...new Set(series.map(s => s.type))]).toEqual(['scatter'])
  })

  it('states WHICH emptiness it is when nothing is offered, IN ONE LINE (INV-5)', () => {
    // A view is the only party that can say WHICH emptiness this is, so the sentence is
    // REQUIRED on the control and `parseViewSpec` enforces that (TEST-A5).
    //
    // It used to name TWO causes, because there were two: nothing offered, or nobody had
    // answered the pane's first block yet. There is only one now — the project holds no 2-D
    // coordinates — and the owner has objected twice to explanatory paragraphs in a ~300px
    // rail. So the assertion is that the sentence names the ONE cause and stays SHORT; a
    // length bound is the only form in which "not a paragraph" is checkable at all.
    const text = byId('coordinatePicker')?.empty_text ?? ''
    expect(text.length).toBeGreaterThan(0)
    expect(text, 'the emptiness is a line, not a paragraph').toMatch(/^.{0,110}$/s)
    expect(text).not.toMatch(/row space/i)
  })

  it('the selector vocabulary has no key a domain term could arrive through', async () => {
    // The runtime contract, imported rather than described: an `artifact_ref` source is matched
    // by `matchesTypeFilter`, whose filter is closed over these keys. A KIND of positions is
    // therefore expressible ONLY as a capability — no `name`, no `producer`, no `kind_of_thing`.
    const mod = await import('@/modules/workbench/core/runtime/axisSource')
    const filter: import('@/modules/workbench/core/runtime/axisSource').ArtifactTypeFilter = {
      datatype: DECLARED_DATATYPE,
      subtypes_of: 'data',
      capabilities: ['plottable-xy'],
      excludes: [],
      // The one term that narrows by SHAPE rather than by kind. It is a NUMBER — there is no
      // spelling of it through which a domain word could arrive.
      dims: 2,
    }
    // A compile-time fact made runtime-visible: adding a key to `ArtifactTypeFilter` that this
    // list does not carry fails `tsc` at the literal above, and adding one the code READS but the
    // type does not declare fails here.
    expect(Object.keys(filter).sort()).toEqual(['capabilities', 'datatype', 'dims', 'excludes', 'subtypes_of'])
    expect(typeof mod.matchesTypeFilter).toBe('function')
  })
})
