#!/usr/bin/env python3
# ruff: noqa
"""TEST-10 [covers: ITEM-7, ITEM-9] — same seed ⇒ byte-identical outputs, INCLUDING `n_nhoods`.

`n_nhoods` is the non-obvious part. The index cells are drawn with a seeded RNG and then refined
to the nearest actual cell to each neighbourhood's median position; the refinement is followed by
a dedup, so two seeds on the same data legitimately give DIFFERENT NUMBERS of neighbourhoods.
That is why `seed` is an explicit recorded parameter, why the report records `n_nhoods` rather
than anything inferring it, and why the parity fixture has to commit `prop` and `seed` or the
neighbourhood matching is undefined.
"""
import numpy as np

from da_fixtures import embedding_dataset, EXTERNAL

PARAMS = {"method": "nb_glm", "prop": 0.15}


def _bind(run, seed_data=1):
    X, conds, samps, _ = embedding_dataset(n_per_sample=180, samples_per_side=3, seed=seed_data)
    run.add_embedding(X, slot="embedding")
    run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
    run.add_column(samps, slot="sample", name="sample")
    return X


def test_two_runs_at_the_same_seed_produce_identical_columns_and_n_nhoods(neighbourhoods_run):
    a, b = neighbourhoods_run(), neighbourhoods_run()
    _bind(a)
    _bind(b)
    a.run_ok(dict(PARAMS, seed=7))
    b.run_ok(dict(PARAMS, seed=7))

    ra, rb = a.report(), b.report()
    assert ra["n_nhoods"] == rb["n_nhoods"]
    assert ra["index_cells"] == rb["index_cells"]
    assert ra["kth_distance"] == rb["kth_distance"]

    ea, eb = a.da_entries()[0], b.da_entries()[0]
    assert a.da_members(ea) == b.da_members(eb)
    for member in sorted(a.da_members(ea)):
        x = a.da_column(ea, member)
        y = b.da_column(eb, member)
        if member == "population":
            assert list(x) == list(y)
        else:
            xa = np.asarray(x, dtype=float)
            ya = np.asarray(y, dtype=float)
            assert np.array_equal(np.nan_to_num(xa, nan=-999.0), np.nan_to_num(ya, nan=-999.0)), \
                member


def test_a_different_seed_can_change_n_nhoods_which_is_why_it_is_recorded(neighbourhoods_run):
    counts = set()
    for seed in (0, 1, 2, 3, 4, 5):
        run = neighbourhoods_run()
        _bind(run)
        run.run_ok(dict(PARAMS, seed=seed))
        counts.add(run.report()["n_nhoods"])
    assert len(counts) > 1, (
        f"every seed gave the same neighbourhood count ({counts}). Either the refinement dedup is "
        "not running or the fixture is degenerate; in both cases the reason `n_nhoods` is "
        "RECORDED rather than inferred is not being exercised.")


def test_the_determinism_environment_is_read_out_of_the_running_process(neighbourhoods_run):
    """Recorded from the CHILD's own environment, not from source text, so the test proves what
    the run actually saw."""
    run = neighbourhoods_run()
    _bind(run)
    run.run_ok(PARAMS)
    env = run.report()["determinism_env"]
    for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
                "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS"):
        assert env[var] == "1", f"{var} was {env[var]!r} in the running compute"
    assert env["NUMBA_CPU_NAME"] == "generic"


def test_the_cluster_analysis_is_deterministic_too(clusters_run):
    from da_fixtures import population_dataset

    outs = []
    for _ in range(2):
        run = clusters_run()
        pops, conds, samps = population_dataset(n_per_sample=200, samples_per_side=3)
        run.add_column(pops, slot="population", name="leiden")
        run.add_column(conds, slot="condition", name="condition", provenance=EXTERNAL)
        run.add_column(samps, slot="sample", name="sample")
        run.run_ok({"method": "nb_glm", "group1": "treat", "group2": "ctrl"})
        entry = run.da_entries()[0]
        outs.append({m: list(run.da_column(entry, m)) for m in sorted(run.da_members(entry))})
    assert outs[0].keys() == outs[1].keys()
    for member in outs[0]:
        x, y = outs[0][member], outs[1][member]
        if member == "population":
            assert x == y
        else:
            assert np.array_equal(np.nan_to_num(np.asarray(x, float), nan=-999.0),
                                  np.nan_to_num(np.asarray(y, float), nan=-999.0)), member
