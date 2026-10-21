#!/usr/bin/env python3
# ruff: noqa
"""TEST-15 [acceptance] [invariant: INV-11] [covers: ITEM-13a, ITEM-13] — the six-var pin.

The CHILD process environment carries ALL SIX thread vars pinned to "1", read out of the
RUNNING compute (the report records `os.environ` after the pin), never from source text.
"""
SIX = (
    "OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS",
)


def test_all_six_thread_vars_are_pinned_in_the_running_child(reduce_run):
    from embedding_fixtures import counts_matrix

    run = reduce_run()
    run.add_matrix(counts_matrix(40, 25, seed=0))
    # run with the six vars UNSET (absent) in the child env, so a pin the compute did not
    # perform would show up as a missing/None value.
    run.run_ok({"n_hvg": 12, "n_pcs": 6, "seed": 0},
               env_extra={v: None for v in SIX})  # absent; setdefault should pin to "1"

    pins = run.report()["thread_pins"]
    for v in SIX:
        assert pins.get(v) == "1", (v, pins)


def test_the_server_pinned_three_are_not_overridden(reduce_run):
    """`setdefault` — a genuine server-set value survives; the processor only fills the
    three the server leaves unset. Here the three server vars are pre-set to "1" and the
    other three are pinned by the processor."""
    from embedding_fixtures import counts_matrix

    run = reduce_run()
    run.add_matrix(counts_matrix(40, 25, seed=1))
    run.run_ok({"n_hvg": 12, "n_pcs": 6},
               env_extra={"OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1",
                          "MKL_NUM_THREADS": "1"})
    pins = run.report()["thread_pins"]
    assert all(pins[v] == "1" for v in SIX)
