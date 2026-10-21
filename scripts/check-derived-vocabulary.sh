#!/usr/bin/env bash
#
# check-derived-vocabulary.sh — the N+1-proof "the app core never learns the domain"
# guard (artifact-model ITEM-21, INV-5). The DERIVED successor to
# `check-kinds-zero-core.sh`, whose mechanism this generalizes rather than replaces.
#
# ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────
# `check-kinds-zero-core.sh` HARD-CODES three kind ids
# (`geneset/collection|graph/attributed|de/result`). It therefore catches exactly the
# domain terms somebody remembered to type into it, and the N+1 term — the id a
# processor contributes TOMORROW — leaks into app-core silently, with the guard
# printing PASS. That is the same drift `lint-no-domain-in-builtin.mjs` already
# recorded and fixed on the frontend side (its `contributedDatatypes()` reads the
# manifests; see its WS-R5 G2 note: a hardcoded mirror of DATA had drifted in BOTH
# directions at once — one listed id no longer shipped, five shipped ids were absent).
#
# This guard derives its forbidden vocabulary from the SAME source the extensions
# loader reads: every `contributes.datatypes[].id` in every
# `src-app/packages/*/manifest.yaml`. A new processor's vocabulary is forbidden the
# moment it is DECLARED, with ZERO edits to this file. A removed processor's
# vocabulary drops out the same way.
#
# ── WHAT IS EXCLUDED, AND WHY IT IS EXCLUDED BY CONSTRUCTION ────────────────────
# Mirrors `check-kinds-zero-core.sh` exactly:
#   * a CONTRIBUTED processor package (`src-app/packages/<pkg>/**`) — the DATA. Not a
#     surface at all, so the manifests can never be scanned against themselves (a
#     category error: the manifest IS the declaration of the vocabulary), and a domain
#     package's own domain vocabulary is exactly what it is FOR.
#   * TEST code — excluded STRUCTURALLY, four ways, never by naming a file:
#       - any path segment `tests/`, `testdata/` or `fixtures/`
#       - `src-app/server/tests/**` is not a SURFACE_ROOT
#       - in-source `#[cfg(test)]` items and `#[test]` / `#[tokio::test]` fns are
#         blanked by the stripper before matching (this is what keeps the sibling
#         grep-guard `workstore/no_legacy_wire.rs`, which must SPELL the vocabulary
#         it searches for, from being a leak — the same self-reference exemption
#         `lint-no-domain-in-builtin.mjs` grants its own forbidden-string list)
#       - a Python test module, per PYTEST'S OWN declaration of what one is: the
#         `python_files` glob read out of the package's `pytest.ini` (derived, not typed
#         here, for the same reason the vocabulary is derived — a rule spelled in the
#         guard drifts from the rule the tree actually runs under)
#   A dispatch cannot be hidden in a test, because a test cannot be reached from
#   production code.
#
# ── THE BLIND SPOT THIS CLOSED: FRAMEWORK CODE LIVING UNDER packages/ ──────────
# `src-app/packages/**` was excluded WHOLESALE, and `src-app/packages/_lib/` is not
# data — it is the FRAMEWORK output-format library, staged by the server into EVERY
# processor's `/code`. So anything it names, it names on behalf of every producer that
# will ever exist: it is precisely the "core" INV-5 is about, and it was unscanned.
# Measured cost of the gap: `cyto_columns.py` defaulted `axis` to a single-cell axis name
# and both `write_embedding`'s member `name` and its emitted `meta.kind` to a contributed
# datatype id — a framework library authoring the producer's `structure.axis`, with the
# guard printing PASS.
#
# The framework packages are therefore their own scanned surface, with their own floors,
# while every CONTRIBUTED package stays excluded. The line is ownership, not location: a
# contributed package's domain vocabulary is legitimate; framework code has none.
#
# ── AND THE SURFACE IS DERIVED, BECAUSE A LIST FALLS ONE RING BEHIND EVERY TIME ──
# That surface was first written as a LIST holding one entry, `_lib`. Which is the same
# defect this whole guard exists to retire, one level up: `check-kinds-zero-core.sh`
# hard-codes the TERMS and misses the N+1st term; a hard-coded ROOT misses the N+1st
# framework package. It did — `_helpers` is app-owned framework in exactly the same
# sense (its `align.py` / `colsummary.py` are in the server's `PY_HELPER_FILES`, staged
# into EVERY Python entry, a WIDER radius than `_lib/conformance.py`'s entry-scoped
# staging) and it was unscanned. Cost of that gap, measured: three contributed-datatype
# literals in `_helpers/compute/demo-analysis.py`, one of them added while this guard
# stood next to it printing PASS. Fourth instance of the class.
#
# So the roots are DERIVED, from the same structural fact the extensions loader uses: a
# `_`-prefixed package under `src-app/packages/` is RESERVED. `ExtensionRegistry::
# build_from_dir` SKIPS `_`-prefixed dirs, so such a package can contribute no datatype,
# converter or view — which is precisely why it can have no LEGITIMATE domain vocabulary,
# and why the derivation is a definition rather than a heuristic. A new reserved package
# is scanned the day it lands, with zero edits here.
#
# The derivation is itself CHECKED, against the server constants that name the reserved
# packages (`RESERVED_*_PACKAGE` in `sandbox/processors/mod.rs`): a package the server
# names but the glob did not find is a FAIL, not a silent one-ring-behind. That is the
# ring the package glob is derived at, and the reason it is checked one ring further in.
#
# Deliberately NOT derived from `PY_HELPER_FILES` / `RESERVED_ENTRY_HELPERS` alone (what
# the server literally STAGES), even though that is the narrower and more precise notion
# of "speaks on behalf of every producer": staging is a per-FILE table, so deriving from
# it would drop the app-run ENTRIES (`_lib/verify_conformance.py`,
# `_helpers/compute/demo-analysis.py`) out of a surface that already covered one of them.
# A guard must never cover LESS than it did. The package ring is the outermost ring with
# a structural definition, so it is the one that cannot fall behind.
#
# NOTE on the Python dialect: `#` comments are stripped, DOCSTRINGS ARE NOT. A docstring is
# a string object — it can be `json.loads`ed or emitted — so exempting triple-quoted blocks
# would be a genuine fail-open, not a prose courtesy. The consequence is deliberate: prose
# in framework code must DESCRIBE a contributed datatype id rather than spell it. Fail-
# closed, and stated at the top of `cyto_columns.py` where an author meets it.
#
# ── MATCHING ────────────────────────────────────────────────────────────────────
# Two tiers, both DERIVED — no term is ever typed into this file:
#   * COMPOUND id (contains `/` or `-`, e.g. `single-cell/expression`, `cell-set`) —
#     matched as a raw substring with a token boundary on BOTH sides. The boundary is
#     what keeps `metadata-column-family` (a registry CAPABILITY id, a different
#     token) from reading as a hit on the datatype id `metadata-column`.
#   * BARE id (a single generic word, e.g. `embedding`, `clustering`) — matched ONLY
#     as a quoted string literal (`"embedding"` / `'embedding'`), because a bare
#     substring match on an English word is pure noise. A hardcoded quoted literal is
#     precisely the shape of the bug this invariant exists to stop (design D20: "the
#     bug was the hardcoded SQL literal").
# Comments are stripped string-aware (a `//` inside a `"https://…"` literal does NOT
# blank the rest of the line — that exact naive-tokenizer bug was a live FAIL-OPEN in
# the sibling JS guard).
#
# ── FLOORS (a guard that scans nothing must FAIL, not congratulate itself) ───────
# Measured 2026-07-29: 19 contributed datatypes across 3 packages; 182 app-core files;
# 10 non-test framework modules across 2 reserved packages. Floors sit ~2/3 of the
# measurement (the WS-R3 margin rule) so a rename or a broken parse trips them long before
# the guard silently forbids less.
#
# ── AND ONE CHECK THAT IS NOT ABOUT A BROKEN PARSE (#196 / INV-6) ──────────────
# Every derivation above re-reads the SAME manifests that DEFINE the vocabulary. So on a
# declaration-side change both sides move together and the derivation cannot see it:
# delete `env: <id>` from a manifest and this guard simply forbids one term fewer, in
# silence. `docs/design/derived-guards.md` §4 records that correction, proved by mutating
# a shipped declaration away and watching every derived check stay green — *"a derivation
# whose two sides read the same source is a tautology in the direction that source
# changes… put a frozen anchor across exactly that direction."*
#
# The anchor is NOT a count. It was one (`MIN_ENV_DECLS`, a floor on total declaration
# SITES) and a blind audit defeated it: a total is global, so declarations added by an
# UNRELATED package create permanent slack and both shipped declarations could then be
# deleted at exit 0. A floor over a global total defends no PARTICULAR declaration.
#
# It is now a DERIVED CROSS-CHECK against a SECOND, INDEPENDENT source: every recipe that
# ships under `src-app/env-rootfs/<id>/` must still be declared by some manifest. Deleting
# a declaration does not delete the recipe, so the two sources diverge — which is exactly
# the direction §4 says a single-source derivation is blind to. No slack can be borrowed,
# because the check is per RECIPE and another package's env cannot satisfy this one's.
#
# And there is no number left to drift. That matters concretely: two branches in this repo
# each correctly lowered a hand-maintained counter 12 -> 11, git merged the two identical
# lines with no conflict, and TWO removals produced ONE decrement. A derived per-unit
# assertion has nothing to edit, so it cannot drift through a clean merge.
#
# `MIN_ENVS` stays, doing the different job it always did: anti-vacuity on a COLLAPSED
# parse. `MIN_ENV_RECIPES` is the same anti-vacuity guarantee for the recipe walk.
#
# Exit 0 = clean. 1 = a leak or a collapsed scan set (both printed). 2 = not a repo.
set -u
cd "$(git rev-parse --show-toplevel)" || exit 2

# ── the DATA (never scanned; only parsed) ───────────────────────────────────────
PROCESSORS_DIR='src-app/packages'

# ── the APP-CORE surface (default-deny at the FILE axis: whole roots, so a NEW
#    app-core file is scanned on arrival — no per-file allow-list to forget) ──────
SURFACE_ROOTS=(
  'src-app/server/src'
  'src-app/server/build_helper'
  'src-app/server/build.rs'
  'src-app/desktop/tauri/src'
)

# The FRAMEWORK code that lives under `packages/` — app-core in every sense except its
# path. Scanned as `.py`; kept as its own surface (with its own floors) so a collapse in
# either surface is separately detectable, and so the app-core floor keeps meaning what it
# measured.
#
# DERIVED, never listed (see the header): every `_`-prefixed RESERVED package that carries
# a `manifest.yaml`. `manifest.yaml` is what makes a directory a package at all (the seed
# extractor + the S1 manifest lint both key on it), and it is also what keeps `__pycache__`
# and other incidental `_`-named directories out.
#
# The server source that NAMES the reserved packages, used to check the derivation one ring
# in: a package the server names but this glob did not find means the two disagree, and the
# guard fails rather than scanning one package fewer.
SERVER_PROCESSORS_RS='src-app/server/src/modules/sandbox/processors/mod.rs'

FRAMEWORK_LIB_ROOTS=()
while IFS= read -r mf; do
  [ -n "$mf" ] || continue
  FRAMEWORK_LIB_ROOTS+=("$(dirname "$mf")")
done <<EOF
$(git ls-files --cached --others --exclude-standard -- "$PROCESSORS_DIR" 2>/dev/null |
    grep -E '^'"$PROCESSORS_DIR"'/_[^/]+/manifest\.yaml$' | sort -u)
EOF

# ── THE BUILD SURFACE: the recipes + shell that STAND UP the app ────────────────
# `justfile` and the repo-root `scripts/*.sh` are app-core in the only sense that
# matters here — they are shipped tooling that every domain must be able to reuse
# unchanged — and NOTHING scanned them. Measured cost of that gap: the default env-id
# was a literal in TWO places (`scripts/fetch-env-rootfs.sh`'s `ENV_ID=…` fallback and
# `justfile`'s `env-rootfs ENV_ID=…` parameter default), so a second analysis domain
# could not be added without editing a build recipe — the exact property INV-5 asserts,
# violated on the one tier no guard looked at.
#
# ── AND THE SURFACE IS THE WHOLE OF `scripts/`, NOT AN EXTENSION LIST (#304) ────
# The build surface was `justfile` + `scripts/*.sh`, so the nine pinned `scripts/*.mjs`
# guards were scanned by nothing. Measured cost of that gap: `check-viz-producer-
# magnitudes.mjs` hard-coded a contributed datatype id (#303) and sat on `main` while THIS
# guard printed PASS over it.
#
# The first cut of the repair added `scripts/*.mjs` as a third glob, and a blind audit
# refused it — correctly, and on this guard-s own stated grounds. An extension list IS an
# enumeration of the set the guard ranges over, so it drifts exactly the way a term list
# does: with `*.sh` + `*.mjs` typed here, a planted id in `scripts/coercion-parity-kernel.py`
# — a real, PINNED build script — exited 0, and so did one in a `.bash` file. That is the
# same one-ring-behind failure the FRAMEWORK roots were derived to escape, one tier out.
#
# So the surface is DERIVED from the structural fact instead: `justfile`, plus EVERY file
# git tracks under `scripts/`. That is the repo-root build tooling, and being under
# `scripts/` is what makes a file part of it — the same definition `check-guard-integrity.sh`
# and the justfile already work from. A build script in a language nobody has used yet is
# scanned the day it lands, with zero edits here.
#
# The DIALECT is then per-file, and that is not tidiness. Reusing the `sh` arm for `.mjs`
# would be a FAIL-OPEN: `sh` truncates a line at a word-initial `#`, and one of those files
# carries 196 of them, so every domain literal to the right of any `#` would drop out of the
# scan while the guard reported a widened surface. An extension this file has no arm for
# gets `raw` — nothing is stripped, so prose in it over-reports rather than under-reports.
# Fail-CLOSED is the right default for a format we cannot parse.
#
# ── THE EXEMPTION, NARROWED FROM A FILE TO A DECLARED BLOCK (#304) ──────────────
# A sibling GUARD must SPELL the vocabulary it hunts: `check-kinds-zero-core.sh`'s
# `KINDS=` and `check-no-legacy-wire.sh`'s `DOMAIN_REGEX=`. Scanning those would be the
# cry-wolf class — the same self-reference this guard already exempts for `#[cfg(test)]`
# grep-guards in Rust, and that `lint-no-domain-in-builtin.mjs` grants its own
# forbidden-string list.
#
# That exemption used to be the WHOLE FILE, granted by the file being PINNED in
# `scripts/guard-hashes.txt`. #304 is the measurement that this is too broad, and it is
# not a hypothetical: `check-viz-producer-magnitudes.mjs` was pinned and therefore would
# have been exempt, yet it was NOT hunting for that vocabulary — it was DISPATCHING on it.
# A guard that greps for a term and a guard that branches on one are opposite cases, and
# a pin cannot tell them apart. Nothing can, from the outside — so the file SAYS which it
# is doing, in its own bytes, on its own line:
#
#     # cyto:guard-vocabulary
#     KINDS=<the terms this guard hunts>
#     # cyto:end-guard-vocabulary
#
# Only the lines INSIDE that block are blanked, exactly the way an in-source `#[cfg(test)]`
# item is blanked for Rust — the mechanism is the same one, keyed on a declaration instead
# of on an attribute. Everything else in a pinned guard is scanned like any other build
# file. `// cyto:guard-vocabulary` is the same marker in the js dialect.
#
# Pinning is still NECESSARY and is now not SUFFICIENT, so the exemption costs two keys
# instead of one and both land in a reviewed diff:
#   * to exempt a line you must PIN the file, which puts it in a committed manifest diff;
#   * `check-guard-integrity.sh` check 2 FAILS on any `scripts/check-*.sh` or
#     `scripts/check-*.mjs` that is not pinned, so "rename it to check-foo.sh and hide the
#     literal there" cannot be done silently — and check 1 fails on any edit to a pinned
#     guard that is not re-pinned;
#   * AND you must open the block, in the same commit, next to the line it covers.
# `check-guard-integrity.sh` runs BEFORE this guard in `just check-guards`, so the pin set
# is verified intact before it is consulted.
#
# Both ways of getting the block wrong FAIL rather than exempt (this is where the previous
# shape would have leaked back in through a typo):
#   * a marker in a build file that is NOT pinned is a hard failure, never a silent no-op —
#     otherwise an author would believe an exemption they do not have;
#   * an UNTERMINATED block is a hard failure — otherwise a missing end-marker blanks the
#     rest of the file, which is the whole-file exemption being removed here, reintroduced
#     by accident and invisibly.
#
# The blocks are added where they are MEASURABLY needed and nowhere else. With the
# exemption removed entirely the whole tree yields hits on exactly two lines, and those two
# carry the only blocks in the repo. `check-no-format-crates.sh`s `DENY_FAMILIES=` is clean
# (crate families are not contributed datatype ids) and deliberately has NO block: an
# exemption granted to a file that does not need it is `derived-guards.md` §5s "widening an
# allowlist", and it would pre-authorize a future leak there.
#
# ── AND JS TEST MODULES ARE EXCLUDED BY THE TREE-S OWN DECLARATION OF WHAT ONE IS ─
# Widening to `.mjs` sweeps in the `*.test.mjs` control suites, which legitimately spell the
# vocabulary they plant. They are excluded the same way Python test modules already are: NOT
# by a pattern typed here, but by reading the declaration the tree actually runs under —
# every `.mjs` the `justfile` invokes as `node --test`. A rule spelled in the guard drifts
# from the rule the tree runs under; a derived one cannot.
#
# TWO KEYS, and the first cut had only one. A blind audit defeated it in a line: `grep` has
# no notion of a recipe, so a justfile COMMENT (`# historical: node --test scripts/x.mjs`),
# an `echo` STRING inside a recipe, or a path under any OTHER `.../scripts/` directory (the
# rewrite was greedy) each granted a silent WHOLE-FILE exemption — #303-s exact leak, in
# #303-s exact file, back to PASS for one comment line in an unpinned file. `MIN_JS_TEST_FILES`
# cannot see it: the count goes UP.
#
# So a file is a JS test module only when BOTH hold, and they are keys of different kinds:
#   * the justfile DECLARES it, on a line that is not a comment, as a repo-root `scripts/`
#     path (node flags between `--test` and the path are allowed — the first cut required
#     the path to sit immediately after `--test`, so an added `--test-reporter` collapsed the
#     whole derivation to zero); AND
#   * the file IS one — it imports `node:test`. That is a property the file CARRIES, in the
#     same sense `#[cfg(test)]` is, so it cannot be granted from outside the file. A guard
#     hiding a dispatch would have to import the test runner into itself to claim it.
# Floored (`MIN_JS_TEST_FILES`), so a collapsed derivation fails instead of quietly scanning
# the controls and crying wolf.
#
# ── AND THE SURFACE IS NOT TYPED HERE EITHER, IT IS DECLARED ONCE (#311/#324) ───
# `BUILD_SURFACE_GLOBS=('justfile' 'scripts')` was the surface, and `scripts` there is a
# git pathspec rooted at the REPO. #324 is the measured cost of that last word: #259's
# fixture generator landed at `src-app/libs/viz/scripts/`, which is inside the wholesale
# pytest's surface and was outside this one, so this guard printed PASS while
# `test_a_new_kind_costs_zero_core_code` carried the red onto `main`. That is #303 again,
# one directory out, and #304 had already been the repair for #303 — which is the tell that
# the shape was wrong rather than the value.
#
# So the surface is DECLARED, once, in `scripts/lib/zero-core-surface.txt`, and the OTHER
# guard over this invariant reads the same file. Two readers of one declaration cannot drift
# the way two hand-kept lists did; that is #311's own prescription and
# `docs/design/derived-guards.md` §2's shape. What the declaration says is a STRUCTURAL fact
# rather than a path: being under a directory named `scripts` is what makes a file build
# tooling, at any depth. A `scripts/` directory nobody has created yet is scanned the day it
# lands, with zero edits here.
#
# The declaration also carries the `cyto:guard-vocabulary` markers and the pin manifest that
# bounds them, for the same reason: the exemption RULE is the second thing the two guards
# derived separately, and #311 residual 1 is that only one of them honoured it.
#
# Read fail-CLOSED. A missing file, a missing field, a duplicated single-valued field or an
# exception naming nothing is a hard FAIL, never a quietly smaller scan — a declaration that
# half-reads is this guard scanning less while printing PASS, which is the failure it exists
# to stop.
SURFACE_DECL='scripts/lib/zero-core-surface.txt'
if [ ! -f "$SURFACE_DECL" ]; then
  echo "FAIL: $SURFACE_DECL is missing, so this guard has no declaration of the build surface"
  echo "      or of the cyto:guard-vocabulary exemption. It is the file"
  echo "      src-app/packages/spatial-types/tests/test_spatial_types_manifest.py reads too;"
  echo "      restore it rather than re-typing either rule into a guard (#311)."
  exit 1
fi
# A line whose first non-blank character is `#` is a comment. A `#` anywhere else is DATA:
# the exception reasons carry issue numbers, and a mid-line comment rule would eat them.
DECL_BODY="$(sed -e 's/^[[:space:]]*#.*$//' "$SURFACE_DECL")"
decl_field() { printf '%s\n' "$DECL_BODY" | awk -v f="$1" '$1 == f { $1 = ""; sub(/^[ \t]+/, ""); print }'; }
decl_first() { decl_field "$1" | awk '{ print $1 }'; }
decl_count() { decl_first "$1" | grep -c . || true; }

# ── EVERY VALUE IS VALIDATED, AND ANYTHING ELSE IS REFUSED ──────────────────────
# The repair for a demonstrated FAIL-OPEN, not tidiness. These values are interpolated
# into four matcher languages — an awk ERE, a BRE `grep`, a Python `re` and a git
# PATHSPEC — and a blind audit defeated every one of them from the declaration alone:
#   * `vocab_block_open cyto:guard-vocabulary(` made awk's DYNAMIC regex fail to
#     compile. awk compiles it lazily, on the first BUILD file, so awk died on EVERY
#     build file with stderr swallowed, `out` was empty, `[ -n "$out" ] || continue`
#     read that as "no hits", and the guard printed PASS over a real planted leak while
#     still reporting 53 files scanned (the count comes from the FILE LIST, not from
#     what awk processed);
#   * `surface_root :(exclude)justfile` is a git PATHSPEC, not a path: git exits 0 with
#     empty output and the recipes leave the surface, at exit 0;
#   * `surface_exception src-app/x+y` was escaped ERE-style and consumed by a BRE
#     `grep`, where `\+` is an OPERATOR: the DECLARED directory was not exempted and a
#     DIFFERENT one silently was;
#   * `surface_exception src-app/a(b` made the "names a real path" check itself error
#     out (`[: : integer expression expected`), so the check did not fire.
# A charset that admits none of those needs no escaping in any of the four languages,
# which is why there is none below: the two readers then agree by CONSTRUCTION rather
# than by two escapers that have to match. This is the same conclusion §7.1 reaches
# about the vocabulary block — stop writing a cleverer predicate, remove the thing that
# needed one.
decl_fail=0

# EVERY RECORD MUST BE A RECORD THIS READER KNOWS, and the reason is not tidiness either.
# awk splits on space and tab; Python's `str.split()` splits on every Unicode whitespace. So a
# line written `data_root<VT>src-app/libs` — or with NBSP, which renders as an ordinary space in
# `git diff` — is a parsed record in the counterpart and, here, a line whose `$1` matches no
# field and is therefore SILENTLY DROPPED. One declaration, two answers, in the one place the
# round that fixed the value split did not look. Both readers refuse an unknown field now, so a
# record either means the same thing to both or fails.
_KNOWN_FIELDS=' scan_root data_root test_path_segment surface_root surface_dir surface_exception vocab_block_open vocab_block_close vocab_block_pins '
while IFS= read -r _line; do
  [ -n "$_line" ] || continue
  _f="$(printf '%s\n' "$_line" | awk '{ print $1 }')"
  [ -n "$_f" ] || continue
  case "$_KNOWN_FIELDS" in
    *" $_f "*) ;;
    *)
      echo "FAIL: $SURFACE_DECL carries a record this reader does not know: \`$_f\`."
      echo "      Every non-comment line must begin with a declared field. A line whose first"
      echo "      token is not one is dropped SILENTLY here while the counterpart, which splits"
      echo "      on every Unicode whitespace rather than space and tab, may well parse it — and"
      echo "      with a non-breaking space the line looks ordinary in a diff. Known fields:"
      echo "     $_KNOWN_FIELDS"
      decl_fail=1
      ;;
  esac
done <<EOF
$DECL_BODY
EOF

_valid() { # $1 = kind, $2 = value  → 0 if the value is acceptable
  case "$1" in
    path)
      # A TRAILING SLASH is refused, and that is not pedantry: `data_root src-app/packages/`
      # passes every other check and then builds `^src-app/packages//`, which matches nothing —
      # the exclusion silently no-ops in BOTH readers, and a package's own scripts/ directory
      # starts being reported as a leak. One character, found blind, fails closed now.
      #
      # `*/.*` — a `/` followed by a `.` ANYWHERE — and it is not tidiness either. The
      # counterpart's charset writes the same rule as `/(?![/.]|$)`, which refuses every
      # dot-leading segment; this `case` refused only a LEADING dot and the two `..` forms. A
      # blind round enumerated the two charsets over `{a,.,/,-,_}` up to length 5 and found 118
      # strings the shell took and the counterpart refused — `a/.b`, `a/./b`, `a/..b` — one
      # declaration with two answers, which is the defect this file exists to remove. It was
      # not cosmetic: `surface_root src-app/./packages/_lib` walked straight past the
      # at-or-under-a-data-root check (which compares the DECLARED STRINGS) while git
      # normalised the path and the data-root exclusion emptied it — a declared surface
      # contributing nothing, at exit 0, with the PASS line advertising it.
      case "$2" in
        -*|.*|*//*|*/|*/.*|*/..|../*|..) return 1 ;;
      esac
      printf '%s' "$2" | LC_ALL=C grep -qE '^[A-Za-z0-9_][A-Za-z0-9_./-]*$' ;;
    name)   printf '%s' "$2" | LC_ALL=C grep -qE '^[A-Za-z0-9_][A-Za-z0-9_.-]*$' ;;
    marker) printf '%s' "$2" | LC_ALL=C grep -qE '^[A-Za-z0-9_][A-Za-z0-9:_-]*$' ;;
  esac
}
_check_values() { # $1 = field, $2 = kind
  while IFS= read -r _v; do
    [ -n "$_v" ] || continue
    if ! _valid "$2" "$_v"; then
      echo "FAIL: $SURFACE_DECL declares \`$1 $_v\`, which is not a plain $2 token."
      echo "      Every value here is interpolated into an awk regex, a grep pattern, a Python"
      echo "      regex and a git pathspec. A value carrying a metacharacter means something"
      echo "      different in each, and a blind audit turned exactly that into a silent PASS"
      echo "      over a planted leak. The charsets are stated in this declaration's header;"
      echo "      widen them only together with the four readers that consume them."
      decl_fail=1
    fi
  done <<EOF
$(decl_first "$1")
EOF
}

for _f in surface_dir vocab_block_open vocab_block_close vocab_block_pins; do
  _n="$(decl_count "$_f")"
  if [ "$_n" -ne 1 ]; then
    echo "FAIL: $SURFACE_DECL declares \`$_f\` $_n time(s); exactly one is required."
    echo "      Zero means this guard would fall back to nothing; more than one means two"
    echo "      readers of this file could pick different ones, which is the drift the"
    echo "      declaration exists to remove (#311)."
    decl_fail=1
  fi
done
for _f in scan_root surface_root data_root test_path_segment; do
  if [ "$(decl_count "$_f")" -lt 1 ]; then
    echo "FAIL: $SURFACE_DECL declares no \`$_f\`. Every one of these is load-bearing: the"
    echo "      scan roots are the region both guards range over, the surface roots are the"
    echo "      recipes that stand the app up, the data root is the contributed packages this"
    echo "      invariant is ABOUT, and the test segments are what keeps a fixture from being"
    echo "      reported as a dispatch. An absent one is a silently different guard."
    decl_fail=1
  fi
done
_check_values scan_root path
_check_values surface_root path
_check_values data_root path
_check_values vocab_block_pins path
_check_values surface_exception path
_check_values surface_dir name
_check_values test_path_segment name
_check_values vocab_block_open marker
_check_values vocab_block_close marker
[ "$decl_fail" -eq 0 ] || exit 1

_read_into() { # $1 = array name, $2 = field — first token of each record
  eval "$1=()"
  while IFS= read -r _v; do
    [ -n "$_v" ] || continue
    eval "$1+=(\"\$_v\")"
  done <<EOF
$(decl_first "$2")
EOF
}
_read_into SCAN_ROOTS scan_root
_read_into BUILD_SURFACE_ROOTS surface_root
_read_into DATA_ROOTS data_root
_read_into TEST_SEGMENTS test_path_segment
# A `surface_exception` is the ONLY thing anyone has to write down: the default is SCANNED.
# The first token is the path; the rest of the line is the reason a reader of the diff sees.
_read_into SURFACE_EXCEPTIONS surface_exception

SURFACE_DIR="$(decl_first surface_dir)"
VOCAB_OPEN="$(decl_first vocab_block_open)"
VOCAB_CLOSE="$(decl_first vocab_block_close)"
GUARD_MANIFEST="$(decl_first vocab_block_pins)"
JUSTFILE='justfile'

# Every declared PATH must name something git tracks. derived-guards.md §3, applied to
# all of them rather than to one: a marker naming nothing is not a premise that does not
# hold, it is a guard switched off, and it looks identical from the outside. The first
# cut enforced this for `surface_exception` only, and a blind audit walked straight
# through the gap it left at `surface_root` — pointing it at a name that resolves to
# nothing dropped the justfile out of the scanned surface at exit 0, with a real leak in
# it. There is no ordering trick here: the same rule, for every path this file declares.
_names_something() { # $1 = path
  [ -n "$(git ls-files --cached --others --exclude-standard -- "$1" 2>/dev/null | head -1)" ]
}

# The ONE escape the charsets still need, and the reason it is provably complete rather than
# hopeful. A validated value is drawn from `[A-Za-z0-9_./-]` (path) or `[A-Za-z0-9_.-]` (name).
# Of the BRE metacharacters (`. * [ ] ^ $ \`) and the extra ERE ones (`+ ? { } ( ) |`), the
# charsets admit exactly ONE: the dot. So escaping the dot is not a best-effort escaper — it is
# the complete one FOR THIS CHARSET, and it stops being complete only if the charset widens,
# which is a visible edit to two pinned files.
#
# A blind round found this the hard way, and the shape is worth keeping: the round that
# introduced the charsets ALSO deleted the escaping, on the grounds that the charsets removed
# the need for it. They removed the need for all of it but the dot — and every shipped
# `surface_exception` is a FILE PATH, so every one of them carries a dot. `domain-baseline.json`
# was matching `domain-baselineXjson`, which reinstated the #324 state (fast guard PASS,
# wholesale pytest RED) with the declaration exactly as committed.
_re() { printf '%s' "$1" | sed 's/\./\\./g'; }

# The declared test-code segments as ONE alternation, built once and used on every tier.
# `scripts/lib/zero-core-surface.txt` says the two readers now keep one list; the round that
# wrote that sentence applied it to the BUILD tier only and left `(tests|testdata|fixtures)`
# hard-coded on the app-core and framework tiers — so `__tests__` was declared test code for
# one reader and one tier of the other. A blind round demonstrated the false positive it
# leaves. The declaration is the list, everywhere, or it is not the list.
_TEST_SEG_RE=''
for _seg in ${TEST_SEGMENTS[@]+"${TEST_SEGMENTS[@]}"}; do
  _TEST_SEG_RE="${_TEST_SEG_RE:+$_TEST_SEG_RE|}$(_re "$_seg")"
done
if [ -z "$_TEST_SEG_RE" ]; then
  echo "FAIL: $SURFACE_DECL declared no usable \`test_path_segment\`, so every fixture and every"
  echo "      test module would be scanned as if it were a dispatch. That is the cry-wolf class"
  echo "      docs/design/derived-guards.md §5 names, and it fails rather than arriving."
  exit 1
fi
# ONLY THE INCLUSION PATHS, and the asymmetry is the point rather than an oversight.
# `scan_root`, `surface_root` and `vocab_block_pins` decide what IS scanned or which files may
# claim an exemption: one of them naming nothing REMOVES a region while the guard reports the
# same PASS, which is §3's "a guard switched off, and it looks identical from the outside".
#
# `data_root` is the opposite direction and is deliberately NOT here. It is an EXCLUSION: one
# that names nothing excludes nothing, so the guard scans MORE, not less — a typo in it makes a
# contributed package's own vocabulary a LOUD red rather than a silent gap. Requiring it to
# exist also PRE-EMPTS a better message: a tree whose packages are genuinely gone is a COLLAPSED
# VOCABULARY, which this guard's own MIN_TERMS/MIN_PACKAGES floors say precisely, and a
# `data_root names nothing` failure in front of them is a worse answer to the same question.
# That is not hypothetical — a control in the Rust suite (`domain_surface::derived_vocabulary_test`,
# reachable only through `just check-domain`) asserts exactly that message and is what caught it.
# THE THIRD EXEMPTION AXIS, and the one that was priced at nothing. A blind round did to
# `data_root` exactly what the round before it did to `test_path_segment`: with a leak planted
# under src-app/libs/viz/scripts/, one appended line — `data_root src-app/libs` — dropped 10
# build files including the leak, and BOTH guards printed PASS. Cheaper than either capped
# axis, and worse than `test_path_segment` in one respect that matters: `data_root` is applied
# by both readers to BOTH sets, so the containment assertion shrinks with the scan and the
# backstop cannot see it either. §7.1.3's own bullet 1 says to enumerate every field that can
# REMOVE something and ask what each costs; the round that wrote that sentence enumerated six
# fields and priced two.
#
# The repair is NOT a cap, and that is the point. A `data_root` is not an opinion — it is a
# statement about where the CONTRIBUTED PACKAGES are, and that set has its own declaration:
# a directory is a package because it holds a `manifest.yaml` (this guard's own line 166). So
# the value is DERIVED-CHECKED rather than trusted: every declared data root must hold at
# least one contributed manifest, and every contributed manifest must sit under one. That
# refuses `src-app/libs` — which holds no manifest — while costing a real relocation of the
# package tree nothing but the truth.
#
# A `data_root` MUST BE AT OR UNDER `PROCESSORS_DIR`, and this replaces a rule that had a
# one-line bypass. The first cut asked "does this directory hold a `<pkg>/manifest.yaml`" — a
# statement about FILE SHAPE, which a blind round satisfied with a one-line empty manifest:
# `mkdir src-app/libs/zz && echo 'name: zz' > src-app/libs/zz/manifest.yaml` plus
# `data_root src-app/libs` dropped 9 build files INCLUDING a real planted leak, and BOTH guards
# printed PASS. It also needed a collapsed-tree GATE, because a tree with no packages made the
# rule fire in front of the better "the derivation collapsed" message — and that gate was itself
# a mechanism with no control.
#
# The rule below has none of that. `PROCESSORS_DIR` is where this guard READS the contributed
# vocabulary; the data roots are the region that vocabulary lives in. Requiring each root to be
# at or under it — together with the converse check just after, that PROCESSORS_DIR is covered —
# pins the two declarations to each other exactly. No file shape, no gate, no dependency on what
# the tree happens to contain today, and nothing to plant.
for _r in ${DATA_ROOTS[@]+"${DATA_ROOTS[@]}"}; do
  case "$_r" in
    "$PROCESSORS_DIR"|"$PROCESSORS_DIR"/*) ;;
    *)
      echo "FAIL: $SURFACE_DECL declares \`data_root $_r\`, which is not at or under"
      echo "      \`$PROCESSORS_DIR\` — the directory this guard READS the contributed vocabulary"
      echo "      from. A data root is not an opinion about what to skip: it is the region that"
      echo "      vocabulary lives in, and a root outside it removes ordinary source from BOTH"
      echo "      guards at once. An earlier rule asked only whether the directory held something"
      echo "      SHAPED like a package manifest, and a one-line empty file bought the exemption."
      decl_fail=1
      ;;
  esac
done

_dr_fail=0
_pd_covered=0
for _r in ${DATA_ROOTS[@]+"${DATA_ROOTS[@]}"}; do
  case "$PROCESSORS_DIR" in "$_r"|"$_r"/*) _pd_covered=1 ;; esac
done
# This half is a statement about two DECLARATIONS agreeing, not about the tree, so it is not
# gated: it is true or false whether or not any package currently exists.
if [ "$_pd_covered" -ne 1 ]; then
  echo "FAIL: this guard reads the contributed packages from \`$PROCESSORS_DIR\`, and"
  echo "      $SURFACE_DECL declares no \`data_root\` covering it. One of the two is wrong, and"
  echo "      while they disagree this guard scans a package tree as if it were app core (or"
  echo "      excludes app core as if it were a package). One spelling of one set."
  _dr_fail=1
fi
[ "$_dr_fail" -eq 0 ] || decl_fail=1

for _f in scan_root surface_root vocab_block_pins; do
  while IFS= read -r _v; do
    [ -n "$_v" ] || continue
    if ! _names_something "$_v"; then
      echo "FAIL: $SURFACE_DECL declares \`$_f $_v\`, and git tracks nothing there."
      echo "      A declared path that names nothing does not narrow this guard by a"
      echo "      directory — it removes a region from the scan while the guard reports the"
      echo "      same PASS, which is how a leak in that region reaches main. Re-point it,"
      echo "      or delete the record if the region is genuinely gone."
      decl_fail=1
    fi
  done <<EOF
$(decl_first "$_f")
EOF
done
[ "$decl_fail" -eq 0 ] || exit 1

# The frontend is deliberately NOT a root here: `src-app/ui/scripts/lint-no-domain-in-builtin.mjs`
# already scans it against the SAME derived vocabulary, with a per-(file,token) ratchet
# baseline this shell guard has no way to carry. `src-app/ui/scripts/` itself is the
# declaration's five written exceptions, and they are FILES rather than that directory —
# 5 of its 66 tracked files are excepted and the other 61 are scanned, for the narrow reason
# each entry states.
#
# ── RELATION TO THE TWO EXISTING DERIVED ENFORCERS (this is not a third opinion) ──
# `lint-no-domain-in-builtin.mjs::contributedDatatypes()` and the Rust twin
# `tests/domain_surface/mod.rs::contributed_datatypes()` already read this same
# `datatypes:` slice — the reader below is a byte-for-byte third sibling of theirs, on
# purpose (all three must yield the same 28 ids across 5 packages, or the shared
# `domain-baseline.json` drifts). What differs is the ENFORCEMENT, not the vocabulary:
#   * those two ratchet against a per-(file,token) BASELINE of thousands of historical
#     hits across the whole tree, and they run under node/cargo;
#   * this one is ZERO-TOLERANCE on a narrower, structurally-defined surface, needs
#     nothing but git+awk, and runs in a second — which is what lets it sit in the
#     default `just` gate where `check-kinds-zero-core.sh`'s hard-coded trio sits today.

MIN_TERMS=14        # measured 28 (re-measured off the PASS line; the annotation said 19)
MIN_PACKAGES=2      # measured 5 (re-measured; the annotation said 3)
MIN_FILES=120       # measured 319 (re-measured off the PASS line; the annotation said 182)
MIN_LIB_FILES=7     # measured 14 non-test modules across the reserved packages (said 10)
MIN_LIB_PACKAGES=2  # measured 2 (`_helpers`, `_lib`)
MIN_ENVS=1          # measured 1 distinct id (`single-cell`)
MIN_ENV_RECIPES=1   # anti-vacuity only: the recipe WALK must find something to cross-check
MIN_BUILD_FILES=90  # measured 114 (justfile + everything git tracks under any scripts/ directory
                    # inside the scan roots, less the data roots, the 5
                    # declared exceptions and the 5 js test modules). Re-measure with the guard-s
                    # own PASS line, not by hand: the first cut of this annotation was wrong by one
                    # in BOTH terms and the total still reconciled, which is exactly how a
                    # hand-kept number rots — and the SECOND cut of it was wrong again (it said
                    # "measured 42 ... - 4 js test modules" beside a PASS line printing 5).
                    #
                    # WITHDRAWN CLAIM, kept visible because the reasoning is the useful part. An
                    # earlier version said this floor was "a SECOND, INDEPENDENT detector" of a
                    # regression to the root-only surface and of the exempt-the-leaking-directory
                    # dodge, because both landed one below it. Both arithmetic facts were true and
                    # the CONCLUSION was wrong twice over: a constant over a growing tree stops
                    # detecting anything the moment a few files land under any scripts/ directory,
                    # and a blind audit did not even have to wait — it paid the shortfall straight
                    # back in the same file by adding a `surface_root`, landing exactly ON the
                    # floor with the leak exempt and the guard green. A floor detects a COLLAPSED
                    # derivation; it is not a policy. What bounds an exception is
                    # MAX_SURFACE_EXCEPTIONS below and the byte pin under both files.
                    #
                    # It does still catch the root-only regression, which yields 44 — but as a
                    # by-product of being a floor, not as a mechanism anyone should rely on.
MAX_SURFACE_EXCEPTIONS=5  # measured 5 — the sibling ratcheting guard, its committed baseline, its
                    # two control suites and their expected-delta fixture: every file in the tree
                    # that legitimately spells this vocabulary and CANNOT use a declared
                    # vocabulary block, because check-guard-integrity.sh deliberately does not pin
                    # that guard and a marker in an unpinned file is a hard failure. (This comment
                    # deliberately does not START a line with the marker token: the guard would
                    # read it as an unterminated block, which it just did, correctly.)
                    #
                    # The FIRST cut of this widening excepted the whole `src-app/ui/scripts`
                    # PREFIX — 66 files to cover these 5 — and a blind audit planted a leak in a
                    # sixth file there and reproduced the #324 STATE at a committed path: this
                    # guard PASS, the wholesale pytest RED, `just check-guards` green. That is
                    # derived-guards.md §5's prefix exemption in substance even when the reason is
                    # sound, so the reason is applied to the files it is actually about. A CAP rather than a floor, and the only
                    # non-decaying bound on a `surface_exception`: a SIXTH one cannot arrive without an
                    # edit to THIS pinned guard in the same commit as the declaration's. See the
                    # note at the check itself for what it deliberately does not claim.
                    #
                    # A blind round observed that this was, for one round, the ONLY capped
                    # exemption axis while `test_path_segment` sat uncapped one field over with
                    # the same power — so the claim above was true of the field it named and
                    # false of the file. MAX_TEST_SEGMENTS below is the parity.
MAX_TEST_SEGMENTS=3 # measured 3 (`tests`, `testdata`, `fixtures`). THE SECOND
                    # EXEMPTION AXIS, and it was uncapped for two rounds while the cap above
                    # carried a comment calling itself the only bound on an exception.
                    #
                    # A blind round demonstrated the cost of that in one line: with a real leak
                    # planted at src-app/libs/viz/scripts/, appending `test_path_segment viz` to
                    # the declaration turned BOTH guards and the containment assertion green,
                    # for the price of a single re-pin — strictly CHEAPER than the
                    # `surface_exception` route, which additionally costs an edit here. An
                    # exemption axis whose cost is lower than the axis the guard advertises as
                    # capped is the whole of derived-guards.md §5's "widening an allowlist",
                    # wearing a different field name.
                    #
                    # AND A CAPPED SLOT THAT NAMES NOTHING IS A PRE-PAID EXEMPTION. `__tests__`
                    # sat in this list matching ZERO tracked files, declared on the argument that
                    # unifying the two readers' lists removes a way for them to disagree — which
                    # was true, and also meant one of the four capped slots cost NOTHING to spend.
                    # A blind round re-pointed it at a directory holding a real planted leak and
                    # both guards went green, for one edited line and a re-pin: the count never
                    # moved, so the cap never fired. That is derived-guards.md §5's pre-authorized
                    # future leak with a price tag on the wrong axis, and it is the same argument
                    # TEST-22(d) makes about an exception that changes nothing when removed.
                    # Every declared segment must now MATCH SOMETHING, so a slot cannot be BANKED.
                    #
                    # SAY WHAT THAT DOES AND DOES NOT BUY. It does not stop a LIVE slot being
                    # re-pointed — nothing decidable does, and §7.1 says so at length about the
                    # vocabulary block. What it changes is the price: spending a slot now means
                    # DELETING a segment the tree actually uses, which is a removal a reviewer
                    # reads, instead of overwriting an inert word nobody would look twice at.
                    # Beyond that the bound is the byte pin and a human, for this axis and for
                    # every other one, and that is stated rather than dressed up as closure.
                    # Two things bound it now. This cap gives ADDING one the same two-committed-
                    # diffs cost a sixth `surface_exception` has. And the BUILD-TIER assertion
                    # below refuses any declared segment that would remove a build file at all,
                    # which is what actually kills the `viz` vector: build tooling is build
                    # tooling wherever it sits, and the exclusion the build tier legitimately
                    # needs is the DERIVED js-test one, not a typed segment name.
                    #
                    # WHAT IT STILL DOES NOT BOUND, said plainly: a segment that appears ONLY in
                    # the app-core tree (`viz-core`, say) removes app-core files and no build
                    # files, so the build-tier assertion does not see it and only this cap and
                    # the byte pin stand between it and a silenced region. That is the same
                    # residual `surface_exception` has — an existing record can be re-pointed —
                    # and it is recorded in #325 rather than claimed closed.
MIN_SURFACE_DIRS=2  # measured 3 (`scripts`, `src-app/ui/scripts`, `src-app/libs/viz/scripts` —
                    # counted inside the declared scan roots).
                    # NOT anti-vacuity boilerplate: >= 2 is the assertion that the walk crosses
                    # the REPO ROOT. A derivation that regressed to a root-only pathspec — which
                    # is exactly what #324 leaked through — resolves to 1 and fails here, rather
                    # than silently scanning a smaller tree. Counted BEFORE the exceptions are
                    # subtracted, because an exception is a decision about a directory the walk
                    # FOUND; counting after would let the floor be satisfied by exempting.
MIN_JS_TEST_FILES=3 # measured 5 (the `node --test` .mjs paths the justfile declares; the
                    # annotation said 4 while the PASS line printed 5 — re-measured). Applied
                    # ONLY when the tree HAS a scripts/*.mjs tier — see below; a tree with none
                    # has nothing to exclude and zero is the right answer, exactly as for
                    # MIN_ENV_RECIPES.

TMP="$(mktemp -d)" || exit 2
trap 'rm -rf "$TMP"' EXIT
TERMS="$TMP/terms.tsv"
PKGS="$TMP/pkgs.txt"
BUILD_TERMS="$TMP/build-terms.tsv"
ENVS="$TMP/envs.txt"

# ── 1. DERIVE the forbidden vocabulary ──────────────────────────────────────────
#
# An indentation-exact slice reader for the `contributes.datatypes:` block, mirroring
# `lint-no-domain-in-builtin.mjs::contributedDatatypes` byte for byte in intent: read
# ONLY the `datatypes:` block (an `- id:` also appears under `analyses:`, `views:` and
# `converters:`, and sweeping those in would forbid analysis ids as if they were
# datatypes). No YAML dependency — a gate that a transitive dep bump can break is a
# worse gate.
: > "$TERMS"
: > "$PKGS"
for mf in "$PROCESSORS_DIR"/*/manifest.yaml; do
  [ -f "$mf" ] || continue
  pkg="$(basename "$(dirname "$mf")")"
  awk -v pkg="$pkg" '
    /^[[:space:]]*(#|$)/ { next }
    {
      line = $0
      indent = match(line, /[^ ]/) - 1
      if (!inblock) {
        if (indent == 2 && line ~ /^  datatypes:[[:space:]]*$/) inblock = 1
        next
      }
      if (indent <= 2) { inblock = 0; next }
      if (match(line, /^    - id:[[:space:]]*/)) {
        id = substr(line, RSTART + RLENGTH)
        sub(/[[:space:]]+$/, "", id)
        gsub(/^["'"'"']|["'"'"']$/, "", id)
        if (id != "") print pkg "\t" id
      }
    }
  ' "$mf" >> "$TERMS.raw"
done
[ -f "$TERMS.raw" ] || : > "$TERMS.raw"
cut -f1 "$TERMS.raw" | sort -u > "$PKGS"

# Split into the two match tiers. A term holding `/` or `-` is a COMPOUND (safe as a
# boundary-wrapped substring); anything else is BARE (quoted-literal only).
awk -F'\t' '{
  t = $2
  if (t ~ /[\/-]/) print "compound\t" t; else print "bare\t" t
}' "$TERMS.raw" | sort -u > "$TERMS"

# ── 1b. DERIVE the ENV-ID vocabulary (the BUILD surface's extra tier) ────────────
#
# The analysis ENV IMAGE a contribution's compute runs inside is DATA too, and it is
# declared in TWO places: `contributes.converters[].env` (`ConverterContribution::env` —
# "the set is deployment data, not a list this type knows") and, since #189,
# `contributes.analyses[].env` (`AnalysisContributionData::env`, its twin). The build
# tier had no such derivation at all, which is how `single-cell` came to be typed into a
# recipe parameter default and a shell fallback.
#
# ── THE UNION, AND WHY READING ONE HALF IS WORSE THAN READING NEITHER (#196) ─────
# This reader was scoped to the `converters:` block, matching what
# `sandbox::env_image::default_env_id()` did at the time. E1/#189 made that function read
# the UNION of both contribution kinds (`env_image.rs::declared_envs_in` chains
# `converters` then `analyses`) and this reader was left behind — which is the
# enumerate-instead-of-derive failure one level up: an env declared by an ANALYSIS would
# be absent from the forbidden vocabulary, so its literal could be typed into a recipe
# with no guard, while this block printed PASS and named the app function it mirrors.
#
# So the block matcher takes BOTH. Note the loop shape: a `  analyses:` line ENDS the
# `converters:` block and OPENS its own, so the block-exit test may not `next` past the
# header test — an early `next` there read the two blocks as one and silently dropped
# whichever came second.
#
# Scoped to the BUILD surface ON PURPOSE, and NOT merged into $TERMS. An env-id is a
# BARE-looking compound (`single-cell`) that is also a PREFIX of the datatype ids
# (`single-cell/expression`), and the compound matcher's boundary set treats `/` as a
# boundary — so adding it to the app-core/framework vocabulary would newly flag prose in
# `_lib/cyto_columns.py`'s docstrings, which describe the axis-defaulting defect they
# exist to warn about. Measured: 3 such hits. Widening a surface must not be smuggled in
# as a vocabulary change; the app-core scan stays byte-identical to what it measured.
: > "$ENVS.raw"
for mf in "$PROCESSORS_DIR"/*/manifest.yaml; do
  [ -f "$mf" ] || continue
  awk '
    /^[[:space:]]*(#|$)/ { next }
    {
      line = $0
      indent = match(line, /[^ ]/) - 1
      # A dedent to the block level ENDS the current block. Fall through rather than
      # `next`, because that same line may be the header of the sibling block.
      if (inblock && indent <= 2) inblock = 0
      if (!inblock) {
        if (indent == 2 && line ~ /^  (converters|analyses):[[:space:]]*$/) inblock = 1
        next
      }
      if (match(line, /^(      env:|    - env:)[[:space:]]*/)) {
        id = substr(line, RSTART + RLENGTH)
        # A YAML scalar read the way a YAML parser reads it: a QUOTED value ends at its
        # own closing quote; an UNQUOTED one ends at an inline `#` comment.
        #
        # Stripping only trailing whitespace and one quote character at each end was
        # FAIL-OPEN, and silently so: `env: x  # note` derived the id `x  # note`, which
        # matches nothing in any scanned file. No floor moves either — it is still one
        # declaration of one id — so the guard PASSED while the real id had stopped being
        # forbidden anywhere. That trailing-comment shape is idiomatic throughout this
        # tree (every `# import=` pin line), so it is likely rather than exotic.
        q = substr(id, 1, 1)
        if (q == "\"" || q == "\047") {
          rest = substr(id, 2)
          p = index(rest, q)
          id = (p > 0) ? substr(rest, 1, p - 1) : rest
        } else {
          p = index(id, "#")
          if (p > 0) id = substr(id, 1, p - 1)
          sub(/[[:space:]]+$/, "", id)
        }
        if (id != "") print id
      }
    }
  ' "$mf" >> "$ENVS.raw"
done
[ -f "$ENVS.raw" ] || : > "$ENVS.raw"
# `fail` is initialised HERE, before the FIRST check that can set it — which is now the
# recipe cross-check below, not the grammar validation.
#
# R8: this was already got wrong once (a later `fail=0` clobbered the grammar validation's
# `fail=1`, so the guard printed FAIL and exited 0), and moving the cross-check earlier
# reintroduced it for the cross-check instead. TEST-6 and TEST-18 caught it in the same
# run, which is what those exit-status assertions are for. Anything that sets `fail` must
# come AFTER this line; there is exactly one `fail=0` in the file.
fail=0
# The recipe cross-check runs HERE — before the grammar validation, the `sort -u` and the
# counts — because an operator-selected recipe CONTRIBUTES its id to `$ENVS.raw`. Running
# it after the sort (where it first sat) meant that contribution never reached `$ENVS`,
# the forbidden vocabulary or `n_envs`. Order is load-bearing, so it is stated.
# ── the ANTI-DELETION check: every SHIPPED RECIPE must still be DECLARED ────────
#
# #196 R7. This replaces a floor on the repo-wide TOTAL number of declaration sites
# (`MIN_ENV_DECLS`), which a blind audit defeated: the total is global, so declarations
# added by an UNRELATED package create permanent slack, and both shipped declarations
# could then be deleted at exit 0. A floor over a global total defends no PARTICULAR
# declaration.
#
# It also removes the last hand-maintained NUMBER from this guard, and that matters for a
# reason measured in this repo the same week: two branches each correctly lowered a
# hand-maintained counter 12 -> 11, git merged two identical lines with no conflict, and
# TWO removals produced ONE decrement. A number drifts invisibly through a clean merge; a
# derived per-unit assertion cannot, because there is nothing to edit.
#
# WHY THIS ESCAPES THE §4 TAUTOLOGY. The derivation's blind spot is that it re-reads the
# very manifests that DEFINE the vocabulary, so a deleted `env:` shrinks both sides at
# once. This check reads a SECOND, INDEPENDENT source — the recipe tree on disk — and
# holds the two against each other. Deleting a declaration does not delete the recipe, so
# the two sources DIVERGE and the divergence is the signal. That is §4's prescription
# ("put a frozen anchor across exactly that direction") satisfied by a derived cross-check
# rather than by a census.
#
# Deliberately NOT an error: removing one of SEVERAL declarations of the same env. The
# env remains declared, fetchable and publishable, so nothing is broken. What is caught is
# removing the LAST one while its recipe still ships — the state in which the image is
# built and pushed but nothing can ask for it.
RECIPE_ROOT="src-app/env-rootfs"
undeclared=""
n_recipes=0
n_operator_selected=0
if [ -d "$RECIPE_ROOT" ]; then
  # `find`, deliberately, and NOT a `*/` glob: a glob skips dot-directories while BOTH
  # sibling discoverers see them — `publish-env-rootfs.sh:85` uses this same
  # `-mindepth 2 -maxdepth 2 -name Dockerfile` shape, and Rust's `discover_env_recipes`
  # uses `read_dir`, which is likewise not glob-filtered. A dot-recipe would therefore
  # have been PUBLISHED and walked by the Rust guards while this cross-check quietly did
  # not require it to be declared. Three discoverers of one set must agree, or the
  # disagreement IS the hole.
  while IFS= read -r _rid; do
    [ -n "$_rid" ] || continue
    n_recipes=$((n_recipes + 1))
    if ! grep -qxF "$_rid" "$ENVS.raw" 2>/dev/null; then
      # A recipe MAY legitimately be selected by the operator instead of by a manifest:
      # `processor_manifest.rs` documents that a contribution declaring NO env resolves
      # against EVERY recipe and the deployment picks one via `CYTO_SANDBOX_ENV_ID`, and
      # the README lists that as a first-class channel. Failing such a recipe would be
      # this guard failing a CORRECT configuration, which is how a guard gets disabled.
      #
      # So the recipe may DECLARE that intent, in itself, with a marker comment — the same
      # declare-don't-infer idiom as `cyto:env-smoke`. That keeps the anti-deletion
      # property intact: removing the last manifest declaration still fails UNLESS the
      # same commit also adds this marker, which is precisely the "force the removal into
      # a reviewed diff" the anchor exists for. It cannot be set accidentally.
      if grep -qE '^[[:space:]]*#[[:space:]]*cyto:env-operator-selected([[:space:]]|$)' \
           "$RECIPE_ROOT/$_rid/Dockerfile" 2>/dev/null; then
        n_operator_selected=$((n_operator_selected + 1))
        # The marker DECLARES the env — from the recipe tree instead of from a manifest —
        # so the id JOINS the derived vocabulary rather than dropping out of it.
        #
        # R8: the first version only `continue`d, which made the marker an exemption from
        # the recipe anchor AND a silent deletion from the forbidden set: `$ENVS` is
        # derived from manifests alone, so a marked recipe contributed nothing to it while
        # its env id stayed live and operator-selectable. A blind audit proved the A/B —
        # deleting one `env:` line and adding the marker turned a hard INV-5 leak failure
        # (exit 1) into PASS (exit 0) on an unchanged build file. That is precisely the
        # "the vocabulary shrinks in silence" direction derived-guards.md §4 exists to
        # close, reopened through the escape hatch added to close its sibling.
        #
        # Latent rather than live only because the real tree has one env and MIN_ENVS=1
        # masked it; it bites on any tree with two, which E3's second recipe creates.
        echo "$_rid" >> "$ENVS.raw"
        continue
      fi
      undeclared="$undeclared $_rid"
    fi
  done <<EOF
$(find "$RECIPE_ROOT" -mindepth 2 -maxdepth 2 -name Dockerfile -exec dirname {} \; 2>/dev/null \
    | while read -r _d; do basename "$_d"; done | sort)
EOF
fi
if [ -n "$undeclared" ]; then
  echo "FAIL: env recipe(s) SHIP but no processor manifest declares them:$undeclared"
  echo ""
  echo "      Every directory under $RECIPE_ROOT/ with a Dockerfile is an image that gets"
  echo "      BUILT and PUSHED. An undeclared one is an image nothing can ask for: the"
  echo "      publish path still ships it and no converter or analysis resolves to it."
  echo ""
  echo "      This is the DELETION direction the derivation above is blind to. It re-reads"
  echo "      the manifests that DEFINE the vocabulary, so a removed \`env:\` line shrinks the"
  echo "      forbidden set and the thing it is checked against together, in silence"
  echo "      (docs/design/derived-guards.md §4). The recipe tree is the second, independent"
  echo "      source that does NOT move when a manifest line is deleted."
  echo ""
  echo "      Do ONE of three things, in the same commit:"
  echo "        * declare it — \`env: <id>\` on a converter or an analysis in"
  echo "          src-app/packages/<pkg>/manifest.yaml; or"
  echo "        * mark the recipe OPERATOR-SELECTED — put \`# cyto:env-operator-selected\`"
  echo "          on its own line in the recipe's Dockerfile, if it is meant to be chosen"
  echo "          by CYTO_SANDBOX_ENV_ID rather than by a manifest (a documented, supported"
  echo "          configuration); or"
  echo "        * delete the recipe."
  echo "      Declared env id(s) seen: $(tr '\n' ' ' < "$ENVS.raw")"
  fail=1
fi
# Anti-vacuity, scoped to the case where it can actually mean something.
#
# A repo with NO recipe tree at all ships no env images, so there is nothing to
# cross-check and zero is the right answer — that is the normal state of the synthetic
# fixture repos this guard is tested against, and of any deployment that contributes no
# env image. Failing there would be a floor firing on a legitimate zero.
#
# A recipe root that EXISTS but yields nothing is different: that is a collapsed walk (a
# rename or a restructure INSIDE the tree), and it would let the cross-check above pass
# having verified nothing. That one fails.
#
# The remaining case — the whole root renamed away in the REAL repo — is held where it
# can be held without guessing: `env_image.rs::every_env_recipe_smoke_verifies_every_`
# `pinned_import` floors `recipes >= 1` against the real tree, and
# `every_env_recipe_source_mentions_jq_tripwire` walks the same root. A shell guard that
# must also run against fixture repos cannot distinguish "renamed" from "none"; a Rust
# test that only ever runs against the real repo can, and does.
if [ -d "$RECIPE_ROOT" ] && [ "$n_recipes" -lt "$MIN_ENV_RECIPES" ]; then
  echo "FAIL: $RECIPE_ROOT exists but the walk discovered $n_recipes recipe(s), below the"
  echo "      floor of $MIN_ENV_RECIPES — it COLLAPSED, so the declaration cross-check above"
  echo "      verified nothing. A recipe is a directory under it holding a Dockerfile."
  echo "      Re-point RECIPE_ROOT or restore the tree; do not lower this to go green."
  fail=1
fi

# Validate every DERIVED id against the shipped grammar before it is used or counted
# (#196 R7). The indentation-exact block reader cannot see several legal YAML shapes —
# a flow map, a quoted key, a folded scalar, an anchor/alias — and those either vanish
# (invisible to a floor, because a MISSED ADDITION is invisible to a minimum by
# construction) or derive GARBAGE like `>-` / `*E`. Refusing the garbage makes the whole
# class LOUD without adding a YAML dependency, which DEC-1 refuses.
# shellcheck source=lib/env-id-grammar.sh
# A LITERAL repo-relative path, not `$(dirname "$0")`: this script has already `cd`d to
# the git toplevel above, so `$0`-relative resolution is measured from the WRONG base and
# gave a spurious exit 2 when the guard was invoked from a subdirectory or via a symlink.
_grammar_lib="scripts/lib/env-id-grammar.sh"
if [ ! -f "$_grammar_lib" ]; then
  # Fail LOUDLY and say why. Without this the source fails, `cyto_is_valid_env_id` is
  # undefined, `! <undefined>` is TRUE, and every derived id is reported malformed — a
  # missing file wearing the costume of a real finding. Observed exactly once, in a
  # fixture repo that copied the guard without its lib.
  echo "FAIL: cannot read the env-id grammar at $_grammar_lib."
  echo "      This guard sources it rather than re-spelling the grammar; without it the"
  echo "      env-id validation cannot run and this guard will not guess. If you copied"
  echo "      this script somewhere, copy scripts/lib/ with it."
  exit 2
fi
# shellcheck disable=SC1090
. "$_grammar_lib"
while IFS= read -r _eid; do
  [ -n "$_eid" ] || continue
  if ! cyto_is_valid_env_id "$_eid"; then
    echo "FAIL: derived a malformed env id from a processor manifest: '$_eid'"
    echo "      A legal env id is a non-empty OCI path component: lowercase a-z, 0-9, . _ -"
    echo "      (src-app/server/src/modules/sandbox/env_id.rs, the grammar the runtime and"
    echo "      the build lint already share)."
    echo ""
    echo "      This almost always means a manifest declares \`env:\` in a YAML shape this"
    echo "      indentation-exact block reader cannot see — a flow map \`- {id: x, env: y}\`,"
    echo "      a quoted key, a folded scalar or an anchor/alias. Such a declaration would"
    echo "      otherwise be MISSING from the forbidden vocabulary with this guard printing"
    echo "      PASS, and no floor can see a missed addition. Rewrite it as a plain block"
    echo "      scalar."
    fail=1
  fi
done < "$ENVS.raw"
sort -u "$ENVS.raw" > "$ENVS"
n_envs="$(grep -c . "$ENVS" || true)"
# Every OCCURRENCE, not the deduped set: reported so a reader can see the declaration
# shape at a glance. Nothing is FLOORED on it any more — see the header for why a total
# was the wrong anchor and what replaced it.
n_env_decls="$(grep -c . "$ENVS.raw" || true)"

# The build surface forbids BOTH vocabularies. Same two-tier split.
{
  cat "$TERMS"
  awk '{ if ($0 ~ /[\/-]/) print "compound\t" $0; else print "bare\t" $0 }' "$ENVS"
} | sort -u > "$BUILD_TERMS"

n_terms="$(grep -c . "$TERMS" || true)"
n_pkgs="$(grep -c . "$PKGS" || true)"

if [ "$n_terms" -lt "$MIN_TERMS" ]; then
  echo "FAIL: the processor manifests yielded $n_terms contributed datatype id(s)."
  echo "      That is below the committed floor of $MIN_TERMS. The vocabulary this guard"
  echo "      forbids is DERIVED from $PROCESSORS_DIR/*/manifest.yaml; a short parse means"
  echo "      the manifests moved or their shape changed, and this guard was about to forbid"
  echo "      LESS than the tree contributes. Re-point the reader, or lower MIN_TERMS"
  echo "      deliberately if the lattice really shrank."
  fail=1
fi
if [ "$n_pkgs" -lt "$MIN_PACKAGES" ]; then
  echo "FAIL: only $n_pkgs package(s) were seen contributing datatypes."
  echo "      That is below the committed floor of $MIN_PACKAGES."
  echo "      Contributing packages seen: $(tr '\n' ' ' < "$PKGS")"
  fail=1
fi
if [ "$n_envs" -lt "$MIN_ENVS" ]; then
  echo "FAIL: the processor manifests yielded $n_envs distinct declared env-id(s), below the"
  echo "      floor of $MIN_ENVS. The env vocabulary the BUILD surface forbids is DERIVED from"
  echo "      $PROCESSORS_DIR/*/manifest.yaml as the UNION of contributes.converters[].env"
  echo "      and contributes.analyses[].env — the same union"
  echo "      \`sandbox::env_image::declared_envs_in()\` reads (#189/#196). A short parse means"
  echo "      the manifests moved or their shape changed, and this guard was about to let an"
  echo "      env-id literal back into the recipes. Re-point the reader; check BOTH block"
  echo "      matchers, not just the converters one."
  fail=1
fi
# The DELETION direction (INV-6). Distinct-id count above cannot see it: with two
# declarations of one id, removing either leaves the derived set unchanged; with two
# distinct ids, removing one still clears a floor of 1. See the header for why this is a
# floor and not a hand-maintained census.
# ── 2. RESOLVE the scanned surface ──────────────────────────────────────────────
#
# `--cached --others --exclude-standard`: tracked files PLUS created-but-not-yet-staged
# ones, minus gitignored build output. `--cached` alone returns NOTHING for a path
# renamed in the working tree but not yet `git add`ed, and the guard would then PASS
# having scanned nothing (the live fail-open ITEM-37 catalogued four times).
FILES="$(
  git ls-files --cached --others --exclude-standard -- "${SURFACE_ROOTS[@]}" 2>/dev/null |
    grep -E '\.(rs|sql)$' |
    grep -vE "(^|/)($_TEST_SEG_RE)/" |
    sort -u
)"
n_files="$(printf '%s\n' "$FILES" | grep -c . || true)"

if [ "$n_files" -lt "$MIN_FILES" ]; then
  echo "FAIL: the app-core scan set resolved to $n_files file(s), below the floor of $MIN_FILES."
  echo "      A SURFACE_ROOT no longer exists (moved/renamed), so this guard was about to"
  echo "      PASS having scanned almost nothing. Re-point SURFACE_ROOTS."
  fail=1
fi

# The framework-library surface. Test modules are excluded by PYTEST'S OWN definition of a
# test module — the `python_files` glob declared in the package's `pytest.ini` — rather than
# by a pattern typed here; the conventional pair is the fallback when a package declares
# none. A package that declared a glob matching nothing would leave its tests scanned, which
# over-reports: fail-CLOSED, never silent.
py_test_globs() {
  local ini="$1/pytest.ini" globs=''
  if [ -f "$ini" ]; then
    globs="$(awk '
      /^[[:space:]]*python_files[[:space:]]*=/ { sub(/^[^=]*=[[:space:]]*/, ""); print; exit }
    ' "$ini")"
  fi
  [ -n "$globs" ] && printf '%s\n' "$globs" || printf '%s\n' 'test_*.py *_test.py conftest.py'
}

is_py_test() { # $1 = path, $2 = space-separated globs
  local base g
  base="$(basename "$1")"
  for g in $2; do
    # shellcheck disable=SC2254 -- an unquoted case pattern is the glob match we want
    case "$base" in $g) return 0 ;; esac
  done
  return 1
}

# The derivation, CHECKED one ring in. `RESERVED_*_PACKAGE: &str = "_x"` in the server's
# processor resolver is where the app itself names its reserved packages; every one of them
# must be a root the glob above found. A miss means the glob and the server disagree — a
# renamed/moved package, or a reserved package shipped without a `manifest.yaml` — and the
# guard would then scan one framework package fewer while printing PASS.
if [ -f "$SERVER_PROCESSORS_RS" ]; then
  while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    found=0
    for root in "${FRAMEWORK_LIB_ROOTS[@]}"; do
      [ "$root" = "$PROCESSORS_DIR/$pkg" ] && found=1 && break
    done
    if [ "$found" -eq 0 ]; then
      echo "FAIL: the server names a RESERVED processor package \`$pkg\` that this guard's"
      echo "      derived framework surface does not contain. The roots are derived from"
      echo "      $PROCESSORS_DIR/_*/manifest.yaml; either that package moved, or it ships"
      echo "      no manifest.yaml, and this guard was about to scan one framework package"
      echo "      fewer than the app stages/runs. Source: $SERVER_PROCESSORS_RS."
      fail=1
    fi
  done <<EOF
$(grep -oE 'RESERVED_[A-Z_]*PACKAGE[[:space:]]*:[[:space:]]*&str[[:space:]]*=[[:space:]]*"[^"]+"' \
    "$SERVER_PROCESSORS_RS" | sed 's/.*"\(.*\)"/\1/' | sort -u)
EOF
else
  echo "FAIL: $SERVER_PROCESSORS_RS is missing, so the derived framework surface cannot be"
  echo "      checked against the packages the server actually reserves. Re-point"
  echo "      SERVER_PROCESSORS_RS."
  fail=1
fi

n_lib_packages="${#FRAMEWORK_LIB_ROOTS[@]}"
if [ "$n_lib_packages" -lt "$MIN_LIB_PACKAGES" ]; then
  echo "FAIL: the derived framework surface resolved to $n_lib_packages reserved package(s),"
  echo "      below the floor of $MIN_LIB_PACKAGES. The roots are DERIVED from"
  echo "      $PROCESSORS_DIR/_*/manifest.yaml — a short derivation means the packages moved"
  echo "      or lost their manifests, and this guard was about to scan less framework code"
  echo "      than the tree ships."
  fail=1
fi

LIB_FILES=''
for root in "${FRAMEWORK_LIB_ROOTS[@]}"; do
  globs="$(py_test_globs "$root")"
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    is_py_test "$f" "$globs" && continue
    LIB_FILES="${LIB_FILES}${f}
"
  done <<EOF
$(git ls-files --cached --others --exclude-standard -- "$root" 2>/dev/null |
    grep -E '\.py$' | grep -vE "(^|/)($_TEST_SEG_RE)/" | sort -u)
EOF
done
n_lib_files="$(printf '%s' "$LIB_FILES" | grep -c . || true)"

if [ "$n_lib_files" -lt "$MIN_LIB_FILES" ]; then
  echo "FAIL: the framework scan set resolved to $n_lib_files file(s), below the floor"
  echo "      of $MIN_LIB_FILES. Either a reserved package moved/renamed (the roots are"
  echo "      DERIVED from $PROCESSORS_DIR/_*/manifest.yaml — currently"
  echo "      ${FRAMEWORK_LIB_ROOTS[*]}), or a pytest \`python_files\` glob widened until it"
  echo "      swallowed the modules themselves — either way this guard was about to PASS"
  echo "      without scanning the framework code that is staged into every processor."
  fail=1
fi

# The PINNED set: read from the SAME manifest `check-guard-integrity.sh` verifies, so an
# unpinned or renamed guard cannot claim the exemption at all. Since #304 this is no longer
# a set of EXEMPT FILES — it is the set of files whose DECLARED vocabulary block is honoured
# (see the header). Every one of them is still scanned everywhere else.
GUARD_PINNED=''
if [ -f "$GUARD_MANIFEST" ]; then
  GUARD_PINNED="$(sed -e 's/#.*//' -e 's/^[[:space:]]*//' "$GUARD_MANIFEST" |
    awk 'NF == 2 { print $2 }' | sort -u)"
else
  echo "FAIL: $GUARD_MANIFEST is missing, so the BUILD surface has no structural definition"
  echo "      of which files may DECLARE a vocabulary block (a guard that must spell the"
  echo "      vocabulary it hunts). Restore it: scripts/check-guard-integrity.sh --update"
  fail=1
fi

# The JS TEST MODULES, derived from the justfile rather than typed here — see the header.
# The same trade `py_test_globs` makes for pytest: read the declaration the tree runs under.
JS_TEST_FILES=''
if [ -f "$JUSTFILE" ]; then
  # 1. drop justfile COMMENTS before looking for the declaration — a comment is not
  #    something the tree runs, and treating it as one was a whole-file exemption for a
  #    line of prose. A `#` inside a recipe-s own shell is stripped too; that can only
  #    REMOVE an exemption, never add one.
  # 2. the invocation must not sit INSIDE A QUOTED STRING: an `@echo "run: node --test x.mjs"`
  #    is a real, non-comment recipe line and still runs nothing. The decision is made on the
  #    line with its QUOTED SPANS blanked — so `node --test` must appear outside every quote.
  #    The first cut tested "no quote character before the `node` token", which rejected three
  #    idiomatic forms outright (`NODE_OPTIONS="..." node --test ...`, `cd "..." && node --test
  #    ...`) — a cry-wolf that would have pushed someone to disable this. Stated limit: an
  #    UNquoted `echo node --test x.mjs` still passes this half; key 2 then decides, and it
  #    only ever exempts a genuine test module anyway.
  # 3. allow node flags between `--test` and the path.
  # 4. accept ONLY a repo-root `scripts/<name>.mjs`, anchored — the greedy rewrite let
  #    `src-app/ui/scripts/x.mjs` exempt the repo-root `scripts/x.mjs` that was never named.
  #    Deliberately NOT widened to subdirectories: no `scripts/*/*.mjs` exists and no
  #    declaration names one, so widening it would be an exemption bound to no change, which
  #    is what `docs/design/derived-guards.md` §5 refuses.
  # 5. and require the file to actually IMPORT `node:test` (the second key, above).
  _declared="$(sed -e 's/^[[:space:]]*#.*//' -e 's/[[:space:]]#.*//' "$JUSTFILE" |
    awk '{ u = $0; gsub(/"[^"]*"/, " ", u); gsub(/\047[^\047]*\047/, " ", u);
           if (u ~ /node[[:space:]]+--test/) print }' |
    grep -oE 'node[[:space:]]+--test([[:space:]]+--[^[:space:]]+)*[[:space:]]+[^[:space:]]+\.mjs' |
    sed -e 's#.*[[:space:]]##' -e 's#^["]##' -e "s#^[']##" -e 's#^{{justfile_directory()}}/##' |
    grep -E '^scripts/[A-Za-z0-9._-]+\.mjs$' | sort -u)"
  JS_TEST_FILES="$(
    printf '%s\n' "$_declared" | while IFS= read -r _m; do
      [ -n "$_m" ] || continue
      # The SECOND key, and it is a property the FILE carries: it imports the test runner.
      # Two greps rather than one bracket class, so neither quote character has to be
      # escaped into a pattern (a `\x27` escape is not portable across sed/grep dialects,
      # and this file must run under bash on Linux, macOS and git-bash).
      # The specifier must sit where an IMPORT puts it — directly after `from`, `import` or
      # `require(` — and NOT on a comment line. Two narrower rules were measured and both were
      # worse: matching the specifier anywhere let `const RUNNER_SPEC = "node:test"` satisfy
      # the key (a guard that INSPECTS test imports would spell it exactly so), while
      # anchoring the whole pattern at the start of a line stopped matching a prettier-wrapped
      # `import {` / `  test,` / `} from 'node:test'`, so a purely COSMETIC reformat could trip
      # the floor and hard-FAIL this guard. Dropping comment lines first satisfies both: a
      # wrapped import still matches on its `} from ...` line, and a commented-out one does not.
      if grep -vE '^[[:space:]]*(//|/\*|\*|#)' "$_m" 2>/dev/null |
           grep -qE '(from|import|require\()[[:space:]]*"node:test"' ||
         grep -vE '^[[:space:]]*(//|/\*|\*|#)' "$_m" 2>/dev/null |
           grep -qE "(from|import|require\()[[:space:]]*'node:test'"; then
        printf '%s\n' "$_m"
      fi
    done
  )"
fi
n_js_tests="$(printf '%s\n' "$JS_TEST_FILES" | grep -c . || true)"
# Anti-vacuity, scoped to the case where it can MEAN something — the same rule this guard
# already applies to `MIN_ENV_RECIPES`, and for the same reason. A tree with no `scripts/*.mjs`
# at all has nothing to exclude, so zero declared test modules is the RIGHT answer there, and
# failing on it would be a floor firing on a legitimate zero. That is not hypothetical: the
# synthetic fixture repos this guard is tested against have no `.mjs` tier, and an
# unconditional floor failed all seventeen of them on a missing scaffold rather than on
# anything they assert.
# …and the condition is keyed on the floor's own SUBJECT — a `.mjs` that IMPORTS `node:test`,
# i.e. a module that could be declared — not on any `.mjs` existing at all. Keyed on the wider
# set it hard-failed a legitimate zero: a tree carrying only non-test `.mjs` helpers (a real
# shape) has nothing to declare, and the floor fired on it with a message blaming the justfile.
n_build_mjs=0
while IFS= read -r _cand; do
  [ -n "$_cand" ] || continue
  if grep -vE '^[[:space:]]*(//|/\*|\*|#)' "$_cand" 2>/dev/null |
       grep -qE '(from|import|require\()[[:space:]]*"node:test"' ||
     grep -vE '^[[:space:]]*(//|/\*|\*|#)' "$_cand" 2>/dev/null |
       grep -qE "(from|import|require\()[[:space:]]*'node:test'"; then
    n_build_mjs=$((n_build_mjs + 1))
  fi
done <<EOF
$(git ls-files --cached --others --exclude-standard -- 'scripts/*.mjs' 2>/dev/null)
EOF
if [ "$n_build_mjs" -gt 0 ] && [ "$n_js_tests" -lt "$MIN_JS_TEST_FILES" ]; then
  echo "FAIL: the justfile declared $n_js_tests \`node --test\` .mjs path(s), below the floor of"
  echo "      $MIN_JS_TEST_FILES. That derivation is what excludes the control suites from the build"
  echo "      surface; a collapsed one would scan them, report their planted vocabulary as a"
  echo "      leak, and train everyone to ignore this guard. Re-point the reader at how the"
  echo "      justfile now invokes them. Do NOT replace it with a \`*.test.mjs\` pattern typed"
  echo "      into this file — a rule spelled in the guard drifts from the rule the tree runs"
  echo "      under, which is the whole reason the vocabulary itself is derived."
  echo ""
  echo "      A module counts only if BOTH keys hold: the justfile declares it on a"
  echo "      NON-COMMENT line as a repo-root scripts/<name>.mjs (node flags between"
  echo "      \`--test\` and the path are fine), AND the file itself imports \`node:test\`."
  echo "      Declared-but-not-importing is the likelier half to have moved."
  fail=1
fi

# ── THE BUILD SURFACE, DERIVED FROM THE DECLARATION ────────────────────────────
# `surface_root` is a tracked path that is build tooling wherever it sits; `surface_dir` is a
# directory NAME, and every file git tracks under a directory of that name AT ANY DEPTH is
# build tooling. The second half is the #324 repair: `git ls-files -- scripts` is a pathspec
# rooted at the repo, so it never saw `src-app/libs/viz/scripts/`; a PATH-SEGMENT filter over
# the whole tracked set has no root to be wrong about.
# ── THE BUILD SURFACE, DERIVED FROM THE DECLARATION ────────────────────────────
# `surface_root` is a tracked path that is build tooling wherever it sits; `surface_dir`
# is a directory NAME, and every file git tracks under a directory of that name AT ANY
# DEPTH INSIDE THE SCAN ROOTS is build tooling. The depth half is the #324 repair:
# `git ls-files -- scripts` is a pathspec rooted at the repo, so it never saw
# `src-app/libs/viz/scripts/`; a PATH-SEGMENT filter has no root to be wrong about.
#
# Bounded by the SCAN ROOTS, and that bound is not incidental. Unbounded, the walk
# reaches `scripts/` directories the wholesale pytest cannot see (`docs/scripts/`, say),
# which makes the fast guard range over a region with no backstop — the containment
# TEST-24 exists to hold, violated by the guard that was supposed to be its subset. In
# scope for both, or in scope for neither.
#
# And the DATA ROOTS come out, on this tier as on the app-core tier. A contributed
# package's own vocabulary is what it is FOR; scanning a package that ships a `scripts/`
# directory would report its own declared id as a leak, which is derived-guards.md §1's
# "starts refusing things it never meant to refuse" landing on precisely the act INV-3
# keeps free. The first cut of this widening dropped `src-app/packages/` on the app-core
# tier and not here; a blind audit reproduced both halves.
#
# No escaping anywhere below, and that is a property rather than an omission: every value
# is validated to a charset with no metacharacter in awk, grep, git-pathspec or Python.
# The first cut escaped ERE-style and fed the result to a BRE `grep`, where `\+` is an
# OPERATOR — so a declared exception exempted a DIFFERENT directory than the one written.
SURFACE_DIR_FILES="$(
  git ls-files --cached --others --exclude-standard -- ${SCAN_ROOTS[@]+"${SCAN_ROOTS[@]}"} 2>/dev/null |
    grep -E "(^|/)$(_re "$SURFACE_DIR")/" || true
)"
# Subtracted from the DIRECTORY WALK here (so the floor and the exception checks below see the
# same set the scan will), and from the FINAL union below (so a `surface_root` that sits inside
# a data root is dropped too). The first cut did only the former, and the counterpart did only
# the latter — two rules from one declaration, which is the defect the declaration exists to
# remove. Both, in both readers, matching `^r$` as well as `^r/` so a root naming a FILE works.
_drop_data_roots() { # reads a file list on stdin
  _out="$(cat)"
  for _r in ${DATA_ROOTS[@]+"${DATA_ROOTS[@]}"}; do
    _out="$(printf '%s\n' "$_out" | grep -v -e "^$(_re "$_r")\$" -e "^$(_re "$_r")/" || true)"
  done
  printf '%s\n' "$_out"
}
SURFACE_DIR_FILES="$(printf '%s\n' "$SURFACE_DIR_FILES" | _drop_data_roots)"
# Counted BEFORE the exceptions are subtracted — see MIN_SURFACE_DIRS.
n_surface_dirs="$(
  printf '%s\n' "$SURFACE_DIR_FILES" | grep . |
    sed -E "s#(.*)$(_re "$SURFACE_DIR")/.*#\1${SURFACE_DIR}#" | sort -u | grep -c . || true
)"
if [ "$n_surface_dirs" -lt "$MIN_SURFACE_DIRS" ]; then
  echo "FAIL: the \`$SURFACE_DIR\` walk found $n_surface_dirs director(y/ies), below the floor of"
  echo "      $MIN_SURFACE_DIRS. The floor is >= 2 because that is what asserts the walk CROSSES"
  echo "      THE REPO ROOT. A derivation that has regressed to a root-only pathspec resolves to"
  echo "      1 and is exactly the gap #324 leaked through — a build script one directory deeper"
  echo "      than \`$SURFACE_DIR/\` being invisible to this guard while the wholesale pytest"
  echo "      carried the red to main. Re-point the derivation; do NOT lower this."
  fail=1
fi
# Every exception must NAME A REAL PATH *inside a surface dir*. Naming a tracked path is
# not enough: an entry pointing at something the walk never reaches narrows nothing and
# reads, from the outside, exactly like one that does.
n_exceptions=0
for _ex in ${SURFACE_EXCEPTIONS[@]+"${SURFACE_EXCEPTIONS[@]}"}; do
  n_exceptions=$((n_exceptions + 1))
  if [ "$(printf '%s\n' "$SURFACE_DIR_FILES" | grep -c -e "^$(_re "$_ex")\$" -e "^$(_re "$_ex")/" || true)" -eq 0 ]; then
    echo "FAIL: $SURFACE_DECL declares \`surface_exception $_ex\`, and no tracked file at or under"
    echo "      that path sits in a \`$SURFACE_DIR\` directory inside the scan roots. An exception"
    echo "      that names nothing does not narrow this guard — it is an entry nobody can check,"
    echo "      sitting where a real one would be. Delete it, or re-point it at what it meant."
    fail=1
  fi
done
# THE CAP, and it is the honest replacement for a claim this guard used to make. An
# earlier annotation said MIN_BUILD_FILES was a "second, INDEPENDENT detector" of the
# exempt-the-leaking-directory dodge. It is not: it detected it only at that day's file
# count, and a blind audit paid the shortfall straight back by ALSO adding a
# `surface_root`, landing exactly on the floor with the leak exempt and the guard green.
# A count over a growing tree cannot carry that property. What can is this: the number of
# exceptions is frozen HERE, in a byte-pinned guard, so a SIXTH one costs an edit to a
# SECOND pinned file in the same commit — two reviewed diffs, which is the same two-key
# shape #304 gave the vocabulary block. It does not stop an existing entry being
# re-pointed; nothing decidable does, and §7.1 says so at length about the block. What it
# stops is an exception ARRIVING in the one diff that needed it.
# THE SECOND EXEMPTION AXIS GETS THE SAME CAP. See MAX_TEST_SEGMENTS for what a blind
# round did with this field for the price of one re-pin. Counted from the declaration, so a
# reader of the diff sees the number move in the same commit as the record.
n_test_segments=0
for _seg in ${TEST_SEGMENTS[@]+"${TEST_SEGMENTS[@]}"}; do
  n_test_segments=$((n_test_segments + 1))
done
# …and every declared segment must CLASSIFY SOMETHING. A capped slot naming nothing is a
# pre-paid exemption: the cap prices ADDING a segment and says nothing about RE-POINTING one, so
# an inert member is a free slot a later commit can spend on any directory it likes without the
# count moving. §3's "a marker naming nothing is a guard switched off", read on the axis that
# prices this one. Measured over the SCAN ROOTS rather than the app-core set, because the
# question is whether the segment classifies any tracked file as test code at all.
for _seg in ${TEST_SEGMENTS[@]+"${TEST_SEGMENTS[@]}"}; do
  if [ "$(git ls-files --cached --others --exclude-standard -- ${SCAN_ROOTS[@]+"${SCAN_ROOTS[@]}"} 2>/dev/null |
            grep -cE "(^|/)$(_re "$_seg")/" || true)" -eq 0 ]; then
    echo "FAIL: $SURFACE_DECL declares \`test_path_segment $_seg\`, and no tracked file under the"
    echo "      scan roots sits on such a path. An exemption slot that classifies nothing is not"
    echo "      harmless: the cap prices ADDING a segment and says nothing about RE-POINTING one,"
    echo "      so an inert member is a slot a later commit spends on any directory it likes with"
    echo "      the count never moving. Delete it; re-add it the day the convention arrives, which"
    echo "      is the same two committed diffs anything else here costs."
    fail=1
  fi
done

if [ "$n_test_segments" -gt "$MAX_TEST_SEGMENTS" ]; then
  echo "FAIL: $SURFACE_DECL declares $n_test_segments \`test_path_segment\` record(s); the cap is"
  echo "      $MAX_TEST_SEGMENTS. A path segment is an EXEMPTION with the same reach as a"
  echo "      \`surface_exception\` and, until a blind round said so, a lower price: one line here"
  echo "      silenced a real planted leak in both guards. If the new segment is right, RAISE"
  echo "      MAX_TEST_SEGMENTS in check-derived-vocabulary.sh in the same commit, and re-pin."
  fail=1
fi

# A `surface_root` INSIDE a `data_root` is a contradiction in the declaration, and the
# dangerous kind: it passes the charset, it passes the names-a-real-path check, and then
# _drop_data_roots removes every file it contributed — so it is a declared surface that
# contributes NOTHING while the PASS line reports the same count as before. That is §3's
# "a marker naming nothing", one field over from where this file already closed it, and a
# blind round found it by appending `surface_root src-app/packages/_lib` and watching the
# build count not move. Saying which of the two records is wrong is not this guard's job;
# saying that they cannot both be right is.
for _r in ${BUILD_SURFACE_ROOTS[@]+"${BUILD_SURFACE_ROOTS[@]}"}; do
  for _d in ${DATA_ROOTS[@]+"${DATA_ROOTS[@]}"}; do
    case "$_r" in
      "$_d"|"$_d"/*)
        echo "FAIL: $SURFACE_DECL declares \`surface_root $_r\`, which is at or under"
        echo "      \`data_root $_d\`. The data-root exclusion then removes everything that root"
        echo "      contributes, so it is a surface that scans nothing while this guard reports"
        echo "      the same PASS — indistinguishable from the outside from one that works."
        echo "      One of the two records is wrong; both cannot be right."
        fail=1
        ;;
    esac
  done
done

if [ "$n_exceptions" -gt "$MAX_SURFACE_EXCEPTIONS" ]; then
  echo "FAIL: $SURFACE_DECL declares $n_exceptions \`surface_exception\` record(s); the cap is"
  echo "      $MAX_SURFACE_EXCEPTIONS. The cap is not a style rule — it is what stops an exception being added in"
  echo "      the same diff that needed one, which is how the leak it covers ships green. If the"
  echo "      new exception is right, RAISE THIS in check-derived-vocabulary.sh in the same"
  echo "      commit, and re-pin: two committed diffs, with a human reading both."
  fail=1
fi
BUILD_FILES="$(
  { git ls-files --cached --others --exclude-standard -- ${BUILD_SURFACE_ROOTS[@]+"${BUILD_SURFACE_ROOTS[@]}"} 2>/dev/null
    printf '%s\n' "$SURFACE_DIR_FILES"; } |
    grep . | _drop_data_roots | grep . | sort -u
)"
for _ex in ${SURFACE_EXCEPTIONS[@]+"${SURFACE_EXCEPTIONS[@]}"}; do
  BUILD_FILES="$(
    printf '%s\n' "$BUILD_FILES" | grep -v -e "^$(_re "$_ex")\$" -e "^$(_re "$_ex")/" || true
  )"
done
if [ -n "$JS_TEST_FILES" ]; then
  BUILD_FILES="$(printf '%s\n' "$BUILD_FILES" | grep -vxF "$JS_TEST_FILES" || true)"
fi
# THE BUILD TIER DOES NOT APPLY THE TEST-SEGMENT EXCLUSION, AND ASSERTS THAT IT WOULD NOT
# MATTER. Build tooling is build tooling wherever it sits; a file under a `SURFACE_DIR/`
# directory is in this tier because of WHERE it is, and letting a typed segment name delete it
# is the fail-open MAX_TEST_SEGMENTS documents — `test_path_segment viz` removed 10 build
# files, the planted leak among them, and printed PASS. (TEN, not the nine first recorded:
# `src-app/libs/viz/scripts/` holds nine tracked files and the plant was the tenth. The first
# figure subtracted a planted tree's count from an unplanted baseline — a measurement taken
# over a set that is not the set you think it is, which is this branch's own subject.)
#
# It is an ASSERTION rather than a silent removal because the segments are still one list
# across the readers, and a build file under a `tests/` path is scanned HERE while the
# wholesale side's scan set still drops it — a region the fast guard ranges over with no
# backstop, which is §7.1's whole subject. The wholesale side says the same thing from the
# other direction (TEST-24 goes red), so this exists to say it where the tree is, with a
# remedy, rather than only as a containment failure two files away.
#
# CHECKED AFTER THE SUBTRACTIONS, and a blind round is why. The first cut computed it BEFORE
# the `surface_exception` and js-test subtractions ran, so neither of the two remedies its own
# message named could ever clear it — and one of the two could not have worked in any order:
# the js-test derivation is anchored at the repo ROOT (`^scripts/<file>.mjs$`, one segment),
# and a path that trips this assertion necessarily has a directory component, so no file can
# ever satisfy both. A guard that fails with an unreachable remedy is §1's false red with the
# remedy line making it worse, not better. The message now names what actually works.
#
# MEASURED 2026-09-07: zero tracked files under the scan roots sit under both a `SURFACE_DIR/`
# directory and a declared test segment, so this removes nothing today — which is exactly why
# the filter it replaces could only ever have been used to remove something it should not.
_seg_in_build="$(printf '%s\n' "$BUILD_FILES" | grep -E "(^|/)($_TEST_SEG_RE)/" || true)"
if [ -n "$(printf '%s' "$_seg_in_build" | grep . || true)" ]; then
  echo "FAIL: a declared \`test_path_segment\` matches file(s) on the BUILD surface:"
  printf '%s\n' "$_seg_in_build" | grep . | head -20 | sed 's/^/        /'
  echo "      This tier scans them and the wholesale backstop does not, because its scan set"
  echo "      still drops a declared test segment — a region one guard ranges over alone, which"
  echo "      is the relation #324 broke. It is also how one line in $SURFACE_DECL"
  echo "      once deleted a whole \`$SURFACE_DIR/\` directory, with a planted leak in it, at exit 0."
  echo "      TWO remedies, both reviewed, and neither is silent:"
  echo "        * declare each file above as a \`surface_exception\` — it costs the"
  echo "          MAX_SURFACE_EXCEPTIONS cap in THIS pinned guard as well as the record there."
  echo "          KNOW WHAT THAT BUYS: an exception is normally PARTIAL, because the wholesale"
  echo "          backstop does not apply exceptions at all. For a file that ALSO sits on a"
  echo "          declared test segment the backstop drops it too, so the pair is a TOTAL"
  echo "          exemption — that file is then scanned by nobody. Prefer moving it; or"
  echo "        * withdraw the segment from $SURFACE_DECL, which puts these files back"
  echo "          under the wholesale scan and re-exposes every app-core file that segment covered."
  echo "      What does NOT work is the justfile's \`node --test\` route: that derivation is"
  echo "      anchored at the repo root, so it can never name a path with a directory in it."
  fail=1
fi
n_build_files="$(printf '%s\n' "$BUILD_FILES" | grep -c . || true)"

if [ "$n_build_files" -lt "$MIN_BUILD_FILES" ]; then
  echo "FAIL: the build scan set resolved to $n_build_files file(s), below the floor of"
  echo "      $MIN_BUILD_FILES. Either a BUILD_SURFACE_GLOB no longer matches (the recipes moved),"
  echo "      or the js-test derivation widened until it swallowed the build tier — either way"
  echo "      this guard was about to PASS without scanning the tooling that stands the app up."
  fail=1
fi

[ "$fail" -eq 0 ] || exit 1

# ── 3. SCAN ─────────────────────────────────────────────────────────────────────
SCAN_AWK='
function boundary(c) { return (c == "" || c !~ /[A-Za-z0-9_-]/) }

# ---- pass 1: the derived terms -------------------------------------------------
FNR == NR {
  if ($0 == "") next
  n++; kind[n] = $1; term[n] = $2
  next
}

# ---- pass 2: the file under scan ----------------------------------------------
FNR == 1 { skip = 0; pend = 0; depth = 0; vocab = 0; vocabline = 0; jsblock = 0; jsblockline = 0 }

# ---- the DECLARED vocabulary block (#304) --------------------------------------
# The narrowed self-reference exemption. It exists ONLY on the BUILD surface (`BLOCKS`),
# because that is the only tier whose scanned files are guards; on the app-core and
# framework tiers a marker is just text and is scanned like any other line. Gating it is
# not cosmetic: without `BLOCKS` this rule ran with `EXEMPT` unset for those tiers too, and
# a marker in a `.rs`/`.py` file emitted a raw structural record into the LEAK report, under
# a banner that described it wrongly.
#
# `EXEMPT` is 1 only for a file PINNED in the guard manifest; in a build file that is NOT
# pinned the markers are a hard failure rather than a silent no-op, because an author who
# believes they have an exemption they do not have is exactly how a leak gets typed in next
# to a marker and shipped.
#
# THREE ways of getting the block wrong, all fail-closed, and the third is the one a blind
# audit had to find:
#   * UNTERMINATED — it would blank the rest of the file, which is the whole-file exemption
#     this replaced, reintroduced by a typo and invisible from the outside;
#   * STRAY / NESTED — a marker pair that does not nest is a block whose extent nobody can
#     read off the file;
#
# ── WHAT BOUNDS THE BLOCK, AND WHAT DOES NOT (read this before adding a predicate) ──
# Three successive attempts were made to bound the block SYNTACTICALLY — "every line carries a
# forbidden term", then "…on the stripped line", then "…and is an assignment" — and a blind
# audit defeated each one in a single line: a trailing `# <term>` laundered any line in; a real
# `case $KIND in <term>)` spells a term; and `_=1; case $KIND in <term>)` is assignment-shaped.
# The last attempt ALSO cried wolf on six ordinary declaration forms (a multi-line array, an
# `export const`, `declare -r`, `+=`, an indexed assignment, a heredoc).
#
# That is the documented shape of a losing game: a predicate over a SEMANTIC property
# ("declares" versus "dispatches") has an unbounded evasion space, so each round only finds
# another spelling. The predicate is therefore GONE rather than sharpened again, and what
# actually bounds the block is stated instead of implied:
#
#   THE BLOCK IS BOUNDED BY THE PIN, NOT BY A PATTERN. The marker is honoured only in a file
#   whose BYTES are pinned in scripts/guard-hashes.txt, so ANY edit inside the block — adding a
#   line, changing a line, widening the block — changes the file hash and FAILS
#   check-guard-integrity.sh until it is re-pinned in the same commit. A re-pin is a one-line
#   diff in a committed manifest with a human on the other side of it. That is the control;
#   the markers make its SCOPE readable, and nothing here decides whether the bytes inside
#   deserve the exemption. Stated plainly so nobody assumes otherwise: a marker pair around an
#   ENTIRE pinned guard, dispatch included, is GREEN on every automated gate once the re-pin
#   this repo already tells the author to run has been run. The content control is the human
#   who reads that one-line manifest diff.
#
# What is still checked below is only what is DECIDABLE from the text, with no evasion space:
# the marker must be in a pinned file, the block must be terminated, and the markers must
# nest. Those are structural facts, not judgements about intent.
# Structural findings are printed with a !! prefix and split out by the caller, so they can
# never be mistaken for (or hidden among) vocabulary hits.
# The stripped form of this line, computed ONCE for the build tier so the block rule and the
# scan below cannot disagree about what the line says. They did: the bound read the RAW line,
# so appending `# <a declared term>` to ANY line satisfied it and the whole-file exemption
# came straight back — with a term the block does not even declare.
BLOCKS == 1 { bcode = strip_build($0) }

BLOCKS == 1 {
  if ($0 ~ ("^[[:space:]]*(#|//)[[:space:]]*" VCLOSE "([[:space:]]|$)")) {
    if (!EXEMPT) { printf "!!UNPINNED\t%s\t%d\n", FILE, FNR; next }
    if (!vocab) printf "!!STRAY\t%s\t%d\n", FILE, FNR
    vocab = 0
    next
  }
  if ($0 ~ ("^[[:space:]]*(#|//)[[:space:]]*" VOPEN "([[:space:]]|$)")) {
    if (!EXEMPT) { printf "!!UNPINNED\t%s\t%d\n", FILE, FNR; next }
    if (vocab) printf "!!NESTED\t%s\t%d\n", FILE, FNR
    vocab = 1
    vocabline = FNR
    next
  }
  if (vocab) next
}

END {
  if (BLOCKS == 1 && vocab) printf "!!UNTERMINATED\t%s\t%d\n", FILE, vocabline
  # A `/*` this stripper opened and never closed blanks the REST OF THE FILE — the same
  # silent whole-file exemption the vocabulary block is hardened against, arriving through
  # the comment syntax instead. It happens on a shape this stripper cannot parse (a regex
  # character class holding a slash-star, which is legal JS), so it is reported rather than
  # guessed at.
  if (jsblock) printf "!!JSBLOCK\t%s\t%d\n", FILE, jsblockline
}

{
  raw = $0
  code = raw

  # Already computed above for the build tier — and it MUST be reused rather than recomputed,
  # because `strip_js` carries the multi-line block-comment state and calling it twice per
  # line would advance that state twice.
  if (BLOCKS == 1) { code = bcode }
  else if (DIALECT == "rs") {
    # blank an in-source test item wholesale: #[cfg(test)] mod, #[test] fn,
    # #[tokio::test] fn. Test code may legitimately name the vocabulary (a fixture,
    # or a sibling grep-guard that must SPELL what it searches for).
    if (skip > 0) {
      depth += gsub(/\{/, "{", code) - gsub(/\}/, "}", code)
      if (depth <= 0) skip = 0
      next
    }
    if (raw ~ /^[[:space:]]*#\[(cfg\(test\)|test|tokio::test|rstest)/) { pend = 1; next }
    if (pend == 1) {
      if (code ~ /\{/) {
        depth = gsub(/\{/, "{", code) - gsub(/\}/, "}", code)
        pend = 0
        if (depth > 0) skip = 1
        next
      }
      if (code ~ /;[[:space:]]*$/) { pend = 0; next }
      next
    }
    # Rust: only the double quote opens a string. A single quote is a LIFETIME far more
    # often than a char literal, and treating it as a string delimiter would leave the
    # stripper permanently "inside a string" — which stops the comment marker being
    # honoured and turns every domain term in the following comments into a false
    # positive. (This comment may not itself contain a single quote: the whole awk
    # program is a single-quoted shell string.)
    code = strip_comment(raw, "//", "\"", 0)
  } else if (DIALECT == "py") {
    # Python: `#` opens a comment, and BOTH quote characters open a string, so the
    # stripper is handed the pair. Docstrings are deliberately NOT exempt — see the
    # dialect note in this file header: a triple-quoted block is a string object, so
    # exempting it would be a fail-open, not a courtesy to prose.
    code = strip_comment(raw, "#", "\"\047", 0)
  } else if (DIALECT == "js") {
    # JavaScript/ESM has its own stripper rather than a `strip_comment` call, and a blind
    # audit is why: `strip_comment` knows a line marker and string quotes, which is not
    # enough for this language in EITHER direction.
    #   * FAIL-OPEN, demonstrated: the `//` produced by an ESCAPED SLASH in a regex literal
    #     (`s.split(/\//)`, `/^https:\/\//`) read as a comment marker and truncated the rest
    #     of the line, so a planted id after one exited 0. That is the same shape the header
    #     above cites as the live fail-open in the sibling JS guard.
    #   * CRY-WOLF, demonstrated: `/* ... */` and JSDoc blocks were not stripped, so prose
    #     naming an id inside a block comment was reported while the identical prose in a
    #     `//` comment was not — and the newly-widened surface is exactly where block
    #     comments dominate.
    code = strip_js(raw)
  } else if (DIALECT == "sh") {
    # Shell + justfile: `#` opens a comment ONLY at the start of a WORD (line start or
    # after whitespace). Without that rule the stripper would truncate at the `#` in
    # `$#`, `${#arr[@]}` and `${v#pat}` — dropping the rest of a live line out of the
    # scan, which is a fail-OPEN. Both quote characters open a string.
    code = sh_blank_expansion_ops(strip_comment(raw, "#", "\"\047", 1))
  } else if (DIALECT == "sql") {
    code = strip_comment(raw, "--", "\047", 0)
  }
  # No `else` arm: `raw` is reachable only on the BUILD tier, where `strip_build` supplies it
  # above. An `else { code = raw }` here was DEAD, and it mattered — a control named it as the
  # thing it was mutating, so mutating it proved nothing while the live arm went untested.

  for (i = 1; i <= n; i++) {
    if (kind[i] == "compound") {
      pos = 0; rest = code
      while ((p = index(rest, term[i])) > 0) {
        pos += p
        L = (pos > 1) ? substr(code, pos - 1, 1) : ""
        R = substr(code, pos + length(term[i]), 1)
        if (boundary(L) && boundary(R)) { report(term[i]); break }
        rest = substr(code, pos + 1)
      }
    } else {
      if (index(code, "\"" term[i] "\"") > 0 || index(code, "\047" term[i] "\047") > 0) report(term[i])
    }
  }
}

# The BUILD tier stripper, factored out so the vocabulary-block bound and the scan below
# read the SAME text. `rs` never reaches here (it is not a build dialect) and keeps its own
# stateful in-source-test handling in the main rule.
function strip_build(raw) {
  if (DIALECT == "js")  return strip_js(raw)
  if (DIALECT == "py")  return strip_comment(raw, "#", "\"\047", 0)
  if (DIALECT == "sh")  return sh_blank_expansion_ops(strip_comment(raw, "#", "\"\047", 1))
  if (DIALECT == "sql") return strip_comment(raw, "--", "\047", 0)
  return raw
}

# One escaped character, resolved for the scan. A word character is an escape SEQUENCE and is
# blanked (so `\\n` cannot glue an `n` onto the token before it); anything else is the literal
# character and is kept (so `\\/` cannot hide a compound id). Length is preserved either way,
# because the caller computes match positions on the returned string.
function unescape(ch, bs) {
  if (ch == "") return " "
  # A dialect that KEEPS the backslash on an unknown escape needs no table at all, and this is
  # the round-5 simplification: in such a dialect the backslash SURVIVES either way, and a
  # backslash is itself a token boundary — so whether the letter is an escape sequence or not
  # cannot change the verdict. A per-dialect table there would be an untestable claim, which is
  # the thing this branch exists to remove. Python, shell and Rust take that path.
  #
  # JavaScript is the one dialect where it matters, because an unknown escape DROPS the
  # backslash (`"\\a" === "a"`), so the letter joins the token beside it:
  #   * a real escape sequence is blanked — otherwise the `n` of a trailing `\\n` glues onto the
  #     term and kills its right-hand boundary (round 3);
  #   * anything else IS the character — otherwise the identity escape hides the term, because
  #     `\"d\\a/result\"` really is `da/result` (round 4).
  # `x`/`u` are hex/unicode PREFIXES and `0`-`7` the octal ones; the digits after them are
  # ordinary characters. Residual, declared: a term spelled entirely in hex still gets through,
  # which is the tokenizer-shaped limit filed as #312 rather than patched again here.
  if (DIALECT != "js") return bs ch
  if (index("bfnrtv01234567xu", ch) > 0) return " "
  return ch
}

# The JS/ESM stripper. Four things, and each of the last three was a demonstrated defect in
# the version that reused the generic `strip_comment`:
#   * `//` to end of line, as before;
#   * `/* ... */`, INCLUDING across lines — `jsblock` is deliberately a global so the state
#     survives the record boundary (it is reset per file at FNR == 1);
#   * all three string openers: the double quote, the apostrophe (\047) and the backtick
#     (\140), each closed only by itself;
#   * a backslash escape OUTSIDE a string, which is what stops a regex literal like the
#     escaped-slash form from being read as a comment marker.
# Known limit, stated because the last one was found by mutation and not by reading: this is
# not a JS lexer. An unescaped slash-delimited regex whose body ends in a slash-slash pair
# would still truncate. That direction is fail-OPEN, so if such a shape ever ships here the
# answer is a real tokenizer, not another special case.
function strip_js(line,   out, i, L, c, d, instr, opener) {
  out = ""; i = 1; L = length(line); instr = 0; opener = ""
  while (i <= L) {
    c = substr(line, i, 1)
    d = substr(line, i, 2)
    if (jsblock) {
      if (d == "*/") { jsblock = 0; out = out "  "; i += 2; continue }
      out = out " "; i++; continue
    }
    if (instr) {
      # WHAT is escaped decides. Round 2 blanked both characters and hid `"spatial\\/image"`;
      # round 3 kept both and hid `"geneset/collection\\n"` — the trailing `\\n` came back as a
      # WORD character, killed the right-hand token boundary, and a printf-with-newline is the
      # idiomatic way to write that line. Two fail-opens, opposite directions, same rule.
      #   * an escaped WORD character (`\\n`, `\\t`, `\\x`) is blanked — it is an escape SEQUENCE,
      #     never part of the token beside it;
      #   * an escaped NON-word character (`\\/`, `\\.`, `\\-`) keeps the character — it IS the
      #     character, and dropping it is what hid the escaped compound id.
      # Keeping a non-word character cannot re-open a comment: the comment test reads the
      # INPUT by position and never re-examines what has been emitted.
      if (c == "\\") { out = out unescape(substr(line, i + 1, 1), c); i += 2; continue }
      if (c == opener) instr = 0
      out = out c; i++; continue
    }
    if (c == "\"" || c == "\047" || c == "\140") { instr = 1; opener = c; out = out c; i++; continue }
    if (c == "\\") { out = out unescape(substr(line, i + 1, 1), c); i += 2; continue }
    if (d == "/*") { jsblock = 1; jsblockline = FNR; out = out "  "; i += 2; continue }
    if (d == "//") break
    out = out c; i++
  }
  return out
}

# String-AWARE comment strip. `quotes` is the SET of characters that open a string in this
# dialect (one for Rust/SQL, both for Python and shell). Naive `//`-stripping was a live
# fail-open in the sibling JS guard: a `"https://…"` literal blanked the rest of its own
# line out of the scan. A string is closed only by the character that OPENED it, so an
# apostrophe inside a double-quoted Python string cannot terminate it.
# `wordstart` (shell) additionally requires the marker to begin a WORD, so parameter
# expansions (`$#`, `${#a[@]}`, `${v#pat}`) are not mistaken for a comment.
# Known limit: `/* … */` block comments and Rust raw strings are not modelled (the tree
# uses neither; a term inside one would over-report, which is fail-CLOSED, not silent).
function strip_comment(line, marker, quotes, wordstart,   out, i, L, c, instr, opener, prev) {
  out = ""; i = 1; L = length(line); instr = 0; opener = ""
  while (i <= L) {
    c = substr(line, i, 1)
    if (instr) {
      # See `unescape`: three answers, per dialect. Blanking both hid an escaped compound id;
      # keeping both glued an escape sequence onto the token; dropping the backslash in a
      # dialect that keeps it deleted a boundary the language really has.
      if (c == "\\") { out = out unescape(substr(line, i + 1, 1), c); i += 2; continue }
      if (c == opener) instr = 0
      out = out c; i++; continue
    }
    if (index(quotes, c) > 0) { instr = 1; opener = c; out = out c; i++; continue }
    if (substr(line, i, length(marker)) == marker) {
      prev = (i > 1) ? substr(line, i - 1, 1) : ""
      if (!wordstart || prev == "" || prev == " " || prev == "\t") break
    }
    out = out c; i++
  }
  return out
}

# Shell parameter-expansion OPERATORS, blanked LENGTH-PRESERVINGLY (positions are computed
# on the returned string, so it must not shift).
#
# THIS CLOSED A LIVE FAIL-OPEN, and it is the reason the sh dialect needs a pre-pass at all.
# A contributed id is hyphen-compound (`single-cell`), so `-` is a WORD character to the
# boundary test — and the idiomatic shell default is `${VAR:-value}`, which puts that very
# `-` immediately to the LEFT of the value. The boundary check therefore REJECTED the exact
# leak this surface was added to catch: the first RED run of this guard reported the
# `justfile` parameter default and stayed SILENT on the shell fallback in
# `scripts/fetch-env-rootfs.sh`, which was written `ENV_ID="${ENV_ID:-${CYTO_..._ENV_ID:-x}}"`.
#
# So inside a `${…}` the operator run (`:-` `:=` `:+` `:?` `-` `=` `+` `?` `#` `%`) is blanked
# to spaces, restoring the boundary without weakening it anywhere else: a hyphenated token
# like `foo-<id>` is still not a hit, because that `-` is not an expansion operator. Nesting
# works because the scan resumes AT the end of the operator, so an inner `${…}` is reached on
# the next iteration.
#
# NOTE: this awk program is a SINGLE-QUOTED shell string, so no comment in it may contain an
# apostrophe. Writing one here is what produced a `syntax error near unexpected token` on the
# very next run.
function sh_blank_expansion_ops(s,   out, i, L, j, n) {
  out = s; L = length(s); i = 1
  while (i < L) {
    if (substr(s, i, 2) == "${") {
      j = i + 2
      while (j <= L && substr(s, j, 1) ~ /[A-Za-z0-9_]/) j++
      n = 0
      while (j <= L && n < 2 && index(":-=+?#%", substr(s, j, 1)) > 0) {
        out = substr(out, 1, j - 1) " " substr(out, j + 1)
        j++; n++
      }
      i = (j > i) ? j : i + 1
      continue
    }
    i++
  }
  return out
}

function report(t,   shown) {
  shown = $0
  sub(/^[[:space:]]+/, "", shown)
  if (length(shown) > 140) shown = substr(shown, 1, 140) "…"
  printf "%s:%d: %s\n        %s\n", FILE, FNR, t, shown
}
'

# ── AN AWK THAT DID NOT RUN IS NOT AN AWK THAT FOUND NOTHING ───────────────────
# The scanner's exit status used to be discarded, and `[ -n "$out" ] || continue` read a
# dead awk as "no hits". That is the single most dangerous shape in this file, because it
# is INDISTINGUISHABLE FROM CLEAN and it fires on every file at once: a blind audit put an
# unbalanced paren in the declaration's marker, awk (which compiles a dynamic regex lazily,
# on the first BUILD file) died on every build file with its stderr swallowed, and the guard
# printed PASS over a real planted leak — while still reporting 53 files scanned, because
# that number is a LINE COUNT of the file list and never had anything to do with what awk
# processed. The marker charset closes that particular door; this closes the corridor.
awk_broken=''
hits=''
while IFS= read -r f; do
  [ -n "$f" ] || continue
  case "$f" in
    *.sql) dialect=sql ;;
    *.py)  dialect=py  ;;
    *)     dialect=rs  ;;
  esac
  if ! out="$(awk -F'\t' -v FILE="$f" -v DIALECT="$dialect" -v BLOCKS=0 \
           -v VOPEN="$VOCAB_OPEN" -v VCLOSE="$VOCAB_CLOSE" \
           "$SCAN_AWK" "$TERMS" "$f" 2>/dev/null)"; then
    awk_broken="${awk_broken}${f}
"
  fi
  [ -n "$out" ] && hits="${hits}${out}
"
done <<EOF
$FILES
$LIB_FILES
EOF

# The BUILD surface, scanned against the WIDER vocabulary (datatype ids + env ids) — a
# recipe must be reusable by a domain that ships neither.
#
# Two things are per-FILE here and were not before #304: the DIALECT (`.mjs` is js, and
# reusing sh would be a fail-open — see the header) and the EXEMPT flag, which is 1 only for
# a file pinned in the guard manifest and which decides whether that file may DECLARE a
# vocabulary block at all.
structural=''
while IFS= read -r f; do
  [ -n "$f" ] || continue
  # The dialect is a per-file property now that the surface is the whole of `scripts/`.
  # Anything without an arm falls to `raw`, which strips nothing — fail-CLOSED.
  case "$f" in
    *.mjs|*.js|*.cjs) dialect=js ;;
    *.py)             dialect=py ;;
    *.sql)            dialect=sql ;;
    *.sh|*.bash|justfile|*/justfile) dialect=sh ;;
    *)                dialect=raw ;;
  esac
  exempt=0
  printf '%s\n' "$GUARD_PINNED" | grep -qxF -- "$f" && exempt=1
  if ! out="$(awk -F'\t' -v FILE="$f" -v DIALECT="$dialect" -v EXEMPT="$exempt" -v BLOCKS=1 \
           -v VOPEN="$VOCAB_OPEN" -v VCLOSE="$VOCAB_CLOSE" \
           "$SCAN_AWK" "$BUILD_TERMS" "$f" 2>/dev/null)"; then
    awk_broken="${awk_broken}${f}
"
  fi
  [ -n "$out" ] || continue
  s_out="$(printf '%s\n' "$out" | grep '^!!' || true)"
  v_out="$(printf '%s\n' "$out" | grep -v '^!!' || true)"
  [ -n "$s_out" ] && structural="${structural}${s_out}
"
  [ -n "$v_out" ] && hits="${hits}${v_out}
"
done <<EOF
$BUILD_FILES
EOF

if [ -n "$awk_broken" ]; then
  echo "FAIL: the scanner did not RUN on $(printf '%s' "$awk_broken" | grep -c .) file(s), so this guard has no"
  echo "      opinion about them and must not report one. An awk that exits non-zero produces no"
  echo "      output, and no output is what a CLEAN file produces — the two are the same bytes,"
  echo "      which is why this is a hard failure and not a warning. First few:"
  printf '%s' "$awk_broken" | head -3 | sed 's/^/        /'
  echo "      The usual cause is a value in $SURFACE_DECL that is not a plain token"
  echo "      (the markers become an awk regex), so check that file's diff first."
  # `exit 1`, NOT `fail=1`. `fail` is read for the last time ~400 lines above this point, so
  # setting it here printed the whole block and then exited 0 — the FAIL-then-PASS shape this
  # file already warns about at the `fail=0` assignment, reproduced by a blind round on the
  # very check that was added to close a fail-open. A verdict written after its own reader has
  # run is not a verdict.
  exit 1
fi

# A malformed or unauthorised vocabulary block is reported SEPARATELY from a leak and fails
# on its own. Merging the two would let a reader dismiss "the block is broken" as one more
# line in a leak report, and a broken block is the more dangerous of the two: it is the
# state in which the guard stops looking.
if [ -n "$structural" ]; then
  echo "FAIL: the scan of a build file could not be trusted — a DECLARED guard-vocabulary block"
  echo "      is malformed or unauthorised, or a comment was left open (#304)."
  echo ""
  printf '%s' "$structural" | while IFS="$(printf '\t')" read -r kind file line; do
    [ -n "$kind" ] || continue
    case "$kind" in
      '!!UNPINNED')
        echo "  $file:$line: a cyto:guard-vocabulary marker in a file that is NOT pinned in"
        echo "      $GUARD_MANIFEST. The marker does NOT exempt anything here, and it fails"
        echo "      rather than no-opping so nobody believes in an exemption they do not have."
        echo "      Pin the file (scripts/check-guard-integrity.sh --update) if it really is a"
        echo "      guard that must SPELL the vocabulary it hunts; otherwise remove the marker"
        echo "      and DERIVE the value instead of naming it."
        ;;
      '!!UNTERMINATED')
        echo "  $file:$line: a cyto:guard-vocabulary block is opened and never closed. Left"
        echo "      alone that blanks the REST OF THE FILE — a whole-file exemption arriving"
        echo "      through a typo, which is exactly the shape #304 removed. Close it with"
        echo "      \`# cyto:end-guard-vocabulary\` on its own line."
        ;;
      '!!STRAY')
        echo "  $file:$line: a cyto:end-guard-vocabulary marker with no open block."
        ;;
      '!!NESTED')
        echo "  $file:$line: a cyto:guard-vocabulary block opened inside another one."
        ;;
      '!!JSBLOCK')
        echo "  $file:$line: a JavaScript block comment opens here and is never closed, so the"
        echo "      stripper blanked the REST OF THE FILE out of the scan — a whole-file"
        echo "      exemption arriving through the comment syntax. Either close it, or (the"
        echo "      likelier cause) a regex character class holding a slash-star, which this"
        echo "      stripper cannot parse. Rewrite it, or escape the slash. This is reported"
        echo "      rather than guessed at because a silently-blanked file is what #304 is about."
        ;;
    esac
  done
  echo ""
  exit 1
fi

if [ -n "$hits" ]; then
  echo "FAIL: contributed DOMAIN vocabulary leaked into the app-core production surface (INV-5)."
  echo ""
  echo "$hits" | head -100
  echo "Each line is  <file>:<line>: <the leaked term>  followed by the offending source line."
  echo ""
  echo "These terms are not written down in this guard — they are DERIVED from"
  echo "$PROCESSORS_DIR/*/manifest.yaml (contributes.datatypes[].id), which is why a"
  echo "processor contributed yesterday is already forbidden today. The app core must route on"
  echo "STRUCTURE (layout, capability, is_a over the registry), never on a domain id literal:"
  echo "  - resolving a family?  query the registry (is_a / capability), do not name the type"
  echo "  - need it in a fixture? put it in a test — #[cfg(test)] / #[test] bodies, a pytest"
  echo "    test module, and any tests|testdata|fixtures path are excluded by construction"
  echo "  - is the term genuinely NOT domain?  then it does not belong in a processor"
  echo "    manifest's contributes.datatypes[] either — fix it at the declaration"
  echo "  - hit inside a Python DOCSTRING in ${FRAMEWORK_LIB_ROOTS[*]}?  docstrings are"
  echo "    strings, not comments, and are deliberately not exempt (a triple-quoted block"
  echo "    can be parsed/emitted, so exempting it would fail open). Describe the id in"
  echo "    prose instead of spelling it."
  echo "  - hit in \`justfile\`, \`scripts/*.sh\` or \`scripts/*.mjs\`?  the build tier must be"
  echo "    reusable by a domain that ships neither these datatypes nor this env. DERIVE the"
  echo "    value the way the app does (env-id: the UNION of contributes.converters[].env and"
  echo "    contributes.analyses[].env, cf. sandbox::env_image::declared_envs_in), or"
  echo "    REQUIRE it as an explicit argument. \`scripts/*.mjs\` joined this surface in #304:"
  echo "    it is the tier #277s leak lived in, and it was scanned by nothing."
  echo "  - are you a GUARD that must SPELL the vocabulary it hunts?  Being PINNED in"
  echo "    $GUARD_MANIFEST no longer exempts the whole file (#304) — a pinned guard that"
  echo "    DISPATCHES on a domain id is exactly the case that leaked. DECLARE the block"
  echo "    instead, and keep it to the hunted vocabulary:"
  echo "        # cyto:guard-vocabulary"
  echo "        KINDS=<the terms this guard hunts>"
  echo "        # cyto:end-guard-vocabulary"
  echo "    (\`// cyto:guard-vocabulary\` in a .mjs). Only those lines are blanked, and only"
  echo "    in a file that is pinned; every other line is scanned like any build file."
  exit 1
fi

echo "PASS: 0 contributed domain-vocabulary leaks in the app-core surface (INV-5)."
echo "      $n_terms derived term(s) from $n_pkgs package(s) (floors $MIN_TERMS/$MIN_PACKAGES);"
echo "      scanned $n_files app-core file(s) (floor $MIN_FILES)"
echo "      + $n_lib_files framework file(s) across $n_lib_packages derived reserved package(s)"
echo "      ${FRAMEWORK_LIB_ROOTS[*]} (floors $MIN_LIB_FILES/$MIN_LIB_PACKAGES)"
echo "      + $n_build_files build file(s) (floor $MIN_BUILD_FILES; ${BUILD_SURFACE_ROOTS[*]} + everything under"
echo "      all $n_surface_dirs \`$SURFACE_DIR/\` director(y/ies) at any depth (floor $MIN_SURFACE_DIRS), less"
echo "      ${#SURFACE_EXCEPTIONS[@]} declared exception(s) and $n_js_tests justfile-declared \`node --test\` module(s)"
echo "      that import node:test (floor $MIN_JS_TEST_FILES), per $SURFACE_DECL) against"
echo "      $n_terms datatype + $n_envs env id(s) (floor $MIN_ENVS)"
echo "      from $n_env_decls converter/analysis env declaration(s);"
echo "      all $n_recipes shipped env recipe(s) accounted for ($n_operator_selected"
echo "      operator-selected; floor $MIN_ENV_RECIPES)."
exit 0
