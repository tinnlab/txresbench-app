#!/usr/bin/env python3
# ruff: noqa
"""TEST-14 [covers: ITEM-2, ITEM-12] — the manifest declares exactly what the workbench needs.

The manifest is DATA the server parses at boot and `build.rs` lints with `deny_unknown_fields`, so
a typo is a build failure rather than a boot surprise. This test covers the half the Rust lint
cannot: that the declared FILES exist, that `run.helpers` stay inside the package (the sandbox
staging refuses `..`), and that the views name only slots the compute actually resolves.
"""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_MANIFEST = _PKG / "manifest.yaml"


def _doc():
    return yaml.safe_load(_MANIFEST.read_text())


def _analyses():
    return {a["id"]: a for a in _doc()["contributes"]["analyses"]}


def test_both_analyses_are_declared_with_the_shape_the_workbench_loads():
    analyses = _analyses()
    assert set(analyses) == {"da.neighbourhoods", "da.clusters"}
    for aid, a in analyses.items():
        assert a["category"] == "differential-abundance"
        assert a["title"] and a["description"] and a["whenHint"]
        assert a["safety"] == "read-run"
        assert a["examples"]
        assert a["schedule"] == {"class": "normal"}
        assert a["arch"] == ["x86_64", "aarch64"]
        assert "da/result" in a["produces"] and "report/qc" in a["produces"]
        assert a["run"]["kind"] == "sandbox" and a["run"]["runtime"] == "python"


def test_the_neighbourhood_analysis_keys_on_the_embedding_datatype():
    a = _analyses()["da.neighbourhoods"]
    assert a["appliesTo"] == [{"slot": "embedding", "type_id": "embedding",
                               "auto_bind_sole_candidate": True}]
    assert set(a["consumes"]) == {"embedding", "metadata-column"}
    # NOTABLY ABSENT — abundance counts cells, not reads.
    assert "single-cell/expression" not in a["consumes"]


def test_the_cluster_analysis_needs_no_matrix_and_no_embedding():
    a = _analyses()["da.clusters"]
    # Single-value, and the opt-in auto-bind is DECLARED rather than omitted: under DEC-15 the
    # sole-candidate bind is opt-IN, so a slot that omits the key is unresolvable for a headless
    # (agent/MCP) launch. It fires only when the project holds exactly ONE `metadata-column`.
    assert a["appliesTo"] == [{"slot": "population", "type_id": "metadata-column",
                               "auto_bind_sole_candidate": True}]
    assert a["consumes"] == ["metadata-column"]
    assert "embedding" not in a["consumes"]
    # it alone commits the optional per-cell effect column
    assert "metadata-column" in a["produces"]


def test_only_the_cluster_analysis_produces_a_per_cell_column():
    """A cell belongs to MANY overlapping neighbourhoods, so a per-cell effect there would need an
    arbitrary reduction. Not emitting one is a decision, and the manifest records it."""
    assert "metadata-column" not in _analyses()["da.neighbourhoods"]["produces"]


def test_every_declared_run_helper_exists_and_is_confined_to_the_package():
    for aid, a in _analyses().items():
        entry = _PKG / a["run"]["entry"]
        assert entry.is_file(), f"{aid}: missing entry {a['run']['entry']}"
        for helper in a["run"].get("helpers", []):
            assert ".." not in helper, (
                f"{aid}: helper {helper!r} escapes the package — `confine_under_package` refuses "
                "it, which is why `_regime.py` is VENDORED rather than imported")
            assert (_PKG / helper).is_file(), f"{aid}: missing helper {helper}"


def test_every_declared_view_file_exists():
    """A `ui:` entry naming a missing view file is a LOAD ERROR for the whole package."""
    for aid, a in _analyses().items():
        for rel in a["ui"]:
            assert (_PKG / rel).is_file(), f"{aid}: missing view {rel}"
    for section in _doc()["contributes"]["sections"]:
        for rel in section["ui"]:
            assert (_PKG / rel).is_file(), f"{section['id']}: missing view {rel}"


def test_the_visualize_section_keys_on_the_datatype_not_on_a_producer():
    sections = _doc()["contributes"]["sections"]
    assert len(sections) == 1
    s = sections[0]
    assert s["pane"] == "visualize"
    assert s["applies_to"] == [{"type_id": "da/result"}]
    assert s["id"] == "da.viz.differential-abundance"


def test_the_manifest_carries_a_column_zero_version_key():
    """`scripts/check-processor-seed-versions.sh` exempts a package INTRODUCED on a branch from
    the bump rule, but it still requires the key — and every later content change must bump it
    forward, or a provisioned deployment keeps running the old kernel."""
    lines = _MANIFEST.read_text().splitlines()
    assert any(l.startswith("version:") for l in lines), "no column-0 `version:` key"
    assert any(l.startswith("id: differential-abundance") for l in lines)
    assert any(l.startswith("apiVersion:") for l in lines)


def test_the_methods_param_roles_are_in_the_closed_vocabulary_the_build_gate_enforces():
    """Read out of the shipped Rust build gate rather than retyped here, so a change to that
    vocabulary fails this test instead of silently diverging from it."""
    gate = (_PKG.parents[1] / "server" / "build_helper" / "processor_manifest.rs").read_text()
    block = gate.split("enum MethodsParamRole")[1].split("}")[0]
    allowed = set()
    for line in block.splitlines():
        token = line.strip().rstrip(",")
        if token and token[0].isupper():
            # CamelCase -> snake_case, the `rename_all = "snake_case"` serde spelling
            snake = "".join(("_" + c.lower()) if c.isupper() else c for c in token).lstrip("_")
            allowed.add(snake)
    assert {"threshold_list", "seed", "output_label"} <= allowed, allowed
    for aid, a in _analyses().items():
        for param, role in a["methods"]["params"].items():
            assert role in allowed, f"{aid}: param {param!r} declares unknown role {role!r}"


def test_every_analysis_declares_both_methods_and_methodsText():
    """They are DIFFERENT systems — `methods` is read only by Rust (the exported `methods.md`),
    `methodsText` only by the frontend — and both are required."""
    for aid, a in _analyses().items():
        assert a["methodsText"].strip()
        assert a["methods"]["subject"]["singular"] == "population"
        assert a["methods"]["subject"]["plural"] == "populations"
        assert a["methods"]["action"]
        assert a["methods"]["note"].strip()
