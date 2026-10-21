// TEST-3 (ITEM-22) — the `@cyto/workbench-api` alias CANNOT silently keep working
// after the package is gone.
//
// ITEM-1 collapsed `src-app/libs/workbench-api` into `core/`. A move like that
// stays green for the wrong reason if the old specifier still resolves through a
// leftover tsconfig path, a leftover workspace dep, or a leftover workspace glob:
// `tsc` would keep compiling and every "no remaining importers" grep would keep
// passing while the two surfaces silently diverged. So this asserts the RESOLUTION
// EDGES are severed, not merely that nobody imports it today.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI = path.resolve(HERE, '../../../..') // <repo>/src-app/ui
const REPO = path.resolve(UI, '../..')
const SPECIFIER = '@cyto/workbench-api'

/** JSON with comments (tsconfig) — strip `//` line comments before parsing. */
function readJsonc(p: string): Record<string, unknown> {
  const raw = readFileSync(p, 'utf8').replace(/^\s*\/\/.*$/gm, '')
  return JSON.parse(raw) as Record<string, unknown>
}

test('TEST-3: ui/tsconfig.json declares no `@cyto/workbench-api` path alias', () => {
  const tsconfig = readJsonc(path.join(UI, 'tsconfig.json'))
  const paths = ((tsconfig.compilerOptions as Record<string, unknown>)?.paths ?? {}) as Record<
    string,
    string[]
  >
  const keys = Object.keys(paths)
  // Positive expectation: the alias map is still doing its job for `@/*`, so a test
  // that passes because the whole `paths` block vanished would be caught here.
  assert.ok(keys.length >= 1, 'the tsconfig paths map should still alias the app root')
  assert.ok(keys.includes('@/*'), `expected the app alias to survive; got ${keys.join(', ')}`)
  for (const k of keys) {
    assert.ok(!k.startsWith(SPECIFIER), `tsconfig still aliases ${k}`)
  }
})

test('TEST-3: ui/package.json declares no dependency on the deleted package', () => {
  const pkg = JSON.parse(readFileSync(path.join(UI, 'package.json'), 'utf8'))
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = (pkg[field] ?? {}) as Record<string, string>
    assert.ok(!(SPECIFIER in deps), `ui/package.json still declares ${SPECIFIER} in ${field}`)
  }
  // Positive control — the file really was parsed and really does declare deps.
  assert.ok(Object.keys(pkg.dependencies ?? {}).length > 10)
})

test('TEST-3: no workspace glob resolves a `workbench-api` package directory', () => {
  const root = JSON.parse(readFileSync(path.join(REPO, 'package.json'), 'utf8'))
  const globs: string[] = root.workspaces ?? []
  assert.ok(globs.length >= 2, `expected the workspace globs to survive; got ${JSON.stringify(globs)}`)
  const resolved: string[] = []
  for (const g of globs) {
    if (!g.endsWith('/*')) {
      resolved.push(g)
      continue
    }
    const dir = path.join(REPO, g.slice(0, -2))
    if (!existsSync(dir)) continue
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) resolved.push(path.posix.join(g.slice(0, -2), e.name))
    }
  }
  // Positive expectation: the globs still resolve real workspaces (dock, viz, ui, …).
  assert.ok(resolved.length >= 3, `expected ≥3 resolved workspaces, got ${resolved.join(', ')}`)
  assert.deepEqual(
    resolved.filter(p => p.endsWith('/workbench-api')),
    [],
    `a workspace still resolves a workbench-api package: ${resolved.join(', ')}`,
  )
})

test('TEST-3: the package DIRECTORY is gone', () => {
  assert.equal(existsSync(path.join(REPO, 'src-app/libs/workbench-api')), false)
})

test('TEST-3: the specifier is UNRESOLVABLE from the ui workspace', () => {
  // The load-bearing assertion. Everything above is a source-of-truth check; this is
  // the behaviour: node itself cannot find the module any more, so no stale import
  // can quietly keep working.
  const req = createRequire(path.join(UI, 'package.json'))
  assert.throws(
    () => req.resolve(SPECIFIER),
    (e: NodeJS.ErrnoException) => e.code === 'MODULE_NOT_FOUND',
    `${SPECIFIER} still resolves from ${UI}`,
  )
  // Positive control: the resolver works — a package that DOES exist resolves.
  assert.ok(req.resolve('typescript'))
})

test('TEST-3: package-lock.json carries no dependency EDGE on the deleted package', () => {
  const lock = JSON.parse(readFileSync(path.join(REPO, 'package-lock.json'), 'utf8'))
  const packages = (lock.packages ?? {}) as Record<string, Record<string, unknown>>
  // Two kinds of edge, both of which would make `npm ci` try to link it:
  //   1. a `node_modules/@cyto/workbench-api` link entry
  //   2. any package declaring it as a dependency
  assert.ok(
    !(`node_modules/${SPECIFIER}` in packages),
    'the lockfile still links node_modules/@cyto/workbench-api',
  )
  for (const [name, entry] of Object.entries(packages)) {
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies']) {
      const deps = (entry[field] ?? {}) as Record<string, string>
      assert.ok(!(SPECIFIER in deps), `lockfile: ${name} still depends on ${SPECIFIER} via ${field}`)
    }
  }
  // NOTE (characterised, not asserted away): the lockfile retains INERT package-definition
  // rows for the deleted path (marked `extraneous`). They declare no edge, `npm ci`
  // ignores them, and `require.resolve` above proves the specifier is dead. They clear on
  // the next full `npm install`.
})

test('TEST-3: no source file in ui/src or ui/tests IMPORTS the old specifier', () => {
  // The complement of the resolution check: even a comment-only mention is worth
  // knowing about, but only an IMPORT is a defect, so the assertion is on imports.
  const roots = [path.join(UI, 'src'), path.join(UI, 'tests')]
  const offenders: string[] = []
  let scanned = 0
  const walk = (dir: string) => {
    if (!existsSync(dir)) return
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules') continue
        walk(p)
        continue
      }
      if (!/\.(ts|tsx|mjs|js)$/.test(e.name)) continue
      scanned++
      const src = readFileSync(p, 'utf8')
      if (new RegExp(`(from|import|require)\\s*\\(?\\s*['"]${SPECIFIER.replace('/', '\\/')}`).test(src))
        offenders.push(path.relative(UI, p))
    }
  }
  for (const r of roots) walk(r)
  // POSITIVE COUNT: the baseline was 137 importing files across ui/src + ui/tests.
  // A scan that found 3 files would report "zero importers" just as happily.
  assert.ok(scanned >= 700, `scan set collapsed — only ${scanned} source files scanned`)
  assert.deepEqual(offenders, [], `these files still import ${SPECIFIER}`)
})
