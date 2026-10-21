#!/usr/bin/env python3
# ruff: noqa
"""TEST-25 [acceptance] [invariant: INV-16, INV-19] — the manifest declares only
load/enable/execute facts and forecasts NO produced columns; it declares two analyses, the
`type_id: embedding` chaining key for analysis 2, `produces: [embedding, report/qc]` for
analysis 1 (the exact-string chaining edge), per-analysis `schedule.class`, and no
`canvas:`.
"""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_MANIFEST = Path(__file__).resolve().parents[1] / "manifest.yaml"

# The keys a manifest may no longer carry (`loadProcessors.ts` `assertNoRemovedKeys`).
REMOVED_KEYS = {"accepts", "when", "params", "defaults", "produces_annotations",
                "inStandardRecipe", "recipeOrder"}


def _load():
    return yaml.safe_load(_MANIFEST.read_text())


def test_two_analyses_declared():
    analyses = _load()["contributes"]["analyses"]
    ids = {a["id"] for a in analyses}
    assert ids == {"embedding.reduce", "embedding.visualize"}


def test_no_removed_keys_anywhere():
    analyses = _load()["contributes"]["analyses"]
    for a in analyses:
        assert not (set(a) & REMOVED_KEYS), (a["id"], set(a) & REMOVED_KEYS)
        # nested removed keys: run.inputs, schedule.resources.
        assert "inputs" not in (a.get("run") or {})
        assert "resources" not in (a.get("schedule") or {})
        # no forecast of produced columns.
        assert "produces_annotations" not in a
        # no canvas surface (§Coordinates already owns plottable-xy dims:2).
        assert "canvas" not in a


def test_analysis1_produces_the_exact_chaining_strings():
    reduce = next(a for a in _load()["contributes"]["analyses"]
                  if a["id"] == "embedding.reduce")
    assert reduce["produces"] == ["embedding", "report/qc"]
    assert reduce["schedule"]["class"] == "normal"
    # appliesTo: raw single-cell/expression, excluding normalized/protein/atac.
    sel = reduce["appliesTo"][0]
    assert sel["slot"] == "matrices"
    assert sel["subtypes_of"] == "single-cell/expression"
    assert set(sel["excludes"]) == {"single-cell/normalized", "single-cell/protein",
                                    "single-cell/atac"}
    assert reduce["consumes"] == ["metadata-column"]


def test_analysis2_keys_on_the_embedding_datatype():
    viz = next(a for a in _load()["contributes"]["analyses"]
               if a["id"] == "embedding.visualize")
    sel = viz["appliesTo"][0]
    assert sel["type_id"] == "embedding"      # exact-string chaining edge (ITEM-0d)
    assert viz["schedule"]["class"] == "normal"
    # Stage-C: the declarative view now lands, so the analysis declares its `ui:` file
    # (INV-16 — the manifest names the FILE, the view owns the UI). No `canvas:` in it.
    assert viz["ui"] == ["ui/visualize.yaml"]


def test_analysis1_declares_its_view():
    reduce = next(a for a in _load()["contributes"]["analyses"]
                  if a["id"] == "embedding.reduce")
    assert reduce["ui"] == ["ui/reduce.yaml"]


def test_both_entries_declare_the_shared_helper():
    for a in _load()["contributes"]["analyses"]:
        run = a["run"]
        assert run["kind"] == "sandbox" and run["runtime"] == "python"
        assert "compute/_shared.py" in (run.get("helpers") or [])
