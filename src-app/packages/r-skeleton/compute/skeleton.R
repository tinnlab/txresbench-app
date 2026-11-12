#!/usr/bin/env Rscript
# r-skeleton.probe -- the FIRST R entry this platform executes (epic #169 / E6 / #194).
#
# ## The compute contract, in R
#
# Identical to the one every python entry already honours (PLATFORM_ARCHITECTURE.md
# S4.1) -- it is language-NEUTRAL, which is the property E6 exists to demonstrate:
#
#   read    <inputs>/params.json          (the run's params, with `seed` merged in)
#   write   <outputs>/probe.html          the kind-typed artifact (report/html)
#   write   <outputs>/manifest.json       the canonical OutputsManifest, LAST
#
# Roots are `/inputs` and `/outputs` under bwrap; both are overridable via
# TXR_INPUTS_DIR / TXR_OUTPUTS_DIR so the same file is runnable on a host, exactly as
# the python entries are. `manifest.json` is written LAST and only after the artifact
# exists, so a crash mid-run leaves NO manifest rather than a manifest naming bytes that
# are not there -- the host reads a missing/invalid manifest on exit 0 as a typed
# contract violation (P3 FINAL.md ITEM-15 / DEC-K), which is the behaviour E6/TEST-8
# asserts from the R side.
#
# ## What it stages, and what it may therefore assume (E6/DEC-2)
#
# An R entry receives its own package's declared `run.helpers` and NOTHING ELSE. The
# app's cross-cutting helper table (`PY_HELPER_FILES`) is a table of PYTHON modules and
# there is no R substrate to stage; inventing one inside a tracer bullet is a
# library-sized commitment E6 refuses (INV-5). So this file is SELF-CONTAINED by
# contract, not by accident: it loads `jsonlite` (pinned in the env recipe) and nothing
# else.
#
# It declares NO `run.dependencies`. The decision is stated in the manifest, beside the
# key it governs; how it was reached is in the lifecycle record. This comment restates
# neither -- nine independent copies of one decision is how four audit rounds each found
# a different stale one.
#
# ## Why the values below are the ones they are (E6/DEC-4, DEC-10)
#
# The surviving python interpreter probe in `tests/sandbox/mod.rs` states the discipline:
# "`42` is the PRODUCT, not the input: the request carries `6*7`, so this string can only
# come from an interpreter that evaluated it in the rootfs." An exit code proves nothing
# -- an echo, a shim or a shell that merely accepted the string all exit 0. So this entry
# emits three things that CANNOT be produced by anything but a real R interpreter running
# inside the R image:
#
#   1. `r_version_string` -- R's own `R.version.string`. It appears nowhere in the
#      request and no python interpreter emits it.
#   2. `product` -- `a * b` read from the request. The product appears nowhere in the
#      request, and because the operands COME FROM the request the assertion ranges over
#      the request instead of over one canned pair.
#   3. `rng_draw` -- `set.seed(seed); sum(rnorm(draws))`. R's Mersenne-Twister +
#      INVERSION normal generator is R-specific: NumPy, given the same seed, produces a
#      different number. The test asserts the R value AND asserts python's value for that
#      seed is ABSENT, so "only R could have produced this" is a control, not a claim.
#
# It reads NO staged artifact (E6/DEC-11) -- decoding a Zarr/CSC store from R needs the
# substrate DEC-2 refuses to build here. Inputs are still materialized by the host.

suppressPackageStartupMessages(library(jsonlite))

inputs_dir <- Sys.getenv("TXR_INPUTS_DIR", unset = "/inputs")
outputs_dir <- Sys.getenv("TXR_OUTPUTS_DIR", unset = "/outputs")
dir.create(outputs_dir, recursive = TRUE, showWarnings = FALSE)

params_path <- file.path(inputs_dir, "params.json")
params <- if (file.exists(params_path)) {
  fromJSON(params_path, simplifyVector = FALSE)
} else {
  # The host ALWAYS writes this file for a real run (`sandbox::inputs`), so its absence
  # means this entry is being exercised outside a run. Defaulting is correct here and
  # only here; a real run never takes this branch.
  list()
}

# ONE READER, ONE GRAMMAR. Every parameter is pulled through these two functions, so
# there is no second place that decides what a missing, non-numeric or out-of-range value
# means. That matters more than it looks: a parameter that silently defaults makes the
# emitted value unattributable to the request, and the whole point of what this entry
# emits is that it is attributable.
num_param <- function(name, default) {
  v <- params[[name]]
  if (is.null(v)) return(default)
  # `as.numeric` WARNS for an uncoercible atom and ERRORS for a list, so both are caught
  # here rather than one of them escaping as a raw R message from somewhere else.
  n <- tryCatch(suppressWarnings(as.numeric(v)), error = function(e) NA_real_)
  if (length(n) != 1L || is.na(n) || !is.finite(n)) {
    stop(sprintf(
      "r-skeleton.probe: parameter `%s` is not a single finite number (got %s). Refusing rather than defaulting.",
      name, paste(format(v), collapse = ",")
    ), call. = FALSE)
  }
  n
}

# An INTEGER parameter, validated as one BEFORE it is narrowed. `as.integer(num_param(..))`
# narrowed after validation, so the refusal above never saw the failure: a value outside
# int range became `NA` with only a warning, and `set.seed(NA)` then died with a raw R
# message instead of an attributable one; a fractional value was silently truncated.
int_param <- function(name, default, min_value) {
  n <- num_param(name, default)
  if (n != trunc(n)) {
    stop(sprintf("r-skeleton.probe: parameter `%s` must be a whole number (got %s).", name, format(n)),
         call. = FALSE)
  }
  if (n < min_value) {
    stop(sprintf("r-skeleton.probe: parameter `%s` must be >= %s (got %s).",
                 name, format(min_value), format(n)), call. = FALSE)
  }
  # `.Machine$integer.max` is R's own bound, read rather than typed. `AnalysisSpec.seed`
  # is an i64 on the host side, so a caller CAN supply a value R cannot hold, and that is
  # a refusal with a reason rather than an `NA` two lines later.
  if (abs(n) > .Machine$integer.max) {
    stop(sprintf(
      "r-skeleton.probe: parameter `%s` (%s) is outside R's integer range (+/-%s). The host carries it as a 64-bit integer; R cannot.",
      name, format(n, scientific = FALSE), format(.Machine$integer.max)
    ), call. = FALSE)
  }
  as.integer(n)
}

a <- num_param("a", 6)
b <- num_param("b", 7)
# `seed` is merged into params.json by the host for EVERY run
# (`sandbox::inputs::params_json_value`: "seed is merged in LAST (so it wins) and is
# NEVER null"), so this default is unreachable on the real path.
seed <- int_param("seed", 0, -.Machine$integer.max)
draws <- int_param("draws", 8, 1)

product <- a * b

# The RNG kind is STATED, not inherited: `set.seed` honours whatever kind is current, so
# recording the kind alongside the draw is what makes the draw reproducible by a reader
# who was not here. R has defaulted to Mersenne-Twister + Inversion for decades and to
# "Rejection" sampling since 3.6; a future R that changes any of them changes this value,
# and the test that pins it going RED is the correct, loud outcome.
set.seed(seed)
rng_draw <- round(sum(rnorm(draws)), 9)
rng_kind <- paste(RNGkind(), collapse = " ")

esc <- function(x) {
  x <- gsub("&", "&amp;", as.character(x), fixed = TRUE)
  x <- gsub("<", "&lt;", x, fixed = TRUE)
  x <- gsub(">", "&gt;", x, fixed = TRUE)
  gsub("\"", "&quot;", x, fixed = TRUE)
}

row <- function(k, v) {
  sprintf("<tr><th scope=\"row\">%s</th><td id=\"%s\">%s</td></tr>", esc(k), esc(k), esc(v))
}

# `report/html` is `opaque_as_is` with `format: html`, and the declared structure below
# says `media_type: text/html`. `_lib/conformance.py::_conform_opaque` FALSIFIES that
# claim against the bytes (a `text/*` artifact must decode), so the framework-owned,
# out-of-process output gate really does bite on an R producer -- which is what bounds
# the DEC-2 weakening: R lacks INPUT-side helpers, not output validation.
html <- paste0(
  "<!doctype html>\n<html lang=\"en\">\n<head><meta charset=\"utf-8\">",
  "<title>R environment probe</title></head>\n<body>\n",
  "<h1>R environment probe</h1>\n",
  "<p>What this run observed inside the R analysis environment. ",
  "No data were read; nothing scientific was computed.</p>\n",
  "<table>\n",
  row("r_version_string", R.version.string), "\n",
  row("r_version", paste0(R.version$major, ".", R.version$minor)), "\n",
  row("r_platform", R.version$platform), "\n",
  row("product", format(product, scientific = FALSE)), "\n",
  row("seed", format(seed, scientific = FALSE)), "\n",
  row("draws", format(draws, scientific = FALSE)), "\n",
  row("rng_kind", rng_kind), "\n",
  row("rng_draw", sprintf("%.9f", rng_draw)), "\n",
  # KEY PREFIXED `lib_version:` on purpose. `r_version` above is the INTERPRETER's own
  # version and is emitted unconditionally; a check for "some *_version field" is
  # therefore satisfied by it whether or not any LIBRARY version was ever recorded --
  # measured, by mutation, on the version of this file that used a bare
  # `jsonlite_version` key. The prefix is what lets a reader of the emitted BYTES tell
  # "a library's resolved version is here" from "R told me what R is".
  row("lib_version:jsonlite", as.character(packageVersion("jsonlite"))), "\n",
  "</table>\n</body>\n</html>\n"
)

artifact_name <- "probe.html"
writeLines(html, file.path(outputs_dir, artifact_name), sep = "")

# The canonical OutputsManifest. Every field `sandbox::outputs::OutputEntry` requires is
# named explicitly: `role`, `structure` and `meta` carry NO serde default, so an omitted
# one fails at ingest rather than being assumed.
#
# `auto_unbox = TRUE` so single-element R vectors serialize as JSON scalars rather than
# as one-element arrays -- R has no scalar type, and the manifest's schema does.
entry <- list(
  id = "probe",
  datatype = "report/html",
  path = artifact_name,
  layout = "opaque",
  role = "artifact",
  structure = list(encoding = "opaque", media_type = "text/html"),
  meta = list(kind = "r-environment-probe")
)
write(
  toJSON(list(outputs = list(entry)), auto_unbox = TRUE, pretty = TRUE),
  file.path(outputs_dir, "manifest.json")
)
