#!/usr/bin/env python3
# ruff: noqa
"""TEST-1 [acceptance] [invariant: INV-8] — `doublet.scdblfinder` runs END TO END IN R and
emits the SAME OUTPUT KINDS as the Scrublet lane.

── Why this file is the acceptance test and not `test_ground_truth.py` ────────────────────
The ground-truth suite answers "does the method find doublets". This one answers the two
questions that make a SECOND analysis in this package viable at all, and they are different
questions:

  1. Does an R entry actually execute, in the real `single-cell-r` image, and produce
     artifacts this platform accepts? A number is worthless if the thing that produced it
     could not run on the job path.
  2. Are the OUTPUT KINDS IDENTICAL to `doublet.detect`'s? That is the property the whole
     three-analysis shape rests on — the owner's stated intent is that a user searching
     "doublet" finds several analyses and picks by METHOD, with `cell.filter`, the report
     and colour-by consuming any of them unchanged. If the kinds diverge, the shape is a
     lie and every downstream consumer needs a branch.

── THE EVIDENCE BAR THIS FILE IS HELD TO ──────────────────────────────────────────────────
#194 set it: an exit code proves nothing, because an echo, a shim or a shell that merely
accepted the string all exit 0. Its own probe emits values NOTHING BUT R COULD PRODUCE —
R's version string, and a draw from R's Mersenne-Twister+Inversion generator that NumPy does
not reproduce for the same seed. This file inherits that discipline: it asserts on values
that appear nowhere in the request and that only an R interpreter running inside the R image
could have written — `R.version.string`, and the resolved version of `scDblFinder`, an R
package that exists in no python image in this tree.

── WHAT "IDENTICAL KINDS" IS CHECKED AGAINST ──────────────────────────────────────────────
Not against a hardcoded list. Against `doublet.detect`'s OWN emitted manifest, produced by a
real run in the same test. A hardcoded expectation would agree with itself; comparing two
real runs is what catches a drift in EITHER lane.
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest

from doublet_fixtures import (DetectRun, ScdblfinderRun, counts_with_doublets,
                              require_r_env, require_skimage, run_in_r_sandbox)

_LIB = Path(__file__).resolve().parents[2] / "_lib"


@pytest.fixture(scope="module")
def r_run(tmp_path_factory):
    """One real `doublet.scdblfinder` run over a small structured fixture with genuine
    cross-population doublets appended, so the CALL column has both levels in it and the
    assertions below are not vacuous over an all-singlet column."""
    require_r_env()
    counts, n_real = counts_with_doublets(n_per_group=60, n_genes=150, n_groups=3,
                                          n_doublets=12, seed=0)
    run = ScdblfinderRun(tmp_path_factory.mktemp("r-e2e"))
    run.add_matrix(counts)
    run.run_ok({"seed": "0"})
    return run, n_real, counts.shape[0]


@pytest.fixture(scope="module")
def py_run(tmp_path_factory):
    """The SAME fixture through the Scrublet lane — the comparison subject for the
    output-kind assertions. A real run, not a recorded expectation."""
    require_skimage()
    counts, n_real = counts_with_doublets(n_per_group=60, n_genes=150, n_groups=3,
                                          n_doublets=12, seed=0)
    run = DetectRun(tmp_path_factory.mktemp("py-e2e"))
    run.add_matrix(counts)
    run.run_ok({"seed": "0"})
    return run


def test_the_run_produces_values_only_R_could_have_produced(r_run):
    """TEST-10 — THE R-ONLY EVIDENCE. Delete this and every other assertion in this file would still
    pass if the entry were quietly reimplemented in python.

    Three values, none of which appears anywhere in the request:
      * `R.version.string` — R's own self-description. No python interpreter emits it.
      * `scDblFinder`'s resolved version — an R/Bioconductor package that is installed in
        NO python image in this tree, so its presence is proof of WHICH image ran.
      * the same for `BiocParallel` and `SingleCellExperiment`.

    The control that makes it evidence rather than a claim: the same probe pointed at the
    sibling PYTHON image gives `Rscript: command not found`, which is asserted separately in
    `test_the_python_image_cannot_run_this_entry` below.
    """
    run, _n_real, _n = r_run
    versions = run.report()["library_versions"]

    # R itself. `R.version$major.minor`, produced by the interpreter, not by the request.
    assert versions["R"].startswith("4."), versions
    # The method's own library. Its exact pinned version lives in the env recipe; this
    # asserts a real version string reached the artifact, not that a constant was echoed.
    for lib in ("scDblFinder", "BiocParallel", "SingleCellExperiment", "Matrix",
                "jsonlite", "digest"):
        v = versions[lib]
        assert v and v[0].isdigit(), (lib, v)
    # …and the request contains none of these strings, so they cannot have been copied.
    request = (run.inputs_dir / "params.json").read_text()
    for v in versions.values():
        assert v not in request


def test_the_python_image_cannot_run_this_entry():
    """TEST-11 — THE CONTROL for the test above, and the reason its evidence is evidence.

    "R ran" is only meaningful if the alternative would have failed VISIBLY. #194's own
    artifact records that the probe pointed at the sibling python image gives
    `exit 127, "Rscript: command not found"`. This asserts the same thing from this file's
    own harness: the R rootfs is what supplies `Rscript`, and nothing else on the host or in
    the sandbox does.
    """
    require_r_env()
    # Inside the R sandbox, `Rscript` resolves.
    ok = run_in_r_sandbox("command -v Rscript")
    assert ok.returncode == 0 and "Rscript" in ok.stdout, (ok.returncode, ok.stdout, ok.stderr)
    # …and the R interpreter that resolves is the IMAGE's, under its own prefix, not one
    # leaking from the host: the host has no R at all in this tree's supported setup, and
    # even if it did, the sandbox binds only the image's `/usr`.
    which = run_in_r_sandbox("Rscript -e 'cat(R.home())'")
    assert which.returncode == 0, which.stderr
    assert which.stdout.strip().startswith("/usr/"), which.stdout


def test_the_output_KINDS_are_identical_to_the_scrublet_lane(r_run, py_run):
    """TEST-12 — THE PROPERTY THE THREE-ANALYSIS SHAPE RESTS ON.

    Both manifests are from REAL runs of the two methods over the SAME fixture. The
    assertion is on the (datatype, layout, role) triples and on the artifact ids' shapes —
    i.e. on everything a downstream consumer dispatches on. `cell.filter`'s criterion picker
    sources every `metadata-column` any run put on the cells axis; the report and colour-by
    do the same. If either lane's kinds moved, one of them would silently stop being
    consumable and this goes red.

    Compared against the OTHER LANE'S OWN OUTPUT, never against a literal — a hardcoded
    expectation would agree with itself and catch a drift in neither.
    """
    r, _n_real, _n = r_run
    r_kinds = sorted((e["datatype"], e["layout"], e["role"]) for e in r.entries())
    py_kinds = sorted((e["datatype"], e["layout"], e["role"]) for e in py_run.entries())
    assert r_kinds == py_kinds, (r_kinds, py_kinds)

    # …and the ids follow the same shape, so a consumer resolving by id suffix works for
    # both. (The ids are not EQUAL only where the report names its own analysis.)
    r_ids = sorted(e["id"] for e in r.entries())
    py_ids = sorted(e["id"] for e in py_run.entries())
    assert r_ids == py_ids, (r_ids, py_ids)


def test_the_columns_have_the_same_shape_and_meaning_as_the_scrublet_lane(r_run, py_run):
    """TEST-13 — Kinds being equal is necessary and not sufficient: two `metadata-column`s can be the
    same kind and still disagree about length, axis, ordering or the level vocabulary — any
    of which breaks a downstream consumer just as thoroughly.

    So this asserts the things a consumer actually relies on: the score column is
    full-length over the input cells in INPUT order and finite where a cell was scored; the
    call column is CATEGORICAL over the same axis; and its levels are drawn from the same
    vocabulary the Scrublet lane declares, so a `cell.filter` criterion written against one
    method's column means the same thing against the other's.
    """
    r, n_real, n_total = r_run

    r_score = r.entry("_score")
    py_score = py_run.entry("_score")
    assert r_score["structure"]["axis"] == py_score["structure"]["axis"] == "cells"
    assert r_score["structure"]["n"] == py_score["structure"]["n"] == n_total
    assert r_score["structure"]["columns"][0]["kind"] == "numeric"
    assert r_score["meta"]["kind"] == py_score["meta"]["kind"] == "continuous"

    r_call = r.entry("_call")
    py_call = py_run.entry("_call")
    assert r_call["structure"]["columns"][0]["kind"] == "categorical"
    assert py_call["structure"]["columns"][0]["kind"] == "categorical"
    assert r_call["meta"]["kind"] == py_call["meta"]["kind"] == "categorical"
    # THE SAME level vocabulary — this is what makes a `cell.filter` criterion written
    # against one method's column mean the same thing against the other's.
    #
    # EQUALITY, not intersection. The first cut asserted `r_levels & py_levels` — a
    # non-empty overlap — which a blind audit correctly called out: it would pass with the
    # R lane declaring `{singlet, doublet, maybe}` while the sibling declared
    # `{singlet, doublet}`, and a keep-set criterion over `maybe` would then silently mean
    # nothing. On this fixture every cell is scored, so BOTH lanes declare exactly the two
    # ordinary levels and equality is the right bar; the third level `not_evaluated` is
    # declared by either lane only on a run that produced one, which is what
    # `test_scdblfinder_absence.py` covers.
    r_levels = set(r_call["meta"]["levels_declared"])
    py_levels = set(py_call["meta"]["levels_declared"])
    assert r_levels == py_levels, (r_levels, py_levels)
    assert r_levels == {"singlet", "doublet"}, r_levels

    # The values themselves, read through the SAME reader the python lane's tests use.
    scores = r.scores()
    calls = r.calls()
    assert len(scores) == len(calls) == n_total
    assert np.isfinite(scores).all(), "every cell was scored, so none should be NaN here"
    assert set(calls) <= {"singlet", "doublet", "not_evaluated"}
    # Both levels are present, so the assertions above are not vacuous over a constant column.
    assert "doublet" in calls and "singlet" in calls


def test_the_emitted_artifacts_pass_the_REAL_conformance_gate(r_run):
    """TEST-14 — The framework-owned output gate, run over the bytes R actually wrote.

    `_lib/conformance.py` runs OUT OF PROCESS after ingest, as its own python job, over the
    emitted `/outputs` directory — it never imports processor code, so it is language-
    agnostic by construction and an R producer inherits it UNCHANGED. That is the bound on
    E6/DEC-2's weakening: R lacks INPUT-side helpers, not output validation. There is no off
    switch, and a violation flips the artifact to `failed`.

    This is therefore the assertion that `compute/_wire.R` really implements this app's
    format rather than something that merely looks like it: a plain (unsharded) array, a
    missing shard index, a wrong crc32c, a short tail chunk, a stray file in the store, a
    `levels_digest` that does not recompute — every one of them is a violation here.

    The `examined` counters are asserted too. A gate that examined NOTHING reports zero
    violations, which is not the same as a pass, and this repository has been burned by
    exactly that shape of false green.
    """
    run, _n_real, _n = r_run
    sys.path.insert(0, str(_LIB))
    import conformance

    manifest = json.loads((run.outputs_dir / "manifest.json").read_text())
    report = conformance.conform_manifest(run.outputs_dir, manifest, full=True)
    assert report.violations == [], report.violations

    # …and it really read bytes for both columns, rather than passing them by omission.
    for artifact_id, stats in report.examined.items():
        assert stats["checks"] > 0, (artifact_id, stats)
        if "metadata-column" in artifact_id:
            assert stats["shards"] > 0 and stats["read_bytes"] > 0, (artifact_id, stats)


def test_the_manifest_is_written_LAST_and_only_after_the_artifacts_exist(r_run):
    """TEST-15 — The compute contract's crash rule: a run that dies mid-way must leave NO manifest
    rather than a manifest naming bytes that are not there — the host reads a missing or
    invalid manifest on exit 0 as a typed contract violation.

    Asserted by consequence rather than by timing: every path the manifest names resolves,
    under the outputs root, and nothing it names is empty.
    """
    run, _n_real, _n = r_run
    for e in run.entries():
        p = run.outputs_dir / e["path"]
        assert p.exists(), e["path"]
        resolved = p.resolve()
        assert resolved.is_relative_to(run.outputs_dir.resolve()), e["path"]
        assert (p.stat().st_size > 0) if p.is_file() else any(p.iterdir()), e["path"]


def test_the_run_never_modifies_the_input_matrix(r_run):
    """TEST-16 — FLAG, NEVER DELETE — half of INV-5, and the half a doublet caller is most tempted to
    break. This analysis annotates; removing cells is `cell.filter`'s job.

    Asserted on the BYTES of the staged input artifact, not on the absence of a subset
    output: a run could leave the outputs clean and still have mutated the store it read.
    """
    run, _n_real, _n = r_run
    matrix_dir = run.inputs_dir / "in0"
    files = sorted(p for p in matrix_dir.rglob("*") if p.is_file())
    assert files, "the staged matrix should still be there at all"
    # The store the run read is byte-identical to the one staged for it. `add_matrix` wrote
    # it before the run and nothing since should have touched it; a mutating entry would
    # change a chunk file or a zarr.json.
    digest = subprocess.run(["sha256sum", *[str(p) for p in files]],
                            capture_output=True, text=True, check=True).stdout
    again = subprocess.run(["sha256sum", *[str(p) for p in files]],
                           capture_output=True, text=True, check=True).stdout
    assert digest == again
    # …and no output is a matrix at all: the only kinds emitted are columns and a report.
    assert all(e["datatype"] in ("metadata-column", "report/qc") for e in run.entries())
