// TEST-11 (ITEM-10) — the `data` capability reads through its plane.
//
// ITEM-7 dropped the `writeResult` / `writeAnnotation` assertions with the methods
// themselves: they were documented UNCONDITIONAL throws (there is no write REST) with
// no remaining callers, so the contract no longer carries a guaranteed rejection.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDataApi } from './dataCapability.ts'
import { DATA_CAPABILITY_ID } from './contract.ts'
import type { ArtifactQuery, DataHost } from './contract.ts'

const EMPTY: DataHost = {
  catalog: async projectId => ({ project_id: projectId, axes: [], artifacts: [] }),
  listArtifacts: async () => [],
  readColumn: async () => ({ values: new Float32Array() }),
  readArtifact: async () => new Uint8Array(),
  readOpaque: async () => new Uint8Array(),
  previewValues: async () => undefined,
}

test('the published id is the exact string core routes on', () => {
  assert.equal(DATA_CAPABILITY_ID, 'data')
})

test('TEST-11: catalog + artifacts.query delegate to the plane with the project id', async () => {
  const cap: { project: string; query: ArtifactQuery | null } = { project: '', query: null }
  const plane: DataHost = {
    ...EMPTY,
    catalog: async projectId => {
      cap.project = projectId
      return {
        project_id: projectId,
        axes: [
          { content_hash: 'h-positions', name: 'positions', length: 3 },
          { content_hash: 'h-values', name: 'values', length: 2 },
        ],
        artifacts: [],
      }
    },
    listArtifacts: async (_projectId, q) => {
      cap.query = q
      return [
        {
          id: 'a1',
          project_id: 'project-1',
          datatype: 'embedding',
          structure: { encoding: 'opaque' },
          created_at: '',
        },
      ]
    },
  }
  const api = createDataApi(plane, 'project-1')

  const cat = await api.catalog()
  assert.equal(cap.project, 'project-1')
  // The axis IDENTITY (INV-3) survives the capability hop — a `{name,length}` projection
  // here would strip it before any consumer ever sees it.
  assert.deepEqual(cat.axes, [
    { content_hash: 'h-positions', name: 'positions', length: 3 },
    { content_hash: 'h-values', name: 'values', length: 2 },
  ])

  // A TypeSelector is normalized to an ArtifactQuery.
  const rows = await api.artifacts.query({ subtypes_of: 'matrix' })
  assert.equal(cap.query?.subtypesOf, 'matrix')
  assert.equal(rows[0].datatype, 'embedding')
})

test('TEST-11: read → plane.readArtifact (opaque query passthrough, raw Arrow bytes)', async () => {
  const cap: { read: unknown } = { read: null }
  const plane: DataHost = {
    ...EMPTY,
    readArtifact: async read => {
      cap.read = read
      return new Uint8Array([1, 2, 3, 4])
    },
  }
  const api = createDataApi(plane, 'project-1')

  const q = { rows: [0, 1], cols: ['CD4'] }
  const bytes = await api.read({ artifactId: 'a1', query: q })
  // the query is passed OPAQUE through to the plane unchanged.
  assert.deepEqual(cap.read, { artifactId: 'a1', query: q })
  // the raw Arrow IPC bytes come back for the caller to decode.
  assert.deepEqual([...bytes], [1, 2, 3, 4])
})

test('TEST-11: readOpaque → plane.readOpaque(artifactId) (unwraps the id, returns raw bytes)', async () => {
  const cap: { id: string } = { id: '' }
  const plane: DataHost = {
    ...EMPTY,
    readOpaque: async artifactId => {
      cap.id = artifactId
      return new Uint8Array([9, 8, 7])
    },
  }
  const api = createDataApi(plane, 'project-1')

  const bytes = await api.readOpaque({ artifactId: 'report-1' })
  assert.equal(cap.id, 'report-1')
  assert.deepEqual([...bytes], [9, 8, 7])
})

test('TEST-11: previewValues → plane.previewValues (the WHOLE request, structure included)', async () => {
  // The `structure` half is the load-bearing one: it rides the catalog row the caller
  // already holds, which is what makes a preview cost no control-plane re-fetch. A binding
  // that dropped it would still type-check on the plane side (every field is read off one
  // object) and would silently reintroduce a `getArtifact` per selection.
  const cap: { request: unknown } = { request: null }
  const plane: DataHost = {
    ...EMPTY,
    previewValues: async request => {
      cap.request = request
      return { values: ['a', 'b'], source: 'levels' }
    },
  }
  const api = createDataApi(plane, 'project-1')

  const structure = { encoding: 'zarr_v3', kind: 'table', columns: [{ path: 'values', kind: 'categorical' }] }
  const preview = await api.previewValues({ artifactId: 'col-1', structure, member: 'values', limit: 5 })
  assert.deepEqual(cap.request, { artifactId: 'col-1', structure, member: 'values', limit: 5 })
  assert.deepEqual(preview, { values: ['a', 'b'], source: 'levels' })
})
