// paneToolbarItems.test.ts — TEST-6 (covers ITEM-3): the lazy-`menu` thunk CONTRACT, asserted on
// the source as text.
//
// WHY SOURCE-AS-TEXT AND NOT A RENDER. This package's vitest is `environment: 'node'` with
// `include: ['src/**/*.test.ts']` — no DOM, no `@testing-library`, and `.test.tsx` is not even
// matched. So the render half of ITEM-3 is proven where it actually renders (TEST-P4, e2e, which
// counts the elements a real wheel drive creates); this file pins the STRUCTURAL contract that
// makes that possible, in the same technique `tools/registry.test.ts` already uses on this exact
// file.
//
// THE FAILURE THIS GUARDS. `menu` was an eagerly-built element and `inline` still is. If a future
// edit reverts `menu` to an element — or, worse, "helpfully" makes `inline` a thunk too and breaks
// the unfolded strip — the e2e counter would catch the first only when someone runs the perf leg,
// and the second not at all. Both are one grep away here.
//
// It also asserts the piece the perf win actually turns on and which no type can express: the
// overflow popup's body must be handed to `Popover` as a COMPONENT, not as inline JSX. The kit
// `Popover` takes `content: ReactNode`, so inline JSX is evaluated at the call site on every render,
// open or closed — which is precisely how the closed menu's rows cost 96 `MenuRowButton` + ~320
// `span` creations per wheel step.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { stripComments } from '../../../tests/sourceScan'

const HERE = dirname(fileURLToPath(import.meta.url))
// COMMENT-STRIPPED (FIX_ROUND-2 / C15). Every assertion in this file is a regex over source text,
// and until now the text was RAW — unlike its sibling `gridDecomposition.test.ts`, which routes
// every assertion through this same stripper precisely because "a source-text guard that reads prose
// is the vacuity this file exists to defeat". Verified benign at the time: every anchor here
// resolved to real code. But the file is one explanatory comment away from a false green in both
// directions — a future docblock in `PaneToolbar.tsx` quoting `menuItems.length > 0 && (` would hold
// that clause green after the real guard was deleted, and a docblock quoting `menu: <` would red the
// eager-element ban with nothing wrong. The stripper is shared, not copied, so there is exactly one
// implementation of the rule in the package.
const SRC = stripComments(readFileSync(join(HERE, 'PaneToolbar.tsx'), 'utf8'))

describe('PaneToolbar overflow items are lazy (TEST-6 / ITEM-3)', () => {
  it('the source was read at all (the scan is not vacuous)', () => {
    // Every assertion below is a regex over SRC. A read that silently returned '' would make them
    // all trivially true — the exact false-green family this package has shipped before.
    expect(SRC.length).toBeGreaterThan(10_000)
    expect(SRC).toContain('function PaneToolbarImpl(')
  })

  it('the memo wrapper pins the display name (a rename must not satisfy a budget)', () => {
    // The counter leg keys on component NAMES. `memo(PaneToolbarImpl)` reports the inner function's
    // name unless it is pinned, which would silently turn INV-1's "PaneToolbar element creations
    // = 0" into a budget satisfied by the memo REFACTOR rather than by the split that is supposed
    // to earn it. Measured: before pinning, the counter read `PaneToolbar=0, PaneToolbarImpl=8`.
    expect(SRC).toMatch(/PaneToolbarImpl\.displayName = 'PaneToolbar'/)
    expect(SRC).toMatch(/export const PaneToolbar = memo\(PaneToolbarImpl\)/)
  })

  it('`menu` is a THUNK on the item type and at every construction site', () => {
    expect(SRC, 'the item type must declare menu as a function').toMatch(/readonly menu:\s*\(\)\s*=>\s*ReactNode/)
    // Both producers: the `action()` helper and the `popout` literal.
    expect(SRC, '`action()` must return a menu thunk').toMatch(/menu:\s*\(\)\s*=>\s*\(\s*\n?\s*<MenuRowButton/)
    expect(SRC, 'the popout item must return a menu thunk').toMatch(/menu:\s*\(\)\s*=>\s*<div key="popout"/)
    // And no site may go back to an eager element.
    expect(
      /menu:\s*</.test(SRC),
      'a `menu:` assigned an element directly re-introduces the eager build',
    ).toBe(false)
  })

  it('`inline` stays EAGER — the design defers only the menu form', () => {
    // `inline` is read unconditionally for every unfolded item on every render, so a thunk here
    // would add a call per item per render and defer nothing. The design source is explicit that
    // only `menu` can be deferred.
    expect(SRC).toMatch(/readonly inline:\s*ReactNode/)
    expect(/inline:\s*\(\)\s*=>/.test(SRC), '`inline` must not become a thunk').toBe(false)
  })

  it('the popup body is a COMPONENT, so the rows build only when the popup mounts', () => {
    expect(SRC, 'the panel must be its own component').toMatch(/function OverflowPanel\(/)
    expect(SRC, 'and Popover must receive it as an element, not inline JSX').toMatch(
      /content=\{<OverflowPanel\s/,
    )
    // The thunks must be invoked INSIDE that component and nowhere else — an invocation at the
    // toolbar's top level would rebuild every row per render and silently undo the whole item.
    const calls = [...SRC.matchAll(/i\.menu\(\)/g)]
    expect(calls, 'exactly one `i.menu()` call site, inside OverflowPanel').toHaveLength(1)
    const panelStart = SRC.indexOf('function OverflowPanel(')
    const panelEnd = SRC.indexOf('function PaneToolbarImpl(')
    // Both anchors must be FOUND. `indexOf` returns -1 on a miss, and a -1 bound silently turns the
    // range check below into something that can never fail meaningfully — which is exactly how this
    // assertion would have gone quiet when `PaneToolbar` was renamed to `PaneToolbarImpl` for the
    // memo wrapper, had the range not happened to break loudly first.
    expect(panelStart, 'OverflowPanel anchor not found').toBeGreaterThan(-1)
    expect(panelEnd, 'PaneToolbarImpl anchor not found').toBeGreaterThan(-1)
    expect(calls[0].index!).toBeGreaterThan(panelStart)
    expect(calls[0].index!).toBeLessThan(panelEnd)
  })

  it('the overflow subtree is still guarded on there BEING folded items', () => {
    // Without this guard the Popover container mounts on every pane regardless — which was the
    // measured +96 elements/wheel (PLAN.md `## Re-captured baseline`).
    expect(SRC).toMatch(/menuItems\.length > 0 && \(/)
  })

  it('the pinned group is measured on its CONTENT node, not the flex-grown wrapper', () => {
    // The bug that made "a width at which nothing folds" UNREACHABLE: `leftRef` is `flex-1`, so its
    // scrollWidth reports the space AVAILABLE (measured 2 072px on a 2 304px toolbar) rather than
    // the space WANTED (254px). One item therefore folded at every width, on every pane, keeping
    // the overflow Popover permanently mounted.
    expect(SRC).toMatch(/leftContentRef\.current\?\.scrollWidth/)
    expect(
      /leftNaturalRef\.current = [\s\S]{0,40}leftRef\.current\?\.scrollWidth/.test(SRC),
      'measuring the flex-grown wrapper reintroduces the always-folds bug',
    ).toBe(false)
    expect(SRC, 'the content ref must actually be attached').toMatch(/ref=\{leftContentRef\}/)
  })

  it('`cellBindingSchema` is memoized on the view kind', () => {
    expect(SRC).toMatch(/useMemo\(\(\) => cellBindingSchema\(cell\.kind\), \[cell\.kind\]\)/)
  })
})
