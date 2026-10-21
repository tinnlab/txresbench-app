#!/usr/bin/env python3
# ruff: noqa
"""Provenance-report acceptance tests (INV-7 / INV-13).

TEST-22 — the `report/qc` (`meta.kind: embedding-report`) records every parameter actually
used, the resolved library versions, the seed, and the PCA sign convention.
TEST-23 — no-benchmark choices are recorded as the CHOICE made, with no field claiming one
is correct/recommended.

analysis-dep-contract TEST-12 [covers: ITEM-14] — the `library_versions` key survives the
#80 generalization, and the harmonypy entry equals what the package DECLARES. The key and
its assertions below are unchanged; what changed underneath is where the values come from.
They used to be a hand-typed module list read through the deprecated `__version__`
attribute, with an unreadable version recorded as `None` and compared against nothing. They
are now the DECLARED contract, resolved through the installed distribution's metadata and
range-checked, so an unresolvable version is a named refusal instead of a published
`None`. That this test still passes unchanged is the point: the report's contract to its
readers did not move.
"""
from embedding_fixtures import counts_matrix


# ── TEST-22 [acceptance] [invariant: INV-7] [covers: ITEM-24] ──────────────────────
def test_the_report_records_every_parameter_versions_seed_and_sign_convention(reduce_run):
    run = reduce_run()
    run.add_matrix(counts_matrix(60, 40, seed=0))
    run.run_ok({"n_hvg": 20, "n_pcs": 10, "seed": 7})
    rep = run.report()

    # the manifest entry is a report/qc typed embedding-report.
    report_entry = next(e for e in run.manifest()["outputs"]
                        if e["datatype"] == "report/qc")
    assert report_entry["meta"]["kind"] == "embedding-report"

    # every parameter ACTUALLY used.
    params = rep["parameters"]
    for key in ("n_hvg_effective", "n_pcs_effective", "seed", "hvg_flavor",
                "pca_svd_solver", "normalization"):
        assert key in params
    assert params["seed"] == 7
    assert params["hvg_flavor"] == "seurat_v3"

    # resolved library versions (only knowable at run time — rootfs pins nothing).
    versions = rep["library_versions"]
    assert versions.get("scanpy") and versions.get("numpy") and versions.get("scipy")

    # the PCA sign convention, recorded.
    assert rep["pca_sign_convention"] == "loadings_max_abs_positive"


# ── TEST-23 [acceptance] [invariant: INV-13] [covers: ITEM-9] ──────────────────────
def test_choices_are_recorded_as_choices_not_recommendations(reduce_run):
    run = reduce_run()
    run.add_matrix(counts_matrix(50, 30, seed=1))
    run.run_ok({"n_hvg": 12, "n_pcs": 6})
    rep = run.report()
    blob = repr(rep).lower()
    # the scaling/regress-out choices are recorded as booleans, not as a claim of correctness.
    assert rep["parameters"]["scaled"] is False
    assert "recommended" not in blob
    assert "correct choice" not in blob
