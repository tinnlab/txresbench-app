// TEST-5 (ITEM-2) — the React-free seam.
//
// The whole point of splitting `declarative/` three ways (RESEARCH R2) is that the SPEC
// front end and the RUNTIME are framework-free: they can be evaluated, tested and
// re-hosted without React. That property is invisible to `tsc` — a stray
// `import { useMemo } from 'react'` in `core/runtime` compiles perfectly — so it needs
// an executable guard, and it is exactly the kind of property that silently rots on the
// next refactor.
//
// Both directions are asserted: `core/spec` + `core/runtime` import NO React, and
// `core/render` DOES — otherwise a test that passed because the scan found no files, or
// because `core/render` had been emptied, would read identically.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const CORE = path.resolve(HERE, '..')

/** Matches a real module specifier for React — `react`, `react-dom`, `react-dom/client`,
 *  `react/jsx-runtime` — in an `import … from`, a bare `import`, or a dynamic `import()`.
 *  Deliberately NOT a bare `/react/` substring: that would also match `@txresbench/kit`'s
 *  re-exports and `react-hook-form`, and a guard that over-matches gets relaxed, then
 *  gets relaxed again, and stops guarding. */
const REACT_IMPORT = /(?:from|import)\s*\(?\s*['"](react|react-dom)(\/[^'"]*)?['"]/

function sources(dir: string): string[] {
  const out: string[] = []
  const walk = (d: string) => {
    if (!existsSync(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) {
        walk(p)
        continue
      }
      if (!/\.(ts|tsx)$/.test(e.name)) continue
      if (/\.test\.(ts|tsx)$/.test(e.name)) continue // suites may render
      out.push(p)
    }
  }
  walk(dir)
  return out
}

const importsReact = (f: string) => REACT_IMPORT.test(readFileSync(f, 'utf8'))

test('TEST-5: `core/spec` is React-free', () => {
  const files = sources(path.join(CORE, 'spec'))
  // POSITIVE COUNT — "no React imports found" over an empty scan is the failure this
  // round found six times over.
  assert.ok(files.length >= 4, `core/spec scan collapsed: ${files.length} file(s)`)
  assert.deepEqual(
    files.filter(importsReact).map(f => path.relative(CORE, f)),
    [],
    'core/spec must be evaluable without a UI framework',
  )
})

test('TEST-5: `core/runtime` is React-free', () => {
  const files = sources(path.join(CORE, 'runtime'))
  assert.ok(files.length >= 12, `core/runtime scan collapsed: ${files.length} file(s)`)
  assert.deepEqual(
    files.filter(importsReact).map(f => path.relative(CORE, f)),
    [],
    'core/runtime must be evaluable without a UI framework',
  )
})

test('TEST-5: `core/render` IS the React layer (the positive control)', () => {
  const files = sources(path.join(CORE, 'render'))
  assert.ok(files.length >= 8, `core/render scan collapsed: ${files.length} file(s)`)
  const reactFiles = files.filter(importsReact)
  // If this were 0 the two assertions above would be vacuous — the regex would simply
  // not be matching anything anywhere.
  assert.ok(
    reactFiles.length >= 5,
    `core/render should be the React half; only ${reactFiles.length} of ${files.length} import React ` +
      '— either the layer moved or the detector is broken',
  )
})

test('TEST-5: the React detector actually matches the forms it must catch', () => {
  // A guard is only as good as its matcher; these are the shapes that must not slip past.
  for (const s of [
    `import { useMemo } from 'react'`,
    `import React from "react"`,
    `import { createRoot } from 'react-dom/client'`,
    `import 'react-dom'`,
    `const R = await import('react')`,
    `export { x } from 'react/jsx-runtime'`,
  ])
    assert.ok(REACT_IMPORT.test(s), `detector missed: ${s}`)
  // …and the shapes it must NOT claim, or it will be relaxed into uselessness.
  for (const s of [
    `import { useForm } from 'react-hook-form'`,
    `import { Button } from '@txresbench/kit'`,
    `// this module is deliberately react-free`,
    `const reactive = true`,
  ])
    assert.ok(!REACT_IMPORT.test(s), `detector over-matched: ${s}`)
})
