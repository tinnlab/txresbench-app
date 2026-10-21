#!/usr/bin/env python3
# ruff: noqa
"""TEST-23 [covers: ITEM-15] — the package is REGISTERED (mirrors embedding
`test_package_registration`)."""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_PYTEST_INI = _PKG.parent / "pytest.ini"
_MANIFEST = _PKG / "manifest.yaml"


def test_pytest_ini_registers_the_de_suite():
    testpaths = next(l for l in _PYTEST_INI.read_text().splitlines()
                     if l.strip().startswith("testpaths"))
    assert "differential-expression/tests" in testpaths


def test_manifest_is_registrable():
    doc = yaml.safe_load(_MANIFEST.read_text())
    assert doc["id"] == "differential-expression"
    assert doc["publisher"] == "cyto"
    assert doc["version"]
    assert {a["id"] for a in doc["contributes"]["analyses"]} == {"de.compare", "de.markers"}
    # the Visualize SECTION contribution is present (ITEM-13 / ITEM-65).
    sections = doc["contributes"].get("sections") or []
    assert any(s["pane"] == "visualize" for s in sections)
