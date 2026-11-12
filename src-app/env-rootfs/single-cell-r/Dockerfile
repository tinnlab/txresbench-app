# The `single-cell-r` env rootfs — R + a BOUNDED Bioconductor set (#191 / epic #169).
#
# ── WHY THIS IMAGE EXISTS ────────────────────────────────────────────────────────────
# The sibling `single-cell` recipe says it in its own words (`../single-cell/Dockerfile`):
# "DROPS r-base-core (no R processor exists — re-add if one lands)". One has landed. The
# doublet analysis is built and HELD because Scrublet cannot reach #130's ground-truth
# floors at any parameterisation (measured recall 0.673 / AUPRC 0.585 against floors
# 0.75 / 0.80); #101 chose Scrublet ONLY because R was unavailable, and `scDblFinder` is
# the benchmark winner. So this image is not an enhancement — it is the blocker on a
# finished branch, and `scDblFinder` is both its first consumer and its acceptance
# evidence.
#
# ── WHAT IS IN IT, AND WHAT DELIBERATELY IS NOT ──────────────────────────────────────
# r-base plus an ENUMERATED, exactly-pinned package set — NOT all of Bioconductor. Read
# `requirements.txt`: it is the source of truth for what is installed, why each entry is
# here, and what was excluded by name. An unbounded image is a build nobody can maintain
# and a fetch nobody tolerates; the size budget below is what keeps that honest, and it
# FAILS THE BUILD rather than merely being documented.
#
# NOT here, each for a stated reason (details in `requirements.txt`):
#   * `zellkonverter`/`basilisk` — it embeds an entire private Python environment inside
#     the R image, i.e. a second copy of the stack the `single-cell` image already is.
#   * `Seurat` — no shipped analysis needs it; this app's wire format is not a Seurat
#     object and never becomes one.
#   * `rhdf5`/`HDF5Array` — HDF5 is an IMPORT-boundary format here, not the analysis wire
#     format. Verified against the tree, not assumed: every artifact a processor reads or
#     writes is a Zarr v3 sharded store (`packages/_lib/txr_zarr.py`, and `qc`'s own
#     manifest: "a `single-cell/expression` artifact in a real project is a MULTIFILE
#     ZARR store, not an `.h5ad` blob"). `h5py`/`read_h5ad` appear only in the two import
#     converters. So the matrix/IO substrate an R entry needs is `jsonlite` + `Matrix`
#     (+ `bit64` for the int64 offsets R has no native type for, `digest` for the
#     `key_sequence_digest` the conformance gate recomputes) — NOT an HDF5 stack.
#
# ── NOTHING SHIPPED DECLARES THIS ENV YET, AND THAT IS ON PURPOSE ────────────────────
# `grep -r 'env: single-cell-r' src-app/packages/` finds NOTHING, so no shipped analysis
# routes a job here today. That is not an oversight and it is not a defect — it is where
# this image sits in the dependency graph, and the reasoning is written here because the
# next person to notice the absence will be standing in this file.
#
# A contribution may only declare an env whose recipe satisfies its `run.dependencies[]`
# (`server/build_helper/processor_manifest.rs::lint_declared_dependencies`). Every shipped
# analysis is python and declares python pins, so declaring `env: single-cell-r` on one
# would fail `cargo check` — CORRECTLY, because that job genuinely could not run here. The
# first legitimate declaration therefore arrives with the first R analysis: E6/#194 and
# E7/#195, whose `scDblFinder` consumer is the whole reason this image exists.
#
# What ships HERE is the mechanism, end to end and tested: the manifest schema accepts
# `env` on an analysis, the #80 gate resolves a declaration against the declared recipe
# alone, this recipe's R-form pins are declarable at all (see `requirements.txt`'s grammar
# directive), and `provide()` routes a declared env to its OWN staged rootfs rather than
# silently serving the python one. Until E6/E7 land, the image is reachable only by an
# operator (`TXR_SANDBOX_ENV_ID`) or an admin-set `default_env_id`.
# Recorded as DISP-2 in the item's decisions; ruled 2026-09-03.
#
# ── SO THIS RECIPE DECLARES ITSELF, AND THE MARKER BELOW IS THAT DECLARATION ─────────
# `scripts/check-derived-vocabulary.sh` anchors every shipped recipe to a declaration:
# a directory here with a Dockerfile is an image that gets BUILT and PUSHED, so one that
# nothing declares is an image nothing can ask for. That anchor is right, and this recipe
# would trip it — because the only two ways to declare an env from a manifest are both
# unavailable to it, not by oversight but by construction:
#
#   * on an ANALYSIS — impossible until an R analysis exists. A contribution may only
#     name an env whose recipe satisfies its `run.dependencies[]`, and every shipped
#     analysis declares python libraries, so the #80 build gate would refuse it. E6/#194
#     and E7/#195 deliver the first R analysis and with it the first real declaration.
#   * on a CONVERTER — same reason, and no converter targets this image at all.
#
# The third channel is the one that fits: a deployment selects this image with
# `TXR_SANDBOX_ENV_ID` (or an admin-set `default_env_id`), which
# `processor_manifest.rs` documents as a first-class way to choose an env, and the marker
# is how a recipe SAYS that about itself — the same declare-don't-infer idiom as this
# file's `txr:env-smoke` marker below.
#
# It is a DECLARATION, not an exemption, and the difference is the whole point: the
# marker puts this id INTO the derived vocabulary, so it stays FORBIDDEN as a literal in
# the app-core surface exactly as a manifest-declared id would be. It does not buy silence
# — it buys the right kind of noise. And it is deliberately not removable by accident:
# once E6/E7 declare this env on a real analysis, deleting the marker is a reviewed diff
# rather than a line that quietly stops mattering.
# txr:env-operator-selected
#
# ── PUBLISHING IS MANUAL, EXACTLY AS FOR THE PYTHON RECIPE ───────────────────────────
# `.github/workflows/env-images.yml` is `.disabled` (the organization's Actions billing
# is off). The runtime resolves a MOVING tag, so a change here is invisible to every
# deployment until someone republishes: `docs/runbooks/env-image-republish.md`, or
# `scripts/publish-env-rootfs.sh --env single-cell-r`. Editing this file without
# republishing is a no-op, and that is the single most likely way to waste a day on it.
#
# ── THE SCHEMA VERSION DOES NOT MOVE, AND THAT IS LOAD-BEARING ───────────────────────
# A SECOND image is not a LAYOUT change to the first. `/opt`, `/usr`, the sandbox PATH,
# every bind and the marker path are what `ROOTFS_SCHEMA_VERSION` fences, and none of
# them moves here. Bumping would be actively harmful: the runtime resolves the moving tag
# `schema<N>-latest-<arch>`, so a bump re-points every deployment at a tag that does not
# exist until someone publishes under it — and with the publish workflow disabled, that
# window lasts until a human notices. See `server/src/modules/rootfs/version.rs:36-56`.
#
# ── HOW R IS PINNED (the R analogue of `uv pip install -r requirements.txt`) ──────────
# R has no wheel index, so exactness comes from two fixed coordinates plus an assertion.
# **Both coordinates are DECLARED IN `requirements.txt`** and read from there by the
# installer below (#192) — they used to be `ARG CRAN_SNAPSHOT` / `ARG BIOC_VERSION` here,
# which meant the same fact lived in two files with nothing holding them together:
#   1. `# txr:pin-source=dated-snapshot:<url>` — a DATE-PINNED Posit Package Manager
#      binary CRAN snapshot, which makes CRAN a function from name to version (the
#      `rocker-versioned2` mechanism);
#   2. `# txr:pin-source=release-channel:bioconductor-<rel>` — a FIXED Bioconductor
#      release, in lockstep with the R version;
#   3. a VERSION-ASSERTION pass that compares every installed package against
#      `requirements.txt` and FAILS the build on any mismatch. That third step is what
#      makes the pin file authoritative rather than aspirational: if an upstream moves
#      under us, the build goes red and names the package, instead of silently shipping
#      a different version into a published result's provenance.
# The CLASS on each line is not decoration: it states what identity that source
# guarantees, and a class that guarantees none (`vcs-head`) is refused by the build. See
# `docs/runbooks/env-image-republish.md` §4b.
#
# ── SHAPE ────────────────────────────────────────────────────────────────────────────
# Two-stage `rootfs` → `packer`, mirroring the python recipe: stage 1 builds the library,
# the packer stage runs mksquashfs and exposes `/rootfs.squashfs` (docker-cp'd out by the
# publish script). Divergence from the sibling, stated: the base is not `python:3.11-slim`
# and there is no uv venv — R's install path is its own, and `rocker/r-ver` is the prior
# art the plan names for a date-pinned R.

# ---------------------------------------------------------------------------
# Stage 1 — the R analysis rootfs.
# ---------------------------------------------------------------------------
# `rocker/r-ver` pins the R version exactly, ships R at `/usr/local` (inside the `/usr`
# the sandbox binds) and pre-configures the P3M binary repo — which is why the CRAN half
# of the install compiles nothing. It is NOT `bioconductor/bioconductor_docker`: that is
# the authority on what Bioc packages NEED and the anti-pattern on size (a ~4 GB
# developer image carrying a full build toolchain), and inheriting it would blow the
# budget below before a single analysis package was installed.
FROM rocker/r-ver:4.6.1 AS rootfs
ENV DEBIAN_FRONTEND=noninteractive

# bwrap binds <rootfs>/usr over /usr and runs `/bin/bash -lc`, so the base userland needs
# bash + coreutils; jq lets a shell entry parse params.json (the same reason the python
# recipe installs it — and `every_env_dockerfile_installs_jq` asserts it across EVERY
# recipe, so omitting it here reddens a test with no edit to that test).
#
# The `*-dev` packages are BUILD-ONLY: Bioconductor has no binary channel, so its half of
# the set compiles from source and needs headers. They are purged in the trim layer.
#
# `libuv1` is a RUNTIME library and is NOT build-only, so it is listed separately and
# survives the purge. It is here because a P3M binary package (`fs`, pulled transitively
# by the spatial tier) links against `libuv.so.1`, which noble does not install by
# default: without it, five packages fail with "unable to load shared object … libuv.so.1"
# at lazy-load time. That is the failure class a binary package channel introduces — the
# .so is already compiled, so nothing in the R install tells you a SYSTEM library is
# missing until the package is loaded.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash coreutils ca-certificates curl bzip2 jq binutils \
        libuv1 \
        libcurl4-openssl-dev libssl-dev libxml2-dev zlib1g-dev libbz2-dev \
        liblzma-dev libglpk-dev libgsl-dev libfftw3-dev libgeos-dev libudunits2-dev \
        libproj-dev libgdal-dev libpng-dev libjpeg-dev libtiff5-dev \
        libfontconfig1-dev libfreetype6-dev libharfbuzz-dev libfribidi-dev \
        libmagick++-dev libcairo2-dev \
    && rm -rf /var/lib/apt/lists/*

# The two fixed coordinates the pin set is resolved AT are DECLARED IN THE PIN FILE, as
# `# txr:pin-source=<class>:<coordinate>` lines, and read from there below (#192).
#
# They used to be `ARG CRAN_SNAPSHOT=…` / `ARG BIOC_VERSION=…` here, with the pin file's
# header describing them in prose ("currently .../noble/2026-09-01"). That is the same
# fact written twice, in two files, with nothing holding them together — and the file
# whose header would go stale is the one whose whole job is to be the record of what the
# pins mean. One place now says it, and it is the place that is the source of truth for
# what is installed.
#
# The build-arg override is REMOVED rather than replaced, deliberately: an overridable
# coordinate is an unrecorded input to a published number. Changing a coordinate is a pin
# upgrade — follow `docs/runbooks/env-image-republish.md` §4b, because moving a coordinate
# moves versions the assertion pass below will then reject until the pin file is updated
# to match, which is the point.
COPY requirements.txt /tmp/requirements.txt

# Install EXACTLY the pinned set, then ASSERT it.
#
# The installer is INLINE rather than a sibling `.R` file on purpose: the build's
# freshness key is a hash of THIS FILE's bytes (`rootfs::version::format_version`), so
# logic in a separate file would change without re-triggering a build. The recipe is
# two files — `Dockerfile` + `requirements.txt` — exactly like its sibling, and both are
# watched by the build helper.
#
# The pin file is the ONLY install list. Nothing is named here, so a package cannot be
# installed without being pinned, and a pin cannot be installed without being asserted.
#
# ── THIS RECIPE REQUIRES BUILDKIT ───────────────────────────────────────────────────
# The `RUN <<'…'` heredocs below are BuildKit syntax. Neither
# `scripts/publish-env-rootfs.sh` nor `.github/workflows/env-images.yml.disabled` sets
# `DOCKER_BUILDKIT` explicitly — they rely on the default, which is BuildKit on Docker
# ≥ 23 (and the only builder at all on ≥ 25, where the classic builder was removed).
# On an older daemon, export `DOCKER_BUILDKIT=1` before building this recipe. Stated
# rather than assumed, because the failure mode is a confusing parse error rather than a
# missing feature.
#
# The alternative — a backslash-continued one-liner — would make a 70-line installer
# unreadable and unreviewable, and this recipe's whole position is that the install regime
# should be legible enough to review.
RUN <<'TXR_INSTALL'
set -eux
# ── THE REGIME FUNCTIONS, IN A SEPARATELY DELIMITED BLOCK (#192) ─────────────────────
# Everything that decides what this image RECORDS — the pin parser, the coordinate
# reader, and the closure-lock writer — lives in `txr-regime.R` below. It is written
# FROM THIS FILE rather than COPYied from a sibling `.R` for the reason the recipe is
# exactly two files: `watched_env_pin_files` watches precisely `Dockerfile` +
# `requirements.txt` for cargo's `rerun-if-changed`, so a third file would change without
# re-triggering the build gate.
#
# STATED PRECISELY, because the obvious second reason is not currently true and repeating
# it would mislead: `rootfs::version::format_version` hashes THIS FILE's bytes only, and
# since #192 the resolution coordinates live in `requirements.txt`, which it does not
# hash — so that key no longer covers a coordinate rotation. It covers nothing today
# either way: `build_helper/sandbox_rootfs.rs::setup()` returns `write_stub(...)` before
# the staging path, which is `#[allow(unreachable_code)]`, because the rootfs became a
# GHCR artifact lazy-fetched at run time and keyed by its own content digest. If that
# path is ever re-enabled, the key must fold the pin file too, or a pin edit will serve a
# stale squashfs. Recorded here rather than discovered there.
#
# It is nonetheless a SEPARATE, NAMED heredoc rather than more lines of the installer,
# and every function takes its inputs as ARGUMENTS instead of reading globals. That is
# what makes it RUNNABLE outside a `docker build`: `tests/run-r-tests.sh` extracts this
# exact block by its `TXR_REGIME_R` delimiter and executes it under `Rscript` against
# fixtures — including the two cases the comments record as found the hard way (a package
# installed twice, and a lock that would disagree with R's own resolver). A `docker
# build` is a 20-minute, multi-GB operation this repository cannot run in a test, so the
# only alternative would be a static predicate over these lines — and a predicate over
# text is exactly what has repeatedly been defeated here by the next spelling rather than
# by a real defect.
cat > /tmp/txr-regime.R <<'TXR_REGIME_R'
## ---- THE CANONICAL-BYTES PRECONDITION, checked before anything is parsed.
##
## WHY THIS EXISTS. This installer and the Rust build gate are the TWO programs that read
## this file (#214). They are written in different languages and do not agree about which
## exotic bytes separate tokens or end lines, so a byte the two read differently can be a
## directive to one and invisible to the other. Every exploitable defect found across four
## audit rounds was an instance of that one fact: a NBSP, a lone CR, a U+000B, a U+001C.
##
## ── AN ALLOWLIST, NOT A FORBIDDEN SET (#214) ──────────────────────────────────────
##
## This used to enumerate 81 forbidden codepoints, mirroring Rust's
## `is_control() || is_whitespace()`. Each of the four rounds WIDENED that set, each
## widening was correct, and each was insufficient — because a forbidden set fails OPEN on
## every character nobody thought of. A blind audit of #214 walked through the next door:
## Rust's `is_control()` covers category `Cc` only, so the whole `Cf` FORMAT class passed —
## U+FEFF, U+200B, U+00AD, and the bidi overrides of Trojan Source (CVE-2021-42574). A
## zero-width space in `#<ZWSP>txr:pin-source=` makes the directive inert while leaving it
## visibly present, in the file AND in the generated artefact a reviewer reads.
##
## So the polarity is inverted rather than the set widened a fifth time. This file may
## contain PRINTABLE ASCII, SPACE, TAB, LF, and the four decorative characters its own
## prose uses. Everything else is refused BY DEFAULT — every control, every format
## character, every exotic space, every homoglyph, and every character Unicode has not
## defined yet.
##
## The happy side effect is that R no longer needs a 242-entry enumeration to say this.
## Both the gate and this installer express the same four-character rule, and
## `processor_manifest.rs::the_two_readers_allow_exactly_the_same_non_ascii_characters`
## reads this vector out of this file to hold the two lists together.
txr_allowed_non_ascii <- c(0xa7, 0x2014, 0x2192, 0x2500)

## `text` is the file read as ONE string (`readChar`), not `readLines` — a CR is invisible
## to a line-splitting reader by construction, which is precisely the byte this refuses.
txr_assert_canonical_bytes <- function(text) {
  ## FAIL CLOSED ON INVALID UTF-8 — BEFORE `strsplit`, and this placement is the whole fix.
  ##
  ## Originally this check did not exist and one stray 0x80 disabled the whole function. The
  ## first attempt at a fix put `anyNA(cps)` AFTER the split, on the theory that `utf8ToInt`
  ## returns NA for an invalid string. A second blind audit ran it and the guard never
  ## fired: the NA comes from `strsplit`, which returns a single `NA_character_`, and
  ## `paste(NA, collapse = "")` then yields the two-character string "NA" — so `cps` is
  ## `c(78, 65)`, both in the allowlist, and `anyNA(cps)` is FALSE. The refusal was
  ## unreachable for the exact input class its own message named.
  ##
  ## That is the second time on this branch that a fix was described correctly and did not
  ## work, so it is written down rather than quietly corrected. `validUTF8` asks the
  ## question directly, of the bytes, before anything transforms them.
  if (!validUTF8(text)) {
    stop("requirements.txt is not valid UTF-8. The build gate refuses such a file outright, and this reader cannot examine it character by character, so it is refused here too rather than silently skipped.", call. = FALSE)
  }
  chars <- strsplit(text, "", fixed = TRUE)[[1]]
  if (!length(chars)) return(invisible(TRUE))
  cps <- utf8ToInt(paste(chars, collapse = ""))
  ok <- (cps >= 0x21 & cps <= 0x7e) | cps %in% c(0x20, 0x09, 0x0a) |
        cps %in% txr_allowed_non_ascii
  hit <- which(!ok)
  if (length(hit)) {
    i <- hit[[1]]
    line <- sum(cps[seq_len(i)] == 0x0a) + 1L
    stop(sprintf(
      "requirements.txt line %d: character U+%04X is not permitted. A pin file may contain printable ASCII, SPACE, TAB, LF, and only these non-ASCII characters: %s. Everything else is refused BY DEFAULT. The Rust build gate and this installer do not agree about which exotic bytes separate tokens or end lines, and a character a human reviewer cannot see is one they cannot review. If you genuinely need this character in prose, add it to `txr_allowed_non_ascii` here AND to `PIN_FILE_ALLOWED_NON_ASCII` in the build gate AND to `pin_file_canon.py` — two cross-check tests hold the three lists to each other.",
      line, cps[[i]],
      paste(sprintf("U+%04X", txr_allowed_non_ascii), collapse = ", ")), call. = FALSE)
  }
  invisible(TRUE)
}

## ---- THE ONE WAY TO READ THIS FILE (#214 round 2).
##
## Every reader in the R lane goes through here: the installer, the build-time smoke, and
## the test suite. That is a STRUCTURAL fix for a problem two previous rounds attacked with
## predicates. `regime_test.R` had its own `readLines` (a fourth opinion about where a line
## ends, in the suite whose subject is that byte); round 1 replaced it with a retyped
## `readChar` + `strsplit` and a source check forbidding `readLines(pin_file`; a blind audit
## then defeated that check with `readLines(con = pin_file)` and with a one-line alias.
##
## A better predicate would have been the fifth attempt at a predicate. There is now a
## function to call instead, so there is nothing for a reader to re-implement — and the
## suite's remaining source check has a much narrower claim to make.
##
## `readChar` + `useBytes`, never `readLines`: `readLines` splits on CR as well as LF, so it
## cannot see the one byte the precondition below exists for.
txr_read_pin_lines <- function(path) {
  text <- readChar(path, file.info(path)$size, useBytes = TRUE)
  Encoding(text) <- "UTF-8"
  txr_assert_canonical_bytes(text)
  strsplit(text, "\n", fixed = TRUE)[[1]]
}

## ---- parse the pin file. Deliberately the SAME grammar the Rust build gate parses
## (`server/build_helper/processor_manifest.rs::parse_env_pins_in`): every non-blank,
## non-comment line is `<name>==<version>` with an `# import=<library>` token. A bare
## name, a range, a duplicate or a missing token is a BUILD ERROR here, so the two
## parsers cannot disagree about what the file says.
##
## POSIX classes, NOT `\\s`. R's default (TRE/extended) regex engine does NOT interpret
## `\s` INSIDE a bracket expression — `[^\s#]` reads as "not backslash, not s, not #", so
## the version capture swallowed the padding spaces and every pin compared unequal to
## itself ("installed 1.30.27 != pinned 1.30.27"). Caught by the assertion doing its job.
txr_parse_pins <- function(raw) {
  pat <- "^[[:space:]]*([A-Za-z0-9][A-Za-z0-9._]*)==([^[:space:]#]+)[[:space:]]*#[[:space:]]*import=([A-Za-z0-9._]+)"
  pins <- list()
  for (i in seq_along(raw)) {
    line <- raw[[i]]
    body <- trimws(sub("#.*$", "", line))
    if (!nzchar(body)) next
    m <- regmatches(line, regexec(pat, line))[[1]]
    if (length(m) != 4L) {
      stop(sprintf(
        "requirements.txt line %d: %s\n  every line must be `<name>==<version>  # import=<library>` — a bare name, a range or a missing import token cannot be checked",
        i, line), call. = FALSE)
    }
    nm <- m[[2]]
    if (nm %in% vapply(pins, function(p) p$name, "")) {
      stop(sprintf("requirements.txt line %d: `%s` is pinned twice — the pin set must be a function from package to version", i, nm), call. = FALSE)
    }
    pins[[length(pins) + 1L]] <- list(name = nm, version = m[[3]], import = m[[4]])
  }
  if (length(pins) < 10L) stop("the pin file parsed to fewer than 10 pins — refusing to build an env this thin by accident", call. = FALSE)
  pins
}

## ---- read the RESOLUTION COORDINATES the pin file declares (#192). The comment-body
## normalisation MIRRORS the Rust gate's `directive_body`: leading whitespace and every
## leading `#` removed, then trimmed, so `#`, `# `, `##  ` and a tab-indented variant all
## reach the same place. If these two readers disagreed about which lines are directives,
## the file the build installs from and the file the build GATE checks would be different
## files with the same name.
##
## The class is what says whether `<name>==<version>` is an identity at all. `vcs-head` is
## refused HERE as well as in the Rust gate, so an operator who edits the pin file and
## builds the image directly hits the same refusal as `cargo check` — a gate that only one
## of two entry points enforces is a gate with a door beside it.
##
## ── THE ONE PLACE THAT SYMMETRY IS NOT EXACT, stated rather than implied (#214) ──
##
## An embedded NUL. `readChar` TRUNCATES at the first one, so this reader silently sees a
## PREFIX of the file and then verifies that prefix against itself, while the Rust gate
## reads the whole file and refuses it. R cannot fix this — a character vector cannot hold a
## NUL — so the asymmetry is a property of the language, not a choice, and the gate is the
## only thing standing between a NUL and a silently-truncated install. Invalid UTF-8 was a
## second instance until #214 — one stray byte disabled the whole check — and
## `txr_assert_canonical_bytes` now refuses it with `validUTF8`, BEFORE anything transforms
## the string. `regime_test.R` exercises both, which is what makes the claim checkable
## rather than asserted: the first attempt at the UTF-8 fix had no test and did not work.
txr_parse_sources <- function(raw) {
  known <- c("immutable-index", "dated-snapshot", "release-channel")
  out <- list()
  for (i in seq_along(raw)) {
    body <- sub("^[[:space:]]*#*[[:space:]]*", "", raw[[i]])
    ## MATCH THE KEY, THEN REQUIRE THE `=`. Matching `^txr:pin-source[[:space:]]*=` in one
    ## step meant a line that NAMED the directive without an `=` was silently SKIPPED —
    ## `# txr:pin-source vcs-head:x` walked straight past the #209 refusal below, while the
    ## Rust gate hard-errored on it. A gate with a spelling that bypasses it is not a gate,
    ## and "these two readers agree about which lines are directives" was the claim this
    ## file makes three paragraphs up. The word boundary is required for the same reason the
    ## Rust side requires one: `txr:pin-sourceXYZ=a:b` is not this directive.
    if (!grepl("^txr:pin-source([[:space:]]|=|$)", body)) next
    rest <- sub("^txr:pin-source[[:space:]]*", "", body)
    if (!startsWith(rest, "=")) {
      stop(sprintf("requirements.txt line %d: `%s` names `txr:pin-source` but is not `txr:pin-source=<class>:<coordinate>` — a near-miss is refused rather than skipped, because a skipped near-miss is how a refused source class gets installed anyway", i, trimws(raw[[i]])), call. = FALSE)
    }
    value <- trimws(sub("^=", "", rest))
    ## A trailing comment is stripped only when it is SEPARATED by whitespace. A bare
    ## `#` is legal inside a URL fragment, and silently truncating the coordinate there
    ## would make the regime the file declares differ from the regime the build resolves —
    ## with no error anywhere. (`value` is free-form and never interpreted here; that is
    ## incompatible with unconditional comment-stripping.)
    value <- trimws(sub("[[:space:]]+#.*$", "", value))
    m <- regmatches(value, regexec("^([A-Za-z-]+):(.+)$", value))[[1]]
    if (length(m) != 3L) {
      stop(sprintf("requirements.txt line %d: `txr:pin-source=%s` is not `<class>:<coordinate>` (a class, a colon, and a non-empty coordinate)", i, value), call. = FALSE)
    }
    cls <- m[[2]]
    coord <- trimws(m[[3]])
    if (identical(cls, "vcs-head")) {
      stop(sprintf(
        "requirements.txt line %d: `txr:pin-source=vcs-head:%s` is REFUSED. An unversioned VCS head does not make `<name>==<version>` denote one source tree: two builds a day apart record the SAME version string for DIFFERENT code, so a run's provenance record would lie. Shipping from one needs a commit pin PLUS a source hash — that is #209.",
        i, coord), call. = FALSE)
    }
    if (!(cls %in% known)) {
      stop(sprintf("requirements.txt line %d: `%s` names no known pin-source class (%s, vcs-head)", i, cls, paste(known, collapse = ", ")), call. = FALSE)
    }
    ## The same `(class, coordinate)` twice says nothing twice and is what a bad merge
    ## leaves behind. Refused here as well as in the Rust gate — the two readers are
    ## claimed to agree about what this file says, and an assertion of agreement that is
    ## not true in both directions is worse than no assertion.
    for (prev in out) {
      if (identical(prev$class, cls) && identical(prev$coordinate, coord)) {
        stop(sprintf("requirements.txt line %d: `%s:%s` is declared twice", i, cls, coord), call. = FALSE)
      }
    }
    out[[length(out) + 1L]] <- list(class = cls, coordinate = coord)
  }
  if (!length(out)) {
    stop("requirements.txt declares no `txr:pin-source=<class>:<coordinate>` — an unrecorded regime is how a published result comes to rest on a dependency version that appears in no diff in this repository", call. = FALSE)
  }
  out
}

## Exactly one coordinate of a given class, or an error. "Exactly": two dated snapshots
## would make "which one did these pins come from" unanswerable, and silently taking the
## first is the shape of answer this whole file exists to refuse.
txr_source_coordinate <- function(sources, cls) {
  hit <- Filter(function(s) identical(s$class, cls), sources)
  if (length(hit) != 1L) {
    stop(sprintf("requirements.txt must declare exactly one `%s` pin source; found %d", cls, length(hit)), call. = FALSE)
  }
  hit[[1]]$coordinate
}

## The Bioconductor RELEASE out of a `release-channel` coordinate. The prefix is required
## rather than stripped-if-present: `release-channel:3.23` names a release of nothing, and
## a coordinate that does not say which channel it is is not a coordinate.
txr_bioc_release <- function(coord) {
  ## The `.+` is not decoration: `bioconductor-` alone satisfied a bare prefix test and
  ## returned "", which then reached `BiocManager::repositories(version = "")` and was
  ## printed into the lock header as `# bioconductor `. A coordinate that names a channel
  ## and no release is exactly the "does not say which channel it is" case this function
  ## exists to refuse, one level down.
  if (!grepl("^bioconductor-.+$", coord)) {
    stop(sprintf("the `release-channel` coordinate `%s` does not name a channel AND a release — expected `bioconductor-<release>`", coord), call. = FALSE)
  }
  sub("^bioconductor-", "", coord)
}

## ---- freeze the FULL resolved closure INTO the image (#192 extends #191).
##
## `requirements.txt` pins the DIRECT set; this records every transitive package nobody
## named, so transitive drift is visible in the provenance of the run it affected instead
## of being invisible.
##
## THE SCHEMA IS `renv.lock`'s: package, version and SOURCE per package. The source is
## what says whether the recorded version is an identity — a package from the dated CRAN
## snapshot and a package from the Bioconductor release channel make different promises
## about what a rebuild will produce, and a lock that recorded only `name==version` could
## not tell a reader which promise applied to which line.
##
## `ip` is an `installed.packages()`-shaped frame; `resolve_version(name)` is what R
## actually LOADS; `repo_of(name)` is the `Repository` field the package records. All
## three are ARGUMENTS so this is exercisable without an installed library set.
txr_write_env_lock <- function(path, pins, header, ip, resolve_version, repo_of, lib_paths,
                                priority_of = function(nm) NA_character_) {
  ## EVERY interpolated field, not just this one.
  ##
  ## The first cut sanitised `Repository` alone, on the stated grounds that it is "a DCF
  ## field from the RESOLVED REPOSITORY — content this build did not write". That reasoning
  ## is correct and it applies verbatim to `Package`, `Version` and `LibPath`: they come
  ## from the same DESCRIPTION file, published by the same third party, and DCF
  ## continuation lines make any of them legitimately multi-line. An audit set a real
  ## installed package's `Version:` to a continuation carrying
  ## `ghostpkg==9.9.9  # source=CRAN`, rebuilt its `Meta/package.rds` the way `R CMD
  ## INSTALL` does, and this writer emitted a whole extra package line — with the writer
  ## reporting one package and `env-lock-of.sh` reporting and printing two. The resolver
  ## cross-check above did not see it because BOTH sides carried the same poisoned string.
  ## The same byte in `LibPath` turns a `# shadowed` provenance COMMENT into a counted
  ## package line.
  ##
  ## Sanitising one of four fields is not sanitising: the file's whole job is to be an
  ## unambiguous line-per-package record, and any field that can carry a newline can add a
  ## line. Control characters go too, not just newlines — a CR splits this file for R's
  ## `readLines` and not for the shell reader's `grep`, which is the same divergence class
  ## the pin file's canonical-bytes precondition exists to close, one file over.
  clean_field <- function(s) {
    s <- gsub("[[:cntrl:]]+", " ", s)
    if (nchar(s) > 120L) s <- paste0(substr(s, 1L, 117L), "...")
    s
  }
  clean_source <- clean_field
  con <- file(path, "w")
  on.exit(try(close(con), silent = TRUE), add = TRUE)
  writeLines(vapply(header, clean_field, ""), con)
  ## ONE LINE PER PACKAGE, AND IT MUST BE THE ONE R LOADS. `installed.packages()` scans
  ## every `.libPaths()` entry, so a package installed twice appears twice — and it is:
  ## the rocker base ships the recommended `Matrix 1.7-5` in `R/library` while the pinned
  ## `1.7-6` installs into `site-library`. Written raw, this file listed BOTH, which makes
  ## the lock ambiguous exactly where it is supposed to be authoritative: its whole job
  ## (see `requirements.txt`) is to be "what a run records, so transitive drift is visible
  ## in the provenance of the run it affected", and a reader cannot tell from
  ## `Matrix==1.7-6` + `Matrix==1.7-5` which one produced the numbers.
  ##
  ## Rows come back in `.libPaths()` order, so the FIRST row per package is the one
  ## `library()` resolves — the same answer `packageDescription` gives, cross-checked
  ## below rather than assumed. A shadowed copy is not dropped silently: it is recorded as
  ## a `# shadowed` comment, because "there is a second copy in the image" is itself
  ## provenance.
  ip <- as.data.frame(ip, stringsAsFactors = FALSE)
  rank <- match(ip$LibPath, lib_paths)
  rank[is.na(rank)] <- .Machine$integer.max
  ord <- ip[order(ip$Package, rank), , drop = FALSE]
  resolved <- ord[!duplicated(ord$Package), , drop = FALSE]
  shadowed <- ord[duplicated(ord$Package), , drop = FALSE]
  ## Cross-check the first-row rule against R's own resolver on the direct pins, so a
  ## future change to `.libPaths()` ordering cannot silently make the lock disagree with
  ## what loads.
  for (p in pins) {
    want <- resolved$Version[match(p$name, resolved$Package)]
    got <- resolve_version(p$name)
    ## NA ON EITHER SIDE IS A REFUSAL, NOT AGREEMENT. `match()` yields NA for a pin absent
    ## from the installed set and `packageDescription` yields NA for a package R cannot
    ## find, so `identical(NA_character_, NA_character_)` was TRUE and the one case where
    ## the lock records NOTHING for a direct pin was the case this check accepted. A check
    ## that agrees with itself about an absence is the shape of a vacuous guard.
    if (length(want) != 1L || is.na(want)) {
      stop(sprintf("the lock would record NOTHING for the pinned package %s — it is not in the installed set the lock is being written from", p$name), call. = FALSE)
    }
    if (length(got) != 1L || is.na(got)) {
      stop(sprintf("R cannot resolve the pinned package %s on .libPaths(), so 'what LOADS' has no answer to compare the lock against", p$name), call. = FALSE)
    }
    if (!identical(as.character(want), as.character(got))) {
      stop(sprintf("lock would record %s==%s but R resolves %s — the lock must record what LOADS", p$name, want, got), call. = FALSE)
    }
  }
  ## THE SOURCE COLUMN, AND WHY IT HAS THREE OUTCOMES RATHER THAN TWO.
  ##
  ## `unrecorded` used to cover both "R itself shipped this package" (a base/recommended
  ## package has no `Repository` field, and never will) and "this package came from
  ## somewhere nothing here can name". Those are opposite answers to the question the
  ## column exists to answer — the first is the most trustworthy provenance in the file,
  ## the second is the false-pin case INV-5 is about — and collapsing them made the column
  ## unable to distinguish exactly the thing the runbook says it distinguishes.
  ##
  ## So `Priority` is consulted: `base`/`recommended` is R's own declaration that it ships
  ## the package, and anything else with no `Repository` is named as needing investigation
  ## rather than filed under the same word.
  ##
  ## `length(r) != 1L` is part of the guard, not belt-and-braces: `is.na(character(0))` is
  ## `logical(0)` and `||` on it aborts with "missing value where TRUE/FALSE needed",
  ## turning a recording decision into an opaque build failure.
  scalar_chr <- function(x) {
    if (is.null(x) || length(x) != 1L || is.na(x) || !nzchar(as.character(x))) NA_character_
    else as.character(x)
  }
  ## SANITISED. `Repository` is a DCF field from the RESOLVED REPOSITORY — content this
  ## build did not write — and DCF continuation lines make it legitimately multi-line. An
  ## embedded newline interpolated into `sprintf("%s==%s  # source=%s")` and emitted by
  ## `writeLines` becomes an EXTRA LINE in the lock, which `scripts/env-lock-of.sh` counts
  ## and prints as an installed package. An audit produced a `ghostpkg==9.9.9` line that
  ## way, in the file that is supposed to be the answer to "which versions did this run
  ## use". Newlines and CRs are collapsed and the field is clamped.

  sources <- vapply(resolved$Package, function(nm) {
    r <- scalar_chr(repo_of(nm))
    if (!is.na(r)) return(clean_source(r))
    pr <- scalar_chr(priority_of(nm))
    if (!is.na(pr) && pr %in% c("base", "recommended")) return(sprintf("r-%s", clean_source(pr)))
    "UNRECORDED-NOT-FROM-A-DECLARED-COORDINATE"
  }, "")
  writeLines(sprintf("%s==%s  # source=%s",
                     vapply(resolved$Package, clean_field, ""),
                     vapply(resolved$Version, clean_field, ""),
                     sources), con)
  if (nrow(shadowed)) {
    writeLines(sprintf("# shadowed %s==%s in %s (not the copy R loads)",
                       vapply(shadowed$Package, clean_field, ""),
                       vapply(shadowed$Version, clean_field, ""),
                       vapply(shadowed$LibPath, clean_field, "")), con)
  }
  close(con)
  on.exit()
  ## COUNT PACKAGE ROWS, NOT BYTES. The byte test could never fire from the real call site:
  ## the installer always passes a four-line header, which is written before any package
  ## line, so a zero-package lock is a non-empty FILE. "An empty lock records nothing while
  ## looking exactly like a lock" was exactly right about the failure and exactly wrong
  ## about how to detect it — the header is what makes it look like a lock.
  if (nrow(resolved) < 1L) {
    stop("the env lock would contain ZERO package lines — a lock with a header and no packages records nothing while looking exactly like a lock", call. = FALSE)
  }
  if (!file.exists(path) || file.info(path)$size <= 0) {
    stop("the env lock file is empty on disk", call. = FALSE)
  }
  list(resolved = nrow(resolved), shadowed = nrow(shadowed))
}
TXR_REGIME_R
cat > /tmp/txr-install.R <<'RSCRIPT'
source("/tmp/txr-regime.R")

## Read the file ONCE, as bytes, and refuse the divergence class before parsing anything.
## `readLines` would have already split on a CR and hidden it.
req_path <- "/tmp/requirements.txt"
raw <- txr_read_pin_lines(req_path)
pins <- txr_parse_pins(raw)
names_wanted <- vapply(pins, function(p) p$name, "")
cat(sprintf("pin file: %d exact pins\n", length(pins)))

## The two coordinates come from the PIN FILE, which is the source of truth for what is
## installed — not from a build arg, which nothing records (#192).
srcs <- txr_parse_sources(raw)
cran <- txr_source_coordinate(srcs, "dated-snapshot")
bioc <- txr_bioc_release(txr_source_coordinate(srcs, "release-channel"))
cat(sprintf("pin sources: CRAN snapshot %s / Bioconductor %s\n", cran, bioc))

## ---- resolve the two coordinates into a repo list. Bioc FIRST so a name present in
## both resolves to the Bioconductor build, which is what its release lockstep means.
options(HTTPUserAgent = sprintf("R/%s R (%s)", getRversion(),
  paste(getRversion(), R.version[["platform"]], R.version[["arch"]], R.version[["os"]])))
options(repos = c(CRAN = cran))

## BOOTSTRAP: the Bioconductor repository URLs are produced BY `BiocManager`, so it has
## to exist before the repo list can be built. It is pinned like everything else (and
## asserted below) — it decides which versions the Bioc half resolves to, which is
## precisely the class of input this file exists to fix in place. Installed from the
## dated CRAN snapshot alone, so the bootstrap is as reproducible as the rest.
if (!requireNamespace("BiocManager", quietly = TRUE)) install.packages("BiocManager")

br <- BiocManager::repositories(version = bioc)
br <- br[names(br) != "CRAN"]
options(repos = c(br, CRAN = cran), timeout = 1800,
        Ncpus = max(1L, as.integer(Sys.getenv("TXR_BUILD_NCPUS", "8"))))

install.packages(names_wanted)

## ---- ASSERT: every pin is installed, at EXACTLY the pinned version. This is what makes
## the file a pin rather than a wish. An upstream that moved under us fails the BUILD and
## names the package; it does not silently ship a different version into a run's
## provenance record.
## RESOLVED THE WAY R RESOLVES IT, not by row order.
##
## This used to be `ip$Version[match(p$name, ip$Package)]` over `installed.packages()`,
## and that is a silent choice between two installs: `installed.packages()` scans EVERY
## entry of `.libPaths()`, and a package really can appear twice. It does here — the
## `rocker/r-ver` base ships the RECOMMENDED package `Matrix 1.7-5` in
## `/usr/local/lib/R/library` while the pinned `1.7-6` installs into
## `/usr/local/lib/R/site-library`. That is normal for a recommended package and is NOT
## an error: `site-library` precedes `library` in `.libPaths()`, so `library(Matrix)`
## loads 1.7-6. But `match()` agreeing with that was luck, not resolution — it would just
## as happily have asserted the SHADOWED copy's version and reported a pin satisfied by an
## install the image never loads.
##
## `packageDescription(fields = "Version")` performs exactly the `.libPaths()` search
## `library()` performs, without loading the package, and returns the RAW `DESCRIPTION`
## string (`packageVersion()` would normalize `1.7-6` to `1.7.6` and fail every dash pin —
## the same trap the smoke layer documents). So the assertion now compares the pin against
## the version R WILL LOAD. A shadowed copy at a different version is reported as a NOTE,
## because it is worth seeing in the build log and is not by itself wrong.
ip <- as.data.frame(installed.packages()[, c("Package", "Version", "LibPath")], stringsAsFactors = FALSE)
bad <- character(0)
for (p in pins) {
  rows <- ip[ip$Package == p$name, , drop = FALSE]
  if (nrow(rows) == 0L) {
    bad <- c(bad, sprintf("  %-22s NOT INSTALLED (pinned %s)", p$name, p$version))
    next
  }
  got <- tryCatch(as.character(utils::packageDescription(p$name, fields = "Version")),
                  error = function(e) NA_character_)
  if (is.na(got)) {
    bad <- c(bad, sprintf("  %-22s installed but UNRESOLVABLE on .libPaths() (pinned %s)", p$name, p$version))
    next
  }
  if (nrow(rows) > 1L && length(unique(rows$Version)) > 1L) {
    cat(sprintf("note: %s is installed in %d libraries (%s); R resolves %s, which is what is asserted\n",
                p$name, nrow(rows), paste(sprintf("%s in %s", rows$Version, rows$LibPath), collapse = ", "), got))
  }
  if (!identical(got, p$version)) {
    bad <- c(bad, sprintf("  %-22s R resolves %s != pinned %s", p$name, got, p$version))
  }
}
if (length(bad)) {
  stop(sprintf(
    "the installed set does not match requirements.txt:\n%s\n\nEither an upstream moved under the pinned coordinates (CRAN snapshot %s / Bioconductor %s), or a pin is stale. Reconcile the pin file and republish — see docs/runbooks/env-image-republish.md.",
    paste(bad, collapse = "\n"), cran, bioc), call. = FALSE)
}
cat(sprintf("pin assertion: %d/%d packages at their exact pinned versions\n", length(pins), length(pins)))

## ---- freeze the FULL resolved closure INTO the image, BEFORE the trim (the same
## ordering the python recipe's own test asserts for `.txresbench-env-lock.txt`: a freeze that
## ran after a trim can silently produce an empty file, and an empty lock records nothing
## while looking exactly like a lock).
##
## The writer itself is `txr_write_env_lock` in `/tmp/txr-regime.R` above — extracted so
## it can be RUN against fixtures outside a docker build (#192). Its inputs are passed in
## rather than read from the environment, which is what makes that possible.
lock <- "/usr/local/lib/R/.txresbench-env-lock.txt"
counts <- txr_write_env_lock(
  path = lock,
  pins = pins,
  header = c(
    sprintf("# R %s", getRversion()),
    sprintf("# bioconductor %s", bioc),
    sprintf("# cran-snapshot %s", cran),
    sprintf("# direct-pins %d", length(pins))
  ),
  ip = ip,
  resolve_version = function(nm) as.character(utils::packageDescription(nm, fields = "Version")),
  ## The per-package SOURCE (#192 / DEC-7). `installed.packages()` has no `Repository`
  ## column; the package's own `DESCRIPTION` records it, and it is what distinguishes a
  ## package that came from the dated CRAN snapshot from one that came from the
  ## Bioconductor release channel — a difference that decides whether a rebuild reproduces
  ## the version or fails loud. A package that records nothing (a base/recommended package
  ## shipped with R itself) is written `unrecorded` rather than omitted: "R shipped this"
  ## is an answer, and a blank column would read as a bug.
  repo_of = function(nm) tryCatch(utils::packageDescription(nm, fields = "Repository"),
                                  error = function(e) NA_character_),
  priority_of = function(nm) tryCatch(utils::packageDescription(nm, fields = "Priority"),
                                      error = function(e) NA_character_),
  lib_paths = .libPaths()
)

## ---- ENFORCE, don't remember: every DIRECT pin must have come from one of the declared
## coordinates, and a package that did records no `Repository`. Without this, an extra
## `remotes::install_github(...)` or `R CMD INSTALL` line anywhere in this recipe would
## install a tree the version assertion above happily accepts (it compares name+version
## only) and the lock would file under a source token nobody reads. The pin-source gate
## refuses a DECLARED `vcs-head`; this is what stops an UNDECLARED one, which is the half
## of INV-5 the declaration alone cannot cover.
undeclared <- character(0)
for (p in pins) {
  r <- tryCatch(utils::packageDescription(p$name, fields = "Repository"), error = function(e) NA_character_)
  pr <- tryCatch(utils::packageDescription(p$name, fields = "Priority"), error = function(e) NA_character_)
  ok_repo <- length(r) == 1L && !is.na(r) && nzchar(as.character(r))
  ok_base <- length(pr) == 1L && !is.na(pr) && as.character(pr) %in% c("base", "recommended")
  if (!ok_repo && !ok_base) undeclared <- c(undeclared, p$name)
}
if (length(undeclared)) {
  stop(sprintf(
    "these pinned packages record no `Repository` and are not base/recommended, so they did NOT come from a declared pin source: %s\n\nA package installed outside the declared coordinates records an identity nothing can trace, which is the false-pin case requirements.txt's INV-5 note is about. Install it from a declared coordinate, or declare the coordinate it came from (see docs/runbooks/env-image-republish.md 4b).",
    paste(undeclared, collapse = ", ")), call. = FALSE)
}
cat(sprintf("env lock: %d packages (%d shadowed duplicate(s) recorded as comments)\n",
            counts$resolved, counts$shadowed))

## ---- emit the derived smoke list so the layer below can `library()` every pin without
## a second hand-maintained list.
writeLines(names_wanted, "/tmp/txr-smoke-names.txt")
RSCRIPT
Rscript --vanilla /tmp/txr-install.R
TXR_INSTALL

# ── SINGLE-THREADED NUMERICS (INV-6) ─────────────────────────────────────────────────
# The queue runs many jobs concurrently, each with its own CPU ceiling. R's BLAS, OpenMP,
# data.table and BiocParallel each default to "all cores", so an unpinned R job
# oversubscribes every other job on the box. The sandbox already exports
# OMP/OPENBLAS/MKL_NUM_THREADS=1 (`sandbox/sandbox.rs`, whose comment says "Covers R +
# numpy"), but this must hold for ANY entry into this image — including the build-time
# probe below and a local run outside the sandbox — so it is baked into the image's own
# R configuration, which `R_HOME/etc/Renviron.site` and `Rprofile.site` are read from at
# every R start. This is the R analogue of the corpus's `utils/disableParallel.R`.
#
# WRITTEN AFTER THE INSTALL, deliberately: `Ncpus = 1L` in `Rprofile.site` would have
# serialized the install above, which is a build-time concern with the opposite answer.
RUN set -eux; \
    { \
      echo '# Single-threaded numerics (#191 / INV-6) — see the Dockerfile for why.'; \
      echo 'OMP_NUM_THREADS=1'; \
      echo 'OMP_THREAD_LIMIT=1'; \
      echo 'OPENBLAS_NUM_THREADS=1'; \
      echo 'MKL_NUM_THREADS=1'; \
      echo 'GOTO_NUM_THREADS=1'; \
      echo 'BLIS_NUM_THREADS=1'; \
      echo 'VECLIB_MAXIMUM_THREADS=1'; \
      echo 'NUMEXPR_NUM_THREADS=1'; \
      echo 'R_DATATABLE_NUM_THREADS=1'; \
      echo 'RCPP_PARALLEL_NUM_THREADS=1'; \
    } >> /usr/local/lib/R/etc/Renviron.site; \
    { \
      echo ''; \
      echo '## Single-threaded numerics (#191 / INV-6). Appended, not replaced: the base'; \
      echo '## image sets the P3M repo + HTTPUserAgent above and both stay.'; \
      echo 'options(mc.cores = 1L, Ncpus = 1L)'; \
      echo 'local({'; \
      echo '  if (requireNamespace("data.table", quietly = TRUE)) try(data.table::setDTthreads(1L), silent = TRUE)'; \
      echo '  if (requireNamespace("RhpcBLASctl", quietly = TRUE)) try(RhpcBLASctl::blas_set_num_threads(1L), silent = TRUE)'; \
      echo '  if (requireNamespace("BiocParallel", quietly = TRUE)) {'; \
      echo '    try(BiocParallel::register(BiocParallel::SerialParam(), default = TRUE), silent = TRUE)'; \
      echo '  }'; \
      echo '  ## `future` is named in INV-6 and is NOT pinned here — but a transitive can'; \
      echo '  ## pull it in, and its default plan is multicore. Guarded so this is a no-op'; \
      echo '  ## when it is absent and a hard sequential plan the moment it is not.'; \
      echo '  if (requireNamespace("future", quietly = TRUE)) {'; \
      echo '    try(future::plan(future::sequential), silent = TRUE)'; \
      echo '    options(future.globals.maxSize = 2e9)'; \
      echo '  }'; \
      echo '})'; \
    } >> /usr/local/lib/R/etc/Rprofile.site

# ── TRIM ─────────────────────────────────────────────────────────────────────────────
# Follows the python recipe's documented discipline (426 → 316 MB there). The wins, in
# order: strip .so debug symbols; drop the help/doc/HTML/vignette payload no batch job
# reads; drop the `-dev` headers and the compiler toolchain, which exist only to BUILD
# the Bioconductor half and must not ship (nothing installs at run time — the sandbox is
# `--unshare-net`, so a compiler in the image is dead weight with a CVE surface).
#
# KEPT deliberately: every package's `data/`, `extdata/` and `R/` — several of the
# spatial packages load bundled datasets and R metadata at runtime, so deleting them is
# the over-trim that fails the smoke line below rather than a user's job.
#
# `apt-get autoremove` is NOT run: it would drop runtime shared libraries that the
# compiled R packages link against but apt cannot see, which is a broken image that
# passes every apt-level check. The `-dev` packages are purged by name instead, and the
# check below walks EVERY name in that list rather than a hardcoded sample of three.
#
# THE PURGE LIST IS NOT THE WHOLE STORY, AND `/usr/include` IS WHY. `--auto-remove=false`
# means apt keeps the transitive `-dev` packages the named ones pulled in — 85 of them
# survive the purge, and with them **239 MB of C/C++ headers** inside what was a 693 MiB image,
# roughly a third of it. The layer's own message used to claim the purge stops "headers, a
# compiler and its CVE surface" from shipping; the compiler binaries are genuinely gone
# (`gcc`/`g++`/`gfortran`/`ld`/`ar`/`strip` are all absent), the headers were not, and
# nothing said so. `/usr/include` is now removed outright and the removal is asserted:
# nothing compiles at run time (the sandbox is `--unshare-net`), the build-time smoke
# below loads all 18 packages AFTER this layer, so an over-trim fails the IMAGE build
# rather than a user's job. R's own package `include/` trees are deliberately LEFT — they
# are small and some packages ship linking headers other packages read at install time.
#
# EVERY `|| true` BELOW IS SCOPED, and the two that used to swallow a TOTAL failure no
# longer do. `strip … 2>/dev/null || true` reported success when `strip` was not on PATH
# at all, and `apt-get purge … || true` reported success when the purge did nothing; in
# both cases the image simply shipped bigger, with a compiler toolchain still in it, and
# nothing said so. The `|| true` on the per-file `strip` is still right (a handful of
# `.so`s legitimately refuse to be stripped) — so the TOOL's presence and the purge's
# EFFECT are asserted instead, which is the part that cannot be a partial failure.
#
# THE REAL ASSERTION IS A POST-CONDITION, NOT A SIZE DELTA. `after < before` is not
# idempotent (over already-stripped content the sizes are equal and a correct trim fails);
# `after <= before` is idempotent but toothless — a blind audit replaced `strip` with
# `#!/bin/sh\nexit 0` and the layer stayed GREEN, printing `811238 KiB -> 811238 KiB`,
# which is exactly the silent no-op the layer's own message names. So the layer now checks
# what stripping is FOR: after the pass, ZERO shared objects may still carry a `.symtab`
# (measured on the shipped image: 0 of 211). That is checkable, idempotent, and a stubbed
# `strip` fails it immediately. `readelf` is available here because binutils is still
# installed — it is purged further down this same layer.
RUN set -eux; \
    command -v strip >/dev/null || { echo 'FAILED: strip is not on PATH — the debug-symbol trim would silently do nothing and the image would ship tens of MB of symbols. binutils is installed above; if it moved, fix the trim rather than tolerating it.' >&2; exit 1; }; \
    command -v readelf >/dev/null || { echo 'FAILED: readelf is not on PATH. The post-condition below COUNTS shared objects that still carry a .symtab; with no readelf every probe fails, the count is 0, and the layer reports success while nothing was stripped. `elfutils` ships a /usr/bin/strip and no readelf, so this is a real substitution, not a hypothetical.' >&2; exit 1; }; \
    readelf -S /usr/local/lib/R/bin/exec/R 2>/dev/null | grep -q ' \.text ' || { echo 'FAILED: readelf is present but its section output is not the format this check parses (llvm-readelf spells sections differently). A parse that matches nothing counts nothing, which reads as a clean strip.' >&2; exit 1; }; \
    sos=$(find /usr/local/lib/R \( -name '*.so' -o -name '*.so.*' \) | wc -l); \
    [ "$sos" -gt 0 ] || { echo 'FAILED: the shared-object walk matched nothing under /usr/local/lib/R. Either the library moved or the pattern is wrong; either way the strip below is a no-op nobody would notice.' >&2; exit 1; }; \
    before=$(du -sk /usr/local/lib/R | cut -f1); \
    find /usr/local/lib/R \( -name '*.so' -o -name '*.so.*' \) -print0 | xargs -0 -r strip --strip-unneeded 2>/dev/null || true; \
    after=$(du -sk /usr/local/lib/R | cut -f1); \
    printf 'strip: %s shared object(s), %s KiB -> %s KiB\n' "$sos" "$before" "$after"; \
    [ "$after" -le "$before" ] || { echo 'FAILED: the strip pass GREW the tree.' >&2; exit 1; }; \
    symtabs=$(find /usr/local/lib/R \( -name '*.so' -o -name '*.so.*' \) -print0 \
        | xargs -0 -r -n1 sh -c 'readelf -S "$0" 2>/dev/null | grep -q " .symtab " && echo "$0"' | wc -l); \
    printf 'strip: %s of %s shared object(s) still carry a .symtab\n' "$symtabs" "$sos"; \
    [ "$symtabs" -eq 0 ] || { echo 'FAILED: stripping did not remove the symbol tables it exists to remove. `strip` is present and the walk found files, so it ran and did nothing — which is the state a size check cannot see and a POST-CONDITION can.' >&2; exit 1; }; \
    find /usr/local/lib/R/site-library -mindepth 2 -maxdepth 2 -type d \
        \( -name 'doc' -o -name 'html' -o -name 'help' -o -name 'tests' -o -name 'examples' -o -name 'doc-src' \) \
        -prune -exec rm -rf {} + 2>/dev/null || true; \
    find /usr/local/lib/R/library -mindepth 2 -maxdepth 2 -type d \
        \( -name 'doc' -o -name 'html' \) -prune -exec rm -rf {} + 2>/dev/null || true; \
    rm -rf /usr/local/lib/R/doc /usr/share/doc /usr/share/man /usr/share/info \
           /usr/local/lib/R/site-library/*/libs/*.a /root/.cache /tmp/Rtmp* ; \
    TXR_PURGED='libcurl4-openssl-dev libssl-dev libxml2-dev zlib1g-dev libbz2-dev liblzma-dev libglpk-dev libgsl-dev libfftw3-dev libgeos-dev libudunits2-dev libproj-dev libgdal-dev libpng-dev libjpeg-dev libtiff5-dev libfontconfig1-dev libfreetype6-dev libharfbuzz-dev libfribidi-dev libmagick++-dev libcairo2-dev binutils'; \
    n_purge=$(printf '%s\n' $TXR_PURGED | grep -c .); \
    [ "$n_purge" -ge 20 ] || { echo "FAILED: the purge list holds $n_purge package(s); the recipe apt-installs a ~23-package build toolchain above and every one of them must be named here. An EMPTY or truncated list makes BOTH the purge and the check below no-ops — the toolchain ships and nothing is red, which is the exact shape this floor exists to catch (the .so walk twelve lines up has the same floor for the same reason)." >&2; exit 1; }; \
    apt-get purge -y --auto-remove=false $TXR_PURGED >/dev/null 2>&1 || true; \
    for pkg in $TXR_PURGED; do \
        if dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q 'install ok installed'; then \
            echo "FAILED: apt-get purge left \`$pkg\` installed. The purge is best-effort per package (hence the || true) and this checks EVERY name it was asked to remove: a compiler and its headers have no use inside a sandbox with no network, and they carry a CVE surface that outlives them." >&2; \
            exit 1; \
        fi; \
    done; \
    hdr_before=$(find / -xdev -name '*.h' -not -path '/proc/*' | wc -l); \
    rm -rf /usr/include; \
    hdr_after=$(find / -xdev -name '*.h' -not -path '/proc/*' | wc -l); \
    printf 'headers: %s -> %s (.h files image-wide)\n' "$hdr_before" "$hdr_after"; \
    [ ! -d /usr/include ] || { echo 'FAILED: /usr/include survived the trim.' >&2; exit 1; }; \
    [ "$hdr_after" -lt "$hdr_before" ] || { echo 'FAILED: removing /usr/include freed no headers image-wide. `[ ! -d /usr/include ]` alone is a claim about a PATH, and `mv /usr/include /usr/local-include` satisfies it with every byte still in the image. This counts the bytes instead.' >&2; exit 1; }; \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb

# ── SELF-CONTAINMENT UNDER /usr — R MUST START WITHOUT /etc ─────────────────────────
#
# THE DEFECT THIS CLOSES, found by running it rather than reading it. Debian/Ubuntu route
# BLAS and LAPACK through `update-alternatives`:
#
#   /usr/lib/x86_64-linux-gnu/libblas.so.3
#     -> /etc/alternatives/libblas.so.3-x86_64-linux-gnu
#     -> /usr/lib/x86_64-linux-gnu/openblas-pthread/libblas.so.3
#
# The middle hop LEAVES /usr. `sandbox::sandbox` binds the rootfs `/usr` with a hard
# `--ro-bind` and everything else with `--ro-bind-try` — including
# `<rootfs>/etc/alternatives`. `-try` means SILENTLY SKIPPED when the path is not there.
# So an image whose R depends on that hop starts only by the grace of an optional bind,
# and when the bind does not happen R does not fail gracefully:
#
#   /usr/local/lib/R/bin/exec/R: error while loading shared libraries: libblas.so.3:
#   cannot open shared object file: No such file or directory
#
# — i.e. "R is broken", from inside a sandbox, for a reason nothing in the image names.
# That is the same failure SHAPE this whole epic exists to eliminate, one layer down.
#
# So every symlink under /usr that leaves /usr through /etc/alternatives is re-pointed at
# its FULLY RESOLVED target (36 of them as built, not the two that bit first — written as
# a walk because the next R package to pull an alternatives-managed library would
# reintroduce the identical failure under a different name), and any survivor FAILS the
# build. `readlink -f` is correct here and only here: inside the image the rootfs IS `/`,
# so it resolves the chain exactly as the runtime will see it.
#
# Verified by `scripts/verify-r-rootfs-local.sh`, which runs R with NO /etc binds at all.
RUN set -eux; \
    fixed=0; \
    for l in $(find /usr -type l); do \
        case "$(readlink "$l")" in \
            /etc/alternatives/*) \
                real="$(readlink -f "$l" 2>/dev/null || true)"; \
                if [ -n "$real" ] && [ -e "$real" ]; then \
                    ln -sfn "$real" "$l"; \
                    fixed=$((fixed + 1)); \
                fi; \
                ;; \
        esac; \
    done; \
    printf 're-pointed %s /usr symlink(s) off /etc/alternatives\n' "$fixed"; \
    remaining="$(find /usr -type l -lname '/etc/alternatives/*' | wc -l)"; \
    if [ "$remaining" -ne 0 ]; then \
        printf 'FAILED: %s /usr symlink(s) still resolve through /etc/alternatives:\n' "$remaining" >&2; \
        find /usr -type l -lname '/etc/alternatives/*' >&2; \
        printf 'The sandbox binds <rootfs>/etc/* with --ro-bind-TRY, so each of these is a library that disappears when that optional bind does not happen.\n' >&2; \
        exit 1; \
    fi; \
    ls /usr/lib/*/libblas.so.3 >/dev/null || { echo 'control: no libblas.so.3 under /usr/lib — the walk had no subject' >&2; exit 1; }

# ── TEST-E3-2 / TEST-E3-3 [acceptance] — the build-time smoke ────────────────────────
# EVERY pinned package `library()`-loads AND reports its pinned version, INSIDE the image,
# AFTER the trim. A broken or over-trimmed env therefore fails the IMAGE build, not a
# user's job (INV-4), and the correspondence between "what is pinned" and "what is
# verified" is derived from the pin file rather than remembered — the failure mode the
# python recipe's `test_rootfs_deps.py` exists to catch ("an install the smoke line does
# not verify silently ships absent") cannot occur here by construction.
#
# **NOT `--vanilla` from here on, and that is the whole point.** `--vanilla` implies
# `--no-environ --no-site-file`, so it SKIPS `Renviron.site` and `Rprofile.site` — the two
# files the layer above just wrote. A smoke that ran under `--vanilla` would be measuring
# an R this image never runs: the sandbox invokes `Rscript /code/entry.R` plainly
# (`sandbox/spec.rs`), site files honoured. `--vanilla` is correct for the INSTALL layer
# (it runs before that configuration exists and must not depend on it) and wrong for every
# layer whose job is to observe it.
RUN <<'TXR_SMOKE'
set -eux
cat > /tmp/txr-smoke.R <<'RSCRIPT'
## THE FOURTH PARSER IS GONE. This stage used to re-implement the pin grammar inline — a
## second regex, a second >=10 floor, and, unlike `txr_parse_pins`, a silent
## `m <- m[lengths(m) == 4L]` that DROPPED every line it could not read instead of
## refusing. So "what is pinned" and "what is verified at build time" were derived by two
## parsers with nothing holding them together, and an audit narrowed this copy until the
## smoke verified ONE of the eighteen packages with every suite still green.
##
## It now sources the same block the installer uses and the tests execute. One parser, one
## floor, one refusal path.
source("/tmp/txr-regime.R")
m <- txr_parse_pins(txr_read_pin_lines("/tmp/requirements.txt"))
bad <- character(0)
for (r in m) {
  lib <- r$import; want <- r$version
  ok <- suppressWarnings(suppressMessages(require(lib, character.only = TRUE, quietly = TRUE)))
  if (!ok) { bad <- c(bad, sprintf("  %-22s library() FAILED", lib)); next }
  ## The RAW DESCRIPTION string, not `as.character(packageVersion())` — the latter
  ## normalizes R's `-` separator to `.` (`1.7-6` becomes `1.7.6`) and would compare a
  ## normalized value against a raw pin.
  got <- as.character(utils::packageDescription(lib, fields = "Version"))
  if (!identical(got, want)) bad <- c(bad, sprintf("  %-22s loaded %s != pinned %s", lib, got, want))
}
if (length(bad)) stop(sprintf("build-time smoke FAILED:\n%s", paste(bad, collapse = "\n")), call. = FALSE)
cat(sprintf("R analysis stack OK — %d pinned packages load at their pinned versions\n", length(m)))
RSCRIPT
Rscript /tmp/txr-smoke.R
TXR_SMOKE

# An EXPLICIT `library()` line naming every pinned package, alongside the derived check
# above. It is redundant for this recipe's own correctness and that is fine: it exists so
# a cross-recipe pin ⇄ smoke correspondence guard (#196 / PROV-E8-3) has the same shape to
# match in both recipes and does not have to special-case this one. It is kept in step with
# the pin file IN BOTH DIRECTIONS by
# `test_every_pin_is_named_on_the_explicit_smoke_line`.
#
# The marker below is #196's declared INTERFACE for "this is the instruction that LOADS
# every pinned distribution" (`env_image.rs::SMOKE_MARKER` = `txr:env-smoke`, required on
# its own line immediately above the instruction). It sits on THIS line and not on the
# derived heredoc above, deliberately: the derived check names no package, and a
# correspondence guard keyed on each pin's own `# import=` token needs a surface where
# those tokens actually appear. Conforming to that interface is this recipe's side of the
# coordination with #196 — the guard itself is #196's file and is not touched here.
# txr:env-smoke
RUN Rscript -e "library(BiocManager); library(Matrix); library(jsonlite); library(bit64); library(digest); library(BiocParallel); library(SingleCellExperiment); library(scDblFinder); library(SpatialExperiment); library(edgeR); library(DESpace); library(spacexr); library(spicyR); library(Statial); library(spatstat); library(lme4); library(refund); library(spatialFDA); cat('explicit smoke OK\n')"

# ── TEST-E3-9 [acceptance] [invariant: INV-6] — one thread, MEASURED ─────────────────
# R is RUN and asked what it resolves to, rather than the config being grepped. A config
# that is present but not read is exactly the failure a grep cannot see — and the FIRST
# version of this layer contained that very failure: it ran under `--vanilla`, which skips
# both site files, so it was asking an R that could not see the configuration under test.
# Run plainly, exactly as the sandbox does.
RUN <<'TXR_THREADS'
set -eux

# ── CONTROL HALF 1, RUN IN THE SHELL AND NOT IN R ────────────────────────────────────
# The claim this layer makes is "`Renviron.site` is what pins the numeric threads". The
# way that claim goes false is an `ENV R_DATATABLE_NUM_THREADS=1` (or an inherited
# process environment) supplying the same value, leaving `Renviron.site` unread and
# unnoticed. The discriminator therefore has to be asked OUTSIDE R: in a plain shell
# these variables must be UNSET, because nothing in the image environment sets them.
#
# THIS CANNOT BE ASKED FROM AN R CHILD, and that is worth stating because the obvious
# version of this control is wrong. `--vanilla` implies `--no-environ`, which stops the
# child from READING `Renviron.site` — it cannot unset what the child INHERITS. R
# `putenv`s the site file's entries into its own process, so a `system2("Rscript",
# "--vanilla", …)` spawned from the configured parent inherits `R_DATATABLE_NUM_THREADS=1`
# regardless. An earlier cut of this layer asserted the child saw it EMPTY and would have
# failed the build on a perfectly correct image. Spawning with `env -u` would not help
# either: that erases the variable whether it came from the site file or from a Docker
# `ENV`, which is exactly the distinction being drawn.
for v in OMP_NUM_THREADS OPENBLAS_NUM_THREADS MKL_NUM_THREADS R_DATATABLE_NUM_THREADS; do
    eval "val=\${$v-}"
    if [ -n "$val" ]; then
        echo "control failed: $v=$val is set in the IMAGE ENVIRONMENT (a Docker ENV or an inherited process env), not by Renviron.site. The R probe below would then report 1 for a reason this layer is not testing, and Renviron.site could be deleted without anything going red." >&2
        exit 1
    fi
done
printf 'control: the image environment sets none of the thread variables (so R is their only source)\n'

cat > /tmp/txr-threads.R <<'RSCRIPT'
v <- c(OMP_NUM_THREADS = Sys.getenv("OMP_NUM_THREADS"),
       OPENBLAS_NUM_THREADS = Sys.getenv("OPENBLAS_NUM_THREADS"),
       MKL_NUM_THREADS = Sys.getenv("MKL_NUM_THREADS"),
       R_DATATABLE_NUM_THREADS = Sys.getenv("R_DATATABLE_NUM_THREADS"))
bad <- names(v)[v != "1"]
if (length(bad)) {
  stop(sprintf("not single-threaded: %s", paste(sprintf("%s=%s", bad, v[bad]), collapse = ", ")), call. = FALSE)
}
if (!identical(getOption("mc.cores"), 1L)) stop("mc.cores is not 1", call. = FALSE)
w <- BiocParallel::bpnworkers(BiocParallel::bpparam())
if (!identical(as.integer(w), 1L)) {
  stop(sprintf("BiocParallel default is %s workers, not 1", w), call. = FALSE)
}
## CONTROL HALF 2 — `Rprofile.site` is the source of the OPTIONS half.
##
## Scoped deliberately to `mc.cores`, and the scope is the correction. An option is NOT
## inherited by a child process, so `--vanilla` (which implies `--no-init-file
## --no-site-file`) genuinely observes an R that never read `Rprofile.site`: the option
## must be NULL there and 1L above, and no environment can fake either. The ENVIRONMENT
## half cannot be tested this way at all — R exports `Renviron.site`'s entries into its own
## process, so any child inherits them whatever flags it is given — and it is asserted in
## the shell, before R starts, at the top of this layer.
out <- suppressWarnings(system2("Rscript", c("--vanilla", "-e",
  shQuote('cat(sprintf("CTRL[mc=%s]", is.null(getOption("mc.cores"))))')),
  stdout = TRUE, stderr = TRUE))
frame <- grep("^CTRL\\[", out, value = TRUE)
if (length(frame) != 1L) {
  stop(sprintf("control failed: the --vanilla probe emitted no CTRL frame (%s) — it did not run, so it proves nothing", paste(out, collapse = " ")), call. = FALSE)
}
if (!identical(frame, "CTRL[mc=TRUE]")) {
  stop(sprintf("control failed: --vanilla still sees mc.cores (%s), so this layer cannot tell 'Rprofile.site is read' from 'the option came from somewhere else'", frame), call. = FALSE)
}
cat("single-thread pinning OK (BLAS/OpenMP/data.table/mc.cores/BiocParallel = 1; the --vanilla control confirms Rprofile.site is the source of the options half, and the shell control above confirms the image environment is the source of none of it)\n")
RSCRIPT
Rscript /tmp/txr-threads.R
TXR_THREADS

# Schema marker read by the runtime mount probe (must equal ROOTFS_SCHEMA_VERSION).
# NOT bumped for a second image — see the header, and
# `server/src/modules/rootfs/version.rs`'s own note on why a bump would be harmful.
ARG ROOTFS_SCHEMA_VERSION=5
# EVERY build-time artifact leaves with this layer. `/tmp/requirements.txt` and the two
# generated `.R` probes were shipping INSIDE the squashfs — 39 KiB, so not a size problem,
# but they are build inputs sitting in a runtime image, `/tmp` is a tmpfs the sandbox
# mounts over anyway, and a stale copy of the pin file inside the image is a second source
# of truth for exactly the question `requirements.txt` exists to answer. The layer then
# ASSERTS /tmp is empty, because a `rm -f` of a path that moved is silent.
RUN set -eux; \
    printf '%s\n' "$ROOTFS_SCHEMA_VERSION" > /.txresbench-sandbox-rootfs-schema; \
    rm -f /tmp/txr-install.R /tmp/txr-regime.R /tmp/txr-smoke-names.txt \
          /tmp/txr-smoke.R /tmp/txr-threads.R /tmp/requirements.txt; \
    left="$(find /tmp -mindepth 1 -print)"; \
    if [ -n "$left" ]; then \
        printf 'FAILED: build artifacts remain in /tmp and would ship inside the squashfs:\n%s\n' "$left" >&2; \
        exit 1; \
    fi

# ---------------------------------------------------------------------------
# Stage 2 — pack into a squashfs inside the container (host lacks squashfs-tools),
# and ENFORCE the size budget.
# ---------------------------------------------------------------------------
# Same packer settings as the python recipe: zstd -Xcompression-level 22 -b 1M, chosen
# there because xz is ~20 MB smaller but has slower random reads, which is the wrong
# trade for a filesystem that is MOUNTED and read at run time.
FROM debian:bookworm-slim AS packer
RUN apt-get update && apt-get install -y --no-install-recommends squashfs-tools && rm -rf /var/lib/apt/lists/*
COPY --from=rootfs / /rootfs

# TEST-E3-5 [acceptance] — the size budget is ENFORCED, not documented.
#
# The number is MEASURED, not estimated. As built on 2026-09-03 this recipe packs to
# **680.8 MiB** (713,859,072 bytes, zstd -Xcompression-level 22 -b 1M, x86_64), against the
# python sibling's ~316 MB. It was 692.9 MiB before the trim layer stopped shipping
# `/usr/include`: 239 MB of headers, which zstd -22 compresses roughly 20:1, so the packed
# artifact fell only ~12 MB while the MOUNTED rootfs shrank by 239 MB. 800 MiB is the
# measurement plus headroom, and the method + the numbers are recorded in
# `docs/runbooks/env-image-republish.md` §4a — in the
# RUNBOOK rather than in a lifecycle artifact, because lifecycle artifacts are stripped at
# merge and a budget whose justification vanishes is a number nobody can defend.
#
# The headroom is deliberately narrow: a pin upgrade that adds a few MB passes, and adding
# a Bioconductor sub-universe (hundreds of MB) fails. Raising it is a decision someone
# makes and records, not something a build does silently. Mutation-checked — built with
# ROOTFS_MAX_MB below the measured size, the build goes RED with both numbers named.
ARG ROOTFS_MAX_MB=800
RUN set -eux; \
    mksquashfs /rootfs /rootfs.squashfs \
        -comp zstd -Xcompression-level 22 -b 1M -noappend -no-progress -all-root \
        -e rootfs.squashfs; \
    bytes=$(stat -c%s /rootfs.squashfs); \
    mb=$(( (bytes + 1048575) / 1048576 )); \
    printf 'packed squashfs: %s MB (budget %s MB)\n' "$mb" "$ROOTFS_MAX_MB"; \
    if [ "$mb" -gt "$ROOTFS_MAX_MB" ]; then \
        printf 'BUDGET EXCEEDED: the packed rootfs is %s MB, over the %s MB budget.\n' "$mb" "$ROOTFS_MAX_MB" >&2; \
        printf 'Trim the recipe, drop a package, or make a deliberate, recorded decision to raise ROOTFS_MAX_MB — an env image nobody will wait to fetch is an env image nobody uses.\n' >&2; \
        exit 1; \
    fi; \
    printf '%s\n' "$mb" > /rootfs.squashfs.mb
