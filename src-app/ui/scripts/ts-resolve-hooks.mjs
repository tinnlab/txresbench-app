import { existsSync, statSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve as presolve } from 'node:path'

const isFile = p => existsSync(p) && statSync(p).isFile()

// The app's `@/*` -> `<ui>/src/*` alias (mirrors vite.config.ts / vitest.config.ts /
// tsconfig.json paths). `node --test` has no bundler, so without this a node:test file
// cannot load any app source that imports through the alias — which every source under
// `modules/workbench/core` now does.
const UI_SRC = presolve(dirname(fileURLToPath(import.meta.url)), '..', 'src')

// Resolve extensionless RELATIVE specifiers to their .ts/.tsx/index file.
export async function resolve(spec, ctx, next) {
  if (spec === '@' || spec.startsWith('@/')) {
    const base = presolve(UI_SRC, spec.slice(2))
    for (const c of [base, base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx']) {
      if (isFile(c)) return { url: pathToFileURL(c).href, shortCircuit: true }
    }
  }
  if ((spec.startsWith('./') || spec.startsWith('../')) && ctx.parentURL) {
    const base = presolve(dirname(fileURLToPath(ctx.parentURL)), spec)
    for (const c of [base, base + '.ts', base + '.tsx', base + '/index.ts', base + '/index.tsx']) {
      if (isFile(c)) return { url: pathToFileURL(c).href, shortCircuit: true }
    }
  }
  return next(spec, ctx)
}
