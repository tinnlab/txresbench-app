import { describe, expect, it } from 'vitest'
import { readColumn } from './typedRead'
import { classifyJsonPayload, UnsupportedArtifactStructure } from './artifactReader'
import { memoryStore } from './zarrReader'

// A JSON blob is NOT one shape — it is TWO, and the reader used to know only one.
//
// `readJsonTable` is a COLUMNAR-TABLE reader: it treats every array-valued key as a column,
// zips them to `max(len)` and pads the short ones with nulls. A producer emitting a DOCUMENT
// — a `kind`-tagged object whose members are unrelated and of unequal length — therefore
// decoded into a table that looked plausible and was wrong in two ways at once: the members
// were padded into phantom blank rows, and every non-array key (the `kind` discriminator
// among them) was dropped on the floor with nothing raising a hand.
//
// The fix is not a better zip. It is that the two shapes are DECLARED and CHECKED: a binding
// says which one it expects, and reading a document as a table (or a table as a document) is
// refused by name rather than approximated. `classifyJsonPayload` is the pure half of that
// decision and is tested directly here, because a classifier that silently drifts is how the
// approximation would grow back under a new name.

const blob = (payload: unknown) =>
  memoryStore(new Map([['', new TextEncoder().encode(JSON.stringify(payload))]]))

const JSON_OPAQUE = { encoding: 'opaque', media_type: 'application/json' }

describe('classifyJsonPayload — the columnar reading is only valid when it is LOSSLESS', () => {
  it('a row-oriented {columns, rows} blob is a table', () => {
    expect(classifyJsonPayload({ columns: ['a', 'b'], rows: [[1, 2]] })).toBe('table')
  })

  it('a bare column map of EQUAL-length arrays is a table', () => {
    expect(classifyJsonPayload({ a: [1, 2, 3], b: ['x', 'y', 'z'] })).toBe('table')
  })

  it('an ENVELOPE nesting the column map is a table, non-columnar siblings and all', () => {
    expect(classifyJsonPayload({ columns: ['a'], frame: { a: [1, 2], b: [3, 4] } })).toBe('table')
  })

  // The two properties that make the columnar reading LOSSY, each on its own sufficient.
  it('a non-array top-level member makes it a document — that member has no column to be', () => {
    expect(classifyJsonPayload({ kind: 'report', a: [1, 2], b: [3, 4] })).toBe('document')
  })

  it('RAGGED arrays make it a document — padding to max(len) invents rows', () => {
    expect(classifyJsonPayload({ a: [1, 2], b: [3] })).toBe('document')
  })

  // Both at once: the real producer's shape (a discriminator plus members of unequal length).
  it('a discriminated object with ragged members is a document', () => {
    expect(
      classifyJsonPayload({ kind: 'x', sources: ['p', 'q'], normalize: [], candidates: [{ key: 'k' }] }),
    ).toBe('document')
  })

  it('an object with no members at all is a document, not an empty table', () => {
    // An empty table and "these bytes are not a table" are indistinguishable downstream
    // (INV-2), so the empty case must not be claimed by the table arm.
    expect(classifyJsonPayload({})).toBe('document')
  })
})

describe('expect: "document" reads the whole object, discriminator included', () => {
  it('yields every member — including the non-array keys a table read drops', async () => {
    const doc = await readColumn({
      id: 'fx',
      expect: 'document',
      structure: JSON_OPAQUE,
      store: blob({ kind: 'x', sources: ['p', 'q'], normalize: [], candidates: [{ key: 'k', ok: true }] }),
    })
    // The field that never survived the columnar decode.
    expect(doc.kind).toBe('x')
    // …and the members at their OWN lengths, unpadded.
    expect(doc.sources).toEqual(['p', 'q'])
    expect(doc.candidates).toEqual([{ key: 'k', ok: true }])
    expect(doc.normalize).toEqual([])
  })

  it('refuses a COLUMNAR TABLE, naming what it found — the mismatch is not best-effort', async () => {
    await expect(
      readColumn({
        id: 'fx',
        expect: 'document',
        structure: JSON_OPAQUE,
        store: blob({ columns: ['a'], rows: [[1]] }),
      }),
    ).rejects.toThrow(UnsupportedArtifactStructure)
  })

  it('refuses a NON-JSON opaque blob by media type, before a byte is decoded', async () => {
    await expect(
      readColumn({
        id: 'fx',
        expect: 'document',
        structure: { encoding: 'opaque', media_type: 'application/x-hdf5' },
        store: blob({ kind: 'x' }),
      }),
    ).rejects.toThrow(/expects kind "document".*declares "opaque\(application\/x-hdf5\)"/s)
  })

  it('refuses a zarr artifact, naming the kind it declares instead', async () => {
    await expect(
      readColumn({
        id: 'fx',
        expect: 'document',
        structure: { encoding: 'zarr_v3', kind: 'table', columns: [{ path: 'a' }] },
        store: blob({ kind: 'x' }),
      }),
    ).rejects.toThrow(/expects kind "document".*declares "table"/s)
  })
})

describe('expect: "table" REFUSES a document rather than zipping it into blank rows', () => {
  it('refuses a discriminated, ragged object and says which members are not columns', async () => {
    await expect(
      readColumn({
        id: 'fx',
        expect: 'table',
        structure: JSON_OPAQUE,
        store: blob({ kind: 'x', sources: ['p', 'q'], candidates: [{ key: 'k' }] }),
      }),
    ).rejects.toThrow(/document/)
  })

  it('still reads every genuinely columnar shape — the refusal is narrow', async () => {
    const rowOriented = await readColumn({
      id: 'fx',
      expect: 'table',
      structure: JSON_OPAQUE,
      store: blob({ columns: ['a', 'b'], rows: [[1, 'x'], [2, 'y']] }),
    })
    expect(rowOriented.rows.length).toBe(2)

    const bare = await readColumn({
      id: 'fx',
      expect: 'table',
      structure: { encoding: 'opaque' },
      store: blob({ a: [1, 2, 3], b: [4, 5, 6] }),
    })
    expect(bare.columns).toEqual(['a', 'b'])
    expect(bare.rows.length).toBe(3)
  })
})

// ── REGRESSION: the DECLARATION is not a column (blind-audit S1) ─────────────────────────
//
// On the bare-map arm the located map IS the top-level object, so `columns` — the declared
// column ORDER, itself an array — was counted as a column and length-compared against the real
// ones. The result was that a table decoded or was refused depending on whether it happened to
// be SQUARE. Every `columns:`-carrying fixture in the suite nests under an envelope, where the
// declaration is excluded by construction, so the one combination that breaks is the one no
// fixture wrote.
describe('the `columns` declaration is not itself a column', () => {
  it('decodes a BARE map carrying a declaration whose length differs from the row count', async () => {
    const table = await readColumn({
      id: 'fx',
      expect: 'table',
      structure: JSON_OPAQUE,
      store: blob({ columns: ['a', 'b'], a: [1, 2, 3], b: [4, 5, 6] }),
    })
    expect(table.columns).toEqual(['a', 'b'])
    expect(table.rows.length, '3 rows, not a refusal').toBe(3)
  })

  it('still refuses a bare map that is GENUINELY ragged beside its declaration', async () => {
    // The narrowing must not swallow real raggedness: drop the declaration, keep the check.
    await expect(
      readColumn({
        id: 'fx',
        expect: 'table',
        structure: JSON_OPAQUE,
        store: blob({ columns: ['a', 'b'], a: [1, 2, 3], b: [4] }),
      }),
    ).rejects.toThrow(/unequal length/)
  })

  it('classifies both cases directly, so the rule is pinned without a decode', () => {
    expect(classifyJsonPayload({ columns: ['a', 'b'], a: [1, 2, 3], b: [4, 5, 6] })).toBe('table')
    expect(classifyJsonPayload({ columns: ['a', 'b'], a: [1, 2, 3], b: [4] })).toBe('document')
  })

  it('names EQUAL arrays as equal — a refusal must not fabricate raggedness', async () => {
    // The evidence sentence is the whole `error` a region surfaces; claiming unequal lengths
    // over `a[2], b[2]` sends an operator to look for a fault that is not there.
    await expect(
      readColumn({
        id: 'fx',
        expect: 'table',
        structure: JSON_OPAQUE,
        store: blob({ n_entities: 2, a: [1, 2], b: [3, 4] }),
      }),
    ).rejects.toThrow(/`n_entities` is not an array(?!.*unequal length)/s)
  })
})
