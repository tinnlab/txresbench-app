// @vitest-environment jsdom
//
// TEST-59 / TEST-61 / TEST-63 / TEST-68 / TEST-69 / TEST-70 / TEST-71 / TEST-72 / TEST-73 /
// TEST-74 / TEST-A17 (ITEM-46 … ITEM-60) — the ENTRY SECTION as it is actually RENDERED.
//
// ── Why these assertions are against the DOM and not against the declaration ───────────
//
// The previous slice found a ▶ declared on a table COLUMN rather than under the per-row
// primitive it belongs under: it parsed, it validated, and it rendered nothing — and the
// conformance spec read the same wrong shape and agreed with the bug. A test that asserts a
// spec HAS an `action` key would have passed against a widget that ignored it. So every control
// here is found in the rendered output, pressed, and its dispatch observed.
//
// The other half is the SHIPPED declaration: several rules (that the display choice is section
// state and not pane state, that what is emitted is the KEY) are only true if the shipped yaml
// says so, and asserting them against a hand-written fixture would prove nothing about what
// users get. Those cases DISCOVER the shipped spec by the mechanism it declares — the one
// `ui/*.yaml` on disk carrying an `entry_list` — rather than by naming a package, so the
// assertion is about the mechanism and survives a package being renamed or added.

import * as React from 'react'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { defineAction } from '@/core/actions/defineAction'
import type { WidgetSpec } from '@/modules/workbench/core/manifest/viewSpec'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { __clearWidgetsForTests } from '@/modules/workbench/core/render/registry'
import { WidgetList } from '@/modules/workbench/core/render/WidgetHost'
import { PANE_SCOPE_KEYS } from '@/modules/workbench/core/runtime/paneScopeKeys'
import { describeEntryRows, type EntryAnnotation } from '@/modules/workbench/core/runtime/axisEntryRows'
import { installVisualizeWidgets, __resetVisualizeWidgetsForTests } from './installVisualizeWidgets'
import { ENTRY_LIST_COPY } from './EntryListWidget'

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  if (typeof (globalThis as { PointerEvent?: unknown }).PointerEvent !== 'function') {
    ;(globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {} as never
  }
})

let dispatched: Array<{ action: string; args: Record<string, unknown> }> = []

beforeEach(() => {
  cleanup()
  __clearWidgetsForTests()
  __resetVisualizeWidgetsForTests()
  installVisualizeWidgets()
  dispatched = []
})
afterEach(cleanup)

// ── the fixture: vocabulary-free, and CONTESTED on purpose ─────────────────────────────
//
// Two entries whose displayed name is the same and whose declared group differs — the shape
// INV-15 says is the CORRECT result rather than a collision to resolve. Nothing here is a
// modality: the grouping column is "Pool" and its values are "left"/"right".

const KEYS = ['k-1', 'k-2', 'k-3', 'k-4']
const ALPHA = 'ann-alpha'
const POOL = 'ann-pool'
const KEY_ARTIFACT = 'ann-key'

const ANNOTATIONS: EntryAnnotation[] = [
  { value: ALPHA, label: 'Alpha', is_key: false, groups: false },
  { value: KEY_ARTIFACT, label: 'Item id', is_key: true, groups: false },
  { value: POOL, label: 'Pool', is_key: false, groups: true },
]

const VALUES = new Map<string, readonly string[]>([
  [ALPHA, ['solo', 'shared', '', 'shared']],
  [POOL, ['left', 'left', 'right', 'right']],
])

/** Displayed by `Alpha` — the CONTESTED arrangement (two rows both reading `shared`). */
const ROWS = describeEntryRows(KEYS, ANNOTATIONS, VALUES, { artifact: POOL }, null)
/** Displayed by the KEY — the section's own default. Nothing is contested under it, which is
 *  itself the point: the contest is a fact about the DISPLAYED names. */
const ROWS_BY_KEY = describeEntryRows(
  KEYS,
  [ANNOTATIONS[1], ANNOTATIONS[0], ANNOTATIONS[2]],
  VALUES,
  { artifact: POOL },
  null,
)
const GROUPS = [
  { name: 'left', count: 2 },
  { name: 'right', count: 2 },
]
/** TWO value sources for the whole axis — the `each` disposition's N. */
const SOURCES = [
  { artifact: 'src-raw', title: 'raw' },
  { artifact: 'src-norm', title: 'normalized' },
]

// The two actions the widget dispatches. Registered under the view-spec namespace
// (`${specId}::${localId}`) the declarative dispatcher resolves against, so the press goes
// through the REAL routing rather than a stub the test holds.
const PLOT = `plotEntry${Date.now()}`
const SHOW = `showAnnotation${Date.now()}`
for (const local of [PLOT, SHOW]) {
  defineAction({
    id: `t/spec::${local}`,
    title: local,
    permission: 'jobs::use',
    mutating: true,
    params: z.object({}).passthrough(),
    run: async (args: Record<string, unknown>) => {
      dispatched.push({ action: local, args })
    },
  })
}

interface Over {
  rows?: unknown
  groups?: unknown
  grouped?: boolean
  annotations?: unknown
  showSelect?: boolean
  showValue?: string
  showNote?: string | null
  sources?: unknown
  counts?: unknown
  widget?: Record<string, unknown>
}

function mount(over: Over = {}): void {
  const w = {
    id: 'ents',
    kind: 'entry_list',
    label: 'Entries',
    disposition: 'each',
    entries: '$data.entries.rows',
    sources: '$data.entries.sources',
    groups: '$data.entries.groups',
    grouped: '$data.entries.grouped',
    counts: '$derived.plot_counts',
    search: { placeholder: 'Find an entry…' },
    show: {
      label: 'Show:',
      options: '$data.entries.annotations',
      value: '$data.entries.show',
      onChange: SHOW,
      when: '$data.entries.show_select',
      note: '$data.entries.show_note',
    },
    action: { label: 'Plot', icon: 'play', onClick: PLOT },
    ...(over.widget ?? {}),
  } as unknown as WidgetSpec
  const scope: Scope = {
    params: {},
    state: {},
    derived: { plot_counts: over.counts ?? {} },
    const: {},
    data: {
      entries: {
        rows: over.rows ?? ROWS,
        groups: over.groups ?? GROUPS,
        grouped: over.grouped ?? true,
        annotations: over.annotations ?? ANNOTATIONS,
        show_select: over.showSelect ?? true,
        show: over.showValue ?? ALPHA,
        show_note: over.showNote === undefined ? null : over.showNote,
        sources: over.sources ?? SOURCES,
      },
    },
  }
  render(<WidgetList specs={[w]} scope={scope} viewId="v" specId="t/spec" />)
}

const press = (testid: string): void => {
  fireEvent.click(screen.getByTestId(testid))
}

// ── ITEM-46 / ITEM-30 / ITEM-34: a row is a VERB ───────────────────────────────────────

describe('every row is a VERB with a ▶, and no choice (ITEM-34 / DEC-10, TEST-59)', () => {
  it('renders a persistent search input and NO checkbox on any row', () => {
    mount()
    expect(screen.getByTestId('widget-ents-search')).toBeTruthy()
    expect(screen.queryByTestId('widget-ents-toggle-k-1')).toBeNull()
  })

  it('the ▶ names THE ROW UNAMBIGUOUSLY, not the verb (ITEM-30)', () => {
    mount()
    // Not "Plot" — forty rows called "Plot" would be forty identical accessible names.
    //
    // And not the bare LABEL either, which is what this assertion used to pin: a label is
    // contested-by-construction on an entry axis (two rows legitimately read the same), so a
    // button named after it produces two buttons with one name — ITEM-30's defect one step
    // later, and invisible to a fixture whose labels all differ. The name is the row's
    // ALWAYS-qualified `title`, which is the field that exists precisely because it is read
    // alone with no neighbours to compare against.
    expect(screen.getByTestId('widget-ents-plot-k-1').getAttribute('aria-label')).toBe('Plot solo (left)')
    expect(screen.getByTestId('widget-ents-plot-k-3').getAttribute('aria-label')).toBe('Plot k-3 (right)')
  })

  it('a REFUSED ▶ states its cause and dispatches nothing — never a dead control', async () => {
    const refused = ROWS.map(r => ({ ...r, plot_refusal: 'nothing carries values for these entries' }))
    mount({ rows: refused })
    const button = screen.getByTestId('widget-ents-plot-k-1')
    // aria-disabled, never natively disabled — the whole point of the gate is that the control
    // can still STATE its cause, which it does in an sr-only node inside itself.
    expect(button.getAttribute('aria-disabled')).toBe('true')
    expect(button.textContent).toContain('nothing carries values for these entries')
    press('widget-ents-plot-k-1')
    await new Promise(r => setTimeout(r, 10))
    expect(dispatched).toEqual([])
  })
})

// ── DEC-9 / ITEM-59: what one press emits ──────────────────────────────────────────────

describe('what a press EMITS (DEC-9 / ITEM-59, TEST-73)', () => {
  it('under `each`, ONE parent press emits one plot PER SOURCE', async () => {
    mount()
    press('widget-ents-plot-k-1')
    await waitFor(() => expect(dispatched).toHaveLength(2))
    expect(dispatched.map(d => d.args.artifact)).toEqual(['src-raw', 'src-norm'])
    // …each carrying the ENTRY KEY as its identity (ITEM-57) and the ALWAYS-qualified title
    // (ITEM-58), never the label alone.
    expect(dispatched[0].args.entry).toBe('k-1')
    expect(dispatched[0].args.title).toBe('solo (left)')
    expect(dispatched[0].args.position).toBe(0)
  })

  it('a PER-SOURCE ▶ emits exactly that one', async () => {
    mount()
    press('widget-ents-plot-k-1-normalized')
    await waitFor(() => expect(dispatched).toHaveLength(1))
    expect(dispatched[0].args.artifact).toBe('src-norm')
  })

  it('under `combined` the parent emits ONCE and no per-source control exists', async () => {
    mount({ widget: { disposition: 'combined' } })
    expect(screen.queryByTestId('widget-ents-plot-k-1-raw')).toBeNull()
    press('widget-ents-plot-k-1')
    await waitFor(() => expect(dispatched).toHaveLength(1))
    expect(dispatched[0].args.artifact).toBeUndefined()
  })

  it('a SECOND press of the same ▶ emits again — it never toggles off (DEC-9)', async () => {
    mount({ widget: { disposition: 'combined' } })
    press('widget-ents-plot-k-2')
    await waitFor(() => expect(dispatched).toHaveLength(1))
    press('widget-ents-plot-k-2')
    await waitFor(() => expect(dispatched).toHaveLength(2))
    expect(dispatched[0].args).toEqual(dispatched[1].args)
    // and the row still carries no selected state after either press
    expect(screen.getByTestId('widget-ents-entry-k-2').getAttribute('data-entry-state')).toBe('unchosen')
  })
})

// ── ITEM-52 / ITEM-51: the two things a row says about its own name ────────────────────

describe('a row states its own name honestly (ITEM-51 / ITEM-52, TEST-64, TEST-A17)', () => {
  it('QUALIFIES the contested name and leaves the uncontested one alone', () => {
    mount()
    expect(screen.getByTestId('widget-ents-qualifier-k-2').textContent).toBe(' (left)')
    expect(screen.getByTestId('widget-ents-qualifier-k-4').textContent).toBe(' (right)')
    expect(screen.queryByTestId('widget-ents-qualifier-k-1')).toBeNull()
  })

  it('an entry with no value under the displayed annotation shows its KEY and SAYS so', () => {
    mount()
    expect(screen.getByTestId('widget-ents-missing-k-3').textContent).toBe('— no Alpha')
    // …and never the value of another annotation as its NAME.
    //
    // Scoped to the NAME element rather than to the whole row (owner, 2026-08-13): the row now
    // also renders the entry's OTHER annotation inline, in a secondary slot, because that is
    // the mockup's own shape (`CD3E  ENSG…98851`) and it is the one thing on the row that
    // varies per row. What ITEM-51 forbids is a SILENT FALLBACK — the row presenting another
    // vocabulary's value AS the name — and that is exactly what this now asserts. The row
    // saying "no Alpha here, and its accession is `right`" is honest; the row calling itself
    // `right` is not.
    expect(screen.getByTestId('widget-ents-label-k-3').textContent).not.toContain('right')
    expect(screen.getByTestId('widget-ents-label-k-3').textContent).toContain('k-3')
  })

  it('the storage-disambiguated form of a shared name appears NOWHERE', () => {
    mount()
    // The ladder is the displayed annotation → the declared qualifier → NEVER a storage index.
    expect(document.body.textContent).not.toMatch(/shared-1/)
  })
})

// ── ITEM-54 / ITEM-55 / ITEM-56: groups ────────────────────────────────────────────────

describe('groups carry counts and survive search (ITEM-54 / ITEM-55, TEST-68 / TEST-69)', () => {
  it('a heading states its DECLARED total', () => {
    mount()
    expect(screen.getByTestId('widget-ents-group-left').textContent).toBe('left · 2')
    expect(screen.getByTestId('widget-ents-group-right').textContent).toBe('right · 2')
  })

  it('under a query BOTH groups survive, in the `n of N` form', () => {
    mount()
    fireEvent.change(screen.getByTestId('widget-ents-search'), { target: { value: 'shared' } })
    expect(screen.getByTestId('widget-ents-group-left').textContent).toBe('left · 1 of 2')
    expect(screen.getByTestId('widget-ents-group-right').textContent).toBe('right · 1 of 2')
    // never a flattened list — grouping must not disappear exactly when disambiguation matters
    expect(screen.getByTestId('widget-ents-entry-k-2')).toBeTruthy()
    expect(screen.getByTestId('widget-ents-entry-k-4')).toBeTruthy()
    expect(screen.queryByTestId('widget-ents-entry-k-1')).toBeNull()
  })

  it('a group with ZERO matches is not rendered as an empty heading', () => {
    mount()
    fireEvent.change(screen.getByTestId('widget-ents-search'), { target: { value: 'solo' } })
    expect(screen.getByTestId('widget-ents-group-left')).toBeTruthy()
    expect(screen.queryByTestId('widget-ents-group-right')).toBeNull()
  })

  it('ITEM-56 — with one group there are NO headings at all', () => {
    mount({ grouped: false })
    expect(screen.queryByTestId('widget-ents-group-left')).toBeNull()
    expect(screen.getByTestId('widget-ents-entry-k-1')).toBeTruthy()
  })

  it('a search matching nothing says so, and renders no groups', () => {
    mount()
    fireEvent.change(screen.getByTestId('widget-ents-search'), { target: { value: 'zzz' } })
    expect(screen.getByTestId('widget-ents-no-match').textContent).toBe(ENTRY_LIST_COPY.noMatch)
    expect(screen.queryByTestId('widget-ents-group-left')).toBeNull()
  })
})

// ── ITEM-50: search matches EVERY annotation, and the row says which one hit ───────────

describe('search matches EVERY annotation (ITEM-50, TEST-63)', () => {
  it('finds a row by an annotation the header is NOT showing, and says which one', () => {
    // The header shows the KEY; the query is an `Alpha` value. Refusing to find it would be
    // perverse — someone pasting an identifier must find its row.
    mount({ rows: ROWS_BY_KEY, showValue: KEY_ARTIFACT })
    fireEvent.change(screen.getByTestId('widget-ents-search'), { target: { value: 'solo' } })
    expect(screen.getByTestId('widget-ents-entry-k-1')).toBeTruthy()
    expect(screen.getByTestId('widget-ents-matched-k-1').textContent).toBe('matched Alpha · solo')
  })

  it('the sub-line is ABSENT when the displayed name already explains the match', () => {
    mount()
    fireEvent.change(screen.getByTestId('widget-ents-search'), { target: { value: 'k-1' } })
    expect(screen.getByTestId('widget-ents-entry-k-1')).toBeTruthy()
    expect(screen.queryByTestId('widget-ents-matched-k-1')).toBeNull()
  })
})

// ── ITEM-48 / ITEM-49 / ITEM-56: the header ────────────────────────────────────────────

describe('the `Show:` header (ITEM-48 / ITEM-49 / ITEM-56, TEST-61 / TEST-62 / TEST-70)', () => {
  it('renders with its options and SAYS which one it picked for itself', () => {
    mount({ showNote: 'Showing the Item id — this list\'s own default.' })
    expect(screen.getByTestId('widget-ents-show')).toBeTruthy()
    expect(screen.getByTestId('widget-ents-show-note').textContent).toContain('Item id')
  })

  it('ITEM-56 — with one declared annotation the select does not RENDER at all', () => {
    mount({ showSelect: false })
    expect(screen.queryByTestId('widget-ents-show')).toBeNull()
    // …not merely disabled: a disabled control still asserts there was a decision to make.
    expect(screen.queryByTestId('widget-ents-show-select')).toBeNull()
  })

  it('changing it changes the NAMES and nothing that is emitted (TEST-61)', async () => {
    // The SAME entries under the two headers: the displayed names differ, and the emitted
    // identity and title are byte-identical.
    mount({ rows: ROWS_BY_KEY, showValue: KEY_ARTIFACT })
    expect(screen.getByTestId('widget-ents-entry-k-1').textContent).toContain('k-1')
    press('widget-ents-plot-k-1-raw')
    await waitFor(() => expect(dispatched).toHaveLength(1))
    const underKey = dispatched[0].args

    cleanup()
    dispatched = []
    mount({ rows: ROWS, showValue: ALPHA })
    expect(screen.getByTestId('widget-ents-entry-k-1').textContent).toContain('solo')
    press('widget-ents-plot-k-1-raw')
    await waitFor(() => expect(dispatched).toHaveLength(1))
    const underAlpha = dispatched[0].args
    // THE IDENTITY does not move: the same entry, the same source, the same position (ITEM-57).
    for (const field of ['entry', 'artifact', 'position']) {
      expect(underAlpha[field], field).toEqual(underKey[field])
    }
    expect(underKey.entry).toBe('k-1')
    // The TITLE is what the row was CALLED when it was emitted, and a plot keeps the title it
    // was born with (ITEM-57) — so the two differ, and each carries its qualifier (ITEM-58).
    expect(underKey.title).toBe('k-1 (left)')
    expect(underAlpha.title).toBe('solo (left)')
  })
})

// ── ITEM-33: the count numeral ─────────────────────────────────────────────────────────

describe('the open-plot numeral is a projection, absent at zero (ITEM-33)', () => {
  it('renders `count_by`\'s record and shows nothing for an entry with none open', () => {
    mount({ counts: { 'k-1': { before: 2, after: 2 } } })
    expect(screen.getByTestId('widget-ents-open-k-1').textContent).toBe('2')
    expect(screen.queryByTestId('widget-ents-open-k-2')).toBeNull()
  })
})

// ── the SHIPPED declaration ────────────────────────────────────────────────────────────

describe('the shipped section declares what these rules rest on', () => {
  /**
   * The shipped view-spec for the ENTRY-AXIS section, discovered rather than named.
   *
   * It used to be "the first shipped spec declaring an `entry_list`", and that stopped
   * identifying anything the day § Colour by became one too (owner, ledger #32): two sections
   * ship the control now, the walk returned whichever file the directory listed first, and the
   * three tests below — all of which are about the ENTRY axis — began asserting against the
   * column list, which declares no display select, a different disposition and a different
   * emit record.
   *
   * The locator is now the ENGINE SOURCE the section binds (`axis_entry_rows`), which is what
   * actually makes it the entry-axis section. Deliberately NOT any of the three things the
   * tests below assert (the display select, the disposition, the emitted record) — a locator
   * that keyed on one of those would make that test tautological.
   */
  const shipped = (() => {
    const root = resolve(process.cwd(), '../packages')
    for (const pkg of readdirSync(root, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const dir = `${root}/${pkg.name}/ui`
      if (!existsSync(dir)) continue
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
        const parsed = parseYaml(readFileSync(`${dir}/${file}`, 'utf8')) as Record<string, unknown>
        const widgets = Array.isArray(parsed.widgets) ? (parsed.widgets as Array<Record<string, unknown>>) : []
        if (!widgets.some(w => w.kind === 'entry_list')) continue
        const data = (parsed.data ?? {}) as Record<string, { source?: string }>
        if (Object.values(data).some(d => d?.source === 'axis_entry_rows')) return parsed
      }
    }
    return undefined
  })()

  it('a shipped spec declares one at all (a zero match would make the rest vacuous)', () => {
    expect(shipped).toBeTruthy()
  })

  it('TEST-74 / INV-13 — the display choice is SECTION state, and pane scope is untouched', () => {
    const state = shipped!.state as Record<string, { type?: unknown; scope?: string }>
    const widgets = shipped!.widgets as Array<Record<string, unknown>>
    const list = widgets.find(w => w.kind === 'entry_list')!

    // THE POSITIVE HALF, WHICH THIS TEST DID NOT ASSERT. Its only content assertion was
    // `expect(showField).toBeUndefined()` over the fields declaring `scope: pane` — a pure
    // ABSENCE, satisfied just as well by a spec that declares no display field AT ALL, or by
    // a `state:` block this reader failed to parse. So the half of the title that says the
    // choice IS section state was certified by nothing. Name the field first, and prove it
    // exists and is bound to the control before saying where it does NOT live.
    const showBinding = (list.show as { value?: string } | undefined)?.value
    expect(showBinding, 'the list declares no display control at all').toBeTruthy()
    // The control reads the ENGINE's resolved answer (`$data…`), and the STATE field is what
    // the section's own action writes — so the field is found through the action, not through
    // a name this test spells (which would pass on a spec that renamed both in step).
    const onChange = (list.show as { onChange?: string } | undefined)?.onChange
    const actions = shipped!.actions as Array<Record<string, unknown>>
    const showAction = actions.find(a => a.id === onChange)
    expect(showAction, 'the display control is wired to no action').toBeTruthy()
    const set = (showAction!.body as Array<Record<string, Record<string, unknown>>>)[0].set
    const written = Object.keys(set ?? {})
    expect(written).toHaveLength(1)
    const field = written[0]
    // It IS section state: declared in this spec's own `state:` block.
    expect(state[field], `the action writes '${field}', which the spec never declares`).toBeTruthy()

    // …and only NOW the negative half: it is not pane-scoped, and the pane's set stays closed
    // at two. The absence means something because the thing it is an absence OF has just been
    // shown to exist.
    expect(state[field].scope).toBeUndefined()
    const paneScoped = Object.values(state).filter(f => f && typeof f === 'object' && 'type' in f && f.scope === 'pane')
    expect(paneScoped).toEqual([])
    expect([...PANE_SCOPE_KEYS]).toEqual(['axis', 'coordinate'])
  })

  it('declares the ▶ under the widget\'s own `action:`, and the disposition it emits under', () => {
    const widgets = shipped!.widgets as Array<Record<string, unknown>>
    const list = widgets.find(w => w.kind === 'entry_list')!
    const onClick = (list.action as { onClick?: string } | undefined)?.onClick
    expect(onClick, 'the list declares no ▶ at all').toBeTruthy()
    expect(list.disposition).toBe('each')
    // …and the action it names EXISTS in the same file, or the ▶ is a control wired to nothing.
    const actions = shipped!.actions as Array<Record<string, unknown>>
    expect(actions.map(a => a.id)).toContain(onClick)
  })

  it('the emitted record stores the KEY and the qualified TITLE, never the bare label', () => {
    const widgets = shipped!.widgets as Array<Record<string, unknown>>
    const onClick = ((widgets.find(w => w.kind === 'entry_list')!.action) as { onClick: string }).onClick
    const actions = shipped!.actions as Array<Record<string, unknown>>
    const plot = actions.find(a => a.id === onClick)!
    const appended = (plot.body as Array<Record<string, { value?: Record<string, unknown> }>>)[0].listAppend?.value
    expect(appended?.entry).toBe('$params.entry')
    expect(appended?.name).toBe('$params.title')
    // ITEM-57 — the label is NOT what is stored: names are deprecated and reused.
    expect(appended?.label).toBeUndefined()
  })
})
