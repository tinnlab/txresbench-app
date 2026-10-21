# P2 datatype-system — R1 vs R2 convergence diff

## Substantively new in r2 (not in r1)
- **Ingest + converter model (r2 ITEM-11: `IngestSpec` + `ConverterRef[]`).** Datatypes declare how
  an uploaded file becomes their type (`.h5ad → single-cell/anndata` via a sandbox convert-to-Zarr,
  or kerchunk-virtualize) and carry a Galaxy-style **implicit converter graph** between types
  (near-term: the one HDF5→Zarr converter; the general graph a declared seam). r1 has no
  converter/ingest-spec concept at all (it treats `.h5ad→Zarr` purely as P3 compute). Genuinely new
  datatype-descriptor surface with product consequences.
- **Explicit tiered data-access routing as a datatype property (r2 ITEM-9).** A datatype declares
  which of Tier-1 (authed range + client decode, the default) / Tier-2 (layout-slice) / Tier-3
  (precompute-as-analysis) its storage supports; the data API picks. r1 folds tiers into P1; r2
  makes tier-support a first-class descriptor field.
- **Stronger table-ownership stance:** r2 decides the single `artifacts` table is **owned by P2's
  `modules/datatype`** (merging P1's `analysis_results`); r1 keeps it co-owned (P2 typed columns, P1
  physical columns, one shared migration). A real cross-part ownership decision that collides with
  both P1 plans.

## Substantively new in r1 (not in r2)
- Nothing substantive. r1's `capabilities` vocabulary (ITEM-12), abstract-vs-concrete `abstract:
  bool` decision, and `SelectorMapping` are all present in r2 in equivalent form (capabilities on
  the descriptor, `SelectorMap`, seed lattice). r1's items are finer-grained slices of the same
  design, not new work.

## Shared substance
Both derived the same open type system: a `Datatype` descriptor self-registering via
`#[distributed_slice(DATATYPES)]` (mirroring `STUDY_EXTENSIONS`), a boot-built **subtyping lattice**
with `is_a`/ancestors + cycle/orphan/dup validation as the compatibility engine, a **type-match
resolver** (`matches(selector, datatype)` + `available_for`) driving both analysis-availability
gating and artifact-ref pickers, the **unified typed-artifact model** (`dataset ≡ analysis-output ≡
typed artifact`; source vs derived via `produced_by`/`source`), **storage layouts keyed on LAYOUT
not domain** (`ChunkedDense`/`ChunkedSparse{CSC|CSR}`/`ColumnarTable`/`Chunked1d`) with single-cell
un-privileged, a **layout slicer seam** (ship sparse+dense server-slicing, rest via Tier-1/columnar
client decode), **viewers-per-datatype dispatch resolved up the lattice** (P2 owns the mapping/
`ViewerRef`, P7 owns renderers — co-design to avoid churn), **multi-file = one merkle content hash /
multi-output = N artifacts** (produce-atomically/consume-individually), `datatype_id` as a
**code-registered validated string (no DB enum/FK)** with graceful "unknown datatype" degradation,
the **`GET /api/datatypes` + type-filtered artifacts query** REST surface, a **runtime-derived FE
mirror** (no hand-maintained TS union), the **`dataset` stub → source-artifact migration**, and the
same seed lattice (`data`←`tabular`←`matrix`←`single-cell/anndata` + embedding/clustering, others as
open later entries). Risks match: P1/P2 catalog double-ownership (both flag it HIGH), ViewerRef churn
with P7, FE mirror drift, open-id-vs-sqlx integrity.

## Verdict
VERDICT: DIVERGED — needs r3 (r2 adds ingest/converter model + table-ownership stance)
