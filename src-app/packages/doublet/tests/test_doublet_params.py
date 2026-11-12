#!/usr/bin/env python3
# ruff: noqa
"""TEST-24 [acceptance] [invariant: INV-10] [covers: ITEM-3, ITEM-4] — THE INPUT BOUNDARY.

*Every stage is a named refusal on failure, never a silent wrong answer* — applied to the
params channel, which is the one surface a blind correctness review found completely
untested.

── Why this file exists ────────────────────────────────────────────────────────────────
"Pass every parameter explicitly" is only half of INV-10. The other half is that the value
actually passed is the value the user asked for. Three failure shapes were live before this
file, all of them silent, and all of them worse than a crash because the run SUCCEEDS and the
provenance report then faithfully records the substituted value — so the exported methods
document asserts a method nobody chose:

  * `{"threshold": "0,3"}` (a European decimal comma) parsed as unreadable, was treated as
    ABSENT, and the run silently used Scrublet's automatic threshold while recording
    `threshold_source: "automatic"`.
  * `{"mean_center": "t"}` fell through a truthiness test to `False`, inverting a `True`
    default, changing every score, and recording `mean_center: false` as though asked for.
  * `{"expected_doublet_rate": 0}` reached Scrublet's score formula
    (`ld = q*rho/r / (1 - rho - q*(1 - rho - rho/r))`), where `rho = 0` makes every score
    exactly 0.0 and divides by zero in the standard error — an all-zero column that writes
    cleanly and reads as a result. `-0.1` produced NEGATIVE doublet scores; `2.0` produced
    infinities.

ABSENT and UNPARSEABLE are different answers. Blank means "derive it"; present-but-unreadable
means the user asked for something and did not get it. The bounds are re-checked HERE rather
than trusted to `ui/doublet.yaml`, because the compute is reachable by an agent/MCP call that
never rendered the form — the same reason the ceiling gate is compute-side. Six of the
parameters below are not in the form at all, so that channel is the ONLY way to set them.
"""
import numpy as np
import pytest

from doublet_fixtures import require_skimage, structured_counts

PARAMS = {"n_prin_comps": 10}


@pytest.fixture
def run_with(detect_run):
    """Launch a real run with `extra` merged over the working defaults, and hand back the
    process so the refusal can be read off stderr."""
    def go(extra, *, cells=40, genes=90):
        run = detect_run()
        run.add_matrix(structured_counts(cells, genes, n_groups=3, seed=0))
        return run, run.run(dict(PARAMS, **extra))
    return go


# ── a present-but-unreadable value is REFUSED, never treated as absent ──────────────
@pytest.mark.parametrize("params,token", [
    ({"threshold": "0,3"}, "threshold"),              # European decimal comma
    ({"threshold": "0.3%"}, "threshold"),
    ({"threshold": "abc"}, "threshold"),
    ({"expected_doublet_rate": "8%"}, "expected_doublet_rate"),
    ({"doublet_rate_per_1k": "0,008"}, "doublet_rate_per_1k"),
    ({"n_prin_comps": "abc"}, "n_prin_comps"),
    ({"n_neighbors": "abc"}, "n_neighbors"),
    ({"seed": "abc"}, "seed"),
    ({"sim_doublet_ratio": "two"}, "sim_doublet_ratio"),
])
def test_an_unreadable_numeric_param_is_a_named_refusal(run_with, params, token):
    run, proc = run_with(params)
    assert proc.returncode != 0, (
        f"{params} was accepted; the run would have silently substituted a default and then "
        "recorded the substituted value as though it had been asked for")
    diag = run.diagnostics(proc)
    assert f"`{token}`" in diag, diag
    assert "no default is substituted" in diag
    assert not (run.outputs_dir / "manifest.json").exists()


@pytest.mark.parametrize("value", ["1e999", "-1e999", "nan", float("inf"), float("nan")])
def test_a_non_finite_numeric_param_is_a_named_refusal(run_with, value):
    """`float("1e999")` is `inf`, and `int(inf)` raises `OverflowError` — which is not a
    `ValueError`, so it escaped the coercer's handler entirely and surfaced as an uncaught
    traceback before any progress frame. A bare JSON literal reaches the same place:
    `json.dumps(float("inf"))` emits `Infinity`, which `json.loads` accepts — so the last two
    cases below reach the coercer as a bare float, with no string involved."""
    run, proc = run_with({"seed": value})
    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert "`seed`" in diag, diag
    assert proc.stderr.strip().splitlines()[-1].startswith("doublet.detect:"), (
        "a raw traceback escaped instead of the named refusal:\n" + proc.stderr[-600:])


@pytest.mark.parametrize("params,token", [
    ({"n_prin_comps": [10]}, "n_prin_comps"), ({"seed": {"a": 1}}, "seed"),
    ({"threshold": ["0.3"]}, "threshold"),
    ({"expected_doublet_rate": {}}, "expected_doublet_rate"),
])
def test_a_structured_value_where_a_number_belongs_is_a_named_refusal(run_with, params, token):
    run, proc = run_with(params)
    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    # BOTH bindings, not just "a refusal happened": the parameter name, and the sentence only
    # `_refuse_param` emits. Without the second, an UNRELATED named refusal that happens to
    # mention the same token satisfies the test.
    assert f"`{token}`" in diag, diag
    assert "no default is substituted" in diag, diag


# ── booleans: an unrecognised spelling is refused, NOT silently False ───────────────
@pytest.mark.parametrize("value", ["t", "y", "TRUE!", "maybe", "2"])
def test_an_unrecognised_boolean_is_refused_not_read_as_false(run_with, value):
    """The old truthiness test returned `False` for anything outside its true-set, so `"t"`
    INVERTED a `True` default (`mean_center`, `normalize_variance`) and changed every score
    while the report recorded the flipped value as though chosen. `mean_center` is not even
    in the form, so this channel is the only way to reach it."""
    run, proc = run_with({"mean_center": value})
    assert proc.returncode != 0, (
        f"mean_center={value!r} was accepted; a True default would have silently become False")
    assert "`mean_center`" in run.diagnostics(proc)


@pytest.mark.parametrize("value,expected", [
    (True, True), (False, False), ("true", True), ("FALSE", False),
    ("yes", True), ("off", False), ("1", True), ("0", False), (1, True), (0, False),
])
def test_the_recognised_boolean_spellings_round_trip(detect_run, value, expected):
    require_skimage()
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok(dict(PARAMS, log_transform=value))
    assert run.report()["parameters"]["log_transform"] is expected


# ── bounds: the compute is the BELT to the form's braces ───────────────────────────
@pytest.mark.parametrize("params,token", [
    ({"expected_doublet_rate": "0"}, "expected_doublet_rate"),
    ({"expected_doublet_rate": "-0.1"}, "expected_doublet_rate"),
    ({"expected_doublet_rate": "2.0"}, "expected_doublet_rate"),
    ({"expected_doublet_rate": "1.0"}, "expected_doublet_rate"),
    ({"doublet_rate_per_1k": "0"}, "doublet_rate_per_1k"),
    ({"doublet_rate_per_1k": "-1"}, "doublet_rate_per_1k"),
    ({"sim_doublet_ratio": "0"}, "sim_doublet_ratio"),
    ({"sim_doublet_ratio": "1000"}, "sim_doublet_ratio"),
    ({"threshold": "-0.5"}, "threshold"),
    ({"threshold": "1.5"}, "threshold"),
    ({"n_prin_comps": "0"}, "n_prin_comps"),
    ({"n_prin_comps": "-5"}, "n_prin_comps"),
    ({"n_prin_comps": "100000"}, "n_prin_comps"),
    ({"n_neighbors": "0"}, "n_neighbors"),
    ({"n_neighbors": "-5"}, "n_neighbors"),
    ({"seed": "-1"}, "seed"),
    ({"seed": "5000000000"}, "seed"),
    ({"synthetic_doublet_umi_subsampling": "0"}, "synthetic_doublet_umi_subsampling"),
    ({"synthetic_doublet_umi_subsampling": "2"}, "synthetic_doublet_umi_subsampling"),
    ({"stdev_doublet_rate": "-0.1"}, "stdev_doublet_rate"),
])
def test_an_out_of_band_parameter_is_refused_rather_than_producing_a_malformed_score(
        run_with, params, token):
    """Each bound is a real property of the score formula, not a defensive guess: at
    `rho = 0` every score is 0.0 and the standard error divides by zero; at `rho >= 1` the
    denominator changes sign and scores go negative; at `r = 0` the ratio is `inf`; a seed
    outside [0, 2**32-1] is rejected by `check_random_state` with a message about seeds
    rather than about this analysis."""
    run, proc = run_with(params)
    assert proc.returncode != 0, (
        f"{params} was accepted — it produces a malformed score column that still writes "
        "cleanly and still reads as a result")
    diag = run.diagnostics(proc)
    assert f"`{token}`" in diag, diag
    # Bind to `_refuse_param`'s own sentence. Without it, three of these cases were satisfied
    # by the UNRELATED degenerate-population refusal, whose lever text says "lower
    # `n_prin_comps`" — so a bounds test passed while the bound was gone.
    assert "no default is substituted" in diag, diag


def test_a_bad_knn_metric_is_named_as_a_metric_typo(run_with):
    """Before this, a typo landed in the blanket handler around `sc.pp.scrublet` and was
    reported as "this is a degenerate population rather than a bug", offering levers (lower
    `n_prin_comps`, merge a batch level) that are wrong for the actual cause. The user was
    told their sample was degenerate when their parameter was misspelled."""
    run, proc = run_with({"knn_dist_metric": "euclidian"})
    assert proc.returncode != 0
    diag = run.diagnostics(proc)
    assert "`knn_dist_metric`" in diag
    assert "euclidean" in diag                     # names the supported set
    assert "degenerate population" not in diag     # and NOT the wrong diagnosis


# ── the label names a COLUMN, and is interpolated into a PATH ──────────────────────
@pytest.mark.parametrize("label", ["../../../escape", "a/b", "..", "with space",
                                   "-leading", "x" * 65, ""])
def test_a_label_that_is_not_a_column_name_is_refused(run_with, label):
    """The label is interpolated into `metadata/<label>_score.zarr`, and the writer does
    `outputs_dir / rel_dir` with `mkdir(parents=True)` — so `../../../x` writes OUTSIDE the
    outputs root and hands ingest a manifest path that escapes it. The form's `not_in` rule
    is a COLLISION guard, not a character guard, and the form is not the only caller."""
    run, proc = run_with({"label": label})
    assert proc.returncode != 0, f"label={label!r} was accepted"
    assert "`label`" in run.diagnostics(proc)


@pytest.mark.parametrize("label", ["doublet", "run2", "d.2", "a_b-c", "X1"])
def test_a_well_formed_label_is_accepted_and_names_the_columns(detect_run, label):
    require_skimage()
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok(dict(PARAMS, label=label))
    ids = {e["id"] for e in run.entries()}
    assert f"metadata-column:{label}_score" in ids
    # The emitted PATH is exactly the one the label composes — asserting `".." not in path`
    # could not fail for a label that is well-formed by construction, so it proved nothing.
    score = next(e for e in run.entries() if e["id"].endswith(f"{label}_score"))
    assert score["path"] == f"metadata/{label}_score.zarr"


# ── a blank param is still "derive it", and 0 is still a genuine 0 ────────────────
def test_a_blank_param_still_means_derive_it(detect_run):
    """The refusals above must not have made blank unusable: the form sends `""` for both
    `expected_doublet_rate` and `threshold` when the user leaves them empty, and that is the
    normal path."""
    require_skimage()
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok(dict(PARAMS, expected_doublet_rate="", threshold="", n_neighbors=""))
    record = run.report()["batches"][0]
    assert record["rate_source"] == "auto_10x_0.8pct_per_1k"
    assert record["threshold_source"] == "automatic"
    assert run.report()["parameters"]["n_neighbors"] is None


def test_zero_is_a_value_not_an_absence_where_zero_is_legal(detect_run):
    """`"0"` must not collapse into "blank". `stdev_doublet_rate: 0` is a legal, meaningful
    value (no uncertainty in the prior), so it has to reach Scrublet as 0.0."""
    require_skimage()
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok(dict(PARAMS, stdev_doublet_rate="0"))
    assert run.report()["parameters"]["stdev_doublet_rate"] == 0.0


# ── the criteria recipe is client JSON and must not crash on a bad shape ──────────
@pytest.mark.parametrize("column", [["pct_mt"], {"a": 1}, 5, None])
def test_a_non_string_criterion_column_does_not_crash_the_run(detect_run, column):
    """`col in filter_obs` on an unhashable value raises `TypeError: unhashable type` — even
    against an EMPTY dict, so no bound column is needed to trigger it. The vendored kernel
    was hardened against exactly this input after it took down a production job; the report
    loop beside it must not re-introduce it."""
    require_skimage()
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    proc = run.run(dict(PARAMS, criteria=[{"column": column, "min": "0"}]))

    assert proc.returncode == 0, (
        "a malformed criterion column crashed the run:\n" + proc.stderr[-900:])
    # a criterion naming no column imposes no constraint — every cell is still scored
    assert len(run.scores()) == 120
    entry = run.report()["prefilter"]["columns"][0]
    assert entry["present"] is False
    # A non-string column cannot be a column NAME, so it is recorded as such: `column` is
    # null and the raw value is preserved separately. Asserting these is what binds the
    # HASHABLE cases (5, None) to the guard — `col in filter_obs` never raises for those, so
    # `present is False` alone is satisfied by the unguarded code too.
    assert entry["column"] is None
    assert entry["column_raw"] == repr(column)


def test_a_trimmed_column_name_is_reported_as_present(detect_run):
    """`criteria_keep_mask` looks the column up by its TRIMMED name, so the report must too.
    Comparing the untrimmed spelling recorded `present: false` for a criterion that had in
    fact been applied — a report/reality divergence in the field a reader uses to decide
    whether the recipe was honoured."""
    require_skimage()
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.add_column([1.0] * 100 + [0.0] * 20, slot="column:qc", name="qc")
    run.run_ok(dict(PARAMS, criteria=[{"column": "  qc  ", "min": "0.5"}]))

    prefilter = run.report()["prefilter"]
    assert prefilter["n_excluded"] == 20, "the criterion did not actually apply"
    assert prefilter["columns"][0]["present"] is True, (
        "the filter applied but the report says the column was absent")


# ── the batch column: a MISSING sample key is not a sample ─────────────────────────
@pytest.mark.parametrize("encoding", ["categorical", "string", "pandas_na", "numeric"])
def test_a_missing_sample_key_is_a_named_refusal_not_an_anonymous_batch(detect_run, encoding):
    """The highest-consequence finding a blind review can make against this package, and it
    survived a first fix because "missing" has TWO spellings on the wire.

    Grouping cells with an unknown sample turns them into ONE anonymous level, scored as a
    single population — different captures pooled, one shared rate prior, exit 0, no warning,
    a batch labelled "". Verbatim the pair of failures the per-sample split exists to
    prevent, arriving through the one door the split did not watch.

    BOTH encodings are driven, because a blank-only check passes the one that matters:
    `write_metadata_column`'s STRING branch writes a missing value as `""`, but its
    CATEGORICAL branch invents a real declared level (`NA`) and records its name in the
    column's structure — and the sample picker offers ONLY categorical columns, so the
    categorical spelling is the one the shipped form can actually produce. The named
    motivating case (a merged import with an incomplete `donor_id`) is a categorical.
    """
    import pandas as pd

    dense = structured_counts(40, 90, n_groups=3, seed=0)
    n = dense.shape[0]
    labels = [None if i < 40 else ("S1" if i < 80 else "S2") for i in range(n)]
    if encoding == "categorical":
        values = pd.Categorical(labels)
    elif encoding == "pandas_na":
        # `pd.NA` is neither `None` nor float-NaN, so `txr_columns._as_strings` does NOT map
        # it to `""` — it becomes the literal string `"<NA>"`. The column is still stamped
        # `kind: categorical` in its meta, so the sample picker OFFERS it, and it carries no
        # `missing_level` for the stamp reader to find. A guard that knew only about blanks
        # and the stamp passed it straight through into an anonymous pooled batch.
        values = pd.Series([pd.NA if v is None else v for v in labels], dtype=object)
    elif encoding == "numeric":
        # a float column's missing values read back as the literal `"nan"`
        values = pd.Series([float("nan") if v is None else float(len(v)) for v in labels])
    else:
        values = labels

    run = detect_run()
    run.add_matrix(dense)
    run.add_column(values, slot="batch", name="sample")
    proc = run.run(dict(PARAMS, batch_column="sample"))

    assert proc.returncode != 0, (
        f"cells with no sample key ({encoding} encoding) were silently grouped into one "
        "anonymous batch")
    diag = run.diagnostics(proc)
    assert "40 of the 120 cells" in diag, diag
    assert "'sample'" in diag
    assert "not a sample" in diag
    assert "pre-filter" in diag and "unbatched" in diag     # the named levers
    assert not (run.outputs_dir / "manifest.json").exists()
    # The refusal NAMES the value it saw, so a user whose column holds a GENUINE sample
    # called `NA` can tell what happened and rename it. For the categorical encoding that
    # value is the invented level, read from the column's own stamp rather than guessed.
    assert "the value(s) seen:" in diag, diag
    # the exact spelling depends on the encoding — the point is that the refusal NAMES it,
    # so a user whose column holds a GENUINE sample called `NA` or `nan` can see what
    # happened and rename it rather than being told only that "something is missing"
    assert any(f"'{form}'" in diag for form in ("NA", "<NA>", "nan", "<blank>")), diag
    assert "rename it" in diag


def test_the_prefilter_lever_the_refusal_names_actually_works(detect_run):
    """A lever named in a refusal that fires BEFORE the filter runs is not a lever.

    The first version of this guard was evaluated on the full column, so "exclude the
    unassigned cells with the inline pre-filter" could never suppress it: the only two
    escapes left were re-importing the dataset and running unbatched, and for a merged
    multi-sample matrix unbatched is the exact wrong answer this file is organised against.
    The check now runs on the cells that SURVIVE the filter, so the lever is real — which is
    what this test drives.
    """
    import pandas as pd

    require_skimage()
    dense = structured_counts(40, 90, n_groups=3, seed=0)
    n = dense.shape[0]
    labels = [None if i < 40 else ("S1" if i < 80 else "S2") for i in range(n)]

    run = detect_run()
    run.add_matrix(dense)
    run.add_column(pd.Categorical(labels), slot="batch", name="sample")
    run.add_column(["no"] * 40 + ["yes"] * 80, slot="column:assigned", name="assigned")
    run.run_ok(dict(PARAMS, batch_column="sample",
                    criteria=[{"column": "assigned", "keep": ["yes"]}]))

    report = run.report()
    assert report["batched"] is True
    assert report["n_batches"] == 2
    assert {b["batch"] for b in report["batches"]} == {"S1", "S2"}
    assert report["prefilter"]["n_excluded"] == 40
    assert set(run.calls()[:40]) == {"not_evaluated"}


def test_a_fully_labelled_batch_column_is_still_accepted(detect_run):
    """The control: the refusal above must not have made batching unusable."""
    require_skimage()
    dense = structured_counts(40, 90, n_groups=3, seed=0)
    run = detect_run()
    run.add_matrix(dense)
    run.add_column(["S1"] * 60 + ["S2"] * 60, slot="batch", name="sample")
    run.run_ok(dict(PARAMS, batch_column="sample"))
    assert run.report()["n_batches"] == 2


@pytest.mark.parametrize("key", ["threshold", "expected_doublet_rate", "n_neighbors"])
def test_whitespace_only_is_ABSENT_not_unreadable(detect_run, key):
    """`_absent` treats a whitespace-only string as absent, which matters because a form
    field the user cleared can arrive as `"   "`. It must mean "derive it", not "refused",
    and not "zero"."""
    require_skimage()
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok(dict(PARAMS, **{key: "   "}))
    record = run.report()["batches"][0]
    assert record["rate_source"] == "auto_10x_0.8pct_per_1k"
    assert record["threshold_source"] == "automatic"


@pytest.mark.parametrize("key", ["n_prin_comps", "seed", "threshold", "sim_doublet_ratio"])
def test_a_boolean_where_a_number_belongs_is_refused(run_with, key):
    """`True` is an `int` in Python, so an unguarded coercer reads `{"n_prin_comps": true}`
    as a 1-component PCA and `{"seed": false}` as seed 0 — a value the caller never meant,
    recorded as though chosen."""
    run, proc = run_with({key: True})
    assert proc.returncode != 0, f"{key}=True was accepted as the number 1"
    diag = run.diagnostics(proc)
    assert f"`{key}`" in diag and "no default is substituted" in diag, diag


# ── filter_applied vs excluded_any: the case that distinguishes them ───────────────
def test_a_recipe_that_excludes_NOTHING_still_reports_that_a_filter_ran(detect_run):
    """The distinguishing case, and the only one that can see the difference between
    `applied` and `excluded_any`.

    `applied` used to be `bool(criteria) and n_kept != n_cells`, so a recipe that RAN but
    happened to exclude nothing reported `applied: false` beside a non-empty `criteria` list.
    A methods paragraph reading `applied` would then state that no filter ran when one did —
    the inverse of "never describe a laxer method than the one that ran". Every other
    pre-filter test either has no criteria or has criteria that DO exclude, so none of them
    can distinguish the two fields.
    """
    require_skimage()
    dense = structured_counts(40, 90, n_groups=3, seed=0)
    n = dense.shape[0]
    run = detect_run()
    run.add_matrix(dense)
    run.add_column([1.0] * n, slot="column:qc", name="qc")   # every cell passes
    run.run_ok(dict(PARAMS, criteria=[{"column": "qc", "min": "0.5"}]))

    prefilter = run.report()["prefilter"]
    assert prefilter["applied"] is True, "a criteria recipe ran but the report denies it"
    assert prefilter["excluded_any"] is False
    assert prefilter["n_excluded"] == 0
    assert prefilter["n_kept"] == n
    # …and no third level is declared, because nothing was excluded
    assert run.report()["call_levels"] == ["singlet", "doublet"]


def test_a_label_whose_committed_columns_already_exist_is_refused(detect_run):
    """The form's `not_in` guard is a MIS-TRANSPLANT from `cell-filter`, which commits a
    column named exactly `<label>`. This analysis commits `<label>_score` and `<label>_call`,
    so the form's check tests a string this run never writes — re-running with the same label
    passes the form and lands a SECOND `doublet_score` on the axis, leaving two columns with
    one name and a reader keeping whichever came last.

    The compute therefore checks the names it will ACTUALLY commit.
    """
    dense = structured_counts(40, 90, n_groups=3, seed=0)
    run = detect_run()
    run.add_matrix(dense)
    # a prior run's score column, bound as an ordinary cells-axis column
    run.add_column([0.1] * dense.shape[0], slot="column:doublet_score", name="doublet_score")
    proc = run.run(dict(PARAMS, criteria=[{"column": "doublet_score", "max": "0.9"}]))

    assert proc.returncode != 0, "a second `doublet_score` was committed onto the same axis"
    diag = run.diagnostics(proc)
    assert "'doublet_score'" in diag, diag
    assert "Two columns with one name" in diag
    assert "different label" in diag


def test_a_distinct_label_is_accepted_beside_an_existing_column(detect_run):
    """The control: the collision check must refuse only a real collision."""
    require_skimage()
    dense = structured_counts(40, 90, n_groups=3, seed=0)
    run = detect_run()
    run.add_matrix(dense)
    run.add_column([0.1] * dense.shape[0], slot="column:doublet_score", name="doublet_score")
    run.run_ok(dict(PARAMS, label="run2",
                    criteria=[{"column": "doublet_score", "max": "0.9"}]))
    ids = {e["id"] for e in run.entries()}
    assert "metadata-column:run2_score" in ids


@pytest.mark.parametrize("levels", [
    ("Tumor", "NAT"),        # NAT = Normal Adjacent Tissue — a standard tumour-cohort label
    ("Treated", "None"),     # an ordinary no-treatment arm
    ("A", "NULL"),           # a real surname, and a real cohort label
    ("A", "nat"),
    ("Nan", "NAN"),          # only the exact lowercase `nan` is pandas' repr
    ("na", "NA_2"),
])
def test_a_LEGITIMATE_sample_name_that_looks_like_a_null_is_not_refused(detect_run, levels):
    """The negative control for `MISSING_VALUE_SENTINELS`, and the reason it is
    case-SENSITIVE and short.

    An earlier version matched case-insensitively over `{"<na>", "nan", "nat", "none",
    "null"}` and refused real datasets outright — a merged `Tumor` / `NAT` matrix, which is
    *precisely* the multi-sample case this analysis exists for, came back as "60 of the 120
    cells being scored have no value". The only lever such a refusal offers is "rename your
    sample", i.e. corrupt your own nomenclature to run the analysis, and for a shared cohort
    that is not an edit the user owns.

    A guard that refuses real data is not a safer guard. Without this control, narrowing the
    set could silently regress back — the positive tests would all still pass, because they
    only ever assert that a MISSING value IS caught.
    """
    require_skimage()
    dense = structured_counts(40, 90, n_groups=3, seed=0)
    n = dense.shape[0]
    labels = [levels[0]] * (n // 2) + [levels[1]] * (n - n // 2)

    run = detect_run()
    run.add_matrix(dense)
    run.add_column(labels, slot="batch", name="sample")
    run.run_ok(dict(PARAMS, batch_column="sample"))

    report = run.report()
    assert report["batched"] is True
    assert report["n_batches"] == 2, report["batches"]
    assert {b["batch"] for b in report["batches"]} == set(levels)


def test_the_sentinel_set_is_exactly_the_pandas_repr_forms():
    """Pins the set itself, so a future widening has to be argued for. Each entry is a string
    a MISSING value actually arrives as; nothing else belongs here, because every addition is
    a class of legitimate sample name refused."""
    import sys
    from pathlib import Path

    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "compute"))
    from doublet_fixtures import load_shared

    S = load_shared()

    assert set(S.MISSING_VALUE_SENTINELS) == {"<NA>", "NaT", "nan"}
    for real in ("NAT", "None", "NULL", "Null", "nat", "NaN", "NAN", "NA", "Tumor", "n/a"):
        assert not S.is_missing_label(real), f"{real!r} is a legitimate sample name"
    for missing in ("", "   ", "<NA>", "NaT", "nan"):
        assert S.is_missing_label(missing), missing
    # …and the stamped level is caught whatever it is called
    assert S.is_missing_label("NA", "NA")
    assert S.is_missing_label("NA_", "NA_")
    assert not S.is_missing_label("NA", "NA_")
