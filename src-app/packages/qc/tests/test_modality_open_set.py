#!/usr/bin/env python3
# ruff: noqa
"""TEST-6 [acceptance] [invariant: INV-6] — the modality prefix is an OPEN set.

`classify_feature_type` is open by construction: "an unrecognized feature type maps to a
sanitized modality of its own — NEVER dropped, NEVER folded into RNA". The QC view used
to offer three (`rna`/`prot`/`atac`), so an `hto` or `crispr` run had no correct answer
and the wrong one became the emitted column prefix.

The prefix now comes from each matrix artifact's `meta.modality`, stamped by the importer
(DEC-7) — an arbitrary sanitized key. This suite pins that: whatever key arrives is the
key that prefixes the columns, and nothing is folded into `rna`.

The keys used here are the REAL outputs of the importer's classifier — `crispr` for
"CRISPR Guide Capture", and `custom_assay_v2` for the unrecognised feature-type string
"Custom Assay v2" (`normalize_modality_key`). They are computed from that function rather
than hardcoded, so a change to the classifier moves this test with it.
"""
from __future__ import annotations

import os
import sys

import numpy as np

from qc_fixtures import counts_matrix

sys.path.insert(
    0,
    os.path.abspath(
        os.path.join(os.path.dirname(__file__), os.pardir, os.pardir, "anndata-import", "compute")
    ),
)
import multimodal as mm  # noqa: E402

CRISPR_KEY = mm.classify_feature_type("CRISPR Guide Capture")
CUSTOM_KEY = mm.classify_feature_type("Custom Assay v2")


def test_the_importers_keys_are_what_this_suite_claims():
    """Non-vacuity: the two keys are genuinely OUTSIDE the retired closed list."""
    assert CRISPR_KEY == "crispr"
    assert CUSTOM_KEY == "custom_assay_v2"
    assert CRISPR_KEY not in ("rna", "prot", "atac")
    assert CUSTOM_KEY not in ("rna", "prot", "atac")


def test_an_arbitrary_modality_key_prefixes_its_own_columns(qc_run):
    """A `crispr` matrix and a matrix whose key was SANITIZED from an unrecognised
    feature-type string each yield columns prefixed with THAT key."""
    r = qc_run()
    crispr = counts_matrix(5, 4, seed=31)
    custom = counts_matrix(5, 3, seed=32)
    r.add_matrix(crispr)
    r.add_matrix(custom)
    r.add_gene_names(crispr.shape[1])
    r.add_gene_names(custom.shape[1])
    r.run_ok({
        "qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}],
        "matrix_modalities": [CRISPR_KEY, CUSTOM_KEY],
    })

    cols = r.emitted_columns()
    assert f"{CRISPR_KEY}:total_counts" in cols, cols
    assert f"{CUSTOM_KEY}:total_counts" in cols, cols
    np.testing.assert_allclose(
        r.column_values(f"{CRISPR_KEY}:total_counts"), crispr.sum(axis=1), rtol=1e-6
    )
    np.testing.assert_allclose(
        r.column_values(f"{CUSTOM_KEY}:total_counts"), custom.sum(axis=1), rtol=1e-6
    )


def test_nothing_is_folded_into_rna(qc_run):
    """No `rna:`-prefixed column — and no bare, unprefixed one either — appears in a run
    where neither matrix is RNA. Folding an unrecognised modality into RNA is the silent
    loss INV-6 exists to prevent."""
    r = qc_run()
    r.add_matrix(counts_matrix(5, 4, seed=33))
    r.add_matrix(counts_matrix(5, 3, seed=34))
    r.add_gene_names(4)
    r.add_gene_names(3)
    r.run_ok({
        "qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}],
        "matrix_modalities": [CRISPR_KEY, CUSTOM_KEY],
    })
    cols = r.emitted_columns()
    assert not any(c.startswith("rna:") for c in cols), cols
    assert "total_counts" not in cols, (
        f"an unprefixed column collapsed the two modalities together: {cols}"
    )
    assert len(cols) == 2, cols


def test_every_modality_reaches_the_shared_cells_axis_in_one_run(qc_run):
    """DEC-6: ONE job writes every selected modality's metrics onto the SHARED cells
    axis, which is what makes joint filtering (`crispr:… AND custom:…`) meaningful."""
    r = qc_run()
    r.add_matrix(counts_matrix(5, 4, seed=35))
    r.add_matrix(counts_matrix(5, 3, seed=36))
    r.add_gene_names(4)
    r.add_gene_names(3)
    r.run_ok({
        "qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}],
        "matrix_modalities": [CRISPR_KEY, CUSTOM_KEY],
    })
    entries = [
        e for e in r.manifest()["outputs"] if e.get("datatype") == "metadata-column"
    ]
    assert {e["id"] for e in entries} == {
        f"metadata-column:{CRISPR_KEY}:total_counts",
        f"metadata-column:{CUSTOM_KEY}:total_counts",
    }
    for e in entries:
        assert e["structure"]["axis"] == "cells", e
        assert e["structure"]["n"] == 5, e


def test_two_matrices_sharing_one_modality_key_are_refused(qc_run):
    """Two prefixes that are the same prefix write the SAME column names onto the shared
    cells axis, so the second would silently replace the first — one column labelled as
    two. Refused, like a mount collision."""
    r = qc_run()
    r.add_matrix(counts_matrix(5, 4, seed=38))
    r.add_matrix(counts_matrix(5, 3, seed=39))
    r.add_gene_names(4)
    r.add_gene_names(3)
    proc = r.run({
        "qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}],
        "matrix_modalities": ["rna", "rna"],
    })
    assert proc.returncode != 0, (
        f"two matrices shared a prefix and the run answered anyway:\n{proc.stderr}")
    assert "collide" in r.diagnostics(proc), proc.stderr


def test_a_multi_matrix_run_with_no_modalities_is_refused(qc_run):
    """No `meta.modality` for either matrix ⇒ no prefix ⇒ colliding unprefixed columns.
    An unknown modality is never GUESSED (INV-6) and never folded into `rna`, so the only
    honest answer is to refuse and name what is missing."""
    r = qc_run()
    r.add_matrix(counts_matrix(5, 4, seed=40))
    r.add_matrix(counts_matrix(5, 3, seed=41))
    r.add_gene_names(4)
    r.add_gene_names(3)
    proc = r.run({"qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}]})
    assert proc.returncode != 0, proc.stderr
    assert "matrix_modalities" in r.diagnostics(proc), proc.stderr


def test_a_single_matrix_with_no_modality_keeps_the_unprefixed_columns(qc_run):
    """The pre-multimodal behaviour, byte-identical: one matrix, no modality, no prefix."""
    r = qc_run()
    dense = counts_matrix(4, 3, seed=42)
    r.add_matrix(dense)
    r.add_gene_names(dense.shape[1])
    r.run_ok({"qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}]})
    assert r.emitted_columns() == ["total_counts"]
    np.testing.assert_allclose(r.column_values("total_counts"), dense.sum(axis=1), rtol=1e-6)


def test_a_modality_key_with_a_separator_is_sanitized_into_the_column_name(qc_run):
    """A key is still sanitized on the way into a FILENAME, but the column's own name
    keeps the prefixed display spelling."""
    r = qc_run()
    r.add_matrix(counts_matrix(4, 3, seed=37))
    r.add_gene_names(3)
    r.run_ok({
        "qc_metrics": [{"name": "total_counts", "pattern": ".*", "aggregation": "sum"}],
        "matrix_modalities": ["my odd key"],
    })
    cols = r.emitted_columns()
    assert len(cols) == 1, cols
    assert cols[0].endswith(":total_counts"), cols
    assert not cols[0].startswith("rna:"), cols
