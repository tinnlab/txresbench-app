#!/usr/bin/env python3
# ruff: noqa
"""TEST-26 + TEST-34 (ITEM-17 / ITEM-24) — the qc compute's INPUT CONTRACT.

Two claims, both about resolution:

* **TEST-26** — the compute resolves a `matrices` slot LIST and a `gene_names` slot out
  of `/inputs/inputs.json`, reads the CSC ARTIFACT (never an `.h5ad`), and names the
  missing slot when one is absent.
* **TEST-34** — resolution is by SLOT **only**. A correctly-slotted input whose mount
  name carries NO recognisable suffix resolves; a stray file in `/inputs` that matches
  one of the retired globs (`*.h5ad`, `*.h5`, `matrix.mtx*`, `*.tar.gz`) is NOT picked
  up.

Before ITEM-24 `resolve_slot` fell back to (2) ANY slot and then (3) a filename GLOB, and
`load_matrix` dispatched its reader on `src.name.lower()`. Both are gone: the input is an
artifact whose own `zarr.json` declares its encoding.
"""
from __future__ import annotations

import numpy as np

from qc_fixtures import counts_matrix, pct_on


# ── TEST-26: the slot LIST ────────────────────────────────────────────────────

def test_matrices_slot_is_a_list_and_every_matrix_is_read(qc_run):
    """DEC-6: ONE job over ALL selected modality matrices. Two artifacts arrive under the
    SAME slot (`matrices`), and both contribute metric columns on the shared cells axis."""
    r = qc_run()
    rna = counts_matrix(6, 5, seed=1)
    prot = counts_matrix(6, 3, seed=2)
    r.add_matrix(rna)
    r.add_matrix(prot)
    r.add_gene_names(rna.shape[1])
    r.add_gene_names(prot.shape[1])
    r.run_ok({
        "qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}],
        "matrix_modalities": ["rna", "prot"],
    })

    cols = r.emitted_columns()
    assert "rna:total_counts" in cols, cols
    assert "prot:total_counts" in cols, cols
    np.testing.assert_allclose(r.column_values("rna:total_counts"), rna.sum(axis=1), rtol=1e-6)
    np.testing.assert_allclose(r.column_values("prot:total_counts"), prot.sum(axis=1), rtol=1e-6)


def test_every_matrix_emits_its_own_metadata_column_artifacts(qc_run):
    """The per-matrix columns are real artifacts, not just report rows."""
    r = qc_run()
    r.add_matrix(counts_matrix(4, 4, seed=3))
    r.add_matrix(counts_matrix(4, 4, seed=4))
    r.add_gene_names(4)
    r.add_gene_names(4)
    r.run_ok({
        "qc_metrics": [{"name": "n_genes", "pattern": ".*", "aggregation": "count"}],
        "matrix_modalities": ["rna", "atac"],
    })
    ids = r.metadata_column_ids()
    assert "metadata-column:rna:n_genes" in ids, ids
    assert "metadata-column:atac:n_genes" in ids, ids


def test_the_whole_gene_set_rows_match_the_scanpy_definitions(qc_run):
    """`sum` over `.*` = the per-cell total; `count` over `.*` = the per-cell number of
    genes with a positive count — what scanpy calls `total_counts` / `n_genes_by_counts`.

    These used to be BUILTINS: name-matched against a hardcoded list, pattern-less,
    uneditable, computed by their own parse path. They are ordinary rows now, and the
    definitions are pinned here so the special case's removal is visible as "same numbers,
    one fewer mechanism" (`test_aggregation.py` compares them against the deleted kernels
    directly)."""
    r = qc_run()
    dense = counts_matrix(7, 6, seed=5)
    dense[2, :] = 0.0  # a genuinely empty cell
    dense[3, 1] = 0.0
    r.add_matrix(dense)
    r.add_gene_names(dense.shape[1])
    r.run_ok({"qc_metrics": [
        {"name": "total_counts", "pattern": ".*", "aggregation": "sum"},
        {"name": "n_genes", "pattern": ".*", "aggregation": "count"},
    ]})
    np.testing.assert_allclose(r.column_values("total_counts"), dense.sum(axis=1), rtol=1e-6)
    np.testing.assert_allclose(
        r.column_values("n_genes"), (dense > 0).sum(axis=1), rtol=1e-6
    )


def test_the_metrics_equal_what_scanpy_computes_for_the_same_matrix(qc_run):
    """The ORACLE check for the reader rewrite.

    `sc.pp.calculate_qc_metrics` is gone from this compute — it takes an AnnData, and the
    input is a CSC artifact — so the `sum` / `count` / `percentage` reducers are computed
    off the CSC trio directly. This asserts the three are numerically
    IDENTICAL to what scanpy produces for the same matrix and the same gene set, which is
    the only way to know the definitions survived the move rather than being re-derived
    approximately.

    Skips when scanpy is not installed; the sandbox runtime always ships it, and every
    other test here runs scanpy-free."""
    import pytest as _pytest

    sc = _pytest.importorskip("scanpy")
    ad = _pytest.importorskip("anndata")
    import pandas as pd

    dense = counts_matrix(9, 7, seed=101)
    dense[4, :] = 0.0          # a zero-count cell (the pct denominator is 0)
    dense[5, 2] = 0.0          # a hole inside a non-empty cell
    symbols = ["MT-ND1", "ACTB", "MT-CO1", "GAPDH", "RPS12", "MT-CO2", "RPL13"]

    r = qc_run()
    r.add_matrix(dense)
    r.add_column(symbols, slot="gene_names", axis="genes", name="feature_name")
    r.run_ok({"qc_metrics": [
        {"name": "total_counts", "pattern": ".*", "aggregation": "sum"},
        {"name": "n_genes", "pattern": ".*", "aggregation": "count"},
        {"name": "pct_mito", "pattern": r"^MT-", "aggregation": "percentage"},
    ]})

    adata = ad.AnnData(X=np.asarray(dense, dtype=np.float32))
    adata.var_names = symbols
    adata.var["mito"] = np.array([s.startswith("MT-") for s in symbols])
    sc.pp.calculate_qc_metrics(
        adata, qc_vars=["mito"], percent_top=None, log1p=False, inplace=True)

    np.testing.assert_allclose(
        r.column_values("total_counts"), np.asarray(adata.obs["total_counts"]), rtol=1e-6)
    np.testing.assert_allclose(
        r.column_values("n_genes"),
        np.asarray(adata.obs["n_genes_by_counts"]), rtol=1e-6)
    # scanpy leaves NaN where a cell has no counts at all; the emitted column carries the
    # 0 the previous `nan_to_num` produced, so compare on the defined cells and assert the
    # zero-count cell explicitly.
    scanpy_pct = np.nan_to_num(np.asarray(adata.obs["pct_counts_mito"], dtype=float), nan=0.0)
    np.testing.assert_allclose(r.column_values("pct_mito"), scanpy_pct, rtol=1e-6)
    assert r.column_values("pct_mito")[4] == 0.0


# ── TEST-26: the gene_names slot ──────────────────────────────────────────────

def test_gene_names_slot_resolves_from_inputs_json(qc_run):
    """A `gene_names` artifact supplies the VALUES the gene regexes match against."""
    r = qc_run()
    dense = counts_matrix(5, 4, seed=6)
    r.add_matrix(dense)
    symbols = ["MT-ND1", "ACTB", "MT-CO1", "GAPDH"]
    r.add_column(symbols, slot="gene_names", axis="genes", name="feature_name")
    r.run_ok({"qc_metrics": [
        {"name": "pct_mito", "pattern": r"^MT-", "aggregation": "percentage"}]})

    assert r.report()["matched_genes"]["pct_mito"] == 2, r.report()["matched_genes"]
    np.testing.assert_allclose(
        r.column_values("pct_mito"),
        pct_on(dense, [s.startswith("MT-") for s in symbols]),
        rtol=1e-6,
    )


def test_reads_the_csc_artifact_and_never_an_h5ad(qc_run):
    """The matrix input is a MULTIFILE Zarr store; the run must read it as such.

    The store declares its own encoding in the group `zarr.json`
    (`{"encoding": "zarr_v3", "kind": "sparse_csc", …}`) — the compute takes the format
    from there. Nothing in `/inputs` is an `.h5ad`, and the run still succeeds."""
    r = qc_run()
    dense = counts_matrix(5, 5, seed=7)
    store = r.add_matrix(dense)
    assert (store / "zarr.json").is_file(), "the fixture must be a Zarr store, not a file"
    assert not any(p.name.endswith(".h5ad") for p in r.inputs_dir.rglob("*"))
    r.add_gene_names(dense.shape[1])
    r.run_ok({"qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}]})
    np.testing.assert_allclose(r.column_values("total_counts"), dense.sum(axis=1), rtol=1e-6)


# ── TEST-26: a missing slot is NAMED ──────────────────────────────────────────

def test_missing_matrices_slot_errors_clearly(qc_run):
    """No `matrices` entry in inputs.json ⇒ a non-zero exit whose message NAMES the slot
    (not a silent no-op, and not a stack trace out of a reader)."""
    r = qc_run()
    proc = r.run({"qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}]},
                 declare_inputs=False)
    assert proc.returncode != 0, proc.stdout + proc.stderr
    assert "matrices" in r.diagnostics(proc), proc.stderr


def test_an_unrelated_slot_does_not_stand_in_for_matrices(qc_run):
    """The retired "any slot will do" fallback: a `gene_names` input alone must NOT be
    read as the matrix."""
    r = qc_run()
    r.add_column(["MT-ND1", "ACTB"], slot="gene_names", axis="genes")
    proc = r.run({"qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}]})
    assert proc.returncode != 0, proc.stdout + proc.stderr
    assert "matrices" in r.diagnostics(proc), proc.stderr


# ── TEST-34: SLOT-only resolution ─────────────────────────────────────────────

def test_a_slotted_input_with_no_recognisable_suffix_resolves(qc_run):
    """The mount name is meaningless (`payload`), and the run works anyway — the slot is
    the whole contract. Under the old `load_matrix` this name matched no branch and fell
    through to `ad.read_h5ad`, which cannot open a directory."""
    r = qc_run()
    dense = counts_matrix(4, 4, seed=8)
    r.add_matrix(dense, mount="payload")
    r.add_gene_names(dense.shape[1])
    r.run_ok({"qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}]})
    np.testing.assert_allclose(r.column_values("total_counts"), dense.sum(axis=1), rtol=1e-6)


def test_a_stray_file_matching_a_retired_glob_is_not_picked_up(qc_run):
    """`/inputs` holds files matching every glob the old `resolve_slot` tried
    (`*.h5ad`, `*.h5`, `*.tar.gz`, `matrix.mtx`) and inputs.json declares NO matrix.
    The run must FAIL naming the slot rather than reading a stray."""
    r = qc_run()
    for name in ("dataset.h5ad", "matrix.h5", "bundle.tar.gz", "matrix.mtx"):
        r.add_stray(name)
    # …including one that is a REAL, readable store — so "it failed to parse" cannot be
    # mistaken for "it refused to look".
    r.add_stray_matrix("expression.h5ad", counts_matrix(4, 4, seed=9))
    proc = r.run({"qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}]},
                 declare_inputs=False)
    assert proc.returncode != 0, (
        "a stray file matching a retired glob was picked up:\n"
        f"{proc.stdout}\n{proc.stderr}"
    )
    diag = r.diagnostics(proc)
    # "it exited non-zero" is NOT the claim — a reinstated glob also exits non-zero when
    # the junk file it picked up fails to parse, and an earlier draft of this test passed
    # against exactly that. The claim is that it never LOOKED: the diagnostic is the
    # unbound-slot one, and no stray name appears in it.
    assert "no input is bound" in diag and "matrices" in diag, proc.stderr
    for stray in ("dataset.h5ad", "matrix.h5", "bundle.tar.gz", "matrix.mtx",
                  "expression.h5ad"):
        assert stray not in diag, (
            f"the run reached {stray!r} — it resolved a file inputs.json never declared:\n{diag}"
        )
    assert not (r.outputs_dir / "obs.json").exists(), "it produced output from a stray input"


def test_two_bindings_that_collide_on_one_mount_are_refused(qc_run):
    """A LIST slot whose bindings land on the SAME mount is REFUSED, loudly.

    This is a live seam with the runner's mount naming (ITEM-23):
    `derive_artifact_mount_name(slot, structure)` is a pure function of the SLOT and the
    encoding, so BOTH bindings of a two-matrix `matrices` run derive `matrices.zarr` —
    the second stage overwrites the first, and `inputs.json` records two entries with an
    identical `sandbox_path`. Read naively that is the same matrix twice, emitted under
    two different modality prefixes: a wrong answer with no symptom.

    The compute cannot fix the naming, but it can refuse to answer. Reproduced exactly as
    the runner would produce it — two stages at one mount name."""
    r = qc_run()
    r.add_matrix(counts_matrix(5, 4, seed=12), mount="matrices.zarr")
    r.add_matrix(counts_matrix(5, 3, seed=13), mount="matrices.zarr")
    proc = r.run({
        "qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}],
        "matrix_modalities": ["rna", "prot"],
    })
    assert proc.returncode != 0, (
        "two bindings collided on one mount and the run answered anyway:\n"
        f"{proc.stdout}\n{proc.stderr}")
    diag = r.diagnostics(proc)
    assert "matrices" in diag and "matrices.zarr" in diag, proc.stderr


def test_a_declared_slot_wins_over_a_stray_with_a_matching_name(qc_run):
    """A stray `expression.h5ad`-named store sits beside the DECLARED matrix; the declared
    one is what gets read (the stray has a different cell count, so it cannot alias)."""
    r = qc_run()
    declared = counts_matrix(5, 4, seed=10)
    r.add_matrix(declared, mount="in_declared")
    r.add_gene_names(declared.shape[1])
    r.add_stray_matrix("expression.h5ad", counts_matrix(9, 4, seed=11))
    r.run_ok({"qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}]})
    assert r.obs()["n_cells"] == 5
    np.testing.assert_allclose(r.column_values("total_counts"), declared.sum(axis=1), rtol=1e-6)
