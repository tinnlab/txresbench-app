#!/usr/bin/env python3
# ruff: noqa
"""TEST-51 — PARITY against an INDEPENDENT `scDblFinder` reference run.

── Why this file exists, and it is not "one more test" ────────────────────────────────────
Every other assertion about this entry's per-sample prior compares the entry against ITSELF:
the report re-states the value, and "a level scores the same alone as inside the batch" runs
the same code twice. A blind audit showed exactly what that cannot see — replace the value
handed to the library with a flat, wrong-but-uniform `dbr = 0.30`, leave the report's own
expression alone, and **47 of 47 tests still pass** while the fit demonstrably moves.

A first attempt to fix it restructured the code so the report and the call read the same
variable. That makes them LOOK coupled and enforces nothing: a second audit reproduced the
identical mutation against the restructured code and it survived again. The lesson is
specific and worth stating plainly — **a refactor is not an assertion.** No arrangement of
one program can testify about itself; the only thing that can is a second, independent
computation of the same quantity.

So this file is that second computation. It calls `scDblFinder` DIRECTLY, in its own R
process, with the parameters the entry's own report SAYS it used, and requires the scores to
match. If the entry fitted with a prior other than the one it published, the reference — told
the published one — diverges, and this goes red. That is the only leg on the branch that can
distinguish "the report is honest" from "the report is consistent with itself".

── Why the reference is trustworthy ───────────────────────────────────────────────────────
It is not a reimplementation of the method: it is the same installed `scDblFinder` at the
same pinned version, in the same image, called with the same seed. The only thing this file
reimplements is the WIRING — building a `SingleCellExperiment` and passing the parameters —
which is precisely the part under test. Mirrors `test_parity.py`'s discipline for the python
lane: an independent reference run in a subprocess, all thread variables pinned (the sandbox
argv sets `OMP_NUM_THREADS`/`OPENBLAS_NUM_THREADS`/`MKL_NUM_THREADS` to 1), joined
positionally against a matrix staged in a known order.

── TWO MEASURED SENSITIVITIES, DOCUMENTED RATHER THAN AVERAGED AWAY ──────────────────────
Both were found by this file failing, and the second one nearly made it useless.

**1. The score is reproducible to ~5e-16, not bit-exactly.** The entry hands `scDblFinder` a
`dgCMatrix` decoded from the CSC store; this reference hands it a dense matrix read from
text. Same numbers, different container, and the library's own PCA takes a different internal
path — measured max |diff| 4.996e-16 over 240 cells, i.e. last-bit floating-point noise. The
tolerance below is 1e-12: still orders of magnitude tighter than any change a wrong parameter
produces, so it costs no sensitivity. A stated tolerance with a measured cause, not a number
widened until the test passed.

**2. `dbr` IS OBSERVABLE ONLY ON A FIXTURE THAT CONTAINS DOUBLETS — and the first draft of
this file used one that did not.** That draft ran on two clean populations, saw identical
scores AND identical calls at `dbr = 0.00192` and `dbr = 0.30`, and concluded the library
was insensitive to its own prior. It was the FIXTURE that was insensitive. Swept directly:

    clean 2-population fixture, 240 cells, no doublets present
      dbr 1e-6 … 0.5   called 0 at every value, threshold 0.618080 at every value,
                       score sum 106.340000063 at every value — NOTHING moves

    fixture with 20 real cross-group doublets appended, 260 cells
      dbr 1e-6   called 14   thr 0.909894   score sum 24.790595
      dbr 0.002  called 14   thr 0.909891   score sum 24.790595
      dbr 0.02   called 13   thr 0.860503   score sum 24.641332
      dbr 0.06   called 22   thr 0.145944   score sum 25.205111
      dbr 0.30   called 22   thr 0.145944   score sum 25.205111

So the prior reaches the artificial-doublet construction and therefore the fit, not merely
the threshold — but only when there is something to find. **A parity test on a doublet-free
fixture is blind to every parameter that matters**, and would have passed the audit's
surviving mutation for exactly that reason. This file now scores a fixture with real
doublets in it, and `test_the_reference_is_SENSITIVE_to_the_prior_it_is_given` is the
standing proof that the fixture still has that property.
"""
import json

import numpy as np
import pandas as pd
import pytest

from doublet_fixtures import (ScdblfinderRun, require_r_env, run_in_r_sandbox,
                              structured_counts)

@pytest.fixture(autouse=True)
def _needs_r():
    require_r_env()


def _with_doublets(dense, n_doublets, group_size, seed):
    """`dense` with `n_doublets` genuine CROSS-GROUP sums appended.

    Without these the fixture has nothing to detect, and `dbr` becomes unobservable — see
    sensitivity note 2. The pairs cross a group boundary because a within-group sum is
    homotypic and near-undetectable by construction, so it would not restore sensitivity.
    """
    rng = np.random.default_rng(seed)
    rows, n = [], dense.shape[0]
    while len(rows) < n_doublets:
        i, j = rng.integers(0, n, 2)
        if i // group_size == j // group_size:
            continue
        rows.append(dense[i] + dense[j])
    return np.vstack([dense, np.asarray(rows, dtype=dense.dtype)])


def _two_populations(seed=0):
    """`(a, b, merged, labels)` — two distinct populations of UNEQUAL size, each containing
    genuine doublets, so a single pooled prior cannot coincide with either level's own
    derived value AND the prior is observable at all."""
    group = 60
    block = structured_counts(n_per_group=group, n_genes=180, n_groups=4, seed=seed)
    a = _with_doublets(block[:group * 2], 12, group, seed + 1)
    b = _with_doublets(block[group * 2:], 20, group, seed + 2)
    merged = np.vstack([a, b])
    labels = ["S1"] * a.shape[0] + ["S2"] * b.shape[0]
    return a, b, merged, labels


_REFERENCE_R = r"""
# An INDEPENDENT `scDblFinder` reference. It shares nothing with the entry under test except
# the installed library: it builds its own SingleCellExperiment from a plain dense matrix
# handed to it as TSV, and passes the parameters it is told to pass.
suppressPackageStartupMessages({
  library(Matrix); library(jsonlite); library(scDblFinder); library(SingleCellExperiment)
})
args <- commandArgs(TRUE)
spec <- fromJSON(args[1], simplifyVector = TRUE)
counts <- as.matrix(read.table(spec$matrix, sep = "\t"))       # cells x genes
sce <- SingleCellExperiment(list(counts = t(counts)))          # library wants genes x cells
set.seed(as.integer(spec$seed))
res <- scDblFinder(
  sce,
  clusters = NULL, samples = NULL, knownDoublets = NULL,
  dbr = as.numeric(spec$dbr),
  dbr.sd = NULL,
  dbr.per1k = as.numeric(spec$dbr_per1k),
  nfeatures = as.integer(spec$nfeatures),
  dims = as.integer(spec$dims),
  includePCs = as.integer(spec$include_pcs),
  propRandom = as.numeric(spec$prop_random),
  propMarkers = as.numeric(spec$prop_markers),
  score = spec$score,
  returnType = "sce", verbose = FALSE,
  BPPARAM = BiocParallel::SerialParam(progressbar = FALSE)
)
cd <- SummarizedExperiment::colData(res)
write(toJSON(list(score = as.numeric(cd$scDblFinder.score),
                  class = as.character(cd$scDblFinder.class)),
             digits = NA), spec$out)
"""


def _reference_scores(tmp_path, dense, *, dbr, seed, params, tag):
    """`scDblFinder`'s own scores for `dense`, fitted independently at `dbr` and `seed`."""
    work = tmp_path / f"ref-{tag}"
    work.mkdir(parents=True, exist_ok=True)
    script = work / "reference.R"
    script.write_text(_REFERENCE_R)
    matrix_path = work / "counts.tsv"
    # THROUGH float32 FIRST. The entry reads its counts out of a CSC store whose `data`
    # member is float32 (`cyto_csc.DATA_DTYPE`), so it sees float32-rounded values; a
    # reference fed the full-precision array differs in the last bit and the comparison
    # fails at 4e-16 for a reason that has nothing to do with the prior. Both sides must see
    # the SAME numbers, so the bridge rounds the way the store does.
    np.savetxt(matrix_path, np.asarray(dense, dtype=np.float32).astype(np.float64),
               delimiter="\t", fmt="%.17g")
    out = work / "reference.json"
    spec = work / "spec.json"
    spec.write_text(json.dumps({
        "matrix": str(matrix_path), "out": str(out), "seed": int(seed), "dbr": float(dbr),
        "dbr_per1k": params["doublet_rate_per_1k"], "nfeatures": params["nfeatures"],
        "dims": params["dims"], "include_pcs": params["include_pcs"],
        "prop_random": params["prop_random"], "prop_markers": params["prop_markers"],
        "score": params["score"],
    }))
    proc = run_in_r_sandbox(f"Rscript {script} {spec}", binds=[work])
    assert proc.returncode == 0, (
        f"the reference run failed\n--- stderr ---\n{proc.stderr[-3000:]}")
    got = json.loads(out.read_text())
    return np.asarray(got["score"], dtype=np.float64), [str(c) for c in got["class"]]


@pytest.fixture(scope="module")
def unbatched(tmp_path_factory):
    """One real UNBATCHED run of the entry, plus its inputs."""
    require_r_env()
    _a, _b, merged, _labels = _two_populations()
    run = ScdblfinderRun(tmp_path_factory.mktemp("parity-unbatched"))
    run.add_matrix(merged)
    # `nfeatures` IS PASSED, AND BELOW THE GENE COUNT, deliberately. The fixture has 180
    # genes and the entry's default is 1352, which `scDblFinder` clamps — so at the default
    # ANY value >= 180 is a no-op and parity could not see that parameter at all (mutating
    # the entry to 200 while the report published 1352 passed). Running in the sensitive
    # range is what makes the "or a parameter does" half of the wiring claim true.
    run.run_ok({"seed": "0", "nfeatures": "80"})
    return run, merged


def test_an_unbatched_run_matches_an_INDEPENDENT_reference_fit(unbatched, tmp_path):
    """TEST-31 — The entry's scores are `scDblFinder`'s scores, at the prior the entry PUBLISHED.

    The reference is told the `expected_doublet_rate` the report claims — not the one the
    entry's source computes, which is the whole point. If the entry fitted with any other
    value, the two vectors differ and this goes red.

    Delete this and the branch has no leg anywhere that can tell an honest report from a
    self-consistent one.
    """
    run, merged = unbatched
    report = run.report()
    record = report["batches"][0]
    assert record["scored"] is True

    ref_score, ref_class = _reference_scores(
        tmp_path, merged, dbr=record["expected_doublet_rate"], seed=report["seed"],
        params=report["parameters"], tag="unbatched")

    got = run.scores()
    assert len(ref_score) == len(got) == merged.shape[0]
    # THE WIRING leg: orientation, parameter plumbing, seed. See sensitivity note 1.
    assert np.allclose(got, ref_score, rtol=0, atol=1e-12), (
        "the entry's scores are NOT what `scDblFinder` produces from the same input at the "
        "same seed. Either the matrix reaches the library differently (orientation, dtype, "
        "ordering) or a parameter does.\n"
        f"max |diff| = {np.max(np.abs(got - ref_score))}")
    # THE PRIOR leg, and the only one that can see it: the class vector is what `dbr`
    # actually moves (sensitivity note 2).
    assert run.calls() == ref_class, (
        f"the entry's CALLS differ from `scDblFinder`'s at the prior the report publishes "
        f"({record['expected_doublet_rate']}) — the recorded prior is not the prior that was "
        f"used. entry doublets={sum(c == 'doublet' for c in run.calls())}, "
        f"reference doublets={sum(c == 'doublet' for c in ref_class)}")


def test_the_reference_is_SENSITIVE_to_the_prior_it_is_given(unbatched, tmp_path):
    """TEST-32 — THE CONTROL, and without it the test above proves nothing.

    If `scDblFinder`'s scores were insensitive to `dbr`, matching the reference would be
    trivially satisfied by any prior at all and the parity test would be decoration. So the
    same reference is run at a deliberately wrong prior and REQUIRED to differ.

    This is the assertion that makes "the published prior is the prior that was used" a real
    claim rather than a coincidence of an insensitive parameter.
    """
    run, merged = unbatched
    report = run.report()
    honest = report["batches"][0]["expected_doublet_rate"]
    wrong = 0.30
    assert wrong != pytest.approx(honest)

    ref_honest_s, ref_honest_c = _reference_scores(
        tmp_path, merged, dbr=honest, seed=report["seed"],
        params=report["parameters"], tag="honest")
    ref_wrong_s, ref_wrong_c = _reference_scores(
        tmp_path, merged, dbr=wrong, seed=report["seed"],
        params=report["parameters"], tag="wrong")

    # BOTH must move, and on THIS fixture both do — the prior reaches the artificial-doublet
    # construction, so it changes the fit and not merely the cut point.
    assert not np.array_equal(ref_honest_s, ref_wrong_s), (
        "`scDblFinder` produced identical SCORES at two expected doublet rates two orders of "
        "magnitude apart. That is what a DOUBLET-FREE fixture looks like (see sensitivity "
        "note 2) — check that `_with_doublets` is still appending real cross-group sums "
        "before trusting anything else in this file.")
    assert ref_honest_c != ref_wrong_c, (
        "`scDblFinder` produced identical CALLS at two expected doublet rates two orders of "
        "magnitude apart, so nothing in this file can distinguish the prior the entry used. "
        "Investigate before trusting any per-sample prior assertion on this branch.")

    # …and in the expected DIRECTION: a larger prior calls more doublets. A control that only
    # asked for "different" would be satisfied by noise.
    n_honest = sum(c == "doublet" for c in ref_honest_c)
    n_wrong = sum(c == "doublet" for c in ref_wrong_c)
    assert n_wrong > n_honest, (
        f"a {wrong / honest:.0f}x larger expected rate did not call more doublets "
        f"({n_honest} -> {n_wrong}); the prior is not doing what the report says it does")


def test_EACH_LEVEL_of_a_batched_run_matches_its_own_INDEPENDENT_reference_fit(tmp_path):
    """TEST-33 — INV-5, finally testable: each sample is fitted with ITS OWN derived prior, and the
    prior the library received is the one the report published — checked per level against a
    reference that never saw the entry's code.

    Two levels of DIFFERENT sizes, so their derived priors cannot coincide and a single
    pooled prior cannot satisfy both. The reference for each level is run on THAT level's
    submatrix, at the rate that level's record claims, at the seed the entry gives that level.

    This is the test the audit's surviving mutation (a flat `dbr = 0.30` for the fit, report
    untouched) fails, and it fails for the right reason: the reference is told the published
    number and the entry used a different one.
    """
    a, b, merged, labels = _two_populations()
    run = ScdblfinderRun(tmp_path / "parity-batched")
    run.add_matrix(merged)
    run.add_column(pd.Categorical(labels), slot="batch", name="sample")
    run.run_ok({"seed": "0", "batch_column": "sample", "nfeatures": "80"})

    report = run.report()
    assert report["batched"] is True and report["n_batches"] == 2
    records = {r["sample"]: r for r in report["batches"]}
    scores = run.scores()
    calls = run.calls()

    # The entry seeds level `i` with `seed + i - 1`, in the order the levels are declared.
    n_a = a.shape[0]
    for index, (level, dense, lo, hi) in enumerate((("S1", a, 0, n_a),
                                                    ("S2", b, n_a, n_a + b.shape[0]))):
        record = records[level]
        assert record["scored"] is True and record["n_cells"] == dense.shape[0]
        ref_score, ref_class = _reference_scores(
            tmp_path, dense, dbr=record["expected_doublet_rate"],
            seed=report["seed"] + index, params=report["parameters"], tag=level)
        assert np.allclose(scores[lo:hi], ref_score, rtol=0, atol=1e-12), (
            f"{level}'s scores are not `scDblFinder`'s output for its own submatrix at its "
            f"own seed — the wiring differs.\nmax |diff| = "
            f"{np.max(np.abs(scores[lo:hi] - ref_score))}")
        # THE PRIOR leg, per level. This is what the audit's surviving mutation fails.
        assert calls[lo:hi] == ref_class, (
            f"{level}'s CALLS are not `scDblFinder`'s output at the prior its own record "
            f"publishes ({record['expected_doublet_rate']}) — the recorded prior is not the "
            f"prior that level was fitted with.")

    # …and the two levels really were given DIFFERENT priors, so the test above is not two
    # copies of one comparison.
    assert (records["S1"]["expected_doublet_rate"]
            != pytest.approx(records["S2"]["expected_doublet_rate"]))
