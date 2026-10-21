#!/usr/bin/env python3
# ruff: noqa
"""TEST-12 [acceptance] [invariant: INV-11] + TEST-21 [covers: ITEM-3, ITEM-14] — the manifest
declares `class: normal` with NO per-run class control (so a refusal never names a `batch`
escape hatch), `version` + `arch`, and a `methods` narration."""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_MANIFEST = _PKG / "manifest.yaml"

REMOVED_KEYS = {"accepts", "when", "params", "defaults", "produces_annotations",
                "inStandardRecipe", "recipeOrder"}


def _doc():
    return yaml.safe_load(_MANIFEST.read_text())


def _analyses():
    return {a["id"]: a for a in _doc()["contributes"]["analyses"]}


def test_both_analyses_are_class_normal_with_no_per_run_class_control():
    for a in _analyses().values():
        assert a["schedule"]["class"] == "normal"
        # NO `batch` schedule class, and no per-run class control (mirrors clustering F2 / TEST-12).
        assert a["schedule"]["class"] != "batch"
        assert set(a["schedule"].keys()) == {"class"}, "the schedule declares only a class, no per-run knob"
    # no view exposes a class/resource-tier control the user could flip to `batch`.
    ui_dir = _MANIFEST.parent / "ui"
    for f in ui_dir.glob("*.yaml"):
        assert "batch" not in f.read_text().lower(), f"a view names `batch`: {f.name}"


def test_manifest_carries_version_and_arch():
    doc = _doc()
    assert doc["version"]
    for a in _analyses().values():
        assert a["arch"] == ["x86_64", "aarch64"]


def test_no_removed_keys_and_valid_run_shape():
    for aid, a in _analyses().items():
        assert not (set(a) & REMOVED_KEYS), (aid, set(a) & REMOVED_KEYS)
        run = a["run"]
        assert run["kind"] == "sandbox" and run["runtime"] == "python"
        assert run.get("entry")
        assert "compute/_shared.py" in (run.get("helpers") or [])
        assert a["appliesTo"] and isinstance(a["appliesTo"], list)
        assert a["ui"] and all(str(u).startswith("ui/") for u in a["ui"])


def test_methods_narration_declares_roles_for_params():
    # TEST-21 — the `methods` block narrates roles (subject/action/note/params) so a param the
    # compute applies is disclosed by name, never silently dropped.
    for a in _analyses().values():
        m = a["methods"]
        assert m["subject"]["singular"] == "gene"
        assert m["action"] and m["note"]
        assert "seed" in m["params"] and "name" in m["params"]


# ── TEST-9 [covers: ITEM-8] — the v0.2 manifest bumped `version` and lists the VENDORED criteria
# kernel in `de.compare`'s helpers, with `schedule.class: normal` unchanged.
def test_v0_2_version_bump_and_criteria_helper():
    doc = _doc()
    # 0.2.1 (#80): the package now DECLARES the libraries its compute imports and the
    # version range each is supported against, and its outputs-manifest writer emits the
    # run's environment record. A version bump is required because an old extracted kernel
    # under the new manifest would emit no record.
    # The CLAIM is "advanced-contrast is a v0.2 increment", so that is what is asserted.
    # It used to pin the PATCH level too (`== "0.2.1"`), which is a mirror of DATA that goes
    # red on every later change to this package — it did, on fix/zero-core-derived, which had
    # to bump the version because it edits a file inside the package and
    # `scripts/check-processor-seed-versions.sh` requires the version to move when any file
    # under a seed package changes. That guard is DERIVED from git (it compares the branch
    # against its merge base), so it enforces "the version moved when the contents moved"
    # non-circularly and far better than a literal here ever could. Pinning the patch level
    # in a second place only duplicated it badly. See docs/design/derived-guards.md §2.
    assert doc["version"].startswith("0.2."), (
        f"advanced-contrast is a v0.2 increment; got {doc['version']!r}"
    )
    compare = _analyses()["de.compare"]
    helpers = compare["run"].get("helpers") or []
    assert "compute/_criteria.py" in helpers, "the vendored criteria kernel must be staged (INV-A1)"
    # schedule unchanged (advanced contrast adds no resource cost — pseudobulk still collapses).
    assert compare["schedule"] == {"class": "normal"}
    # the vendored helper file actually exists on disk.
    assert (_PKG / "compute" / "_criteria.py").is_file()
