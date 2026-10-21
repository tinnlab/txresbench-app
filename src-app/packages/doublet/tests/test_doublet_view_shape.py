#!/usr/bin/env python3
# ruff: noqa
"""TEST-17 [covers: ITEM-16, ITEM-17, ITEM-18] — the view <-> compute SEAM.

The shipped `ui/*.yaml` files are loaded AS DATA and checked against what
`compute/doublet.py` actually reads. This is where the per-sample invariant's most realistic
silent regression is caught: **a form that passes the batch column as a PARAM instead of
binding it as a SLOT.** Such a form launches successfully, the compute finds nothing on the
`batch` slot, the run scores the merged matrix as one population, and the report honestly says
`batched: false` — a correct-looking run of a wrong analysis, with no error anywhere.

── The honest limit of this file ───────────────────────────────────────────────────────
`#128` asks for a surface test in the style of `qcSurface.test.ts` / `cellFilterRunInputs.
test.ts`, which drive the REAL TypeScript interpreter. Those live under `src-app/ui/src/`, and
adding one there would violate the zero-`src-app`-change invariant that this package exists to
demonstrate — so the seam is proven here instead, against the compute's own module-level slot
constants. What this does NOT cover is a regression in the interpreter itself; that half is
covered by the shipped `processorViewSpecs.test.ts`, which already parses both of these files
through the real `parseViewSpec`, resolves every `$`-ref and frame-kernel `derived:`, and
asserts the run action "binds every REQUIRED slot of doublet.detect" and "names only slots
compute/doublet.detect resolves".
"""
import re
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_UI = _PKG / "ui"
_COMPUTE_SRC = (_PKG / "compute" / "doublet.py").read_text()


def _view(name):
    return yaml.safe_load((_UI / name).read_text())


def _run_action():
    view = _view("doublet.yaml")
    return next(a for a in view["actions"] if a["id"] == "dd.run")


def _run_processor():
    return _run_action()["body"][0]["run_processor"]


def _compute_constant(name):
    match = re.search(rf'^{name} = "([^"]+)"', _COMPUTE_SRC, flags=re.M)
    assert match, f"{name} is not a module-level constant in compute/doublet.py"
    return match.group(1)


# ── the batch binding: a SLOT, not a param ──────────────────────────────────────────
def test_the_batch_column_is_bound_as_a_slot_named_by_the_compute():
    """The load-bearing assertion of this file. A `metadata-column` store keeps its values
    under the constant member `values` and CANNOT carry its own name, so the chosen column has
    to arrive as a resolved ARTIFACT on a slot; a string param would name a column the compute
    has no way to fetch."""
    bindings = _run_processor()["inputs_from"]
    batch = next(b for b in bindings if b.get("slot") == "batch")

    assert batch["when"] == "$state.batchColumn"
    assert batch["artifact"] == "$data.obsSources[$state.batchColumn]", (
        "the batch slot must resolve through the axis_columns `as: sources` map — that map is "
        "the only place the column NAME is turned into an artifact id")
    assert batch["slot"] == _compute_constant("BATCH_SLOT"), (
        "the view binds a slot name the compute does not read")


def test_the_batch_column_is_NOT_passed_as_an_input_channel_param():
    """The name travels as a param too — that is correct and required, because the report and
    `methods.md` must be able to say WHICH column was used. What must not happen is the name
    being the ONLY channel. So: the param is present AND the slot binding is present."""
    processor = _run_processor()
    assert processor["params"]["batch_column"] == "$state.batchColumn"
    slots = {b.get("slot") for b in processor["inputs_from"]}
    assert "batch" in slots, (
        "the batch column is passed as a param with no slot binding — the compute would find "
        "nothing on `batch` and would silently score the merged matrix as one population")


def test_inputs_and_params_stay_separate_channels():
    processor = _run_processor()
    assert set(processor["inputs"]) == {"matrix"}
    assert processor["inputs"]["matrix"] == "$state.matrix"
    # no artifact reference leaks into the params channel
    for key, value in processor["params"].items():
        assert "obsSources" not in str(value), (key, value)


def test_every_slot_the_view_names_is_one_the_compute_resolves():
    processor = _run_processor()
    named = set(processor["inputs"]) | {b.get("slot") for b in processor["inputs_from"]}
    prefix = _compute_constant("COLUMN_SLOT_PREFIX") if "COLUMN_SLOT_PREFIX" in _COMPUTE_SRC \
        else "column:"
    fixed = {s for s in named if not s.startswith("column:") and not s.startswith("{")}
    assert fixed == {"matrix", "batch"}, fixed
    assert _compute_constant("MATRIX_SLOT") == "matrix"
    # the repeated criterion binding uses cell-filter's `column:<name>` convention
    repeater = next(b for b in processor["inputs_from"] if "for_each" in b)
    assert repeater["slot"] == "column:{$c.column}"
    assert repeater["when"] == "$c.column"
    assert prefix == "column:"


def test_every_param_the_form_sends_is_one_the_compute_reads():
    """A param the compute ignores is a control that silently does nothing — the worst kind
    of form field, because it looks like it works.

    The assertion demands an actual READ (`p.get("key")` or one of the typed coercers), NOT
    merely the token appearing somewhere in the file. A looser check is satisfied by the key
    turning up in the report dict, in `parameters_resolved`, or in a comment — so a param the
    compute only ECHOES BACK into its own provenance record, without ever reaching a Scrublet
    argument, would pass while doing nothing.
    """
    # A read is `p.get("k")`, one of the typed coercers, or a `_resolve_*` helper reading the
    # key off its own `params` argument. The patterns are matched with a LEFT BOUNDARY,
    # because a bare substring test for `params.get("threshold")` is also satisfied by
    # `scrublet_params.get("threshold")` — a read of the RESOLVED-params dict, i.e. precisely
    # the echo-back this test claims to exclude.
    readers = (r'\bp\.get\("{k}"\)', r'_int_or\(p, "{k}"', r'_float_or\(p, "{k}"',
               r'_bool_or\(p, "{k}"', r'_optional_float\(p, "{k}"',
               r'(?<![A-Za-z_])params\.get\("{k}"\)')
    for key in _run_processor()["params"]:
        assert any(re.search(pattern.format(k=re.escape(key)), _COMPUTE_SRC)
                   for pattern in readers), (
            f"the form sends `{key}` but the compute never READS it — it may appear in the "
            "report, in a resolved-params echo, or in a comment, none of which is the same "
            "as reaching the computation")


# ── the correctness rule is stated AT the control ──────────────────────────────────
def test_the_batch_picker_states_the_per_sample_rule_where_the_user_decides():
    """This is the one place a user can prevent the epic's central failure, and the compute
    deliberately refuses to infer it for them — so the reason has to be at the control, not in
    a doc nobody opens."""
    view = _view("doublet.yaml")
    picker = next(w for w in view["widgets"] if w["id"] == "batchColumnPicker")
    help_text = " ".join(picker["help"].split())

    assert "INDEPENDENTLY" in help_text
    assert "separately captured libraries" in help_text
    assert "single capture" in help_text
    assert "wrong answer" in help_text          # unset on a merged matrix is not "different"
    assert "records whether it was batched" in help_text


def test_the_batch_picker_derives_its_options_from_the_data():
    view = _view("doublet.yaml")
    picker = next(w for w in view["widgets"] if w["id"] == "batchColumnPicker")
    assert picker["options"] == "$derived.catColumns"
    derived = view["derived"]["catColumns"]["columns_of"]
    assert derived == {"obs": "$data.obs", "only": "categorical"}
    assert view["data"]["obs"]["source"] == "axis_columns"
    assert view["data"]["obs"]["args"]["axis"] == "cells"
    # a hardcoded option list would be the inference this analysis refuses, in another form
    assert not isinstance(picker["options"], list)


def test_switching_the_matrix_clears_the_batch_column():
    """A batch column is a column of the PREVIOUS matrix's cells axis. Keeping a stale value
    would leave the single most consequential parameter in the analysis pointing at a column
    the new matrix may not carry."""
    setter = next(a for a in _view("doublet.yaml")["actions"] if a["id"] == "dd.setMatrix")
    assert setter["body"][0]["set"]["batchColumn"] is None


# ── declarative hygiene ────────────────────────────────────────────────────────────
@pytest.mark.parametrize("name", ["doublet.yaml", "doublet-report.yaml"])
def test_every_action_declares_a_permission_and_introduces_no_new_gate(name):
    view = _view(name)
    assert view["permission"] == "jobs::use"
    for action in view["actions"]:
        assert action.get("permission") == "jobs::use", action["id"]


@pytest.mark.parametrize("name", ["doublet.yaml", "doublet-report.yaml"])
def test_no_layout_keys_and_no_analysis_backpointer(name):
    raw = (_UI / name).read_text()
    doc = _view(name)
    for forbidden in ("layout", "area", "region", "analysis"):
        assert forbidden not in doc, forbidden
    assert "\nlayout:" not in raw


@pytest.mark.parametrize("name", ["doublet.yaml", "doublet-report.yaml"])
def test_the_readout_carries_no_canvas_level_controls(name):
    """Canvas-level `controls`/`selection`/`filters`/`mask` are LAST-WRITER-WINS across
    contributors on one pane, so at most one section may carry them. This package carries
    none, which is why stacking its two fragments cannot fight a sibling section."""
    doc = _view(name)
    for key in ("canvas", "controls", "selection", "filters", "mask"):
        assert key not in doc, key


def test_the_manifest_lists_both_views_in_render_order():
    manifest = yaml.safe_load((_PKG / "manifest.yaml").read_text())
    analysis = manifest["contributes"]["analyses"][0]
    assert analysis["ui"] == ["ui/doublet.yaml", "ui/doublet-report.yaml"], (
        "the run form must render above the readout — the manifest's order IS the layout")
    for entry in analysis["ui"]:
        assert (_PKG / entry).is_file(), entry


# ── the readout reads the report, and does not restate it ──────────────────────────
def test_the_readout_reads_this_analysis_report_as_a_document():
    slice_ = _view("doublet-report.yaml")["data"]["report"]
    assert slice_["source"] == "job.result"
    assert slice_["args"] == {
        "datatype": "report/qc",
        "produced_by": "doublet.detect",
        "shape": "document",
        "kind": "doublet-report",
    }


def test_the_disclosures_are_surfaced_by_reference_not_restated():
    """The report is the single source of these sentences. A copy in the YAML would be a
    second source to drift from it — and the exported `methods.md` reads the same doctrine
    from the manifest, so a third spelling would be worse again."""
    view = _view("doublet-report.yaml")
    widgets = {w["id"]: w for w in view["widgets"]}
    for widget_id, field in (("flagDontDeleteNote", "flag_dont_delete"),
                             ("homotypicNote", "homotypic"),
                             ("methodTradeoffNote", "method_tradeoff"),
                             ("unbatchedWarning", "batching"),
                             ("batchedNote", "batching")):
        assert widgets[widget_id]["text"] == f"$data.report.disclosure.{field}", widget_id

    # …and the sentences themselves do NOT appear as literals anywhere in the view file
    raw = (_UI / "doublet-report.yaml").read_text()
    for phrase in ("FLAGS for inspection", "Homotypic doublets", "Xi & Li"):
        assert phrase not in raw, (
            f"the readout restates {phrase!r} instead of surfacing the report's own copy")


def test_the_readout_states_the_batching_state_and_the_refusal():
    view = _view("doublet-report.yaml")
    widgets = {w["id"]: w for w in view["widgets"]}
    assert widgets["unbatchedWarning"]["when"] == "$data.report.batched == false"
    assert widgets["unbatchedWarning"]["tone"] == "warning"
    assert widgets["batchedNote"]["when"] == "$data.report.batched == true"
    # the no-call refusal is surfaced rather than leaving the user hunting for a column that
    # was deliberately not written
    no_call = widgets["noCallWarning"]
    assert no_call["when"] == "$data.report.call_emitted == false"
    assert "not bimodal" in " ".join(no_call["text"].split())
    assert "explicit threshold" in " ".join(no_call["text"].split())


def test_the_readout_binds_the_per_batch_lookups_the_report_actually_emits():
    view = _view("doublet-report.yaml")
    widgets = {w["id"]: w for w in view["widgets"]}
    assert widgets["batchTable"]["rows"] == "$data.report.batches"
    assert widgets["histogramBatchPicker"]["options"] == "$data.report.batch_names"
    assert widgets["histogramTable"]["rows"] == \
        "$data.report.histogram_by_batch[$state.histogramBatch]"
    assert widgets["histogramThresholdStat"]["value"] == \
        "$data.report.threshold_by_batch[$state.histogramBatch]"

    # every column the per-batch table renders is a key the report's batch records carry
    keys = {c["key"] for c in widgets["batchTable"]["columns"]}
    assert keys <= {"batch_label", "n_cells", "expected_doublet_rate", "rate_source",
                    "threshold", "threshold_source", "n_called", "pct_called"}
    # the rate and its source are BOTH shown: the per-sample prior is the invariant's visible
    # evidence, and "where did this number come from" is half of it
    assert {"expected_doublet_rate", "rate_source"} <= keys


def test_the_distribution_uses_a_shipped_widget_kind_not_an_invented_one():
    """`histogram` is NOT a core widget kind — it is a canvas SERIES type, and a canvas series
    binds a columnar frame, which a `shape: document` report slice is not. The distribution
    therefore ships as a bins TABLE plus a threshold `stat`, which is the fallback #128 names.
    This asserts we took that fallback rather than inventing a kind the parser would reject.
    """
    kinds = {w["kind"] for w in _view("doublet-report.yaml")["widgets"]}
    assert "histogram" not in kinds
    assert kinds <= {"alert", "stat", "select", "table"}, kinds
    widgets = {w["id"]: w for w in _view("doublet-report.yaml")["widgets"]}
    assert widgets["histogramTable"]["kind"] == "table"
    assert widgets["histogramThresholdStat"]["kind"] == "stat"


# ── the run form's own controls ────────────────────────────────────────────────────
def test_the_matrix_picker_mirrors_the_manifests_raw_count_selector():
    view = _view("doublet.yaml")
    picker = next(w for w in view["widgets"] if w["id"] == "matrixPicker")
    manifest = yaml.safe_load((_PKG / "manifest.yaml").read_text())
    selector = manifest["contributes"]["analyses"][0]["appliesTo"][0]

    assert picker["kind"] == "artifact_ref"
    assert picker["auto_bind_sole_candidate"] is True is selector["auto_bind_sole_candidate"]
    assert picker["source"]["subtypes_of"] == selector["subtypes_of"]
    assert picker["source"]["excludes"] == selector["excludes"]


def test_blankable_numeric_fields_say_what_blank_means():
    """`expected_doublet_rate` and `threshold` both have a MEANINGFUL empty value (derive it /
    detect it). A blank field whose placeholder said nothing would read as "unset and
    therefore broken"."""
    widgets = {w["id"]: w for w in _view("doublet.yaml")["widgets"]}
    assert widgets["expectedRateInput"]["placeholder"] == "auto — derived per sample"
    assert widgets["thresholdInput"]["placeholder"].startswith("auto")
    assert _view("doublet.yaml")["state"]["expectedDoubletRate"]["default"] == ""
    assert _view("doublet.yaml")["state"]["threshold"]["default"] == ""
    # …and the threshold's help names the refusal it is the lever for
    help_text = " ".join(widgets["thresholdInput"]["help"].split())
    assert "not bimodal" in help_text
    assert "never invented" in help_text


def test_numeric_fields_are_text_with_a_number_constraint():
    """There is no numeric widget kind in the core vocabulary, so numbers are `text` held to
    the shared decimal grammar by `require.number` — the same idiom `embedding` and
    `clustering` use."""
    widgets = {w["id"]: w for w in _view("doublet.yaml")["widgets"]}
    for widget_id in ("expectedRateInput", "ratePer1kInput", "thresholdInput",
                      "nPrinCompsInput", "simRatioInput", "seedInput"):
        widget = widgets[widget_id]
        assert widget["kind"] == "text", widget_id
        assert "number" in widget["require"], widget_id


def test_the_output_label_refuses_a_name_already_on_the_axis():
    """Runs coexist provenance-immutable, so a second column under an existing name would
    leave two columns with one name and a reader keeps whichever came last."""
    widgets = {w["id"]: w for w in _view("doublet.yaml")["widgets"]}
    label = widgets["labelInput"]
    assert label["require"]["required"] is True
    assert label["require"]["not_in"] == "$data.obsSources"


# ── the form's braces must match the compute's belt ────────────────────────────────
def test_the_forms_numeric_bounds_match_the_computes():
    """A form that ACCEPTS a value the compute REFUSES is a shipped deadlock: the run fails,
    the form says the field is fine, and re-typing the same number changes nothing.

    Both sets of bounds exist for the same reason and must agree. The compute is the belt
    (it is reachable by an agent/MCP call that never rendered the form) and the form is the
    braces (it stops the user before the job is dispatched) — but braces looser than the belt
    are worse than no braces, because they promise the value is usable.
    """
    import re
    import sys
    from pathlib import Path

    compute_dir = Path(__file__).resolve().parents[1] / "compute"
    sys.path.insert(0, str(compute_dir))
    from doublet_fixtures import load_compute

    D = load_compute()

    widgets = {w["id"]: w for w in _view("doublet.yaml")["widgets"]}

    def bounds(widget_id):
        number = widgets[widget_id]["require"]["number"]
        return number.get("min"), number.get("max")

    assert bounds("expectedRateInput") == (D.RATE_MIN_USER, D.RATE_MAX_USER)
    assert bounds("ratePer1kInput") == (D.RATE_PER_1K_MIN, D.RATE_PER_1K_MAX)
    assert bounds("simRatioInput") == (D.SIM_RATIO_MIN, D.SIM_RATIO_MAX)
    assert bounds("nPrinCompsInput") == (1, D.N_PRIN_COMPS_MAX)
    assert bounds("seedInput") == (0, 2 ** 32 - 1)
    # the threshold is a doublet score, and BOTH ends are legal there
    assert bounds("thresholdInput") == (0, 1)


def test_every_state_default_the_form_ships_is_accepted_by_the_compute(detect_run):
    """The form's own defaults must be launchable. This drives a REAL run with exactly the
    `state:` defaults the view declares — the values a user sees the instant the form opens,
    before touching anything — so a bound that excluded its own default could not survive."""
    from doublet_fixtures import require_skimage, structured_counts

    require_skimage()
    view = _view("doublet.yaml")
    state = view["state"]
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok({
        "expected_doublet_rate": state["expectedDoubletRate"]["default"],
        "doublet_rate_per_1k": state["doubletRatePer1k"]["default"],
        "threshold": state["threshold"]["default"],
        "n_prin_comps": state["nPrinComps"]["default"],
        "sim_doublet_ratio": state["simDoubletRatio"]["default"],
        "seed": state["seed"]["default"],
        "label": state["label"]["default"],
        "criteria": state["criteria"]["default"],
    })
    assert run.report()["label"] == "doublet"
    assert run.report()["batches"][0]["rate_source"] == "auto_10x_0.8pct_per_1k"
