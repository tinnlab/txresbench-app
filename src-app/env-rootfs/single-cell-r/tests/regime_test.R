## regime_test.R — TEST-5 and TEST-6 for #192.
##
## Run by `run-r-tests.sh`, which extracts the shipped `CYTO_REGIME_R` block out of the
## recipe's Dockerfile and hands it here as argv[1]. argv[2] is the SHIPPED pin file.
##
## Everything below RUNS the shipped functions. Nothing asserts about the text of the
## recipe: the whole reason this file exists is that a predicate over text is defeated by
## the next spelling rather than by a defect.

args <- commandArgs(trailingOnly = TRUE)
if (length(args) != 2L) stop("usage: regime_test.R <extracted-regime.R> <requirements.txt>", call. = FALSE)
source(args[[1]])
pin_file <- args[[2]]
## This suite's own path, for the self-parse in TEST-P16. Derived from the frame rather
## than passed, so it cannot be pointed at a different file.
## `[[1]]` on an empty match is an out-of-bounds abort under `R -f` or stdin. `run-r-tests.sh`
## always uses `Rscript`, so this is defensive rather than live — but a suite that dies with
## a subscript error instead of saying what it needs is a suite nobody can diagnose.
.self_arg <- grep("^--file=", commandArgs(trailingOnly = FALSE), value = TRUE)
if (!length(.self_arg)) {
  stop("regime_test.R must be run with `Rscript` so it can locate its own source (TEST-P16 parses it)", call. = FALSE)
}
self_file <- sub("^--file=", "", .self_arg[[1]])

failures <- 0L
ok <- function(label) cat(sprintf("  ok   %s\n", label))
bad <- function(label, why) {
  failures <<- failures + 1L
  cat(sprintf("  FAIL %s\n         %s\n", label, why))
}
expect_true <- function(label, cond, why = "expected TRUE") {
  if (isTRUE(cond)) ok(label) else bad(label, why)
}
expect_equal <- function(label, got, want) {
  if (identical(got, want)) ok(label) else bad(label, sprintf("got %s, want %s",
    paste(utils::capture.output(str(got)), collapse = " "),
    paste(utils::capture.output(str(want)), collapse = " ")))
}
## A refusal is only a refusal if it says WHY. Every `expect_error` names the substring
## the message must carry, so a function that started failing for an unrelated reason
## cannot keep this test green.
expect_error <- function(label, expr, must_say) {
  e <- tryCatch({ force(expr); NULL }, error = function(e) conditionMessage(e))
  if (is.null(e)) {
    bad(label, "no error was raised, but one was required")
  } else if (!grepl(must_say, e, fixed = TRUE)) {
    bad(label, sprintf("the refusal did not say %s; it said: %s", sQuote(must_say), e))
  } else {
    ok(label)
  }
}

## ── THIS SUITE CALLS THE READER, IT DOES NOT HAVE ONE (#214 / TEST-P16) ───────────
##
## It used to be `pin_lines <- readLines(pin_file, warn = FALSE)`, which is a FOURTH
## opinion about where a line ends: `readLines` splits on CR as well as LF, while the
## installer under test reads the file as one string and splits on "\n" only. So this
## suite could see two lines where the thing it is testing sees one — in the one suite
## whose subject is precisely that byte.
##
## Round 1 replaced it with a RETYPED `readChar` + `strsplit` and a source predicate
## forbidding `readLines(pin_file`. A blind audit defeated that predicate twice, with
## `readLines(con = pin_file)` and with a one-line alias, and both mutants ran the whole
## suite green. A better predicate would have been the fifth predicate.
##
## So the reader is now a FUNCTION in the shipped regime block — `cyto_read_pin_lines` —
## which the installer, the build-time smoke and this suite all call. There is nothing left
## to re-implement, which is a structural answer rather than a textual one. The source check
## below is correspondingly narrower and says only what it can prove.
pin_lines <- cyto_read_pin_lines(pin_file)
## …and the raw bytes, for the assertions that are ABOUT the bytes rather than the lines.
## Read the same way `cyto_read_pin_lines` reads them, because they are the same read.
pin_text <- readChar(pin_file, file.info(pin_file)$size, useBytes = TRUE)
Encoding(pin_text) <- "UTF-8"

## ─────────────────────────── TEST-P16 (#214) — this suite has no line rule ────────
cat("TEST-P16 (#214): this suite reads the pin file through the parser UNDER TEST\n")
## The claim: `pin_lines` above came from the installer's own reader, so this suite cannot
## see a different set of lines from the program it is testing. The check is a
## DIFFERENTIAL one — a lone CR is the byte where `readLines` and the installer's reader
## disagree, so if this suite still had a `readLines` of its own, the two would differ.
cr_text <- "# cyto:ecosystem=r\n# a comment\rb==1.0  # import=b\n"
## The installer's reader REFUSES it outright…
expect_error("the installer's reader refuses a lone CR", cyto_assert_canonical_bytes(cr_text),
             "U+000D")
## …while `readLines` would silently hand back one MORE line than `strsplit(text, "\n")`.
## That difference is exactly the fourth line-ending opinion this suite used to carry.
cr_tmp <- tempfile(); writeLines(character(0), cr_tmp)
con <- file(cr_tmp, "wb"); writeBin(charToRaw(cr_text), con); close(con)
## A LEMMA, not a test of this suite: it establishes that the two readers genuinely differ
## on this byte, which is what makes "which reader does this suite use" a question worth
## asking at all. It is true with the feature deleted, and is labelled so rather than left
## to look like coverage.
expect_true("LEMMA: readLines and the installer's reader really do disagree about a lone CR",
            length(readLines(cr_tmp, warn = FALSE)) != length(strsplit(cr_text, "\n", fixed = TRUE)[[1]]),
            "the two readers agreed, so this case proves nothing about which one is used")
unlink(cr_tmp)
## And this suite really has no `readLines` of the pin file — checked over the PARSED
## source, not over its text.
##
## The first cut asserted `length(pin_lines) == length(strsplit(pin_text, "\n"))`, which is
## `length(x) == length(x)` for two identical expressions, and its comment claimed a
## reintroduced `readLines` would have to delete it to stay green. A blind audit reverted
## line 58 to `readLines(pin_file)` and the assertion still printed `ok` — because the
## shipped file is canonical, so `readLines` and `strsplit(text, "\n")` necessarily agree on
## it and NO differential over these bytes can exist. The claim was unfalsifiable.
##
## `parse()` + `deparse()` drops every comment, so this is the R analogue of the AST walks
## the python side uses: prose mentioning `readLines(pin_file)` — including this paragraph —
## cannot satisfy it, and reintroducing the call reddens it.
pin_assigns <- Filter(function(e) {
  is.call(e) && length(e) == 3L &&
    identical(as.character(e[[1]]), "<-") &&
    is.name(e[[2]]) && identical(as.character(e[[2]]), "pin_lines")
}, as.list(parse(self_file)))
## ANTI-VACUITY: the parse must have produced this suite's code, or the Filter above ranges
## over nothing and both assertions below are about an empty list.
expect_true("the self-parse produced this suite's code",
            length(as.list(parse(self_file))) > 40L,
            sprintf("parsed only %d top-level expressions", length(as.list(parse(self_file)))))
expect_equal("this suite assigns `pin_lines` exactly ONCE", length(pin_assigns), 1L)
expect_true("SECONDARY: it assigns `pin_lines` from the shipped reader BY NAME (the behavioural proof is in run-r-tests.sh)",
            length(pin_assigns) == 1L && is.call(pin_assigns[[1]][[3]]) &&
              identical(as.character(pin_assigns[[1]][[3]][[1]]), "cyto_read_pin_lines"),
            "pin_lines is no longer assigned from cyto_read_pin_lines(); this suite has grown a reader of its own")
## ANTI-VACUITY: the parse must have produced this suite's code, or the walk above ranges
## over nothing and both assertions are about an empty list.
expect_true("the self-parse produced this suite's code", length(as.list(parse(self_file))) > 40L,
            sprintf("parsed only %d top-level expressions", length(as.list(parse(self_file)))))
## POSITIVE CONTROL, running the SAME predicate over a synthetic assignment that uses a
## private reader. The first cut hand-copied one conjunct of the check into the control,
## which is "a control derived from a copy of the guard" — the anti-pattern this branch
## fixed in the Rust census two rounds ago and then reproduced here.
reader_of <- function(e) {
  if (is.call(e) && length(e) == 3L && identical(as.character(e[[1]]), "<-") &&
      is.name(e[[2]]) && identical(as.character(e[[2]]), "pin_lines") &&
      is.call(e[[3]])) as.character(e[[3]][[1]]) else NA_character_
}
decoy <- parse(text = "pin_lines <- readLines(con = pin_file, warn = FALSE)")[[1]]
expect_true("the predicate REJECTS a private reader (so its acceptance above means something)",
            !identical(reader_of(decoy), "cyto_read_pin_lines") &&
              identical(reader_of(pin_assigns[[1]]), "cyto_read_pin_lines"),
            "the predicate cannot tell a private reader from the shipped one")

## ─────────────────────────── TEST-5 — the pins and the coordinates ─────────────────
cat("TEST-5 (INV-1): exact pins, and the resolution coordinates, read off the SHIPPED file\n")

pins <- cyto_parse_pins(pin_lines)
expect_true("the shipped pin file parses to a non-trivial pin set", length(pins) >= 18,
            sprintf("only %d pins parsed", length(pins)))
names <- vapply(pins, function(p) p$name, "")
## HONEST LABEL. This asserts the parser copies the name VERBATIM — it has never applied a
## case fold, before or after #192, so it would pass with the case-preserving rule fully
## reverted and is NOT a test of it. The first cut labelled it "case is PRESERVED", which
## made this suite look like it covered the item's central property. It does not: that is
## Rust-side, and its proof is
## `processor_manifest.rs::r_pin_names_resolve_case_preservingly_and_python_pin_names_still_fold`,
## which is red when the rule is reverted. What this rules out is a future edit adding a
## fold HERE, which would make the recipe install a different set from the one the gate
## checked.
expect_true("the installer copies pin names verbatim (a fold added here would desync the recipe from the gate)",
            "scDblFinder" %in% names && !("scdblfinder" %in% names),
            paste("parsed names:", paste(names, collapse = ", ")))
## NOT an assertion about the pin file — a TAUTOLOGY over the parser, kept as a
## constructor guard and labelled as one. Both regex captures are `+` quantified and the
## non-match branch is an unconditional `stop()`, so no pin file exists for which the parse
## succeeds and this fails. Its only live mutation is a typo in the `list(name=, version=,
## import=)` construction. (Was labelled as though it checked the file; it does not.)
expect_true("the pin-list CONSTRUCTOR fills every field (a tautology over the parser, kept as a constructor guard)",
            all(vapply(pins, function(p) nzchar(p$version) && nzchar(p$import), TRUE)))
## A dash-shaped version must be parsed VERBATIM — `1.7-6` and not `1.7-` or `1.7.6`. That
## is the case that made this recipe need a declared version grammar at all.
##
## ── WHY THIS IS A FROZEN CASE AND NOT A COMPARISON AGAINST THE SOURCE LINE (#214) ──
##
## It used to `grep` the pin lines for a dash-shaped pin and then `sub()` the name and
## version back out of the matched line, to compare "the parse" against "the source". That
## is a second grammar: a `==` token rule and a `[^#[:space:]]` comment rule, in the suite
## whose whole subject is that two grammars over this file disagree. A blind audit counted
## it as a third parser and was right to.
##
## The property is now a FROZEN CASE, which `docs/design/derived-guards.md` §4 names as the
## sanctioned shape: derive the set, freeze the cases whose VALUES matter. It is also
## strictly stronger than what it replaces — a parser truncating `1.7-6` to `1.7-` fails an
## equality against the literal, where the old form compared two things a truncating parser
## would have truncated identically only by luck. It costs an edit when Matrix's pin moves,
## and never on an addition.
dash_pin <- Filter(function(p) identical(p$name, "Matrix"), pins)
expect_true("the frozen dash-version case is still in the shipped file", length(dash_pin) == 1L,
            "Matrix is gone from the pin file; re-point this frozen case at another dash-shaped pin")
## GUARDED. `expect_true` RECORDS a failure and returns, so an unguarded `dash_pin[[1]]`
## below would abort the whole suite with `subscript out of bounds` instead of printing the
## message above — the message that says what to do. A blind audit found this shape; a test
## that crashes instead of failing is a test whose diagnosis is lost.
if (length(dash_pin) == 1L) {
  expect_equal("a dash-shaped version is parsed VERBATIM (frozen case: Matrix)",
               dash_pin[[1]]$version, "1.7-6")
} else {
  bad("a dash-shaped version is parsed VERBATIM (frozen case: Matrix)",
      "skipped: the frozen subject is not in the pin file (see the failure above)")
}
## …and the CLASS has not silently left the file, which is the half a frozen case cannot
## see. No grammar: `grepl(..., fixed = TRUE)` over already-PARSED versions.
expect_true("at least one parsed version is still dash-shaped",
            any(vapply(pins, function(p) grepl("-", p$version, fixed = TRUE), TRUE)),
            "no dash-shaped version remains, so nothing here exercises the R version grammar")

## Ten WELL-FORMED, DISTINCT pins plus the one malformed line under test, so the floor on
## pin count is cleared and the only thing that can fail is the line being tested. (The
## first cut used ten copies of one line, and the duplicate check fired first — the test
## was green for the wrong reason, which is what `expect_error`'s required substring is
## there to catch.)
filler <- sprintf("pkg%02d==1.0  # import=pkg%02d", 1:10, 1:10)
expect_error("a RANGE is refused", cyto_parse_pins(c(filler, "beta>=1.0  # import=beta")),
             "every line must be")
expect_error("a BARE NAME is refused", cyto_parse_pins(c(filler, "beta  # import=beta")),
             "every line must be")
expect_error("a MISSING import token is refused", cyto_parse_pins(c(filler, "beta==1.0")),
             "every line must be")
expect_error("a DUPLICATE is refused", cyto_parse_pins(c(filler, "pkg01==2.0  # import=pkg01")),
             "is pinned twice")
## AT THE BOUNDARY, not at one pin. The fixture used to hold ONE pin, which is below any
## floor >= 2, so the constant was unconstrained downward: an audit lowered it to 2 — half
## the recipe deletable without complaint — and this assertion still reported ok, because
## the required substring is a literal in the message rather than the compared number.
## Nine pins pins the number itself.
expect_error("a file of NINE pins is refused — the floor is 10, and this pins the number not the message",
             cyto_parse_pins(sprintf("p%02d==1.0  # import=p%02d", 1:9, 1:9)),
             "fewer than 10 pins")
expect_true("...and TEN is accepted, so the boundary is the boundary",
            length(cyto_parse_pins(sprintf("p%02d==1.0  # import=p%02d", 1:10, 1:10))) == 10L)

srcs <- cyto_parse_sources(pin_lines)
expect_equal("the shipped file declares two coordinates", length(srcs), 2L)
expect_true("one is a dated snapshot",
            "dated-snapshot" %in% vapply(srcs, function(s) s$class, ""))
expect_true("one is a release channel",
            "release-channel" %in% vapply(srcs, function(s) s$class, ""))
cran <- cyto_source_coordinate(srcs, "dated-snapshot")
bioc <- cyto_bioc_release(cyto_source_coordinate(srcs, "release-channel"))
expect_true("the CRAN coordinate is a URL", grepl("^https://", cran), cran)
expect_true("the Bioconductor coordinate is a release", grepl("^[0-9]+\\.[0-9]+$", bioc), bioc)
cat(sprintf("  ->   CRAN snapshot %s / Bioconductor %s\n", cran, bioc))

## The comment-body normalisation must MIRROR the Rust gate's `directive_body`. If these
## two readers disagreed about which lines are directives, the file the recipe installs
## from and the file the build gate checks would be different files with the same name.
for (spelling in c("#cyto:pin-source=dated-snapshot:X",
                   "#  cyto:pin-source=dated-snapshot:X",
                   "## cyto:pin-source=dated-snapshot:X",
                   "# cyto:pin-source = dated-snapshot:X",
                   "\t# cyto:pin-source=dated-snapshot:X",
                   "   # cyto:pin-source=dated-snapshot:X")) {
  got <- tryCatch(cyto_parse_sources(spelling)[[1]]$coordinate, error = function(e) paste("ERR:", conditionMessage(e)))
  expect_equal(sprintf("spelling %s is understood", sQuote(trimws(spelling))), got, "X")
}

## ─── The #209 gate, in the recipe's own reader as well as in the Rust one ──────────
## ONE refusal, ONE assertion. The first cut called `expect_error` twice over the
## byte-identical expression, differing only in which substring of the same message it
## required — two `ok` lines for one behaviour, which is coverage inflation.
local({
  e <- tryCatch({ cyto_parse_sources("# cyto:pin-source=vcs-head:https://github.com/x/y"); NULL },
                error = function(e) conditionMessage(e))
  expect_true("a `vcs-head` source is REFUSED, naming #209 AND why the identity fails",
              !is.null(e) && grepl("#209", e, fixed = TRUE) &&
                grepl("DIFFERENT code", e, fixed = TRUE),
              if (is.null(e)) "no error raised" else e)
})
expect_error("an unknown class is refused rather than defaulted",
             cyto_parse_sources("# cyto:pin-source=whatever:X"),
             "names no known pin-source class")
expect_error("a class with no coordinate is refused",
             cyto_parse_sources("# cyto:pin-source=dated-snapshot:"),
             "is not `<class>:<coordinate>`")

## ─── The two readers must AGREE about which lines are directives (audit R1-4) ──────
## A line that NAMES the directive without an `=` used to be SILENTLY SKIPPED here while
## the Rust gate hard-errored on it — so `# cyto:pin-source vcs-head:x` walked straight
## past the #209 refusal on the one entry point that exists for an operator bypassing
## `cargo check`. A gate with a spelling that bypasses it is not a gate.
expect_error("a `cyto:pin-source` line with no `=` is REFUSED, not skipped",
             cyto_parse_sources(c("# cyto:pin-source vcs-head:https://github.com/x/y",
                                  "# cyto:pin-source=dated-snapshot:ok")),
             "names `cyto:pin-source` but is not")
expect_error("the same (class, coordinate) twice is refused, as it is in the Rust gate",
             cyto_parse_sources(c("# cyto:pin-source=dated-snapshot:a",
                                  "# cyto:pin-source=dated-snapshot:a")),
             "is declared twice")
## A `#` inside a coordinate is NOT a comment. Truncating it would make the regime the
## file declares differ from the regime the build resolves, with no error anywhere.
expect_equal("a `#` inside a coordinate does not truncate it",
             cyto_parse_sources("# cyto:pin-source=dated-snapshot:https://x/y#frag")[[1]]$coordinate,
             "https://x/y#frag")
expect_equal("a whitespace-separated trailing comment IS stripped",
             cyto_parse_sources("# cyto:pin-source=dated-snapshot:https://x/y   # why")[[1]]$coordinate,
             "https://x/y")
## A class that names a channel and no release is not a coordinate — one level down from
## the doc comment's own argument for requiring the prefix.
expect_error("`bioconductor-` with no release is refused",
             cyto_bioc_release("bioconductor-"),
             "does not name a channel AND a release")

## ─── The invisible-character class, refused BY DEFAULT (rounds 2-4, inverted by #214) ───
##
## The first cut asserted two codepoints, U+00A0 and U+0085, because those were the two the
## previous audit had named. The next audit found U+000B, where the disagreement runs the
## OTHER way — invisible to the Rust gate, live here — and neither suite could see it,
## because both were enumerations of the last finding. Round 4 added U+001C. #214's audit
## then found the whole `Cf` FORMAT class outside `is_control()`.
##
## Four widenings of a FORBIDDEN set, each correct, each insufficient. The rule is now an
## ALLOWLIST — printable ASCII, SPACE, TAB, LF, and `cyto_allowed_non_ascii` — so the
## property to assert is no longer "these N characters are refused" but "everything outside
## the allowlist is refused, INCLUDING characters nobody has enumerated anywhere".
expect_true("the recipe allows only a small, named set of non-ASCII characters",
            length(cyto_allowed_non_ascii) > 0L && length(cyto_allowed_non_ascii) <= 8L,
            paste("allowlist size:", length(cyto_allowed_non_ascii)))
## U+0000 IS SKIPPED HERE, AND THAT IS ITSELF THE FINDING. An R character vector cannot
## contain a NUL — `intToUtf8(0)` yields "" — so this reader is constitutionally unable to
## see one, and `readChar` TRUNCATES the file at the first one. The Rust gate reads the
## whole file and refuses it (its own test names U+0000 explicitly), which is the only
## reason a NUL cannot reach the installer silently. Recorded rather than papered over:
## this is one forbidden byte the two implementations do NOT enforce symmetrically, and
## the asymmetry is a property of R, not a choice.
##
## The probe set is DELIBERATELY not an enumeration of "the forbidden characters" — there
## is no such list any more. It is a spread of classes, including several no round ever
## named, precisely to check that the allowlist refuses things it was never told about.
probe <- c(0x01, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x7f,
           0x85, 0xa0, 0xad, 0x200b, 0x200c, 0x2028, 0x2029, 0x202e, 0x2060,
           0x2069, 0x3000, 0xfeff, 0x0430, 0x1680, 0x205f)
ws_bad <- 0L
for (cp in probe) {
  ch <- intToUtf8(cp)
  txt <- paste0("#", ch, "cyto:pin-source=dated-snapshot:https://evil/x\n")
  e <- tryCatch({ cyto_assert_canonical_bytes(txt); NULL }, error = function(e) conditionMessage(e))
  ## `fixed = TRUE`: `+` is a regex metacharacter, so `grepl("U+000B", e)` searches for
  ## one-or-more `U` followed by `000B` and never matches the message it is checking. The
  ## first cut had it unfixed and reported all 22 characters as failing while every one of
  ## them was in fact being refused correctly — a test failing for the wrong reason, which
  ## is the same defect as passing for the wrong reason and only marginally luckier.
  if (is.null(e) || !grepl(sprintf("U+%04X", cp), e, fixed = TRUE)) ws_bad <- ws_bad + 1L
}
expect_equal("every probed invisible character is refused, naming itself", ws_bad, 0L)
## ── INVALID UTF-8 AND NUL: the two byte classes R cannot examine ──────────────────
##
## A GUARD WHOSE FAILURE MODE HAS NEVER BEEN DEMONSTRATED IS A GUARD NOBODY HAS CHECKED,
## and this one proves the point twice over: the first attempt at the invalid-UTF-8 refusal
## had no test here, and it did not work (`anyNA(cps)` after the split is FALSE, because
## `strsplit` yields NA_character_ and `paste` turns that into the literal string "NA").
bad_utf8 <- rawToChar(as.raw(c(0x61, 0x6c, 0x70, 0x68, 0x61, 0x80, 0x0a)))
expect_error("invalid UTF-8 is REFUSED, not silently skipped",
             cyto_assert_canonical_bytes(bad_utf8), "not valid UTF-8")
## …and the refusal is reached BEFORE the split, which is where the first attempt failed.
##
## Asserted via the MESSAGE, not via `strsplit`'s behaviour. The first cut checked
## `is.na(strsplit(...)[[1]][[1]])`, which is TRUE only in a UTF-8 locale — under `LC_ALL=C`
## `strsplit` returns the bytes and the assertion failed on correct code, with a message
## ("the fixture is not actually invalid UTF-8") that was false. `run-r-tests.sh` pins no
## locale. A guard that is red on correct code in a plausible environment is one people
## learn to route around.
expect_true("the fixture really is invalid UTF-8", !validUTF8(bad_utf8))
expect_true("the refusal is the UTF-8 one, i.e. reached BEFORE the character scan",
            grepl("not valid UTF-8",
                  tryCatch({ cyto_assert_canonical_bytes(bad_utf8); "" },
                           error = function(e) conditionMessage(e)), fixed = TRUE),
            "the file was refused for some other reason, so the placement of the check is unproven")
## A NUL is the one byte this reader is CONSTITUTIONALLY unable to see: an R character
## vector cannot hold one, and `readChar` truncates the file at the first. The gate refuses
## it and is the only thing that can. Asserted here so the asymmetry is recorded as a
## measured property rather than as a comment.
nul_err <- tryCatch({ rawToChar(as.raw(c(0x61, 0x00, 0x62))); NULL },
                    error = function(e) conditionMessage(e))
expect_true("LEMMA: a NUL cannot even enter an R string — this is why the gate, not this reader, refuses it",
            !is.null(nul_err) && grepl("nul", nul_err, fixed = TRUE),
            "R now accepts an embedded NUL in a string, so this asymmetry may be closeable here too")

## THE POINT OF AN ALLOWLIST, stated as a test: a character in NO enumeration anywhere — not
## in the probe above, not in `cyto_allowed_non_ascii`, not in any round's finding — is
## refused because it was never permitted. A forbidden set could not express this.
expect_error("a character nobody enumerated anywhere is refused by default",
             cyto_assert_canonical_bytes("# a \u2603 snowman\n"), "U+2603")
expect_true("SPACE, TAB and LF are still permitted",
            is.null(tryCatch({ cyto_assert_canonical_bytes("# a\tb c\n"); NULL },
                             error = function(e) conditionMessage(e))))
## A LONE CR is the byte a line-splitting reader cannot see by construction: `readLines`
## would already have split on it. This is why the check reads the file as one string.
expect_error("a lone CR is refused", cyto_assert_canonical_bytes("# see the runbook\r# cyto:pin-source=x:y\n"),
             "U+000D")
## The SHIPPED file passes, so the precondition cannot be arbitrarily strict unnoticed.
##
## ── THIS ASSERTION WAS VACUOUS, AND #192's ROUND 4 REPORTED IT FIXED WHEN IT WAS NOT ──
##
## It read `cyto_assert_canonical_bytes(paste(pin_lines, collapse = "\n"))` — a
## `readLines` + `paste` RECONSTRUCTION of the file, not the file. That round-trip launders
## every CR into an LF before the check ever sees it, so the one claim in this suite that
## the shipped bytes are canonical was blind to exactly the byte class the precondition was
## written for, and would have reported PASS on a file the gate and the installer both
## refuse. Round 4's own report says this was "now read with `readChar`". It was not: the
## report described the fix and the code kept the reconstruction. Found by #214 while
## removing this suite's line rule.
##
## It now checks `pin_text` — the file's actual bytes, as read above.
expect_true("the shipped pin file satisfies the precondition",
            is.null(tryCatch({ cyto_assert_canonical_bytes(pin_text); NULL },
                             error = function(e) conditionMessage(e))))

## ─── The admissibility GATE, not just the `known` vector (audit round 3) ──────────
## The python cross-check compares Rust's tokens against this reader's `known` vector by
## reading both as text. An audit left `known` byte-identical and widened the `%in%` test
## beside it — the installer then accepted a class the gate refuses, with every suite
## green. This pins the expression rather than the list: a plausible-looking class that is
## not in `known` must be REFUSED.
for (bogus in c("vendored-tarball", "mirror-pin", "git-tag", "local-path")) {
  expect_error(sprintf("class %s is refused (the GATE, not the vector)", sQuote(bogus)),
               cyto_parse_sources(sprintf("# cyto:pin-source=%s:x", bogus)),
               "names no known pin-source class")
}

## ─── TWO DIFFERENT coordinates of ONE class (audit round 3) ──────────────────────
## The Rust gate refuses this at parse time and its comment justifies that by asserting
## "the recipe's own installer refuses the same state". The installer's refusal lives in
## `cyto_source_coordinate`'s `length(hit) != 1L`, and nothing exercised it: an audit
## changed it to `< 1L` — silently taking the FIRST of two — and all four suites stayed
## green. That is the exact half that turns a hidden line into an origin swap.
expect_error("two DIFFERENT coordinates of one class are refused by the installer too",
             cyto_source_coordinate(
               cyto_parse_sources(c("# cyto:pin-source=dated-snapshot:https://good/x",
                                    "# cyto:pin-source=dated-snapshot:https://evil/x")),
               "dated-snapshot"),
             "must declare exactly one")

## ─── The anti-DELETION floor, proved by DELETING (ITEM-9) ─────────────────────────
## ─── The anti-DELETION floor, proved by DELETING (ITEM-9) ─────────────────────────
## `derived-guards.md` §4: a derivation reading the same source the subject is built from
## moves with it, so it is blind in the direction of a removal. These two mutations are
## that direction.
deleted_sources <- grep("cyto:pin-source", pin_lines, value = TRUE, invert = TRUE)
expect_error("DELETING every pin-source line goes RED (not a silent default)",
             cyto_parse_sources(deleted_sources),
             "declares no `cyto:pin-source=")
expect_error("DELETING only the release-channel line goes RED for the coordinate that needs it",
             cyto_bioc_release(cyto_source_coordinate(
               cyto_parse_sources(grep("release-channel", pin_lines, value = TRUE, invert = TRUE)),
               "release-channel")),
             "must declare exactly one")

## ─────────────────────────── TEST-6 — the closure-lock writer ─────────────────────
cat("TEST-6 (INV-3): the closure lock, WRITTEN by the shipped writer\n")

tmp <- tempfile(fileext = ".txt")
fixture_pins <- list(list(name = "Matrix", version = "1.7-6", import = "Matrix"),
                     list(name = "scDblFinder", version = "1.26.7", import = "scDblFinder"))
## `installed.packages()`-shaped, WITH the duplicate that made this writer necessary: the
## rocker base ships a recommended `Matrix` in `R/library` while the pinned one installs
## into `site-library`.
libs <- c("/usr/local/lib/R/site-library", "/usr/local/lib/R/library")
## ROW ORDER IS DELIBERATELY WRONG, and that is the point. The first cut listed the
## site-library `Matrix 1.7-6` BEFORE the R/library `1.7-5`; `order()` is stable, so
## ordering by Package alone produced byte-identical output and the `.libPaths()` ranking —
## the entire mechanism these three assertions exist to pin, and the `lib_paths` argument
## with it — was unobserved. An audit deleted `rank` from the `order()` call and the suite
## stayed green. The SHADOWED copy is now listed first, so only the rank can recover it.
ip <- data.frame(
  Package = c("Matrix", "scDblFinder", "Matrix", "digest"),
  Version = c("1.7-5", "1.26.7", "1.7-6", "0.6.39"),
  LibPath = c(libs[[2]], libs[[1]], libs[[1]], libs[[1]]),
  stringsAsFactors = FALSE
)
repos <- c(Matrix = "CRAN", scDblFinder = "Bioconductor 3.23/bioc", digest = "CRAN")
## What R actually loads: the copy in the FIRST `.libPaths()` entry, which is no longer
## the first row of the frame.
resolve <- function(nm) {
  rows <- ip[ip$Package == nm, , drop = FALSE]
  rows$Version[order(match(rows$LibPath, libs))][[1]]
}
repo_of <- function(nm) unname(repos[nm])


## ROWS SELECTED BY NAME, never by position. Reordering the fixture above — which is what
## makes the `.libPaths()` ranking observable at all — silently changed the meaning of
## every `ip[1, ]` slice below. A fixture indexed by position encodes an ordering no test
## states, so the next person who changes the order breaks assertions that were never
## about order.
loaded_row <- function(nm) {
  rows <- ip[ip$Package == nm, , drop = FALSE]
  rows[order(match(rows$LibPath, libs)), , drop = FALSE][1, , drop = FALSE]
}

counts <- cyto_write_env_lock(tmp, fixture_pins,
                              header = c("# R 4.6.1", "# bioconductor 3.23"),
                              ip = ip, resolve_version = resolve, repo_of = repo_of,
                              lib_paths = libs)
lock <- readLines(tmp, warn = FALSE)

expect_equal("one line per RESOLVED package", counts$resolved, 3L)
expect_equal("the shadowed copy is counted, not dropped", counts$shadowed, 1L)
expect_true("the header is written first", identical(lock[[1]], "# R 4.6.1"))
expect_true("every package line carries package==version AND its source (renv.lock schema)",
            "Matrix==1.7-6  # source=CRAN" %in% lock,
            paste(lock, collapse = " | "))
expect_true("a Bioconductor package records the Bioconductor channel as its source",
            "scDblFinder==1.26.7  # source=Bioconductor 3.23/bioc" %in% lock,
            paste(lock, collapse = " | "))
expect_true("the copy R LOADS is the one recorded — never the shadowed one",
            !any(grepl("^Matrix==1\\.7-5", lock)),
            paste(lock, collapse = " | "))
expect_true("the shadowed copy IS recorded, as a comment, because a second copy is provenance",
            any(grepl("^# shadowed Matrix==1\\.7-5 in /usr/local/lib/R/library", lock)),
            paste(lock, collapse = " | "))
expect_true("a transitive package nobody pinned is recorded too",
            any(grepl("^digest==0\\.6\\.39", lock)),
            paste(lock, collapse = " | "))

## A package whose DESCRIPTION records no Repository (a base/recommended package R ships)
## is written `unrecorded`, never blank — a blank column reads as a bug.
tmp2 <- tempfile(fileext = ".txt")
invisible(cyto_write_env_lock(tmp2, list(list(name = "Matrix", version = "1.7-6")),
                    header = "# h", ip = loaded_row("Matrix"),
                    resolve_version = resolve,
                    repo_of = function(nm) NA_character_, lib_paths = libs))
expect_true("a package with no recorded Repository and no base/recommended priority is NAMED, not filed under a shared word",
            any(grepl("# source=UNRECORDED-NOT-FROM-A-DECLARED-COORDINATE",
                      readLines(tmp2, warn = FALSE), fixed = TRUE)))

## THE CROSS-CHECK. The writer picks the first row per package as "what R loads"; if that
## rule ever disagreed with R's own resolver the lock would be authoritative and wrong,
## which is the worst state for a provenance record to be in.
expect_error("a lock that would DISAGREE with R's resolver is refused",
             cyto_write_env_lock(tempfile(), fixture_pins, header = "# h", ip = ip,
                                 resolve_version = function(nm) "9.9.9",
                                 repo_of = repo_of, lib_paths = libs),
             "the lock must record what LOADS")

## A HEADER-ONLY lock records nothing while looking exactly like a lock — and the FILE is
## not empty, which is why the first cut's byte-length guard could never fire from the real
## call site (the installer always passes a four-line header). The guard counts package
## ROWS now; this fixture passes the header the installer actually passes.
expect_error("a ZERO-PACKAGE lock is refused even though the FILE is non-empty",
             cyto_write_env_lock(tempfile(), list(),
                                 header = c("# R 4.6.1", "# bioconductor 3.23",
                                            "# cran-snapshot X", "# direct-pins 0"),
                                 ip = ip[0, , drop = FALSE],
                                 resolve_version = resolve, repo_of = repo_of,
                                 lib_paths = libs),
             "ZERO package lines")

## THE CROSS-CHECK MUST NOT AGREE WITH ITSELF ABOUT AN ABSENCE. `match()` yields NA for a
## pin missing from the installed set and `packageDescription` yields NA for a package R
## cannot find, so `identical(NA, NA)` was TRUE and the one case where the lock records
## NOTHING for a direct pin was the case the check accepted.
expect_error("a pin ABSENT from the installed set is refused, not silently agreed with",
             cyto_write_env_lock(tempfile(),
                                 list(list(name = "Ghost", version = "9.9")),
                                 header = "# h", ip = ip,
                                 resolve_version = function(nm) NA_character_,
                                 repo_of = repo_of, lib_paths = libs),
             "would record NOTHING for the pinned package Ghost")
expect_error("a pin R cannot RESOLVE is refused",
             cyto_write_env_lock(tempfile(),
                                 list(list(name = "Matrix", version = "1.7-6")),
                                 header = "# h", ip = ip,
                                 resolve_version = function(nm) NA_character_,
                                 repo_of = repo_of, lib_paths = libs),
             "so 'what LOADS' has no answer")

## THE SOURCE COLUMN HAS THREE OUTCOMES, and collapsing two of them was the defect: "R
## itself ships this" and "this came from somewhere nothing here can name" are opposite
## answers to the question the column exists to answer.
tmp3 <- tempfile(fileext = ".txt")
invisible(cyto_write_env_lock(tmp3, list(list(name = "Matrix", version = "1.7-6")),
                              header = "# h", ip = rbind(loaded_row("Matrix"), loaded_row("digest")),
                              resolve_version = resolve,
                              repo_of = function(nm) if (identical(nm, "Matrix")) "CRAN" else NA_character_,
                              priority_of = function(nm) if (identical(nm, "digest")) "recommended" else NA_character_,
                              lib_paths = libs))
lock3 <- readLines(tmp3, warn = FALSE)
expect_true("a package R SHIPS is recorded as such, not as `unrecorded`",
            any(grepl("# source=r-recommended", lock3, fixed = TRUE)),
            paste(lock3, collapse = " | "))
tmp4 <- tempfile(fileext = ".txt")
invisible(cyto_write_env_lock(tmp4, list(list(name = "Matrix", version = "1.7-6")),
                              header = "# h", ip = rbind(loaded_row("Matrix"), loaded_row("digest")),
                              resolve_version = resolve,
                              repo_of = function(nm) if (identical(nm, "Matrix")) "CRAN" else NA_character_,
                              priority_of = function(nm) NA_character_, lib_paths = libs))
expect_true("a package from NO declared coordinate is NAMED as such, distinguishably",
            any(grepl("UNRECORDED-NOT-FROM-A-DECLARED-COORDINATE", readLines(tmp4, warn = FALSE), fixed = TRUE)))

## THE SOURCE FIELD CANNOT INJECT A LINE. `Repository` is a DCF field from the resolved
## repository — content the build did not write — and DCF continuation lines make it
## legitimately multi-line. An audit returned one containing a newline and the writer
## emitted an extra `ghostpkg==9.9.9  # source=CRAN` line, which `env-lock-of.sh` then
## counted and printed as an installed version, in the file that IS the answer to "which
## versions did this run use".
tmp6 <- tempfile(fileext = ".txt")
counts6 <- cyto_write_env_lock(tmp6, list(list(name = "Matrix", version = "1.7-6")),
                               header = "# h", ip = ip[ip$Package %in% c("Matrix", "digest"), , drop = FALSE],
                               resolve_version = resolve,
                               repo_of = function(nm) if (identical(nm, "digest")) "CRAN\n  ghostpkg==9.9.9  # source=CRAN" else "CRAN",
                               lib_paths = libs)
lock6 <- readLines(tmp6, warn = FALSE)
## THE PROPERTY IS "cannot add a LINE", not "the bytes disappear". The first cut asserted
## `!any(grepl("ghostpkg", ...))` and failed against a correct sanitiser: the newline is
## collapsed to a space, so the text survives harmlessly ON ITS OWN PACKAGE'S LINE and adds
## nothing `env-lock-of.sh` would count. Asserting the stronger-looking thing would have
## forced the sanitiser to delete content it has no business deleting.
expect_true("an injected newline cannot make the field a separate LOCK LINE",
            !any(grepl("^[[:space:]]*ghostpkg==", lock6)),
            paste(lock6, collapse = " | "))
expect_true("...and the injected text stays on its own package's line, not silently dropped",
            any(grepl("^digest==0\\.6\\.39", lock6)),
            paste(lock6, collapse = " | "))
expect_equal("the lock's line count matches what the writer reports",
             length(grep("^[^#][^=]*==", lock6)), counts6$resolved)

## EVERY interpolated field, not just `source`. The first cut sanitised `Repository`
## alone; `Package`, `Version` and `LibPath` come from the same DCF file published by the
## same third party, and DCF continuation lines make any of them legitimately multi-line.
## An audit set a REAL installed package's `Version:` to a continuation carrying a
## package-shaped line, rebuilt its Meta/package.rds the way `R CMD INSTALL` does, and the
## writer emitted a whole extra line — the writer reporting one package and
## `env-lock-of.sh` reporting and printing two. The resolver cross-check did not see it
## because BOTH sides carried the same poisoned string.
tmp7 <- tempfile(fileext = ".txt")
ip7 <- data.frame(
  Package = c("goodpkg"),
  Version = c("0.1.0\n ghostpkg==9.9.9  # source=CRAN"),
  LibPath = c(libs[[1]]), stringsAsFactors = FALSE
)
counts7 <- cyto_write_env_lock(tmp7, list(list(name = "goodpkg", version = ip7$Version[[1]])),
                               header = "# h", ip = ip7,
                               resolve_version = function(nm) ip7$Version[[1]],
                               repo_of = function(nm) "CRAN", lib_paths = libs)
lock7 <- readLines(tmp7, warn = FALSE)
expect_true("a poisoned Version cannot fabricate a package line",
            !any(grepl("^[[:space:]]*ghostpkg==", lock7)),
            paste(lock7, collapse = " | "))
expect_equal("the writer's count and the file's package lines still agree",
             length(grep("^[^#][^=]*==", lock7)), counts7$resolved)

## The same byte in LibPath turns a `# shadowed` provenance COMMENT into a counted line.
tmp8 <- tempfile(fileext = ".txt")
ip8 <- data.frame(
  Package = c("goodpkg", "goodpkg"),
  Version = c("1.0", "0.9"),
  LibPath = c(libs[[1]], "/usr/local/lib/R/library\nfakepkg==7.7.7  # source=CRAN"),
  stringsAsFactors = FALSE
)
counts8 <- cyto_write_env_lock(tmp8, list(list(name = "goodpkg", version = "1.0")),
                               header = "# h", ip = ip8,
                               resolve_version = function(nm) "1.0",
                               repo_of = function(nm) "CRAN", lib_paths = libs)
lock8 <- readLines(tmp8, warn = FALSE)
expect_true("a poisoned LibPath cannot turn a shadowed COMMENT into a package line",
            !any(grepl("^[[:space:]]*fakepkg==", lock8)),
            paste(lock8, collapse = " | "))
expect_equal("...and the shadowed copy is still recorded", counts8$shadowed, 1L)

## Zero-length safety: `is.na(character(0))` is `logical(0)` and `||` on it aborts with
## "missing value where TRUE/FALSE needed" — turning a recording decision into an opaque
## build failure.
tmp5 <- tempfile(fileext = ".txt")
res5 <- tryCatch({
  cyto_write_env_lock(tmp5, list(list(name = "Matrix", version = "1.7-6")),
                      header = "# h", ip = loaded_row("Matrix"),
                      resolve_version = resolve,
                      repo_of = function(nm) character(0), lib_paths = libs)
  "ok"
}, error = function(e) conditionMessage(e))
expect_equal("a zero-length `repo_of` result does not abort the freeze", res5, "ok")

cat(sprintf("\n%s\n", if (failures == 0L) "regime_test.R: PASS" else sprintf("regime_test.R: %d FAILURE(S)", failures)))
if (failures > 0L) quit(status = 1L)
