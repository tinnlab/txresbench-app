#!/usr/bin/env python3
# ruff: noqa
"""The core compute contract.

TEST-12 [acceptance] [invariant: INV-8] [covers: ITEM-5, ITEM-15] — FLAG, DON'T DELETE: this
        analysis annotates and cannot remove a cell.
TEST-14 [acceptance] [invariant: INV-10] [covers: ITEM-3, ITEM-25] — EVERY `sc.pp.scrublet`
        parameter is passed explicitly; none is left to a scanpy default; the resolved
        scanpy version is recorded and inside the declared supported set.
TEST-15 [covers: ITEM-26] — determinism.
TEST-18 [covers: ITEM-4] — the expected-doublet-rate derivation.
TEST-20 [covers: ITEM-2] — the wire contract: thread pins read out of the RUNNING process,
        slot resolution with meaningless mount names, progress frames, named refusals.
"""
import inspect
import json
import re
import sys
from pathlib import Path

import numpy as np
import pytest

from doublet_fixtures import (counts_matrix, load_compute, load_shared,
                              require_skimage,
                              structured_counts)

_PKG = Path(__file__).resolve().parents[1]
_COMPUTE = _PKG / "compute"

sys.path.insert(0, str(_COMPUTE))
S = load_shared()

#: NEVER `import doublet` — see `doublet_fixtures.load_compute` for why that silently
#: returns the namespace package for the package DIRECTORY under `--import-mode=importlib`.
D = load_compute()

PARAMS = {"n_prin_comps": 10}


# ── TEST-18 — the rate derivation (a pure function, tested as one) ──────────────────
@pytest.mark.parametrize("n,expected", [
    (250, 0.005),        # 0.008 * 250/1000 = 0.002 -> clamped UP to the floor
    (625, 0.005),        # exactly the floor
    (1000, 0.008),
    (2700, 0.0216),      # the raw pbmc3k fixture
    (9500, 0.076),       # the ~7.6% figure the epic quotes for a 10k lane
    (31250, 0.25),       # exactly the ceiling
    (50000, 0.25),       # clamped DOWN to the ceiling
])
def test_the_auto_rate_is_the_10x_loading_rule_clamped(n, expected):
    rate, source = D.resolve_expected_rate(n, rate_per_1k=0.008, explicit=None)
    assert rate == pytest.approx(expected)
    assert source == "auto_10x_0.8pct_per_1k"


def test_an_explicit_rate_overrides_and_is_recorded_as_the_users():
    rate, source = D.resolve_expected_rate(9999, rate_per_1k=0.008, explicit=0.123)
    assert rate == 0.123
    assert source == "user"
    # …and it is NOT clamped: the user asked for it, and silently moving it would be the
    # library-default problem in a new costume.
    rate, _ = D.resolve_expected_rate(10, rate_per_1k=0.008, explicit=0.9)
    assert rate == 0.9


def test_an_ht_chip_rate_halves_the_derived_value():
    """HT chips halve the per-cell rate. The knob is `doublet_rate_per_1k` precisely so
    nobody is ever asked to compute a rate by hand."""
    standard, _ = D.resolve_expected_rate(5000, rate_per_1k=0.008, explicit=None)
    ht, _ = D.resolve_expected_rate(5000, rate_per_1k=0.004, explicit=None)
    assert standard == pytest.approx(0.04)
    assert ht == pytest.approx(0.02)
    assert ht == pytest.approx(standard / 2)


def test_scrublets_own_flat_default_is_never_used():
    """Scrublet's constructor default is a flat 0.05 (0.06 in the original package), which is
    wrong in BOTH directions on real data: it over-calls a 2,000-cell run (true rate ~1.6%)
    and under-calls a 20,000-cell run (~16%). It must not be reachable."""
    for n in (2000, 20000):
        rate, _ = D.resolve_expected_rate(n, rate_per_1k=0.008, explicit=None)
        assert rate != pytest.approx(0.05)
        assert rate != pytest.approx(0.06)
    assert D.resolve_expected_rate(2000, rate_per_1k=0.008, explicit=None)[0] == pytest.approx(0.016)
    assert D.resolve_expected_rate(20000, rate_per_1k=0.008, explicit=None)[0] == pytest.approx(0.16)


def test_a_nonpositive_rate_per_1k_is_a_named_refusal(detect_run):
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    proc = run.run(dict(PARAMS, doublet_rate_per_1k="0"))
    assert proc.returncode != 0
    assert "doublet_rate_per_1k" in run.diagnostics(proc)


# ── TEST-14 — every parameter explicit ──────────────────────────────────────────────
def test_every_scrublet_parameter_the_wrapper_accepts_is_passed_explicitly(detect_run):
    """`scanpy` is UNPINNED in the env rootfs, so a scientific default can move under a
    shipped package between two image builds. The defence is to leave NOTHING to a default:
    this compares the parameter set the compute actually passed (recorded in the report)
    against `sc.pp.scrublet`'s own keyword-only signature, read by reflection."""
    require_skimage()
    import scanpy as sc

    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok(PARAMS)

    signature = inspect.signature(sc.pp.scrublet)
    accepted = {name for name, p in signature.parameters.items()
                if p.kind is inspect.Parameter.KEYWORD_ONLY}
    # `copy` is deliberately excluded from the RECORD (it is a plumbing flag, not a
    # scientific parameter) but it IS passed; `adata_sim` is positional-or-keyword and not
    # part of this analysis' surface. `expected_doublet_rate` is recorded PER BATCH rather
    # than run-level, because it is derived from each batch's own cell count — a single
    # run-level value would be a fiction on any batched run — so the coverage check is over
    # the union of both records.
    report = run.report()
    per_batch_keys = set().union(*(set(b) for b in report["batches"]))
    recorded = set(report["parameters"]) | per_batch_keys | {"copy"}
    assert "expected_doublet_rate" in per_batch_keys
    missing = accepted - recorded
    assert not missing, (
        f"{sorted(missing)} were left to a scanpy default. scanpy is unpinned, so a default "
        "can move under this package between two image builds without a single line of our "
        "code changing."
    )

    params = report["parameters"]
    # the values that carry scientific meaning, pinned rather than merely present
    assert params["batch_key"] is None        # the split is OURS, never delegated
    assert params["use_approx_neighbors"] is False  # exact sklearn kNN; annoy is approximate
    assert params["sim_doublet_ratio"] == 2.0
    assert params["stdev_doublet_rate"] == 0.02
    assert params["synthetic_doublet_umi_subsampling"] == 1.0
    assert params["knn_dist_metric"] == "euclidean"
    assert params["random_state"] == 0
    # `expected_doublet_rate` is deliberately NOT here: it is per batch, so one run-level
    # value would be a fiction on any batched run.
    assert "expected_doublet_rate" not in params


def test_the_knobs_the_wrapper_cannot_honour_are_recorded_not_faked(detect_run):
    """`min_counts`, `min_cells` and `min_gene_variability_pctl` belong to the STANDALONE
    Scrublet class; `sc.pp.scrublet` does not expose them and applies its own filtering and
    HVG step instead. Offering them as parameters would be offering knobs that silently do
    nothing — so they are recorded at the values scanpy fixes internally."""
    require_skimage()
    import scanpy as sc

    accepted = set(inspect.signature(sc.pp.scrublet).parameters)
    for knob in ("min_counts", "min_cells", "min_gene_variability_pctl"):
        assert knob not in accepted, (
            f"scanpy now exposes `{knob}`; it should be passed explicitly rather than "
            "recorded under `fixed_by_scanpy`")

    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok(PARAMS)
    fixed = run.report()["fixed_by_scanpy"]
    assert fixed["filter_genes_min_cells"] == 3
    assert fixed["filter_cells_min_genes"] == 3
    # TWO normalize_total calls with different targets; the HVG-feeding one has none.
    assert fixed["normalize_total_target_sum_hvg"] is None
    assert fixed["normalize_total_target_sum_pca"] == 1e6
    assert "min_gene_variability_pctl" in fixed["note"]


def test_the_resolved_scanpy_version_is_recorded_and_supported(detect_run):
    require_skimage()
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok(PARAMS)
    report = run.report()

    version = report["scanpy_version"]
    assert version, "the resolved scanpy version was not recorded"
    assert report["scanpy_supported"] is True, (
        f"scanpy {version} is outside the declared supported set "
        f"{report['scanpy_supported_set']} — re-validate the package against it and widen "
        "the set deliberately rather than letting the behaviour move silently"
    )
    assert report["scanpy_supported_set"] == list(D.SUPPORTED_SCANPY)
    for lib in ("scanpy", "anndata", "numpy", "scipy", "sklearn", "pandas"):
        assert report["library_versions"][lib], lib


def test_an_unsupported_scanpy_is_a_loud_warning_not_a_silent_change(detect_run):
    """The version half of the invariant has to be capable of firing. The supported set is a
    module constant, so this drives the predicate directly rather than faking an install."""
    assert not any("0.0.".startswith(v) for v in D.SUPPORTED_SCANPY)
    assert any("1.11.5".startswith(v) for v in D.SUPPORTED_SCANPY)
    assert not any("2.0.0".startswith(v) for v in D.SUPPORTED_SCANPY), (
        "a hypothetical scanpy 2.0 must NOT be silently inside the validated set")


# ── TEST-12 — flag, don't delete ────────────────────────────────────────────────────
def test_the_analysis_emits_no_matrix_and_cannot_remove_a_cell(detect_run):
    """`cell.filter` is the filtering analysis. This one annotates: it must not emit a
    subset matrix, and its columns must cover EVERY input cell in input order under every
    parameterization — otherwise a downstream consumer would silently be looking at a
    different cells axis than the one it thinks it has."""
    require_skimage()
    dense = structured_counts(40, 90, n_groups=3, seed=0)
    n = dense.shape[0]
    qc = [1.0] * (n - 20) + [0.0] * 20
    labels = ["S1"] * (n // 2) + ["S2"] * (n - n // 2)

    parameterizations = [
        ("plain", {}, []),
        ("batched", {"batch_column": "sample"}, ["batch"]),
        ("filtered", {"criteria": [{"column": "qc", "min": "0.5"}]}, ["qc"]),
        ("both", {"batch_column": "sample",
                  "criteria": [{"column": "qc", "min": "0.5"}]}, ["batch", "qc"]),
    ]
    for name, extra, needs in parameterizations:
        run = detect_run()
        run.add_matrix(dense)
        if "batch" in needs:
            run.add_column(labels, slot="batch", name="sample")
        if "qc" in needs:
            run.add_column(qc, slot="column:qc", name="qc")
        run.run_ok(dict(PARAMS, **extra))

        datatypes = {e["datatype"] for e in run.entries()}
        assert datatypes <= {"metadata-column", "report/qc"}, (name, datatypes)
        assert not any("expression" in d for d in datatypes), (name, datatypes)

        assert len(run.scores()) == n, name
        assert len(run.calls()) == n, name
        assert run.report()["n_cells"] == n, name


def test_the_flag_dont_delete_disclosure_ships_in_the_report(detect_run):
    require_skimage()
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok(PARAMS)
    text = run.report()["disclosure"]["flag_dont_delete"]
    assert "FLAGS for inspection, not removals" in text
    assert "not modified" in text
    assert "trajectory" in text          # the specific way a real cell looks like a doublet


# ── TEST-15 — determinism ───────────────────────────────────────────────────────────
def test_two_runs_with_the_same_seed_are_identical(detect_run):
    require_skimage()
    dense = structured_counts(40, 90, n_groups=3, seed=0)
    first, second = detect_run(), detect_run()
    for run in (first, second):
        run.add_matrix(dense)
        run.run_ok(dict(PARAMS, seed="7"))

    assert np.array_equal(first.scores(), second.scores())
    assert first.calls() == second.calls()
    assert (first.report()["batches"][0]["threshold"]
            == second.report()["batches"][0]["threshold"])


def test_a_different_seed_changes_the_result(detect_run):
    """The control: if the seed did not reach the computation, the determinism test above
    would pass for a compute that ignores it entirely."""
    require_skimage()
    dense = structured_counts(40, 90, n_groups=3, seed=0)
    a, b = detect_run(), detect_run()
    a.add_matrix(dense)
    a.run_ok(dict(PARAMS, seed="0"))
    b.add_matrix(dense)
    b.run_ok(dict(PARAMS, seed="12345"))
    assert not np.array_equal(a.scores(), b.scores()), "the seed never reached the simulation"


# ── TEST-20 — the wire contract ─────────────────────────────────────────────────────
def test_the_six_thread_variables_are_pinned_in_the_RUNNING_process(detect_run):
    """Read out of the child process and recorded into the report, so this proves the child
    ENV rather than the source text. Unpinned BLAS is not cosmetic here: measured, it moves
    Scrublet's scores by ~9e-4 (see `test_parity.py`)."""
    require_skimage()
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok(PARAMS)
    pins = run.report()["thread_pins"]
    assert set(pins) == set(S.THREAD_ENV_VARS)
    assert len(pins) == 6
    for var, value in pins.items():
        assert value == "1", (var, value)


def test_inputs_resolve_by_SLOT_with_meaningless_mount_names(detect_run):
    """The harness names every mount `in0`/`in1`/…, so a compute that sniffed a filename
    suffix (or assumed an order) could not pass. Binding the batch column FIRST and the
    matrix second is the case that catches a positional assumption."""
    require_skimage()
    dense = structured_counts(40, 90, n_groups=3, seed=0)
    labels = ["S1"] * 60 + ["S2"] * 60

    run = detect_run()
    run.add_column(labels, slot="batch", name="sample")   # mount in0
    run.add_matrix(dense)                                  # mount in1
    run.run_ok(dict(PARAMS, batch_column="sample"))

    declared = json.loads((run.inputs_dir / "inputs.json").read_text())["inputs"]
    assert [e["sandbox_path"] for e in declared] == ["/inputs/in0", "/inputs/in1"]
    assert run.report()["batched"] is True
    assert run.report()["n_batches"] == 2


def test_a_missing_matrix_slot_is_a_named_refusal(detect_run):
    run = detect_run()
    proc = run.run(PARAMS)
    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert "'matrix'" in diag
    assert "resolves by SLOT only" in diag
    assert "no filename fallback" in diag


def test_more_than_one_matrix_is_a_named_refusal(detect_run):
    dense = structured_counts(40, 90, n_groups=3, seed=0)
    run = detect_run()
    run.add_matrix(dense)
    run.add_matrix(dense)
    proc = run.run(PARAMS)
    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert "SINGULAR" in diag
    assert "ATAC" in diag        # names WHY, not just that it refuses


def test_progress_frames_are_emitted_for_each_named_phase(detect_run):
    require_skimage()
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    proc = run.run_ok(PARAMS)
    phases = run.progress_phases(proc)
    for phase in ("resolve", "preflight", "read", "integer-gate", "filter", "score",
                  "write", "report", "done"):
        assert phase in phases, (phase, phases)
    assert phases[-1] == "done"


def test_a_batched_run_reports_progress_per_batch(detect_run):
    """A silent spinner over a long multi-sample run is a defect; the user should see which
    sample is being scored."""
    require_skimage()
    dense = structured_counts(40, 90, n_groups=3, seed=0)
    labels = ["S1"] * 60 + ["S2"] * 60
    run = detect_run()
    run.add_matrix(dense)
    run.add_column(labels, slot="batch", name="sample")
    proc = run.run_ok(dict(PARAMS, batch_column="sample"))
    frames = [l for l in proc.stderr.splitlines() if l.startswith("progress: score")]
    assert len(frames) == 2, frames
    assert any("batch 1/2" in f for f in frames), frames
    assert any("batch 2/2" in f for f in frames), frames


def test_a_shapeless_or_non_csc_input_is_refused_before_any_read(detect_run):
    """The ceiling gate and the structure check both run BEFORE a byte of the matrix is
    read, so a malformed input cannot get as far as being loaded."""
    run = detect_run()
    # a metadata-column store bound on the matrix slot — well-formed zarr, wrong kind
    run.add_column([1.0] * 40, slot="matrix", name="values")
    proc = run.run(PARAMS)
    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert "sparse_csc" in diag


def test_a_blank_label_is_refused_rather_than_inventing_a_column_name(detect_run):
    run = detect_run()
    run.add_matrix(counts_matrix(40, 30, seed=0))
    proc = run.run(dict(PARAMS, label="   "))
    assert proc.returncode != 0
    assert "label" in run.diagnostics(proc)


def test_the_label_names_the_emitted_columns(detect_run):
    require_skimage()
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok(dict(PARAMS, label="run2"))
    ids = {e["id"] for e in run.entries()}
    assert "metadata-column:run2_score" in ids
    assert "metadata-column:run2_call" in ids
    report = run.report()
    assert report["score_column"] == "run2_score"
    assert report["call_column"] == "run2_call"


# ── the import-collision guard (TEST-25) ───────────────────────────────────────────
#
# Added at the 717-commit merge of main, which brought `--import-mode=importlib` (#198)
# and silently broke every `import doublet` in this suite. Fifteen tests failed loudly
# with `AttributeError`; the dangerous case is the one that would NOT have — a test
# probing for the ABSENCE of an attribute would have gone permanently, quietly green.


def test_the_bare_name_doublet_does_NOT_resolve_to_the_compute_module(request):
    """The POSITIVE CONTROL for `load_compute`.

    Asserting only "load_compute gives us the right module" cannot distinguish a real fix
    from a tree where the bare import happened to work anyway. So this asserts BOTH sides:
    the bare name does NOT give you the compute module, and the helper does.

    The namespace-package leg is gated on the RESOLVED import mode, not assumed. A blind
    audit ran this file with `-o addopts= --import-mode=prepend` and it failed — because
    the hazard is a property of `--import-mode=importlib` (which `packages/pytest.ini` sets
    for the canonical runner), and under `prepend` there is no synthesised `doublet`
    namespace package at all. Worse, the unconditional `import_module("doublet")` under
    `prepend` finds `compute/doublet.py` on the `sys.path` entry `load_compute` added and
    EXECUTES IT A SECOND TIME, leaving two module objects for one file — this guard was
    creating the duplicate it exists to prevent.

    So the mode is read and each mode gets the assertion that is true of it. What is
    asserted in BOTH is the part that is actually about our code: `load_compute()` returns
    the compute FILE, and it is the object this module bound.
    """
    import importlib

    mode = str(request.config.getoption("importmode"))

    loaded = load_compute()
    assert Path(loaded.__file__).resolve() == (_COMPUTE / "doublet.py").resolve()
    # …and it is the module the rest of this file actually bound.
    assert loaded is D

    if mode != "importlib":
        pytest.skip(
            f"the namespace-package hazard is specific to --import-mode=importlib; this "
            f"run resolved importmode={mode!r}. `packages/pytest.ini` sets importlib for "
            "the canonical runner, which is the configuration this guard is about.")

    bare = importlib.import_module("doublet")
    assert getattr(bare, "__file__", None) is None, (
        "`doublet` now resolves to a real module; the collision this guard documents has "
        "changed shape and load_compute's rationale must be re-read")
    assert Path(str(list(bare.__path__)[0])).resolve() == _PKG.resolve()
    assert loaded is not bare


def test_no_test_in_this_suite_imports_the_compute_module_by_bare_name():
    """The rule, enforced over the suite rather than remembered.

    `import doublet` is not a spelling mistake — it is the spelling that WORKED for the
    whole life of this branch and stopped working on merge. Nothing else stops it coming
    back in the next test somebody adds.
    """
    # `\bdoublet\b` after `import`, NOT an anchored end-of-line: the first version of this
    # guard matched `import doublet` and `import doublet as D` and nothing else, so
    # `import doublet, sys` — the identical silent hazard, one comma different — walked
    # straight past it. Anything that binds the bare name is an offender however it is
    # spelled. `from doublet import X` is deliberately NOT matched: it raises at import
    # time rather than handing back a namespace package, so it is the loud failure, not
    # the silent one this guard exists for.
    offenders = []
    for path in sorted(Path(__file__).resolve().parent.glob("*.py")):
        for i, line in enumerate(path.read_text().splitlines(), 1):
            if re.match(r"^\s*import\s+doublet\b(?!_)", line):
                offenders.append(f"{path.name}:{i}")
    assert not offenders, (
        "these import the compute module by bare name, which resolves to the package "
        f"directory under --import-mode=importlib; use load_compute(): {offenders}")

    # The guard's own reach, pinned — a grep guard is only as good as its pattern, and this
    # one already had a live blind spot (`import doublet, sys`) that a blind audit found by
    # planting it. These are the spellings that must be caught, and the ones that must not.
    caught = lambda line: bool(re.match(r"^\s*import\s+doublet\b(?!_)", line))
    for spelling in ("import doublet",
                     "import doublet as D",
                     "import doublet, sys",
                     "    import doublet as D"):
        assert caught(spelling), f"the guard would not catch {spelling!r}"
    for benign in ("import doublet_fixtures",
                   "from doublet_fixtures import load_compute",
                   "import doublet_compute"):
        assert not caught(benign), f"the guard falsely flags {benign!r}"


def test_load_compute_binds_OUR_shared_even_when_another_packages_won_the_flat_name():
    """TEST-28 — the #237 flat-name hazard, driven rather than reasoned about.

    Seven packages ship `compute/_shared.py` and three ship `compute/_criteria.py`, all
    imported by their computes under those BARE names, with no `__init__.py` anywhere in
    this tree. So `sys.modules["_shared"]` binds to whichever suite imported it FIRST, and a
    per-package run and a full-tree `just check-py` therefore measure DIFFERENT module
    graphs. Doublet's `_shared` carries 26 names clustering's does not — the entire
    peak-memory model and `MISSING_VALUE_SENTINELS` among them — so binding the wrong one is
    not a subtle difference, it is an AttributeError in the ceiling tests.

    Production is immune: a real run is a fresh subprocess with `/code` as `sys.path[0]`.
    Only the in-process load is exposed, and it was exposed identically before
    `load_compute` existed. This test drives the hazard in a SUBPROCESS — the collision is
    a property of a fresh interpreter's `sys.modules`, and staging it in-process would
    either pollute this session's modules for every test that runs after, or be defeated by
    whatever this session has already imported.
    """
    import json
    import subprocess
    import textwrap

    packages = _PKG.parent
    script = textwrap.dedent(f"""
        import json, pathlib, sys
        pk = {str(packages)!r}
        # clustering's `_shared` deliberately wins the flat name FIRST.
        for p in ("_lib", "_helpers", "clustering/compute"):
            sys.path.insert(0, str(pathlib.Path(pk) / p))
        import _shared as intruder
        sys.path.insert(0, str(pathlib.Path(pk) / "doublet" / "tests"))
        from doublet_fixtures import load_compute
        D = load_compute()
        print(json.dumps({{
            "compute": D.__file__,
            "shared": D.S.__file__,
            "criteria": D.CR.__file__,
            "intruder": intruder.__file__,
            "global_shared_after": sys.modules["_shared"].__file__,
            "has_peak_model": hasattr(D.S, "_peak_bytes"),
        }}))
    """)
    proc = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stderr[-2000:]
    got = json.loads(proc.stdout.strip().splitlines()[-1])

    # The control: the intruder really did win the flat name, so this is not a test that
    # passes because the collision never happened.
    assert Path(got["intruder"]).parent.parent.name == "clustering", got["intruder"]

    ours = (_PKG / "compute").resolve()
    assert Path(got["compute"]).resolve() == (ours / "doublet.py")
    assert Path(got["shared"]).resolve() == (ours / "_shared.py"), (
        "the compute bound another package's `_shared`; the ceiling model is not even "
        "present on it")
    assert Path(got["criteria"]).resolve() == (ours / "_criteria.py")
    assert got["has_peak_model"] is True

    # …and the global binding is put back, so loading our compute cannot change what the
    # NEXT package's suite sees. A fix that leaked would trade our bug for everyone's.
    assert got["global_shared_after"] == got["intruder"]


def test_no_test_module_imports_the_sibling_helpers_by_bare_name():
    """TEST-30 — the guard for the failure only a FULL-TREE run could show.

    A blind audit reported this hazard as LATENT, reasoning from a grep that every other
    package's `import _shared` is function-level and so runs after collection. The grep was
    right and the conclusion was wrong: those function-level imports still run BEFORE
    doublet's tests, because `pytest.ini` lists `doublet/tests` LAST. A full-tree
    `just check-py` failed six doublet tests with `AttributeError: module '_shared' has no
    attribute 'MISSING_VALUE_SENTINELS'` / `'HistogramRefused'` while the same tests passed
    standalone. That is why the gate is the whole runner and not the per-package suite.

    Parsed with `ast`, not grepped, for a reason that bit during the repair: two of these
    imports live INSIDE f-string subprocess scripts, where the bare form is CORRECT — a
    fresh interpreter with `compute/` as `sys.path[0]` has no collision, and
    `doublet_fixtures` is not importable there. A line-based guard cannot tell those from
    real ones; a blanket rewrite that ignored the difference broke the ceiling test. `ast`
    does not look inside string literals, so it draws exactly the right line.
    """
    import ast

    offenders = []
    for path in sorted(Path(__file__).resolve().parent.glob("*.py")):
        if path.name == "doublet_fixtures.py":
            continue          # the helper that loads them by file location, by design
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    if alias.name in ("_shared", "_criteria"):
                        offenders.append(f"{path.name}:{node.lineno} import {alias.name}")
            elif isinstance(node, ast.ImportFrom) and node.module in ("_shared", "_criteria"):
                offenders.append(f"{path.name}:{node.lineno} from {node.module}")
    assert not offenders, (
        "these bind a sibling helper by its BARE name, which resolves to whichever "
        "package's copy the tree imported first (#237); use doublet_fixtures.load_shared() "
        f"/ load_criteria(): {offenders}")


def test_the_compute_and_the_tests_share_ONE_sibling_module_object():
    """The other half of TEST-30, and the defect the first repair introduced.

    Routing the tests through `load_shared()` while `load_compute()` loaded its own copy
    gave the compute a DIFFERENT `HistogramRefused` class object from the one a test holds,
    so `pytest.raises(S.HistogramRefused)` no longer caught the compute's raise — two module
    objects for one source file, which is the exact failure this machinery exists to
    prevent, reintroduced by the fix for it. Identity is the assertion; equality of names
    would not have caught it.
    """
    from doublet_fixtures import load_criteria, load_shared

    compute = load_compute()
    assert compute.S is load_shared()
    assert compute.CR is load_criteria()
    # …and they really are ours, not a sibling package's that happens to be loaded.
    assert Path(compute.S.__file__).resolve() == (_COMPUTE / "_shared.py").resolve()
    assert Path(compute.CR.__file__).resolve() == (_COMPUTE / "_criteria.py").resolve()
