// @vitest-environment jsdom
//
// WHAT THE SHIPPED PRESET PICKER OFFERS — mounted, over the real yaml and the real store.
//
// The picker adds on change: choosing IS the action. That made the OFFER load-bearing in a way it
// was not while an Add button stood between the two — an option that is already a row is now an
// invitation to do the one thing the form immediately refuses (`metricTable.require.unique_by:
// name`), so the user gets a duplicate row and a closed run gate for answering a question the form
// asked them. The gate was right; the offer was wrong.
//
// Asserted HERE and not in `qcSurface.test.ts` because the claim is about what a RENDERED CONTROL
// offers, and that file is deliberately DOM-free — it can see that a clause is declared and not
// that anything applies it. Every assertion below drives the real registered renderer over the
// real shipped declaration, with the option set read the way a user reads it (open the control,
// look at the rows).
//
// The store is the REAL one, so `$derived` is computed by the shipped kernels from the shipped
// `state` defaults rather than hand-built here — which is the half a structural test cannot reach:
// a clause naming a `derived` entry that does not exist evaluates to `absent` and offers
// EVERYTHING, silently.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { render, screen, cleanup, act } from '@testing-library/react'

import type { SelectWidget, ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { parseViewSpec } from '@/modules/workbench/core/spec/schema'
import { createViewStore, type ViewStore } from './store'
import type { Scope } from './expr'
import { WidgetList } from '@/modules/workbench/core/render/WidgetHost'
import {
  installWidgets,
  __resetInstallWidgetsForTests,
} from '@/modules/workbench/extensions/widgets/installWidgets'
import { pickerOptions } from '@/modules/workbench/core/__testutil__/pickerDriver'

/** The shipped file, resolved from the RUNNER's cwd rather than `import.meta.url`: under
 *  `@vitest-environment jsdom` the module URL is an `http:` one and `fileURLToPath` refuses it
 *  (the same reason `shippedFormConformance.test.tsx` walks up from `process.cwd()`). */
function shippedQcView(): string {
  let dir = process.cwd()
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'packages', 'qc', 'ui', 'qc.yaml')
    if (existsSync(candidate)) return candidate
    dir = join(dir, '..')
  }
  throw new Error(`no shipped view found from ${process.cwd()}`)
}

const spec = parseViewSpec(parseYaml(readFileSync(shippedQcView(), 'utf8'))).value as ViewSpec

/** The picker under test, read off the SHIPPED file — never restated here. */
const picker = spec.widgets.find(w => w.id === 'presetPicker') as SelectWidget

/** Every catalog entry's own `value`, in declaration order — the SUPERSET the picker draws from.
 *  Read off the shipped `const` block, so this file names no preset of its own. */
const catalogValues = (): string[] =>
  Object.values((spec.const?.metricPresets ?? {}) as Record<string, { value?: string }>).map(e =>
    String(e.value),
  )

/** The catalog entry whose METRIC row a given `value` appends. */
const metricOf = (value: string): { name?: string } => {
  const entry = Object.values(
    (spec.const?.metricPresets ?? {}) as Record<string, { value?: string; metric?: { name?: string } }>,
  ).find(e => String(e.value) === value)
  return entry?.metric ?? {}
}

/** Entries carrying a capability gate of their own — excluded from the "offered" expectation
 *  below, because a run against a fixture with no capabilities correctly never offers them. Read
 *  from the DECLARATION rather than listed, so a newly-gated entry is handled the day it ships. */
const capabilityGated = (): Set<string> =>
  new Set(
    Object.values((spec.const?.metricPresets ?? {}) as Record<string, { value?: string; when?: string }>)
      .filter(e => typeof e.when === 'string' && e.when.length > 0)
      .map(e => String(e.value)),
  )

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  } as never
  if (!globalThis.CSS) (globalThis as { CSS?: unknown }).CSS = { escape: (v: string) => v }
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
      dispatchEvent() {
        return false
      },
      onchange: null,
    })) as never
  }
})

let storeSeq = 0
let store: ViewStore

beforeEach(() => {
  cleanup()
  __resetInstallWidgetsForTests()
  installWidgets()
  store = createViewStore(spec, `qc-offer-${++storeSeq}`)
})
afterEach(cleanup)

/** Render the shipped picker over the LIVE store — its `derived` recomputed by the real kernels
 *  from whatever `state` currently holds. */
function mountPicker(): HTMLElement {
  render(
    <WidgetList
      specs={[picker]}
      scope={
        {
          params: {},
          state: store.state,
          derived: store.derived,
          const: spec.const ?? {},
          data: {},
        } as Scope
      }
      viewId="v"
      specId={spec.id}
    />,
  )
  return screen.getByTestId('widget-presetPicker')
}

/** The names currently in the metric table, off the live store. */
const heldNames = (): string[] =>
  ((store.state.qc_metrics ?? []) as Array<{ name?: string }>).map(m => String(m.name))

describe('the preset picker never offers what the table already holds', () => {
  it('a FRESH form offers only the presets its seeded rows do not already cover', async () => {
    // The seeded state is the shipped one — four rows, named by the catalog itself.
    const held = new Set(heldNames())
    expect(held.size, 'the shipped form seeds rows, else this asserts nothing').toBeGreaterThan(0)

    const gated = capabilityGated()
    const expected = catalogValues().filter(v => !gated.has(v) && !held.has(String(metricOf(v).name)))
    // POSITIVE CONTROL on the expectation itself: the catalog must hold BOTH kinds, or "excludes
    // the held ones" is satisfied by a catalog that happens to have nothing held (or nothing free)
    // and the assertion below reads the same either way.
    expect(expected.length, 'some preset is still addable').toBeGreaterThan(0)
    expect(
      catalogValues().filter(v => held.has(String(metricOf(v).name))).length,
      'some preset is already a seeded row — otherwise this suite proves nothing',
    ).toBeGreaterThan(0)

    expect(await pickerOptions(mountPicker())).toEqual(expected)
  })

  it('removing a row PUTS ITS PRESET BACK — the offer follows the table, it is not a fixed list', async () => {
    const before = await pickerOptions(mountPicker())
    const dropped = heldNames()[0]
    const restored = catalogValues().find(v => String(metricOf(v).name) === dropped)
    expect(restored, 'a seeded row corresponds to a catalog entry').toBeTruthy()
    expect(before, 'it is withheld to begin with').not.toContain(restored)

    cleanup()
    act(() => {
      store.set(
        'qc_metrics',
        ((store.state.qc_metrics ?? []) as Array<{ name?: string }>).filter(m => m.name !== dropped),
      )
    })
    expect(await pickerOptions(mountPicker())).toContain(restored)
  })

  it('a row RENAMED onto a preset withholds that preset — the gate reads NAMES, not preset ids', async () => {
    // The offer is keyed on the emitted column NAME, which is what `unique_by` and the compute
    // both collide on. Keying it on the preset's own id would agree with this today (the two are
    // spelled alike) and diverge for the first entry whose value and metric name differ — or, as
    // here, the moment a user types a name by hand.
    const gated = capabilityGated()
    const free = catalogValues().find(
      v => !gated.has(v) && !new Set(heldNames()).has(String(metricOf(v).name)),
    )!
    expect(await pickerOptions(mountPicker())).toContain(free)

    cleanup()
    act(() => {
      // Rename the FIRST row onto that preset's emitted name — the same collision, by hand.
      store.set('qc_metrics.0.name', String(metricOf(free).name))
    })
    expect(await pickerOptions(mountPicker())).not.toContain(free)
  })

  it('with every preset added the control is DISABLED and says so in the VIEW’s words', async () => {
    cleanup()
    const gated = capabilityGated()
    act(() => {
      store.set(
        'qc_metrics',
        catalogValues()
          .filter(v => !gated.has(v))
          .map(v => ({ name: metricOf(v).name, pattern: '.*', aggregation: 'sum' })),
      )
    })
    const el = mountPicker()
    expect(await pickerOptions(el), 'nothing left to add').toEqual([])
    expect(el.hasAttribute('disabled'), 'a control offering nothing is not operable').toBe(true)
    // …and it is NOT the engine's "not yet" wording, which would tell the user to wait for
    // options that can never arrive. The sentence is the view's, read off the shipped file.
    const declared = String(picker.empty_text ?? '')
    expect(declared, 'the view declares its own exhausted-set sentence').not.toBe('')
    expect((el.textContent ?? '').replace(/\s+/g, ' ')).toContain(declared.replace(/\s+/g, ' ').trim())
  })
})
