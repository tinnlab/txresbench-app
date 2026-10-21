// TEST-1 (unit) [acceptance] [invariant: INV-1] [covers: ITEM-1, ITEM-4]
//
// INV-1 — "The manifest declares only what the workbench needs to LOAD, ENABLE and
// EXECUTE an analysis. No labels, no help text, no field order, no form schema, no
// domain data, no forecast of produced columns."
// (`docs/design/processor-manifest-ui-separation.md`.)
//
// ── Why this is written against a NEW fixture package, not a shipped one ─────────────
//
// The invariant is a claim about ANY manifest, so a test that asserts the one migrated
// package still works cannot fail on "implementation ≠ design" — it would pass equally
// against a loader that special-cases the packages in this tree. The subject here is
// therefore a package that does not exist anywhere in the repo: its whole `manifest.yaml`
// (and its view file) is authored inline, in YAML, exactly as a third party would ship it,
// and it is driven through the REAL `loadProcessors` into a REAL `Registry`. It uses
// NEUTRAL vocabulary on purpose — "any processor works" is not evidenced by a processor
// from the one domain the app already knows.
//
// The positive case is deliberately the MINIMAL manifest the design names: an analysis
// entry carrying ONLY `{id, appliesTo, produces, ui, run, schedule.class}`. That set is
// asserted literally (`Object.keys`), so a future manifest key that quietly becomes
// load-bearing turns the minimal fixture red rather than passing unnoticed.
//
// ── SCOPE: this covers ONE of THREE independent enforcement points ───────────────────
//
// A removed key is refused in three different places, by three different mechanisms, and
// this file exercises exactly the first:
//
//   1. THE FE LOADER (this file) — `runtime/loadProcessors.ts::assertNoRemovedKeys`,
//      at registration time, for EVERY package including one dropped at runtime that
//      no build ever saw.
//   2. THE RUST BUILD GATE — `server/build_helper/processor_manifest.rs`, whose
//      `#[serde(deny_unknown_fields)]` mirror makes an in-tree `src-app/packages/*`
//      manifest carrying a removed key fail `cargo check`. It cannot see a
//      runtime-dropped package, and this file cannot see it.
//   3. VERSION-KEYED SEED RECONCILIATION — the embedded-package refresh path.
//
// Nothing below should be read as covering (2) or (3). They have their own tests, and a
// green run here says nothing about either.

import { describe, expect, it, beforeEach } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  Registry,
  WORKBENCH_API_VERSION,
  type AnalysisContribution,
  type Contributions,
  type ProcessorPackage,
  type StatusBarItemContribution,
  type SectionContribution,
  type ViewContribution,
} from '@/modules/workbench/core'
import { loadProcessors } from '../runtime/loadProcessors'
import { isDeclarativeRenderSpec } from '../runtime/seam'
import { __resetRegisteredSpecsForTests } from '../runtime/interpreter'
import { __resetBuiltinWidgetsForTests } from '@/modules/workbench/extensions'
import { fakeLattice } from '../__testutil__/fakes'

// ── the fixture package, as YAML ─────────────────────────────────────────────────────
//
// Authored as TEXT and parsed with the same `yaml` parser the production discovery path
// uses, so the subject is a manifest FILE and not a hand-built object graph that has
// already been shaped by this file's own idea of the schema.

const PKG_ID = 'probe.shape'
const ANALYSIS_ID = 'probe.shape.run'
const VIEW_FILE = 'ui/probe.yaml'

/** The six analysis keys INV-1 leaves on the contract, in the design's own order. */
const MINIMAL_KEYS = ['id', 'appliesTo', 'produces', 'ui', 'run', 'schedule']

/** A manifest whose ONE analysis carries exactly {@link MINIMAL_KEYS}. `subtypes_of:
 *  matrix` is a lattice ROOT, not a domain type — `fakeLattice`'s neutral branch
 *  (`projection → matrix → tabular → data`, `grouping → data`) is what makes the
 *  enablement assertions below discriminate rather than always answer the same way. */
const MINIMAL_MANIFEST = `
id: ${PKG_ID}
name: Probe package
publisher: probe
version: 0.0.1
apiVersion: "^1.0"
contributes:
  analyses:
    - id: ${ANALYSIS_ID}
      appliesTo:
        - { slot: frame, subtypes_of: matrix }
      produces: [probe/summary]
      ui: [${VIEW_FILE}]
      run: { kind: sandbox, runtime: python, entry: compute/probe.py }
      schedule: { class: batch }
`

/** The fixture's view file. Its content is irrelevant to INV-1 beyond being VALID — what
 *  matters is that the manifest's `ui:` entry resolves to a pane, i.e. that the manifest
 *  did its LOAD job. */
const MINIMAL_VIEW = `
id: probe/form
title: Probe form
permission: jobs::use
state:
  chosen: { type: string, default: "" }
widgets:
  - { id: probeGo, kind: button, label: Go, onClick: probe.go }
actions:
  - id: probe.go
    title: Go
    permission: jobs::use
    mutating: true
    stateful: true
    params: {}
    body:
      - set: { chosen: done }
`

/**
 * The keys INV-1 REMOVED, spelled out from the design + PLAN ITEM-25 rather than imported
 * from the loader.
 *
 * Importing `REMOVED_ANALYSIS_KEYS` would make this list agree with the implementation by
 * construction — the exact tautology an acceptance test exists to avoid. Written down
 * here, a key silently dropped from the loader's list turns a case red.
 *
 * Each entry is the YAML fragment a manifest would carry, and the dotted key the error
 * must name.
 */
const REMOVED_KEYS: ReadonlyArray<[key: string, yamlFragment: string]> = [
  ['accepts', '      accepts: [{ type_id: matrix }]'],
  ['when', '      when: "has:matrix"'],
  ['params', '      params: { fields: [{ name: frame, title: Frame }] }'],
  ['defaults', '      defaults: { threshold: 3 }'],
  [
    'produces_annotations',
    '      produces_annotations: [{ name: score, type: continuous, axis: rows }]',
  ],
  ['inStandardRecipe', '      inStandardRecipe: true'],
  ['recipeOrder', '      recipeOrder: 2'],
  ['run.inputs', '      run: { kind: sandbox, entry: compute/probe.py, inputs: { frame: frame.bin } }'],
  ['schedule.resources', '      schedule: { class: batch, resources: { cpu: 4 } }'],
]

/** Splice an extra (or replacement) analysis block into the minimal manifest. A fragment
 *  that re-declares `run:`/`schedule:` REPLACES the minimal one, which is how the two
 *  NESTED removed keys are expressed. */
function manifestWith(fragment: string): string {
  const key = fragment.trim().split(':')[0]
  const withoutReplaced = MINIMAL_MANIFEST.split('\n')
    .filter(line => !(key === 'run' && line.trim().startsWith('run:')))
    .filter(line => !(key === 'schedule' && line.trim().startsWith('schedule:')))
    .join('\n')
  return `${withoutReplaced.trimEnd()}\n${fragment}\n`
}

/** Decode a manifest + view text pair into the `ProcessorPackage` the loader consumes —
 *  the same YAML-parse the production glob/runtime-fetch decoders perform. */
function packageFrom(manifestText: string, viewText: string = MINIMAL_VIEW): ProcessorPackage {
  return {
    manifest: parseYaml(manifestText) as ProcessorPackage['manifest'],
    views: { [VIEW_FILE]: parseYaml(viewText) },
  }
}

/** A REAL `Contributions` (the production `Registry`, not a stub) so "registers" means
 *  what it means in the app. */
function realRegistry(): Contributions {
  return {
    analyses: new Registry<AnalysisContribution>('analyses'),
    views: new Registry<ViewContribution>('views'),
    statusBarItems: new Registry<StatusBarItemContribution>('statusBarItems'),
    sections: new Registry<SectionContribution>('sections'),
  }
}

beforeEach(() => {
  __resetRegisteredSpecsForTests()
  __resetBuiltinWidgetsForTests()
})

describe('INV-1 (TEST-1): the manifest carries only LOAD / ENABLE / EXECUTE', () => {
  it('the fixture manifest carries EXACTLY the six surviving analysis keys', () => {
    // The premise of every assertion below. Written as an equality, not a subset: an
    // extra key here would mean the "minimal" fixture is quietly relying on something the
    // design removed, and the positive case would stop proving minimality.
    const parsed = parseYaml(MINIMAL_MANIFEST) as {
      contributes: { analyses: Array<Record<string, unknown>> }
    }
    expect(Object.keys(parsed.contributes.analyses[0]).sort()).toEqual([...MINIMAL_KEYS].sort())
  })

  it('LOADS: the minimal manifest registers its analysis and the ONE pane its `ui:` names', () => {
    const registry = realRegistry()
    const res = loadProcessors([packageFrom(MINIMAL_MANIFEST)], registry)

    expect(res.errors).toEqual([])
    expect(res.analysisIds).toEqual([ANALYSIS_ID])

    const analysis = registry.analyses.get(ANALYSIS_ID)
    expect(analysis).toBeDefined()
    expect(analysis?.extensionId).toBe(PKG_ID)
    expect(analysis?.apiVersion).toBe(WORKBENCH_API_VERSION)

    // ONE pane, keyed on the ANALYSIS (INV-3's unit), holding the file the manifest named.
    expect(res.viewContributionIds).toEqual([ANALYSIS_ID])
    const pane = registry.views.get(ANALYSIS_ID)
    expect(pane).toBeDefined()
    const render = (pane?.render as { spec: unknown }).spec
    expect(isDeclarativeRenderSpec(render)).toBe(true)
  })

  it('ENABLES: availability is derived from `appliesTo`, and genuinely discriminates', () => {
    const registry = realRegistry()
    loadProcessors([packageFrom(MINIMAL_MANIFEST)], registry)
    const analysis = registry.analyses.get(ANALYSIS_ID) as AnalysisContribution

    // `projection` isA `matrix` ⇒ enabled. `grouping` does not ⇒ not enabled. An empty
    // project ⇒ not enabled. Without all three, "enabled" could be a constant.
    expect(Registry.availability(analysis, ['projection'], fakeLattice)).toBe(true)
    expect(Registry.availability(analysis, ['grouping'], fakeLattice)).toBe(false)
    expect(Registry.availability(analysis, [], fakeLattice)).toBe(false)
  })

  it('EXECUTES: the run spec + schedule class reach the registry verbatim', () => {
    const registry = realRegistry()
    loadProcessors([packageFrom(MINIMAL_MANIFEST)], registry)
    const analysis = registry.analyses.get(ANALYSIS_ID) as AnalysisContribution

    expect(analysis.run).toEqual({ kind: 'sandbox', runtime: 'python', entry: 'compute/probe.py' })
    expect(analysis.schedule).toEqual({ class: 'batch' })
    expect(analysis.produces).toEqual(['probe/summary'])
    expect(analysis.appliesTo).toEqual([{ slot: 'frame', subtypes_of: 'matrix' }])
  })

  it('carries NOTHING presentational into the registry projection', () => {
    // INV-1's negative half, stated over the projection rather than the source: the
    // registered contribution has no form schema, no defaults bag and no column forecast
    // to consult, so nothing downstream can start honouring one.
    const registry = realRegistry()
    loadProcessors([packageFrom(MINIMAL_MANIFEST)], registry)
    const analysis = registry.analyses.get(ANALYSIS_ID) as unknown as Record<string, unknown>

    for (const key of ['params', 'defaults', 'produces_annotations', 'accepts', 'when']) {
      expect(analysis[key], `the registry projection still carries \`${key}\``).toBeUndefined()
    }
  })

  it('a manifest with NO `ui:` still registers a runnable analysis (the fallback-form state)', () => {
    // "No `ui:` means no view, and the generic fallback form is then an explicit declared
    // state" — so the absence must LOAD, not fail.
    const registry = realRegistry()
    const noUi = MINIMAL_MANIFEST.split('\n')
      .filter(line => !line.trim().startsWith('ui: ['))
      .join('\n')
    const res = loadProcessors([packageFrom(noUi)], registry)

    expect(res.errors).toEqual([])
    expect(registry.analyses.get(ANALYSIS_ID)).toBeDefined()
    expect(registry.analyses.get(ANALYSIS_ID)?.ui).toBeUndefined()
    expect(res.viewContributionIds).toEqual([])
  })
})

describe('INV-1 (TEST-1): a removed key is REFUSED at load, naming the key', () => {
  it.each(REMOVED_KEYS)(
    'refuses a manifest still declaring `%s`, and registers nothing for it',
    (key, fragment) => {
      const registry = realRegistry()
      const res = loadProcessors([packageFrom(manifestWith(fragment))], registry)

      // LOUD: the error must name the offending key AND the package, or the author
      // cannot find the file to edit.
      expect(res.errors.length).toBeGreaterThan(0)
      const named = res.errors.filter(e => e.message.includes(key) && e.package === PKG_ID)
      expect(
        named.length,
        `no load error named \`${key}\` + package "${PKG_ID}"; got ${JSON.stringify(res.errors)}`,
      ).toBeGreaterThan(0)
      expect(named[0].message).toMatch(/removed key/i)

      // …and REFUSED, not accepted-and-ignored: the analysis is absent from the registry.
      expect(res.analysisIds).toEqual([])
      expect(registry.analyses.get(ANALYSIS_ID)).toBeUndefined()
    },
  )

  it('the positive control: the same fixture with none of them loads clean', () => {
    // Without this, every case above would still pass against a loader that refused
    // EVERY manifest.
    const registry = realRegistry()
    const res = loadProcessors([packageFrom(MINIMAL_MANIFEST)], registry)
    expect(res.errors).toEqual([])
    expect(registry.analyses.get(ANALYSIS_ID)).toBeDefined()
  })

  it('a sibling analysis in the same package is unaffected (blast radius is one analysis)', () => {
    // Fail-isolation is part of the contract: one bad analysis must not take the package
    // down, or a single stale key would blank an entire processor.
    const twoAnalyses = `${manifestWith(REMOVED_KEYS[0][1]).trimEnd()}
    - id: ${ANALYSIS_ID}.sibling
      appliesTo:
        - { slot: frame, subtypes_of: matrix }
      produces: [probe/summary]
      run: { kind: sandbox, runtime: python, entry: compute/probe.py }
      schedule: { class: batch }
`
    const registry = realRegistry()
    const res = loadProcessors([packageFrom(twoAnalyses)], registry)

    expect(res.analysisIds).toEqual([`${ANALYSIS_ID}.sibling`])
    expect(registry.analyses.get(`${ANALYSIS_ID}.sibling`)).toBeDefined()
    expect(registry.analyses.get(ANALYSIS_ID)).toBeUndefined()
  })
})
