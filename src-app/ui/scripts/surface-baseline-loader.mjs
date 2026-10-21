/**
 * Module hooks for `capture-surface-baseline.mjs`.
 *
 * The baseline device must load the workbench's TS/TSX sources out of an ARBITRARY
 * repo root — including a checkout of `origin/main`, whose tree shape predates the
 * refactor. So it cannot reuse `scripts/ts-resolve-hooks.mjs` (which hardcodes THIS
 * worktree's `src/` for the `@/*` alias, and does not transpile JSX at all).
 *
 * Two hooks:
 *   resolve — `@/*` -> `<uiRoot>/src/*` (uiRoot comes from SURFACE_BASELINE_UI_ROOT),
 *             extensionless relative -> `.ts` / `.tsx` / `index.*`, and non-JS assets
 *             (`.css`, `.svg`, …) -> an empty stub so a component import does not
 *             explode outside a bundler.
 *   load    — transpile `.ts` / `.tsx` through the in-tree `typescript` package.
 *             Node's own type-stripping cannot handle JSX, and the pane/widget
 *             registries this device reads are `.tsx`.
 */
import { existsSync, statSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as presolve, extname } from 'node:path'
import { createRequire } from 'node:module'

const isFile = p => existsSync(p) && statSync(p).isFile()

const UI_ROOT = process.env.SURFACE_BASELINE_UI_ROOT
if (!UI_ROOT) throw new Error('surface-baseline-loader: SURFACE_BASELINE_UI_ROOT is not set')
const UI_SRC = presolve(UI_ROOT, 'src')

// `typescript` is a devDependency of the ui workspace in BOTH tree shapes; resolve it
// from the tree under test so the transpile matches that tree's compiler.
const requireFromUi = createRequire(presolve(UI_ROOT, 'package.json'))
const ts = requireFromUi('typescript')

const STUB = 'data:text/javascript,export default {};'
const ASSET_EXT = new Set(['.css', '.scss', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.woff', '.woff2'])

const CANDIDATES = base => [base, base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx']

export async function resolve(spec, ctx, next) {
  if (ASSET_EXT.has(extname(spec).toLowerCase())) return { url: STUB, shortCircuit: true }
  if (spec === '@' || spec.startsWith('@/')) {
    const base = presolve(UI_SRC, spec.slice(2))
    for (const c of CANDIDATES(base)) if (isFile(c)) return { url: pathToFileURL(c).href, shortCircuit: true }
  }
  if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL?.startsWith('file:')) {
    const base = presolve(dirname(fileURLToPath(ctx.parentURL)), spec)
    for (const c of CANDIDATES(base)) if (isFile(c)) return { url: pathToFileURL(c).href, shortCircuit: true }
  }
  try {
    return await next(spec, ctx)
  } catch (e) {
    // A package that publishes TS SOURCE with extensionless internal specifiers
    // (`@ziee/kit/src/shadcn/native-select`) resolves to a real path with no file at
    // it. Node reports that path on the error; retry it with our extension candidates.
    if (e?.code === 'ERR_MODULE_NOT_FOUND' && typeof e.url === 'string' && e.url.startsWith('file:')) {
      const base = fileURLToPath(e.url)
      for (const c of CANDIDATES(base)) if (isFile(c)) return { url: pathToFileURL(c).href, shortCircuit: true }
    }
    throw e
  }
}

export async function load(url, ctx, next) {
  if (url.startsWith('file:')) {
    const p = fileURLToPath(url)
    const ext = extname(p).toLowerCase()
    if (ext === '.ts' || ext === '.tsx') {
      const out = ts.transpileModule(readFileSync(p, 'utf8'), {
        fileName: p,
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          jsx: ts.JsxEmit.ReactJSX,
          verbatimModuleSyntax: false,
          isolatedModules: true,
        },
      })
      // `import.meta.env` is a Vite define, not a runtime property; outside the bundler
      // it is `undefined` and the first `.DEV` read throws. Substitute the same shape
      // vitest injects (DEV false / PROD true — the SHIPPING branch, so a dev-only test
      // seam cannot alter what this device measures).
      const src = out.outputText.replace(/\bimport\.meta\.env\b/g, 'globalThis.__SURFACE_BASELINE_ENV__')
      return { format: 'module', source: src, shortCircuit: true }
    }
  }
  return next(url, ctx)
}
