// The artifact-catalog CHANNEL reader (ITEM-7/ITEM-8, ITEM-21).
//
// `readCatalogScope` is the one hop between a render scope — an `unknown`-valued record —
// and the typed rows a control resolves its candidates from. Two things make it worth
// pinning on its own rather than only through the widget that calls it:
//
//   · It must FAIL CLOSED. Every non-conforming input has to read as an EMPTY catalog, not
//     as a throw and not as a partially-trusted object, because the failure it guards is a
//     host that published nothing (a bare unit mount) — a legitimate state that must render
//     the control's empty branch, not take the pane down.
//   · The key is a MAGIC STRING crossing an untyped boundary. A typo on either side does
//     not fail to compile: the publisher writes a key nobody reads and the reader finds
//     nothing, so every `artifact_ref` in the app silently offers zero candidates — which
//     is indistinguishable from "this project has no matching artifacts". Pinning the
//     literal is what makes a rename a red test instead of a quiet blank picker.
//
// A node:test suite, deliberately: the module is React-free and its only imports are
// type-only, so it needs no DOM, no bundler and no host.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Scope } from '@/modules/workbench/core/runtime/expr'
import { CATALOG_SCOPE_KEY, readCatalogScope, type ArtifactRow } from './catalog.ts'

// A synthetic row. The datatype is a placeholder, NOT one of the app's contributed ids:
// nothing here dispatches on it, so naming a real one would put a domain literal in an
// engine test for no reason (`lint-no-domain-in-builtin` flags exactly that).
const row = (id: string): ArtifactRow => ({
  id,
  project_id: 'p1',
  datatype: 'example/type-a',
  structure: { encoding: 'zarr_v3', kind: 'table', axis: 'axis-a', columns: [{ name: id, kind: 'string' }] },
  created_at: '2026-01-01T00:00:00Z',
  source_dataset_id: 'ds-a',
})

test('the channel key is the exact literal both sides of the untyped scope agree on', () => {
  // Pinned as a VALUE, not compared against itself: the scope is `Record<string, unknown>`,
  // so a rename type-checks on both sides and silently disconnects them.
  assert.equal(CATALOG_SCOPE_KEY, 'catalog')
})

test('reads the rows and the lattice a populated channel carries', () => {
  const lattice = { isA: () => true, matches: () => true, get: () => undefined }
  const scope: Scope = { [CATALOG_SCOPE_KEY]: { artifacts: [row('a'), row('b')], lattice } }
  const read = readCatalogScope(scope)
  assert.deepEqual(
    read.artifacts.map(a => a.id),
    ['a', 'b'],
  )
  // The lattice rides through UNCHANGED (same reference): a source's `excludes` /
  // `capabilities` constraints FAIL CLOSED without it, so a reader that dropped it would
  // turn every negative constraint into "no candidates" with no error anywhere.
  assert.equal(read.lattice, lattice)
})

test('every non-conforming channel reads as an EMPTY catalog, and none of them throws', () => {
  // Each case is a real shape a host can publish: nothing at all, an explicit absence, a
  // primitive, and — the one a `typeof === object` check alone would wave through — an
  // object on the right key whose `artifacts` is not a list.
  const cases: Array<[string, Scope]> = [
    ['no channel at all', {}],
    ['channel explicitly undefined', { [CATALOG_SCOPE_KEY]: undefined }],
    ['channel is null', { [CATALOG_SCOPE_KEY]: null }],
    ['channel is a primitive', { [CATALOG_SCOPE_KEY]: 'catalog' }],
    ['channel is an object with no rows', { [CATALOG_SCOPE_KEY]: {} }],
    ['channel carries a non-array under `artifacts`', { [CATALOG_SCOPE_KEY]: { artifacts: { 0: row('a') } } }],
  ]
  for (const [why, scope] of cases) {
    const read = readCatalogScope(scope)
    assert.deepEqual(read.artifacts, [], `${why}: must read as an empty catalog`)
    assert.equal(read.lattice, undefined, `${why}: must not invent a lattice`)
  }
})

test('a populated channel is not confused with an EMPTY one (the negative control)', () => {
  // Without this, an implementation that returned `{artifacts: []}` unconditionally would
  // satisfy every clause above.
  assert.equal(readCatalogScope({ [CATALOG_SCOPE_KEY]: { artifacts: [row('a')] } }).artifacts.length, 1)
})
