# Research spike — DIFFERENTIAL ABUNDANCE (compositional shifts across conditions)

**Status:** research only. No product code, no package, no rootfs change was made by this spike.
**Branch:** `spike/research-diffabundance`. **Scope:** decide the method, the output kind, the
prerequisites, the scientific-validity invariant + acceptance bar, and the DAG.

Differential abundance (DA) answers *"which cell populations change in **proportion** between
conditions"*. It is the compositional complement to `de.compare`, which tests **expression**
within a fixed population. The catalog today has import, `qc.10x`, `cell.filter`,
`embedding.reduce/.visualize/.integrate`, `clustering.cluster`, `de.compare`/`de.markers`,
`geneset.*`, `annotation-integrate`. **DA is absent.**

---

## 0. Executive summary

| Question | Answer |
|---|---|
| Method | **Milo-style neighbourhood DA** (primary) + **cluster-level DA** (second analysis), both on a *(population × sample)* **count** model — not a proportion model |
| Library | **None new.** Implement on the pinned stack (`numpy`/`scipy`/`scanpy`/`pydeseq2`/`statsmodels`). See §2 — every off-the-shelf DA library is uninstallable in this rootfs |
| Specification | `pertpy.tools.Milo` with `solver="pydeseq2"` is the *exact* design we implement; `miloR` (Bioconductor) is the reference for parity fixtures |
| Output kind | **NEW `da/result`** — a columnar table over a new `population` axis. **NOT** `de/result` (its `entity_axis` is `gene`). `graph/attributed` is a *later, optional secondary*, and is **`[shared]`** with the trajectory spike |
| Prerequisites | an `embedding` (≥3 dims) for neighbourhoods; a `metadata-column` **condition** + **sample** pair — the `de.compare` design plumbing, **reused verbatim**; a `metadata-column` population label for the cluster-level analysis. **No expression matrix at all.** |
| New KNN artifact needed? | **No.** The tree has no KNN-graph artifact and does not need one — the kNN is rebuilt in-process from the `embedding`, exactly as `clustering.cluster` and `embedding.visualize` already do |
| Assets / licensing | None for the analysis. The **parity fixture** carries the only licensing question (§8) |
| Correctness bar | `INV-DA-1..4` (§6) + a 4-part acceptance battery whose centrepiece is a **negative control**: the naive per-population proportion test must **fail** the same fixture our estimator passes (§7) |
| `src-app` diff | **Empty except `src-app/packages/pytest.ini`.** No new chart kind, no new server module, no rootfs edit, no `open-kinds` edit — see §5 and §9 |

---

## 1. What "compositional" means here, and why it is the correctness trap

Cell-type proportions are **compositional**: they are constrained to sum to 1. A real increase in
one population *mechanically* depresses every other population's proportion, whether or not
anything happened to those populations. Consequences:

1. **A per-cluster t-test / Wilcoxon on proportions is statistically invalid.** It reports
   confident false positives for every unchanged population whenever any population truly moves.
   This is not a subtle inefficiency — it is the dominant error mode, and it scales *with* effect
   size: the bigger the real biology, the more false discoveries the naive test manufactures.
2. **Cells are not replicates.** 10,000 cells from 2 donors carry 2 units of information about a
   between-donor contrast, not 10,000. Testing per cell inflates n by ~10³ and drives p → 0. This
   is the same replication failure `de.compare` already solved with pseudobulk (`INV-1`/`INV-5`).
3. **The two failures are independent.** Fixing replication (aggregate to samples) does **nothing**
   for compositionality, and fixing compositionality does nothing for replication. Both must be
   handled, separately and by name — exactly the shape of the DE package's `INV-1`.

There are two principled answers, and this spike adopts **both, as declared modes**:

| Mode | Model | Assumption it makes (must be narrated) |
|---|---|---|
| **`poscounts` size factors** (default) | NB-GLM on integer counts; per-sample size factor = median of ratios over positive counts (DESeq2 `poscounts`) — the robust, TMM-family normalization | **Most populations are unchanged.** Robust to a minority of shifting populations; breaks down if a majority move |
| **`reference` population** (opt-in) | offset = `log(count of the named reference population)` per sample — the additive-log-ratio (ALR) transform; this is scCODA's identifiability device without scCODA's dependency stack | **The named reference population's absolute abundance is constant.** Effects are explicitly *relative to that reference* |

There is deliberately **no third mode**. Raw proportions with an independent per-population test is
**refused**, not offered as a "simple" option — see `INV-DA-1`.

> The honest caveat, stated in `methods.md`: neither mode measures *absolute* abundance. Without a
> spike-in or a total-cell-count measurement, single-cell data cannot distinguish "A went up" from
> "everything else went down". Both modes report a **relative** shift under a **stated** assumption.
> DA results are claims about composition, not about cell numbers.

---

## 2. Method + library evaluation — and the feasibility wall

### 2.1 The four candidates

| Method | Level | Statistics | Verdict |
|---|---|---|---|
| **Milo / miloR** ([paper](https://www.nature.com/articles/s41587-021-01033-z)) | **KNN neighbourhood** — no clustering required | Cells counted per *(neighbourhood × sample)*; NB-GLM (edgeR QL-F); **spatial FDR** = BH weighted by neighbourhood connectivity | **ADOPT (primary).** Resolution-free; detects shifts that straddle cluster boundaries; the only candidate that does not inherit the arbitrariness of a clustering resolution |
| **scCODA** | cluster | Bayesian Dirichlet-multinomial, HMC, a **fixed reference cell type** for identifiability | **REJECT as a dependency, ADOPT its idea.** Requires `tensorflow` + `tensorflow-probability`; last release 0.1.9 (stale). Its *reference-population* device is adopted as our ALR mode at ~15 lines and zero dependency |
| **DA-seq** | per-cell score | kNN-based multi-scale score + a logistic classifier; permutation null | **REJECT.** R-only, no maintained Python port, and its FDR calibration is weaker than Milo's for the same input |
| **Naive cluster-proportion test** | cluster | t-test / Wilcoxon on per-sample proportions | **REJECT as a method; RETAIN as the negative control** in the acceptance battery (§7). Statistically invalid per §1 |

**Milo and scCODA answer subtly different questions and this must be surfaced in the UI, not
hidden.** Milo asks *"is there any region of the KNN graph whose cellular composition shifts?"* —
its unit is a neighbourhood, neighbourhoods **overlap**, and a "population" is discovered rather
than named. scCODA/cluster-level DA asks *"does the proportion of **this named cell type** change?"*
— its unit is a label a human can talk about, and it is blind to a shift confined to part of a
cluster. A user with well-curated annotations wants the second; a user asking "what changed?" wants
the first. Shipping both, as two analyses in one package, mirrors the `differential-expression`
package's own `de.compare` / `de.markers` split (two analyses, one shared compute substrate).

### 2.2 The feasibility wall — no DA library is installable in this rootfs

`src-app/env-rootfs/single-cell/Dockerfile` is a **uv venv on Python 3.11**, trimmed to ~316 MB,
which **deliberately dropped `r-base-core`** (*"no R processor exists — re-add if one lands"*). The
pinned scientific set is: `numpy scipy pandas scikit-learn scanpy anndata leidenalg igraph
umap-learn numba llvmlite zarr h5py harmonypy==2.0.0 scikit-misc pydeseq2 decoupler statsmodels
squidpy spatialdata`.

| Library | Blocker |
|---|---|
| `milopy` | Requires **R + edgeR** (via rpy2). Upstream states it is **being archived** in favour of pertpy |
| `pertpy` | **Requires Python >= 3.12** (rootfs is 3.11 → a `ROOTFS_SCHEMA_VERSION` bump and a full revalidation of every package). Required deps include `flax`, `numpyro`, `ott-jax` → **JAX**, hundreds of MB into a 316 MB image |
| `scCODA` | `tensorflow` + `tensorflow-probability`; stale |
| `DAseq` | R |

**Conclusion: implement on the pinned stack.** This is *not* "reimplementing a statistics library".
The statistical engine — a negative-binomial GLM with Wald tests — is **already pinned and already
in production here** (`pydeseq2`, used by `de.compare`). What DA adds on top is four small,
fully-specified pieces:

1. `make_nhoods` — refined index-cell sampling over the kNN graph (~40 lines);
2. `count_nhoods` — a sparse boolean matmul producing the *(nhood × sample)* count matrix (2 lines);
3. the design → `DeseqDataSet(..., size_factors_fit_type="poscounts")` → `DeseqStats` call (~30 lines);
4. weighted BH (spatial FDR) (~15 lines).

And **pertpy's own `solver="pydeseq2"` path is literally this pipeline** — which is what makes the
tight parity tier in §7 possible.

### 2.3 The reference algorithm, pinned (from `pertpy.tools.Milo`)

Defaults and column names to mirror, so parity is meaningful:

```
make_nhoods(prop=0.1, seed=0)
  n_ixs = int(round(n_obs * prop))                       # random index cells
  # REFINEMENT: for each sampled vertex i, take the median position of its kNN in X_dimred,
  # then snap to the nearest ACTUAL cell:
  nh_pos  = median(X_dimred[neighbours_of(i)], axis=0)
  refined[i] = neighbours_of(i)[argmin(euclidean(X_dimred[neighbours_of(i)], nh_pos))]
  refined = unique(refined)                              # n_nhoods is seed-dependent
  # kth-NN distance per index cell is retained -> the spatial-FDR weight

count_nhoods(sample_col)
  nhood_count_mat = csr(nhoods).T @ csr(get_dummies(obs[sample_col]))   # (nhood x sample) ints

da_nhoods(design, model_contrasts=None, add_intercept=True, solver='pydeseq2')
  dds = DeseqDataSet(counts=..., metadata=design_df, design=...,
                     refit_cooks=True, size_factors_fit_type="poscounts")
  dds.deseq2(); DeseqStats(dds, contrast=[factor, group1, group2])
  # renamed to edgeR conventions: log2FoldChange -> logFC, pvalue -> PValue, padj -> FDR

spatial FDR (_graph_spatial_fdr)
  w        = 1.0 / kth_distance                          # denser neighbourhood -> larger weight
  adj_rev  = (w.sum() * p_sorted / cumsum(w_sorted))[::-1]
  adj      = minimum.accumulate(adj_rev)[::-1]           # monotonicity
  adj      = minimum(adj, 1.0)                           # NaN -> 1
```

**Note the size factors are `poscounts`, estimated internally by PyDESeq2 — no explicit offset is
passed.** That is precisely the compositional-normalization lever of §1, and it is why the default
mode is `poscounts` rather than a raw library-size offset (raw totals are *not* robust to a
population that genuinely moves).

Our stored column names deviate from Milo's in exactly one way, following the tree's `G1` rule
already in `de/result`: **`neglog10p` is stored, never raw `p`** (an f32 `p` underflows to 0 below
~1e-45 and destroys the ranking among the top hits).

---

## 3. Experimental design — the hard prerequisite, and the plumbing to REUSE

DA needs replicate samples plus a condition. `de.compare` already solved this, and DA must reuse
that solution rather than invent a second design UX. Concretely, the plumbing is **three
cooperating pieces**, all in `src-app/packages/differential-expression/`:

**(a) The view seam** (`ui/compare.yaml`). The design is *not* a bespoke widget — it is two
`select`s over `derived.catColumns` (`columns_of: {obs: $data.obs, only: categorical}`), bound on
run through `inputs_from` with `artifact: "$data.obsSources[$state.<col>]"`, which resolves each
chosen obs column to a real `metadata-column` **artifact** for that slot:

```yaml
- id: samplePicker    # the replicate/sample column -> the unit of replication
- id: groupingPicker  # the condition column -> the tested coefficient
...
inputs_from:
  - when: "$state.grouping" ; slot: "grouping" ; artifact: "$data.obsSources[$state.grouping]"
  - when: "$state.sample"   ; slot: "sample"   ; artifact: "$data.obsSources[$state.sample]"
```

**(b) The regime classifier** (`compute/_regime.py`). Reads the bound column's `attributes.cyto`
and returns `R1` (inferential, p written) / `R2` (descriptive, p **absent**) / `R3` (unreplicated,
p **absent**). `R1` is granted only on **positive** external-provenance evidence *and* ≥2 samples
per side; no-evidence defaults conservatively to `R2` (`DEC-4`).

**(c) The replication aggregation** (`compute/_pseudobulk.py`). Not reusable as code — DA counts
*cells per population per sample*, not *reads per gene per pseudobulk* — but the **contract** is:
the unit of replication is the sample, and units below `min_cells` are **dropped and recorded,
never silently omitted**. DA copies that contract.

### 3.1 The sharp finding: for DA, *population* and *condition* are different columns

In `de.compare` the "grouping" column is **both** the thing that defines the groups **and** the
thing being tested — so `_regime.classify` is called on it once and everything follows. **In DA
they separate**:

* the **population** (cluster / annotation / neighbourhood) defines the *rows* of the count matrix;
* the **condition** defines the *tested coefficient*.

The regime classifier must therefore be applied to the **condition** column (and the sample column
for replication), **never** to the population column. `_regime.classify(provenance,
samples_per_side=...)` already has exactly the right signature for this — **it is reusable verbatim,
with no change to `de.compare`.**

But the reasoning must be recorded, because the naive reading ("the population is matrix-derived ⇒
R2") would kill the feature:

> **DA populations are matrix-derived by construction.** There is no such thing as differential
> abundance over populations that were not derived from the matrix. This is **not** the double-dipping
> failure `de.compare`'s `INV-2` guards against, because the population boundaries were drawn
> **condition-blind**: the clustering never saw the condition label, so the null distribution of the
> abundance statistic is not distorted by the selection. What *is* distorted is the *interpretation*:
> a cluster is an arbitrary partition, so a cluster-level result is sensitive to the clustering
> resolution. That sensitivity is a mandatory disclosure on `da.clusters` (`INV-DA-3`) and is exactly
> the failure `da.neighbourhoods` avoids by being resolution-free.

**The residual, honest risk:** if the population labels *were* derived with knowledge of the
condition — clustering after condition-aware integration, or an annotation transferred from a
condition-matched reference — then the selection **is** circular. We cannot detect that reliably
from `attributes.cyto` today. It is recorded as a **stated limitation in `methods.md`**, not as a
fake guard. Inventing a detector we cannot make sound would be worse than disclosing the gap.

### 3.2 How the reuse is physically realised — and the decision it forces

`run.helpers` are **confined to a package's own tree** (`processors/mod.rs::confine_under_package`
rejects `..`), so a DA package **cannot import** `differential-expression/compute/_regime.py`.
The tree's established answer is **vendoring verbatim + a byte-identical source-parity test** — this
is exactly how `cell-filter`'s `criteria_keep_mask` reaches both `embedding` and
`differential-expression` (`src-app/packages/differential-expression/tests/test_criteria_parity.py`
asserts `inspect.getsource` equality per function).

The alternative is promoting `_regime.py` into the reserved `_helpers` package — but the staging
table is `PY_HELPER_FILES` in `src-app/server/src/modules/sandbox/processors.rs`, so that is a
**server (`src-app`) change**, and it would put a domain-specific statistical classifier into the
set staged into *every* job.

**Recommendation: vendor + byte-identical parity test** (keeps the DEC-9 diff empty), and file the
`_helpers` promotion as an explicit `[shared]` decision for the coordinator — because if **six**
parallel spikes each vendor the same design plumbing, the one-line staging edit starts to look
cheaper than six drifting copies. That call is above this spike's pay grade; it is issue **#1**.

---

## 4. Inputs, prerequisites and the KNN question

### 4.1 There is no KNN-graph artifact, and DA does not need one

Verified across the tree: **no package produces a neighbours/KNN artifact.** Both existing
consumers rebuild it in-process from an `embedding`:

* `clustering.cluster` — *"rebuilds the kNN graph FROM that embedding (never a 2-D UMAP/t-SNE
  layout — `INV-11`)"*, then Leiden;
* `embedding.visualize` — *"Built a k-NN graph over the input embedding"*, then UMAP/t-SNE.

`da.neighbourhoods` takes the **same** edge: `appliesTo: [{slot: embedding, type_id: embedding,
auto_bind_sole_candidate: true}]`, and inherits the **same named refusal** — a 2-D layout is not a
valid input (`INV-11`), enforced compute-side from the declared structure before any read.

This is a real, precise dependency (`embedding.reduce` → `da.neighbourhoods`) and it is a *chaining*
edge the workbench can already answer ("run Reduce dimensions first"). **No new kind, no new
prerequisite package.** Proposing a `neighbors/graph` artifact here would be a gratuitous third
idiom for something the tree already does twice.

### 4.2 Full input table

| Analysis | Slot | Type | Required | Notes |
|---|---|---|---|---|
| `da.neighbourhoods` | `embedding` | `embedding` (≥3 dims) | yes | `auto_bind_sole_candidate`; 2-D layout refused by name |
| | `condition` | `metadata-column` (categorical) | yes | the tested coefficient; `_regime` classified |
| | `sample` | `metadata-column` (categorical) | yes | the unit of replication |
| | `covariate` (0..n) | `metadata-column` | no | additive terms in the design formula |
| | `annotation` | `metadata-column` (categorical) | no | labels neighbourhoods (`nhood_annotation` + purity fraction) for readability only — never enters the model |
| `da.clusters` | `population` | `metadata-column` (categorical) | yes | the cluster / annotation label |
| | `condition`, `sample`, `covariate` | as above | | |
| | `reference` (param) | one level of `population` | no | switches the ALR mode |

**Notably absent: `single-cell/expression`.** DA counts *cells*, not reads. That removes the whole
`INV-13` raw-counts gate, the banded CSC read and the memory ceiling that dominate `de.compare` — a
real simplification. `da.clusters` needs **no matrix artifact at all**: three metadata columns are a
complete input.

### 4.3 Schedule + determinism

`schedule: {class: normal}` (4 GiB / 2 cores / 600 CPU-s), matching every sibling. The
*(nhood × sample)* matrix is tiny; the memory-bound term is the kNN over the embedding plus the
`nhoods` boolean sparse matrix (`nnz ≈ k · prop · n_cells`). A ceiling re-check before the read with
a **named refusal pointing at a reachable lever** is required, mirroring `clustering`'s `INV-10` —
and, as there, the refusal must **not** name a `batch` class, because this package ships no per-run
class control.

**Determinism is load-bearing and non-obvious:** `make_nhoods` draws index cells with a seeded RNG,
and the `np.unique` dedup after refinement makes **`n_nhoods` itself seed-dependent**. `seed` must
be an explicit param (role `seed`), recorded in provenance, with a same-seed-⇒-byte-identical test,
mirroring the determinism pins in `embedding` and `clustering`.

---

## 5. Output kind decision

### 5.1 `de/result` — REJECTED

`de/result` declares `axes: [{name: gene}]` and `entity_axis: gene`, and its whole point is being
*"the gene-axis analog of a `metadata-column`, served through the ordinary gene-axis
annotation-table path"*. A DA row is a **neighbourhood or a cluster**, not a gene. Reusing it would
be a lie about the axis and would misroute the serving path.

### 5.2 `graph/attributed` — REJECTED as primary, kept as an optional secondary `[shared]`

`open-kinds` declares `graph/attributed` with `axes: [node, edge]`, `entity_axis: node`, a CSC
adjacency and a `node_attrs` table whose attrs are **exactly `degree: i64` and `cluster:
categorical`**. Milo's neighbourhood *overlap* graph (`nhood_connectivities`) genuinely is that
shape. But as the **primary** output it fails three ways:

1. the DA **headline is a table** (effect + significance per population), not a graph — an adjacency
   is a secondary readout;
2. carrying `logFC`/`spatial_fdr` on nodes requires **widening `node_attrs`**, i.e. an
   `open-kinds/manifest.yaml` edit (sanctioned by `DEC-9`, but a shared cost);
3. **there is no graph or beeswarm chart kind to plot it with.** Chart kinds are a closed list in
   `src-app/libs/viz/src/viz-core/charts/chartSchemas.ts` (`scatter, bar, box, violin, dotplot,
   heatmap, histogram, image, volcano, grid`). Adding `beeswarm` or a node-link view is a
   `src-app/libs/viz` change — a **direct violation of the zero-`src-app`-diff invariant.**

So the neighbourhood graph is deferred to increment 2, and the `node_attrs` widening is filed as a
**`[shared]`** issue — **the trajectory spike is evaluating the same kind**, and if both need
widened node attributes, one `open-kinds` version bump serves both.

### 5.3 NEW kind `da/result` — ADOPTED

A columnar table over a new `population` axis, structurally a mirror of `de/result`:

```yaml
- id: da/result
  extends: tabular
  title: DA result (per-population abundance table)
  is_abstract: false
  axes:
    - { name: population, key_label: population_id }
  entity_axis: population
  storage: { layout: { kind: columnar_table }, format: zarr, file_layout: single }
  capabilities: [da-result]
  arrays:
    - name: table
      kind: annotation-table
      dims: [{ axis: population }]
      attrs:
        - { name: logFC,        dtype: f32 }   # log2 abundance fold-change
        - { name: neglog10p,    dtype: f32 }   # G1: -log10(p), NEVER raw p.   R1 only
        - { name: padj,         dtype: f32 }   # plain BH within the run.      R1 only
        - { name: spatial_fdr,  dtype: f32 }   # connectivity-weighted BH.     R1 + nhoods only
        - { name: n_cells,      dtype: f32 }   # population size (all samples)
        - { name: mean_prop_1,  dtype: f32 }   # mean per-sample proportion, side 1
        - { name: mean_prop_2,  dtype: f32 }
        - { name: n_samples_1,  dtype: f32 }   # DISTINCT samples contributing, side 1
        - { name: n_samples_2,  dtype: f32 }
        - { name: score,        dtype: f32 }   # the ranking column
      layout: { kind: columnar_table }
```

Three properties earned by this shape:

* **Absence-is-absence carries over.** `neglog10p` / `padj` / `spatial_fdr` are **declared** but
  written **only** in an R1 regime; an R2/R3 artifact **omits** them (absent, not 1) — the same
  producer-opt-in rule `de/result` already uses.
* **It plots for free.** The shipped `volcano` chart kind takes `encode: {effectColumn,
  significanceColumn}` **from the section YAML**, so a DA volcano is `effectColumn: logFC`,
  `significanceColumn: neglog10p` with **zero** `src-app` change. A DA result is genuinely
  volcano-shaped (effect vs significance over many entities) — this is reuse, not a workaround.
* **The per-run index rides a `report/qc` document**, `kind: da-report`, exactly as `de-report`
  does, giving the Visualize section its `comparisons` / `groups` / `grouped` rows with a regime
  qualifier per row.

**Where to declare it.** The DA package can declare `contributes.datatypes` itself (packages already
do: `single-cell-types`, `open-kinds`). **Recommendation: declare `da/result` inside the
`differential-abundance` package**, which keeps the non-package `src-app` diff literally empty. The
alternative — adding it to `open-kinds` — is sanctioned by `DEC-9` but couples the DA release to a
shared manifest. `scripts/check-derived-vocabulary.sh` **derives** its forbidden vocabulary from
every package's `contributes.datatypes[].id`, so the new id is guarded automatically either way; no
hand-list needs editing.

Secondary outputs: **`metadata-column`** — for `da.clusters` only, an optional per-cell column
carrying the population's signed effect, which colours the UMAP for free via the shipped colour-by
section. **Deliberately not emitted by `da.neighbourhoods`**: a cell belongs to *many* overlapping
neighbourhoods, so a per-cell effect would require an arbitrary reduction, and inventing one to fill
a column would be exactly the kind of quiet fabrication `INV-3` exists to prevent.

---

## 6. Invariants

**`INV-DA-1` — compositional handling is declared, or the run refuses.**
No abundance statistic is ever computed from raw proportions by an independent per-population test.
Every p-value comes from a **count** model over the integer *(population × sample)* matrix under an
**explicitly named** normalization — either robust size factors (`poscounts`) **or** a named
reference population (ALR) — and that normalization **and the assumption it makes** are narrated in
`methods.md` by name. A run that cannot establish a normalization (e.g. `reference` names a
population absent from a sample) **refuses by name**; it never falls back to proportions.

**`INV-DA-2` — the unit of replication is the sample, never the cell.**
The count matrix's column space is samples. `< 2` samples on either side ⇒ **R3**: ranked effects
only, `neglog10p`/`padj`/`spatial_fdr` **ABSENT**, not 1. Units below `min_cells` are dropped **and
recorded**, never silently omitted. `_regime.py` is reused verbatim (§3.2).

**`INV-DA-3` — the regime is classified on the CONDITION, and the population's derivation is
disclosed, not punished.**
`_regime.classify` is applied to the condition (and sample) column's provenance — **never** the
population's. DA populations are matrix-derived by construction; because they are drawn
**condition-blind** this is not `de.compare`'s circular selection. `da.clusters` results carry a
**mandatory** resolution-sensitivity disclosure; `da.neighbourhoods` results state that they are
resolution-free. The undetectable case (populations derived *with* knowledge of the condition) is a
**stated limitation**, not a simulated guard.

**`INV-DA-4` — overlapping neighbourhoods get spatial FDR, and both corrections are recorded.**
Neighbourhoods overlap, so plain BH over them is anti-conservative in dense graph regions.
`da.neighbourhoods` **must** apply connectivity-weighted BH (`w = 1/kth_distance`) and writes
**both** `padj` (plain) and `spatial_fdr`; every threshold, badge and headline reads `spatial_fdr`.
`da.clusters` writes `padj` only and **omits** `spatial_fdr` (clusters are disjoint — a weight there
would be meaningless, and emitting a meaningless column is worse than omitting it).

---

## 7. Acceptance: "it runs" is not the bar

An invalid compositional test **runs perfectly** and returns confident false positives. So the
acceptance bar is behavioural, and its centrepiece is a test that a broken implementation
**cannot** pass.

### `[acceptance] TEST-DA-POWER` — recovery of a known shift
Simulated dataset: `P = 12` populations, `R = 5` replicates per condition, one population given a
true 2× abundance shift; per-sample totals drawn with realistic over-dispersion. **Assert** the
shifted population is recovered at target FDR 0.10 in ≥ 18/20 seeds.

### `[acceptance] TEST-DA-FDR` — FDR control on the null
`M = 200` fully-null simulations (no population shifted). **Assert** the observed false-positive
rate ≤ 0.10 within an exact binomial CI. A method with no compositional handling can still pass
*this* one — which is why it is not sufficient on its own.

### `[acceptance] TEST-DA-NEGATIVE-CONTROL` — the un-gameable one
The **compositional-confounding** fixture: exactly one population truly up, all `P-1` others
genuinely unchanged in absolute terms (so their *proportions* mechanically fall).

* **Assert our estimator** reports ≤ 1 of the `P-1` unchanged populations as significant at FDR 0.10.
* **Assert the naive per-population t-test on proportions**, run on the **same** fixture by the test
  itself, reports **≥ 4** of them — i.e. it **fails**.

Both halves are required. The second is what makes the first meaningful: a test that a broken
implementation would also pass is not a test. This test is the executable form of `INV-DA-1`.

### `[acceptance] TEST-DA-PARITY` — two-tier reference parity
Exact numeric parity with `miloR` is **not achievable and should not be claimed**: miloR uses
edgeR's quasi-likelihood F-test, we use PyDESeq2's Wald test. Two honest tiers instead:

| Tier | Reference | Bar |
|---|---|---|
| **Tight** | **`pertpy.tools.Milo` with `solver="pydeseq2"`** — the *same* statistical engine we implement against | Given identical neighbourhoods and identical *(nhood × sample)* counts (both committed as fixtures): `max abs(Δ logFC) ≤ 1e-6`, `max abs(Δ neglog10p) ≤ 1e-6`, `spatial_fdr` identical to 1e-9 |
| **Loose** | **`miloR`** (Bioconductor) on a named public dataset | Spearman ρ(logFC) ≥ 0.95 over neighbourhoods matched by index cell; sign agreement on **all** neighbourhoods with `abs(logFC) > 0.5`; ≥ 15/20 overlap in the top-20 by spatial FDR |

Because neither R nor Python 3.12 is available in the sandbox or CI (§2.2), **both references are
committed golden fixtures generated out-of-band**, together with the **committed generation
script**, so the recipe is reproducible even though the run is not in CI. This is stated plainly as
a limitation rather than dressed up as a live parity run. Neighbourhood matching is by index cell,
which requires the committed `prop` and `seed` — hence the determinism pin in §4.3.

Supporting pins: `TEST-DA-DETERMINISM` (same seed ⇒ byte-identical outputs, including `n_nhoods`),
`TEST-DA-ABSENCE` (an R2/R3 artifact **omits** the p-family columns entirely).

---

## 8. Assets and licensing

**The analysis needs no assets** — no gene sets, no reference atlas, no downloaded model, no
network access. Confirmed against the sibling packages: `geneset` is the only one with an asset
question, and DA has none.

The **only** licensing question is the §7 parity fixture. Mitigation, in preference order:
1. commit **only derived summary statistics** (the reference `logFC` / `PValue` / `SpatialFDR`
   table plus the neighbourhood index-cell ids) — a few tens of KB, no primary data redistributed;
2. if a primary-data fixture is unavoidable, use a dataset under a redistribution-permitting licence
   (e.g. the `MouseThymusAgeing` data used by the Milo paper) and record the licence in the fixture
   directory. Controlled-access datasets (EGA-gated COVID PBMC cohorts) must **not** be committed.

Recommendation: **(1)**. It is sufficient for both parity tiers and removes the question entirely.

---

## 9. Platform obligations (missing any of these ships broken)

| Obligation | What DA must do |
|---|---|
| **`methods:` block** | `subject: {singular: population, plural: populations}` (both **required**), `action`, `commits`, `commits_unlabeled`, `note`, `params`. Build-gated by `src-app/server/build_helper/processor_manifest.rs` with `deny_unknown_fields` — a typo'd role fails `cargo build`, not boot |
| **param roles** | Closed vocabulary, exactly: `predicate_list`, `threshold_list`, `opaque_predicate`, `allow_list`, `subsample_cap`, `seed`, `output_label`. Map `seed: seed`, `name: output_label`, and the FDR/`min_cells` thresholds as `threshold_list` |
| ⚠️ **the `note` trap** | `methods.rs` appends `note` **only when ≥ 1 constraint was narrated**. A DA declaration with *no* constraint-producing param role would **silently drop the compositional-correctness disclosure from `methods.md`** — the out-of-app trust deliverable. **DA must declare at least one `threshold_list` param** so the note renders. This is easy to miss and is why it is its own issue |
| **undeclared params** | Auto-disclosed by name in a trailing sentence (`` Additional recorded parameters are NOT narrated here…: `x`, `y` ``). So `method`, `design`, `prop`, `k`, `reference` are disclosed for free — but **the statistical model and the design formula must still be narrated explicitly**, in `note`, not left to the by-name fallback |
| ⚠️ **`{name}` does not substitute** | `methods.rs` replaces the literal token `{label}` only. `clustering`, `differential-expression`, `geneset` and `embedding` all declare `{name}` / `{n_pcs}` / `{method}` placeholders that render **verbatim** into `methods.md`. **DA must use `{label}` or no placeholder** — do not copy the sibling bug |
| **`methodsText`** | A separate, **frontend-only** `$`-interpolated string (`loadProcessors.ts`). Nothing in Rust reads it; nothing in the FE reads `methods`. Both are required, and they must not contradict each other |
| **Kind declaration** | `da/result` + `entity_axis: population` (build-gated: it must name a declared axis) |
| **Seed versions** | `scripts/check-processor-seed-versions.sh`: a **new** package is explicitly `exempt` (*"introduced on this branch; version-bump rule N/A"*), but it needs a **column-0 `version:`** key, and every later content change requires a forward bump (`sort -V`; backwards = FAIL) |
| **Registration** | **None.** `include_dir!("$CARGO_MANIFEST_DIR/../packages")` in `extensions/embedded.rs` bakes the whole tree. Dropping `src-app/packages/differential-abundance/` in *is* the registration — no Rust list, no build-script entry |
| **pytest** | `src-app/packages/pytest.ini` `testpaths` is an **enumeration** — a package whose suite is not listed is collected by **nothing**. Add `differential-abundance/tests` in the **same commit** that creates it. This is the **only** non-package `src-app` edit the feature needs |
| **Viz section** | A `sections:` entry, `pane: visualize`, `applies_to: [{type_id: da/result}]`, `entry_list` over the `da-report` index with a regime qualifier + `Plot ▸` → the **existing** `volcano` chart kind. **No new chart kind** (§5.2) |
| **Guards not affected** | `check-package-suites.mjs` (npm workspaces only), `check-guard-integrity.sh` (guard scripts only), `check-kinds-zero-core.sh` (a narrower legacy pin) — none need editing. `capture-surface-baseline.mjs`'s `SHIPPING_SPECS` is a genuine hand-list; adding the DA view there is optional |

---

## 10. DAG decomposition

```
                       EPIC: Differential abundance analysis
                                     │
  ┌──────────────────┬───────────────┼────────────────┬──────────────────────┐
  │                  │               │                │                      │
[shared]        [decision]      da/result kind   graph/attributed      (independent)
design plumbing  no new rootfs     (#3)          node_attrs [shared]
   (#1)            dep (#2)                          (#13, incr-2)
  │                  │  │               │
  └────────┬─────────┘  │               │
           ▼            ▼               │
   compositional kernel (#4) ◄──────────┘ (kind consumed by both analyses)
     │                    │
     │                    └────────────► [acceptance] INV-DA-1 battery (#9)
     │
     ├──────────────► da.clusters (#5) ──┬──► DA volcano viz section (#12)
     │                                    │
     │        nhood construction (#6) ──► spatial FDR (#7)
     │                    │                    │
     │                    └────────┬───────────┘
     └─────────────────────────────▼
                        da.neighbourhoods (#8) ──► [acceptance] parity (#10)
                                    │
                    (#5 + #8) ──► methods.md narration (#11)
```

**Critical path:** `#2 → #4 → #8 → #10`. **Cheapest first real value:** `#3 → #4 → #5` — cluster-level
DA needs no embedding, no matrix and no neighbourhood machinery, so it de-risks the statistical
kernel behind a small surface before the Milo half lands.

---

## 11. `[shared]` items — for the coordinator's dedupe across the 6 parallel spikes

1. **Experimental-design plumbing (condition × sample)** — issue **#1**. Owned originally by
   `de.compare`. *Any* spike proposing a replicate-aware inferential test (DA here; likely also
   perturbation / cell-cell-communication / any pseudobulk-shaped analysis) needs the same
   condition+sample picker pair, the same `inputs_from`/`obsSources` binding and the same
   `_regime.py` classifier. Because `run.helpers` are package-confined, each consumer must
   **vendor** it. **The decision the coordinator owns: N vendored copies vs. one `PY_HELPER_FILES`
   promotion** (a one-line `src-app` change that buys a single source of truth). This spike
   recommends vendoring for one consumer and promotion at three or more.
2. **`graph/attributed` `node_attrs` widening** — issue **#13**. `open-kinds` currently declares
   `node_attrs` as exactly `degree: i64` + `cluster: categorical`. **The trajectory spike is
   evaluating the same kind.** If both need to carry analysis-result attributes on nodes, **one**
   `open-kinds` version bump should serve both — do not let two spikes each bump it. Not on DA's
   critical path (increment 2).
3. **Chart-kind ceiling (informational, not an issue here).** Chart kinds are a closed list in
   `src-app/libs/viz`. DA avoids it by reusing `volcano`. Any spike that concludes it needs a *new*
   chart kind is proposing a `src-app` change and should surface that cost explicitly rather than
   discovering it during implementation.

---

## 12. Feasibility verdict

**Feasible, with one honest caveat.**

What is genuinely easy: the statistical engine (`pydeseq2`) is already pinned and already in
production here; the design plumbing exists and is directly reusable; the kNN-from-embedding idiom
exists twice already; the output is volcano-shaped so no viz work is needed; and `da.clusters`
requires **no matrix artifact at all**. The non-package `src-app` diff is a single line in
`pytest.ini`.

What is genuinely hard, and should not be understated: **we are implementing the Milo algorithm
rather than importing it**, because every off-the-shelf DA library needs R, TensorFlow, or a Python
version bump this rootfs cannot absorb. The four pieces are small and fully specified (§2.3), but
"small and specified" is not "free" — the correctness rests on **our** neighbourhood construction
and **our** spatial FDR, which is exactly why the acceptance bar in §7 is behavioural (power, FDR
control, a failing negative control, two-tier parity) rather than "it runs". If the acceptance
battery is descoped, this feature should not ship: an invalid compositional test is worse than no
test, because it produces confident, plausible, wrong answers that a reader has no way to detect.
