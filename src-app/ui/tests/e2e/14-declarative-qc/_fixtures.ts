/**
 * The single-cell FIXTURE DATA the e2e specs seed with — the domain vocabulary that used to be
 * compiled into the server crate.
 *
 * The backend seed route (`POST /api/projects/{id}/_debug/seed`) is a GENERIC engine: it inserts
 * whatever artifacts a caller's `plan` describes and knows nothing about single-cell biology. All
 * of the subject matter therefore lives HERE, in the test data that drives it — the datatype ids,
 * the obs column names, the marker-gene symbols, the sample labels and the synthetic value ramps.
 * Adding a fixture for a different domain means writing a new plan next to this one; the server is
 * never touched.
 *
 * RELATIONSHIP TO THE FORMER RUST BUILDERS. These re-express the former `build_obs_payload` /
 * `seed_metric_columns` / `seed_plottable_inner` fixture builders. They are SEMANTICALLY
 * equivalent — same column names, same ramps, same row/column counts, same structural properties
 * the specs actually assert on — but NOT a byte-identical port; do not rely on the seeded bytes
 * matching what the Rust wrote. Two divergences, both verified against the deleted builders
 * (commit 1948b5f0^):
 *
 *  1. JSON TEXT. The Rust built the ramps as `f64` (`(i % 25) as f64`), so `serde_json` wrote
 *     `0.0, 1.0, …`; these are integral JS numbers, so `JSON.stringify` writes `0, 1, …`. The
 *     parsed VALUES are identical, and the derived f32 column blobs ARE bit-identical (small
 *     integers are exact in both) — but the JSON text, and therefore the blob's length and its
 *     content hash, differ.
 *  2. FLOAT PRECISION. The 2-D ring below computes in f64 and rounds once (`Math.fround`); the
 *     Rust computed the whole ring in f32 (`(i as f32) / (n as f32) * f32::TAU`, then `f32::cos`).
 *     Two different precisions, so the f32 lanes are not bit-identical. Spot-checked over the
 *     60-point ring: ~60% of lanes differ, by ≲ 4e-6 absolute on a ±10 coordinate range (1-2 f32
 *     ULP).
 *
 * That is the real tolerance, and it is well inside what the specs depend on: they assert on
 * column NAMES, cardinalities, category counts, orderings and non-degeneracy (e.g. "all values
 * are ≥ 0, so `max: -1` empties the keep-mask"), never on an exact float or an exact byte length.
 * A spec that ever needs an exact value should assert it against these functions' own output
 * rather than against a transcribed literal.
 */

/** The contributed datatype ids these fixtures materialize (DATA — `single-cell-types/manifest.yaml`). */
/** The member path the positions artifact writes inside its Zarr store. ONE literal for the whole
 *  test tier: a spec that needs to name the member imports this rather than spelling it, so a
 *  producer-side rename fails in one place. */
export const POSITIONS_MEMBER = 'embedding'

export const DT = {
  expression: 'single-cell/expression',
  anndata: 'single-cell/anndata',
  multimodal: 'single-cell/multimodal',
  qcReport: 'report/qc',
  metadataColumn: 'metadata-column',
  embedding: POSITIONS_MEMBER,
  clustering: 'clustering',
  cellSet: 'cell-set',
} as const

/** The Filter-shaped obs columns (`ui/cell-filter.yaml` reads any obs column). */
const FILTER_COLUMNS = ['nCount', 'nFeature', 'pct_mito', 'pct_ribo'] as const
/** The QC-shaped scanpy aliases (`ui/qc.yaml` canvas violins read these). */
const QC_ALIASES = ['total_counts', 'n_genes_by_counts'] as const

/** The per-cell CONTINUOUS metric ramps. All values are ≥ 0, so a `max: -1` range bound empties
 *  the client keep-mask for ANY column — deterministic for the live kept-count e2e. */
function metricRamps(nCells: number) {
  const pct_mito: number[] = []
  const pct_ribo: number[] = []
  const nCount: number[] = []
  const nFeature: number[] = []
  for (let i = 0; i < nCells; i++) {
    pct_mito.push(i % 25)
    pct_ribo.push(8 + (i % 18))
    nCount.push(1000 + i * 12)
    nFeature.push(400 + i * 4)
  }
  return { pct_mito, pct_ribo, nCount, nFeature }
}

/**
 * The obs.json payload `qc-10x.py` would emit: a wrapped columnar `/obs` slice carrying exactly
 * the columns BOTH declarative surfaces require — the Filter-shaped ones and the QC-shaped scanpy
 * aliases (`total_counts` == `nCount`, `n_genes_by_counts` == `nFeature`). Cells are split across
 * two samples so the per-sample violins/sliders/kept-counts have more than one group.
 */
export function obsPayload(nCells: number): Record<string, unknown> {
  const { pct_mito, pct_ribo, nCount, nFeature } = metricRamps(nCells)
  const id: string[] = []
  const ident: string[] = []
  for (let i = 0; i < nCells; i++) {
    id.push(`cell-${i}`)
    ident.push(i % 2 === 0 ? 'sampleA' : 'sampleB')
  }
  return {
    columns: ['id', 'ident', ...FILTER_COLUMNS, ...QC_ALIASES],
    n_cells: nCells,
    obs: {
      id,
      ident,
      nCount,
      nFeature,
      pct_mito,
      pct_ribo,
      // QC-shaped aliases (scanpy names) so the Compute-QC violins paint from seed.
      total_counts: nCount,
      n_genes_by_counts: nFeature,
    },
    // The marker symbols a real `qc-10x.py` run reports as having matched each percentage metric.
    matched_genes: { pct_mito: ['MT-CO1', 'MT-ND1'], pct_ribo: ['RPS12', 'RPL13'] },
  }
}

/** The per-metric dense-f32 `metadata-column` artifacts a real qc.10x run emits (one per computed
 *  metric). Values mirror `obsPayload`'s continuous columns. */
export function metricColumns(nCells: number): { name: string; values: number[] }[] {
  const { pct_mito, pct_ribo, nCount, nFeature } = metricRamps(nCells)
  return [
    { name: 'pct_mito', values: pct_mito },
    { name: 'pct_ribo', values: pct_ribo },
    { name: 'nCount', values: nCount },
    { name: 'nFeature', values: nFeature },
    // QC-shaped aliases, so the Compute-QC canvas violins have materialized columns too.
    { name: 'total_counts', values: nCount },
    { name: 'n_genes_by_counts', values: nFeature },
  ]
}

/** The OPAQUE `single-cell/expression` placeholder bytes (not a real matrix — a spec whose
 *  analysis must genuinely RUN pairs an obs-only seed with `seedRunnableExpression`). */
export function expressionPlaceholder(nCells: number): Record<string, unknown> {
  return { seed: DT.expression, cells: nCells }
}

// ── the fully-PLOTTABLE fixture (the Arrow-rewire e2e, TEST-19) ────────────────────────────────

export const PLOTTABLE_CELLS = 60
export const PLOTTABLE_GENES = 5
export const PLOTTABLE_CLUSTERING_COLUMN = 'leiden'

/** A 2-D embedding on a ring → a deterministic, visibly non-degenerate scatter. */
export function ringEmbedding(nCells = PLOTTABLE_CELLS): number[] {
  const out: number[] = []
  for (let i = 0; i < nCells; i++) {
    const t = (i / nCells) * Math.PI * 2
    out.push(Math.fround(Math.cos(t) * 10), Math.fround(Math.sin(t) * 10))
  }
  return out
}

/** A CSC expression matrix: gene `g` is expressed (value `g+1`) in cells where
 *  `cell % nGenes === g`, so each gene lights ~nCells/nGenes cells. */
export function cscExpression(nCells = PLOTTABLE_CELLS, nGenes = PLOTTABLE_GENES) {
  const indptr: number[] = [0]
  const indices: number[] = []
  const data: number[] = []
  for (let g = 0; g < nGenes; g++) {
    for (let c = 0; c < nCells; c++) {
      if (c % nGenes === g) {
        indices.push(c)
        data.push(g + 1)
      }
    }
    indptr.push(indices.length)
  }
  return { indptr, indices, data }
}

/** A content-addressed cell-set MASK: the first half of the cells, as u32 row ids. */
export function halfCellSetMask(nCells = PLOTTABLE_CELLS): number[] {
  return Array.from({ length: Math.floor(nCells / 2) }, (_, r) => r)
}

/** ONE categorical column (`leiden`, 3 clusters). `shape.columns` carries the column name+kind
 *  (mirroring the ingest column-catalog inference) so `catalog()` emits the composite
 *  `<artifactId>#leiden` key `categorical()` resolves. */
export function clusteringPayload(nCells = PLOTTABLE_CELLS): Record<string, unknown> {
  const leiden = Array.from({ length: nCells }, (_, i) => `${i % 3}`)
  return {
    columns: [PLOTTABLE_CLUSTERING_COLUMN],
    n_cells: nCells,
    obs: { [PLOTTABLE_CLUSTERING_COLUMN]: leiden },
  }
}


// ── artifact-model ITEM-25: Zarr-shaped seed fixtures ────────────────────────────────
//
// The `/read` Selection→Arrow endpoint is deleted (ITEM-12), so a seeded artifact is now
// read the way a real one is: byte ranges over `/data/{*member}` + a client-side decode
// keyed on the producer's declared `structure`. These builders emit that shape.
//
// The arrays are RAW (an empty codec chain after `bytes`) and UNSHARDED — the seed engine
// frames a member as JSON or as a little-endian typed array, and shuffle+gzip is neither.
// That is a fixture-authoring limit, not a reader limit: `zarrReader.test.ts` already
// proves the compressed + sharded path against bytes the PYTHON writer produced. What
// these fixtures exist to exercise is the layer above — member resolution, the declared
// kind, and the request SHAPE (chunk-granular ranges, one request per chunk).

/** How many elements one inner chunk of a seeded Zarr column holds. Small on purpose:
 *  the point of a multi-chunk fixture is that a read is observably MORE THAN ONE
 *  request, which is what makes progressive arrival testable at all. */
export const ZARR_FIXTURE_CHUNK = 16

/** `zarr.json` for a raw, unsharded Zarr v3 array chunked along dim 0. */
function zarrArrayMeta(
  shape: number[],
  dtype: string,
  chunk: number,
  attributes: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    zarr_format: 3,
    node_type: 'array',
    shape,
    data_type: dtype,
    chunk_grid: { name: 'regular', configuration: { chunk_shape: [chunk, ...shape.slice(1)] } },
    chunk_key_encoding: { name: 'default', configuration: { separator: '/' } },
    fill_value: 0,
    codecs: [{ name: 'bytes', configuration: { endian: 'little' } }],
    attributes,
  }
}

/** The seed members for ONE raw Zarr array at `path`: its `zarr.json` plus one file per
 *  chunk. A tail chunk is PADDED to the full chunk shape — Zarr chunks are always
 *  `chunk_shape` elements and `shape` is what bounds a reader, so a short tail file would
 *  make the reader read past the buffer. */
/**
 * ONE per-entity column, in the shape a REAL producer writes it.
 *
 * The faithful part is the member PATH: every single-column store the shared writer emits puts
 * its values under the constant `values`, and carries the column's real name only in `meta`.
 * Fixtures used to name the member after the column, which is a shape no producer ever emits —
 * so a reader that keyed on the member name looked correct here and collapsed every column on
 * an axis onto one key against real data.
 *
 * `axis` is declared, and that is load-bearing too: an artifact with no `structure` is `opaque`,
 * declares no axis, and is therefore invisible to every axis-scoped resolver — which is how a
 * seeded "annotated" dataset could offer zero criteria columns for its own matrix.
 */
export function entityColumnArtifact(
  name: string,
  values: number[],
  axis: string,
): {
  members: ({ name: string } & ({ encoding: 'json'; value: unknown } | { encoding: 'f32' | 'u32' | 'i64'; values: number[] }))[]
  structure: Record<string, unknown>
  meta: Record<string, unknown>
} {
  const n = values.length
  return {
    members: zarrArrayMembers(COLUMN_MEMBER_PATH, values, {
      encoding: 'f32',
      dtype: 'float32',
      attributes: { txr: { kind: 'numeric', name } },
    }),
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis,
      n,
      columns: [
        { path: COLUMN_MEMBER_PATH, name: COLUMN_MEMBER_PATH, kind: 'numeric', dtype: 'float32', shape: [n] },
      ],
      arrays: [],
    },
    meta: { name, dtype: 'float32', n, axis },
  }
}

/**
 * A single-column store holding a CATEGORICAL — the same shape {@link entityColumnArtifact}
 * produces for a numeric column (constant `values` member path, real name in `meta`), so the
 * criteria builder offers it through exactly the same route as the metric columns beside it.
 *
 * The point of it is `levels`: a categorical's level set is DECLARED by the producer, never
 * derived from the codes it happens to contain. Pass a level that NO code selects and the
 * declaration is observably distinguishable from the values — which is the whole basis of
 * TEST-57, since a picker populated by `unique(values)` cannot produce such a level and a picker
 * fed the declaration must.
 */
export function categoricalColumnArtifact(
  name: string,
  levels: readonly string[],
  codes: readonly number[],
  axis: string,
): {
  members: ({ name: string } & ({ encoding: 'json'; value: unknown } | { encoding: 'f32' | 'u32' | 'i64'; values: number[] }))[]
  structure: Record<string, unknown>
  meta: Record<string, unknown>
} {
  const n = codes.length
  return {
    members: zarrArrayMembers(COLUMN_MEMBER_PATH, [...codes], {
      encoding: 'u32',
      dtype: 'uint32',
      // `attributes.txr.levels` is what `readDeclaredLevels` reads — one `zarr.json`, no chunks.
      // That is the metadata-only route the picker takes, and seeding it here is what makes this
      // fixture exercise the real path rather than a shape that merely looks like it.
      attributes: { txr: { kind: 'categorical', name, levels: [...levels] } },
    }),
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis,
      n,
      columns: [
        {
          path: COLUMN_MEMBER_PATH,
          name: COLUMN_MEMBER_PATH,
          kind: 'categorical',
          dtype: 'uint32',
          shape: [n],
          levels: [...levels],
        },
      ],
      arrays: [],
    },
    meta: { name, dtype: 'uint32', n, axis },
  }
}

/** The entity axis this fixture module aligns its per-entity columns to. Named ONCE so the
 *  literal appears in a single place, and so the seed module can reuse it without repeating a
 *  token the domain-vocabulary guard counts. */
export const ENTITY_AXIS = 'cells'

/** The CONSTANT member path a single-column store writes under — the producer's own spelling. */
const COLUMN_MEMBER_PATH = 'values'

/**
 * ONE arbitrarily-named Zarr array member.
 *
 * EXPORTED (dimension-membership ITEM-21) for the one fixture shape the column/array builders
 * above cannot express: a membership INDEX BODY. `txr_zarr.Table.close()` writes that member
 * through `write_array` rather than through `numeric()`, deliberately — "its length is the
 * member COUNT, its values are positions into a DIFFERENT sequence (the axis), and offering it
 * in the column picker would offer the row numbers as a thing to colour by" — so it is neither
 * a `column` nor an `array` of the table that carries it, and no builder here models it.
 *
 * Exported rather than re-implemented in the seeder, so the chunking, the tail padding and the
 * `zarr.json` shape stay ONE implementation: a second copy would be the fixture that agrees
 * with the reader and disagrees with the producer, which is the failure an e2e exists to catch
 * rather than to reproduce.
 */
export function zarrArrayMembers(
  path: string,
  values: number[],
  opts: {
    encoding: 'f32' | 'u32' | 'i64'
    dtype: string
    chunk?: number
    width?: number
    attributes?: Record<string, unknown>
  },
): ({ name: string } & ({ encoding: 'json'; value: unknown } | { encoding: 'f32' | 'u32' | 'i64'; values: number[] }))[] {
  const width = opts.width ?? 1
  const rows = values.length / width
  const chunkRows = opts.chunk ?? ZARR_FIXTURE_CHUNK
  const shape = width === 1 ? [rows] : [rows, width]
  const members: ({ name: string } & ({ encoding: 'json'; value: unknown } | { encoding: 'f32' | 'u32' | 'i64'; values: number[] }))[] = [
    { name: `${path}/zarr.json`, encoding: 'json', value: zarrArrayMeta(shape, opts.dtype, chunkRows, opts.attributes) },
  ]
  const nChunks = Math.ceil(rows / chunkRows)
  for (let c = 0; c < nChunks; c++) {
    const slice = values.slice(c * chunkRows * width, (c + 1) * chunkRows * width)
    while (slice.length < chunkRows * width) slice.push(0) // pad the tail to a full chunk
    const key = width === 1 ? `${path}/c/${c}` : `${path}/c/${c}/0`
    members.push({ name: key, encoding: opts.encoding, values: slice })
  }
  return members
}

/** A Zarr artifact holding ONE 2-D `embedding` member — the shape `txr_columns.write_embedding`
 *  produces. Returns the seed members + the `structure` the artifact row declares. */
export function zarrEmbeddingArtifact(nRows = PLOTTABLE_CELLS, chunkRows = ZARR_FIXTURE_CHUNK) {
  const values = ringEmbedding(nRows)
  return {
    members: zarrArrayMembers(POSITIONS_MEMBER, values, {
      encoding: 'f32',
      dtype: 'float32',
      width: 2,
      chunk: chunkRows,
    }),
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: ENTITY_AXIS,
      n: nRows,
      columns: [],
      arrays: [{ path: POSITIONS_MEMBER, kind: 'numeric', dtype: 'float32', shape: [nRows, 2] }],
    },
    n_chunks: Math.ceil(nRows / chunkRows),
  }
}

/** A Zarr artifact holding ONE categorical column — the shape
 *  `txr_columns.write_metadata_column` produces for a pandas Categorical. The level set is
 *  DECLARED (D10), including one level that never occurs in the data. */
export function zarrClusteringArtifact(nRows = PLOTTABLE_CELLS) {
  const levels = ['0', '1', '2', 'NEVER-OBSERVED']
  const codes = Array.from({ length: nRows }, (_, i) => i % 3)
  return {
    levels,
    codes,
    members: zarrArrayMembers(PLOTTABLE_CLUSTERING_COLUMN, codes, {
      encoding: 'u32',
      dtype: 'uint32',
      attributes: { txr: { kind: 'categorical', name: PLOTTABLE_CLUSTERING_COLUMN, levels } },
    }),
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: ENTITY_AXIS,
      n: nRows,
      columns: [
        {
          path: PLOTTABLE_CLUSTERING_COLUMN,
          name: PLOTTABLE_CLUSTERING_COLUMN,
          kind: 'categorical',
          dtype: 'uint32',
          shape: [nRows],
          levels,
        },
      ],
      arrays: [],
    },
  }
}

/**
 * A CSC matrix artifact in the ONE vocabulary a producer emits: a `zarr_v3` store whose
 * `kind` is `sparse_csc` and whose three members are Zarr arrays
 * (`txr_csc.write_csc_zarr`). Returns the seed members + the `structure` the row declares.
 *
 * The arrays are raw + unsharded like the other seeded Zarr fixtures above (the seed engine
 * frames a member as JSON or as a little-endian typed array, and shuffle+gzip is neither).
 * That is a fixture-authoring limit, not a reader limit — the unit suite decodes the
 * compressed, sharded bytes the Python writer really produces. What this exists to exercise
 * is the layer above: the declared kind, member resolution, and the request SHAPE.
 */
export function cscArtifact(nRows = PLOTTABLE_CELLS, nCols = PLOTTABLE_GENES) {
  const csc = cscExpression(nRows, nCols)
  const indptr = { path: 'indptr', kind: 'numeric', dtype: 'int64', shape: [nCols + 1] }
  const indices = { path: 'indices', kind: 'numeric', dtype: 'uint32', shape: [csc.indices.length] }
  const data = { path: 'data', kind: 'numeric', dtype: 'float32', shape: [csc.data.length] }
  return {
    members: [
      ...zarrArrayMembers('indptr', csc.indptr, { encoding: 'i64', dtype: 'int64' }),
      ...zarrArrayMembers('indices', csc.indices, { encoding: 'u32', dtype: 'uint32' }),
      ...zarrArrayMembers('data', csc.data, { encoding: 'f32', dtype: 'float32' }),
    ],
    structure: {
      encoding: 'zarr_v3',
      kind: 'sparse_csc',
      axes: ['cells', 'genes'],
      shape: [nRows, nCols],
      nnz: csc.data.length,
      indptr,
      indices,
      data,
    },
  }
}

/**
 * ONE inline-utf8 string column, in the ONE layout the reader decodes — `split`: a `uint32`
 * `offsets` member and a `uint8` `values` member under a group (`txr_zarr.Table.string`).
 *
 * The `uint8` payload is written through the seed engine's `u32` framing, packed FOUR BYTES
 * PER WORD little-endian. That is not a trick: the engine frames a numeric member as a raw
 * little-endian buffer and never authors content, so packing the bytes into words reproduces
 * the byte stream a real writer emits, exactly. The alternative was a new `u8` variant on the
 * seed contract — a public-schema change, for a fixture.
 *
 * The values array is declared at the PADDED length rather than at the exact byte count: a
 * Zarr chunk is always `chunk_shape` elements, and the reader never uses that array's shape as
 * a byte count — every read is bounded by the OFFSETS. Declaring the padding is therefore the
 * honest description of what was written, and it keeps chunk and shape in step.
 */
export function zarrStringMembers(path: string, values: readonly string[]) {
  const encoder = new TextEncoder()
  const encoded = values.map(v => encoder.encode(v))
  const offsets: number[] = [0]
  for (const bytes of encoded) offsets.push(offsets[offsets.length - 1] + bytes.length)
  const byteLength = offsets[offsets.length - 1]
  const padded = Math.max(4, Math.ceil(byteLength / 4) * 4)
  const flat = new Uint8Array(padded)
  let at = 0
  for (const bytes of encoded) {
    flat.set(bytes, at)
    at += bytes.length
  }
  const words: number[] = []
  for (let i = 0; i < padded; i += 4) {
    words.push(flat[i] | (flat[i + 1] << 8) | (flat[i + 2] << 16) | (flat[i + 3] << 24))
  }
  return [
    {
      name: `${path}/offsets/zarr.json`,
      encoding: 'json' as const,
      value: zarrArrayMeta([offsets.length], 'uint32', offsets.length),
    },
    { name: `${path}/offsets/c/0`, encoding: 'u32' as const, values: offsets },
    {
      name: `${path}/values/zarr.json`,
      encoding: 'json' as const,
      value: zarrArrayMeta([padded], 'uint8', padded),
    },
    { name: `${path}/values/c/0`, encoding: 'u32' as const, values: words },
  ]
}

/**
 * A single-column store holding TEXT — the shape `write_metadata_column` produces for a string
 * column, and the shape an axis KEY artifact is.
 *
 * The member path is the constant `values` every single-column store writes under, and the
 * column's real name rides in `meta` — the same faithfulness `entityColumnArtifact` documents,
 * for the same reason.
 */
export function textColumnArtifact(name: string, values: readonly string[], axis: string) {
  return {
    members: zarrStringMembers(COLUMN_MEMBER_PATH, values),
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis,
      n: values.length,
      columns: [
        {
          path: COLUMN_MEMBER_PATH,
          name: COLUMN_MEMBER_PATH,
          kind: 'string',
          layout: 'split',
          n: values.length,
        },
      ],
      arrays: [],
    } as Record<string, unknown>,
    meta: { name } as Record<string, unknown>,
  }
}

/** The same positions fixture under the app's NEUTRAL vocabulary.
 *
 *  The house rule recorded in `domain-baseline.json` is that a shared helper carries ZERO
 *  domain tokens, because one token there is a token in every spec that imports it. A
 *  consumer that needs "an artifact carrying plottable positions" should not have to spell a
 *  domain noun to ask for one, so the alias lives HERE — in the file that already defines the
 *  fixture and is already baselined for it — and the consumers stay at zero. */
export const positionsArtifact = zarrEmbeddingArtifact

/**
 * The SAME plottable artifact with a DECLARED component count of `width` — the fixture for
 * "declares more than two dimensions, and is therefore not offered".
 *
 * § Coordinates narrows its offer to `dims: 2`, because the pane draws a picture in two axes
 * and a decomposition declaring fifty components does not name which two were meant. This
 * builds one of those: the same datatype, the same capability, the same axis, differing ONLY
 * in the declared width — which is what makes it a controlled fixture rather than a second
 * shape that might be excluded for some other reason.
 */
export function wideComponentsArtifact(nRows: number, width = 50) {
  const values: number[] = []
  for (let i = 0; i < nRows; i++) {
    for (let c = 0; c < width; c++) values.push(Math.fround(Math.sin((i + c) / 7)))
  }
  return {
    members: zarrArrayMembers('components', values, { encoding: 'f32', dtype: 'float32', width }),
    structure: {
      encoding: 'zarr_v3',
      kind: 'table',
      axis: ENTITY_AXIS,
      n: nRows,
      columns: [],
      arrays: [{ path: 'components', kind: 'numeric', dtype: 'float32', shape: [nRows, width] }],
    },
    n_chunks: Math.ceil(nRows / ZARR_FIXTURE_CHUNK),
  }
}

/** The DATATYPE ID of the positions fixture above, under the same neutral name — so a helper
 *  or spec that seeds positions never has to spell the domain id to say which kind it means.
 *  The id itself is the lattice's word and stays here, beside the fixture it belongs to. */
export const DT_POSITIONS = DT.embedding

/**
 * The one seeded numeric ramp whose values reach 0, DERIVED from the ramp data rather than spelled.
 *
 * A spec that fills a `max = 0` range bound needs the one column for which that bound keeps a
 * NON-EMPTY set of rows; against any other seeded ramp the oracle degenerates to `[]` and the
 * assertion passes for any reason at all. Naming it here, from the data, does two things a literal
 * in the spec cannot: it keeps the spec free of this module's vocabulary, and it re-derives the
 * premise if the ramps are ever re-seeded instead of leaving a stale name that still type-checks.
 *
 * Throws when the premise no longer holds — a spec that pins a subject must fail loudly, not
 * silently pick a different one.
 */
export const RAMP_REACHING_ZERO: string = (() => {
  const ramps = metricRamps(64) as unknown as Record<string, number[]>
  const reaching = Object.keys(ramps).filter(k => ramps[k].some(v => v <= 0))
  if (reaching.length !== 1) {
    throw new Error(
      `_fixtures: expected exactly ONE seeded ramp reaching 0, got [${reaching.join(', ')}]. ` +
        'The regression spec pins its subject column on there being exactly one.',
    )
  }
  return reaching[0]
})()
