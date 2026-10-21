#!/usr/bin/env python3
# ruff: noqa
"""TEST-9 + TEST-10 — inputs are resolved by SLOT, and every bad input is a NAMED refusal.

Two properties, both of which fail SILENTLY or UGLY without a test:

  * inputs come from the declared slot map, never from a filename. The harness mounts every
    artifact under a meaningless `in0`/`in1` name — the same thing the real runner does — so
    a compute that sniffed suffixes would work on a hand-made fixture and break in the
    sandbox.
  * a wrong input is refused BY NAME, before any byte of it is read where the declaration is
    enough to know. A 2-D layout bound as the embedding is the case that matters most: it
    runs perfectly and measures the picture instead of the data.

Mutation: resolve inputs by filename -> the slot tests fail because the mount names carry no
type. Read the matrix before the ceiling gate -> the refusal arrives after the read it was
supposed to prevent. Accept a continuous column as the partition -> the graph's nodes become
whatever a float column happened to be binned into.
"""
import numpy as np
import pytest

from trajectory_generators import branching_walk, cells_digest, embed

pytest.importorskip("scanpy")
pytest.importorskip("igraph")


@pytest.fixture(scope="module")
def fixture():
    counts, _tt, branch = branching_walk(n_per_branch=150, seed=0)
    return embed(counts), branch


# ── TEST-9 — resolution is BY SLOT ────────────────────────────────────────────────────
def test_inputs_are_resolved_by_slot_not_by_filename(paga_run, fixture):
    """The mounts are named `in0`/`in1` with no type in the name, and the partition is
    mounted FIRST — so a compute that took "the first mount" or sniffed a suffix gets the
    wrong artifact and fails."""
    emb, branch = fixture
    run = paga_run()
    run.add_partition(branch, name="branch")            # in0 — deliberately first
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))  # in1
    run.run_ok({"n_neighbors": 15})

    assert run.node_labels() == ["A", "B", "trunk"]
    assert run.report()["n_cells"] == emb.shape[0]


def test_a_missing_required_input_refuses_by_name(paga_run, fixture):
    emb, _branch = fixture
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    proc = run.run_fails({})

    diagnostics = run.diagnostics(proc)
    assert "no `partition` input bound" in diagnostics
    assert "does not invent a partition of its own" in diagnostics


def test_more_than_one_embedding_refuses_by_name(paga_run, fixture):
    emb, branch = fixture
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(branch, name="branch")
    proc = run.run_fails({})

    assert "bind exactly one" in run.diagnostics(proc)


# ── TEST-10 — the named refusals ──────────────────────────────────────────────────────
def test_a_2d_layout_bound_as_the_embedding_is_refused_by_name(paga_run, fixture):
    """The most dangerous wrong input in this analysis: it would RUN, and it would measure
    the picture rather than the data."""
    emb, branch = fixture
    run = paga_run()
    run.add_layout(emb)
    run.add_partition(branch, name="branch")
    proc = run.run_fails({})

    diagnostics = run.diagnostics(proc)
    assert "refuses to build the neighbour graph on a 2-D layout" in diagnostics
    assert "measures the picture, not the biology" in diagnostics


def test_the_layout_refusal_happens_before_the_matrix_is_read(paga_run, fixture):
    """Read off the DECLARATION, so it costs nothing and cannot be defeated by a large
    input. The progress stream is the evidence: the refusal lands at `preflight`, and the
    `read` phase never starts."""
    emb, branch = fixture
    run = paga_run()
    run.add_layout(emb)
    run.add_partition(branch, name="branch")
    proc = run.run_fails({})

    phases = run.progress_phases(proc)
    assert "preflight" in phases
    assert "read" not in phases, (
        f"the embedding was read before the refusal: phases={phases}")


def test_a_continuous_column_bound_as_the_partition_is_refused_by_name(paga_run, fixture):
    """Categorical-ness is a per-ARTIFACT property — the datatype declares no dtype at all —
    so the applicability check cannot express it and this refusal is the enforcement."""
    emb, _branch = fixture
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_continuous_column(np.linspace(0.0, 1.0, emb.shape[0]))
    proc = run.run_fails({})

    diagnostics = run.diagnostics(proc)
    assert "needs a\nCATEGORICAL column" in diagnostics or "CATEGORICAL" in diagnostics
    assert "binned into groups this analysis would have" in diagnostics


def test_a_partition_of_the_wrong_length_refuses_by_name(paga_run, fixture):
    emb, branch = fixture
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(list(branch)[:-5], name="branch")
    proc = run.run_fails({})

    assert "aligned over the same cells axis" in run.diagnostics(proc)


# ── the ceiling gate ──────────────────────────────────────────────────────────────────
def test_the_ceiling_gate_refuses_before_any_read_naming_the_ceiling_and_a_lever(
        paga_run, fixture):
    """The budget seam only ever LOWERS a budget, so the refusal is exercisable without a
    4 GiB fixture — and the refusal is what a real oversized run would hit."""
    emb, branch = fixture
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(branch, name="branch")
    proc = run.run_fails({}, env_extra={"TRAJECTORY_MEMORY_BUDGET_BYTES": "1024"})

    diagnostics = run.diagnostics(proc)
    assert "refusing before reading the embedding" in diagnostics
    assert "MEMORY ceiling" in diagnostics
    # names a lever the user can actually pull, and says what it is protecting them from.
    assert "smaller single dataset" in diagnostics
    assert "OOM-killed" in diagnostics
    assert "read" not in run.progress_phases(proc)


def test_the_time_ceiling_is_reported_separately_from_the_memory_one(paga_run, fixture):
    """Which ceiling was hit determines which lever helps, so they are distinct refusals
    rather than one 'too big'."""
    emb, branch = fixture
    run = paga_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(branch, name="branch")
    proc = run.run_fails({}, env_extra={"TRAJECTORY_CPU_SECS_BUDGET": "0.0001"})

    diagnostics = run.diagnostics(proc)
    assert "TIME ceiling" in diagnostics
    assert "CPU-seconds count parallelism, not wall clock" in diagnostics
    assert "timeout_secs" in diagnostics


def test_too_few_cells_refuses_rather_than_ordering_noise(dpt_run):
    """No cell is ever synthesized to reach the floor."""
    rng = np.random.default_rng(0)
    tiny = rng.normal(0.0, 1.0, (6, 8)).astype(np.float32)
    run = dpt_run()
    run.add_embedding(tiny, aligned_to=cells_digest(6))
    proc = run.run_fails({"root_mode": "diffusion_extreme"})

    diagnostics = run.diagnostics(proc)
    assert "below the viable floor" in diagnostics
    assert "no cell is ever synthesized" in diagnostics


def test_asking_the_distance_for_more_components_than_were_computed_refuses(dpt_run,
                                                                           fixture):
    emb, _branch = fixture
    run = dpt_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    proc = run.run_fails({"root_mode": "diffusion_extreme", "n_comps": 5, "n_dcs": 12})

    diagnostics = run.diagnostics(proc)
    assert "exceeds `n_comps`" in diagnostics


def test_an_unknown_disconnected_policy_refuses_rather_than_falling_back(dpt_run, fixture):
    emb, _branch = fixture
    run = dpt_run()
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    proc = run.run_fails({"root_mode": "diffusion_extreme", "on_disconnected": "ignore"})

    assert "must be `refuse` or `mark_missing`" in run.diagnostics(proc)


# ── the budget seams can only ever make the gate STRICTER ─────────────────────────────
#
# Round 1 clamped these and wrote a comment promising it; round 2 showed the promise was
# false (NaN defeats a clamp, because every comparison against NaN is False) AND that no test
# set a seam above its default, so reverting the clamp entirely would have gone unnoticed.
def _oversized(run, emb, branch):
    run.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    run.add_partition(branch, name="branch")


def test_a_seam_cannot_RAISE_the_memory_ceiling(paga_run, fixture):
    emb, branch = fixture
    # first prove the refusal is live at a lowered ceiling…
    low = paga_run(); _oversized(low, emb, branch)
    proc = low.run_fails({}, env_extra={"TRAJECTORY_MEMORY_BUDGET_BYTES": "1024"})
    assert "MEMORY ceiling" in low.diagnostics(proc)
    # …then that an ENORMOUS value cannot lift the real one. It is clamped to the class
    # limit, so a run inside that limit still succeeds and nothing was loosened.
    high = paga_run(); _oversized(high, emb, branch)
    high.run_ok({}, env_extra={"TRAJECTORY_MEMORY_BUDGET_BYTES": str(10**15)})
    assert high.report()["ceiling"]["memory_budget_bytes"] == 4 * 1024**3, (
        "the seam raised the memory ceiling above the resource class's real limit")


def test_a_seam_cannot_DISABLE_the_time_ceiling(paga_run, fixture):
    """The NaN case specifically. `min(nan, 600)` is `nan` and `x > nan` is always False, so
    a non-finite seam did not lower the ceiling — it deleted it, and the gate could never
    fire again. It also wrote a bare `NaN` token into the report, which is not valid JSON."""
    import json

    emb, branch = fixture
    run = paga_run(); _oversized(run, emb, branch)
    proc = run.run_fails({}, env_extra={"TRAJECTORY_CPU_SECS_PER_MCELL": "1e12",
                                        "TRAJECTORY_CPU_SECS_BUDGET": "nan"})
    assert "TIME ceiling" in run.diagnostics(proc), (
        "a non-finite seam disabled the time gate — the clamp was bypassed")

    # and a run that DOES complete under a non-finite seam writes a parseable report.
    ok = paga_run(); _oversized(ok, emb, branch)
    ok.run_ok({}, env_extra={"TRAJECTORY_CPU_SECS_BUDGET": "nan"})
    blob = (ok.outputs_dir / ok.REPORT).read_text()
    assert "NaN" not in blob, "a bare NaN token reached the report — that is invalid JSON"
    json.loads(blob)
    assert ok.report()["ceiling"]["cpu_seconds_budget"] == 600.0


def test_a_seam_cannot_make_the_cost_estimate_CHEAPER(paga_run, fixture):
    """The per-cost seam is clamped the other way, so zeroing it cannot talk the gate down."""
    emb, branch = fixture
    run = paga_run(); _oversized(run, emb, branch)
    run.run_ok({}, env_extra={"TRAJECTORY_CPU_SECS_PER_MCELL": "0"})
    ceiling = run.report()["ceiling"]
    assert ceiling["estimated_cpu_seconds"] > 0, "the cost estimate was zeroed by a seam"


def test_a_malformed_seam_falls_back_instead_of_dying_at_import(paga_run, fixture):
    """These are read at module import, before the diagnostic prefix exists, so a bare
    `int()` on a malformed value could not have been a named refusal by construction."""
    emb, branch = fixture
    run = paga_run(); _oversized(run, emb, branch)
    proc = run.run_ok({}, env_extra={"TRAJECTORY_MEMORY_BUDGET_BYTES": "4GiB"})
    assert "ignoring TRAJECTORY_MEMORY_BUDGET_BYTES" in proc.stderr
    assert run.report()["ceiling"]["memory_budget_bytes"] == 4 * 1024**3
