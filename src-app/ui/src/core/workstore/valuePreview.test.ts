// valuePreview.test.ts — the bounded value-EXCERPT read (`previewColumnValues`).
//
// The property under test is not "it returns strings". It is WHAT IT COSTS, and the cost
// is the whole reason this entry point exists rather than a `.slice()` on
// `readCategoricalColumn`: that one returns `{codes, categories}` and reads the FULL code
// array to do it — 35,477 entries on a real import, to show five strings. A preview that
// pulls the whole column is not a preview, and on a five-row fixture the two are
// indistinguishable by any assertion about the VALUES. So every case below also asserts on
// the REQUESTS the read issued, through a store that records them.
//
// Fixtures are the Python writer's own bytes (`__fixtures__/zarr/table`, produced by
// `src-app/packages/_lib/txr_zarr.py`) and the oracle is `expected.json`, computed by
// the GENERATOR from its numpy inputs — never by this reader. A fixture the thing under
// test also defines proves only self-consistency.

import { describe, it, expect, beforeEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  __resetArtifactArrayCache,
  parseStructure,
  previewableColumn,
  previewColumnValues,
  type ArtifactStructure,
  type ZarrMember,
} from './artifactReader'
import { memoryStore, type ZarrStore } from './zarrReader'

const FIXTURES = join(fileURLToPath(new URL('.', import.meta.url)), '__fixtures__', 'zarr')

function loadTree(root: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else files.set(relative(root, full).split(sep).join('/'), new Uint8Array(readFileSync(full)))
    }
  }
  walk(root)
  return files
}

const TABLE_TREE = loadTree(join(FIXTURES, 'table'))

/** The declaration the WRITER stamped into the group's `zarr.json` — the same document
 *  `Table.close()` returns into the artifact row. Read from the store so these tests use
 *  the producer's vocabulary rather than one restated here. */
const TABLE_STRUCTURE = parseStructure(
  'table',
  (
    JSON.parse(new TextDecoder().decode(TABLE_TREE.get('zarr.json')!)) as {
      attributes: { txr: unknown }
    }
  ).attributes.txr,
)

/** The GENERATOR's oracle, computed from its numpy inputs. */
const EXPECTED = JSON.parse(readFileSync(join(FIXTURES, 'expected.json'), 'utf8')) as {
  table: {
    cat8: { levels: string[] }
    str: { n: number; values: string[] }
  }
}

/** A `ZarrStore` that RECORDS every key it is asked for. The request log is the
 *  assertion surface: "no data-array read" is a claim about requests, and inferring it
 *  from timing (or from the shape of the result) is exactly the inference that lets a
 *  full-column read pass on a small fixture. */
function recordingStore(tree: Map<string, Uint8Array>): ZarrStore & { keys: string[] } {
  const inner = memoryStore(tree)
  const keys: string[] = []
  return {
    keys,
    async get(path) {
      keys.push(path)
      return inner.get(path)
    },
    async getRange(path, start, length) {
      keys.push(path)
      return inner.getRange(path, start, length)
    },
    async getSuffix(path, length) {
      keys.push(path)
      return inner.getSuffix(path, length)
    },
  }
}

/** Every recorded key that is NOT a metadata document — i.e. a chunk of a data array.
 *  Zarr chunk keys are `c/<coords>` under the member path (`chunkKey`), so "everything
 *  that is not a `zarr.json`" is the honest complement and needs no knowledge of the
 *  separator or the rank. */
const dataReads = (keys: string[]): string[] => keys.filter(k => !k.endsWith('zarr.json'))

/** The single-column table declaration a metadata column artifact carries — one member,
 *  lifted VERBATIM out of the multi-member fixture, so the member's own declaration
 *  (kind, layout, shape, chunking, `n_levels`) is the producer's and the bytes it names
 *  are the producer's. */
function soleColumnStructure(path: string): ArtifactStructure {
  const columns = (TABLE_STRUCTURE as { columns?: ZarrMember[] }).columns ?? []
  const member = columns.find(m => m.path === path)
  if (!member) throw new Error(`fixture has no member "${path}" — the fixture changed shape`)
  return { encoding: 'zarr_v3', kind: 'table', columns: [member], arrays: [] } as ArtifactStructure
}

beforeEach(() => {
  // The opened-array cache is process-wide by design, so a suite sharing one module
  // instance would otherwise inherit the previous case's `zarr.json` fetches and every
  // request-count assertion below would measure the wrong thing.
  __resetArtifactArrayCache()
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// previewableColumn — the DECLARATION gate (what may be previewed at all)
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('previewableColumn', () => {
  it('names the sole member of a single-column table when its ENCODING carries text', () => {
    expect(previewableColumn(soleColumnStructure('cat8'))?.path).toBe('cat8')
    expect(previewableColumn(soleColumnStructure('str'))?.path).toBe('str')
  })

  it('refuses a NUMERIC member (DEC-3 — five numbers are not a summary of a column)', () => {
    expect(previewableColumn(soleColumnStructure('f32col'))).toBeUndefined()
  })

  it('refuses a MULTI-member table — a preview may not pick a column for the user', () => {
    // The multi-member fixture holds four columns, two of them text-valued. Choosing one
    // is the guess the surrounding controls exist to remove.
    expect(previewableColumn(TABLE_STRUCTURE)).toBeUndefined()
  })

  it('refuses everything that is not a `zarr_v3` table, without throwing', () => {
    // TOTAL over `unknown`: a caller holds a catalog row's RAW `structure` and must be
    // able to ask before parsing it. A declaration that will not parse previews nothing —
    // a determinate answer about the declaration, not a swallowed read failure.
    for (const declared of [
      undefined,
      null,
      'nonsense',
      [],
      {},
      { encoding: 'opaque', media_type: 'text/html' },
      { encoding: 'zarr_v3', kind: 'sparse_csc', axes: ['rows', 'cols'] },
      { encoding: 'zarr_v3', kind: 'table', columns: [] },
      { encoding: 'zarr_v3', kind: 'table', columns: [{ path: 'v' }] }, // no declared kind
    ]) {
      expect(previewableColumn(declared)).toBeUndefined()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// the CATEGORICAL arm — metadata only
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('previewColumnValues — a dictionary-encoded column', () => {
  it('excerpts the DECLARED level set and reads NOT ONE BYTE of the data array', async () => {
    const store = recordingStore(TABLE_TREE)
    const preview = await previewColumnValues('table', soleColumnStructure('cat8'), { store, limit: 3 })

    // The values are the writer's own levels, in dictionary order — the oracle is the
    // generator's, computed from the numpy inputs it encoded.
    expect(preview).toEqual({ values: EXPECTED.table.cat8.levels.slice(0, 3), source: 'levels' })

    // THE property. Every request is a metadata document; the codes were never touched.
    expect(dataReads(store.keys)).toEqual([])
    expect(store.keys).toEqual(['cat8/zarr.json'])
  })

  it('reports `source: "levels"` — a VOCABULARY excerpt, not the first rows (DEC-2)', async () => {
    const store = recordingStore(TABLE_TREE)
    const preview = await previewColumnValues('table', soleColumnStructure('cat8'), { store })
    expect(preview?.source).toBe('levels')
    // The level set is what the column CONTAINS, and it is not row order: `cat8` declares
    // a level the codes never use, and it survives into the excerpt. That is precisely why
    // this may not be rendered as "the first N values".
    expect(preview?.values).toContain('')
    expect(EXPECTED.table.cat8.levels).toContain('NEVER-OBSERVED')
  })

  it('costs NO request at all when the member row still inlines its levels', async () => {
    // The pre-`levels_digest` artifact shape. It is the cheap end of the same arm and must
    // not regress into a fetch just because the common case needs one.
    const store = recordingStore(TABLE_TREE)
    const structure = {
      encoding: 'zarr_v3',
      kind: 'table',
      columns: [{ path: 'cat8', kind: 'categorical', levels: ['x', 'y', 'z'] }],
    } as unknown as ArtifactStructure
    const preview = await previewColumnValues('table', structure, { store, limit: 2 })
    expect(preview).toEqual({ values: ['x', 'y'], source: 'levels' })
    expect(store.keys).toEqual([])
  })

  it('stringifies a non-string level rather than leaking a bool/number into a text excerpt', async () => {
    const store = recordingStore(TABLE_TREE)
    const structure = {
      encoding: 'zarr_v3',
      kind: 'table',
      columns: [{ path: 'cat8', kind: 'categorical', levels: [false, true] }],
    } as unknown as ArtifactStructure
    expect(await previewColumnValues('table', structure, { store })).toEqual({
      values: ['false', 'true'],
      source: 'levels',
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// the STRING arm — a bounded WINDOW, never the column
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('previewColumnValues — an inline-utf8 column', () => {
  it('excerpts the first values, exactly as the writer wrote them', async () => {
    const store = recordingStore(TABLE_TREE)
    const preview = await previewColumnValues('table', soleColumnStructure('str'), { store, limit: 5 })
    // The oracle is the generator's list, so a windowing bug that returned the WRONG five
    // strings (a mis-computed offset base is the classic one) fails here rather than
    // agreeing with itself.
    expect(preview).toEqual({ values: EXPECTED.table.str.values.slice(0, 5), source: 'rows' })
  })

  it('fetches only the chunks the WINDOW covers — strictly fewer than the whole column', async () => {
    // The cost claim, measured against the eager read of the same member over the same
    // bytes. Asserting "few requests" against a hardcoded number would pass for a reader
    // that got lucky with the fixture's chunking; comparing the two paths is the property.
    const windowed = recordingStore(TABLE_TREE)
    await previewColumnValues('table', soleColumnStructure('str'), { store: windowed, limit: 5 })

    __resetArtifactArrayCache()
    const eager = recordingStore(TABLE_TREE)
    const { openStringColumn } = await import('./artifactReader')
    const all = await (await openStringColumn('table', soleColumnStructure('str'), 'str', { store: eager })).readAll()
    expect(all).toHaveLength(EXPECTED.table.str.n)

    expect(dataReads(windowed.keys).length).toBeGreaterThan(0) // it did read SOMETHING
    expect(dataReads(windowed.keys).length).toBeLessThan(dataReads(eager.keys).length)
  })

  it('clamps a limit past the end of the column instead of over-reading', async () => {
    const store = recordingStore(TABLE_TREE)
    const preview = await previewColumnValues('table', soleColumnStructure('str'), {
      store,
      limit: EXPECTED.table.str.n + 1000,
    })
    expect(preview?.values).toHaveLength(EXPECTED.table.str.n)
  })
})

// ═══════════════════════════════════════════════════════════════════════════════════════
// what it REFUSES — and refuses without spending a request
// ═══════════════════════════════════════════════════════════════════════════════════════

describe('previewColumnValues — nothing to preview', () => {
  it('previews nothing for a numeric column, and asks for nothing (DEC-3)', async () => {
    const store = recordingStore(TABLE_TREE)
    expect(await previewColumnValues('table', soleColumnStructure('f32col'), { store })).toBeUndefined()
    expect(store.keys).toEqual([])
  })

  it('previews nothing for a multi-member table with no member named', async () => {
    const store = recordingStore(TABLE_TREE)
    expect(await previewColumnValues('table', TABLE_STRUCTURE, { store })).toBeUndefined()
    expect(store.keys).toEqual([])
  })

  it('honours a NAMED member inside a multi-member table', async () => {
    const store = recordingStore(TABLE_TREE)
    const preview = await previewColumnValues('table', TABLE_STRUCTURE, { store, member: 'cat8', limit: 2 })
    expect(preview).toEqual({ values: EXPECTED.table.cat8.levels.slice(0, 2), source: 'levels' })
    expect(dataReads(store.keys)).toEqual([])
  })

  it('THROWS on a named member the artifact does not declare — a caller bug, not an absence', async () => {
    const store = recordingStore(TABLE_TREE)
    await expect(
      previewColumnValues('table', TABLE_STRUCTURE, { store, member: 'no_such_column' }),
    ).rejects.toThrow(/no member "no_such_column"/)
  })

  it('previews nothing at limit 0, without a request', async () => {
    const store = recordingStore(TABLE_TREE)
    expect(await previewColumnValues('table', soleColumnStructure('cat8'), { store, limit: 0 })).toBeUndefined()
    expect(store.keys).toEqual([])
  })

  it('PROPAGATES a read failure rather than reporting "nothing to preview"', async () => {
    // The two are different facts and only one of them licenses a caller to stay silent.
    // A store whose metadata is gone (the shape a GC-ed blob takes) must not read as an
    // artifact that declares no text column.
    const gutted = new Map(TABLE_TREE)
    gutted.delete('cat8/zarr.json')
    await expect(
      previewColumnValues('table', soleColumnStructure('cat8'), { store: memoryStore(gutted) }),
    ).rejects.toThrow(/cat8\/zarr\.json/)
  })
})
