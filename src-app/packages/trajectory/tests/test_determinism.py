#!/usr/bin/env python3
# ruff: noqa
"""TEST-11 — the determinism pin holds, in the process where it matters.

This matters more for an ordering than for a partition. A reordered floating-point reduction
moves a partition's answer only when it pushes one borderline cell across a boundary; it
moves a pseudotime's answer for EVERY cell, a little, because the result is a distance in a
basis the reduction helped compute.

The environment is read out of the RUNNING compute rather than scraped from its source, so
this proves the pin took effect in the child process rather than that the right lines exist
in a file.

Mutation: move the pin below the first numeric import -> the numeric stack initialises
threaded before the pin lands and the byte-identity assertions become flaky rather than
failing outright, which is why the env read-back is asserted separately and directly.
"""
import numpy as np
import pytest

from trajectory_generators import barcodes, branching_walk, cells_digest, embed

pytest.importorskip("scanpy")
pytest.importorskip("igraph")

THREAD_VARS = ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
               "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS")


@pytest.fixture(scope="module")
def fixture():
    counts, _tt, branch = branching_walk(n_per_branch=150, seed=0)
    return embed(counts), branch


def test_the_pin_is_read_out_of_the_running_compute_not_its_source(paga_run, fixture):
    emb, branch = fixture
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(branch, name="branch")
    run.run_ok({})

    env = run.report()["determinism_env"]
    for var in THREAD_VARS:
        assert env[var] == "1", f"{var} was {env[var]!r} inside the running compute"
    # the cross-machine codegen identity: without it the numeric JIT specialises to the build
    # host's CPU, and a re-run on a different microarchitecture can reorder reductions.
    assert env["NUMBA_CPU_NAME"] == "generic"


def test_the_pin_sits_above_the_first_numeric_import():
    """Order is the whole mechanism: an environment variable read at import time by the
    numeric stack is only honoured if it is set BEFORE that import. Asserted on the source
    because it is a property of the file's structure, not of a run."""
    from pathlib import Path

    source = (Path(__file__).resolve().parents[1] / "compute" / "_shared.py").read_text()
    pin = source.index("NUMBA_CPU_NAME")
    first_numeric = source.index("import numpy")
    assert pin < first_numeric, (
        "the determinism pin is set AFTER numpy is imported, so the numeric stack has "
        "already initialised by the time it lands")


def test_a_server_set_value_is_never_overridden():
    """Every pin is a set-default, so a genuine deployment-set value wins. A processor that
    hard-set these would silently override an operator's deliberate choice."""
    from pathlib import Path

    source = (Path(__file__).resolve().parents[1] / "compute" / "_shared.py").read_text()
    block = source[source.index("THREAD_ENV_VARS = ("):source.index("def resolved_")]
    assert "setdefault" in block
    assert "os.environ[" not in block, (
        "a pin assigns unconditionally, which would override a server-set value")


def test_two_identical_graph_runs_produce_identical_adjacency(paga_run, fixture):
    emb, branch = fixture
    a = paga_run()
    a.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    a.add_partition(branch, name="branch")
    a.run_ok({"seed": 0})

    b = paga_run()
    b.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    b.add_partition(branch, name="branch")
    b.run_ok({"seed": 0})

    assert np.array_equal(a.adjacency(), b.adjacency())
    assert a.node_labels() == b.node_labels()
    assert a.graph_structure()["tree_edges"] == b.graph_structure()["tree_edges"]


def test_two_identical_pseudotime_runs_produce_identical_bytes(dpt_run, fixture):
    emb, branch = fixture
    n = emb.shape[0]
    params = {"root_mode": "root_cluster", "root_level": "trunk", "seed": 0}

    a = dpt_run()
    a.add_embedding(emb, aligned_to=cells_digest(n))
    a.add_partition(branch, slot="root_column", name="branch")
    a.add_keys(barcodes(n))
    a.run_ok(params)

    b = dpt_run()
    b.add_embedding(emb, aligned_to=cells_digest(n))
    b.add_partition(branch, slot="root_column", name="branch")
    b.add_keys(barcodes(n))
    b.run_ok(params)

    assert a.column_bytes() == b.column_bytes()
    assert np.array_equal(a.pseudotime(), b.pseudotime())
