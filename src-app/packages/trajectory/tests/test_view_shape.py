#!/usr/bin/env python3
# ruff: noqa
"""TEST-22 — the declarative views conform, and name only what the compute resolves.

The app-side parser is the real schema and enforces most of this on its own; this suite is
the package's own copy, so a break is attributable HERE and shows up in the package's suite
rather than only in the whole-tree frontend run.

Two rules in the shipped parser bite a first draft and are asserted explicitly because they
are easy to reintroduce: any binding that depends on another choice must declare the
sentence its emptiness reads as, and a closed-set control's unset is `null` (an empty string
is a value somebody chose).

The kind allowlist here is the FULL shipped vocabulary, deliberately unlike the sibling
packages' copies of this test, which omit several kinds they happen not to use — copying one
of those verbatim would have failed this package's own tabbed root selector.

Mutation: name a widget kind or data source that does not exist -> the vocabulary tests fail
here and the package would fail to register at run time. Bind a run param to something other
than form state -> the explicit-params test fails, which is the rule that keeps "what was
launched" equal to "what was shown".
"""
import re
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_VIEWS = sorted((_PKG / "ui").glob("*.yaml"))

#: The FULL shipped widget vocabulary.
WIDGET_KINDS = {
    "select", "text", "multiselect", "range_slider", "list-editor", "tabs", "token-input",
    "table", "button", "alert", "stat", "group", "dataset-picker", "artifact_ref",
}
#: The FULL shipped data-source vocabulary.
DATA_SOURCES = {
    "job.result", "axis_columns", "row_space_columns", "compatible_columns",
    "integration_grid", "axis_entries", "axis_entry_values", "axis_entry_rows",
    "pane_frame", "column_values",
}
#: Keys the parser REFUSES outright.
REFUSED_TOP_LEVEL = {"layout", "area", "region", "analysis"}


def _load(path):
    return yaml.safe_load(path.read_text())


def _widgets(view):
    """Every widget, descending into the containers the parser descends into."""
    out = []

    def visit(nodes):
        for w in nodes or []:
            out.append(w)
            visit(w.get("children"))
            for tab in w.get("tabs") or []:
                visit(tab.get("children"))
            item = w.get("item")
            if isinstance(item, dict):
                visit(item.get("children"))

    visit(view.get("widgets"))
    return out


def test_there_are_views_to_check():
    """Vacuity floor: an empty glob would make every test below pass over nothing."""
    assert len(_VIEWS) == 4, [p.name for p in _VIEWS]


@pytest.mark.parametrize("path", _VIEWS, ids=lambda p: p.name)
def test_the_required_top_level_keys_are_present_and_the_refused_ones_absent(path):
    view = _load(path)
    for key in ("id", "title", "permission", "state", "widgets", "actions"):
        assert key in view, f"{path.name} declares no {key!r}"
    assert isinstance(view["state"], dict)
    assert isinstance(view["widgets"], list) and view["widgets"]
    assert isinstance(view["actions"], list)
    for refused in REFUSED_TOP_LEVEL:
        assert refused not in view, (
            f"{path.name} declares {refused!r}, which the parser refuses: one analysis "
            "renders into ONE pane and the widget ORDER is the layout")


@pytest.mark.parametrize("path", _VIEWS, ids=lambda p: p.name)
def test_every_view_reuses_the_existing_permission(path):
    """This feature introduces NO permission. Inventing one would be a new authz surface for
    no reason, and would drag a whole gating tier behind it."""
    assert _load(path)["permission"] == "jobs::use"


@pytest.mark.parametrize("path", _VIEWS, ids=lambda p: p.name)
def test_every_widget_kind_is_in_the_shipped_vocabulary(path):
    for w in _widgets(_load(path)):
        assert w.get("kind") in WIDGET_KINDS, (
            f"{path.name} widget {w.get('id')!r} names kind {w.get('kind')!r}, which is not "
            "in the shipped vocabulary — the package would fail to register it")


@pytest.mark.parametrize("path", _VIEWS, ids=lambda p: p.name)
def test_every_data_source_is_in_the_shipped_vocabulary(path):
    for name, slice_ in (_load(path).get("data") or {}).items():
        assert slice_["source"] in DATA_SOURCES, (
            f"{path.name} slice {name!r} names source {slice_['source']!r}, which no "
            "resolver serves — it would render empty with an error status rather than fail "
            "loudly, so an invented source is worse than a missing one")


@pytest.mark.parametrize("path", _VIEWS, ids=lambda p: p.name)
def test_a_closed_set_control_never_defaults_to_the_empty_string(path):
    """`null` is the only unset for a closed set; `""` is a value somebody chose, and the
    set never offers it — so a control bound to it opens already showing a choice nobody
    made. A real member of the set IS a legitimate default (the recommended one)."""
    view = _load(path)
    closed = {w.get("value") for w in _widgets(view)
              if w.get("kind") in ("select", "artifact_ref") and w.get("value")}
    for field, spec in view["state"].items():
        if f"$state.{field}" in closed:
            assert spec.get("default") != "", (
                f"{path.name} state {field!r} is bound to a closed-set control and defaults "
                'to "" — use null, the only unset')


@pytest.mark.parametrize("path", _VIEWS, ids=lambda p: p.name)
def test_a_dependent_binding_declares_the_sentence_its_emptiness_reads_as(path):
    """The parser requires it, and the reason is real: a control whose options depend on
    another choice is empty for a reason the user needs told, and an unexplained empty list
    reads as a broken app."""
    for w in _widgets(_load(path)):
        for key in ("source", "options", "entries", "rows"):
            bound = w.get(key)
            # The parser's own dependency test: another control's value, or the pane's
            # anchor. A `$derived.` binding that reaches neither is not dependent.
            if isinstance(bound, str) and ("$state." in bound or "$scope.axis" in bound):
                assert w.get("empty_text"), (
                    f"{path.name} widget {w.get('id')!r} binds {key!r} to a dependent "
                    "expression but declares no empty_text")


@pytest.mark.parametrize("path", _VIEWS, ids=lambda p: p.name)
def test_every_widget_event_names_a_declared_action(path):
    view = _load(path)
    declared = {a["id"] for a in view["actions"]}
    for w in _widgets(view):
        for key in ("onClick", "onChange", "onCommit", "onSelect"):
            if w.get(key):
                assert w[key] in declared, (
                    f"{path.name} widget {w.get('id')!r} references undeclared action "
                    f"{w[key]!r}")


@pytest.mark.parametrize("path", _VIEWS, ids=lambda p: p.name)
def test_every_action_declares_the_existing_permission(path):
    for action in _load(path)["actions"]:
        assert action.get("permission") == "jobs::use", (
            f"{path.name} action {action.get('id')!r} declares "
            f"{action.get('permission')!r}")
        assert action.get("title"), f"{path.name} action {action.get('id')!r} has no title"


# ── the VIEW <-> COMPUTE seam ─────────────────────────────────────────────────────────
def _run_blocks():
    for path in _VIEWS:
        for action in _load(path).get("actions") or []:
            for effect in action.get("body") or []:
                if "run_processor" in effect:
                    yield path, effect["run_processor"]


def _compute_slots(analysis_id):
    """The literal slot names the compute resolves, read from its source the same way the
    app-side seam reader does."""
    entry = {"trajectory.paga": "paga.py", "trajectory.dpt": "dpt.py"}[analysis_id]
    sources = [(_PKG / "compute" / entry).read_text(),
               (_PKG / "compute" / "_shared.py").read_text()]
    names = set()
    for src in sources:
        names |= set(re.findall(r'^[A-Z][A-Z0-9_]*_SLOT\s*=\s*["\']([^"\']+)["\']', src,
                                re.M))
    return names


def test_there_are_run_blocks_to_check():
    assert len(list(_run_blocks())) == 2


@pytest.mark.parametrize("path,block", list(_run_blocks()),
                         ids=lambda x: getattr(x, "name", "block"))
def test_a_run_block_names_only_slots_its_compute_resolves(path, block):
    known = _compute_slots(block["id"])
    assert known, "the compute's slot vocabulary read back empty — an unreadable contract"
    named = set((block.get("inputs") or {}).keys())
    named |= {e["slot"] for e in (block.get("inputs_from") or [])}
    unknown = named - known
    assert not unknown, (
        f"{path.name} binds slot(s) {sorted(unknown)} that compute for {block['id']} does "
        f"not resolve (it resolves {sorted(known)})")


@pytest.mark.parametrize("path,block", list(_run_blocks()),
                         ids=lambda x: getattr(x, "name", "block"))
def test_every_launched_param_is_a_visible_form_value(path, block):
    """What is launched is what was shown: nothing is resolved invisibly between the click
    and the job."""
    view = _load(path)
    state_fields = set(view["state"])
    for name, expr in (block.get("params") or {}).items():
        assert isinstance(expr, str) and expr.startswith("$state."), (
            f"{path.name} param {name!r} is {expr!r} — a run param must come from form "
            "state, so the launched value is the shown value")
        assert expr[len("$state."):] in state_fields, (
            f"{path.name} param {name!r} names undeclared state {expr!r}")
