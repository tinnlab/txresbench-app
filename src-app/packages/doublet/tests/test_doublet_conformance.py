#!/usr/bin/env python3
# ruff: noqa
"""TEST-10 [covers: ITEM-23] — POST-INGEST CONFORMANCE.

Every store this run emits must pass the SAME gate the platform runs out-of-process after
ingest (`_lib/conformance.py`, driven by the `jobs::conformance` verification processor):
the group's `attributes.cyto` must equal the producer's declared `structure`, and every
member node must stamp its own.

── Why this is not ceremony (#73) ──────────────────────────────────────────────────────
A job can report COMPLETED with exit 0 while its output artifact lands `failed`. That is the
exact trap here: a green run whose columns never became usable artifacts, with the doublet
score and call absent from every picker and every colour-by while the job list shows a tick.
So the assertion is on the ARTIFACT's conformance, never on the exit code — `run_ok()` has
already checked the exit code and it proves nothing about this.

For the CATEGORICAL call column specifically, `_REQUIRED_STAMPED_KEYS["categorical"]` demands
`kind`, `levels` AND `ordered` on the stamp, because a store-URL consumer resolves codes
through the STAMPED level set: absent, `read_column` returns the raw integer codes, which is
"a different type carrying different values" rather than a missing nicety. That is the
concrete reason the call is a `pd.Categorical` and not a numpy bool.
"""
import json
from pathlib import Path

import pytest

import conformance

from doublet_fixtures import require_skimage, structured_counts

PARAMS = {"n_prin_comps": 10}


def _cyto(store_dir):
    doc = json.loads((Path(store_dir) / "zarr.json").read_text())
    return (doc.get("attributes") or {}).get("cyto")


def _run(detect_run, *, filtered=False, batched=False):
    dense = structured_counts(40, 90, n_groups=3, seed=0)
    n = dense.shape[0]
    run = detect_run()
    run.add_matrix(dense)
    run.add_cells_index([f"BC{i}" for i in range(n)])
    params = dict(PARAMS)
    if batched:
        run.add_column(["S1"] * (n // 2) + ["S2"] * (n - n // 2), slot="batch", name="sample")
        params["batch_column"] = "sample"
    if filtered:
        run.add_column([1.0] * (n - 20) + [0.0] * 20, slot="column:qc", name="qc")
        params["criteria"] = [{"column": "qc", "min": "0.5"}]
    run.run_ok(params)
    return run


@pytest.mark.parametrize("shape", ["plain", "batched", "filtered", "both"])
def test_every_emitted_store_conforms_against_its_declaration(detect_run, shape):
    """All four shapes, because the FILTERED one is the interesting case: it declares a
    third level, and a level set that disagreed between the stamp and the manifest entry
    would fail exactly here rather than silently mislabelling cells downstream."""
    require_skimage()
    run = _run(detect_run,
               filtered=shape in ("filtered", "both"),
               batched=shape in ("batched", "both"))

    violations = conformance.conform_outputs(run.outputs_dir)
    assert violations == [], violations


def test_the_categorical_call_stamps_kind_levels_and_ordered(detect_run):
    require_skimage()
    run = _run(detect_run)
    entry = run.entry("doublet_call")
    assert entry is not None

    stamp = _cyto(run.outputs_dir / entry["path"])
    assert stamp is not None, "the call store carries no attributes.cyto stamp"
    # the group stamp must EQUAL the producer's declared structure — two copies of one
    # declaration, which is what the gate compares
    assert stamp == entry["structure"]

    member = _cyto(run.outputs_dir / entry["path"] / "values")
    assert member is not None, "the `values` member node stamps nothing"
    for key in ("kind", "levels", "ordered"):
        assert key in member, (key, member)
    assert member["kind"] == "categorical"
    assert member["levels"] == ["singlet", "doublet"]
    assert member["ordered"] is False


def test_a_bool_call_column_could_not_have_carried_the_third_state(detect_run):
    """The decision made executable. `write_metadata_column`'s BOOL branch hard-codes
    `meta["levels"] = ["false","true"]` and writes a plain bool array with no
    `attributes.cyto.levels` to fall back to — so it cannot express `not_evaluated`, and
    `False` would mean both "singlet" and "we never looked".

    This reads the shipped writer's own source rather than asserting the claim, so the day
    the bool branch gains a third state this test says so instead of quietly staying true.
    """
    import inspect

    import cyto_columns

    source = inspect.getsource(cyto_columns.write_metadata_column)
    assert '"levels": ["false", "true"]' in source or "'levels': ['false', 'true']" in source \
        or '["false","true"]' in source.replace(" ", ""), (
        "the bool branch's hard-coded two-level display set has moved; re-check whether a "
        "bool column can now carry a third state")

    require_skimage()
    run = _run(detect_run, filtered=True)
    entry = run.entry("doublet_call")
    member = _cyto(run.outputs_dir / entry["path"] / "values")
    assert member["levels"] == ["singlet", "doublet", "not_evaluated"]
    assert entry["meta"]["n_levels"] == 3


def test_the_score_column_declares_aligned_to_and_not_a_key_sequence(detect_run):
    """`structure.aligned_to` is what names the ROW SPACE these values belong to.

    Stated precisely, because the looser version of this claim is wrong: an UNDECLARED
    alignment is `alignmentState` A3, and `rowSpaceColumns.ts` drops only A2 (aligned to a
    DIFFERENT row space) and A4 (provably disjoint members). So an A3 column is still
    OFFERED by the colour-by — it is marked alignment-not-declared, not hidden. What
    `aligned_to` buys is the positive statement, and the writer's own contract is that its
    absence is "a real state the viewer renders rather than a silent pass".

    NOTE the shipped run form does not bind `cells_index`, here or in `embedding.reduce`, so
    on a form-launched run this is absent by construction — a platform gap reported rather
    than papered over. This test drives the slot the way an agent/MCP launch can.

    `key_sequence_digest` must NOT be declared either way: that would claim this artifact IS
    the axis, which it is not.
    """
    require_skimage()
    run = _run(detect_run)
    entry = run.entry("doublet_score")
    structure = entry["structure"]

    assert structure.get("aligned_to"), "the score column declares no row space"
    assert "key_sequence_digest" not in structure
    assert "key" not in structure

    # the stamp on disk agrees with the declaration (the gate's own comparison)
    assert _cyto(run.outputs_dir / entry["path"]) == structure


def test_the_report_is_a_declared_opaque_artifact(detect_run):
    require_skimage()
    run = _run(detect_run)
    entry = run.entry("doublet-report")
    assert entry["datatype"] == "report/qc"
    assert entry["layout"] == "opaque"
    assert entry["structure"] == {"encoding": "opaque", "media_type": "application/json"}
    assert entry["meta"]["kind"] == "doublet-report"
    # …and the bytes really are the JSON the media type claims
    json.loads((run.outputs_dir / entry["path"]).read_text())


def test_the_manifest_stays_far_inside_its_declared_caps(detect_run):
    """`/outputs/manifest.json` is capped at 1 MiB / 512 entries and the run FAILS past it.
    The histogram is the only unbounded-looking thing this package emits, so this pins that
    it lives in the REPORT (which is an artifact) and not in the manifest `meta`."""
    require_skimage()
    run = _run(detect_run, batched=True)
    raw = (run.outputs_dir / "manifest.json").read_text()
    assert len(raw.encode()) < 32 * 1024, len(raw)
    assert len(run.entries()) <= 8
    for entry in run.entries():
        assert "sim_score_histogram" not in json.dumps(entry)


# ── the pre-read ceiling gate ──────────────────────────────────────────────────────
def test_the_declared_nnz_is_verified_against_what_was_actually_read(detect_run):
    """The gate sizes the run from the DECLARED `nnz`. A store that declares `nnz: 1` while
    holding millions of stored values would sail through the pre-read budget and then be read
    in full — defeating the gate as completely as a missing `nnz` would, and `sp.csc_matrix`
    runs `check_format(full_check=False)` so it would not object either. The declaration is
    therefore checked against what arrived."""
    import json

    run = detect_run()
    store = run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    meta = store / "zarr.json"
    doc = json.loads(meta.read_text())
    doc["attributes"]["cyto"]["nnz"] = 1
    meta.write_text(json.dumps(doc))

    proc = run.run(PARAMS)
    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert "declares nnz=1" in diag, diag
    assert "false statement of its own size" in diag


def test_a_malformed_nnz_fails_closed_by_name(detect_run):
    import json

    run = detect_run()
    store = run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    meta = store / "zarr.json"
    doc = json.loads(meta.read_text())
    doc["attributes"]["cyto"]["nnz"] = "lots"
    meta.write_text(json.dumps(doc))

    proc = run.run(PARAMS)
    assert proc.returncode != 0
    assert "not a count" in run.diagnostics(proc)


def test_the_ceiling_env_seams_can_only_LOWER_a_budget(detect_run):
    """The seams exist so a refusal can be exercised without a 4 GiB fixture, and the module
    comment promises they "only ever LOWER a budget, never lift a real limit". That promise
    was previously documentation rather than code: `DOUBLET_MEMORY_BUDGET_BYTES=99999999999`
    lifted the memory ceiling above the sandbox's real limit and
    `DOUBLET_CPU_SECS_PER_MNNZ=0` disabled the time gate outright. Now it is enforced."""
    import sys
    from pathlib import Path

    compute = Path(__file__).resolve().parents[1] / "compute"
    sys.path.insert(0, str(compute))

    # LOWERING works: a 1-byte memory budget refuses even a tiny matrix.
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    proc = run.run(PARAMS, env_extra={"DOUBLET_MEMORY_BUDGET_BYTES": "1"})
    assert proc.returncode != 0
    assert "MEMORY ceiling" in run.diagnostics(proc)

    # LIFTING does not: an absurd budget is clamped back to the hard default, and a
    # zero-cost-per-nnz estimate cannot switch the time gate off.
    for env, name in (({"DOUBLET_MEMORY_BUDGET_BYTES": "99999999999"}, "memory"),
                      ({"DOUBLET_CPU_SECS_BUDGET": "99999"}, "cpu budget"),
                      ({"DOUBLET_CPU_SECS_PER_MNNZ": "0"}, "cpu rate"),
                      ({"DOUBLET_MEMORY_BUDGET_BYTES": "not-a-number"}, "malformed")):
        require_skimage()
        ok = detect_run()
        ok.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
        ok.run_ok(PARAMS, env_extra=env)
        ceiling = ok.report()["ceiling"]
        assert ceiling["memory_budget_bytes"] <= 8 * 1024 ** 3, (name, ceiling)
        assert ceiling["cpu_seconds_budget"] <= 600.0, (name, ceiling)
        assert ceiling["estimated_cpu_seconds"] > 0, (name, ceiling)


def test_the_peak_estimate_scales_with_the_simulated_set(detect_run):
    """`sim_doublet_ratio` decides how many simulated rows are held beside the observed
    matrix, and it was absent from the memory model entirely — leaving the memory bound
    unbounded above through a knob the form exposes."""
    require_skimage()
    small, large = detect_run(), detect_run()
    for run, ratio in ((small, "2.0"), (large, "6.0")):
        run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
        run.run_ok(dict(PARAMS, sim_doublet_ratio=ratio))

    a, b = small.report()["ceiling"], large.report()["ceiling"]
    assert a["sim_doublet_ratio"] == 2.0 and b["sim_doublet_ratio"] == 6.0
    assert b["estimated_peak_bytes"] > a["estimated_peak_bytes"]
    assert b["estimated_cpu_seconds"] > a["estimated_cpu_seconds"]


def test_a_row_index_outside_the_declared_cell_count_is_refused(detect_run):
    """The other half of the pre-read gate's belt, which shipped with no test at all beside a
    sibling that got two.

    `sp.csc_matrix` runs `check_format(full_check=False)` and does NOT bound-check indices, so
    a store whose `indices` name a row beyond the declared cell count would be accepted here
    and surface much later as a confusing slicing error — or, worse, read values into the
    wrong cells."""
    import json

    import numpy as np

    run = detect_run()
    store = run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    # shrink the DECLARED cell count so the (unchanged) stored row indices now overrun it
    meta = store / "zarr.json"
    doc = json.loads(meta.read_text())
    doc["attributes"]["cyto"]["shape"] = [10, 90]
    meta.write_text(json.dumps(doc))

    proc = run.run(PARAMS)
    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert "carries a row index outside" in diag, diag
    assert "wrong cells" in diag
    assert not (run.outputs_dir / "manifest.json").exists()


def test_the_lifting_attempts_leave_the_hard_defaults_exactly_in_place(detect_run):
    """Tighter than "the budget is <= the hard default": asserts it EQUALS it.

    The earlier loop asserted `<=`, which is satisfied by a budget that was never touched AND
    by one that was lowered — so for two of its four env settings both budget assertions were
    idle. Equality is the statement that actually says "the lift was rejected"."""
    require_skimage()
    for env in ({"DOUBLET_MEMORY_BUDGET_BYTES": "99999999999"},
                {"DOUBLET_CPU_SECS_BUDGET": "99999"},
                {"DOUBLET_CPU_SECS_PER_MNNZ": "0"},
                {"DOUBLET_MEMORY_BUDGET_BYTES": "not-a-number"},
                {"DOUBLET_MEMORY_BUDGET_BYTES": "1e999"},
                {"DOUBLET_MEMORY_BUDGET_BYTES": "100000000000000000000"},
                {"DOUBLET_CPU_SECS_BUDGET": "-5"}):
        run = detect_run()
        run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
        run.run_ok(PARAMS, env_extra=env)
        ceiling = run.report()["ceiling"]
        assert ceiling["memory_budget_bytes"] == 8 * 1024 ** 3, (env, ceiling)
        assert ceiling["cpu_seconds_budget"] == 600.0, (env, ceiling)


def test_the_peak_model_is_the_measured_one_and_is_recorded(detect_run):
    """The model is fitted to real peak RSS, not counted from the source — two earlier
    versions were counted and both were wrong. The report carries the model's terms so a
    reader can reproduce the arithmetic in a refusal rather than taking it on trust."""
    require_skimage()
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok(PARAMS)

    model = run.report()["ceiling"]["peak_model"]
    assert set(model) == {"base_bytes", "bytes_per_nnz_global", "bytes_per_nnz_pop",
                          "bytes_per_nnz_per_sim", "bytes_per_cell_per_sim", "n_cells",
                          "nnz_pop", "largest_population_cells", "fitted_to"}
    assert model["n_cells"] == 120
    assert "measured peak RSS" in model["fitted_to"]
    # unbatched: the largest population IS the whole matrix
    assert model["largest_population_cells"] == 120
    assert model["nnz_pop"] == run.report()["ceiling"]["nnz"]

    ceiling = run.report()["ceiling"]
    expected = int(model["base_bytes"]
                   + ceiling["nnz"] * model["bytes_per_nnz_global"]
                   + model["nnz_pop"] * model["bytes_per_nnz_pop"]
                   + model["nnz_pop"] * ceiling["sim_doublet_ratio"]
                   * model["bytes_per_nnz_per_sim"]
                   + model["largest_population_cells"] * (1 + ceiling["sim_doublet_ratio"])
                   * model["bytes_per_cell_per_sim"])
    assert ceiling["estimated_peak_bytes"] == expected, (
        "the recorded terms do not reproduce the recorded estimate, so a reader checking a "
        "refusal's arithmetic would get a different number than the gate used")


def test_the_schedule_class_matches_the_budget_the_compute_enforces():
    """The manifest's `schedule.class` and the compute's memory ceiling are two halves of one
    statement, and a disagreement is invisible until a run dies: the class is what the sandbox
    actually grants, and the ceiling is what the compute refuses above. If the class said
    `batch` (8 GiB) while the ceiling still refused at 4 GiB, half the granted envelope would
    be unreachable; if it said `normal` while the ceiling admitted 8 GiB, the gate would wave
    through runs the cgroup then OOM-kills — which is the exact failure a pre-read gate exists
    to prevent.
    """
    import sys
    from pathlib import Path

    import yaml

    pkg = Path(__file__).resolve().parents[1]
    sys.path.insert(0, str(pkg / "compute"))
    from doublet_fixtures import load_shared

    S = load_shared()

    analysis = yaml.safe_load((pkg / "manifest.yaml").read_text())["contributes"]["analyses"][0]
    declared = analysis["schedule"]["class"]

    # the budgets `sandbox/settings.rs` grants per class
    granted = {"interactive": 4 * 1024 ** 3, "normal": 4 * 1024 ** 3, "batch": 8 * 1024 ** 3}
    assert declared in granted, declared
    assert S._MEM_BUDGET_HARD == granted[declared], (
        f"the manifest declares `{declared}` ({granted[declared] / 1024**3:.0f} GiB) but the "
        f"compute's ceiling is {S._MEM_BUDGET_HARD / 1024**3:.0f} GiB")


def test_the_ceiling_is_sized_on_the_LARGEST_POPULATION_not_the_merged_total(detect_run):
    """The gate used to size every term on the MERGED matrix even though each Scrublet call
    sees ONE population — so it was systematically most hostile to exactly the merged
    multi-sample matrices the per-sample split exists for. The epic's own motivating case
    (5 x 10k cells) was refused outright, while the run it would actually perform is five
    independent 10k-cell fits.

    The batch column is read BEFORE the gate (it is a 1-D column, not the matrix) so the
    largest level can be sized on. This asserts the estimate for a batched run is strictly
    SMALLER than for the same matrix unbatched, and that the model records which population
    it sized on.
    """
    require_skimage()
    dense = structured_counts(40, 90, n_groups=3, seed=0)
    n = dense.shape[0]

    batched = detect_run()
    batched.add_matrix(dense)
    batched.add_column(["S1"] * (n // 2) + ["S2"] * (n - n // 2), slot="batch", name="sample")
    batched.run_ok(dict(PARAMS, batch_column="sample"))

    unbatched = detect_run()
    unbatched.add_matrix(dense)
    unbatched.run_ok(PARAMS)

    b, u = batched.report()["ceiling"], unbatched.report()["ceiling"]
    assert b["peak_model"]["largest_population_cells"] == n // 2
    assert u["peak_model"]["largest_population_cells"] == n
    assert b["estimated_peak_bytes"] < u["estimated_peak_bytes"], (
        "a batched run was sized as though it scored the whole matrix at once")
    # …but the CPU estimate is unchanged: every population is still scored.
    assert b["estimated_cpu_seconds"] == u["estimated_cpu_seconds"]


# ── the ceiling gate, driven DIRECTLY ──────────────────────────────────────────────
def test_the_ceiling_gate_is_exercised_directly_not_only_through_a_run():
    """Two behaviours shipped with no coverage because every existing test reaches the gate
    only through a real run, where the one caller cannot produce a bad value: the
    `largest_population_cells` refusal, and the model's agreement with its own six measured
    points. `ceiling_refuse_if_over` is this module's PUBLIC gate — a future caller can pass
    what the current one cannot."""
    import subprocess
    import sys
    from pathlib import Path

    compute = Path(__file__).resolve().parents[1] / "compute"
    lib = Path(__file__).resolve().parents[2] / "_lib"

    # the six measured points: the model must never sit BELOW a measurement
    script = f'''
import sys
sys.path.insert(0, {str(compute)!r}); sys.path.insert(0, {str(lib)!r})
import _shared as S  # noqa: E402  (a FRESH interpreter: no flat-name collision here)
pts = [(700,591747,2.0,378),(1400,1184471,2.0,529),(2700,2286884,2.0,877),
       (2700,2286884,6.0,1818),(2700,810640,2.0,460),(2700,288281,2.0,333)]
worst = 100.0
for c, n, r, measured in pts:
    est = S._peak_bytes(n, n, c, r) / 1024**2
    pct = 100.0 * (est - measured) / measured
    assert pct >= 0, ("UNDER-estimates at", c, n, r, round(pct, 1))
    worst = min(worst, pct)
print("OK", round(worst, 1))
'''
    out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
    assert out.returncode == 0, out.stdout + out.stderr
    assert out.stdout.startswith("OK"), out.stdout

    # a population size the current caller cannot produce, but the public gate can be handed
    for bad in (-5, 0, 10 ** 9, True, 1.5, "40"):
        script = f'''
import sys
sys.path.insert(0, {str(compute)!r}); sys.path.insert(0, {str(lib)!r})
import _shared as S  # noqa: E402  (a FRESH interpreter: no flat-name collision here)
S.set_prefix("doublet.detect")
S.ceiling_refuse_if_over({{"nnz": 1000, "shape": [100, 50]}},
                         sim_doublet_ratio=2.0, largest_population_cells={bad!r})
print("ACCEPTED")
'''
        out = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
        assert out.returncode != 0, f"largest_population_cells={bad!r} was accepted"
        assert "doublet.detect:" in out.stderr, (bad, out.stderr[-400:])
        assert "largest_population_cells" in out.stderr, (bad, out.stderr[-400:])


# ── the capacity figures, computed rather than written down ────────────────────────
#: The measured points the model must bound from above. Raw data; it does not drift.
MEASURED_PEAKS = [
    # cells,      nnz, sim_ratio, peak MiB
    (700, 591_747, 2.0, 378),
    (1_400, 1_184_471, 2.0, 529),
    (2_700, 2_286_884, 2.0, 877),
    (2_700, 2_286_884, 6.0, 1_818),
    (2_700, 810_640, 2.0, 460),     # gene-subset, cells held fixed
    (2_700, 288_281, 2.0, 333),     # gene-subset, cells held fixed
    # LOW-RATIO sweep. Every earlier calibration point was at r in {2, 6}, so nothing pinned
    # the intercept and a model linear in `r` extrapolated BELOW the real floor — measured
    # -16% at r=0.1, and `sim_doublet_ratio: 0.1` is a supported value the refusal message
    # itself recommends. These three are why `_peak_bytes` clamps the ratio at 1.0.
    (2_700, 2_286_884, 1.0, 639),
    (2_700, 2_286_884, 0.5, 568),
    (2_700, 2_286_884, 0.1, 567),
]

CLASS_BUDGETS = {"normal": 4 * 1024 ** 3, "batch": 8 * 1024 ** 3}


def _peak_model():
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "compute"))
    from doublet_fixtures import load_shared

    S = load_shared()
    return S


def test_the_model_never_under_estimates_a_measured_peak():
    """The ONE testable requirement the constants have to meet. Everything else about the
    model — the fit method, the coefficient split, the narrative — has been wrong at least
    once; this has not, and it is the only property that matters for a gate whose job is to
    refuse before an OOM."""
    S = _peak_model()
    worst = None
    for cells, nnz, ratio, measured in MEASURED_PEAKS:
        estimate = S._peak_bytes(nnz, nnz, cells, ratio) / 1024 ** 2
        pct = 100.0 * (estimate - measured) / measured
        assert pct >= 0, (
            f"the model UNDER-estimates at {cells} cells / {nnz:,} nnz / r={ratio}: "
            f"{estimate:.0f} MiB vs a measured {measured} MiB ({pct:+.1f}%)")
        worst = pct if worst is None else min(worst, pct)
    # …and it is not absurdly loose either, which would refuse runs that would have fitted.
    # This asserts the BAND, not just its floor: an earlier version computed `worst`, printed
    # it, and never asserted it, so it passed at any over-estimate and could not catch a
    # stated accuracy band being wrong.
    assert worst < 40, f"the tightest margin is {worst:.1f}% — the model may be over-strict"
    loosest = max(100.0 * (S._peak_bytes(n, n, c, r) / 1024 ** 2 - m) / m
                  for c, n, r, m in MEASURED_PEAKS)
    assert loosest < 50, (
        f"the loosest margin is {loosest:.1f}% — the model over-estimates far enough to "
        "refuse runs that would have fitted comfortably")


def test_the_capacity_figures_follow_from_the_shipped_constants():
    """THE SINGLE SOURCE for what this analysis can process.

    Capacity is a FUNCTION of the peak-model constants. Written into a comment it went stale
    across a model change THREE times — and each time it was load-bearing for the
    `schedule.class` decision, so a stale number was not cosmetic. It is computed here
    instead, and the manifest and `_shared.py` deliberately quote no figures at all.

    The refuse/admit facts below are the honest scope of this analysis, and two of them are
    limitations rather than capabilities.
    """
    S = _peak_model()

    def capacity(budget, nnz_per_cell, ratio=2.0):
        """Largest unbatched cell count that fits, by bisection on the real model."""
        lo, hi = 1, 10_000_000
        while lo < hi:
            mid = (lo + hi + 1) // 2
            nnz = mid * nnz_per_cell
            if S._peak_bytes(nnz, nnz, mid, ratio) <= budget:
                lo = mid
            else:
                hi = mid - 1
        return lo

    def fits(cells, nnz_per_cell, budget, ratio=2.0, largest_pop=None):
        pop = largest_pop or cells
        nnz, nnz_pop = cells * nnz_per_cell, pop * nnz_per_cell
        return S._peak_bytes(nnz, nnz_pop, pop, ratio) <= budget

    PBMC3K, TEN_X_V3 = 847, 2500

    # `batch` roughly DOUBLES what `normal` can take — the entire reason for the deviation.
    for density in (PBMC3K, TEN_X_V3):
        n_normal = capacity(CLASS_BUDGETS["normal"], density)
        n_batch = capacity(CLASS_BUDGETS["batch"], density)
        assert n_batch > n_normal
        assert 1.8 < n_batch / n_normal < 2.3, (density, n_normal, n_batch)

    # A single typical 10x v3 lane: `normal` refuses it, `batch` takes it. This is the
    # concrete thing the class change buys.
    assert not fits(10_000, TEN_X_V3, CLASS_BUDGETS["normal"])
    assert fits(10_000, TEN_X_V3, CLASS_BUDGETS["batch"])

    # …and here is what it does NOT buy, asserted so the limitation cannot quietly lapse.
    # The research doc §5's own worked example is a 20,000-cell run; BOTH classes refuse it.
    for cls in ("normal", "batch"):
        assert not fits(20_000, TEN_X_V3, CLASS_BUDGETS[cls]), cls

    # §4.3's 5 x 10,000-cell merged matrix — the epic's motivating case — is refused by both
    # at 10x v3 depth even WITH per-population sizing, and admitted by both at pbmc3k depth.
    # The analysis is depth-bound, not just cell-bound.
    for cls in ("normal", "batch"):
        assert not fits(50_000, TEN_X_V3, CLASS_BUDGETS[cls], largest_pop=10_000), cls
    assert fits(50_000, PBMC3K, CLASS_BUDGETS["normal"], largest_pop=10_000)

    # per-population sizing is what makes the batched case cheaper than the unbatched one
    assert (S._peak_bytes(50_000 * PBMC3K, 10_000 * PBMC3K, 10_000, 2.0)
            < S._peak_bytes(50_000 * PBMC3K, 50_000 * PBMC3K, 50_000, 2.0))


def test_a_low_sim_doublet_ratio_is_sized_at_its_MEASURED_floor(detect_run):
    """`sim_doublet_ratio` below 1 must not shrink the estimate below the measured floor.

    The peak is FLAT under r~=0.5 (567 MiB at r=0.1, 568 at r=0.5, against 639 at r=1), so a
    model linear in `r` extrapolates under it. That was live and reachable: `SIM_RATIO_MIN` is
    0.1, and the memory refusal names "a smaller `sim_doublet_ratio`" as a lever — so the
    documented escape from a refusal steered the user into the one regime where the gate
    under-estimated by up to 23%.
    """
    S = _peak_model()
    nnz, cells = 2_286_884, 2_700
    at_one = S._peak_bytes(nnz, nnz, cells, 1.0)
    for low in (0.1, 0.25, 0.5, 0.9):
        assert S._peak_bytes(nnz, nnz, cells, low) == at_one, (
            f"r={low} is sized below the r=1 floor")
    # …and above 1 it still grows, or the clamp would have flattened the whole model
    assert S._peak_bytes(nnz, nnz, cells, 2.0) > at_one
    assert S._peak_bytes(nnz, nnz, cells, 6.0) > S._peak_bytes(nnz, nnz, cells, 2.0)

    # the clamp is in the SIZING only — the run still uses the ratio it was given
    require_skimage()
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok(dict(PARAMS, sim_doublet_ratio="0.5"))
    assert run.report()["parameters"]["sim_doublet_ratio"] == 0.5
    assert run.report()["ceiling"]["sim_doublet_ratio"] == 0.5


def test_a_non_finite_threshold_is_a_NAMED_refusal_not_a_traceback(detect_run):
    """`_histogram` raises when it cannot place a cut. That exception is thrown from inside
    the per-population loop, OUTSIDE the `try` that catches `ScoringRefused`, and `main()` is
    invoked bare — so without `_safe_histogram` it reaches the user as a raw traceback, which
    is exactly what this compute's contract forbids. Neither the exception type nor the
    wrapper had any coverage."""
    import sys
    from pathlib import Path

    compute = Path(__file__).resolve().parents[1] / "compute"
    lib = Path(__file__).resolve().parents[2] / "_lib"
    sys.path.insert(0, str(compute))
    sys.path.insert(0, str(lib))
    from doublet_fixtures import load_shared

    S = load_shared()
    from doublet_fixtures import load_compute

    D = load_compute()

    # the raiser
    for bad in (float("nan"), float("inf"), float("-inf")):
        try:
            D._histogram([0.1, 0.2, 0.3], threshold=bad)
        except S.HistogramRefused as exc:
            assert "cannot define a cut" in str(exc)
        else:
            raise AssertionError(f"threshold={bad!r} was accepted")

    # …including when the score vector is EMPTY, which an earlier ordering let slip past
    try:
        D._histogram([], threshold=float("nan"))
    except S.HistogramRefused:
        pass
    else:
        raise AssertionError("an empty vector let a NaN threshold through")

    # a finite threshold still works, and an absent one is legal
    assert D._histogram([0.1, 0.9], threshold=0.5)["rows"]
    assert D._histogram([0.1, 0.9], threshold=None)["rows"][0]["above_threshold"] is None
