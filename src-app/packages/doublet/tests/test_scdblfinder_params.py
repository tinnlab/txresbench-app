#!/usr/bin/env python3
# ruff: noqa
"""TEST-P [acceptance] [invariant: INV-5, INV-6] [covers: #195/E7] — THE R ENTRY'S
PARAMETER AND PER-SAMPLE BEHAVIOUR.

The R sibling of `test_doublet_params.py` and `test_per_sample.py`. Same two invariants,
same two failure shapes, one new lane — and the lane is the reason the tests have to be
written again rather than reused: `doublet.scdblfinder` shares no line of code with
`doublet.detect`. Its coercers are `num_param`/`int_param`/`bool_param`/`str_param` in R,
its per-sample loop is its own, and R's own conversions are a fresh set of traps
(`as.numeric("0,008")` is `NA` with a WARNING, not an error; `as.integer(2.9)` truncates
silently; `as.numeric(TRUE)` is `1`).

── The three things a green run can hide, and what each test does about it ─────────────
1. A PARAMETER THAT WENT NOWHERE. `scDblFinder` takes 31 named formals. If the entry
   passes 15 of them and neither passes nor discloses the rest, the exported provenance
   report describes a method nobody can reproduce — and a library upgrade that adds a
   sixteenth knob makes the report silently incomplete with nothing going red.
   `test_every_scdblfinder_formal_is_passed_or_declared_fixed` reads the formals off the
   INSTALLED package inside the image and off the ENTRY's own parse tree, so it is a
   statement about the two things that actually meet at run time.
2. A SUBSTITUTED DEFAULT. `absent()` treats an unreadable value as absent unless something
   refuses it, and the run then records the substituted value as though it had been asked
   for. Every refusal test below asserts the parameter is NAMED, because "it failed" is not
   the property — a reader has to learn which knob they got wrong from inside a sandbox.
3. A SHARED RATE PRIOR / A SHARED NEIGHBOURHOOD. Cells from separately captured libraries
   cannot co-occupy a droplet. The per-sample tests turn "independent" into a measurement:
   each level's prior is checked against ITS OWN arithmetic, and each level's scores are
   checked against a run of that level ALONE.

── Every test here drives the REAL entry ───────────────────────────────────────────────
Through `ScdblfinderRun`, which stages inputs with the SAME python writers the shipped lane
uses and reads outputs back with the SAME python reader, then executes `compute/
scdblfinder.R` inside the `single-cell-r` image under `bwrap`. Nothing is stubbed and
nothing is grepped: a claim about a refusal is a non-zero exit with a message, a claim
about a score is a decoded column.

── HONEST COST ─────────────────────────────────────────────────────────────────────────
One real `scDblFinder` fit on the smallest fixture that still has genuine heterotypic
doublets in it is ~13 s inside the image. The per-sample tests need FOUR fits (a batched
run over two levels, plus each level alone), so the expensive runs are module-scoped and
several tests assert over the same emitted bytes. The refusal tests cost nothing: every
parameter is parsed BEFORE the matrix is read, so a refusal exits before any fit.
"""
import hashlib
import json
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from doublet_fixtures import (SCDBLFINDER, ScdblfinderRun, counts_with_doublets,
                              run_in_r_sandbox)

_COMPUTE = SCDBLFINDER.parent


@pytest.fixture
def scdblfinder_run(tmp_path):
    """A factory for one real `doublet.scdblfinder` run.

    Local to this module rather than in `conftest.py` for the same reason `DetectRun`'s
    fixture is a factory: several tests need TWO or THREE independent runs to compare, and a
    single fixture instance cannot give them separate output roots.
    """
    counter = {"n": 0}

    def make() -> ScdblfinderRun:
        counter["n"] += 1
        return ScdblfinderRun(tmp_path / f"scdbl{counter['n']}")

    return make


def _tree_hash(root: Path) -> str:
    """A digest over every byte under `root`, path-ordered — an artifact's identity."""
    h = hashlib.sha256()
    for p in sorted(Path(root).rglob("*")):
        if p.is_file():
            h.update(str(p.relative_to(root)).encode("utf-8"))
            h.update(b"\x00")
            h.update(p.read_bytes())
    return h.hexdigest()


#: The R side of the formals check. Kept as a module constant (rather than an f-string at
#: the call site) because the script is full of R braces, which an f-string would eat.
_FORMALS_PROBE = """
suppressPackageStartupMessages({library(scDblFinder); library(jsonlite)})
# Sourced, not executed: `scdblfinder.R` guards its own `main()` with `sys.nframe() == 0L`,
# so sourcing gives the bindings without running an analysis. It resolves `_wire.R` against
# `.script_dir()`, which falls back to the working directory when there is no `--file=` —
# hence the caller `cd`s into the compute directory.
source("scdblfinder.R")

passed <- character(0)
walk <- function(e) {
  if (is.call(e)) {
    head <- paste(deparse(e[[1]]), collapse = "")
    if (head %in% c("scDblFinder::scDblFinder", "scDblFinder")) passed <<- c(passed, names(e)[-1])
  }
  if (is.call(e) || is.pairlist(e)) for (x in as.list(e)) if (!missing(x)) walk(x)
}
walk(body(score_population))
stopifnot(length(passed) > 0)

writeLines(toJSON(list(formals = names(formals(scDblFinder)),
                       passed = passed,
                       fixed = names(FIXED_BY_SCDBLFINDER),
                       version = as.character(packageVersion("scDblFinder"))),
                  auto_unbox = FALSE),
           "__OUT__")
"""


# ── INV-6: every wrapper-accepted parameter is passed explicitly, or disclosed ───────
def test_every_scdblfinder_formal_is_passed_explicitly_or_declared_fixed(tmp_path):
    """TEST-17 — DELETE THIS and the disclosure rots the first time the library moves.

    The invariant is not "the call site is long". It is that a reader of the emitted report
    can reproduce the run: a formal this entry passes is in `parameters`, and a formal the
    LIBRARY fixes is in `fixed_by_scDblFinder` described as the library's. A formal in
    NEITHER place is a knob whose value the report does not account for — and the way that
    happens in practice is a version bump adding one, which no hard-coded list can catch.

    So both sides are read LIVE, inside the image, from the things that meet at run time:

      * `names(formals(scDblFinder))` off the INSTALLED package — not a list in this file;
      * the argument names of the `scDblFinder::scDblFinder(...)` call as it appears in
        `body(score_population)` after the SHIPPED entry is sourced — the parse tree, not a
        regex over the text, so a commented-out or string-embedded argument cannot count;
      * `names(FIXED_BY_SCDBLFINDER)` off the sourced entry's own binding.

    `sce` and `...` are exempt: `sce` is the data (passed positionally, so it has no name in
    the call) and `...` is not a knob.
    """
    probe = tmp_path / "formals_probe.R"
    out = tmp_path / "formals.json"
    probe.write_text(_FORMALS_PROBE.replace("__OUT__", str(out)))

    proc = run_in_r_sandbox(f"cd {_COMPUTE} && Rscript --vanilla -e 'source(\"{probe}\")'",
                            binds=[str(tmp_path), str(_COMPUTE)])
    assert proc.returncode == 0, (
        f"the formals probe exited {proc.returncode}\n--- stdout ---\n{proc.stdout}\n"
        f"--- stderr ---\n{proc.stderr}")
    got = json.loads((tmp_path / "formals.json").read_text())

    formals = list(got["formals"])
    # A live read, so this is also the guard against the probe silently reading nothing.
    assert len(formals) > 20, formals
    assert "sce" in formals and "..." in formals

    passed = {name for name in got["passed"] if name}     # "" is the positional `sce`
    fixed = set(got["fixed"])
    exempt = {"sce", "..."}

    unaccounted = [f for f in formals if f not in passed and f not in fixed and f not in exempt]
    assert unaccounted == [], (
        f"scDblFinder {got['version']} accepts {unaccounted}, which `scdblfinder.R` neither "
        "passes explicitly nor names in FIXED_BY_SCDBLFINDER. Every wrapper-accepted "
        "parameter must be one or the other: what the entry controls is recorded in the "
        "report's `parameters`, and what the library fixes internally is disclosed as the "
        "library's. A formal in neither is a knob the exported provenance does not account "
        "for.")

    # …and the other direction, because a disclosure block that named a formal the library
    # DROPPED would be a report describing a knob that no longer exists.
    stale = sorted((passed | fixed) - set(formals))
    assert stale == [], (
        f"`scdblfinder.R` names {stale}, which scDblFinder {got['version']} no longer "
        "accepts; the report would describe a parameter the library dropped")


# ── a refusal is NAMED, never a substituted default ─────────────────────────────────
#
# Each case is a value the R coercers could plausibly wave through. `as.numeric("0,008")`
# is `NA` with a warning (not an error), `as.integer(2.9)` truncates to 2, `TRUE` numifies
# to 1, and a bound that is only checked after narrowing turns an out-of-range value into
# `NA` — the #194 lesson the entry's `int_param` comment names.
#
# A MATRIX IS STAGED for every one of these. Without it a refusal test passes on
# "no `matrix` input was staged", which is a different non-zero exit and would keep passing
# after the parameter check was deleted.
_REFUSALS = [
    # (params, the token the message must name, why this value is a trap)
    ({"doublet_rate_per_1k": "0,008"}, "doublet_rate_per_1k"),   # European decimal comma
    ({"doublet_rate_per_1k": "abc"}, "doublet_rate_per_1k"),
    ({"doublet_rate_per_1k": 0}, "doublet_rate_per_1k"),         # below the 1e-6 floor
    ({"doublet_rate_per_1k": 5}, "doublet_rate_per_1k"),         # above the 1.0 ceiling
    ({"expected_doublet_rate": 0}, "expected_doublet_rate"),     # a rate of 0 is not a rate
    ({"expected_doublet_rate": 1}, "expected_doublet_rate"),     # nor is a rate of 1
    ({"expected_doublet_rate": "8%"}, "expected_doublet_rate"),
    ({"doublet_rate_sd": 2}, "doublet_rate_sd"),
    ({"nfeatures": 2.5}, "nfeatures"),                           # fractional where integer
    ({"nfeatures": 1}, "nfeatures"),                             # below the 2 floor
    ({"dims": 1.5}, "dims"),
    ({"dims": 0}, "dims"),
    ({"include_pcs": -1}, "include_pcs"),
    ({"include_pcs": 3.5}, "include_pcs"),
    ({"prop_random": 1.5}, "prop_random"),
    ({"prop_markers": -0.5}, "prop_markers"),
    ({"score": "forest"}, "score"),                              # outside the allowed set
    ({"seed": "abc"}, "seed"),
    ({"seed": 1e18}, "seed"),                                    # outside R's integer range
    ({"label": "../escape"}, "label"),                           # would write outside /outputs
    ({"label": "with space"}, "label"),
]


@pytest.mark.parametrize("params,token", _REFUSALS, ids=[
    f"{list(p)[0]}={list(p.values())[0]!r}" for p, _t in _REFUSALS])
def test_an_out_of_range_or_unreadable_parameter_is_a_named_refusal(scdblfinder_run,
                                                                    params, token):
    """TEST-18 — DELETE ANY OF THESE and the value silently becomes the default, the run succeeds, and
    the provenance report records the DEFAULT as though the user had chosen it — which is
    worse than a crash, because the exported methods document then asserts a method nobody
    ran.

    Three bindings are asserted, not one: a non-zero exit, the PARAMETER NAME in the
    diagnostic (so an unrelated failure elsewhere cannot satisfy the test), and NO
    `manifest.json` — a refusal that had already written half its outputs would leave the
    host ingesting artifacts from a run that then failed.
    """
    run = scdblfinder_run()
    run.add_matrix(counts_with_doublets(n_per_group=14, n_genes=90, n_doublets=8, seed=1)[0])
    proc = run.run(params)

    assert proc.returncode != 0, (
        f"{params} was accepted; the run would have substituted a default and then recorded "
        f"the substituted value in `parameters`.\n{proc.stderr[-1500:]}")
    diag = run.diagnostics(proc)
    assert f"`{token}`" in diag, (
        f"the refusal does not name `{token}`, so a reader inside a sandbox cannot tell "
        f"which parameter they got wrong:\n{proc.stderr[-1500:]}")
    assert not (run.outputs_dir / "manifest.json").exists()


def test_the_criteria_recipe_is_refused_by_name_rather_than_silently_ignored(scdblfinder_run):
    """TEST-19 — DELETE THIS and the single worst outcome in this package becomes reachable: a user
    (or an agent) passes `cell-filter`'s `criteria` recipe, the R entry has no predicate
    kernel to run it with, and the run succeeds having scored EVERY cell — including the
    ones the recipe was supposed to exclude — while the report says nothing about it. The
    filter is described in the request and never happened.

    `doublet.detect` accepts the same key because it vendors the python kernel. The R lane
    cannot, and the whole design of this refusal is that the gap is LOUD: the message must
    name `criteria` AND name the two levers that do work, or a user has a dead end instead
    of a route.
    """
    run = scdblfinder_run()
    run.add_matrix(counts_with_doublets(n_per_group=14, n_genes=90, n_doublets=8, seed=1)[0])
    run.add_column([1.0] * 50, slot="column:qc", name="qc")
    proc = run.run({"criteria": [{"column": "qc", "min": "0.5"}]})

    assert proc.returncode != 0, (
        "the `criteria` recipe was accepted; every cell was scored and the report describes "
        "a pre-filter that never ran")
    diag = run.diagnostics(proc)
    assert "`criteria`" in diag, diag
    # the levers, so the refusal is a route rather than a dead end
    assert "cell.filter" in diag, diag
    assert "doublet.detect" in diag, diag
    assert not (run.outputs_dir / "manifest.json").exists()


def test_a_run_with_no_extra_parameters_succeeds(scdblfinder_run):
    """TEST-20 — The NEGATIVE CONTROL for the whole refusal table above.

    DELETE THIS and every refusal test could be passing because the entry refuses
    everything — a compute that exited non-zero unconditionally would satisfy 22 tests and
    fail this one. It also pins that the fixture those tests stage is itself acceptable, so
    a refusal there is attributable to the parameter and to nothing else.
    """
    run = scdblfinder_run()
    run.add_matrix(counts_with_doublets(n_per_group=14, n_genes=90, n_doublets=8, seed=1)[0])
    run.run_ok({})
    assert (run.outputs_dir / "manifest.json").is_file()
    assert run.report()["method"] == "scdblfinder"


# ── INV-5: per-sample independence, measured ────────────────────────────────────────
#
# Two levels of DELIBERATELY UNEQUAL size, so a per-level prior cannot coincide with a
# pooled one by accident, and INTERLEAVED in a shuffled order, so a reassembly that wrote
# each level's results back in scoring order rather than in input position would show up.
_N_A, _N_B = 50, 76


def _two_populations():
    """`(a, b, merged, labels)` — two genuinely different populations, shuffled together.

    Both carry real heterotypic doublets (`counts_with_doublets`), because a fixture whose
    call column is all-`singlet` makes every assertion about calls vacuous. Within each
    level the row ORDER is preserved by construction, which is what lets a standalone run
    over `a` be compared position-by-position with the batched run's `S1` rows.
    """
    a, _ = counts_with_doublets(n_per_group=14, n_genes=90, n_doublets=8, seed=1)
    b, _ = counts_with_doublets(n_per_group=22, n_genes=90, n_doublets=10, seed=2)
    assert (a.shape[0], b.shape[0]) == (_N_A, _N_B)
    which = np.array([0] * _N_A + [1] * _N_B)
    np.random.default_rng(5).shuffle(which)
    rows, ia, ib = [], 0, 0
    for w in which:
        if w == 0:
            rows.append(a[ia]); ia += 1
        else:
            rows.append(b[ib]); ib += 1
    merged = np.asarray(rows, dtype=a.dtype)
    labels = ["S1" if w == 0 else "S2" for w in which]
    return a, b, merged, labels, which


@pytest.fixture(scope="module")
def batched(tmp_path_factory):
    """ONE batched run plus each level scored ALONE — four real `scDblFinder` fits.

    Module-scoped because the fits are the expensive part and every test below is an
    assertion about the SAME emitted bytes. The input store is hashed immediately before and
    immediately after the run, inside the fixture, because "unchanged" is a claim about the
    bytes AT THE MOMENT the compute had them; a hash taken in a later test would only prove
    nothing touched them afterwards.

    THE SEEDS ARE NOT BOTH ZERO, and that is the interesting detail. The entry seeds level
    `i` through `level_seed(seed, i)`, which is `seed + i - 1` everywhere below the top of
    R's integer range (it wraps only a value that would overflow), so a level's standalone
    counterpart has to be run with the seed that level got inside the batch (S1 -> 0,
    S2 -> 1). Running both alone at seed 0 would
    compare two different fits and the test would fail for a reason that is not the
    invariant.
    """
    a, b, merged, labels, which = _two_populations()

    run = ScdblfinderRun(tmp_path_factory.mktemp("scdbl_batched"))
    matrix_dir = run.add_matrix(merged)
    run.add_column(pd.Categorical(labels), slot="batch", name="sample")
    before = _tree_hash(matrix_dir)
    proc = run.run({"seed": 0, "batch_column": "sample"})
    after = _tree_hash(matrix_dir)
    assert proc.returncode == 0, (
        f"the batched run exited {proc.returncode}\n--- stderr ---\n{proc.stderr[-3000:]}")

    alone = {}
    for level, dense, seed in (("S1", a, 0), ("S2", b, 1)):
        solo = ScdblfinderRun(tmp_path_factory.mktemp(f"scdbl_{level}"))
        solo.add_matrix(dense)
        solo.run_ok({"seed": seed})
        alone[level] = solo

    return {"run": run, "alone": alone, "which": which, "labels": labels,
            "matrix_dir": matrix_dir, "hash_before": before, "hash_after": after,
            "n_cells": merged.shape[0]}


def test_each_level_carries_its_own_derived_rate_prior(batched):
    """TEST-21 — DELETE THIS and the per-sample loop can derive ONE prior from the merged total while
    still looking per-sample in the report. That is the wrong number in the direction that
    matters: the expected rate scales with cells loaded per lane, so a merged 5x10k matrix
    auto-derives ~40% where the per-lane truth is ~7.6%, and every score is fit against it.

    The arithmetic is re-derived here (`n_cells * doublet_rate_per_1k / 1000`) rather than
    copied from the report, and the two levels are of DIFFERENT sizes so the two values
    cannot coincide — with equal levels a single pooled prior would satisfy every assertion
    below except the merged-total one.
    """
    report = batched["run"].report()
    assert report["batched"] is True
    assert report["batch_column"] == "sample"
    assert report["n_batches"] == 2

    records = {r["sample"]: r for r in report["batches"]}
    assert set(records) == {"S1", "S2"}
    per_1k = report["parameters"]["doublet_rate_per_1k"]
    assert per_1k == 0.008          # the 10x Chromium default, unset by this run

    for level, n in (("S1", _N_A), ("S2", _N_B)):
        record = records[level]
        assert record["scored"] is True
        assert record["n_cells"] == n
        assert record["rate_source"] == "derived", (
            f"{level} did not derive its own rate; `rate_source` says {record['rate_source']!r}")
        assert record["expected_doublet_rate"] == pytest.approx(n * per_1k / 1000.0), (
            f"{level}'s prior is not derived from its own {n} cells")

    # THE POINT: neither is the value the MERGED total would give, and the two differ from
    # each other — which one pooled prior could not do.
    merged_value = (_N_A + _N_B) * per_1k / 1000.0
    assert records["S1"]["expected_doublet_rate"] != pytest.approx(merged_value)
    assert records["S2"]["expected_doublet_rate"] != pytest.approx(merged_value)
    assert (records["S1"]["expected_doublet_rate"]
            != pytest.approx(records["S2"]["expected_doublet_rate"]))


def test_a_level_scores_the_same_alone_as_it_does_inside_the_batch(batched):
    """TEST-22 — THE LEG THAT MAKES "INDEPENDENT" MEAN SOMETHING.

    DELETE THIS and every other per-sample assertion is satisfied by an implementation that
    reports per-level metadata while fitting ONE model over the merged matrix: the records
    would still carry their own `n_cells` and their own derived rate, and nothing would
    reveal that the artificial doublets crossed a sample boundary — summing a cell from S1
    with a cell from S2 invents a profile no droplet could produce, and every real cell is
    then scored by its density among that fiction.

    EXACT equality, not `allclose`: a batch that borrowed even one neighbour from the other
    sample moves the score in the last bits, which is precisely what `allclose` forgives.
    The comparison is done at the cells' INPUT POSITIONS, which the shuffled interleave
    makes a real constraint.
    """
    run, alone, which = batched["run"], batched["alone"], batched["which"]
    scores = run.scores()
    calls = run.calls()

    for level, code in (("S1", 0), ("S2", 1)):
        mask = which == code
        want = alone[level].scores()
        assert want.shape == (int(mask.sum()),)
        assert np.array_equal(scores[mask], want), (
            f"{level}'s scores inside the batch differ from {level} scored alone; "
            f"max|d| = {float(np.nanmax(np.abs(scores[mask] - want))):.3e}. Information "
            "crossed a batch boundary.")
        # the CALLS follow, so the invariant reaches the artifact a user actually filters on
        assert [c for c, m in zip(calls, mask) if m] == alone[level].calls()
        # …and the threshold recorded for the level is that level's own standalone one.
        record = {r["sample"]: r for r in run.report()["batches"]}[level]
        assert record["threshold"] == alone[level].report()["batches"][0]["threshold"]

    # The fixture is not vacuous: both call levels are actually present, so "the calls
    # follow" is a statement about a column with two values in it and not about a constant.
    assert set(calls) == {"singlet", "doublet"}, sorted(set(calls))


def test_the_score_column_is_full_length_over_the_input_cells_in_input_order(batched):
    """TEST-23 — INV-5, FLAG NEVER DELETE.

    DELETE THIS and the entry may emit a column over the SCORED cells rather than over the
    input cells — which reads back cleanly, aligns to nothing, and silently mislabels every
    cell downstream of the first skipped one. `cell.filter` is what removes cells; this
    analysis annotates.

    Three separate claims, because a column can be full-length and still wrong:
      * LENGTH — one value per input cell, in both columns;
      * ORDER — each level's values sit at that level's INPUT positions (the shuffled
        interleave is what makes this falsifiable; with blocked labels a reassembly in
        scoring order is indistinguishable from one in input order);
      * NO SUBSET MATRIX — the run emits two metadata columns and a report, and nothing
        that is or contains an expression matrix.
    """
    run, n_cells, which = batched["run"], batched["n_cells"], batched["which"]
    report = run.report()
    assert report["n_cells"] == n_cells == len(which)
    assert report["n_evaluated"] == n_cells and report["n_not_evaluated"] == 0

    scores = run.scores()
    calls = run.calls()
    assert scores.shape == (n_cells,)
    assert len(calls) == n_cells
    assert not np.isnan(scores).any(), "a scored run left NaNs in the score column"

    # ORDER: the first S1 cell in input order is the first cell of the standalone S1 run.
    first_s1 = int(np.flatnonzero(which == 0)[0])
    first_s2 = int(np.flatnonzero(which == 1)[0])
    assert scores[first_s1] == batched["alone"]["S1"].scores()[0]
    assert scores[first_s2] == batched["alone"]["S2"].scores()[0]

    # NO SUBSET MATRIX, and every declared column spans the whole input axis.
    entries = run.entries()
    assert sorted(e["datatype"] for e in entries) == [
        "metadata-column", "metadata-column", "report/qc"]
    for entry in entries:
        assert not entry["datatype"].startswith("single-cell"), entry
        if entry["datatype"] == "metadata-column":
            assert entry["structure"]["n"] == n_cells, entry["id"]
            assert entry["meta"]["n"] == n_cells, entry["id"]
            assert entry["structure"]["axis"] == "cells"


def test_the_input_matrix_is_not_modified_by_the_run(batched):
    """TEST-24 — DELETE THIS and the compute may write into its own input mount — which on the real
    platform is a staged artifact SHARED with every other job that binds it, so a mutation
    here corrupts a dataset for runs that have nothing to do with doublets.

    The hash is taken over every byte of the staged CSC store immediately before and
    immediately after the run (inside the fixture, because "unchanged" is a claim about the
    bytes at the moment the compute held them). It covers `zarr.json`, the shard files and
    the member nodes, so a rewritten chunk, a re-stamped declaration and a stray temp file
    are all failures.
    """
    assert batched["hash_after"] == batched["hash_before"], (
        f"the input matrix store at {batched['matrix_dir']} changed during the run")
    # …and the run really did read it, so the hash is not a statement about an unused mount.
    assert batched["run"].report()["n_genes"] == 90


# ── a level too small to score is a NAMED refusal, not a silent NaN ─────────────────
def test_a_level_below_the_minimum_is_a_named_refusal_and_the_others_still_run(
        scdblfinder_run):
    """TEST-25 — DELETE THIS and a tiny level becomes whatever `scDblFinder` does with 12 cells — a
    crash that takes the whole run down, or a fabricated score fit from an
    artificial-doublet population that could not be built. Both are worse than the honest
    answer, and the honest answer has to be VISIBLE: a NaN with no record beside it is
    indistinguishable from a bug.

    Four claims, and the fourth is the one that makes this a refusal rather than a failure:
      * the small level's record says `scored: false` and carries a `refusal` STRING;
      * that string names the level's size and the minimum, so a reader knows the lever;
      * its cells carry NaN scores and the third call level `not_evaluated` — which is
        DECLARED only because this run produced one;
      * the OTHER level is scored and the run exits 0. A refusal that took the whole run
        down would make one unusable sample cost the user every sample.
    """
    a, _ = counts_with_doublets(n_per_group=14, n_genes=90, n_doublets=8, seed=1)
    tiny_n = 12                                   # far below MIN_CELLS_PER_BATCH (30)
    labels = ["S1"] * (a.shape[0] - tiny_n) + ["tiny"] * tiny_n

    run = scdblfinder_run()
    run.add_matrix(a)
    run.add_column(pd.Categorical(labels), slot="batch", name="sample")
    run.run_ok({"seed": 0, "batch_column": "sample"})

    records = {r["sample"]: r for r in run.report()["batches"]}
    assert set(records) == {"S1", "tiny"}

    tiny = records["tiny"]
    assert tiny["scored"] is False
    assert tiny["n_cells"] == tiny_n
    assert isinstance(tiny.get("refusal"), str) and tiny["refusal"], tiny
    assert str(tiny_n) in tiny["refusal"], tiny["refusal"]
    assert "30" in tiny["refusal"], tiny["refusal"]
    assert "not_evaluated" in tiny["refusal"], tiny["refusal"]
    # …and it carries NO fabricated numbers: a refused level has no rate and no threshold.
    assert "expected_doublet_rate" not in tiny, tiny
    assert "threshold" not in tiny, tiny

    assert records["S1"]["scored"] is True, "one unusable level cost the other its scores"

    scores = run.scores()
    calls = run.calls()
    assert scores.shape == (a.shape[0],) and len(calls) == a.shape[0]
    tail = slice(a.shape[0] - tiny_n, a.shape[0])
    assert np.isnan(scores[tail]).all(), (
        "the refused level's cells were given scores anyway")
    assert calls[tail] == ["not_evaluated"] * tiny_n
    assert not np.isnan(scores[: a.shape[0] - tiny_n]).any()

    report = run.report()
    assert report["n_not_evaluated"] == tiny_n
    assert report["n_evaluated"] == a.shape[0] - tiny_n
    # The third level is declared BECAUSE this run produced one — never speculatively.
    assert report["call_levels"] == ["singlet", "doublet", "not_evaluated"]
    entry = run.entry("doublet_call")
    assert entry["structure"]["columns"][0]["n_levels"] == 3


def test_the_TOP_of_the_seed_range_is_accepted_and_scores_every_level():
    """TEST-68 — the boundary `level_seed()` exists for, driven end to end.

    `int_param` accepts `seed = .Machine$integer.max`, and the per-level offset pushes level
    2 past it. THREE successive attempts to handle that were wrong, and the first two both
    SHIPPED, because nothing here exercised the branch:

      * the first folded every seed through a modulus, so `seed = 0` became -1073741823 and
        every published number moved (caught by the ground-truth suite, not by this file);
      * the second wrapped by 2^32, landing on `-2147483648` — which R reserves as
        `NA_integer_` — so `set.seed(NA)` aborted the run from OUTSIDE the `tryCatch`, at
        exactly the boundary the wrap was written for, and the function's own comment
        asserted that case was handled.

    A branch with no test is how a fix for a bug introduces a bug at the same address, twice.
    This drives the real entry at the top of the accepted range with TWO levels, so the
    offset is actually used, and requires every level to be SCORED — not merely that the
    process exits 0, which the first of those two defects would have satisfied.
    """
    a, b, merged, labels, _which = _two_populations()
    run = ScdblfinderRun(Path(tempfile.mkdtemp(prefix="scdbl-seedmax-")))
    run.add_matrix(merged)
    run.add_column(pd.Categorical(labels), slot="batch", name="sample")
    proc = run.run({"seed": 2147483647, "batch_column": "sample"})

    assert proc.returncode == 0, (
        "the top of the accepted seed range aborted the run\n--- stderr ---\n"
        + proc.stderr[-2000:])
    report = run.report()
    assert report["seed"] == 2147483647
    assert report["n_batches"] == 2
    for record in report["batches"]:
        assert record["scored"] is True, record
    assert np.isfinite(run.scores()).all()

    # …AND the seed each level actually received, which is the only thing that can see what
    # `level_seed` did. Level 1 is the requested seed unchanged; level 2 must WRAP — to a
    # value R can hold, which `-2147483648` is not.
    seeds = [r["seed"] for r in report["batches"]]
    assert seeds[0] == 2147483647, seeds
    assert seeds[1] == -2147483647, seeds
    assert len(set(seeds)) == len(seeds), (
        f"two levels shared a seed ({seeds}); they would fit the same artificial-doublet "
        f"population and stop being independent")


def test_the_BOTTOM_of_the_seed_range_is_accepted_too():
    """TEST-69 — the other end, which the wrap must not touch at all.

    `-.Machine$integer.max` is the smallest accepted seed; adding the per-level offset moves
    it AWAY from the boundary, so `level_seed` must be the identity here. Asserted because a
    guard written for one end of a range is exactly the kind of thing that gets applied to
    both ends by a later reader.
    """
    a, b, merged, labels, _which = _two_populations()
    run = ScdblfinderRun(Path(tempfile.mkdtemp(prefix="scdbl-seedmin-")))
    run.add_matrix(merged)
    run.add_column(pd.Categorical(labels), slot="batch", name="sample")
    proc = run.run({"seed": -2147483647, "batch_column": "sample"})
    assert proc.returncode == 0, proc.stderr[-2000:]
    report = run.report()
    assert report["seed"] == -2147483647
    assert all(r["scored"] for r in report["batches"])

    # THE IDENTITY, ASSERTED. This is what the docstring above claims and what the first
    # version of this test did not check: it observed only that the run exited 0, so the
    # ORIGINAL defect — a modulus fold that silently reseeded every run — passed it.
    seeds = [r["seed"] for r in report["batches"]]
    assert seeds == [-2147483647, -2147483646], seeds
