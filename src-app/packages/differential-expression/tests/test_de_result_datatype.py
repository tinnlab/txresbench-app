#!/usr/bin/env python3
# ruff: noqa
"""TEST-8 [acceptance] [invariant: INV-8] [covers: ITEM-1] — `de/result` is a 2D GENE table
(`entity_axis: gene`, NO `comparison` axis), declaring `neglog10p` (not raw `p`), the
detection/size members, and (per-artifact) `regime` + `multiplicity_family`. Paired with
TEST-16 (the golden regen guard)."""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_OPEN_KINDS = Path(__file__).resolve().parents[2] / "open-kinds" / "manifest.yaml"


def _de_result():
    doc = yaml.safe_load(_OPEN_KINDS.read_text())
    return next(d for d in doc["contributes"]["datatypes"] if d["id"] == "de/result")


def test_de_result_is_a_2d_gene_table_no_comparison_axis():
    dt = _de_result()
    axis_names = {a["name"] for a in dt["axes"]}
    assert axis_names == {"gene"}, "the synthetic `comparison` axis is DROPPED (DEC-13)"
    assert dt["entity_axis"] == "gene"
    assert dt["storage"]["layout"]["kind"] == "columnar_table"


def test_declares_neglog10p_not_raw_pval_plus_detection_and_size_members():
    dt = _de_result()
    table = next(a for a in dt["arrays"] if a["name"] == "table")
    members = {attr["name"] for attr in table["attrs"]}
    # G1 — `-log10(p)` stored, raw `pval` is NOT a member.
    assert "neglog10p" in members and "pval" not in members
    # G2 — detection + size + base mean.
    assert {"pct_1", "pct_2", "n_1", "n_2", "base_mean", "logFC", "score"} <= members
    # G4 — the across-comparison family column.
    assert "padj" in members and "padj_across" in members


def test_member_names_carry_no_single_cell_domain_vocabulary():
    # DEC-8 — domain-neutral names keep the app-builtin domain-strip lint green.
    dt = _de_result()
    table = next(a for a in dt["arrays"] if a["name"] == "table")
    banned = ("gene_symbol", "cell", "cluster", "leiden", "umap", "scanpy")
    for attr in table["attrs"]:
        low = attr["name"].lower()
        assert not any(b in low for b in banned), attr["name"]


def test_produced_artifact_records_regime_and_multiplicity_family(markers_run):
    # the per-comparison artifact stamps `regime` (G3) + `multiplicity_family` (G4) into
    # attributes.txr.de — the datatype's per-artifact validity fields.
    from de_fixtures import two_group_expression, group_labels, MATRIX_DERIVED
    run = markers_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(), slot="grouping", name="leiden", provenance=MATRIX_DERIVED)
    run.run_ok({"method": "wilcoxon"})
    e = run.de_entries()[0]
    de = run.de_txr(e)["de"]
    assert de["regime"] == "R2"
    assert "multiplicity_family" in run.de_txr(e) or "multiplicity_family" in run.manifest()["outputs"][0]["meta"]
    assert de["entity_axis"] == "gene"
