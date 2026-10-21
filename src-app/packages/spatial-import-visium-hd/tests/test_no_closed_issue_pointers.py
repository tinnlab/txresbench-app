#!/usr/bin/env python3
# ruff: noqa
"""TEST-29 — no `#NNN` this package cites is a CLOSED issue offered as somewhere to GO.

## The defect this generalizes

#313 exists because of one sentence. `spatial-import-visium`'s `locate_members` refuses a
Visium HD bundle by name and tells the reader: *"That is issue #160, and picking one bin
here would hide the platform gap rather than close it."* #160 is CLOSED — it delivered the
upload CONTAINER, not the importer — so the deferral pointer outlived the issue it deferred
to, and the actual platform gap ended up tracked by nothing at all. A user who followed the
message arrived at a closed issue and a dead end; nobody planning work saw an open item.

That is a defect CLASS, not a typo. #302 is the same shape one package over ("shared
modules still pointing at `#156`'s registration overlay"). A one-off correction of one
sentence would not have prevented the next one, which is why DEC-7 discharges #313's third
acceptance bullet with THIS guard rather than with an edit.

## The rule, and why it is not "no closed issue may be named"

A CLOSED issue is often the RIGHT citation: "#160 delivered the container", "#222's defect
class is structurally unreachable here", "pinned by #163 after verifying it already ships".
Those are history, and forbidding them would make the code less explicable, not more. What
must never happen is a closed issue offered as a DESTINATION — the place a reader should go
for work that is missing.

So the rule is encoded in two layers, in descending order of how hard it is to reword
around:

* **Layer 1 (exact).** No CLOSED issue number may appear ANYWHERE inside a `raise` message
  in this package's own compute. A refusal message is what a user gets INSTEAD of their
  result, and the only reason such a message names an issue is to send the reader there —
  so in that context, citing and deferring are the same act. Nothing about this depends on
  prose.
* **Layer 2 (phrasing).** In any other string a user sees — report text, note text — a
  CLOSED issue number may not be reached by a DEFERRAL MARKER (`tracked as`, `filed as`,
  `deferred to`, `see issue`, …) within the same clause. This one CAN be reworded around,
  and saying so is the point: it is why layer 1 exists and why the marker list is spelled
  out below instead of hidden in a helper.

Strings are found with `ast`, never by regexing the file. A substring predicate cannot tell
a refusal message from the comment that explains it, and the sibling package records
exactly that false positive — where "fix the comment so the grep passes" would have been
the wrong repair.

## No network, so the issue states are COMMITTED and DATED

`just check-py` runs offline and a guard that phoned GitHub would go green whenever the
network was down — the worst possible failure direction for a guard. `tests/issue_states.json`
is a hand-captured, dated snapshot (`gh issue view <n> --json number,state,title`, run on
the date the file records). The date is load-bearing: the question this file asks is "was
the issue closed WHEN the reference was written", and a self-updating answer would both
retroactively condemn yesterday's honest citation and quietly stop covering tomorrow's new
one. Every number the scanner finds must be recorded there, so a new reference cannot be
added without someone looking its state up.

## Every read names `encoding="utf-8"`

The files scanned here are full of em dashes, `µm` and `§`. A locale-default read under
`LC_ALL=C` raises or mis-decodes, and a scanner that cannot decode its subject reports zero
references — which is a guard going green for the one reason it must not (#330/#333/#336/#339).
The positive control at the bottom is what makes that failure visible instead of silent.
"""
import ast
import json
import re
import sys
from datetime import date
from pathlib import Path

import pytest

PKG = Path(__file__).resolve().parents[1]
PACKAGES = PKG.parent
STATES = Path(__file__).resolve().parent / "issue_states.json"

#: The issue THIS package is for. The positive control's anchor.
THIS_ISSUE = 313

#: The issue #313 was filed about being cited as a dead end.
THE_STALE_POINTER = 160

#: An issue reference, and NOT the three things in this tree that look like one.
#:
#: `(?<![0-9A-Za-z_#])` — refuses a `#` that is itself preceded by an alphanumeric, an
#: underscore or another `#`, so a fragment inside a longer token is not harvested.
#: `(?![0-9A-Za-z])` — refuses a run of digits followed by a letter, which is what excludes
#: CSS colour literals: `registration_qc.py`'s QC verdict palette contains `#0a7`, and a
#: pattern without this guard reads that as issue **#0**. (`#eafaf3` never matched: it
#: begins with a letter.)
#:
#: WHAT IT DELIBERATELY DOES NOT MATCH, stated so the exclusions are choices and not gaps:
#:   * `#!` shebangs — `!` is not a digit;
#:   * `# 313` with a space — an issue reference in this repo is written closed-up, and
#:     matching the spaced form would harvest ordinary prose ("# 3 of 4");
#:   * `#NNNa`/`#a7` colour literals, per the two guards above;
#:   * six-digit colour literals that happen to be all-digits (e.g. `#123456`) WOULD match.
#:     None exists in this package today; if one is added it is recorded in
#:     `issue_states.json` as `NOT_AN_ISSUE` with its reason, which is the honest handling —
#:     an exclusion nobody wrote down is indistinguishable from a bug.
#: THE SIGIL IS NOT THE RULE, and believing it was made every layer of this guard evadable
#: by dropping one character. A blind audit put the literal sentence #313 was filed about --
#: "That is issue 160, and picking one bin here would hide the platform gap rather than close
#: it." -- into a user-facing refusal and the whole file went GREEN, including the test that
#: asserts BY NAME that this exact dead end cannot recur. The hashed spelling of the same
#: sentence reddens three tests, so the rule really did hang on the `#` alone.
#:
#: The unhashed form is not hypothetical prose either: this repo writes "issue 364" in running
#: text. So `issue NNN` is an issue reference here, exactly as `#NNN` is.
#: The spellings, widened again after a third audit found the second widening closed exactly
#: the one form the second audit had used and nothing adjacent to it. Each alternative here is
#: a spelling this repo or its issue tracker actually produces:
#:
#:   `#160`                       the sigil
#:   `issue 160`, `issues 160`    running text (this repo writes "issue 364")
#:   `GitHub issue 160`
#:   `issue no. 160`, `issue #160`
#:   `GH-160`                     the tracker's own short form
#:   `.../issues/160`             a GitHub URL -- the most common form in this tree (10
#:                                occurrences across docs/ and src-app/), and previously
#:                                invisible to EVERY layer, including the backstop that
#:                                requires each number to be in the dated snapshot
#:
#: And the COORDINATED form, `issues 313 and 160`, gets its own pattern below: the single
#: capture here takes only the first number, so a deferral naming an OPEN issue satisfied
#: TEST-35 while smuggling a CLOSED dead-end pointer past both layers in the same clause.
ISSUE_REF = re.compile(
    r"(?<![0-9A-Za-z_#])"
    r"(?:#|gh-|issues?/|(?:github\s+)?issues?\s*(?:nos?\.?\s*)?#?\s*)"
    r"(\d+)(?![0-9A-Za-z])",
    re.IGNORECASE,
)

#: `... and 160` / `..., 160` immediately after an issue reference. Run over the text a second
#: time so a coordinated list contributes EVERY number it names, not just the first.
ISSUE_REF_CONTINUED = re.compile(
    r"(?<![0-9A-Za-z_#])"
    r"(?:#|gh-|issues?/|(?:github\s+)?issues?\s*(?:nos?\.?\s*)?#?\s*)"
    r"\d+(?![0-9A-Za-z])"
    r"((?:\s*(?:,|and|&)\s*#?\d+(?![0-9A-Za-z]))+)",
    re.IGNORECASE,
)


def issue_numbers(text):
    """Every issue number `text` names, in any of the spellings above, coordinated lists
    included.

    A single regex cannot do this: the capture that finds `issues 313 and 160` returns 313 and
    stops, and that is not a detail -- a deferral that names an OPEN issue and a CLOSED one in
    one clause passed every layer of this guard while pointing a reader at the dead end.
    """
    found = [int(m.group(1)) for m in ISSUE_REF.finditer(text)]
    for m in ISSUE_REF_CONTINUED.finditer(text):
        found.extend(int(n) for n in re.findall(r"\d+", m.group(1)))
    return found

#: Prose that turns a CITATION into a DESTINATION. Matched when one of these is followed,
#: within the same clause, by an issue reference.
#:
#: Chosen to separate "go here for the missing work" from "this happened, here is where":
#: `#160 delivered the container` and `See <design doc> §6 and issue #257` both point at an
#: EXPLANATION and are legitimate; `Widening this is tracked as #288` points at WORK THAT
#: DOES NOT EXIST if the issue is closed, and is the #313 defect exactly.
DEFERRAL_MARKERS = (
    "tracked as", "tracked by", "tracked in", "is tracked", "are tracked",
    "filed as", "filed under", "filed at",
    "deferred to", "deferred until", "deferred in",
    "see issue", "that is issue", "this is issue", "is issue",
    "follow-up is", "follow up is", "followed up in",
    "will be tracked", "is owned by issue",
)
#: THE GAP BETWEEN THE MARKER AND THE REFERENCE, and why it is not `[^.;]`.
#:
#: A period ends a sentence, so the gap must not cross one -- but a period is also INSIDE a
#: URL, and `[^.;]` cannot traverse `github.com`. So "tracked as
#: https://github.com/o/r/issues/160" -- the commonest deferral spelling in this tree -- was
#: unreachable by layer 2 no matter how many spellings the reference alternation learned.
#: A dot is admitted only when the next character is NOT whitespace, which is what separates
#: `github.com/` from `. See`.
_GAP = r"(?:[^.;]|\.(?=\S)){0,60}?"

#: The reference itself. Spelled once and shared with the DEFERRAL rule below, because two
#: copies of this alternation is how the two layers came to recognise different spellings.
_ISSUE_PREFIX = r"(?:#|gh-|issues?/|(?:github\s+)?issues?\s*(?:nos?\.?\s*)?#?\s*)"

DEFERRAL = re.compile(
    "(?:" + "|".join(re.escape(m) for m in DEFERRAL_MARKERS)
    + r")" + _GAP
    # EITHER a full reference, OR nothing at all when the MARKER ITSELF ended in the word
    # `issue`/`issues`. "That is issue 160" -- the literal sentence #313 was filed about --
    # has only one `issue` in it, the marker eats it, and the old pattern then demanded a
    # SECOND one. So layer 2 could not see the defect this whole file exists for; layer 1
    # caught it and layer 2, the only rule over report notes and diagnostics, did not.
    + r"(?:" + _ISSUE_PREFIX + r"|(?<=issue)\s*#?\s*|(?<=issues)\s*#?\s*)"
    + r"(\d+)(?![0-9A-Za-z])",
    re.IGNORECASE,
)

#: THE SAME COORDINATED-LIST READER, over the DEFERRAL rule.
#:
#: FIX_ROUND-3 routed `scan()`, layer 1, the #160-specific test and TEST-35 through
#: `issue_numbers()` and LEFT `DEFERRAL` a single-capture regex -- so the very spelling that
#: round's commit message says it closed ("a deferral could name an OPEN issue while smuggling
#: the CLOSED dead-end pointer past both layers in the same clause") still walked past LAYER 2,
#: which is the only rule over the strings a user reads OUTSIDE a `raise`: report notes and
#: diagnostics. MEASURED at FIX_ROUND-4: a note reading "the missing widening is tracked as
#: issues 313 and 288." (288 is CLOSED in the snapshot) left all nine tests in this file GREEN,
#: while the single-number spelling of the same sentence reddened TEST-29.
DEFERRAL_CONTINUED = re.compile(
    DEFERRAL.pattern + r"((?:\s*(?:,|and|&)\s*#?\d+(?![0-9A-Za-z]))+)",
    re.IGNORECASE,
)


def deferral_numbers(text):
    """Every issue number a DEFERRAL clause names, coordinated lists included."""
    found = [int(m.group(1)) for m in DEFERRAL.finditer(text)]
    for m in DEFERRAL_CONTINUED.finditer(text):
        found.extend(int(n) for n in re.findall(r"\d+", m.group(2)))
    return found


#: VENDORED VERBATIM from `spatial-types` and staged beside the entry. NOT this package's
#: own source: `tests/test_vendored_contract.py` byte-compares both against their source of
#: truth, so this package cannot correct a word in either without becoming a second
#: implementation wearing the first one's name. They are scanned SEPARATELY below, under a
#: ratchet, and the byte-identity is asserted there so the exclusion cannot be used to hide
#: a local edit.
VENDORED = ("compute/ome_writer.py", "compute/spatial_declarations.py")

#: The deferral pointers this package INHERITS through the vendored pair, frozen exactly.
#:
#: `ome_writer.py`'s `READABLE_SAMPLE_COUNTS` refusal ends "Widening this is tracked as
#: #288." — and #288 CLOSED on 2026-09-06, three days before this snapshot, by fixing the
#: CLIENT (Viv's `isInterleaved` rule) rather than by widening the writer. So the sentence
#: now sends a user whose 2- or 6-sample image was refused to a closed issue: the #313
#: defect, verbatim, in a user-facing refusal, in all FOUR copies of that file
#: (`spatial-types`, `spatial-import-visium`, `spatial-import-xenium`, and this package's
#: vendored copy at line 1371).
#:
#: It is FROZEN rather than fixed, and frozen rather than left to fail, because neither
#: repair is available to this branch: correcting the text would break the vendoring
#: identity invariant, and correcting it at the source forces a `spatial-types`
#: `manifest.yaml` bump that a sibling branch owns (`scripts/check-processor-seed-versions.sh`
#: — the identical constraint DEC-7 records for the `import_visium.py` pointer). So it is
#: FILED instead of edited: issue 364, against `spatial-types/compute/ome_writer.py`, whose
#: acceptance requires this set to shrink to the empty set in the same commit that fixes it.
#:
#: This is a RATCHET, not an exemption. A NEW inherited deferral, a change to this one, or
#: any drift of the vendored bytes turns the test below RED.
INHERITED_DEFERRALS = {
    ("compute/ome_writer.py", 288),
}


#: THIS FILE, excluded from its own sweep — the one exclusion, stated rather than quiet.
#:
#: A guard against stale deferral pointers has to QUOTE one to say what it forbids: the
#: docstring above reproduces `import_visium.py`'s "That is issue #160" verbatim, because a
#: rule whose subject is unnamed is a rule nobody can check. Scanning this file would
#: therefore refuse the guard for containing the very sentence it exists to catch, and the
#: only way to satisfy it would be to delete the explanation — which is the wrong repair in
#: exactly the way this whole file argues against.
#:
#: The exclusion is one named path, not a pattern, and `scanned_files` asserts it really
#: removed a file that exists — so it cannot silently widen into "the tests are not scanned".
SELF = Path(__file__).resolve().relative_to(PKG).as_posix()


def scanned_files():
    """Every `.py` and `.yaml` under this package, as package-relative POSIX paths.

    Enumerated by walking the tree rather than listed, so a file added tomorrow is scanned
    tomorrow. `__pycache__` is skipped: a `.pyc` is not source, and a stale one would make
    the scan answer about code that is no longer here. [`SELF`] is skipped for the reason
    recorded above it.
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


def scan():
    """`{issue number: [(relpath, lineno, line)]}` for every reference in the package."""
    hits = {}
    for rel in scanned_files():
        text = (PKG / rel).read_text(encoding="utf-8")
        for lineno, line in enumerate(text.splitlines(), start=1):
            for number in issue_numbers(line):
                hits.setdefault(number, []).append((rel, lineno, line.strip()))
    return hits


def states():
    """The committed, dated snapshot. `encoding="utf-8"` on a `.json` too — no exceptions."""
    return json.loads(STATES.read_text(encoding="utf-8"))


def closed_numbers():
    doc = states()
    return {int(n) for n, s in doc["issues"].items() if s == "CLOSED"}


def _docstring_nodes(tree):
    """The `id()`s of every Constant node that IS a docstring, so prose about the code is
    not mistaken for prose the user reads."""
    out = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Module, ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            if (node.body and isinstance(node.body[0], ast.Expr)
                    and isinstance(node.body[0].value, ast.Constant)
                    and isinstance(node.body[0].value.value, str)):
                out.add(id(node.body[0].value))
    return out


def user_visible_strings(rel):
    """`[(lineno, text, in_raise)]` — every string a reader of the PRODUCT could see.

    Found with `ast`, so a comment explaining a refusal is never mistaken for the refusal.
    Docstrings are excluded (they document the module for a developer and never leave the
    process); `in_raise` marks the strings that reach a user INSTEAD of their result, which
    is the set layer 1 holds to the stricter rule.

    Everything else that is a literal string in the module is included, including f-string
    fragments — `ast.walk` descends into `JoinedStr`, and an f-string is exactly where a
    message that interpolates a path would put its prose.
    """
    tree = ast.parse((PKG / rel).read_text(encoding="utf-8"), filename=rel)
    skip = _docstring_nodes(tree)
    raised = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Raise) and node.exc is not None:
            for child in ast.walk(node.exc):
                if isinstance(child, ast.Constant) and isinstance(child.value, str):
                    raised.add(id(child))
    out = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Constant) and isinstance(node.value, str)):
            continue
        if id(node) in skip:
            continue
        out.append((node.lineno, node.value, id(node) in raised))
    return out


def authored_compute():
    """`compute/*.py` MINUS the two vendored files — the modules this package really wrote."""
    return [rel for rel in scanned_files()
            if rel.startswith("compute/") and rel not in VENDORED]


# ── the positive controls: this guard is measuring something ────────────────────────


def test_TEST_29_the_scan_finds_REAL_issue_references_including_this_packages_own():
    """TEST-29 [positive control] — a sweep that found nothing would pass every rule below.

    WHAT THIS WOULD CATCH. The scanner's regex broken by an edit; the file walk pointed at
    the wrong root; a locale-default read raising and being swallowed; the package emptied.
    Each of those makes every assertion in this file vacuously true while looking rigorous,
    and #339 is this tree's proof that "the guard stopped seeing its subject" is a real
    thing that happens rather than a hypothetical.

    Anchored on #313 specifically, not merely on "some references exist": this package is
    #313's deliverable and its manifest changelog, its compute and its tests all name it. A
    scan that could not find THAT is not scanning this package.
    """
    hits = scan()
    assert hits, (
        f"the scan of {len(scanned_files())} file(s) under {PKG} found no `#NNN` reference "
        "at all — the pattern, the walk or the read is broken, and every rule in this file "
        "is now vacuous"
    )
    assert len(hits) >= 20, (
        f"only {len(hits)} distinct issue numbers found; this package's manifest alone "
        "cites nine. The sweep is not reaching the tree it claims to."
    )
    assert THIS_ISSUE in hits, (
        f"#{THIS_ISSUE} — the issue this entire package exists for — is cited nowhere the "
        f"scan can see. Found: {sorted(hits)}"
    )
    assert any(rel == "manifest.yaml" for rel, _n, _l in hits[THIS_ISSUE]), (
        f"#{THIS_ISSUE} is not cited in manifest.yaml; the changelog entry TEST-27 checks "
        "names it, so the scan is not reading the manifest"
    )

    # And the scan really refused the colour literal it says it refuses.
    assert 0 not in hits, (
        "the scan harvested issue `#0`, which means `registration_qc.py`'s `#0a7` verdict "
        "colour was read as an issue reference — the trailing guard in ISSUE_REF is gone"
    )


def test_TEST_29_the_DATED_snapshot_covers_every_reference_the_scan_finds():
    """TEST-29 — the offline substitute for the network, and the thing that keeps it honest.

    WHAT THIS WOULD CATCH. A new `#NNN` added to this package with nobody looking up whether
    it is open (the rule below would then simply not apply to it — a guard that shrinks
    silently as the code grows); a snapshot with no capture date, which cannot answer "was
    it closed when the reference was written"; a state string outside the three this file
    understands; and entries for numbers nothing cites any more, which is how a snapshot
    turns into a list nobody trusts.

    Both directions are asserted deliberately. Missing entries make the CLOSED rule
    incomplete; stale entries make it look more thorough than it is.
    """
    doc = states()
    for key in ("_captured", "_how", "_why", "issues"):
        assert key in doc, f"`{key}` is missing from {STATES}"

    captured = date.fromisoformat(doc["_captured"])
    assert captured <= date.today(), (
        f"the snapshot claims to have been captured on {captured}, which is in the future"
    )
    assert "gh issue view" in doc["_how"], (
        "`_how` must name the exact command the states were captured with, so the next "
        f"person can re-run it: {doc['_how']!r}"
    )
    assert len(doc["_why"]) > 80, "`_why` must say why this is a committed file and not a query"

    recorded = doc["issues"]
    assert all(isinstance(v, str) for v in recorded.values())
    unknown = {n: s for n, s in recorded.items()
               if s not in ("OPEN", "CLOSED", "NOT_AN_ISSUE")}
    assert not unknown, f"unrecognised state(s) in {STATES}: {unknown}"

    found = set(scan())
    missing = sorted(found - {int(n) for n in recorded})
    assert not missing, (
        f"these issue numbers are cited in this package but have no state recorded in "
        f"{STATES.name}: {missing}. Capture them with the command in `_how` and commit the "
        "result — until then the CLOSED rule below simply does not apply to them, which is "
        "a guard quietly shrinking as the code grows."
    )
    stale = sorted({int(n) for n in recorded} - found)
    assert not stale, (
        f"{STATES.name} records state for issue(s) nothing in this package cites any more: "
        f"{stale}. Drop them — a snapshot padded with numbers nobody uses reads as more "
        "coverage than it is."
    )


# ── layer 1: the exact rule, over the strings a user gets INSTEAD of a result ───────


def test_TEST_29_no_CLOSED_issue_is_named_in_a_REFUSAL_this_package_raises():
    """TEST-29 [layer 1] — a refusal that names an issue is sending the reader there.

    WHAT THIS WOULD CATCH. The #313 defect being committed again in this package: a
    `raise VisiumImportError(... "that is issue #NNN" ...)` whose #NNN has since closed, so
    the user is refused AND misdirected in the same sentence. Nothing here depends on the
    wording — any closed number, anywhere in a raise message, fails — so it cannot be
    reworded around, only removed.

    Scoped to the modules this package AUTHORED. The two vendored files are byte-frozen
    copies of `spatial-types`' and are handled by their own ratchet below, where the freeze
    is asserted rather than assumed.
    """
    closed = closed_numbers()
    assert closed, "the snapshot records no CLOSED issue at all, so this rule is vacuous"

    raise_sites = 0
    offences = []
    for rel in authored_compute():
        for lineno, text, in_raise in user_visible_strings(rel):
            if not in_raise:
                continue
            raise_sites += 1
            for number in set(issue_numbers(text)):
                if number in closed:
                    offences.append((rel, lineno, number, text.strip()[:160]))

    assert raise_sites >= 20, (
        f"only {raise_sites} string(s) were found inside `raise` statements across "
        f"{authored_compute()}. This compute refuses by name in dozens of places; a count "
        "this low means the AST walk is not finding the messages and the rule is vacuous."
    )
    assert not offences, (
        "a refusal message names a CLOSED issue, which sends a refused user to a dead end — "
        "the exact defect #313 was filed about, committed again:\n" +
        "\n".join(f"  {rel}:{lineno} names #{n} — {t}" for rel, lineno, n, t in offences)
    )


# ── layer 2: the phrasing rule, over everything else a user reads ───────────────────


def test_TEST_29_no_CLOSED_issue_is_offered_as_a_DESTINATION_in_report_text():
    """TEST-29 [layer 2] — "tracked as #NNN" on a closed NNN is work that does not exist.

    WHAT THIS WOULD CATCH. A report note or a diagnostic that tells the reader where the
    missing half is tracked, pointing at an issue that has since closed. The report is the
    other surface a user reads, and a note saying "widening this is tracked as #288" is the
    same dead end as a refusal saying it — the user just gets an artifact as well.

    Deliberately NOT "no closed issue may be named in report text". This importer's own
    `NON_PLACEABLE_VENDOR_IMAGES` note ends "See docs/design/visium-slide-design-scale.md §6
    and issue #257", and #257 is closed: that is a citation to the MEASUREMENT that explains
    why a CytAssist image is not placed, and it is exactly right. Forbidding it would make
    the note less explicable and would teach the next author to delete the citation rather
    than to check it. The distinction the marker list encodes is destination versus
    explanation.

    This layer is weaker than layer 1 and that is stated rather than hidden: a reworded
    deferral escapes it. It is here because it catches the phrasing that has actually
    occurred twice in this tree (#313's `#160`, #302's `#156`), and layer 1 is what holds
    the case that matters most.
    """
    closed = closed_numbers()
    scanned = 0
    offences = []
    for rel in authored_compute():
        for lineno, text, _in_raise in user_visible_strings(rel):
            scanned += 1
            for number in set(deferral_numbers(text)):
                if number in closed:
                    offences.append((rel, lineno, number, text.strip()[:160]))
    assert scanned > 200, (
        f"only {scanned} string constant(s) were read out of {authored_compute()}; the AST "
        "walk is not reaching this compute's prose"
    )
    assert not offences, (
        "a string a user reads offers a CLOSED issue as the place the missing work lives:\n"
        + "\n".join(f"  {rel}:{lineno} defers to #{n} — {t}"
                    for rel, lineno, n, t in offences)
        + f"\n(deferral markers: {list(DEFERRAL_MARKERS)})"
    )


# ── the specific one #313 was filed about ──────────────────────────────────────────


def test_TEST_29_issue_160_is_cited_NOWHERE_as_the_place_to_go_for_the_missing_importer():
    """TEST-29 — the named case, asserted by name, because it is the reason this file exists.

    #313's own words: "The refusal points the reader at #160 — and #160 is CLOSED. It
    delivered the container, not the importer. The deferral pointer is stale, so the actual
    platform gap is tracked by nothing: no open issue names it, and the code that refuses HD
    sends a reader to a closed issue."

    WHAT THIS WOULD CATCH. This package reproducing that sentence in any form — in a
    refusal, in a report note, or in a comment phrased as a deferral. It is asserted
    separately from the general rules above because the general rules are calibrated on a
    snapshot and a marker list, and this one claim must hold even if somebody widens either.

    #160 may still be CITED, and is, four times: it delivered `spatial/visium-hd-bundle` and
    the path-segment member matching that made this package possible, and `INV-6` rests on
    that having already landed. History, not a destination. The positive control below
    asserts those citations are still there — a version of this file that passed because
    #160 had been scrubbed from the package entirely would be measuring nothing.
    """
    hits = scan()
    assert THE_STALE_POINTER in hits, (
        f"#{THE_STALE_POINTER} is cited nowhere in this package. That is not a pass: this "
        "test is calibrated on the citations that SHOULD be here (the container and the "
        "member matcher #160 delivered), and their absence means it is measuring nothing."
    )

    # (a) It reaches no user, anywhere in the compute — vendored files INCLUDED, because a
    #     user cannot tell which of the staged modules produced the message they are reading.
    leaks = []
    for rel in scanned_files():
        if not rel.startswith("compute/"):
            continue
        for lineno, text, in_raise in user_visible_strings(rel):
            if THE_STALE_POINTER in set(issue_numbers(text)):
                leaks.append((rel, lineno, "raise" if in_raise else "text", text[:160]))
    assert not leaks, (
        f"#{THE_STALE_POINTER} appears in a string this package's compute shows a user: "
        f"{leaks}. #{THE_STALE_POINTER} delivered the CONTAINER and is closed; pointing a "
        "user at it for the importer is the defect #313 was filed about."
    )

    # (b) And nowhere in the package — comments and manifest included — is it phrased as a
    #     deferral. This is the half that catches "the HD importer is tracked as #160" in a
    #     comment, which no user sees but which sends the next author to the same dead end.
    deferrals = []
    for rel in scanned_files():
        text = (PKG / rel).read_text(encoding="utf-8")
        for lineno, line in enumerate(text.splitlines(), start=1):
            if THE_STALE_POINTER in set(deferral_numbers(line)):
                deferrals.append((rel, lineno, line.strip()[:160]))
    assert not deferrals, (
        f"#{THE_STALE_POINTER} is offered as a place to go: {deferrals}. It is CLOSED — it "
        "delivered the container. The importer is #313, and this package IS it."
    )


# ── the vendored pair: frozen, not exempt ──────────────────────────────────────────


def test_TEST_29_the_VENDORED_copies_are_byte_frozen_and_carry_no_NEW_deferral():
    """TEST-29 — the ratchet over the two files this package may not edit.

    `compute/ome_writer.py` and `compute/spatial_declarations.py` are VENDORED VERBATIM from
    `spatial-types` and staged beside the entry, because the platform confines `run.helpers`
    to a package's own tree. This package cannot correct a word in either: the vendoring
    identity is the contract, and a vendored file that drifts is a second implementation
    wearing the first one's name.

    So they are excluded from the rules above — and the exclusion is made non-vacuous HERE,
    two ways. First, byte-identity to the source of truth is asserted, so nothing can be
    smuggled into this package behind the exclusion. Second, the deferral pointers the pair
    INHERITS are frozen as an exact set: a new one, a removed one, or a change of which
    issue is named turns this red.

    WHAT THIS RATCHET CURRENTLY RECORDS, and it is a real defect rather than a formality:
    `ome_writer.py:1371` refuses an image whose sample count is outside {1, 3, 4} and ends
    the refusal "Widening this is tracked as #288." #288 CLOSED on 2026-09-06 — by fixing
    the CLIENT (Viv's hard-coded `isInterleaved` rule), not by widening the writer — so that
    sentence now sends a refused user to a closed issue in ALL FOUR copies of the file. It
    is #313's defect, in a user-facing refusal, inherited rather than authored here.

    It is frozen rather than fixed because neither repair is available to this branch:
    editing the vendored copy breaks the identity invariant, and editing the source forces a
    `spatial-types` `manifest.yaml` version bump that a sibling branch owns
    (`check-processor-seed-versions.sh` — the identical constraint DEC-7 records for the
    `import_visium.py` pointer). It belongs in an issue against `spatial-types`, and this
    frozen set is what stops it being forgotten.
    """
    closed = closed_numbers()

    for rel in VENDORED:
        mine = PKG / rel
        source = PACKAGES / "spatial-types" / rel
        assert mine.is_file() and source.is_file(), f"{rel} is missing on one side"
        assert mine.read_bytes() == source.read_bytes(), (
            f"{rel} has DRIFTED from `spatial-types/{rel}`. The exclusion the rules above "
            "grant this file rests entirely on it being a verbatim copy; a drifted copy is "
            "this package's own source and must satisfy them."
        )

    inherited = set()
    for rel in VENDORED:
        for lineno, text, _in_raise in user_visible_strings(rel):
            for number in set(deferral_numbers(text)):
                if number in closed:
                    inherited.add((rel, number))

    assert inherited == INHERITED_DEFERRALS, (
        f"the CLOSED-issue deferrals inherited through the vendored pair changed.\n"
        f"  now:    {sorted(inherited)}\n"
        f"  frozen: {sorted(INHERITED_DEFERRALS)}\n"
        "A NEW entry means a stale pointer just arrived from `spatial-types` and needs an "
        "issue filed there; a REMOVED entry means one was fixed upstream and this frozen "
        "set must shrink to match, or it starts excusing a defect that no longer exists."
    )
    # The frozen set is not a list of numbers somebody could mistype into harmlessness: the
    # sentence it stands for must still be the sentence.
    assert "Widening this is tracked as #288." in (
        (PKG / "compute" / "ome_writer.py").read_text(encoding="utf-8")
    ), (
        "the `#288` deferral this ratchet freezes is no longer in the vendored "
        "`ome_writer.py`; if it was fixed upstream, drop it from INHERITED_DEFERRALS"
    )


def test_TEST_29_this_files_own_reads_are_ENCODING_EXPLICIT():
    """TEST-29 — the scanner cannot be allowed to go quiet on a non-UTF-8 locale.

    Every file this scanner opens carries em dashes; several carry `µm` and `§`. A
    `read_text()` with no encoding uses the locale's preferred encoding, which under
    `LC_ALL=C` is `ANSI_X3.4-1968` — and the result is either a `UnicodeDecodeError` or,
    worse, mojibake in which the regex finds fewer references than exist. #339 is that
    defect landing in this tree for the fourth time, which is why it is asserted rather than
    trusted.
    """
    source = Path(__file__).read_text(encoding="utf-8")
    reads = re.findall(r"\.read_text\((?P<args>[^)]*)\)", source)
    assert reads, "no `read_text` call found here, so this control measures nothing"
    bare = [call for call in reads if "encoding=" not in call]
    assert not bare, f"{len(bare)} `read_text(...)` call(s) name no encoding: {bare}"

    # And the subject really is non-ASCII, so the requirement is load-bearing rather than
    # ceremonial.
    non_ascii = [rel for rel in scanned_files()
                 if any(b > 0x7F for b in (PKG / rel).read_bytes())]
    assert non_ascii, (
        "no file under this package contains a non-ASCII byte any more, so the "
        "encoding requirement above no longer defends anything — re-derive it or drop it"
    )


#: Words that PROMISE the work happens somewhere else. A deferral is the one kind of
#: sentence whose whole content is a pointer, so it is the one kind that must carry one.
#:
#: Deliberately narrow. "This is out of scope" states a boundary and needs no tracker;
#: "this is FILED separately" asserts that an item exists, and an assertion nobody can check
#: is how #313 happened -- `import_visium.py` deferred to #160 after #160 closed, and the
#: platform gap ended up tracked by nothing. A deferral naming NO issue at all is the same
#: defect one step earlier: the reader has nowhere to go and nobody planning work sees it.
#: TEST-35's own marker list, named separately from layer 2's `DEFERRAL_MARKERS` above.
#: It was originally spelled `DEFERRAL_MARKERS` too, which REBOUND the module-level name --
#: harmless to layer 2's behaviour (its `DEFERRAL` pattern is compiled from the first binding
#: at import time) and not harmless to its failure MESSAGE, which printed the wrong list.
SHIPPED_DEFERRAL_MARKERS = (
    "filed as", "is filed", "filed separately", "filed rather than",
    "tracked as", "tracked by", "deferred to", "follow-up", "followup",
)

#: THE SENTENCE is the window, not a line count. A first cut allowed the pointer anywhere
#: within +/-3 lines, and a MUTATION TEST showed that is not a guard: deleting `#360` from
#: the manifest's staging deferral left the check green, because `#313` is mentioned three
#: lines below for an unrelated reason. A pointer that happens to be nearby is not this
#: deferral's pointer. So the marker and the number must be in ONE SENTENCE.
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+")

#: Text inside double quotes is a QUOTATION, and a quotation is not this package's promise.
#: `spatial-storage-layout.md` §6.7 is quoted verbatim in `locate_bins` -- 'must be "filed as
#: a `[shared]` platform item"' -- and that "filed as" is the DESIGN's sentence, not a
#: deferral this module is making. Quoted spans are removed before markers are looked for.
_QUOTED_SPAN = re.compile(r'"[^"]*"')


def deferral_sentences(rel):
    """Every SENTENCE of one shipped file that promises work happens elsewhere.

    The file is flattened to one stream first (comment markers stripped, lines joined),
    because a deferral and its issue number are routinely split across two wrapped comment
    lines and a line-by-line scan sees neither whole.
    """
    text = (PKG / rel).read_text(encoding="utf-8")
    flat = " ".join(re.sub(r"^\s*(#:|#|\*|>|-)\s?", "", ln).strip()
                    for ln in text.split("\n"))
    out = []
    for sentence in _SENTENCE_SPLIT.split(flat):
        unquoted = _QUOTED_SPAN.sub(" ", sentence)
        if any(m in unquoted.lower() for m in SHIPPED_DEFERRAL_MARKERS):
            out.append(sentence.strip())
    return out

#: Shipped files only -- the ones a USER of this package can read. A deferral inside the
#: test suite is a note to the next maintainer, who has the lifecycle record; a deferral in
#: the manifest or the compute is read by someone who does not.
def shipped_files():
    return [rel for rel in scanned_files()
            if rel == "manifest.yaml" or rel.startswith("compute/")]


def test_TEST_35_every_DEFERRAL_in_SHIPPED_prose_NAMES_AN_ISSUE():
    """A promise that work happens elsewhere must say WHERE, in the shipped copy.

    ## Why `DEC-N` does not discharge it

    `DECISIONS.md` is a `.lifecycle/` artifact and `.lifecycle/` is STRIPPED from the tree
    before it merges (`git log` on main: "strip lifecycle artifacts"). So a shipped sentence
    whose only referent is `(DEC-3)` points at a file that does not exist in the tree the
    reader is holding. It reads like a pointer, which is worse than no pointer at all: it
    stops the reader looking further.

    ## What this would catch

    Exactly what it did catch on the branch that added it. Three shipped deferrals --
    the staging-ordinal workaround (`locate_bins` leg (b)), the bin PICKER form, and the
    2 um barcode-join memory ceiling -- each said "filed" and named no issue between them.
    The first is #360, the second #361; the third had genuinely never been filed and is now
    #367. TEST-29 was blind to all three: it checks that a pointer is not STALE, and a
    deferral with no pointer has nothing to be stale.

    The rule is intentionally satisfiable in one way only -- write the number. It cannot be
    reworded around, because the marker list is checked against the sentence and the numbers
    against `issue_states.json`, which is where a number's OPEN/CLOSED state already lives.
    """
    offenders = []
    for rel in shipped_files():
        for sentence in deferral_sentences(rel):
            if not issue_numbers(sentence):
                offenders.append((rel, sentence))
    assert not offenders, (
        "a shipped deferral names no issue:\n"
        + "\n".join(f"  {rel}:  {text}" for rel, text in offenders)
        + "\nWrite the issue number in the shipped file. `(DEC-N)` does not count: "
          "`.lifecycle/` is stripped before merge, so that referent does not exist in the "
          "tree a reader is holding."
    )


def test_TEST_35_the_deferral_scan_is_NOT_VACUOUS():
    """The guard must be looking at sentences that exist.

    A marker list that matches nothing passes forever. This asserts the shipped prose really
    does contain deferrals (it does -- three of them), so the check above has subjects.
    """
    found = [(rel, s) for rel in shipped_files() for s in deferral_sentences(rel)]
    assert len(found) >= 3, (
        f"only {len(found)} deferral sentence(s) found in the shipped files "
        f"({shipped_files()}) — either the markers no longer match this package's prose or "
        "the file list is wrong; either way the guard above is checking nothing"
    )


# ── TEST-45: the READERS themselves, pinned directly ────────────────────────────────


#: `(text, the numbers the reader must find)`. Every spelling FIX_ROUND-3 widened to, plus
#: the negatives that keep the widening from becoming "any digits".
#:
#: WHY THIS IS A TABLE OVER THE HELPER AND NOT A PROBE INTO THE PACKAGE. FIX_ROUND-3 widened
#: `issue_numbers()` from the `#NNN` sigil to six spellings and reported "7 mutants, 7 RED" --
#: but no `.py` or `.yaml` in this package CONTAINS any of the new spellings, so reverting the
#: helper wholesale to the pre-round-3 single regex left the ENTIRE package suite green.
#: MEASURED at FIX_ROUND-4. The widening was prospective-only and pinned by nothing: exactly
#: the shape this file exists to prevent, one level up. A guard that is only exercised through
#: source it happens to scan is pinned by that source's accidents.
SPELLINGS = (
    ("tracked as #160", [160]),
    ("that is issue 160", [160]),
    ("tracked as issue no. 160", [160]),
    ("tracked as GH-160", [160]),
    ("tracked as https://github.com/owner/repo/issues/160", [160]),
    ("tracked as github issue 160", [160]),
    ("tracked as issues 313 and 160", [313, 160]),
    ("tracked as issues 313, 160 and 288", [313, 160, 288]),
    ("tracked as #313 & #160", [313, 160]),
)

#: Text that names no issue at all. Without these the widening could be `\d+` and pass.
NON_SPELLINGS = (
    "#0a7",
    "version 160 of the reference",
    "a bin of 160 um",
    "spaceranger-3.1.0",
)


@pytest.mark.parametrize("text,expected", SPELLINGS, ids=[t for t, _ in SPELLINGS])
def test_TEST_45_issue_numbers_reads_EVERY_widened_spelling(text, expected):
    """TEST-45 — the scan-side reader, over each spelling, by value."""
    assert sorted(set(issue_numbers(text))) == sorted(set(expected)), (
        f"`issue_numbers` read {issue_numbers(text)!r} out of {text!r}; the widening this "
        "asserts is what stops a CLOSED-issue pointer wearing a different spelling from "
        "walking past every layer of this guard")


@pytest.mark.parametrize("text", NON_SPELLINGS, ids=list(NON_SPELLINGS))
def test_TEST_45_issue_numbers_reads_NOTHING_out_of_a_bare_number(text):
    """TEST-45 — the control. A widening with no floor is `\\d+`, which flags every version."""
    assert issue_numbers(text) == [], (
        f"`issue_numbers` invented {issue_numbers(text)!r} out of {text!r}")


@pytest.mark.parametrize("text,expected", SPELLINGS, ids=[t for t, _ in SPELLINGS])
def test_TEST_45_deferral_numbers_reads_EVERY_widened_spelling(text, expected):
    """TEST-45 — the DESTINATION-side reader, which FIX_ROUND-3 left single-capture.

    Layer 2 is the only rule over the strings a user reads outside a `raise` — report notes
    and diagnostics — so a coordinated list that escapes here escapes the guard entirely for
    that whole surface. Every entry above is a DEFERRAL clause, so both readers must agree.
    """
    assert sorted(set(deferral_numbers(text))) == sorted(set(expected)), (
        f"`deferral_numbers` read {deferral_numbers(text)!r} out of {text!r}")


def test_TEST_45_a_deferral_is_NOT_a_citation():
    """TEST-45 — the control that keeps layer 2 from becoming "no closed issue may be named".

    `NON_PLACEABLE_VENDOR_IMAGES`' own note ends "See … §6 and issue #257", and #257 is
    closed: a citation to the MEASUREMENT that explains a refusal, which is exactly right.
    The marker list is what separates destination from explanation, and it must keep doing so
    now that both readers are multi-number.
    """
    # THE PROBE CITES THE REAL DOCUMENT the shipped note cites, not a made-up one.
    # `scripts/check-design-citations.mjs` (#355, which landed on `main` while this branch was
    # in its fix loop) reads every design-document path in every TEXT FILE — comments and test
    # strings included — as a citation a reader is invited to follow, and refuses one that
    # resolves to nothing. Three probe sentences naming an invented document therefore turned a
    # repo-wide gate RED, and so did the comment that explained them. A probe about CITATIONS
    # is exactly the wrong place to write one that does not resolve; the sentence below is the
    # shipped note's own, which is also what makes it a faithful probe.
    note = "See docs/design/visium-slide-design-scale.md §6 and issue #257"
    assert deferral_numbers(note) == []
    assert deferral_numbers(note.replace("issue #257", "issues #257 and #160")) == []
    assert sorted(set(issue_numbers(
        note.replace("issue #257", "issues #257 and #160")))) == [160, 257]


def test_TEST_110_the_587_still_open_claims_are_RETIRED_and_the_closure_is_recorded():
    """TEST-110 — #587: the stale "still open in HD" records are retired, and the closure is recorded.

    The 0.14.0/#585 entry and the compute's #585 comment both recorded the unreadable-
    target leg as open in HD and tracked as #587; this node's fix closes that leg, and both
    records must be rewritten so a reader of the changelog or the comment sees the leg pair
    (the #585 Dataset leg + the #587 unreadable-target leg) as closed — not a pointer to a
    still-open item. TEST-29 cannot see this: its layer-2 rule fires only on a CLOSED issue
    offered as a destination, and #587 is OPEN, so a restored "still open" sentence would
    pass every existing guard. This pin asserts: (1) the 0.14.0 entry's stale sentence is
    gone and replaced by the closure record naming the 0.15.0 entry; (2) the compute #585
    comment's stale sentence is gone and replaced by the two-legs-closed record; (3) the
    0.15.0 entry exists and cites #587 and still names the #450 ExternalLink diagnosis as
    untouched; (4) `tests/issue_states.json` carries a 587 ENTRY whose state is a legal
    snapshot state (OPEN/CLOSED/NOT_AN_ISSUE — the DERIVED, presence-based shape, NOT
    `== "OPEN"`). The snapshot's own `_why` states the date is the load-bearing half and
    that it is "deliberately not self-updating: an issue that closes tomorrow does not
    retroactively make yesterday's citation a defect" — and #587 closes the moment this
    branch merges, so the NEXT re-capture (any later node's `gh issue view`) flips "587"
    to CLOSED and a state-equality assertion would redden for a reason wholly unrelated
    to the retirement pin. What the pin needs is that this node's citations were made
    against a dated snapshot that RECORDED 587 (the #585 node's 2026-09-23 capture,
    measured OPEN at the time) — presence + shape, never state equality. (Verified, NOT
    edited; the 0.15.0 entry's citation is covered by the existing entry.)
    """
    manifest = (PKG / "manifest.yaml").read_text(encoding="utf-8")
    lines = manifest.splitlines()
    version_line = next(k for k, ln in enumerate(lines) if ln.startswith("version:"))
    head_0150 = next(k for k, ln in enumerate(lines) if ln.startswith("# 0.15.0 — #587:"))
    head_0140 = next(k for k, ln in enumerate(lines) if ln.startswith("# 0.14.0 — #585:"))
    assert head_0140 < head_0150 < version_line, (
        "the changelog layout moved: the newest entry must sit immediately above "
        "`version:` (heads 0.14.0 < 0.15.0 < version)")

    # Entry bodies are `# `-prefixed continuation lines; strip the marker and join so a
    # phrase pin is not defeated by a line wrap that lands inside the phrase.
    def entry_text(head_idx, end_idx):
        return " ".join(ln.strip().lstrip("#").strip()
                        for ln in lines[head_idx:end_idx])

    entry_0140 = entry_text(head_0140, head_0150)
    assert "STILL OPEN in HD" not in entry_0140, (
        "the 0.14.0 entry still claims the unreadable-target leg is open in HD — the "
        "#587 retirement did not land in the changelog")
    assert "closed by the 0.15.0 entry (#587)" in entry_0140, (
        "the 0.14.0 entry does not record that this node's 0.15.0 entry closes the "
        "unreadable-target leg (#587)")
    assert "whole `/matrix` leg pair" in entry_0140, (
        "the 0.14.0 entry does not record the two-importers-agree claim advanced to the "
        "whole leg pair (#587)")

    entry_0150 = entry_text(head_0150, version_line)
    assert "0.15.0" in manifest, "the 0.15.0 version is not declared"
    assert "closed" in entry_0150 and "target cannot be read" in entry_0150, (
        "the 0.15.0 entry does not state the closure and the new refusal")
    assert "#450" in entry_0150 and "untouched" in entry_0150, (
        "the 0.15.0 entry no longer cites the #450 ExternalLink diagnosis as untouched "
        "(0.14.0/#585 pin: this node's refusals must not change the ExternalLink leg)")

    compute = (PKG / "compute" / "import_visium_hd.py").read_text(encoding="utf-8")
    mark = "── THE RESOLVED OBJECT MUST BE A GROUP (#585)"
    start = compute.find(mark)
    end = compute.find("if not isinstance(group, h5py.Group):")
    assert 0 <= start < end, (
        "could not locate the compute #585 comment block — the structural anchor moved")
    comment = compute[start:end]
    assert "remains open in HD -- #587" not in comment, (
        "the compute #585 comment still claims the unreadable-target leg is open — the "
        "#587 retirement did not land in the compute comment")
    assert "BOTH legs of the" in comment and "unreadable-target" in comment, (
        "the compute #585 comment does not record that both legs are now closed (#585 + "
        "#587)")

    states = json.loads(STATES.read_text(encoding="utf-8"))["issues"]
    # PRESENCE + SHAPE, NOT `== "OPEN"` — see the docstring clause (4). The snapshot's `_why`
    # makes it explicit: the DATE is the load-bearing half and the file is "deliberately not
    # self-updating: an issue that closes tomorrow does not retroactively make yesterday's
    # citation a defect". #587 CLOSES the moment this branch merges; the next re-capture
    # flips the entry to CLOSED and state-equality would redden for a reason unrelated to
    # the retirement pin. What the pin proves is that this node's citations were written
    # while the dated snapshot RECORDED 587 — presence of the entry, plus the shape sanity
    # check that it is one of the legal snapshot states (the file's own convention, applied
    # at the layer-2 scan below).
    assert "587" in states, (
        "the dated snapshot records no 587 entry — the re-capture that covered this node's "
        "#587 citations is missing, so the retirement pin no longer proves the citations "
        "were made against a recorded state (per `_why`, every cited number must be here)")
    assert states["587"] in ("OPEN", "CLOSED", "NOT_AN_ISSUE"), (
        f"issue_states.json records 587 as {states['587']!r}, a shape the snapshot never "
        "uses (OPEN/CLOSED/NOT_AN_ISSUE)")
