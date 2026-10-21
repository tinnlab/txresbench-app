#!/usr/bin/env python3
# ruff: noqa
"""TEST-8 [acceptance] [invariant: INV-8] [covers: ITEM-7] — the determinism environment.

The recorded determinism env carries pinned NUMBA/NUMEXPR/VECLIB thread caps + NUMBA_CPU_NAME
(read out of the RUNNING child, never source text), and two runs at the same seed produce
identical labels. A run with the pins UNSET is detectably pinned by the processor's
`setdefault` — the no-op pin is caught.
"""
from clustering_fixtures import cells_digest, three_blob_embedding

PINNED = (
    "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS",
    "NUMBA_CPU_NAME",
)
# The THREE the processor owns (the server pins OMP/OPENBLAS/MKL); these three unpinned
# make numba non-reproducible.
PROCESSOR_OWNED = ("NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS")


def test_determinism_env_is_pinned_in_the_running_child(cluster_run):
    run = cluster_run()
    run.add_embedding(three_blob_embedding(30, 8, seed=0), aligned_to=cells_digest(90))
    # run with the processor-owned vars UNSET (absent) in the child env, so a pin the
    # compute did NOT perform would show up as a missing/None value.
    run.run_ok({"resolution": 1.0, "seed": 0},
               env_extra={v: None for v in PROCESSOR_OWNED})

    env = run.report()["determinism_env"]
    for v in PINNED:
        assert env.get(v) is not None, (v, env)
    for v in PROCESSOR_OWNED:
        assert env[v] == "1", (v, env)
    # NUMBA_CPU_NAME is pinned to `generic` for cross-machine codegen identity.
    assert env["NUMBA_CPU_NAME"] == "generic"


def test_two_runs_at_the_same_seed_produce_identical_labels(cluster_run):
    r1 = cluster_run()
    r1.add_embedding(three_blob_embedding(40, 10, seed=0), aligned_to=cells_digest(120))
    r1.run_ok({"resolution": 1.0, "seed": 11})

    r2 = cluster_run()
    r2.add_embedding(three_blob_embedding(40, 10, seed=0), aligned_to=cells_digest(120))
    r2.run_ok({"resolution": 1.0, "seed": 11})

    assert r1.labels() == r2.labels()


def test_server_pinned_three_are_not_overridden(cluster_run):
    """`setdefault` — a genuine server-set value survives; the processor only fills the
    three the server leaves unset."""
    run = cluster_run()
    run.add_embedding(three_blob_embedding(30, 8, seed=1), aligned_to=cells_digest(90))
    run.run_ok({"resolution": 1.0},
               env_extra={"OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1",
                          "MKL_NUM_THREADS": "1"})
    env = run.report()["determinism_env"]
    assert all(env[v] == "1" for v in PINNED[:6])
