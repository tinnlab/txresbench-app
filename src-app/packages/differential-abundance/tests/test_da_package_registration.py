#!/usr/bin/env python3
# ruff: noqa
"""TEST-15 [covers: ITEM-15] — the package is REGISTERED, and its suite is COLLECTED.

`src-app/packages/pytest.ini`'s `testpaths` is an ENUMERATION: a package whose suite is not listed
there is collected by NOTHING — not the justfile, not `npm run check`, not CI — so every test in
this directory would be a file nobody runs. That is the exact hole `annotation-integrate` fell
into, and it is why the line lands in the same commit that creates the directory.

Registration of the PACKAGE itself needs nothing: `include_dir!("$CARGO_MANIFEST_DIR/../packages")`
in `extensions/embedded.rs` bakes the whole tree, so dropping the directory in IS the registration
— no Rust list, no build-script entry.
"""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_PYTEST_INI = _PKG.parent / "pytest.ini"
_MANIFEST = _PKG / "manifest.yaml"


def test_pytest_ini_registers_this_suite():
    testpaths = next(l for l in _PYTEST_INI.read_text().splitlines()
                     if l.strip().startswith("testpaths"))
    assert "differential-abundance/tests" in testpaths, (
        "without this entry every test in this directory is collected by NOTHING")


def test_the_manifest_is_registrable():
    doc = yaml.safe_load(_MANIFEST.read_text())
    assert doc["id"] == "differential-abundance"
    assert doc["publisher"] == "txr"
    assert doc["version"]
    assert doc["apiVersion"] == "1.0"
    assert {a["id"] for a in doc["contributes"]["analyses"]} == {"da.neighbourhoods", "da.clusters"}
    assert any(s["pane"] == "visualize" for s in doc["contributes"]["sections"])
    assert {d["id"] for d in doc["contributes"]["datatypes"]} == {"da/result"}


def test_the_package_directory_holds_everything_the_loader_bakes():
    for rel in ("manifest.yaml", "compute/_shared.py", "compute/_regime.py", "compute/_kernel.py",
                "compute/_nhoods.py", "compute/clusters.py", "compute/neighbourhoods.py",
                "ui/clusters.yaml", "ui/neighbourhoods.yaml", "ui/visualize-section.yaml"):
        assert (_PKG / rel).is_file(), rel


def test_no_analysis_or_datatype_id_collides_with_an_existing_package():
    """Every id this package introduces is new. A collision would be silently resolved by
    whichever manifest the loader read last."""
    ours = {"differential-abundance", "da.neighbourhoods", "da.clusters", "da/result"}
    for manifest in sorted(_PKG.parent.glob("*/manifest.yaml")):
        if manifest.parent.name == _PKG.name:
            continue
        doc = yaml.safe_load(manifest.read_text()) or {}
        contributes = doc.get("contributes") or {}
        ids = {doc.get("id")}
        ids |= {a["id"] for a in contributes.get("analyses", [])}
        ids |= {d["id"] for d in contributes.get("datatypes", [])}
        ids |= {s["id"] for s in contributes.get("sections", [])}
        clash = ours & ids
        assert not clash, f"{manifest.parent.name} already declares {clash}"
