#!/usr/bin/env python3
# ruff: noqa
"""Regression tests for the processor-registry audit findings in qc-10x.py +
cell-filter.py (the pure recipe/metric helpers — no scipy/scanpy needed, since
those imports are now lazy). Each test would have FAILED before the corresponding fix:

  #1 filter.yaml ↔ cell-filter.py thresholds MAP shape ({criterion:{ident:[lo,hi]}}).
  #2 gate index-space: obs.json positions → barcodes via gate_ids (id-based, robust).
  #3 qc ReDoS guard rejects the nested-unbounded-quantifier family.
  #4 default ribo pattern covers mouse (Rp[sl]) as well as human (RP[SL]).
  #5 parse_qc_metrics skips a bare-string / invalid entry with a warning, never crashes.

The two entry scripts are hyphenated (`qc-10x.py` / `cell-filter.py`) so they load via
importlib by path (not `import`)."""
import importlib.util
import os

import numpy as np
import pandas as pd
import pytest

# qc-10x.py + cell-filter.py live in their processor packages (`packages/<name>/compute/`).
# Resolve them there (the shared `align`/`colsummary` helpers now live in the `_helpers`
# package alongside this suite, staged by conftest — D2 Slice 5).
# tests → _helpers → processors → src-app  (3 levels up).
_SRC_APP = os.path.abspath(os.path.join(os.path.dirname(__file__), *([os.pardir] * 3)))
_PROCESSORS = os.path.join(_SRC_APP, "packages")


def _load(mod_name, rel_path):
    spec = importlib.util.spec_from_file_location(mod_name, os.path.join(_PROCESSORS, rel_path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


qc = _load("qc10x", os.path.join("qc", "compute", "qc-10x.py"))
cf = _load("cellfilter", os.path.join("cell-filter", "compute", "cell-filter.py"))


class _FakeAdata:
    """Minimal AnnData stand-in for resolve_gate (obs_names + n_obs only)."""

    def __init__(self, names):
        self._names = [str(n) for n in names]

    @property
    def n_obs(self):
        return len(self._names)

    @property
    def obs_names(self):
        return pd.Index(self._names)


# ───────────────────────── #1 thresholds MAP shape ─────────────────────────────

def test_thresholds_accepts_interactive_map_shape():
    # The shape filter.yaml `saveFilter` actually binds: {criterion:{ident:[lo,hi]}}.
    p = {"thresholds": {"nCount": {"s1": [200, 5000], "s2": [100, 4000]},
                        "pct_mito": {"s1": [0, 10]}}}
    out = cf.thresholds_from_params(p)
    # one entry per (criterion, ident); min/max/sample populated.
    got = {(t["metric"], t["sample"]): (t["min"], t["max"]) for t in out}
    assert got[("nCount", "s1")] == (200.0, 5000.0)
    assert got[("nCount", "s2")] == (100.0, 4000.0)
    assert got[("pct_mito", "s1")] == (0.0, 10.0)
    assert len(out) == 3


def test_thresholds_map_skips_allnone_range():
    p = {"thresholds": {"nCount": {"all": [None, None], "keep": [1, 2]}}}
    out = cf.thresholds_from_params(p)
    assert [(t["sample"], t["min"], t["max"]) for t in out] == [("keep", 1.0, 2.0)]


def test_thresholds_list_shape_still_works():
    p = {"thresholds": [{"metric": "n_genes", "min": 200}, {"criteria": "pct_mito", "max": 10, "ident": "s1"}]}
    out = cf.thresholds_from_params(p)
    assert out[0] == {"metric": "n_genes", "min": 200, "max": None, "sample": None}
    assert out[1] == {"metric": "pct_mito", "min": None, "max": 10, "sample": "s1"}


# ───────────────────────── #2 gate id-space robustness ─────────────────────────

def test_gate_positions_map_through_gate_ids_to_barcodes():
    # Pre-filter obs.json order (what the UI brushes over): 4 cells, index 1 + 3 kept.
    gate_ids = ["AAAC-1", "CCCG-1", "GGGG-1", "TTTT-1"]
    gate = [1, 3]
    mapped = cf._gate_to_ids(gate, gate_ids)
    assert mapped == ["CCCG-1", "TTTT-1"]
    # The QC-kept subset (a DIFFERENT index space) — barcodes resolve correctly,
    # whereas the raw positions 1/3 would have hit the wrong cells.
    kept = _FakeAdata(["GGGG-1", "TTTT-1", "CCCG-1"])
    mask, matched, unmatched = cf.resolve_gate(kept, mapped)
    assert matched == 2 and unmatched == []
    assert list(mask) == [False, True, True]  # TTTT + CCCG kept, GGGG dropped


def test_gate_barcodes_pass_through_and_out_of_range_dropped():
    gate_ids = ["b0", "b1"]
    # mix of an in-range index, an out-of-range index (dropped), and a raw barcode.
    assert cf._gate_to_ids([0, 9, "b1"], gate_ids) == ["b0", "b1"]


def test_gate_without_gate_ids_is_verbatim_backcompat():
    # No mapping supplied → gate returned untouched; resolve_gate keeps positional
    # behaviour for genuine INTEGERS (AI-supplied barcodes or legacy index gates).
    assert cf._gate_to_ids([0, 2], None) == [0, 2]
    ad = _FakeAdata(["x", "y", "z"])
    mask, matched, unmatched = cf.resolve_gate(ad, [0, 2])
    assert list(mask) == [True, False, True] and matched == 2 and unmatched == []


# ── the identity class: a KEY that is not found is never re-read as a POSITION ──────
#
# These three cases were all resolved positionally before this fix, so each of them
# selected a real but WRONG cell and reported it as a hit.

def test_absent_numeric_barcode_is_unmatched_never_a_row_index():
    # A dataset whose barcodes are plain integers — several pipelines emit exactly this.
    # "42" is a NAME. It is not in this subset, so it identifies nothing; it must NOT
    # become row 42 (which, before the fix, is precisely what it became: `mask[42]`).
    # 50 cells, and NONE of them is called "42" — but row 42 exists, which is the whole
    # hazard: the old fallback wrote `mask[42]` and counted it as a match.
    ad = _FakeAdata([f"BC{i}" for i in range(50)])
    mask, matched, unmatched = cf.resolve_gate(ad, ["42"])
    assert matched == 0
    assert unmatched == ["42"]
    assert not mask.any()          # row 42 in particular
    assert mask[42] == False       # the exact cell the old code kept


def test_present_numeric_barcode_resolves_by_NAME_not_by_position():
    # The positive control for the case above: barcode "2" exists, and it is the cell
    # CALLED "2" (row 0 here), not the cell AT row 2.
    ad = _FakeAdata(["2", "0", "1"])
    mask, matched, unmatched = cf.resolve_gate(ad, ["2"])
    assert matched == 1 and unmatched == []
    assert list(mask) == [True, False, False]


def test_gate_to_ids_does_not_index_gate_ids_with_a_numeric_barcode_string():
    # `_gate_to_ids` is the guard `resolve_gate` leans on, and it had the same defect one
    # level up: a digits-only barcode STRING was run through `int()` and used to index
    # `gate_ids`, replacing a real barcode with whatever cell sat at that row.
    gate_ids = ["AAAC-1", "CCCG-1", "GGGG-1"]
    # "1" is a barcode in the dataset below, not the position of "CCCG-1".
    assert cf._gate_to_ids(["1"], gate_ids) == ["1"]
    # ... and the genuine INTEGER 1 still maps positionally.
    assert cf._gate_to_ids([1], gate_ids) == ["CCCG-1"]


def test_a_gate_that_identifies_no_cell_is_REFUSED_not_silently_emptied():
    # The stated failure the identity fix makes reachable. With the old positional
    # fallback this gate kept row 42 and reported success; with the fallback gone it keeps
    # NOTHING, and an all-false mask committed under the user's label would hide the real
    # cause (a gate resolved against the wrong dataset / id space). So it refuses.
    ad = _FakeAdata([f"BC{i}" for i in range(50)])
    gate = ["42", "7"]
    mask, matched, unmatched = cf.resolve_gate(ad, gate)
    assert matched == 0 and not mask.any()
    reason = cf.gate_refusal_reason(gate, matched, unmatched)
    assert reason is not None
    assert "identified none of this dataset's cells" in reason
    assert "not a row number" in reason


def test_a_PARTIAL_gate_miss_is_not_a_refusal():
    # The brush sweeps the PRE-filter obs, so some of the cells it named are legitimately
    # gone by the time this runs. That is reported, not refused.
    ad = _FakeAdata(["BC1", "BC2"])
    gate = ["BC1", "BC99"]
    mask, matched, unmatched = cf.resolve_gate(ad, gate)
    assert matched == 1 and unmatched == ["BC99"]
    assert cf.gate_refusal_reason(gate, matched, unmatched) is None


def test_no_gate_at_all_is_not_a_refusal():
    assert cf.gate_refusal_reason([], 0, []) is None


def test_out_of_range_integer_position_is_reported_not_silently_skipped():
    ad = _FakeAdata(["x", "y"])
    mask, matched, unmatched = cf.resolve_gate(ad, [0, 7])
    assert matched == 1 and unmatched == [7]
    assert list(mask) == [True, False]


# ───────────────────────── #3 ReDoS guard is honest ────────────────────────────

@pytest.mark.parametrize("bad", [r"(a+)+$", r"(a*)*", r"(.*)+", r"(x+){2,}"])
def test_redos_nested_quantifier_rejected(bad):
    assert qc._has_nested_unbounded_quantifier(bad) is True
    with pytest.raises(ValueError, match="nested unbounded quantifier"):
        qc.compile_gene_pattern(bad, "evil")


@pytest.mark.parametrize("ok", [r"^MT-|^mt-", r"^(RP[SL]|Rp[sl])", r"[*+]a+", r"\(a+\)+", r"a+b*c"])
def test_safe_patterns_accepted(ok):
    assert qc._has_nested_unbounded_quantifier(ok) is False
    assert qc.compile_gene_pattern(ok, "ok") == ok


def test_oversized_and_invalid_patterns_raise():
    with pytest.raises(ValueError, match="exceeds"):
        qc.compile_gene_pattern("a" * (qc.MAX_PATTERN_LEN + 1), "big")
    with pytest.raises(ValueError, match="invalid regex"):
        qc.compile_gene_pattern("(unterminated", "bad")


# ───────────────────────── #4 mouse-ribo default restored ──────────────────────

def test_default_ribo_covers_human_and_mouse():
    ribo = next(m for m in qc.DEFAULT_QC_METRICS if m["name"] == "pct_ribo")["pattern"]
    genes = pd.Index(["RPS12", "RPL13", "Rps12", "Rpl13", "ACTB", "Gapdh"])
    flag = np.asarray(genes.str.match(ribo))
    assert list(genes[flag]) == ["RPS12", "RPL13", "Rps12", "Rpl13"]  # human + mouse


# ───────────────────────── #5 parse_qc_metrics never crashes ───────────────────

def test_parse_qc_metrics_skips_bad_entries_with_warnings():
    warnings = []
    p = {"qc_metrics": [
        "mito",                                   # bare string → skipped
        {"name": "ribo", "pattern": r"^RP[SL]", "aggregation": "percentage"},   # valid
        {"name": "evil", "pattern": r"(a+)+$", "aggregation": "sum"},           # ReDoS → skipped
        {"name": "broken", "pattern": r"(", "aggregation": "sum"},              # invalid regex → skipped
    ]}
    out = qc.parse_qc_metrics(p, warnings)
    assert [m["name"] for m in out] == ["ribo"]
    joined = " ".join(warnings)
    assert "not an object" in joined            # the bare string
    assert "nested unbounded quantifier" in joined
    assert "invalid regex" in joined


def test_parse_qc_metrics_defaults_and_duplicate_names():
    out = qc.parse_qc_metrics({})
    assert [m["name"] for m in out] == ["total_counts", "n_genes", "pct_mito", "pct_ribo"]
    # Duplicate names used to de-dup silently to the first occurrence. That was tolerable
    # while the name was only a stem the compute decorated; the name IS the emitted column
    # now (DEC-1), so the survivor may be the row whose aggregation the caller did not want.
    with pytest.raises(qc.DuplicateMetricName):
        qc.parse_qc_metrics({"qc_metrics": [
            {"name": "x", "pattern": "^A", "aggregation": "sum"},
            {"name": "x", "pattern": "^B", "aggregation": "sum"}]})


# ─────────────── ITEM-18: EVERY metric is optional, and uniform ────────────────
#
# `parse_builtin_metrics` and `BUILTIN_METRIC_NAMES` are gone. `total_counts` /
# `n_genes` are ordinary rows (`sum` / `count` over `.*`), so "the builtins are
# removable" is no longer a property of a special case — it is the same property every
# row has, which is the point.

def test_the_default_set_is_four_ordinary_rows_when_omitted():
    assert [(m["name"], m["aggregation"]) for m in qc.parse_qc_metrics({})] == [
        ("total_counts", "sum"),
        ("n_genes", "count"),
        ("pct_mito", "percentage"),
        ("pct_ribo", "percentage"),
    ]


def test_the_former_builtins_are_removable_like_any_other_row():
    p = {"qc_metrics": [{"name": "pct_hb", "pattern": r"^HB[AB]", "aggregation": "percentage"}]}
    assert [m["name"] for m in qc.parse_qc_metrics(p)] == ["pct_hb"]


def test_only_custom_metric_emits_only_that_column():
    # ITEM-18 headline: a run selecting ONLY a custom metric produces ONLY that column
    # (no umi / n_genes forced). The emitted names ARE the rows' names (DEC-1) — there is
    # no `pct_` prefix rule left to restate here, which is why this test can no longer
    # drift from the compute.
    p = {"qc_metrics": [{"name": "pct_hb", "pattern": r"^HB[AB]", "aggregation": "percentage"}]}
    assert [m["name"] for m in qc.parse_qc_metrics(p)] == ["pct_hb"]


def test_a_whole_set_row_and_a_pattern_row_compose_in_order():
    p = {"qc_metrics": [
        {"name": "total_counts", "pattern": ".*", "aggregation": "sum"},
        {"name": "pct_mito", "pattern": r"^MT-", "aggregation": "percentage"},
    ]}
    assert [m["name"] for m in qc.parse_qc_metrics(p)] == ["total_counts", "pct_mito"]
