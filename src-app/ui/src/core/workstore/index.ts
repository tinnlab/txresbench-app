// Workstore data-plane client: a hand-written byte-Range fetch helper + typed JSON
// control-plane wrappers, plus the zero-dependency decoders that sit on top of them.
//
// There is ONE read surface — `GET /artifacts/{id}/data[/{*member}]` — and the client
// decodes (artifact-model ITEM-12, INV-1). Three layers, bottom-up:
//   `binaryClient.ts`   raw `ArrayBuffer` over a byte range.
//   `zarrReader.ts`     one Zarr v3 array: shard index → chunk ranges → typed views.
//   `artifactReader.ts` one ARTIFACT: dispatch on the producer-declared `structure`.
// `catalog.ts` is the JSON control plane (the artifact rows themselves).
//
// `arrowClient.ts` used to sit where `artifactReader.ts` does, fetching
// `/read?<selection>` and decoding Arrow-IPC. ITEM-12 deleted that endpoint and ITEM-24
// dropped `apache-arrow` + `zarrita` — no format library remains on either side of the
// wire.

export {
  byteRangeParam,
  ERR_NOT_CONFORMING,
  ERR_UNRESOLVABLE,
  fetchArtifactBytes,
  fetchArtifactBytesOrNull,
  fetchArtifactRange,
  suffixRangeParam,
  WorkstoreHttpError,
} from './binaryClient'
export type { ByteRange, SparseColumn } from './binaryClient'

// The byte source a pyramidal-raster reader consumes. `@ziee/viz`'s `loadOmeTiffPyramid`
// takes a byte length + an inclusive-span read and knows nothing else about storage; this
// is the one implementation of that seam over the artifact byte plane. See
// `artifactByteRangeSource.ts` for why the length is a parameter rather than a discovery.
export { artifactByteRangeSource, UnknownArtifactLengthError } from './artifactByteRangeSource'
export type { ArtifactByteRangeSource } from './artifactByteRangeSource'
export { getArtifact, getCatalog, listArtifacts } from './catalog'

// The ONE rule for "which member of a same-datatype group supplies its declarations",
// published here because it is shared by the workstore Artifacts pane and the dataset
// preview rollup — and, most importantly, must stay the same rule the SERVER's
// `artifact_summary_rows` applies. See `representative.ts`.
export { declaresSomething, preferredGroup, representativeOf } from './representative'

// The one vocabulary for "which dataset is this artifact's?" — published here because it
// is shared by THREE modules (the two artifact pickers in `workbench`, the Artifacts pane
// in `workstore`) and belongs to none of them. See `sourceDataset.ts` for why the words
// are shared while the grouping functions deliberately are not.
export {
  PROJECT_PRODUCED_LABEL,
  sharesSourceDataset,
  sourceDatasetGroupKey,
  sourceDatasetIds,
  sourceDatasetLabel,
  sourceDatasetNames,
  sourceDatasetsLabel,
} from './sourceDataset'
export type { SourceDatasetCarrier } from './sourceDataset'

// The one derivation of "what is this artifact called" — published here for the same reason
// and shared by the same kind of set: the lineage DAG's nodes, the artifact pickers' options,
// and a workbench `artifact` pane's tab. See `artifactLabel.ts` for why the two rival
// formatters that preceded it were a defect rather than a style difference.
export {
  artifactLabel,
  artifactLabelSegments,
  formatDims,
  formatRelativeTime,
  shortArtifactId,
  UNTYPED_ARTIFACT_LABEL,
} from './artifactLabel'
export type { ArtifactLabelParts } from './artifactLabel'
// The AMBIENT lookup that lets a surface holding only an artifact ID name it — fed by the
// fetches `catalog.ts` already performs, never by one of its own.
export {
  ARTIFACT_NAME_CACHE_MAX,
  artifactDisplayName,
  rememberArtifacts,
  subscribeArtifactNames,
  __resetArtifactNames,
} from './artifactNames'

// The TYPED read surface (ITEM-29). The entry point is reached as
// `ApiClient.Workstore.readColumn` — the api-client binding splices it into the generated
// client, so a call site needs no import from here at all. The types are exported for a
// caller that wants to name one (a `ColumnKind` parameter, a `ColumnFor<'table'>` field).
// The sibling dtype-keyed entry point (`readArray`) is deleted: it never acquired a
// production caller. The reader's own dtype coverage is unaffected and lives on
// `resolveDataType` / `readComplex` / `decodeFloat16` below.
export { readColumn, readColumnarTableChecked, WorkstoreTypeMismatch } from './typedRead'
export {
  decodeCountFor,
  decodeCounts,
  enableDecodeCounter,
  resetDecodeCounts,
} from './decodeCounter'
export type {
  ColumnFor,
  ColumnKind,
  JsonDocument,
  ReadColumnParams,
  WorkstoreByteReads,
  WorkstoreTypedReads,
} from './typedRead'

// The artifact-level read layer (ITEM-25) — what the viz/workbench read paths call.
export {
  __resetArtifactArrayCache,
  asSparseCsc,
  asZarrTable,
  classifyJsonPayload,
  declaredDims,
  declaredDimsForDisplay,
  DEFAULT_VALUE_PREVIEW,
  openStringColumn,
  parseStructure,
  previewableColumn,
  previewColumnValues,
  readCategoricalColumn,
  readJsonDocument,
  readNumericColumn,
  readOpaque,
  readPositions,
  readDeclaredLevels,
  readSparseColumn,
  readTable,
  resolveMember,
  assertMembershipOnParentAxis,
  readMemberIndex,
  streamGatheredNumericBytes,
  streamNumericBytes,
  streamPositionBytes,
  tableMembers,
  TEXT_VALUE_KINDS,
  UnsupportedArtifactStructure,
} from './artifactReader'
export type {
  ArtifactReadOptions,
  ArtifactStreamOptions,
  ArtifactStructure,
  CategoricalColumnData,
  ColumnarTableData,
  DecodedColumn,
  OpaqueStructure,
  PositionsData,
  SparseColumnData,
  SparseCscStructure,
  TableData,
  ValuePreviewData,
  ZarrMember,
  ZarrTableStructure,
} from './artifactReader'

// The ZERO-DEPENDENCY Zarr v3 reader (artifact-model ITEM-23) — `/data/{*member}` IS a
// Zarr store, so the client decodes. Exported here so a consumer that needs ONE array
// (rather than an artifact-level read) reaches it through the module's public surface.
// `zarrCodecs.ts` holds the pure byte layer and is re-exported from `zarrReader.ts`.
export {
  artifactStore,
  crc32c,
  decodeFloat16,
  decodeStringWindow,
  deinterleaveComplex,
  float16ToFloat32,
  inflate,
  memoryStore,
  openSplitStringColumn,
  openZarrArray,
  openZarrGroupAttributes,
  readCategorical,
  readComplex,
  readSplitStrings,
  resolveDataType,
  toUint16Codes,
  unshuffle,
  ZarrArray,
  ZarrFormatError,
} from './zarrReader'
export type {
  CytoArrayAttributes,
  ZarrArrayMetadata,
  ZarrArrayOptions,
  ZarrCategoricalColumn,
  ZarrChunkSlice,
  ZarrCodecSpec,
  ZarrCodeArray,
  ZarrComplexPair,
  ZarrDataType,
  ZarrRepresentation,
  ZarrStore,
  ZarrStringColumn,
  ZarrTypedArray,
} from './zarrReader'

// Expose the real data-plane readers on `window.__cyto_read` so an e2e can drive the
// ACTUAL shipped decode (byte ranges over `/data/{*member}` → the zero-dep decoders)
// against the real backend in the browser, with NO route mocking. Read-only testability
// seam, gated so it is tree-shaken OUT of a real release bundle (matching the backend's
// `cfg!(debug_assertions)` discipline): present under the Vite dev server
// (`import.meta.env.DEV`) AND under the e2e's production PREVIEW build (which sets
// `VITE_ENABLE_TEST_SEAMS=1`); a shipped release sets neither, so the seam is absent.
//
// Each entry takes the artifact's `structure` because dispatch is on the DECLARATION
// (ITEM-25); the e2e reads it off `GET /api/artifacts/{id}` like production does. The
// seam used to expose `sparse(id, col, mask)` — the `mask` argument is gone with `/read`,
// which resolved a row-subset artifact SERVER-side (INV-1 forbids that, and it had no
// production caller).
import { decodeCounts, enableDecodeCounter, resetDecodeCounts } from './decodeCounter'
import {
  parseStructure,
  readCategoricalColumn,
  readPositions,
  readDeclaredLevels,
  readSparseColumn,
  readTable,
} from './artifactReader'
import { artifactByteRangeSource } from './artifactByteRangeSource'
if ((import.meta.env.DEV || import.meta.env.VITE_ENABLE_TEST_SEAMS) && typeof window !== 'undefined') {
  ;(window as unknown as { __cyto_read?: unknown }).__cyto_read = {
    parseStructure,
    /**
     * DECODE counting (ITEM-11). `enable()` starts recording and clears; `counts()` snapshots
     * `{ "<artifact>|<member>": n }`.
     *
     * Exposed because the invariants this work turns on — "an encoding change fetches ONE
     * column, not a reload"; "positions are decoded ONCE per coordinate however many panes" —
     * are NOT observable from request counts: artifact bytes are served `immutable`, so a
     * repeated read usually issues no second request while still paying a full inflate +
     * unshuffle. A test that counted requests would read 1 for both the shared case and the
     * repeated one, and pass while the thing it protects is broken.
     */
    decodes: {
      enable: () => enableDecodeCounter(),
      reset: () => resetDecodeCounts(),
      counts: () => decodeCounts(),
    },
    /**
     * Resolve an artifact's OME-TIFF resolution pyramid over REAL byte ranges and report
     * what came back — the level shapes, the tile size, and a decoded level-0 tile.
     *
     * Here rather than on a `DataSource` on purpose: wiring `imagePixelSource()` into the
     * production data source is a separate, dependent item, and doing it early to make a
     * test convenient is exactly the scope creep that item exists to hold. This seam lets
     * an e2e drive the SHIPPED reader against a REAL artifact through the SHIPPED
     * transport, and observe the requests it makes, before that wiring exists.
     *
     * `byteLength` is the artifact row's `stored_bytes`; the caller reads it off
     * `GET /api/artifacts/{id}` exactly as production will.
     *
     * NOTE FOR A LATER READER: because this is the only reachable consumer, the seam
     * contract's clause about the pyramid being "fed to the dense image pane" is NOT covered
     * by anything here — the e2e proves the READER and the transport, not the render path.
     * That clause belongs to the item that wires `imagePixelSource()` into the production data
     * source, and a passing e2e here must not be mistaken for coverage of it.
     */
    omeTiffPyramid: async (id: string, byteLength: number) => {
      const { loadOmeTiffPyramid } = await import('@ziee/viz')
      const result = await loadOmeTiffPyramid(artifactByteRangeSource(id, byteLength))
      const tile = await result.pyramid[0].getTile({ x: 0, y: 0, selection: { c: 0 } })
      return {
        levels: result.pyramid.length,
        shapes: result.pyramid.map(level => level.shape),
        dtype: result.meta.dtype,
        tileSize: result.tileSize,
        interleaved: result.interleaved,
        tiled: result.tiled,
        levelSizes: result.meta.levels.map(level => [level.width, level.height]),
        tile: { width: tile.width, height: tile.height, bytes: tile.data.length },
        // a sum, so a test can tell a decoded tile from a zero-filled buffer
        tileChecksum: Array.from(tile.data as ArrayLike<number>).reduce(
          (total: number, value: number) => total + value,
          0,
        ),
      }
    },
    sparse: (id: string, col: number, structure: unknown) =>
      readSparseColumn(id, col, parseStructure(id, structure)),
    categorical: (id: string, structure: unknown, column?: string) =>
      readCategoricalColumn(id, parseStructure(id, structure), column),
    table: (id: string, structure: unknown) => readTable(id, parseStructure(id, structure)),
    /**
     * A progressive read, with every chunk arrival recorded. Exposed so an e2e can assert
     * — against the REAL backend, over real HTTP — that content becomes available IN
     * STAGES rather than in one blocking fetch. That is the specific regression deleting
     * the streaming route risks, and it cannot be observed from the resolved value alone:
     * `{positions}` looks identical either way. `resolvedAfter` records how many chunks
     * had already landed when the promise settled, so a reader that gathered everything
     * and fired the callbacks at the end would be distinguishable from one that yields.
     */
    positionsProgressive: async (id: string, structure: unknown) => {
      const chunks: { index: number; total: number; offset: number; length: number; t: number }[] = []
      const t0 = performance.now()
      let resolved = false
      const p = readPositions(id, parseStructure(id, structure), undefined, {
        onChunk: s => {
          chunks.push({
            index: s.index,
            total: s.total,
            offset: s.offset,
            length: s.values.length,
            t: performance.now() - t0,
          })
          if (resolved) throw new Error('a chunk arrived AFTER the read resolved')
        },
      })
      const result = await p
      resolved = true
      return { chunks, length: result.length, positions: Array.from(result.positions) }
    },
  }
}

// `TEXT_VALUE_KINDS` used to be DECLARED here and is now re-exported from
// `artifactReader.ts` (above) — the module that declares `ZarrMember.kind` in the first
// place. It moved because this barrel imports that module and not the other way round, so
// a reader implementing the union (`previewableColumn`) could not consult it from here.
// Published from this barrel either way: it is an internal encoding fact both workbench
// layers already depend on this module for, and no consumer's import path changes.
