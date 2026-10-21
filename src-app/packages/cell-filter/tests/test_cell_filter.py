"""Cell-filter compute — PURE-function tests (declarative-processor-ui Slice 4, ITEM-9/27,
DEC-14/27). Mirrors `packages/qc/tests/test_qc.py`: loads the (hyphenated) compute entry script
by path via importlib and exercises its PURE recipe kernels with synthetic numpy — NO heavy
pbmc3k / run_compute fixture (those lived in the deleted `builtins/conftest.py`; the end-to-end
run is the env-gated e2e). Covers the NON-DESTRUCTIVE keep-mask behavior the current script emits:
  * `criteria_keep_mask` — the declarative `criteria` recipe → the combined keep-mask (AND over
    criteria), JOINT DROP (DEC-27: one per-cell boolean over the shared obs, a criterion on any
    modality's column drops the whole cell), continuous range + categorical keep-set, absent-column
    keep-all, empty/unbounded bounds;
  * `mask_column_name` / `mask_path_component` — the committed column is the run's LABEL,
    verbatim (no `keep_` prefix, no slug, no `keep_all` fallback); only the FILENAME is
    sanitised, and a blank label is refused;
  * `thresholds_from_params` — the legacy recipe reader still parses (back-compat).
The script emits ONLY a per-cell keep-mask metadata-column (never a filtered `.h5ad`) — annotate-
only (ITEM-25/27); this suite asserts the mask kernels, not a filtered matrix.
"""
import importlib.util
import math
import os
import sys

import numpy as np

# The `_lib` reference reader for the Zarr the processor now emits (ITEM-26).
_LIB_DIR = os.path.abspath(
    os.path.join(os.path.dirname(__file__), os.pardir, os.pardir, "_lib")
)
if _LIB_DIR not in sys.path:
    sys.path.insert(0, _LIB_DIR)
import cyto_zarr_read  # noqa: E402

# Slice 5 physically re-homed the compute script into this package's `compute/` sibling
# (`packages/cell-filter/compute/cell-filter.py`) — co-located with the manifest.
_CF_SCRIPT = os.path.abspath(
    os.path.join(os.path.dirname(__file__), os.pardir, "compute", "cell-filter.py")
)


def _load_cf():
    spec = importlib.util.spec_from_file_location("cell_filter_pkg", _CF_SCRIPT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


cf = _load_cf()

# ── the SHARED coercion corpus ────────────────────────────────────────────────────────
# Mirrored case-for-case by `libs/workbench-api/src/dsl/criteriaPredicate.test.ts`
# (`UNICODE_WS` / `ASCII_WS` / `NON_SCALAR_BOUNDS`). FOUR independent readers coerce the
# SAME `{column,min,max,keep}[]` — the TS live mask, the TS DSL builder, THIS committed
# mask and the Rust emitter — so a spelling only one of them accepts is, by construction,
# a recorded predicate that constrains what the committed mask did not (or the reverse),
# silently, at rc=0.
# Whitespace JS `String.prototype.trim()` strips and the other readers do NOT.
_UNICODE_WS = [
    "\u00a0",  # NBSP - what a spreadsheet / a CJK IME pastes
    "\u2007",  # FIGURE SPACE
    "\u3000",  # IDEOGRAPHIC SPACE
    "\ufeff",  # ZERO WIDTH NO-BREAK SPACE (BOM)
    "\u0085",  # NEXT LINE
    "\u2009",  # THIN SPACE
    "\u1680",  # OGHAM SPACE MARK
    "\u2028",  # LINE SEPARATOR
]
# The six ASCII whitespace characters ALL FOUR readers trim — and only these.
_ASCII_WS = [" ", "\t", "\n", "\r", "\f", "\v"]
# Shapes that are not a bound / not a keep-set member in ANY reader.
_NON_SCALAR_BOUNDS = [[10], [[1]], {"min": 10}, True, False, [], {}, ("10",)]

# A tiny SHARED obs (4 cells): an RNA metric + a modality-PREFIXED protein metric + a categorical
# cell type — the multi-modal joint-drop shape (DEC-27).
_OBS = {
    "pct_mito": np.array([5.0, 20.0, 8.0, 2.0]),
    "prot:total_counts": np.array([100.0, 50.0, 400.0, 90.0]),
    "cell_type": np.array(["T", "B", "T", "NK"]),
}


# ─────────────────── the committed column's NAME (mask-column-naming) ───────────────────
#
# The label the user typed IS the column name. There is no `keep_` prefix, no slug, no
# case-fold and no trim — an IDENTITY rule, which is why there is no longer a naming
# FUNCTION to keep in sync with a frontend copy. The old `keep_column_name` slugged
# (`Mito < 10%` → `keep_mito_10`), and the prefix was silently doing the NAMESPACING that
# now belongs to the form's `require.not_in` against every column already on the axis.
#
# The slug's `<`→`_lt_` / `>`→`_gt_` disambiguation is not lost, it is UNNECESSARY:
# `mito<10` and `mito>10` were only at risk of colliding because the collapse erased them.
# Verbatim, they are two different strings and the assertion below is the same guarantee.


def test_the_mask_column_is_the_label_verbatim():
    assert cf.mask_column_name("strict") == "strict"
    # Case, spaces, punctuation and non-ASCII all survive: this is the name the user chose.
    assert cf.mask_column_name("Mito < 10%") == "Mito < 10%"
    assert cf.mask_column_name("keep-cells.v2") == "keep-cells.v2"
    assert cf.mask_column_name("garder les cellules") == "garder les cellules"
    # The three spellings the old slug COLLAPSED into one column are three columns now, so a
    # form check on the typed text is a check on the committed name (no resolve step to skip).
    assert len({cf.mask_column_name(x) for x in ("abc-1", "abc 1", "abc_1")}) == 3
    # The disambiguation the slug needed, for free.
    assert cf.mask_column_name("mito<10") != cf.mask_column_name("mito>10")


def test_a_blank_label_is_REFUSED_rather_than_defaulted_to_a_name_nobody_chose():
    """`keep_all` is gone with the prefix. A column has to be called something, and the run
    inventing a name for an unanswered field is exactly the silent behaviour requirement 1
    removes — the form supplies a DEFAULT so the field is never blank, and if it somehow is,
    the run refuses instead of committing under a name the user never saw."""
    for blank in ("", " ", "\t\n", None):
        try:
            cf.mask_column_name(blank)
        except cf.BlankMaskLabel:
            continue
        raise AssertionError(f"a blank label {blank!r} was accepted")


def test_blankness_uses_the_six_character_set_so_the_form_never_says_yes_to_a_refusal():
    """A CONTAINMENT, not an equality, is what has to hold here.

    The form's presence test is JS `String.trim()`; python's own `str.strip()` eats
    U+001C–U+001F and U+0085 that JS does not, and JS eats U+00A0/U+FEFF that the six ASCII
    characters `_trim_column` documents do not. Reading blankness with the SIX makes
    compute-blank a SUBSET of both, so every label this run refuses the form refused first —
    the form never declares a name valid and then has the run reject it. The three characters
    below are each blank to one of the other two readers and present under the six, and the
    run accepting them is what pins the direction of the containment."""
    for present in (" ", "﻿", ""):
        assert cf.mask_column_name(present) == present


def test_the_FILENAME_is_sanitised_while_the_COLUMN_NAME_is_not():
    """A name and a path are different things (the rule `qc-10x.py::sanitize` already follows).

    The slug used to guarantee `[a-z0-9_]`, and `main` interpolates the name straight into the
    output path — so dropping it without sanitising the PATH would let a label containing `/`
    write outside the artifact directory. The column keeps the user's spelling; the file gets
    a component that is only ever one path segment."""
    assert cf.mask_path_component("Mito < 10%") == "Mito___10_"
    for hostile in ("a/b", "a\\b", "..", "../..", "\0x", ".", "/"):
        comp = cf.mask_path_component(hostile)
        assert "/" not in comp and "\\" not in comp and "\0" not in comp, comp
        # `os.path.join` of a run's outputs with this component must not climb out of it.
        assert os.path.normpath(os.path.join("/outputs", comp + ".zarr")).startswith("/outputs/"), comp
    # It never returns the empty string, which would make the path the directory itself.
    assert cf.mask_path_component("") == "mask"
    # `.` and `..` are made of legal characters and are still not NAMES. The `.zarr` suffix
    # the one call site appends happens to disarm them, and that is exactly why this is
    # asserted on the function: the promise is "one ordinary path segment", so it must not
    # rest on a suffix a second caller might not add.
    for dotted in (".", "..", "...", "./.."):
        assert cf.mask_path_component(dotted) not in (".", "..", ""), dotted


def test_criteria_no_criteria_keeps_all():
    assert cf.criteria_keep_mask([], _OBS).tolist() == [True, True, True, True]


def test_criteria_continuous_range():
    # keep pct_mito <= 10 (max=10, min empty ⇒ unbounded).
    mask = cf.criteria_keep_mask([{"column": "pct_mito", "control": "range", "min": "", "max": "10"}], _OBS)
    assert mask.tolist() == [True, False, True, True]


def test_criteria_categorical_keep_set_real_view_shape():
    # P1 REGRESSION: the REAL `ui/cell-filter.yaml` NEVER sets a criterion's `control` field —
    # `cf.addCriterion` seeds `control:''` and `cf.setCriterionField` only writes column/min/max/keep.
    # So a categorical criterion arrives with control='' + a non-empty `keep`. It MUST reach the
    # categorical branch (inferred from the keep-set shape), not silently fall to range → keep-all.
    view_shape = {"column": "cell_type", "control": "", "min": "", "max": "", "keep": ["T"]}
    mask = cf.criteria_keep_mask([view_shape], _OBS)
    assert mask.tolist() == [True, False, True, False], "categorical keep-set must filter (P1)"


def test_criteria_categorical_keep_set_explicit_control_still_honored():
    # An explicit control='multiselect' (an AI-driven criterion) is still honored (back-compat).
    mask = cf.criteria_keep_mask([{"column": "cell_type", "control": "multiselect", "keep": ["T"]}], _OBS)
    assert mask.tolist() == [True, False, True, False]


def test_criteria_all_absent_columns_full_keep_mask_no_crash():
    # P2 REGRESSION: when EVERY criterion references an absent column, obs_cols is empty ({}),
    # so the inferred mask length would be 0 → `keep &= crit_keep` broadcast-crashes in main().
    # Passing n_cells pins the mask to the full cell count → a full keep-all mask, no crash.
    mask = cf.criteria_keep_mask(
        [{"column": "nope", "keep": ["T"]}, {"column": "missing", "min": "1"}], {}, n_cells=4
    )
    assert mask.tolist() == [True, True, True, True]


def test_criteria_joint_drop_across_modalities():
    # A criterion on the PROTEIN-prefixed column drops the WHOLE cell (shared obs, DEC-27).
    mask = cf.criteria_keep_mask(
        [
            {"column": "pct_mito", "control": "range", "max": "10"},
            {"column": "prot:total_counts", "control": "range", "min": "100"},
        ],
        _OBS,
    )
    # cell0: mito5<=10 & prot100>=100 → keep; cell1: mito20 drop; cell2: mito8 & prot400 → keep;
    # cell3: mito2 ok but prot90<100 → JOINT DROP.
    assert mask.tolist() == [True, False, True, False]


def test_criteria_absent_column_keeps_all_and_empty_bounds_unbounded():
    assert cf.criteria_keep_mask([{"column": "nope", "control": "range", "max": "1"}], _OBS).tolist() == [
        True,
        True,
        True,
        True,
    ]
    assert cf.criteria_keep_mask(
        [{"column": "pct_mito", "control": "range", "min": "", "max": ""}], _OBS
    ).tolist() == [True, True, True, True]


def test_thresholds_from_params_back_compat():
    out = cf.thresholds_from_params({"thresholds": [{"metric": "n_genes", "min": 200}]})
    assert out == [{"metric": "n_genes", "min": 200, "max": None, "sample": None}]


# ── TEST-27 (filter-provenance ITEM-16 / DEC-3) ───────────────────────────────────────────
# `ui/cell-filter.yaml` sends `criteria`, never `thresholds`, so the committed
# `filter-report` used to record `"thresholds": []` — the report did not say what was
# filtered on. The compute script now learns the `criteria` shape as a FOURTH branch.
_UI_CRITERIA = [
    {"column": "pct_mito", "control": "range", "min": "", "max": "10"},
    {"column": "prot:total_counts", "control": "range", "min": "80"},
    {"column": "cell_type", "keep": ["T", "NK"]},
    # no-constraint criteria: omitted from the report (mirrors the all-None skip)
    {"column": "pct_mito", "control": "range", "min": "", "max": ""},
    {"column": "cell_type", "keep": []},
    {"column": ""},
]


def test_thresholds_from_params_accepts_the_declarative_criteria_shape():
    out = cf.thresholds_from_params({"criteria": _UI_CRITERIA, "label": "strict"})
    assert out, "the report's thresholds are NO LONGER empty for a criteria-driven run"
    assert out == [
        {"metric": "pct_mito", "min": None, "max": 10.0, "sample": None, "source": "criteria"},
        {
            "metric": "prot:total_counts",
            "min": 80.0,
            "max": None,
            "sample": None,
            "source": "criteria",
        },
        {
            "metric": "cell_type",
            "min": None,
            "max": None,
            "sample": None,
            "keep": ["T", "NK"],
            "source": "criteria",
        },
    ]
    # every entry NAMES its criterion, incl. the categorical keep-set the numeric
    # `thresholds` vocabulary cannot express.
    assert {t["metric"] for t in out} == {"pct_mito", "prot:total_counts", "cell_type"}


def test_criteria_branch_never_displaces_the_live_thresholds_callers():
    # An explicit `thresholds` list keeps its OWN entries, in its own order, FIRST
    # (the 3 live callers are untouched)... and the criteria are appended after them
    # (F2-4 — see `test_criteria_are_reported_even_when_thresholds_are_present`).
    both = cf.thresholds_from_params(
        {"thresholds": [{"metric": "n_genes", "min": 200}], "criteria": _UI_CRITERIA}
    )
    assert both[0] == {"metric": "n_genes", "min": 200, "max": None, "sample": None}
    assert [t for t in both if t.get("source") != "criteria"] == [
        {"metric": "n_genes", "min": 200, "max": None, "sample": None}
    ]
    # ...as does the per-sample map form. (ITEM-9 deleted the `predicate` DSL fallback
    # from the kernel — nothing sends a `predicate` since ITEM-4 stopped the criteria→DSL
    # lift — so the two assertions that exercised it are deleted with the branch they
    # covered, rather than kept as coverage of behaviour no caller can reach.)
    per_sample = cf.thresholds_from_params(
        {"thresholds": {"pct_mito": {"s1": [None, 10]}}, "criteria": _UI_CRITERIA}
    )
    assert per_sample[0] == {"metric": "pct_mito", "min": None, "max": 10.0, "sample": "s1"}
    assert [t for t in per_sample if t.get("source") != "criteria"] == [
        {"metric": "pct_mito", "min": None, "max": 10.0, "sample": "s1"}
    ]


def test_criteria_report_entries_are_report_only_the_mask_is_unchanged():
    # The REGRESSION clause of DEC-3: the keep-mask comes from `criteria_keep_mask` and must
    # be byte-identical to before the report fix — the report entries are tagged
    # `source="criteria"` precisely so `main`'s threshold-apply loop skips them.
    #
    # NOTE (round 4 / R3-17): this test asserts the KERNELS in isolation. It does NOT
    # invoke `main()`, so the guard that actually makes the entries report-only —
    # `if t.get("source") == "criteria": continue` in main's apply loop — is not
    # exercised here at all. Deleting that guard left this whole suite at
    # `28 passed EXIT=0`. The guard is pinned by
    # `test_main_never_applies_a_criteria_report_entry_through_the_thresholds_loop`
    # below, which drives `main()` end-to-end; keep the two together.
    out = cf.thresholds_from_params({"criteria": _UI_CRITERIA})
    assert all(t["source"] == "criteria" for t in out), "every entry is tagged report-only"
    mask = cf.criteria_keep_mask(_UI_CRITERIA, _OBS).tolist()
    # pct_mito<=10 -> [T,F,T,T]; prot:total_counts>=80 -> [T,F,T,T]; cell_type in {T,NK} -> [T,F,T,T]
    assert mask == [True, False, True, True]


def test_bound_coercion_uses_the_one_decimal_grammar():
    """TEST-37 (parity). Four parsers read the same criterion bound — JS ``Number()``
    (the predicate builder + the live mask), this ``float()`` (the committed mask), Rust
    ``parse::<f64>()`` (the emitted replay script) and the narration. Their native
    accept-sets differ, and every difference is a recorded predicate constraining what
    this mask did not, or the reverse. All four are restricted to plain decimal
    notation; this pins THIS one."""
    cf = _load_cf()
    b = cf._bound_or_none
    assert b("0") == 0.0
    assert b("1e3") == 1000.0
    assert b(" 1 ") == 1.0
    assert b(".5") == 0.5
    assert b("-2.") == -2.0
    assert b(10) == 10.0
    assert b(10.5) == 10.5
    for bad in ["", "   ", ".", "+", "abc", "0x10", "inf", "-inf", "Infinity", "1_0",
                "nan", "1e", "1.2.3", None, True, False, float("inf"), float("nan")]:
        assert b(bad) is None, "must reject %r" % (bad,)


def test_a_non_list_keep_is_not_a_keep_set():
    """TEST-38. ``len(c["keep"] or []) > 0`` is ALSO true for the string "abc" — the
    mask then built the character keep-set {a,b,c} while the emitter
    (`predicate_script::is_categorical`, JSON-array-only) took the range branch. A
    malformed non-list ``keep`` is not a keep-set anywhere now."""
    cf = _load_cf()
    assert cf._is_categorical_criterion({"column": "x", "keep": ["a"]}) is True
    assert cf._is_categorical_criterion({"column": "x", "keep": "abc"}) is False
    # …and with no bounds it therefore imposes NO constraint (never a character filter).
    obs = {"x": np.array(["a", "b", "z"])}
    assert list(cf.criteria_keep_mask([{"column": "x", "keep": "abc"}], obs)) == [True, True, True]


def test_the_mask_uses_the_trimmed_column_spelling():
    """TEST-42. The predicate builder and both script emitters have always trimmed the
    column; this mask looked the RAW value up in obs, so `" pct_mito"` recorded a
    predicate constraining `pct_mito` that the mask never applied."""
    cf = _load_cf()
    obs = {"pct_mito": np.array([1.0, 50.0])}
    assert list(cf.criteria_keep_mask([{"column": " pct_mito", "max": "10"}], obs)) == [True, False]


def test_criteria_thresholds_report_only_bounds_the_mask_accepts():
    """A bound spelling the mask rejects (`float("0x10")` raises → unbounded) must not
    appear in the report as a threshold that filtered."""
    cf = _load_cf()
    assert cf.criteria_thresholds([{"column": "n_genes", "min": "0x10"}]) == []
    assert cf.criteria_thresholds([{"column": "n_genes", "min": ""}]) == []
    assert cf.criteria_thresholds([{"column": "n_genes", "min": "500"}]) == [
        {"metric": "n_genes", "min": 500.0, "max": None, "sample": None, "source": "criteria"}
    ]


def test_report_metric_uses_the_trimmed_spelling_the_mask_applied():
    """A padded column is TRIMMED by `criteria_keep_mask`, so the criterion DID
    constrain. `criteria_thresholds` must emit the same trimmed `metric` — main()'s
    report filter matches it against the trimmed `criteria_obs_cols` keys, so an
    untrimmed metric silently dropped a threshold that actually filtered (the report
    UNDER-stating the filter, the inverse of its purpose)."""
    cf = _load_cf()
    assert cf.criteria_thresholds([{"column": " pct_mito ", "max": "10"}]) == [
        {"metric": "pct_mito", "min": None, "max": 10.0, "sample": None, "source": "criteria"}
    ]
    assert cf.criteria_thresholds([{"column": " leiden ", "keep": ["1"]}]) == [
        {"metric": "leiden", "min": None, "max": None, "sample": None,
         "keep": ["1"], "source": "criteria"}
    ]


def test_a_unicode_digit_bound_is_not_a_bound():
    """F1 (re-audit). Python's ``\\d`` matches Unicode digits and ``float()`` accepts
    them; the JS regex and Rust's ``is_ascii_digit`` do not. A fullwidth or Arabic-Indic
    bound -- what a CJK/Arabic IME emits for ordinary typing -- therefore constrained
    THIS mask while the recorded predicate omitted the criterion, with no diagnostic."""
    cf = _load_cf()
    for spelling in ["\uff11\uff10", "\u0660.\u0665", "\U0001d7cf", "1\u0662", "1e\u0661"]:
        assert cf._bound_or_none(spelling) is None, repr(spelling)
    obs = {"pct_mito": np.array([1.0, 50.0])}
    assert list(cf.criteria_keep_mask([{"column": "pct_mito", "max": "\uff11\uff10"}], obs)) == [True, True]


def test_categorical_match_is_dtype_independent():
    """F2 (re-audit). Whether a cell's ``1`` spells itself "1" or "1.0" depends on the
    column's DTYPE, which the UI that built the keep-set cannot see -- so ``keep:["1","2"]``
    over a FLOAT column matched nothing here while the live preview matched everything.
    A numeric fallback beside the string compare removes the dtype from the answer."""
    cf = _load_cf()
    floats = {"leiden": np.array([0.0, 1.0, 2.0, 3.0])}
    assert list(cf.criteria_keep_mask([{"column": "leiden", "keep": ["1", "2"]}], floats)) == [
        False, True, True, False
    ]
    ints = {"leiden": np.array([0, 1, 2, 3])}
    assert list(cf.criteria_keep_mask([{"column": "leiden", "keep": ["1.0", "2"]}], ints)) == [
        False, True, True, False
    ]
    # …and a genuinely non-numeric keep-set is still a plain string compare.
    strs = {"cell_type": np.array(["T", "NK", "B"])}
    assert list(cf.criteria_keep_mask([{"column": "cell_type", "keep": ["T", "NK"]}], strs)) == [
        True, True, False
    ]


def test_a_range_on_a_non_numeric_column_does_not_kill_the_job():
    """F3 (re-audit). `cf.setCriterionField` writes ONE field, so switching `column` to a
    categorical one leaves a stale Min in state (the widgets are only HIDDEN). The
    unguarded ``np.asarray(col, dtype=float)`` raised, failing the WHOLE job. A
    non-numeric cell now FAILS the threshold, exactly as the TS mask and the emitted
    replay script already did."""
    cf = _load_cf()
    obs = {"cell_type": np.array(["T", "NK", "B"])}
    assert list(cf.criteria_keep_mask([{"column": "cell_type", "min": "0", "max": "10"}], obs)) == [
        False, False, False
    ]
    # a MIXED column keeps only its numeric, in-range cells
    mixed = {"x": np.array(["1", "abc", "5"], dtype=object)}
    assert list(cf.criteria_keep_mask([{"column": "x", "max": "3"}], mixed)) == [True, False, False]


def test_an_explicit_multiselect_with_a_string_keep_is_not_a_character_set():
    """F4 (re-audit). ``c.get("keep") or []`` iterated the STRING "12" into the character
    keep-set {'1','2'} -- a filter neither the TS mask (which requires an array) nor the
    emitter (JSON-array-only) agreed with. Only reachable via an EXPLICIT `control`."""
    cf = _load_cf()
    obs = {"leiden": np.array([1.0, 2.0, 3.0])}
    crit = [{"column": "leiden", "control": "multiselect", "keep": "12"}]
    assert list(cf.criteria_keep_mask(crit, obs)) == [True, True, True]


def test_a_non_finite_cell_fails_a_numeric_threshold():
    """F9 (re-audit). All three docstrings said so; the TS mask did not implement it
    (`Number.isNaN` alone let +/-Infinity through). This pins the Python side that the
    TS one now matches."""
    cf = _load_cf()
    obs = {"x": np.array([float("inf"), float("-inf"), 1.0])}
    assert list(cf.criteria_keep_mask([{"column": "x", "min": "0"}], obs)) == [False, False, True]


# ── round 2: the four-reader coercion corpus + the report-path guards ──────────────────


def test_a_non_ascii_padded_bound_is_unbounded_here_too():
    """F2-1 PARITY TWIN. `criteriaPredicate.ts::parseBound` trimmed with JS
    `String.prototype.trim()`, which strips the full Unicode `White_Space` set, so a
    PASTED `max: "10\\u00a0"` (Min/Max are free-text widgets) recorded
    `{lte:[{col:pct_mito},10]}` and previewed 3/5 kept while THIS mask -- which refuses a
    non-ascii string outright -- kept 5/5 and the report's `thresholds` was `[]`. This
    side was already right; the corpus is pinned here so the two cannot drift apart
    again, and so the *shared* corpus lives in both suites."""
    cf = _load_cf()
    for ws in _UNICODE_WS:
        assert cf._bound_or_none("10" + ws) is None, repr(ws)
        assert cf._bound_or_none(ws + "10") is None, repr(ws)
        assert cf._bound_or_none(ws + "10" + ws) is None, repr(ws)
    for ws in _ASCII_WS:
        assert cf._bound_or_none(ws + "10" + ws) == 10.0, repr(ws)
    assert cf._bound_or_none("1\u00a00") is None
    assert cf._bound_or_none("10\u20ac") is None
    # the MASK therefore applies no constraint -- matching what the builder now records.
    obs = {"pct_mito": np.array([1.0, 50.0])}
    assert list(cf.criteria_keep_mask([{"column": "pct_mito", "max": "10\u00a0"}], obs)) == [
        True,
        True,
    ]
    # ...and the REPORT says nothing filtered, rather than naming a threshold that did not.
    assert cf.criteria_thresholds([{"column": "pct_mito", "max": "10\u00a0"}]) == []


def test_a_non_scalar_is_not_a_bound_here_either():
    """F2-5 PARITY TWIN. `parseBound` used to `String()` ANY value, so `{min:[10]}`
    recorded `gte 10` while `_bound_or_none` (type-gated) applied NO constraint."""
    cf = _load_cf()
    for bad in _NON_SCALAR_BOUNDS:
        assert cf._bound_or_none(bad) is None, repr(bad)
    obs = {"pct_mito": np.array([1.0, 50.0])}
    assert list(cf.criteria_keep_mask([{"column": "pct_mito", "min": [10]}], obs)) == [True, True]


def test_a_non_string_column_names_no_column_in_the_mask_or_the_report():
    """R4A-09 (round 4b). `criteria` is client-supplied JSON, so `column` can arrive as a
    number / list / dict. The mask kernel looked the RAW value up in `obs`, so an
    unhashable one raised ``TypeError: unhashable type: 'list'`` and killed the job; the
    report meanwhile recorded a threshold on the metric ``"['q']"`` — a filter that never
    ran — and main's resolve pass indexed `adata.obs` with it. Only a STRING is a column
    name now, in every one of the three places, matching the emitter (which has always
    read `column` through `as_str`) and the live preview.

    RED ON REVERT: restore `col_name = _trim_column(...) if isinstance(..., str) else
    c.get("column")` and the `["q"]` case raises out of `criteria_keep_mask`."""
    cf = _load_cf()
    obs = {"q": np.array([0.0, 5.0])}
    for column in (5, None, ["q"], {"a": 1}, True):
        crit = [{"column": column, "min": "1"}]
        assert list(cf.criteria_keep_mask(crit, obs, n_cells=2)) == [True, True], repr(column)
        assert cf.criteria_thresholds(crit) == [], repr(column)
        assert cf.thresholds_from_params({"criteria": crit}) == [], repr(column)
    # …and the STRING path is untouched (positive control).
    assert list(cf.criteria_keep_mask([{"column": " q ", "min": "1"}], obs, n_cells=2)) == [
        False,
        True,
    ]


def test_criteria_thresholds_survives_a_non_iterable_keep():
    """F2-2 (round 2, HIGH). `{control:"multiselect", keep:5}` raised
    `TypeError: 'int' object is not iterable` out of this comprehension -- the real script
    exited 1 with an EMPTY outputs dir, because `thresholds_from_params` runs BEFORE any
    mask is written. Round 1 added the `isinstance(raw,(list,tuple))` guard to the MASK
    kernel and never added it here."""
    cf = _load_cf()
    for keep in [5, 5.5, None, object()]:
        crit = [{"column": "leiden", "control": "multiselect", "keep": keep}]
        assert cf.criteria_thresholds(crit) == [], repr(keep)
        # …through the entry point `main` actually calls, too.
        assert cf.thresholds_from_params({"criteria": crit}) == [], repr(keep)


def test_criteria_thresholds_does_not_report_a_string_keep_as_a_character_set():
    """F2-3 (round 2). `[str(x) for x in "abc"]` reported the keep-set `["a","b","c"]`
    for a criterion the MASK skips entirely (a non-list `keep` is not a keep-set), i.e.
    the report described a filter that never ran."""
    cf = _load_cf()
    for keep in ["abc", {"a": 1}]:
        crit = [{"column": "leiden", "control": "multiselect", "keep": keep}]
        assert cf.criteria_thresholds(crit) == [], repr(keep)
    # the mask agrees -- no constraint at all.
    obs = {"leiden": np.array(["a", "b", "z"])}
    assert list(
        cf.criteria_keep_mask(
            [{"column": "leiden", "control": "multiselect", "keep": "abc"}], obs
        )
    ) == [True, True, True]


def test_criteria_are_reported_even_when_thresholds_are_present():
    """F2-4 (round 2). `thresholds_from_params` gated the criteria branch on `if not out`,
    so a params payload carrying BOTH `thresholds` and `criteria` reported only the
    former -- while `main` still APPLIED the criteria via `criteria_keep_mask`. Verified
    5 cells in -> 2 kept, where cells 3-4 were dropped by a `pct_mito` criterion that
    appeared NOWHERE in the emitted `filter-report`. The gate bought nothing: these
    entries are tagged `source="criteria"` and are skipped by main's apply loop BY
    CONSTRUCTION, so the committed mask is unchanged."""
    cf = _load_cf()
    out = cf.thresholds_from_params(
        {
            "thresholds": [{"metric": "n_genes", "min": 200}],
            "criteria": [{"column": "pct_mito", "control": "range", "max": "10"}],
        }
    )
    assert {"metric": "pct_mito", "min": None, "max": 10.0, "sample": None, "source": "criteria"} in out
    # the pre-existing entry is still there, first, byte-identical
    assert out[0] == {"metric": "n_genes", "min": 200, "max": None, "sample": None}
    # and the same for the per-sample MAP form of `thresholds`
    per_sample = cf.thresholds_from_params(
        {
            "thresholds": {"n_genes": {"s1": [200, None]}},
            "criteria": [{"column": "pct_mito", "control": "range", "max": "10"}],
        }
    )
    assert {"metric": "pct_mito", "min": None, "max": 10.0, "sample": None, "source": "criteria"} in per_sample
    # the criteria that DO constrain the mask are exactly the ones now reported
    obs = {"pct_mito": np.array([1.0, 2.0, 3.0, 50.0, 60.0])}
    assert list(
        cf.criteria_keep_mask([{"column": "pct_mito", "control": "range", "max": "10"}], obs)
    ) == [True, True, True, False, False]


def test_a_unicode_digit_CELL_is_not_a_number():
    """F2-6 (round 2). `_value_float` was a bare `float(x)`, which accepts Unicode decimal
    digits (``float("\uff11\uff10")`` is 10.0, ``float("\u0661\u0662")`` is 12.0 -- what a CJK/Arabic IME emits
    for ordinary typing) where the live TS mask's `Number()` answers NaN, splitting the
    four readers 2-2 on the SAME obs cell. numpy's string->float fast path used the same
    unrestricted `float()` per element, so an all-numeric-LOOKING string column never
    even reached `_value_float`; a non-numeric dtype is coerced per cell now."""
    cf = _load_cf()
    for spelling in ["\uff11\uff10", "\u0660.\u0665", "\U0001d7cf", "1\u0662"]:
        assert math.isnan(cf._value_float(spelling)), repr(spelling)
    # the committed MASK now drops the fullwidth cell, exactly as the TS preview does
    obs = {"x": np.array(["1", "\uff11\uff10", "5"], dtype=object)}
    assert list(cf.criteria_keep_mask([{"column": "x", "max": "20"}], obs)) == [True, False, True]
    # …including a plain (non-object) numpy string column
    obs_u = {"x": np.array(["1", "\uff11\uff10", "5"])}
    assert list(cf.criteria_keep_mask([{"column": "x", "max": "20"}], obs_u)) == [True, False, True]
    # A merely NBSP-PADDED ascii number IS still a number -- JS `Number("\\u00a01")` is 1
    # too, so gating on the raw (unstripped) string would have created a NEW divergence.
    padded = {"x": np.array(["\u00a01", "50"], dtype=object)}
    assert list(cf.criteria_keep_mask([{"column": "x", "max": "10"}], padded)) == [True, False]
    # a genuinely numeric column is untouched by the dtype branch
    nums = {"x": np.array([1.0, 50.0])}
    assert list(cf.criteria_keep_mask([{"column": "x", "max": "10"}], nums)) == [True, False]


# ── round 4: `main()` ITSELF, driven end-to-end (R3-17 / R3-18) ───────────────────────
#
# Every test above this line calls a PURE kernel. That left the two behaviours `main()`
# alone owns — the report-only GUARD in its threshold-apply loop, and the TRIM it applies
# before looking a criterion's column up in `adata.obs` — asserted by no test at all.
# Round-3 mutation testing proved it: deleting either left the suite at
# `28 passed EXIT=0` (mutations M1 and M3). Neither is expressible against a kernel,
# because both are about how main WIRES the kernels together.
#
# So these two drive the REAL entry point over a synthetic run directory: a genuine
# `.h5ad` + `inputs.json` + `params.json` under `CYTO_INPUTS_DIR`/`CYTO_OUTPUTS_DIR` (the
# documented roots), and they read back the two artifacts a real run commits — the
# mask column (read back through the manifest's `path`) and `filter-report.json`.
# Deliberately tiny (4 cells,
# 3 genes): this is still a unit test, not the env-gated end-to-end.


def _make_run_dir(root, obs, criteria, label="strict", extra_params=None):
    """Write a minimal, REAL cell-filter run directory → (inputs_dir, outputs_dir).

    ITEM-24 changed WHAT is staged here, not what these tests assert. The input used to
    be one `.h5ad` carrying the matrix AND its obs frame, mounted under a name the
    compute sniffed. It is now the artifacts a real run actually binds:

      * slot `expression`     — the CSC Zarr count matrix (mounted `in0`: SUFFIX-FREE, so
                                a reader that dispatched on the filename cannot pass);
      * slot `column:<name>`  — one `metadata-column` store per obs column;
      * slot `cells_index`    — the cells-axis key artifact (the barcodes).

    ``extra_params`` is merged into ``params.json`` so a test can drive main's
    THRESHOLD-apply loop (``thresholds``), not only the declarative ``criteria``
    branch — the two clauses R4A-04 / R4A-05 cover live in that loop."""
    import json as _json

    import pandas as pd
    import scipy.sparse as _sp

    import cyto_columns
    import cyto_csc

    inputs, outputs = root / "inputs", root / "outputs"
    inputs.mkdir(parents=True, exist_ok=True)
    outputs.mkdir(parents=True, exist_ok=True)
    n = len(next(iter(obs.values())))

    entries = []

    def _declare(slot, mount):
        entries.append({"slot": slot, "kind": "artifact-prefix",
                        "sandbox_path": f"/inputs/{mount}"})

    matrix = _sp.csr_matrix(np.arange(n * 3, dtype="float32").reshape(n, 3))
    cyto_csc.write_csc_zarr(cyto_csc.ArraySource(matrix), inputs / "in0",
                            axes=("cells", "genes"))
    _declare("expression", "in0")

    for i, (name, values) in enumerate(obs.items()):
        mount = f"in{i + 1}"
        cyto_columns.write_metadata_column(
            inputs, mount, name, pd.Series(list(values)), axis="cells")
        _declare(f"column:{name}", mount)

    cyto_columns.write_metadata_column(
        inputs, "cells", "cells_index",
        pd.Series([f"cell{i}" for i in range(n)]), axis="cells", holds_axis_keys=True)
    _declare("cells_index", "cells")

    (inputs / "inputs.json").write_text(_json.dumps({"inputs": entries}))
    payload = {"criteria": criteria, "label": label, "seed": 0}
    payload.update(extra_params or {})
    (inputs / "params.json").write_text(_json.dumps(payload))
    return inputs, outputs


def _drive_main(obs, criteria, label="strict", extra_params=None):
    """Execute the REAL ``main()`` over a synthetic run dir → (outputs_dir, manifest, report),
    with the outputs COPIED OUT of the temp dir so a caller can still read them.

    The mask's PATH is read from `/outputs/manifest.json`, never rebuilt from the report's
    `mask_column`. The column NAME is the user's verbatim label and the FILENAME is a
    sanitised component of it, so the two are deliberately no longer the same string —
    reconstructing one from the other here would encode the very coupling the compute drops.
    """
    import json as _json
    import shutil
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as td:
        inputs, outputs = _make_run_dir(Path(td), obs, criteria, label, extra_params)
        saved = {k: os.environ.get(k) for k in ("CYTO_INPUTS_DIR", "CYTO_OUTPUTS_DIR")}
        os.environ["CYTO_INPUTS_DIR"] = str(inputs)
        os.environ["CYTO_OUTPUTS_DIR"] = str(outputs)
        try:
            cf.main()
        finally:
            for k, v in saved.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
        report = _json.loads((outputs / "filter-report.json").read_text())
        manifest = _json.loads((outputs / "manifest.json").read_text())
        kept = Path(tempfile.mkdtemp(prefix="cf-outputs-"))
        shutil.rmtree(kept)
        shutil.copytree(outputs, kept)
        return kept, manifest, report


def _mask_entry(manifest):
    """The ONE `metadata-column` entry a run commits, from the manifest it wrote."""
    entries = [e for e in manifest["outputs"] if e["datatype"] == "metadata-column"]
    assert len(entries) == 1, entries
    return entries[0]


def _run_main(obs, criteria, label="strict", extra_params=None):
    """Execute the REAL ``main()`` over a synthetic run dir → (committed mask, report)."""
    import shutil

    outputs, manifest, report = _drive_main(obs, criteria, label, extra_params)
    try:
        # ITEM-26: the keep-mask is a Zarr artifact DIRECTORY (one byte per cell) rather
        # than a JSON array of `true`/`false` tokens. Decode it from the bytes.
        mask = cyto_zarr_read.read_column(outputs / _mask_entry(manifest)["path"])
        return [bool(v) for v in mask], report
    finally:
        shutil.rmtree(outputs, ignore_errors=True)


# ── the label reaches the COMMITTED column, and only the FILENAME is rewritten ───────────


def test_main_commits_the_label_as_the_column_name_verbatim():
    """The end-to-end half of the naming rule, over the REAL entry point: what the user typed
    is what the artifact declares itself called, and what the report and the output id say."""
    import shutil

    obs = {"pct_mito": np.array([5.0, 20.0])}
    label = "Mito < 10%"
    outputs, manifest, report = _drive_main(obs, [], label=label)
    try:
        entry = _mask_entry(manifest)
        assert report["mask_column"] == label
        assert entry["id"] == f"metadata-column:{label}"
        # The artifact's own producer declaration — what the catalog row, and therefore the
        # form's taken-set on the next run, will carry.
        assert entry["meta"]["name"] == label
        # …and the FILENAME is not the name. That is the whole point of keeping them apart.
        assert entry["path"] != f"{label}.zarr"
        assert (outputs / entry["path"]).is_dir()
    finally:
        shutil.rmtree(outputs, ignore_errors=True)


def test_main_REFUSES_a_blank_label_instead_of_committing_keep_all():
    """`keep_all` was a name nobody chose, attached to the run that most needed a name (the
    one whose author did not think about it). With the prefix gone there is no fallback to
    fall back TO, and inventing one is the behaviour requirement 1 removes."""
    try:
        _drive_main({"pct_mito": np.array([5.0, 20.0])}, [], label="")
    except SystemExit as e:
        assert e.code != 0
        return
    raise AssertionError("a blank label committed a mask instead of failing the run")


def test_a_label_full_of_separators_cannot_write_OUTSIDE_the_outputs_dir():
    """The security clause of dropping the slug. `main` interpolates the mask name into the
    output path; the slug used to guarantee `[a-z0-9_]` and now does not. The server's
    manifest reader refuses a traversing path, but only AFTER the compute has already
    written the bytes — so the confinement has to hold here, not there."""
    import shutil

    obs = {"pct_mito": np.array([5.0, 20.0])}
    outputs, manifest, report = _drive_main(obs, [], label="../../escaped")
    try:
        entry = _mask_entry(manifest)
        # The column is still exactly what was typed…
        assert report["mask_column"] == "../../escaped"
        # …and the path is one ordinary component under the outputs dir.
        assert ".." not in entry["path"].split("/")
        assert (outputs / entry["path"]).resolve().is_relative_to(outputs.resolve())
    finally:
        shutil.rmtree(outputs, ignore_errors=True)


def test_main_never_applies_a_criteria_report_entry_through_the_thresholds_loop():
    """R3-17. The REGRESSION clause of DEC-3, asserted where it actually lives.

    `criteria_thresholds` entries are tagged ``source="criteria"`` so that main's
    threshold-APPLY loop skips them — the mask for those criteria is produced by the
    dedicated `criteria_keep_mask` branch, the only one that honours a categorical
    keep-set and the non-finite rule. Without the guard the SAME criteria run a second
    time under the numeric-threshold semantics, which cannot express a keep-set: it
    float-coerces `cell_type`, raises, and records ``per_metric_removed["cell_type"] =
    None`` — "metric unavailable → skipped". The one document then names cell_type as a
    filter that ran AND as a metric that was skipped."""
    obs = {
        "pct_score": np.array([5.0, 20.0, 8.0, 2.0]),
        "cell_type": np.array(["T", "B", "T", "NK"]),
    }
    criteria = [
        {"column": "pct_score", "control": "range", "min": "", "max": "10"},
        {"column": "cell_type", "keep": ["T", "NK"]},
    ]
    mask, report = _run_main(obs, criteria)

    # 1. the COMMITTED mask is exactly the criteria kernel's answer.
    assert mask == cf.criteria_keep_mask(criteria, obs).tolist() == [True, False, True, True]
    assert (report["n_cells_in"], report["n_cells_out"], report["n_removed"]) == (4, 2 + 1, 1)

    # 2. the report says what was filtered on, and every entry is report-only.
    assert {t["metric"] for t in report["thresholds"]} == {"pct_score", "cell_type"}
    assert all(t.get("source") == "criteria" for t in report["thresholds"])

    # 3. …and NOT ONE of them reached the apply loop. `per_metric_removed` is that
    #    loop's own ledger, so an entry there is the proof the guard is gone.
    assert report["per_metric_removed"] == {}, (
        "a criteria entry reached main's threshold-apply loop: the same constraint ran "
        "twice, under two different semantics"
    )
    for t in report["thresholds"]:
        assert t["metric"] not in report["per_metric_removed"], (
            f"the report names {t['metric']!r} as filtered-on AND as skipped/removed by "
            f"the thresholds loop — one run, two contradictory accounts"
        )


def test_main_looks_the_criterion_up_under_the_TRIMMED_column_spelling():
    """R3-18. `criteria_thresholds` and `criteria_keep_mask` both trim; main must trim the
    SAME way when it harvests `adata.obs` into `criteria_obs_cols`, because that dict is
    BOTH the mask kernel's whole view of obs AND the key set the report filter matches
    `metric` against. Untrimmed, a pasted `" qc_score "` (Column is a free-text/select
    widget) resolves to no obs column at all: the mask silently keeps every cell, and the
    report then drops the threshold too — so the run reports "nothing was filtered" for a
    filter the user watched the live preview apply."""
    obs = {"qc_score": np.array([5.0, 50.0, 8.0, 90.0])}
    criteria = [{"column": " qc_score ", "control": "range", "min": "", "max": "10"}]
    mask, report = _run_main(obs, criteria)

    # the padded criterion DID constrain the committed mask…
    assert mask == [True, False, True, False]
    assert (report["n_cells_out"], report["n_removed"]) == (2, 2)
    # …and the report names it, under the trimmed spelling the mask actually used.
    assert [t["metric"] for t in report["thresholds"]] == ["qc_score"]


def test_main_survives_a_non_string_criterion_column():
    """ROUND-6 (C2). R4A-09's fix has THREE arms — `criteria_keep_mask`,
    `criteria_thresholds` and `resolve_criteria_obs_cols` — but
    `test_a_non_string_column_names_no_column_in_the_mask_or_the_report` drives only the
    three PURE kernels. Reverting the third arm (the ``isinstance(raw_col, str)`` guard
    in `resolve_criteria_obs_cols`) therefore left the WHOLE suite behaviourally green
    while a real run carrying a ``{"column": ["q"]}`` criterion died in main's resolve
    pass, before any output was written.

    RED ON REVERT (executed): replace the guard with
    ``raw_col = _trim_column(raw_col) if isinstance(raw_col, str) else raw_col`` and this
    raises ``TypeError: unhashable type: 'list'`` out of `resolve_metric_col`'s
    ``metric in adata.obs.columns``."""
    obs = {"q": np.array([5.0, 50.0, 8.0, 90.0])}
    for column in (["q"], 5):
        criteria = [
            {"column": column, "min": "1"},  # not a column name in ANY reader
            {"column": "q", "control": "range", "min": "", "max": "10"},
        ]
        # the job COMPLETES — the unreadable criterion contributes no constraint…
        mask, report = _run_main(obs, criteria)
        assert mask == [True, False, True, False], repr(column)
        # …and the readable one still ran, named under its own spelling.
        assert [t["metric"] for t in report["thresholds"]] == ["q"], repr(column)


# ── ROUND-4b: the two round-4 clauses that shipped with NO behavioural test ───────────
#
# R4A-04 / R4A-05. `main()`'s threshold-apply loop gained two clauses in round 4 — the
# non-finite fail (R3-84) and the `metric@sample` report key (R3-87) — and NOTHING
# asserted either. Deleting each left the processor suite green except the
# manifest-version sha lock, which fires identically for a COMMENT-ONLY edit and
# therefore carries zero behavioural signal. Both are properties of main's WIRING (a
# threshold list, an obs `sample` column, the report's `per_metric_removed` ledger), so
# neither is expressible against a pure kernel: they are driven through the real
# entry point, exactly like R3-17/R3-18 above.


def test_main_fails_a_non_finite_cell_against_a_bounded_threshold():
    """R4A-04 / R3-84. `criteria_keep_mask` has always applied ``m &= np.isfinite(vals)``
    — a value that cannot be SHOWN to satisfy a threshold must not be kept — but the
    THRESHOLD loop only compared, and ``NaN < lo`` / ``NaN > hi`` are both False, so a
    NaN cell survived. Both paths write into the report's ONE ``thresholds`` list under
    an identical shape, so the report described two constraints that were not the same
    constraint.

    RED ON REVERT: delete ``if bounded: fail |= ~np.isfinite(col)`` from
    `cell-filter.py` and the NaN cell is kept — mask ``[True, True, False]``,
    ``per_metric_removed == {"qc": 1}``."""
    obs = {"qc": np.array([5.0, np.nan, 50.0]), "sample": np.array(["s1", "s1", "s1"])}
    mask, report = _run_main(
        obs, [], extra_params={"thresholds": [{"metric": "qc", "max": 10}]}
    )
    assert mask == [True, False, False], (
        "a NON-FINITE cell must FAIL a bounded threshold, exactly as it fails the "
        "criteria kernel's own mask"
    )
    assert report["per_metric_removed"] == {"qc": 2}
    assert (report["n_cells_in"], report["n_cells_out"], report["n_removed"]) == (3, 1, 2)
    # …and the criteria kernel agrees on the same data + the same bound, which is the
    # point of the clause: one constraint, one answer, whichever path expressed it.
    assert cf.criteria_keep_mask(
        [{"column": "qc", "control": "range", "max": "10"}], obs
    ).tolist() == mask


def test_main_keys_per_sample_threshold_removals_by_metric_AND_sample():
    """R4A-05 / R3-87. The interactive per-sample map (``{criterion: {ident: [lo, hi]}}``,
    DEC-1) emits ONE threshold per sample for the SAME metric. Keyed by metric name
    alone, each sample overwrote the previous entry and the report understated every
    removal but the last.

    RED ON REVERT: change the key back to ``t["metric"]`` and ``per_metric_removed``
    becomes ``{"qc": 1}`` — the s1 removal vanishes from the report while the cell is
    still gone from the committed mask."""
    obs = {
        "qc": np.array([5.0, 50.0, 5.0, 90.0]),
        "sample": np.array(["s1", "s1", "s2", "s2"]),
    }
    mask, report = _run_main(
        obs,
        [],
        extra_params={"thresholds": {"qc": {"s1": [None, 10], "s2": [None, 10]}}},
    )
    assert mask == [True, False, True, False]
    assert report["per_metric_removed"] == {"qc@s1": 1, "qc@s2": 1}, (
        "one entry per (metric, sample): keyed by metric alone the two samples "
        "overwrite each other and the report understates the removals"
    )
    assert sum(report["per_metric_removed"].values()) == report["n_removed"] == 2


# ── ROUND-3 / F3-6 — the package VERSION must move when the kernel moves ──────────────
#
# `extensions/embedded.rs::reconcile` skips re-extraction when the recorded package
# version equals the shipped one and the folder is present ("no rewrite even if the
# user edited files at this SAME version; a version bump is what re-asserts the
# seed"). So a deployment that already extracted `cell-filter@0.1.0` keeps executing
# the OLD compute kernel after an upgrade, while the frontend ships the NEW
# `ui/cell-filter.yaml` (vite-bundles it at build time) that records the DSL
# predicate — reproducing, at deploy granularity, exactly the recorded-predicate-vs-
# committed-mask divergence this whole feature exists to eliminate.
#
# This lock is the guard: it pins (declared version, kernel sha256) as ONE fact.
# Editing the kernel without bumping `manifest.yaml`'s `version:` fails here, which
# forces the bump to be a deliberate act rather than an omission.
#
# RED ON REVERT: set `_MANIFEST_VERSION_LOCK` back to `("0.1.0", "40e6d91f…")` — the
# pair as of this branch's merge-base — and the test reports the kernel changed under
# an unchanged version.
#
# The lock is only a guard while it is CURRENT. It went stale one bump ago: 44730091
# moved `manifest.yaml` to 0.6.0 and left the lock at 0.5.0, so this test has been RED
# on the branch ever since — failing on the FIRST assertion (declared != locked), which
# means the kernel-sha assertion underneath it never even evaluated. A pinned pair that
# nobody re-pins stops pinning anything; re-pinned to the current pair here.
#
# The version stays 0.6.0 rather than bumping again: 0.6.0 is branch-local and
# unreleased (the merge-base declares 0.1.0), so the kernel edit below rides the bump
# that is already in flight. A bump is owed per RELEASED version, not per commit.
#
# Re-locked for artifact-model ITEM-26: the keep-mask is now written as a Zarr artifact
# directory through the shared `_lib` writer instead of a JSON array of booleans.
#
# Then bumped 0.6.0 -> 0.7.0, reversing the "unreleased, so the sha moves and the version
# does not" reasoning above. `scripts/check-processor-seed-versions.sh` measures against
# origin/main, where this package IS 0.6.0 — so a deployment provisioned from main holds
# 0.6.0, and the extractor SKIPS re-extraction at an unchanged version. It would keep
# running the old kernel against a server that now expects Zarr. "Released" is the wrong
# axis; "already provisioned somewhere" is the one that bites, and main counts.
#
# Re-locked for the manifest/UI separation (ITEM-18 + ITEM-24). `manifest.yaml` moved to
# 0.8.0 with the removed-key migration, and the kernel's INPUT PATH changed under it: the
# `expression*.h5ad` glob and the AnnData reader are gone, replaced by slot-resolved
# artifacts (CSC matrix + `column:<name>` metadata-columns + `cells_index`). A deployment
# provisioned from main holds 0.7.0 and the extractor SKIPS re-extraction at an unchanged
# version, so the two HAVE to move together: an old kernel globbing for an `.h5ad` against
# a server that now mounts a Zarr store would find nothing.
#
# Re-locked for MASK COLUMN NAMING (0.8.0 -> 0.9.0). The kernel stopped slugging: the
# committed column is the label verbatim, a blank one is refused, and only the filename is
# sanitised. The view moved with it (it now refuses a name already on the axis), and the two
# have to arrive together — an old kernel still writing `keep_<label>` under a form that
# checked the un-prefixed name for collisions would commit a column the check never examined.
#
# Re-locked for GATE IDENTITY (0.9.0 -> 0.10.0). `resolve_gate` stopped falling back from
# a cell ID to a ROW POSITION when the id was absent, and `_gate_to_ids` stopped reading a
# digits-only barcode string as an index; a gate that identifies no cell is now refused and
# `filter-report.json` carries `gate_unmatched` (report_schema 3). An old extracted kernel
# under the new manifest would keep silently selecting a neighbouring cell, which is the
# exact defect — so the two have to arrive together.
# Re-locked for FILTER→VIRTUAL-DATASET (0.10.0 -> 0.11.0). The keep-mask output now carries a
# `meta.filter_mask` MARKER (an object with the run label) so the server-side finalize sink
# recognizes it and mints a `source='filter'` virtual dataset (ITEM-13, §11.3 / DEC-6). An old
# extracted kernel under the new manifest would emit an UNMARKED mask, which the sink ignores —
# so a filter run would silently create no dataset. The two must arrive together.
# Re-locked for THE DEPENDENCY CONTRACT (0.11.0 -> 0.11.1, #80). The kernel's outputs-manifest
# writer now also emits the run's ENVIRONMENT RECORD — the resolved version of every library
# this package declares — and refuses the run when the environment contradicts that
# declaration. An old extracted kernel under the new manifest would emit NO environment record,
# so the run would be published with nothing saying which library versions produced it, which is
# the state #80 exists to end. The two must arrive together.
#
# WHAT THIS LOCK DOES AND DOES NOT ENFORCE. It ties the kernel's BYTES to the DECLARED
# VERSION: a kernel edit without a version bump is red, and a version bump without
# updating this tuple is red. It does NOT read `manifest.yaml`'s other contents, so
# "a manifest change implies a bump" is a rule this file cannot check — the entries below
# record WHY each bump happened; they do not prove the bump was mandatory.
#
# Re-locked for THE DECLARED ENV (0.11.1 -> 0.11.2, #191). The contribution now DECLARES
# `env: single-cell` beside its `run:` block, which is what the #80 dependency gate resolves
# `run.dependencies` against once a SECOND recipe (`single-cell-r`) exists on disk — an
# env-LESS declaration is checked against every recipe, so this package's python pins would
# be demanded of the R env too. The kernel bytes did NOT move (the sha below is unchanged);
# the MANIFEST did, and `embedded.rs::reconcile` is version-keyed, so a deployment
# provisioned from main would keep an extracted manifest carrying no `env:` and route the
# run at the wrong image. That is why the version was bumped by hand — and because the
# VERSION moved, this tuple had to move with it, which is the part that IS enforced.
_MANIFEST_VERSION_LOCK = (
    "0.11.2",
    "6e40237c9718ad8710d0186668a89d04d7c8e3fd187969775a1b0acafdba58bf",
)


def _declared_version():
    manifest = os.path.abspath(
        os.path.join(os.path.dirname(__file__), os.pardir, "manifest.yaml")
    )
    with open(manifest, encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("version:"):
                return line.split(":", 1)[1].strip()
    raise AssertionError("manifest.yaml declares no top-level `version:`")


def test_the_kernel_and_the_declared_package_version_move_together():
    import hashlib

    with open(_CF_SCRIPT, "rb") as fh:
        actual_sha = hashlib.sha256(fh.read()).hexdigest()
    locked_version, locked_sha = _MANIFEST_VERSION_LOCK
    declared = _declared_version()

    assert declared == locked_version, (
        f"manifest.yaml declares version {declared!r} but the lock records "
        f"{locked_version!r}. If you bumped the version, update _MANIFEST_VERSION_LOCK "
        f"in the same commit."
    )
    assert actual_sha == locked_sha, (
        f"compute/cell-filter.py changed (sha256 {actual_sha}) but the package is still "
        f"declared {declared!r}. `embedded.rs::reconcile` SKIPS re-extraction at an "
        f"unchanged version, so every already-deployed install would keep running the "
        f"OLD kernel while the frontend ships the NEW ui/cell-filter.yaml. Bump "
        f"`manifest.yaml`'s `version:` and update _MANIFEST_VERSION_LOCK together."
    )
