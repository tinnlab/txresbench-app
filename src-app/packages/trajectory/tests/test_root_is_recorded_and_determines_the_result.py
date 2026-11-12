#!/usr/bin/env python3
# ruff: noqa
"""TEST-3 [acceptance] [invariant: INV-3] — the root is RECORDED, and it DETERMINES the answer.

Three legs, and the third is the one that stops the other two being decoration:

  (a) the resolved root and the RULE that resolved it are in the report and the params;
  (b) identical inputs/root/seed produce a byte-identical artifact;
  (c) two runs differing ONLY in the root produce DIFFERENT pseudotime.

Without (c), a compute that ignored the root entirely and hardcoded row 0 would pass (a) and
(b) perfectly — it would record a root, and it would be beautifully reproducible.

The fourth leg is why this invariant exists at all: the pseudotime tool writes **no column
and raises nothing** when the root is missing or out of range. It warns. A pipeline that
mis-resolves the root therefore produces a valid-looking run with a MISSING OUTPUT and exit
code 0. The compute asserts the column's presence after the call and refuses by name.

Mutation: drop the post-call presence check -> the missing-root case emits an artifact whose
column is absent and the run "succeeds". Hardcode the root index -> leg (c) fails. Stop
recording the rule -> leg (a) fails.
"""
from pathlib import Path

import numpy as np
import pytest

from trajectory_generators import barcodes, branching_walk, cells_digest, embed

pytest.importorskip("scanpy")
pytest.importorskip("igraph")


@pytest.fixture(scope="module")
def fixture():
    counts, true_time, true_branch = branching_walk(n_per_branch=150, seed=0)
    return embed(counts), true_time, true_branch


def _run(dpt_run, emb, branch, params, *, keys=True):
    n = emb.shape[0]
    run = dpt_run()
    run.add_embedding(emb, aligned_to=cells_digest(n))
    run.add_partition(branch, slot="root_column", name="branch")
    if keys:
        run.add_keys(barcodes(n))
    return run


# ── (a) the root and its rule are recorded ────────────────────────────────────────────
def test_the_resolved_root_and_the_rule_that_resolved_it_are_recorded(dpt_run, fixture):
    emb, _tt, branch = fixture
    run = _run(dpt_run, emb, branch, None)
    run.run_ok({"root_mode": "root_cluster", "root_level": "trunk"})

    report = run.report()
    root = report["root"]
    assert isinstance(root["index"], int)
    assert root["barcode"] == f"cell-{root['index']}"
    assert root["mode"] == "root_cluster"
    assert root["level"] == "trunk"
    # the RULE, in words, not just the answer — this is what makes the choice auditable.
    rule = root["rule"]
    assert "TIP of the named population" in rule
    assert "furthest in diffusion space" in rule
    # …and it says WHY it is a distance, which is the property that makes it sign-proof.
    assert "invariant to the arbitrary sign" in rule
    assert "any row order" in rule
    assert root["n_dcs_used"] == 10
    assert root["measured_against"] == "cells outside the level"
    assert root["is_a_biological_assertion"] is True
    # …and the recorded params carry the mode the run actually honoured.
    assert report["parameters"]["root_mode"] == "root_cluster"
    # the artifact itself carries it too, not only the side-car report.
    assert run.group_txr("metadata-column")["trajectory"]["root"]["index"] == root["index"]


def test_a_root_with_no_key_column_records_an_honest_absence_not_an_invented_barcode(
        dpt_run, fixture):
    emb, _tt, branch = fixture
    run = _run(dpt_run, emb, branch, None, keys=False)
    run.run_ok({"root_mode": "root_cluster", "root_level": "trunk"})

    report = run.report()
    assert report["root"]["barcode"] is None
    assert report["root_barcode_recorded"] is False
    assert "not invented" in report["root_barcode_absent_because"]
    # the row index is still exact, so the run is still reproducible.
    assert isinstance(report["root"]["index"], int)


# ── (b) determinism ───────────────────────────────────────────────────────────────────
def test_identical_inputs_root_and_seed_produce_a_byte_identical_artifact(dpt_run, fixture):
    emb, _tt, branch = fixture
    params = {"root_mode": "root_cluster", "root_level": "trunk", "seed": 0}

    a = _run(dpt_run, emb, branch, None)
    a.run_ok(params)
    b = _run(dpt_run, emb, branch, None)
    b.run_ok(params)

    assert a.column_bytes() == b.column_bytes(), (
        "two identical runs produced different bytes — the determinism pin is not holding")
    assert a.report()["root"]["index"] == b.report()["root"]["index"]


# ── (c) the ANTI-VACUITY leg ──────────────────────────────────────────────────────────
def test_two_runs_differing_only_in_the_root_produce_different_pseudotime(dpt_run, fixture):
    """The leg that makes (a) and (b) mean something.

    A compute that hardcoded `iroot = 0` would record a root, be perfectly reproducible, and
    fail HERE — which is the only place the difference shows up.
    """
    emb, _tt, branch = fixture

    a = _run(dpt_run, emb, branch, None)
    a.run_ok({"root_mode": "root_cluster", "root_level": "trunk", "seed": 0})
    b = _run(dpt_run, emb, branch, None)
    b.run_ok({"root_mode": "root_cluster", "root_level": "A", "seed": 0})

    assert a.report()["root"]["index"] != b.report()["root"]["index"], (
        "the two runs resolved the SAME root, so this test cannot show the root matters")
    assert not np.allclose(a.pseudotime(), b.pseudotime()), (
        "two different roots produced the same pseudotime — the root is not reaching the "
        "computation, and every other assertion about it is then decoration")
    # and the bytes differ too, so the difference reaches the artifact.
    assert a.column_bytes() != b.column_bytes()


# ── the silent scanpy failure this invariant exists for ───────────────────────────────
def test_an_unresolvable_root_refuses_by_name_rather_than_emitting_nothing(dpt_run, fixture):
    """The pseudotime tool writes NO column and raises NOTHING when the root does not take.

    So the compute must refuse by name. If it did not, this run would exit 0 with an
    artifact whose column is simply absent — the most dangerous shape in this analysis,
    because every gate downstream would be green.
    """
    emb, _tt, branch = fixture
    run = _run(dpt_run, emb, branch, None)
    proc = run.run_fails({"root_mode": "root_cluster", "root_level": "no-such-level"})

    diagnostics = run.diagnostics(proc)
    assert "no-such-level" in diagnostics
    assert "does not appear" in diagnostics
    # the refusal is OURS, not a library traceback reaching the user.
    assert "Traceback" not in diagnostics
    # and nothing was emitted.
    assert not (run.outputs_dir / "manifest.json").exists()


def test_a_barcode_root_that_is_not_on_the_axis_refuses_by_name(dpt_run, fixture):
    emb, _tt, branch = fixture
    run = _run(dpt_run, emb, branch, None)
    proc = run.run_fails({"root_mode": "barcode", "root_barcode": "not-a-cell"})

    diagnostics = run.diagnostics(proc)
    assert "not-a-cell" in diagnostics
    assert "not on this dataset's cells axis" in diagnostics


def test_a_barcode_root_with_no_key_column_bound_refuses_rather_than_guessing(dpt_run,
                                                                             fixture):
    emb, _tt, branch = fixture
    run = _run(dpt_run, emb, branch, None, keys=False)
    proc = run.run_fails({"root_mode": "barcode", "root_barcode": "cell-0"})

    diagnostics = run.diagnostics(proc)
    assert "no cells-axis key column is bound" in diagnostics
    assert "refuses rather than guessing a row" in diagnostics


# ── TEST-29 — the guard the invariant turns on, EXERCISED rather than reasoned about ────
def test_the_library_really_does_write_no_column_when_the_root_does_not_take():
    """POSITIVE CONTROL for the guard below, driven on the library directly.

    Both soft cases are reproduced: a MISSING root and an OUT-OF-RANGE one. Neither raises.
    Both leave the column simply absent — which is what makes this the most dangerous
    failure in the analysis, because a pipeline that hit it would exit 0 with a valid-looking
    artifact.
    """
    import anndata as ad
    import scanpy as sc

    counts, _tt, _tb = branching_walk(n_per_branch=60, seed=0)
    emb = embed(counts)
    n = emb.shape[0]

    for label, setup in (("missing", lambda a: None),
                         ("out-of-range", lambda a: a.uns.__setitem__("iroot", n + 10_000))):
        a = ad.AnnData(X=np.zeros((n, 1), dtype=np.float32))
        a.obsm["X_e"] = emb
        sc.pp.neighbors(a, n_neighbors=15, use_rep="X_e", random_state=0)
        sc.tl.diffmap(a, n_comps=15, random_state=0)
        setup(a)
        sc.tl.dpt(a, n_dcs=10, n_branchings=0)  # raises NOTHING
        assert "dpt_pseudotime" not in a.obs.columns, (
            f"the {label} root now produces a column — if the library has started raising or "
            "writing here, the guard this test protects can be revisited")


def test_our_guard_refuses_by_name_when_the_column_does_not_appear(dpt_run, fixture):
    """The guard itself, end to end.

    It is unreachable through the ordinary parameter surface BECAUSE the root is validated
    before the call — which is good design and also means a parameter-driven test can only
    ever prove the validation works. The seam injects exactly the upstream-triggering
    condition (an out-of-range root) so the library's silent failure is genuine and the
    refusal is real; nothing is mocked.

    Without this, deleting the guard would leave the whole suite green — which is precisely
    the mutation this file's docstring claims to catch.
    """
    emb, _tt, branch = fixture
    run = _run(dpt_run, emb, branch, None)
    proc = run.run_fails({"root_mode": "root_cluster", "root_level": "trunk"},
                         env_extra={"TRAJECTORY_SIMULATE_UNRESOLVED_ROOT": "1"})

    diagnostics = run.diagnostics(proc)
    assert "computed no pseudotime column" in diagnostics
    assert "SILENTLY" in diagnostics
    assert "refused here instead of emitting an artifact" in diagnostics
    # nothing was emitted — no artifact with an absent column.
    assert not (run.outputs_dir / "manifest.json").exists()


def test_the_seam_only_ever_makes_the_run_REFUSE(dpt_run, fixture):
    """A seam that could make a run SUCCEED DIFFERENTLY would be production behaviour wearing
    a test name, so the property is asserted about the seam rather than around it.

    The first version of this test never set the variable at all — it ran the ordinary happy
    path and asserted the output kind, which two other tests already do. It would have stayed
    green against a seam that silently changed a successful result, which is the only thing
    it exists to rule out.
    """
    emb, _tt, branch = fixture

    # 1. WITH the seam, the run refuses and emits NOTHING. It cannot produce an artifact.
    refused = _run(dpt_run, emb, branch, None)
    refused.run_fails({"root_mode": "root_cluster", "root_level": "trunk"},
                      env_extra={"TRAJECTORY_SIMULATE_UNRESOLVED_ROOT": "1"})
    assert not (refused.outputs_dir / "manifest.json").exists()

    # 2. Its ONLY effect in the source is to move the root out of range — one read, one
    #    assignment, and nothing else. A seam with a second effect could not be read off a
    #    passing run, so it is read off the code.
    source = (Path(__file__).resolve().parents[1] / "compute" / "dpt.py").read_text()
    key = "TRAJECTORY_SIMULATE_UNRESOLVED_ROOT"
    assert source.count(key) == 1, "the seam is referenced more than once"
    block = source.split(key, 1)[1].split("\n\n", 1)[0]
    assert 'adata.uns["iroot"]' in block, "the seam's effect is not the root assignment"
    assert "S.fail" not in block, "the seam refuses directly instead of letting the guard fire"

    # 3. And the guard it triggers reads the OBSERVED COLUMN, not the injected value — a
    #    guard rewritten to test `iroot` would pass the test above while proving nothing
    #    about the library's silent failure.
    assert 'if "dpt_pseudotime" not in adata.obs.columns:' in source
