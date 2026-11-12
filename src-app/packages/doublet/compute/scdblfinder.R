#!/usr/bin/env Rscript
# doublet.scdblfinder — the R/Bioconductor doublet caller, as a SECOND declared method
# beside `doublet.detect`'s Scrublet (#195 / E7, epic #169).
#
# ── WHAT THIS IS, AND WHY IT IS A SECOND ANALYSIS RATHER THAN A PARAMETER ───────────
# The owner's ruling: a user searching for "doublet" finds three analyses and picks by
# METHOD. That shape is also forced, and the reason is technical rather than aesthetic:
# `run.runtime` is a SINGLE SCALAR PER ANALYSIS (`Language::from_runtime`) and `run.entry`
# a single path, so one analysis id cannot dispatch to both a `.py` and an `.R` entry —
# the dispatch has no branch to take (E7/DEC-1).
#
# THE OUTPUT KINDS ARE IDENTICAL to `doublet.detect`'s — a continuous per-cell score
# `metadata-column`, a CATEGORICAL per-cell call `metadata-column`, and a `report/qc` —
# which is the property that makes the three-analysis shape work: `cell.filter`, the
# report and colour-by consume either method's output unchanged. That identity is not
# asserted here; it is pinned by `tests/test_scdblfinder_end_to_end.py`, which reads both
# methods' manifests and compares the kinds and the column shapes.
#
# ── WHAT IT INHERITS FROM THE PYTHON LANE, DELIBERATELY ─────────────────────────────
#   * NON-DESTRUCTIVE. It annotates; it never filters and never emits a subset matrix.
#     Removing cells is `cell.filter`'s job. `04-pipeline-steps.md` §7: "flag, then
#     inspect — do NOT blindly delete high-scoring cells."
#   * RAW COUNTS ONLY, re-checked from the stored values rather than trusted from the
#     form, because an agent/MCP call reaches this compute without rendering a form.
#   * PER-SAMPLE SCORING OWNED BY THIS FILE, not delegated to `scDblFinder(samples=)`.
#     Each level gets its own `SingleCellExperiment`, and therefore its own expected
#     doublet rate derived from THAT level's own recovered-cell count — cells from
#     separately captured libraries cannot share a droplet. An unbatched run is permitted
#     and the report RECORDS which of the two it was, rather than leaving a reader to
#     infer it.
#   * A NAMED REFUSAL rather than a substituted default: a level too small to score
#     honestly, a normalized matrix, an out-of-range parameter.
#   * THE SCORE COLUMN IS FULL-LENGTH IN INPUT ORDER, with `NaN` where a cell was not
#     scored, and the CALL column carries the third level `not_evaluated` — declared only
#     on a run that actually produced one.
#
# ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────────────
#   * NO INLINE PRE-FILTER. `doublet.detect` accepts `cell-filter`'s `criteria` recipe
#     through a byte-for-byte vendored `_criteria.py`. That kernel is PYTHON, and porting
#     a predicate language to R is a second library-sized commitment this item did not
#     scope; a `criteria` parameter that silently did nothing would be worse than its
#     absence. It is REFUSED BY NAME if passed, so the gap is loud rather than silent.
#   * NO `run.dependencies`. See the manifest, beside the key it governs.
#
# ── THE COMPUTE CONTRACT, IN R ──────────────────────────────────────────────────────
# Identical to every python entry's, because it is language-NEUTRAL:
#     read   <inputs>/inputs.json, <inputs>/params.json, and the staged artifacts
#     write  <outputs>/metadata/<label>_{score,call}.zarr, <outputs>/scdblfinder-report.json
#     write  <outputs>/manifest.json  LAST, and only after the artifacts exist
# Roots are `/inputs` and `/outputs`, overridable via TXR_INPUTS_DIR / TXR_OUTPUTS_DIR
# exactly as the python entries are, which is what lets the off-sandbox harness drive the
# REAL entry rather than a stand-in.

suppressPackageStartupMessages({
  library(jsonlite)
  library(Matrix)
  library(digest)
})

# `run.helpers` are staged by BASENAME into `/code` beside the entry, and the sandbox's
# working directory is not `/code`, so the helper is resolved against THIS FILE's own
# directory rather than against the cwd.
.script_dir <- function() {
  a <- commandArgs(FALSE)
  f <- sub("^--file=", "", a[grep("^--file=", a)])
  if (length(f)) dirname(normalizePath(f[1])) else "."
}
source(file.path(.script_dir(), "_wire.R"))

ANALYSIS <- "doublet.scdblfinder"
METHOD <- "scdblfinder"
CITATION <- paste0("Germain, Lun, Garcia Meixide, Macnair & Robinson 2021, ",
                   "F1000Research (scDblFinder)")

# ── THE SLOT CONSTANTS ARE SPELLED WITH `=`, NOT `<-`, AND THAT IS LOAD-BEARING ────
# The workbench reads a compute's slot vocabulary straight out of this source
# (`computeSlotVocabulary`) and cross-checks it against the view spec, so a view that
# binds a slot the compute does not have goes red. Its reader matches
# `NAME_SLOT = "value"`; R's idiomatic `<-` is invisible to it, and the vocabulary came
# back EMPTY — which its own vacuity guard caught, exactly as designed. `=` is legal R
# assignment at top level and keeps the fix in this package, where widening the reader
# would have meant editing `src-app/ui/` for a package's convenience.
MATRIX_SLOT = "matrix"
#: The per-sample column. A `metadata-column` store keeps its values under the constant
#: member `values` and CANNOT carry its own name, so the chosen column is bound as an
#: input SLOT and its display NAME travels separately as the `batch_column` param.
#: `inputs` and `params` are separate channels and must stay so.
BATCH_SLOT = "batch"
CELLS_INDEX_SLOT = "cells_index"

LEVEL_SINGLET <- "singlet"
LEVEL_DOUBLET <- "doublet"
LEVEL_NOT_EVALUATED <- "not_evaluated"

#: The smallest population this method can score honestly. `scDblFinder` builds artificial
#: doublets, runs a `dims`-component PCA over the union and fits a classifier; a handful of
#: cells yields a crash or a meaningless score. Held at the SAME value as the python lane
#: so "too small to score" means one thing across both methods, and so the two are
#: comparable on the same fixture — which is the whole point of shipping both.
MIN_CELLS_PER_BATCH <- 30L

#: The 10x Chromium multiplet rate per 1,000 recovered cells — `scDblFinder`'s own
#: `dbr.per1k` default, and the same figure `doublet.detect` uses. 0.004 for an HT chip.
DOUBLET_RATE_PER_1K <- 0.008

#: What the library FIXES INTERNALLY and this entry does not control. Recorded rather
#: than faked: the shipped python lane's DEC-3 discipline is that a parameter we do not
#: actually pass is disclosed as the library's, never re-described as ours.
FIXED_BY_SCDBLFINDER <- list(
  removeUnidentifiable = TRUE,
  aggregateFeatures = FALSE,
  clustCor = "NULL (no cluster-correlation feature)",
  artificialDoublets = "NULL (the library sizes the artificial set from the input)",
  knownUse = "discard",
  metric = "logloss",
  nrounds = 0.25,
  max_depth = 4L,
  iter = 3L,
  k = "NULL (the library derives its kNN k from the cell count)",
  unident.th = "NULL",
  # Found by `test_every_scdblfinder_formal_is_passed_explicitly_or_declared_fixed`,
  # which reads `formals(scDblFinder)` off the INSTALLED package rather than a list in
  # this file — so an unaccounted knob is a failure rather than an omission nobody
  # notices. This one was genuinely unaccounted for until that test said so.
  trainingFeatures = "NULL (the library derives its classifier features from the artificial-doublet set it builds; this entry supplies no pre-trained feature set)",
  processing = "default",
  multiSampleMode = "not reached — this entry runs ONE sample per call, by design",
  threshold = TRUE,
  BPPARAM = "SerialParam — ONE worker, pinned by the env recipe (INV-6)"
)

DISCLOSURE <- list(
  homotypic = paste0(
    "Homotypic doublets — two cells of the same type — are largely undetectable by any ",
    "simulation-based caller, scDblFinder included: summing two cells of one type ",
    "produces a profile that looks like one more deeply sequenced cell of that type. ",
    "The reported rate is therefore a floor, not an estimate of the true rate."),
  method_tradeoff = paste0(
    "scDblFinder is an R/Bioconductor method. It is NOT one of the nine methods Xi & Li ",
    "2021 (Cell Systems) compared — DoubletFinder had the best detection accuracy in ",
    "that benchmark, and this repository's own research notes previously misattributed ",
    "it; the correction is recorded rather than quietly applied. Choosing between this ",
    "method and Scrublet on published rankings alone is therefore not supported by that ",
    "benchmark. What IS available is a like-for-like measurement on this repository's ",
    "own ground-truth fixture: see `measured_performance` in this report."),
  not_a_filter = paste0(
    "Calls are FLAGS for inspection, not removals: the matrix was not modified and no ",
    "cells were deleted. Removing cells is the downstream Cell-filter analysis."))

# ── the ONE parameter grammar ───────────────────────────────────────────────────────
#
# Every parameter is pulled through these, so there is no second place that decides what
# a missing, non-numeric or out-of-range value means. A parameter that silently defaults
# makes the emitted value unattributable to the request.

PARAMS <- list()

fail <- function(msg) {
  cat(sprintf("%s: %s\n", ANALYSIS, msg), file = stderr())
  quit(status = 2L, save = "no")
}

progress <- function(phase, pct = NULL, message = NULL) {
  parts <- c(phase, if (!is.null(pct)) as.character(as.integer(pct)),
             if (!is.null(message)) message)
  cat(sprintf("progress: %s\n", paste(parts, collapse = "|")), file = stderr())
}

absent <- function(v) is.null(v) || (length(v) == 1L && is.na(v)) ||
  (is.character(v) && length(v) == 1L && !nzchar(trimws(v)))

num_param <- function(name, default, lo = NULL, hi = NULL) {
  v <- PARAMS[[name]]
  if (absent(v)) return(default)
  n <- tryCatch(suppressWarnings(as.numeric(v)), error = function(e) NA_real_)
  if (length(n) != 1L || is.na(n) || !is.finite(n)) {
    fail(sprintf("parameter `%s` is not a single finite number (got %s). Refusing rather than defaulting.",
                 name, paste(format(v), collapse = ",")))
  }
  if (!is.null(lo) && n < lo) fail(sprintf("parameter `%s` must be >= %s (got %s).", name, format(lo), format(n)))
  if (!is.null(hi) && n > hi) fail(sprintf("parameter `%s` must be <= %s (got %s).", name, format(hi), format(n)))
  n
}

#' An INTEGER parameter validated as one BEFORE it is narrowed — narrowing first turns an
#' out-of-range value into `NA` with only a warning, and a fractional value is silently
#' truncated (the #194 lesson, inherited).
int_param <- function(name, default, lo = NULL, hi = NULL) {
  n <- num_param(name, default, lo, hi)
  if (n != trunc(n)) fail(sprintf("parameter `%s` must be a whole number (got %s).", name, format(n)))
  if (abs(n) > .Machine$integer.max) {
    fail(sprintf(paste0("parameter `%s` (%s) is outside R's integer range (+/-%s). The host ",
                        "carries it as a 64-bit integer; R cannot."),
                 name, format(n, scientific = FALSE), format(.Machine$integer.max)))
  }
  as.integer(n)
}

str_param <- function(name, default, allowed = NULL) {
  v <- PARAMS[[name]]
  if (absent(v)) return(default)
  s <- trimws(as.character(v)[1])
  if (!is.null(allowed) && !(s %in% allowed)) {
    fail(sprintf("parameter `%s` must be one of %s (got %s).",
                 name, paste(allowed, collapse = ", "), s))
  }
  s
}

#' The characters an output `label` may contain. It is interpolated into an output PATH
#' (`metadata/<label>_score.zarr`), so `../` or `/` would write outside `/outputs` and put
#' a manifest path that escapes the outputs root in front of the ingest.
#' The seed for level `i`, wrapped into R's integer range rather than allowed to overflow.
#' `seed + i - 1L` is integer arithmetic; at `seed = .Machine$integer.max` and two or more
#' levels it silently becomes `NA` and `set.seed(NA)` aborts with a raw R message.
level_seed <- function(seed, i) {
  # THE IDENTITY IN THE ORDINARY CASE. The first cut of this helper folded every seed
  # through a modulus, so `seed = 0, i = 1` became -1073741823 instead of 0 — it "fixed"
  # an overflow that only occurs at the very top of the range by silently reseeding EVERY
  # run. The full doublet suite caught it immediately and specifically: the recorded
  # measurement moved (recall 0.964 -> 0.970), the like-for-like comparison against
  # Scrublet's precision inverted, and a small fixture stopped calling any doublets. A
  # correctness fix that changes the numbers is not a correctness fix.
  v <- as.double(seed) + (i - 1)
  # 4294967295, NOT 4294967296. Subtracting 2^32 maps `2147483648` to `-2147483648`, which
  # R cannot hold — it reserves `INT_MIN` as `NA_integer_` — so the wrap landed back on the
  # exact failure it exists to prevent: `as.integer()` returned `NA` and `set.seed(NA)`
  # aborted the run, from OUTSIDE the tryCatch. Measured at `seed = 2147483647, i = 2`
  # before this line was corrected. Subtracting 2^32-1 lands on `-2147483647`, the smallest
  # value R actually has.
  if (v > .Machine$integer.max) v <- v - 4294967295
  as.integer(v)
}

check_label <- function(label) {
  if (!grepl("^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$", label)) {
    fail(sprintf(paste0("`label` must be 1-64 characters of letters, digits, `.`, `_` or ",
                        "`-`, starting alphanumeric (got %s). It is interpolated into an ",
                        "output path."), label))
  }
  label
}

# ── the scoring core ────────────────────────────────────────────────────────────────

#' Score ONE population. Returns `list(score, class, dbr, n, threshold)`.
#'
#' EVERY wrapper-accepted parameter this entry controls is passed EXPLICITLY (INV-6),
#' including the ones whose value equals the library default — the point of the
#' discipline is that the RUN is reproducible from the recorded request, not that the
#' call site is short. What the library fixes internally is in `FIXED_BY_SCDBLFINDER`
#' above and is reported as the library's, not re-described as ours.
score_population <- function(counts_cg, opts, seed) {
  # `scDblFinder` takes a SingleCellExperiment of GENES x CELLS; this app's stores are
  # CELLS x GENES. The transpose is explicit and happens once, here, rather than being
  # guessed at by the reader.
  sce <- SingleCellExperiment::SingleCellExperiment(
    list(counts = Matrix::t(counts_cg)))
  set.seed(seed)
  res <- tryCatch(
    scDblFinder::scDblFinder(
      sce,
      clusters = opts$clusters,
      samples = NULL,           # ONE population per call — the loop is ours (E7/DEC-4)
      knownDoublets = opts$known_doublets,
      dbr = opts$dbr,
      dbr.sd = opts$dbr_sd,
      dbr.per1k = opts$dbr_per1k,
      nfeatures = opts$nfeatures,
      dims = opts$dims,
      includePCs = opts$include_pcs,
      propRandom = opts$prop_random,
      propMarkers = opts$prop_markers,
      score = opts$score,
      returnType = "sce",
      verbose = FALSE,
      BPPARAM = BiocParallel::SerialParam(progressbar = FALSE)
    ),
    error = function(e) e
  )
  if (inherits(res, "error")) {
    return(list(error = conditionMessage(res)))
  }
  cd <- SummarizedExperiment::colData(res)
  cls <- as.character(cd$scDblFinder.class)
  list(
    score = as.double(cd$scDblFinder.score),
    class = cls,
    n = ncol(res),
    # THE LIBRARY'S OWN CUT POINT, read from where it publishes it. The first cut of this
    # file RECONSTRUCTED a midpoint from the called scores instead, which was wrong twice:
    # it is not the library's number, and it is `NA` on every run that called no doublets
    # — so the per-sample table rendered "NA" for a threshold the library had in fact
    # chosen (measured: 0.5822614 while this reported NA). A recorded value a reader
    # cannot reproduce the call from is worse than an absent one.
    threshold = {
      md <- S4Vectors::metadata(res)$scDblFinder.threshold
      if (is.null(md) || !length(md)) NA_real_ else as.double(md[[1]])
    }
  )
}

# ── main ────────────────────────────────────────────────────────────────────────────

main <- function() {
  inputs_dir <- Sys.getenv("TXR_INPUTS_DIR", unset = "/inputs")
  outputs_dir <- Sys.getenv("TXR_OUTPUTS_DIR", unset = "/outputs")
  dir.create(outputs_dir, recursive = TRUE, showWarnings = FALSE)

  PARAMS <<- read_params(inputs_dir)
  slots <- read_inputs_index(inputs_dir)

  if (!absent(PARAMS[["criteria"]])) {
    fail(paste0("this method does not accept an inline pre-filter (`criteria`). That ",
                "recipe is `cell-filter`'s predicate kernel, which is a PYTHON helper ",
                "this R entry cannot stage; accepting the parameter and ignoring it would ",
                "describe a filter that never ran. Run `cell.filter` first, or use ",
                "`doublet.detect`, which vendors the kernel."))
  }

  label <- check_label(str_param("label", "doublet"))
  # Bounded to R's integer range, which is `int_param`'s own check restated at the point of
  # use. It does NOT reserve headroom for the per-level offset, and an earlier version of
  # this comment claimed it did — `level_seed()` handles the top of the range by wrapping,
  # which is where that concern belongs, and describing a subtraction this line does not
  # perform is the kind of comment that survives the code it described.
  seed <- int_param("seed", 0L, lo = -.Machine$integer.max, hi = .Machine$integer.max)
  dbr_per1k <- num_param("doublet_rate_per_1k", DOUBLET_RATE_PER_1K, lo = 1e-6, hi = 1)
  # `expected_doublet_rate` is a PROBABILITY: strictly inside (0, 1). A user's number is
  # honoured or refused, never quietly clamped.
  dbr <- if (absent(PARAMS[["expected_doublet_rate"]])) NULL else
    num_param("expected_doublet_rate", NULL, lo = 1e-6, hi = 0.999999)
  dbr_sd <- if (absent(PARAMS[["doublet_rate_sd"]])) NULL else
    num_param("doublet_rate_sd", NULL, lo = 0, hi = 1)
  opts <- list(
    clusters = NULL,
    known_doublets = NULL,
    dbr = dbr,
    dbr_sd = dbr_sd,
    dbr_per1k = dbr_per1k,
    nfeatures = int_param("nfeatures", 1352L, lo = 2L),
    dims = int_param("dims", 20L, lo = 2L),
    include_pcs = int_param("include_pcs", 19L, lo = 0L),
    prop_random = num_param("prop_random", 0, lo = 0, hi = 1),
    prop_markers = num_param("prop_markers", 0, lo = 0, hi = 1),
    score = str_param("score", "xgb", c("xgb", "weighted", "ratio"))
  )
  batch_column_name <- str_param("batch_column", NULL)

  # ── the matrix ────────────────────────────────────────────────────────────────
  progress("read", 5, "reading the count matrix")
  matrix_path <- slots[[MATRIX_SLOT]]
  if (is.null(matrix_path) || !dir.exists(matrix_path)) {
    fail(sprintf("no `%s` input was staged; this analysis needs one raw-count matrix.",
                 MATRIX_SLOT))
  }
  st <- read_store_structure(matrix_path)
  if (!identical(st$encoding, "zarr_v3") || !identical(st$kind, "sparse_csc")) {
    fail(sprintf("the `%s` artifact declares encoding=%s kind=%s; this analysis reads a sparse CSC store.",
                 MATRIX_SLOT, format(st$encoding), format(st$kind)))
  }
  counts <- read_csc_matrix(matrix_path)
  n_cells <- nrow(counts)
  n_genes <- ncol(counts)
  if (n_cells < MIN_CELLS_PER_BATCH) {
    fail(sprintf(paste0("the matrix has %d cells; this method needs at least %d to build an ",
                        "artificial-doublet population and fit a classifier."),
                 n_cells, MIN_CELLS_PER_BATCH))
  }

  # ── the raw-count gate, re-checked FROM THE STORED VALUES ─────────────────────
  #
  # Not from the form, and not from the artifact's declared subtype: an agent/MCP call
  # reaches this compute without rendering a form, and scDblFinder does its own
  # normalization and feature selection internally, so a normalized matrix silently
  # produces meaningless scores rather than failing.
  vals <- counts@x
  if (length(vals)) {
    # NON-FINITE FIRST, and it is not defensive padding. `any(vals < 0)` returns NA when
    # `vals` holds a NaN, and `if (NA)` is an R ERROR — so a matrix carrying NaN used to
    # abort with a raw "missing value where TRUE/FALSE needed" traceback from inside the
    # sandbox, from the one block whose entire job is to refuse BY NAME.
    n_nonfinite <- sum(!is.finite(vals))
    if (n_nonfinite > 0) {
      fail(sprintf(paste0("the matrix holds %d non-finite stored value(s) (NaN or Inf); raw ",
                          "counts are finite non-negative integers. Refusing rather than ",
                          "scoring around them."), n_nonfinite))
    }
    if (any(vals < 0)) fail("the matrix holds negative values; this method needs RAW counts.")
    non_integer <- sum(abs(vals - round(vals)) > 1e-8)
    if (non_integer > 0) {
      fail(sprintf(paste0("the matrix holds %d non-integer stored values, so it is not raw ",
                          "counts (normalized or scaled data produces meaningless doublet ",
                          "scores here because scDblFinder normalizes internally). Bind the ",
                          "RAW count matrix."), non_integer))
    }
  }

  # ── the optional sample/batch column ──────────────────────────────────────────
  batch_path <- slots[[BATCH_SLOT]]
  batched <- !is.null(batch_path) && dir.exists(batch_path)
  if (batched) {
    bst <- read_store_structure(batch_path)
    col <- bst$columns[[1]]
    if (!identical(col$kind, "categorical")) {
      fail(sprintf(paste0("the `%s` artifact is a %s column; the sample column must be ",
                          "CATEGORICAL — its levels are the populations scored ",
                          "independently."), BATCH_SLOT, format(col$kind)))
    }
    node <- read_json_file(file.path(batch_path, "values", "zarr.json"))
    levels_ <- as.character(unlist(node$attributes$txr$levels))
    codes <- read_member_array(batch_path, "values", as = "uint8")
    if (length(codes) != n_cells) {
      fail(sprintf(paste0("the `%s` artifact holds %d values but the matrix declares %d ",
                          "cells — they are not the same cells axis."),
                   BATCH_SLOT, length(codes), n_cells))
    }
    assignment <- levels_[as.integer(codes) + 1L]
  } else {
    assignment <- rep("__all__", n_cells)
    levels_ <- "__all__"
  }

  # ── the optional cells-axis key artifact ──────────────────────────────────────
  aligned_to <- NULL
  ci_path <- slots[[CELLS_INDEX_SLOT]]
  if (!is.null(ci_path) && dir.exists(ci_path)) {
    node <- read_json_file(file.path(ci_path, "values", "zarr.json"))
    kind <- node$attributes$txr$kind
    keys <- if (identical(kind, "categorical")) {
      lv <- as.character(unlist(node$attributes$txr$levels))
      lv[as.integer(read_member_array(ci_path, "values", as = "uint8")) + 1L]
    } else {
      fail(sprintf(paste0("the `%s` artifact is a %s column; this entry can only read a ",
                          "CATEGORICAL key column. A string-layout key artifact needs the ",
                          "arrow split layout, which `_wire.R` does not implement."),
                   CELLS_INDEX_SLOT, format(kind)))
    }
    if (length(keys) != n_cells) {
      fail(sprintf("the `%s` artifact holds %d keys but the matrix declares %d cells.",
                   CELLS_INDEX_SLOT, length(keys), n_cells))
    }
    aligned_to <- key_sequence_digest(keys)
  }

  # ── the per-sample loop. OURS, not `scDblFinder(samples=)`. ───────────────────
  #
  # The library's own `samples` path does score per batch, but this entry needs each
  # level's expected-rate prior derived from THAT level's own recovered-cell count, and
  # it needs a level too small to score to be a NAMED refusal rather than whatever the
  # library does with it. Both follow from running one population per call. `BiocParallel`
  # is pinned to one worker by the recipe anyway, so delegating would buy no parallelism
  # and lose the per-sample prior.
  present <- levels_[levels_ %in% unique(assignment)]
  scores <- rep(NA_real_, n_cells)
  calls <- rep(NA_character_, n_cells)
  records <- list()
  for (i in seq_along(present)) {
    lv <- present[i]
    idx <- which(assignment == lv)
    progress("score", 10 + as.integer(70 * (i - 1) / length(present)),
             sprintf("scoring %s (%d cells)", lv, length(idx)))
    if (length(idx) < MIN_CELLS_PER_BATCH) {
      records[[length(records) + 1L]] <- list(
        sample = lv, n_cells = length(idx), scored = FALSE,
        refusal = sprintf(paste0("only %d cells, below the %d this method needs to build an ",
                                 "artificial-doublet population; these cells are recorded as ",
                                 "`%s` rather than given a fabricated score."),
                          length(idx), MIN_CELLS_PER_BATCH, LEVEL_NOT_EVALUATED))
      next
    }
    # ── THE PER-LEVEL PRIOR, COMPUTED ONCE AND PASSED EXPLICITLY ─────────────────
    #
    # `dbr` is derived from THIS LEVEL'S OWN recovered-cell count unless the user gave one,
    # and the value that goes to the library is the SAME OBJECT that goes into the report.
    #
    # The first cut passed `dbr = NULL` and let the library derive it, then re-derived the
    # same arithmetic separately for the report. That is two expressions for one number,
    # and a blind audit showed what it costs: with the value handed to the library replaced
    # by a flat 0.30, every per-sample test still passed while the report went on printing
    # the honest derivation — the fit had moved (scores by up to 0.64, one level's
    # threshold from 0.7516 to 0.5497) and nothing could see it. One expression, passed
    # explicitly, is what makes the report's claim checkable against the run.
    level_dbr <- if (is.null(opts$dbr)) length(idx) * dbr_per1k / 1000 else opts$dbr
    # RECORDED, for the same reason `expected_doublet_rate` is: a value the fit depends on
    # that nothing outside the process can observe is a value no test can check. `level_seed`
    # was wrong three times running — reseeding every run, then returning `NA` at the top of
    # the range — and the tests written for it could only see "the run did not crash",
    # because the seed each level actually got appeared nowhere in the output.
    this_seed <- level_seed(seed, i)
    res <- score_population(counts[idx, , drop = FALSE], modifyList(opts, list(dbr = level_dbr)),
                            this_seed)
    if (!is.null(res$error)) {
      records[[length(records) + 1L]] <- list(
        sample = lv, n_cells = length(idx), scored = FALSE,
        refusal = sprintf(paste0("scDblFinder could not score this population: %s. Its cells ",
                                 "are recorded as `%s` rather than given a fabricated score."),
                          res$error, LEVEL_NOT_EVALUATED))
      next
    }
    scores[idx] <- res$score
    calls[idx] <- res$class
    records[[length(records) + 1L]] <- list(
      sample = lv, n_cells = length(idx), scored = TRUE,
      # The rate ACTUALLY IN FORCE for this level — the SAME `level_dbr` the fit received,
      # not a second computation of it. See the note above the call.
      expected_doublet_rate = level_dbr,
      rate_source = if (is.null(opts$dbr)) "derived" else "user",
      seed = this_seed,
      threshold = res$threshold,
      n_called = sum(res$class == LEVEL_DOUBLET))
  }

  n_evaluated <- sum(!is.na(scores))
  any_scored <- any(vapply(records, function(r) isTRUE(r$scored), logical(1)))

  # ── the columns ───────────────────────────────────────────────────────────────
  progress("write", 82, "writing the doublet columns")
  entries <- list()
  score_name <- sprintf("%s_score", label)
  score_rel <- file.path("metadata", sprintf("%s.zarr", score_name))
  sc <- write_numeric_column(outputs_dir, score_rel, score_name, scores, axis = "cells",
                             aligned_to = aligned_to)
  sc$meta$method <- METHOD
  sc$meta$produced_by <- ANALYSIS
  entries[[length(entries) + 1L]] <- output_entry(
    sprintf("metadata-column:%s", score_name), DT_METADATA_COLUMN, score_rel, "artifact",
    sc$structure, sc$meta)

  # The CALL column is CATEGORICAL and is emitted ONLY when SOMETHING was scored. An
  # all-`singlet` column on a run that scored nothing would be a fabricated answer, which
  # is what this omission refuses — the same INV-3 the python lane holds.
  call_name <- sprintf("%s_call", label)
  call_emitted <- FALSE
  call_levels <- NULL
  if (any_scored) {
    has_unevaluated <- any(is.na(calls))
    # `not_evaluated` is DECLARED ONLY on a run that actually produced one — a level is
    # never declared speculatively.
    call_levels <- c(LEVEL_SINGLET, LEVEL_DOUBLET,
                     if (has_unevaluated) LEVEL_NOT_EVALUATED)
    codes <- match(ifelse(is.na(calls), LEVEL_NOT_EVALUATED, calls), call_levels) - 1L
    call_rel <- file.path("metadata", sprintf("%s.zarr", call_name))
    cc <- write_categorical_column(outputs_dir, call_rel, call_name, codes, call_levels,
                                   axis = "cells", aligned_to = aligned_to)
    cc$meta$method <- METHOD
    cc$meta$produced_by <- ANALYSIS
    cc$meta$levels_declared <- I(call_levels)
    entries[[length(entries) + 1L]] <- output_entry(
      sprintf("metadata-column:%s", call_name), DT_METADATA_COLUMN, call_rel, "artifact",
      cc$structure, cc$meta)
    call_emitted <- TRUE
  }

  # ── the provenance report ─────────────────────────────────────────────────────
  progress("report", 94, "provenance report")
  n_called <- sum(!is.na(calls) & calls == LEVEL_DOUBLET)
  report <- list(
    kind = "doublet-report",
    analysis = ANALYSIS,
    method = METHOD,
    citation = CITATION,
    label = label,
    n_cells = n_cells,
    n_genes = n_genes,
    n_evaluated = n_evaluated,
    n_not_evaluated = n_cells - n_evaluated,
    n_called = n_called,
    call_emitted = call_emitted,
    call_levels = if (is.null(call_levels)) I(character(0)) else I(call_levels),
    # Disclosure, not inference: an unbatched run is a legitimate state and is RECORDED
    # as such. It is never possible to obtain a call without the export saying which.
    batched = batched,
    batch_column = if (is.null(batch_column_name)) NULL else batch_column_name,
    n_batches = length(present),
    batches = records,
    seed = seed,
    parameters = list(
      doublet_rate_per_1k = dbr_per1k,
      expected_doublet_rate = if (is.null(opts$dbr)) NULL else opts$dbr,
      doublet_rate_sd = if (is.null(opts$dbr_sd)) NULL else opts$dbr_sd,
      nfeatures = opts$nfeatures, dims = opts$dims, include_pcs = opts$include_pcs,
      prop_random = opts$prop_random, prop_markers = opts$prop_markers,
      score = opts$score),
    fixed_by_scDblFinder = FIXED_BY_SCDBLFINDER,
    # The R lane records the resolved version of every library it loads, IN THE ARTIFACT,
    # because it declares no `run.dependencies` — helper staging is python-gated, so the
    # recorder the contract would be enforced by is not reachable from here. This is the
    # thing that is NOT lost along with the declaration, and a test pins it.
    library_versions = list(
      R = paste0(R.version$major, ".", R.version$minor),
      scDblFinder = as.character(packageVersion("scDblFinder")),
      BiocParallel = as.character(packageVersion("BiocParallel")),
      SingleCellExperiment = as.character(packageVersion("SingleCellExperiment")),
      Matrix = as.character(packageVersion("Matrix")),
      # Reached via `::` (which needs no `library()`) and therefore easy to miss — a blind
      # audit did. This block is the WHOLE traceability record for a published number,
      # because this entry declares no `run.dependencies`, so a library the run loads and
      # does not record is a hole in exactly the guarantee the missing declaration was
      # traded for.
      S4Vectors = as.character(packageVersion("S4Vectors")),
      SummarizedExperiment = as.character(packageVersion("SummarizedExperiment")),
      jsonlite = as.character(packageVersion("jsonlite")),
      digest = as.character(packageVersion("digest"))),
    disclosure = DISCLOSURE,
    # The like-for-like comparison (E7/DEC-9). Both numbers were produced on the SAME
    # fixture, the same construction and the same estimator; a number produced under a
    # different construction is not a comparison and is not published as one. The values
    # are maintained beside the measurement that produced them, in
    # `tests/test_ground_truth.py`, and a test asserts they agree with it.
    measured_performance = MEASURED_PERFORMANCE,
    batching_note = if (batched)
      sprintf(paste0("Doublet scoring ran independently within each of the %d levels of ",
                     "`%s`, each with its own artificial-doublet population and its own ",
                     "expected-rate prior derived from that sample's own cell count."),
              length(present), if (is.null(batch_column_name)) "the bound sample column" else batch_column_name)
    else
      paste0("This run was NOT batched: every cell was scored as one population. That is ",
             "correct if this dataset is a single capture. If it is a MERGED multi-sample ",
             "matrix, the result is not trustworthy: artificial doublets crossed sample ",
             "boundaries, inventing profiles no droplet could produce, and the ",
             "expected-rate prior was derived from the merged total rather than per lane. ",
             "Re-run with the sample column bound.")
  )
  report_path <- "scdblfinder-report.json"
  write_json_file(file.path(outputs_dir, report_path), report)
  entries[[length(entries) + 1L]] <- output_entry(
    "doublet-report", DT_REPORT_QC, report_path, "artifact",
    opaque_structure("application/json"),
    list(kind = "doublet-report", n_cells = n_cells, n_called = n_called,
         batched = batched, call_emitted = call_emitted))

  write_outputs_manifest(outputs_dir, entries)
  progress("done", 100, sprintf("%d cells scored; %d called", n_evaluated, n_called))
  cat(sprintf("%s: %d cells x %d genes -> %s%s\n", ANALYSIS, n_cells, n_genes, score_name,
              if (call_emitted) sprintf(" + %s (%d called)", call_name, n_called)
              else " (call omitted — nothing was scored)"),
      file = stderr())
}

#: The like-for-like numbers both methods carry, measured on #101/#130's OWN synthetic
#: heterotypic spike-in into real pbmc3k — same seed, same construction, same estimator.
#: MAINTAINED IN ONE PLACE: `tests/test_ground_truth.py` holds the measurement and
#: `tests/test_method_disclosure.py` asserts these agree with it, so a re-measure that
#: moves one and not the other goes red rather than shipping two numbers for one fact.
MEASURED_PERFORMANCE <- list(
  fixture = "pbmc3k raw counts + 6% cross-lineage heterotypic spike-ins, seed 0",
  note = paste0("These are the ONLY numbers in this report that compare the two methods, ",
                "and they are comparable because the fixture, the seed, the spike-in ",
                "construction and the AUPRC estimator are identical. Two limits cap BOTH ",
                "methods from above on this benchmark and are properties of the fixture, ",
                "not of either caller: pbmc3k's 2,638 real cells contain roughly 2% NATIVE ",
                "doublets that the truth vector labels `singlet`, so they score as false ",
                "positives; and homotypic doublets are undetectable by any simulation-based ",
                "caller."),
  scdblfinder = list(recall = 0.964, precision = 0.667, auprc = 0.858),
  scrublet = list(recall = 0.673, precision = 0.628, auprc = 0.585)
)

if (sys.nframe() == 0L) main()
