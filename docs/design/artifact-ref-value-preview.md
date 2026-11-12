# Value preview for a selected column

## Why

A gene-names picker on a CELLxGENE-derived dataset offers, among others:

    genes_index        ENSG00000198804, ENSG00000198888, …
    feature_name       MT-CO1, MT-ND1, ACTB, …

The names do not say which is which. A user who does not know that `var.index` holds
ENSEMBL ids while symbols live in `feature_name` has no way to tell from the picker, and
picking wrong is SILENT: `^MT-` matches nothing against ENSEMBL ids, so `pct_mito` comes
out 0 for every cell and the run reports success. That is the original defect this whole
line of work exists to remove, reachable through a control that looks correct.

Three values make the distinction obvious to anyone, with no schema knowledge. The system
already holds those values; it is not showing them.

This is the same shape as the count-matrix labels fixed alongside it — two options rendered
as identical strings while `source_dataset_name` sat unused on the row. Having the
information and not displaying it is the defect.

## The change

After a column is SELECTED in an `artifact_ref` control, show a short sample of its values
beneath the control:

    Gene names from   [ feature_name          ▾ ]
                      e.g. MT-CO1, MT-ND1, ACTB, GAPDH, RPS12

## Where the values come from — two paths, very different costs

The producer stamps a dictionary-encoded column's level set into the store's own group
metadata (`_lib/txr_zarr.py:860`, `attrs["levels"]`), while the outputs manifest carries
only `levels_digest` + `n_levels` — the split that took the manifest from 2.1 MB to 55 KB.
So:

| column encoding | preview source | cost |
|---|---|---|
| `categorical` (dictionary-encoded) | `attributes.txr.levels` in the group `zarr.json` | ONE small metadata read; no data array |
| `string` (inline utf8) | first chunk of the array via `GET /api/artifacts/{id}/data/{member}` | one bounded byte-range read |
| `numeric` | out of scope — see DEC-3 | — |

On the shipped single-cell import that means every candidate except `genes_index` previews
from metadata alone.

## Decisions

### DEC-1: the preview is fetched ON SELECTION, never on render

A picker renders N candidates. Previewing all of them turns one control into N data-plane
reads, on every mount, for a question the user has not asked yet. The preview is a
consequence of choosing, not of looking.

**Basis:** the same reasoning that made the catalog epoch caused rather than polled. A
control that reads data to render is a control that reads data on every reconcile.

### DEC-2: a level sample is labelled as a SAMPLE, not as the first rows

For a dictionary-encoded column the levels are the VOCABULARY in dictionary order, not the
first N rows in row order. `MT-CO1, ACTB, …` is a fair sample of what the column contains
and is exactly what distinguishes ENSEMBL from symbols — but it is not "the first five
genes", and must not be presented as if it were.

The rendering says `e.g. …`. It does not say `first 5` or imply position. A display that
implies an ordering the data does not have is the class of confident-but-wrong surface
this work keeps removing.

### DEC-3: numeric columns get no value preview

A gene-names picker filtered to `text` cannot offer one. A future control that admits
numeric columns is better served by a summary (min/max/n) than by five sample values, and
that is a different feature. Out of scope rather than half-built.

### DEC-4: a preview failure is silent and non-blocking

The preview is an aid, not a gate. A failed read (missing blob, network, a store whose
metadata does not carry levels) renders NOTHING and does not surface an error, does not
block Run, and does not clear the selection. The dev data on this box already has a missing
blob that makes `workstore.gc` abort its sweep — a preview must degrade past that.

It must NOT, however, render a stale preview for a different column: a pending or failed
read shows nothing rather than the previous value.

### DEC-5: `n_levels` is shown when it is free, and never substitutes for values

`n_levels` is already on the manifest entry and costs nothing. It separates
annotation-like (`feature_type`, 2 levels) from identifier-like (`feature_name`, ~35k) and
is worth showing. It CANNOT separate `genes_index` from `feature_name` — both are
identifier-like — which is the confusion that actually caused the defect. So it is
supplementary, never the preview itself.

## Surfaces to change

- **`core/render/ArtifactRefWidget.tsx`** — render the preview under the control when a
  value is bound. This is the widget that already had its sole-candidate arm corrected to
  show the BOUND value rather than the candidate; the preview attaches to the same bound
  value.
- **The data-plane port** — a `previewValues(artifactId, member, limit)` read. It belongs
  beside the existing `categorical()` / `valueColumn()` reads, but must NOT be built on
  `categorical()`: that returns `{codes, categories, length}` and reads the FULL code array
  (35k entries) to do it. A preview that pulls the whole column is not a preview.
- **The view-spec vocabulary** — decide whether the preview is implicit for every
  `artifact_ref` or opt-in per control (`preview: true`). Prefer implicit if the cost is
  metadata-only for the common case; a flag every author must remember is a flag most will
  not set. State the choice.
- **The shipped-form conformance tier** — the preview is a rendered surface, so it falls
  under P2 (every rendered control is honest). Add: a bound control shows a preview drawn
  from THAT column, and switching the selection replaces it rather than leaving the prior
  column's sample on screen.

## Acceptance

1. On the shipped QC view with `feature_name` selected, the preview shows gene SYMBOLS; with
   `genes_index` selected, it shows ENSEMBL ids. That single contrast is the feature.
2. Selecting a categorical column issues NO data-array read — asserted on the requests
   made, not inferred from timing.
3. Switching selection replaces the preview; a pending read shows nothing, never the
   previous column's values.
4. A preview read that fails leaves the form fully operable and Run unblocked.
5. Nothing is previewed before a selection exists.
