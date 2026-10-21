// @vitest-environment jsdom
//
// The `multiselect` table COLUMN primitive, the per-row `when` gate, the FOLD and the icon row
// action — MOUNTED, through the real widget host and real registered renderers, with real
// registered actions on the other end.
//
// A table column could render free text, a per-row action, or a closed-set choice. A MULTI-value
// choice was still unexpressible, and it is ordinary: the closed-set column commits one value.
//
// And a per-row `when`: a column is ONE declaration over N rows, but which control a row NEEDS
// can be a property of that row. Without it a table can only offer every column to every row,
// which is how a control meant for one kind of row silently accepts input on another.
//
// (A `range_slider` per-row primitive lived here too, drawn under the row in a `row_detail` band.
// Both are deleted — the criteria row's bounds are its two numeric inputs and nothing else — so
// the tests that drove them are gone rather than repointed. The band's own placement tests had
// no other subject; the `when`-gate and fold tests below did, and kept theirs.)
//
// It drives the SHIPPED table (the declared columns come out of the contributed package) with a
// SYNTHETIC scope. That is deliberate on both counts: the primitives are exercised in the exact
// shape an author ships them in, and nothing in this file has to restate the vocabulary — the
// column keys, the bindings and the dispatch targets are all read off the spec, so a rename
// moves every assertion below with it instead of leaving them asserting a shape nothing renders.

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { defineAction, getActionMeta } from '@/core/actions/defineAction'
import type { ViewSpec, WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { parseViewSpec } from '@/modules/workbench/core/spec/schema'
import { ROW_PART_KEY, tableRowParts, tableRowPrimitives } from '@/modules/workbench/core/spec/schema'
import { __clearWidgetsForTests } from './registry'
import { installBuiltinWidgets, __resetBuiltinWidgetsForTests } from '@/modules/workbench/extensions'
import { WidgetList } from './WidgetHost'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
  else if (typeof globalThis.CSS.escape !== 'function') {
    ;(globalThis.CSS as { escape: (v: string) => string }).escape = (v: string) => v
  }
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent !== 'function') {
    ;(globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {} as never
    ;(window as unknown as { PointerEvent?: unknown }).PointerEvent = (
      globalThis as { PointerEvent?: unknown }
    ).PointerEvent
  }
  if (!window.matchMedia) {
    window.matchMedia = ((q: string) => ({
      matches: false,
      media: q,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
      onchange: null,
    })) as never
  }
})

/** The shipped-package root, resolved from the RUNNER's cwd rather than `import.meta.url`:
 *  under `@vitest-environment jsdom` the module URL is an `http:` one and `fileURLToPath`
 *  refuses it (the same resolution the shipped-form conformance tier uses). */
function findProcessorsDir(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'packages')
    if (existsSync(candidate) && readdirSync(candidate).some(d => existsSync(join(candidate, d, 'manifest.yaml')))) {
      return candidate
    }
    dir = join(dir, '..')
  }
  throw new Error('no packages/ package root found from ' + process.cwd())
}

/** The one shipped view that declares a per-row control of the given kind. Found by SHAPE — this
 *  file names no package, so the tier follows the primitive rather than a directory.
 *
 *  It searches every ROW-SCOPED part, which is the top-level columns AND the sub-parts of a
 *  FOLDED one: this file's whole method is to follow the primitive rather than its address, and
 *  the primitives it drives have moved address before. */
function findSpecDeclaring(primitive: string): ViewSpec {
  const root = findProcessorsDir()
  for (const pkg of readdirSync(root)) {
    const uiDir = join(root, pkg, 'ui')
    if (!existsSync(uiDir)) continue
    for (const file of readdirSync(uiDir)) {
      if (!file.endsWith('.yaml')) continue
      const parsed = parseViewSpec(parseYaml(readFileSync(join(uiDir, file), 'utf8')))
      const view = parsed.value as ViewSpec | undefined
      const found = (view?.widgets ?? []).some(w =>
        tableRowParts(w).some(c => tableRowPrimitives(c.decl).some(p => p.primitive === primitive)),
      )
      if (found) return view!
    }
  }
  throw new Error(`no shipped view declares a "${primitive}" part`)
}

const spec = findSpecDeclaring('multiselect')

/** The shipped row builder, and its declared part keys — read, never restated. */
const TABLE = spec.widgets.find(
  w => w.kind === 'table' && typeof (w as { rows?: string }).rows === 'string',
) as WidgetSpec & { id: string; columns: Array<{ key: string }> }
const TESTID = `widget-${TABLE.id}`

/** Every ROW-SCOPED part — the columns, and the sub-parts of a folded one — through the ONE
 *  shared reader. */
const ROW_PARTS = tableRowParts(TABLE).map(c => c.decl as { key: string })

/** Which per-row PRIMITIVE a part declares, and its declaration. One part, one primitive. */
function primitiveOf(key: string): { primitive: string; decl: Record<string, unknown> } {
  const col = ROW_PARTS.find(c => c.key === key)
  expect(col, `no "${key}" part`).toBeTruthy()
  const found = tableRowPrimitives(col)
  expect(found, `the "${key}" part declares exactly one per-row primitive`).toHaveLength(1)
  return { primitive: found[0].primitive, decl: found[0].decl as Record<string, unknown> }
}

/** The one part rendering `primitive`. Named by SHAPE so this file states no part key of
 *  its own — a renamed part moves every assertion with it, and so does a MOVED one: the bounds
 *  were columns and are now sub-parts of a fold, and nothing below had to say so. */
function partFor(primitive: string): string {
  const col = ROW_PARTS.find(c => tableRowPrimitives(c).some(p => p.primitive === primitive))
  expect(col, `no row-scoped part renders a "${primitive}"`).toBeTruthy()
  return col!.key
}

const SET_COLUMN = partFor('multiselect')
/** The bound (free-text) parts — through `ROW_PARTS`, the SHARED enumeration, never through
 *  `TABLE.columns`.
 *
 *  This line used to read `.columns`, and the fold is the second time that spelling has gone
 *  quietly wrong: the bounds are no longer columns of their own, they are sub-parts of one
 *  folded column, so the filter matched NOTHING and every assertion driven off this list became
 *  vacuously true. That is the identical failure the detail band caused one round earlier, at a
 *  different address — which is the whole argument for there being ONE reader. */
const BOUND_PARTS = ROW_PARTS.filter(c =>
  tableRowPrimitives(c).some(p => p.primitive === 'editable_text'),
).map(c => c.key)
// The list is what several assertions below iterate; empty would make them all pass saying
// nothing, so its non-emptiness is asserted rather than assumed.
expect(BOUND_PARTS.length, 'the shipped row builder declares no free-text bound part').toBeGreaterThan(0)

/** The gate expressions the two families declare — likewise read off the spec. The BOUND gate
 *  is read off a bound part rather than off the deleted range control, which is where it used to
 *  come from; both bounds carry the same one. */
const boundGate = String(primitiveOf(BOUND_PARTS[0]).decl.when)
const setGate = String(primitiveOf(SET_COLUMN).decl.when)
/** The derived names those gates are keyed on. Extracted from the DECLARED bindings so a
 *  synthetic scope cannot diverge from what the spec actually reads. */
const derivedName = (expr: string): string => /\$derived\.([A-Za-z0-9_]+)/.exec(expr)![1]
const CONTROL_MAP = derivedName(boundGate)
const OPTION_MAP = derivedName(String(primitiveOf(SET_COLUMN).decl.options))
/** The two values the gates compare against (`… == range` / `… == multiselect`). */
const gateValue = (expr: string): string => expr.split('==').pop()!.trim()
const RANGE_KIND = gateValue(boundGate)
const SET_KIND = gateValue(setGate)
/** Which row FIELD each control is bound to — `$row.<field>`. */
const fieldOf = (expr: unknown): string => /\$row\.([A-Za-z0-9_]+)/.exec(String(expr))![1]
/** The row fields the bound parts write, in declaration order. */
const BOUND_FIELDS = BOUND_PARTS.map(key => fieldOf(primitiveOf(key).decl.value))
// The field the row's own CLOSED-SET column is bound to — found by SHAPE, never by position: a
// declared column list is authored in whatever order its contributor wrote it, and the contract
// promises nothing about which one is first.
const COLUMN_FIELD = fieldOf(primitiveOf(partFor('select')).decl.value)

const SPEC_ID = 'trc'
/** Register the SHIPPED dispatch targets, capturing every payload. The action registry is
 *  process-global with no reset seam, so each id is registered once for the whole file. */
const payloads = new Map<string, Record<string, unknown>[]>()
function captureTargets(): void {
  for (const col of ROW_PARTS) {
    for (const { decl } of tableRowPrimitives(col)) {
      for (const key of ['onChange', 'onClick', 'onCommit']) {
        const local = (decl as Record<string, unknown>)[key]
        if (typeof local !== 'string' || local === '') continue
        const id = `${SPEC_ID}::${local}`
        if (!payloads.has(local)) payloads.set(local, [])
        if (getActionMeta(id)) continue
        defineAction({
          id,
          title: local,
          permission: 'jobs::use',
          mutating: true,
          params: z.object({}).passthrough(),
          run: async (p: unknown) => {
            payloads.get(local)!.push(p as Record<string, unknown>)
          },
        })
      }
    }
  }
}
captureTargets()

const committedTo = (decl: Record<string, unknown>): Record<string, unknown>[] =>
  payloads.get(String(decl.onCommit ?? decl.onChange))!

type Row = Record<string, unknown>
const MEASURED = 'm'
const LABELLED = 'k'
/** A row of the CONTINUOUS kind — every bound field present and blank, over the picked column. */
const blankBounds = (): Row => Object.fromEntries(BOUND_FIELDS.map(f => [f, '']))
const spanning = (over: Row = {}): Row => ({ [COLUMN_FIELD]: MEASURED, ...blankBounds(), ...over })
const labelled = (): Row => ({ [COLUMN_FIELD]: LABELLED, ...blankBounds() })

function mount(rows: Row[]): void {
  installBuiltinWidgets()
  const scope: Scope = {
    params: {},
    state: { criteria: rows },
    derived: {
      [CONTROL_MAP]: { [MEASURED]: RANGE_KIND, [LABELLED]: SET_KIND },
      [OPTION_MAP]: { [LABELLED]: ['x', 'y'] },
      columns: [{ value: MEASURED }, { value: LABELLED }],
    },
    const: {},
    data: {},
  }
  // The table's own `rows` binding names the state field; the scope above supplies it.
  const table = { ...(TABLE as object), rows: TABLE.columns && (TABLE as { rows: string }).rows } as WidgetSpec
  render(<WidgetList specs={[table]} scope={scope} viewId="v1" specId={SPEC_ID} />)
}

const controlAt = (primitive: string, column: string, row: number): HTMLElement | null =>
  screen.queryByTestId(`${TESTID}-${primitive}-${column}-${row}`)
// ── where a row's parts actually LAND (the placement half) ────────────────────────────────
//
// The grid the kit renders. Everything below is read off the DOM rather than off the spec,
// because placement is the one property a spec assertion cannot see.
const GRID = `${TESTID}-grid`
/** How many columns the header declares — what the FOLD's width claim is measured against. */
const headerColumnCount = (): number =>
  screen.getByTestId(GRID).querySelectorAll('thead th').length

beforeEach(() => {
  __resetBuiltinWidgetsForTests()
  cleanup()
  for (const list of payloads.values()) list.length = 0
})
afterEach(() => {
  __clearWidgetsForTests()
})

describe('a per-row `when` decides which controls a row gets', () => {
  it('a row whose gate is FALSE renders none of the gated controls', () => {
    mount([spanning(), labelled()])
    for (const key of BOUND_PARTS) {
      expect(controlAt('edit', key, 0), `row 0 draws its "${key}"`).not.toBeNull()
      expect(controlAt('edit', key, 1), `row 1 must not draw "${key}"`).toBeNull()
    }
    // …and the reverse. A keep-set on a row whose column is measured is a control whose every
    // choice means nothing, and whose use silently reclassifies the criterion.
    expect(controlAt('multiselect', SET_COLUMN, 0)).toBeNull()
    expect(controlAt('multiselect', SET_COLUMN, 1)).not.toBeNull()
  })
})

describe('a multi-value column commits a SET on one row', () => {
  it('each row shows its OWN set, from its OWN options', () => {
    mount([{ ...labelled(), keep: ['x'] }, { ...labelled(), keep: ['y'] }])
    expect(controlAt('multiselect', SET_COLUMN, 0)!.textContent).toContain('x')
    expect(controlAt('multiselect', SET_COLUMN, 0)!.textContent).not.toContain('y')
    expect(controlAt('multiselect', SET_COLUMN, 1)!.textContent).toContain('y')
  })
})

// ── the FOLD: mutually-exclusive controls sharing ONE column ─────────────────────────────────
//
// REPORTED: the criteria table was wider than the dock pane it lives in, so the last heading and
// the row action were cut off. One of the two structural causes was here — a grid reserves a
// column's width on EVERY row, and this row's `when` gates make bounds and a keep-set mutually
// exclusive, so each row paid permanent width for a control it could never use.
//
// Everything below is read off the SHIPPED spec + the rendered DOM, because the fold's whole
// claim is that it changes PLACEMENT and nothing else. A spec-only assertion cannot see
// placement, and a DOM-only one cannot see that the parts kept their names.
describe('mutually exclusive controls share one column without losing their identity', () => {
  /** The folded container the shipped spec declares, if any — found by SHAPE (a column with
   *  sub-parts), so this file still names no key of its own. */
  const foldedColumn = (): { key: string; parts: Array<{ key: string }> } | undefined =>
    (TABLE.columns as Array<{ key: string; parts?: Array<{ key: string }> }>).find(
      c => Array.isArray(c.parts) && c.parts.length > 1,
    ) as { key: string; parts: Array<{ key: string }> } | undefined

  it('the shipped builder folds its per-row-exclusive controls into ONE column', () => {
    const folded = foldedColumn()
    expect(folded, 'no shipped column folds its sub-parts — the grid is back to one column each').toBeTruthy()
    // The parts it holds are exactly the ones the row's gate makes exclusive: the bounds and
    // the keep-set. Derived, never restated — this file names no part key.
    const held = new Set(folded!.parts.map(p => p.key))
    for (const key of [...BOUND_PARTS, SET_COLUMN]) {
      expect(held.has(key), `"${key}" is not inside the folded column`).toBe(true)
    }
    // …and there are FEWER columns than row-scoped parts, which is the width claim itself.
    expect(TABLE.columns.length).toBeLessThan(ROW_PARTS.length)
  })

  it('a folded column draws ONLY the control its row’s gate calls for', () => {
    mount([spanning(), labelled()])
    // Row 0 is continuous: its bounds are drawn, its keep-set is not.
    for (const key of BOUND_PARTS) expect(controlAt('edit', key, 0), `row 0 "${key}"`).not.toBeNull()
    expect(controlAt('multiselect', SET_COLUMN, 0), 'row 0 drew a keep-set it cannot use').toBeNull()
    // Row 1 is categorical: the exact reverse, in the SAME column.
    for (const key of BOUND_PARTS) expect(controlAt('edit', key, 1), `row 1 "${key}"`).toBeNull()
    expect(controlAt('multiselect', SET_COLUMN, 1), 'row 1 "keep"').not.toBeNull()
  })

  it('the folded controls sit in ONE grid box of their row, not in three', () => {
    // The placement claim, measured: both bounds share a single `<td>`. Asserting only that
    // both RENDER would stay green if the fold had quietly become three columns again.
    mount([spanning()])
    const boxOf = (key: string): Element | null => controlAt('edit', key, 0)!.closest('td')
    const boxes = new Set(BOUND_PARTS.map(boxOf))
    expect(boxes.size, 'the folded bounds are drawn in separate boxes').toBe(1)
    // …and the header declares one heading for them, not one per part.
    expect(headerColumnCount()).toBe(TABLE.columns.length)
    expect(headerColumnCount()).toBeLessThan(ROW_PARTS.length)
  })

  it('a folded control keeps its own testid, accessible name and verdict address', () => {
    // This is what "the fold is a placement" MEANS operationally: every address a caller can
    // hold onto is unchanged. A fold that renamed its parts would break e2e selectors, the
    // per-row `at.part` address, and the accessible names — silently, one at a time.
    mount([spanning()])
    for (const key of BOUND_PARTS) {
      const el = controlAt('edit', key, 0)!
      expect(el.getAttribute('aria-label'), `"${key}" row 0 name`).toBe(`${key} row 1`)
    }
    expect(controlAt('edit', BOUND_PARTS[0], 0)!.tagName.toLowerCase()).toBe('input')
  })

  it('a folded free-text control shows the column’s declared placeholder', () => {
    // One heading cannot name two ends of a range, so the ends say it themselves. Without this
    // the fold trades a clipped control for an anonymous pair of boxes.
    mount([spanning()])
    const declared = BOUND_PARTS.map(key => String(primitiveOf(key).decl.placeholder ?? ''))
    expect(
      declared.every(p => p !== ''),
      `a folded bound declares no placeholder: ${declared.join(' / ')}`,
    ).toBe(true)
    for (const [i, key] of BOUND_PARTS.entries()) {
      expect(controlAt('edit', key, 0)!.getAttribute('placeholder')).toBe(declared[i])
    }
    // They must not be the SAME word, or the pair is still anonymous.
    expect(new Set(declared).size).toBe(declared.length)
  })
})

// ── the row ACTION as an icon (the other half of the width fix) ──────────────────────────────
describe('a per-row action can be an icon without becoming nameless', () => {
  const ACTION_PART = partFor('button')

  it('the shipped action draws a GLYPH and no text, and is still named for the row', () => {
    mount([spanning()])
    const el = controlAt('action', ACTION_PART, 0)
    expect(el, 'the row action did not render').not.toBeNull()
    const declared = primitiveOf(ACTION_PART).decl
    expect(declared.icon, 'the shipped action declares no icon — it is a text button again').toBeTruthy()
    // A glyph, not a word: the visible text is gone…
    expect(el!.textContent?.trim() ?? '').toBe('')
    expect(el!.querySelector('svg'), 'an icon action with no glyph is an empty square').not.toBeNull()
    // …and the declared label survives as the accessible name, carrying the ROW with it.
    expect(el!.getAttribute('aria-label')).toContain(String(declared.label))
    expect(el!.getAttribute('aria-label')).toContain('row 1')
  })

  it('an icon action still DISPATCHES its declared target with the row index', () => {
    // A control that reads correctly and does nothing is the worse half of this trade.
    mount([spanning(), labelled()])
    const declared = primitiveOf(ACTION_PART).decl
    act(() => {
      fireEvent.click(controlAt('action', ACTION_PART, 1)!)
    })
    const seen = payloads.get(String(declared.onClick))!
    expect(seen).toHaveLength(1)
    expect(seen[0].index).toBe(1)
  })

  it('an UNREGISTERED icon name degrades to the labelled button, never to a blank one', () => {
    // The registry is closed on purpose. The failure it must not have is a view naming a glyph
    // that does not exist and getting a control with nothing in it.
    installBuiltinWidgets()
    const declared = primitiveOf(ACTION_PART).decl
    const table = {
      ...(TABLE as object),
      columns: [
        {
          key: 'act',
          title: '',
          [ROW_PART_KEY]: { button: { ...declared, icon: 'no-such-glyph-in-the-registry' } },
        },
      ],
    } as unknown as WidgetSpec
    render(
      <WidgetList
        specs={[table]}
        scope={{ params: {}, state: { criteria: [spanning()] }, derived: {}, const: {}, data: {} }}
        viewId="v3"
        specId={SPEC_ID}
      />,
    )
    const el = screen.getByTestId(`${TESTID}-action-act-0`)
    expect(el.querySelector('svg'), 'an unregistered name rendered a glyph anyway').toBeNull()
    expect(el.textContent?.trim()).toBe(String(declared.label))
  })
})
