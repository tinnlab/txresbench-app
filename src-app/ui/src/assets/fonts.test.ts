/**
 * TEST-QF-7 (fonts half, X1/G-1/RES-27) — the local font bundle's source-level
 * pin + the build check's behavior.
 *
 * X1's defect: `src/assets/fonts.css` declared `url('./assets/fonts/…')` while
 * the file already lives NEXT TO `src/assets/fonts/` — so the path resolved to
 * `src/assets/assets/fonts/…`, the built CSS referenced
 * `/assets/assets/fonts/…` (never in dist; the SPA index answered and every
 * font failed OTS parsing — the QA report's tripled path).
 *
 * What this pins:
 * 1. Every @font-face url in fonts.css is `./fonts/<file>` (no `assets/`
 *    repetition) and the file exists next to the css — the dev server, the
 *    built preview and the Tauri desktop shell all serve the same dist, so a
 *    correct source path is correct everywhere (Vite rewrites the urls into
 *    dist and copies the woff2 files).
 * 2. The three board families at the weights the design uses are declared.
 * 3. index.css imports the font css (the one import site).
 * 4. The build check `scripts/check-built-css-urls.mjs` exists, is wired into
 *    vite.config.ts's closeBundle, and behaves: a fixture dist whose css
 *    references a file that is not there exits 1 (naming it), and a fixture
 *    where every url() resolves exits 0. The fixtures are under the process
 *    TMPDIR (the owner rule: never /tmp) — a broken asset can never ship
 *    silently again (TEST-QF-7's "every url() in the built CSS exists in
 *    dist").
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const UI = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const ASSETS = join(UI, 'src', 'assets')
const fontsCss = readFileSync(join(ASSETS, 'fonts.css'), 'utf8')
const CHECK = join(UI, 'scripts', 'check-built-css-urls.mjs')

/** The @font-face declarations as {family, weight, url}. */
function facesOf(css: string): Array<{ family: string; weight: string; url: string }> {
  const out: Array<{ family: string; weight: string; url: string }> = []
  for (const block of css.match(/@font-face\s*\{[^}]+\}/g) ?? []) {
    out.push({
      family: /font-family:\s*'([^']+)'/.exec(block)?.[1] ?? '',
      weight: /font-weight:\s*(\d+)/.exec(block)?.[1] ?? '',
      url: /src:\s*url\(([^)]+)\)/.exec(block)?.[1] ?? '',
    })
  }
  return out
}

describe('the local font bundle (TEST-QF-7, X1)', () => {
  it('declares the three board families at the design weights, from THIS assets dir', () => {
    const faces = facesOf(fontsCss)
    const families = new Map<string, Set<string>>()
    for (const f of faces) {
      if (!families.has(f.family)) families.set(f.family, new Set())
      families.get(f.family)!.add(f.weight)
    }
    expect([...families.entries()].map(([k, v]) => [k, [...v].sort()])).toEqual([
      ['Source Sans 3', ['400', '600', '700']],
      ['Source Serif 4', ['400', '600']],
      ['Source Code Pro', ['400', '500']],
    ])
    // Every family/weight faces the local file next to the css — the X1 shape
    // (`./fonts/…`), never the tripled `./assets/fonts/…`.
    expect(fontsCss).not.toContain("url('./assets/")
    for (const f of faces) {
      expect(f.url).toMatch(/^'\.\/fonts\/[a-z0-9-]+\.woff2'$/)
      expect(existsSync(join(ASSETS, f.url.slice(2, -1))), `${f.url} must exist`).toBe(true)
    }
  })

  it('ships the OFL licence files with the fonts', () => {
    expect(facesOf(fontsCss)).toHaveLength(7)
    for (const lic of [
      'LICENSE-OFL-Source-Sans-3.txt',
      'LICENSE-OFL-Source-Serif-4.txt',
      'LICENSE-OFL-Source-Code-Pro.txt',
    ]) {
      expect(existsSync(join(ASSETS, 'fonts', lic)), lic).toBe(true)
    }
  })

  it('index.css imports the font css (the one import site the build reads)', () => {
    const index = readFileSync(join(UI, 'src', 'index.css'), 'utf8')
    expect(index).toContain('@import "./assets/fonts.css";')
    expect(index).toContain('@import "./assets/txr-theme.css";')
  })

  it('declares the app face at the document base, so portaled chrome inherits it (R2-01)', () => {
    // The kit Dialog/Drawer portal their content to document.body — outside
    // the `.txr-shell` subtree that declared the old inline face — so dialogs
    // rendered in the browser's DejaVu-like fallback next to Source Sans
    // pages (the qa-fixes2 R2-01 defect). The base layer must carry the same
    // first family the shell declares (one face everywhere).
    const index = readFileSync(join(UI, 'src', 'index.css'), 'utf8')
    expect(index).toMatch(
      /@layer base\s*\{[\s\S]{0,900}?font-family:\s*'Source Sans 3', system-ui, sans-serif;/,
    )
    // The shell's own declaration stays the same face (one truth, two
    // sites). app-shell ITEM-1 moved the shell from `TxrLayout.tsx` to
    // `components/AppShell.tsx` — the pin follows the declaration (the
    // unit tier runs ITEM-4's, so the re-pin is verified here).
    const shell = readFileSync(
      join(UI, 'src', 'modules', 'txrshell', 'components', 'AppShell.tsx'),
      'utf8',
    )
    expect(shell).toContain("fontFamily: \"'Source Sans 3', system-ui, sans-serif\"")
  })

  it('the build check is wired into the vite build and behaves on fixture dists', () => {
    expect(existsSync(CHECK)).toBe(true)
    // qa-fixes3 ITEM-6 (d): the plugin lives in its own module (the config
    // plugs it in) and captures the bundler's RESOLVED outDir — the check
    // runs against what the build actually wrote, default or --outDir.
    const plugin = readFileSync(join(UI, 'vite-built-css-check.ts'), 'utf8')
    expect(plugin).toContain('check-built-css-urls.mjs')
    expect(plugin).toContain('closeBundle')
    expect(plugin).toContain('configResolved')
    expect(plugin).toContain('config.build.outDir')
    const config = readFileSync(join(UI, 'vite.config.ts'), 'utf8')
    expect(config).toContain('txrBuiltCssUrlsCheck')
    expect(config).toContain('vite-built-css-check')

    const tmp = mkdtempSync(join(process.env.TMPDIR ?? '.', 'txr-font-check-'))
    try {
      const dist = join(tmp, 'dist', 'assets')
      mkdirSync(dist, { recursive: true })
      writeFileSync(join(dist, 'index-abc.css'), "a{src:url('/assets/font-ok.woff2')}")
      writeFileSync(join(dist, 'font-ok.woff2'), 'x')
      // All urls resolve (absolute against dist root).
      expect(
        execFileSync('node', [CHECK, join(tmp, 'dist')], { encoding: 'utf8' }).trim(),
      ).toContain('OK')
      // A missing target must fail the build (the X1 defect class): the css
      // references a font the dist does not contain.
      writeFileSync(join(dist, 'index-abc.css'), "a{src:url('/assets/assets/fonts/gone.woff2')}")
      expect(() => execFileSync('node', [CHECK, join(tmp, 'dist')], { encoding: 'utf8' })).toThrow(
        /gone\.woff2/,
      )
      // The relative spelling is checked too (the css sitting next to its font).
      writeFileSync(join(dist, 'index-abc.css'), "a{src:url('./font-ok.woff2')}")
      expect(
        execFileSync('node', [CHECK, join(tmp, 'dist')], { encoding: 'utf8' }).trim(),
      ).toContain('OK')
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('the plugin checks the RESOLVED outDir — the default and a --outDir override alike (ITEM-6 d)', async () => {
    const { txrBuiltCssUrlsCheck } = await import('../../vite-built-css-check')
    // The Plugin typing allows an ObjectHook wrapper; a plain function hook
    // is callable directly (the factory's hooks are functions).
    const configResolved = (plugin: { configResolved?: unknown }, config: { root: string; outDir: string }) =>
      (
        plugin.configResolved as unknown as (
          config: { root: string; build: { outDir: string } },
        ) => void
      )({ root: config.root, build: { outDir: config.outDir } })
    const closeBundle = (plugin: { closeBundle?: unknown }) =>
      (plugin.closeBundle as unknown as () => void)()
    const tmp = mkdtempSync(join(process.env.TMPDIR ?? '.', 'txr-outdir-check-'))
    try {
      const fixture = (distRoot: string) => {
        const assets = join(distRoot, 'assets')
        mkdirSync(assets, { recursive: true })
        writeFileSync(join(assets, 'index-abc.css'), "a{src:url('/assets/font-ok.woff2')}")
        writeFileSync(join(assets, 'font-ok.woff2'), 'x')
      }
      const root = join(tmp, 'ui')
      const defaultDist = join(root, '..', 'dist') // vite resolves '../dist' against the root
      const customDist = join(tmp, 'somewhere-else')
      // The two shapes the resolved config carries: a relative outDir (this
      // config's own `outDir: '../dist'`) and an absolute --outDir override.
      // Both must pass through the same closeBundle hook against the
      // directory the build resolves them to.
      for (const [outDir, distRoot] of [
        ['../dist', defaultDist],
        [customDist, customDist],
      ] as const) {
        fixture(distRoot)
        const plugin = txrBuiltCssUrlsCheck()
        // Vite calls configResolved with the raw outDir; the plugin resolves
        // it the way the bundler does (path.resolve(root, outDir)).
        configResolved(plugin, { root, outDir })
        expect(() => closeBundle(plugin)).not.toThrow()
      }
      // The override case is what the old hardcoded `dist` missed: a broken
      // url in the CUSTOM dist must fail the build through the plugin — the
      // thrown command names the custom directory (the check's own stderr
      // carries the missing url).
      const plugin = txrBuiltCssUrlsCheck()
      configResolved(plugin, { root, outDir: customDist })
      writeFileSync(
        join(customDist, 'assets', 'index-abc.css'),
        "a{src:url('/assets/assets/fonts/gone.woff2')}",
      )
      expect(() => closeBundle(plugin)).toThrow(/somewhere-else/)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  })
})
