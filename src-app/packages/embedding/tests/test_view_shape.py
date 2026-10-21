#!/usr/bin/env python3
# ruff: noqa
"""TEST-26 / TEST-27 [acceptance] [invariant: INV-17, INV-18, INV-20] — the two declarative
views as DATA (the src-app-free proof, DEC-13).

TEST-26 (INV-17/INV-18): each view OWNS everything the user sees + selects and declares its
own option sources; every input the run consumes (the matrix / embedding, the batch column,
the parameters) is a visible form control passed EXPLICITLY in `run_processor` — nothing is
resolved invisibly between click and job; the honesty note is present in the visualize view.

TEST-27 (INV-20): the batch/covariate options and the output-name taken-set derive from the
DATA (`axis_columns`/`$derived`), never a hardcoded closed list standing in for the open set;
no raw-JSON field anywhere (every input is one typed control).
"""
import ast
import re
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_UI = Path(__file__).resolve().parents[1] / "ui"
_COMPUTE = Path(__file__).resolve().parents[1] / "compute"

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


def _honesty_note_constant():
    """The `HONESTY_NOTE` string literal out of `compute/visualize.py` — the single source."""
    tree = ast.parse((_COMPUTE / "visualize.py").read_text())
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            for t in node.targets:
                if isinstance(t, ast.Name) and t.id == "HONESTY_NOTE":
                    return ast.literal_eval(node.value)
    raise AssertionError("HONESTY_NOTE not found in visualize.py")


def _norm(s):
    return re.sub(r"\s+", " ", s).strip()


# ── shared shape (INV-16/INV-17 — the view is data, not a bespoke component) ──────────
@pytest.mark.parametrize("name", ["reduce.yaml", "visualize.yaml"])
def test_view_is_declared_as_data(name):
    view = _load(name)
    # Declared as data: the grammar sections, no bespoke React (nothing here names a
    # component), the EXISTING permission (this feature introduces none), and none of the
    # keys `parseViewSpec` refuses.
    assert view["permission"] == "jobs::use"
    assert isinstance(view.get("state"), dict) and view["state"]
    assert isinstance(view.get("widgets"), list) and view["widgets"]
    assert isinstance(view.get("actions"), list) and view["actions"]
    assert "analysis" not in view          # the manifest owns the binding (no back-pointer)
    assert "layout" not in view            # INV-3
    # Every widget is a CORE typed control — no raw-JSON textarea stands in for a form
    # (INV-18/INV-20). Table cells are typed too, but these two views use flat controls.
    for w in _widgets(view):
        assert w["kind"] in CORE_WIDGET_KINDS, (name, w.get("id"), w["kind"])


def test_visualize_has_no_canvas():
    # ITEM-12 — §Coordinates already renders plottable-xy dims:2; a second surface competes.
    assert "canvas" not in _load("visualize.yaml")


# ── TEST-26 — every run input is a VISIBLE control passed EXPLICITLY (INV-17/INV-18) ──
def test_reduce_inputs_are_visible_and_explicit():
    view = _load("reduce.yaml")
    rp = _run_processor(view)
    assert rp["id"] == "embedding.reduce"

    # The matrix input is EXPLICIT (from state), and a visible control holds that state.
    assert rp["inputs"]["matrices"] == "$state.matrix"
    picker = _widget_by_id(view, "matrixPicker")
    assert picker and picker["kind"] == "artifact_ref" and picker["value"] == "$state.matrix"

    # Every param is passed EXPLICITLY from view state (nothing invisible), and each state
    # field it names is backed by a VISIBLE widget the user sets before Run. `criteria` is the
    # inline filter, backed by the `criteriaTable` (a `rows:` binding, not `value:`).
    params = rp["params"]
    for key in ("criteria", "n_hvg", "n_pcs", "seed", "name", "integration", "batch_column"):
        assert key in params, key
        assert str(params[key]).startswith("$state."), (key, params[key])
    # a state field is "visible" if some control reads it — a scalar via `value`, a list via
    # a table's `rows`.
    widget_state_values = {w.get("value") for w in _widgets(view)}
    widget_state_values |= {w.get("rows") for w in _widgets(view)}
    for pval in params.values():
        # each param's $state.X is a control's value/rows somewhere on the form (INV-18)
        for ref in _state_refs(pval):
            assert f"$state.{ref}" in widget_state_values, ref

    # The batch column drives a REAL slot binding (its values reach the run), gated on a
    # column being chosen — no batch, no binding. Bound from the data, not typed.
    binding = next(b for b in rp["inputs_from"] if b["slot"] == "batch")
    assert binding["when"] == "$state.batchColumn"
    assert binding["artifact"] == "$data.obsSources[$state.batchColumn]"


def test_filter_criteria_builder_is_visible_and_passed_explicitly():
    # TEST-26 filter clause (INV-17/INV-18) — the inline filter is a VISIBLE control whose
    # every criterion the run consumes is passed EXPLICITLY: `params.criteria` + one
    # `column:<name>` slot per criterion, gated on the criterion having a column. Nothing is
    # resolved invisibly between the builder and the job.
    view = _load("reduce.yaml")
    table = _widget_by_id(view, "criteriaTable")
    assert table and table["kind"] == "table"
    assert table["rows"] == "$state.criteria"        # the builder reads the criteria list
    assert _widget_by_id(view, "addCriterionBtn")    # and there is an affordance to add one

    rp = _run_processor(view)
    # the recipe is passed EXPLICITLY as the ONE encoding the compute reads
    assert rp["params"]["criteria"] == "$state.criteria"
    # …and each criterion's obs column reaches the run as a `column:<name>` slot bound from
    # the data (not typed), gated on the criterion having a column.
    col_binding = next(
        b for b in rp["inputs_from"] if str(b.get("slot", "")).startswith("column:"))
    assert col_binding["for_each"] == "$state.criteria as $c"
    assert col_binding["when"] == "$c.column"
    assert col_binding["slot"] == "column:{$c.column}"
    assert col_binding["artifact"] == "$data.obsSources[$c.column]"


def test_filter_column_selector_derives_from_axis_columns():
    # TEST-27 filter clause (INV-20) — the filter column selector, its category values, and its
    # range extents all DERIVE from the data (the cells-axis `axis_columns` relation), never a
    # hardcoded closed list standing in for the open obs set (ITEM-2d/14d).
    view = _load("reduce.yaml")
    # the criterion column picker offers `$derived.columns` — the OPEN column set…
    table = _widget_by_id(view, "criteriaTable")
    col_cell = next(c for c in table["columns"] if c["key"] == "column")["cell"]["select"]
    assert col_cell["options"] == "$derived.columns"
    # …and every criteria-builder derived is `columns_of`/`categories_by_column` over
    # `$data.obs`, which is `axis_columns` over the CHOSEN matrix's cells axis.
    derived = view.get("derived") or {}
    assert "columns_of" in derived["columns"]
    assert "columns_of" in derived["controlByColumn"]
    assert "categories_by_column" in derived["categoriesByColumn"]
    obs = view["data"]["obs"]
    assert obs["source"] == "axis_columns"
    assert obs["args"]["axis"] == "cells"
    assert obs["args"]["of"] == "$state.matrix"
    # the category keep-set + range widgets read their options/bounds from the data too — no
    # inline literal anywhere in the builder.
    keep_cell = next(c for c in table["columns"] if c["key"] == "constraint")
    keep = next(p for p in keep_cell["parts"] if p["key"] == "keep")["cell"]["multiselect"]
    assert keep["options"] == "$derived.categoriesByColumn[$row.column]"


def test_visualize_inputs_are_visible_and_explicit():
    view = _load("visualize.yaml")
    rp = _run_processor(view)
    assert rp["id"] == "embedding.visualize"

    assert rp["inputs"]["embedding"] == "$state.embedding"
    picker = _widget_by_id(view, "embeddingPicker")
    assert picker and picker["kind"] == "artifact_ref" and picker["value"] == "$state.embedding"

    params = rp["params"]
    for key in ("method", "n_neighbors", "min_dist", "metric", "seed", "name"):
        assert key in params, key
        assert str(params[key]).startswith("$state."), (key, params[key])
    widget_state_values = {w.get("value") for w in _widgets(view)}
    for pval in params.values():
        for ref in _state_refs(pval):
            assert f"$state.{ref}" in widget_state_values, ref


def test_honesty_note_present_and_matches_the_compute_constant():
    # INV-13/§B.5/DEC-8 — the always-visible lossy-summary note, and it is the SAME sentence
    # the compute records (`HONESTY_NOTE`), so the two cannot drift (DRIFT-1 D2).
    view = _load("visualize.yaml")
    note = _widget_by_id(view, "honestyNote")
    assert note and note["kind"] == "alert"
    assert _norm(note["text"]) == _norm(_honesty_note_constant())


# ── TEST-27 — options DERIVE from data; no closed list stands in for the open set ─────
def test_batch_options_derive_from_the_data():
    view = _load("reduce.yaml")
    # The batch/covariate options are a $-ref into a data-derived list, NEVER an inline
    # literal (INV-20). The categorical columns come from the chosen matrix's cells axis.
    batch = _widget_by_id(view, "batchColumnPicker")
    assert batch["kind"] == "select"
    assert isinstance(batch["options"], str) and batch["options"].startswith("$")
    # …and that ref resolves to a `columns_of` over an `axis_columns` slice — the OPEN set.
    derived = view.get("derived") or {}
    assert "columns_of" in derived["catColumns"]
    assert view["data"]["obs"]["source"] == "axis_columns"
    assert view["data"]["obs"]["args"]["axis"] == "cells"
    assert view["data"]["obs"]["args"]["of"] == "$state.matrix"


def test_output_name_taken_set_is_data_not_a_literal():
    # The name `not_in` set is the cells axis's OWN columns (`as: sources`), read from data,
    # not a hardcoded reserved list (INV-20).
    for name, ref in (("reduce.yaml", "$state.matrix"), ("visualize.yaml", "$state.embedding")):
        view = _load(name)
        src = view["data"]["obsSources"]
        assert src["source"] == "axis_columns"
        assert src["args"]["as"] == "sources"
        assert src["args"]["of"] == ref
        name_widget = _widget_by_id(view, "nameInput")
        assert name_widget["require"]["not_in"] == "$data.obsSources"


def test_closed_selects_are_genuinely_closed_sets():
    # INV-20 forbids a closed list standing in for an OPEN set — it does NOT forbid a closed
    # list for a genuinely closed one. integration/method/metric ARE closed vocabularies (the
    # compute compares against fixed strings), declared as `const` data, which is correct.
    reduce = _load("reduce.yaml")
    assert _widget_by_id(reduce, "integrationPicker")["options"] == "$const.integrationModes"
    assert {m["value"] for m in reduce["const"]["integrationModes"]} == {"none", "harmony"}
    viz = _load("visualize.yaml")
    assert _widget_by_id(viz, "methodPicker")["options"] == "$const.methods"
    assert {m["value"] for m in viz["const"]["methods"]} == {"umap", "tsne"}
