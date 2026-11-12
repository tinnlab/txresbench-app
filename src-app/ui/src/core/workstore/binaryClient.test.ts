// TEST-29 [covers: ITEM-24] — the FRONTEND half of INV-1's mechanical proof.
//
// `scripts/check-no-format-crates.sh` asserts the SERVER links no format-parsing crate.
// This is its twin on the client: no module imports a format library either. The design's
// claim is not "we happen not to use Arrow at the moment" — it is that the encoding
// (shuffle + gzip, arrow-layout strings, Zarr v3 sharding) is decodable with
// `DecompressionStream`, `TextDecoder` and typed-array views, and DEC-4 paid 2.6% of
// compression ratio to keep it that way. A single `import` puts the dependency back and
// the reason for the codec choice evaporates with nothing else failing.
//
// ── WHY A SOURCE SCAN, NOT A package.json CHECK ────────────────────────────────────
//
// `package.json` is the weaker assertion in both directions. A dep can be absent from it
// and still resolve (hoisted from a workspace sibling into the shared `node_modules`,
// which is exactly this repo's layout), and a dep can sit in it unused. What matters is
// whether a module can REACH the library, so the scan is over the import graph's text —
// the thing that would have to change for the dependency to come back. `package.json` is
// asserted too, as the second, independent read.
//
// ── WHY THE SCAN SPANS THE WORKSPACE, NOT JUST `ui/src` ────────────────────────────
//
// This used to scan `ui/src` + `ui/package.json` and nothing else — which left a hole the
// exact shape of the invariant. `ui` is one workspace among several; it consumes
// `@txresbench/viz`, `@txresbench/kit`, `@txresbench/dock`, … as FIRST-PARTY SOURCE (their `main`/`exports`
// point straight at `src/*.ts`, so they are compiled into the app, not consumed as a
// prebuilt artifact). A format-library import in a workspace package is therefore in the
// UI's bundle just as surely as one written in `ui/src` — and the planted probe proved it:
// a `tableFromIPC` import added to `@txresbench/viz`'s `src/charts.ts`, which `ui` imports as
// `@txresbench/viz/charts`, left all four assertions below GREEN.
//
// So the scanned surface is DERIVED: the root `package.json`'s `workspaces` globs give
// name → directory, and the closure walks `ui`'s workspace dependencies transitively. A
// package added to the graph tomorrow is scanned on arrival, with no list to update here.
//
// ── DEFAULT-DENY ───────────────────────────────────────────────────────────────────
//
// The list below denies FAMILIES by import-specifier prefix, so a subpath import is denied
// by its root and a newly-added codec/format package trips it without anyone editing the
// list. Widening it is a one-line change; narrowing it is an invariant change and belongs
// in the design, not here. (The families are named once, in `DENIED` — this prose does not
// repeat them, because every occurrence in this file is itself scanned.)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..')
const UI_ROOT = join(SRC, '..')
/** `src-app/ui` → `src-app` → the repo root, which owns the `workspaces` globs. */
const REPO_ROOT = join(UI_ROOT, '..', '..')

/** Import specifiers no module under `ui/src` may name. Matched as a family: the exact
 *  specifier or anything under it (`apache-arrow/…`). */
const DENIED = [
  'apache-arrow',
  'zarrita',
  'numcodecs',
  'parquet-wasm',
  'hyparquet',
  'h5wasm',
  '@zarrita/core',
  'blosc',
] as const

interface Manifest {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function manifestAt(dir: string): Manifest {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as Manifest
}

/** Read, not written down: the closure root is whatever `ui/package.json` calls itself. */
const UI_PACKAGE_NAME = (() => {
  const { name } = manifestAt(UI_ROOT)
  if (!name) throw new Error('ui/package.json declares no `name` — the closure has no root')
  return name
})()

/** Package name → directory, for every workspace the ROOT `package.json` declares.
 *  Derived from the `workspaces` globs (`a/b/*` or a literal path), so a package added to
 *  the monorepo is resolvable here without an edit. */
function workspaceIndex(): Map<string, string> {
  const root = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    workspaces?: string[]
  }
  const index = new Map<string, string>()
  for (const pattern of root.workspaces ?? []) {
    const dirs = pattern.endsWith('/*')
      ? readdirSync(join(REPO_ROOT, pattern.slice(0, -2))).map(entry =>
          join(REPO_ROOT, pattern.slice(0, -2), entry),
        )
      : [join(REPO_ROOT, pattern)]
    for (const dir of dirs) {
      if (!existsSync(join(dir, 'package.json'))) continue
      const { name } = manifestAt(dir)
      if (name) index.set(name, dir)
    }
  }
  return index
}

/** The UI package plus the TRANSITIVE closure of the workspace packages it depends on.
 *  `devDependencies` are followed for the same reason test files are scanned: "only in
 *  the dev graph" still means the dependency is installed and resolvable. */
function scannedPackages(): { name: string; dir: string }[] {
  const index = workspaceIndex()
  const out = new Map<string, string>([[UI_PACKAGE_NAME, UI_ROOT]])
  const queue = [UI_PACKAGE_NAME]
  while (queue.length) {
    const dir = out.get(queue.shift() as string) as string
    const pkg = manifestAt(dir)
    for (const dep of [
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
    ]) {
      const depDir = index.get(dep)
      if (!depDir || out.has(dep)) continue
      out.set(dep, depDir)
      queue.push(dep)
    }
  }
  return [...out].map(([name, dir]) => ({ name, dir }))
}

/** Every `.ts`/`.tsx` under a package's source root. Test files included on purpose: a
 *  test that imports a format library needs the dependency installed just as much as
 *  production does, and "only in tests" is how a dependency gets re-added. */
function sourceFiles(root: string): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '__fixtures__') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.tsx?$/.test(entry)) out.push(full)
    }
  }
  walk(root)
  return out
}

/** Every module specifier a file imports: static `import … from 'x'`, side-effect
 *  `import 'x'`, `export … from 'x'`, dynamic `import('x')` and `require('x')`. */
function importSpecifiers(src: string): string[] {
  const out: string[] = []
  const patterns = [
    /(?:^|\n)\s*(?:import|export)[\s\S]*?\sfrom\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const re of patterns) {
    for (const m of src.matchAll(re)) out.push(m[1])
  }
  return out
}

function isDenied(specifier: string): string | undefined {
  return DENIED.find(d => specifier === d || specifier.startsWith(`${d}/`))
}

const PACKAGES = scannedPackages()

/** The scan set, as `(package, absolute file)` pairs. A package's source root is its
 *  `src/` when it has one (every workspace here does), else the package directory — never
 *  a hand-listed subset, so a new directory inside a scanned package is covered. */
const SCANNED: { pkg: string; dir: string; file: string }[] = PACKAGES.flatMap(({ name, dir }) => {
  const srcRoot = existsSync(join(dir, 'src')) ? join(dir, 'src') : dir
  return sourceFiles(srcRoot).map(file => ({ pkg: name, dir, file }))
})

const FILES = SCANNED.map(s => s.file)

describe('TEST-29 (ITEM-24) — no module imports a format library', () => {
  it('scans a non-trivial import graph (anti-vacuity)', () => {
    // A scan that walked zero files would report clean forever. This is the same
    // `assert_all_present` role the Rust guards' presence check plays.
    expect(FILES.length, 'the workspace closure has sources to scan').toBeGreaterThan(200)
    const specifiers = FILES.flatMap(f => importSpecifiers(readFileSync(f, 'utf8')))
    expect(specifiers.length, 'the specifier extractor actually matches').toBeGreaterThan(500)
  })

  it('the scanned surface spans the workspace closure, not just ui/src', () => {
    // The floor that would have caught the original hole. `ui` alone cleared every
    // threshold above while a format library sat one workspace away, so the shape of the
    // SET is asserted, not only its size: the UI package plus the workspace packages it
    // actually consumes as source, each contributing files.
    const names = PACKAGES.map(p => p.name).sort()
    expect(names.length, `closure resolved to ${names.join(', ')}`).toBeGreaterThan(1)
    expect(names, 'the UI package is the closure root').toContain(UI_PACKAGE_NAME)
    // Every package in the closure contributed at least one file. A package whose `src/`
    // moved would otherwise drop out silently and the scan would still look healthy.
    for (const { name } of PACKAGES) {
      expect(
        SCANNED.filter(s => s.pkg === name).length,
        `workspace package ${name} contributed no files — its source root moved`,
      ).toBeGreaterThan(0)
    }
  })

  it('the extractor MATCHES a denied specifier (proves it is not a no-op regex)', () => {
    // The failure mode this rules out: a guard that reports PASS because its pattern
    // never fires. Every import form the scan claims to cover is exercised here.
    // ASSEMBLED at runtime, never written literally: this file is itself in the scan set
    // (deliberately — the guard must not be able to hide an import in its own source), so
    // spelling a denied specifier out here, even inside a string or a comment, would make
    // the guard fail on itself. That it WOULD is the proof the scan reads what it claims.
    const q = String.fromCharCode(39)
    const spec = (name: string) => `${q}${name}${q}`
    const synthetic = [
      `import { tableFromIPC } from ${spec('apache-arrow')}`,
      `import ${spec('zarrita')}`,
      `export { open } from ${spec('zarrita/core')}`,
      `const z = await import(${spec('numcodecs')})`,
      `const p = require(${spec('hyparquet')})`,
    ].join('\n')
    const hits = importSpecifiers(synthetic).map(isDenied).filter(Boolean)
    expect(hits).toEqual(['apache-arrow', 'zarrita', 'zarrita', 'numcodecs', 'hyparquet'])
    // …and a legitimate specifier is NOT flagged (the negative control).
    expect(importSpecifiers(`import { x } from ${spec('./zarrReader')}`).map(isDenied)).toEqual([undefined])
    expect(isDenied('@/core/workstore/zarrReader')).toBeUndefined()
  })

  it('no file in the workspace closure imports one', () => {
    const leaks: string[] = []
    for (const { pkg, file } of SCANNED) {
      for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
        const family = isDenied(specifier)
        if (family) {
          leaks.push(`${pkg} ${relative(REPO_ROOT, file).split(sep).join('/')}: ${specifier} [${family}]`)
        }
      }
    }
    expect(
      leaks,
      'INV-1/ITEM-24: the client decodes with platform primitives only — see ' +
        'src/core/workstore/zarrReader.ts. Adding a format library back is an invariant ' +
        'change, not a convenience. A workspace package counts: its `exports` point at ' +
        '`src/*.ts`, so its imports are the UI bundle:\n' +
        leaks.join('\n'),
    ).toEqual([])
  })

  it('no package.json in the closure declares one either', () => {
    // The second, independent read — now over every manifest in the closure, because an
    // installed dependency is HOISTED into the shared root `node_modules` and is therefore
    // resolvable from `ui/src` no matter which workspace declared it. A dep declared here
    // and imported nowhere is exactly that: a live, reachable format library.
    const leaks: string[] = []
    let totalDeclared = 0
    for (const { name, dir } of PACKAGES) {
      const pkg = manifestAt(dir)
      const declared = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
      ]
      totalDeclared += declared.length
      for (const dep of declared) {
        if (isDenied(dep)) leaks.push(`${name} (${relative(REPO_ROOT, dir)}): ${dep}`)
      }
    }
    expect(totalDeclared, 'the manifests parsed').toBeGreaterThan(10)
    expect(
      leaks,
      'a workspace manifest declares a format library. Declared ⇒ installed ⇒ hoisted to ' +
        'the shared root `node_modules` ⇒ importable from anywhere in the UI, whether or ' +
        'not anything imports it today:\n' + leaks.join('\n'),
    ).toEqual([])
  })
})

// ── TEST-20 [ITEM-17] — the STREAMING byte route ────────────────────────────────────
//
// The claim is narrow and it is the whole point: the progressive read reaches the
// endpoint through the SAME generated client as the buffered read, so it inherits auth,
// the base URL, the silent 401-refresh, the retry-once and the `?range=` spelling — and
// this module still holds no transport of its own. The scan above (and TEST-41) is what
// proves the absence; these prove the presence.
//
// Mocked at `@/api-client`, which is the ONE boundary — mocking `fetch` instead would
// assert the transport's internals rather than that we go through it.
describe('the streaming byte route goes through the generated client (TEST-20)', () => {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const stubBody = (): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array([1, 2, 3]))
        c.close()
      },
    })

  beforeEach(() => {
    calls.length = 0
    vi.doMock('@/api-client', () => ({
      ApiClient: {
        Workstore: {
          async getArtifactDataStream(params: Record<string, unknown>) {
            calls.push({ method: 'whole', params })
            return stubBody()
          },
          async getArtifactDataMemberStream(params: Record<string, unknown>) {
            calls.push({ method: 'member', params })
            return params['*member'] === 'absent' ? null : stubBody()
          },
        },
      },
    }))
  })
  afterEach(() => {
    vi.doUnmock('@/api-client')
    vi.resetModules()
  })

  it('reaches the MEMBER route, and the `?range=` spelling matches the buffered read', async () => {
    const { fetchArtifactStream, byteRangeParam } = await import('./binaryClient')
    const range = byteRangeParam({ start: 10, end: 19 })
    const body = await fetchArtifactStream('art-1', 'positions/c/0', range)
    expect(body, 'a body is returned, unparsed').toBeInstanceOf(ReadableStream)
    expect(calls).toEqual([
      { method: 'member', params: { id: 'art-1', '*member': 'positions/c/0', range } },
    ])
    // …and it is the SAME spelling the buffered path uses — a query param, not a header.
    expect(range).toBe('10-19')
  })

  it('reaches the WHOLE-artifact route when no member is named', async () => {
    const { fetchArtifactStream } = await import('./binaryClient')
    await fetchArtifactStream('art-2')
    expect(calls).toEqual([{ method: 'whole', params: { id: 'art-2', range: undefined } }])
  })

  it('a bodyless response stays NULL — never an empty stream', async () => {
    // Coercing it would let a caller read zero bytes and conclude the member is empty,
    // which is the absence-reads-as-data confusion the 404 path is careful to avoid.
    const { fetchArtifactStream } = await import('./binaryClient')
    expect(await fetchArtifactStream('art-3', 'absent')).toBeNull()
  })

  it('artifactStore.getStream wires through, and an empty window never becomes a whole read', async () => {
    const { artifactStore } = await import('./zarrReader')
    const store = artifactStore('art-4', 'grp')
    await store.getStream!('values/c/1', { start: 0, length: 8 })
    expect(calls).toEqual([
      { method: 'member', params: { id: 'art-4', '*member': 'grp/values/c/1', range: '0-7' } },
    ])
    // The guard that matters: a zero-length window must NOT fall through to an un-ranged
    // request for the entire member — the mistake its buffered siblings guard against.
    calls.length = 0
    expect(await store.getStream!('values/c/1', { start: 0, length: 0 })).toBeNull()
    expect(calls, 'a zero-length window issues NO request at all').toEqual([])
  })
})
