#!/usr/bin/env python3
# ruff: noqa
"""#157 — a spatially-imported matrix runs the FULL existing chain, unmodified.

`docs/design/spatial-storage-layout.md` §9 makes the epic's central architectural bet:

    a spatial dataset's expression matrix must remain usable by existing analyses
    (QC, clustering, DE), with spatial as *additional* artifacts.
    … Nothing needs to know it is spatial.

If that holds, spatial data inherits every existing analysis for free. If it does not,
every analysis needs a spatial branch and the design is wrong. Until this file, **nobody
had run it**.

## The experiment, and why it has THREE arms

* **spatial** — `spatial.import-visium` over the committed real Space Ranger bundle.
* **control** — the SAME `filtered_feature_bc_matrix.h5` through `anndata.import`, the
  ordinary importer, which knows nothing about tissue positions or coordinate spaces.
* **spatial-marked** — the spatial arm's matrix with the spatial declarations
  (`platform`, `measured_entity`, `coordinate_space`, `microns_per_pixel`, `positioning`,
  `section`) stamped into the store's own `attributes.txr`.

Then the IDENTICAL chain over each: `qc.10x` → `cell.filter` → `embedding.reduce` →
`clustering.cluster` → `de.markers` → `de.compare`, driven by one body of code
(`ChainRun`), with the shipped entries at their shipped paths and no manifest touched.

**Why two arms were not enough, stated plainly because it was measured rather than
guessed.** The first version of this file had only `spatial` and `control`, and a blind
audit showed the comparison between them could not fail: the two importers emit
BYTE-IDENTICAL matrices whose in-store `attributes.txr` are also identical, and
`inputs.json` carries only `{slot, kind, content_hash, sandbox_path}` — no datatype, no
`meta`. No compute in the chain had any channel through which it *could* learn the matrix
was spatial, so cross-arm equality was ENTAILED by byte-identity plus determinism. The
auditor proved it by corrupting a real `qc.10x` metric: every test stayed green.

The **spatial-marked** arm is the repair. `attributes.txr` is the one declaration channel
that genuinely reaches a sandboxed analysis (it is bytes inside the hardlinked zarr store,
unlike the catalog-only `meta` that #211 is about). An arm that announces itself as spatial
*through that channel* and still produces an identical answer is a real measurement of
"nothing needs to know it is spatial" — and it doubles as a forward-looking test of what
would happen if #211 were fixed and every declaration became visible.

**What the marked arm does NOT reach**, said out loud so it is not read as covering INV-2
whole: it stamps only the EXPRESSION store, so the other bound stores' `attributes.txr`
(gene symbols, QC columns, the reduced layout, the grouping) are unmarked; the catalog
DATATYPE that drives SELECTION (`single-cell/counts` vs `single-cell/expression`) is never
exercised by a real bind — it is covered statically by `test_visium_chain_selectors.py`
reading the shipped manifests; and no arm places a `spatial/*` sibling artifact in front of
a chain consumer, so "a consumer notices a spatial artifact in the same dataset" is not
covered anywhere on this branch.

**Assert on outputs, never on exit codes.** Every leg reads its artifacts back out of the
store and checks their content. `ChainStep.run_ok` does check the exit status, but no test
here rests on it: a chain that ran to completion and produced a degenerate answer — an
all-zero QC column, a mask that kept everything, a rank-1 PCA, one cluster — passes an
exit-code test and fails this one.

## What this file deliberately does NOT do

It does not fix, work around, or quietly route around **#203** (a 2-D obs-aligned artifact
through a filter VD serves plausible wrong numbers) or **#211** (spatial declarations are
invisible to a sandboxed consumer). Where the chain meets them, the measurement is the
deliverable. The filter half of that lives in
`src-app/server/tests/workstore/spatial_filter_vd_test.rs`, because the behaviour is the
Rust gather's, not this chain's — `cell.filter`'s compute emits only a keep-mask, and the
filtered matrix a downstream analysis actually consumes is minted server-side.
"""
import json
import re
import sys
import warnings
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_chain_fixtures as VC  # noqa: E402


# ── the three arms, run ONCE for the whole module (they are not cheap) ──────────────
@pytest.fixture(scope="module")
def spatial_arm(tmp_path_factory):
    base = tmp_path_factory.mktemp("visium-spatial")
    return VC.ChainRun(base / "chain", VC.import_visium(base / "import")).run()


@pytest.fixture(scope="module")
def control_arm(tmp_path_factory):
    base = tmp_path_factory.mktemp("visium-control")
    return VC.ChainRun(base / "chain", VC.import_ordinary(base / "import")).run()


@pytest.fixture(scope="module")
def marked_arm(tmp_path_factory):
    base = tmp_path_factory.mktemp("visium-marked")
    return VC.ChainRun(base / "chain", VC.import_visium_marked(base / "import")).run()


# ════════════════════════════════════════════════════════════════════════════════════
#  TEST-8 — the harness's own load-bearing property
# ════════════════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("arm", ["spatial_arm", "control_arm"])
def test_the_harness_binds_by_slot_under_meaningless_mounts(arm, request):
    """TEST-8 [covers: ITEM-1] — every other test in this file rests on this one.

    The chain is only evidence about SLOT resolution if the staged paths carry no
    information. A compute that resolved by filename — the exact fallback
    `qc-10x.py:155-170` was written to delete, and one that `anndata-import` still has
    (`h5ad_import.py` dispatches on `Path(src).name.lower()` and globs `*.h5`) — would
    otherwise pass this suite while being broken in production, where the mount name is
    derived from the ARTIFACT.

    Run over BOTH arms, and asserting the FULL path rather than its first segment. Both of
    those were corrections: the control arm is the only one that binds a FILE, and the
    first version staged it as `in0/filtered_feature_bc_matrix.h5` — the vendor filename
    fully intact — while checking only the leading `in0`. The one arm that could have
    tested the claim was the one arm not tested.
    """
    run = request.getfixturevalue(arm)
    steps = [run.importer, run.qc, run.filter, run.reduce, run.cluster,
             run.markers, run.compare]
    pattern = re.compile(r"^/inputs/in\d+$")
    seen = 0
    for step in steps:
        declared = json.loads((step.inputs_dir / "inputs.json").read_text())["inputs"]
        assert declared, f"{step.analysis} declared no inputs"
        for entry in declared:
            assert pattern.match(entry["sandbox_path"]), (
                f"{step.analysis} bound slot {entry['slot']!r} at "
                f"{entry['sandbox_path']!r}; a staged path must carry NO hint of the slot, "
                f"the datatype or the source filename, or 'resolved by slot' is not "
                f"something this suite observed")
            assert entry["slot"], "every binding must name a slot"
            assert set(entry) == {"slot", "kind", "content_hash", "sandbox_path"}, (
                f"the harness wrote {sorted(entry)}; production's `render_inputs_json` "
                f"emits exactly those four fields, and a harness that fed a compute more "
                f"than production does would prove nothing about production")
            seen += 1
        assert step.proc is not None and step.proc.returncode == 0
    assert seen >= 10, f"expected the chain to declare many bindings, saw {seen}"


# ════════════════════════════════════════════════════════════════════════════════════
#  TEST-1 [acceptance] [INV-1] — the chain runs, and its outputs are not degenerate
#
#  One test per leg, over the SAME module-scoped fixture, so a failure in an early leg
#  does not hide the state of the later ones. (A single six-leg test reported only its
#  first failure — demonstrated during the blind audit, where a broken `cell.filter`
#  aborted the body before embedding, clustering or either DE leg was evaluated.)
# ════════════════════════════════════════════════════════════════════════════════════


def test_qc_runs_on_a_spatially_imported_matrix(spatial_arm):
    """TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-2, ITEM-4] — leg 1."""
    run = spatial_arm
    names = {VC.column_label(e) for e in run.qc_columns}
    assert {"total_counts", "n_genes", "pct_mito", "pct_ribo"} <= names, sorted(names)
    for metric in ("total_counts", "n_genes", "pct_mito", "pct_ribo"):
        values = np.asarray(run.qc_values(metric), dtype=float)
        assert values.shape == (run.n_cells,), f"{metric} is {values.shape}"
        assert np.isfinite(values).all(), f"{metric} carries non-finite values"
        assert (values >= 0).all(), f"{metric} carries negatives"
        assert len(np.unique(values)) > 1, (
            f"{metric} is CONSTANT across all {run.n_cells} spots — a degenerate column "
            f"that a successful exit would not distinguish from a computed one")
    assert (np.asarray(run.qc_values("pct_mito"), dtype=float) <= 100.0).all()


def test_cell_filter_runs_on_a_spatially_imported_matrix(spatial_arm):
    """TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-2, ITEM-4] — leg 2."""
    mask = spatial_arm.mask()
    assert len(mask) == spatial_arm.n_cells
    assert 0 < sum(mask) < spatial_arm.n_cells, (
        f"the keep-mask kept {sum(mask)} of {spatial_arm.n_cells} — a filter that keeps "
        f"everything or nothing is a no-op and cannot show that filtering works here")


def test_embedding_reduce_runs_on_a_spatially_imported_matrix(spatial_arm):
    """TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-2, ITEM-4] — leg 3."""
    emb = spatial_arm.embedding()
    assert emb.ndim == 2 and emb.shape[0] == spatial_arm.n_cells, emb.shape
    assert np.isfinite(emb).all(), "the PCA carries non-finite values"
    variances = emb.var(axis=0)
    assert variances[0] > 0, "PC1 has zero variance — the embedding is degenerate"
    assert np.all(np.diff(variances) <= 1e-4), (
        "component variances are not non-increasing; a PCA whose components are not "
        "rank-ordered by variance is not a PCA")


def test_clustering_runs_on_a_spatially_imported_matrix(spatial_arm):
    """TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-2, ITEM-4] — leg 4."""
    labels = spatial_arm.labels()
    assert len(labels) == spatial_arm.n_cells, (
        f"{len(labels)} labels for {spatial_arm.n_cells} cells — the partition lost rows")
    assert len(spatial_arm.cluster_levels()) >= 2, (
        "clustering returned a single cluster; that is the degenerate answer, and it is "
        "also what would silently disable both DE legs")


def test_de_markers_runs_on_a_spatially_imported_matrix(spatial_arm):
    """TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-2, ITEM-4] — leg 5."""
    run = spatial_arm
    entries = run.de_entries(run.markers)
    assert len(entries) == len(run.cluster_levels()), (
        f"de.markers emitted {len(entries)} results for {len(run.cluster_levels())} clusters")
    for entry in entries:
        log_fc = np.asarray(run.de_column(run.markers, entry, "logFC"), dtype=float)
        assert log_fc.shape == (run.n_genes,), (
            f"{entry['id']} covers {log_fc.shape}, expected the full {run.n_genes} genes")
        assert np.isfinite(log_fc).all(), f"{entry['id']} carries non-finite logFC"
        assert len(np.unique(log_fc)) > 1, f"{entry['id']} logFC is constant"


def test_de_compare_runs_on_a_spatially_imported_matrix(spatial_arm):
    """TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-2, ITEM-4] — leg 6."""
    run = spatial_arm
    entries = run.de_entries(run.compare)
    assert len(entries) == 1, [e["id"] for e in entries]
    log_fc = np.asarray(run.de_column(run.compare, entries[0], "logFC"), dtype=float)
    assert log_fc.shape == (run.n_genes,)
    assert np.isfinite(log_fc).all()
    assert len(np.unique(log_fc)) > 1


# ════════════════════════════════════════════════════════════════════════════════════
#  TEST-2 [acceptance] [INV-2] — "Nothing needs to know it is spatial"
# ════════════════════════════════════════════════════════════════════════════════════


def test_the_two_arms_are_given_the_same_gene_symbols(spatial_arm, control_arm):
    """The control's precondition, asserted rather than trusted.

    The two importers spell the gene-symbol column differently
    (`metadata-column:gene_symbol` vs the `genes_index` that `sc.read_10x_h5` fills from
    `var_names`), and `qc.10x`'s default `pct_mito`/`pct_ribo` patterns match SYMBOLS. Bind
    the wrong one and the control reports 0.0 % mito against the spatial arm's real value —
    a cross-arm "difference" that is entirely an artefact of the harness. That is not
    hypothetical: it is what the first run of this suite did.
    """
    spatial = [str(v) for v in VC.read_column(VC.gene_symbol_store(spatial_arm.importer))]
    control = [str(v) for v in VC.read_column(VC.gene_symbol_store(control_arm.importer))]
    assert spatial == control, (
        "the two arms were handed different gene-symbol columns, so any downstream "
        "difference between them would be unattributable")
    assert any(g.lower().startswith("mt-") or g.lower().startswith("rp") for g in spatial), (
        "no mitochondrial or ribosomal symbol is present in the fixture's gene set, so the "
        "pct_mito / pct_ribo legs would be vacuously equal at 0.0 on both arms")


def test_the_spatial_matrix_is_byte_identical_to_the_ordinary_import(
        spatial_arm, control_arm):
    """The SUBSTRATE check — not, by itself, a proof of INV-2.

    Two independent importers, one file, and the CSC members compared element for element.
    This establishes that the arms ARE one matrix; it does NOT establish that the chain
    treats a spatial matrix the same as a non-spatial one, because with identical bytes the
    chain has nothing to treat differently. That claim needs the marked arm below —
    a distinction the first version of this file got wrong by crediting these as two
    independent halves of one acceptance test.
    """
    spatial_entry = VC.expression_entry(spatial_arm.importer)
    control_entry = VC.expression_entry(control_arm.importer)

    assert spatial_entry["structure"]["kind"] == "sparse_csc"
    assert control_entry["structure"]["kind"] == "sparse_csc"
    assert spatial_entry["structure"]["shape"] == control_entry["structure"]["shape"]
    assert spatial_entry["structure"]["nnz"] == control_entry["structure"]["nnz"]
    assert spatial_entry["structure"]["axes"] == control_entry["structure"]["axes"]
    assert spatial_entry["datatype"] != control_entry["datatype"], (
        "the two arms must SPELL the datatype differently (`single-cell/counts` vs "
        "`single-cell/expression`) — if they had converged, the selector claim in "
        "test_visium_chain_selectors.py would be about one datatype, not two")

    spatial_members = VC.csc_members(spatial_arm.importer.store(spatial_entry))
    control_members = VC.csc_members(control_arm.importer.store(control_entry))
    for member in ("data", "indices", "indptr"):
        assert np.array_equal(spatial_members[member], control_members[member]), (
            f"the CSC `{member}` member differs between the spatial importer and the "
            f"ordinary one — the two arms are not the same matrix, so every cross-arm "
            f"comparison would be measuring the importers rather than the chain")


def test_the_chain_treats_the_two_importers_matrices_identically(spatial_arm, control_arm):
    """Two importers, one answer.

    Weaker than it looks and labelled accordingly: given the byte-identity above plus the
    determinism leg, this is very nearly entailed. It is kept because the entailment has
    premises that could break — an importer could start emitting a different `nnz`, or a
    consumer could begin reading the manifest `datatype` (which the two arms DO spell
    differently) — and this is what would notice.
    """
    _assert_chain_outputs_agree(spatial_arm, control_arm, "the ordinary importer's")


def test_the_chain_ignores_spatial_declarations_it_CAN_see(spatial_arm, marked_arm):
    """TEST-2 [acceptance] [invariant: INV-2] [covers: ITEM-3] — the real experiment.

    §9: "**Nothing needs to know it is spatial.**"

    The marked arm's matrix is byte-identical to the spatial arm's in every CSC member, but
    its store's `attributes.txr` additionally declares `platform: visium`,
    `measured_entity: {kind: spot, resolution_um: 55}`, a `coordinate_space`, a
    `microns_per_pixel`, a `positioning` and a `section`. That is the ONE declaration
    channel a sandboxed compute can actually read — `sandbox/inputs.rs` hardlinks a stored
    artifact's members, so the store's own `zarr.json` arrives verbatim, while the catalog
    `meta` never crosses (#211).

    So a consumer that dispatched on any of those — the special-casing §9 forbids —
    would produce a different answer HERE and nowhere else in this suite. Every leg is
    required to be unchanged.

    This is also a forward-looking test of #211: it says what happens to the existing chain
    on the day those declarations DO become visible. The answer must be "nothing".
    """
    marked_attributes = VC.store_txr_attributes(
        marked_arm.importer.store(VC.expression_entry(marked_arm.importer)))
    for key in VC.SPATIAL_MARKERS:
        assert key in marked_attributes, (
            f"the marked arm does not actually declare {key!r} in the store's "
            f"attributes.txr, so this test would be comparing two identical matrices "
            f"and could not fail")
    plain_attributes = VC.store_txr_attributes(
        spatial_arm.importer.store(VC.expression_entry(spatial_arm.importer)))
    assert not (set(VC.SPATIAL_MARKERS) & set(plain_attributes)), (
        "the UNMARKED arm already carries a spatial declaration in attributes.txr, so the "
        "two arms do not differ and this experiment has no variable")
    assert plain_attributes["nnz"] == marked_attributes["nnz"], (
        "the marker stamp changed the matrix's structural declaration; it must ADD keys "
        "only, or a divergence below would be about the bytes rather than the markers")

    _assert_chain_outputs_agree(spatial_arm, marked_arm, "a matrix declaring itself spatial")


def _assert_chain_outputs_agree(left, right, what: str):
    """Every leg of two ChainRuns, compared EXACTLY.

    Exact, not tolerant: both arms run every leg at `seed: 0` with the BLAS thread count
    pinned to 1 (`ChainStep.run`), over inputs whose CSC members are equal element for
    element. The pipeline is deterministic under those conditions — which is what the
    determinism leg establishes — so an approximate comparison could only hide a real
    divergence.
    """
    for metric in ("total_counts", "n_genes", "pct_mito", "pct_ribo"):
        a = np.asarray(left.qc_values(metric), dtype=float)
        b = np.asarray(right.qc_values(metric), dtype=float)
        assert np.array_equal(a, b), (
            f"qc.10x computed a different `{metric}` for the spatial matrix "
            f"(median {np.median(a):.6g}) than for {what} (median {np.median(b):.6g})")

    assert left.mask() == right.mask(), f"cell.filter kept a different subset for {what}"
    assert np.array_equal(left.embedding(), right.embedding()), (
        f"embedding.reduce produced a different PCA for {what}")
    assert left.labels() == right.labels(), (
        f"clustering.cluster produced a different partition for {what}")

    for step_name in ("markers", "compare"):
        left_step, right_step = getattr(left, step_name), getattr(right, step_name)
        left_entries = left.de_entries(left_step)
        right_entries = right.de_entries(right_step)
        assert [e["id"] for e in left_entries] == [e["id"] for e in right_entries], (
            f"de.{step_name} emitted a different result set for {what}")
        assert left_entries, f"de.{step_name} emitted NO results, so this loop is vacuous"
        for left_entry, right_entry in zip(left_entries, right_entries):
            for member in ("logFC", "score"):
                a = np.asarray(left.de_column(left_step, left_entry, member), dtype=float)
                b = np.asarray(right.de_column(right_step, right_entry, member), dtype=float)
                assert np.array_equal(a, b), (
                    f"de.{step_name} {left_entry['id']} `{member}` differs for {what}")


# ── TEST-13: determinism, which is what makes the comparisons above mean something ──


def test_the_chain_is_deterministic_at_a_fixed_seed(spatial_arm, tmp_path):
    """TEST-13 [covers: ITEM-4] — reproducibility, and an HONEST statement of its limit.

    **What this establishes.** Re-running `embedding.reduce` and `clustering.cluster` at the
    same seed, from a fresh staging directory, reproduces the same PCA and the same
    partition. That is what the exact cross-arm comparisons elsewhere in this module rest
    on: without it, an agreement could be luck and a difference could not be attributed to
    the importer.

    **What it does NOT establish, stated because two successive attempts to establish it
    both failed.** There is no working negative control on the seed here.

    * The first attempt ran at `seed: 1, resolution: 2.5` and required a different
      partition. It passed — but `resolution` alone changes a Leiden partition, so it could
      not distinguish "the seed is honoured" from "the seed is ignored and the resolution
      is honoured", which is the entire question.
    * The second attempt varied only the seed. **Measured: the partition is identical.**
      That is a property of this fixture (120 well-separated spots over 150 genes leave
      Leiden no ties to break), not a defect — but it means the partition cannot observe
      whether the seed was used.
    * The third attempt asserted that the run report records the seed. A blind audit broke
      that too: `cluster.py` resolves `seed` once and uses the SAME local for both the RNG
      and the report line, so replacing `random_state=seed` with `random_state=0` — fully
      disconnecting the parameter from the algorithm — left the assertion green.

    So the report assertion below is kept for what it genuinely proves — the parameter is
    PARSED and reaches the compute's own record — and is labelled as exactly that. **Whether
    the seed reaches the partitioner is UNVERIFIED on this fixture.** Closing it needs a
    tie-prone fixture where the partition is seed-sensitive; that is a fixture problem, not
    an assertion problem, and inventing a second moving parameter to hide it is what made
    the first attempt vacuous.
    """
    rerun = VC.ChainRun(tmp_path / "rerun", spatial_arm.importer)

    reduce_step = VC.ChainStep(rerun.base / "3-embed", "embedding.reduce")
    reduce_step.bind("matrices", rerun.expression)
    reduce_step.run_ok({})
    entry = reduce_step.entries(datatype="embedding")[0]
    embedding = VC.read_array(reduce_step.store(entry),
                              entry["structure"]["arrays"][0]["path"])
    assert np.array_equal(embedding, spatial_arm.embedding()), (
        "embedding.reduce is not reproducible at a fixed seed on this matrix")

    cluster_step = VC.ChainStep(rerun.base / "4-cluster", "clustering.cluster")
    cluster_step.bind("embedding", reduce_step.store(entry))
    cluster_step.bind("expression", rerun.expression)
    cluster_step.run_ok({})
    labels = [str(v) for v in
              VC.read_column(cluster_step.store(cluster_step.entries(
                  datatype="metadata-column")[0]))]
    assert labels == spatial_arm.labels(), (
        "clustering.cluster is not reproducible at a fixed seed on this matrix")

    # ── what the seed is, and is NOT, shown to do ───────────────────────────────────
    other = VC.ChainStep(rerun.base / "4-cluster-seed1", "clustering.cluster")
    other.bind("embedding", reduce_step.store(entry))
    other.bind("expression", rerun.expression)
    # The seed is PARSED and reaches the compute's own record. That is all the assertions
    # below claim — see the docstring for why nothing here can claim more.
    other.run_ok({"seed": 1})
    other_labels = [str(v) for v in
                    VC.read_column(other.store(other.entries(
                        datatype="metadata-column")[0]))]
    def _seeds(node) -> set:
        """Every `seed` value anywhere in the report, at any depth.

        Searched rather than addressed by path: `clustering.cluster` records the seed inside
        a nested operating-parameters block, and pinning the exact path here would make this
        assertion break on a harmless report reshuffle instead of on the thing it is about.
        """
        found = set()
        if isinstance(node, dict):
            for key, value in node.items():
                if key == "seed" and isinstance(value, int):
                    found.add(value)
                found |= _seeds(value)
        elif isinstance(node, list):
            for value in node:
                found |= _seeds(value)
        return found

    other_seeds = _seeds(json.loads(
        (other.outputs_dir / "clustering-report.json").read_text()))
    baseline_seeds = _seeds(json.loads(
        (cluster_step.outputs_dir / "clustering-report.json").read_text()))
    assert other_seeds == {1}, (
        f"clustering.cluster was given `seed: 1` but its report records seed(s) "
        f"{sorted(other_seeds)} — the parameter is not even being PARSED. (Note the bound: "
        f"a compute that parsed the seed and then partitioned with a hardcoded random_state "
        f"would satisfy this; that case was demonstrated by mutation and is not covered.)")
    assert baseline_seeds == {0}, (
        f"the default run records seed(s) {sorted(baseline_seeds)}, not 0")

    # RECORDED, not required. On this fixture the partition is seed-invariant; asserting
    # that as a requirement would go RED on a product improvement and on any benign fixture
    # change, while staying green on the regression it was meant to catch.
    if other_labels != labels:
        # `warnings.warn`, not `print`: pytest discards a passing test's stdout unless
        # `-s` is given, and this branch is reachable only when every assertion has already
        # passed — so a `print` here could never deliver its message. A warning shows up in
        # the terminal warnings summary of a GREEN run, which is where this note belongs.
        warnings.warn(
            "the partition is now seed-SENSITIVE on this fixture — TEST-13's negative "
            "control has become possible and should be restored",
            stacklevel=2)



# ════════════════════════════════════════════════════════════════════════════════════
#  TEST-3 [acceptance] [INV-3] — no spatial-specific ENTITY axis, anywhere
# ════════════════════════════════════════════════════════════════════════════════════


def test_no_artifact_declares_a_spatial_specific_entity_axis(spatial_arm):
    """TEST-3 [acceptance] [invariant: INV-3] [covers: ITEM-6].

    §9's first constraint: *"**No `spots` axis.** The entity axis must remain `cells` with
    `key_label: barcode`. Inventing a spatial-specific axis would make every
    `subtypes_of: single-cell/expression` selector miss, and would fork `metadata-column`
    (whose axis is `cells`)."*

    Asserted over the WHOLE emitted artifact set rather than over the matrix alone, because
    that is where a spatial axis would ARRIVE — on a sibling column, quietly, in some later
    importer change — and a per-artifact assertion would not see it.

    `vertex` is NOT in the forbidden set, deliberately: §6.1 of the same design BLESSES it,
    and `spatial-types/manifest.yaml` already declares it as the entity axis of
    `spatial/boundaries`. INV-3 is a constraint on the axis a `cells`-aligned artifact
    lives on, not a ban on every spatial axis the design introduced. The declaration site
    is covered separately, in `test_visium_chain_selectors.py`, because an axis added to a
    manifest but not yet emitted is invisible to this scan.
    """
    expression = VC.expression_entry(spatial_arm.importer)
    assert expression["structure"]["axes"] == ["cells", "genes"], (
        f"the matrix declares axes {expression['structure']['axes']}")

    forbidden = {"spots", "spot", "bins", "bin", "pixels", "pixel", "beads", "bead"}
    checked = 0
    for entry in spatial_arm.importer.manifest():
        structure = VC.structure_of(entry)
        declared = set()
        if isinstance(structure.get("axis"), str):
            declared.add(structure["axis"])
        for axis in structure.get("axes") or []:
            declared.add(str(axis))
        for group in ("columns", "arrays"):
            for member in structure.get(group) or []:
                if isinstance(member, dict) and isinstance(member.get("axis"), str):
                    declared.add(member["axis"])
        if declared:
            checked += 1
        offending = declared & forbidden
        assert not offending, (
            f"{entry['id']} declares axis/axes {sorted(offending)} — a spatial-specific "
            f"entity axis. A Visium spot is not a cell, but the axis name is a JOIN KEY, "
            f"not a biological claim, and every shipped selector is keyed on `cells`")
    assert checked >= 5, (
        f"only {checked} emitted artifacts declared any axis at all, so the scan above was "
        f"nearly vacuous")

    barcode = spatial_arm.importer.entry("metadata-column:barcode")
    assert (barcode.get("meta") or {}).get("axis") == "cells"
    assert (barcode.get("meta") or {}).get("is_axis_index") is True, (
        "the cells axis must be carried by the `barcode` column, per §9's `key_label` clause")
    barcodes = [str(v) for v in VC.read_column(spatial_arm.importer.store(barcode))]
    assert len(barcodes) == spatial_arm.n_cells
    assert len(set(barcodes)) == len(barcodes), "the barcode key column is not unique"


# ════════════════════════════════════════════════════════════════════════════════════
#  TEST-5 [acceptance] [INV-5] — the disclosure debt: what is owed, and what is NOT
# ════════════════════════════════════════════════════════════════════════════════════


def test_the_disclosure_dispatch_columns_exist(spatial_arm):
    """TEST-5 [acceptance] [invariant: INV-5] [covers: ITEM-7] — the half this item OWES.

    §9's third constraint says the scientific-disclosure problem "belongs to the analysis
    epics — but the importer should stamp a `platform` / `measurement_unit`
    metadata-column so a future disclosure has something to dispatch on."

    So: the columns exist, on the `cells` axis, full length, with values that are constant
    and legible — a disclosure layer dispatches on the VALUE, so a column of nulls or of
    per-row noise would satisfy "the column exists" and be useless.
    """
    for name, expected in (("platform", "visium"), ("measurement_unit", "spot")):
        entry = spatial_arm.importer.entry(f"metadata-column:{name}")
        assert entry["datatype"] == "metadata-column"
        assert (entry.get("meta") or {}).get("axis") == "cells"
        values = [str(v) for v in VC.read_column(spatial_arm.importer.store(entry))]
        assert len(values) == spatial_arm.n_cells, f"{name} is length {len(values)}"
        assert set(values) == {expected}, (
            f"{name} holds {sorted(set(values))[:5]}; a disclosure layer dispatches on this "
            f"value, so it must be exactly {expected!r} for every row")


def test_qc_computed_pct_mito_over_rows_that_are_spots_and_nothing_disclosed_it(spatial_arm):
    """TEST-5 [acceptance] [invariant: INV-5] [covers: ITEM-7] — the half this item MEASURES.

    §9, stated plainly: *"The analyses will be scientifically wrong in known ways, and the
    platform will not say so. `qc.10x` will compute %mito on a Visium spot — legitimate,
    but `06-spatial-processing.md:405-407` warns that high %mito can mark a **real
    anatomical region** and must not be blindly filtered."*

    This test does not fix that. It RECORDS it, executably. The rows are JOINED to the
    importer's own `measurement_unit` column through the barcode axis, so the assertion is
    that %mito was computed over rows that ARE spots — the first version asserted only that
    a %mito was computed, which passed verbatim on the ordinary non-spatial arm and
    therefore recorded nothing about Visium at all.

    The haystack is derived from the manifest — every `report/*` body plus every column's
    `meta` and store attributes — rather than hardcoding one filename, because `obs.json`
    (which `qc-10x.py` calls "the per-cell metric table the UI reads", and where its
    dropped-metric warnings land) is the most likely home for a future disclosure and was
    not being read.

    **When a disclosure does land, this test goes RED — and that is the intended signal,
    not a false alarm.** It is the record of the day the debt was paid, and whoever pays it
    should rewrite this assertion rather than delete it.
    """
    run = spatial_arm
    n = run.n_cells

    # ── the rows %mito was computed over really are spots ───────────────────────────
    unit_entry = run.importer.entry("metadata-column:measurement_unit")
    units = [str(v) for v in VC.read_column(run.importer.store(unit_entry))]
    pct_mito = np.asarray(run.qc_values("pct_mito"), dtype=float)
    assert len(units) == n == len(pct_mito), (
        f"the measurement_unit column ({len(units)}) and pct_mito ({len(pct_mito)}) are "
        f"not both over the {n} rows of the matrix, so they cannot be joined")
    assert set(units) == {"spot"}, (
        f"the rows are declared {sorted(set(units))}, not spots — this test's whole claim "
        f"is that a per-CELL metric was computed over per-SPOT rows")
    assert float(np.median(pct_mito)) > 1.0, (
        "pct_mito is ~0 on this fixture, so this test would be vacuously green — it must "
        "measure a REAL mitochondrial signal for the absence of a disclosure to matter")

    # ── …and nothing anywhere in the QC outputs says so ─────────────────────────────
    haystack = []
    for entry in run.qc.manifest():
        if entry["datatype"].startswith("report/"):
            body = run.qc.outputs_dir / entry["path"]
            if body.is_file():
                haystack.append(body.read_text().lower())
        haystack.append(str(entry.get("meta") or {}).lower())
        if entry["datatype"] == "metadata-column":
            haystack.append(str(VC.store_txr_attributes(run.qc.store(entry))).lower())
    blob = "\n".join(haystack)

    assert "pct_mito" in blob, (
        "the haystack does not even contain `pct_mito`, so the absence assertions below "
        "would be measuring an empty string rather than the QC outputs")
    for token in ("spot", "visium", "spatial", "measured_entity", "platform", "anatom"):
        assert token not in blob, (
            f"the QC outputs now mention {token!r}. If a scientific-disclosure layer has "
            f"landed, this assertion is the record of the debt it paid — re-derive it "
            f"against the new behaviour rather than deleting it (INV-5)")


# ════════════════════════════════════════════════════════════════════════════════════
#  TEST-11 — what `cell.filter` ACTUALLY emits
# ════════════════════════════════════════════════════════════════════════════════════


def test_cell_filter_emits_a_mask_and_no_filtered_matrix(spatial_arm):
    """TEST-11 [covers: ITEM-2] — the design's §9 sentence, corrected by measurement.

    §9 says *"`cell.filter` emits a filtered matrix and a keep-mask"*. Measured here: it
    emits the keep-mask and a report, and **no matrix and no re-emitted obs-aligned
    sibling**. The filtered matrix and the carried siblings are minted SERVER-SIDE, by
    `create_filter_vd_for_run` (`virtual_dataset.rs:1525`), from the marked mask.

    That distinction is the whole reason INV-6 needed a Rust test rather than a Python one:
    the behaviour §9 tells us to verify does not live in the compute at all.

    The dtype assertion at the end is a CROSS-LANGUAGE pin. The Rust half's whole INV-6
    answer rests on a hand-built keep-mask fixture, and the only thing keeping that fixture
    honest about the shape `cell.filter` really produces is this line.
    """
    manifest = spatial_arm.filter.manifest()
    ids = [e["id"] for e in manifest]
    assert sorted({e["datatype"] for e in manifest}) == ["metadata-column", "report/qc"], (
        f"cell.filter emitted datatypes {sorted({e['datatype'] for e in manifest})}")
    assert not [e for e in manifest if VC.structure_of(e).get("kind") == "sparse_csc"], (
        f"cell.filter emitted an expression matrix ({ids}) — if that is now the behaviour, "
        f"the filtered-dataset mechanism has changed and INV-6's Rust coverage must be "
        f"re-derived against it")

    mask_entry = spatial_arm.mask_entry()
    marker = (mask_entry.get("meta") or {}).get("filter_mask")
    assert marker and marker.get("label") == "chain-compat", (
        "the mask carries no `filter_mask` marker, which is what the server's finalize sink "
        "keys the virtual-dataset creation on — without it nothing downstream is filtered")
    assert set(spatial_arm.mask()) == {True, False}, (
        "the mask is single-valued; a filter that separates nothing cannot exercise the "
        "carrying behaviour INV-6 is about")

    column = VC.structure_of(mask_entry)["columns"][0]
    assert column["dtype"] == "bool", (
        f"the keep-mask's member is {column['dtype']!r}, not `bool`. "
        f"`server/tests/workstore/spatial_filter_vd_test.rs` builds its mask fixture as a "
        f"plain bool array on the strength of this; if the real shape has changed, that "
        f"fixture is now a fiction and the whole INV-6 answer must be re-derived")
    assert column.get("kind") != "categorical", (
        "the keep-mask is now a categorical; see the dtype assertion above — the Rust "
        "fixture models a plain bool array")


# ════════════════════════════════════════════════════════════════════════════════════
#  TEST-14 — the chain CONTINUES on the filtered population
# ════════════════════════════════════════════════════════════════════════════════════


@pytest.fixture(scope="module")
def spatial_arm_filtered(spatial_arm):
    return spatial_arm.run_filtered()


def test_the_chain_continues_on_the_filtered_spatial_population(spatial_arm_filtered):
    """TEST-14 [acceptance] [invariant: INV-1] [covers: ITEM-2, ITEM-4].

    #157's scope item 1 writes the chain with an arrow after `cell.filter`
    (`qc.10x → cell.filter → embedding.reduce → clustering.* → de.compare`), and until this
    test the suite fanned out from ONE matrix with the filter as a dead-end branch: legs 3-6
    all consumed the UNFILTERED matrix. A blind audit named that, correctly.

    Following the arrow turned out to be a finding rather than a chore, and it is not a
    spatial one. **A downstream analysis cannot consume `cell.filter`'s result at all**:
    the filtered matrix exists only as a gathered row in a filter virtual dataset, and
    staging one for a compute fails because `gather_exec::resolve` asks a `sparse_csc`
    store for a member named `values`. That is measured in
    `server/tests/workstore/spatial_filter_vd_test.rs::
    what_a_downstream_analysis_receives_for_the_filtered_matrix`, with the unfiltered
    matrix staging cleanly as its positive control.

    So the arrow is followed the way the product actually supports: each analysis's own
    inline `criteria` filter, over the same band, using the same predicate kernel
    (`embedding/compute/_criteria.py` IS `cell-filter`'s `criteria_keep_mask`, vendored).
    The assertion that ties the two expressions of the band together is the row count:
    the embedding must cover exactly the cells the mask kept.
    """
    run = spatial_arm_filtered
    kept = sum(run.mask())
    assert 0 < kept < run.n_cells, "the mask must keep a strict subset for this to mean anything"

    # `cell.filter`'s emitted mask, against a closed-interval reading of the same QC column
    # and the same band, recomputed here in numpy. Compared as SETS, not counts.
    #
    # Stated precisely, because an earlier message here claimed more: this does NOT compare
    # the two PRODUCTION predicates (`cell-filter`'s thresholds branch and the reducer's
    # vendored `criteria` kernel) against each other. The inline path's own kept set is
    # observable only through the filtered embedding's ROW COUNT, asserted just below.
    assert run.band_row_indices() == run.kept_row_indices(), (
        "`cell.filter`'s keep-mask does not match a closed-interval reading of the band it "
        "was given over the same QC column, so the band recorded on the run is not the band "
        "that was applied — and every 'the same population' claim below rests on it")

    emb = run.embedding_filtered()
    assert emb.shape[0] == kept, (
        f"the inline-filtered embedding covers {emb.shape[0]} cells but `cell.filter` kept "
        f"{kept}. The two express the SAME band through the same vendored predicate kernel, "
        f"so a mismatch means one of them is reading the band differently — and the chain "
        f"'continuing on the filtered population' would be running on a different population")
    assert emb.shape[0] < run.embedding().shape[0], (
        "the filtered embedding is not smaller than the unfiltered one, so the inline filter "
        "did nothing and this test would pass on a no-op")
    assert np.isfinite(emb).all()
    variances = emb.var(axis=0)
    assert variances[0] > 0 and np.all(np.diff(variances) <= 1e-4), (
        "the post-filter PCA is degenerate or not rank-ordered")

    labels = run.labels_filtered()
    assert len(labels) == kept, (
        f"clustering on the filtered population returned {len(labels)} labels for {kept} rows")
    assert len(set(labels)) >= 2, (
        "clustering the filtered population collapsed to one cluster")

def test_de_markers_refuses_a_filtered_grouping_against_an_unfiltered_matrix(
        spatial_arm_filtered):
    """TEST-15 [covers: ITEM-2] — the ONE leg of the chain that cannot reach a filtered
    population.

    `de.markers` declares no criteria parameter of any spelling and no `column:<name>` slot
    — unlike `embedding.reduce` (a literal `criteria` param) and `de.compare`
    (`group1_criteria` / `group2_criteria`), which each also resolve `column:<name>` slots. (`clustering.cluster` has
    no inline filter either; it reaches a filtered population a third way, by consuming an
    already-filtered EMBEDDING. `de.markers` cannot, because its input is the matrix itself.)
    That leaves two routes and both are closed:

    * a genuinely filtered MATRIX artifact — which is what a filter virtual dataset holds,
      and which `server/tests/workstore/spatial_filter_vd_test.rs::
      what_a_downstream_analysis_receives_for_the_filtered_matrix` measures cannot be staged
      for a compute at all; or
    * the unfiltered matrix plus a filtered grouping column — attempted here, and refused by
      the alignment guard, by name.

    **An earlier version of this test claimed the same of `de.compare` and was wrong.**
    `de.compare`'s ADVANCED contrast mode ships exactly the mechanism it said was missing,
    and the leg it said was unreachable is exercised for real in
    `test_de_compare_reaches_the_filtered_population_through_its_advanced_contrast` below.
    Recorded here because the false claim was about #157's chain TERMINUS, and a suite that
    reports an unreachable terminus is worse than one that says nothing.

    Not a spatial finding: it reads the same for any dataset in the product.
    """
    run = spatial_arm_filtered
    attempt = run.attempt_markers_on_the_filtered_population()

    assert attempt.proc.returncode != 0, (
        "de.markers ACCEPTED an unfiltered matrix with a filtered grouping column. Either "
        "the alignment guard is gone — in which case it has been silently running over a "
        "row correspondence that does not exist — or a filtered matrix is now reachable "
        "and this test should become the positive one it stands in for")

    diagnostics = attempt.diagnostics()
    assert "not the same" in diagnostics, (
        f"de.markers refused, but not with the alignment complaint this test is about. "
        f"(Matched on the guard's own phrase alone — an earlier version also accepted the "
        f"bare word 'values', which appears in almost any Python diagnostic and could admit "
        f"an unrelated refusal.)\n{diagnostics}")
    assert str(len(run.labels_filtered())) in diagnostics, (
        f"the refusal does not name the filtered length ({len(run.labels_filtered())}), so "
        f"it may not be the length mismatch at all:\n{diagnostics}")
    assert str(run.n_cells) in diagnostics, (
        f"the refusal does not name the unfiltered matrix length ({run.n_cells}):\n"
        f"{diagnostics}")


def test_de_compare_reaches_the_filtered_population_through_its_advanced_contrast(
        spatial_arm_filtered):
    """TEST-16 [acceptance] [invariant: INV-1] [covers: ITEM-2, ITEM-4] — the chain's
    TERMINUS, on the filtered population.

    #157's scope item 1 runs the chain to `de.compare`, and this is the leg that gets there.
    `de.compare` stages the vendored criteria kernel and resolves `column:<name>` slots, so
    each side of an ADVANCED contrast is a criteria list evaluated over the full matrix —
    which means the filter's band can be ANDed into both sides.

    **Two things this does NOT claim, both measured.**

    * The contrast is "partition level A within the band" against "level B within the band".
      That is differential expression restricted TO the band, not over the whole of the kept
      population: on this fixture the partition has six levels and the two contrasted ones
      cover about half the kept rows. The assertion below is the per-side cell count against
      an independently computed intersection — which is the exact claim, and is checkable.
    * The grouping is the FULL-LENGTH partition, not the filtered one. That is forced: a
      criteria side is a mask over the whole matrix, so every column it names must be full
      length. So this leg reaches `de.compare` by a route that SKIPS the preceding
      post-filter leg, and #157's literal arrow — the filtered clustering's own output
      feeding `de.compare` — is closed. That closure is not narrated here; it is attempted
      and asserted in
      `test_de_compare_refuses_the_filtered_partition_as_a_criterion_column` below.

    This test exists because the suite briefly asserted that `de.compare` could not reach a
    filtered population at all. Running the leg is what settled it, which is the whole reason
    an audit's "your docstring claims more than your code does" is answered by making the
    code do it rather than by trimming the prose.
    """
    run = spatial_arm_filtered
    step = run.compare_on_the_filtered_population()

    entries = run.de_entries(step)
    assert len(entries) == 1, [e["id"] for e in entries]
    entry = entries[0]

    log_fc = np.asarray(run.de_column(step, entry, "logFC"), dtype=float)
    assert log_fc.shape == (run.n_genes,), (
        f"{entry['id']} covers {log_fc.shape}, expected the full {run.n_genes} genes")
    assert np.isfinite(log_fc).all(), "the contrast carries non-finite logFC"
    assert len(np.unique(log_fc)) > 1, "the contrast's logFC is constant"

    # …and it really WAS restricted to the band — asserted EXACTLY, not by proxy.
    #
    # An earlier version of this test said the DE report records no per-side cell counts and
    # fell back to an A/B comparison. That was wrong: `compare.py` puts `n_group1`/`n_group2`
    # into the advanced-mode provenance, which is written to the report as
    # `grouping_provenance`. So the population each side actually selected is observable,
    # and it is compared against a COUNT computed independently here from the partition and
    # the band. Precisely: the report exposes per-side cell COUNTS, not membership, so what
    # is checked is that each side is the right SIZE for a band-restricted contrast —
    # |level ∩ band| — not that it holds the same cells. An A/B difference alone would only
    # show the two runs differ; this pins the size of what each side took, and the
    # whole-population run below rules out a band that restricted nobody.
    expected = _expected_side_sizes(run, banded=True)
    assert _side_sizes(step) == expected, (
        f"the banded contrast selected {_side_sizes(step)} cells per side; intersecting the "
        f"partition with the band gives {expected}. The contrast is not restricted to the "
        f"band, so 'filtered' in this test's name is decoration")

    # The whole-population control, kept as the second leg: the SAME contrast without the
    # band must select MORE cells and produce different effect sizes. Without it, a band
    # that happened to keep everything would satisfy the equality above.
    whole = run.compare_on_the_whole_population()
    whole_entries = run.de_entries(whole)
    assert len(whole_entries) == 1
    assert _side_sizes(whole) == _expected_side_sizes(run, banded=False)
    assert sum(_side_sizes(whole)) > sum(_side_sizes(step)), (
        "the band excluded nobody, so the two runs are the same run")
    whole_log_fc = np.asarray(
        run.de_column(whole, whole_entries[0], "logFC"), dtype=float)
    # Shape FIRST: `np.array_equal` returns False for differently-shaped arrays, so without
    # this the inequality below would be satisfied trivially by a control run that emitted a
    # shorter table — while its message still claimed "over all N genes".
    assert whole_log_fc.shape == (run.n_genes,), (
        f"the whole-population control covers {whole_log_fc.shape}, not the full "
        f"{run.n_genes} genes")
    assert not np.array_equal(log_fc, whole_log_fc), (
        f"the banded contrast and the whole-population contrast produced IDENTICAL effect "
        f"sizes over all {run.n_genes} genes despite selecting different cells")


def _side_sizes(step) -> list:
    """`[n_group1, n_group2]` as the DE run itself recorded them.

    `compare.py`'s advanced branch records these in its `provenance` dict, which the report
    writes out as `grouping_provenance`.
    """
    report = json.loads((step.outputs_dir / "de-report.json").read_text())
    provenance = report.get("grouping_provenance") or {}
    return [provenance.get("n_group1"), provenance.get("n_group2")]


def _expected_side_sizes(run, *, banded: bool) -> list:
    """The same two numbers, computed here from the partition and the band.

    Independent of the compute: it reads the labels and the QC column and intersects them,
    so agreeing with `_side_sizes` is evidence rather than a tautology.
    """
    labels = run.labels()
    levels = run.cluster_levels()[:2]
    allowed = set(run.band_row_indices()) if banded else set(range(len(labels)))
    return [sum(1 for i, lab in enumerate(labels) if lab == level and i in allowed)
            for level in levels]


def test_de_compare_refuses_the_filtered_partition_as_a_criterion_column(
        spatial_arm_filtered):
    """TEST-17 [covers: ITEM-15] — #157's literal arrow, attempted and closed.

    `test_de_compare_reaches_the_filtered_population_through_its_advanced_contrast` reaches
    the terminus with the FULL-LENGTH partition. #157's arrow is narrower than that: it runs
    `clustering.*` and then `de.compare`, i.e. the FILTERED clustering leg's own output
    feeding the next leg. That binding is attempted here.

    It refuses, on the same alignment wall `de.markers` hits — a criterion column must be
    full length because a criteria side is a mask over the whole matrix. So the arrow as
    written is closed, and the terminus is reached by going around it. Recorded as an
    executable attempt rather than a sentence, because the suite's standard elsewhere is
    that the attempt is the finding, and it was not being applied to the one arrow the
    scope item is actually about.

    Not a spatial finding: it follows from a filtered column and an unfiltered matrix, which
    is the shape any filtered dataset in the product has.
    """
    run = spatial_arm_filtered
    attempt = run.attempt_compare_with_the_filtered_partition()

    assert attempt.proc.returncode != 0, (
        "de.compare ACCEPTED a criterion column shorter than the matrix. Either the "
        "alignment guard is gone, or a filtered matrix has become bindable — in which case "
        "#157's arrow is now open and this test should become the positive one")

    diagnostics = attempt.diagnostics()
    assert "not the same" in diagnostics, (
        f"de.compare refused, but not with the alignment complaint:\n{diagnostics}")
    assert str(len(run.labels_filtered())) in diagnostics and str(run.n_cells) in diagnostics, (
        f"the refusal does not name both lengths "
        f"({len(run.labels_filtered())} and {run.n_cells}), so it may not be the length "
        f"mismatch at all:\n{diagnostics}")
