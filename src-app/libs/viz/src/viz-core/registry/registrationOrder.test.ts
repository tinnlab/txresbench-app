// registrationOrder.test.ts — the chart registry is ORDER-INDEPENDENT.
//
// ── The defect this exists to keep dead ──────────────────────────────────────────────
//
// `chartSchemas.installBuiltinSchemas()` registers each built-in with a PLACEHOLDER view (the
// visible `Unsupported` note) so a parse-time consumer can validate a declarative option without
// pulling deck.gl; `charts/installBuiltins()` registers the same types with their REAL views.
// The design assumed schemas-then-builtins, and `registerChartType` implemented exactly that one
// direction: it stayed silent when a full descriptor replaced a schema-only one.
//
// Nothing enforced the order. Which installer runs first is decided by MODULE-EVAL order —
// `grid/GridWorkspace.tsx` calls `installBuiltins()` at module load, the host app calls
// `installBuiltinSchemas()` from its `view_spec` validator — and in the CytoAnalyst app the
// builtins won. So the schema-only descriptors were registered SECOND and clobbered the
// render-capable ones: every chart cell rendered `unsupported kind: <type>` on a fully-registered
// type, and the console carried one "already registered; replacing" warning per built-in (the
// warning fires only when the descriptor being replaced is NOT schema-only — i.e. it was itself
// the downgrade's receipt).
//
// The invariant, stated as a property rather than an order: a SCHEMA-ONLY descriptor is an
// upgrade-only placeholder. It may be upgraded to a render-capable descriptor, and it may never
// replace one. Both install orders must therefore leave every built-in RENDER-CAPABLE, and
// neither may warn — a built-in registering twice per page load is noise that trains people to
// ignore the console.
//
// Each case runs against a FRESH module graph (`vi.resetModules()` + dynamic import), because the
// registry and the `use()` idempotency set are module-level singletons: without the reset, the
// second case would observe the first case's registry and prove nothing about order.

import { describe, it, expect, vi, afterEach } from 'vitest'

// ── THIS FILE'S BUDGET IS AN IMPORT COST, NOT A LOGIC COST ──────────────────────────────────────
//
// Every case here runs against a FRESH module graph (`vi.resetModules()` + dynamic import), and
// `installBuiltins` pulls the whole chart/deck graph behind it. Measured with `--reporter=verbose`:
//
//     4860 ms   schemas → builtins            ← pays the COLD graph, once
//       26 ms   builtins → schemas
//       45 ms   both orders resolve the same
//       23 ms   a genuine duplicate still warns
//       19 ms   a schema-only descriptor still registers
//
// So the cost is one cold module-graph import paid by whichever case runs FIRST, and 4860 ms of
// vitest's 5000 ms default is 97 % — the same shape as the line ratchets this round re-anchored: a
// budget sitting at the measurement is not a budget. It reds NON-deterministically, and it does so
// in isolation too (measured 2 of 3 isolated runs on an otherwise idle box), so "it only fails under
// parallel load" is not the diagnosis.
//
// The budget is therefore stated explicitly and sized against the measurement rather than left at a
// default that happens to be a hair above it. It is 6× the observed cold import, and it is on EVERY
// case because which one runs first is a property of the file's order, not of the case. A real hang
// — a registry that deadlocks rather than one that is slow to import — still fails, just later.
const COLD_IMPORT_BUDGET_MS = 30_000

/** A pristine `@ziee/viz` registry + both installers, with no state shared with any other case. */
async function freshRegistry() {
  vi.resetModules()
  const [{ installBuiltins }, { installBuiltinSchemas }, registry, { isSchemaOnly }] =
    await Promise.all([
      import('../charts/installBuiltins'),
      import('../charts/chartSchemas'),
      import('./registry'),
      import('./schemaOnly'),
    ])
  return { installBuiltins, installBuiltinSchemas, isSchemaOnly, ...registry }
}

/** The built-in types whose render-capability this asserts. `violin` is the one the app showed as
 *  `unsupported kind: violin`; the rest fail the same way for the same reason. */
const BUILTIN_TYPES = [
  'scatter',
  'image',
  'grid',
  'violin',
  'box',
  'bar',
  'dotplot',
  'heatmap',
  'volcano',
  'histogram',
] as const

afterEach(() => {
  vi.restoreAllMocks()
})

describe('chart-type registration is order-independent', () => {
  it('schemas → builtins: every built-in ends up render-capable, silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const viz = await freshRegistry()

    viz.installBuiltinSchemas()
    viz.installBuiltins()

    for (const type of BUILTIN_TYPES) {
      const desc = viz.getChartType(type)
      expect(desc, `"${type}" is not registered`).toBeDefined()
      expect(viz.isSchemaOnly(desc!), `"${type}" is a parse-time placeholder, not a real chart`).toBe(false)
    }
    expect(
      warn.mock.calls.map(c => String(c[0])),
      'the schema→builtin UPGRADE is the designed hand-off and must not warn',
    ).toEqual([])
  }, COLD_IMPORT_BUDGET_MS)

  it('builtins → schemas: the placeholder must NOT downgrade a registered chart', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const viz = await freshRegistry()

    // The order the app actually produced: `GridWorkspace` module-eval installs the real charts
    // before the host's `view_spec` validator asks for the parse-time schemas.
    viz.installBuiltins()
    viz.installBuiltinSchemas()

    for (const type of BUILTIN_TYPES) {
      const desc = viz.getChartType(type)
      expect(desc, `"${type}" is not registered`).toBeDefined()
      expect(
        viz.isSchemaOnly(desc!),
        `"${type}" was downgraded to the parse-time placeholder — it renders "unsupported kind: ${type}"`,
      ).toBe(false)
    }
    expect(
      warn.mock.calls.map(c => String(c[0])),
      'a no-op placeholder registration must not warn (this was the per-built-in console noise)',
    ).toEqual([])
  }, COLD_IMPORT_BUDGET_MS)

  it('both orders resolve every built-in to the SAME descriptor', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = await freshRegistry()
    a.installBuiltinSchemas()
    a.installBuiltins()
    const b = await freshRegistry()
    b.installBuiltins()
    b.installBuiltinSchemas()

    // Fresh module graphs ⇒ different function identities, so compare the OBSERVABLE shape: the
    // schema-only marker (which is what decides whether a cell paints or shows `Unsupported`) and
    // the descriptor's declared contract.
    for (const type of BUILTIN_TYPES) {
      const da = a.getChartType(type)!
      const db = b.getChartType(type)!
      expect(a.isSchemaOnly(da)).toBe(b.isSchemaOnly(db))
      expect(db.coordinateSystem).toBe(da.coordinateSystem)
      expect(db.bindingSchema?.map(c => c.id)).toEqual(da.bindingSchema?.map(c => c.id))
    }
  }, COLD_IMPORT_BUDGET_MS)
})

describe('registerChartType placeholder policy', () => {
  it('a genuine duplicate (two render-capable descriptors) still warns and last-wins', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const viz = await freshRegistry()

    const first = { type: 'dup', coordinateSystem: 'chart2d', view: () => null, model: () => ({}) } as never
    const second = { type: 'dup', coordinateSystem: 'chart2d', view: () => null, model: () => ({}) } as never
    viz.registerChartType(first)
    viz.registerChartType(second)

    expect(viz.getChartType('dup')).toBe(second)
    expect(warn.mock.calls.map(c => String(c[0]))).toEqual([
      '[viz] chart type "dup" is already registered; replacing.',
    ])
  }, COLD_IMPORT_BUDGET_MS)

  it('a schema-only descriptor still registers a type nobody has claimed yet', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const viz = await freshRegistry()

    // The "never downgrade" rule must not become "never register": with no incumbent, the
    // parse-time placeholder IS the registration `parseOption` needs.
    viz.installBuiltinSchemas()
    for (const type of BUILTIN_TYPES) {
      expect(viz.hasChartType(type), `"${type}" must be registered for parse-time validation`).toBe(true)
      expect(viz.isSchemaOnly(viz.getChartType(type)!)).toBe(true)
    }
    expect(warn.mock.calls).toEqual([])
  }, COLD_IMPORT_BUDGET_MS)
})
