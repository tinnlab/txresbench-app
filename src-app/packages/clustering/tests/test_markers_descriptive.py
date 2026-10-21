#!/usr/bin/env python3
# ruff: noqa
"""TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-5] — the load-bearing double-dipping
anchor (CL-INV-1, doc 10 §4).

The descriptive-markers pass is folded into the `report/qc` clustering-report. It asserts:

  * the markers are labelled DESCRIPTIVE, not inference, and carry the circular-by-
    construction disclosure in `meta` (CL-INV-1);
  * `method='wilcoxon'` is set EXPLICITLY and the method scanpy ACTUALLY ran is recorded
    (DEC-3) — a mutation that lets scanpy's silent `t-test` default stand is caught, because
    `method_ran` reads back `t-test`;
  * NO between-cluster `pvals_adj`/FDR is headlined as a finding — and a MUTATION that
    injects a bare inferential FDR as a discovery is caught by the same guard (negative
    control: the guard has teeth);
  * the markers reach the run report as a `report/qc` artifact (markers→report/qc shape).
"""
import copy

from clustering_fixtures import (cells_digest, three_blob_embedding,
                                 three_blob_expression)

# The keys that would turn a descriptive marker into an inference claim if headlined. Mirror
# of `_markers.INFERENTIAL_KEYS` — kept literal here so the test is an INDEPENDENT check, not
# a re-export of the thing under test.
_INFERENTIAL_KEYS = {"pvals", "pvals_adj", "padj", "fdr", "qval", "qvals", "pvalue", "p_value"}
# Where a p-value would be "headlined as a finding": a top-level discovery/finding field, or a
# per-marker record field. (A clearly-labelled `pvalues_omitted*` disclosure key is allowed —
# it is the ABSENCE claim, not a finding.)
_FINDING_CONTAINERS = ("per_cluster", "findings", "significant", "significant_markers",
                       "discoveries", "top_hits")


def _headlines_inferential_fdr(markers: dict) -> bool:
    """True iff the markers section HEADLINES an inferential p-value/FDR as a finding — either
    a top-level discovery field, or a p-value carried on a per-marker record. This is the
    structural definition of the defect CL-INV-1 forbids; the test asserts it is False on the
    real report and True on a mutated one (so the guard provably kills the mutation)."""
    # (a) a per-marker record carrying a p-value/FDR field.
    per = markers.get("per_cluster") or {}
    for _cluster, recs in per.items():
        for rec in (recs or []):
            if isinstance(rec, dict) and (set(rec) & _INFERENTIAL_KEYS):
                return True
    # (b) a top-level finding/discovery container keyed by, or listing, a p-value/FDR.
    for k, v in markers.items():
        if k in _FINDING_CONTAINERS and k != "per_cluster":
            if isinstance(v, dict) and (set(v) & _INFERENTIAL_KEYS):
                return True
            if isinstance(v, list):
                for rec in v:
                    if isinstance(rec, dict) and (set(rec) & _INFERENTIAL_KEYS):
                        return True
    return False


def _run_with_markers(cluster_run, n_per=40):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(n_per, 10, seed=0), method="pca",
                      aligned_to=cells_digest(3 * n_per))
    run.add_expression(three_blob_expression(n_per, 30, seed=1))
    run.run_ok({"resolution": 1.0, "seed": 0})
    return run


def test_markers_are_descriptive_and_carry_the_circularity_disclosure(cluster_run):
    markers = _run_with_markers(cluster_run).markers()
    assert markers["computed"] is True
    # (a) labelled DESCRIPTIVE, not inference.
    assert markers["descriptive"] is True
    assert markers["is_inference"] is False
    # (b) the selection-bias / circularity disclosure sentence (CL-INV-1, doc 10 §4).
    d = markers["disclosure"].lower()
    assert "descriptive" in d and "not inferential" in d
    assert "double dipping" in d               # the mechanism, named
    assert "same cells" in d                   # clusters defined from the same data
    assert "anti-conservative by construction" in d
    assert "inflated" in d                     # the best-practices wording (§4.3)
    assert "ranking" in d                      # read it as a ranking, not evidence (§4.5)
    assert "split-based" in d                  # valid inference is a SEPARATE analysis


def test_wilcoxon_is_set_explicitly_and_the_method_that_ran_is_recorded(cluster_run):
    markers = _run_with_markers(cluster_run).markers()
    # DEC-3 — wilcoxon EXPLICIT, tie_correct + pts recorded.
    assert markers["method"] == "wilcoxon"
    assert markers["tie_correct"] is True
    assert markers["pts"] is True
    # The method scanpy ACTUALLY ran, read back out of adata.uns — a mutation that dropped
    # `method=` and let the silent `t-test` default stand reads back `t-test` here and FAILS.
    assert markers["method_ran"] == "wilcoxon"
    assert markers["scanpy_default_avoided"] == "t-test"


def test_no_between_cluster_fdr_is_headlined_and_the_guard_has_teeth(cluster_run):
    markers = _run_with_markers(cluster_run).markers()
    # the real report headlines NO inferential p-value / FDR (CL-INV-1).
    assert markers.get("pvalues_omitted") is True
    assert _headlines_inferential_fdr(markers) is False
    # every emitted per-cluster record is a RANKING (score + effect size), carrying no p-value.
    for _cluster, recs in markers["per_cluster"].items():
        assert recs, "a computed cluster must have ranked markers"
        for rec in recs:
            assert set(rec) & _INFERENTIAL_KEYS == set()   # no p-value on the record
            assert "score" in rec and "log2fc" in rec      # a ranking + an effect size
    # NEGATIVE CONTROL — the mutation the invariant forbids: headline a bare inferential FDR
    # as a discovery on the clustered data. The guard MUST catch it (proves it kills the
    # mutation, not merely passes on the honest output).
    mutated = copy.deepcopy(markers)
    first_cluster = next(iter(mutated["per_cluster"]))
    mutated["per_cluster"][first_cluster][0]["pvals_adj"] = 1e-9  # a between-cluster FDR "finding"
    assert _headlines_inferential_fdr(mutated) is True
    # and the same for a top-level discovery container.
    mutated2 = copy.deepcopy(markers)
    mutated2["significant_markers"] = [{"gene": "X", "fdr": 1e-12}]
    assert _headlines_inferential_fdr(mutated2) is True


def test_markers_land_in_the_report_qc_artifact(cluster_run):
    run = _run_with_markers(cluster_run)
    # markers → report/qc shape: the run report is a `report/qc` artifact, and the descriptive
    # markers are folded into it (INV-17 — the report carries the marker facts, not a new
    # `markers` datatype).
    # #80: the hidden `run-environment` record shares the `report/qc` datatype (it reuses
    # the shape every report already declares, so the artifact conformance gate accepts it
    # under an existing rule). It is a provenance carrier, not this analysis' report, so
    # the "exactly one report" claim is asserted over the PRODUCED reports.
    report_entries = [e for e in run.manifest()["outputs"]
                      if e["datatype"] == "report/qc" and e["id"] != "run-environment"]
    assert len(report_entries) == 1
    report = run.report()
    assert "markers" in report
    assert report["markers"]["computed"] is True
    assert report["markers"]["per_cluster"]


def test_labels_only_run_records_a_skip_not_a_fabricated_marker_table(cluster_run):
    # no `expression` bound → labels only; the markers section records the honest skip and
    # STILL carries the descriptive framing (never a fabricated marker table).
    run = cluster_run()
    run.add_embedding(three_blob_embedding(30, 8, seed=0), aligned_to=cells_digest(90))
    run.run_ok({"resolution": 1.0})
    markers = run.markers()
    assert markers["computed"] is False
    assert markers["is_inference"] is False
    assert "no `expression` input bound" in markers["skipped_reason"]
    assert markers.get("per_cluster", {}) == {} or "per_cluster" not in markers
