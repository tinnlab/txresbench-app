import { describe, it, expect, beforeEach } from 'vitest'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { WIDGET_KINDS, EFFECT_OPS } from '@/modules/workbench/core'
import { parseViewSpec } from '@/modules/workbench/core/spec/schema'
import {
  registerWidget,
  getWidget,
  hasWidget,
  registeredWidgetKinds,
} from './registry'
import {
  installBuiltinWidgets,
  widgetsInstalledComplete,
  CANVAS_WIDGET_KINDS,
  __resetBuiltinWidgetsForTests,
} from '@/modules/workbench/extensions'

// TEST-7 (PLAN.md ITEM-7) — the widget registry: `registerWidget`/
// `installBuiltinWidgets` populate it; an unknown `kind` errors; a renderer resolves
// for every builtin kind.

beforeEach(() => __resetBuiltinWidgetsForTests())

describe('widget registry (ITEM-7)', () => {
  it('installBuiltinWidgets registers a renderer for EVERY core WIDGET_KIND', () => {
    installBuiltinWidgets()
    for (const kind of WIDGET_KINDS) {
      expect(hasWidget(kind)).toBe(true)
      expect(typeof getWidget(kind)).toBe('function')
    }
    expect(widgetsInstalledComplete()).toBe(true)
  })

  it('getWidget throws on an unknown kind (never a silent blank)', () => {
    installBuiltinWidgets()
    expect(() => getWidget('not-a-widget')).toThrow(/no widget renderer registered/)
  })

  it('registerWidget adds (and can override) a renderer', () => {
    const custom = () => null
    registerWidget('select', custom)
    expect(getWidget('select')).toBe(custom)
  })

  it('viz kinds resolve to real `<Viz>`-backed renderers (ITEM-8)', () => {
    installBuiltinWidgets()
    for (const kind of ['scatter', 'violin'] as const) {
      const renderer = getWidget(kind)
      // Building the element must not throw (it returns JSX; deck.gl paints e2e).
      const el = renderer(
        { kind, encode: { x: 'nCount', y: 'nFeature', colorBy: 'pct_mito' } } as never,
        { viewId: 'v', scope: { data: { obs: {} } }, dispatch: () => {}, renderChildren: () => null },
      )
      expect(el).not.toBeNull()
    }
  })
})

// ── DEC-A (ITEM-36) — kinds OPEN, effects CLOSED ────────────────────────────────────
//
// This file used to assert `registeredWidgetKinds() === WIDGET_KINDS` (set EQUALITY),
// which closed the kind set BY TEST: nothing outside `core` could register a renderer
// without turning this red. Canvas now OWNS its plot kinds and registers them through the
// ordinary `registerWidget` seam from OUTSIDE core, so equality is the wrong invariant —
// the right one is core ⊆ registered.
//
// Rendering is not privilege escalation; ACTING is. So the same suite re-asserts the other
// half: `EffectSpec`'s op vocabulary stayed EQUALITY-closed. Loosening the kind set must
// not be able to silently loosen the effect set — a processor UI can never ship executable
// code, and there is deliberately no registration seam for effects.
describe('DEC-A: the widget-kind set is OPEN, the effect-op set stays CLOSED', () => {
  it('core WIDGET_KINDS are a SUBSET of the registered kinds (never an equality)', () => {
    installBuiltinWidgets()
    const registered = new Set(registeredWidgetKinds())
    for (const kind of WIDGET_KINDS) {
      expect(registered.has(kind), `core kind "${kind}" is not registered`).toBe(true)
    }
    // The canvas extension's plot kinds are registered from OUTSIDE core — renderable,
    // but deliberately absent from core's vocabulary.
    for (const kind of CANVAS_WIDGET_KINDS) {
      expect(registered.has(kind), `canvas kind "${kind}" is not registered`).toBe(true)
      expect(WIDGET_KINDS as readonly string[]).not.toContain(kind)
    }
    // …hence a STRICT superset, which the old equality assertion forbade.
    expect(registered.size).toBeGreaterThan(WIDGET_KINDS.length)
  })

  it('an extension may register a kind core has never heard of', () => {
    installBuiltinWidgets()
    expect(hasWidget('x.third-party/plot')).toBe(false)
    registerWidget('x.third-party/plot', () => null)
    expect(hasWidget('x.third-party/plot')).toBe(true)
    expect(registeredWidgetKinds()).toContain('x.third-party/plot')
  })

  it('the EFFECT vocabulary is still equality-closed: exactly EFFECT_OPS, no more', () => {
    // Every DECLARED op is recognised by the validator…
    for (const op of EFFECT_OPS) {
      const errs = parseViewSpec(specWithEffect({ [op]: {} })).errors ?? []
      expect(
        errs.some(e => /unknown effect op/.test(e.message)),
        `declared effect op "${op}" was rejected as unknown`,
      ).toBe(false)
    }
    // …and anything OUTSIDE the vocabulary is rejected. Adding a registration seam for
    // effects would require deleting this assertion — which is the point of it.
    const errs = parseViewSpec(specWithEffect({ exfiltrate: {} })).errors ?? []
    expect(errs.some(e => /unknown effect op.*exfiltrate/.test(e.message))).toBe(true)
  })
})

/** A minimal spec whose single action body carries exactly `effect`. Only the
 *  `unknown effect op` diagnostic is read, so per-op ARG validation is irrelevant here. */
function specWithEffect(effect: Record<string, unknown>): ViewSpec {
  return {
    id: 'dec-a/probe',
    title: 'DEC-A probe',
    permission: 'studies::use',
    state: {},
    widgets: [{ id: 'go', kind: 'button', label: 'Go', onClick: 'probe.act' }],
    actions: [
      {
        id: 'probe.act',
        title: 'Act',
        permission: 'studies::use',
        params: {},
        body: [effect as never],
      },
    ],
  }
}
