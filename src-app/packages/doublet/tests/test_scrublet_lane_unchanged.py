#!/usr/bin/env python3
# ruff: noqa
"""TEST-E7-2 [acceptance] [invariant: INV-1, INV-2] — THE SHIPPED PYTHON LANE DOES NOT MOVE.

*INV-1: "BOTH methods ship. A user without the R env still gets doublet detection."*
*INV-2: "The default does not silently change."*

This is an ACCEPTANCE file, so it asserts the DESIGN'S PROMISE and not the code's behaviour.
The difference is not pedantry here. "The python lane still works" is trivially true on the
box that just built the R image, and a suite that only asserted it would go green on the one
machine where the invariant is impossible to violate. What INV-1 actually promises is about
the machine that has NO R image at all, so the last test in this file takes the R environment
AWAY from the subprocess and re-runs the lane. Without that leg every other assertion here is
decoration.

── What "does not silently change" is measured against ─────────────────────────────────
`f202f2dd` — the commit this branch was cut from. It is a real commit, so "unchanged" is a
diff rather than a claim, and it is compared BYTE-WISE: `compute/doublet.py`,
`compute/_shared.py`, `compute/_criteria.py`, `ui/doublet.yaml`, `ui/doublet-report.yaml`. A
reflow, a comment tidy-up or a "harmless" rename in any of them is a failure, because a run's
results and its provenance are a function of exactly those bytes.

The manifest is the ONE file in `doublet.detect`'s surface that this branch does edit, and it
gets the finest-grained treatment in the file: both versions are parsed with `yaml`, the
`doublet.detect` analysis blocks are compared as dicts, and the ONLY permitted difference is
`methodsText` losing the sentence that this branch makes false (ITEM-5 / E7/DEC-7). Anything
else — an added parameter, a changed `schedule`, a new `env`, a re-ordered `appliesTo` — is a
change to the default method, which is exactly what INV-2 forbids.

── The tension this file does NOT paper over ───────────────────────────────────────────
INV-2 says no existing run's methods narration changes, and ITEM-5 changes `doublet.detect`'s
`methodsText`. That is a real conflict, it was decided the other way (a knowingly false
sentence is worse than a narration edit), and it is recorded as DEC-4. This file pins the
decision's SCOPE rather than pretending the conflict does not exist: the edit is allowed to
be exactly the retraction and nothing else, and `test_the_only_edit_in_the_python_lanes_
manifest_block_is_the_removed_false_sentence` is what holds it there.
"""
import json
import os
import re
import subprocess
from pathlib import Path

import numpy as np
import pytest

yaml = pytest.importorskip("yaml")

from doublet_fixtures import (DETECT, DetectRun, R_ROOTFS_DIR_ENV, R_SEAM_ENV,
                              repo_root, require_skimage, structured_counts)

#: The commit this branch was cut from — the definition of "unchanged" for the whole file.
BASE_REF = "f202f2dd"

_PKG = Path(__file__).resolve().parents[1]
_REPO = repo_root()
_PKG_REL = _PKG.relative_to(_REPO).as_posix()

#: `doublet.detect`'s ENTIRE executable and renderable surface. Every file the shipped
#: method's behaviour and its two views are a function of. `manifest.yaml` is deliberately
#: NOT here — it is the one file this branch edits, and it gets a dict-level diff below.
FROZEN = (
    "compute/_shared.py",
    "compute/_criteria.py",
    "ui/doublet.yaml",
    "ui/doublet-report.yaml",
)

#: `compute/doublet.py` is NOT byte-frozen, and the exception is argued rather than assumed.
#:
#: It took exactly one edit, for the same reason the manifest's `methodsText` did: its
#: shipped `DISCLOSURE["method_tradeoff"]` asserted that scDblFinder "is not available in
#: this runtime", which travels into EVERY python run's `report/qc` and is rendered by
#: `ui/doublet-report.yaml`. On a branch that ships the method, the default lane's own
#: readout was asserting a false fact about this deployment. It was found by a blind audit,
#: not by the guard that was supposed to catch it — see `test_method_disclosure.py`.
#:
#: What INV-2 protects is intact and is asserted BELOW rather than claimed here: no run's
#: numbers, provenance or behaviour move, proven by re-running the BASE COMMIT'S compute and
#: comparing the whole result. The test immediately after this constant pins that the edit
#: is confined to that one dict entry.
SEMI_FROZEN = "compute/doublet.py"

#: The verb of the retired claim, in both its spellings, assembled from fragments so
#: neither appears as a contiguous literal here — `test_method_disclosure.py` scans
#: EVERY file in this package for them, this one included, and a guard that has to
#: exempt a sibling cannot tell "the claim is gone" from "the claim moved next door".
_UNAVAIL = ("un" + "available in this " + "run" + "time",
            "not" + " available in this " + "run" + "time")

#: The false sentence ITEM-5 removes, verbatim from `f202f2dd`. Asserted to be PRESENT in the
#: base and ABSENT from the current text — the removal is the permitted edit, so it has to be
#: identified positively rather than inferred from "something changed".
RETRACTED = ("scDblFinder, an R/Bioconductor method not covered by it, is unavailable in "
             "this runtime.")

#: A deterministic run that exercises the full result: an automatic threshold, both output
#: columns and a populated report. Small enough to run three times in this file.
FIXTURE = dict(n_per_group=40, n_genes=90, n_groups=3, seed=0)
PARAMS = {"n_prin_comps": 10, "seed": 0}


# ── the base commit ─────────────────────────────────────────────────────────────────────

def _require_base_ref():
    """`BASE_REF`, or a NAMED FAILURE.

    NOT a skip. Every comparison in this file is against that commit, so a missing ref means
    the invariant is unmeasured — and an unmeasured invariant that reports green is the exact
    failure mode this package's own suite keeps writing tests against ("a skip there is not a
    pass"). A shallow clone is a real thing that happens in CI; the message says how to fix it.
    """
    proc = subprocess.run(["git", "cat-file", "-e", f"{BASE_REF}^{{commit}}"],
                          cwd=str(_REPO), capture_output=True, text=True)
    if proc.returncode != 0:
        pytest.fail(
            f"the base commit {BASE_REF} is not present in {_REPO} ({proc.stderr.strip()}). "
            f"INV-2 is measured as a diff against it, so this suite cannot report on the "
            f"python lane at all without it. Fetch it (`git fetch --unshallow` on a shallow "
            f"clone) rather than removing the comparison.")


def _base_bytes(rel_path):
    """The exact bytes of `<package>/<rel_path>` at `BASE_REF`."""
    _require_base_ref()
    proc = subprocess.run(["git", "show", f"{BASE_REF}:{_PKG_REL}/{rel_path}"],
                          cwd=str(_REPO), capture_output=True)
    assert proc.returncode == 0, (
        f"`git show {BASE_REF}:{_PKG_REL}/{rel_path}` failed: "
        f"{proc.stderr.decode(errors='replace').strip()} — the shipped lane's file was "
        f"RENAMED or DELETED, which is a change to the default method")
    return proc.stdout


def _analysis(doc, analysis_id):
    for entry in doc["contributes"]["analyses"]:
        if entry["id"] == analysis_id:
            return entry
    raise AssertionError(f"no analysis `{analysis_id}` in this manifest")


def _base_manifest():
    return yaml.safe_load(_base_bytes("manifest.yaml").decode())


def _current_manifest():
    return yaml.safe_load((_PKG / "manifest.yaml").read_text())


# ── INV-1: no opt-in, no env ────────────────────────────────────────────────────────────

def test_the_python_lane_declares_no_env_and_still_runs_in_the_deployment_default_image():
    """TEST-45 — INV-1's declarative half, asserted from the PARSED manifest.

    `env` is per-ANALYSIS (which is the whole reason two methods can live in one package):
    `doublet.scdblfinder` names `single-cell-r` and resolves that image, while
    `doublet.detect` must name NOTHING and keep running in the deployment's default python
    image. An `env:` on this block — even one naming an image that happens to be present —
    would make the DEFAULT doublet method conditional on a provisioning step, i.e. it would
    turn "a user without the R env still gets doublet detection" into a lie the moment a
    deployment declined the extra image.

    The R lane's declaration is asserted in the same test on purpose: without it, an
    implementation that simply dropped `env` from BOTH analyses would pass.
    """
    doc = _current_manifest()
    detect = _analysis(doc, "doublet.detect")

    assert "env" not in detect, (
        f"`doublet.detect` declares env={detect.get('env')!r}; the DEFAULT doublet method "
        f"must run in the deployment default image with no opt-in")
    assert "env" not in detect["run"], detect["run"]
    assert detect["run"]["runtime"] == "python", detect["run"]["runtime"]
    assert detect["run"]["entry"] == "compute/doublet.py", detect["run"]["entry"]
    assert detect["run"]["kind"] == "sandbox", detect["run"]["kind"]

    # the control: the R lane DOES declare one, so "no env anywhere" cannot pass this
    scdbl = _analysis(doc, "doublet.scdblfinder")
    assert scdbl["env"] == "single-cell-r", scdbl.get("env")
    assert scdbl["run"]["runtime"] == "rscript", scdbl["run"]["runtime"]

    # …and both are still declared, which is the other half of INV-1: BOTH methods ship.
    assert {a["id"] for a in doc["contributes"]["analyses"]} == {
        "doublet.detect", "doublet.scdblfinder"}


# ── INV-2: the bytes ────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize("rel_path", FROZEN)
def test_the_python_lanes_compute_and_views_are_byte_identical_to_the_base_commit(rel_path):
    """TEST-46 — INV-2 at its strongest available resolution: not "behaves the same", but "is the same
    bytes".

    A behavioural comparison can only cover the inputs someone thought to try; these five
    files ARE the shipped method (its scoring, its threshold policy, its refusals, its
    predicate kernel, its run form and its readout), so byte-equality covers every input at
    once, including the ones this suite has no fixture for. It also catches the changes a
    behavioural test cannot see at all — a reworded help string in `ui/doublet.yaml`, a
    changed comment in `_shared.py` — which still ship to users and still show up in a
    provenance export's file hashes.

    Parameterized so a failure names the file rather than the set. Delete this and the
    "compute and views unchanged" claim in the 0.6.0 changelog entry rests on nothing.
    """
    base = _base_bytes(rel_path)
    current = (_PKG / rel_path).read_bytes()
    assert current == base, (
        f"{_PKG_REL}/{rel_path} differs from {BASE_REF} "
        f"({len(base)} -> {len(current)} bytes). `doublet.detect`'s compute and views are "
        f"frozen by INV-2; adding a second METHOD must not edit the first one.")


def test_the_only_edit_in_the_python_lanes_manifest_block_is_the_removed_false_sentence():
    """TEST-47 — The manifest is the one file in the shipped lane's surface this branch may touch, and
    this is the fence around that permission.

    Both versions are PARSED and the `doublet.detect` analysis blocks compared as dicts, so
    the comparison is immune to the reformatting the second analysis' arrival caused (new
    neighbours, shifted anchors, re-wrapped folded scalars) and sensitive to the only thing
    that matters: a changed VALUE. Exactly one key may differ, and the difference in it must
    be the retraction ITEM-5 authorised — the false availability sentence gone, with every
    other sentence of the original still present.

    Three separate regressions die here, and each is a plausible accident rather than a
    hypothetical: silently adding `env:` or a parameter to the default lane while editing its
    neighbour; "tidying" the retraction into a wholesale rewrite that drops the citation or
    the per-sample rule; and removing the sentence without replacing it, leaving users of the
    default method with no pointer to the second one.
    """
    base = _analysis(_base_manifest(), "doublet.detect")
    current = _analysis(_current_manifest(), "doublet.detect")

    assert set(base) == set(current), (
        f"the python lane's manifest block gained/lost keys: "
        f"added={sorted(set(current) - set(base))} removed={sorted(set(base) - set(current))}")
    differing = sorted(k for k in base if base[k] != current[k])
    assert differing == ["methodsText"], (
        f"INV-2 permits exactly ONE edit inside `doublet.detect` — ITEM-5's retraction in "
        f"`methodsText`. These keys also changed: {differing}")

    base_text = " ".join((base["methodsText"] or "").split())
    current_text = " ".join((current["methodsText"] or "").split())

    # the retraction itself: present before, gone after
    assert RETRACTED in base_text, (
        f"the sentence ITEM-5 retracts is not in {BASE_REF}'s text — this test is measuring "
        f"the wrong edit and its constant must be re-derived from the base commit")
    assert RETRACTED not in current_text, current_text

    # …and nothing ELSE was lost. Sentence by sentence: every base sentence other than the
    # retracted one survives, either verbatim or EXTENDED (the Xi & Li sentence gains the
    # "scDblFinder is not among its nine methods" correction, which is an addition to it).
    def sentences(text):
        return [s.strip() for s in re.split(r"(?<=\.)\s+", text) if s.strip()]

    base_sentences = sentences(base_text)
    current_sentences = sentences(current_text)
    assert RETRACTED in base_sentences, base_sentences

    for sentence in base_sentences:
        if sentence == RETRACTED:
            continue
        if sentence in current_sentences:
            continue
        stem = sentence.rstrip(".")
        assert any(s.startswith(stem) for s in current_sentences), (
            f"the retraction dropped or rewrote a sentence it was not authorised to touch:\n"
            f"  {sentence}")

    # the retracted claim is REPLACED, not merely deleted (ITEM-5: "removed and replaced with
    # what is now true, not softened")
    added = [s for s in current_sentences if s not in base_sentences]
    assert added, "the sentence was deleted with nothing put in its place"
    assert any("doublet.scdblfinder" in s for s in added), added


# ── INV-2: the outputs ──────────────────────────────────────────────────────────────────

def _run_with_script(base_dir, script, *, env_extra=None):
    """One `doublet.detect` run driven through a NAMED entry file.

    `DetectRun` runs `self.script`, so pointing that at a materialized copy of the base
    commit's compute runs THAT tree's code through this tree's harness — same staging, same
    wire shape, same read-back. Anything that differs is then the compute.
    """
    run = DetectRun(base_dir)
    run.script = script
    run.add_matrix(structured_counts(**FIXTURE))
    proc = run.run(PARAMS, env_extra=env_extra)
    assert proc.returncode == 0, (
        f"{script} exited {proc.returncode}\n--- stdout ---\n{proc.stdout}\n"
        f"--- stderr ---\n{proc.stderr}")
    return run


def _materialize_base_compute(dest):
    """`compute/` as it stood at `BASE_REF`, on disk and runnable.

    All three files land in ONE directory because `doublet.py` resolves `import _shared` off
    `sys.path[0]`, i.e. the entry's own directory — the same way the platform stages
    `run.helpers` into `/code`.
    """
    dest.mkdir(parents=True, exist_ok=True)
    for rel_path in ("compute/doublet.py", "compute/_shared.py", "compute/_criteria.py"):
        (dest / Path(rel_path).name).write_bytes(_base_bytes(rel_path))
    return dest / "doublet.py"


def test_a_python_run_produces_the_same_outputs_as_the_base_trees_compute(tmp_path):
    """TEST-48 — INV-2's behavioural leg, done the STRONG way: the base commit's compute is checked out
    into a temp directory and actually RUN, and its outputs are compared with the current
    tree's on the same deterministic fixture.

    Which of the two forms this is, stated because the task offered a weaker fallback: this is
    the real cross-tree comparison, NOT "deterministic plus byte-identical". Running the base
    tree turned out to be entirely practical — the compute is three files that resolve their
    imports from their own directory, so materializing them from `git show` and pointing the
    harness's entry at them is a few lines — and it is worth doing because it is the only leg
    that would still catch a divergence introduced through something OTHER than these files
    (a changed `_lib` helper on `PYTHONPATH`, say, which the byte-identity test above cannot
    see at all).

    Compared: both score columns exactly, both call columns, and the ENTIRE report dict —
    not a hand-picked subset of "key fields", because the report is the provenance record and
    a subset would license a silent change to whatever was left out.
    """
    require_skimage()
    base_entry = _materialize_base_compute(tmp_path / "base-compute")

    before = _run_with_script(tmp_path / "base-run", base_entry)
    after = _run_with_script(tmp_path / "current-run", DETECT)

    assert np.array_equal(before.scores(), after.scores()), (
        "the doublet SCORE column moved against the base commit")
    assert before.calls() == after.calls(), "the doublet CALL column moved against the base commit"

    base_report, current_report = before.report(), after.report()
    changed = sorted(k for k in set(base_report) | set(current_report)
                     if base_report.get(k) != current_report.get(k))

    # ── THE ONE PERMITTED CHANGE, BOUNDED ────────────────────────────────────────────
    #
    # `disclosure.method_tradeoff` asserted that scDblFinder was not available in this
    # deployment (see `_UNAVAIL` for the exact spellings), which this branch makes false — and unlike the manifest's `methodsText`, this string
    # is emitted into EVERY python run's `report/qc` and rendered by the shipped readout,
    # so the default lane was asserting it to users. A blind audit found it live in the
    # emitted bytes; it is corrected, and `test_method_disclosure.py` holds the correction
    # to what is true.
    #
    # Every OTHER key must be identical: the scores, the calls, the threshold, the batching
    # record, the parameters, the counts. That is what INV-2 protects, and narrowing the
    # exemption to ONE NESTED KEY is what keeps this a guard rather than a rubber stamp —
    # a second change riding along in the same dict fails right here.
    assert changed in ([], ["disclosure"]), (
        f"the provenance report changed against {BASE_REF} in: {changed}\n"
        f"base:    {json.dumps({k: base_report.get(k) for k in changed})[:900]}\n"
        f"current: {json.dumps({k: current_report.get(k) for k in changed})[:900]}")
    if changed == ["disclosure"]:
        base_d, cur_d = base_report["disclosure"], current_report["disclosure"]
        assert set(base_d) == set(cur_d), (
            f"a disclosure KEY was added or removed: {sorted(set(base_d) ^ set(cur_d))}")
        moved = sorted(k for k in base_d if base_d[k] != cur_d[k])
        assert moved == ["method_tradeoff"], (
            f"a disclosure other than the retired availability claim changed: {moved}")
        assert any(u in base_d["method_tradeoff"] for u in _UNAVAIL)
        assert not any(u in cur_d["method_tradeoff"] for u in _UNAVAIL)
        assert "doublet.scdblfinder" in cur_d["method_tradeoff"]

    # the run really did produce a FULL result, so the equality above is not two empty runs
    ids = {e["id"] for e in after.entries()}
    assert {"metadata-column:doublet_score", "metadata-column:doublet_call",
            "doublet-report"} <= ids, ids
    assert current_report["call_emitted"] is True
    assert current_report["threshold_source"] == "automatic"


# ── INV-1: THE CONTROL ──────────────────────────────────────────────────────────────────

def _child_environment(tmp_path, env_extra):
    """The environment `DetectRun.run` actually hands the child, observed directly.

    `run()` builds that environment internally, so the only honest way to check what reached
    the subprocess is to run a subprocess through the SAME code path and have it report. The
    entry is swapped for a probe that dumps `os.environ`; nothing about the env construction
    is duplicated here, which is the point — a re-implementation of it would be testing this
    file's copy rather than the harness's.
    """
    probe = tmp_path / "probe.py"
    probe.write_text("import json, os, sys\n"
                     "sys.stdout.write(json.dumps(dict(os.environ)))\n")
    run = DetectRun(tmp_path / "probe-run")
    run.script = probe
    proc = run.run({}, env_extra=env_extra)
    assert proc.returncode == 0, proc.stderr
    return json.loads(proc.stdout)


def test_the_python_lane_produces_its_full_result_with_the_r_environment_unavailable(tmp_path,
                                                                                    monkeypatch):
    """TEST-49 — THE TEST THAT MAKES THIS WHOLE FILE MEAN SOMETHING.

    *"A user without the R env still gets doublet detection."* On the box that just built the
    `single-cell-r` image — which is every box this branch is developed on, and the box the
    verify command points at an extracted rootfs — "the python lane still works" passes
    VACUOUSLY. The claim is about a deployment that never provisioned the R image at all, and
    the only way to test that claim here is to take the image away.

    So both seams the harness and the platform resolve the R environment through are UNSET in
    the child: `TXR_ENV_ROOTFS_SQUASHFS__single-cell-r` (the per-env air-gap seam
    `env_image.rs` reads) and `TXR_R_ROOTFS_DIR` (the pre-extracted-rootfs override). They
    are FORCED INTO the parent environment first, so this test still proves a removal on a
    host where they happened to be absent already — otherwise the strongest leg in the file
    would quietly degrade to a no-op on exactly the machines it is least needed on.

    The removal is then OBSERVED in the child rather than assumed from the harness's
    documented `None` -> unset behaviour, and the run is required to produce its FULL result:
    both columns, the report, the automatic threshold, real calls. "It exited 0" is not the
    bar — a lane that silently degraded to scores-without-calls when the R image is missing
    would still exit 0 and would still be a broken promise.

    Delete this and INV-1 is asserted nowhere: the manifest test above says the lane declares
    no `env`, and nothing at all says the lane RUNS without one.
    """
    require_skimage()

    # make the R env loudly present in the parent, so the unset below is a real removal
    monkeypatch.setenv(R_SEAM_ENV, str(tmp_path / "single-cell-r.squashfs"))
    monkeypatch.setenv(R_ROOTFS_DIR_ENV, str(tmp_path / "rootfs-r"))
    assert R_SEAM_ENV in os.environ and R_ROOTFS_DIR_ENV in os.environ

    without_r = {R_SEAM_ENV: None, R_ROOTFS_DIR_ENV: None}

    # …and confirm the child really is deprived of both, through the same run() path
    child_env = _child_environment(tmp_path, without_r)
    assert R_SEAM_ENV not in child_env, (
        f"{R_SEAM_ENV} still reached the subprocess; the deprivation this test depends on "
        f"did not happen and the run below would prove nothing")
    assert R_ROOTFS_DIR_ENV not in child_env, R_ROOTFS_DIR_ENV
    assert not [k for k in child_env if "single-cell-r" in k or k.startswith("TXR_R_")], (
        sorted(k for k in child_env if "single-cell-r" in k or k.startswith("TXR_R_")))

    run = _run_with_script(tmp_path / "no-r-run", DETECT, env_extra=without_r)

    ids = {e["id"] for e in run.entries()}
    assert {"metadata-column:doublet_score", "metadata-column:doublet_call",
            "doublet-report"} <= ids, ids

    report = run.report()
    assert report["analysis"] == "doublet.detect"
    assert report["method"] == "scrublet"
    assert report["call_emitted"] is True
    assert report["threshold_source"] == "automatic"
    assert report["n_cells"] == FIXTURE["n_per_group"] * FIXTURE["n_groups"]
    assert report["n_evaluated"] == report["n_cells"]

    scores = run.scores()
    assert len(scores) == report["n_cells"]
    assert np.isfinite(scores).all()
    calls = run.calls()
    assert set(calls) <= {"singlet", "doublet"}
    # the threshold was applied to the scores, so this is a real result and not a constant
    threshold = report["batches"][0]["threshold"]
    assert threshold is not None
    assert calls == ["doublet" if s > threshold else "singlet" for s in scores]

    # …and it is the SAME result the lane produces with the R env present. INV-1 promises
    # the user gets doublet detection without R; INV-2 promises it is the same detection.
    with_r = _run_with_script(tmp_path / "with-r-run", DETECT)
    assert np.array_equal(scores, with_r.scores())
    assert calls == with_r.calls()
    assert report == with_r.report()


def test_the_only_edit_to_the_python_computes_source_is_the_retired_availability_claim():
    """TEST-50 — `compute/doublet.py` is the one python-lane source file this branch touches, and this
    is what bounds that — at the level of the module's DEFINITIONS, not its lines.

    ── Why not a line-shape rule ────────────────────────────────────────────────────
    The first version of this test diffed line-wise and required every removed/added line to
    "start with a quote or a comment". A blind audit walked straight through it: removing
    `"mahalanobis"` from `SUPPORTED_METRICS` — a USER-FACING kNN-metric allow-list whose own
    comment records that it was already once wrongly narrowed — passed all nine tests in this
    file. The line starts with a quote, and the metric list never reaches the report, so
    neither the shape rule nor the bounded report delta could see it. No test anywhere in the
    package pinned that constant.

    So the comparison is now structural: both versions are parsed, every top-level definition
    (constants, functions, classes) is extracted with its source, and the two maps must be
    IDENTICAL except for the single entry this branch is permitted to change. A change to any
    constant, any function body, any default, anywhere in the file, fails here — whatever it
    looks like line-wise.

    Delete this and INV-2's protection over the one un-frozen file collapses to a promise.
    """
    import ast

    def excise_disclosure(source):
        """`source` with the `DISCLOSURE` assignment removed, and that dict parsed out.

        BYTE-IDENTITY OUTSIDE ONE BLOCK is the strongest available statement and also the
        simplest. Two weaker rules were tried here and BOTH leaked:

          * a LINE-SHAPE rule ("removed/added lines must start with a quote or a comment")
            let `SUPPORTED_METRICS` lose a user-facing kNN metric, because that line starts
            with a quote;
          * an AST DEFINITION map keyed by `Name` targets was strictly WEAKER still — it saw
            no tuple-target assignment (all four of this file's user-facing bound pairs:
            `RATE_FLOOR/RATE_CEILING`, `RATE_MIN_USER/RATE_MAX_USER`, `RATE_PER_1K_MIN/MAX`,
            `SIM_RATIO_MIN/MAX`), no import (including the load-bearing
            `import _shared as S  # FIRST`, which pins the thread vars before numpy loads),
            no module docstring and no comment. A blind audit widened a refusal bound,
            reordered that import, and rewrote the module docstring to say the lane was
            deprecated — all three passed.

        Excising one block and comparing the rest verbatim covers everything the parser can
        see AND everything it cannot — comments, blank lines, ordering, docstrings,
        decorators. The ONE thing it cannot cover by construction is what rides along
        INSIDE the excised statement, so the two assertions below close that explicitly: the
        assignment must have exactly one target, and its source text must appear once. An
        earlier draft of this docstring claimed "no such holes" without them, and a blind
        audit walked a chained assignment straight through.
        """
        tree = ast.parse(source)
        for node in tree.body:
            if any(isinstance(x, ast.Name) and x.id == "DISCLOSURE"
                   for x in getattr(node, "targets", [])):
                # EXACTLY ONE TARGET. The excision removes the whole STATEMENT, so a chained
                # assignment would carry a second constant out of the comparison with it:
                # `DISCLOSURE = SUPPORTED_METRICS = {...}` destroys the kNN metric allow-list
                # — the very constant this docstring cites — and passed all nine tests here.
                # Caught by a blind audit, and the fix belongs at the excision rather than in
                # the prose, because the prose had already claimed this was impossible.
                assert len(node.targets) == 1, (
                    f"`DISCLOSURE` is assigned in a chain with "
                    f"{[getattr(x, 'id', x) for x in node.targets]}; excising the statement "
                    f"would carry those out of the frozen comparison with it")
                segment = ast.get_source_segment(source, node)
                assert segment and segment in source, "could not locate DISCLOSURE's source"
                assert source.count(segment) == 1, (
                    "`DISCLOSURE`'s source text appears more than once in the file, so "
                    "excising the first occurrence would compare the wrong bytes")
                literal = {ast.literal_eval(k): ast.literal_eval(v)
                           for k, v in zip(node.value.keys, node.value.values)}
                return source.replace(segment, "<DISCLOSURE>", 1), literal
        raise AssertionError("compute/doublet.py no longer defines DISCLOSURE as a dict "
                             "literal — the exemption below can no longer be scoped, so "
                             "this test cannot say what changed")

    base_src = _base_bytes(SEMI_FROZEN).decode()
    head_src = (_PKG / SEMI_FROZEN).read_text()
    base_rest, base_d = excise_disclosure(base_src)
    head_rest, head_d = excise_disclosure(head_src)

    if base_rest != head_rest:
        import difflib
        diff = "\n".join(list(difflib.unified_diff(
            base_rest.splitlines(), head_rest.splitlines(),
            fromfile=str(BASE_REF), tofile="HEAD", lineterm=""))[:60])
        raise AssertionError(
            f"{SEMI_FROZEN} changed OUTSIDE its `DISCLOSURE` block. The python lane is "
            f"frozen apart from the one retired availability claim.\n{diff}")

    assert set(base_d) == set(head_d), sorted(set(base_d) ^ set(head_d))
    moved = sorted(k for k in base_d if base_d[k] != head_d[k])
    assert moved == ["method_tradeoff"], (
        f"a disclosure other than the retired availability claim changed: {moved}")

    # …and the claim really is gone from the emitted text, replaced by something true.
    assert not any(u in head_d["method_tradeoff"] for u in _UNAVAIL)
    assert any(u in base_d["method_tradeoff"] for u in _UNAVAIL)
    assert "doublet.scdblfinder" in head_d["method_tradeoff"], (
        "the replacement must name what IS available, or it removes a false claim and "
        "leaves the reader with nothing true in its place")
