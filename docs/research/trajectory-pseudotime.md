# Research spike — Trajectory / pseudotime analysis

Read-only investigation. **Nothing here is implemented.** The deliverable is this document
plus the GitHub DAG issues it justifies.

Scope: pick the method, decide the output kinds, enumerate the platform obligations, and —
the part that actually matters — define the **scientific-validity invariant** and the
reference-parity test that makes "it ran" insufficient.

Every scanpy fact below was verified against **installed source and a live run on scanpy
1.11.5**, plus the raw source at tags 1.8.0 / 1.9.0 / 1.10.0 / 1.11.0 / 1.12.4. Where the
scanpy *documentation* is wrong, this doc says so and follows the source.

---

## 0. Executive summary

| Question | Answer |
|---|---|
| Method | **scanpy PAGA** (cluster-level abstracted graph) + **scanpy DPT** (per-cell diffusion pseudotime), as **two analyses in one package** |
| Library | `scanpy` + `igraph` — **both already in the sandbox rootfs**. Zero new dependency, zero new asset, zero download. |
| Graph output | `graph/attributed` — **the already-declared, never-produced open kind**. The lead in the brief holds. |
| Pseudotime output | `metadata-column` (continuous, `float32`). **No new kind.** |
| Branch labels (`n_branchings > 0`) | **DESCOPED — on scanpy's own advice.** See §2.3. |
| Assets / licensing | **None.** scanpy is BSD-3, already shipped. This is a *reason to choose it*: Palantir's required dep `mellon` is **GPL-3.0**, and Slingshot/Monocle3 would mean putting R back in the rootfs. |
| Biggest surprise | Producing `graph/attributed` **breaks a committed guard on purpose** — `model_coverage` asserts it has no producer. Retiring that exemption is a required, deliberate, reviewable step. |
| Second biggest | `sc.tl.paga` **crashes** (igraph `ValueError`) when two groups share zero inter-group edges; `sc.tl.dpt` **silently writes no column** when `iroot` is missing or out of range. Both are silent-or-ugly failures that must become named refusals. |
| Third | There is **no graph/network widget renderer** in the declarative vocabulary, and `sc.tl.paga` does not even compute node positions (`sc.pl.paga` does). |
| Feasibility | **Feasible. No blocker.** Three real costs, all named above, all scoped into issues. |

---

## 1. How an analysis is added here (the constraint this doc is written against)

An analysis is a **pure data package**: `src-app/packages/<name>/manifest.yaml` plus python
under `compute/` plus declarative views under `ui/`. The architecture invariant is **zero
`src-app` changes** — `src-app/packages/clustering/tests/test_zero_src_app_diff.py` is the
executable form of it: no path under `src-app/ui/` or `src-app/server/src/` may appear in the
branch diff, and nothing under `src-app/` outside the package except a sanctioned
`src-app/packages/pytest.ini` append.

The wire is small and complete:

* **Outputs** — the compute writes `/outputs/manifest.json` (`{"outputs": [ … ]}`), each
  entry `{id, datatype, path, layout, role, structure, meta}`. The server struct is
  `src-app/server/src/modules/sandbox/outputs.rs` (`MAX_OUTPUTS = 512`,
  `MAX_MANIFEST_BYTES = 1 MiB`). **A run may emit many artifacts** — `de.compare` emits one
  `de/result` per comparison plus a `report/qc`.
* **Typing** — `src-app/server/src/modules/datatype/validate.rs::validate_artifact_typing`
  checks exactly three things: the `datatype` resolves in the live registry; it is not
  abstract; and the `layout` string equals the datatype's declared `storage.layout.kind`
  mapped through `LayoutKind::as_storage_layout` (`chunked_sparse → "chunked-sparse"`,
  `columnar_table → "columnar-table"`, `chunked_1d → "chunked-1d"`,
  `chunked_dense → "chunked-dense"`, `opaque_as_is → "opaque"`). **There is no per-kind Rust
  branch anywhere.** That is the whole zero-core thesis: naming an open kind in an output
  entry is all it takes.
* **Structure** — `structure` must be a JSON object naming an `encoding`
  (`src-app/server/src/modules/workstore/ingest.rs`). It is the producer's decode
  declaration, stamped into the store's `zarr.json` under `attributes.cyto` so the store-URL
  reader and the catalog row decode identically.
* **Conformance** — `src-app/packages/_lib/conformance.py`, invoked *by the ingest path*
  (`src-app/server/src/modules/jobs/conformance.rs` → `verify_conformance.py`), judges the
  emitted bytes against the producer's own `structure`. It implements `sparse_csc`, the
  columnar table, and `opaque`. It checks **structure-vs-bytes**, not
  structure-vs-datatype-`arrays`.

One consequence that shapes §3: **one artifact carries one `structure.kind`.** The `geneset`
manifest says so explicitly — a CSC membership store and a columnar metadata table cannot
co-locate in one artifact. A multi-array declared kind is therefore emitted as a *subset*
plus side-channel declarations, or as several artifacts.

---

## 2. Method: PAGA + DPT, and why

### 2.1 PAGA — the exact contract

```python
sc.tl.paga(adata, groups=None, *, use_rna_velocity=False,
           model='v1.2', neighbors_key=None, copy=False)
```
Signature and numeric core are **identical from scanpy 1.8.0 through 1.12.4** (diffed at
each tag; only cosmetic refactors).

**Requires**: `sc.pp.neighbors` (hard `ValueError` otherwise) and `groups` naming a
**categorical** `adata.obs` column (`KeyError` if absent; auto-picks `leiden`/`louvain` if
`None`). It also requires **`igraph`**, which is an *optional* scanpy extra
(`scanpy[paga]`) — **already present in this repo's rootfs**, so it costs us nothing, but
it is a real dependency to record.

**Writes exactly three keys** into `adata.uns['paga']`:

| key | actual type | shape | dtype |
|---|---|---|---|
| `connectivities` | `scipy.sparse.csr_matrix` | `(n_groups, n_groups)` | `float64` |
| `connectivities_tree` | `scipy.sparse.csr_matrix` | `(n_groups, n_groups)` | `float64` |
| `groups` | `str` | — | the obs key |

Three contract traps, all confirmed against source:

* **The scanpy docstring is wrong about `connectivities`.** It documents `numpy.ndarray`;
  the object is **CSR sparse**. Write the contract against sparse.
* **`pos` is NOT written by `sc.tl.paga`.** Node coordinates are computed by the *plotting*
  function `sc.pl.paga`. The tool produces topology only, no layout. This matters for §5.4.
* **Undocumented side effect outside `uns['paga']`:** `adata.uns[f"{groups}_sizes"]` — an
  `ndarray` of per-group cell counts. Free per-node `n_cells` for our node attributes.

**Node ordering follows `adata.obs[groups].cat.categories`** — natsorted/lexicographic,
**not order of appearance**. This must be pinned in the contract and asserted in the test;
it is the single easiest way to ship a correctly-computed matrix with wrong labels.

**`connectivities` is symmetric; `connectivities_tree` is NOT** — the tree stores one
direction per MST edge (`scipy.sparse.csgraph.minimum_spanning_tree` on `1/connectivities`,
values back-substituted).

**The statistic, exactly** (`_compute_connectivities_v1_2`): binarize the kNN *distances*
matrix into a directed igraph; `ns[i]` = group size, `n = Σns`;
`es[i]` = inner-cluster edges + directed inter-cluster row sum (computed **before**
symmetrization); symmetrize `inter_es += inter_es.T` to get the observed count `v`; then

```
expected_random_null(i,j) = (es[i]*ns[j] + es[j]*ns[i]) / (n - 1)
connectivity(i,j)         = min(v / expected_random_null, 1)     # 1 if expected == 0
```

**The ratio is hard-capped at 1**, which is precisely why people misread it as a
probability. It is not one. scanpy computes `expected_n_edges_random` but the line writing it
to `uns` is **commented out**, so the denominator is unrecoverable from the output — if we
want it in the report we must recompute it.

`model='v1.0'` is a *different statistic* (undirected UMAP fuzzy graph, no cap). The run
must pass `model` **explicitly** and record it — the same discipline `embedding.reduce` uses
for harmonypy's parameters and `clustering` uses for `method='wilcoxon'`.

**Robustness bug, reproduced live (scanpy 1.11.5 / igraph 1.0.0 / scipy 1.15.3):** if two
groups share **zero** inter-group edges, `sc.tl.paga` **crashes**:

```
ValueError: mismatching number of index arrays for shape; got 0, expected 2
  igraph/adjacency.py:116 in _get_adjacency_sparse
```

This is not a rare edge case — it is what a multi-sample, un-integrated dataset with a
disconnected kNN graph does. It must become a **named refusal with a reachable lever**
(raise `n_neighbors`, integrate, or subset to one connected component), not a stack trace.
See INV-5.

### 2.2 DPT — the exact contract

```python
sc.tl.dpt(adata, n_dcs=10, *, n_branchings=0, min_group_size=0.01,
          allow_kendall_tau_shift=True, neighbors_key=None, copy=False)
```
Signature and defaults **unchanged 1.8.0 → 1.12.4**. There is no `diffmap_key` parameter.

**Requirements, and the asymmetry in strictness is the whole safety story:**

| prerequisite | scanpy's behaviour when missing |
|---|---|
| `sc.pp.neighbors` | **hard `ValueError`** |
| `sc.tl.diffmap` | **soft** — warns, then silently runs `_diffmap` with defaults (`n_comps=15`, `random_state=0`) |
| `adata.uns['iroot']` | **soft — warns and then simply never writes `dpt_pseudotime`.** No exception. |
| `iroot >= n_obs` | **soft** — warns, sets `iroot = None`, writes nothing |

**The `iroot` case is the single most dangerous silent failure in this whole analysis**: a
pipeline that forgets or mis-resolves the root produces a valid-looking run with a *missing*
output and no error. Our compute must resolve `iroot` itself, assert the column exists after
the call, and refuse by name otherwise. It must also call `sc.tl.diffmap` **explicitly** with
a recorded `n_comps` rather than relying on the fallback — note the default mismatch,
`diffmap` `n_comps=15` vs `dpt` `n_dcs=10`, which scanpy's own docstring flags.

**Writes:**

* `adata.obs['dpt_pseudotime']` — **`float32`** (the eigen basis is cast to float32 in
  `compute_eigen`), normalized to `[0, 1]` over the root's connected component.
* `adata.uns['iroot']` — rewritten.
* Only when `n_branchings > 0`: `obs['dpt_groups']` (categorical), `obs['dpt_order']`,
  `obs['dpt_order_indices']`, `uns['dpt_changepoints']`, `uns['dpt_grouptips']` — the last
  three **undocumented in the Returns section**.

**Disconnected graphs → `+inf`, confirmed empirically.** `Neighbors._get_dpt_row` sets
`row[~mask] = np.inf` for cells in a different component, then

```python
self.pseudotime = self.distances_dpt[self.iroot].copy()
self.pseudotime /= np.max(self.pseudotime[self.pseudotime < np.inf])
```

so the normalization divides **only by the finite max**. A two-blob test gave 200/400 cells
`inf` and a finite range of exactly `[0.0, 1.0]`. Anything downstream that plots, sorts, or
averages this column misbehaves on `inf`. See INV-4.

### 2.3 `n_branchings > 0` is DESCOPED, on scanpy's own advice

scanpy's `tl.dpt` docstring says it outright:

> *"We recommend, however, to only use `sc.tl.dpt` for computing pseudotime
> (`n_branchings=0`) and to detect branchings via `sc.tl.paga`."*

The Kendall-tau splitting criterion additionally needs the `allow_kendall_tau_shift=True`
stabilization hack for small branches, which is an admission of instability in the API
surface itself.

**Decision: v1 runs `n_branchings=0` and emits no branch column.** Branch structure is what
the PAGA graph is *for*. Shipping an unstable categorical labelled "lineage branch" is
exactly the kind of authoritative-looking wrongness this spike exists to prevent. This
removes the categorical `metadata-column` output from the design entirely.

### 2.4 Why not the alternatives

| Candidate | Verdict | Reason |
|---|---|---|
| **PAGA + DPT (scanpy)** | **CHOSEN** | Already installed (scanpy **and** igraph). Pure python. BSD-3. Directly produces the two shapes the platform already declares. Its abstracted graph is *literally* the shape `open-kinds` says `graph/attributed` exists for. |
| **Palantir** | Deferred | Pure-python wheel, MIT, active (1.4.5, Jul 2026), no R. **But its required dep `mellon` is GPL-3.0** and pulls `jax` + the frozen `jaxopt` — a genuine redistribution question this spike is not entitled to answer. Also: its output shape (per-cell fate *probabilities* over terminal states) has no declared kind yet. Revisit once a per-fate `metadata-column` shape is proven. |
| **scFates** | Deferred | Pure-python wheel, BSD-3, active. Tree inference and pseudotime *are* pure python — but seven of its functions (`tl.test_association`, `tl.fit`, `tl.test_fork`, …) require **R's `mgcv` via `rpy2`**, and **`rpy2` is not in its `requires_dist`**: `pip install` succeeds and those calls fail at run time. Hard deps on `elpigraph-python` + `simpleppt`. A reasonable *second* backend, not the way to land the first. |
| **Slingshot** | Rejected | **R only** (Bioconductor, Artistic-2.0). The rootfs Dockerfile *deliberately dropped* `r-base-core`: *"DROPS r-base-core (no R processor exists — re-add if one lands)"*. Upstream dormant since 2023 (still released via Bioc). The PyPI `pyslingshot` is a third-party **reimplementation, not a binding**, and pins `numpy<2` — a direct conflict with a modern scanpy stack. |
| **Monocle3** | Rejected | The only genuinely hostile install: **R only, GitHub-only** (not CRAN, not Bioconductor), ~55 imports, `sf`/`spdep` dragging in GDAL/GEOS/PROJ/sqlite3, `leidenbase` needing C++ compilation, and a `Remotes:` field so **two deps resolve only from GitHub** — an unreproducible dependency closure. (The Bioconductor package named `monocle` is Monocle **2**, a different codebase.) |
| **tradeSeq** | Out of scope | **Not a trajectory method** — it is trajectory-*based* DE (per-gene NB-GAM over pseudotime). R only. Worth recording that it accepts bare `(pseudotime, cellWeights)` matrices, so a python-side trajectory can be exported into it — that is the cheapest future bridge to formal DE-along-pseudotime. |

**The deciding argument is not "scanpy is easiest".** It is that the platform has already
declared, in `open-kinds/manifest.yaml`, the exact contract PAGA emits — *"The
abstracted-graph / trajectory shape whose axis is neither obs nor var, so SOMA (obsp/varp
only) cannot hold it"* — and has already proven the zero-core serve path for it
(`src-app/server/tests/workstore/open_kinds_serve_test.rs` reads node 0's weighted
neighbours out of a `graph/attributed` CSC artifact through the unchanged byte plane).
Choosing a method whose output *is not* that shape would leave the declared contract
unproduced, and would cost either an R runtime or a GPL dependency to do it.

**The honest capability gap** of PAGA+DPT versus those alternatives, which belongs in the
methods statement: **no fate probabilities, no per-lineage pseudotime or lineage weights, no
fitted principal curve/graph, and no DE-along-pseudotime test.**

### 2.5 Limitations that MUST be disclosed

A trajectory that runs but is wrong looks authoritative. These go in `methodsText`, in
`methods.note`, and in the run form's help text — not in a footnote:

1. **Pseudotime is not time.** It is a monotone ordering along a graph geodesic, with no
   units, no calibration to developmental time and no guarantee of uniform rate. The
   foundational assumption — *transcriptomic similarity implies developmental relation* —
   is an assumption, not an observation (Tritschler et al. 2019, *Development* 146:dev170506).
2. **The root determines everything.** `iroot` is one unvalidated integer with no default
   and no automatic inference. It fixes the origin and direction of the entire ordering.
3. **DPT requires a connected graph.** Unreachable cells get `+inf`, and the normalization
   rescales by whichever component the root landed in.
4. **PAGA connectivities are a test statistic, not a probability** — an observed/expected
   inter-partition edge ratio under a random-connection null, **hard-capped at 1**, which
   makes it look like one. scanpy declines to give a p-value because the null model
   *"strongly overestimates the expected value"*. The visualised graph also depends on an
   arbitrary user `threshold` (0.03 in the canonical tutorial) with no principled selection
   rule.
5. **PAGA is only as good as the clustering handed to it.** Its nodes *are* the partitions.
   Changing the Leiden resolution changes the topology.
6. **Branch detection via DPT is unstable and scanpy advises against it** — hence §2.3.
7. **A numerical break is scheduled upstream.** The DPT distance still includes a
   stationary-state contribution from a 2015 implementation that other implementations
   (including the PAGA paper) omit; a scanpy source comment states this will likely be
   removed at the next backwards-incompatible release.
8. **No method tests whether a trajectory exists.** Run on discrete cell types, both
   produce a confident-looking ordering of nothing.
9. **Benchmark context.** Saelens et al. 2019 (*Nat Biotechnol* 37:547) benchmarked 45
   methods and found no universal winner: *"the choice of method should depend mostly on the
   dataset dimensions and trajectory topology."* PAGA scored well on tree-like/complex
   topologies; Slingshot was recommended for simple ones.

---

## 3. Output-kind decision

### 3.1 The verdict

**Reuse `graph/attributed` for the PAGA graph. Reuse `metadata-column` for pseudotime.
Declare no new kind.** The lead in the brief is correct, with one qualification (§3.3).

### 3.2 Mapping, output by output

| Produced thing | Kind | Layout | Where |
|---|---|---|---|
| PAGA `connectivities`, `n_groups × n_groups` | `graph/attributed` | `chunked-sparse` (CSC) | its own artifact; the declared **primary served array** (`adjacency`) |
| `connectivities_tree` | — | — | rides the same artifact's `structure_extra` as an edge list (`n_groups − 1` edges; a second artifact for a handful of pairs is not worth an ingest) |
| Per-node attributes: group label, `n_cells` (free, from `uns[f"{groups}_sizes"]`), degree | — | — | rides `structure_extra["nodes"]`, exactly as `geneset/collection` rides its per-set metadata in `structure.sets` |
| `dpt_pseudotime` | `metadata-column` | `chunked-1d` | its own artifact, `meta.kind == "continuous"`, `stored_dtype: "float32"` |
| Provenance / diagnostics report (one per analysis) | `report/qc` | `opaque` | one JSON blob per run |

**Does `graph/attributed` actually fit?** Yes, on all three declared arrays:

* `adjacency` — `dims: [{axis: node}, {axis: node}]`, `attrs: [{name: weight, dtype: f32}]`,
  `layout: chunked_sparse/csc`. PAGA connectivities is exactly a symmetric weighted
  `node × node` sparse matrix. `cyto_csc.write_csc_zarr(..., axes=("node","node"))` works —
  the writer stringifies `axes` with no validation, so both dims naming one axis is legal.
  One narrowing to record: scanpy returns `float64` **CSR**; the declared attr is `f32` and
  the declared orientation is CSC. Both conversions are lossy-in-the-last-bits and must be
  done deliberately, with INV-1's tolerance set accordingly.
* `edges` — `dims: [{axis: edge}]`, `attrs: [src i64, dst i64, weight f32]`. The
  `connectivities_tree` shape. Because one artifact carries one `structure.kind`, this rides
  `structure_extra` rather than being a second member of the same store. Its **asymmetry**
  (§2.1) must be preserved and declared, not "helpfully" symmetrized.
* `node_attrs` — `dims: [{axis: node}]`, `attrs: [degree i64, cluster categorical]`. A PAGA
  node's natural attributes are exactly *which cluster it is* and *how connected it is*.

**Is anything missing from the declared contract?** One thing, and it needs no manifest
change: `node_attrs.attrs` does not include `n_cells`. That is fine — the declared `arrays[]`
are the type's *full shape* and are **not validated against emitted bytes at ingest** (only
`structure`-vs-bytes is, by the conformance gate). The `geneset` manifest documents this
subset-emit as sanctioned. Promoting `n_cells` to a typed node column later is an
`open-kinds` `arrays[].attrs` addition plus a `version:` bump — additive, not a blocker.

**Per-cell pseudotime is NOT part of the graph.** It is an obs-axis column on an existing
kind, exactly as the brief suspected. `metadata-column` declares
`axes: [{name: cells, key_label: barcode}]`, `storage.layout: chunked_1d`,
`capabilities: [obs-aligned, continuous-column, metadata-column-family]` and — this is the
point — **no dtype and no continuous/categorical declaration at all**. The split is made
per-artifact by the producer: `_lib/cyto_columns.py::write_metadata_column` dispatches on the
pandas dtype and stamps `meta.kind ∈ {"continuous","categorical"}` (vocabulary pinned at
`cyto_columns.py:79-80`). A float column becomes `kind: "continuous"`,
`stored_dtype: "float32"`. `qc.10x` already writes exactly this for its per-cell float
metrics.

**The payoff is free.** `single-cell-viz/ui/colour-by.yaml` binds a `row_space_columns` slice
with `datatype: metadata-column` and
`kinds: [{kind: categorical, heading: Groups}, {kind: continuous, heading: Values}]`. The
pseudotime column therefore lands under **Values** and colours the existing UMAP with **no
viz code and no `src-app` diff** — the identical mechanism `clustering.cluster` relies on and
pins with `packages/clustering/tests/test_colour_by_binding.py`.

**One open question for the implementation, not resolvable on paper:** `inf` values in a
`float32` column. `write_metadata_column` has a `n_missing` channel for float NaN. INV-4
requires that unreachable cells are declared missing (or the run refuses) — never written as
a finite number and never left as a raw `inf` for a colour scale to render as "latest".

### 3.3 The qualification: the `node` axis has no anchor, and a committed guard says so

`graph/attributed` declares `entity_axis: node`. A PAGA node is a **cluster**, i.e. a *level
of a categorical column*, not an entry of any dataset axis. The `node` axis therefore remains
unanchored even after a producer exists.

`src-app/packages/_lib/model_coverage_exempt.json` records this, and its wording is an
instruction to this spike:

> `graph/attributed` — Open-axis kind with no in-tree producer. Its entity axis `node` has no
> dataset anchor, so its disposition is genuinely undecidable until a producer exists: if a
> producer's nodes turn out to be entries of an original dataset axis it is an ordinary row
> space, and otherwise it rests on an axis nothing anchors. **Remove this entry when the
> first producer lands, and decide it then.**

**The decision this spike makes: the nodes are partition levels, so the axis stays
unanchored. The `lattice` exemption survives, but its reason must be rewritten from "no
producer" to "a producer exists and its nodes are levels of a categorical column, not
entries of a dataset axis".** Additionally, the `producer` register — which is **complete
and asserted in both directions** — needs new `(producer × datatype)` entries for
`trajectory.paga × graph/attributed` and `trajectory.dpt × metadata-column`, each with a
`disposition` and a `reason`.

There is a second half that *is* a `src-app` edit.
`src-app/server/tests/model_coverage/mod.rs::the_widening_did_not_swallow_the_standing_exemption`
hardcodes the live tree:

```rust
assert!(
    outside_the_model().contains("graph/attributed"),
    "`graph/attributed` has no in-tree producer, so no derivation can anchor it. …"
);
```

The moment a producer lands, that test's stated *reason* is false even where its assertion
still holds. The guard's own teeth test
(`the_derivation_rule_still_refuses_an_unanchored_axis`, case (a)) already carries a
**synthetic** orphan (`synth/orphan`) for the same property, so the live-tree assertion can be
retired in favour of the synthetic one **without weakening the guard** — which is the bar any
change to a guard has to clear here.

**This is a deliberate, reviewable `src-app/server/tests/` change.** No production code
changes. It is not forbidden by the zero-src-app invariant as written
(`test_zero_src_app_diff.py` forbids `src-app/ui/` and `src-app/server/src/`), but the
sibling assertion `test_only_clustering_package_and_the_sanctioned_pytest_ini_changed`
forbids *anything* under `src-app/` outside the package, so the trajectory package's copy
must sanction, explicitly and by name:

* `src-app/packages/_lib/model_coverage_exempt.json`
* `src-app/server/tests/model_coverage/mod.rs`
* `src-app/packages/pytest.ini`

Being honest about it: **the zero-src-app-edit guarantee is not perfectly clean for the first
producer of a previously-unproduced open kind.** A guard whose entire purpose was to notice
this event does notice it, and the required work is to record the decision it was waiting
for. That is the guard working, not the architecture failing. It is filed as its own issue so
it is reviewed on its merits rather than smuggled into a compute PR.

### 3.4 Rejected alternatives for the graph output

* **Put the PAGA graph in the `report/qc` JSON.** Cheap, and wrong: `report/qc` is `opaque`,
  so the graph would be un-served, un-sliceable, un-decodable by the byte-range client, and
  invisible to any future consumer. It would also leave the declared `graph/attributed`
  contract permanently unproduced.
* **Declare a new `trajectory/*` kind.** Unjustifiable. The declared kind fits, its serve
  path is already tested, and a second near-identical kind is exactly the drift `open-kinds`
  exists to prevent.
* **Emit pseudotime as an `embedding`.** Physically a dense cells × 1 array, but `embedding`
  carries `plottable-xy` and would land in the *layouts* channel — offering a meaningless
  1-D scatter and never reaching the colour-by Values list.

---

## 4. Inputs and prerequisites

### 4.1 The upstream chain

```
import (anndata / h5ad / cellranger)
  └─ qc.10x  →  cell.filter
       └─ embedding.reduce            → embedding        (PCA / Harmony latent)
            ├─ embedding.visualize    → embedding (2-D)  ← the surface pseudotime colours
            ├─ clustering.cluster     → metadata-column (categorical)
            │        └───────────────┐
            └────────────────┐        │
                     trajectory.paga  (embedding + the categorical column) → graph/attributed
                     trajectory.dpt   (embedding + a root)                 → metadata-column
```

**`trajectory.paga`** consumes:

* `embedding` — required, single-select, `auto_bind_sole_candidate: true` (the reduced
  representation, **never** a 2-D layout — the same INV-11-shaped compute-side named refusal
  `clustering.cluster` enforces, read off the declared structure before a byte is read).
* a **categorical `metadata-column`** — required. The partition. `appliesTo` keys on the
  datatype; the categorical-ness is a per-artifact `structure` member kind, so the run form
  lists it via a `row_space_columns` / `column_values` slice and the compute refuses a
  continuous column by name.

**`trajectory.dpt`** consumes:

* `embedding` — required, same rules.
* a **root** — see §4.2.
* optionally the PAGA `graph/attributed` artifact — *not* for the computation, but so the
  report can state which abstracted graph the root cluster was read from. This is a genuine
  optional binding of the `clustering.cluster`-optional-expression shape, not a fake
  dependency.

Both write a `report/qc` carrying `library_versions` — the shipped convention (`clustering`,
`embedding`, `differential-expression` all record resolved versions). **Caveat**: the shipped
helper reads `getattr(module, "__version__")`, and **`scanpy.__version__` is deprecated as of
1.11.5** (it emits a `FutureWarning` and points at
`importlib.metadata.version("scanpy")`). Flagged as `[shared]` (§7.5).

### 4.2 Root selection — the UX problem, and it is solvable declaratively

DPT needs `adata.uns['iroot']`, an **integer row index**. Asking a user for a row index is
not an interface. What the ecosystem actually does today:

* The **canonical scanpy PAGA/paul15 tutorial** does
  `adata.uns["iroot"] = np.flatnonzero(adata.obs["louvain_anno"] == "16/Stem")[0]` — i.e. it
  picks **whichever cell of the stem cluster happens to be first in file order**. That is not
  a rule, it is an accident, and it is **not permutation-invariant**: reorder the obs and you
  get a different root and different numbers.
* The **scverse best-practices book** does `adata.obsm["X_diffmap"][:, 3].argmin()` — where
  both the component index *and* the `argmin`/`argmax` sign are unpinned free parameters (an
  eigenvector's sign is not determined). Note component 0 is the trivial steady state, so
  real components start at 1.

Three offered modes, all expressible in the shipped declarative vocabulary with **zero new
`src-app` data source**:

1. **Root cluster (default, recommended).** The user picks a categorical column and then a
   **level** of it, read through the shipped `column_values` data source (the same source
   `single-cell-viz/ui/colour-by.yaml` uses). The compute resolves the level to a cell index
   **deterministically and by a stated rule** — the cell of that group extremal along a named
   diffusion component — and records the resolved barcode. This is the tutorial's practice
   made reproducible.
2. **Extremal cell along a diffusion component.** The user picks a component index (≥1) and a
   direction. Fully determined by the data; no biology asserted; the sign ambiguity is made
   an explicit user choice rather than a hidden one.
3. **Explicit barcode.** A text field. The compute refuses by name if the barcode is not in
   the cells axis.

**Whatever the mode, the run records the resolved barcode and the rule that resolved it** in
the report and in the run params, so the methods narration can disclose it. A root chosen by
mode 1 is a *biological assertion by the user*, and the report says so in those words.

### 4.3 Compute-side prerequisites

* `sc.pp.neighbors` on the input embedding (rebuilt from the embedding, never from a 2-D
  layout). The exact/approximate `neighbour_path` switch must be recorded truthfully —
  `packages/clustering/compute/_shared.py::neighbour_path` and its oracle test
  `test_neighbour_path_scanpy.py` are the existing, correct implementation and should be
  vendored verbatim (`run.helpers` confinement forbids cross-package imports; `embedding`'s
  vendoring of `cell-filter`'s `_criteria.py` is the sanctioned precedent).
* `sc.tl.diffmap` called **explicitly**, `n_comps` recorded, never relying on the fallback.
  Record both `n_comps` and `n_dcs` — they differ by default (15 vs 10).
* `model='v1.2'` passed **explicitly** to `sc.tl.paga` and recorded (v1.0 is a different
  statistic).
* A memory/time **ceiling gate read from the declared structure before any byte is read**
  (`ceiling_refuse_if_over`), refusing by name at a reachable lever. `schedule.class: normal`
  (4 GiB / 2 cores / 600 CPU-s) is right for both; neither is heavier than
  `clustering.cluster`, whose ceiling logic transfers directly.
* A **determinism pin** — the six-var thread pin plus a seed, as in `_shared.py`. Note
  `sc.tl.diffmap` accepts `random_state` (default 0) and **was non-deterministic before
  scanpy 1.8.0**; the shipped rootfs is 1.11.5, comfortably past that floor, but the run must
  pass `random_state` explicitly and record it.

---

## 5. Platform obligations

Missing any of these ships something broken or dishonest.

### 5.1 `methodsText` + the `methods:` block (the out-of-app trust deliverable)

`src-app/server/src/modules/provenance/export/methods.rs` reads
`contributes.analyses[].methods` to narrate the exported `methods.md`. The contract in full:

* **Required**: `subject: {singular, plural}` and `action`. Missing either **fails
  `cargo build`** (`build.rs` → `lint_processor_tree`).
* **Optional**: `commits`, `commits_unlabeled`, `note`, `params`, `allow_list_slots`.
* Both the runtime struct (`extensions/types.rs`, `MethodsNarration` / `MethodsSubject`) and
  the build mirror are `#[serde(deny_unknown_fields)]`. Any other key fails the build.
* `params` maps a param name to a role from a **closed seven-value vocabulary**:
  `predicate_list`, `threshold_list`, `opaque_predicate`, `allow_list`, `subsample_cap`,
  `seed`, `output_label`. Anything else fails the build.
* A param **not** in `spec.params` is disclosed by name:
  `` Additional recorded parameters are NOT narrated here and may further constrain the result: `a`, `b` (see `manifest.json`). ``
* A **malformed** `methods:` block does not degrade — it fails the whole manifest parse and
  the **entire package is skipped** at boot (`loader.rs`), losing its analyses, views and
  datatypes.
* `methodsText` is a **separate, frontend-only** field, interpolated with `$param` /
  `$params.x` tokens (never braces) and rendered in-app in the provenance view. The two
  systems never meet and neither falls back to the other.

**Three defects in that narrator that this analysis will hit, and that every other analysis
already hits.** Filed as `[shared]` (§7.1):

1. **`commits` supports only the `{label}` placeholder.** Five shipped manifests use
   `{name}`, `{n_pcs}`, `{n_hvg}`, `{method}` — those emit **literal braces** into
   `methods.md`. Only `cell-filter` spells it correctly.
2. **`note:` is dropped entirely on the no-constraints branch.** An analysis that declares no
   param with a constraint-producing role takes a branch that never emits `note`. Every
   carefully written `note:` in `clustering`, `embedding` and `differential-expression` is
   currently **absent from every exported `methods.md`**.
3. **On that same branch it emits an accusation that is false for us**: `NOTE: no criteria
   were recorded for this run, so the predicate it applied is not documented here.` A
   trajectory run applies no predicate. The exported statement would tell a reader the
   analysis hid something it never had.

**Consequence**: the trajectory package's narration cannot be correct until (1) and (2)/(3)
are fixed. Disclosure of `root_mode`, `root_barcode`, `n_dcs`, `n_comps`, `groups_column`,
`model`, `n_neighbors` and `metric` **is** the trust deliverable for a trajectory — those
parameters *are* the result. So the methods issue is a real blocker edge in §8, not a nicety.

Sketch (subject to the fix):

```yaml
methodsText: >-
  Ordered the cells along a diffusion pseudotime. A k-NN graph was rebuilt over the input
  embedding, a diffusion map computed, and each cell assigned a scalar distance from a
  recorded root cell along the diffusion manifold. Pseudotime is an ordering, not a time:
  it has no units, it is entirely determined by the chosen root, and it makes no claim
  that a continuum exists in these data.
methods:
  subject: { singular: cell, plural: cells }
  action: ordered
  commits: "one per-cell pseudotime column, labelled `{label}`"
  commits_unlabeled: a per-cell pseudotime column
  note: >-
    Diffusion pseudotime is a distance along the diffusion manifold from the recorded root
    cell; a different root is a different result, not a different view of the same result.
    Cells not reachable from the root in the neighbour graph are reported as unreachable
    rather than assigned a finite value. Branch detection was not performed: scanpy's own
    guidance is to read branching from the abstracted graph rather than from DPT.
  params:
    seed: seed
    name: output_label
  # root_mode / root_barcode / n_dcs / n_comps / n_neighbors / metric are DISCLOSED BY NAME
  # by the runtime narrator — none has a role in the closed vocabulary.
```

### 5.2 Kind / axis declarations

**None needed.** `graph/attributed`, `metadata-column` and `report/qc` all already exist and
all already fit. The only registry-adjacent work is the model-coverage bookkeeping in §3.3.

### 5.3 Processor seed versions and the other repo-wide gates

* **`scripts/check-processor-seed-versions.sh`** — every file change under a package must
  move that package's `manifest.yaml` `version:`. It **skips packages that did not exist at
  the merge base**, so a brand-new `trajectory` package is exempt on its introducing branch.
  It is not the correctness boundary either way: `embedded.rs` records a SHA-256 per embedded
  file in `.seed-manifest.json` and re-asserts changed bytes at the same version. The
  obligation is **version hygiene**: each increment (compute → views → tests) bumps the
  version, as `clustering` did `0.1.0 → 0.3.1` across its stages.
* **`src-app/packages/pytest.ini`** — `testpaths` is an **enumeration**. A package whose suite
  is not listed is collected by **nothing**; `just check-py` runs bare pytest from that
  directory. `trajectory/tests` must be appended **in the same commit that creates it**.
  Shared-edit hotspot across parallel spikes (§7.4).
* **`scripts/check-guard-integrity.sh` + `scripts/guard-hashes.txt`** — only if a
  `scripts/check-*.sh|.mjs` guard is touched. This spike does not require one.
* **`scripts/check-kinds-zero-core.sh`** — scans app-core *production* lines for the three
  open-kind ids. Tests and `packages/` are out of scope by construction, so §3.3's changes do
  not trip it.
* **`scripts/check-derived-vocabulary.sh` / `domain_surface`** — the domain vocabulary is
  derived from `packages/*/manifest.yaml`, so a new package joins with no edit, provided no
  domain noun lands in app core. This spike puts none there.
* **`category: trajectory`** is free: `AnalysisContribution.category` is an open `string` on
  both the Rust and TS sides, and no frontend label map is keyed on it.

### 5.4 Is a viz section needed?

**For pseudotime: no. It is free.** The colour-by section (§3.2) already lists a continuous
`metadata-column` under **Values**.

**For the PAGA graph: yes — and it is blocked twice over.**

1. The declarative widget vocabulary is exactly `scatter`, `violin`, `bar`, `histogram`,
   `image`, `entry_list`, `lineage`, `select`, `text`, `multiselect`, `range_slider`,
   `list-editor`, `tabs`, `token-input`, `table`, `button`, `alert`, `stat`, `group`,
   `dataset-picker`, `artifact_ref`
   (`ui/src/modules/workbench/extensions/{canvas,visualize,widgets}/install*.ts`). `lineage`
   is the **provenance** lineage pane, not a cell-lineage plot. **There is no node-link
   renderer.**
2. **`sc.tl.paga` does not compute node positions at all** — `sc.pl.paga` does (§2.1). So
   even with a renderer, someone has to decide and record a layout algorithm, which is a
   further scientific-presentation choice.

Three honest options; this spike recommends the second:

1. Add a `network` widget kind. Legitimate, reusable, permanently useful — and a
   `src-app/ui` change, which breaks the very invariant this package demonstrates.
2. **Ship the graph without a bespoke plot, and read it as a `table`** — a per-edge table
   (`source`, `target`, `connectivity`) sorted descending, plus the node table. Fully
   declarative, states exactly what the statistic is, and is arguably **more honest** than a
   force-directed picture, which invites reading node positions as meaningful when they are a
   layout artefact. The on-screen trajectory story is then carried by the pseudotime-coloured
   UMAP, which is what a reader actually looks at anyway.
3. Defer the graph entirely and ship pseudotime only. Rejected — it leaves
   `graph/attributed` unproduced, which is the whole point of the lead.

Option 1 is filed as **`[shared]`** (§7.2), because a network renderer is equally needed by
any cell–cell-communication or gene-regulatory-network spike, and this spike must not assume
it owns it.

---

## 6. The scientific-validity invariant and the parity test

"It runs" is not the bar. A trajectory that executes but is wrong is worse than nothing,
because it looks authoritative. Five invariants; each has a concrete, falsifiable test, and
each carries its mutation list in the docstring in the house style
(`test_neighbour_path_scanpy.py`'s "Mutation: …" paragraph), so a reviewer can check the test
still refuses what it was built to refuse.

### INV-1 — PAGA connectivity parity with scanpy (the reference-parity acceptance test)

**Invariant.** For a named, committed fixture, our emitted `graph/attributed` adjacency is
**numerically equal to `sc.tl.paga`'s own `adata.uns['paga']['connectivities']`**, compared
densely, within `f32` round-trip tolerance (`rtol=1e-5, atol=1e-7`), with:

* the **same node ordering** — `adata.obs[groups].cat.categories`, natsorted, *not* order of
  appearance;
* the **same sparsity pattern** — identical non-zero index sets, not merely close values;
* **symmetry** (`A == A.T`) and a zero diagonal;
* every value in `[0, 1]` (the statistic is capped — §2.1);
* `connectivities_tree` a spanning tree of the connectivity graph (`n_groups − 1` edges,
  connected) with its **asymmetry preserved**.

**Test.** `packages/trajectory/tests/test_paga_parity_scanpy.py`,
`TEST-N [acceptance] [invariant: INV-1]`.

* **Oracle**: scanpy itself, called independently inside the test on the same AnnData — *not*
  a golden number file, which would only prove we still agree with our past selves. This is
  the shape `test_neighbour_path_scanpy.py` already established in this tree (its oracle is
  scanpy's own `Neighbors._handle_transformer`).
* **Fixture**: the committed synthetic generator of INV-2 (gating, network-independent), plus
  `sc.datasets.krumsiek11()` where the environment permits a download — that test **skips
  loudly** rather than passing silently.
* **Mutations that must fail it**: transpose before writing; symmetrize
  `connectivities_tree`; sort nodes alphabetically instead of by categorical level order;
  drop the sparsity-pattern check and emit a dense zero-filled matrix; silently pass
  `model='v1.0'`. Each is a plausible slip that still produces a plot that looks like a
  trajectory.

**Why parity is a meaningful bar here**: the PAGA numeric core is **byte-identical from
scanpy 1.8.0 through 1.12.4** (diffed at each tag), so this test is stable across the whole
supported range and a failure means *we* changed, not scanpy.

### INV-2 — DPT recovers a known ordering on a simulated dataset (ground truth)

**Invariant.** On a dataset with a **known ground-truth ordering**, the emitted pseudotime is
monotone in the true ordering: **signed** Spearman ρ(pseudotime, true_time) ≥ 0.95 when the
root is placed at the true origin.

**Test.** `packages/trajectory/tests/test_dpt_recovers_known_ordering.py`,
`TEST-N [acceptance] [invariant: INV-2]`.

* **Fixture A (gating)**: a seeded, committed **generator** — a branching random walk in a
  low-dimensional latent space lifted to counts, whose `true_time` and `true_branch` are known
  *by construction*. Committed as code, not as a data blob, so the ground truth is inspectable
  and the test can explain why it is the truth.
* **Fixture B (independent, skip-if-unavailable)**: **`sc.datasets.krumsiek11()`** — 640 × 11,
  **simulated** from a literature-curated Boolean network, carrying `obs['cell_type']` with
  four known fates (`Mo`, `Ery`, `Mk`, `Neu`) and a known branching topology; it is the
  reference example in the PAGA paper itself. (`toggleswitch()` is simulated but too trivial
  — 2 genes, no labels; `paul15()` and `moignard15()` are **real** data with no true ordering,
  so they are smoke fixtures, not ground truth. Both `krumsiek11` and `toggleswitch` emit
  `Observation names are not unique` on load and need `.obs_names_make_unique()`.)
* **The sign convention is asserted, not assumed**: pseudotime at the root must be the
  minimum, and the correlation is **signed**. A perfectly inverted ordering has ρ = −1, which
  is *maximally wrong* and would sail through an `abs(ρ)` test. This is the single easiest way
  to ship a confidently backwards trajectory.
* **Mutations that must fail it**: negate the pseudotime; use `argmax` where `argmin` is
  specified when resolving the root; shuffle cell order between the diffmap and the write.

### INV-3 — the root is recorded, and it demonstrably determines the answer

**Invariant.** (a) The resolved root **barcode** and the **rule** that resolved it appear in
the run's `report/qc` and in the recorded params. (b) The same inputs, root and seed produce a
**byte-identical** pseudotime artifact. (c) Two runs differing **only** in the root produce
**different** pseudotime.

**Test.** `test_root_is_recorded_and_determines_the_result.py`,
`[acceptance] [invariant: INV-3]`. Part (c) is the anti-vacuity half: without it, a compute
that hardcoded `iroot = 0` would pass (a) and (b) perfectly.

**Additionally**, and this is the reason INV-3 exists at all: `sc.tl.dpt` **writes no column
and raises nothing** when `iroot` is missing or out of range (§2.2). The test asserts that our
compute, after calling `dpt`, **verifies `dpt_pseudotime` is present** and refuses by name if
it is not — rather than emitting an artifact with a missing column.

### INV-4 — a disconnected graph is never silently finite

**Invariant.** When the neighbour graph is disconnected and cells are unreachable from the
root, the run **either** refuses by name naming a reachable lever (raise `n_neighbors`,
integrate the samples, subset to one connected component), **or** emits the column with those
cells declared missing (`n_missing` in `meta`) and states the count in the report. It **never**
writes a finite pseudotime for an unreachable cell, and never lets a raw `+inf` reach a colour
scale.

**Test.** `test_disconnected_graph.py`, `[acceptance] [invariant: INV-4]`, over a fixture of
two well-separated blobs — empirically reproduced as 200/400 cells `inf` with the finite range
rescaled to exactly `[0, 1]`. This is the failure mode most likely to reach a user:
multi-sample data with no integration routinely yields a disconnected graph, and an `inf`
rendered on a colour scale reads as "the end of the trajectory".

### INV-5 — the PAGA zero-inter-edge crash is a named refusal, not a stack trace

**Invariant.** When two groups share **zero** inter-group edges, `sc.tl.paga` raises
`ValueError: mismatching number of index arrays for shape; got 0, expected 2` from
`igraph/adjacency.py` (reproduced on scanpy 1.11.5 / igraph 1.0.0 / scipy 1.15.3). The run
detects this condition **before** calling scanpy and refuses by name at a reachable lever, or
handles it and emits a graph with genuine zero entries — never a sandbox stack trace.

**Test.** `test_paga_disconnected_partitions_refusal.py`,
`[acceptance] [invariant: INV-5]`, over a fixture of two clusters with no edges between them.

### A note on pinning

The rootfs pins **only** `harmonypy==2.0.0`, and documents exactly why: version-unstable
defaults. The picture for scanpy is more nuanced than "pin it":

* **The PAGA statistic and the DPT signature/defaults are unchanged 1.8.0 → 1.12.4.** The
  frequently-repeated claim of a "scanpy ≥1.4.5 diffmap first-eigenvector change" **could not
  be substantiated** — the 1.4.5 notes say nothing about it and the source is functionally
  identical at 1.4.4/1.4.5/1.4.6. What exists is a *pre-1.3 legacy shim*
  (`_backwards_compat_get_full_X_diffmap`) and a **docs clarification added in 1.8.0**. Any
  design doc asserting a 1.4.5 behaviour change should drop the claim.
* **The real floor is 1.8.0**: before it, `tl.diffmap` had **no `random_state`** and was
  **non-deterministic** — DPT was not reproducible run to run (fixed by scanpy PR #1858).
* **Other real breaks**: 1.5.0 moved graphs from `.uns` to `.obsp`; 1.9.0 changed
  `_choose_representation` `n_pcs` subsetting, which can change the neighbour graph and
  therefore everything downstream.
* **The crash in INV-5 lives in the igraph/scipy seam**, not in scanpy — so pinning scanpy
  alone would not pin it.

**Recommendation**: record the resolved versions of `scanpy`, `igraph`, `scipy` and `numpy` in
the report (free, shipped convention). **Whether to also pin them in the rootfs is a
cross-cutting decision affecting every analysis package**, not this one — filed as `[shared]`
(§7.3), with the harmonypy pin as the precedent that the answer is sometimes yes.

---

## 7. Cross-cutting / `[shared]` findings

Flagged for the coordinator. **This spike does not assume it owns any of them.**

Five parallel spikes had already filed overlapping items by the time this one finished. The
disposition, so nothing is duplicated and nothing is silently dropped:

| Finding | Status |
|---|---|
| §7.1 methods narrator output defects | **Filed new: #131** (the *repair*; #123 and #77 document these as traps each epic works around individually) |
| §7.2 no network renderer | **Already filed: #115** — trajectory's confirmation added there, incl. that `sc.tl.paga` computes no positions at all |
| §7.3 unpinned scientific stack | **Already filed: #80** — this spike's evidence added |
| §7.4 shared-file edit collisions | **Partly #118**; the rest recorded as a coordination note on epic #125 |
| §7.5 `scanpy.__version__` deprecation | **Filed new: #132** |
| §3.2 `node_attrs` too narrow for `n_cells` | **Already filed: #91** — trajectory's half of the union enumerated there; we recommend it stays deferred |
| §6 reference-parity test tier | **Already filed: #94** — #136 builds trajectory's; adopt #94's if it lands first |

### 7.1 `[shared]` — the `methods.md` narrator drops the honest parts

Three defects in `provenance/export/methods.rs` (§5.1): `{label}` is the only placeholder
(five shipped manifests emit literal braces); `note:` is silently dropped when an analysis
declares no constraint-producing param role; and that same branch emits a **false**
accusation (`no criteria were recorded … the predicate it applied is not documented here`)
for analyses that apply no predicate. **All six parallel analysis spikes will hit all three.**
The exported `methods.md` is the out-of-app trust deliverable; it is currently narrating less
than the manifests say, and in one case narrating something untrue.

### 7.2 `[shared]` — no node-link / network widget renderer

The declarative widget vocabulary has no way to draw a graph (§5.4), and `sc.tl.paga` does not
even produce node positions. Any package producing `graph/attributed` — trajectory now,
cell–cell communication and gene-regulatory networks plausibly next — can store and serve it
zero-core but cannot draw it. Adding a `network` widget is a `src-app/ui` change and should be
decided once, for all of them.

### 7.3 `[shared]` — the scientific stack is unpinned in the sandbox rootfs

`src-app/env-rootfs/single-cell/Dockerfile` pins only `harmonypy==2.0.0`, by explicit house
style. Every scientific result the product produces — QC metrics, HVG selection, PCA,
neighbours, Leiden, UMAP, DE, and now PAGA/DPT — comes from an unpinned `scanpy`, `igraph`,
`scipy` and `numpy`. Two runs of "the same analysis" months apart can differ with nothing
recorded but a version string in a report nobody diffs. Concrete evidence this is not
theoretical: `tl.diffmap` was non-deterministic before scanpy 1.8.0; 1.5.0 relocated the
neighbour graphs; 1.9.0 changed `n_pcs` subsetting; and the INV-5 crash lives in the
igraph/scipy seam. The harmonypy pin is the precedent that the answer is sometimes "pin it".

### 7.4 `[shared]` — every new analysis package must edit the same shared files

Six parallel spikes each adding a package will each need to touch:

* `src-app/packages/pytest.ini` — `testpaths` is an enumeration; an unlisted suite is
  collected by **nothing**.
* `src-app/packages/_lib/model_coverage_exempt.json` — the `producer` register is **complete
  and asserted in both directions**, so *every* new (producer × row-bearing datatype) pair
  goes red until somebody records a `disposition` and a `reason`. A new analysis producing a
  `metadata-column` needs an entry. **This is the one a spike will discover from a red guard
  rather than from reading anything.**
* each package's own `test_zero_src_app_diff.py` sanctioned-paths set.

Guaranteed conflicts. Worth one coordinator note and possibly one shared prep PR.

### 7.5 `[shared]` — `scanpy.__version__` is deprecated, and every package's version recorder uses it

`clustering`, `embedding`, `differential-expression` all record `library_versions` via
`getattr(module, "__version__", None)`. On the installed scanpy **1.11.5** that emits
`FutureWarning: `__version__` is deprecated, use `importlib.metadata.version('scanpy')``.
When it is removed, every one of those recorders silently records `None` for its most
important library — a **provenance** regression that no test currently catches, because the
recorders' fallback is `None` rather than a failure. Small, shared, and worth fixing once in
`_lib` rather than five times.

---

## 8. Proposed DAG

Real edges only. **One package, two analyses** — the shape `embedding` (reduce + visualize)
and `differential-expression` (compare + markers) already use, and the right one here because
both analyses share the neighbours/diffmap/ceiling/IO substrate and one version bump should
move both.

**Filed as GitHub issues under epic #125.**

```
   #131 [shared] methods narrator        #115 [shared] network chart kind
            (blocks #137)                   (optional; TRJ ships the table form)
                    │                                  ⋮
   #118 [shared] graph/attributed model-coverage disposition
                    │
                    ▼
   #133  package skeleton + `trajectory.paga`   ──►  graph/attributed + report/qc
                    │                                 (INV-1, INV-5)
                    ▼
   #134  `trajectory.dpt`                       ──►  metadata-column (continuous) + report/qc
                    │                                 (INV-2, INV-3, INV-4)
          ┌─────────┴─────────┐
          ▼                   ▼
   #135  declarative      #136  scientific-validity suite
         views + root-           (INV-1 … INV-5, as one suite)
         selection UX
          │                   │
          └─────────┬─────────┘
                    ▼
   #137  methods.md narration  (also blocked_by #131)
```

`#118` was **already filed by the RNA-velocity spike** (epic #81), which is evaluating the
same datatype. This spike does **not** contest ownership; its decision on the joint
`node`-axis question is recorded as a comment there (summary: **(a)**, `node` stays free —
velocity's nodes are *cells* and therefore anchored, trajectory's are *cluster levels* and
therefore not, so no single subtype declaration could be honest for both).

Why each edge is real:

* **TRJ-1 → TRJ-2** — `model_coverage`'s assertions go **red** the instant a producer of
  `graph/attributed` lands. Landing the compute first means landing a red guard.
* **TRJ-2 → TRJ-3** — `trajectory.dpt` imports the `compute/_shared.py` substrate (thread
  pin, IO wire, structure readers, ceiling gate, neighbour-path oracle) that TRJ-2
  introduces. Not a sequencing preference: the file does not exist until TRJ-2.
* **TRJ-2, TRJ-3 → TRJ-4** — a view names params and slots that must exist, and the loader
  treats a `ui:` entry pointing at a missing file as a **load error**.
* **TRJ-2, TRJ-3 → TRJ-5** — the suite asserts against emitted artifacts.
* **TRJ-4, TRJ-5, [shared] methods → TRJ-6** — the narration discloses the parameters the
  views expose and the suite pins, and it cannot be correct until the narrator is fixed.

Deliberately **not** split further: "PAGA compute" and "PAGA output writing" are one unit;
"the run form" and "the report readout" are one unit (two `ui:` fragments stacking in one
pane); the five invariants are one suite.

---

## 9. Assets and licensing

**Nothing to acquire, nothing to ship, nothing to license.**

* `scanpy` (BSD-3-Clause) and `igraph` — **both already installed** in
  `src-app/env-rootfs/single-cell/Dockerfile`, alongside `anndata`, `numpy`, `scipy`,
  `scikit-learn`, `leidenalg`, `umap-learn`, `numba`, `zarr`, `h5py`. PAGA and DPT are
  `scanpy.tools`; `igraph` is what makes PAGA's `scanpy[paga]` extra satisfied, and it is
  there for Leiden already.
* No reference genome, no annotation database, no gene-set collection, no model weights, no
  credentials, no network access at run time.
* Optional real-data fixtures (`sc.datasets.krumsiek11()`, `paul15()`) are downloads. The
  **gating** tests use the committed synthetic generator, so the suite is network-independent;
  the real-data checks skip loudly.

**This is an argument for the method, not just an absence of work.** Every alternative
carries a licensing or packaging obligation: Palantir is MIT but requires **GPL-3.0
`mellon`**; scFates needs `elpigraph` plus, for its statistics, R's `mgcv` through an
undeclared `rpy2`; Slingshot (Artistic-2.0) and Monocle3 both mean **putting R back into the
rootfs** that this repo deliberately removed, and Monocle3's dependency closure is not even
reproducible from CRAN/Bioconductor (two deps resolve only from GitHub via `Remotes:`).

---

## 10. Honest risk register

| Risk | Severity | Mitigation |
|---|---|---|
| A confidently wrong trajectory on data with no continuum | **High** | Cannot be tested away — no method tests for the existence of a trajectory. Mitigated by disclosure (§2.5) in the form, the report and `methods.md`, and by never presenting pseudotime as a measurement. |
| Inverted pseudotime (root at the wrong end) | High | INV-2 asserts a **signed** correlation; INV-3(c) asserts the root actually moves the answer. |
| `iroot` silently unresolved → artifact with a missing column | High | INV-3: assert the column's presence after the scanpy call and refuse by name. |
| Silent `inf` on a disconnected graph rendered as "late" | High | INV-4. |
| `sc.tl.paga` crashes on zero-inter-edge partitions | Medium-High | INV-5: detect before the call, refuse by name at a reachable lever. |
| PAGA graph read as a picture of biology (positions are a layout artefact — and scanpy's tool computes none) | Medium | §5.4 option 2 — ship it as an edge table with the statistic named, not as a force-directed picture. |
| Version drift with nothing pinned | Medium | Record `scanpy`/`igraph`/`scipy`/`numpy` versions (free). Pinning is `[shared]` §7.3. PAGA's numeric core is stable 1.8.0→1.12.4, which narrows this materially. |
| `scanpy.__version__` deprecation silently zeroing the version record | Medium | `[shared]` §7.5. |
| The `graph/attributed` exemption decision reviewed as a rubber stamp | Medium | Split into its own issue (TRJ-1) so it is reviewed on its own merits. |
| Over-scoping into fate probabilities / DE-along-pseudotime | Low | Explicitly out of scope (§11). |

---

## 11. Explicitly out of scope

DPT branch detection (`n_branchings > 0` — descoped on scanpy's own advice, §2.3),
trajectory-associated gene testing (tradeSeq-style GAM fits along pseudotime), RNA velocity
(scVelo — needs spliced/unspliced layers this platform does not ingest), fate-probability and
terminal-state inference (Palantir, CellRank), multi-sample trajectory alignment, and any
second trajectory backend.

Each is a separate spike, and each becomes materially cheaper once a pseudotime
`metadata-column` and an abstracted `graph/attributed` exist to build on. tradeSeq in
particular accepts bare `(pseudotime, cellWeights)` matrices, so the column this spike
produces is already the input to that bridge.
