#!/usr/bin/env python3
# ruff: noqa
"""Manifest-shape acceptance anchors — the "UI is data, not code" contract.

TEST-19 [acceptance] [invariant: INV-19] [covers: ITEM-1, ITEM-13] — the manifest declares
        only load/enable/execute (no removed/forecast keys, no labels/help/field-order), and
        the clustering PACKAGE adds no bespoke view/render code (no `.tsx`).
TEST-24 [covers: ITEM-15] — the `methods` narration block declares a role for every param
        the compute applies (a param with no declared role is disclosed BY NAME).
TEST-25 [covers: ITEM-16] — the manifest carries a `version`, `arch: [x86_64, aarch64]`, and
        a valid `schedule.class` (labels = `normal`).
"""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_MANIFEST = _PKG / "manifest.yaml"

# The keys a manifest may no longer carry (`loadProcessors.ts` `assertNoRemovedKeys`).
REMOVED_KEYS = {"accepts", "when", "params", "defaults", "produces_annotations",
                "inStandardRecipe", "recipeOrder"}


def _load():
    return yaml.safe_load(_MANIFEST.read_text())


def _analysis():
    analyses = _load()["contributes"]["analyses"]
    assert len(analyses) == 1
    return analyses[0]


def test_one_analysis_clustering_cluster():
    a = _analysis()
    assert a["id"] == "clustering.cluster"
    assert a["category"] == "clustering"


def test_no_removed_or_forecast_keys():
    a = _analysis()
    assert not (set(a) & REMOVED_KEYS), set(a) & REMOVED_KEYS
    assert "inputs" not in (a.get("run") or {})       # nested removed keys
    assert "resources" not in (a.get("schedule") or {})
    assert "produces_annotations" not in a             # no forecast of produced columns
    assert "canvas" not in a


def test_keys_on_the_embedding_datatype_and_produces_the_categorical_column():
    a = _analysis()
    sel = a["appliesTo"][0]
    assert sel["slot"] == "embedding"
    assert sel["type_id"] == "embedding"               # exact-string consume of `embedding`
    # the chaining graph edges: the required embedding + the OPTIONAL Stage-B markers input
    # (`single-cell/expression`) — a graph edge, not an availability gate (labels-only without it).
    assert a["consumes"] == ["embedding", "single-cell/expression"]
    # produces a categorical metadata-column + a report, NEVER an exclusive clustering type.
    assert a["produces"] == ["metadata-column", "report/qc"]
    assert "clustering" not in a["produces"]


def test_run_is_a_python_sandbox_with_the_shared_helper():
    a = _analysis()
    run = a["run"]
    assert run["kind"] == "sandbox" and run["runtime"] == "python"
    assert run["entry"] == "compute/cluster.py"
    helpers = run.get("helpers") or []
    assert "compute/_shared.py" in helpers
    assert "compute/_markers.py" in helpers            # the Stage-B descriptive-markers pass


def test_version_arch_and_schedule_class():
    a = _analysis()
    m = _load()
    assert m["version"]                                # a real version string
    assert a["arch"] == ["x86_64", "aarch64"]
    assert a["schedule"]["class"] == "normal"          # labels pass = normal (INV-10)


def test_methods_narration_declares_a_role_for_mapped_params():
    a = _analysis()
    methods = a["methods"]
    assert methods["subject"]["singular"] == "cell"
    assert methods["action"]                            # a verb the narrator renders
    # the closed-vocabulary params carry a declared role; the rest are disclosed by name.
    assert methods["params"]["seed"] == "seed"
    assert methods["params"]["name"] == "output_label"


def test_stage_c_manifest_declares_the_ui_view_files():
    # TEST-19 (INV-19) — Stage C: the manifest NAMES its view files (the run form + the
    # markers readout) but does NOT describe their contents. They stack in the analysis' pane
    # in the order listed; each MUST exist on disk (a `ui:` entry naming a missing file is a
    # LOAD ERROR).
    a = _analysis()
    assert a["ui"] == ["ui/clustering.yaml", "ui/markers.yaml"]
    for rel in a["ui"]:
        assert (_PKG / rel).is_file(), rel
    # the manifest declares only THAT there are views — no labels/help/field-order/form-schema
    # leaked up from the view files into the manifest (INV-19).
    for forbidden in ("widgets", "state", "actions", "layout", "fields", "form"):
        assert forbidden not in a, forbidden


def test_the_package_adds_no_bespoke_view_or_render_code():
    # INV-19 / the EA TEST-28 twin at the package level: no `.tsx`/render source in the
    # clustering package — only manifest + compute + tests.
    tsx = list(_PKG.rglob("*.tsx")) + list(_PKG.rglob("*.jsx"))
    assert tsx == [], tsx
