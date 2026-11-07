/**
 * TEST-MOD-01 — txrmodels module shape + the PROV-UI-MODELS-1 route/slot
 * surface (INV-5, INV-6, INV-7; ITEM-1). The TEST-MOD-02 rows for the path
 * builders live in `routes.test.ts` (their own file, per the TESTS map).
 *
 * The module is a framework module: auto-discovered by the loader glob in
 * `modules/loader.ts` (`import.meta.glob` over module.tsx files in the
 * modules tree), registering exactly the three model routes under the shell
 * layout, with NO eager store (the model store registers whole-store-lazy
 * in its own file, the `datasets`/`txrresults` precedent — `stores: []`),
 * NO component, NO permission predicate (the app defines no `X::use` for
 * these screens; all routes are `requiresAuth` under the local single-user
 * session) and exactly ONE slot registration: the routerEffects dialog
 * host (PROV-UI-MODELS-2).
 *
 * The no-edits assertions below run over the item's own delta (working tree
 * against HEAD while uncommitted; the tip commit's file set when committed —
 * the same dual-state convention the sibling module tests use). The plan's
 * no-go list: no generated client, no OpenAPI, no guard/script, no
 * package.json line, no loader edit, no server path, and NO other module
 * directory except the four sanctioned pins: `txrshell/module.tsx` (the
 * `/models` route handoff, pinned separately below),
 * `txrintake/module.test.ts`, `txrrun/module.test.ts` and
 * `txrresults/module.test.ts` (their shell-route / no-other-module pins
 * went stale with the handoff and are updated by this item — DRIFT-1 #8).
 *
 * The status-word / design-example-number / URL / scan covers the module's
 * own publish surface (non-test source, comments, README-listed fixtures —
 * same scope the sibling scans use); the route builders' scan additionally
 * covers the whole module directory (TEST-MOD-02). Scanned tokens are built
 * from split literals so this test file itself stays clear of them.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AppModule } from '@ziee/framework/module-system/types'
import txrModelsModule from './module'
import { TxrLayoutDef } from '../txrshell/module'
import txrShellModule from '../txrshell/module'
import { TxrModelsDialogHost } from './components/TxrModelsDialogHost'

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
 * tree against HEAD. Committed (the branch gate): the tip commit's diff —
 * the item commit or its report record commit, both of which are this
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

/**
 * The shell file's change, as added/removed lines. The working tree first
 * (a LATER shell edit surfaces here and the pin sees it); when the working
 * tree has no shell change, the committed walk-back: the NEAREST commit
 * whose shell diff is non-empty — the item that last touched the shell.
 * The look-up is the full branch history, deliberately with NO window: the
 * shell handoff is ITEM-1's, and each item's report-impl commit pair
 * pushes it one further back — the ITEM-1/2 "at most three" window went
 * stale at ITEM-3 (fixed by the 12-commit window), and that window went
 * stale at ITEM-7 again (the shell commit was HEAD~13, measured — the
 * ITEM-6 state had it at HEAD~11). The byte-shape assertions below are
 * the pin; the search breadth is a device detail, never a weakening.
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

describe('txrmodels module (TEST-MOD-01)', () => {
  it('registers as a framework module with the planned metadata', () => {
    expect(txrModelsModule.metadata).toEqual({
      name: 'txrmodels',
      version: '1.0.0',
      description:
        'TxResBench models — choose pretrained (D) and saved (I) models to run, the Your-models inventory (J), and the save dialogs (L/L2/L3)',
    })
  })

  it('owns exactly the three model routes, each guarded under the shell layout', () => {
    const routes = routesOf(txrModelsModule)
    expect(routes.map(r => r.path)).toEqual(['/pretrained-models', '/saved-models', '/models'])
    for (const route of routes) {
      expect(route.requiresAuth).toBe(true)
      expect(route.layout).toBe(TxrLayoutDef)
      expect(route.permission).toBeUndefined()
    }
  })

  it('registers an empty store list (the model store is whole-store-lazy) and no component or predicate', () => {
    // `stores: []` per PROV-UI-MODELS-3: the model store registers with
    // `registerLazyStore` in its own file (the `DatasetDetail` precedent),
    // so the module declares no eager store and no other registration.
    expect(txrModelsModule.registerStores?.()).toEqual([])
    expect(
      (txrModelsModule as AppModule & { registerComponents?: unknown }).registerComponents,
    ).toBeUndefined()
    expect((txrModelsModule as unknown as Record<string, unknown>).shouldLoad).toBeUndefined()
    expect(txrModelsModule.initialize).toBeUndefined()
    expect(txrModelsModule.cleanup).toBeUndefined()
    const source = readFileSync(fileURLToPath(new URL('./module.tsx', import.meta.url)), 'utf8')
    expect(source).not.toContain("import('./stores/")
    expect(source).not.toContain("from './stores/")
  })

  it('registers exactly the dialog-host slot (PROV-UI-MODELS-2)', () => {
    expect(txrModelsModule.registerSlots?.()).toEqual({
      routerEffects: [
        {
          id: 'txr-models-dialog-host',
          component: TxrModelsDialogHost,
        },
      ],
    })
    // The host renders nothing at this item: the mount point exists (the
    // slot demands a component), the subscription + dialogs are the item
    // that owns them. Rendering null is the framework's contract for an
    // effect host (the `command-palette` precedent).
    expect(TxrModelsDialogHost()).toBeNull()
  })

  it('declares the router, the shell, the intake, the shared list, the run and the results modules as framework dependencies', () => {
    expect(txrModelsModule.registerDependencies?.()).toEqual([
      'router',
      'txrshell',
      'txrintake',
      'txrlist',
      'txrrun',
      'txrresults',
    ])
  })

  it('is picked up by the loader auto-discovery glob', () => {
    const files = import.meta.glob('./**/module.tsx', { eager: true }) as Record<
      string,
      { default: unknown }
    >
    expect(Object.keys(files)).toContain('./module.tsx')
    expect(files['./module.tsx'].default).toBe(txrModelsModule)
  })

  it('routes the three lazy pages the module declares', () => {
    const source = readFileSync(fileURLToPath(new URL('./module.tsx', import.meta.url)), 'utf8')
    expect(source).toContain('lazyWithPreload')
    expect(source).toContain("import('./pages/PretrainedModelsPage')")
    expect(source).toContain("import('./pages/SavedModelsPage')")
    expect(source).toContain("import('./pages/ModelsPage')")
  })

  it('does not change the generated client, the openapi, the guards, the loader, the server or any other module (DEC-2/17/18)', () => {
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
    // FOUR sanctioned exceptions (DRIFT-1 #8): the `/models` route handoff
    // itself (`txrshell/module.tsx`, pinned separately below) and the three
    // sibling module test files whose pins went stale with the handoff and
    // are updated by this item. Nothing else outside this module moves.
    expect(
      touched.filter(
        p =>
          p.startsWith('src-app/ui/src/modules/') &&
          !p.startsWith('src-app/ui/src/modules/txrmodels/') &&
          p !== 'src-app/ui/src/modules/txrshell/module.tsx' &&
          p !== 'src-app/ui/src/modules/txrintake/module.test.ts' &&
          p !== 'src-app/ui/src/modules/txrrun/module.test.ts' &&
          p !== 'src-app/ui/src/modules/txrresults/module.test.ts',
      ),
    ).toEqual([])
  })

  it('records the txrshell `/models` handoff: the route is gone, the handoff comment is there, nothing else in the shell moves', () => {
    // The current shell state (the handoff's result).
    expect(routesOf(txrShellModule).map(r => r.path)).toEqual(['/history', '/help'])
    const shellSource = readFileSync(
      fileURLToPath(new URL('../txrshell/module.tsx', import.meta.url)),
      'utf8',
    )
    expect(shellSource).toContain('`txrmodels` module')
    expect(shellSource).not.toContain("path: '/models'")

    // The patch itself: removed lines are the old comment block + the
    // `/models` route block only; added lines are the new comment block
    // only. Byte-pins "NO other change" (DEC-2).
    const { added, removed } = shellPatch()
    const commentLine = (l: string) => /^(\s*\/\*\*|\s*\*(?:\s.*)?|\s*\*\/)$/.test(l)
    const routeBlockLine = (l: string) =>
      [
        '    {',
        "      path: '/models',",
        '      element: <ShellPage title="Models" />,',
        '      requiresAuth: true,',
        '      layout: TxrLayoutDef,',
        '    },',
      ].includes(l)
    expect(removed.length).toBeGreaterThan(0)
    expect(removed).toContain("      path: '/models',")
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
    // The scan's target is SHIPPED COPY — the module's own source, comments
    // and fixtures; any spelling there fails. Test files are excluded, the
    // same scope the sibling token scans use: they PIN the boards'
    // bytes as EXPECTED values, which is precisely what an INV-5/6 scan
    // must allow outside shipped copy.
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
    // The boards' example facts (Pretrained / Saved / Models boards) —
    // never code or fixture constants (INV-4).
    const designExampleBareCounts = [
      '38 pa' + 'tients',
      '5 ca' + 'n run',
      '13 sa' + 'ved models',
      '151 pa' + 'tients',
      'of 3' + '8',
      '50 m' + 'b',
      '11 m' + 'odels',
      '0.' + '64',
    ]
    for (const phrase of designExampleBareCounts) {
      expect(own).not.toContain(phrase)
    }
    expect(own).not.toContain('http' + '://')
  })

  it('spells no forbidden literal in its own source files (INV-4)', () => {
    const own = ownSourceFiles(MODULE_DIR)
      .filter(p => !/\.test\.(ts|tsx)$/.test(p))
      .map(p => readFileSync(p, 'utf8'))
      .join('\n')
      .toLowerCase()
    const tokenRe = new RegExp('st' + 'ud(y|ies)', 'i')
    expect(tokenRe.test(own)).toBe(false)
  })
})
