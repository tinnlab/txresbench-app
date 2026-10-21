#!/usr/bin/env python3
# ruff: noqa
"""TEST-8 + TEST-21 — the manifest declares what the loader requires, and nothing stale.

A manifest error here is not a soft failure: a malformed block fails the parse and the WHOLE
package is skipped at boot, losing both analyses, both views and the whole contribution. A
`ui:` entry naming a missing file is likewise a load error. So the declaration is asserted
against disk rather than eyeballed.

Mutation: rename a view file without updating `ui:` -> the existence test fails here instead
of the package vanishing at boot. Re-add one of the removed schema keys -> the build gate
would fail; this test names it first and more cheaply.
"""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_PACKAGES = _PKG.parent


@pytest.fixture(scope="module")
def manifest():
    return yaml.safe_load((_PKG / "manifest.yaml").read_text())


@pytest.fixture(scope="module")
def analyses(manifest):
    return {a["id"]: a for a in manifest["contributes"]["analyses"]}


def test_the_package_declares_every_field_the_runtime_requires(manifest):
    for key in ("id", "name", "publisher", "version", "apiVersion"):
        assert manifest.get(key), f"the manifest declares no {key!r}"
    assert manifest["id"] == "trajectory"
    assert manifest["apiVersion"] == "1.0"
    # `publisher` is optional to the build lint and REQUIRED by the runtime parser, so its
    # absence would pass the build and fail at boot.
    assert manifest["publisher"] == "cyto"


def test_it_contributes_exactly_the_two_analyses_and_no_datatype(manifest, analyses):
    assert set(analyses) == {"trajectory.paga", "trajectory.dpt"}
    # NO new kind is declared: the whole output-kind decision is that the two already-
    # declared kinds fit. A `datatypes:` block here would be the drift that decision avoids.
    assert not manifest["contributes"].get("datatypes")
    assert not manifest["contributes"].get("converters")
    assert not manifest["contributes"].get("sections")


@pytest.mark.parametrize("analysis_id", ["trajectory.paga", "trajectory.dpt"])
def test_each_analysis_declares_the_required_fields(analyses, analysis_id):
    a = analyses[analysis_id]
    for key in ("id", "category", "title"):
        assert a.get(key), f"{analysis_id} declares no {key!r}"
    assert a["category"] == "trajectory"
    assert a["schedule"]["class"] == "normal"
    assert a["arch"] == ["x86_64", "aarch64"]
    assert a["run"]["kind"] == "sandbox"
    assert a["run"]["runtime"] == "python"
    assert a["safety"] == "read-run"


@pytest.mark.parametrize("analysis_id", ["trajectory.paga", "trajectory.dpt"])
def test_no_removed_schema_key_is_present(analyses, analysis_id):
    """Every one of these is a BUILD FAILURE under the schema's unknown-field rejection.
    Naming them here fails cheaply and says which."""
    a = analyses[analysis_id]
    for removed in ("accepts", "when", "params", "defaults", "produces_annotations",
                    "inStandardRecipe", "recipeOrder"):
        assert removed not in a, f"{analysis_id} declares the removed key {removed!r}"
    assert "inputs" not in a["run"]
    assert "resources" not in a["schedule"]


@pytest.mark.parametrize("analysis_id", ["trajectory.paga", "trajectory.dpt"])
def test_every_declared_file_exists_on_disk(analyses, analysis_id):
    """A `ui:` entry naming a missing file is a LOAD ERROR, and a missing helper means the
    entry cannot import its own substrate at run time."""
    a = analyses[analysis_id]
    entry = _PKG / a["run"]["entry"]
    assert entry.is_file(), f"{analysis_id} run entry missing: {entry}"
    for helper in a["run"].get("helpers", []):
        assert (_PKG / helper).is_file(), f"{analysis_id} helper missing: {helper}"
    for view in a.get("ui", []):
        assert view.startswith("ui/"), f"view files live under ui/: {view}"
        assert (_PKG / view).is_file(), f"{analysis_id} declares a missing view: {view}"


def test_the_declared_outputs_are_the_two_existing_kinds_and_a_report(analyses):
    assert analyses["trajectory.paga"]["produces"] == ["graph/attributed", "report/qc"]
    assert analyses["trajectory.dpt"]["produces"] == ["metadata-column", "report/qc"]


def test_the_graph_analysis_requires_a_partition_and_the_pseudotime_one_does_not(analyses):
    """An `appliesTo` entry is REQUIRED by definition, which is exactly why the two differ:
    a graph over no partition is nothing, while a pseudotime has three root modes and only
    one of them needs a column."""
    paga_slots = {s["slot"] for s in analyses["trajectory.paga"]["appliesTo"]}
    dpt_slots = {s["slot"] for s in analyses["trajectory.dpt"]["appliesTo"]}
    assert paga_slots == {"embedding", "partition"}
    assert dpt_slots == {"embedding"}


def test_every_single_value_input_declares_its_sole_candidate_bind(analyses):
    """Opt-IN: omitting it leaves the input unresolved for a headless agent launch."""
    for analysis in analyses.values():
        for slot in analysis["appliesTo"]:
            assert slot.get("auto_bind_sole_candidate") is True, (
                f"{analysis['id']} slot {slot['slot']!r} does not declare its auto-bind")


def test_the_applicability_keys_on_the_datatype_never_on_a_subtype_relation(analyses):
    """Recorded because it is load-bearing in a second, non-obvious place: the model-coverage
    guard's anchoring rule reads the SUBTYPE constraint only, so spelling these as a subtype
    relation would anchor the graph kind's axis through our inputs and silently invert the
    disposition recorded in the register."""
    for analysis in analyses.values():
        for slot in analysis["appliesTo"]:
            assert "type_id" in slot, f"{analysis['id']}/{slot['slot']} lost its exact type"
            assert "subtypes_of" not in slot, (
                f"{analysis['id']}/{slot['slot']} constrains by subtype relation — that "
                "anchors the produced kind's axis in the model-coverage fixpoint")


# ── TEST-21 — the suite is actually collected ────────────────────────────────────────
def test_this_packages_suite_is_listed_in_the_testpaths_enumeration():
    """`testpaths` is an ENUMERATION: a package whose suite is not listed is collected by
    NOTHING, and every gate stays green while the tests never run. That failure has already
    happened once in this tree, which is why the append lands in the same commit as the
    directory."""
    ini = (_PACKAGES / "pytest.ini").read_text()
    line = next(l for l in ini.splitlines() if l.startswith("testpaths"))
    assert "trajectory/tests" in line.split(), (
        f"trajectory/tests is not in the testpaths enumeration: {line}")
