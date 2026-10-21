#!/usr/bin/env python3
# ruff: noqa
"""TEST-29 [acceptance] [invariant: INV-14] [covers: ITEM-13] — the run forms declare EXACTLY
the controls in MOCKUP_MAPPING.md, and the method enum is SOURCED from the catalog() (not
hardcoded); a control absent from the mockup, or a hardcoded (non-catalog) method enum, FAILS."""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

import _methods as METH

_UI = Path(__file__).resolve().parents[1] / "ui"


def _widgets(name):
    doc = yaml.safe_load((_UI / name).read_text())
    return doc, {w["id"]: w for w in doc.get("widgets", [])}


# The EXACT control sets MOCKUP_MAPPING.md declares — INV-14 pt 4 is "no control appears that is
# not in MOCKUP.html; none it shows is dropped", so the assertion is SET EQUALITY: a bespoke extra
# control (not in the mockup) fails just as a dropped one does.
# v1 (Simple) controls + the v0.2 ADVANCED-contrast additions (MOCKUP_MAPPING.md, v0.2):
# the contrast-mode toggle, the two criteria-builder panels (table + add-criterion + live count
# each), and the overlap readout. Simple-only pickers stay; the regime callout is shared.
_COMPARE_CONTROLS = {"expressionPicker", "contrastModePicker", "groupingPicker", "samplePicker",
                     "group1Picker", "group2Picker", "methodPicker", "minCellsInput",
                     "multiplicityPicker", "regimeCallout", "runBtn",
                     # advanced (v0.2):
                     "group1Table", "group1AddBtn", "group1Count",
                     "group2Table", "group2AddBtn", "group2Count",
                     # AC3 — the overlap readout is TWO state-driven alerts (green disjoint / red
                     # overlap), not one static warning.
                     "overlapReadoutDisjoint", "overlapReadoutOverlap",
                     # AC4 — the conservative-regime callout + per-criterion-column provenance chips.
                     "regimeCalloutAdvanced", "group1ProvChips", "group2ProvChips"}
_MARKER_CONTROLS = {"expressionPicker", "groupingPicker", "methodPicker", "comparisonNote",
                    "regimeCallout", "runBtn"}


def test_compare_declares_exactly_the_mockup_controls():
    doc, w = _widgets("compare.yaml")
    # SET EQUALITY, not mere presence — an extra bespoke control (e.g. a hand-rolled volcano or a
    # second method enum) makes the set unequal → red. INV-14 pt 4 / INV-A6.
    assert set(w) == _COMPARE_CONTROLS, set(w).symmetric_difference(_COMPARE_CONTROLS)


def test_markers_declares_exactly_the_mockup_controls():
    doc, w = _widgets("markers.yaml")
    assert set(w) == _MARKER_CONTROLS, set(w).symmetric_difference(_MARKER_CONTROLS)
    # markers has none of the compare-only controls.
    assert "samplePicker" not in w and "group1Picker" not in w and "minCellsInput" not in w


def test_method_enum_is_sourced_from_the_catalog_not_hardcoded():
    # INV-12 — the const method options are the SAME set (and order) the catalog registers.
    cdoc = yaml.safe_load((_UI / "compare.yaml").read_text())
    mdoc = yaml.safe_load((_UI / "markers.yaml").read_text())
    compare_opts = [o["value"] for o in cdoc["const"]["compareMethods"]]
    marker_opts = [o["value"] for o in mdoc["const"]["markerMethods"]]
    assert compare_opts == [m["key"] for m in METH.compare_catalog()]
    assert marker_opts == [m["key"] for m in METH.marker_catalog()]
    # and the pickers bind those const sets, not an inline literal list.
    cw = {w["id"]: w for w in cdoc["widgets"]}
    mw = {w["id"]: w for w in mdoc["widgets"]}
    assert cw["methodPicker"]["options"] == "$const.compareMethods"
    assert mw["methodPicker"]["options"] == "$const.markerMethods"


# ── TEST-6 [acceptance] [invariant: INV-A6] [covers: ITEM-1] — the ADVANCED form declares EXACTLY
# the MOCKUP_MAPPING.md (v0.2) controls, in the SHIPPED cell-filter criteria idiom (not a bespoke
# group editor); no extra control, none dropped.
def _by_id(name):
    doc = yaml.safe_load((_UI / name).read_text())
    return {w["id"]: w for w in doc.get("widgets", [])}


def test_advanced_contrast_mode_toggle_present():
    w = _by_id("compare.yaml")
    tog = w["contrastModePicker"]
    assert tog["kind"] == "select" and tog["value"] == "$state.contrastMode"
    # sourced from the const enum (Simple | Advanced), Simple the default (INV-A2).
    doc = yaml.safe_load((_UI / "compare.yaml").read_text())
    modes = [o["value"] for o in doc["const"]["contrastModes"]]
    assert modes == ["simple", "advanced"]
    assert doc["state"]["contrastMode"]["default"] == "simple"


def test_two_criteria_builder_panels_are_the_cellfilter_idiom():
    w = _by_id("compare.yaml")
    for table_id, add_id, rows_ref, add_action in (
        ("group1Table", "group1AddBtn", "$state.group1Criteria", "de.g1.addCriterion"),
        ("group2Table", "group2AddBtn", "$state.group2Criteria", "de.g2.addCriterion"),
    ):
        t = w[table_id]
        # a TABLE over the group's `criteria` list — the shipped cell-filter idiom, NOT a bespoke
        # group editor (INV-A6 non-negotiable #1).
        assert t["kind"] == "table" and t["rows"] == rows_ref
        colkeys = {c["key"] for c in t["columns"]}
        assert {"column", "constraint", "remove"} <= colkeys
        # the constraint column carries BOTH the numeric min/max parts and the categorical keep-set
        # part — reused from cell-filter (categorical keep-set / numeric range per row).
        constraint = next(c for c in t["columns"] if c["key"] == "constraint")
        partkeys = {p["key"] for p in constraint["parts"]}
        assert {"min", "max", "keep"} <= partkeys
        add = w[add_id]
        assert add["kind"] == "button" and add["onClick"] == add_action


def test_per_group_live_counts_derive_from_the_masks():
    w = _by_id("compare.yaml")
    assert w["group1Count"]["kind"] == "stat" and w["group1Count"]["value"] == "$derived.g1By['true'].before"
    assert w["group2Count"]["kind"] == "stat" and w["group2Count"]["value"] == "$derived.g2By['true'].before"


# ── AC5 — TEST-6 asserts the MOCKUP controls, not "matches the cell-filter idiom". Dropping any
# of AC2 (include/exclude toggle) / AC3 (both overlap states) / AC4 (regime provenance chips)
# FAILS here. This is the INV-A6 binding test; it must not be complicit in a drift again.
def test_include_exclude_toggle_present_on_criteria_rows():
    # AC2 — the mockup's `.incexc` toggle. Each criteria table carries a `mode` column whose cell
    # is an include/exclude SELECT sourced from the const enum, gated to CATEGORICAL rows (a
    # numeric-range exclude is not expressible by the single-range kernel, so it is hidden).
    doc = yaml.safe_load((_UI / "compare.yaml").read_text())
    w = {x["id"]: x for x in doc["widgets"]}
    ie = [o["value"] for o in doc["const"]["includeExclude"]]
    assert ie == ["include", "exclude"], "the toggle enum is Include | Exclude"
    for table_id in ("group1Table", "group2Table"):
        t = w[table_id]
        mode_col = next((c for c in t["columns"] if c["key"] == "mode"), None)
        assert mode_col is not None, f"{table_id} must declare the include/exclude `mode` column"
        sel = mode_col["cell"]["select"]
        assert sel["options"] == "$const.includeExclude" and sel["value"] == "$row.mode"
        # categorical rows ONLY (numeric-range exclude is unsupported → hidden).
        assert sel["when"] == "$derived.advControlByColumn[$row.column] == multiselect"
    # the criterion row carries a `mode` default so the toggle has a value.
    for act_id in ("de.g1.addCriterion", "de.g2.addCriterion"):
        act = next(a for a in doc["actions"] if a["id"] == act_id)
        appended = act["body"][0]["listAppend"]["value"]
        assert appended.get("mode") == "include"


def test_overlap_readout_has_BOTH_disjoint_and_overlap_states():
    # AC3 — the mockup flips the readout green ✓ (disjoint) ↔ red (overlap). Realized as two
    # conditional alerts gated on the live overlap derived, not one static warning.
    w = _by_id("compare.yaml")
    ok = w["overlapReadoutDisjoint"]
    bad = w["overlapReadoutOverlap"]
    assert ok["kind"] == "alert" and ok["tone"] == "success"
    # `error`, NOT `destructive`. Read the history before "fixing" this back (#374):
    # `destructive` is a shadcn BUTTON-variant token, not an alert tone. It is absent from the
    # view-spec's closed `AlertWidget.tone` union AND from the kit's `AlertTone`, so the kit's
    # `toneIcon[tone]` lookup returned undefined and rendering `<undefined />` CRASHED the live
    # overlap banner. `9d8025bfa` corrected the view (destructive→error) and added the
    # tone-walking guard in `test_view_shape.py`; this assertion was left demanding the exact
    # value that fix removed, so it could only ever pass by reintroducing the crash. The
    # mockup's red treatment is the `error` tone's STYLING, not a second tone vocabulary.
    assert bad["kind"] == "alert" and bad["tone"] == "error"
    # each is gated on the SAME overlap derived that gates Run — disjoint on <=, overlap on >.
    assert "$derived.overlapBy['true'].before <= $derived.overlapBy['true'].after" in ok["when"]
    assert "$derived.overlapBy['true'].before > $derived.overlapBy['true'].after" in bad["when"]


def test_regime_callout_has_provenance_chips():
    # AC4 — the conservative-regime callout + a provenance chip per criterion column of each group.
    w = _by_id("compare.yaml")
    assert w["regimeCallout"]["kind"] == "alert"  # v1 info (simple mode)
    assert w["regimeCalloutAdvanced"]["kind"] == "alert"  # the conservative-regime callout
    for chips_id, rows in (("group1ProvChips", "$state.group1Criteria as $c"),
                           ("group2ProvChips", "$state.group2Criteria as $c")):
        chip = w[chips_id]
        assert chip["kind"] == "stat", chips_id
        # one chip per criterion column (live from the criteria list), naming the column.
        assert chip["for_each"] == rows
        assert chip["value"] == "$c.column"


def test_advanced_widgets_are_gated_on_advanced_mode_and_simple_pickers_on_simple():
    w = _by_id("compare.yaml")
    for adv in ("group1Table", "group1AddBtn", "group1Count", "group2Table", "group2AddBtn",
                "group2Count", "overlapReadoutDisjoint", "overlapReadoutOverlap",
                "regimeCalloutAdvanced", "group1ProvChips", "group2ProvChips"):
        assert str(w[adv].get("when")).startswith("$state.contrastMode == advanced"), adv
    for simp in ("groupingPicker", "group1Picker", "group2Picker", "regimeCallout"):
        assert w[simp].get("when") == "$state.contrastMode == simple", simp
