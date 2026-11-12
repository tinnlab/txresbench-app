#!/usr/bin/env python3
# ruff: noqa
"""doublet.detect — per-cell doublet score + call from a raw count matrix (Scrublet).

Reads ONE `single-cell/expression` RAW count matrix and produces two cells-axis
`metadata-column`s — a continuous `<label>_score` and a CATEGORICAL `<label>_call` — plus a
`report/qc` provenance report. It NEVER filters, NEVER emits a subset matrix and NEVER
removes a cell: it annotates. Removing cells is `cell.filter`, which needs no change (it
already consumes `metadata-column` and its criterion picker sources every column any run put
on the cells axis).

## The fixed pipeline

    resolve inputs -> read the matrix STRUCTURE + the batch column ->
    CEILING GATE (before the matrix is read) -> read CSC -> raw-integer gate ->
    INLINE PRE-FILTER -> split into per-sample populations ->
    score each population INDEPENDENTLY with Scrublet -> threshold per population
    (automatic, or the explicit param) -> reassemble in input order ->
    write the score column -> write the call column (ONLY where a threshold was determined) ->
    provenance report

Every stage is a named refusal on failure, never a silent wrong answer.

## The input contract

Resolved by SLOT out of `/inputs/inputs.json` (never a filename suffix):

  * `matrix`       - REQUIRED, exactly ONE `single-cell/expression` CSC store of RAW counts.
                     SINGULAR: this is an RNA-count method; ATAC doublets need dedicated
                     tools (AMULET), so one matrix, one run.
  * `batch`        - OPTIONAL, a categorical cells-axis `metadata-column`. Bound => each of
                     its levels is scored INDEPENDENTLY (the correctness core). A
                     `metadata-column` store cannot carry its own name, so the column arrives
                     as a SLOT and its display name travels as the `batch_column` param.
  * `column:<name>`- 0..N, OPTIONAL. One cells-axis obs column the inline pre-filter's
                     `criteria` may reference, one slot per referenced column.
  * `cells_index`  - OPTIONAL, the cells-axis KEY artifact. Supplies the row space's
                     `key_sequence_digest` for `aligned_to`. Absent means absent.

Params (`/inputs/params.json`): `label` (the output column prefix, default `doublet`),
`seed` (0), `expected_doublet_rate` (blank => derived per sample, see below),
`doublet_rate_per_1k` (0.008; HT chips use 0.004), `threshold` (blank => Scrublet's
automatic threshold), `n_prin_comps` (30), `sim_doublet_ratio` (2.0),
`stdev_doublet_rate` (0.02), `synthetic_doublet_umi_subsampling` (1.0),
`knn_dist_metric` (euclidean), `normalize_variance` (true), `log_transform` (false),
`mean_center` (true), `n_neighbors` (blank => Scrublet's `round(0.5*sqrt(n))`),
`batch_column` (the bound column's display name, for the report and `methods.md`),
`criteria` (the inline pre-filter recipe).

## The expected-doublet-rate prior

Scrublet's own default is a flat 0.05 (scanpy's wrapper; the standalone class uses 0.1),
which is wrong in BOTH directions on real data:
it over-calls a 2,000-cell run (true rate ~1.6%) and under-calls a 20,000-cell run (~16%).
The 10x Chromium multiplet rate scales ~linearly with recovered cells at ~0.8% per 1,000
(scDblFinder encodes exactly this as `dbr.per1k = 0.008`), so the default here is

    expected_doublet_rate = clamp(doublet_rate_per_1k * n_cells / 1000, 0.005, 0.25)

computed from the SCORED POPULATION's own cell count. An explicit `expected_doublet_rate`
overrides it and the report records `rate_source: "user"`; otherwise
`rate_source: "auto_10x_0.8pct_per_1k"` plus the resolved value.

## Never fabricate a call

Scrublet's automatic threshold is the minimum between the two modes of the SIMULATED score
histogram. When that histogram is not bimodal the minimum does not exist, and scanpy's own
wrapper responds by writing `predicted_doublet = False` for EVERY cell — an all-singlet
column that reads as a confident answer to a question the method could not answer. We refuse
that: the score column is emitted, the CALL ARTIFACT IS OMITTED ENTIRELY, and the report
records `threshold_source: "undetermined"` with the reason. The reachable lever is the
explicit `threshold` param. A fabricated threshold is never substituted. (Same doctrine as
`de/result`, which omits `padj` rather than filling it with 1 — absence is absence.)

## Every parameter is passed explicitly

`scanpy` is UNPINNED in the env rootfs, so a scientific default can move under a shipped
package between two image builds. Two halves of the `harmonypy` precedent apply: pass every
parameter `sc.pp.scrublet` accepts EXPLICITLY (never a scanpy default), and RECORD the
resolved `scanpy.__version__` in the report, asserted against a declared supported set.
Three knobs of the standalone Scrublet class (`min_counts`, `min_cells`,
`min_gene_variability_pctl`) are NOT exposed by scanpy's wrapper — it hardcodes its own
filtering and HVG step — so they are recorded under `fixed_by_scanpy` rather than faked as
parameters this package cannot honour.

Roots overridable via `TXR_INPUTS_DIR` / `TXR_OUTPUTS_DIR`. Progress ->
`$TXR_PROGRESS_FIFO`.
"""
import _shared as S  # FIRST — pins the six thread vars before numpy/scanpy load

import json

import numpy as np

import txr_columns
import _criteria as CR  # the cell-filter predicate kernel, VENDORED VERBATIM


# ── the input slots this compute reads (the view<->compute seam reader reads these) ──
MATRIX_SLOT = "matrix"
#: The per-sample / batch column. A `metadata-column` store keeps its values under the
#: constant member `values` and CANNOT carry its own name, so the chosen column is bound as
#: an input SLOT (through the view's `inputs_from` repeater), never passed as a string param.
#: Its display NAME travels separately as the `batch_column` param, so the report and
#: `methods.md` can say which column was used. `inputs` and `params` are separate channels
#: and must stay so.
BATCH_SLOT = "batch"
CELLS_INDEX_SLOT = "cells_index"

# ── the method ──────────────────────────────────────────────────────────────────────
METHOD = "scrublet"
CITATION = "Wolock, Lopez & Klein 2019, Cell Systems (Scrublet); as vendored in scanpy"

#: The scanpy versions whose `sc.pp.scrublet` this package has been validated against. The
#: rootfs pins nothing but `harmonypy`, so the resolved version is RECORDED in every report
#: and a version outside this set is a LOUD report warning — never a silent behaviour change.
SUPPORTED_SCANPY = ("1.10.", "1.11.")

#: The 10x Chromium multiplet rate per 1,000 recovered cells (scDblFinder's `dbr.per1k`).
DEFAULT_RATE_PER_1K = 0.008
#: The derived rate is clamped into this band: below it the prior is noise, above it the
#: simulation is dominated by the prior rather than by the data.
RATE_FLOOR, RATE_CEILING = 0.005, 0.25

# ── the bounds every user-supplied parameter is REFUSED outside of ──────────────────
#
# WHAT EACH BOUND PREVENTS is documented ONCE, at the point of use in `main()`, against the
# measured behaviour of Scrublet's score formula. It is deliberately NOT restated here: an
# earlier version carried a second copy that asserted a set of degeneracies which do not
# hold (an "all-zero column", a sign change at rho >= 1, `inf` at r = 0), and when the copy
# in `main()` was corrected this one was left — so the same file carried two contradictory
# accounts of the same formula, on the constants themselves. One account, one place.
#
#: `expected_doublet_rate` is a probability and must be strictly inside (0, 1). WHY each
#: bound exists is documented ONCE, at the point of use in `main()`, against the MEASURED
#: behaviour of the score formula. It is not restated here — an earlier version carried a
#: second copy asserting degeneracies that do not hold, and when the copy in `main()` was
#: corrected this one was left, so the file held two contradictory accounts of one formula
#: with the wrong one sitting on the constants themselves. NOT clamped: a user's number is
#: honoured or refused, never quietly moved.
RATE_MIN_USER, RATE_MAX_USER = 1e-6, 0.9
#: The same quantity per 1,000 cells; 0.008 standard chip, 0.004 HT.
RATE_PER_1K_MIN, RATE_PER_1K_MAX = 1e-6, 1.0
#: `sim_doublet_ratio` scales the simulated set, which is held beside the observed one.
SIM_RATIO_MIN, SIM_RATIO_MAX = 0.1, 20.0
#: UMI subsampling is a rate; 0 would discard every count.
UMI_SUBSAMPLING_MIN = 1e-6
#: A PCA rank beyond this cannot be satisfied by any matrix this analysis will see, and a
#: huge value turns the dense `(1+r)*n_cells x n_prin_comps` embedding into the memory bound.
N_PRIN_COMPS_MAX = 500

#: The kNN metrics this analysis accepts, checked HERE so a typo is named as a typo rather
#: than surfacing from inside sklearn as a "degenerate population".
#: VERIFIED BY RUNNING each candidate through `sklearn.neighbors.NearestNeighbors` on a
#: 40 x 30 array — the shape this analysis actually presents at the default
#: `n_prin_comps=30` — not copied from a docs page.
#:
#: Three are excluded because they genuinely raise there, and would otherwise land in
#: `score_population`'s handler and be reported as "this is a degenerate population rather
#: than a bug", which is the exact misdiagnosis this allow-list exists to prevent:
#:   * `seuclidean`  — TypeError (needs a `V` variance vector)
#:   * `haversine`   — ValueError, valid only in 2 dimensions (so it would work only at
#:                     `n_prin_comps=2`, which no realistic run uses)
#:   * `matching`    — not an sklearn metric name at all
#:
#: `mahalanobis` IS included. An earlier version removed it claiming it "needs V/VI" — that
#: is true only of the ball-tree path on low-dimensional data, and at this analysis' default
#: rank it runs clean (checked both directly and end-to-end through `sc.pp.scrublet`). It was
#: removed from a user-facing allow-list on a false premise, under a comment asserting the
#: list had been verified by running it. Re-verify by running before editing this tuple.
SUPPORTED_METRICS = ("euclidean", "sqeuclidean", "manhattan", "cityblock", "l1", "l2",
                     "chebyshev", "minkowski", "cosine", "correlation", "braycurtis",
                     "canberra", "mahalanobis", "nan_euclidean", "hamming", "jaccard",
                     "dice", "rogerstanimoto", "sokalsneath", "yule", "russellrao")

#: The characters an output `label` may contain. It is interpolated into an output PATH
#: (`metadata/<label>_score.zarr`), so `../` or `/` would write outside `/outputs` and put a
#: manifest path that escapes the outputs root in front of the ingest.
_LABEL_RE = __import__("re").compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

#: The smallest population Scrublet can honestly score. `sc.pp.scrublet` sets
#: `n_neighbors = round(0.5 * sqrt(n))` and runs a 30-component PCA over the union of the
#: observed cells and `sim_doublet_ratio`x as many simulated doublets, so a handful of cells
#: yields either a crash or a meaningless score. A batch level below this is a NAMED refusal
#: naming its levers — never a silent NaN and never a crash.
MIN_CELLS_PER_BATCH = 30

#: Bins of the SIMULATED score distribution carried in the report, per batch.
#: FIXED so every batch's table has the same number of rows and the readout's row count does
#: not move as samples are switched. NOT because of the 1 MiB `/outputs/manifest.json` cap —
#: the histogram lives in `doublet-report.json`, a separate artifact the cap does not bound;
#: the manifest `meta` carries only a handful of scalars. The per-cell scores are a
#: first-class column artifact and are never duplicated here.
HISTOGRAM_BINS = 40

#: The call column's levels. `not_evaluated` is added ONLY on a run that actually produced
#: no call for some cell — it is never declared speculatively.
LEVEL_SINGLET = "singlet"
LEVEL_DOUBLET = "doublet"
LEVEL_NOT_EVALUATED = "not_evaluated"

DISCLOSURE = {
    "flag_dont_delete": (
        "These are FLAGS for inspection, not removals — the matrix was not modified and no "
        "cells were deleted. Inspect before removing: elevated scores concentrated in a "
        "whole cluster are the strong signal, while scattered high-scoring singletons may "
        "be real cells, and on trajectory data genuine intermediate states legitimately "
        "resemble doublets."
    ),
    "homotypic": (
        "Homotypic doublets — two cells of the SAME type — are largely undetectable by any "
        "simulation-based caller, because summing two cells of one type produces a profile "
        "that looks like one more deeply sequenced cell of that type. The rate reported "
        "here is therefore a floor, not an estimate of the true multiplet rate."
    ),
    # ── UPDATED BY #195, AND IT IS THE ONE CHANGE THIS FILE TAKES ───────────────────
    #
    # This sentence used to end "...is an R/Bioconductor method and is not available in
    # this runtime." That became FALSE the moment `doublet.scdblfinder` shipped, and it is
    # the one place the falsehood was actually USER-FACING: this string travels into every
    # run's `report/qc` and `ui/doublet-report.yaml` renders it, so the default lane's own
    # readout was telling users a method two analyses down did not exist.
    #
    # It is a real tension with "the python lane does not change", and it is decided the
    # same way the manifest's `methodsText` was: a run's NUMBERS, its provenance and its
    # behaviour are untouched — only a claim about what this deployment offers, which was
    # true when written and is not now. Leaving stale text that understates our own
    # capability is the mirror image of overstating it.
    "method_tradeoff": (
        "Scrublet is mid-field in the Xi & Li 2021 benchmark (Cell Systems), in which "
        "DoubletFinder had the best detection accuracy; that benchmark concluded an "
        "appropriate choice of computational method is case by case. scDblFinder - often "
        "cited as a stronger caller, and not one of the nine methods that benchmark "
        "compared - is an R/Bioconductor method, and it IS available in this deployment "
        "as the separate analysis `doublet.scdblfinder`. On this repository's own "
        "ground-truth fixture it measured recall 0.964, precision 0.667 and AUPRC 0.858, "
        "against 0.673, 0.628 and 0.585 for this method under the same fixture, seed and "
        "estimator; two limits of that benchmark cap both methods, so the comparison "
        "supports a choice, not a ranking."
    ),
}


# ── param coercion ──────────────────────────────────────────────────────────────────
#
# ABSENT and UNPARSEABLE are different answers and must not collapse into one. A blank or
# missing param means "derive it" / "use the default", which is a legitimate instruction. A
# param that is PRESENT but cannot be read is a user who asked for something and did not get
# it — and silently substituting a default there is the worst failure this compute can have,
# because the run succeeds, the report faithfully records the value that was USED, and the
# provenance document then asserts a method nobody chose. `{"threshold": "0,3"}` (a European
# decimal comma) must not quietly become Scrublet's automatic threshold.
#
# So every coercer below REFUSES BY NAME on a present-but-unreadable value, and the bounds
# are re-checked here rather than trusted to the form: the compute is reachable by an
# agent/MCP call that never rendered it (the same reason the ceiling gate is compute-side).
def _absent(v):
    return v is None or (isinstance(v, str) and not v.strip())


def _refuse_param(key, value, expected):
    S.fail(
        f"the `{key}` parameter is {value!r}, which is not {expected}. It was PRESENT in "
        "params.json, so it is not treated as absent and no default is substituted — a run "
        "that silently ignored it would record the substituted value and the provenance "
        "report would then describe a method nobody chose. Fix the value or omit the key."
    )


def _int_or(params, key, default, *, lo=None, hi=None):
    v = params.get(key)
    if _absent(v):
        return default
    if isinstance(v, bool) or isinstance(v, (list, dict)):
        _refuse_param(key, v, "a whole number")
    try:
        f = float(v)
    except (TypeError, ValueError):
        _refuse_param(key, v, "a whole number")
    if not np.isfinite(f):
        _refuse_param(key, v, "a finite whole number")
    # A fractional value is REFUSED, not truncated. `int(30.9) == 30` would run a
    # 30-component PCA, record `n_prin_comps: 30`, and report it as though chosen — the same
    # silent substitution this whole boundary exists to eliminate. (It also made `seed:
    # "-0.5"` land on 0 while `seed: "-1"` was refused.)
    if f != int(f):
        _refuse_param(key, v, "a WHOLE number (it would otherwise be silently truncated)")
    n = int(f)
    if lo is not None and n < lo:
        _refuse_param(key, v, f"a whole number >= {lo}")
    if hi is not None and n > hi:
        _refuse_param(key, v, f"a whole number <= {hi}")
    return n


def _float_or(params, key, default, *, lo=None, hi=None):
    v = params.get(key)
    if _absent(v):
        return default
    if isinstance(v, bool) or isinstance(v, (list, dict)):
        _refuse_param(key, v, "a number")
    try:
        f = float(v)
    except (TypeError, ValueError):
        _refuse_param(key, v, "a number")
    if not np.isfinite(f):
        _refuse_param(key, v, "a finite number")
    if lo is not None and f < lo:
        _refuse_param(key, v, f"a number >= {lo}")
    if hi is not None and f > hi:
        _refuse_param(key, v, f"a number <= {hi}")
    return f


#: The spellings a boolean param may take. Anything else is a refusal, NOT `False` — a
#: truthiness fallback would turn `"t"` or `"TRUE!"` into `False` and silently invert a
#: `True` default (`mean_center`, `normalize_variance`), changing every score while the
#: report faithfully records the flipped value.
_TRUE_WORDS = ("1", "true", "yes", "on")
_FALSE_WORDS = ("0", "false", "no", "off")


def _bool_or(params, key, default):
    v = params.get(key)
    if _absent(v):
        return default
    if isinstance(v, bool):
        return v
    if isinstance(v, str):
        word = v.strip().lower()
        if word in _TRUE_WORDS:
            return True
        if word in _FALSE_WORDS:
            return False
        _refuse_param(key, v, f"a boolean ({'/'.join(_TRUE_WORDS + _FALSE_WORDS)})")
    if isinstance(v, (int, float)) and v in (0, 1):
        return bool(v)
    _refuse_param(key, v, "a boolean")


def _optional_float(params, key, *, lo=None, hi=None):
    """A param that is legitimately ABSENT (`expected_doublet_rate`, `threshold`): blank or
    missing means "derive it", not "zero" and not "unreadable".

    `0` is a genuine value and is returned as `0.0`; only a blank/missing key yields `None`.
    """
    v = params.get(key)
    if _absent(v):
        return None
    return _float_or(params, key, None, lo=lo, hi=hi)


def _resolve_label(params):
    """The output column PREFIX, validated as a NAME rather than accepted as a path fragment.

    It is interpolated into `metadata/<label>_score.zarr`, and `write_metadata_column` does
    `outputs_dir / rel_dir` with `mkdir(parents=True)` — so an unvalidated `../../x` would
    write outside `/outputs` and hand the ingest a manifest path that escapes the outputs
    root. The form's `not_in` check is a COLLISION guard, not a character guard, and the
    form is not the only caller.
    """
    # ABSENT => the default, and `null` counts as absent, exactly as it does for every other
    # param (`_absent`). Serializing an unset optional field as `null` is the ordinary shape
    # of an agent/MCP call, and this was the ONE param where that was a hard failure.
    # PRESENT-and-blank is still refused: `""` is a caller naming a column, badly.
    if "label" not in params or params.get("label") is None:
        return "doublet"
    raw = params.get("label")
    # A bool or a number is not a column name. Stringifying them would commit columns called
    # `False_score` / `0_score` from a caller that plainly meant something else.
    if isinstance(raw, bool) or not isinstance(raw, str):
        S.fail(
            f"the run's `label` is {raw!r}, which is not a string. It names the two "
            "cells-axis columns this run commits; pass a name, or omit the key for the "
            "default (`doublet`)."
        )
    # PRESENT-but-blank is refused rather than defaulted. The form's own message is "the run
    # refuses to invent one", and a caller that explicitly sent `label: ""` asked for
    # something that is not a column name — the same absent/unparseable distinction every
    # other param draws. An ABSENT key is the different, legitimate case handled above.
    if not raw.strip():
        S.fail(
            "the run's `label` is blank. It names the two cells-axis columns this run "
            "commits, and the run refuses to invent one — omit the key entirely to accept "
            "the default (`doublet`), or give it a name."
        )
    label = str(raw).strip()
    if not _LABEL_RE.match(label):
        S.fail(
            f"the run's `label` is {raw!r}, which is not a usable column name. It must start "
            "with a letter or digit and contain only letters, digits, `.`, `_` or `-` (at "
            "most 64 characters). The label names the two cells-axis columns this run "
            "commits AND the directories they are written to, so a value carrying `/` or "
            "`..` would write outside the outputs root."
        )
    return label


def _resolve_metric(params):
    raw = params.get("knn_dist_metric")
    if _absent(raw):
        return "euclidean"
    metric = str(raw).strip().lower()
    if metric not in SUPPORTED_METRICS:
        S.fail(
            f"`knn_dist_metric` is {raw!r}, which this analysis does not accept. Supported: "
            f"{', '.join(SUPPORTED_METRICS)}. Refused here, by name, rather than surfacing "
            "from inside the neighbour search as an unrelated-looking failure."
        )
    return metric


def resolve_expected_rate(n_cells, *, rate_per_1k, explicit):
    """`(rate, source)` for a scored population of `n_cells`.

    The auto branch is the 10x loading rule, clamped; the user branch is passed through
    verbatim so the report can say the run used what the user asked for. Scrublet's flat
    default is never reached. Bounds on the explicit value are enforced by the caller at
    parse time (`RATE_MIN_USER`/`RATE_MAX_USER`), not silently clamped here — a user's
    number is either honoured or refused, never quietly moved.
    """
    if explicit is not None:
        return float(explicit), "user"
    raw = float(rate_per_1k) * float(n_cells) / 1000.0
    return float(min(max(raw, RATE_FLOOR), RATE_CEILING)), "auto_10x_0.8pct_per_1k"


def _library_versions():
    """The resolved versions of every library whose behaviour this run depends on.

    Read from installed DISTRIBUTION metadata first (scanpy's `__version__` attribute is
    deprecated and emits a FutureWarning), falling back to the module attribute.
    """
    import importlib.metadata as _md

    dists = {"scanpy": "scanpy", "anndata": "anndata", "numpy": "numpy", "scipy": "scipy",
             "sklearn": "scikit-learn", "pandas": "pandas"}
    out = {}
    for mod, dist in dists.items():
        try:
            out[mod] = _md.version(dist)
            continue
        except Exception:
            pass
        try:
            out[mod] = getattr(__import__(mod), "__version__", None)
        except Exception:
            out[mod] = None
    return out


def _histogram(values, threshold=None, bins=HISTOGRAM_BINS):
    """The simulated-score distribution the readout renders.

    This is the plot a user reads to judge whether the distribution is BIMODAL — i.e.
    whether the automatic call is trustworthy at all — so it is emitted as data the view can
    render rather than as a matplotlib PNG from inside the sandbox (which would be an opaque
    blob the workbench could not interact with).

    Returns both encodings: `bin_edges`/`counts` (the compact arrays) and `rows` (one record
    per bin, which is what a declarative `table` widget can bind to; the core widget
    vocabulary ships no histogram kind, and a canvas series needs a columnar frame that a
    `shape: document` report slice is not). `above_threshold` marks which bins fall on the
    doublet side of the cut, which is the readout's stand-in for a cutline overlay.
    """
    arr = np.asarray(values, dtype=np.float64)
    finite = arr[np.isfinite(arr)]
    # The non-finite-threshold check runs BEFORE the empty-input early return. With the old
    # ordering an empty simulated-score vector returned early and the NaN threshold was
    # silently swallowed, while `batches[].threshold` still recorded it and the readout still
    # rendered it — a run whose two artifacts disagree about whether a cut exists. (An earlier
    # version of this comment said the old path left `above_threshold: null` on every row; it
    # did not — the early return emits no rows at all. The reorder is right; that reason was
    # not.)
    if threshold is not None and not np.isfinite(threshold):
        raise S.HistogramRefused(
            f"a non-finite doublet threshold ({threshold!r}) cannot define a cut, so the "
            "score distribution cannot be rendered against it")
    if finite.size == 0:
        return {"bin_edges": [], "counts": [], "rows": [], "n": 0,
                "range": None, "n_outside_unit_interval": 0}

    # THE RANGE IS THE DATA'S OWN, not a hardcoded [0, 1], and the threshold is forced
    # inside it. A fixed unit interval is fine on a dataset whose scores spread widely, but
    # on a low-signal one it puts EVERY score in the first of 40 bins — measured: a fixture
    # whose scores span [0.001, 0.022] with a threshold at 0.0077 collapsed entirely into
    # bin 0, so the one plot whose whole job is "is this bimodal?" showed a single bar and
    # could not answer it. Including the threshold guarantees the cut is always on the axis.
    # A non-finite threshold cannot define a cut. It is unreachable today (skimage returns a
    # finite value and `_optional_float` bounds an explicit one to [0,1]) but if it ever
    # arrives, leaving `cut = None` here would emit `above_threshold: null` on every row while
    # `batches[].threshold` still recorded the NaN — two artifacts of one run disagreeing.
    cut = float(threshold) if threshold is not None else None
    lo = float(finite.min())
    hi = float(finite.max())
    if cut is not None:
        lo, hi = min(lo, cut), max(hi, cut)
    # `hi > lo` is not enough: numpy refuses a span too narrow to cut into `bins` finite
    # pieces ("Too many bins for data range"), which a single-valued distribution with an
    # explicit threshold one ULP away produces. Widen to a span the bin count can carry.
    span = hi - lo
    if not np.isfinite(span) or span <= 0 or span < bins * 1e-12:
        pad = max(abs(hi), abs(lo), 1.0) * 1e-6 + bins * 1e-9
        lo, hi = lo - pad, hi + pad
    counts, edges = np.histogram(finite, bins=bins, range=(lo, hi))
    # The displayed precision is derived from the BIN WIDTH, not fixed. With the old (0,1)
    # range every bin was 0.025 wide and 4-6 dp was always safe; the width is now unbounded
    # below, and a fixed 6 dp made a narrow distribution render as 40 identical empty
    # intervals — on the one widget whose job is answering "is this bimodal?".
    width = (hi - lo) / max(1, bins)
    digits = 6 if width <= 0 else min(15, max(6, int(np.ceil(-np.log10(width))) + 3))
    # Values outside the UNIT interval are still counted separately: a score outside [0, 1]
    # is not a score, and a malformed prior is the way it happens. This is an honesty
    # counter, not a binning concern — the bins now cover the data by construction.
    n_outside = int(np.count_nonzero((finite < 0.0) | (finite > 1.0)))
    rows = []
    for i, c in enumerate(counts):
        blo, bhi = float(edges[i]), float(edges[i + 1])
        if cut is None:
            above, contains = None, None
        else:
            t = cut
            # A cell is a doublet iff `score > threshold` (scanpy `core.py`), so a bin is
            # entirely on the doublet side iff its LOW edge is already past the cut. The bin
            # that STRADDLES the cut is neither — it is flagged separately, because
            # collapsing it into "below" drew the readout's stand-in cutline up to a full
            # bin-width away from the real one. The LAST bin is right-inclusive (as
            # `np.histogram`'s is) so a threshold at the very top still lands in one bin.
            last = i == len(counts) - 1
            above = bool(blo > t)
            contains = bool(blo <= t <= bhi) if last else bool(blo <= t < bhi)
        rows.append({
            "bin": i,
            "bin_low": round(blo, digits),
            "bin_high": round(bhi, digits),
            "count": int(c),
            "above_threshold": above,
            "contains_threshold": contains,
        })
    return {"bin_edges": [float(e) for e in edges],
            "counts": [int(c) for c in counts], "rows": rows, "n": int(finite.size),
            "range": [lo, hi],
            "n_outside_unit_interval": n_outside}


class ScoringRefused(Exception):
    """A degenerate population Scrublet could not score. Carried out of the kernel so the
    caller can name the batch and turn it into the package's own refusal, instead of a
    library traceback reaching the user."""


# ── the scoring kernel: ONE population, scored on its own ───────────────────────────
def score_population(mat_csr, var_names, *, scrublet_params, label_for_errors):
    """Score ONE population of cells with Scrublet and return the per-cell result.

    `mat_csr` is that population's RAW counts (cells x genes). Returns
    `(scores, predicted, threshold, threshold_source, threshold_reason, sim_scores,
      n_dropped_by_method)` where `scores` is a float64 vector of length `mat_csr.shape[0]`
    carrying `NaN` for a cell scanpy's own wrapper dropped (it applies
    `filter_cells(min_genes=3)` internally), and `predicted` is a bool vector or `None` when
    no threshold could be determined.

    This function is the whole reason batching is trivially correct: it sees ONE population
    and nothing else, so a per-batch call cannot borrow information from another batch.
    """
    import anndata as ad
    import scanpy as sc
    import pandas as pd

    n = int(mat_csr.shape[0])
    adata = ad.AnnData(X=mat_csr)
    # Deterministic, collision-free obs names. scanpy's wrapper drops cells internally
    # (`filter_cells(min_genes=3)`) and then writes the scores back onto the original object,
    # so the names are what carry the result to the right rows. (The `.loc[adata.obs_names]`
    # realignment often cited for this is in scanpy's `batch_key` BRANCH, which this package
    # pins off — the non-batch branch assigns by pandas Series alignment instead.)
    adata.obs_names = [f"c{i}" for i in range(n)]
    adata.var_names = list(var_names)

    # A library failure is a NAMED refusal, never a raw traceback. Scrublet's internals can
    # legitimately give up on a degenerate population — every gene filtered out by its own
    # `filter_genes(min_cells=3)`, or fewer usable dimensions than the requested PCA rank —
    # and a user reading `ValueError: Found array with 0 feature(s)` learns nothing about
    # which of their samples was the problem or what to do about it.
    try:
        sc.pp.scrublet(adata, **scrublet_params)
    except Exception as exc:  # noqa: BLE001 — re-raised as a named refusal by the caller
        where = f" for {label_for_errors}" if label_for_errors else ""
        raise ScoringRefused(
            f"Scrublet could not score {n} cell(s){where}: {type(exc).__name__}: {exc}. "
            "This is a degenerate population rather than a bug: Scrublet drops genes "
            "detected in fewer than 3 cells and cells with fewer than 3 genes, then fits a "
            f"{scrublet_params.get('n_prin_comps')}-component PCA over what survives, so a "
            "population with too little variation (or too few genes after that filtering) "
            "has nothing left to embed. Levers: lower `n_prin_comps`, score a larger or "
            "more heterogeneous population, or — if this is one level of a batched run — "
            "merge or drop that level. No score is reported for these cells rather than a "
            "meaningless one."
        ) from exc

    scores = np.asarray(adata.obs["doublet_score"].values, dtype=np.float64)
    # `isfinite`, not `isnan`: an infinite score is neither a usable score nor a NaN, and
    # counting it with `isnan` while `n_evaluated`/`has_call` use `isfinite` would silently
    # break the per-batch identity `n_cells == n_evaluated + n_dropped_by_method` and leave
    # those cells as `not_evaluated` with nothing in the report explaining why.
    n_dropped = int((~np.isfinite(scores)).sum())

    uns = adata.uns.get("scrublet") or {}
    sim = np.asarray(uns.get("doublet_scores_sim", []), dtype=np.float64)

    if scrublet_params.get("threshold") is not None:
        threshold = float(scrublet_params["threshold"])
        source, reason = "user", None
    elif "threshold" in uns:
        threshold = float(uns["threshold"])
        source, reason = "automatic", None
    else:
        # scanpy reached here by writing `predicted_doublet = False` for EVERY cell. That is
        # the fabricated call this package refuses to ship.
        threshold, source = None, "undetermined"
        reason = (
            "Scrublet's automatic threshold is the minimum between the two modes of the "
            "simulated-score histogram, and no such minimum was found — the simulated "
            "distribution is not bimodal, so there is no honest cut point"
            + (f" for {label_for_errors}" if label_for_errors else "")
            + ". No call is reported for these cells; the doublet score is still emitted, "
            "and an explicit `threshold` parameter is the reachable lever."
        )

    if threshold is None:
        predicted = None
    else:
        predicted = np.zeros(n, dtype=bool)
        finite = np.isfinite(scores)
        predicted[finite] = scores[finite] > threshold

    return scores, predicted, threshold, source, reason, sim, n_dropped


def main():
    S.set_prefix("doublet.detect")
    inputs_dir, outputs_dir = S.io_dirs()
    p = S.params(inputs_dir)
    slots = S.load_inputs_index(inputs_dir)
    progress = S.progress

    label = _resolve_label(p)
    # `random_state` is handed to `sklearn.utils.check_random_state`, which refuses anything
    # outside [0, 2**32-1] with a message about seeds rather than about this analysis.
    seed = _int_or(p, "seed", 0, lo=0, hi=2**32 - 1)

    # EVERY parameter `sc.pp.scrublet` accepts, resolved here and passed explicitly below.
    #
    # BOUNDS ARE THE COMPUTE'S BELT TO THE FORM'S BRACES. `ui/doublet.yaml` constrains the
    # numeric fields, but the form is not the only caller: an agent/MCP launch reaches this
    # script having rendered nothing.
    #
    # WHAT EACH BOUND ACTUALLY PREVENTS, verified by substituting into Scrublet's score
    # formula (`ld = q*rho/r / (1 - rho - q*(1 - rho - rho/r))`, scanpy `_scrublet/core.py`)
    # and by running the failures. An earlier version of this comment asserted a set of
    # degeneracies that do NOT hold — "at >= 1 the denominator changes sign", "zero
    # denominator at q=0.5, r=2 when rho > 1", "r = 0 is inf", "rho = 0 gives an all-zero
    # column" — and presenting confident wrong reasons is worse than presenting none, because
    # it stops the next reader checking. What is actually true:
    #
    #   * `expected_doublet_rate = 0` raises ZeroDivisionError inside `core.py` BEFORE any
    #     score is assigned (it is `se_rho / rho`), so the run dies rather than emitting an
    #     all-zero column. Still worth refusing by name: a named refusal beats a library
    #     traceback re-labelled as a degenerate population.
    #   * `rho = 1` exactly makes numerator and denominator collapse to `q/r`, so EVERY cell
    #     scores exactly 1.0 — a uniform column that writes cleanly and reads as a result.
    #     The genuine pole is at a cell-specific `rho* = (1-q)/(1-q-q/r)`, which exceeds 1
    #     only for `q < r/(1+r)`; above that it sits at negative `rho`.
    #   * `rho < 0` gives negative scores. Measured: at the magnitudes a sign typo actually
    #     reaches (rho = -0.05, -0.1) EVERY cell scores negative; positives appear only far
    #     out (5/300 at rho = -0.5). An earlier version claimed "some cells still score
    #     positive" as though that were the near-zero behaviour; it is not.
    #   * `sim_doublet_ratio = 0` is unreachable as a division: PCA rejects the empty
    #     simulated set first (`Found array with 0 sample(s)`).
    #
    # So the bounds are kept and the reasons are now the measured ones.
    rate_per_1k = _float_or(p, "doublet_rate_per_1k", DEFAULT_RATE_PER_1K,
                            lo=RATE_PER_1K_MIN, hi=RATE_PER_1K_MAX)
    explicit_rate = _optional_float(p, "expected_doublet_rate",
                                    lo=RATE_MIN_USER, hi=RATE_MAX_USER)
    explicit_threshold = _optional_float(p, "threshold", lo=0.0, hi=1.0)
    n_prin_comps = _int_or(p, "n_prin_comps", 30, lo=1, hi=N_PRIN_COMPS_MAX)
    sim_doublet_ratio = _float_or(p, "sim_doublet_ratio", 2.0,
                                  lo=SIM_RATIO_MIN, hi=SIM_RATIO_MAX)
    stdev_doublet_rate = _float_or(p, "stdev_doublet_rate", 0.02, lo=0.0, hi=1.0)
    umi_subsampling = _float_or(p, "synthetic_doublet_umi_subsampling", 1.0,
                                lo=UMI_SUBSAMPLING_MIN, hi=1.0)
    knn_dist_metric = _resolve_metric(p)
    normalize_variance = _bool_or(p, "normalize_variance", True)
    log_transform = _bool_or(p, "log_transform", False)
    mean_center = _bool_or(p, "mean_center", True)
    n_neighbors = _int_or(p, "n_neighbors", None, lo=1)

    # ── the automatic-threshold backend, checked FAST, before a byte is read ─────────
    # scanpy computes Scrublet's automatic threshold with
    # `skimage.filters.threshold_minimum`. The env rootfs ships skimage (its build-time
    # smoke-import line names it), but a deployment that has not been republished may not —
    # so we refuse BY NAME rather than let a raw ImportError surface mid-run, and never
    # substitute a threshold.
    if explicit_threshold is None and S.import_threshold_backend() is None:
        S.fail(
            "an automatic doublet threshold requires `scikit-image` "
            "(`skimage.filters.threshold_minimum`), which is NOT available in this "
            "environment. The single-cell env rootfs ships it as a squidpy transitive and "
            "verifies it in the image's build-time smoke import, so a republished rootfs "
            "resolves this. Re-run with an explicit `threshold` parameter to get a call "
            "without automatic detection. Refused by name rather than crashing on a raw "
            "ImportError mid-run, and no threshold is fabricated."
        )

    # ── resolve the ONE matrix ──────────────────────────────────────────────────────
    progress("resolve", 2, "resolving inputs")
    matrix_paths = S.slot_paths(slots, MATRIX_SLOT)
    if not matrix_paths:
        S.fail(
            f"no input is bound to the required slot {MATRIX_SLOT!r}. "
            f"`/inputs/inputs.json` declares slot(s) {sorted(slots) or '[]'}; doublet.detect "
            "resolves by SLOT only — there is no filename fallback. It needs one RAW "
            "`single-cell/expression` count matrix."
        )
    if len(matrix_paths) > 1:
        S.fail(
            f"{len(matrix_paths)} matrices bound to {MATRIX_SLOT!r}, but doublet.detect is "
            "SINGULAR: it is an RNA-count method, and protein/ATAC doublets need dedicated "
            "methods entirely. Run it once per expression matrix."
        )
    matrix_path = matrix_paths[0]

    # ── CEILING GATE — before a byte of the MATRIX is read ──────────────────────────
    #
    # The batch column is read FIRST, deliberately. It is a 1-D column artifact (kilobytes),
    # not the matrix, so reading it costs nothing the gate is protecting against — and
    # without it the gate would size every term on the MERGED matrix even though each
    # Scrublet call sees ONE population. That made the gate systematically most hostile to
    # exactly the merged multi-sample matrices the per-sample split exists for: the epic's own
    # motivating case (5 x 10k cells) was refused outright, while the run it would actually
    # perform is five independent 10k-cell fits. The largest level is what has to fit.
    progress("preflight", 5, "checking the resource envelope")
    structure = S.read_matrix_structure(matrix_path, MATRIX_SLOT)
    declared_cells = int(structure["shape"][0])

    batch_path = S.slot_path(slots, BATCH_SLOT)
    batch_values = None
    batch_missing_level = None
    largest_population_cells = None
    if batch_path is not None:
        batch_values = S.read_column_values(batch_path, BATCH_SLOT)
        if len(batch_values) != declared_cells:
            S.fail(
                f"the `{BATCH_SLOT}` column has {len(batch_values)} values but the matrix "
                f"declares {declared_cells} cells — they are not the same cells axis"
            )
        batch_missing_level = S.column_missing_level(batch_path)
        sizes = {}
        for value in batch_values:
            sizes[str(value)] = sizes.get(str(value), 0) + 1
        largest_population_cells = max(sizes.values()) if sizes else None

    ceiling = S.ceiling_refuse_if_over(
        structure, sim_doublet_ratio=sim_doublet_ratio,
        largest_population_cells=largest_population_cells)

    # ── read the matrix ─────────────────────────────────────────────────────────────
    progress("read", 12, "reading the count matrix")
    mat = S.read_matrix_csc(matrix_path, structure)
    n_cells, n_genes = int(mat.shape[0]), int(mat.shape[1])

    # ── RAW integer-count gate: Scrublet normalizes internally, so a normalized or
    # scaled matrix silently produces meaningless scores. Refuse, never truncate. ─────
    progress("integer-gate", 16, "validating raw integer counts")
    data = np.asarray(mat.data)
    if data.size and not np.all(data == np.round(data)):
        bad = float(data[np.argmax(data != np.round(data))])
        S.fail(
            "the input matrix is NOT raw integer counts (found a non-integer stored value, "
            f"e.g. {bad!r}). Scrublet does its own total-count normalize, HVG selection and "
            "PCA internally, so a normalized or scaled matrix produces meaningless doublet "
            "scores. doublet.detect REFUSES it rather than scoring it. Feed the raw count "
            "matrix, not a `single-cell/normalized` one."
        )
    if data.size and float(data.min()) < 0:
        S.fail("the input matrix holds negative values; raw counts are non-negative")

    var_names = [f"g{j}" for j in range(n_genes)]
    mat_csr = mat.tocsr()

    warnings = []
    versions = _library_versions()
    scanpy_version = versions.get("scanpy") or ""
    scanpy_supported = any(scanpy_version.startswith(v) for v in SUPPORTED_SCANPY)
    if not scanpy_supported:
        warnings.append(
            f"scanpy {scanpy_version!r} is outside this package's validated set "
            f"{list(SUPPORTED_SCANPY)!r}; `sc.pp.scrublet`'s behaviour may have moved. Every "
            "parameter is passed explicitly, but the resolved version is recorded here so "
            "the change is visible rather than silent."
        )

    # ── the per-sample split — THE CORRECTNESS CORE ─────────────────────────────────
    #
    # A doublet is one GEM barcode that captured two cells, and cells from separately
    # captured libraries CANNOT co-occupy a droplet. Scoring a merged multi-sample matrix as
    # one population therefore fails twice, and both failures are invisible in the output:
    #
    #   1. WRONG NEIGHBOURHOOD. Simulated doublets are synthesized by summing pairs of
    #      OBSERVED cells. Merged, those pairs cross samples — inventing profiles no droplet
    #      could produce — and every real cell is then scored by its density among that
    #      fictional population.
    #   2. WRONG RATE PRIOR. The expected rate scales with cells loaded per lane. A merged
    #      5x10k matrix would derive 0.008 x 50,000/1,000 = 40%, which `RATE_CEILING` then
    #      clamps to 25% — still more than triple the ~8% a 10k lane actually carries, and
    #      clamped rather than corrected, so the number is wrong AND its wrongness is hidden.
    #
    # So the loop below is OURS, not `sc.pp.scrublet(batch_key=...)`. scanpy's own batch path
    # does score each batch separately, but it passes the SAME `expected_doublet_rate` to
    # every batch — exactly half the invariant, and the missing half is failure (2).
    #
    # DISCLOSURE, NOT INFERENCE. Nothing here inspects a column NAME to guess a batch key.
    # Both shapes are legitimate and the platform cannot tell them apart: one artifact per
    # sample (already per-sample; no batch column is CORRECT) and one merged multi-sample
    # artifact (where an unset batch column is a WRONG answer, not a different one). An
    # unbatched run is permitted and RECORDED as such, so it is never possible to obtain a
    # doublet call without the export saying whether it was batched.
    batch_column_name = str(p.get("batch_column") or "").strip() or None
    if batch_values is not None:
        if batch_column_name is None:
            batch_column_name = BATCH_SLOT
            warnings.append(
                "a batch column is bound but no `batch_column` name was passed, so the "
                "report and the exported methods paragraph cannot name it. The scoring is "
                "unaffected; the disclosure is weaker than it should be."
            )

    # ── the INLINE pre-filter, applied BEFORE the split ─────────────────────────────
    #
    # Best practice is to score the QC-FILTERED matrix — junk cells (empty-ish droplets,
    # dying cells) skew the simulated-doublet population and the kNN density. TxResBench
    # cannot express that directly, and the reason is architectural rather than an oversight:
    # `cell.filter` is NON-DESTRUCTIVE. It commits a per-cell keep-mask COLUMN and never
    # writes a filtered matrix, so there is no "QC-filtered matrix artifact" to consume. The
    # house answer already exists — `embedding.reduce` takes the same `criteria` recipe
    # `cell-filter`'s view emits and applies it itself at run time — and this is the same
    # thing.
    #
    # ORDER MATTERS: filter FIRST, then split. Filtering after the split would change each
    # batch's surviving cell count AFTER its rate prior had been derived, so the prior would
    # describe a population that no longer exists.
    progress("filter", 22, "applying the inline pre-filter")
    criteria = p.get("criteria")
    if not isinstance(criteria, list):
        criteria = []
    filter_obs = S.collect_filter_columns(slots, n_cells)
    if criteria:
        keep = np.asarray(CR.criteria_keep_mask(criteria, filter_obs, n_cells=n_cells),
                          dtype=bool)
    else:
        keep = np.ones(n_cells, dtype=bool)
    n_kept = int(keep.sum())
    # APPLIED means "a recipe ran", not "the recipe removed something". A filter that
    # excluded nothing still describes the method that ran, and reporting `applied: false`
    # beside a non-empty `criteria` list would let a methods paragraph state that no filter
    # ran when one did — the inverse of "never describe a laxer method than the one that
    # ran". `n_excluded` is the field that says whether anything was removed.
    filter_applied = bool(criteria)
    filter_excluded = n_kept != n_cells

    # Per-column honesty: for each criterion, the EXACT predicate applied and how many cells
    # it alone would keep. Built from the SAME recipe the mask ran on.
    filter_columns = []
    for c in criteria:
        if not isinstance(c, dict):
            continue
        col = c.get("column")
        is_cat = CR._is_categorical_criterion(c)
        one = np.asarray(CR.criteria_keep_mask([c], filter_obs, n_cells=n_cells), dtype=bool)
        # `criteria` is client-supplied JSON, so `column` can arrive as a list or a dict.
        # `col in filter_obs` on an unhashable value raises `TypeError: unhashable type` —
        # even against an empty dict — and the job would die on an uncaught traceback with
        # no diagnostic. The vendored kernel was hardened against exactly this input
        # (`_criteria.py`: "an unhashable one (a list) raised TypeError out of the COMMITTED
        # mask -- a hard job failure"); the report loop must not re-introduce it. The lookup
        # also uses the TRIMMED name, because that is the spelling `criteria_keep_mask`
        # matched on — comparing the untrimmed one would report `present: false` for a
        # criterion that actually applied.
        present = isinstance(col, str) and CR._trim_column(col) in filter_obs
        filter_columns.append({
            "column": col if isinstance(col, str) else None,
            "column_raw": None if isinstance(col, str) else repr(col),
            "kind": "categorical" if is_cat else "range",
            "predicate": ({"keep": c.get("keep")} if is_cat
                          else {"min": c.get("min"), "max": c.get("max")}),
            "present": present,
            "cells_kept_by_this_column": int(one.sum()),
        })

    if filter_applied and n_kept == 0:
        S.fail(
            f"the inline pre-filter excluded ALL {n_cells} cells, so there is nothing to "
            "score. Loosen the criteria; the run is refused rather than emitting a column "
            "in which every cell is `not_evaluated`."
        )

    # The populations are built over the KEPT cells only. Excluded cells never enter a
    # simulation, a PCA or a kNN graph — they are simply absent — and they come back at the
    # end as `NaN` score / `not_evaluated` call, in their ORIGINAL positions.
    kept_idx = np.nonzero(keep)[0].astype(np.int64)

    # ── the MISSING sample key, checked on the cells that will actually be scored ────
    if batch_values is not None:
        missing_idx = [i for i in kept_idx.tolist()
                       if S.is_missing_label(batch_values[i], batch_missing_level)]
        if missing_idx:
            seen = sorted({str(batch_values[i]).strip() or "<blank>" for i in missing_idx})
            spelled = ", ".join(repr(v) for v in seen[:5])
            if len(seen) > 5:
                spelled += f", and {len(seen) - 5} more"
            S.fail(
                f"{len(missing_idx)} of the {int(kept_idx.size)} cells being scored have no "
                "value in the bound sample/batch column"
                + (f" ({batch_column_name!r})" if batch_column_name else "")
                + f" — the value(s) seen: {spelled}. A missing sample key is not a sample: "
                "grouping those cells together would score cells from different captures as "
                "ONE population, with one pooled rate prior, which is exactly the error "
                "batching exists to prevent and which the report could not tell you had "
                "happened. Levers: fill the column, EXCLUDE the unassigned cells with the "
                "inline pre-filter (a criterion on this column keeping only the real sample "
                "names — this check runs on the cells that survive it), or run unbatched if "
                "this dataset really is a single capture. If one of the values above is a "
                "GENUINE sample name that merely looks like a null, rename it in the source "
                "column — this analysis refuses the ambiguity rather than resolving it by "
                "guessing, because guessing wrong here is silent."
            )

    kept_batch_values = ([batch_values[i] for i in kept_idx.tolist()]
                         if batch_values is not None else None)
    # ── a column this run commits must not collide with one bound on this run ───────
    #
    # PLACED HERE, before any Scrublet FIT. Not free — the CSC read and the inline pre-filter
    # have already run — but the fits are the expensive part, and the first version of this
    # sat after `progress("write", 78)` and burned every one of them before refusing.
    #
    # WHAT IT CAN AND CANNOT SEE, stated because the honest scope is narrow. The compute has
    # no view of the dataset's cells axis — it sees only what is BOUND on this run — so
    # `taken` holds the inline-filter columns and the batch column, and nothing else. It
    # therefore catches a collision only when the colliding column happens to be bound here.
    # The general case (a plain re-run with the same label, nothing else bound) is invisible
    # to it and is the FORM's job: `labelInput.require.not_in` reads `$data.obsSources`, which
    # is the whole axis.
    #
    # An earlier version of this comment claimed the opposite — "the form's braces catch the
    # obvious case, the compute's belt catches the real one" — which is inverted: the form
    # sees more here, not less. The form's own weakness is different and is documented at that
    # control: it tests the bare LABEL, while this analysis commits `<label>_score` and
    # `<label>_call`. Neither guard is complete, and the residual gap is reported rather than
    # papered over.
    committed = (f"{label}_score", f"{label}_call")
    taken = set(filter_obs)
    if batch_column_name:
        taken.add(batch_column_name)
    for name in committed:
        if name in taken:
            S.fail(
                f"a cells-axis column named {name!r} is bound to this run, and this run would "
                f"commit another one under that name (from `label: {label!r}`). Two columns "
                "with one name leave a reader keeping whichever came last, so the run is "
                "refused. Pick a different label."
            )

    populations = [(name, kept_idx[local])
                   for name, local in _populations(kept_batch_values, int(kept_idx.size))]
    batched = batch_values is not None
    for name, idx in populations:
        if idx.size < MIN_CELLS_PER_BATCH:
            where = (f"batch level {name!r} of column {batch_column_name!r}" if batched
                     else "this dataset")
            after = " (after the inline pre-filter)" if filter_applied else ""
            S.fail(
                f"{where} holds {idx.size} cell(s){after}, below the minimum of "
                f"{MIN_CELLS_PER_BATCH} that Scrublet can honestly score (it fits a "
                f"{n_prin_comps}-component PCA over the observed cells plus "
                f"{sim_doublet_ratio}x as many simulated doublets, and builds a kNN graph "
                "over their union). Refusing rather than returning a meaningless score or "
                "a silent NaN. Levers: merge this level into another, drop it with the "
                "inline pre-filter, or re-run unbatched if the dataset really is one "
                "capture."
            )

    scores = np.full(n_cells, np.nan, dtype=np.float64)
    predicted_full = np.zeros(n_cells, dtype=bool)
    has_call = np.zeros(n_cells, dtype=bool)   # a cell only gets a call from a level that
                                               # actually determined a threshold
    batch_records = []
    base_params = dict(
        # `batch_key` is ALWAYS None: the split is ours, and each call sees exactly one
        # population. That is what makes "no information crosses a batch boundary" a
        # property of the code rather than a claim about a library.
        batch_key=None,
        sim_doublet_ratio=sim_doublet_ratio,
        stdev_doublet_rate=stdev_doublet_rate,
        synthetic_doublet_umi_subsampling=umi_subsampling,
        knn_dist_metric=knn_dist_metric,
        normalize_variance=normalize_variance,
        log_transform=log_transform,
        mean_center=mean_center,
        n_prin_comps=n_prin_comps,
        use_approx_neighbors=False,   # exact sklearn kNN — annoy is approximate
        get_doublet_neighbor_parents=False,
        n_neighbors=n_neighbors,
        threshold=explicit_threshold,
        verbose=False,
        copy=False,
        random_state=seed,
    )
    for i, (name, idx) in enumerate(populations):
        pct = 30 + int(45 * i / max(1, len(populations)))
        shown = name if name is not None else "all cells"
        progress("score", pct, f"scoring {idx.size} cells ({shown})"
                               + (f" — batch {i + 1}/{len(populations)}" if batched else ""))
        # THE RATE PRIOR IS PER BATCH, derived from THAT batch's own cell count — never from
        # the merged total. This is the second face of the same invariant and is the half
        # scanpy's `batch_key` path gets wrong.
        rate, rate_source = resolve_expected_rate(
            idx.size, rate_per_1k=rate_per_1k, explicit=explicit_rate)
        sub_params = dict(base_params, expected_doublet_rate=rate)
        try:
            sub_scores, sub_pred, threshold, thr_source, thr_reason, sim, n_dropped = (
                score_population(mat_csr[idx], var_names, scrublet_params=sub_params,
                                 label_for_errors=(f"batch {name!r}" if name is not None
                                                   else None)))
        except ScoringRefused as exc:
            # `S.fail` exits, so the `return` is unreachable today — and it is here so that
            # it stays unreachable. Without it, the very next statement writes `sub_scores`,
            # which is still bound to the PREVIOUS iteration's array: if `fail` ever stopped
            # terminating (a monkeypatch, a wrapper swallowing SystemExit, a future
            # raise-and-catch), batch i would silently receive batch i-1's scores at batch
            # i's positions. That is cross-sample contamination presented as a result, which
            # is the one failure mode this whole file is organised against.
            S.fail(str(exc))
            return

        scores[idx] = sub_scores
        if sub_pred is not None:
            predicted_full[idx] = sub_pred
            # A cell can only be CALLED if its own level was scoreable AND thresholded.
            has_call[idx] = np.isfinite(sub_scores)

        n_evaluated = int(np.isfinite(sub_scores).sum())
        n_called = int(sub_pred.sum()) if sub_pred is not None else 0
        batch_records.append({
            "batch": name,
            # A displayable name for every row, including the unbatched one: `null` is the
            # honest VALUE, but a table cell showing nothing reads as missing data rather
            # than as "this run was one population".
            "batch_label": name if name is not None else "all cells (unbatched)",
            "n_cells": int(idx.size),
            "n_evaluated": n_evaluated,
            "n_dropped_by_method": n_dropped,
            "expected_doublet_rate": rate,
            "rate_source": rate_source,
            "doublet_rate_per_1k": rate_per_1k,
            "threshold": threshold,
            "threshold_source": thr_source,
            "threshold_reason": thr_reason,
            "n_called": n_called,
            # `None`, not 0.0: with nothing evaluated there is no basis to state a rate,
            # and "0% doublets" is a claim rather than an absence.
            "pct_called": (100.0 * n_called / n_evaluated) if n_evaluated else None,
            "n_simulated": int(sim.size),
            "sim_score_histogram": _safe_histogram(sim, threshold, name),
        })
        if n_dropped:
            warnings.append(
                f"{n_dropped} cell(s)"
                + (f" in batch {name!r}" if name is not None else "")
                + " were dropped by scanpy's own `filter_cells(min_genes=3)` inside the "
                "Scrublet wrapper and could not be scored; they carry a NaN score and no "
                "call, recorded rather than silently defaulted to singlet."
            )
        if thr_source == "undetermined":
            warnings.append(thr_reason)

    n_evaluated = int(np.isfinite(scores).sum())
    # No level determined a threshold => there is no honest call anywhere, so the call
    # artifact is omitted entirely (below). Some levels determined one => those cells are
    # called and the rest are `not_evaluated`, with the report saying which levels and why.
    predicted = predicted_full if has_call.any() else None

    # ── aligned_to: the source dataset's row-space digest, when available ────────────
    progress("write", 78, "writing the doublet columns")
    import pandas as pd

    # ── `aligned_to`: DECLARED when the axis keys are supplied, ABSENT otherwise ─────
    #
    # `structure.aligned_to` is what names the ROW SPACE these values belong to, and it can
    # only be derived from the cells-axis KEY artifact — a `single-cell/expression` CSC store
    # declares `axes`/`shape`/`nnz` and nothing that identifies its row space, so there is
    # nothing to inherit from the input the way `clustering` inherits it from an `embedding`.
    #
    # NO SHIPPED VIEW BINDS `cells_index`, here or in `embedding.reduce` (cell-filter's
    # picker for it was deliberately deleted as inert). So on a run launched from the form
    # this is ABSENT, and it is worth being exact about what that costs, because the
    # comfortable version of the sentence is false:
    #
    #   * the column IS still offered by the colour-by — `rowSpaceColumns.ts` drops only a
    #     column aligned to a DIFFERENT row space (A2) or provably disjoint from it (A4), and
    #     an undeclared alignment (A3) is neither; but
    #   * there is NO per-column mark saying so. `rowSpaceColumns.ts` records that "THE
    #     ALIGNMENT MARK IS RETIRED … The constant is DELETED", so the reader is not told the
    #     alignment was never declared.
    #
    # An agent/MCP launch that binds the slot gets the stronger declaration. That no
    # declarative view can supply an axis-key artifact today is a platform gap shared with
    # `embedding.reduce`, reported rather than worked around here.
    aligned_to = None
    cells_index_path = S.slot_path(slots, CELLS_INDEX_SLOT)
    if cells_index_path is not None:
        keys = S.read_column_values(cells_index_path, CELLS_INDEX_SLOT)
        if len(keys) != n_cells:
            S.fail(
                f"the `{CELLS_INDEX_SLOT}` artifact holds {len(keys)} keys but the matrix "
                f"declares {n_cells} cells — they are not the same cells axis"
            )
        aligned_to = txr_columns.axis_key_digest(pd.Series([str(k) for k in keys]))

    entries = []

    # The SCORE column — continuous, obs-aligned over ALL cells in input order, NaN where
    # the method could not score a cell.
    score_name = f"{label}_score"
    score_rel = f"metadata/{score_name}.zarr"
    score_structure, score_meta = txr_columns.write_metadata_column(
        outputs_dir, score_rel, score_name, pd.Series(scores, dtype="float64"),
        axis="cells", aligned_to=aligned_to)
    score_meta.update({"method": METHOD, "produced_by": "doublet.detect"})
    entries.append(S.output_entry(
        f"metadata-column:{score_name}", S.DT_METADATA_COLUMN, score_rel, "artifact",
        structure=score_structure, meta=score_meta))

    # The CALL column — CATEGORICAL, and emitted ONLY when a threshold was determined.
    # A bool would hard-code `levels: ["false","true"]` and could never carry the third
    # state; and an all-`singlet` column on an undetermined threshold would be a fabricated
    # answer, which is what the omission below refuses.
    call_name = f"{label}_call"
    call_levels = None
    if predicted is not None:
        calls, call_levels = _build_call_series(predicted, has_call)
        call_rel = f"metadata/{call_name}.zarr"
        call_structure, call_meta = txr_columns.write_metadata_column(
            outputs_dir, call_rel, call_name, pd.Series(calls),
            axis="cells", aligned_to=aligned_to)
        call_meta.update({"method": METHOD, "produced_by": "doublet.detect",
                          "levels_declared": call_levels})
        entries.append(S.output_entry(
            f"metadata-column:{call_name}", S.DT_METADATA_COLUMN, call_rel, "artifact",
            structure=call_structure, meta=call_meta))

    # ── the provenance report ───────────────────────────────────────────────────────
    progress("report", 94, "provenance report")
    determined = [b for b in batch_records if b["threshold_source"] != "undetermined"]
    report = {
        "kind": "doublet-report",
        "analysis": "doublet.detect",
        "method": METHOD,
        "citation": CITATION,
        "label": label,
        "n_cells": n_cells,
        "n_genes": n_genes,
        "n_evaluated": n_evaluated,
        "n_not_evaluated": n_cells - n_evaluated,
        "n_called": sum(b["n_called"] for b in determined),
        # Disclosure, not inference: an unbatched run is a legitimate state (a
        # one-artifact-per-sample project is already per-sample) and is RECORDED as such.
        # It is never possible to obtain a doublet call without the export saying whether it
        # was batched.
        # The inline pre-filter, per run: cells in, cells scored, cells excluded, and the
        # EXACT predicate applied per column. `applied: false` (with n_input == n_evaluated)
        # is the honest no-filter record, not an omission — the exported methods paragraph
        # must never describe a laxer method than the one that ran.
        "prefilter": {
            "applied": filter_applied,
            "excluded_any": filter_excluded,
            "n_input": n_cells,
            "n_kept": n_kept,
            "n_excluded": int(n_cells - n_kept),
            "criteria": criteria,        # the recipe the mask actually ran on
            "columns": filter_columns,   # per-column kind + exact predicate + kept count
        },
        "batched": batched,
        "batch_column": batch_column_name,
        "n_batches": len(batch_records),
        "batches": batch_records,
        # Two flat lookups the readout binds directly (the shipped `$data.report.x[$state.y]`
        # idiom): the batch names a picker offers, and that batch's simulated-score histogram
        # as ROWS a `table` widget can render. Derived from `batches` above, never a second
        # source of truth.
        "batch_names": [b["batch_label"] for b in batch_records],
        "histogram_by_batch": {b["batch_label"]: b["sim_score_histogram"]["rows"]
                               for b in batch_records},
        "threshold_by_batch": {b["batch_label"]: b["threshold"] for b in batch_records},
        # The x-axis is now per batch (the range is each batch's own data), so switching
        # batches in the readout's single table silently rescales the columns. The range is
        # surfaced beside the picker so the reader is told which axis they are looking at.
        "range_by_batch": {b["batch_label"]: b["sim_score_histogram"]["range"]
                           for b in batch_records},
        "call_emitted": predicted is not None,
        "call_column": call_name if predicted is not None else None,
        "call_levels": call_levels,
        "score_column": score_name,
        "n_called_cells_without_a_call": int(n_cells - int(has_call.sum())),
        # The RUN-level threshold state: `automatic`/`user` when every level resolved one,
        # `undetermined` when none did, `partial` when some levels did and others could not
        # (those levels' cells are `not_evaluated`, and `batches[].threshold_reason` says
        # which and why).
        "threshold_source": _run_threshold_source(batch_records),
        # every parameter ACTUALLY passed to `sc.pp.scrublet` — none left to a default.
        # `expected_doublet_rate` is deliberately absent here and present PER BATCH: it is
        # derived from each batch's own cell count, so a single run-level value would be a
        # fiction on any batched run.
        "parameters": {k: v for k, v in base_params.items() if k != "copy"},
        "parameters_resolved": {
            "label": label, "seed": seed,
            "doublet_rate_per_1k": rate_per_1k,
            "expected_doublet_rate": explicit_rate,
            "rate_source": "user" if explicit_rate is not None else "auto_10x_0.8pct_per_1k",
            "rate_floor": RATE_FLOOR, "rate_ceiling": RATE_CEILING,
            "min_cells_per_batch": MIN_CELLS_PER_BATCH,
        },
        # Knobs the standalone Scrublet class exposes but scanpy's wrapper does NOT: they
        # are recorded at the values scanpy fixes internally, rather than offered as
        # parameters this package could not honour.
        "fixed_by_scanpy": {
            "filter_genes_min_cells": 3,
            "filter_cells_min_genes": 3,
            # Recorded with the values the DESIGN asked to pass explicitly, so a reader can
            # see what the shipped run used instead of them rather than only being told the
            # knobs do not exist. scanpy's wrapper selects HVGs with its own defaults, so
            # there is no percentile to report — `null` is the honest value, not 85.
            "min_counts": None,
            "min_cells": None,
            "min_gene_variability_pctl": None,
            "highly_variable_genes": "scanpy defaults, on a log1p layer of the normalized counts",
            # TWO calls, different targets. The FIRST (`normalize_total(ad_obs)`, no
            # target_sum => median of nonzero counts) is the one that feeds the HVG selection
            # recorded above, i.e. it decides WHICH GENES are scored; the later pair
            # normalizes observed and simulated to 1e6 before the PCA. Recording only the
            # second hid the one that matters more.
            "normalize_total_target_sum_hvg": None,
            "normalize_total_target_sum_pca": 1e6,
            "note": (
                "`sc.pp.scrublet` does not expose the standalone Scrublet class's "
                "`min_counts`, `min_cells` or `min_gene_variability_pctl`; it applies its "
                "own filtering and HVG step with the values above. They are recorded here "
                "rather than presented as parameters this package can set."
            ),
        },
        "library_versions": versions,
        "scanpy_version": scanpy_version,
        "scanpy_supported": scanpy_supported,
        "scanpy_supported_set": list(SUPPORTED_SCANPY),
        "thread_pins": S.resolved_thread_env(),
        "ceiling": ceiling,
        "disclosure": dict(DISCLOSURE, batching=(
            f"Doublet scoring ran independently within each of the {len(batch_records)} "
            f"levels of `{batch_column_name}`, each with its own simulated-doublet "
            "population, its own PCA and its own expected-rate prior derived from that "
            "sample's own cell count." if batched else
            "This run was NOT batched: every cell was scored as one population. That is "
            "correct if this dataset is a single capture (the common shape — samples arrive "
            "as separate datasets and are joined later). If it is a MERGED multi-sample "
            "matrix, the result is not trustworthy: simulated doublets crossed sample "
            "boundaries, inventing profiles no droplet could produce, and the expected-rate "
            "prior was derived from the merged total rather than per lane. Re-run with the "
            "sample column bound."
        )),
        "warnings": warnings,
    }
    (outputs_dir / "doublet-report.json").write_text(json.dumps(report, indent=2))
    entries.append(S.output_entry(
        "doublet-report", S.DT_REPORT_QC, "doublet-report.json", "artifact",
        structure=txr_columns.opaque("application/json"),
        meta={"kind": "doublet-report", "n_cells": n_cells,
              "n_called": report["n_called"], "batched": report["batched"],
              "call_emitted": report["call_emitted"]}))

    S.write_manifest(outputs_dir, entries)
    called = report["n_called"] if report["call_emitted"] else "no call (threshold undetermined)"
    progress("done", 100, f"{n_cells} cells scored; {called}")
    print(f"doublet.detect: {n_cells} cells x {n_genes} genes -> {score_name}"
          + (f" + {call_name} ({report['n_called']} called)" if report["call_emitted"]
             else " (call omitted — no threshold determined)"),
          file=__import__("sys").stderr)


def _safe_histogram(values, threshold, batch_name):
    """`_histogram`, with its refusal converted into the package's named one.

    `_histogram` is called from inside the per-population loop, OUTSIDE the `try` that
    catches `ScoringRefused`, and `main()` is invoked bare — so an escaping exception here
    reaches the user as a raw traceback, contradicting this file's own "every stage is a
    named refusal" contract. Nothing has been written at this point, so a refusal leaves no
    partial output.
    """
    try:
        return _histogram(values, threshold)
    except S.HistogramRefused as exc:
        where = f" for batch {batch_name!r}" if batch_name is not None else ""
        S.fail(f"{exc}{where}.")
        return None   # unreachable while `S.fail` exits; here so it stays unreachable, for
                      # the same reason as the `return` after the ScoringRefused handler
    except Exception as exc:  # noqa: BLE001
        # A non-`HistogramRefused` escape is as much a raw traceback as the one this wrapper
        # exists to stop — `np.asarray(values, dtype=float64)` on a non-numeric input raises
        # ValueError, `np.isfinite` on a non-numeric threshold raises TypeError. Both are
        # "unreachable today" in exactly the sense the guarded one was.
        where = f" for batch {batch_name!r}" if batch_name is not None else ""
        S.fail(
            f"the simulated-score distribution could not be built{where}: "
            f"{type(exc).__name__}: {exc}. The scores themselves are unaffected; this is the "
            "report's histogram, so the failure is named rather than raised."
        )
        return None


def _run_threshold_source(batch_records):
    """The RUN-level threshold state, which is not always one of the per-level states.

    `partial` is a real outcome on a batched run and must be nameable: some levels resolved
    a threshold and others did not, so some cells are called and others are honestly
    `not_evaluated`. Collapsing that to either `automatic` or `undetermined` would hide
    which half the reader is looking at.
    """
    sources = {b["threshold_source"] for b in batch_records}
    if len(sources) == 1:
        return next(iter(sources))
    # More than one state can only mean SOME levels resolved a threshold and others did not:
    # an explicit `threshold` makes every level `user`, and otherwise every level is
    # `automatic` or `undetermined`. So there is no third mixed case to name, and inventing
    # one would be a state no run can reach.
    return "partial"


def _populations(batch_values, n_cells):
    """`[(level_name, positions), ...]` — the populations that are scored INDEPENDENTLY.

    Unbatched (`batch_values is None`) is ONE population named `None`, which is the honest
    record of "this dataset was treated as a single capture", not a missing value.

    Batched levels are visited in SORTED order and each level's positions are kept in
    ASCENDING input order, so the result is a pure function of the column's CONTENT: two
    runs whose batch labels are permuted (`A`/`B` renamed, or the levels encountered in a
    different order) score every cell identically. Scoring order must not be able to reach
    a score.
    """
    if batch_values is None:
        return [(None, np.arange(n_cells, dtype=np.int64))]
    values = np.asarray([str(v) for v in batch_values], dtype=object)
    out = []
    for level in sorted({str(v) for v in values}):
        out.append((level, np.nonzero(values == level)[0].astype(np.int64)))
    return out


def _build_call_series(predicted, has_call):
    """The categorical call column and its DECLARED level set.

    `has_call` is the cells whose own population was BOTH scoreable and thresholded; every
    other cell is `not_evaluated`. That third level is included ONLY when some cell actually
    lacks a call, so a run where every cell was scored and called declares exactly two
    levels — the third state is never declared speculatively.

    A bool column could not carry this: `write_metadata_column`'s bool branch hard-codes
    `levels: ["false","true"]`, so `False` would mean both "singlet" and "we never looked" —
    the exact conflation `de/result` refuses when it omits `padj` rather than filling it
    with 1.
    """
    import pandas as pd

    values = np.where(predicted, LEVEL_DOUBLET, LEVEL_SINGLET).astype(object)
    values[~has_call] = LEVEL_NOT_EVALUATED
    levels = [LEVEL_SINGLET, LEVEL_DOUBLET]
    if not has_call.all():
        levels = levels + [LEVEL_NOT_EVALUATED]
    return pd.Categorical(list(values), categories=levels, ordered=False), levels


if __name__ == "__main__":
    main()
