#!/usr/bin/env python3
# ruff: noqa
"""TEST-111 — the RETRACTED FALSE reason of #488 is absent package-wide.

## The rule, and why the old sentence was FALSE

#488 retracts the empty-matrix refusal's stated reason. The old sentence --

  "An empty matrix imports into a complete
  but empty dataset, which is indistinguishable
  from a successful import of a bundle with
  data in it."

-- is false for THIS importer: an empty dataset is trivially distinguishable
once it exists (it has zero squares under tissue and zero stored counts where
a real one has all of those), and HD's report carries the square and bin
counts, so the zero-barcode run prints a ZERO in the very channel that
sentence claimed was silent. The sibling's #445 repair corrected the same
claim in `spatial-import-visium`, whose message now names the outcome signal
instead; #489 measured how many unasserted copies of the sentence a package
can carry, which is the failure shape this scan exists to prevent.

## The TRUE claim, scoped to the outcome signal

What is genuinely true is narrower and is about what the operator SEES, not
about the dataset: an empty matrix imports at exit 0 and is reported as
SUCCESS, and there is no outcome REPORTED TO THE OPERATOR as anything other
than SUCCESS -- the process exits 0 and emits the identical
`progress("done", 100, ...)` line as a full import, and the report's
`image_warnings` / note fields are PASSIVE (they change nothing about the
exit code or stderr). #613 sharpens the scope PER SHAPE, because the old
unscoped absolute -- "nothing in the signal the operator acts on
distinguishes an empty import from a real one" -- is FALSE for the
zero-barcode shape: it (measured with the empty-matrix refusals set aside) streams
`progress: matrix|35|0 bins x N genes` and a report stating `n_bins: 0`, so
the emptiness IS visible in the stream and the report. The absolute is true
for the `nnz == 0`, all-zero and mixed shapes (which stream progress and a
report byte-identical to a real import) and false only for the zero-barcode
shape, whose stream carries `0 bins x N genes` and whose report carries
`n_bins: 0`. The claim the fixed messages state is
therefore the outcome-signal claim SCOPED PER SHAPE, and the expanded
forbidden set below forbids BOTH the #488-retracted fragments AND the #613
class: the "succeeded with a warning" phrasing and the unscoped absolute.
`main()` has exactly two designed outcomes (`except VisiumImportError:
sys.exit(2)`, or `write_manifest` + success), and `report/html` has no
renderer (#223), so no third channel exists. This is the
reason #488 decided to state, the reason the re-pointed TEST-73 pins on the
emitted stderr, and the reason the #470/#533/#548 refusals already use.

## Why an ABSENCE scan, and not a spot fix

#489 measured it on the sibling: the retracted sentence survives in copies
nobody asserts -- a builder docstring, a table row description -- so a
one-place correction leaves the false claim alive in an unasserted copy,
which the next #470-shaped change writes straight back into a message. The
repair shape this node takes is therefore the sweep: every `.py` and `.yaml`
under this package is scanned, and the six fragment groups below are
FORBIDDEN (each assembled from concatenated parts -- see `_FORBIDDEN` -- so
this file never carries the raw contiguous phrase, and it is `SELF`-excluded
anyway for the same reason `test_no_closed_issue_pointers.py` excludes
itself):

  * the predicate the old sentence used in its middle: `indistinguishable`
    + ` from a successful import`;
  * the phrase `complete but` + ` empty dataset`;
  * the phrase `bundle with` + ` data in it`;
  * the gate `imports into a` + ` complete but`;
  * the #503(2) phrasing `succeeded with a` + ` warning` (#613 class);
  * the unscoped absolute `nothing in the signal the operator acts on ` +
    `distinguishes` (#613 class).

Deliberately NOT forbidden: `indistinguishable` alone (it appears legitimately
in about a dozen places), `plausible wrong answer rather than an error` (true,
and it belongs to other defects), and `complete, coherent, empty dataset` (the
adjacent compute comment's TRUE phrasing -- DEC-3 leaves that comment; the
commas are what separate it from the forbidden comma-less phrase). The
corrected claim and its measured clauses are also deliberately NOT forbidden
as a class: `there is no outcome REPORTED TO THE OPERATOR as anything other
than SUCCESS`, `the operator-visible signal does not distinguish ...` and
`progress: matrix|35|0 bins x N genes` are the wording this node's fix ships,
and flagging them would make the sweep unshippable (the positive control
asserts exactly that).

## Two normalizations, because the phrase hides in three shapes

(a) WHITESPACE-COLLAPSED. The builder docstring wraps the phrase across two
source lines (`... which is indistinguishable` on one line, `from a
successful import ...` on the next), so the detector first collapses every
whitespace run -- newlines included -- to one space.

(b) WHITESPACE-, QUOTE- AND `#`-FREE. The message in `compute/import_visium_hd.py`
split the phrase across THREE ADJACENT string literals, so quotes and
indentation sat between the words; removing whitespace AND the `"`/`'`/`#`
characters joins them. (a) alone cannot see that shape, because the quote
characters keep the words apart. `#` is in the class for the THIRD shape: if a
future author writes the sentence back as a line-wrapped comment -- the shape
of the comment block that sits at `compute/import_visium_hd.py:3021-3024` -- the
`#` marker and the space after it sit between the words too, and a quote-free
normalization alone would miss it.

## The exclusion is one named path, asserted

This file quotes the forbidden sentence above to NAME the rule's subject, so
the sweep must not scan it -- exactly the reason the TEST-29 scanner excludes
itself for quoting #160's dead-end pointer. `SELF` is one named path, and
`scanned_files()` asserts it removed EXACTLY one existing file, so the
exclusion cannot silently widen into "the tests are not scanned".

## Standing tests this re-cites

TEST-8 (the zero-paths sweep over `HB.REFUSALS`) keeps guarding the four
reworded rows' refusals; TEST-9 (the ASCII one-line byte sweep) keeps guarding
the reworded message's ASCII spelling and single-line shape; TEST-27 (the
manifest changelog grammar) verifies the 0.17.0 bump; TEST-28 (the `pytest.ini`
testpaths enumeration) verifies this file is collected; TEST-29 (the dated
issue snapshot) verifies every `#NNN` this file and the changelog cite is
recorded -- 488, 489, 503, 613 and 614 included (added by this node), with
445, 470, 533 and 548 already recorded.

## Known ceiling

The detector is LITERAL: fragments are matched case-sensitively after
whitespace/quote/`#`-stripping, so hyphenation, an inserted comma,
capitalisation or a genuinely NEW paraphrase in different words are OUTSIDE
its guarantee. The expanded set pins the #488-retracted sentence and its four
distinctive fragments PLUS the #613 class -- the "succeeded with a warning"
phrasing and the unscoped "nothing in the signal the operator acts on ...
distinguishes" absolute -- in the two shapes those phrases actually shipped
in (line-wrapped and string-literal-split) plus the `#`-comment-wrap shape,
checked both whitespace-collapsed and in the `#`- and backtick-free joined
form, and hyphenated/ellipsised naming stays outside the guarantee too —
deliberately used in the manifest's own notes (`no-'succeeded-with-a-warning'`-outcome,
"nothing in the signal ... distinguishes") as an explicit allowance, not a
verbatim quote. A
future author's genuinely NEW paraphrase in different words remains outside
the guarantee (the sibling's refusal-reason scan tracks exactly that as its
own issue #614, and this node deliberately does NOT widen beyond the two
fragments -- no AST level, no YAML level, no paraphrase loosening): it is
caught by the repair-sweep discipline (the package-wide sweep-measurement
#489 describes), not by this guard.

## The scanned suffix surface — and what is deliberately NOT scanned

`scanned_files()` walks `.py` and `.yaml` only, matching
`test_no_closed_issue_pointers.py`'s convention. The package ALSO ships
non-`.py`/`.yaml` files — notably `.json` (`tests/issue_states.json`, the dated
issue-state snapshot, whose values are issue states, not the free text this scan
guards), `.html` (`tests/fixtures/visium-hd-outs/web_summary.html`, a generated
fixture copy) and the binary/tabular fixture members under
`tests/fixtures/visium-hd-outs/` (`.h5`, `.parquet`, `.csv`) — and those are
NOT scanned: an exclusion, not an accident. Adding a new suffix is a DELIBERATE
change, and the floor-30 coverage leg plus the compute/manifest coverage leg
exist to keep the walk honest.
"""
import ast
import re
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[1]

#: THIS FILE, excluded from its own sweep — the one exclusion, stated rather than
#: quiet, exactly as `test_no_closed_issue_pointers.py`'s `SELF` is.
SELF = Path(__file__).resolve().relative_to(PKG).as_posix()

_WS = re.compile(r"\s+")
_QUOTES_WS = re.compile(r"""["'#`\s]+""")


def _fragment(*parts):
    """Assemble one forbidden fragment from parts.

    The assembly serves ONE purpose: this source file never carries the raw
    contiguous fragment (the joined parts are a forbidden phrase). It says nothing
    about where the split sits — a split at a natural word boundary
    (e.g. `_fragment("indistinguishable", " from a successful import")`) is just
    as fine as one inside a word; both are only so the file is not itself a copy
    of the phrase. The `SELF` exclusion is what makes quoting-and-excluding safe:
    this file is removed from its own sweep, and `scanned_files()` asserts that
    exclusion removed EXACTLY one file, so the assembly is belt-and-braces, not
    the mechanism.
    """
    return "".join(parts)


#: The six forbidden fragments — the retracted #488 reason, in the four
#: sentence pieces that must never come back, PLUS the #613 class in two
#: pieces: the #503(2) "succeeded with a warning" phrasing and the unscoped
#: "nothing in the signal the operator acts on ... distinguishes" absolute.
_FORBIDDEN = (
    _fragment("indistinguishable", " from a successful import"),
    _fragment("complete but", " empty dataset"),
    _fragment("bundle with", " data in it"),
    _fragment("imports into a", " complete but"),
    _fragment("succeeded with a", " warning"),
    _fragment("nothing in the signal the operator acts on ", "distinguishes"),
)


def _line_containing(text, fragment):
    """The 1-based source line carrying `fragment`'s first word.

    Attribution, not detection: the fragment was already found in the whole
    text under a normalization, and the words of the phrase are contiguous in
    the SOURCE too (only whitespace, quotes or the `#` of a comment-wrapped
    copy sit between them), so a pattern that lets each inter-word gap be
    whitespace, a quote or a `#` finds the exact span and its first line.
    """
    pattern = re.compile(r"[\s\"#'`]+".join(re.escape(word) for word in fragment.split(" ")))
    match = pattern.search(text)
    if match is None:  # pragma: no cover — a found fragment is always attributable
        return 0
    return text.count("\n", 0, match.start()) + 1


def _contains_forbidden(text):
    """Every forbidden fragment `text` carries, under either normalization.

    Returns the list of fragments found — empty means clean. Both
    normalizations are required, and each is checked over the WHOLE TEXT (not
    line by line), because the phrase can span two source lines and, in the
    compute message, three ADJACENT STRING LITERALS:

    (a) whitespace-collapsed — every `\\s` run, newlines included, becomes one
        space, so the docstring's line wrap is no longer a hiding place;
    (b) whitespace-, quote- AND `#`-free — `"`, `'` and `#` are removed too, so
        a phrase split across adjacent literals (`"a complete but " "empty
        dataset"`) OR written back as a `#`-wrapped comment (the shape of the
        block at `compute/import_visium_hd.py:3021-3024`) is joined, which (a)
        cannot see because the quote/`#` characters keep the words apart.
    """
    collapsed = _WS.sub(" ", text)
    stripped = _QUOTES_WS.sub("", text)
    found = []
    for fragment in _FORBIDDEN:
        if fragment in collapsed or _QUOTES_WS.sub("", fragment) in stripped:
            found.append(fragment)
    return found


def scanned_files():
    """Every `.py` and `.yaml` under this package, as package-relative POSIX paths.

    Enumerated by walking the tree rather than listed, so a file added
    tomorrow is scanned tomorrow. `__pycache__` is skipped: a `.pyc` is not
    source, and a stale one would make the scan answer about code that is no
    longer here. [`SELF`] is skipped for the reason recorded in the docstring,
    and the exclusion is asserted to have removed EXACTLY one existing file.
    """
    out = []
    excluded = 0
    for path in sorted(PKG.rglob("*")):
        if path.suffix not in (".py", ".yaml") or not path.is_file():
            continue
        if "__pycache__" in path.parts:
            continue
        rel = path.relative_to(PKG).as_posix()
        if rel == SELF:
            excluded += 1
            continue
        out.append(rel)
    assert excluded == 1, (
        f"the self-exclusion matched {excluded} file(s) instead of exactly one — either "
        f"{SELF} has moved (and the guard is now scanning itself, which cannot pass) or the "
        "path is stale (and something else is being skipped silently)"
    )
    return out


def scan_forbidden():
    """`{rel: [(lineno, fragment), ...]}` for every forbidden fragment in the package."""
    hits = {}
    for rel in scanned_files():
        text = (PKG / rel).read_text(encoding="utf-8")
        found = _contains_forbidden(text)
        if found:
            hits[rel] = [(_line_containing(text, fragment), fragment) for fragment in found]
    return hits


# ── the acceptance test ──────────────────────────────────────────────────────────────


def test_TEST_111_the_retracted_reason_is_ABSENT_package_wide():
    """TEST-111 [acceptance, INV-3] [covers: ITEM-2, ITEM-3, ITEM-5] — the real sweep.

    Every `.py` and `.yaml` under the package is read with `encoding="utf-8"`
    and none may contain a forbidden fragment (the retracted #488 reason AND
    the #613 class — the "succeeded with a warning" phrasing and the unscoped
    "nothing in the signal the operator acts on ... distinguishes" absolute),
    in either normalization. This leg is RED until the compute messages, the
    builder docstring and the manifest entries are reworded — that
    is by design: the absence is the acceptance test, and it must never be
    "greened" by weakening the assertion or the fragment list.
    """
    hits = scan_forbidden()
    assert not hits, (
        "the retracted #488 reason or the #613 class is still present in this "
        "package:\n"
        + "\n".join(
            f"  {rel}:{lineno}: {fragment}"
            for rel, found in sorted(hits.items())
            for lineno, fragment in found
        )
    )


# ── the non-vacuity controls: this sweep is measuring something ──────────────────────


@pytest.mark.parametrize(
    "text",
    [
        # (1) UNWRAPPED — the contiguous phrase, assembled from parts.
        _fragment("would say 'an import ", "indistinguishable from a successful ", "import'"),
        # (2) WRAPPED across two source lines — the builder docstring's shape;
        #     whitespace-collapse normalization (a) is what sees it.
        _fragment("which is indistinguishable\n", "    from a successful import"),
        # (3) SPLIT across ADJACENT string literals (quote chars + spaces between
        #     the parts) — the compute message's shape; the quote-free
        #     normalization (b) is what sees it.
        _fragment('source says: "indistinguishable from a" ', '" successful import" here'),
        # (4) The literal-split through THREE parts, with the whitespace AND the
        #     quote characters between them, as the message had it. The splits sit
        #     INSIDE the phrases (`plete|but`, `port|from`, `with|data`), so no
        #     source line carries a raw contiguous fragment even here.
        _fragment('"imports into a complete', ' but " ', '"empty dataset, which is ',
                  '"indistinguishable from a successful ', 'import of a ', '"bundle with',
                  ' data in it."'),
        _fragment('source: "indistinguishable from a successful ', 'import of a bundle',
                  ' with data in it."'),
        # (5) #-COMMENT-WRAPPED — the sentence written back as a line-wrapped
        #     comment, the shape of the block at import_visium_hd.py:3021-3024.
        #     `#` and the space after it sit between the words, so only the
        #     `#`-stripping normalization (b) sees it.
        _fragment("# An empty matrix imports into a complete\n", "# but empty dataset, which is indistinguishable\n",
                  "# from a successful import of a bundle with\n", "# data in it."),
        # (6) #613 CLASS, QUOTED-LITERAL SPLIT — the "succeeded with a warning"
        #     phrasing written back across adjacent string literals, the shape
        #     the old compute message shipped.
        _fragment('source: "there is no "succeeded with a', '" "warning" outcome" here'),
        # (7) #613 CLASS, `#`-COMMENT-WRAPPED — the phrasing written back as a
        #     line-wrapped comment.
        _fragment("# there is no \"succeeded with a\n", "# warning\" outcome so nothing"),
        # (8) #613 CLASS, DOCSTRING LINE-WRAP — the phrasing wrapped across two
        #     source lines in a docstring; whitespace-collapse sees it.
        _fragment("there is no \"succeeded with a\n", "    warning\" outcome in this module"),
        # (9) #613 CLASS, QUOTED-LITERAL SPLIT — the unscoped absolute written
        #     back across adjacent string literals.
        _fragment('source: "nothing in the signal the operator acts on', '" distinguishes an empty import"'),
        # (10) #613 CLASS, `#`-COMMENT-WRAPPED — the unscoped absolute as a
        #      line-wrapped comment.
        _fragment("# nothing in the signal the operator acts on\n", "# distinguishes an empty import from a real one"),
        # (11) #613 CLASS, DOCSTRING LINE-WRAP — the unscoped absolute wrapped
        #      across two source lines.
        _fragment("nothing in the signal the operator acts on\n", "    distinguishes an empty import from a real one"),
        # (12) #613 CLASS, BACKTICK-WRAPPED — the phrasing with "warning"
        #      wrapped in backticks across adjacent string literals; the
        #      quote/`#`-free normalization alone cannot see it (the backticks
        #      keep the words apart), so the backtick joins the stripped class.
        _fragment('there is no "succeeded with a', ' `warning`" outcome here'),
        # (13) #613 CLASS, BACKTICK-WRAPPED — the unscoped absolute with
        #      "distinguishes" wrapped in backticks, same shape.
        _fragment("nothing in the signal the operator acts on", " `distinguishes` an empty import"),
    ],
)
def test_TEST_111_the_detector_CATCHES_every_shape_of_the_forbidden_phrases(text):
    """TEST-111 [positive control] — a detector that found nothing would pass the
    acceptance test vacuously, and a whitespace-only normalization would pass it
    on the string-literal split this package actually shipped. The cases cover
    the #488-retracted sentence AND the #613 class (the "succeeded with a
    warning" phrasing and the unscoped "nothing in the signal the operator acts
    on ... distinguishes" absolute) in each of the four shipped/prospective
    shapes."""
    assert _contains_forbidden(text), (
        f"the detector did not flag this shape of the retracted phrase: {text!r}"
    )


def test_TEST_111_the_detector_does_NOT_flag_the_TRUE_claim_or_clean_prose():
    """TEST-111 [positive control] — the sweep must stay scoped to the RETRACTED
    reason and the #613 class; the TRUE outcome-signal claim (scoped per shape)
    and ordinary clean prose are the shipped message wording (interpolations
    shown as `{int(...)}` placeholders), so flagging them would make the sweep
    unshippable and would be a false positive on the fix."""
    true_claim = (
        '{MATRIX_BASENAME} carries no barcodes at all, so the {int(bin_um)} um bin has no '
        'squares under tissue. An empty matrix imports at exit 0 and is reported as SUCCESS, '
        'and there is no outcome REPORTED TO THE OPERATOR as anything other than SUCCESS: '
        'the process would exit 0 and emit the same closing `progress("done", 100, ...)` '
        'line as a full import -- 17 outputs on this node\'s committed fixture, a number '
        'that is `len(entries)` and so bundle-dependent -- and the report\'s '
        '`image_warnings` / note fields are PASSIVE: they change nothing about the exit code '
        'or stderr and are only visible to someone who opens the report artifact. (MEASURED '
        'on this node\'s committed fixture with the empty-matrix refusals set aside: the '
        'same import then streams `progress: matrix|35|0 bins x '
        '{int(n_features)} genes` and `progress: coordinates|60|0 bin positions`, and its '
        'report states `n_bins: 0` and `n_bins_in_tissue: 0` -- so the emptiness IS visible '
        'in the stream and the report; what still does not exist is any non-SUCCESS '
        'outcome: no warning and no error, and the operator would still be told the import '
        'SUCCEEDED while downstream analysis runs on an empty matrix.) Check that Space '
        'Ranger detected tissue on this run. Refusing rather than shipping an empty matrix '
        'as a successful import.'
    )
    all_zero_claim = (
        '{MATRIX_BASENAME}\'s `/matrix/data` holds {int(nnz)} stored value(s), every one of '
        'them exactly 0, while the matrix declares {int(n_barcodes)} barcode(s) and '
        '{int(n_features)} feature(s) for the {int(bin_um)} um bin. Such a dataset imports '
        'at exit 0 and is reported as SUCCESS, and there is no outcome REPORTED TO THE '
        'OPERATOR as anything other than SUCCESS: the process would exit 0 and emit the same '
        'closing `progress("done", 100, ...)` line as a full import (17 outputs on this '
        'node\'s committed fixture; the count is `len(entries)`, bundle-dependent), and the '
        'report\'s `image_warnings` / note fields are PASSIVE -- they change nothing about '
        'the exit code or stderr and are only visible to someone who opens the report '
        'artifact. MEASURED on this node\'s committed fixture with the refusals set aside: '
        'every streamed `progress:` line and `visium-hd-import-report.json` are '
        'byte-identical to a real import of this bundle -- so in the streamed progress and '
        'the report the operator-visible signal does not distinguish this shape from a real '
        'one, and even the manifest\'s `expression` entry carries `structure.nnz` '
        '{int(nnz)} in both (the only difference in anything the report or manifest STATES '
        'is `data.stored_bytes` (71 vs 763 on this node\'s committed fixture -- a '
        'machine-readable byte count, not a stated value count, which no note field '
        'restates)). The process would exit 0 with no warning and no error, and the operator '
        'is told the import SUCCEEDED while downstream analysis runs on a matrix whose '
        'every stored value is 0 -- which is why it is refused rather than imported. Either '
        'the file is damaged or truncated, or this run produced no read that yielded a '
        'usable UMI (tissue detected, library or sequencing failed). Check '
        '`metrics_summary.csv`\'s "Number of Bins Under Tissue" and the raw matrix '
        '(`raw_feature_bc_matrix.h5`) to tell the two apart. Refusing rather than shipping '
        'an all-zero matrix as a successful import.'
    )
    assert _contains_forbidden(true_claim) == [], true_claim
    assert _contains_forbidden(all_zero_claim) == [], all_zero_claim
    assert _contains_forbidden(
        "Imports into a complete, coherent, EMPTY dataset otherwise.") == []
    assert _contains_forbidden("a plausible wrong answer rather than an error") == []
    assert _contains_forbidden(
        "the operator-visible signal does not distinguish this shape from a real one"
    ) == []
    assert _contains_forbidden("This refusal names the bin and the declared counts.") == []


# ── the coverage control: the sweep really saw the package it claims to sweep ────────


def test_TEST_111_the_sweep_and_self_exclusion_are_non_vacuous():
    """TEST-111 [positive control] — the scan must see the files the fix actually
    touched (the compute message and the manifest changelog) and must exclude
    exactly one existing file: itself.

    A walk pointed at the wrong root, a suffix filter gone wrong or a broken
    read would make the acceptance test above vacuously green while the
    retracted sentence stayed in the product — the exact failure mode the
    `encoding="utf-8"` requirement and this coverage leg exist to expose.
    """
    files = scanned_files()
    assert files, "the package scan enumerated no files at all"
    assert len(files) >= 30, (
        f"only {len(files)} .py/.yaml files were scanned (floor 30) — the sweep is not "
        "reading the package tree it claims to"
    )
    assert "compute/import_visium_hd.py" in files, (
        "the compute module carrying the refusal message is not scanned — the sweep "
        "cannot be the acceptance test for the retraction if it never reads the message"
    )
    assert "manifest.yaml" in files, (
        "the manifest changelog is not scanned — a reworded entry could quote the "
        "false sentence and the sweep would not see it"
    )
    assert SELF.endswith(".py") and (PKG / SELF).is_file(), (
        f"SELF is {SELF!r}, which is not an existing .py file — the exactly-one "
        "self-exclusion inside `scanned_files` would be vacuous"
    )
    assert SELF not in files, (
        f"the self-exclusion did not remove {SELF} from the scan"
    )


# ── TEST-2 (#641): the TEST-84 docstring names both non-finite readings ───────────────


# TEST-2 (#641): the honesty pin for #641 site 2 — the corrected TEST-84 docstring
# (per TESTS.md's phase-5 wording contract).
def test_TEST_112_the_TEST_84_docstring_names_both_readings_of_the_non_finite_diagnosis():
    """TEST-2 (#641) — the TEST-84 docstring names BOTH readings of the non-finite
    diagnosis.

    TEST-84's docstring describes the every-value-non-finite refusal's message. The
    #638 fix (0.19.0) made that message state BOTH readings (a corrupt or mis-written
    FILE, or a genuine run whose reads produced no usable UMI and whose matrix was then
    damaged or truncated), so the docstring's pre-#638 clause -- "never the all-zero
    diagnosis (failed run / no usable UMI)" -- is FALSE about the shipped message. #641
    corrected the docstring, and this pin keeps it corrected: the target is read from
    THIS package's `tests/test_empty_matrix_refusal.py` with explicit
    `encoding="utf-8"`, the TEST-84 def is found by name in the parsed AST, its
    docstring is extracted via `ast.get_docstring` and whitespace-flattened (the suite's
    OWN TEST-25 idiom), and the five contract fragments are asserted on THAT docstring.
    The needles live in THIS file, which the pin never reads, so they can neither
    satisfy nor defeat the checks (contrast TEST-136's self-read discipline).
    """
    empty_src = (PKG / "tests" / "test_empty_matrix_refusal.py").read_text(encoding="utf-8")
    fn = next((n for n in ast.walk(ast.parse(empty_src))
               if isinstance(n, ast.FunctionDef)
               and n.name == "test_TEST_84_an_all_NaN_data_matrix_is_refused_before_the_first_writer"),
              None)
    assert fn is not None, (
        "the TEST-84 def is missing from test_empty_matrix_refusal.py -- the docstring "
        "pin would be reading nothing"
    )
    doc = ast.get_docstring(fn) or ""
    flat = re.sub(r"\s+", " ", doc)
    assert "never the all-zero diagnosis" not in flat, (
        "the TEST-84 docstring still carries the stale pre-#638 clause -- the shipped "
        "non-finite message states BOTH readings, not only the corrupt/mis-written FILE "
        f"one (#641): {flat!r}"
    )
    assert "or a genuine run whose reads produced no usable UMI" in flat, (
        "the TEST-84 docstring must name the no-usable-UMI reading of the non-finite "
        f"diagnosis (#641): {flat!r}"
    )
    assert "every one of them exactly 0" in flat, (
        "the TEST-84 docstring must keep the marker-absence claim -- the all-zero "
        f"diagnosis's marker stays absent from the non-finite refusal (#641): {flat!r}"
    )
    assert "is retired with it" in flat, (
        f"the TEST-84 docstring must keep the retired old-claim note (#641): {flat!r}"
    )
    assert "MEASURED post-fix through the shipped entrypoint: rc 2, zero output paths" in flat, (
        f"the TEST-84 docstring must keep the MEASURED post-fix tail (#641): {flat!r}"
    )


# ── TEST-1 (#643): the two non-emitted #643 claim sites stay corrected ─────────────────


# TEST-1 (#643): the honesty pin for #643 sites 1+2 — the corrected decision-comment
# vendor fact (site 1) and the corrected assert-message prose (site 2), per TESTS.md's
# phase-5 wording contract. The A12 whole-commit revert plus the mutant probes in the
# phase-5 verification record are the discrimination proof (the item's acceptance
# condition); the absence needles redden on a revert of either site by construction.
_N643_CLAIM = _fragment("no measurement in this tree", " supports a vendor-wide claim")
_N643_STALE_VENDOR_FACT = _fragment("Space Ranger never", " emits NaN")
_N643_HEAD = _fragment("the non-finite refusal states", " BOTH readings")
# The FULL compound reading (includes the "and whose matrix was then damaged or
# truncated" half that distinguishes it from the all-zero diagnosis's reading 2) — the
# fix-round-1 refinement of the site-2 prose is itself load-bearing: dropping the
# compound from both rows reddens this leg.
#
# MEASURED (owner's merge-verify ladder, 2026-09-25): the compound phrase ALONE does
# NOT discriminate. `_QUOTES_WS` strips `#` and quotes, so the phrase is also carried
# by the TEST-84 docstring (#641, untouched by this node) and by each row's own
# explanatory comment — five occurrences in the file. Shortening BOTH assert messages
# to the pre-fix-round form while leaving those alone therefore left this leg GREEN.
# The needle is now the head-through-tail message read CONTIGUOUSLY, which the
# docstring ("states BOTH readings honestly: ...") and the comments ("names BOTH
# readings of the non-finite refusal (...)") do not contain, and it is COUNTED: it
# must appear exactly twice — once per row — so shortening either row reddens it.
_N643_FULL_READING = _fragment(
    "the non-finite refusal states BOTH readings — a corrupt or mis-written file, or ",
    "a genuine run whose reads produced no", " usable UMI and",
    " whose matrix was then damaged or truncated", " — and must NOT use the")
_N643_FAILEDRUN = _fragment("all-zero diagnosis's failed-run", " language")
_N643_STALE_PROSE = _fragment(
    "the non-finite refusal is the corrupt-FILE", " diagnosis")


def test_TEST_113_the_643_claim_sites_stay_corrected():
    r"""TEST-1 (#643) — the two NON-EMITTED #643 claim sites stay corrected.

    #643 names two claim sites; neither is EMITTED stderr, so the TEST-84/85
    byte-asserts cannot see a regression of them. Site 1 is the decision comment's
    vendor fact in `compute/import_visium_hd.py`; site 2 is the all-NaN/all-Inf rows'
    assert-message prose in `tests/test_empty_matrix_refusal.py`. Each is read back
    with explicit `encoding="utf-8"` (the locale rule this tree has closed several
    times) and checked under this file's own `_QUOTES_WS` joining — the same
    normalization the visium TEST-137 pin uses on the same comment class.

    The correctness legs are scoped to the declaring files: site 1's corrected claim
    is PRESENT in the compute module, and site 2's corrected head is PRESENT exactly
    twice in the refusal test (the two rows are the fence; a third copy or a missed
    twin reddens the check — see DEC-4), and the WHOLE corrected message — head
    through the compound reading 2 ("...no usable UMI and whose matrix was then
    damaged or truncated") read contiguously — is present exactly twice as well, so
    the fix-round-1 refinement is load-bearing and not merely echoed by a neighbouring
    comment or by the TEST-84 docstring (MEASURED: the phrase alone does not
    discriminate; see the needle comment above). The stale legs run
    PACKAGE-WIDE over
    `scanned_files()` (TEST-111's shape: every `.py` and `.yaml` under the package,
    SELF excluded, explicit encoding), so a second copy of either stale claim
    ANYWHERE in the package reddens the pin — the enforceable half of the Part-B
    claim class. The needles live HERE assembled from `_fragment` parts, so this
    source never carries them contiguously, and this file is the one path the scan
    excludes: they can neither satisfy nor defeat the checks.

    One deliberate consequence, stated openly: the stale legs run over EVERY `.py`
    and `.yaml` under the package, so a future changelog entry or comment that
    quoted the old vendor claim VERBATIM ("as it shipped" — the 0.19.0/0.20.0
    entries' convention) would REDDEN this pin. That is by design, in TEST-111's
    own words: the absence is the acceptance test, and it must never be greened by
    weakening the assertion or the fragment list. A "quote it as it shipped"
    changelog author must therefore either write the old claim in a hyphenated or
    otherwise re-worded form that does not survive the normalized needle (as the
    0.19.0/0.20.0 entries already do) or deliberately re-scope/re-write the
    needle in the same change — a verbatim quote landing is the sweep being
    right, not a false alarm.
    """
    compute_text = (PKG / "compute" / "import_visium_hd.py").read_text(encoding="utf-8")
    empty_text = (PKG / "tests" / "test_empty_matrix_refusal.py").read_text(encoding="utf-8")
    norm_compute = _QUOTES_WS.sub("", compute_text)
    norm_empty = _QUOTES_WS.sub("", empty_text)

    # (#643 site 1, ITEM-3) the corrected claim is present in the compute module —
    # the old vendor fact is checked absent package-wide below.
    assert _QUOTES_WS.sub("", _N643_CLAIM) in norm_compute, (
        "the decision comment must state the corrected in-place claim — no measurement "
        "in this tree supports a vendor-wide claim about what Space Ranger emits "
        "(#643 site 1)"
    )

    # (#643 site 2, ITEM-8) the corrected head is present EXACTLY twice — the two
    # rows, the fence.
    count = norm_empty.count(_QUOTES_WS.sub("", _N643_HEAD))
    assert count == 2, (
        f"the corrected site-2 head must appear exactly twice (the all-NaN and all-Inf "
        f"rows), found {count} — a third copy or a missed twin means the two-site "
        "fence has drifted (#643 site 2)"
    )
    full = norm_empty.count(_QUOTES_WS.sub("", _N643_FULL_READING))
    assert full == 2, (
        f"the corrected site-2 message must be present WHOLE — head through the "
        f"compound no-usable-UMI reading — exactly twice (one per row), found {full}; "
        "a shortened row is the fix-round-1 refinement regressing, and the phrase on "
        "its own is carried by the TEST-84 docstring and by each row's comment, so "
        "only the contiguous whole message discriminates (#643 site 2)"
    )
    assert norm_empty.count(_QUOTES_WS.sub("", _N643_FAILEDRUN)) >= 2, (
        "the non-finite producer prose must keep the prohibition on the all-zero "
        "failed-run language (#643 site 2)"
    )

    # The stale legs, package-wide: (a) the old vendor fact, (b) the stale
    # single-reading prose. Normalization joins a line-wrapped or literal-split
    # return, so neither hiding shape survives.
    stale_vendor = _QUOTES_WS.sub("", _N643_STALE_VENDOR_FACT)
    stale_prose = _QUOTES_WS.sub("", _N643_STALE_PROSE)
    offenders = []
    for rel in scanned_files():
        norm = _QUOTES_WS.sub("", (PKG / rel).read_text(encoding="utf-8"))
        if stale_vendor in norm:
            offenders.append((rel, "site 1"))
        if stale_prose in norm:
            offenders.append((rel, "site 2"))
    assert not offenders, (
        "a stale #643 claim is still present in this package:\n"
        + "\n".join(f"  {rel}: {site}" for rel, site in offenders)
        + "\n(#643 site 1 old vendor fact / site 2 stale single-reading prose)"
    )
