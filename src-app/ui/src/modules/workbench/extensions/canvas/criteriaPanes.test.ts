// criteriaPanes.test.ts — what a criterion's before/after PANES actually carry, over every SHIPPED
// declaration that builds such a pair.
//
// It asserts on the resolved option rather than on the YAML text, because both facts under test are
// things the pane must END UP with: the header string a user reads, and the set the kind switcher
// is allowed to offer. A text-shaped assertion would pass on a declaration viz then drops — so
// every case here also runs the real `parseOption` against the real catalog, which is what
// validates a declared `switchTo` (a fifth case proves it by making that validation fire).
//
// The criteria list is user-built and unbounded, so nothing in a declaration may be hand-written
// per criterion: the titles must be DERIVED from each criterion's own column plus its side.
//
// NOTHING here spells a domain name. The packages, the slice key and the plot ids are all read OUT
// of what ships (the app never knows the vocabulary its packages use — the same rule the shipped
// code is held to), and the fixture columns are neutral inventions, because a declaration binds
// every column through `$c.column` and so cannot care what they are called.

import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  compatibleChartTypes,
  installBuiltinSchemas,
  localLayerName,
  parseOption,
  LAYER_ID_SEP,
  type DatasetCatalog,
  type DatasetResolver,
  type VizOption,
} from '@ziee/viz'
import type { ViewSpec } from '@/modules/workbench/core/manifest/viewSpec'
import { parseViewSpec } from '@/modules/workbench/core/spec/schema'
import { resolveDeclarativeCanvas } from './canvasFeed'
import { composeCanvas } from './canvasComposition'

// DRIFT-1.81, the SECOND site of the same class: `entry_list` is a REGISTERED widget kind
// (DEC-2), so a bare unit process that has not installed the visualize widgets refuses any
// shipped spec declaring one. This gate parses EVERY `packages/*/ui/*.yaml` and asserts each
// parses clean, so it needs the installer exactly as `processorViewSpecs.test.ts` does. The
// class is "every sweep that parses the shipped specs and requires `ok`", not one file.
import { installVisualizeWidgets } from '@/modules/workbench/extensions/visualize/installVisualizeWidgets'

installVisualizeWidgets()

/** Any view id — the fold namespaces by it, and which one it is has no bearing on the collision. */
const VIEW_ID = 'v'

const PACKAGES_DIR = fileURLToPath(new URL('../../../../../../packages/', import.meta.url))

type SeriesDecl = { id: string; coordId: string; for_each?: string; datasetId?: string; type: string }
type CanvasDecl = { datasets: Array<{ id: string }>; series: SeriesDecl[] }

/** Every shipped view spec whose canvas declares a REPEATED (`for_each`) before/after pair — a
 *  series over the base slice and one over its `.kept` view. Discovered rather than named, so a
 *  second package growing the same surface is covered the day it ships, and so this file carries
 *  no package name of its own. */
function shippedBeforeAfterSpecs(): ViewSpec[] {
  const out: ViewSpec[] = []
  for (const pkg of readdirSync(PACKAGES_DIR, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue
    let uiFiles: string[]
    try {
      uiFiles = readdirSync(`${PACKAGES_DIR}${pkg.name}/ui`).filter(f => f.endsWith('.yaml'))
    } catch {
      continue // a package that ships no view files
    }
    for (const file of uiFiles) {
      const parsed = parseViewSpec(parseYaml(readFileSync(`${PACKAGES_DIR}${pkg.name}/ui/${file}`, 'utf8')))
      expect(parsed.ok, `${pkg.name}/ui/${file} must parse: ${JSON.stringify(parsed.errors)}`).toBe(true)
      const canvas = parsed.value?.canvas as CanvasDecl | undefined
      if (!canvas?.series?.some(s => s.for_each && s.datasetId?.endsWith('.kept'))) continue
      out.push(parsed.value!)
    }
  }
  return out
}

const SPECS = shippedBeforeAfterSpecs()

/** A frame in the shape a real import lands: two continuous measurements plus one categorical
 *  annotation, so BOTH criterion families (range → violin, multiselect → bar) resolve. */
const frame = {
  depth: [10, 20, 30, 40],
  fraction: [1, 2, 3, 40],
  batch: ['ctrl', 'ctrl', 'treated', 'treated'],
}
const CONTROL_BY_COLUMN = { depth: 'range', fraction: 'range', batch: 'multiselect' }

/** Two criteria — one on a continuous column, one on a categorical one — as a user would build.
 *  `$i` 0 is the continuous family, `$i` 1 the categorical one. */
const CRITERIA = [
  { column: 'depth', control: '', min: '15', max: '', keep: [] },
  { column: 'batch', control: '', min: '', max: '', keep: ['ctrl'] },
]

/** The declaration's own default slice name — read from it, never spelled here. */
const sliceOf = (spec: ViewSpec) => (spec.canvas as CanvasDecl).datasets[0].id

function scopeFor(spec: ViewSpec, criteria: typeof CRITERIA, keptMask: boolean[]) {
  return {
    params: {},
    state: { criteria, groupBy: '', label: '' },
    derived: { controlByColumn: CONTROL_BY_COLUMN, keptMask },
    const: {},
    data: { [sliceOf(spec)]: frame },
    caps: [],
  }
}

/** Resolve a shipped declaration into the option the canvas would drive, and PARSE it with viz
 *  against the real catalogs — which is the step that validates a declared `switchTo`, so an
 *  assertion below reading a value off the option is reading a value viz has accepted. */
async function driveShipped(
  spec: ViewSpec,
  criteria: typeof CRITERIA = CRITERIA,
  keptMask: boolean[] = [false, true, true, true],
  columns: Record<string, unknown[]> = frame,
): Promise<{
  option: VizOption
  catalogs: Record<string, DatasetCatalog>
  /** the feed's own resolver, so a caller can hand the contribution to the REAL host fold. */
  resolver: DatasetResolver
}> {
  installBuiltinSchemas()
  const data = { [sliceOf(spec)]: columns }
  const feed = resolveDeclarativeCanvas(spec, { data, scope: scopeFor(spec, criteria, keptMask) })
  expect(feed, 'a picked criterion resolves to a plottable canvas').not.toBeNull()
  const catalogs: Record<string, DatasetCatalog> = {}
  for (const d of feed!.option.datasets ?? []) {
    catalogs[d.id] = await (await feed!.resolver(d.id)).catalog()
  }
  parseOption(feed!.option, catalogs) // throws on an unregistered / data-incompatible switchTo
  return { option: feed!.option, catalogs, resolver: feed!.resolver }
}

/** The resolved series whose coordId names `side` and — when given — `family`, at index `$i`. */
function pane(option: VizOption, side: 'before' | 'after', index: number) {
  const found = option.series.filter(s => s.coordId.startsWith(`${side}-`) && s.coordId.endsWith(`-${index}`))
  expect(found, `exactly one ${side} pane at index ${index}`).toHaveLength(1)
  return found[0]
}

describe('every shipped before/after declaration', () => {
  it('ships at least one, or this whole file asserts nothing', () => {
    expect(SPECS.length).toBeGreaterThan(0)
  })

  for (const spec of SPECS) {
    describe(spec.id, () => {
      it('titles each pane from the criterion COLUMN + the side it shows', async () => {
        const { option } = await driveShipped(spec)
        expect(
          pane(option, 'before', 0).title,
          'an unlabelled pane cannot be told apart from its neighbour once there are several criteria',
        ).toBe('depth (before)')
        expect(pane(option, 'after', 0).title).toBe('depth (after)')
        // The SECOND criterion is a different column AND a different family — its titles must
        // follow its own column, which is what makes the derivation a derivation.
        expect(pane(option, 'before', 1).title).toBe('batch (before)')
        expect(pane(option, 'after', 1).title).toBe('batch (after)')
      })

      it('follows a DIFFERENT column, so nothing is hand-written per criterion', async () => {
        const { option } = await driveShipped(
          spec,
          [{ column: 'fraction', control: '', min: '', max: '', keep: [] }],
          [true, true, true, true],
        )
        expect(pane(option, 'before', 0).title).toBe('fraction (before)')
        expect(pane(option, 'after', 0).title).toBe('fraction (after)')
      })

      it('the auto-inferred kind set is the problem being solved (negative control)', async () => {
        const { catalogs, option } = await driveShipped(spec, [CRITERIA[0]], [true, true, true, true])
        const catalog = catalogs[option.datasets![0].id]
        // What the chrome offers when a pane declares NO allow-list — the auto-infer branch its
        // kind-option resolver falls back to in that case.
        const inferred = compatibleChartTypes(catalog, 'violin').map(d => d.type)
        expect(
          inferred,
          'a volcano reads a bulk differential-statistics table; this frame is per-row measurements',
        ).toContain('volcano')
        expect(inferred, 'a metric-only frame is offered the dense views too').toContain('scatter')
      })

      it('declares the allow-list on the CONTINUOUS family: the same column, read three ways', async () => {
        const { option } = await driveShipped(spec)
        for (const side of ['before', 'after'] as const) {
          const offered = pane(option, side, 0).switchTo
          expect(offered, `the ${side} pane declares an explicit kind-switch set`).toBeDefined()
          expect([...offered!].sort()).toEqual(['box', 'histogram', 'violin'])
        }
      })

      it('declares the allow-list on the CATEGORICAL family: a count per category has one reading', async () => {
        const { option } = await driveShipped(spec)
        for (const side of ['before', 'after'] as const) {
          expect(pane(option, side, 1).switchTo).toEqual(['bar'])
        }
      })

      it('excludes every kind that would render something the pane is not', async () => {
        const { option } = await driveShipped(spec)
        for (const index of [0, 1]) {
          for (const side of ['before', 'after'] as const) {
            const offered = pane(option, side, index).switchTo!
            for (const wrong of ['volcano', 'scatter', 'image', 'heatmap', 'dotplot', 'grid']) {
              expect(offered, `${side}-${index} must not offer "${wrong}"`).not.toContain(wrong)
            }
          }
        }
      })

      // ── WHERE the panes sit, not just what they say ──────────────────────────────────
      //
      // A before/after pair is a COMPARISON, so the two must be readable against each other. Laid
      // out in one row per the auto-derived grid, a pair is adjacent only while every criterion
      // happens to be of the same family: the declaration groups its templates by family, so one
      // continuous and one categorical criterion interleave into per-criterion pairs and the sides
      // stop lining up at all. Position is then an accident of which columns the user picked.
      //
      // So the placement is DECLARED: every "before" shares one row and every "after" the row
      // below it, at the SAME column — each pane directly above its counterpart, for any number of
      // criteria and any mix of families.
      it('puts every BEFORE on one row and its AFTER directly below, at the same column', async () => {
        const criteria = [
          { column: 'depth', control: '', min: '15', max: '', keep: [] },
          { column: 'batch', control: '', min: '', max: '', keep: ['ctrl'] },
          { column: 'fraction', control: '', min: '2', max: '', keep: [] },
        ]
        const { option } = await driveShipped(spec, criteria)
        const grid = option.grid ?? []
        expect(grid, 'the panes are placed, not left to fall into one row').not.toHaveLength(0)
        const at = (coordId: string) => {
          const entry = grid.find(g => g.id === coordId)
          expect(entry, `the grid places "${coordId}"`).toBeDefined()
          return { row: entry!.region?.row ?? 0, col: entry!.region?.col ?? 0 }
        }
        const indices = [0, 1, 2]
        const befores = indices.map(i => at(pane(option, 'before', i).coordId))
        const afters = indices.map(i => at(pane(option, 'after', i).coordId))
        expect(new Set(befores.map(p => p.row)).size, 'every BEFORE shares one row').toBe(1)
        expect(new Set(afters.map(p => p.row)).size, 'every AFTER shares one row').toBe(1)
        expect(afters[0].row, 'the AFTER row sits directly below the BEFORE row').toBe(befores[0].row + 1)
        for (const i of indices) {
          expect(afters[i].col, `criterion ${i} is one column, both sides`).toBe(befores[i].col)
        }
        expect(new Set(befores.map(p => p.col)).size, 'one column per criterion').toBe(3)
      })

      // The declared set is not decoration: viz VALIDATES it against the real catalog and refuses
      // an alternative the data cannot satisfy — LOUDLY, aborting the whole option. Without this,
      // every assertion above would pass on a `switchTo` viz silently ignored, AND the reasoning
      // behind the chosen set would be untestable: `bar` is excluded from the continuous family
      // precisely because a frame carrying only measurements cannot serve its category axis, and
      // this is that frame and that refusal.
      it('a declared alternative the frame cannot satisfy is REFUSED, not carried', async () => {
        const metricsOnly = { depth: frame.depth, fraction: frame.fraction }
        const { option, catalogs } = await driveShipped(
          spec,
          [CRITERIA[0]],
          [true, true, true, true],
          metricsOnly,
        )
        const target = pane(option, 'before', 0).coordId
        const sabotaged: VizOption = {
          ...option,
          series: option.series.map(s => (s.coordId === target ? { ...s, switchTo: ['bar'] } : s)),
        }
        expect(() => parseOption(sabotaged, catalogs)).toThrow(/switchTo/)
      })

      // ── THE PREFIX TRAP, ON IDS NOBODY INVENTED ──────────────────────────────────────────────
      //
      // The criteria list is user-built and unbounded, and each pane's id ends in its INDEX. So at
      // eleven criteria a declaration mints a pane whose id is a bare STRING PREFIX of another's
      // (`…-1` and `…-10`) — and the composing host then namespaces both, which does not separate
      // them either (`v::…-1` is still a prefix of `v::…-10`).
      //
      // That matters because viz decides "does this layer belong to this pane" by the id: a
      // `startsWith(paneId)` without the separator hands the eleventh criterion's layers — its
      // plot, its picks, its hovers — to the SECOND criterion's pane. Ten criteria is a fixture
      // that cannot see it; this is the smallest one that can.
      //
      // Driven end to end on purpose. Nothing here is a hand-written id: the criteria are a real
      // user's list, the pane ids come out of the SHIPPED declaration, the composed keys come out
      // of the real host fold, and the ownership rule is IMPORTED from viz, never restated —
      // restating it is what let this defect survive being fixed twice. (`localLayerName` is the
      // reachable face of that rule: it answers through the same predicate the layer filter and
      // the hover router use, and unlike them it is spelled in vocabulary this file may carry.)
      it('at eleven criteria the shipped ids collide as string prefixes, and viz still tells them apart', async () => {
        const ELEVEN = Array.from({ length: 11 }, () => CRITERIA[0])
        const { option, resolver } = await driveShipped(spec, ELEVEN, [false, true, true, true])

        // The ids the declaration really produced, in criterion order.
        const local = [...Array(11).keys()].map(i => pane(option, 'before', i).coordId)
        expect(new Set(local).size, 'eleven criteria are eleven distinct panes').toBe(11)

        // …and the composed keys the HOST folds them into — the strings viz is keyed by.
        const composed = composeCanvas(new Map([[VIEW_ID, { option, resolver, close: null }]]))
        const keys = local.map(id => {
          const found = [...composed.paneOwners].find(([, o]) => o.local === id)?.[0]
          expect(found, `the host placed a key for "${id}"`).toBeDefined()
          return found as string
        })

        // THE COLLISION IS REAL — asserted, not assumed. If a future id scheme separated the
        // index (a trailing `::`, say), this fails and the guard below becomes theory: that is
        // the news, and it should be read rather than silently made redundant.
        const second = keys[1]
        const eleventh = keys[10]
        expect(
          eleventh.startsWith(second),
          `the eleventh pane key must be a bare string prefix of the second for this to be the ` +
            `case under test — got "${second}" and "${eleventh}"`,
        ).toBe(true)

        // …AND VIZ IS NOT FOOLED BY IT. A layer published by a pane resolves back to the name its
        // own code composed ONLY for that pane; asked on behalf of any other, the id comes back
        // untouched, which is viz's spelling of "not mine". Asserted for every ORDERED PAIR, so
        // the eleventh-vs-second direction cannot be the one case nobody looked at.
        const layerOf = (key: string) => `${key}${LAYER_ID_SEP}l`
        expect(localLayerName(layerOf(eleventh), eleventh)).toBe('l')
        expect(localLayerName(layerOf(eleventh), second)).toBe(layerOf(eleventh))
        for (const owner of keys) {
          const claimants = keys.filter(k => localLayerName(layerOf(owner), k) !== layerOf(owner))
          expect(claimants, `"${owner}" owns its own layer and no other pane claims it`).toEqual([owner])
        }
      })
    })
  }
})
