#!/usr/bin/env python3
# ruff: noqa
"""Stage-C view-shape acceptance anchors — the two declarative views as DATA (the src-app-free
proof). The EA `test_view_shape.py` twin, scoped to the clustering package.

TEST-19 (INV-19, run-form clause) — `ui/clustering.yaml` / `ui/markers.yaml` are declared as
        DATA (grammar sections, no bespoke component), reuse the EXISTING `jobs::use`
        permission (no new gate), and carry no `analysis`/`layout` back-pointer. Every widget
        is a CORE typed control — no raw-JSON textarea stands in for a form.
TEST (INV-18) — every input the RUN consumes (the embedding, the optional expression, the
        parameters) is a VISIBLE control passed EXPLICITLY on `run_processor`; nothing is
        resolved invisibly between click and job.
TEST (INV-20) — the option sources DERIVE from the data (the embedding picker's datatype
        source, the output-name `not_in` taken-set from `axis_columns`, the cluster picker's
        options from the produced report's own `levels`), never a hardcoded closed list
        standing in for an open set. The genuinely-closed metric vocabulary is `const` data.
TEST-16 (INV-16) — the free coloured-UMAP-by-cluster is served by the SHIPPED colour-by
        section (a categorical `metadata-column`); the markers view adds NO bespoke colour
        surface. (The data-level colour-by binding proof lives in `test_colour_by_binding.py`.)
TEST (CL-INV-1) — the markers readout SURFACES the double-dipping disclosure from the produced
        report (a `$data.report.markers.disclosure` ref — the report's own copy, single
        source), never a duplicated literal that can drift.
"""
import re
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_UI = _PKG / "ui"

# The core FORM-CONTROL widget kinds (`vocabulary.ts` WIDGET_KINDS) — a raw-JSON textarea is
# NOT among them. INV-18/INV-20's "no raw-JSON blob" is exactly "every widget is one of these".
CORE_WIDGET_KINDS = {
    "select", "text", "multiselect", "range_slider", "list-editor", "table",
    "button", "alert", "stat", "group", "dataset-picker", "artifact_ref",
}


def _load(name):
    return yaml.safe_load((_UI / name).read_text())


def _widgets(view):
    return view.get("widgets") or []


def _widget_by_id(view, wid):
    return next((w for w in _widgets(view) if w.get("id") == wid), None)


def _run_processor(view):
    """The single `run_processor` effect in the view's Run action."""
    for act in view.get("actions") or []:
        for step in act.get("body") or []:
            if isinstance(step, dict) and "run_processor" in step:
                return step["run_processor"]
    raise AssertionError("no run_processor step found")


def _state_refs(value):
    """Every `$state.X` name referenced anywhere inside `value` (str/dict/list)."""
    out = set()
    if isinstance(value, str):
        out.update(re.findall(r"\$state\.([A-Za-z_][A-Za-z0-9_]*)", value))
    elif isinstance(value, dict):
        for v in value.values():
            out |= _state_refs(v)
    elif isinstance(value, list):
        for v in value:
            out |= _state_refs(v)
    return out


# ── shared shape (INV-17/INV-19 — the views are data, not a bespoke component) ─────────
@pytest.mark.parametrize("name", ["clustering.yaml", "markers.yaml"])
def test_view_is_declared_as_data(name):
    view = _load(name)
    assert view["permission"] == "jobs::use"          # the EXISTING gate — no new permission
    assert isinstance(view.get("state"), dict)
    assert isinstance(view.get("widgets"), list) and view["widgets"]
    assert isinstance(view.get("actions"), list)
    assert "analysis" not in view                     # the manifest owns the binding (no back-pointer)
    assert "layout" not in view                       # INV-19 (no widget→dock map)
    for w in _widgets(view):
        assert w["kind"] in CORE_WIDGET_KINDS, (name, w.get("id"), w["kind"])


# ── TEST-18 — every RUN input is a VISIBLE control passed EXPLICITLY (INV-17/INV-18) ──
def test_run_inputs_are_visible_and_explicit():
    view = _load("clustering.yaml")
    rp = _run_processor(view)
    assert rp["id"] == "clustering.cluster"

    # The embedding input is EXPLICIT (from state) and a visible control holds that state.
    assert rp["inputs"]["embedding"] == "$state.embedding"
    picker = _widget_by_id(view, "embeddingPicker")
    assert picker and picker["kind"] == "artifact_ref" and picker["value"] == "$state.embedding"

    # Every param is passed EXPLICITLY from view state, and each state field it names is backed
    # by a VISIBLE widget the user sets before Run.
    params = rp["params"]
    for key in ("resolution", "n_neighbors", "metric", "seed", "name"):
        assert key in params, key
        assert str(params[key]).startswith("$state."), (key, params[key])
    widget_state_values = {w.get("value") for w in _widgets(view)}
    for pval in params.values():
        for ref in _state_refs(pval):
            assert f"$state.{ref}" in widget_state_values, ref


def test_optional_expression_input_is_visible_and_gated():
    # INV-18 — the OPTIONAL markers input is a VISIBLE control, and it reaches the run as a
    # slot binding GATED on a matrix being chosen (no expression → no binding, labels-only).
    view = _load("clustering.yaml")
    picker = _widget_by_id(view, "expressionPicker")
    assert picker and picker["kind"] == "artifact_ref"
    assert picker["value"] == "$state.expression"
    # optional ⇒ NO `required`
    assert not (picker.get("require") or {}).get("required")

    rp = _run_processor(view)
    binding = next(b for b in rp.get("inputs_from", []) if b["slot"] == "expression")
    assert binding["when"] == "$state.expression"
    assert binding["artifact"] == "$state.expression"


# ── TEST-20 — options DERIVE from data; no closed list stands in for the open set ─────
def test_output_name_taken_set_is_data_not_a_literal():
    # The name `not_in` set is the chosen embedding's OWN cells-axis columns (`as: sources`),
    # read from data, not a hardcoded reserved list (INV-20).
    view = _load("clustering.yaml")
    src = view["data"]["obsSources"]
    assert src["source"] == "axis_columns"
    assert src["args"]["as"] == "sources"
    assert src["args"]["of"] == "$state.embedding"
    assert src["args"]["axis"] == "cells"
    name_widget = _widget_by_id(view, "nameInput")
    assert name_widget["require"]["not_in"] == "$data.obsSources"


def test_embedding_picker_keys_on_the_datatype_open_set():
    # INV-17/INV-20 — the picker LISTS by the `embedding` datatype (an open set of every
    # embedding in the project), not a forecast list; the manifest's `appliesTo` governs
    # offering, this control's `source` governs listing.
    view = _load("clustering.yaml")
    picker = _widget_by_id(view, "embeddingPicker")
    assert picker["source"] == {"datatype": "embedding"}


def test_metric_is_a_genuinely_closed_const_set():
    # INV-20 forbids a closed list standing in for an OPEN set — NOT a closed list for a
    # genuinely closed one. The metric is a fixed vocabulary the compute compares against,
    # declared as `const` data (correct); the resolution/n_neighbors/seed are open numeric text.
    view = _load("clustering.yaml")
    assert _widget_by_id(view, "metricPicker")["options"] == "$const.metrics"
    assert {m["value"] for m in view["const"]["metrics"]} >= {"euclidean", "cosine"}


def test_resolution_field_is_labelled_with_its_objective():
    # INV-4 — the exposed resolution control names the modularity objective it drives (so a
    # `resolution` is never read as comparable across objectives).
    view = _load("clustering.yaml")
    res = _widget_by_id(view, "resolutionInput")
    assert re.search(r"modularity", res["label"], re.I)


# ── the MARKERS readout — descriptive table + single-source disclosure (CL-INV-1) ─────
def test_markers_view_reads_the_report_via_job_result():
    # INV-17 — the marker gene/cluster FACTS are read from the produced report artifact, never
    # forecast: the readout binds a `job.result` DOCUMENT slice narrowed to THIS analysis and
    # discriminated by `kind: clustering-report`.
    view = _load("markers.yaml")
    slice_ = view["data"]["report"]
    assert slice_["source"] == "job.result"
    assert slice_["args"]["datatype"] == "report/qc"
    assert slice_["args"]["produced_by"] == "clustering.cluster"
    assert slice_["args"]["shape"] == "document"
    assert slice_["args"]["kind"] == "clustering-report"


def test_markers_table_is_a_table_of_the_report_markers():
    # The fallback the plan names (no shipped dotplot binding): a TABLE view of the report/qc
    # markers, rows read from the report's per-cluster markers, columns a RANKING (score /
    # effect size / expression fraction) — no p-value/FDR column headlined (CL-INV-1).
    view = _load("markers.yaml")
    table = _widget_by_id(view, "markersTable")
    assert table and table["kind"] == "table"
    assert table["rows"] == "$data.report.markers.per_cluster[$state.markerCluster]"
    col_keys = {c["key"] for c in table["columns"]}
    assert {"gene", "rank", "score", "log2fc"} <= col_keys
    # no inference column is headlined as a discovery claim (CL-INV-1 / INV-1).
    for banned in ("pvals", "pvals_adj", "padj", "fdr", "qval", "pvalue", "p_value"):
        assert banned not in col_keys, banned


def test_cluster_picker_options_derive_from_the_report_levels():
    # INV-20 — the cluster ids come from the produced report's OWN explicit `levels` set, read
    # from the artifact, never a forecast/hardcoded list.
    view = _load("markers.yaml")
    picker = _widget_by_id(view, "clusterPicker")
    assert picker["kind"] == "select"
    assert picker["options"] == "$data.report.levels"
    assert isinstance(picker.get("empty_text"), str) and picker["empty_text"].strip()


def test_double_dipping_disclosure_is_surfaced_from_the_report_single_source():
    # CL-INV-1 — the disclosure is ALREADY in the report (Stage B); the readout SURFACES that
    # copy via a `$data` ref (single source), never a duplicated literal that can drift from
    # `_markers.py::MARKER_DISCLOSURE`.
    view = _load("markers.yaml")
    note = _widget_by_id(view, "doubleDippingNote")
    assert note and note["kind"] == "alert"
    assert note["text"] == "$data.report.markers.disclosure"
    # …and it is a pure data ref, not prose with a copy of the sentence baked in.
    assert note["text"].startswith("$data.") and " " not in note["text"].strip()


def test_markers_view_adds_no_bespoke_colour_surface():
    # INV-16 / owner DEC-9(c) — the coloured-UMAP-by-cluster is FREE (the shipped colour-by
    # section reads the categorical `metadata-column`); a bespoke colour control HERE would be
    # the defect. The readout carries only the disclosure + the cluster picker + the marker
    # table — nothing that re-implements colouring.
    view = _load("markers.yaml")
    ids = {w.get("id") for w in _widgets(view)}
    assert ids == {"doubleDippingNote", "clusterPicker", "markersTable"}
