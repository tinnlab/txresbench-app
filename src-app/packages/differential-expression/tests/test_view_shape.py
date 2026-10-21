#!/usr/bin/env python3
# ruff: noqa
"""TEST-20 [covers: ITEM-13] — the run forms declare visible-explicit inputs with data-derived
option sources; markers has NO p-axis; both single-value input slots opt in to
auto_bind_sole_candidate (DEC-15). (The live populated render is DEC-12 → phase-8 gate:ui.)"""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_UI = Path(__file__).resolve().parents[1] / "ui"


def _load(name):
    return yaml.safe_load((_UI / name).read_text())


def _widgets(doc):
    return {w["id"]: w for w in doc.get("widgets", [])}


def test_compare_form_has_visible_explicit_inputs_from_data_sources():
    doc = _load("compare.yaml")
    w = _widgets(doc)
    # the grouping + sample pickers read categorical columns of the chosen matrix (data-derived).
    assert w["groupingPicker"]["options"] == "$derived.catColumns"
    assert w["samplePicker"]["options"] == "$derived.catColumns"
    assert "minCellsInput" in w
    # the run passes every input EXPLICITLY on run_processor.
    run = next(s["run_processor"] for a in doc["actions"] for s in a.get("body", [])
               if "run_processor" in s)
    assert "expression" in run["inputs"]
    slots = {b["slot"] for b in run.get("inputs_from", [])}
    assert {"grouping", "sample"} <= slots


def test_markers_form_has_no_p_axis():
    # a descriptive ranked readout — no significance-axis WIDGET: markers declares no volcano
    # canvas and no widget binds a p-value column (prose mentioning `padj is absent` is fine).
    doc = _load("markers.yaml")
    assert "canvas" not in doc, "markers has no volcano canvas (no significance axis)"
    for w in doc.get("widgets", []):
        assert w.get("kind") not in ("volcano", "chart")
        # no control's option/value binds a p-family column.
        for key in ("options", "value"):
            v = str(w.get(key, ""))
            assert "neglog10p" not in v and "padj" not in v and "pvalue" not in v


def test_single_value_input_slots_opt_in_to_auto_bind():
    for name in ("compare.yaml", "markers.yaml"):
        w = _widgets(_load(name))
        assert w["expressionPicker"]["auto_bind_sole_candidate"] is True


# ── TEST-5 [acceptance] [invariant: INV-A5] [covers: ITEM-6] — the Advanced view DERIVES
# g1Count/g2Count/overlap from the criteria MASKS (the derived bindings exist + reference the
# criteria lists), and Run's disabled binds the overlap comparison.
def test_advanced_derives_counts_and_overlap_from_the_criteria_masks():
    doc = _load("compare.yaml")
    derived = doc["derived"]
    # the two per-group keep-masks reference the two criteria state lists (INV-A5 — real, not faked).
    assert derived["g1Mask"]["keep_mask"]["criteria"] == "$state.group1Criteria"
    assert derived["g2Mask"]["keep_mask"]["criteria"] == "$state.group2Criteria"
    # the live counts derive FROM those masks (count_by over the mask).
    assert derived["g1By"]["count_by"]["group"] == "$derived.g1Mask"
    assert derived["g2By"]["count_by"]["group"] == "$derived.g2Mask"
    # overlap detection references BOTH masks (group=g1, hidden=g2) — |g1 ∩ g2| ⟺ before>after.
    ov = derived["overlapBy"]["count_by"]
    assert ov["group"] == "$derived.g1Mask" and ov["hidden"] == "$derived.g2Mask"
    # the two group panels source their column pickers / keep-sets from the obs frame (INV-A1).
    assert "advColumns" in derived and "advCategoriesByColumn" in derived


def test_run_is_disabled_while_the_groups_overlap():
    doc = _load("compare.yaml")
    run = _widgets(doc)["runBtn"]
    dw = run["disabledWhen"]
    # gated on advanced mode (so Simple mode is never disabled) AND the overlap comparison.
    assert "$state.contrastMode == advanced" in dw
    assert "$derived.overlapBy['true'].before > $derived.overlapBy['true'].after" in dw


def test_advanced_run_binds_criterion_column_slots_and_passes_criteria():
    doc = _load("compare.yaml")
    run = next(s["run_processor"] for a in doc["actions"] for s in a.get("body", [])
               if "run_processor" in s)
    # each criterion column of both groups binds a `column:<name>` slot (name carried by the slot).
    col_slots = [b["slot"] for b in run.get("inputs_from", []) if str(b["slot"]).startswith("column:")]
    assert "column:{$c.column}" in col_slots
    fe = [b.get("for_each") for b in run.get("inputs_from", [])]
    assert "$state.group1Criteria as $c" in fe and "$state.group2Criteria as $c" in fe
    # the run passes contrast_mode + both criteria lists.
    assert run["params"]["contrast_mode"] == "$state.contrastMode"
    assert run["params"]["group1_criteria"] == "$state.group1Criteria"
    assert run["params"]["group2_criteria"] == "$state.group2Criteria"


# ── alert-tone validity (regression: an invalid `tone: destructive` crashed the live
#    overlap banner — the kit AlertTone is info|success|warning|error|neutral, NO destructive;
#    the workbench conformance vitest did NOT catch it). Walk EVERY widget in EVERY DE view. ──
# #374 — this set is TYPED, and one package wide. `_lib/test_view_token_vocabulary.py` now
# guards the same property across EVERY `packages/*/ui/*.yaml`, with the admitted tokens
# DERIVED from `AlertWidget.tone` in `core/manifest/viewSpec.ts`. It is the stricter of the
# two (the view-spec union has no `neutral`; the kit tolerates one), so this stays as the
# DE-local crash guard rather than being retired — a looser guard beside a tighter one is
# redundant, not wrong. Do not widen either to make a view go green.
_ALERT_TONES = {"info", "success", "warning", "error", "neutral"}


def _walk_widgets(node):
    """Yield every dict that looks like a widget (has a `kind`), recursively — including
    widgets nested in table columns/cells, so a bad tone anywhere is caught."""
    if isinstance(node, dict):
        if "kind" in node:
            yield node
        for v in node.values():
            yield from _walk_widgets(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk_widgets(v)


def test_every_alert_tone_is_a_valid_kit_AlertTone():
    for name in ("compare.yaml", "markers.yaml", "visualize-section.yaml"):
        doc = _load(name)
        for w in _walk_widgets(doc):
            if w.get("kind") == "alert" and "tone" in w:
                assert w["tone"] in _ALERT_TONES, (
                    f"{name}: alert {w.get('id')!r} has tone {w['tone']!r} — not a kit AlertTone "
                    f"{sorted(_ALERT_TONES)}; an unknown tone renders an undefined icon and CRASHES "
                    f"the widget at runtime (`overlapReadoutOverlap` regression).")
