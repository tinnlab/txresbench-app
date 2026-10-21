// visualize-pane ITEM-69 / INV-7 — the RUNTIME leg's missing guard: the view_specs the
// runtime-drop e2e AUTHORS must survive the real loader, at unit speed.
//
// ── the break this exists to catch, stated exactly ──────────────────────────────────
//
// `runtimeDropin.test.ts` (TEST-54) already proves the runtime leg registers *a* dropped
// package. Its fixture is a hand-written spec that lives in that same file, so it moves
// whenever the validator moves — which is precisely why it could not catch this:
//
//   · ITEM-28 taught `parseViewSpec` to REFUSE `""` as the default of a state field bound
//     to a CLOSED-SET control (`select` / `artifact_ref` / `entry_list`). Correct rule.
//   · Its commit migrated every declaration it could SEE — the two in-tree package yamls
//     and the gallery fixture specs — and green-lit on 2868 unit tests.
//   · The specs it could NOT see are the ones the e2e authors as TEXT and drops into a live
//     server's processor folder. One of them bound an `artifact_ref` to a field defaulting
//     to `""`. It stopped parsing; `registerDeclarativeViews` is fail-CLOSED at the
//     analysis, so the whole pane silently did not register.
//   · The only report was a 30s registry-poll timeout inside a `workers: 1` e2e that paces
//     ~1 test/min — the run in which the received array holds only the four BAKED views.
//
// The class is "a validator change invalidates a spec authored outside the app tree, and
// nothing fast can see it". The fix for the class is not to remember: it is to give those
// specs a consumer that runs in seconds. `_probeSpecs.ts` is the extraction that makes that
// possible; this file is the consumer.
//
// This drives the REAL production path — `loadRuntimeProcessors` → `loadProcessors` →
// `registerProcessorPackage` → `parseViewSpec` → `registry.views` — with only the HTTP
// fetch substituted, which is the seam `loadRuntimeProcessors` was built with ("the fetch
// is passed in so it is unit-testable without a live backend"). Asserting the REGISTRY, not
// the parse, is deliberate: the parse is what broke, but "the view reaches the registry" is
// what the e2e asserts and therefore what must not be able to break quietly again.
//
// vitest, not `node:test`: the parser transitively imports `@ziee/viz`, whose sources are
// `.tsx`, which the plain-node strip-types runner cannot load (same reason as
// `runtimeDropin.test.ts`).
import { describe, test, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'

import type { Contributions } from '@/modules/workbench/core/contributions/workbenchRegistry'
import { Registry } from '@/modules/workbench/core/contributions/registry'
import { parseViewSpec } from '@/modules/workbench/core/spec/schema'
import { loadRuntimeProcessors } from './loadProcessors'
import {
  droppedViewCorpus,
  manifestText,
  pickerViewText,
} from '../../../../../tests/e2e/14-declarative-qc/_probeSpecs'

/** A fresh, isolated `Contributions` — NOT the process-wide singleton, so this suite cannot
 *  see (or pollute) what the app registered at import time. */
const freshRegistry = (): Contributions => ({
  analyses: new Registry('analyses'),
  views: new Registry('views'),
  statusBarItems: new Registry('statusBarItems'),
  sections: new Registry('sections'),
})

describe('the view_specs the runtime-drop e2e authors parse through the REAL validator', () => {
  const corpus = droppedViewCorpus()

  test('the corpus is not empty (a vacuous guard would pass forever)', () => {
    expect(corpus.length).toBeGreaterThanOrEqual(4)
  })

  // POSITIVE COVERAGE CLAUSE. Without this, the whole suite could be satisfied by a corpus
  // of trivial specs — and the rule that actually broke bites only on a closed-set control.
  // So the corpus must be asserted to CONTAIN the shape, not merely to parse.
  test('the corpus exercises a CLOSED-SET control (the shape the break needed)', () => {
    const closedSet = corpus.filter(c => /kind:\s*(artifact_ref|select|entry_list)\b/.test(c.yaml))
    expect(
      closedSet.length,
      'no corpus entry binds a closed-set control — this guard would not have caught ITEM-28',
    ).toBeGreaterThanOrEqual(1)
  })

  for (const { name, yaml } of corpus) {
    test(`parses: ${name}`, () => {
      const res = parseViewSpec(parseYaml(yaml))
      expect(
        res.ok,
        `a spec the e2e DROPS no longer parses — it will register nothing and the e2e will ` +
          `report only a registry-poll timeout:\n${JSON.stringify((res as { errors?: unknown }).errors, null, 2)}`,
      ).toBe(true)
    })
  }
})

describe('a dropped package built from those specs reaches the registry (the e2e assertion, at unit speed)', () => {
  /** The INV-2 package as the e2e drops it: one analysis, one `ui:` file, the picker form.
   *  Decoded the way `fetchRuntimeProcessorPackages` decodes a served package — yaml text
   *  in, `{manifest, views}` out, keyed by the package-relative path an analysis' `ui:`
   *  names. */
  const PKG = 'e2e-probe-source'
  const ANALYSIS = `${PKG}.run`
  const VIEW_PATH = 'ui/form.yaml'

  const droppedPackage = () => ({
    manifest: parseYaml(
      manifestText(PKG, {
        id: ANALYSIS,
        title: 'Probe source form',
        slot: 'source',
        datatype: 'metadata/column',
        ui: [VIEW_PATH],
      }),
    ),
    views: {
      [VIEW_PATH]: parseYaml(
        pickerViewText({
          specId: 'probe/form',
          title: 'Probe form',
          label: 'Chosen probe input',
          sourceDatatype: 'metadata/column',
        }),
      ),
    },
  })

  test('the analysis AND its view register, with no errors', async () => {
    const registry = freshRegistry()
    expect(registry.views.get(ANALYSIS), 'precondition: a fresh registry knows nothing').toBeUndefined()

    const result = await loadRuntimeProcessors(
      registry,
      // Stand-in baked ids. The delta rule only needs a set the dropped id is NOT in, so
      // naming the shipped packages here would couple this guard to which ones ship.
      new Set(['baked-one', 'baked-two']),
      async () => [droppedPackage() as never],
    )

    // The errors go FIRST: when this breaks, the error list is the diagnosis the e2e could
    // not give (it only ever saw an empty registry and a timeout).
    expect(result.errors, 'the dropped package must load without errors').toEqual([])
    expect(result.analysisIds).toEqual([ANALYSIS])
    expect(result.viewContributionIds).toEqual([ANALYSIS])

    // …and the thing the e2e polls for: the view is IN the registry the app renders from.
    // `manifest-ui-separation.spec.ts` reads exactly this through `window.__workbenchRegistry`.
    const view = registry.views.get(ANALYSIS)
    expect(view, `the runtime-dropped view "${ANALYSIS}" must reach the registry`).toBeTruthy()
    expect(view!.extensionId, 'the contribution is attributed to the dropped package').toBe(PKG)
  })

  // NEGATIVE CONTROL. A guard that only ever sees a passing corpus cannot distinguish "the
  // loader works" from "the loader registers anything". This re-introduces the exact defect
  // — `""` as the default of the closed-set-bound field — and requires it to be REFUSED,
  // and to be refused LOUDLY (a named error), not silently dropped.
  test('the pre-fix shape is still refused, and names the field (the guard has teeth)', async () => {
    const registry = freshRegistry()
    const broken = droppedPackage()
    ;(broken.views[VIEW_PATH] as { state: { pick: { default: unknown } } }).state.pick.default = ''

    const result = await loadRuntimeProcessors(registry, new Set(), async () => [broken as never])

    expect(registry.views.get(ANALYSIS), 'a spec that fails to parse must register nothing').toBeUndefined()
    const named = result.errors.some(e => e.message.includes('"pick"'))
    expect(
      named,
      `the refusal must NAME the field, or an author sees only an empty pane: ${JSON.stringify(result.errors)}`,
    ).toBe(true)
  })
})
