#!/usr/bin/env python3
# ruff: noqa
"""TEST-19 [covers: ITEM-11] — the DA volcano section, on the SHIPPED chart kind (#124).

Chart kinds are a CLOSED list in `src-app/libs/viz/src/viz-core/charts/chartSchemas.ts`. Milo's
canonical readout is a beeswarm and there is none — adding one would be a viz-library change and a
direct violation of the architecture invariant that makes "adding an analysis is pure data" true.
A DA result is genuinely volcano-shaped (effect vs significance over many entities), and the
shipped `volcano` kind takes `encode: {effectColumn, significanceColumn}` from this YAML, so the
readout is reuse rather than a workaround.
"""
import re
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_SECTION = _PKG / "ui" / "visualize-section.yaml"
_CHART_SCHEMAS = (_PKG.parents[1] / "libs" / "viz" / "src" / "viz-core" / "charts"
                  / "chartSchemas.ts")


def _spec():
    return yaml.safe_load(_SECTION.read_text())


def _strings(node):
    if isinstance(node, str):
        yield node
    elif isinstance(node, dict):
        for v in node.values():
            yield from _strings(v)
    elif isinstance(node, list):
        for v in node:
            yield from _strings(v)


def test_volcano_is_already_in_the_shipped_closed_chart_kind_list():
    """Read out of the viz library itself, so this test fails if the shipped list ever stops
    containing the kind this section depends on."""
    assert _CHART_SCHEMAS.is_file(), _CHART_SCHEMAS
    src = _CHART_SCHEMAS.read_text()
    assert re.search(r"['\"]volcano['\"]", src), "the shipped chart-kind list has no `volcano`"
    assert not re.search(r"['\"]beeswarm['\"]", src), (
        "a `beeswarm` kind appeared in the viz library — if this feature added it, that is the "
        "src-app change #124 exists to avoid")


def test_the_section_applies_to_the_datatype_and_reads_the_da_report():
    manifest = yaml.safe_load((_PKG / "manifest.yaml").read_text())
    section = manifest["contributes"]["sections"][0]
    assert section["applies_to"] == [{"type_id": "da/result"}]
    assert section["pane"] == "visualize"

    spec = _spec()
    report = spec["data"]["report"]
    assert report["source"] == "job.result"
    assert report["args"]["datatype"] == "report/qc"
    assert report["args"]["shape"] == "document"
    assert report["args"]["kind"] == "da-report"


def test_the_regime_rides_each_row_as_a_qualifier_never_as_a_badge():
    """`EntryListRenderer` renders `$row.qualifier` beside the name and draws no `badge` at all.
    The DE package shipped that bug once and corrected it; this section does not repeat it."""
    entry_list = next(w for w in _spec()["widgets"] if w["kind"] == "entry_list")
    assert entry_list["entries"] == "$data.report.comparisons"
    assert "badge" not in entry_list
    text = "\n".join(_strings(_spec()))
    assert "$row.regime" in text


def test_plot_is_a_verb_so_pressing_twice_opens_two_volcanoes():
    spec = _spec()
    entry_list = next(w for w in spec["widgets"] if w["kind"] == "entry_list")
    assert entry_list["action"]["label"] == "Plot"
    plot = next(a for a in spec["actions"] if a["id"] == entry_list["action"]["onClick"])
    ops = [k for effect in plot["body"] for k in effect]
    assert ops == ["listAppend"], (
        "Plot must APPEND — a row is an act, not a selected choice, so a second press opens a "
        "second volcano")
    assert plot["mutating"] is False and plot["stateful"] is True


def test_the_canvas_binds_the_shipped_volcano_kind_to_the_HEADLINE_significance_column():
    """INV-DA-4 says every threshold, badge and headline reads `spatial_fdr`. The volcano's
    significance channel IS the only threshold surface this feature ships — `VolcanoView`'s
    DragRail compares `y >= pThreshold` on exactly this column — so binding it to the raw
    `neglog10p` would leave the correction computed, stored, and never used by the one control
    that thresholds anything. It binds to `neglog10_significance`, which each producer fills with
    the −log10 of the correction IT headlines."""
    canvas = _spec()["canvas"]
    series = canvas["series"][0]
    assert series["type"] == "volcano"
    assert series["switchTo"] == ["volcano"], (
        "there is no other honest reading of an effect-vs-significance table over populations")
    assert series["encode"]["effectColumn"] == "logFC"
    assert series["encode"]["significanceColumn"] == "neglog10_significance", (
        "the significance channel must be the ADJUSTED headline column, not the raw p")
    assert series["encode"]["significanceColumn"] != "neglog10p"
    assert series["for_each"] == "$state.plots as $c, $i"
    assert canvas["datasets"][0]["for_each"] == "$state.plots as $c, $i"


def test_the_headline_column_the_canvas_binds_is_one_the_kind_declares():
    """A binding to a column no producer writes renders NOTHING, silently: `bindColumn` honours an
    explicit declaration verbatim and resolves to nothing when the table lacks it. So the encode
    has to name a DECLARED member, not a hoped-for one."""
    manifest = yaml.safe_load((_PKG / "manifest.yaml").read_text())
    dt = next(d for d in manifest["contributes"]["datatypes"] if d["id"] == "da/result")
    members = {a["name"] for a in next(x for x in dt["arrays"] if x["name"] == "table")["attrs"]}
    encode = _spec()["canvas"]["series"][0]["encode"]
    assert encode["effectColumn"] in members
    assert encode["significanceColumn"] in members


def test_absence_is_absence_is_surfaced_rather_than_drawn_as_an_empty_axis():
    """An R2/R3 result has NO significance column at all, so the volcano genuinely cannot be
    drawn — `VolcanoView.bindColumn` honours the declared name verbatim and resolves to nothing
    when the table lacks it. The section has to say that, and say it accurately: 'plots ranked
    effect only' would be a nicer sentence and a false one."""
    text = " ".join(_strings(_spec())).lower()
    assert "absent, not 1" in text
    assert "renders empty" in text, (
        "the section must say what actually happens for an R2/R3 row, not something kinder")
    assert "the regime is shown beside each row" in text, (
        "the reader has to be able to tell BEFORE pressing Plot")
    alerts = [w for w in _spec()["widgets"] if w["kind"] == "alert"]
    assert alerts, "the section must carry the absence-is-absence alert"


def test_the_section_does_not_assume_one_significance_column_for_both_analyses():
    """Neighbourhood rows headline the connectivity-weighted `spatial_fdr`; cluster rows have no
    such column at all and headline plain `padj`. The section reconciles the two the only way that
    does not conflate them — by binding ONE column that each PRODUCER fills with its own
    correction — and this asserts the mechanism, not the prose.

    An earlier version of this test was a substring grep over the alert text. It passed while the
    encode thresholded on the raw p, and would have kept passing if `spatial_fdr` had been deleted
    from the pipeline entirely, as long as the word 'spatial' survived in a sentence."""
    encode = _spec()["canvas"]["series"][0]["encode"]
    assert encode["significanceColumn"] == "neglog10_significance"

    # …and the two producers really do fill it from DIFFERENT sources, read out of their own code.
    compute = _PKG / "compute"
    nhoods = (compute / "neighbourhoods.py").read_text()
    clusters = (compute / "clusters.py").read_text()
    assert 'cols["neglog10_significance"] = K.neglog10(spatial_written)' in nhoods
    assert 'cols["neglog10_significance"] = K.neglog10(padj_written)' in clusters
    assert 'cols["spatial_fdr"]' not in clusters, (
        "a cluster result must never carry a connectivity-weighted column")

    # the prose still has to explain WHY, but it is no longer the whole assertion
    text = " ".join(_strings(_spec())).lower()
    assert "spatial" in text and "disjoint" in text


def test_the_section_reuses_projects_use_and_adds_no_permission():
    spec = _spec()
    assert spec["permission"] == "projects::use"
    for action in spec["actions"]:
        assert action["permission"] == "projects::use"


def test_it_mirrors_the_shipped_de_section_rather_than_being_a_bespoke_card():
    de = yaml.safe_load(
        (_PKG.parent / "differential-expression" / "ui" / "visualize-section.yaml").read_text())
    ours = _spec()
    assert {w["kind"] for w in ours["widgets"]} <= ({w["kind"] for w in de["widgets"]} | {"alert"})
    assert ours["canvas"]["series"][0]["type"] == de["canvas"]["series"][0]["type"] == "volcano"
    assert set(ours["state"]) == set(de["state"]) == {"plots"}
    assert ours["badge"] == de["badge"] == "$state.plots.length"
