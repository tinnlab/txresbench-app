// TEST-12 (FE half) [acceptance] [invariant: INV-5] — the BUILD-TIME processor
// syntax gate for the `ui/*.yaml` declarative view-specs. The Rust `build.rs`
// gate (build_helper/processor_manifest.rs) lints the backend + FE-analyses halves
// of every `packages/<name>/manifest.yaml`, but the `ui/*.yaml` view-spec is a
// TS-side schema `build.rs` cannot reach (DEC-5) — so THIS vitest arm (run in the
// FE `test:unit` pass / `just check`) is the FE half of the syntax gate: it loads
// EVERY shipped `packages/*/ui/*.yaml` and asserts it parses LOUD-clean through
// the SAME `parseViewSpec` the workbench uses to register a declarative view.
//
// A malformed view-spec (unknown widget kind, permission-less action, dangling
// `$`-ref, missing required field) fails the build here rather than silently
// mis-rendering at runtime. A negative-control fixture proves the gate FIRES.

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { parseViewSpec } from './schema'
import { resolveDeclarativeCanvas } from '@/modules/workbench/extensions/canvas/canvasFeed'
import { createViewStore } from '@/modules/workbench/core/runtime/store'
// DRIFT-1.81, measured before it could confuse anyone: `entry_list` is a REGISTERED kind
// (DEC-2 — core's `WIDGET_KINDS` is the FORM-CONTROL vocabulary and a visualize control joins
// through the open seam instead), so a parse-only process that has not installed the visualize
// widgets REFUSES a spec declaring one with *"unknown widget kind"*. The app is unaffected
// — `installBuiltinWidgets` runs at boot — but this gate parses the real `ui/*.yaml` off disk in
// a bare unit process, so the installer has to run here too. One line, deliberately at the
// TOP of the file rather than inside a `beforeAll`, because every `it.each` case below parses.
import { installVisualizeWidgets } from '@/modules/workbench/extensions/visualize/installVisualizeWidgets'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'

/** The shipped `src-app/packages/` tree, relative to this test file. */
const PROCESSORS_DIR = fileURLToPath(new URL('../../../../../../packages', import.meta.url))

/** Discover every `packages/<name>/ui/*.yaml` on disk (the production glob
 *  `import.meta.glob('.../packages/*​/ui/*.yaml')` discovers the same set). */
function discoverViewSpecs(): Array<{ pkg: string; file: string; path: string }> {
  const out: Array<{ pkg: string; file: string; path: string }> = []
  for (const pkg of readdirSync(PROCESSORS_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const uiDir = `${PROCESSORS_DIR}/${pkg.name}/ui`
    if (!existsSync(uiDir)) continue
    for (const f of readdirSync(uiDir)) {
      if (f.endsWith('.yaml') || f.endsWith('.yml')) {
        out.push({ pkg: pkg.name, file: f, path: `${uiDir}/${f}` })
      }
    }
  }
  return out
}

installVisualizeWidgets()

const specs = discoverViewSpecs()

describe('processor ui/*.yaml view-spec build gate (TEST-12 FE half, INV-5)', () => {
  it('discovers the shipped view-specs (guards against a silent zero-match glob)', () => {
    // Must find at least the qc + cell-filter view specs; a zero match would make
    // every per-spec assertion below vacuously pass.
    expect(specs.length).toBeGreaterThanOrEqual(2)
    expect(specs.map(s => s.pkg).sort()).toEqual(expect.arrayContaining(['cell-filter', 'qc']))
  })

  it.each(specs)('packages/$pkg/ui/$file parses LOUD-clean through parseViewSpec', ({ path }) => {
    const raw = parseYaml(readFileSync(path, 'utf8'))
    const res = parseViewSpec(raw)
    expect(res.errors ?? []).toEqual([])
    expect(res.ok).toBe(true)
  })

  it('FIRES on a malformed view-spec (negative control — unknown kind + bad action + dangling ref)', () => {
    const malformed = {
      id: 'bad',
      title: 'Bad',
      permission: 'jobs::use',
      state: {},
      widgets: [
        { kind: 'not-a-real-widget-kind' }, // unknown widget kind
        { kind: 'button', onClick: 'undeclared-action' }, // dangling action ref
      ],
      actions: [
        { id: 'noPerm', body: [] }, // missing required permission
      ],
      derived: { total: '$state.doesNotExist + 1' }, // dangling $-ref
    }
    const res = parseViewSpec(malformed)
    expect(res.ok).toBe(false)
    const msgs = (res.errors ?? []).map(e => e.message).join('\n')
    expect(msgs).toMatch(/unknown widget kind/)
    expect(msgs).toMatch(/undeclared action|references undeclared/)
    expect(msgs).toMatch(/permission/)
    expect(msgs).toMatch(/dangling \$-reference/)
  })
})

// ── r3canvas: the shipping YAMLs still RESOLVE, unchanged ────────────────────────────────────
//
// r3canvas renamed the three frame kernels' columnar operand (`obs:` → `frame:`) and DUAL-ACCEPTS
// the old spelling, and sourced the canvas default dataset id from the DECLARATION instead of a
// literal — precisely so neither shipping YAML has to change. Parsing is not proof of that:
// `parseViewSpec` never validates a kernel's operand key or a canvas dataset id, so a spec using a
// key core silently stopped reading would still parse LOUD-clean and then compute nothing. So
// EXECUTE them.

const KERNELS = ['keep_mask', 'columns_of', 'categories_by_column'] as const

/** A synthetic slice covering both column kinds the frame kernels + canvas dispatch on. */
const SYNTHETIC_SLICE = { some_metric: [1, 2, 3, 4], some_label: ['a', 'a', 'b', 'b'] }

function loadYaml(path: string): Record<string, unknown> {
  return parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>
}

/** Feed EVERY declared data slice the same synthetic frame, so whichever the spec binds resolves.
 *  (The slice NAME is the spec's own choice — see `core/spec/obsLanguage.test.ts`.) */
function syntheticData(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys((raw.data ?? {}) as Record<string, unknown>)) {
    out[key] = { ...SYNTHETIC_SLICE }
  }
  // A `for_each` canvas addresses a PER-ITERATION frame by a dotted path into its slice
  // (`plotted.$i` ⇒ `plotted.0`), which is the shape the two Visualize emit sections use: one
  // frame per emitted plot, never a merged one. A flat slice cannot answer `plotted.0`, so the
  // dataset dropped, the series dropped with it, and the canvas resolved to `null` — which is
  // precisely the state the old `if (feed != null)` tolerance then excused. Both shapes are
  // provided so a spec addressing either resolves; the slice NAME stays the spec's own choice.
  const canvas = (raw.canvas ?? {}) as { datasets?: { id?: unknown }[] }
  for (const d of canvas.datasets ?? []) {
    if (typeof d?.id !== 'string') continue
    const [base, tail] = d.id.split('.')
    if (!tail || !tail.startsWith('$') || !(base in out)) continue
    out[base] = { ...(out[base] as object), '0': { ...SYNTHETIC_SLICE } }
  }
  return out
}

function frameKernelEntries(raw: Record<string, unknown>): string[] {
  const derived = (raw.derived ?? {}) as Record<string, Record<string, unknown>>
  return Object.entries(derived)
    .filter(([, d]) => KERNELS.some(k => d?.[k] != null))
    .map(([name]) => name)
}

describe('r3canvas — the shipped view-specs still RESOLVE through the dual-accepted operand', () => {
  it('at least one shipped spec USES a frame kernel (else the per-spec checks are vacuous)', () => {
    const total = specs.reduce((n, s) => n + frameKernelEntries(loadYaml(s.path)).length, 0)
    expect(total, 'no shipped spec uses keep_mask/columns_of/categories_by_column').toBeGreaterThan(0)
  })

  it.each(specs)('packages/$pkg/ui/$file computes every frame-kernel derived it declares', ({ path }) => {
    const raw = loadYaml(path)
    const names = frameKernelEntries(raw)
    expect(parseViewSpec(raw).ok).toBe(true)
    const store = createViewStore(raw as unknown as ViewSpec, `shipped-kernels-${path}`, syntheticData(raw))
    for (const name of names) {
      const value = store.derived[name]
      expect(value, `derived.${name} did not resolve`).toBeDefined()
      // Every frame kernel returns a non-empty container when its operand BOUND: a per-row mask
      // (array), a column list (array), or a `{ column: categories }` map. An unbound operand
      // yields `[]` / `{}` — which is exactly the silent failure this test exists to catch.
      const size = Array.isArray(value) ? value.length : Object.keys(value as object).length
      expect(size, `derived.${name} resolved EMPTY — the operand did not bind`).toBeGreaterThan(0)
    }
    store.dispose()
  })

  // ── the canvas sweep, made NON-VACUOUS ────────────────────────────────────────────────
  //
  // This sweep asserted NOTHING for any real subject, on 100% of them. It mounted each spec
  // with `scope.state = {}`, so every `for_each: "$state.plots|$state.criteria as …"` expanded
  // to ZERO series, `resolveDeclarativeCanvas` returned `null`, and the whole assertion body
  // sat inside `if (feed != null)`. Every shipped canvas-bearing spec is `for_each`-driven, so
  // the tolerance that was written for "a purely dynamic canvas legitimately expands to zero"
  // swallowed the entire subject set — and the test survived restoring the very regression it
  // is named for.
  //
  // Three changes, each closing one leg of that:
  //   · SEED the iteration state, derived from the spec's own `for_each` clauses, so the
  //     templates actually expand;
  //   · DROP the `if (feed != null)` tolerance — a canvas-bearing spec that resolves to null
  //     now fails, and says which;
  //   · FLOOR the subject count, so the sweep can never silently return to zero subjects (the
  //     failure mode that made it inert is invisible in a green `it.each` with no cases).
  const canvasSpecs = specs.filter(s => (loadYaml(s.path).canvas as { series?: unknown[] })?.series?.length)

  it('the canvas sweep HAS subjects (the anti-vacuity floor)', () => {
    // A hard floor rather than `> 0`: four shipped specs declare a canvas today. A discovery
    // change that dropped one would otherwise shrink the sweep silently, which is exactly how
    // an `it.each` reports green while proving less. The names are NOT written down here —
    // they are a package's vocabulary, and the failure message prints them anyway.
    expect(canvasSpecs.length, `canvas-bearing shipped specs: ${canvasSpecs.map(s => s.file).join(', ')}`)
      .toBeGreaterThanOrEqual(4)
  })

  /**
   * The state a spec's own `for_each` clauses require, one element each.
   *
   * DERIVED from the declaration (`for_each: "$state.<key> as $<var>, $<i>"` plus every
   * `$<var>.<field>` the canvas block references), never hand-listed: a hand-list is what goes
   * stale when a section adds a field, and going stale here means silently returning to zero
   * series — the failure this whole rewrite is about.
   */
  function syntheticState(raw: Record<string, unknown>): Record<string, unknown> {
    const text = JSON.stringify(raw.canvas ?? {})
    const state: Record<string, unknown> = {}
    // Start from the spec's OWN `state:` declaration, so a series gated on a plain state
    // value (a boolean `when:` gate, a string bound into an encode key) expands too.
    // Derived from the declared TYPE, not from a per-spec list.
    for (const [key, decl] of Object.entries((raw.state ?? {}) as Record<string, { type?: string }>)) {
      if (decl?.type === 'boolean') state[key] = true
      else if (decl?.type === 'string') state[key] = 'some_label'
      else if (decl?.type === 'number') state[key] = 1
      else state[key] = []
    }
    for (const m of text.matchAll(/\$state\.([A-Za-z_][\w]*)\s+as\s+\$([A-Za-z_]\w*)/g)) {
      const [, key, varName] = m
      const fields = new Set<string>()
      for (const f of text.matchAll(new RegExp(`\\$${varName}\\.([A-Za-z_]\\w*)`, 'g'))) fields.add(f[1])
      const row: Record<string, unknown> = {}
      for (const f of fields) {
        // A field naming a COLUMN has to name one the synthetic slice actually has, or the
        // series would fail for column availability instead of for what is under test. Every
        // other field is opaque to the canvas resolver and only has to be present.
        // A field naming a COLUMN must name one the synthetic slice actually has — including
        // `column`, which a `when:` gate indexes a derived map by (`$derived.controlByColumn[$c.column]`).
        // With a `synthetic-column` here that lookup is `undefined`, the gate is false, and the
        // for_each legs are dropped: the sweep would then be satisfied by a spec's SINGULAR
        // series while its templated ones went unexercised — the failure this rewrite is about,
        // one level down.
        row[f] =
          f === 'name' || f === 'entry' || f === 'selector' || f === 'column'
            ? 'some_metric'
            : `synthetic-${f}`
      }
      // `mode` selects the colorBy branch; `some_metric` is numeric, so `continuous` is the
      // branch that matches the synthetic slice.
      if ('mode' in row) row.mode = 'continuous'
      state[key] = [row]
    }
    return state
  }

  it.each(canvasSpecs)(
    'packages/$pkg/ui/$file resolves its canvas against its OWN declared default dataset',
    ({ path }) => {
      const raw = loadYaml(path)
      const data = syntheticData(raw)
      const canvas = raw.canvas as {
        datasets?: { id: string }[]
        series?: { encode?: Record<string, unknown> }[]
      }
      // Bind every declared series to a column the synthetic slice actually has, so the feed is
      // testing DATASET-ID resolution (the r3canvas change) and not column availability.
      for (const s of canvas.series ?? []) {
        if (s.encode?.valueKey != null) s.encode.valueKey = 'some_metric'
        if (s.encode?.continuousKey != null) s.encode.continuousKey = 'some_metric'
        if (s.encode?.groupKey != null) s.encode.groupKey = 'some_label'
        // `colorBy` is what BOTH Visualize emit sections bind, and it was not rewritten here —
        // so the two specs that matter most bound a `$c.name` the slice does not carry.
        const cb = s.encode?.colorBy as { mode?: unknown; key?: unknown } | undefined
        if (cb && typeof cb === 'object') {
          cb.mode = 'continuous'
          cb.key = 'some_metric'
        }
      }
      // SEEDED — one iteration per `for_each`, so the templates expand. With `{}` here every
      // subject below resolved to `null` and asserted nothing.
      const state = syntheticState(raw)
      // …and `derived` is COMPUTED by the real store rather than left `{}`. A series may gate
      // itself on a derived value (`when: "$derived.controlByColumn[$c.column] == range"`), and
      // an empty `derived` makes every such gate false — so the templated series are dropped and
      // the spec is "resolved" only by whatever SINGULAR series it happens to carry. That is the
      // same vacuity one level down, and it is invisible: the feed is non-null either way.
      const store = createViewStore(raw as unknown as ViewSpec, `shipped-canvas-${path}`, data)
      const derived = { ...(store.derived as Record<string, unknown>) }
      store.dispose()
      const scope = { state, derived, const: {}, data, params: {} }
      const feed = resolveDeclarativeCanvas(raw as unknown as ViewSpec, { data, scope })
      // NO `if (feed != null)` tolerance. A spec that declares series and still resolves to
      // nothing under a seeded scope is the regression, not an exemption.
      expect(feed, `canvas resolved to null for ${path} — the for_each expanded to zero series`)
        .not.toBeNull()
      const declared = canvas.datasets?.[0]?.id
      expect(declared, 'a resolving canvas must declare its datasets').toBeTruthy()
      expect(feed!.option.series.length).toBeGreaterThan(0)

      // …and every TEMPLATED series expanded, not just the singular ones. A `for_each` id
      // carries its loop variable (`s-colour-$i`), so a resolved series whose id no longer
      // contains a `$` is an expansion that happened. Without this the assertion above is
      // satisfied by a spec's un-templated series while its `for_each` legs stay unexercised —
      // which is exactly the shape the `if (feed != null)` tolerance used to hide.
      const templated = (canvas.series ?? []).filter(
        s => typeof (s as { for_each?: unknown }).for_each === 'string',
      ) as Array<{ id: string }>
      if (templated.length > 0) {
        // Matched per TEMPLATE, not merely "some series has no `$` in its id": a spec's
        // SINGULAR series also have `$`-free ids, so a whole-set check is satisfied by them
        // while every templated leg stays dropped. (Verified: with `derived` emptied — which
        // is what makes a `when: "$derived…"` gate false — a whole-set check still passed and
        // this one goes red.)
        const ids = feed!.option.series.map(s => String(s.id))
        const matched = templated.filter(t => {
          const re = new RegExp(
            `^${t.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\$[A-Za-z_]\w*/g, '.+')}$`,
          )
          return ids.some(id => re.test(id))
        })
        expect(
          matched.length,
          `${path}: ${templated.length} for_each series declared, ${matched.length} expanded ` +
            `(resolved ids: ${ids.join(', ')})`,
        ).toBeGreaterThan(0)
      }
    },
  )
})

// ─────────────────────────────────────────────────────────────────────────────────────
// The VIEW ↔ COMPUTE input seam.
//
// There was none. A view's `run_processor` block names slots; the compute resolves slots;
// nothing compared the two, and the compute's side of the contract exists only as a
// docstring and a set of `fail()` calls. That gap is how `cell-filter.yaml` came to bind
// `{expression}` alone while `cell-filter.py` resolved every obs column on `column:<name>`
// — a run that kept every cell, at rc=0, with a green report.
//
// Two arms, deliberately different in kind:
//
//   A. DECLARATION ↔ DECLARATION. Every slot the analysis' `appliesTo` names is REQUIRED by
//      definition (DEC-5), so the view must bind it. No scanning; two YAML files.
//
//   B. DECLARATION ↔ COMPUTE SOURCE. Every slot the view can emit must be one the compute
//      actually resolves. The compute's slot vocabulary is READ OUT OF ITS SOURCE — the
//      literal names passed to `slot_path`/`slot_paths`, plus the `*_SLOT_PREFIX` constants
//      that introduce a slot FAMILY (`column:`). That is a source scan, with a source scan's
//      brittleness: it tracks the two helper names both shipped computes use, and a compute
//      that resolved slots some third way would read as having none. The vacuity guard below
//      is what keeps that from silently passing — a compute whose vocabulary comes back
//      empty FAILS rather than approving everything.
//
// What this seam does NOT catch, said plainly: an OPTIONAL slot the view never binds. Every
// `column:<name>` is 0..N to the compute, so "the view binds no columns at all" is a legal
// arrangement here — it is a semantic coupling (every criterion the run carries in `params`
// needs its column mounted), and the test that pins it is the behavioural one in
// `core/runtime/cellFilterRunInputs.test.ts`, not this shape check.

/** Every analysis contributed by any shipped package, by id. */
function shippedAnalyses(): Map<string, { pkg: string; analysis: Record<string, unknown> }> {
  const out = new Map<string, { pkg: string; analysis: Record<string, unknown> }>()
  for (const pkg of readdirSync(PROCESSORS_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const file = `${PROCESSORS_DIR}/${pkg.name}/manifest.yaml`
    if (!existsSync(file)) continue
    const manifest = parseYaml(readFileSync(file, 'utf8')) as {
      contributes?: { analyses?: Array<Record<string, unknown>> }
    }
    for (const analysis of manifest.contributes?.analyses ?? []) {
      if (typeof analysis.id === 'string') out.set(analysis.id, { pkg: pkg.name, analysis })
    }
  }
  return out
}

const ANALYSES = shippedAnalyses()

/**
 * Every `contributes.sections[]` entry shipped, by section id (visualize-pane ITEM-65).
 *
 * The SECOND owner a `ui/*.yaml` can have. The gates below were written when an analysis was
 * the only thing that could name a view file, and a Visualize SECTION names them by exactly
 * the same `ui:` list into exactly the same loader path — so a section's spec was reported as
 * "listed by 0 analyses … never registered", which is false and would have been read as a
 * broken package rather than as a gate that had not been told about the new kind. Same class
 * as ITEM-1b's six manifest gates: an enumeration of contribution kinds that has to be widened
 * with the kind, or it fails closed against the thing that just became legal.
 */
function shippedSections(): Array<{ pkg: string; section: Record<string, unknown> }> {
  const out: Array<{ pkg: string; section: Record<string, unknown> }> = []
  for (const pkg of readdirSync(PROCESSORS_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    const file = `${PROCESSORS_DIR}/${pkg.name}/manifest.yaml`
    if (!existsSync(file)) continue
    const manifest = parseYaml(readFileSync(file, 'utf8')) as {
      contributes?: { sections?: Array<Record<string, unknown>> }
    }
    for (const section of manifest.contributes?.sections ?? []) out.push({ pkg: pkg.name, section })
  }
  return out
}

const SECTIONS = shippedSections()

/** The `run_processor` blocks a view declares, with the action that holds each. */
function runProcessorBlocks(raw: Record<string, unknown>): Array<{
  action: string
  block: { id?: string; inputs?: Record<string, unknown>; inputs_from?: Array<{ slot?: unknown }> }
}> {
  const out: Array<{ action: string; block: Record<string, never> }> = []
  for (const action of (raw.actions ?? []) as Array<Record<string, unknown>>) {
    for (const effect of (action.body ?? []) as Array<Record<string, unknown>>) {
      if (effect && typeof effect === 'object' && 'run_processor' in effect) {
        out.push({ action: String(action.id), block: effect.run_processor as Record<string, never> })
      }
    }
  }
  return out as never
}

/** The SLOT VOCABULARY a compute resolves, read out of its source (see arm B above). */
export function computeSlotVocabulary(source: string): { names: Set<string>; prefixes: Set<string> } {
  const names = new Set<string>()
  // `slot_path(slots, "a", "b")` / `slot_paths(slots, "a")` — the literal names a PYTHON
  // compute looks up. The `def` lines carry `*names` and no literals, so they drop out.
  for (const call of source.matchAll(/\bslot_paths?\(\s*slots\s*,([^)]*)\)/g)) {
    for (const lit of call[1].matchAll(/["']([^"']+)["']/g)) names.add(lit[1])
  }
  // The SAME two helper names in a BASH compute's call syntax — `slot_paths "fastqs"`. A
  // shell function takes no `slots` bag (it reads `/inputs/inputs.json` itself) and its call
  // has no parentheses, so the python pattern above reads such a compute as resolving NOTHING
  // and the vacuity guard fires. That is what it is for — "a compute that resolved slots some
  // third way would read as having none" — and this is the answer to it, not a loosening: the
  // literals still come from REAL resolution sites, not from a declaration a compute could
  // make and then not honour.
  //
  // The first token after the helper MUST be a quoted literal, which is what keeps this off
  // prose: a python docstring saying "`slot_path` takes the first of them" has a backtick
  // where this needs whitespace, and `slot_paths(slots, …)` has a paren.
  for (const call of source.matchAll(/\bslot_paths?\s+((?:["'][^"']+["']\s*)+)/g)) {
    for (const lit of call[1].matchAll(/["']([^"']+)["']/g)) names.add(lit[1])
  }
  // A LITERAL slot constant: `ROWS_SLOT = "rows"`, resolved as `slots.get(ROWS_SLOT, [])`.
  //
  // ── WHY THIS ARM EXISTS (measured, not anticipated) ────────────────────────────────────
  //
  // The two `slot_path`/`slot_paths` arms above read a slot out of a CALL. A compute that
  // names its literal slot in a constant and then indexes the bag with it makes no such call,
  // so `integration_integrate.py`'s `rows` slot — a real, `appliesTo`-declared, required slot —
  // read back as resolved by NOTHING. Measured: that compute's vocabulary was
  // `names=[] prefixes=[entity:, level:]`, so a view binding `rows` would have been refused by
  // arm B with "resolved by no slot_path/slot_paths call", naming a slot the compute genuinely
  // reads.
  //
  // This is NOT a loosening past the standard already shipped. The `*_SLOT_PREFIX` arm below
  // already trusts a CONSTANT ASSIGNMENT rather than a call site, for a family resolved through
  // `collect_grid(slots, COLUMN_SLOT_PREFIX, …)`; `ROWS_SLOT` + `slots.get(ROWS_SLOT, …)` is the
  // same construct one arity down. Refusing one while trusting the other was an inconsistency in
  // the reader, not a property of the computes.
  //
  // The `_SLOT` must sit immediately before the `=`, which is what keeps `*_SLOT_PREFIX` out of
  // this set (it ends `_PREFIX`) — the two are different vocabularies and a prefix landing in
  // `names` would make `slotIsKnown` accept the bare prefix as a whole slot name.
  for (const m of source.matchAll(/^[A-Z][A-Z0-9_]*_SLOT\s*=\s*["']([^"']+)["']/gm)) names.add(m[1])
  const prefixes = new Set<string>()
  // A slot FAMILY constant: `COLUMN_SLOT_PREFIX = "column:"`. Language-neutral as written —
  // bash spells an assignment the same way, minus the spaces `\s*` already allows.
  for (const m of source.matchAll(/^[A-Z][A-Z0-9_]*_SLOT_PREFIX\s*=\s*["']([^"']+)["']/gm)) prefixes.add(m[1])
  return { names, prefixes }
}

/**
 * The slot vocabulary of a compute ENTRY, including the sources its manifest declares as
 * `run.helpers` — read as ONE vocabulary, because at runtime they are one program.
 *
 * ── WHY (measured) ────────────────────────────────────────────────────────────────────────
 *
 * `join_quality_preflight.py` resolves the `entity:` family, but it does so through
 * `load_grid`, which it IMPORTS from its sibling (`from integration_integrate import … load_grid`)
 * precisely so the two entry points cannot drift about what a binding means. Its own file
 * therefore contains no slot literal and no family constant at all: measured
 * `names=[] prefixes=[]`. Reading the entry file alone reports a compute that resolves NOTHING,
 * which is the vacuity guard's own alarm condition — a FALSE RED fired by the very refactor
 * that made the seam safer.
 *
 * The helper list is a DECLARATION in the manifest (`run.helpers`), and the runner uses it to
 * stage those files beside the entry. So this follows a declared edge rather than guessing at
 * an import graph: a compute that reads a slot through a file it never declared would still
 * read as resolving nothing, and should.
 */
function computeVocabularyWithHelpers(
  pkg: string,
  run: { entry?: unknown; helpers?: unknown } | undefined,
): { names: Set<string>; prefixes: Set<string> } {
  const names = new Set<string>()
  const prefixes = new Set<string>()
  const rels = [run?.entry, ...(Array.isArray(run?.helpers) ? run.helpers : [])]
  for (const rel of rels) {
    if (typeof rel !== 'string' || rel.length === 0) continue
    const path = `${PROCESSORS_DIR}/${pkg}/${rel}`
    if (!existsSync(path)) continue
    const v = computeSlotVocabulary(readFileSync(path, 'utf8'))
    for (const n of v.names) names.add(n)
    for (const p of v.prefixes) prefixes.add(p)
  }
  return { names, prefixes }
}

/** Every slot a view CAN emit for one `run_processor`: the literal `inputs` keys plus each
 *  `inputs_from` binding's slot template. */
function declaredSlots(block: {
  inputs?: Record<string, unknown>
  inputs_from?: Array<{ slot?: unknown }>
}): string[] {
  return [
    ...Object.keys(block.inputs ?? {}),
    ...(block.inputs_from ?? []).map(b => String(b.slot ?? '')),
  ]
}

/** Is `slot` (possibly an `inputs_from` template like `column:{$c.column}`) in the compute's
 *  vocabulary? A template is judged by the literal text BEFORE its first `{`, which must be a
 *  declared slot-family prefix; a plain name must be a declared name. */
function slotIsKnown(slot: string, vocab: { names: Set<string>; prefixes: Set<string> }): boolean {
  const brace = slot.indexOf('{')
  if (brace < 0) return vocab.names.has(slot)
  return vocab.prefixes.has(slot.slice(0, brace))
}

/** The (view file, run_processor) pairs whose analysis + compute entry both resolve. */
const runPairs = specs.flatMap(s => {
  const raw = loadYaml(s.path)
  return runProcessorBlocks(raw).map(({ action, block }) => {
    const found = ANALYSES.get(String(block.id))
    const run = found?.analysis.run as { entry?: string; helpers?: unknown } | undefined
    const entry = run?.entry
    return {
      pkg: s.pkg,
      file: s.file,
      action,
      block,
      analysisId: String(block.id),
      analysis: found?.analysis,
      computePath: found && entry ? `${PROCESSORS_DIR}/${found.pkg}/${entry}` : undefined,
      // Computed ONCE, here, because BOTH arms need it: arm A's floor asks whether the
      // analysis resolves anything at all, and a family-only analysis answers that from its
      // compute rather than from `appliesTo`.
      vocab: found ? computeVocabularyWithHelpers(found.pkg, run) : undefined,
    }
  })
})

describe('view ↔ compute input seam — a view may only name slots its compute resolves', () => {
  it('finds the shipped run_processor blocks (a zero match would make every check vacuous)', () => {
    expect(runPairs.length).toBeGreaterThanOrEqual(2)
    expect(runPairs.map(p => p.analysisId).sort()).toEqual(expect.arrayContaining(['cell.filter', 'qc.10x']))
    for (const p of runPairs) {
      expect(p.analysis, `run_processor "${p.analysisId}" names no shipped analysis`).toBeTruthy()
    }
  })

  it.each(runPairs)(
    'A: $pkg/$file $action binds every REQUIRED slot of $analysisId (appliesTo, DEC-5)',
    ({ block, analysis, vocab }) => {
      const required = ((analysis?.appliesTo ?? []) as Array<{ slot?: string }>)
        .map(s => s.slot)
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
      // ── THE FLOOR IS "RESOLVES SOMETHING", NOT "DECLARES AN `appliesTo` SLOT" ───────────
      //
      // The floor exists so an analysis cannot pass this arm vacuously by declaring no input
      // shape at all. It was spelled as "≥1 `appliesTo` slot" when every shipped analysis had
      // one — and it is measurably the wrong spelling for a FAMILY-ONLY analysis.
      // A family-only analysis reads only `<family>:<i>:<column>` bindings, a slot family whose
      // extent is data; `appliesTo` is a list of STATIC selectors and no literal key can spell
      // those, so it declares applicability by `subtypes_of` with no `slot`. That analysis has a
      // fully-specified input shape and failed here for having declared it honestly.
      //
      // Naming a slot the compute ignores, purely to satisfy this line, is the arrangement the
      // slot rework just REMOVED — a declaration that stages artifacts for nothing and reads to
      // the next maintainer as a contract. So the floor asks the real question: does this
      // analysis resolve any input at all, statically or by family? An analysis with neither is
      // still refused, which is the vacuity this guard was for.
      expect(
        required.length + (vocab?.prefixes.size ?? 0),
        'the analysis declares no required `appliesTo` slot AND its compute resolves no slot ' +
          'family — there is no input shape for this arm to check',
      ).toBeGreaterThan(0)
      const bound = new Set(Object.keys(block.inputs ?? {}))
      for (const slot of required) {
        // An `appliesTo` entry is required BY DEFINITION, so a view that does not pass it is
        // relying on the launcher's sole-candidate auto-resolution — the invisible step INV-4
        // removes, and the one that used to throw `found ${options.length}`.
        expect(bound.has(slot), `required slot "${slot}" is not in this run_processor's inputs`).toBe(true)
      }
    },
  )

  it.each(runPairs)(
    'B: $pkg/$file $action names only slots compute/$analysisId resolves',
    ({ block, computePath, vocab }) => {
      expect(computePath, 'the analysis declares no run entry').toBeTruthy()
      expect(existsSync(computePath!), `compute entry missing: ${computePath}`).toBe(true)
      // VACUITY GUARD: a compute whose vocabulary reads back empty would approve every slot
      // name in the tree. Fail instead — an unreadable contract is not a satisfied one.
      //
      // It counts BOTH channels, and counting only `names` was a live FALSE RED rather than a
      // vacuous pass. A compute resolving its slots ENTIRELY through families — no literal
      // `slot_path(slots, "…")` anywhere — has `names.size === 0` and a perfectly readable
      // contract; it read back as "the reader has drifted from the compute" and failed. Measured
      // on `integration_integrate.py`: `names=[] prefixes=[entity:, level:]`. The property the
      // guard defends is unchanged — a vocabulary empty in BOTH channels still fails, and that
      // is what "unreadable" means.
      const known = vocab!.names.size + vocab!.prefixes.size
      expect(
        known,
        `no slot vocabulary extracted from ${computePath} (or its declared run.helpers) — ` +
          'the reader has drifted from the compute',
      ).toBeGreaterThan(0)
      for (const slot of declaredSlots(block)) {
        expect(
          slotIsKnown(slot, vocab!),
          `slot "${slot}" is resolved by no slot_path/slot_paths call, no *_SLOT literal and no ` +
            `*_SLOT_PREFIX family in ${computePath} or its declared run.helpers. ` +
            `Known: [${[...vocab!.names].sort().join(', ')}]` +
            `${vocab!.prefixes.size ? ` prefixes: [${[...vocab!.prefixes].sort().join(', ')}]` : ''}`,
        ).toBe(true)
      }
    },
  )

  it('FIRES on a slot the compute does not resolve (negative control)', () => {
    const vocab = computeSlotVocabulary(
      ['COLUMN_SLOT_PREFIX = "column:"', 'x = slot_path(slots, "expression", "cells_index")'].join('\n'),
    )
    expect(vocab.names).toEqual(new Set(['expression', 'cells_index']))
    expect(vocab.prefixes).toEqual(new Set(['column:']))
    // the real spellings pass…
    expect(slotIsKnown('expression', vocab)).toBe(true)
    expect(slotIsKnown('column:{$c.column}', vocab)).toBe(true)
    // …and the near-misses that would silently mount nothing do not.
    expect(slotIsKnown('cells-index', vocab)).toBe(false)
    expect(slotIsKnown('expressions', vocab)).toBe(false)
    expect(slotIsKnown('column_{$c.column}', vocab)).toBe(false)
  })

  // The BASH arm of the same reader, with its own negative control — widening a gate without
  // proving the widened form still FIRES is how a guard becomes decorative.
  it('reads a BASH compute’s slot calls, and still FIRES on the near-misses', () => {
    const vocab = computeSlotVocabulary(
      [
        '#!/usr/bin/env bash',
        'slot_paths() { # slot-name… → every existing /inputs mount bound to the first named slot',
        '  jq -r --arg s "$1" ".inputs[] | select(.slot == \\$s)" "$INPUTS_DIR/inputs.json"',
        '}',
        'FASTQ_DIRS="$(slot_paths "fastqs")"',
        'IDX="$(slot_path "cells_index" "cells-index")"',
      ].join('\n'),
    )
    expect(vocab.names).toEqual(new Set(['fastqs', 'cells_index', 'cells-index']))
    expect(slotIsKnown('fastqs', vocab)).toBe(true)
    // The DEFINITION line contributes nothing (its `(` is where a call has whitespace), so a
    // compute that only defines the helper and never calls it reads as resolving no slots.
    expect(computeSlotVocabulary('slot_paths() { :; }').names.size).toBe(0)
    // …and a slot nothing resolves is still refused.
    expect(slotIsKnown('fastq', vocab)).toBe(false)
    expect(slotIsKnown('reference', vocab)).toBe(false)
  })

  // ── THE THREE WIDENINGS, EACH WITH THE CONTROL THAT MUST STILL FIRE ────────────────────
  //
  // Each arm below was added because a REAL compute in this tree read back as resolving
  // nothing. A widening whose over-accepting form is not asserted is a guard that has been
  // loosened rather than corrected, so each one is paired here with the near-miss it must
  // still refuse.
  // ── A `job.result` SLICE MUST NOT NAME A COMPUTE THAT HIDES ITS OUTPUT ────────────────
  //
  // `job.result` resolves through `data.artifacts.query({type})` -> `listArtifacts`, and that
  // handler ends with an unconditional `items.retain(|a| !a.hidden)` — there is no
  // `include_hidden` anywhere in the server or the UI. So a compute that emits its result
  // `hidden: true` is INVISIBLE to any view binding it, and the binding resolves `empty`
  // forever.
  //
  // That shipped: the integration form's identifier table could never populate, so its
  // required key could never be set and Run was permanently disabled. The whole surface was
  // unusable, and no test noticed because every unit was correct in isolation.
  //
  // This reads the two DECLARATIONS — the view's `produced_by` and the compute's emitted
  // `hidden` — and refuses the combination. It is a source-text read of the compute, which is
  // the same standard the slot-vocabulary arms above already apply.
  it('no `job.result` slice names a compute that emits its output hidden', () => {
    const offenders: string[] = []
    let checked = 0
    for (const spec of specs) {
      const raw = loadYaml(spec.path) as { data?: Record<string, { source?: string; args?: { produced_by?: string } }> }
      for (const [key, decl] of Object.entries(raw.data ?? {})) {
        if (decl?.source !== 'job.result') continue
        const producedBy = decl.args?.produced_by
        if (typeof producedBy !== 'string' || producedBy === '') continue
        const found = ANALYSES.get(producedBy)
        const entry = (found?.analysis.run as { entry?: string } | undefined)?.entry
        if (!found || !entry) continue
        const path = `${PROCESSORS_DIR}/${found.pkg}/${entry}`
        if (!existsSync(path)) continue
        checked++
        // The emitted manifest entry's own declaration. `True`/`true` — the compute may be
        // python or bash.
        if (/["']hidden["']\s*:\s*(True|true)/.test(readFileSync(path, 'utf8'))) {
          offenders.push(`${spec.pkg}/${spec.file} data.${key} -> ${producedBy} (${entry})`)
        }
      }
    }
    // A filter matching nothing reports success having checked nothing.
    expect(checked, 'no resolvable job.result binding found — this guard is vacuous').toBeGreaterThan(0)
    expect(
      offenders,
      'a view binds `job.result` to a compute whose output is hidden; the listing filters it ' +
        'unconditionally, so the slice can only ever resolve empty',
    ).toEqual([])
  })

  it('reads a LITERAL slot constant (`ROWS_SLOT = "rows"`), and does not read a family as one', () => {
    const vocab = computeSlotVocabulary(
      [
        'ENTITY_SLOT_PREFIX = "entity:"',
        'ROWS_SLOT = "rows"',
        'rows = slots.get(ROWS_SLOT, [])',
      ].join('\n'),
    )
    expect(vocab.names).toEqual(new Set(['rows']))
    // The PREFIX constant must NOT land in `names`: if it did, `slotIsKnown` would accept the
    // bare string "entity:" as a whole slot name — a slot no binding ever produces and no
    // compute ever reads.
    expect(vocab.prefixes).toEqual(new Set(['entity:']))
    expect(slotIsKnown('rows', vocab)).toBe(true)
    expect(slotIsKnown('entity:', vocab)).toBe(false)
    // …and the near-misses that would silently mount nothing still are not vocabulary.
    expect(slotIsKnown('row', vocab)).toBe(false)
    expect(slotIsKnown('ROWS_SLOT', vocab)).toBe(false)
    // A CONSTANT is not a call, but it is the same standard the family arm already applied.
    // What is still refused is a name that appears only in PROSE.
    expect(computeSlotVocabulary('# the ROWS_SLOT = "rows" convention').names.size).toBe(0)
  })

  it('counts a FAMILY-ONLY compute as non-vacuous, and an empty one as vacuous', () => {
    // The false RED this fix closes: no `slot_path` call anywhere, a perfectly readable
    // contract, `names.size === 0`.
    const familyOnly = computeSlotVocabulary('LEVEL_SLOT_PREFIX = "level:"')
    expect(familyOnly.names.size).toBe(0)
    expect(familyOnly.names.size + familyOnly.prefixes.size).toBeGreaterThan(0)
    // The property the vacuity guard actually defends is unchanged: a source that resolves
    // nothing in EITHER channel still counts as unreadable, and still fails.
    const nothing = computeSlotVocabulary('def main():\n    pass\n')
    expect(nothing.names.size + nothing.prefixes.size).toBe(0)
  })

  it('unions a declared `run.helpers` source into the entry’s vocabulary, and nothing else', () => {
    // The shipped instance is found by its SHAPE — the analysis that declares `run.helpers`
    // and whose own entry resolves no slot — rather than by spelling its id. The id is a
    // domain package's vocabulary and this is a core spec; searching for the shape also keeps
    // the arm pinned to the PROPERTY it tests instead of to one package's name.
    const jq = [...ANALYSES.values()].find(a => {
      const run = a.analysis.run as { entry?: string; helpers?: unknown } | undefined
      if (!Array.isArray(run?.helpers) || run.helpers.length === 0) return false
      const entry = `${PROCESSORS_DIR}/${a.pkg}/${run.entry}`
      if (!existsSync(entry)) return false
      // The shape this arm is about: a contract SATISFIED ACROSS TWO FILES. The search
      // selects on the union being readable at all — otherwise it would pick an analysis
      // whose helpers are equally empty, which is a different (and legitimate) shape.
      const own = computeSlotVocabulary(readFileSync(entry, 'utf8'))
      const both = computeVocabularyWithHelpers(a.pkg, run)
      return own.names.size + own.prefixes.size === 0 && both.names.size + both.prefixes.size > 0
    })
    expect(jq, 'no family-only analysis with declared helpers remains — this arm is vacuous').toBeTruthy()
    const run = jq!.analysis.run as { entry?: string; helpers?: string[] }
    expect(run.helpers, 'the analysis no longer declares the helper this arm follows').toBeTruthy()
    // The entry ALONE is empty — this is the measurement, asserted rather than remembered, so
    // the union below cannot be satisfied by the entry quietly growing its own constant.
    const entryOnly = computeSlotVocabulary(readFileSync(`${PROCESSORS_DIR}/${jq!.pkg}/${run.entry}`, 'utf8'))
    expect(entryOnly.names.size + entryOnly.prefixes.size).toBe(0)
    const united = computeVocabularyWithHelpers(jq!.pkg, run)
    // The load-bearing assertion, and it is INDEPENDENT of the search: reading the entry file
    // ALONE reports a compute that resolves nothing — which is the vacuity guard's own alarm
    // condition, and the FALSE RED this union exists to prevent. (`entryOnly` above is the
    // measurement; this is what it means.)
    expect(united.names.size + united.prefixes.size).toBeGreaterThan(entryOnly.names.size)
    // An UNDECLARED sibling contributes nothing: the edge followed is the manifest's, not an
    // import graph guessed at. Same package, real file, not in `helpers`.
    const noHelpers = computeVocabularyWithHelpers(jq!.pkg, { entry: run.entry })
    expect(noHelpers.names.size + noHelpers.prefixes.size).toBe(0)
  })

  // Prose must not become vocabulary. `cell-filter.py` really does say "`slot_path` takes the
  // first of them that is" in a docstring; a reader that harvested from that would approve
  // slot names no compute resolves.
  it('does NOT harvest slot names out of prose that merely mentions the helper', () => {
    const vocab = computeSlotVocabulary(
      '"""SLOT names, not filename patterns — `slot_path` takes the first of them that is\npresent."""',
    )
    expect(vocab.names.size).toBe(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────
// TEST-24's SECOND half — the two DECLARATIONS the migration turns on.
//
// Its first half ("every shipped manifest parses under the new schema and declares none
// of the removed keys") is the BUILD gate's, in Rust: `build_helper/processor_manifest.rs`
// mirrors this schema with `deny_unknown_fields` and every removed key absent, over the
// same directory walk, so a manifest carrying one cannot compile. Nothing there can check
// the two clauses below, because both are relations between a manifest and the FILES beside
// it, and the second is a relation the FE loader alone consumes.
//
// Both are enumerated from the DIRECTORY, never from a written-down package list — the same
// property the discovery guard above pins for the view specs, for the same reason: a package
// added later is covered on the next run rather than silently skipped.
describe('shipped manifests — `appliesTo` and the `ui:` ↔ file relation (TEST-24)', () => {
  const analyses = [...ANALYSES.entries()].map(([id, { pkg, analysis }]) => ({ id, pkg, analysis }))

  /** Every `ui:` entry any shipped analysis declares, as `{pkg, entry}` (entry is
   *  package-relative, e.g. `ui/<file>.yaml` — the shape `loadProcessors` looks up). */
  const declaredUi = analyses.flatMap(({ id, pkg, analysis }) =>
    ((analysis.ui ?? []) as string[]).map(entry => ({ id, pkg, entry })),
  )

  /** Every `ui:` entry any shipped SECTION declares — the second owner kind (ITEM-65). */
  const declaredSectionUi = SECTIONS.flatMap(({ pkg, section }) =>
    ((section.ui ?? []) as string[]).map(entry => ({ id: String(section.id), pkg, entry })),
  )

  it('discovers the shipped analyses (a zero match would make every check below vacuous)', () => {
    expect(analyses.length).toBeGreaterThanOrEqual(3)
    expect(specs.length).toBeGreaterThanOrEqual(2)
  })

  it('discovers the shipped SECTIONS (a zero match would make the ownership rule analysis-only again)', () => {
    // Not a formality: with zero sections discovered, the widened ownership rule below
    // degrades silently to the old analysis-only one and a section spec would go back to
    // failing. The count is a floor, not the package list — a second contributing package
    // is covered without editing this number.
    expect(SECTIONS.length, 'ITEM-65 ships a package whose only contribution is sections').toBeGreaterThanOrEqual(2)
  })

  it.each(analyses)('$pkg/$id declares a non-empty `appliesTo`', ({ analysis }) => {
    // `appliesTo` replaced `accepts` + `when` + `params.fields`, and it is the SOLE
    // availability input — `computeAvailability` reads `appliesTo ?? []`, and `[].every()`
    // is `true`, so an analysis that declares none is not "unavailable", it is UNIVERSALLY
    // available. That is the silently-over-enabled launcher DRIFT-1.14 recorded, and an
    // empty list reaches it by exactly the same route a missing key does.
    const appliesTo = (analysis.appliesTo ?? []) as unknown[]
    expect(Array.isArray(appliesTo)).toBe(true)
    expect(appliesTo.length, 'an empty `appliesTo` is UNIVERSALLY available, not unavailable').toBeGreaterThan(0)
  })

  it.each(declaredUi)('$pkg/$id `ui:` entry $entry exists on disk', ({ pkg, entry }) => {
    // The dangling direction. `loadProcessors` fails LOUD on a `ui:` naming a missing file,
    // but only for a package it actually loads — and the user-visible outcome of that error
    // is byte-identical to declaring no `ui:` at all (the generic fallback form). Catching
    // it here makes a typo'd path a red test rather than a console line in a deployment.
    expect(existsSync(`${PROCESSORS_DIR}/${pkg}/${entry}`), `no such file: ${pkg}/${entry}`).toBe(true)
  })

  it.each(declaredSectionUi)('$pkg section $id `ui:` entry $entry exists on disk', ({ pkg, entry }) => {
    // The dangling direction, for the section kind. `loadProcessors` fails LOUD here too —
    // and fail-CLOSED for the whole section, so a typo drops a Visualize block entirely.
    expect(existsSync(`${PROCESSORS_DIR}/${pkg}/${entry}`), `no such file: ${pkg}/${entry}`).toBe(true)
  })

  it.each(specs)('packages/$pkg/ui/$file is NAMED by exactly one analysis OR one section (else it never registers)', ({
    pkg,
    file,
  }) => {
    // The OTHER direction, and the one with no runtime symptom at all: registration walks
    // the OWNERS' `ui:` lists (it replaced the `ui/*.yaml` GLOB), so a spec file that no
    // owner lists is simply never registered. It parses, it lints, it ships, and it renders
    // nothing — with no error anywhere, because nothing ever looked for it.
    //
    // Widened to TWO owner kinds by ITEM-65. Exactly one owner in TOTAL, not one of each:
    // a file named by both an analysis and a section would register twice, into two
    // registries, and the same store id would be mounted in two places.
    const owners = [
      ...declaredUi.filter(u => u.pkg === pkg && u.entry === `ui/${file}`),
      ...declaredSectionUi.filter(u => u.pkg === pkg && u.entry === `ui/${file}`),
    ]
    expect(
      owners.length,
      `ui/${file} is listed by ${owners.length} analyses+sections in ${pkg}; a file no owner names is never registered`,
    ).toBe(1)
  })
})

// ── TEST-88 (ITEM-29e / DEC-15) — the MIGRATION, read off the real specs ─────────────
//
// `auto_bind_sole_candidate` is opt-IN, so absence is OFF. That makes the migration of the
// shipped packages part of the behaviour change, not bookkeeping: without it, ITEM-29b silently
// converts three shipping surfaces from auto-binding to unbound, and nothing would say so.
//
// It reads the real `packages/*/ui/*.yaml` on disk rather than a fixture, for the same reason
// the gate above does: a fixture can be migrated while the shipped file is not, and then the
// test asserts the migration of something nobody ships. The negative control is that a spec
// declaring no `artifact_ref` is not required to carry it — otherwise this would be "every spec
// must contain a string", which is a rule about text.
//
// ── SCOPED TO THE MIGRATION SET, and that scoping is the rule, not an exemption ──────
//
// As first landed this asserted the declaration on EVERY shipped `artifact_ref`, which reads
// as "every picker auto-binds its sole candidate" — the exact proposition ITEM-29b removed,
// re-certified one layer out. DEC-15 says the opposite for anything new: *"A NEW package that
// declares nothing shows an UNBOUND control."* So the requirement belongs to the specs that
// shipped BEFORE the declaration existed and relied on the unconditional behaviour — the
// ANALYSIS-owned ones — and a spec owned by a SECTION (ITEM-65, authored after) is asserted to
// DECLINE it. Both halves in one place, so the suite cannot come to hold both propositions at
// once. [feedback_tests_that_certify_bugs]
describe('every shipped artifact_ref DECLARES its auto-bind (TEST-88, ITEM-29e / DEC-15)', () => {
  /** Every `artifact_ref` widget anywhere in a spec, descending through `group` children. */
  function artifactRefs(widgets: unknown, into: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
    if (!Array.isArray(widgets)) return into
    for (const w of widgets) {
      if (!w || typeof w !== 'object') continue
      const rec = w as Record<string, unknown>
      if (rec.kind === 'artifact_ref') into.push(rec)
      if (rec.kind === 'group') artifactRefs(rec.children, into)
    }
    return into
  }

  /** Package-relative `ui/<file>` entries a SECTION names — the post-declaration authoring. */
  const sectionOwned = new Set(
    SECTIONS.flatMap(({ pkg, section }) => ((section.ui ?? []) as string[]).map(entry => `${pkg}/${entry}`)),
  )

  const withRefs = specs
    .map(s => ({ ...s, refs: artifactRefs((parseYaml(readFileSync(s.path, 'utf8')) as { widgets?: unknown }).widgets) }))
    .filter(s => s.refs.length > 0)

  const migrated = withRefs.filter(s => !sectionOwned.has(`${s.pkg}/ui/${s.file}`))
  const authoredAfter = withRefs.filter(s => sectionOwned.has(`${s.pkg}/ui/${s.file}`))

  it('finds the shipped artifact_ref surfaces (a zero match would pass every case below)', () => {
    // Asserted on the PACKAGE count rather than the widget count, because a spec growing a
    // second picker must be covered without editing a number here. The packages are not NAMED:
    // the set is whatever ships, and naming it would both duplicate the discovery above and
    // carry package vocabulary into the app tree.
    expect(withRefs.length, 'DEC-15 names three shipping packages with an artifact_ref').toBeGreaterThanOrEqual(3)
  })

  it.each(migrated)('packages/$pkg/ui/$file declares auto_bind_sole_candidate on every artifact_ref', ({ refs, pkg, file }) => {
    for (const ref of refs) {
      expect(
        ref.auto_bind_sole_candidate,
        `packages/${pkg}/ui/${file} widget "${String(ref.id)}" relies on the sole-candidate ` +
          'bind that shipped unconditionally; under DEC-15 the declaration is opt-IN, so omitting ' +
          'it silently unbinds this surface',
      ).toBe(true)
    }
  })

  it('a SECTION-owned artifact_ref declines the auto-bind (DEC-15\'s rule for anything new)', () => {
    // The other half of the ruling, asserted rather than assumed. A section's picker is the
    // pane's FRAME (which coordinates? which row space?), and DEC-15 + INV-3 both say a frame
    // is never chosen for the user — "sole candidacy is not consent". If a later author adds
    // the key to make a section auto-bind, this fails and the decision gets re-opened instead
    // of being reversed by a one-line edit.
    expect(
      authoredAfter.length,
      'ITEM-65 ships a section whose spec declares an artifact_ref — without one this rule holds vacuously',
    ).toBeGreaterThanOrEqual(1)
    for (const s of authoredAfter) {
      for (const ref of s.refs) {
        expect(
          ref.auto_bind_sole_candidate,
          `packages/${s.pkg}/ui/${s.file} widget "${String(ref.id)}" declares the auto-bind; ` +
            'a section opens UNANCHORED and says why (DEC-15, INV-3, INV-10)',
        ).toBeUndefined()
      }
    }
  })

  it('a spec with NO artifact_ref is not required to declare it (negative control)', () => {
    // Without this the rule would be "every shipped spec contains the string", which is a claim
    // about text rather than about behaviour, and would be satisfied by a comment.
    const withoutRefs = specs.filter(s => artifactRefs((parseYaml(readFileSync(s.path, 'utf8')) as { widgets?: unknown }).widgets).length === 0)
    for (const s of withoutRefs) {
      expect(readFileSync(s.path, 'utf8')).not.toContain('auto_bind_sole_candidate')
    }
  })
})

// ── TEST-90 (ITEM-29f), the MIGRATION half — read off the real manifests ─────────────
//
// The widget's declaration governs a control a user is looking at. The manifest slot's governs
// the two paths that bind a sole candidate with NO UI at all — `resolveInputs` at launch (an
// agent/MCP call that supplied nothing) and `autoPickSoleArtifacts` from a mount effect, after
// which `runGate` reports the form ready. Both are now gated, and both are opt-IN, so the
// shipped manifests have to declare it or three analyses silently stop resolving their input.
//
// It reads the real `packages/*/manifest.yaml` for the same reason TEST-88 reads the real
// view specs: a fixture can be migrated while the shipped file is not.
describe('every shipped SINGLE-VALUE input slot declares its auto-bind (TEST-90, ITEM-29f)', () => {
  const manifests = readdirSync(PROCESSORS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(`${PROCESSORS_DIR}/${d.name}/manifest.yaml`))
    .map(d => ({ pkg: d.name, path: `${PROCESSORS_DIR}/${d.name}/manifest.yaml` }))

  /** Every `appliesTo[]` selector carrying a `slot`, across every analysis in a manifest. */
  function slots(path: string): Array<Record<string, unknown>> {
    const m = parseYaml(readFileSync(path, 'utf8')) as {
      contributes?: { analyses?: Array<{ appliesTo?: unknown[] }> }
    }
    const out: Array<Record<string, unknown>> = []
    for (const a of m.contributes?.analyses ?? []) {
      for (const sel of a.appliesTo ?? []) {
        if (sel && typeof sel === 'object' && (sel as Record<string, unknown>).slot) {
          out.push(sel as Record<string, unknown>)
        }
      }
    }
    return out
  }

  const withSingleSlots = manifests
    .map(m => ({ ...m, sels: slots(m.path).filter(s => s.multiple !== true) }))
    .filter(m => m.sels.length > 0)

  it('finds the shipped single-value slots (a zero match would pass every case below)', () => {
    // The `multiple: true` slots are excluded by both auto-bind sites already — a multi-ref is
    // 0-or-more by definition — so they are correctly out of scope rather than forgotten, and
    // the negative control below asserts exactly that.
    expect(withSingleSlots.length, 'three shipping analyses declare a single-value input slot').toBeGreaterThanOrEqual(3)
  })

  it.each(withSingleSlots)('packages/$pkg/manifest.yaml declares auto_bind_sole_candidate on every single-value slot', ({ sels, pkg }) => {
    for (const sel of sels) {
      expect(
        sel.auto_bind_sole_candidate,
        `packages/${pkg}/manifest.yaml slot "${String(sel.slot)}" relied on the headless ` +
          'sole-candidate bind that shipped unconditionally; under DEC-15 the declaration is ' +
          'opt-IN, so omitting it leaves this input unresolved for an agent/MCP launch',
      ).toBe(true)
    }
  })

  it('a MULTIPLE slot is not required to declare it (negative control)', () => {
    // Without this the rule would be "every slot carries the key", which is a claim about text.
    // A multi-ref is 0-or-more at launch and was never auto-bound by either site.
    const multi = manifests.flatMap(m => slots(m.path)).filter(s => s.multiple === true)
    expect(multi.length, 'the fixture set must contain at least one multiple slot').toBeGreaterThan(0)
    for (const sel of multi) expect(sel.auto_bind_sole_candidate).toBeUndefined()
  })
})
