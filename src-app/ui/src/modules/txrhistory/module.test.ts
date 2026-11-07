/**
 * TEST-HIST-1 — txrhistory module shape + the PROV-HIST-1/2 surface
 * (INV-5, INV-6, INV-7; ITEM-1).
 *
 * The module is a framework module: auto-discovered by the loader glob in
 * `modules/loader.ts` (`import.meta.glob` over module.tsx files in the
 * modules tree), registering exactly the one `/history` route under the
 * shell layout, with NO eager store (the history store registers
 * whole-store-lazy in its own file, the `datasets`/`txrresults` precedent
 * — `stores: []`), NO slot (K owns no dialog host: the log dialog is the
 * page's own component and K emits no event — PROV-HIST-8), NO component
 * and NO permission predicate (all routes are `requiresAuth` under the
 * local single-user session).
 *
 * The no-edits assertions below run over the item's own delta (working tree
 * against HEAD while uncommitted; the tip commit's file set when committed
 * — the same dual-state convention the sibling module tests use). The
 * plan's no-go list: no generated client, no OpenAPI, no guard/script, no
 * package.json line, no loader edit, no server path, and no edit inside an
 * existing module directory except the sanctioned pins:
 * `txrshell/module.tsx` (the `/history` route handoff, pinned separately
 * below) and the three sibling module-test files whose shell-route / sweep
 * pins the handoff invalidates and which this item maintains
 * (`txrintake`, `txrmodels`, `txrrun` module tests).
 *
 * The status-word / design-example-number / URL / study-token covers the
 * module's own publish surface (non-test source + comments — the same
 * scope the sibling scans use). Scanned tokens are built from split
 * literals so this test file itself stays clear of them.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppModule } from '@ziee/framework/module-system/types'
import txrHistoryModule from './module'
import { TxrLayoutDef } from '../txrshell/module'
import txrShellModule from '../txrshell/module'
import { historyPath, FILTER_OPTIONS, PAGE_SIZE } from './index'

type RouteEntry = {
  path?: string
  requiresAuth?: boolean
  layout?: unknown
  permission?: unknown
}

function routesOf(module: unknown): RouteEntry[] {
  return (module as AppModule & { routes?: RouteEntry[] }).routes ?? []
}

const MODULE_DIR = fileURLToPath(new URL('.', import.meta.url))
const SHELL = 'src-app/ui/src/modules/txrshell/module.tsx'

/**
 * The file set DELIVERED BY THIS ITEM, in either of the two states it is
 * verified in. Uncommitted (the item's own verification run): the working
 * tree against HEAD. Committed (the branch gate): the tip commit's diff.
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

/**
 * The shell file's change, as added/removed lines. The working tree first
 * (a LATER shell edit surfaces here and the pin sees it); when the working
 * tree has no shell change, the committed walk-back: the NEAREST commit
 * whose shell diff is non-empty — the item that last touched the shell.
 * The look-up is the full branch history, deliberately with NO window: the
 * shell handoff is ITEM-1's, and each later item's report-impl commit pair
 * pushes it one further back (the ITEM-3/7 walk-back-window fixes in the
 * `ui-models` ledger). The byte-shape assertions below are the pin; the
 * search breadth is a device detail, never a weakening.
 */
function shellPatch(): { added: string[]; removed: string[] } {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const git = (args: string[]): string[] => {
    try {
      return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
        .split('\n')
        .filter(Boolean)
    } catch {
      return []
    }
  }
  const parse = (lines: string[]): { added: string[]; removed: string[] } => ({
    added: lines.filter(l => l.startsWith('+') && !l.startsWith('+++')).map(l => l.slice(1)),
    removed: lines.filter(l => l.startsWith('-') && !l.startsWith('---')).map(l => l.slice(1)),
  })
  if (git(['status', '--porcelain']).length > 0) {
    const working = parse(git(['diff', 'HEAD', '--', SHELL]))
    if (working.added.length > 0 || working.removed.length > 0) return working
    // The working tree is clean for the shell (a stale pin state): fall
    // through to the committed walk-back, like the clean-tree branch.
  }
  const nearest = git(['log', '--format=%H', '-1', '--', SHELL])[0]
  if (nearest !== undefined) {
    const patch = parse(git(['diff', `${nearest}^`, nearest, '--', SHELL]))
    if (patch.added.length > 0 || patch.removed.length > 0) return patch
  }
  return { added: [], removed: [] }
}

describe('txrhistory module (TEST-HIST-1)', () => {
  it('registers as a framework module with the planned metadata', () => {
    expect(txrHistoryModule.metadata).toEqual({
      name: 'txrhistory',
      version: '1.0.0',
      description: 'TxResBench history — everything you ran on this computer (screen K).',
    })
  })

  it('owns exactly the one history route, guarded under the shell layout', () => {
    const routes = routesOf(txrHistoryModule)
    expect(routes.map(r => r.path)).toEqual(['/history'])
    for (const route of routes) {
      expect(route.requiresAuth).toBe(true)
      expect(route.layout).toBe(TxrLayoutDef)
      expect(route.permission).toBeUndefined()
    }
  })

  it('registers an empty eager store list (the history store is whole-store-lazy) and no component, slot or predicate (PROV-HIST-8)', () => {
    // `stores: []` per PROV-HIST-3: the history store registers with
    // `registerLazyStore` in its own file (the `DatasetDetail` precedent),
    // so the module declares no eager store. K owns NO slot (no dialog
    // host — the log dialog is the page's own component) and emits no
    // event; PROV-HIST-8 pins no registration at all beyond the route.
    expect(txrHistoryModule.registerStores?.()).toEqual([])
    expect(
      (txrHistoryModule as AppModule & { registerComponents?: unknown }).registerComponents,
    ).toBeUndefined()
    expect((txrHistoryModule as AppModule & { registerSlots?: unknown }).registerSlots).toBeUndefined()
    expect(
      (txrHistoryModule as unknown as Record<string, unknown>).shouldLoad,
    ).toBeUndefined()
    expect(txrHistoryModule.initialize).toBeUndefined()
    expect(txrHistoryModule.cleanup).toBeUndefined()
    const source = readFileSync(fileURLToPath(new URL('./module.tsx', import.meta.url)), 'utf8')
    expect(source).not.toContain("import('./stores/")
    expect(source).not.toContain("from './stores/")
  })

  it('declares the router, the shell, the results, the run and the intake modules as framework dependencies', () => {
    expect(txrHistoryModule.registerDependencies?.()).toEqual([
      'router',
      'txrshell',
      'txrresults',
      'txrrun',
      'txrintake',
    ])
  })

  it('is picked up by the loader auto-discovery glob', () => {
    const files = import.meta.glob('./**/module.tsx', { eager: true }) as Record<
      string,
      { default: unknown }
    >
    expect(Object.keys(files)).toContain('./module.tsx')
    expect(files['./module.tsx'].default).toBe(txrHistoryModule)
  })

  it('routes the one lazy page the module declares', () => {
    const source = readFileSync(fileURLToPath(new URL('./module.tsx', import.meta.url)), 'utf8')
    expect(source).toContain('lazyWithPreload')
    expect(source).toContain("import('./pages/HistoryPage')")
  })

  it('exposes the module façade through the barrel: the history path builder and the host-state vocabulary (PROV-HIST-1/2)', () => {
    expect(historyPath()).toBe('/history')
    expect(PAGE_SIZE).toBe(20)
    expect(FILTER_OPTIONS.map(o => o.label)).toEqual([
      'All runs',
      'Learned and predicted',
      'Predicted with a saved model',
      'Stopped or failed',
    ])
    const barrel = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8')
    expect(barrel).toContain("export * from './routes'")
    expect(barrel).toContain("export * from './types'")
    const types = readFileSync(fileURLToPath(new URL('./types.ts', import.meta.url)), 'utf8')
    expect(types).toContain("type TxrHistoryKindFilter")
    expect(types).toContain("type TxrHistoryStatusFilter")
    expect(types).toContain("type TxrHistoryFilter")
    expect(types).toContain("type TxrBucketLabel")
    expect(types).toContain("type TxrModeLabel")
    expect(types).toContain('interface TxrHistoryView')
    expect(types).toContain('interface TxrHistoryActions')
    expect(types).toContain('const PAGE_SIZE')
    expect(types).toContain('const FILTER_OPTIONS')
  })

  it('does not change the generated client, the openapi, the guards, the loader, the server or any other module (DEC-15)', () => {
    const touched = itemDelta()
    expect(touched.filter(p => p.startsWith('src-app/ui/src/api-client/'))).toEqual([])
    expect(touched.filter(p => p.startsWith('src-app/ui/openapi/'))).toEqual([])
    expect(touched.filter(p => p.startsWith('scripts/'))).toEqual([])
    expect(touched.filter(p => p.startsWith('src-app/ui/scripts/'))).toEqual([])
    expect(touched.filter(p => p === 'src-app/ui/package.json')).toEqual([])
    expect(touched.filter(p => p === 'src-app/ui/package-lock.json')).toEqual([])
    expect(touched.filter(p => p === 'src-app/ui/scripts/domain-baseline.json')).toEqual([])
    expect(touched.filter(p => p === 'src-app/ui/src/modules/loader.ts')).toEqual([])
    expect(touched.filter(p => p.startsWith('src-app/server/'))).toEqual([])
    expect(touched.filter(p => p.startsWith('src-app/desktop/'))).toEqual([])
    // FOUR sanctioned exceptions: the `/history` route handoff itself
    // (`txrshell/module.tsx`, pinned separately below) and the three
    // sibling module test files whose pins the handoff invalidates and
    // are maintained by this item (`txrintake` route set, `txrmodels`
    // route-set + byte pin, `txrrun` no-other-module sweep — the
    // ui-models handoff's class, see DRIFT-1 #8). Nothing else outside
    // this module moves.
    expect(
      touched.filter(
        p =>
          p.startsWith('src-app/ui/src/modules/') &&
          !p.startsWith('src-app/ui/src/modules/txrhistory/') &&
          p !== 'src-app/ui/src/modules/txrshell/module.tsx' &&
          p !== 'src-app/ui/src/modules/txrintake/module.test.ts' &&
          p !== 'src-app/ui/src/modules/txrmodels/module.test.ts' &&
          p !== 'src-app/ui/src/modules/txrrun/module.test.ts',
      ),
    ).toEqual([])
  })

  it('records the txrshell `/history` handoff: the route is gone, the handoff comment is there, nothing else in the shell moves', () => {
    // The current shell state (the handoff's result): `/help` only.
    expect(routesOf(txrShellModule).map(r => r.path)).toEqual(['/help'])
    const shellSource = readFileSync(
      fileURLToPath(new URL('../txrshell/module.tsx', import.meta.url)),
      'utf8',
    )
    expect(shellSource).toContain('`txrhistory` module')
    expect(shellSource).toContain('ShellPage') // still imported: `/help` uses it
    expect(shellSource).not.toContain("path: '/history'")

    // The patch itself: removed lines are the old comment block + the
    // `/history` route block only; added lines are the new comment block
    // only. Byte-pins "NO other change" (DEC-2).
    const { added, removed } = shellPatch()
    const commentLine = (l: string) => /^(\s*\/\*\*|\s*\*(?:\s.*)?|\s*\*\/)$/.test(l)
    const routeBlockLine = (l: string) =>
      [
        '    {',
        "      path: '/history',",
        '      element: <ShellPage title="History" />,',
        '      requiresAuth: true,',
        '      layout: TxrLayoutDef,',
        '    },',
      ].includes(l)
    expect(removed.length).toBeGreaterThan(0)
    expect(removed).toContain("      path: '/history',")
    for (const line of removed) {
      expect(commentLine(line) || routeBlockLine(line)).toBe(true)
    }
    for (const line of added) {
      // The new comment block words the handoff (asserted on the source
      // above); every added line is comment text.
      expect(commentLine(line)).toBe(true)
    }
  })

  it('carries no status words, no literal design-example numbers and no URL literal in its own copy (INV-5/6)', () => {
    // The scan's target is SHIPPED COPY — the module's own source and
    // comments; any spelling there fails. Test files are excluded, the
    // same scope the sibling token scans use: they PIN the boards' bytes
    // as EXPECTED values, which is precisely what an INV-5/6 scan must
    // allow outside shipped copy.
    const own = ownSourceFiles(MODULE_DIR)
      .filter(p => !/\.test\.(ts|tsx)$/.test(p))
      .map(p => readFileSync(p, 'utf8'))
      .join('\n')
      .toLowerCase()
    const statusWords = [
      'to' + 'do',
      't' + 'bd',
      'place' + 'holder',
      'coming so' + 'on',
      'in pro' + 'gress',
    ]
    for (const word of statusWords) {
      expect(own).not.toContain(word)
    }
    // The K board's example facts — never code or fixture constants
    // (INV-6): the four-run footer, the usage figure, the row counts and
    // the spelled-out durations are design examples.
    const designExampleBareCounts = [
      '4 ru' + 'ns',
      '312 m' + 'b',
      '38 pa' + 'tients',
      '151 pa' + 'tients',
      '22 pa' + 'tients',
      '64 pa' + 'tients',
      '2 me' + 'thods',
      '3 minutes 10 se' + 'conds',
    ]
    for (const phrase of designExampleBareCounts) {
      expect(own).not.toContain(phrase)
    }
    expect(own).not.toContain('http' + '://')
  })

  it('spells no forbidden literal in its own source files (INV-5)', () => {
    const own = ownSourceFiles(MODULE_DIR)
      .filter(p => !/\.test\.(ts|tsx)$/.test(p))
      .map(p => readFileSync(p, 'utf8'))
      .join('\n')
      .toLowerCase()
    const tokenRe = new RegExp('st' + 'ud(y|ies)', 'i')
    expect(tokenRe.test(own)).toBe(false)
  })
})
