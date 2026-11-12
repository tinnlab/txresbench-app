// TEST-15 (ITEM-14) + TEST-16 (ITEM-15) — the manifest validator: parses JSON,
// gates apiVersion, rejects malformed/unknown-contribution manifests, and indexes
// WITHOUT executing extension code.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validateManifest } from './validate.ts'

const good = {
  id: 'txr.clustering',
  name: 'Clustering',
  publisher: 'txr',
  version: '0.1.0',
  apiVersion: '^1.0',
  activation: ['onAnalysis:clustering.leiden'],
  contributes: { analyses: [{ id: 'clustering.leiden' }] },
}

test('TEST-15: validates a well-formed manifest (object + JSON string)', () => {
  assert.equal(validateManifest(good).ok, true)
  assert.equal(validateManifest(JSON.stringify(good)).ok, true)
})

test('TEST-15: rejects missing required fields + unknown contribution kinds', () => {
  const noId = validateManifest({ ...good, id: undefined })
  assert.equal(noId.ok, false)
  assert.ok(noId.errors.some(e => e.path === '$.id'))

  const badContrib = validateManifest({ ...good, contributes: { bogus: [] } })
  assert.equal(badContrib.ok, false)
  assert.ok(badContrib.errors.some(e => /unknown contribution kind/.test(e.message)))
})

test('TEST-15: rejects an id outside the schema charset (security: keeps the storage prefix injective)', () => {
  // A `:` in an id would break the `ext:<id>:` KV namespace (audit SEC-1).
  for (const bad of ['a:b', 'TxResBench.Demo', 'has space', '_leading']) {
    const r = validateManifest({ ...good, id: bad })
    assert.equal(r.ok, false, `id "${bad}" must be rejected`)
    assert.ok(r.errors.some(e => e.path === '$.id'))
  }
  assert.equal(validateManifest({ ...good, id: 'txr.demo-1' }).ok, true)
})

test('TEST-16: refuses an out-of-range apiVersion', () => {
  const r = validateManifest({ ...good, apiVersion: '^2.0' })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.path === '$.apiVersion'))
})

test('TEST-16: indexes WITHOUT executing extension code (lazy thunk never called)', () => {
  let thunkCalls = 0
  // A manifest whose "code refs" are thunks the validator must never invoke.
  const withThunks = {
    ...good,
    contributes: {
      analyses: [{ id: 'a', run: { kind: 'sandbox', entry: 'x.py' } }],
      // a real code ref would be bound as a thunk; simulate one on the object.
      // (ITEM-35: this used to hang the thunk on a `commands` entry — `commands` is no
      // longer a known contribution key, so the thunk rides a `views` entry instead.)
      views: [{ id: 'v', area: 'bottom', title: 'V', _load: () => void thunkCalls++ }],
    },
  }
  const r = validateManifest(withThunks)
  assert.equal(r.ok, true)
  assert.equal(thunkCalls, 0, 'validation is pure metadata indexing — no code executed')
})
