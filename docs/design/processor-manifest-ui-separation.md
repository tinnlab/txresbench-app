# Processor manifest / UI separation

**Status:** design · **Date:** 2026-08-03

A processor package's `manifest.yaml` has accumulated presentation, domain data,
output forecasts, and dead keys. This design draws one line: the manifest declares
what the workbench needs to **load, enable and execute** an analysis; the view
specs own **everything a person sees**; and everything about produced data is read
from the **artifacts**, which already state it and are already verified.

## Why

Measured against the shipped tree and a real CELLxGENE dataset (3460 × 35477) in a
running deployment:

- **Presentation in the contract file.** `params.fields` is a form schema —
  `title: Count matrix`, `doc: The raw-count…`, `type: artifact-ref` — wrapped
  around a duplicate of `accepts`. Its only non-redundant content is the slot name.
- **Two forms, two panes, one analysis.** `AnalysisRunPanel` renders
  `params.fields`; the view renders `layout.regions`. The user gets `Run · qc.10x`
  *and* `Compute QC metrics`, same primary-button label, and the input is visible
  only in the pane they would never open. The view passes no `inputs`, so the host
  auto-resolves silently and **throws** when the candidate count is not exactly 1
  (`hostCtx.ts`: `found ${options.length}`).
- **Forecasts nothing checks.** `produces_annotations` enumerates output columns
  before the data exists. `single-cell/anndata` — an UPLOAD container — declared
  `pct_mito`/`pct_ribo`/`total_counts`/`n_genes_by_counts`, i.e. QC's outputs. Of
  its 9 declared annotations, **8 do not exist** in the real dataset, which instead
  carries **65** metadata columns the declaration never mentions. Every other type
  claim in the system is verified (the artifact stamps its kind; the conformance
  gate refuses a disagreeing stamp); these were not.
- **Domain knowledge in the loader file.** `^MT-|^mt-` appears **four times**
  across three files (manifest `defaults`, view `state` default, view
  `const.presets`, compute `DEFAULT_PATTERN_METRICS`). The comments call it
  "mirrors". Mitochondrial gene prefixes are not registration data.
- **Keys nothing reads.** `schedule.resources` is dropped at the launch site
  (`jobsCapability` rebuilds `{ class }`); `inStandardRecipe`/`recipeOrder` have
  zero consumers in either language; `contributes.views` points at
  `ui/AnnDataInspector.tsx`, which does not exist; the note about
  `single_cell_axis_overlays()` describes a function the Rust source says is
  deleted.
- **Closed lists over open models.** `classify_feature_type` is open by
  construction — "an unrecognized feature type maps to a sanitized modality of its
  own — NEVER dropped, NEVER folded into RNA" (INV-8) — and produces `rna`, `prot`,
  `hto`, `atac`, `crispr`, or any sanitized key. The QC view offers three:
  `[rna, prot, atac]`. An `hto` or `crispr` run has no correct answer, and the
  wrong one becomes the emitted column prefix.
- **An input that exists nowhere.** QC matches gene patterns against
  `adata.var_names` (`qc-10x.py:462`) — hardcoded, not a param, absent from the
  manifest and the view. On a CELLxGENE dataset the index is ENSEMBL and symbols
  live in `var["feature_name"]`, so `^MT-` matches zero genes and `pct_mito` is
  **0 with no error**. The genes axis carries 8 columns, ≥5 of them strings, and
  nothing structural distinguishes the one holding symbols.

## Invariants

1. **The manifest declares only what the workbench needs to load, enable and
   execute an analysis.** No labels, no help text, no field order, no form schema,
   no domain data, no forecast of produced columns.
2. **The view owns everything the user sees and selects, and declares its own
   option sources.** The manifest does not define, constrain, or supply the UI.
3. **One analysis renders into ONE pane.** Multiple UI files stack top to bottom in
   declaration order.
4. **What is launched is what was shown.** Every input the run consumes is visible
   in the form before Run, and passed explicitly; nothing is resolved invisibly
   between click and job.
5. **Facts about produced data are read from artifacts, never declared ahead of
   time.** An artifact states its own kind, axes and levels, and the conformance
   gate verifies that; a manifest may not restate it.
6. **A closed list may not stand in for an open set.** Where the data model admits
   arbitrary values (modalities, columns, feature types), the UI derives its
   options from the data.
7. **Upload formats are opaque.** A container that exists to be imported or
   exported is not analysable and declares no internal structure.

   *Amended 2026-08-04, after the first sentence proved too coarse to implement
   against.* Read literally, "declares no internal structure" was taken to include
   the container's `axes`, and removing them broke seven `dataset::supporting_*`
   integration tests: `dataset/routes.rs` validates a supporting file's axis against
   `reg.axes_for(dataset.datatype)`, and for an uploaded `.h5ad` that datatype **is**
   the container. Attaching a per-cell annotation CSV to an upload therefore 422'd —
   a real capability that exists precisely at upload time, before anything is parsed.
   The invariant is restated with the boundary made explicit:

   | an opaque container **may** declare | why it is not internal structure |
   |---|---|
   | `axes` (`name` + `key_label`) | its own dimension VOCABULARY — what a supporting file aligns to, resolvable before the bytes are read |
   | `ingest` (extensions, magic) | how the file is RECOGNISED on the way in, and named on the way out |
   | `input_requirements` | what a user must HAND OVER — a fact about the upload, not the contents |
   | `storage.file_layout` | how many files ARRIVE as one dataset (it gates `enforce_cardinality`) |
   | a dispatch-marker `capability` (e.g. `mtx-trio-target`) | a routing key the host resolves; asserts nothing about the bytes |

   | it **may not** declare | what the claim would be |
   |---|---|
   | `capabilities` describing contents (`sliceable`, `has-obs`, `has-var`) | that the bytes can be sliced / carry obs+var — untrue until an importer has run |
   | `storage.layout` other than `opaque_as_is` | the internal encoding (e.g. CSC-sparse) |
   | `schema` | the internal dimensions (`{cells, genes}`) |
   | `arrays` | the arrays inside the container |

   The dividing line is the **direction the claim faces**: everything in the first
   table is about the container's BOUNDARY (how it arrives, leaves, and is joined to);
   everything in the second is about its CONTENTS. Analysability is withdrawn by
   `extends: data/opaque` — never by withholding boundary facts. Conflating the two
   is what cost the feature above, and the invariant's original wording is what
   allowed it.

## Shape

**manifest.yaml** — per analysis: `id`, `category`, `title`, `description`,
`whenHint`, `examples`, `safety`, `appliesTo`, `consumes`, `produces`, `ui`, `run`
(`kind`/`runtime`/`entry`), `schedule.class`, `arch`, `methodsText`, `methods`.

- `appliesTo` replaces `accepts` + `when` + `params.fields`. It is a fact about the
  analysis ("QC applies to raw-count expression matrices"); availability is derived
  from it. Everything in it is required by definition, so no `required:` flag.
- `consumes` carries the graph edge that `accepts … required: false` was smuggling
  (chaining: "run QC first"), which was never an applicability condition.
- `ui: [ui/qc.yaml]` — the manifest names the FILES, saying nothing about their
  contents. This replaces the `ui/*.yaml` glob and the view→analysis back-pointer.
  No `ui:` key means no view, and the generic fallback form is then an explicit
  declared state.

**view_spec** — owns state, widgets, actions, canvas. No `analysis:` key (the
manifest declares the binding), no `layout.regions` (declaration order is the
layout). Inputs are `artifact_ref` widgets declaring their own `source`, passed
explicitly on `run_processor`.

**datatypes** — axes carry identity only (`name`, `key_label`); no annotation
lists. Upload formats (`single-cell/anndata`, `single-cell/matrix-mtx`) extend
`data/opaque` and declare no INTERNAL STRUCTURE — no contents-describing
capability, no non-opaque `storage.layout`, no `schema`. They **do** declare
their `axes`: see INV-7's amendment for why axis identity is a boundary fact
rather than internal structure. (This line read "and declare no axes" until
2026-08-04; that reading was implemented, broke seven `dataset::supporting_*`
tests, and was reverted in the code without the design being corrected.)

A per-column DISPLAY LABEL is the one presentation fact a datatype may still
carry — the optional `labels: { <column>: "<label>" }` lookup (DEC-4). It is not
a forecast and does not weaken INV-5: a lookup is silent for a column it does not
mention, so it can never assert that a column exists. It is a lookup precisely
because that is the property `axes[].annotations` lacked.

## Out of scope

Reworking the compute scripts' internals beyond the input contract; the generic
fallback form's rendering; migrating processors other than `qc`, `cell-filter`,
`anndata-import`, `single-cell-types`.
