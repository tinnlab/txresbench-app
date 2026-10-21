#!/usr/bin/env python3
# ruff: noqa
"""TEST-28 — the partition column's contract, at the edges a sorted fixture cannot reach.

Every case here was invisible to the suite until the fixture gained an explicit level-set
channel: it always declared `sorted(set(values))`, so the declaration always matched the data
exactly and in sorted order. Three real branches were therefore unreachable, and one of them
ended in a raw library traceback.

Mutation: drop the natsort and take the producer's declared order -> the ordering test fails
on the ten-level fixture. Drop the undeclared-label refusal -> that test sees an igraph
InternalError traceback instead of a named refusal. Drop the missing-sentinel refusal -> the
invented level becomes a graph node with a real cell count.
"""
import numpy as np
import pytest

from trajectory_generators import branching_walk, cells_digest, embed

pytest.importorskip("scanpy")
pytest.importorskip("igraph")


@pytest.fixture(scope="module")
def fixture():
    counts, _tt, branch = branching_walk(n_per_branch=150, seed=0)
    return embed(counts), branch


@pytest.fixture(scope="module")
def ten_level():
    """A partition with TEN numeric levels, where lexicographic and natural order DIFFER.

    Three levels of one character each — what every other fixture uses — cannot tell the two
    apart, which is why the node-ordering claim went unchecked for its whole first round.
    """
    rng = np.random.default_rng(0)
    n_per = 25
    emb = np.vstack([rng.normal(i * 1.1, 1.0, (n_per, 8)) for i in range(1, 13)]).astype(
        np.float32)
    labels = np.repeat([str(i) for i in range(1, 13)], n_per)
    return emb, labels


def test_node_order_is_NATSORTED_not_lexicographic(paga_run, ten_level):
    """'10' sorts before '2' lexicographically and after it naturally. The declaration says
    natsorted, so the artifact must actually be natsorted."""
    emb, labels = ten_level
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(labels, name="grp")
    run.run_ok({"n_neighbors": 15})

    natural = [str(i) for i in range(1, 13)]
    lexicographic = sorted(natural)
    assert natural != lexicographic, "the fixture cannot distinguish the two orders"
    assert run.node_labels() == natural, (
        f"node order is {run.node_labels()} — the artifact declares natsorted order and the "
        "report repeats that claim, so it has to be true of the bytes")


def test_node_order_is_natsorted_even_when_the_producer_declared_another_order(
        paga_run, ten_level):
    """An imported annotation routinely carries a biological rather than a sorted level
    order, and an explicit level set is preserved VERBATIM by the underlying library. So the
    order is imposed here rather than inherited — otherwise the artifact's own declaration
    would be false for exactly the inputs a real user brings."""
    emb, labels = ten_level
    scrambled = ["12", "3", "1", "10", "2", "4", "5", "6", "7", "8", "9", "11"]
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(labels, name="grp", categories=scrambled)
    run.run_ok({"n_neighbors": 15})

    assert run.node_labels() == [str(i) for i in range(1, 13)]
    assert run.report()["partition"]["declared_levels"] == scrambled, (
        "the fixture did not actually declare a scrambled order, so this proves nothing")


def test_a_label_outside_the_declared_level_set_never_reaches_the_library(paga_run,
                                                                          fixture):
    """A label the declaration does not list would become an invalid group index and kill the
    library inside its own graph constructor — a raw traceback reaching the user.

    What actually happens is one step earlier and better: the column writer encodes such a
    value as MISSING (that is what an out-of-set value is to a categorical), so the artifact
    arrives carrying the invented sentinel and the unlabelled-cells refusal catches it first,
    with the more useful message. The compute keeps a second, narrower refusal for a label
    that arrives outside the declared set WITHOUT the sentinel — unreachable through this
    writer, and cheap defence for a column some other producer wrote.

    What this test pins either way: the run refuses BY NAME, and no library traceback ever
    reaches the user.
    """
    emb, branch = fixture
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    # declares only two of the three levels the data actually carries.
    run.add_partition(branch, name="branch", categories=["A", "B"])
    proc = run.run_fails({"n_neighbors": 15})

    diagnostics = run.diagnostics(proc)
    assert diagnostics, "the run failed with no named refusal at all"
    assert "cells with NO value" in diagnostics, (
        "expected the sentinel refusal, which is the one that fires for this input")
    assert "Traceback" not in proc.stderr, (
        "the library's traceback reached the user — no refusal ran first")
    assert "InternalError" not in proc.stderr


def test_a_label_absent_from_the_declaration_WITHOUT_a_sentinel_refuses_by_name(paga_run,
                                                                                fixture):
    """The narrower refusal, reached by writing the store the ordinary writer cannot produce.

    The test above goes through `pd.Categorical`, which turns any out-of-set value into a
    missing sentinel BEFORE the compute sees it — so it can only ever exercise the sentinel
    refusal, and the earlier version of it hid that behind an `or`. That made a second
    refusal look tested while it was in fact unreachable and unexercised.

    This builds the store by hand: a declared level set that omits a label the values carry,
    and NO missing-value declaration. That is what a producer outside this tree could emit,
    and it is the input that would otherwise reach the library as an invalid group index.
    """
    import json

    emb, branch = fixture
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    dest = run.add_partition(branch, name="branch")

    # Narrow the DECLARED level set after the fact, leaving the codes and values untouched:
    # the store now claims two levels while its values resolve to three, with nothing marked
    # missing. Exactly the shape the compute's second refusal exists for.
    member = dest / "values" / "zarr.json"
    doc = json.loads(member.read_text())
    doc["attributes"]["cyto"]["levels"] = ["A", "B"]
    member.write_text(json.dumps(doc, indent=2))

    proc = run.run_fails({"n_neighbors": 15})
    diagnostics = run.diagnostics(proc)
    # An internally inconsistent store: the codes run past the declaration they index into.
    # Before this refusal existed the shared reader raised a bare IndexError from framework
    # code — a traceback reaching the user, which is what every refusal here replaces. That
    # was found by BUILDING this fixture, not by reading the code.
    assert "does not define" in diagnostics
    assert "internally inconsistent" in diagnostics
    assert "Traceback" not in proc.stderr, (
        "a framework traceback reached the user instead of a named refusal")
    assert "IndexError" not in proc.stderr


def test_a_partition_with_unlabelled_cells_refuses_by_name(paga_run, fixture):
    """The column writer encodes a missing categorical by INVENTING a level. Left alone it
    becomes a graph node made entirely of cells nobody labelled, indistinguishable from a
    biological group."""
    import pandas as pd

    import cyto_columns

    emb, branch = fixture
    values = [str(v) for v in branch]
    values[10] = None
    values[20] = None

    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    mount = run._mount(None)
    dest = run.inputs_dir / mount
    series = pd.Series(pd.Categorical(values, categories=["A", "B", "trunk"]))
    cyto_columns.write_metadata_column(dest.parent, dest.name, "branch", series, axis="cells")
    run._declare("partition", mount)
    proc = run.run_fails({"n_neighbors": 15})

    diagnostics = run.diagnostics(proc)
    assert "cells with NO value" in diagnostics
    assert "invented level" in diagnostics
    assert "nobody labelled" in diagnostics


def test_a_column_from_a_DIFFERENT_row_space_refuses_by_name(paga_run, fixture):
    """Equal length is not alignment. Two artifacts over equally many cells can be over
    entirely different cells, and the result would be a plausible graph over scrambled
    labels with every declaration well-formed."""
    emb, branch = fixture
    n = emb.shape[0]
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(n))
    # same LENGTH, different declared row space.
    run.add_partition(branch, name="branch", aligned_to=cells_digest(n + 1))
    proc = run.run_fails({"n_neighbors": 15})

    diagnostics = run.diagnostics(proc)
    assert "DIFFERENT row space" in diagnostics
    assert "A length match is not an alignment" in diagnostics


def test_an_aligned_column_is_accepted_so_the_check_is_not_vacuous(paga_run, fixture):
    """The positive control: the same check must PASS when the row spaces agree, or it would
    be refusing everything and the test above would prove nothing."""
    emb, branch = fixture
    digest = cells_digest(emb.shape[0])
    run = paga_run()
    run.add_embedding(emb, aligned_to=digest)
    run.add_partition(branch, name="branch", aligned_to=digest)
    run.run_ok({"n_neighbors": 15})
    assert run.node_labels() == ["A", "B", "trunk"]
