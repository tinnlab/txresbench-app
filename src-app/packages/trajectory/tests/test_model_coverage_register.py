#!/usr/bin/env python3
# ruff: noqa
"""TEST-20 — the model-coverage decision this package was required to make.

Being the first producer of a previously-unproduced open kind DELIBERATELY trips a committed
guard: the producer register is complete and asserted in both directions, so a new
(producer x row-bearing datatype) pair goes red until somebody records what it states. And
the standing lattice entry said, in its own words, "Remove this entry when the first producer
lands, and decide it then."

This is the package-side half of that decision, so it fails in THIS suite rather than only
in the whole-tree guard run. The guard's own arms remain the authority.

Mutation: drop either register row -> the guard's producer arm goes red in both directions.
Leave the lattice reason claiming there is no in-tree producer -> the stated reason is false
while the assertion still holds, which is the quiet kind of wrong this test exists to catch.
"""
import json
from pathlib import Path

import pytest

_PACKAGES = Path(__file__).resolve().parents[2]
_REGISTER = _PACKAGES / "_lib" / "model_coverage_exempt.json"

#: The CLOSED disposition vocabulary. Open vocabularies become free-text fields nobody reads.
DISPOSITIONS = {"rows-declared", "rows-undeclared"}
#: The guard's own floor for a stated reason.
MIN_REASON = 40


@pytest.fixture(scope="module")
def register():
    return json.loads(_REGISTER.read_text())


def test_the_register_parses_and_is_not_empty(register):
    assert register["producer"], "the producer register is empty"
    assert register["lattice"], "the lattice list is empty"


@pytest.mark.parametrize("producer,datatype", [
    ("trajectory.paga", "graph/attributed"),
    ("trajectory.dpt", "metadata-column"),
])
def test_each_new_producer_output_has_a_recorded_disposition(register, producer, datatype):
    rows = [r for r in register["producer"]
            if r["producer"] == producer and r["datatype"] == datatype]
    assert len(rows) == 1, (
        f"expected exactly one register row for {producer} x {datatype}, got {len(rows)}")
    row = rows[0]
    assert row["disposition"] in DISPOSITIONS, (
        f"{row['disposition']!r} is outside the closed vocabulary — the vocabulary is closed "
        "so a disposition stays a decision rather than a sentence")
    assert len(row["reason"].strip()) >= MIN_REASON, (
        "an entry without a real reason is a waiver, and this register exists to record "
        "decisions")


def test_the_graph_producer_states_what_its_rows_ACTUALLY_are(register):
    """The substance of the decision, not just its presence: the nodes are levels of a
    partition, which is why the axis stays unanchored."""
    row = next(r for r in register["producer"] if r["producer"] == "trajectory.paga")
    reason = row["reason"].lower()
    assert "level" in reason
    assert "first" in reason and "producer" in reason
    # it says what it would TAKE to declare, rather than only that it does not.
    assert "what it would take" in reason


def test_the_pseudotime_producer_records_its_partial_coverage_case(register):
    """The wrinkle worth recording: the column is defined over the whole axis but valued
    only on the root's component when the graph is disconnected."""
    row = next(r for r in register["producer"] if r["producer"] == "trajectory.dpt")
    reason = row["reason"].lower()
    assert "whole axis" in reason
    assert "declared-missing" in reason or "missing" in reason


def test_the_lattice_entry_no_longer_claims_there_is_no_producer(register):
    """The specific sentence this branch makes false.

    The entry SURVIVES — the axis is still unanchored — but for a different and stronger
    reason, and leaving the old wording would be a guard whose stated justification is
    untrue while its assertion still passes.
    """
    entry = next(r for r in register["lattice"] if r["datatype"] == "graph/attributed")
    reason = entry["reason"]
    lowered = reason.lower()

    assert "no in-tree producer" not in lowered, (
        "the lattice entry still says the kind has no in-tree producer, which this package "
        "makes false")
    assert "remove this entry when the first producer lands" not in lowered, (
        "the entry still carries the instruction that has now been carried out")
    # …and it records the decision that replaced it.
    assert "level" in lowered
    assert "decision" in lowered
    assert len(reason.strip()) >= MIN_REASON


def test_the_entry_explains_why_a_subtype_declaration_would_not_settle_it(register):
    """The joint question with the other candidate producer: its nodes WOULD be entries of a
    real axis, so no single declaration could be honest for both. Recorded so the next reader
    does not "simplify" it into one."""
    entry = next(r for r in register["lattice"] if r["datatype"] == "graph/attributed")
    assert "#118" in entry["reason"]


def test_the_framework_package_version_moved_with_the_register_edit():
    """A mechanical consequence, recorded rather than discovered from a red guard: the
    seed-version check globs every package manifest INCLUDING the framework library's, so any
    change inside it requires that package's version to move forward."""
    import re

    manifest = (_PACKAGES / "_lib" / "manifest.yaml").read_text()
    version = re.search(r"^version:\s*(\S+)", manifest, re.M).group(1)
    assert version != "0.3.0", (
        "the framework library's version did not move, but a file inside it changed — the "
        "seed-version guard will refuse this branch")
