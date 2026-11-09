/**
 * TEST-UL-17 — txrlist module shape (PROV-UI-LIST-7, INV-6).
 *
 * The module is a framework module only: auto-discovered by the loader glob
 * in `modules/loader.ts` (`import.meta.glob` over module.tsx files in the
 * modules tree), and carrying NO route, NO store, NO slot and NO component
 * (DEC-2). It adds nothing to the app's dependency set and edits no
 * guard/baseline script — the same `git diff`-against-base property the
 * tests below check, for the whole delivered item.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { AppModule } from '@ziee/framework/module-system/types'
import txrlistModule from './module'

const moduleTable = txrlistModule as AppModule & {
  routes?: unknown[]
}

/**
 * The file set DELIVERED BY THIS ITEM, in either of the two states it is
 * verified in. Uncommitted (the item's own verification run): the working
 * tree against HEAD. Committed (the branch gate): the tip commit's own diff
 * — the item commit or its report record commit, both of which are this
 * item's file set.
 */
function itemDelta(): string[] {
  // The tests run from `src-app/ui`, and git prints STATUS/LS-FILES paths
  // relative to the working directory while DIFF paths are repo-root
  // relative — so the three sources must be read from the ROOT with `-C`,
  // otherwise an untracked file (qa-fixes ITEM-7's new files) would be
  // reported on the wrong base and the no-edit pins would misfire
  // (`src-app/ui/scripts/…` arriving as `scripts/…`). The txrhelp sweep's
  // convention.
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

describe('txrlist module', () => {
  it('registers as a framework module with the planned metadata', () => {
    expect(moduleTable.metadata).toEqual({
      name: 'txrlist',
      version: '1.0.0',
      description:
        'Shared model/method selection list for the TxResBench run screens (E, D, I)',
    })
  })

  it('adds no route, no store, no slot and no component (DEC-2)', () => {
    expect((moduleTable as { routes?: unknown }).routes).toBeUndefined()
    expect(moduleTable.registerStores).toBeUndefined()
    expect(moduleTable.registerComponents).toBeUndefined()
    expect(moduleTable.registerSlots).toBeUndefined()
    expect((moduleTable as unknown as Record<string, unknown>).shouldLoad).toBeUndefined()
    expect(moduleTable.initialize).toBeUndefined()
    expect(moduleTable.cleanup).toBeUndefined()
  })

  it('declares no framework dependency (a component library needs none)', () => {
    expect(moduleTable.registerDependencies?.()).toEqual([])
  })

  it('is picked up by the loader auto-discovery glob', () => {
    // The loader globs module.tsx files under the modules tree (loader.ts);
    // this same glob, run from inside the module dir, must resolve the module
    // file and yield the one module export the loader registers.
    const files = import.meta.glob('./**/module.tsx', { eager: true }) as Record<
      string,
      { default: unknown }
    >
    expect(Object.keys(files)).toContain('./module.tsx')
    expect(files['./module.tsx'].default).toBe(txrlistModule)
  })

  it('does not change the dependency set or the guard/scripts tree (INV-5/6)', () => {
    const touched = itemDelta()
    expect(touched.filter(p => p === 'src-app/ui/package.json')).toEqual([])
    // qa-fixes ITEM-7 (X1): the built-CSS url check — one script file
    // (`scripts/check-built-css-urls.mjs`, wired into the vite
    // closeBundle), sanctioned verbatim with the fonts fix.
    expect(touched.filter(p => p.startsWith('src-app/ui/scripts/') &&
          p !== 'src-app/ui/scripts/check-built-css-urls.mjs')).toEqual([])
  })

  it('README pins the three-step host wiring and the provider binding (PROV-UI-LIST-7)', () => {
    const readme = readFileSync(fileURLToPath(new URL('./README.md', import.meta.url)), 'utf8')
    expect(readme).toContain('1. **Build the rows.**')
    expect(readme).toContain('2. **Hold the selection.**')
    expect(readme).toContain('3. **Render the list.**')
    expect(readme).toContain('TxrSelectList')
    expect(readme).toContain('onSelectionChange')
    expect(readme).toContain('onSectionAction')
    expect(readme).toContain('ApiClient.MethodCatalogue.list/.eligibility/.estimate')
  })
})
