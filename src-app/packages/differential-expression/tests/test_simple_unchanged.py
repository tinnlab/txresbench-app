#!/usr/bin/env python3
# ruff: noqa
"""TEST-2 [acceptance] [invariant: INV-A2] [covers: ITEM-1, ITEM-3] — Simple stays the default and
is BYTE-UNCHANGED by the advanced additions.

With `contrast_mode` absent (the default) or explicitly `simple`, `de.compare` produces the SAME
`de/result` for the same two-level contrast, and the Advanced block is INERT — advanced params
(`group1_criteria`) are ignored. The v1 suite proves the simple compute itself; this pins that the
v0.2 fork did not alter it. A mutation that lets the advanced branch leak into the simple path
FAILS."""
import json
from pathlib import Path

import numpy as np

from de_fixtures import EXTERNAL, group_labels, two_group_expression

_GOLDEN = Path(__file__).resolve().parent / "fixtures" / "simple_v1_golden.json"


def _run_simple(compare_run, params):
    run = compare_run()
    run.add_expression(two_group_expression(n_per=30, n_genes=24, seed=4))
    run.add_column(group_labels(30, ("treated", "control")), slot="grouping", name="condition",
                   provenance=EXTERNAL)
    run.run_ok(params)
    return run


def _members_map(run):
    ent = run.de_entries()[0]
    return {m: np.asarray(run.de_column(ent, m), dtype=float)
            for m in run.de_members(ent) if m != "gene"}


def test_default_equals_explicit_simple_and_ignores_advanced_params(compare_run):
    # 1) contrast_mode ABSENT (the default).
    default = _run_simple(compare_run, {"group1": "treated", "group2": "control"})
    # 2) contrast_mode == "simple" AND advanced params supplied — must be INERT.
    explicit = _run_simple(compare_run, {
        "contrast_mode": "simple", "group1": "treated", "group2": "control",
        # these MUST be ignored in simple mode (the advanced block is opt-in only).
        "group1_criteria": [{"column": "condition", "keep": ["treated"]}],
        "group2_criteria": [{"column": "condition", "keep": ["control"]}],
    })
    assert default.report()["regime"] == explicit.report()["regime"]
    assert default.report()["contrast"] == explicit.report()["contrast"] == "treated vs control"
    # the advanced provenance shape never appears in a simple run.
    assert "advanced_contrast" not in (default.report().get("grouping_provenance") or {})
    dm, em = _members_map(default), _members_map(explicit)
    assert set(dm) == set(em)
    for member, arr in dm.items():
        assert np.array_equal(arr, em[member]), f"simple result changed on member {member!r}"


# ── AC6 [acceptance] [invariant: INV-A2] — the v1 NUMERIC ANCHOR. The test above proves internal
# consistency (default == explicit-simple) WITHIN the advanced build, so a shared-path refactor
# that perturbs Simple IDENTICALLY on both runs stays green. This pins the Simple-mode `de/result`
# to a COMMITTED golden generated before this feature: any drift in the shared banded-means path
# that changes the Simple numbers FAILS here. Regenerate the golden only with a deliberate,
# reviewed change to the Simple computation.
def test_simple_result_matches_committed_v1_golden(compare_run):
    golden = json.loads(_GOLDEN.read_text())
    run = compare_run()
    run.add_expression(two_group_expression(n_per=10, n_genes=6, seed=0))
    run.add_column(group_labels(10, ("treated", "control")), slot="grouping", name="condition",
                   provenance=EXTERNAL)
    run.run_ok({"group1": "treated", "group2": "control"})
    assert run.report()["regime"] == golden["regime"] == "R3"
    assert run.report()["contrast"] == golden["contrast"] == "treated vs control"
    ent = run.de_entries()[0]
    got = {m: np.asarray(run.de_column(ent, m), dtype=float)
           for m in run.de_members(ent) if m != "gene"}
    assert set(got) == set(golden["members"]), (
        set(got).symmetric_difference(golden["members"]))
    for member, expected in golden["members"].items():
        assert np.array_equal(got[member], np.asarray(expected, dtype=float)), (
            f"Simple-mode {member!r} drifted from the committed v1 golden — the shared banded path "
            "changed the Simple computation")
