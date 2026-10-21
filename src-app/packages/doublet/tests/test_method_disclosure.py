#!/usr/bin/env python3
# ruff: noqa
"""TEST-E7-5 [acceptance] [invariant: INV-3] [covers: ITEM-5, ITEM-7] — HONEST DISCLOSURE.

*"Each method carries an HONEST statement of its measured performance — in `methodsText`,
in the report's disclosure and in the readout. The trade is stated, not argued away."*

This package now ships TWO doublet callers, and the only thing standing between a user and
an uninformed coin flip is what the two lanes SAY about themselves. That makes the narration
a load-bearing artefact rather than prose, and this file is the gate on it. Four separate
failure modes are covered, and each has burned this repository already:

  1. **A CLAIM THAT WAS TRUE AND IS NOT.** `doublet.detect`'s shipped `methodsText` asserted
     that scDblFinder "is unavailable in this…" — false the moment #191/#194/#195 landed.
     The manifest header asserted `r-base-core` was dropped "with no R runtime lane" — false
     for the same reason. Stale text that UNDERSTATES our capability is the mirror image of
     overstating it, and both are dishonest narration in an export a reader trusts. Both are
     REMOVED and REPLACED with something true and specific, and this file pins the removal
     AND checks the replacement against the manifest data rather than against its own memory.

  2. **TWO NUMBERS FOR ONE FACT.** The measured recall/precision/AUPRC of each method is
     written down in FOUR places: `compute/scdblfinder.R`'s `MEASURED_PERFORMANCE`, the two
     `methodsText` blocks, and `tests/test_ground_truth.py`'s recorded measurement. A
     re-measure that moves one and not the others ships a report that contradicts the run
     panel. `test_the_measured_numbers_have_exactly_one_source` PARSES all four and compares
     them; it is the only thing that makes "one source" true rather than aspirational.

  3. **A COMPARISON THAT IS NOT LIKE-FOR-LIKE.** Two numbers produced under different
     fixtures are not a comparison and must not be published as one (E7/DEC-9). So the
     report's `measured_performance` has to NAME the fixture, carry BOTH methods' numbers,
     and state the two limits that cap BOTH callers from above (~2% native doublets that the
     truth vector labels `singlet`; homotypic doublets undetectable by any simulation-based
     caller).

  4. **A DISCLOSURE THAT EXISTS ONLY IN THE SOURCE.** A `DISCLOSURE` constant nobody emits
     discloses nothing. Every disclosure assertion below therefore reads a REAL RUN'S EMITTED
     BYTES, following `test_ground_truth.py::
     test_the_homotypic_limitation_is_disclosed_to_users_not_only_to_this_test`.

── Why the version block is in here too ────────────────────────────────────────────────
The R analysis declares NO `run.dependencies` (ITEM-10: the recorder the contract would be
enforced by is a python helper `stages_app_helpers(Rscript)` never stages, so a declaration
would claim an enforcement that does not exist). The resolved versions in the report artifact
are therefore the WHOLE traceability record for a published scDblFinder number — there is no
second place a reader could recover them from. That makes them a disclosure, not bookkeeping.
"""
import ast
import json
import re
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

from doublet_fixtures import ScdblfinderRun, require_r_env, structured_counts

_PKG = Path(__file__).resolve().parents[1]
_MANIFEST = _PKG / "manifest.yaml"
_SCDBLFINDER_R = _PKG / "compute" / "scdblfinder.R"
_GROUND_TRUTH = Path(__file__).resolve().parent / "test_ground_truth.py"

#: The env id the R analysis resolves, and the runtime it declares. Named here so the
#: "replacement text is TRUE" assertions below can be checked against the manifest DATA
#: rather than against a substring in a comment.
R_ENV_ID = "single-cell-r"
R_RUNTIME = "rscript"

#: The libraries the R entry loads. Every one of them must have a resolved version in the
#: emitted report, because the manifest declares no contract for any of them — this block is
#: the WHOLE traceability record for a published number, delivered by value instead of by a
#: `run.dependencies` contract the platform cannot enforce for an R entry.
#:
#: The set is EXACT in both directions, deliberately. A library the entry loads but does not
#: record is a hole in that record — `S4Vectors` and `SummarizedExperiment` were exactly
#: that, reached through `::` (which needs no `library()` call, so they are easy to miss)
#: and found by a blind audit rather than by this test, which only checked that the names it
#: already knew were present. Both directions is what turns this from a checklist into a
#: gate: a new `pkg::fn` in the entry now reddens here until somebody records it.
R_LIBRARIES = ("R", "scDblFinder", "BiocParallel", "SingleCellExperiment", "Matrix",
               "jsonlite", "digest", "S4Vectors", "SummarizedExperiment")

#: The three disclosure keys the R report ships. `homotypic` and `method_tradeoff` are the
#: two the python lane already carries (so the two methods disclose the same things in the
#: same shape); `not_a_filter` is this lane's own.
DISCLOSURE_KEYS = ("homotypic", "method_tradeoff", "not_a_filter")

#: The measured numbers, as the design states them. These are used ONLY by
#: `test_each_method_states_its_own_measured_performance`, which asks whether each
#: `methodsText` states the right numbers for the right method. The "one source" test below
#: hardcodes NOTHING — it parses every recorded copy and compares them to each other.
EXPECTED = {
    "scdblfinder": {"recall": 0.964, "precision": 0.667, "auprc": 0.858},
    "scrublet": {"recall": 0.673, "precision": 0.628, "auprc": 0.585},
}

#: Files worth scanning for a stale claim. Deliberately NOT a suffix-blind walk: a `.zarr`
#: chunk or a `__pycache__` blob is not narration and a hit in one would be noise.
_TEXTY = {".py", ".R", ".r", ".yaml", ".yml", ".json", ".md", ".txt", ".toml", ".sh"}


def _package_text_files():
    for path in sorted(_PKG.rglob("*")):
        if not path.is_file() or path.suffix not in _TEXTY:
            continue
        if "__pycache__" in path.parts or ".zarr" in str(path):
            continue
        yield path


def _manifest():
    return yaml.safe_load(_MANIFEST.read_text())


def _analysis(analysis_id):
    for entry in _manifest()["contributes"]["analyses"]:
        if entry["id"] == analysis_id:
            return entry
    raise AssertionError(
        f"the manifest declares no analysis `{analysis_id}`; every disclosure below is "
        f"about a method this package claims to ship")


def _python_disclosure():
    """`compute/doublet.py`'s shipped `DISCLOSURE` dict, parsed from source.

    Read by AST rather than by importing the module, because importing it drags in scanpy
    and the whole scientific stack for what is a string comparison — and because the thing
    under test is what the SOURCE ships, which is what a deployment extracts.
    """
    import ast

    src = (_PKG / "compute" / "doublet.py").read_text()
    for node in ast.parse(src).body:
        if any(isinstance(x, ast.Name) and x.id == "DISCLOSURE"
               for x in getattr(node, "targets", [])):
            return {ast.literal_eval(k): ast.literal_eval(v)
                    for k, v in zip(node.value.keys, node.value.values)}
    raise AssertionError("compute/doublet.py no longer defines DISCLOSURE as a dict literal")


def _r_disclosure_source():
    """The `method_tradeoff` entry of `compute/scdblfinder.R`'s `DISCLOSURE`, as source text.

    R has no AST this suite can reach from python, so this slices the named entry out of the
    file between `method_tradeoff = paste0(` and the closing `),` — and asserts it found
    something, so a rename turns into a failure rather than an empty string that satisfies
    every check vacuously.
    """
    src = (_PKG / "compute" / "scdblfinder.R").read_text()
    start = src.index("method_tradeoff = paste0(")
    end = src.index("),", start)
    body = src[start:end]
    assert len(body) > 200, ("the R lane's method_tradeoff disclosure is suspiciously short; "
                             "the slice below probably stopped matching")
    return body


def _methods_text(analysis_id):
    """`methodsText` with its folded-scalar line wrapping normalized away.

    The manifest spells it as a `>-` block, so the newlines are an artefact of the file's
    column width and not of the sentence. Asserting on the raw string would make a reflow a
    test failure and a reworded claim a pass, i.e. exactly backwards.
    """
    return " ".join((_analysis(analysis_id)["methodsText"] or "").split())


# ── (1) the two false claims ────────────────────────────────────────────────────────────

#: The two spellings of the retired claim's verb, assembled from fragments so neither
#: appears as a contiguous literal in this file (see the scans that use them).
_UN = "un" + "available"
_NA = "not" + " " + "available"

#: This file's own source, so a scan can assert it does not flag itself.
_THIS_FILE = Path(__file__).read_text()


def test_the_availability_claim_is_gone_from_every_file_in_the_package():
    """TEST-34 — The sentence *"scDblFinder … is unavailable in this <runtime>"* must not survive
    ANYWHERE in the package — not in the manifest, not in a compute comment, not in a view's
    help text, not in another test's fixture prose.

    Delete this test and the branch can ship a `methodsText` that tells every reader of every
    exported `methods.md` that the method running two analyses down does not exist. That is
    not a typo: it is the run panel and the trust deliverable asserting a false fact about
    this deployment's own capability.

    The needle is BUILT BY CONCATENATION rather than written as one literal, so that this
    file can scan itself along with everything else. A test that has to exempt itself from
    its own scan cannot tell "the claim is gone" from "the claim moved into the test suite".

    ── IT SCANS A CLAIM FAMILY, NOT ONE STRING, AND THAT IS THE POINT ────────────────
    The first cut of this test matched ONE exact spelling of the claim. A blind audit then
    found the SAME false claim, alive and user-facing, in `compute/doublet.py`'s shipped
    `DISCLOSURE`, spelled with the other one — four characters different. (Neither spelling
    is written out here; that is the point of the fragments below, and the self-check
    immediately after them enforces it.) The guard sailed past it, and the string travels
    into every python run's `report/qc` and is rendered by `ui/doublet-report.yaml`, so the
    DEFAULT lane's own readout was telling users the method two analyses down did not
    exist. The audit also re-inserted a variant into the exact field ITEM-5 governs and
    watched the whole suite stay green.

    An exact-string guard over a SEMANTIC property has an unbounded evasion space — this is
    that failure, caught. The family below is still finite and still evadable by a
    sufficiently different wording; what makes the coverage real is that it is paired with
    `test_no_file_claims_the_r_method_is_unavailable`, which asserts on MEANING (the
    method's name near an unavailability word) rather than on any spelling.
    """
    # EVERY needle is assembled from fragments, so no needle exists as a contiguous literal
    # anywhere in this file. That is what lets the scan cover the test suite too: the first
    # widening of this list wrote the needles out in full and promptly flagged this file and
    # its sibling — a guard that has to exempt itself cannot tell "the claim is gone" from
    # "the claim moved into the test suite".
    unavailable = ["is " + _UN + " in this ", "is " + _NA + " in this ",
                   _UN + " in this ", _NA + " in this ",
                   "is " + _UN + " in the ", "is " + _NA + " in the "]
    runtime_words = ["run" + "time", "deploy" + "ment", "environ" + "ment",
                     "im" + "age", "root" + "fs"]
    needles = [u + w for u in unavailable for w in runtime_words]
    assert not any(n in _THIS_FILE for n in needles), (
        "a needle appears as a literal in this file, so the scan below would flag itself")
    offenders = sorted({"%s: %r" % (f.relative_to(_PKG), n) for f in _package_text_files()
                        for n in needles if n in f.read_text(errors="replace")})
    assert offenders == [], (
        "the retired availability claim is still asserted in: %s. It is false on a branch "
        "that ships `doublet.scdblfinder`." % offenders)


def test_no_file_claims_the_r_method_is_unavailable():
    """TEST-35 — The SEMANTIC companion to the needle scan, scoped to what SHIPS, and judged
    SENTENCE BY SENTENCE.

    ── Two evasions this closes, both measured ─────────────────────────────────────
    A blind audit injected eight false-availability wordings into a shipping file and found
    six that neither this scan nor the needle scan caught. Two causes:

      * the retraction exemption looked in a +/-300-character WINDOW, so a sentence like
        `"scDblFinder cannot run in this image; this note was written in 2026."` exempted
        itself — any retraction word ANYWHERE nearby granted a pass. The exemption is now
        scoped to the SENTENCE carrying the claim, which is the only place a retraction can
        honestly apply to it.
      * the unavailability vocabulary was short. It is longer now (`not installed`,
        `does not provide`, `unsupported`, `does not ship`, `lacks`, `requires an R
        runtime`), and each addition came from an evasion that actually worked.

    ── AND IT IS STILL A FLOOR, WHICH IS WHY IT IS NOT THE ANCHOR ──────────────────
    A pattern guard over a SEMANTIC property has an unbounded evasion space; the honest
    thing is to say so rather than widen the list forever and call it coverage. Somebody can
    still phrase this claim in words nothing here matches.

    What actually anchors the invariant is the POSITIVE test below —
    `test_the_shipping_comparison_fields_state_the_method_IS_available` — which pins the
    exact fields that carry the two methods' comparison and requires each of them to SAY the
    R method is available. A false claim cannot both be present and satisfy that, because
    there is nowhere for it to live except in the fields being pinned. This scan is the net
    for prose OUTSIDE those fields; the pins are the guarantee.
    """
    import re as _re

    # Scanned: exactly what reaches a user — the manifest (which becomes `methodsText` and
    # the run panel), the computes (whose DISCLOSURE strings become `report/qc` bytes), and
    # the view specs that render them. Tests are excluded because this package's tests
    # DISCUSS the retired claim at length on purpose, and an exemption wide enough to allow
    # that is wide enough to hide a real offender. The needle scan still covers them.
    name = "scdbl" + "finder"
    shipping = [_PKG / "manifest.yaml"]
    shipping += sorted((_PKG / "compute").glob("*.py"))
    shipping += sorted((_PKG / "compute").glob("*.R"))
    shipping += sorted((_PKG / "ui").glob("*.yaml"))

    unavail = _re.compile(
        r"(" + _UN + r"|" + _NA + r"|not installed|does not provide"
        # `unsupported` is NARROWED, not deleted. Bare, it matched the readout's own
        # "leaves that choice unsupported" — about a CHOICE, not the method — so a previous
        # round REMOVED it. That violated this file's own rule (narrow the vocabulary) in
        # the same commit that wrote the rule, and left a live hole: the word is in neither
        # scan's family, so "scDblFinder is unsupported in this deployment" passed 620
        # tests. Requiring a copula in front keeps the claim and drops the false positive.
        r"|(is|are|remains|stays) unsupported"
                r"|does not ship|cannot run|no r runtime|lacks an r|requires an r runtime)", _re.I)

    # ── THE VOCABULARY IS DELIBERATELY NOT WIDER THAN THIS ─────────────────────────
    # A blind audit found eight further wordings that evade it ("is absent from this
    # deployment", "support has been withdrawn", "there is no scDblFinder in this image",
    # …). The obvious response is to add them. It WAS tried, and immediately produced three
    # FALSE POSITIVES on legitimate shipped prose — a view spec noting "the one control that
    # is absent", the readout explaining that a choice is left "unsupported". Widening trades
    # one failure mode for the other and buys no closure, because the evasion space is
    # unbounded either way.
    #
    # So this scan stays a NET at a precision it can hold, and the closure lives in
    # `test_the_shipping_comparison_fields_state_the_method_IS_available`, which pins four
    # fields by name. A known residual limit: a claim that refers to the method by PRONOUN
    # in a later sentence ("scDblFinder is the R lane. It cannot run here.") is not caught.
    # Recorded rather than chased.
    # `removed from` is NOT here, and that is the point: it self-exempted a live claim
    # ("…cannot run in this image; the R lane was removed from the roadmap"). A retraction
    # marker has to be a phrase only a RETIRED claim can carry, never one a live claim can
    # carry about something else.
    retraction = _re.compile(
        r"(used to (say|assert|read)|it said|now false|no longer true|became false"
        r"|this version makes false|the sentence asserting|is removed from `|GONE rather"
        r"|retract)", _re.I)

    def sentences(text):
        """Sentence split over WHITESPACE-NORMALIZED text.

        A LINE BREAK IS NOT A SENTENCE END, and treating it as one was a real hole. These
        files carry prose inside YAML folded scalars and `#` comment runs where a sentence
        routinely spans lines — and YAML folding means the user READS it as one line. A
        blind audit put this into the R lane's `methodsText`, wrapped exactly as YAML wraps:

            NOTE: as of this build scDblFinder is not
            available in this deployment, so use the Scrublet lane instead.

        The name landed on line 1 and the vocabulary on line 2, so neither line tripped the
        scan, and the reader saw one perfectly clear false sentence. Comment markers and
        indentation are stripped and all whitespace collapsed FIRST, so what is judged is
        what a reader actually reads.

        IT SPLITS ON SENTENCE TERMINATORS ONLY. A previous version also split on ` — `,
        ` ; ` and ` : ` to stop one long comment paragraph becoming a single "sentence" in
        which any two words are adjacent. That was added to silence a false positive which
        removing an over-generic word from the vocabulary had ALREADY fixed — and it
        reopened the very hole this function exists to close, because an em-dash appositive
        is this codebase's dominant punctuation and separates a subject from its predicate
        INSIDE one sentence:

            # NOTE: scDblFinder — the caller this entry wraps — cannot run in this image.

        splits into three fragments, none of which carries both the name and the claim. A
        blind audit landed that in a shipping file and in the R lane's own `methodsText`;
        both passed 11/11. Reverted. If a false positive returns, narrow the VOCABULARY —
        never the sentence.
        """
        flat = _re.sub(r"^[ \t]*#+[ \t]?", " ", text, flags=_re.M)
        flat = _re.sub(r"\s+", " ", flat)
        # The lookbehinds are the abbreviation class. A bare `(?<=[.!?])\s` splits a
        # single reader-sentence at `i.e.`, `e.g.`, `cf.`, `et al.` — separating subject
        # from predicate exactly as the em-dash did, and all of those already appear in the
        # files this scans. "scDblFinder, i.e. the R doublet caller, cannot run in this
        # deployment" passed 620 tests. Closed here rather than left, because the docstring
        # above now tells future readers this splits on sentence terminators ONLY.
        for chunk in _re.split(
                r"(?<!\bi\.e\.)(?<!\be\.g\.)(?<!\bcf\.)(?<!\bal\.)(?<!\bvs\.)"
                r"(?<!\betc\.)(?<=[.!?])\s", flat):
            if chunk.strip():
                yield chunk

    offenders = []
    for path in shipping:
        for sentence in sentences(path.read_text(errors="replace")):
            if name not in sentence.lower():
                continue
            if unavail.search(sentence) and not retraction.search(sentence):
                offenders.append(f"{path.relative_to(_PKG)}: {' '.join(sentence.split())[:190]}")
    assert offenders == [], (
        "a SHIPPING file asserts (rather than quotes) that the R method is unavailable:\n  "
        + "\n  ".join(offenders))


#: The shipping fields that carry the two methods' comparison. Each MUST state that the R
#: method is available; that is what makes the negative scans a net rather than the whole
#: guarantee. Adding a surface here is how a new place to be wrong gets covered.
def test_the_shipping_comparison_fields_state_the_method_IS_available():
    """TEST-36 — THE POSITIVE ANCHOR for INV-3, and the reason the pattern scans above are allowed to
    be a floor.

    Every place a user meets the two-method comparison is pinned by NAME and required to say
    the R method is available:

      * `doublet.detect`'s `methodsText`      — the run panel and the exported methods.md
      * `doublet.scdblfinder`'s `methodsText` — the same, for the R lane
      * `compute/doublet.py`'s `DISCLOSURE["method_tradeoff"]` — every python run's
        `report/qc`, rendered by `ui/doublet-report.yaml`
      * `compute/scdblfinder.R`'s `DISCLOSURE$method_tradeoff` — the R lane's equivalent

    A false availability claim has nowhere to live except one of these, and it cannot be
    present in one of these AND satisfy it. That is a closed argument, where a pattern scan
    is an open-ended one — which is why this test, not those, is what INV-3 rests on.
    """
    # SCOPED TO THE PYTHON LANE'S TWO FIELDS, and the scope is the argument.
    #
    # These are the only two places where the R method's AVAILABILITY is the subject rather
    # than a presupposition — they are the fields that carried the false claim, and the only
    # fields a stale one can come back to. The R lane's own `methodsText` is not checked for
    # "is available": it IS the R method's narration, so its availability is presupposed by
    # its existence, and demanding the sentence there would be demanding a tautology. What
    # the R lane owes is its measured numbers beside the other method's, which
    # `test_each_method_states_its_own_measured_performance_in_its_methodsText` pins.
    # ── THE PYTHON LANE'S TWO FIELDS: the R method's availability is the SUBJECT ─────
    for where, text in (
        ("doublet.detect.methodsText", _methods_text("doublet.detect")),
        ("compute/doublet.py DISCLOSURE.method_tradeoff",
         _python_disclosure()["method_tradeoff"]),
    ):
        low = " ".join(text.split()).lower()
        assert "scdbl" + "finder" in low, (where, text[:200])
        assert ("is available" in low or "it is available" in low
                or "available in this deployment" in low), (
            f"{where} does not state that the R method IS available. It is the field a user "
            f"meets the comparison in, so an omission here is where a stale claim comes "
            f"back.\n{text[:400]}")
        assert "doublet.scdblfinder" in low, (where, text[:300])

    # ── THE R LANE'S TWO FIELDS: availability is presupposed, so the positive is a
    #    DIFFERENT one — that they say WHERE the method runs, and point at the measurement.
    #
    # An earlier version exempted these entirely, reasoning that demanding "is available"
    # from the R method's own narration is a tautology. The reasoning is right and the
    # exemption was still wrong: a blind audit put a false availability NOTE into
    # `doublet.scdblfinder`'s `methodsText` — the exact field ITEM-5 governs — and it had no
    # anchor at all. A field nothing anchors is a field a claim can live in.
    #
    # What catches an APPENDED claim is the scan above (appending does not delete the true
    # statement); what an anchor catches is the true statement being REMOVED. Both halves
    # are needed and they are different assertions.
    for where, text in (
        ("doublet.scdblfinder.methodsText", _methods_text("doublet.scdblfinder")),
        ("compute/scdblfinder.R DISCLOSURE$method_tradeoff", _r_disclosure_source()),
    ):
        low = " ".join(text.split()).lower()
        assert "scdbl" + "finder" in low, (where, text[:200])
        assert ("r analysis environment" in low or "r/bioconductor" in low), (
            f"{where} no longer says WHERE this method runs.\n{text[:400]}")
        assert ("xi & li" in low or "measurement" in low or "measured" in low), (
            f"{where} states neither the measurement nor the benchmark's limits.\n"
            f"{text[:400]}")

    # The R lane's own disclosure is checked for the OTHER half of INV-3 — that it does not
    # oversell. It must state the comparison's limits rather than only its result.
    r_disclosure = " ".join(_r_disclosure_source().split()).lower()
    assert "xi & li" in r_disclosure and "not " in r_disclosure, r_disclosure[:300]
    assert "measurement" in r_disclosure or "measured_performance" in r_disclosure, (
        "the R lane's method tradeoff must point at the measurement rather than at a "
        "published ranking, because #233 established there is no ranking to point at")


def test_the_replacement_availability_text_is_true_and_specific():
    """TEST-37 — Absence is only half of ITEM-5: the claim was to be *"removed and replaced with what
    is now true, not softened"*. A `methodsText` that merely deleted the sentence would leave
    a reader of the Scrublet lane with no way to learn that a second method exists.

    So the replacement is checked for the two things that make it actionable — the ANALYSIS
    ID a user would search for, and the ENVIRONMENT it runs in — and then those claims are
    checked AGAINST THE MANIFEST DATA. Asserting the substring alone would pass on a
    sentence naming an analysis that does not exist, which is a new false claim replacing an
    old one. Delete this and "removed" degrades to "deleted and forgotten".
    """
    text = _methods_text("doublet.detect")
    assert "doublet.scdblfinder" in text, text
    assert "IS available in this deployment" in text, text
    assert "R analysis environment" in text, text

    # …and the named analysis really is there, really is R, and really resolves that env.
    other = _analysis("doublet.scdblfinder")
    assert other["env"] == R_ENV_ID, other.get("env")
    assert other["run"]["runtime"] == R_RUNTIME, other["run"]["runtime"]
    assert other["run"]["entry"].endswith(".R"), other["run"]["entry"]


def _header_paragraphs():
    """The manifest's leading comment block, split into paragraphs on bare `#` lines.

    Read as RAW TEXT because `yaml.safe_load` discards comments entirely — the header is
    narration a maintainer reads, and it is exactly where the second false claim lived.
    """
    lines = []
    for line in _MANIFEST.read_text().splitlines():
        if line.startswith("#"):
            lines.append(line.lstrip("#").strip())
        elif not line.strip():
            lines.append("")
        else:
            break
    paragraphs, current = [], []
    for line in lines:
        if line:
            current.append(line)
        elif current:
            paragraphs.append(" ".join(current))
            current = []
    if current:
        paragraphs.append(" ".join(current))
    return paragraphs


def test_the_manifest_header_no_longer_asserts_there_is_no_r_runtime_lane():
    """TEST-38 — The header's METHOD rationale used to state, as fact, that `r-base-core` was dropped
    from the env rootfs *"with no R runtime lane"* and that we were therefore KNOWINGLY not
    shipping a stronger method. #191 built the image, #194 proved the `rscript` path and #195
    ships the method, so both halves are false.

    The phrase may still APPEAR — the header quotes the retracted sentence so a reader learns
    what changed — but it may never again be ASSERTED. That distinction is the whole test: a
    bare `assert "no R runtime lane" not in header` would force the correction to be made
    silently, which is precisely the "quietly applied" failure ITEM-5 exists to prevent. So
    every paragraph carrying the phrase must also carry the retraction, and the header must
    positively name what is true instead.

    Delete this and the header can drift back to advertising a capability gap this deployment
    does not have, with the run panel one file below saying the opposite.
    """
    paragraphs = _header_paragraphs()
    carriers = [p for p in paragraphs if "no R runtime lane" in p]
    assert carriers, (
        "the header neither states nor retracts the old `no R runtime lane` claim. ITEM-5 "
        "asks for a RECORDED correction, not a silent deletion.")
    for para in carriers:
        assert "It said" in para, para          # it is a quotation, not an assertion
        assert "now false" in para, para        # …and it is marked as retracted
        assert "GONE" in para, para

    header = " ".join(paragraphs)
    # …and what is true instead is stated specifically enough to act on.
    assert "doublet.scdblfinder" in header, header[:400]
    assert R_ENV_ID in header, header[:400]
    assert R_RUNTIME in header, header[:400]
    # cross-checked against the DATA, so the header cannot describe a tree that does not exist
    other = _analysis("doublet.scdblfinder")
    assert other["env"] == R_ENV_ID and other["run"]["runtime"] == R_RUNTIME


# ── (2) both methods state their measured performance, from ONE source ──────────────────

#: `"… recall 0.964, precision 0.667 and AUPRC 0.858, against 0.673, 0.628 and 0.585 …"`.
#: Both `methodsText` blocks use this one sentence shape; the trailing clause is what says
#: WHOSE the second triple is, and it is asserted separately rather than assumed from order.
_PAIR_RE = re.compile(
    r"recall\s+([0-9]*\.[0-9]+),\s*precision\s+([0-9]*\.[0-9]+)\s+and\s+AUPRC\s+"
    r"([0-9]*\.[0-9]+),\s*against\s+([0-9]*\.[0-9]+),\s*([0-9]*\.[0-9]+)\s+and\s+"
    r"([0-9]*\.[0-9]+)")


def _numbers_from_methods_text(analysis_id):
    """`{"scdblfinder": {...}, "scrublet": {...}}` parsed out of one `methodsText`.

    The ATTRIBUTION is verified, not inferred from position: the tail clause has to name
    which method the second triple belongs to. A block that swapped the two triples would
    otherwise parse cleanly and publish each method's numbers under the other's name.
    """
    text = _methods_text(analysis_id)
    match = _PAIR_RE.search(text)
    assert match, f"{analysis_id}'s methodsText states no measured recall/precision/AUPRC:\n{text}"
    a, b, c, d, e, f = (float(x) for x in match.groups())

    tail = text[match.end():match.end() + 80]
    if analysis_id == "doublet.detect":
        # "…for the method described here" — i.e. Scrublet, the analysis being narrated.
        assert "for the method described here" in tail, tail
        assert "scDblFinder" in text[:match.start()], text[:match.start()][-200:]
    else:
        assert "for the Scrublet method" in tail, tail
        assert "this method measured" in text[:match.start()], text[:match.start()][-200:]
    return {"scdblfinder": {"recall": a, "precision": b, "auprc": c},
            "scrublet": {"recall": d, "precision": e, "auprc": f}}


def test_each_method_states_its_own_measured_performance_in_its_methodsText():
    """TEST-39 — INV-3, at the surface a user actually reads: `methodsText` is the one sentence
    `AnalysisRunPanel` renders and the paragraph carried into the exported methods record.

    BOTH lanes state BOTH methods' numbers. That is deliberate and it is the asymmetry that
    matters: the Scrublet lane is the DEFAULT, so a user who never opens the R analysis is
    the one who most needs to be told there is a measurably better method on the same
    fixture. A lane that stated only its own numbers would make the trade discoverable only
    to the person who had already chosen.

    Delete this and either lane can drop its numbers, or state them for the wrong method, and
    the run panel silently stops disclosing the trade.
    """
    for analysis_id in ("doublet.detect", "doublet.scdblfinder"):
        parsed = _numbers_from_methods_text(analysis_id)
        assert parsed == EXPECTED, (analysis_id, parsed)


#: `scdblfinder = list(recall = 0.964, precision = 0.667, auprc = 0.858)` in the R source.
_R_TRIPLE_RE = re.compile(
    r"(\w+)\s*=\s*list\(\s*recall\s*=\s*([0-9]*\.?[0-9]+)\s*,\s*precision\s*=\s*"
    r"([0-9]*\.?[0-9]+)\s*,\s*auprc\s*=\s*([0-9]*\.?[0-9]+)\s*\)")


def _numbers_from_the_r_source():
    """The `MEASURED_PERFORMANCE` block, parsed out of `compute/scdblfinder.R`."""
    src = _SCDBLFINDER_R.read_text()
    assert "MEASURED_PERFORMANCE <- list(" in src, (
        "`MEASURED_PERFORMANCE` is gone from the R entry; the report's like-for-like "
        "comparison has no source")
    block = src.split("MEASURED_PERFORMANCE <- list(", 1)[1]
    found = {name: {"recall": float(r), "precision": float(p), "auprc": float(a)}
             for name, r, p, a in _R_TRIPLE_RE.findall(block)}
    return {"fixture": _r_string_field(block, "fixture"),
            "note": _r_string_field(block, "note"),
            "numbers": found}


def _r_string_field(block, field):
    """The concatenated `paste0(...)` / plain-string value of one field in an R `list(...)`.

    R spells long prose as `paste0("a ", "b ", "c")`, so the pieces are re-joined here; a
    test that asserted on one fragment would break on any reflow of the source.
    """
    match = re.search(rf"\b{field}\s*=\s*(paste0\()?(.*?)\)?,\n\s*\w+\s*=", block, re.S)
    assert match, f"no `{field}` in MEASURED_PERFORMANCE"
    return "".join(re.findall(r'"((?:[^"\\]|\\.)*)"', match.group(2)))


def _numbers_from_the_ground_truth_suite():
    """Every recorded measurement `tests/test_ground_truth.py` carries, keyed by method.

    Two shapes are read, so this picks up the measurement WHEREVER that file records it:

      * module-level dict constants whose keys are exactly recall/precision/auprc (either
        directly, or nested one level under a method name), matched to a method by the
        constant's own name — this is the form ITEM-6 will land, and it is read by NAME
        rather than re-typed here, exactly as a single source requires; and
      * the banner's *"ACHIEVED here: recall = … precision = … AUPRC = …"* row, which is
        where the shipped Scrublet measurement lives today.

    Anything it does not record is simply absent from the returned mapping — this helper
    reports what that file says, it does not supply what it does not say.
    """
    src = _GROUND_TRUTH.read_text()
    tree = ast.parse(src)
    out = {}

    def triple(node):
        if not isinstance(node, ast.Dict):
            return None
        try:
            keys = [k.value.lower() for k in node.keys]
        except AttributeError:
            return None
        if sorted(keys) != ["auprc", "precision", "recall"]:
            return None
        try:
            values = [float(ast.literal_eval(v)) for v in node.values]
        except Exception:
            return None
        return dict(zip(keys, values))

    def record(name, node):
        got = triple(node)
        low = name.lower()
        if got is not None:
            if "scdbl" in low:
                out["scdblfinder"] = got
            elif "scrublet" in low:
                out["scrublet"] = got
            return
        if isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if isinstance(key, ast.Constant) and isinstance(key.value, str):
                    record(f"{name}.{key.value}", value)

    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name):
                    record(target.id, node.value)

    banner = re.search(
        r"recall\s*=\s*([0-9]*\.[0-9]+)\s+precision\s*=\s*([0-9]*\.[0-9]+)\s+"
        r"AUPRC\s*=\s*([0-9]*\.[0-9]+)", src)
    if banner and "scrublet" not in out:
        out["scrublet"] = {"recall": float(banner.group(1)),
                           "precision": float(banner.group(2)),
                           "auprc": float(banner.group(3))}
    return out


def test_the_measured_numbers_have_exactly_one_source():
    """TEST-40 — THE TEST THAT STOPS A RE-MEASURE MOVING ONE COPY AND NOT THE OTHERS.

    The same three numbers per method are written down in four places, and each of them is
    read by a different audience: the R entry's `MEASURED_PERFORMANCE` (which goes into every
    run's report artifact and from there into the readout), the two `methodsText` blocks
    (the run panel and the exported `methods.md`), and `tests/test_ground_truth.py` (the
    measurement itself). Nothing in the tree makes them one value — a `list()` in R and a
    folded scalar in YAML cannot import from each other — so this parse-and-compare IS the
    single source, and it is the only thing that is.

    Nothing is hardcoded here on purpose. The comparison is source-against-source, so it
    holds after ITEM-6 re-measures and does not have to be edited when the numbers move; it
    only goes red when they move UNEVENLY.

    Delete this and the report can tell a user scDblFinder scored X while the run panel two
    clicks away tells them it scored Y, with neither one wrong on its own terms.
    """
    r_block = _numbers_from_the_r_source()
    sources = {
        "compute/scdblfinder.R::MEASURED_PERFORMANCE": r_block["numbers"],
        "manifest doublet.detect methodsText": _numbers_from_methods_text("doublet.detect"),
        "manifest doublet.scdblfinder methodsText": _numbers_from_methods_text("doublet.scdblfinder"),
        "tests/test_ground_truth.py": _numbers_from_the_ground_truth_suite(),
    }

    # The R block and both narrations must speak about BOTH methods — that is what makes the
    # published comparison a comparison rather than one method's self-report.
    for name in ("compute/scdblfinder.R::MEASURED_PERFORMANCE",
                 "manifest doublet.detect methodsText",
                 "manifest doublet.scdblfinder methodsText"):
        assert set(sources[name]) == {"scdblfinder", "scrublet"}, (name, sorted(sources[name]))

    # Scrublet's measurement is recorded in the ground-truth suite today, so that leg is a
    # real four-way comparison and is asserted as one.
    assert "scrublet" in sources["tests/test_ground_truth.py"], (
        "tests/test_ground_truth.py no longer records the Scrublet measurement; the numbers "
        "narrated to users would then have no measurement behind them at all")

    for method in ("scdblfinder", "scrublet"):
        recorded = {name: numbers[method] for name, numbers in sources.items()
                    if method in numbers}
        assert len(recorded) >= 3, (
            f"only {sorted(recorded)} record {method}'s measurement; there are not enough "
            f"copies left for this test to be comparing anything")
        distinct = {json.dumps({k: round(v, 3) for k, v in triple.items()}, sort_keys=True)
                    for triple in recorded.values()}
        assert len(distinct) == 1, (
            f"{method}'s measured performance disagrees between its recorded copies — a "
            f"re-measure moved one and not the others:\n"
            + "\n".join(f"  {name}: {triple}" for name, triple in sorted(recorded.items())))


# ── (3) + (4) the disclosure that reaches a real run's bytes ────────────────────────────

@pytest.fixture(scope="module")
def scdblfinder_report(tmp_path_factory):
    """ONE real `doublet.scdblfinder` run, shared by every emitted-bytes assertion below.

    Module-scoped because the run is the expensive part (a full scDblFinder fit inside the
    `single-cell-r` image under `bwrap`) and every test here interrogates the SAME artifact.
    Small on purpose: this file asks what the report SAYS, not how well the method scores —
    that is `test_ground_truth.py`'s job on the real fixture.
    """
    require_r_env()
    run = ScdblfinderRun(tmp_path_factory.mktemp("disclosure"))
    run.add_matrix(structured_counts(60, 200, n_groups=3, seed=0))
    proc = run.run({"seed": 0})
    assert proc.returncode == 0, (
        f"the R lane failed, so nothing below is testing an emitted artifact\n"
        f"--- stdout ---\n{proc.stdout}\n--- stderr ---\n{proc.stderr}")
    return run.report()


def test_the_disclosure_block_reaches_the_emitted_bytes(scdblfinder_report):
    """TEST-41 — A `DISCLOSURE` constant in the R source discloses nothing until a run WRITES it.

    This is the model `test_ground_truth.py::
    test_the_homotypic_limitation_is_disclosed_to_users_not_only_to_this_test` set for the
    python lane, applied to the R one: the keys are read out of a report an actual run
    produced, not out of `scdblfinder.R`. Every value is also checked to be substantive
    prose rather than a present-but-empty string, because the readout binds these directly
    (`$data.report.disclosure.homotypic`) and an empty string renders as a blank panel that
    looks like "nothing to disclose".

    Delete this and the honesty collapses back into a source comment nobody outside the repo
    ever sees.
    """
    disclosure = scdblfinder_report["disclosure"]
    assert set(disclosure) == set(DISCLOSURE_KEYS), sorted(disclosure)
    for key in DISCLOSURE_KEYS:
        assert isinstance(disclosure[key], str) and len(disclosure[key]) > 80, (key, disclosure[key])

    # …and each one says the thing it exists to say.
    assert "Homotypic" in disclosure["homotypic"]
    assert "undetectable" in disclosure["homotypic"]
    assert "floor" in disclosure["homotypic"]
    assert "FLAGS for inspection, not removals" in disclosure["not_a_filter"]
    assert "Cell-filter" in disclosure["not_a_filter"]


def test_the_xi_and_li_correction_is_stated_not_quietly_applied(scdblfinder_report):
    """TEST-42 — #233 established that this repository's own research notes MISATTRIBUTED Xi & Li 2021:
    that benchmark compared NINE methods, scDblFinder was NOT among them, and DoubletFinder —
    not scDblFinder — had the best detection accuracy.

    The tempting fix is to delete the citation from the R lane and move on. That would leave
    every reader who remembers the old claim with no way to learn it was wrong, and it would
    leave the door open for the same misreading to be re-introduced as support for the new
    method. So the correction is STATED: the R narration says scDblFinder is not among that
    benchmark's methods, names who actually ranked best, and never claims the benchmark
    ranks scDblFinder first.

    Asserted in BOTH places a user can reach it — the run panel's `methodsText` and the
    emitted report's `method_tradeoff` — because they are separately maintained strings and
    a correction in one is not a correction in the other. Delete this and a future edit can
    re-hang the new method's justification on a benchmark that never evaluated it.
    """
    tradeoff = scdblfinder_report["disclosure"]["method_tradeoff"]
    narration = _methods_text("doublet.scdblfinder")

    for where, text in (("report.disclosure.method_tradeoff", tradeoff),
                        ("doublet.scdblfinder methodsText", narration)):
        assert "Xi & Li" in text, (where, text)
        assert "NOT" in text and "nine methods" in text, (where, text)
        assert "DoubletFinder" in text, (where, text)
        # the claim that must never come back: that this benchmark ranks scDblFinder best
        assert not re.search(r"scDblFinder[^.]{0,80}best", text), (where, text)
        assert not re.search(r"best[^.]{0,80}scDblFinder", text), (where, text)

    # the report's version additionally records that the misattribution was OURS
    assert "misattributed" in tradeoff, tradeoff
    assert "measured_performance" in tradeoff, (
        "the tradeoff disclosure must point at the like-for-like measurement it is telling "
        "the reader to use INSTEAD of the benchmark")


def test_the_report_publishes_a_like_for_like_comparison_or_none_at_all(scdblfinder_report):
    """TEST-43 — E7/DEC-9: two numbers produced under different fixtures are not a comparison, and
    publishing them as one is worse than publishing neither.

    So the emitted `measured_performance` has to carry the three things that make the
    comparison legible: WHICH FIXTURE both numbers came from, BOTH methods' triples (a block
    with only scDblFinder's numbers is a self-report, not a comparison), and the two LIMITS
    that cap both callers from above and belong to the benchmark rather than to either
    method — roughly 2% of pbmc3k's real cells are native doublets the truth vector labels
    `singlet`, and homotypic doublets are undetectable by any simulation-based caller.

    The note is what stops a reader treating 0.858 as an absolute statement about the method.
    Delete this and the report can ship a bare pair of numbers with no fixture, no ceiling
    and no way to tell whether they were measured the same way.
    """
    block = scdblfinder_report["measured_performance"]

    fixture = block["fixture"]
    assert "pbmc3k" in fixture, fixture
    assert "heterotypic" in fixture, fixture
    assert "seed" in fixture, fixture

    assert set(block) >= {"fixture", "note", "scdblfinder", "scrublet"}, sorted(block)
    for method in ("scdblfinder", "scrublet"):
        triple = block[method]
        assert set(triple) == {"recall", "precision", "auprc"}, (method, sorted(triple))
        for metric, value in triple.items():
            assert isinstance(value, (int, float)), (method, metric, value)
            assert 0.0 < float(value) <= 1.0, (
                f"{method}.{metric} is {value} in the EMITTED report — a metric outside "
                f"(0, 1] is a placeholder that was never filled in with the measurement")

    note = " ".join(block["note"].split())
    assert "2% NATIVE" in note or "2% native" in note, note
    assert "singlet" in note, note
    assert "homotypic doublets are undetectable" in note, note
    assert "BOTH" in note, note                       # the limits cap both methods, not one
    assert "identical" in note, note                  # …and the constructions really match


def test_the_library_versions_are_in_the_emitted_bytes(scdblfinder_report):
    """TEST-44 — The R analysis declares NO `run.dependencies` (ITEM-10), so the versions in this
    artifact are the WHOLE traceability record for any number this method publishes.

    That is not an oversight and it is not recoverable elsewhere: `every_dependency_declaring_
    entry_reaches_the_recorder` requires a dependency-declaring entry to reach a `cyto_deps.*`
    call in its own entry or a declared helper, with no language exemption, and `cyto_deps.py`
    is a python helper `stages_app_helpers(Rscript)` never stages. So a declared contract here
    would claim an enforcement that does not exist. What replaces it is recording the RESOLVED
    version by value, in the artifact — and a value nobody checks is a value that can quietly
    become `"unknown"`.

    Every version is therefore asserted to be a real, non-empty, digit-leading version string
    from a REAL RUN, and the absence of the dependency declaration is asserted alongside it so
    that the two facts can never drift apart. Delete this and a published scDblFinder score
    becomes untraceable to the code that produced it.
    """
    versions = scdblfinder_report["library_versions"]
    assert set(versions) == set(R_LIBRARIES), sorted(versions)
    for library, version in versions.items():
        assert isinstance(version, str), (library, version)
        assert version.strip(), f"{library} has an empty resolved version"
        assert version.lower() not in {"unknown", "none", "na", "null"}, (library, version)
        assert re.match(r"^\d+(\.\d+)+", version), (
            f"{library}'s recorded version {version!r} is not a version string")

    # the reason this record is load-bearing, pinned beside it
    run_block = _analysis("doublet.scdblfinder")["run"]
    assert "dependencies" not in run_block, (
        "the R analysis now declares `run.dependencies`. Either the platform gained a way to "
        "enforce it for an rscript entry — in which case this test's premise changed and the "
        "reasoning above must be revisited — or the declaration claims an enforcement that "
        "does not exist.")
