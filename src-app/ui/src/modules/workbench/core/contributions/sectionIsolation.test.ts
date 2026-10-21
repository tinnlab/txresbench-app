// TEST-A12 [acceptance, INV-12] (visualize-pane ITEM-2 / ITEM-6) — **A SECTION IS NOT A VIEW.**
//
// The design's words, quoted rather than paraphrased (§1, §4.7, §4.8):
//
//   *"A section is not a view. It registers into a new `registry.sections` slot, never
//    `registry.views`, so it never reaches `placeViews`, `reconcileViews`,
//    `viewAutomountGate` or `assertContributableArea`. The centre reservation is unreachable
//    from this path by construction."* … *"No extension may open a pane — not now, and not as
//    a second kind."*
//
// ── why this file exists beside `runtime/register.test.ts` ────────────────────────────────
//
// `register.test.ts` already asserts the REGISTRY SPLIT at the one call site: a section lands
// in `sections`, `views` stays empty, and the contribution carries no `area`. That is the
// behaviour of one function, and it is necessary. What it cannot see is the clause the
// invariant is actually written about — *"by construction"*. A future edit that imported
// `placeViews` into the section path and called it under some condition would leave every one
// of those assertions green, because none of them looks at what the path can REACH.
//
// So this file asserts the STRUCTURE: the module graph that carries a manifest's
// `contributes.sections[]` entry into `registry.sections` does not, transitively, contain the
// docking pipeline at all. There is nothing to call.
//
// ── why an import-graph walk, and the two ways it could lie ───────────────────────────────
//
// It could lie by being blind (a walk that resolves nothing reports everything clean), and it
// could lie by being trivial (a root with no imports is clean for free). Both are controlled
// below: a NEGATIVE CONTROL walks the DOCK path with the identical function and requires it to
// reach the very modules the section path must not, and the section walk asserts a floor on how
// many modules it actually resolved. A guard that cannot fail is not a guard — this repo has
// paid for that lesson in the activity-rail rounds.
//
// It walks VALUE imports only. `import type { Region } from '.../regionModel'` is erased by the
// compiler and cannot be called; counting it would make the test red for a fact that is not the
// invariant (`runtime/seam.ts` legitimately names the `Region` TYPE while riding none of it).

import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Contributions, SectionContribution, ViewContribution } from '@/modules/workbench/core'
import type { ProcessorSectionData } from '@/modules/workbench/core/manifest/processorPackage'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { registerDeclarativeSection } from '@/modules/workbench/core/runtime/register'
import { CONTRIBUTION_KINDS } from './workbenchRegistry'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** `src/` — every `@/…` specifier is rooted here. */
const SRC = path.resolve(HERE, '../../../..')
const CORE = path.join(SRC, 'modules/workbench/core')

/** The four the design NAMES. Each is asserted as a MODULE (a file the graph may not contain),
 *  not as a string in a source file: a text search is satisfied by renaming the import. */
const DOCKING_PIPELINE = [
  'shell/placement.ts', //            placeViews
  'shell/dock/paneReconcile.ts', //   reconcileViews
  'shell/dock/viewAutomountGate.ts', // viewAutomountGate
  'shell/regions/regionModel.ts', //  assertContributableArea
] as const

/**
 * The modules that carry a manifest's `contributes.sections[]` entry all the way into
 * `registry.sections`. This IS "the section path": the manifest reader, the seam that builds a
 * `SectionContribution`, the registration call, and the registry that holds the slot.
 *
 * `register.ts` is deliberately included even though it also holds the VIEW registration — it
 * is the module a section is registered BY, so anything it can reach, a section registration
 * can reach. Including it makes the assertion stronger, not weaker.
 */
const SECTION_PATH = [
  'runtime/loadProcessors.ts',
  'runtime/register.ts',
  'runtime/seam.ts',
  'contributions/workbenchRegistry.ts',
] as const

/** The DOCK path — the negative control. If the walk below cannot see the pipeline from here,
 *  it cannot see it anywhere, and the section result means nothing. */
const DOCK_PATH = ['shell/dock/WorkbenchDockHost.tsx', 'shell/dock/panes.tsx'] as const

function resolveSpecifier(spec: string, from: string): string | null {
  let base: string
  if (spec.startsWith('@/')) base = path.join(SRC, spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(from), spec)
  else return null // a bare package specifier — outside this repo's graph
  for (const c of [base, `${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
    if (existsSync(c) && statSync(c).isFile()) return c
  }
  return null
}

/** Value-import edges only: `import type …` / `export type …` are erased and uncallable. */
const VALUE_IMPORT = /^[ \t]*(?:import|export)[ \t]+(?!type[ \t])[\s\S]*?from[ \t]*['"]([^'"]+)['"]/gm

/** The transitive value-import closure of `roots`, and each module's discoverer (for the chain
 *  a failure prints — "it is reachable" is useless without "by what"). */
function closure(roots: readonly string[]): { seen: Set<string>; via: Map<string, string> } {
  const seen = new Set<string>()
  const via = new Map<string, string>()
  const queue: string[] = []
  for (const r of roots) {
    const f = path.join(CORE, r)
    expect(existsSync(f), `walk root does not exist: ${r} — the walk would pass vacuously`).toBe(true)
    seen.add(f)
    queue.push(f)
  }
  while (queue.length > 0) {
    const file = queue.shift() as string
    let src: string
    try {
      src = readFileSync(file, 'utf8')
    } catch {
      continue
    }
    VALUE_IMPORT.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = VALUE_IMPORT.exec(src)) !== null) {
      const target = resolveSpecifier(m[1], file)
      if (!target || seen.has(target) || /\.test\.tsx?$/.test(target)) continue
      seen.add(target)
      via.set(target, file)
      queue.push(target)
    }
  }
  return { seen, via }
}

function chainTo(file: string, via: Map<string, string>): string {
  const parts = [file]
  let cur = file
  while (via.has(cur)) {
    cur = via.get(cur) as string
    parts.push(cur)
  }
  return parts.map(p => path.relative(SRC, p)).join('\n     <- ')
}

describe('TEST-A12 — the centre reservation is unreachable from the section path (INV-12)', () => {
  it('NEGATIVE CONTROL: the same walk DOES find the pipeline from the dock path', () => {
    const { seen } = closure(DOCK_PATH)
    // Not "at least one": each of the two roots exists to reach a different half, and a walk
    // that found only `placement.ts` would still be half blind.
    const reached = DOCKING_PIPELINE.filter(f => seen.has(path.join(CORE, f)))
    expect(
      reached,
      'the walk found NONE of the docking pipeline from the dock path itself — it is blind, so its verdict on the section path is worthless',
    ).toEqual([...DOCKING_PIPELINE])
  })

  it('the section path contains NONE of placeViews / reconcileViews / viewAutomountGate / assertContributableArea', () => {
    const { seen, via } = closure(SECTION_PATH)
    // A floor on the walk's reach, so "clean" can never mean "resolved nothing". The section
    // path is ~110 modules today; 40 is a floor, not a target.
    expect(seen.size, 'the walk resolved almost nothing — it is not seeing the graph').toBeGreaterThan(40)
    const reached = DOCKING_PIPELINE.filter(f => seen.has(path.join(CORE, f)))
    const detail = reached.map(f => `\n  ${f}\n     ${chainTo(path.join(CORE, f), via)}`).join('')
    expect(reached, `INV-12: the section path reaches the docking pipeline:${detail}`).toEqual([])
  })

  it('`sections` is its OWN registry slot — not an alias of `views`', () => {
    // The slot has to exist AND be distinct: were `sections` a second name for `views`, every
    // assertion above would still hold and the invariant would be false.
    expect(CONTRIBUTION_KINDS).toContain('sections')
    expect(CONTRIBUTION_KINDS).toContain('views')
    expect(new Set(CONTRIBUTION_KINDS).size).toBe(CONTRIBUTION_KINDS.length)
  })

  it('a section declaring `area: center` still cannot be placed — there is no `area` to carry it', () => {
    const views: ViewContribution[] = []
    const sections: SectionContribution[] = []
    const registry = {
      views: { register: (c: ViewContribution) => views.push(c) },
      sections: { register: (c: SectionContribution) => sections.push(c) },
    } as unknown as Contributions

    const spec: ViewSpec = {
      id: 'iso/one',
      title: 'Isolated',
      permission: 'jobs::use',
      state: {},
      widgets: [{ id: 'tbl', kind: 'table' }],
      actions: [],
    }
    // The manifest entry SAYS `area: center` — the smuggling attempt, written out rather than
    // described. `ProcessorSectionData` has no such field, so this is the shape a hand-authored
    // manifest would have after someone added the key hoping it would be honoured.
    const data = {
      id: 'iso.section',
      title: 'Isolated',
      pane: 'visualize',
      order: 10,
      applies_to: [{ capabilities: ['plottable-xy'] }],
      ui: ['ui/iso.yaml'],
      area: 'center',
    } as unknown as ProcessorSectionData

    const res = registerDeclarativeSection(data, [{ path: 'ui/iso.yaml', raw: spec as unknown }], registry, {
      extensionId: 'iso.pkg',
    })
    expect(res.ok).toBe(true)
    expect(sections).toHaveLength(1)
    // Found by ITS OWN ID rather than by position: a registry is a declared collection and
    // promises nothing about order.
    const registered = sections.find(c => c.id === 'iso.section')
    expect(registered, 'the section did not reach `registry.sections` under its declared id').toBeTruthy()
    // The load-bearing halves: nothing reached the view slot, and the declared `center` did not
    // survive onto the contribution — so there is no value for a placer to read even if one
    // ever read this slot.
    expect(views).toHaveLength(0)
    expect((registered as unknown as Record<string, unknown>).area).toBeUndefined()
  })
})
