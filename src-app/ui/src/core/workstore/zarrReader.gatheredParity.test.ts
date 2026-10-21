// **INV-3 — THE CLIENT CANNOT TELL.**
//
// This is the acceptance test for the design's central claim: a virtual (gathered) artifact
// is served as a synthetic Zarr store, and `ZarrStore`/`readColumn`/`WorkbenchStreamingSource`
// are untouched, so a client read path produces the SAME result against a gathered artifact
// as against a real one.
//
// ## Why it is shaped this way, and what would make it worthless
//
// The weaker test — "the synthetic store returns well-formed zarr" — is a server-side
// assertion about output shape. It would pass against a gather that returned the wrong rows,
// against one that ignored its row vector, and against a reader that had been quietly taught
// about gathered artifacts. None of those are INV-3.
//
// So:
//
// * **The reader is UNMODIFIED.** This file imports `openZarrArray` and `memoryStore` from
//   `zarrReader.ts` exactly as the existing suite does. If satisfying this test ever requires
//   editing the reader, INV-3 is false and that is the finding — not a thing to work around.
// * **The bytes are REAL, and `stored/` is now what the WRITER emits.** `stored/` is a
//   `cyto_zarr`-produced column in the production chain — `sharding_indexed[ bytes,
//   numcodecs.shuffle, gzip ]` — copied verbatim; `gathered/` is produced by the Rust gather
//   reading the DECODED bytes of an equally real, shuffled source
//   (`server/tests/workstore/gathered_fixture_test.rs`). It used to be an uncompressed,
//   unsharded column built by hand in Rust, recorded as a scope limitation and passed over —
//   and that simplification hid a design defect for rounds, because the gather only ever
//   worked on the one encoding no producer writes. The claim is therefore now *gathered
//   against stored in the encoding production uses*. Generating the gathered store in
//   TypeScript was refused: it would test a reimplementation rather than the gather.
// * **The fixture cannot silently go stale.** That same Rust test regenerates the bytes on
//   every run and FAILS if the committed fixture differs, so a future gather change cannot
//   pass parity against last month's output.
// * **The two stores differ in ENCODING and in how the bytes were produced.** `stored/` is
//   sharded, shuffled and gzipped; `gathered/` is the uncompressed synthetic store, produced
//   by `gather_chunk` pulling the same values out of a SHUFFLED source through a non-identity
//   row vector. A gather that ignored its vector would emit the shuffled order and fail here.
//   That the two decode identically DESPITE different encodings is the whole of INV-3.
//
// The comparison is VALUES, DTYPE and LENGTH — not bytes. Comparing bytes would pass for two
// stores that are identical files and prove nothing about decoding; the claim is about what
// the client ends up holding.

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { beforeEach, describe, expect, it } from 'vitest'

import {
  asZarrTable,
  parseStructure,
  readCategoricalColumn,
  readNumericColumn,
  resolveMember,
  __resetArtifactArrayCache,
} from './artifactReader'
import { memoryStore, openZarrArray, type ZarrStore } from './zarrReader'
import type { ZarrTypedArray } from './zarrCodecs'

/**
 * A decoded column as plain numbers, read through the API every arm of `ZarrTypedArray`
 * shares: `length` plus indexing.
 *
 * Deliberately not the built-in array-conversion helper, and the reason is a real property
 * of the reader rather than a lint detour. `ZarrTypedArray` is a UNION that includes
 * `BigInt64Array`/`BigUint64Array`, whose elements are `bigint`, so no single overload of
 * that helper spans it — the call genuinely does not match the reader's signature (TS2769).
 * The first version of this test assumed number-valued arrays; the type system caught that,
 * and suppressing it with a cast would have hidden a real imprecision in what the
 * comparison means.
 *
 * `Number(...)` is the deliberate normalisation: this fixture is `float32`, so it is exact
 * here, and stating the conversion makes the comparison's semantics explicit rather than
 * accidental. A future fixture on a 64-bit integer dtype would need to compare bigints
 * directly rather than round-trip them through `Number` — which is precisely the decision
 * this helper forces someone to notice instead of silently getting wrong.
 */
function values(a: ZarrTypedArray): number[] {
  const out: number[] = []
  for (let i = 0; i < a.length; i++) out.push(Number(a[i]))
  return out
}

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '__fixtures__', 'gathered')

/** Load one fixture subtree into the `{ storePath -> bytes }` map `memoryStore` takes. */
function loadStore(which: string): ZarrStore {
  const root = join(ROOT, which)
  const files = new Map<string, Uint8Array>()
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else files.set(relative(root, full).split(sep).join('/'), new Uint8Array(readFileSync(full)))
    }
  }
  walk(root)
  return memoryStore(files)
}

/**
 * A fixture store's DECLARATION, read from its own root group node.
 *
 * This is what ingest records as the artifact row's `structure` — `attributes.cyto`,
 * verbatim — so reading it here is reading the same object `parseStructure` is handed in
 * production, rather than a hand-written stand-in.
 */
function declarationOf(which: string): unknown {
  const raw = readFileSync(join(ROOT, which, 'zarr.json'), 'utf8')
  return JSON.parse(raw).attributes?.cyto
}

/**
 * Open one fixture store's single member THROUGH THE ARTIFACT READER'S OWN GUARDS.
 *
 * ── WHY THIS FUNCTION EXISTS, AND WHAT ITS ABSENCE HID ────────────────────────────────
 *
 * These tests used to call `openZarrArray(loadStore(...), '')` — the zarr decoder, addressed
 * at the store ROOT. That bypasses all three of the guards a real client passes on its way
 * to a member: `parseStructure` (which throws when the declaration names no `encoding`),
 * `asZarrTable` (which requires `encoding === 'zarr_v3'` and `kind === 'table'`) and
 * `resolveMember` (which throws on an empty `columns[]`). So it proved the DECODER is
 * codec-indifferent — which was never the risk — while being cited for the claim that the
 * artifact READER is.
 *
 * The gathered artifact declared none of those three things and served its array at the
 * root, and every assertion in this file passed anyway. Entering here is what makes the
 * parity claim about the path a client actually takes.
 */
function openThroughReader(which: string) {
  const structure = parseStructure(which, declarationOf(which))
  const table = asZarrTable(which, structure)
  const member = resolveMember(which, table)
  return openZarrArray(loadStore(which), member.path)
}

describe('INV-3 — a gathered artifact is indistinguishable from a stored one', () => {
  it('decodes to the same values, dtype and length through the UNMODIFIED reader', async () => {
    const stored = await openThroughReader('stored')
    const gathered = await openThroughReader('gathered')

    // NON-VACUITY. Every equality below would hold trivially for two empty or failed reads,
    // which is exactly how an acceptance test comes to certify nothing. Pin the real shape
    // first, independently of the comparison.
    expect(stored.length).toBe(10)
    expect(stored.dtype.name).toBe('float32')

    const a = await stored.readAll()
    const b = await gathered.readAll()

    expect(b.length).toBe(a.length)
    expect(gathered.dtype.name).toBe(stored.dtype.name)
    expect(values(b)).toEqual(values(a))

    // And the values are the ones actually expected — not merely equal to each other. Two
    // identically-wrong reads are equal.
    expect(values(a)).toEqual([10.5, 20.25, 30.125, 40, 50.5, 60.25, 70.125, 80, 90.5, 100.25])

    // …and the same claim through the READER's own column entry point, which is what a
    // consumer calls: `parseStructure -> asZarrTable -> resolveMember -> readNumericColumn`
    // over each store's own declaration. The block above proves the decoder agrees; this
    // proves the path a caller actually takes agrees, which is the thing INV-3 asserts.
    const readThrough = async (which: string) =>
      readNumericColumn(which, parseStructure(which, declarationOf(which)), undefined, {
        store: loadStore(which),
      })
    expect([...(await readThrough('gathered'))]).toEqual([...(await readThrough('stored'))])
  })

  it('spans several chunks, so the cross-chunk path is exercised', async () => {
    const gathered = await openThroughReader('gathered')
    // 10 elements at 4 per chunk = 3 chunks, the last one partial. A single-chunk fixture
    // could not catch a cursor that resets per chunk, an off-by-one at a boundary, or a
    // trailing chunk that is not padded to full width.
    expect(gathered.chunkCountFor(0, gathered.length)).toBeGreaterThanOrEqual(3)
  })

  it('reads a WINDOW across a chunk boundary identically', async () => {
    // The boundary is where a gather most plausibly goes wrong while a whole-column read
    // still looks right: chunk 0 ends at element 4, so [2, 7) straddles two chunks.
    const stored = await openThroughReader('stored')
    const gathered = await openThroughReader('gathered')
    const a = await stored.read(2, 7)
    const b = await gathered.read(2, 7)
    expect(values(b)).toEqual(values(a))
    expect(values(b)).toEqual([30.125, 40, 50.5, 60.25, 70.125])
  })
})

// **ITEM-24 — the gathered-stride hypothesis, tested rather than asserted.**
//
// The claim: progress needs no gathered-specific stride, because `BYTES_PER_ROW`
// (`workbenchStreamingSource.ts`) is keyed on the CHANNEL KIND — `continuous`, `categorical`,
// `positions`, `pointIds` — and never on how the server produced the bytes. If a gathered
// artifact is indistinguishable at the zarr layer, every input to a stride computation is
// identical and so is its output.
//
// "The code should apply unchanged" is a prediction. This is the assertion: every property a
// stride/progress computation reads is compared between the two stores, and they must agree
// exactly. If a future change made a gathered array declare a different dtype width, chunk
// geometry or length, this goes red — which is the point, since that is precisely when a
// gathered-specific stride WOULD become necessary.
//
// ── RE-SCOPED when the fixture moved to the writer's encoding ─────────────────────────────
//
// This block used to assert that CHUNK GEOMETRY was identical too, and it passed — because
// the old hand-built `stored/` was chunked at the virtual array's own chunk size. That
// equality was a property of the FIXTURE, not of gathering: a real column chunks at the
// writer's 4096 and a virtual array declares its own (DEC-15), so the two genuinely differ
// and always would have.
//
// So the assertion is inverted rather than deleted: the geometries must DIFFER (or this
// fixture has drifted back into the simplification that hid a design defect), and every
// property a stride/progress computation actually reads must agree ANYWAY. That is a
// stronger statement than the one it replaces — progress inputs agree across two genuinely
// different encodings and chunkings — and it is why the ITEM-24 dissolve survives the
// fixture change instead of being carried credit from a fixture that no longer exists.
describe('ITEM-24 — progress inputs are identical, so the existing stride path applies', () => {
  it('exposes the same dtype width and length, across DIFFERENT chunk geometry', async () => {
    const stored = await openThroughReader('stored')
    const gathered = await openThroughReader('gathered')

    // NON-VACUITY: pin the real shape first, so the equalities below cannot be two
    // identically-broken reads agreeing with each other.
    expect(stored.dtype.itemSize).toBe(4)
    expect(stored.length).toBe(10)

    // The WIRE element width — the value a stride must be measured on. Getting this from the
    // decoded form instead is the historical bug: `categorical` once used 4 (decoded u32)
    // rather than 2 (wire u16), so a finished column reported exactly half its rows.
    expect(gathered.dtype.itemSize).toBe(stored.dtype.itemSize)
    expect(gathered.dtype.name).toBe(stored.dtype.name)

    // Length and per-row element count — the numerator and the row width.
    expect(gathered.length).toBe(stored.length)
    expect(gathered.rowElements).toBe(stored.rowElements)

    // Chunk geometry DIFFERS, and that is asserted so the fixture cannot quietly return to a
    // stored side chunked like the virtual one — the shape in which this whole block was
    // measuring itself. A stride is not a function of chunking, which is exactly why the
    // equalities above can hold while these do not.
    expect(stored.innerChunkElements).toBe(4096)
    expect(gathered.innerChunkElements).toBeLessThan(stored.innerChunkElements)
    expect(gathered.chunkCountFor(0, gathered.length)).toBeGreaterThan(
      stored.chunkCountFor(0, stored.length),
    )
  })

  it('reports the same byte count for the same read, which is the progress numerator', async () => {
    // Progress is `bytes / bytesPerRow`. The denominator comes from the channel kind; the
    // NUMERATOR comes from what actually arrives. Both stores must deliver the same number of
    // bytes for the same window, or progress would differ even with an identical stride.
    const stored = await openThroughReader('stored')
    const gathered = await openThroughReader('gathered')
    const a = await stored.read(0, stored.length)
    const b = await gathered.read(0, gathered.length)
    expect(b.byteLength).toBe(a.byteLength)
    expect(b.byteLength).toBe(10 * 4)
  })
})

// **THE SAME CLAIM, THROUGH THE REAL SERVE PATH — AND THROUGH THE CLIENT'S OWN PARSER.**
//
// Everything above reads bytes produced by calling `gather_chunk` directly. That proves the
// FUNCTION; it says nothing about the route, which adds fetching each source's shards,
// decoding them, verifying every source's key-sequence digest before any byte is fetched, and
// the ordering between those steps. A green test on a function is not evidence for a route.
//
// `__fixtures__/gathered/route/` is captured from `GET /artifacts/{id}/data/...` against a
// scene built from the PRODUCER's own emitted alignment and its two source datasets
// (`server/tests/workstore/gathered_chain_test.rs::the_route_reproduces_the_committed_parity_fixture`,
// which re-captures on every run and fails if the committed bytes drift). `structure.json`
// beside it is the ARTIFACT ROW's declaration, captured from the same run.
//
// ── WHY THE ROW'S `structure` IS IN THE FIXTURE AT ALL ────────────────────────────────
//
// The previous acceptance proof was a Rust integration test that asserted through the
// server's HTTP route and read `attributes.cyto.levels` itself. It never entered the layer
// where the defect lived: the creator wrote `{kind, axis, n, data_type, gathered_from}` —
// no `encoding`, no `columns[]`, no member — so `parseStructure` threw on its first line and
// no client path could reach the vocabulary the server had gone to the trouble of building.
// An end-to-end test is end-to-end only up to the end it actually reaches.
//
// So this drives `parseStructure → asZarrTable → resolveMember → readCategoricalColumn` over
// what the server actually serves, with a REAL `metadata-column` store beside it as the
// positive control. The control is the discriminator: if the gathered arm ever regresses to
// a shape the reader cannot take, the control still passes and the two diverge — where a
// suite reading both through a hand-rolled decoder would stay uniformly green.
describe('INV-3 through the real serve path, entered through the CLIENT reader', () => {
  beforeEach(() => __resetArtifactArrayCache())

  it('parses the ARTIFACT ROW’s declaration, resolves the member, and reads the labels', async () => {
    const declared = JSON.parse(readFileSync(join(ROOT, 'route', 'structure.json'), 'utf8'))

    // ── The three guards, each named, because each one is where C2 stopped ──────────
    const structure = parseStructure('route', declared)
    expect(structure.encoding).toBe('zarr_v3')
    const table = asZarrTable('route', structure)
    const member = resolveMember('route', table)
    expect(member.path).toBe('values')
    expect(member.kind).toBe('categorical')

    // …and the store really serves the member the declaration points at. A declaration that
    // named a member the route does not serve is the same defect wearing the other face.
    const store = loadStore('route')
    expect(await store.get(`${member.path}/zarr.json`)).not.toBeNull()

    const { codes, categories } = await readCategoricalColumn('route', structure, member.path, {
      store,
    })

    // NON-VACUITY first: a failed or empty read would satisfy any equality below.
    expect(codes.length).toBe(5)
    expect(categories.length).toBeGreaterThan(1)

    // ── THESE VALUES COME FROM A DERIVATION, NEVER FROM THE BYTES ────────────────
    //
    // Re-derive them with:
    //     python3 src/core/workstore/__fixtures__/gathered/derive_expected.py
    //
    // which reads the committed alignment and both sources and works in LABELS: each
    // source's stored codes through its OWN declared level list to a label, the row vector
    // and segment table to say which (source, row) each output row addresses, and the
    // unified vocabulary to turn that label back into a code. It never looks at the
    // captured bytes, at this assertion, or at the Rust gather. It also cross-checks the
    // `levels__group__<src>` tables the gather actually uses against the vocabulary — two
    // independent routes to one answer, which is what makes this an oracle.
    //
    // Its output, verbatim (`python3 …/derive_expected.py`, exit 0):
    //     unified_levels['group'] = ['g1', 'g2', 'g3', 'g4']
    //     row 0: segment 0 (ds-a) row 0 -> 'g2' -> 1
    //     row 1: segment 0 (ds-a) row 1 -> 'g1' -> 0
    //     row 2: segment 1 (ds-b) row 0 -> 'g3' -> 2
    //     row 3: segment 1 (ds-b) row 1 -> 'g4' -> 3
    //     row 4: segment 1 (ds-b) row 2 -> 'g2' -> 1
    //
    // It was NOT closed by pasting in what the route returned. The captured fixture is
    // re-captured on every run by `the_route_reproduces_the_committed_parity_fixture`, so
    // it proves the capture is CURRENT and says nothing about whether it is RIGHT; making
    // this line agree with it would turn INV-3 into a tautology that passes against any
    // gather — including the two that served wrong rows and wrong labels earlier in this
    // stage.
    expect(categories).toEqual(['g1', 'g2', 'g3', 'g4'])
    expect([...codes]).toEqual([1, 0, 2, 3, 1])

    // THE LABELS, which is the user-visible answer and the thing a code array alone cannot
    // be checked against. Rows 0 and 2 address source row 0 of DIFFERENT datasets, so a
    // gather that resolved a row without its segment gives the right count here and the
    // wrong biology.
    expect([...codes].map(c => categories[c])).toEqual(['g2', 'g1', 'g3', 'g4', 'g2'])
  })

  // **DEC-27 — A RUN THAT ACTUALLY DROPS A LEVEL, through the same four calls.**
  //
  // The capture above cannot exercise this: its vocabulary has no invented entry, so a client
  // reading it proves nothing about how absence reaches the browser. `route_dropping/` is the
  // `authority --authority ds-a` scene, whose unified vocabulary carries an APPENDED `NA` and
  // whose rows really point at it.
  //
  // The claim is end-to-end and was previously composed from three separate measurements —
  // the producer appends, the codes are in range, the server copies verbatim. Composed facts
  // agree until one of them moves. This asserts it once, through the path a client takes.
  it('serves a DROPPING run’s vocabulary, with the invented entry NAMED', async () => {
    const declared = JSON.parse(readFileSync(join(ROOT, 'route_dropping', 'structure.json'), 'utf8'))
    const structure = parseStructure('route_dropping', declared)
    const table = asZarrTable('route_dropping', structure)
    const member = resolveMember('route_dropping', table)
    const store = loadStore('route_dropping')

    const { codes, categories } = await readCategoricalColumn(
      'route_dropping',
      structure,
      member.path,
      { store },
    )

    // NON-VACUITY first — and the LENGTH is load-bearing here rather than ceremonial. The
    // first version of this fixture captured chunk 0 only; the reader zero-FILLED the missing
    // tail and returned 5 codes ending in a spurious `g1`, with no error anywhere. This
    // assertion is what caught it.
    expect(codes.length).toBe(5)
    expect(categories.length).toBe(3)

    // ── DERIVED, NOT READ OFF THE CAPTURE ───────────────────────────────────────
    //
    //     python3 src/core/workstore/__fixtures__/gathered/derive_expected.py \
    //         stage1_alignment_absence
    //
    // The oracle had to LEARN DEC-27 to answer this scene: it previously died on a label the
    // unified vocabulary lacked, which was the correct statement of the `-1` encoding and is
    // now stale. That is stage 1's rule applied to the derivation itself — *sort the guards
    // by whether their subject is the VALUE or the SCENARIO* — and the `-1` cross-check
    // beside it is a value-guard, so it stayed. Its output, verbatim (exit 0):
    //
    //     unified_levels['group'] = ['g1', 'g2', 'NA']
    //     missing_levels['group'] = 'NA'
    //     lookup tables agree with the vocabulary for all 2 sources
    //     segment_order = [1, 0]  (declared-order and array-index DISAGREE)
    //     row 0: segment 1 (ds-b) row 0 -> 'g3' (dropped) -> 'NA' -> 2
    //     row 1: segment 1 (ds-b) row 1 -> 'g4' (dropped) -> 'NA' -> 2
    //     row 2: segment 1 (ds-b) row 2 -> 'g2' -> 1
    //     row 3: segment 0 (ds-a) row 0 -> 'g2' -> 1
    //     row 4: segment 0 (ds-a) row 1 -> 'g1' -> 0
    //     EXPECTED (derived from labels) = [2, 2, 1, 1, 0]
    //
    // It reaches the answer through LABELS and the alignment's own declarations, never
    // through the served bytes or the lookup arrays the gather uses — and it cross-checks
    // those arrays against the vocabulary, which is the second independent route.
    //
    // The vocabulary arrives VERBATIM, invented entry included — the codes index into the
    // FULL list, so a server that filtered it would re-index every label after it.
    expect(categories).toEqual(['g1', 'g2', 'NA'])
    expect([...codes]).toEqual([2, 2, 1, 1, 0])
    expect([...codes].map(c => categories[c])).toEqual(['NA', 'NA', 'g2', 'g2', 'g1'])

    // …and WHICH entry is the invented one is DECLARED, not guessed. This is the whole point:
    // without it the browser shows a category literally spelled `NA`, indistinguishable from a
    // real level a dataset happens to spell that way — two states agreeing in the output,
    // which no assertion on the rendered value can separate.
    const array = await openZarrArray(store, member.path)
    expect(array.cyto?.missing_level).toBe('NA')
    expect(categories.indexOf(array.cyto?.missing_level as string)).toBe(2)

    // THE DISCRIMINATOR — the two captures must DISAGREE, or a reader that ignored
    // `missing_level` entirely would pass both and this test would be asserting the fixture's
    // coincidence rather than the code's behaviour.
    const plainDecl = JSON.parse(readFileSync(join(ROOT, 'route', 'structure.json'), 'utf8'))
    const plain = await openZarrArray(loadStore('route'), resolveMember('route', asZarrTable('route', parseStructure('route', plainDecl))).path)
    expect(plain.cyto?.levels).toHaveLength(4)
    expect(plain.cyto?.missing_level).toBeUndefined()
    expect(plain.cyto?.levels).not.toEqual(array.cyto?.levels)
  })

  // **THE POSITIVE CONTROL — a REAL `metadata-column` store, through the same four calls.**
  //
  // `stage1_alignment/sources/level_0_group.zarr` is the producer's own output, regenerated
  // and compared on every run by `stage1_fixture_drift_test`. It is what a gathered artifact
  // must be indistinguishable FROM, so reading it through the identical sequence is what
  // makes the gathered arm above a comparison rather than a solo assertion: if the reader
  // itself were broken, both would fail; if only the gathered wire shape regresses, exactly
  // one does.
  it('reads a REAL metadata-column store through the identical four calls', async () => {
    const root = join(
      fileURLToPath(new URL('.', import.meta.url)),
      '..', '..', '..', '..',
      'server', 'tests', 'fixtures', 'stage1_alignment', 'sources', 'level_0_group.zarr',
    )
    const files = new Map<string, Uint8Array>()
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else files.set(relative(root, full).split(sep).join('/'), new Uint8Array(readFileSync(full)))
      }
    }
    walk(root)
    const declared = JSON.parse(new TextDecoder().decode(files.get('zarr.json'))).attributes.cyto

    const structure = parseStructure('real', declared)
    const table = asZarrTable('real', structure)
    const member = resolveMember('real', table)
    expect(member.path).toBe('values')

    const { codes, categories } = await readCategoricalColumn('real', structure, member.path, {
      store: memoryStore(files),
    })
    // ds-a's own column, in its OWN (per-source) vocabulary — deliberately NOT the unified
    // one. The two disagreeing is what makes this a control and not a second copy of the
    // assertion above: a gather that served raw per-source codes would make them agree.
    expect(categories).toEqual(['g1', 'g2'])
    expect([...codes].map(c => categories[c])).toEqual(['g2', 'g1'])
  })
})
