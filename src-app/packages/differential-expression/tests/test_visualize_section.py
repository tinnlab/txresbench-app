#!/usr/bin/env python3
# ruff: noqa
"""TEST-30 [acceptance] [invariant: INV-14] [covers: ITEM-13, ITEM-17] — the DE Visualize
SECTION is an `entry_list` of the run's comparisons, each with a regime badge + a Plot action
whose canvas chart-kind is `volcano` (VolcanoView), NOT a bespoke card."""
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]


def test_manifest_declares_the_visualize_section():
    doc = yaml.safe_load((_PKG / "manifest.yaml").read_text())
    sections = doc["contributes"]["sections"]
    sec = next(s for s in sections if s["pane"] == "visualize")
    assert sec["title"] == "Differential expression"
    assert sec["applies_to"] == [{"type_id": "de/result"}]
    assert sec["ui"] == ["ui/visualize-section.yaml"]


# The per-row fields EntryListRenderer actually draws (from `EntryListWidget.tsx` `toEntries` +
# `renderRow`). `badge` is NOT among them — it is a non-field the renderer silently drops, which
# is why the regime rode invisibly on it before M1. The regime must ride a field in THIS set.
_RENDERER_ROW_FIELDS = {"key", "value", "label", "qualifier", "group", "missing_note",
                        "title", "values", "plot_refusal"}


def test_section_is_an_entry_list_of_comparisons_with_regime_and_plot():
    doc = yaml.safe_load((_PKG / "ui/visualize-section.yaml").read_text())
    w = {x["id"]: x for x in doc["widgets"]}
    el = w["comparisons"]
    assert el["kind"] == "entry_list"
    assert el["entries"] == "$data.report.comparisons"
    # M1 — the regime is NOT bound to the unsupported widget-level `badge` (which the renderer
    # never draws): a mutation putting it back there makes the hero signal invisible → red here.
    assert "badge" not in el, "regime must not ride the non-rendered `badge` field (M1)"
    # M2 — rows render under their source heading: `grouped` + `groups` are bound (mirrors
    # colour-by). A mutation dropping either flattens the list → red here.
    assert el["grouped"] == "$data.report.grouped"
    assert el["groups"] == "$data.report.groups"
    assert el["action"]["label"] == "Plot"
    assert el["action"]["onClick"] == "de.viz.plotComparison"


def test_regime_rides_a_renderer_supported_row_field_and_rows_are_grouped(markers_run):
    # M1/M2 (behavioral) — the PRODUCER stamps the regime on `qualifier` (a field the renderer
    # draws inline) and a source `group` on every comparison row, and declares `groups`/`grouped`
    # in the report. Reverting the producer to the invisible `badge`-only shape makes this red.
    from de_fixtures import two_group_expression, group_labels, MATRIX_DERIVED
    run = markers_run()
    run.add_expression(two_group_expression())
    run.add_column(group_labels(), slot="grouping", name="leiden", provenance=MATRIX_DERIVED)
    run.run_ok({"method": "wilcoxon"})
    report = run.report()
    assert report["grouped"] is True and report["groups"]  # M2 — the report supplies groups
    comparisons = report["comparisons"]
    assert comparisons, "a marker run lists its comparisons"
    group_names = {g["name"] for g in report["groups"]}
    for c in comparisons:
        # the regime is visible via `qualifier` (a renderer-drawn field), NOT `badge`.
        assert c.get("qualifier") == c["regime"]
        assert "badge" not in c
        # every row carries the `key` the renderer needs to render at all, and a `group` heading
        # that is one of the declared source groups.
        assert c.get("key") and c.get("group") in group_names
        # the regime is carried only on renderer-supported fields.
        assert any(f in _RENDERER_ROW_FIELDS for f in c if c[f] == c["regime"])


def test_plot_opens_a_volcano_canvas_chart_kind_not_a_bespoke_card():
    doc = yaml.safe_load((_PKG / "ui/visualize-section.yaml").read_text())
    canvas = doc["canvas"]
    series = canvas["series"]
    vol = next(s for s in series if s.get("type") == "volcano")
    assert vol["type"] == "volcano"
    assert "volcano" in vol["switchTo"]
    assert vol["datasetId"].startswith("plotted")
    # the volcano binds the row's de/result table effect/significance channels (INV-14).
    assert vol["encode"]["effectColumn"] == "logFC"
    assert vol["encode"]["significanceColumn"] == "neglog10p"


def test_no_bespoke_volcano_widget_in_the_panel():
    # INV-14 pt 1 — the volcano is a CANVAS chart-kind, never a panel-embedded chart widget.
    doc = yaml.safe_load((_PKG / "ui/visualize-section.yaml").read_text())
    kinds = {w["kind"] for w in doc["widgets"]}
    assert "volcano" not in kinds and "chart" not in kinds
