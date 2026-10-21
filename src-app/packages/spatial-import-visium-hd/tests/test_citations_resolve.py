#!/usr/bin/env python3
# ruff: noqa
"""TEST-34 — every `file.md:LINE` citation in this package's SHIPPED prose resolves, and
every citation that QUOTES its source is checked against the words at that line.

The two halves are not the same strength, and saying so here is deliberate: a citation with
a quotation beside it is checked against the QUOTED WORDS; a citation with none is checked
for a file that exists and a line in range. A blind audit measured the split at 25 of 45 and
observed, correctly, that the headline used to claim the stronger check for all of them.
Both are now closed as far as they can be: an unquoted citation must land on a line with
real prose on it (a fence or a tree-drawing is not a source — that is exactly what the ten
stale citations landed on), and a quotation sitting next to a citation can no longer escape
being judged by being moved a few characters away.

This package's stated posture is "Not from memory. Every claim below is a repo-internal
citation." A citation is only worth that sentence if the cited LINE actually carries the
quoted sentence, and nothing checked that: `tests/fixtures/PROVENANCE.json` is
machine-checked by TEST-32, but the manifest and the compute prose — the copy a HUMAN
reads — were checked by nobody.

WHAT THIS CAUGHT, on the branch that added it: ten citations were off by two.
`01-file-formats.md:627` was cited five times for "Positions are **Parquet** (millions of
squares)" and once for "the 2 um matrix is enormous and very sparse"; line 627 is the tree
drawing `└── square_016um/   …` and line 628 is a bare fence. The sentences live at 629 and
630 — exactly where PROVENANCE.json already recorded them. So the machine-checked copy was
right and the human-read copy was wrong, in the one direction nobody looks: a reader who
follows a citation and lands on a code fence concludes the claim is unsourced.

## The rule, and why it is anchored on the QUOTE

A citation with no quotation next to it asserts only "this is discussed over there", which a
line number cannot falsify and this guard therefore does not judge. A citation that follows
a QUOTED FRAGMENT asserts something exact — that those words are at that line — and that is
checkable. So the guard pairs each citation with the double-quoted fragment that ends
immediately before it, and requires the fragment to appear inside the cited line range.

Both halves are normalised before comparison (markdown emphasis, backticks, the two dash
widths, `µ`/`um`, `×`/`x`, curly quotes, and whitespace, which a comment re-wraps at will).
A comparison that demanded the byte-exact sentence would fail on the prose's own line
wrapping and would be deleted by the next person, which is a worse outcome than a slightly
lenient guard that survives.

## What is NOT scanned, and why

The VENDORED files (`compute/spatial_declarations.py`, `compute/ome_writer.py`,
`tests/visium_hd_refusal_sites.py`, `tests/sandbox_code_dir.py`) are byte-identical copies whose
source of truth lives in another package and is pinned by TEST-20. A citation drift in one
of those is a defect in the ORIGINAL, and repairing it here would break the byte-compare
that makes the vendoring safe. They are excluded BY NAME, and the exclusion is asserted to
be exactly the set TEST-20 pins, so a file cannot quietly join it.
"""
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402

PACKAGE = Path(__file__).resolve().parent.parent
#: The repo root: `<repo>/src-app/packages/<pkg>` -> three parents up.
REPO = HF.PACKAGES.parent.parent

#: Byte-identical vendored copies — see the module docstring. Named exactly as TEST-20 pins
#: them, and cross-checked against that test's own list below.
VENDORED = (
    "compute/spatial_declarations.py",
    "compute/ome_writer.py",
    "tests/visium_hd_refusal_sites.py",
    "tests/sandbox_code_dir.py",
)

#: A citation, as this package writes them: a markdown path (full or bare basename) and one
#: line or a line range, inside backticks.
RE_CITATION = re.compile(r"`(?P<path>[A-Za-z0-9_./-]+\.md):(?P<a>\d+)(?:-(?P<b>\d+))?`")

#: How far a quoted fragment may sit from the citation that sources it. A quote and its
#: citation are adjacent by convention (`"…" (`file:line`)`), and anything further away is
#: another sentence's quote and not this citation's claim.
#:
#: THE GAP IS ALSO THE EVASION, which is why `test_TEST_34_a_QUOTATION_NEXT_TO_A_CITATION_IS
#: _ALWAYS_JUDGED` exists below. When the pairing fails, the citation used to be silently
#: DEMOTED to the file-exists-only check — so the very defect this guard was written for
#: survived any rewrite that put a few more characters between the quote and the reference.
#: MEASURED: restoring a stale line number with the quote adjacent reddens the parametrised
#: test; inserting two words between them makes the identical stale citation pass. So an
#: unpaired quotation near a citation is now a FAILURE, not a shrug, and this number stops
#: being a hole.
#:
#: 24 rather than 14, because 14 was measured too tight on this package's own prose: the
#: `DEFAULT_BIN_UM` block writes a correctly-sourced quotation sitting 16 characters after
#: its citation. A gap that refuses a CORRECT pairing pushes the author to reword rather
#: than to fix, which is how a guard gets deleted.
QUOTE_GAP = 24

#: Shorter than this, a fragment is not a quotation of a sentence — it is a word in quotes
#: ("bin", "pass") and matching it proves nothing.
MIN_QUOTE_CHARS = 12

#: Research documents this package cites that are NOT on `main`, and the ref that carries
#: them. PLAN.md takes the same position about the design document, and for the same reason:
#: a claim sourced to a branch is still sourced, but a reader handed a bare path finds
#: NOTHING and reasonably concludes the citation is invented. So a branch-only citation is
#: exempt from the filesystem check and pays for the exemption by having to NAME the ref in
#: the same file — which is the only thing that makes it followable.
BRANCH_ONLY_DOCS = {
    # 17-platform output survey; introduced by 2ba1bf0f, never merged to main. Cited for
    # "Orientation is NOT derivable from array indices", which is why the pitch estimate is a
    # nearest-neighbour median rather than a lattice reconstruction.
    "docs/research/spatial-platforms/01-sequencing-platforms.md":
        "origin/docs/research-spatial-platforms",
}


#: This file, package-relative. Excluded from its own scan for the reason
#: `test_no_closed_issue_pointers.py` gives for the same exclusion: this module's prose is
#: ABOUT stale citations, so it names citations, line numbers and quotations side by side
#: deliberately, and the only way to satisfy the rules below inside it would be to delete
#: the explanation -- which is the wrong repair in exactly the way this file argues
#: against. `_shipped_files` asserts the exclusion removes EXACTLY ONE file, so it cannot
#: silently widen into "the tests are not scanned".
SELF = "tests/test_citations_resolve.py"


def _shipped_files():
    """Every file of this package whose prose a human reads, minus the vendored copies."""
    out, excluded = [], 0
    for path in sorted(PACKAGE.rglob("*")):
        if not path.is_file() or path.suffix not in (".py", ".yaml"):
            continue
        rel = path.relative_to(PACKAGE).as_posix()
        if rel in VENDORED or rel.startswith("tests/fixtures/"):
            continue
        if rel == SELF:
            excluded += 1
            continue
        out.append(path)
    assert excluded == 1, (
        f"the self-exclusion matched {excluded} file(s) instead of exactly one -- either "
        f"{SELF} moved (and this guard is now scanning itself, which cannot pass) or the "
        "path is stale (and something else is being skipped silently)"
    )
    return out


def _flatten(text):
    """The file's prose as ONE line, with comment furniture removed.

    A quotation and the citation that sources it are routinely split across two comment
    lines, so a line-by-line scan would see neither whole. Stripping the leading `#`, `#:`,
    `*`, `>` and `-` markers and joining with a single space reconstructs the sentence the
    reader actually sees.
    """
    parts = []
    for line in text.split("\n"):
        parts.append(re.sub(r"^\s*(#:|#|\*|>|-)\s?", "", line).strip())
    # A DOCSTRING DELIMITER IS NOT A QUOTATION. A triple quote leaves a bare `"` on each
    # side, so a quote-scanner reads a whole docstring as one quoted fragment -- which
    # paired a citation with "text" that was really the function's own prose. Neutralised
    # here, once, so every scan below sees the same stream.
    return " ".join(parts).replace(chr(34) * 3, " ").replace(chr(39) * 3, " ")


def _normalise(s):
    """Comparable form: markdown, dash widths, `µ`, `×` and whitespace are not the claim."""
    s = s.replace("**", "").replace("`", "")
    s = s.replace("’", "'").replace("‘", "'")
    s = s.replace("“", '"').replace("”", '"')
    s = s.replace("—", "-").replace("–", "-").replace("−", "-")
    s = s.replace("µ", "u").replace("μ", "u").replace("×", "x")
    s = re.sub(r"\bum\b", "u", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip().lower()


def _cited_text(lines, a, b):
    """The cited line range as one comparable string.

    The BLOCKQUOTE marker is stripped per line before joining, for the same reason the
    scanner strips `#` from a comment: a markdown `>` is furniture, and leaving it in puts a
    `>` in the MIDDLE of a sentence that a document wrapped across two lines -- which reads
    as a failed match on a citation that is perfectly correct. (Measured: the 10x
    `spot_diameter_fullres` quote is a two-line blockquote, and this is exactly how it
    failed.)
    """
    cleaned = [re.sub(r"^\s*(>+\s?|[-*]\s)", "", ln) for ln in lines[a - 1: b]]
    return _normalise(" ".join(cleaned))


def _resolve(cited_path):
    """The repo file a citation names, whether written in full or as a bare basename."""
    if "/" in cited_path:
        return REPO / cited_path
    hits = sorted(p for p in (REPO / "docs").rglob(cited_path) if p.is_file())
    if len(hits) == 1:
        return hits[0]
    return None


def _citations():
    """Every `(file, cited_path, a, b, quote_or_None)` this package ships."""
    found = []
    for path in _shipped_files():
        stream = _flatten(path.read_text(encoding="utf-8"))
        for m in RE_CITATION.finditer(stream):
            head, rest = stream[: m.start()], stream[m.end():]
            # WHICH SIDE THE QUOTE IS ON. This package writes citations in both orders --
            # `"…" (`cite`)` and `` `cite` -- "…" `` -- and either scan direction alone
            # mis-pairs the other form. Both mistakes were made by this scanner's first two
            # drafts, and both reported a CORRECT citation as stale, which is the failure
            # mode that gets a guard deleted.
            #
            # The separator settles it. A citation that PARENTHESISES the quote before it
            # is separated from it by nothing but `(` and spaces; a citation that INTRODUCES
            # the quote after it is separated from the previous one by real punctuation
            # (`;`, `--`, `:`). So: a pure-parenthesis gap means the quote is behind;
            # anything else means look ahead first.
            back = None
            if '"' in head[-QUOTE_GAP:]:
                close = head.rfind('"')
                open_ = head.rfind('"', 0, close)
                if open_ != -1 and re.fullmatch(r"[\s(\[]*", head[close + 1:]):
                    back = head[open_ + 1: close]
            quote = back
            if quote is None:
                ahead = rest[:QUOTE_GAP]
                if '"' in ahead:
                    start = m.end() + ahead.index('"')
                    close = stream.find('"', start + 1)
                    if close != -1:
                        quote = stream[start + 1: close]
                if quote is None and '"' in head[-QUOTE_GAP:]:
                    close = head.rfind('"')
                    open_ = head.rfind('"', 0, close)
                    if open_ != -1:
                        quote = head[open_ + 1: close]
            found.append((path, m.group("path"), int(m.group("a")),
                          int(m.group("b") or m.group("a")), quote))
    return found


ALL = _citations()

#: The BARE form -- a backticked colon-plus-line-number with no document in front of it --
#: a citation that names a line and no file, leaning on a
#: neighbouring citation for the path. A reader can usually follow it; a CHECKER cannot, and
#: that is how one stale line number survived the sweep that corrected ten others. It is
#: refused by name rather than taught to guess.
RE_BARE_CITATION = re.compile(r"`:(?P<a>\d+)(?:-\d+)?`")


def _bare_citations():
    out = []
    for path in _shipped_files():
        for i, line in enumerate(path.read_text(encoding="utf-8").split("\n"), 1):
            for m in RE_BARE_CITATION.finditer(line):
                out.append((path, i, m.group(0)))
    return out


def test_TEST_34_no_citation_names_a_LINE_WITHOUT_A_FILE():
    """A backticked line number with no document is unresolvable to a CHECKER.

    A human reads it as "same file as the line above", which is exactly why it survives: it
    is followable enough that nobody corrects it and opaque enough that nothing verifies it.
    This package shipped one, and it was the one stale line number still standing after ten
    others had been corrected by hand.
    """
    bare = _bare_citations()
    assert not bare, "\n".join(
        f"{p.relative_to(PACKAGE)}:{i} writes {q} -- a line number with no file. Spell the "
        f"document (`01-file-formats.md:630`) so the citation is checkable; the one bare "
        f"citation this package shipped was also the one stale line number left after ten "
        f"others were corrected."
        for p, i, q in bare
    )


def test_the_vendored_exclusion_is_exactly_what_TEST_20_pins():
    """The excluded set cannot grow silently.

    Excluding a file from a prose guard is how a guard stops guarding. The four names above
    are excluded because they are BYTE-PINNED elsewhere; if a fifth appears in `VENDORED`
    without appearing in TEST-20's list, this reddens.
    """
    pinned = (PACKAGE / "tests" / "test_vendored_contract.py").read_text(encoding="utf-8")
    for rel in VENDORED:
        assert rel.rsplit("/", 1)[-1] in pinned, (
            f"{rel} is excluded from the citation guard as 'vendored', but "
            f"test_vendored_contract.py does not pin it byte-for-byte — so nothing checks "
            f"it at all"
        )


def test_TEST_34_the_guard_is_NOT_VACUOUS():
    """A prose guard that found no prose is a green light for nothing.

    Both counts are asserted: the citations exist at all, and enough of them carry a QUOTE
    (the only form this guard can judge) that a regression has somewhere to land.
    """
    assert len(ALL) >= 20, f"only {len(ALL)} citation(s) found — the scanner is not reading"
    quoted = QUOTED
    assert len(quoted) >= 8, (
        f"only {len(quoted)} citation(s) carry a checkable quotation; the guard would pass "
        f"on a package whose every citation had silently lost its quote"
    )


def _branch_only(cited):
    """The ref a branch-only document lives on, or `None` if it should be on disk."""
    for known, ref in BRANCH_ONLY_DOCS.items():
        if cited == known or known.endswith("/" + cited):
            return ref
    return None


@pytest.mark.parametrize(
    "case", ALL,
    ids=[f"{c[0].name}:{c[1]}:{c[2]}-{c[3]}:{i}" for i, c in enumerate(ALL)],
)
def test_TEST_34_every_cited_FILE_and_LINE_RANGE_exists(case):
    """A citation naming a file that is not there, or a line past its end, is not a source."""
    path, cited, a, b, _quote = case
    ref = _branch_only(cited)
    if ref is not None:
        # The exemption's price: the ref must be named in the SAME file, so a reader who
        # cannot find the path has somewhere to go instead of concluding it was invented.
        text = path.read_text(encoding="utf-8")
        assert ref in text, (
            f"{path.relative_to(PACKAGE)} cites `{cited}`, which is not on `main` -- it "
            f"lives on `{ref}`. A citation to a document a reader cannot open is worse than "
            f"no citation, so the ref has to be named in this file too."
        )
        return
    target = _resolve(cited)
    assert target is not None and target.is_file(), (
        f"{path.relative_to(PACKAGE)} cites `{cited}`, which does not resolve to a file in "
        f"this repo — a reader following it lands nowhere"
    )
    n = len(target.read_text(encoding="utf-8").split("\n"))
    assert 1 <= a <= b <= n, (
        f"{path.relative_to(PACKAGE)} cites `{cited}:{a}-{b}` but that file has {n} lines"
    )


QUOTED = [c for c in ALL
          if c[4] and len(_normalise(c[4])) >= MIN_QUOTE_CHARS and _branch_only(c[1]) is None]


@pytest.mark.parametrize(
    "case", QUOTED, ids=[f"{c[0].name}:{c[1]}:{c[2]}" for c in QUOTED],
)
def test_TEST_34_a_QUOTED_citation_lands_on_the_quoted_words(case):
    """The claim a citation actually makes: THESE WORDS are at THAT LINE.

    WHAT THIS WOULD CATCH — and did: a research document gaining two lines above the cited
    sentence (a fence, a tree drawing, an added paragraph) moves every citation below it,
    silently. The quote still exists in the file, so a "does the sentence appear anywhere"
    check stays green; only the line is wrong, and the line is the whole reason a citation
    is more useful than a grep.
    """
    path, cited, a, b, quote = case
    target = _resolve(cited)
    assert target is not None, f"{path.name} cites unresolvable `{cited}`"
    lines = target.read_text(encoding="utf-8").split("\n")
    cited_text = _cited_text(lines, a, b)
    wanted = _normalise(quote)
    assert wanted in cited_text, (
        f"{path.relative_to(PACKAGE)} quotes\n  \"{quote}\"\nand cites `{cited}:{a}"
        f"{'' if a == b else f'-{b}'}`, which reads\n  \"{' '.join(lines[a - 1: b])[:220]}\"\n"
        f"The quotation is not there. Either the citation is stale (the document gained "
        f"lines above it) or the words were paraphrased into quotation marks."
    )


#: A pointer of the form "this document lives on <ref>". Written when a design document a
#: package quotes is not yet on `main` — legitimate, and the only thing that makes such a
#: quotation followable.
RE_BRANCH_POINTER = re.compile(r"`(origin/[A-Za-z0-9._/-]+)`")


def test_TEST_34_no_file_sends_a_reader_to_a_BRANCH_for_a_document_that_is_ON_DISK():
    """A branch pointer that OUTLIVED the merge is a citation to the wrong place.

    ## What this caught

    Six files in this package quoted the spatial storage-layout design document and told the
    reader it lives on a docs branch — true when this branch was cut, and false the moment
    #315 (`b34d4371`) restored that document to `main` and this branch merged it. Nothing was
    wrong with the quotations; every one of them is verbatim in the merged text. What was
    wrong is that a reader following the pointer would check out a stale branch to read a
    document sitting in their own tree, with no way to know the two had been reconciled.

    (The document and the branch are deliberately NOT both named in this paragraph: the
    check below reads a window around every `origin/<ref>` it finds, and prose naming both
    would make this file its own first offender.)

    That is the same defect class as a stale ISSUE pointer (#313, TEST-29) and a stale LINE
    pointer (TEST-34 above), arriving through a third door: the branch pointer is correct
    when written, is invalidated by someone ELSE's merge, and nothing in this package would
    ever have noticed.

    ## The rule

    A shipped or test file may name `origin/<ref>` as a document's home ONLY while that
    document is genuinely absent from the working tree. The moment the path resolves on
    disk, the pointer must name the tree — which is exactly the condition this asserts,
    and it needs no network and no knowledge of what merged when.
    """
    offenders = []
    for path in _shipped_files():
        stream = _flatten(path.read_text(encoding="utf-8"))
        for m in RE_BRANCH_POINTER.finditer(stream):
            # A CHARACTER WINDOW around the pointer, not the whole file and not a "sentence".
            #
            # Not the whole file: a module may legitimately name a branch ref for ONE document
            # while citing five others that are on disk — `registration_qc.py` does exactly
            # that — so the ref must be bound to the document it claims to host. (Measured: a
            # whole-file rule reported five false positives on this package's first run.)
            #
            # Not a sentence: splitting on `.` is wrong HERE of all places, because every
            # subject of this check is a path ending in `.md`. The first draft did split on
            # `.`, and the `.` it found was the one in `spatial-storage-layout.md` — so the
            # window began AFTER the document name and the guard matched nothing. It passed
            # its own mutation test only after this changed.
            lo, hi = max(0, m.start() - 240), min(len(stream), m.end() + 140)
            sentence = stream[lo:hi]
            for doc in re.findall(r"`([A-Za-z0-9._/-]+\.md)(?::\d+(?:-\d+)?)?`", sentence):
                target = _resolve(doc)
                if target is not None and target.is_file():
                    offenders.append((path.relative_to(PACKAGE).as_posix(), doc,
                                      m.group(1)))
    offenders = sorted(set(offenders))
    assert not offenders, (
        "a file names a branch ref as the home of a document that is IN THIS TREE:\n"
        + "\n".join(f"  {f}: `{d}` claimed to live on `{ref}`" for f, d, ref in offenders)
        + "\nThe document was merged to `main`. Point the reader at the path, not at a "
          "branch they would have to check out to read what they already have."
    )


#: A quotation long enough to be a claim, anywhere in the prose.
RE_ANY_QUOTE = re.compile(r'"([^"]{%d,})"' % MIN_QUOTE_CHARS)

#: How near a quotation must be to a citation before that pair MUST be judged. Wider than
#: `QUOTE_GAP` on purpose: `QUOTE_GAP` decides what the checker is confident enough to pair
#: automatically, and this decides what a HUMAN would read as sourced. The space between the
#: two is exactly where the evasion lived.
CLAIM_GAP = 120


def test_TEST_34_a_QUOTATION_NEXT_TO_A_CITATION_IS_ALWAYS_JUDGED():
    """A quotation the pairer could not attach is a citation nobody checks.

    ## The hole

    `_citations` pairs a citation with a quote only when the two are within `QUOTE_GAP`
    characters. When that fails the citation drops out of `QUOTED` SILENTLY and is checked
    only for "the file exists and the line is in range" — a predicate any number in the file
    satisfies. MEASURED by a blind audit on the real quotation in `read_positions`: with the
    quote adjacent, the stale `01-file-formats.md:627` reddens; with the two words
    "recorded at" inserted between quote and citation, the identical stale citation passes.
    The vacuity guard does not help, because `len(QUOTED) >= 8` is still satisfied by the
    others.

    ## The rule

    If a quotation of real length sits within `CLAIM_GAP` characters of a citation, that
    citation MUST have been paired with some quotation. It does not have to be the same one —
    deciding which quote belongs to which citation is the pairer's job and it may legitimately
    choose a different neighbour — but "there is a quotation here and this citation is
    unjudged" is refused. The fix for an offender is to move the quote next to its citation,
    which is also the form a human reads best.
    """
    unpaired = []
    for path in _shipped_files():
        stream = _flatten(path.read_text(encoding="utf-8"))
        paired = {(c[1], c[2]) for c in ALL
                  if c[0] == path and c[4] and len(_normalise(c[4])) >= MIN_QUOTE_CHARS}
        for m in RE_CITATION.finditer(stream):
            if (m.group("path"), int(m.group("a"))) in paired:
                continue
            if _branch_only(m.group("path")) is not None:
                continue
            lo, hi = max(0, m.start() - CLAIM_GAP), min(len(stream), m.end() + CLAIM_GAP)
            if RE_ANY_QUOTE.search(stream[lo:hi]):
                unpaired.append((path.relative_to(PACKAGE).as_posix(),
                                 m.group(0), stream[lo:hi][:150]))
    assert not unpaired, (
        "a quotation sits beside a citation that nothing checked against it:\n"
        + "\n".join(f"  {f} {c}\n    …{ctx}…" for f, c, ctx in unpaired)
        + "\nPut the quotation immediately before the citation (`\"…\" (`file:line`)`) or "
          "immediately after it, so the pair is judged. A citation whose quote drifted out of "
          "reach is checked only for a file that exists and a line in range — which is the "
          "hole the ten stale citations lived in."
    )


#: A cited line that is only markdown furniture — a fence, a tree drawing, a rule, a blank.
#: Not a source: it is exactly what the ten stale citations landed on when they were off by
#: two (line 627 is `└── square_016um/   …`; line 628 is ```` ``` ````).
RE_FURNITURE_ONLY = re.compile(r"^[\s`>|:.\-_=+*#\[\]()└├─│┌┐┘/\\]*$")


@pytest.mark.parametrize(
    "case", [c for c in ALL if _branch_only(c[1]) is None],
    ids=[f"{c[0].name}:{c[1]}:{c[2]}" for c in ALL if _branch_only(c[1]) is None],
)
def test_TEST_34_an_UNQUOTED_citation_still_lands_on_PROSE(case):
    """A citation must point at a line that SAYS something.

    The unquoted citations cannot be checked against words they never quoted — but they can
    be checked against the one property every real source line has and every stale one
    lacked: text. All ten of the stale citations this guard was written for landed on a code
    fence or a tree drawing, because that is what a document's structure looks like two lines
    above the sentence you meant.

    So the cited range must contain a line with actual words on it. Cheap, total, and it
    covers the half of the citations the quotation check cannot reach — including all six
    occurrences of `01-file-formats.md:602`, the sole source for "Visium HD writes
    `microns_per_pixel` itself", which is the claim DEC-6 and the manifest's "THE SCALE IS
    STATED, NOT DERIVED" both rest on.
    """
    path, cited, a, b, _quote = case
    target = _resolve(cited)
    assert target is not None and target.is_file()
    lines = target.read_text(encoding="utf-8").split("\n")[a - 1: b]
    assert any(not RE_FURNITURE_ONLY.match(ln) and len(re.sub(r"\W+", "", ln)) >= 3
               for ln in lines), (
        f"{path.relative_to(PACKAGE)} cites `{cited}:{a}"
        f"{'' if a == b else f'-{b}'}`, which contains no prose at all:\n"
        + "\n".join(f"    {ln!r}" for ln in lines)
        + "\nA code fence, a tree drawing or a blank line is not a source. This is precisely "
          "what a citation looks like after the document it points into gained two lines."
    )
