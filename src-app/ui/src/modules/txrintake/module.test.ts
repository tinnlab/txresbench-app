/**
 * TEST-INT-1 — txrintake module shape + the txrshell `/` handoff
 * (PROV-UI-INTAKE-1; INV-5, INV-6; ITEM-1), plus the ITEM-2 part of the
 * same row per the TESTS coverage map (ITEM-2 types + barrel, PROV-UI-INTAKE-2).
 *
 * The module is a framework module: auto-discovered by the loader glob in
 * `modules/loader.ts` (import.meta.glob over module.tsx files in the modules
 * tree), registering exactly the four intake routes under the shell layout,
 * with NO store, NO slot, NO component and NO permission predicate. The
 * txrshell `/` scaffold route is removed on the same branch — one route moves
 * to the module that owns the analysis flow; `/models`, `/history` and `/help`
 * stay. (The `/models` and `/history` takovers are the later handoffs —
 * `txrmodels` and `txrhistory`; this file's shell pin below tracks the full
 * set.) The no-new-dependency + no-status-words + no-design-example-number
 * checks below run over the item's own delta, as TEST-INT-1 pins them.
 * ITEM-2's additions pin the barrel entry and the state-contract surface
 * (the types are compile-time; the snapshot below is the representative
 * instance the store will own).
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppModule } from '@ziee/framework/module-system/types'
import txrIntakeModule, { ROUTE_CONVENTIONS } from './module'
import txrShellModule, { TxrLayoutDef } from '../txrshell/module'
import type {
  IntakeSnapshot,
  JoinOffer,
  LoadedFile,
} from './index'

type RouteEntry = { path?: string; requiresAuth?: boolean; layout?: unknown }

function routesOf(module: unknown): RouteEntry[] {
  return (module as AppModule & { routes?: RouteEntry[] }).routes ?? []
}

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url))

/**
 * The file set DELIVERED BY THIS ITEM, in either of the two states it is
 * verified in. Uncommitted (the item's own verification run): the working
 * tree against HEAD. Committed (the branch gate): the tip commit's own diff
 * — the item commit or its report record commit, both of which are this
 * item's file set.
 */
function itemDelta(): string[] {
  const git = (args: string[]): string[] => {
    try {
      return execFileSync('git', args, { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
    } catch {
      return []
    }
  }
  if (git(['status', '--porcelain']).length > 0) {
    return [
      ...new Set([
        ...git(['diff', '--name-only', 'HEAD']),
        ...git(['diff', '--name-only', '--cached']),
        ...git(['ls-files', '--others', '--exclude-standard']),
      ]),
    ].sort()
  }
  return git(['show', '--name-only', '--format=', 'HEAD']).sort()
}

/** Every `.ts`/`.tsx` file under the module dir (the publish surface of the module). */
function ownSourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...ownSourceFiles(p))
    } else if (/\.tsx?$/.test(entry.name)) {
      out.push(p)
    }
  }
  return out
}

describe('txrintake module', () => {
  it('registers as a framework module with the planned metadata', () => {
    expect(txrIntakeModule.metadata).toEqual({
      name: 'txrintake',
      version: '1.0.0',
      description:
        'TxResBench intake — Start (A), Your study (B), Your files (C), Add the patients to predict (N).',
    })
  })

  it('owns exactly the four intake routes, each guarded under the shell layout', () => {
    const routes = routesOf(txrIntakeModule)
    expect(routes.map(r => r.path)).toEqual(['/', '/study', '/files', '/predict-files'])
    for (const route of routes) {
      expect(route.requiresAuth).toBe(true)
      expect(route.layout).toBe(TxrLayoutDef)
    }
  })

  it('registers no store, no slot, no component and no permission predicate', () => {
    expect((txrIntakeModule as AppModule & { registerStores?: unknown }).registerStores).toBeUndefined()
    expect(
      (txrIntakeModule as AppModule & { registerComponents?: unknown }).registerComponents,
    ).toBeUndefined()
    expect((txrIntakeModule as AppModule & { registerSlots?: unknown }).registerSlots).toBeUndefined()
    expect(
      (txrIntakeModule as unknown as Record<string, unknown>).shouldLoad,
    ).toBeUndefined()
    expect(txrIntakeModule.initialize).toBeUndefined()
    expect(txrIntakeModule.cleanup).toBeUndefined()
  })

  it('declares only the router as a framework dependency', () => {
    expect(txrIntakeModule.registerDependencies?.()).toEqual(['router'])
  })

  it('is picked up by the loader auto-discovery glob', () => {
    const files = import.meta.glob('./**/module.tsx', { eager: true }) as Record<
      string,
      { default: unknown }
    >
    expect(Object.keys(files)).toContain('./module.tsx')
    expect(files['./module.tsx'].default).toBe(txrIntakeModule)
  })

  it('declares the E/D/I route conventions for the sibling choice screens', () => {
    expect(ROUTE_CONVENTIONS).toEqual({
      methods: '/choose-methods',
      pretrainedModels: '/pretrained-models',
      savedModels: '/saved-models',
    })
    const source = readFileSync(fileURLToPath(new URL('./module.tsx', import.meta.url)), 'utf8')
    expect(source).toContain('/choose-methods')
    expect(source).toContain('/pretrained-models')
    expect(source).toContain('/saved-models')
  })

  it('records the txrshell route handoffs: the `/`, `/models` and `/history` scaffold routes are gone, the shell keeps `/help`', () => {
    // The `/models` route was handed to `txrmodels` (screen J) after this
    // test was written, and the `/history` route to `txrhistory` (screen
    // K) — the sanctioned handoffs of this epic's route takeovers (each
    // module edits the same shell file, its own block).
    expect(routesOf(txrShellModule).map(r => r.path)).toEqual(['/help'])
    const shellSource = readFileSync(
      fileURLToPath(new URL('../txrshell/module.tsx', import.meta.url)),
      'utf8',
    )
    expect(shellSource).toContain('handed to the `txrintake` module')
    expect(shellSource).not.toContain("path: '/'")
    // The `/models` handoff's words (the shell comment names the incoming
    // module); the phrase spans the comment's line breaks.
    expect(shellSource).toContain('`txrmodels` module')
    expect(shellSource).not.toContain("path: '/models'")
    // The `/history` handoff's words (this epic's newest takeover).
    expect(shellSource).toContain('`txrhistory` module')
    expect(shellSource).not.toContain("path: '/history'")
  })

  it('does not change the dependency set, the ui scripts tree or the domain ledger (INV-5/6)', () => {
    const touched = itemDelta()
    expect(touched.filter(p => p === 'src-app/ui/package.json')).toEqual([])
    expect(touched.filter(p => p.startsWith('src-app/ui/scripts/'))).toEqual([])
    expect(touched.filter(p => p === 'src-app/ui/scripts/domain-baseline.json')).toEqual([])
  })

  it('carries no status words and no literal design-example numbers in its own files (INV-5)', () => {
    // The status-word scan targets SHIPPED COPY that promises or announces
    // work not yet done. The kit `Select`'s input-hint prop (spelled exactly
    // like one of those status words) is an INPUT AFFORDANCE, not a copy
    // mark — its API occurrences (`hint="Choose a disease…"`) are stripped
    // before the word scan; any other spelling in comments, copy or
    // fixtures still fails. DRIFT-1 ITEM-5 — the scan's own precision, never
    // a baseline. (The prop name and the regex below are built from split
    // literals so this test file itself stays clear of the scanned words.)
    const kitHintProp = new RegExp('place' + 'holder' + '\\s*=\\s*"[^"]*"', 'g')
    const own = ownSourceFiles(MODULE_DIR)
      .map(p => readFileSync(p, 'utf8'))
      .join('\n')
      .replace(kitHintProp, '')
      .toLowerCase()
    const statusWords = ['to' + 'do', 't' + 'bd', 'place' + 'holder', 'coming so' + 'on', 'in pro' + 'gress']
    for (const word of statusWords) {
      expect(own).not.toContain(word)
    }
    const designExampleBareCounts = [
      '9 mo' + 'dels',
      '38 me' + 'thods',
      '26 o' + 'f 38',
      '12 mo' + 'dels',
    ]
    for (const phrase of designExampleBareCounts) {
      expect(own).not.toContain(phrase)
    }
  })
})

describe('ITEM-2 — the state-contract barrel (PROV-UI-INTAKE-2)', () => {
  it('re-exports the intake state types from the module barrel', () => {
    const barrel = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')
    expect(barrel).toContain("export * from './types'")
  })

  it('declares the representative snapshot the store will own', () => {
    const measurements: LoadedFile = {
      source: { name: 'measurements.csv', format: 'csv' },
      table: {
        source: { name: 'measurements.csv', format: 'csv' },
        header_row: 1,
        columns: ['patient_id', 'day', 'marker', 'value', 'unit'],
        rows: [
          ['P0001', '0', 'ldh', '210', 'U/L'],
          ['P0001', '14', 'LDH', '260', 'U/L'],
        ],
      },
      inspection: null,
      problems: [],
      prepared: false,
      joinOffers: [],
      vocabOffers: [],
    }
    const joins: JoinOffer[] = [{ variants: ['ldh', 'LDH'], key: 'LDH' }]
    const mapping = [{ key: 'LDH', marker_id: 'ldh' }]
    const snapshot: IntakeSnapshot = {
      intent: 'train',
      mode: 'study',
      study: {
        disease: 'colorectal',
        treatment: null,
        outcome: 'progression-by-day',
        markerGroups: { ctdna: true, counts: true, ldh: true },
        beforeTreatment: 'always',
        drawsDuringTreatment: 2,
        lastDrawDay: 56,
      },
      patients: null,
      measurements,
      predictMeasurements: null,
      joins,
      mapping,
      parameters: { decision_day: 56, baseline_max_day: 0 },
      validation: null,
    }
    expect(snapshot.mode).toBe('study')
    expect(snapshot.parameters).toEqual({ decision_day: 56, baseline_max_day: 0 })
    expect(snapshot.measurements?.table.rows).toHaveLength(2)
    expect(snapshot.joins[0].variants).toEqual(['ldh', 'LDH'])
    expect(snapshot.validation).toBeNull()
  })
})
