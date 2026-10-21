#!/usr/bin/env python3
# ruff: noqa
"""TEST-17 + TEST-18 + TEST-26 + TEST-27 — what the run RECORDS about itself.

For a trajectory the provenance is not bookkeeping around the result — the parameters ARE
the result. A pseudotime without its root, or an abstracted graph without its statistic
model, describes a different analysis than the one that ran. So the recorded set is asserted
field by field, including the pairs that are easy to conflate (how many diffusion components
were COMPUTED vs how many the DISTANCE uses, which differ by default upstream).

The disclosures are asserted as recorded TEXT, because they are the only mitigation for the
limitations no test in this package can close.

Mutation: drop a recorded parameter -> the field assertion names it. Record the library
versions through the deprecated attribute -> the version test's non-null assertion fails the
day upstream removes it, which is the whole point.
"""
import json

import numpy as np
import pytest

from trajectory_generators import barcodes, branching_walk, cells_digest, embed

pytest.importorskip("scanpy")
pytest.importorskip("igraph")
conformance = pytest.importorskip("conformance")


@pytest.fixture(scope="module")
def fixture():
    counts, _tt, branch = branching_walk(n_per_branch=150, seed=0)
    return embed(counts), branch


@pytest.fixture
def paga(paga_run, fixture):
    emb, branch = fixture
    r = paga_run()
    r.add_embedding(emb, aligned_to=cells_digest(emb.shape[0]))
    r.add_partition(branch, name="branch")
    r.run_ok({"n_neighbors": 15, "metric": "euclidean", "seed": 0})
    return r


@pytest.fixture
def dpt(dpt_run, fixture):
    emb, branch = fixture
    n = emb.shape[0]
    r = dpt_run()
    r.add_embedding(emb, aligned_to=cells_digest(n))
    r.add_partition(branch, slot="root_column", name="branch")
    r.add_keys(barcodes(n))
    r.run_ok({"root_mode": "root_cluster", "root_level": "trunk",
              "n_neighbors": 15, "n_comps": 15, "n_dcs": 10, "seed": 0})
    return r


# ── TEST-17 — the full recorded parameter set ─────────────────────────────────────────
def test_the_graph_run_records_every_parameter_it_honoured(paga):
    report = paga.report()
    params = report["parameters"]
    assert params["n_neighbors"] == 15
    assert params["metric"] == "euclidean"
    assert params["seed"] == 0
    assert params["neighbour_path"] in ("exact", "approximate")
    assert params["neighbour_path_switch_cells"] == 8192  # metric-appropriate, not a flat one
    assert report["model"] == "v1.2"
    assert report["inter_group_edges"] > 0
    assert report["n_nodes"] == 3
    assert report["partition"]["levels"] == ["A", "B", "trunk"]


def test_the_pseudotime_run_records_the_two_component_counts_separately(dpt):
    """They differ by default upstream (15 vs 10) and the library's own docstring flags the
    mismatch, so conflating them is an easy and invisible error."""
    params = dpt.report()["parameters"]
    assert params["n_comps"] == 15
    assert params["n_dcs"] == 10
    assert params["n_comps"] != params["n_dcs"]
    assert "different by default" in params["n_comps_vs_n_dcs_is"]
    assert params["random_state"] == params["seed"] == 0
    assert params["root_mode"] == "root_cluster"
    assert params["on_disconnected"] == "refuse"


def test_the_metric_is_recorded_as_a_choice_never_as_a_recommendation(paga, dpt):
    assert paga.report()["parameters"]["metric_is"] == "recorded, not recommended"
    assert dpt.report()["parameters"]["metric_is"] == "recorded, not recommended"


def test_the_statistic_model_is_recorded_with_WHY_it_matters(paga):
    report = paga.report()
    assert "DIFFERENT statistic" in report["model_is"]
    assert "only\ncomparable within one model" in report["model_is"] or \
           "comparable within one model" in report["model_is"]


def test_the_undeclarable_denominator_is_named_as_absent_rather_than_omitted(paga):
    """An honest absence, not a silent one: the library computes the expected-edge
    denominator and then does not export it, so the report says so instead of leaving a
    reader to wonder whether it was forgotten."""
    report = paga.report()
    assert report["expected_null_denominator"] is None
    why = report["expected_null_denominator_is"]
    assert "commented out" in why
    assert "second implementation" in why


def test_the_determinism_environment_is_read_out_of_the_RUNNING_process(paga, dpt):
    """Read from the child process's own environment, never scraped from source text — the
    only way to prove the pin actually took effect where it matters."""
    for run in (paga, dpt):
        env = run.report()["determinism_env"]
        assert env["NUMBA_CPU_NAME"] == "generic"
        for var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
                    "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS", "NUMBA_NUM_THREADS"):
            assert env[var] == "1", f"{var} is not pinned in the running compute"


def test_the_ceiling_arithmetic_is_recorded_so_a_refusal_is_reproducible(paga, dpt):
    for run in (paga, dpt):
        ceiling = run.report()["ceiling"]
        assert ceiling["n_cells"] == 450
        assert ceiling["estimated_resident_bytes"] > 0
        assert ceiling["memory_budget_bytes"] > 0
        assert ceiling["cpu_seconds_budget"] > 0
    # the pseudotime path additionally sizes the diffusion basis, which the graph path has
    # no need of — so the two estimates are genuinely different rather than copied.
    assert paga.report()["ceiling"]["diffmap_bytes_per_cell"] == 0
    assert dpt.report()["ceiling"]["diffmap_bytes_per_cell"] > 0


def test_the_disclosures_travel_with_the_result_as_recorded_text(paga, dpt):
    """The limitations no test can close are shipped ON the artifact, in words."""
    graph_disclosures = paga.report()["disclosures"]
    assert "not a probability" in graph_disclosures["connectivity_is_not_a_probability"]
    assert "HARD-CAPPED AT 1" in graph_disclosures["connectivity_is_not_a_probability"]
    assert "INPUT" in graph_disclosures["only_as_good_as_the_partition"]
    assert "confident-looking ordering of nothing" in \
        graph_disclosures["no_method_tests_that_a_trajectory_EXISTS"]

    pt_disclosures = dpt.report()["disclosures"]
    assert "ORDERING, not a time" in pt_disclosures["pseudotime_is_not_time"]
    assert "no units" in pt_disclosures["pseudotime_is_not_time"]
    assert "DIFFERENT RESULT" in pt_disclosures["the_root_determines_everything"]
    assert "biological assertion" in pt_disclosures["the_root_determines_everything"]

    # The three added after the design-conformance angle found them missing entirely. They
    # are asserted on the ARTIFACT, not just in the manifest, because a reader of a result
    # has only the artifact.
    for key, phrase in (("the_capability_gap_of_this_method", "no fate probabilities"),
                        ("no_method_is_best_at_this", "NO universal winner")):
        assert phrase in graph_disclosures[key], key
        assert phrase in pt_disclosures[key], key
    assert "backwards-incompatible release" in \
        pt_disclosures["a_numerical_change_is_scheduled_upstream"]
    # …and the graph analysis does NOT carry the pseudotime-specific numerical caveat, which
    # would be a claim about a distance it never computes.
    assert "a_numerical_change_is_scheduled_upstream" not in graph_disclosures


# ── TEST-18 — library versions, resolved the way that survives the deprecation ────────
def test_every_library_version_resolves_to_a_real_value(paga, dpt):
    """The scientific stack is unpinned in the sandbox image by explicit house style, so the
    versions that produced a result are only knowable at run time. A recorder that silently
    writes null for the most important library is a provenance regression no other test
    catches, because its fallback is a value rather than a failure."""
    for run in (paga, dpt):
        versions = run.report()["library_versions"]
        for lib in ("scanpy", "igraph", "scipy", "numpy", "anndata", "pandas"):
            assert versions.get(lib), (
                f"{lib} recorded as {versions.get(lib)!r} — a null here is exactly the "
                "silent provenance regression the metadata-first resolution avoids")
            assert versions[lib][0].isdigit()


def _shared_module():
    import importlib.util
    import sys
    from pathlib import Path

    compute = Path(__file__).resolve().parents[1] / "compute"
    sys.path.insert(0, str(compute))
    spec = importlib.util.spec_from_file_location("trajectory_shared_versions",
                                                  compute / "_shared.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_attribute_the_sibling_packages_read_is_ALREADY_deprecated():
    """The premise, asserted rather than asserted-about.

    This is not a future risk: reading the attribute on the installed library emits a
    deprecation warning TODAY. When it is finally removed, every recorder built on
    `getattr(module, "__version__", None)` silently records null for its most important
    library, and nothing goes red — because the fallback is a value rather than a failure.
    """
    import warnings

    import scanpy

    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter("always")
        getattr(scanpy, "__version__", None)
    assert any(issubclass(w.category, (DeprecationWarning, FutureWarning)) for w in caught), (
        "the attribute no longer warns — if it has been REMOVED, every sibling package's "
        "recorder is now silently writing null and this package's ordering matters more, "
        "not less")


def test_the_version_is_resolved_through_distribution_metadata_FIRST():
    """Asserts the ORDER, by making the two sources disagree.

    Distribution metadata is patched to a sentinel. A recorder that read the module
    attribute first would return the real version and fail here; one that reads metadata
    first returns the sentinel. Patching rather than deleting, because the attribute is a
    module-level deprecation shim rather than a real attribute and cannot be deleted.
    """
    import importlib.metadata as im

    mod = _shared_module()
    real = im.version
    try:
        im.version = lambda dist: "0.0.0-sentinel"
        resolved = mod.library_versions(("scanpy",))
    finally:
        im.version = real

    assert resolved["scanpy"] == "0.0.0-sentinel", (
        f"resolved {resolved['scanpy']!r} — the recorder consulted the deprecated module "
        "attribute before distribution metadata, which is the ordering that breaks silently "
        "the day the attribute is removed")


def test_a_library_with_no_distribution_metadata_still_falls_back_rather_than_nulling():
    """The fallback arm, exercised. Metadata-first must not mean metadata-only: a module
    importable without a distribution record should still report a version if it carries
    one, rather than being recorded as absent."""
    import sys
    import types

    mod = _shared_module()
    fake = types.ModuleType("trajectory_fake_lib")
    fake.__version__ = "9.9.9"
    sys.modules["trajectory_fake_lib"] = fake
    try:
        resolved = mod.library_versions(("trajectory_fake_lib",))
    finally:
        del sys.modules["trajectory_fake_lib"]

    assert resolved["trajectory_fake_lib"] == "9.9.9"


# ── TEST-27 — the report artifacts themselves ─────────────────────────────────────────
def test_each_analysis_emits_exactly_one_opaque_report(paga, dpt):
    for run in (paga, dpt):
        reports = run.entries("report/qc")
        assert len(reports) == 1
        entry = reports[0]
        assert entry["layout"] == "opaque"
        assert entry["structure"]["encoding"] == "opaque"
        assert entry["structure"]["media_type"] == "application/json"


def test_every_manifest_entry_is_well_formed_against_the_wire_contract(paga, dpt):
    for run in (paga, dpt):
        for entry in run.manifest()["outputs"]:
            assert set(entry) == {"id", "datatype", "path", "layout", "role", "structure",
                                  "meta"}
            assert entry["id"] and entry["datatype"] and entry["path"]
            assert isinstance(entry["structure"], dict), (
                "`structure` is the producer's decode declaration and has no default on "
                "either side of the wire")


def test_both_runs_pass_the_real_conformance_gate(paga, dpt):
    for run in (paga, dpt):
        assert conformance.conform_outputs(run.outputs_dir) == []


# ── TEST-26 — the pseudotime output's own declaration ────────────────────────────────
def test_the_pseudotime_column_is_a_continuous_float32_1d_column(dpt):
    entry = dpt.entry("metadata-column")
    assert entry["layout"] == "chunked-1d"
    assert entry["meta"]["kind"] == "continuous"
    assert entry["meta"]["stored_dtype"] == "float32"
    assert entry["meta"]["axis"] == "cells"
    assert entry["meta"]["n"] == 450


def test_the_diffusion_map_was_called_explicitly_with_a_recorded_size(dpt):
    """Never left to the library's silent fallback: it warns and then runs with ITS OWN
    defaults, so a run that relied on that would have a basis nobody recorded."""
    provenance = dpt.group_cyto("metadata-column")["trajectory"]
    assert provenance["n_comps"] == 15
    assert provenance["n_dcs"] == 10
    assert provenance["method"] == "dpt"
    assert provenance["n_branchings"] == 0
