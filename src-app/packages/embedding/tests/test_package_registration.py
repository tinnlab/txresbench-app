#!/usr/bin/env python3
# ruff: noqa
"""TEST-39 [covers: ITEM-5, ITEM-30] — the package is REGISTERED and its manifest has the
shape the processor lint accepts.

`src-app/packages/pytest.ini` `testpaths` lists `embedding/tests` (so `just check-py`
collects the suite), and the manifest carries no removed keys and a valid
`run`/`schedule`/`appliesTo`/`ui` shape for each analysis (what `lint_processor_tree` +
`check-processor-versions` require), so the build/boot lints pass.
"""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_PYTEST_INI = _PKG.parent / "pytest.ini"
_MANIFEST = _PKG / "manifest.yaml"

# Keys a manifest may no longer carry (`loadProcessors.ts` `assertNoRemovedKeys`).
REMOVED_KEYS = {"accepts", "when", "params", "defaults", "produces_annotations",
                "inStandardRecipe", "recipeOrder"}


def test_pytest_ini_registers_the_embedding_suite():
    text = _PYTEST_INI.read_text()
    # the enumeration `testpaths` MUST list the package's tests, or nothing collects it.
    testpaths = next(l for l in text.splitlines() if l.strip().startswith("testpaths"))
    assert "embedding/tests" in testpaths


def test_manifest_has_the_shape_the_processor_lint_accepts():
    doc = yaml.safe_load(_MANIFEST.read_text())
    assert doc["id"] == "embedding"
    assert doc["publisher"] == "cyto"
    analyses = doc["contributes"]["analyses"]
    assert {a["id"] for a in analyses} == {"embedding.reduce", "embedding.visualize"}

    for a in analyses:
        # no removed keys anywhere on the analysis.
        assert not (set(a) & REMOVED_KEYS), (a["id"], set(a) & REMOVED_KEYS)
        run = a["run"]
        assert run["kind"] == "sandbox" and run["runtime"] == "python"
        assert run.get("entry"), a["id"]
        assert "compute/_shared.py" in (run.get("helpers") or [])
        # a valid, declared schedule class + a non-empty appliesTo + a declared view file.
        assert a["schedule"]["class"] == "normal"
        assert a["appliesTo"] and isinstance(a["appliesTo"], list)
        assert a["ui"] and all(str(u).startswith("ui/") for u in a["ui"])
