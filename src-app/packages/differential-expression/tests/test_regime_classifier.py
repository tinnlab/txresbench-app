#!/usr/bin/env python3
# ruff: noqa
"""TEST-17 [covers: ITEM-9] — the regime truth table (INV-2 / DEC-4)."""
from de_fixtures import import_own

R = import_own("_regime")


def test_matrix_derived_is_r2():
    assert R.classify({"clustering": {"method": "leiden"}}, samples_per_side=5) == R.R2
    assert R.classify({"annotation": {}}, samples_per_side=2) == R.R2
    assert R.classify({"derived_from_matrix": True}, samples_per_side=9) == R.R2


def test_external_replicated_is_r1():
    assert R.classify({"external": True}, samples_per_side=2) == R.R1
    assert R.classify({"provenance": "external"}, samples_per_side=4) == R.R1


def test_external_unreplicated_is_r3():
    assert R.classify({"external": True}, samples_per_side=1) == R.R3
    assert R.classify({"external": True}, samples_per_side=None) == R.R3


def test_no_provenance_defaults_conservatively_to_r2():
    # DEC-4 — a no-evidence grouping defaults to R2, NEVER R1 (a wrong default fabricates a p).
    assert R.classify({}, samples_per_side=5) == R.R2
    assert R.classify({"something": "else"}, samples_per_side=9) == R.R2
    assert R.classify(None, samples_per_side=2) == R.R2


def test_mutation_defaulting_no_provenance_to_r1_would_fail():
    # The negative control: if the classifier returned R1 for a no-provenance grouping with
    # samples, this assertion (the DEC-4 conservative default) would go red.
    assert R.classify({}, samples_per_side=100) != R.R1
