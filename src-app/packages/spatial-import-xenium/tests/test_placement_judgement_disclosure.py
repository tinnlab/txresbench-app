#!/usr/bin/env python3
# ruff: noqa
"""#301 — THE DEFERRAL TARGET NOW EXISTS FOR THIS PRODUCER, and the code says so.

## What this file used to assert, and why it is inverted rather than deleted

#291 wrote this file to close a defect: #247 removed `coverage_against`'s invented
`_SCALE_HINT_MAX = 5.0` and, in three places, handed the placement judgement to *"#156's
registration QC overlay"* — a control that, for THIS producer, did not exist.
`compute/registration_qc.py` lived in `spatial-import-visium` and in no other package, #156
was CLOSED, and so nothing was arriving. On the Xenium path the deferral target was not
there, which made #247's DEC-5 residue (*"a uniform scale error — a 1000x pair — satisfies
both remaining booleans and is now caught by nothing"*) UNQUALIFIED rather than temporary.

So this file asserted the claim's SUBJECT: that no registration QC existed for this package,
three ways, with the identical detector run against `spatial-import-visium` as a positive
control. Its own words, kept verbatim because they are the reason it is inverted and not
removed:

    The day someone builds one, this file goes RED and names every prose site to update —
    the disclosure invalidates itself instead of quietly becoming false.

**#301 is that day.** `spatial-import-xenium/compute/registration_qc.py` is this package's
own, staged in `run.helpers`, and every run that emits a morphology image emits a rendered
overlay beside it as a `report/qc` artifact. Every assertion below is the #291 assertion with
its sign flipped, on the SAME detector: the module is present, all five of Visium's overlay
entry points are defined in it, the manifest stages it, the artifact is emitted, and every
prose site that told a reader Xenium placement is judged by nothing now says what judges it.

Deleting the file would have been the non-repair. A self-invalidating disclosure earns its
keep exactly once — at the moment it fires — and what it buys is the enumerated list of
prose sites that go stale together. Throwing that list away at the moment it becomes
actionable is how the sites go stale one at a time instead.

## The detector is UNCHANGED, and that is deliberate

`_probe_package`, `_QC_FILENAME`, `_OVERLAY_ENTRY_POINTS` and `_defined_names` are byte-for-byte
the mechanism #291 shipped, with the four evasions its audit found still closed: a recursive
glob (an overlay hidden in `compute/qc/`), an `ast` parse rather than a text match (a class
whose methods carry the names; an `async def`; a `def render_overlay(...)` inside a
DOCSTRING, which a raw-text probe reported as real code), and a module-name pattern wider
than the literal basename.

**Its one irreducible limit was that an overlay built under a wholly unanticipated name could
pass it.** That limit is not closed by this branch — a probe of this kind cannot close it —
but it is no longer LOAD-BEARING in the direction that mattered: #291 needed the detector to
prove an ABSENCE, where an unanticipated name meant a false negative and a disclosure that
had quietly become false. The claim here is a PRESENCE, and a presence is proved by the thing
itself. #301 deliberately built under the anticipated name — `compute/registration_qc.py`
defining `registration_qc`, `check_registration`, `render_overlay`, `score_registration` and
`registration_verdict`, exactly the sibling's file name and exactly its five module-level
entry points (DEC-9) — so the detector keys on what was actually built rather than on a guess.

What the detector still CANNOT do, stated because the inversion makes it easier to overclaim:
it proves an overlay of the expected SHAPE is present and staged, not that it MEASURES
anything. A file with those five names and empty bodies would satisfy every assertion in this
test. `tests/test_registration_qc.py` is what closes that — it mutates the placement on a real
vendor bundle and requires the verdict to flip — and the prose in `boundaries.py` and
`manifest.yaml` is worded to that split.

## And the residue this branch could not reach (#302)

`spatial-types/compute/`'s shared modules carry prose written when no overlay existed for this
producer, and they are vendored BYTE-IDENTICALLY into all three spatial packages — so
correcting them there forces a matching edit inside `spatial-import-visium`, which a
concurrent branch owns. That is #302, and it is NAMED at the corrected sites here rather than
left as a stale claim with no pointer, which is the same discipline #291 applied to the gap
this branch closes.
"""
import ast
import json
import re
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

_PACKAGES = XF.PKG.parent
_XENIUM = _PACKAGES / "spatial-import-xenium"
_VISIUM = _PACKAGES / "spatial-import-visium"

#: The five module-level entry points `spatial-import-visium/compute/registration_qc.py`
#: defines. A registration QC built for this producer is a sibling of that file, so these are
#: what a real one looks like from the outside — and #301 built under exactly them (DEC-9),
#: which is what lets this probe key on the thing rather than on a guess about naming.
_OVERLAY_ENTRY_POINTS = ("registration_qc", "check_registration", "render_overlay",
                         "score_registration", "registration_verdict")

#: A module FILE that is a registration QC. Deliberately looser than the exact basename so a
#: `registration-qc.py` / `qc_registration.py` spelling is caught too, and widened past the
#: literal words after an audit built a working overlay as `placement_overlay.py` and walked
#: straight past a name-only probe. Still a FILE NAME match, not a free-text search: a name
#: is a bounded thing, and trying to recognise registration QC from prose is not.
_QC_FILENAME = re.compile(
    r"registration[_-]?qc|qc[_-]?registration|registration[_-]?overlay"
    r"|placement[_-]?(qc|overlay|check)|overlay[_-]?(qc|placement)",
    re.IGNORECASE)

#: The DEFINITIONS a module actually contains — parsed, not pattern-matched.
#:
#: Two audits pushed this here. The first defeated an `^def ` anchor with a class whose methods
#: carry the canonical names, and again with `async def`. Widening the regex to
#: `^\s*(async\s+)?def ` closed those and opened a worse one: a raw-text match cannot tell code
#: from a code SAMPLE, and the second audit put an indented `def render_overlay(...)` inside a
#: docstring and made the detector report a registration QC that does not exist. In a package
#: whose prose routinely quotes these exact symbol names — including this file's own — that is
#: a live hazard, not a hypothetical.
#:
#: `ast` answers the question the probe is actually asking: is there a real function here?
#: Nested and method definitions count (a class-based overlay is still an overlay); text inside
#: a string does not, because it is a string.
def _defined_names(text):
    try:
        tree = ast.parse(text)
    except SyntaxError:
        # A module this suite cannot parse is not a module this package ships; a probe that
        # raises here would fail for a reason unrelated to what it is asserting.
        return set()
    return {node.name for node in ast.walk(tree)
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))}

#: The sites that used to point a reader at a judge which, for this producer, was not there —
#: each with the PHRASES the #301 correction must actually contain.
#:
#: THE SHAPE OF THIS TABLE IS #291'S AND IS KEPT ON PURPOSE. Its first cut asserted only
#: `"#291" in text`, per file; a blind audit reverted a whole corrected block to its bare
#: wording, left one stray `#291` elsewhere in the same 2300-line file, and the test stayed
#: green — a file-level substring check proves the string was typed once, not that the
#: correction reached the site. So each entry carries the substantive phrases and every one of
#: them has to be present. The entries are the #291 phrases replaced by their #301 successors,
#: site for site, so a REVERSION in either direction is caught: the new phrase is required,
#: and (below) the old absence-claim is required to be gone.
#:
#: An ENUMERATED list, not a pattern. A sixth site added later is a new row here rather than
#: something a regex was supposed to have caught — the honest shape for a check whose subject
#: is prose.
#:
#: EVERY PHRASE SITS INSIDE ONE STRING LITERAL OR ONE PARAGRAPH. The check flattens whitespace
#: (so a reflow is not a reversion) but it cannot see across the `" "` of an adjacent-literal
#: concatenation, so a phrase chosen to straddle one would be unsatisfiable no matter what the
#: file said.
_DISCLOSURE_SITES = (
    ("compute/boundaries.py", "the coverage note and both public docstrings",
     ("#301", "NOW EXISTS FOR THIS PRODUCER",
      "IT DOES NOT SETTLE THE SHAPE",
      "THE CONTROL THAT DECIDES IT IS BUILT FOR THIS ",
      "spatial-import-visium", "#302")),
    ("compute/import_xenium.py",
     "the boundaries-note renderer, the two emitted image warnings, the module docstring, "
     "`PLACEMENT_JUDGEMENT` and `scale_referent.compensating_control`",
     ("#301", "#291",
      # the module docstring's standing claim
      "AND IT NOW EXISTS FOR THIS PRODUCER (#301)",
      # the stated-scale disagreement warning a user reads
      "AND THE CONTROL THAT DECIDES IT IS NOW ",
      # the unreadable-unit warning, which used to end at "weaker than the check"
      "What did NOT stop running is",
      # the image coverage warning, which used to send the reader to an absent artifact
      "READ THE REGISTRATION OVERLAY BEFORE READING ANYTHING OFF THIS IMAGE",
      # the boundaries-note renderer
      "something downstream now DOES rule on placement",
      # the structured disclosure blocks, and the HTML that renders one of them
      "PLACEMENT_JUDGEMENT", "still_not_decided",
      "What checks this import's placement",
      "#302")),
    ("manifest.yaml", "the standing 'NO registration overlay' paragraph",
     ("#301", "THE REGISTRATION OVERLAY IS NOW HERE", "spatial-import-visium",
      "WHAT IT STILL DOES NOT DECIDE", "#302")),
    ("tests/test_boundaries_ragged_edges.py", "#247's two acceptance-test rationales",
     ("#301", "THE OVERLAY NOW EXISTS", "QUALIFIED IT AGAIN")),
    ("tests/test_boundaries_declarations.py", "the emitted-coverage test's rationale",
     ("#301", "the overlay now judges THIS producer's placement")),
    ("tests/test_scale_referent.py", "the assertions that pinned the absent-control wording",
     ("#301", '"IS NOW BUILT" in note', "READ THE REGISTRATION OVERLAY")),
)

#: THE OTHER HALF OF EACH SITE: the #291 absence-claim that must be GONE.
#:
#: Requiring the new phrase is not enough on its own — a file can carry the correction AND the
#: sentence it corrects, which is worse than either alone (a reader meets both and believes
#: the one they read first). #291's own audit found exactly this failure mode in the other
#: direction, where a reverted block coexisted with a stray issue reference.
#:
#: Scoped to phrases that are UNAMBIGUOUSLY the old claim rather than any mention of it: this
#: package's prose quotes its own history constantly and must stay free to (the corrections
#: above all do). So each entry is a full assertive sentence fragment, never a bare token.
_RETIRED_CLAIMS = (
    ("compute/boundaries.py", "Xenium boundary placement is judged by nothing today"),
    ("compute/import_xenium.py", "THE CONTROL THAT WOULD DECIDE THIS IS NOT "),
    ("compute/import_xenium.py", "TREAT THIS IMAGE'S PLACEMENT AS UNCHECKED"),
    ("compute/import_xenium.py", '"status": "NOT PRODUCED by this importer"'),
    ("manifest.yaml", "* NO registration overlay, and NOTHING IS COMING"),
    # AND THE OVERSTATEMENT THIS BRANCH'S OWN CORRECTION INTRODUCED, retired in round 2. The
    # first cut of the corrected block claimed the overlay is "emitted as a `report/qc`
    # artifact of this run" — a per-RUN claim in a block that is asserted IDENTICAL across
    # runs, and false on the one bundle a reader most needs it: when every cell maps outside
    # the frame the picture would carry no marks and is withheld, so the same report said both
    # that sentence and "no overlay was rendered". A blind design-conformance angle reproduced
    # it. Retiring an absence claim and replacing it with an overstatement is the same defect
    # with the sign flipped, which is what this whole table exists to keep from happening.
    ("compute/import_xenium.py", "artifact of this run\"),"),
)

_UPDATE_THESE = "\n".join(f"      - {path}  ({what})" for path, what, _ in _DISCLOSURE_SITES)


@pytest.fixture(scope="module")
def BD():
    return XF.load_boundaries_module()


def BD_reportable(module, boundaries_block):
    """`coverage_is_reportable` as the PRODUCER answers it, through the entry's own import."""
    return module.BD.coverage_is_reportable(
        boundaries_block.get("coverage") or {},
        entities_without_boundary=boundaries_block.get("n_entities_without_boundary"))


def _probe_package(pkg):
    """The detector, run against ONE package root. Three independent probes.

    Returns `(modules, symbols, manifest_hits)`. Every probe is a positive-or-empty answer
    about the package's own tree, so the SAME function answers "visium has one" and "xenium
    has one" — which is what made the negative meaningful under #291 and what makes the two
    positives comparable now.
    """
    compute = pkg / "compute"
    # `rglob`, not `glob`: the first cut looked only at the top level, and an audit hid a
    # working overlay in `compute/qc/` in one move. Paths are reported relative to `compute`
    # so a nested hit is legible in the failure message.
    modules = sorted(str(f.relative_to(compute)) for f in compute.rglob("*.py")
                     if _QC_FILENAME.search(f.name))

    symbols = []
    for path in sorted(compute.rglob("*.py")):
        defined = _defined_names(path.read_text(encoding="utf-8"))
        for name in _OVERLAY_ENTRY_POINTS:
            if name in defined:
                symbols.append(f"{path.relative_to(compute)}::{name}")

    doc = yaml.safe_load((pkg / "manifest.yaml").read_text()) or {}
    manifest_hits = []
    for analysis in (doc.get("contributes") or {}).get("analyses") or []:
        for helper in ((analysis.get("run") or {}).get("helpers") or []):
            if _QC_FILENAME.search(str(helper)):
                manifest_hits.append(f"run.helpers: {helper}")
        for produced in (analysis.get("produces") or []):
            if _QC_FILENAME.search(str(produced)):
                manifest_hits.append(f"produces: {produced}")
    return modules, sorted(symbols), sorted(manifest_hits)


def test_a_registration_QC_EXISTS_for_this_package_on_the_same_detector_that_proved_it_did_not():
    """TEST-14 [acceptance] [invariant: INV-2] [covers: ITEM-7] (#301).

    §7.5, verbatim: *"Nothing in the conformance gate can check an affine (§12.2). The
    compensating control is a **rendered overlay in the `report/qc`** ... **This is a required
    output of the importer, not a nice-to-have** — it is the entire verification story for
    step 7.3."*

    THIS IS #291'S TEST, INVERTED. It asserted, three ways, that this importer did not produce
    §7.5's required output, and every claim that branch made about placement rested on it
    being true. #301 built the overlay, so the same three probes must now find it — and the
    same `spatial-import-visium` positive control is kept, because a detector that has stopped
    detecting would satisfy an absence claim and a presence claim equally by simply looking at
    nothing.

    The expected symbol set is spelled out LITERALLY on both sides rather than derived from
    `_OVERLAY_ENTRY_POINTS`, for the reason #291 recorded: comparing the probe against itself
    is how an audit shrank the tuple to one name and left the control passing with a probe five
    times weaker.

    ## WHAT THIS PROVES AND WHAT IT DOES NOT

    It proves an overlay of the expected SHAPE is present, defines the sibling's five entry
    points, and is staged where the sandbox will find it. It does NOT prove the overlay
    MEASURES anything — five empty functions would pass every line below.
    `tests/test_registration_qc.py` is what closes that: it mutates a real vendor bundle's
    placement and requires the verdict to flip. The split is deliberate and every claim in
    this package that rests on this file is worded to it.
    """
    # (a) THE CONTROL, FIRST. If this fails, the claim below means nothing.
    v_modules, v_symbols, v_manifest = _probe_package(_VISIUM)
    assert v_modules == ["registration_qc.py"], (
        "the positive control failed: `spatial-import-visium/compute/registration_qc.py` is "
        f"where #156's overlay lives, and the module probe found {v_modules}. Until this "
        "passes, the xenium assertions below are vacuous rather than green."
    )
    v_from_qc = {sym for sym in v_symbols if sym.startswith("registration_qc.py::")}
    assert v_from_qc == {
        "registration_qc.py::registration_qc",
        "registration_qc.py::check_registration",
        "registration_qc.py::render_overlay",
        "registration_qc.py::score_registration",
        "registration_qc.py::registration_verdict",
    }, (
        f"the positive control failed: the symbol probe found {sorted(v_from_qc)} in "
        "`spatial-import-visium/compute/registration_qc.py`. It must find EXACTLY #156's "
        "five overlay entry points there — fewer means the probe (or "
        "`_OVERLAY_ENTRY_POINTS`) has been narrowed and its answer for xenium proves less "
        "than it claims. Symbols found elsewhere in that package are NOT compared, "
        f"deliberately: {sorted(set(v_symbols) - v_from_qc)}."
    )
    assert v_manifest, (
        "the positive control failed: `spatial-import-visium/manifest.yaml` stages "
        "`compute/registration_qc.py` in `run.helpers`, and the manifest probe found nothing "
        "— it can no longer see a staged overlay in a manifest that has one."
    )

    # (b) AND NOW THE CLAIM. Same function, same three probes, the other package.
    x_modules, x_symbols, x_manifest = _probe_package(_XENIUM)
    found = {"compute modules": x_modules, "compute symbols": x_symbols,
             "manifest entries": x_manifest}
    assert all(found.values()), (
        "THE REGISTRATION QC FOR `spatial-import-xenium` HAS GONE MISSING on at least one "
        f"probe:\n      {found}\n"
        "    Design §7.5 calls this overlay a REQUIRED output of the importer, #301 built it "
        "for this producer, and this package's prose — in `compute/boundaries.py`, in "
        "`compute/import_xenium.py`, in `manifest.yaml` — now tells a reader that their "
        "placement is checked by it. Removing it makes all of that false at once, so restore "
        "it rather than relaxing this test; if it is genuinely being withdrawn, every site "
        "below has to go back to disclosing an absence:\n"
        f"{_UPDATE_THESE}\n"
        "    (This assertion is #291's, inverted. It fired once, correctly, on the day the "
        "overlay was built; it is kept pointing the other way so the same list of sites "
        "cannot go stale one at a time.)"
    )
    assert x_modules == ["registration_qc.py"], (
        f"the module probe found {x_modules}. #301 built this producer's overlay under the "
        "sibling's own file name deliberately (DEC-9), so that this detector keys on what was "
        "actually built rather than on a guess about naming — which is the one evasion #291 "
        "recorded as unclosable. A rename here re-opens it."
    )
    x_from_qc = {sym for sym in x_symbols if sym.startswith("registration_qc.py::")}
    assert x_from_qc == {
        "registration_qc.py::registration_qc",
        "registration_qc.py::check_registration",
        "registration_qc.py::render_overlay",
        "registration_qc.py::score_registration",
        "registration_qc.py::registration_verdict",
    }, (
        f"the symbol probe found {sorted(x_from_qc)} in "
        "`spatial-import-xenium/compute/registration_qc.py`. All five of the sibling's entry "
        "points must be here: the shape is what makes the two producers' overlays "
        "recognisable as the same kind of thing, and it is what this detector is keyed to."
    )
    assert x_manifest == ["run.helpers: compute/registration_qc.py"], (
        f"the manifest probe found {x_manifest}. The overlay module must be STAGED — the "
        "entry imports it by bare name and `/code` is flat, so an unstaged helper is an "
        "ImportError inside a user's sandbox with no build-time signal at all."
    )


def test_the_benign_note_and_both_docstrings_NAME_the_judge_that_now_exists(BD):
    """TEST-15 [acceptance] [invariant: INV-1] [covers: ITEM-8] (#301).

    #291's TEST-2, inverted. It asserted the artifact did not pretend a control existed; this
    asserts it does not pretend one is still missing. Both directions are the same rule: the
    note names the control's real STATUS in the same breath as the control.

    THE NOTE IS THE PRODUCER'S, not a comment: it is the string `write_boundaries` puts in
    `meta["boundary_coverage"]["note"]` on the `spatial-boundaries` artifact, which the report
    then carries verbatim. It has carried three wordings — #247's deferral to a control that
    would pick this up, #291's disclosure that for this producer it was not built, and this
    one — and each was true when written.

    CREDIT WHERE IT IS DUE, because a blind audit caught #291's version of this docstring
    claiming more than the code below does. This test calls `coverage_against` DIRECTLY; it
    does not run an import, so it cannot see the note being severed from the artifact on its
    way out. TEST-16 below closes that: it drives a REAL import and reads the statement back
    out of the emitted report. This test owns the CONTENT of the producer's note; TEST-16 owns
    its journey to the artifact.

    Four facts are required, because any three of them is a half-truth: the control is named;
    it IS built for this importer; the reader is told where to read it; and what it still does
    NOT settle is stated. Drop the last and "judged by nothing" has simply been replaced by
    "judged, fully", which is the same overstatement with the sign flipped.
    """
    def bbox(t):
        return {"x_min": t[0], "x_max": t[1], "y_min": t[2], "y_max": t[3]}

    note = BD.coverage_against(bbox((-1, 11, -1, 11)), bbox((0, 10, 0, 10)))["note"]
    lowered = note.lower()

    # 1. THE CONTROL IS NAMED AND ITS STATUS IS STATED IN THE SAME BREATH.
    assert "registration qc overlay" in lowered, (
        f"the note no longer names the control §7.5 requires: {note}"
    )
    assert "is built for this importer" in lowered, (
        "the note names §7.5's overlay without saying it IS built for this importer — which "
        f"is the state #301 created and #291's wording denied: {note}"
    )
    assert "not built" not in lowered, (
        "the note has gone back to #291's disclosure that the control does not exist here, "
        f"which #301 made false: {note}"
    )
    # 2. WHERE TO READ IT, so the statement is actionable rather than reassuring.
    assert "report/qc" in lowered and "read it" in lowered, (
        "the note says a control exists without telling the reader where to find it, which "
        f"is a reassurance rather than a pointer: {note}"
    )
    # 3. AND WHAT IT STILL DOES NOT DECIDE. A status with no limit attached is the same
    #    defect as #291's status with no consequence attached, in the other direction.
    assert "does not decide" in lowered, (
        f"the note states the control exists without stating what it still cannot settle: {note}"
    )
    assert "shape" in lowered, (
        "the overlay draws cell centres, not polygon outlines, so a boundary set correctly "
        "SCALED and wrongly SHAPED is still ruled on by nothing — the note must say so: "
        f"{note}"
    )
    # 4. AND THE WORK ITEM, so the reader can check the claim.
    assert "#301" in note, f"the note does not point at the work item that built it: {note}"

    # 5. THE SAME FACTS IN BOTH PUBLIC DOCSTRINGS. `coverage_against` is where a maintainer
    #    goes for the rationale and `coverage_is_reportable` is where the "the JUDGEMENT is
    #    #156's" sentence lived; correcting one and leaving the other is how the next reader
    #    finds the stale one.
    for fn in (BD.coverage_against, BD.coverage_is_reportable):
        doc = (fn.__doc__ or "").lower()
        assert "#301" in doc, (
            f"{fn.__name__}'s docstring does not point at the work item that built the "
            "overlay for this producer, so a reader who disbelieves it has nowhere to go"
        )
        assert "#291" in doc, (
            f"{fn.__name__}'s docstring has dropped the position it is correcting; a "
            "correction with no record of what it corrected reads as though the earlier text "
            "was never there"
        )
        assert "registration qc" in doc or "registration overlay" in doc, (
            f"{fn.__name__}'s docstring no longer names the control at all"
        )
        assert not ("has no registration qc" in doc or "emits none" in doc), (
            f"{fn.__name__}'s docstring still says this package has no registration QC"
        )


def test_the_disclosure_reinstated_NO_producer_side_ruling(BD):
    """TEST-3 [acceptance] [invariant: INV-2] [covers: ITEM-8] (#291, re-armed by #301).

    §7.3, verbatim: *"Getting the affine wrong does not error; it draws spots in the wrong
    place ... So the design rule is: **declare the space, never the scale factor alone.**"*

    #291's guard, kept and re-pointed at the NEW text. Its original reason was that a branch
    complaining "nothing judges this" could most easily fail by quietly judging it. #301's
    version of the same hazard is sharper, not weaker: now that a downstream judge exists,
    "something else checks it anyway" is the most natural argument for folding a hint back
    into `coverage_against` — and #247 removed exactly such a hint. So the key set and #247's
    five banned tokens are re-asserted against the rewritten note.

    ## WHAT THIS PROVES, AND WHAT IT DOES NOT

    It proves the correction did not change the SHAPE of the answer: the key set is still the
    six facts, and the banned tokens are still absent from every branch's note. The
    ratio-INDEPENDENCE leg is the one with real teeth, and a blind audit showed why it needed
    widening: it exercised only the benign branch, so a sentence keyed to a number in the
    not-overlaps or not-contained branch was never reached. Both are now swept across four
    decades of ratio, holding the FACTS fixed — if any branch's prose starts varying with the
    measurement, that is a band wearing a paragraph's clothes and it goes red here.

    It does NOT prove "no ruling in prose". The banned list is five literal tokens, and the
    same audit slipped an explicit verdict past it by writing `5.0` instead of `5x`. A general
    ban on judgement expressed in English is not something an assertion can carry.
    """
    def bbox(t):
        return {"x_min": t[0], "x_max": t[1], "y_min": t[2], "y_max": t[3]}

    facts = {"vertex_bbox", "centroid_bbox", "overlaps", "centroids_contained",
             "extent_ratios", "note"}
    banned = ("5x", "consistent", "verdict", "tolerance", "band")

    # EVERY BRANCH, not only the one #301 rewrote — a correction that pushed a ruling into a
    # neighbouring note would otherwise pass.
    cases = {
        "benign": ((-1, 11, -1, 11), (0, 10, 0, 10), 0),
        "1000x-scale": ((0, 10000, 0, 10000), (0, 10, 0, 10), 0),
        "no-overlap": ((11, 20, 0, 10), (0, 10, 0, 10), 0),
        "not-contained": ((-10, 0, -10, 0), (0, 10, 0, 10), 0),
        "degenerate": ((5, 5, 5, 5), (5, 5, 5, 5), 0),
        "partial": ((0, 10, 0, 10), (0, 100, 0, 100), 7),
    }
    for name, (vertex, centroid, without) in cases.items():
        got = BD.coverage_against(bbox(vertex), bbox(centroid),
                                  entities_without_boundary=without)
        assert set(got) == facts, (
            f"{name}: the coverage block carries {sorted(got)} — the correction has brought a "
            "producer-side placement key back into the artifact (#247)"
        )
        for word in banned:
            assert word not in got["note"].lower(), (
                f"{name}: the note rules where the key set does not ({word!r}): {got['note']}"
            )

    # AND THE TEXT IS A CONSTANT, NOT A FUNCTION OF THE RATIO. If it ever varied with the
    # measurement it would be a band wearing a paragraph's clothes.
    centroid = bbox((0, 10, 0, 10))
    probes = {
        "1.0001x": bbox((-0.0005, 10.0005, -0.0005, 10.0005)),
        "1.2x": bbox((-1, 11, -1, 11)),
        "5.5x": bbox((-22.5, 32.5, -22.5, 32.5)),
        "1000x": bbox((0, 10000, 0, 10000)),
        "1e6x": bbox((0, 10 ** 7, 0, 10 ** 7)),
        "1e9x": bbox((0, 10 ** 10, 0, 10 ** 10)),
    }
    notes = {n: BD.coverage_against(b, centroid)["note"] for n, b in probes.items()}
    assert len(set(notes.values())) == 1, (
        "pairs from 1.0001x to 1e9x are no longer described identically, so the text is "
        f"judging the ratio: {notes}"
    )
    # The raw ratio is still the only thing that separates them — #247's honest limit, which
    # #301 narrows via a SEPARATE module rather than removes from here.
    assert BD.coverage_against(probes["1000x"], centroid)["extent_ratios"] == [1000.0, 1000.0]

    # THE SAME SWEEP OVER THE TWO LOUD BRANCHES, which the first cut left unswept — so a
    # sentence keyed to the measurement could have been added to either and nothing here
    # would have reached it. The FACTS are held fixed in each sweep (still disjoint; still
    # overlapping-but-not-containing), and only the magnitude moves.
    disjoint = {
        "1x-apart": (bbox((11, 21, 0, 10)), bbox((0, 10, 0, 10))),
        "10x-apart": (bbox((110, 210, 0, 10)), bbox((0, 10, 0, 10))),
        "1000x-apart": (bbox((11000, 21000, 0, 10)), bbox((0, 10, 0, 10))),
        "1e5x-apart": (bbox((11 * 10 ** 5, 21 * 10 ** 5, 0, 10)), bbox((0, 10, 0, 10))),
    }
    got = {n: BD.coverage_against(v, c) for n, (v, c) in disjoint.items()}
    assert all(o["overlaps"] is False for o in got.values()), (
        f"the disjoint sweep stopped being disjoint, so it controls nothing: "
        f"{ {n: o['overlaps'] for n, o in got.items()} }"
    )
    assert len({o["note"] for o in got.values()}) == 1, (
        "wholly disjoint pairs 1x to 1e5x apart are no longer described identically — the "
        f"NON-OVERLAP note is judging the magnitude: { {n: o['note'] for n, o in got.items()} }"
    )
    flipped = {
        "flip-1x": (bbox((-10, 0, -10, 0)), bbox((0, 10, 0, 10))),
        "flip-100x": (bbox((-1000, 0, -1000, 0)), bbox((0, 10, 0, 10))),
        "flip-1e4x": (bbox((-10 ** 5, 0, -10 ** 5, 0)), bbox((0, 10, 0, 10))),
    }
    got = {n: BD.coverage_against(v, c) for n, (v, c) in flipped.items()}
    assert all(o["overlaps"] is True and o["centroids_contained"] is False
               for o in got.values()), (
        "the y-flip sweep stopped being overlapping-but-not-containing, so it controls "
        f"nothing: { {n: (o['overlaps'], o['centroids_contained']) for n, o in got.items()} }"
    )
    assert len({o["note"] for o in got.values()}) == 1, (
        "containment failures 1x to 1e4x apart are no longer described identically — the "
        f"NOT-CONTAINED note is judging the magnitude: "
        f"{ {n: o['note'] for n, o in got.items()} }"
    )


def test_every_site_that_pointed_at_an_absent_judge_now_names_the_one_that_exists():
    """TEST-15 [covers: ITEM-8] (#301).

    #291's TEST-4, inverted. The correction is only worth anything if it reached EVERY site.
    Six files carried the absence claim — three places in `compute/boundaries.py`, five in
    `compute/import_xenium.py`, this package's manifest paragraph, and three test docstrings a
    reader goes to for the rationale. This is an ENUMERATED list, not a pattern search: each
    entry is a file this branch corrected, so the check is bounded and a seventh site added
    later is a new entry here rather than something a regex was supposed to have caught.

    TWO DIRECTIONS, because either alone is defeatable. The new phrase must be PRESENT (a file
    that lost it has had a correction reverted, and `"#301" in text` alone would not notice —
    one stray mention anywhere in a 2500-line file satisfies it, which a blind audit
    demonstrated against the #291 version of this check). And the old absence-claim must be
    GONE (a file carrying both is worse than a file carrying either, because a reader believes
    whichever they meet first).

    Also pinned: the manifest VERSION moved. `check-processor-seed-versions` requires it — an
    already-provisioned deployment skips re-extraction at an unchanged version, so a corrected
    `compute/` tree shipped at 0.9.2 would not reach a user at all.
    """
    # WHITESPACE-NORMALISED. A phrase that straddles a line wrap made a pure REFLOW — same
    # words, same meaning — read as a reverted correction; an audit demonstrated it. The
    # check is about what the site SAYS, and a wrap position is not part of that.
    def _flat(text):
        return " ".join(text.split())

    for rel, what, required in _DISCLOSURE_SITES:
        text = _flat((_XENIUM / rel).read_text(encoding="utf-8"))
        missing = [phrase for phrase in required if _flat(phrase) not in text]
        assert not missing, (
            f"{rel} ({what}) is missing {missing!r}. Each of these is a phrase the #301 "
            "correction put at that site, replacing text that told a reader Xenium placement "
            "is judged by nothing. A file that has lost one of them has had a correction "
            "reverted."
        )

    for rel, retired in _RETIRED_CLAIMS:
        text = _flat((_XENIUM / rel).read_text(encoding="utf-8"))
        assert _flat(retired) not in text, (
            f"{rel} still carries the #291 absence claim {retired!r}, which #301 made false. "
            "A file that carries both the correction and the sentence it corrects is worse "
            "than one that carries either: a reader believes whichever they meet first."
        )

    # THE MANIFEST PARAGRAPH IS ASSERTED BY WHAT IT CLAIMS, not by the absence of the old
    # wording alone. It used to say "NO registration overlay, and NOTHING IS COMING" — true
    # when written — and the paragraph that replaces it has to make the positive claim AND
    # keep the limit, or "nothing is coming" has been swapped for "everything is fine".
    manifest_text = (_XENIUM / "manifest.yaml").read_text(encoding="utf-8")
    lines = manifest_text.splitlines()  # the paragraph check below wants the block structure
    start = next(i for i, line in enumerate(lines)
                 if line.startswith("# * THE REGISTRATION OVERLAY IS NOW HERE"))
    end = next(i for i in range(start + 1, len(lines))
               if not lines[i].startswith("#   "))
    overlay_paragraph = "\n".join(lines[start:end]).lower()
    assert "registration_qc.py" in overlay_paragraph, (
        "the manifest's registration-overlay paragraph does not name the module that now "
        "exists, so a reader cannot check the claim"
    )
    assert "spatial-import-visium" in overlay_paragraph, (
        "the manifest paragraph says the overlay exists here without saying where the "
        "sibling's went — the two are different checks answering the same design section, "
        "and a reader who finds the other one needs to know that"
    )
    assert "what it still does not decide" in overlay_paragraph, (
        "the paragraph claims the control exists without stating its limit, which is the "
        "same overstatement as #291's 'judged by nothing' with the sign flipped"
    )
    assert "#302" in overlay_paragraph, (
        "the paragraph does not name the residue this branch could not reach — the same "
        "prose, still stale in the shared modules this package vendors"
    )

    doc = yaml.safe_load(manifest_text)
    version = tuple(int(part) for part in str(doc["version"]).split("."))
    assert version > (0, 9, 2), (
        f"spatial-import-xenium is at {doc['version']}; `origin/main` ships 0.9.2. This "
        "branch changes files under `compute/`, and an already-provisioned deployment skips "
        "re-extraction at an unchanged version — so without a bump the overlay does not ship "
        "and `check-processor-seed-versions` refuses the merge."
    )


def _well_placed_boundaries(bundle_root, dest):
    """A `cell_boundaries.parquet` whose polygons SURROUND their own centroids.

    ## Why this has to exist

    Every boundaries fixture in this package is deliberately NOT co-located — the staged one
    keys real vendor vertices from a different bundle onto this bundle's cell ids, which is
    what makes it a good subject for the §7.3 failure-mode tests. The consequence is that
    `coverage_is_reportable` is True for all of them, so the LOUD branch is the only branch a
    real import in this suite has ever exercised.

    That left the word "unconditional" untested. A blind angle proved it: gating the emission
    on `coverage_is_reportable` — re-introducing verbatim the defect the block exists to
    prevent — left all 306 tests green, because no fixture reaches the benign branch. A claim
    about EVERY bundle asserted on one bundle, from the wrong branch.

    So this builds the missing branch rather than asserting around it: a small square around
    each real centroid. Overlaps and contains by construction, which is exactly the case where
    the note goes quiet and the standing statement must not.
    """
    import csv as _csv
    import gzip as _gzip

    import pyarrow as pa
    import pyarrow.parquet as pq

    ids, xs, ys = [], [], []
    with _gzip.open(Path(bundle_root) / "cells.csv.gz", "rt", newline="") as fh:
        for row in _csv.DictReader(fh):
            cx, cy = float(row["x_centroid"]), float(row["y_centroid"])
            # A CLOSED ring, four corners plus the repeat, at a radius small enough that no
            # cell's box reaches another's centroid and large enough to be a real extent.
            for dx, dy in ((-2, -2), (2, -2), (2, 2), (-2, 2), (-2, -2)):
                ids.append(row["cell_id"])
                xs.append(cx + dx)
                ys.append(cy + dy)
    assert ids, "the staged bundle has no cells; this fixture would assert on nothing"
    pq.write_table(
        pa.table({"cell_id": pa.array(ids, type=pa.string()),
                  "vertex_x": pa.array(xs, type=pa.float64()),
                  "vertex_y": pa.array(ys, type=pa.float64())}),
        dest, compression="snappy")
    return dest


@pytest.fixture(scope="module")
def imported(tmp_path_factory):
    """TWO real imports — the loud branch and the benign one — because the claim is UNCONDITIONAL.

    Module-scoped: the imports are the expensive part of this file and nothing here mutates
    their outputs.
    """
    out = tmp_path_factory.mktemp("placement-disclosure")

    # (a) the staged fixture: polygons and centroids wholly apart, so the coverage note is
    #     reportable and the boundaries section renders.
    loud_root = XF.stage_bundle(out, boundaries=XF.PRIME_STAGED_BOUNDARIES, name="loud-outs")
    loud_outputs = out / "outputs-loud"
    loud_outputs.mkdir()
    module, entries = XF.run_over(loud_root, loud_outputs)

    # (b) the branch nothing in this package had ever imported: a WELL-PLACED pair, where
    #     `coverage_is_reportable` is False and the note says nothing.
    benign_root = XF.stage_bundle(out, name="benign-outs")
    _well_placed_boundaries(benign_root, benign_root / "cell_boundaries.parquet")
    benign_outputs = out / "outputs-benign"
    benign_outputs.mkdir()
    _, benign_entries = XF.run_over(benign_root, benign_outputs)

    load = lambda d: json.loads((d / "xenium-import-report.json").read_text())
    return {"module": module, "entries": entries, "outputs": loud_outputs,
            "report": load(loud_outputs),
            "benign_entries": benign_entries, "benign_outputs": benign_outputs,
            "benign_report": load(benign_outputs)}


def test_the_emitted_report_STATES_unconditionally_what_judges_the_placement(imported):
    """TEST-16 [acceptance] [invariant: INV-1] [covers: ITEM-8] (#301).

    §7.5 makes the registration QC overlay "a required output of the importer, not a
    nice-to-have ... the entire verification story for step 7.3". This importer now produces
    it, and the artifact must say so where a reader will actually meet it — the same
    obligation #291 discharged in the other direction.

    ## WHY UNCONDITIONAL, AND WHY THIS TEST DRIVES A REAL IMPORT

    #291's first cut put its disclosure ONLY in the benign coverage note — and
    `coverage_is_reportable` is False for exactly that case, so on a well-placed bundle the
    HTML summary said nothing at all about placement. A blind design-conformance angle called
    that what it is: the substitute for a human control, placed behind the predicate that
    suppresses it. `boundaries.placement_judgement` is therefore emitted on EVERY bundle that
    has boundaries, and this test asserts the identical block on both branches.

    And it is asserted THROUGH A REAL IMPORT rather than off a function's return value,
    because a blind tests-quality angle severed the note's route to the report (`"coverage":
    None`) and every direct-call assertion in this file stayed green. What is claimed — "the
    artifact states" — is a claim about the artifact.
    """
    boundaries = imported["report"]["boundaries"]
    assert boundaries["emitted"] is True, (
        "the staged bundle stopped emitting boundaries, so this test is asserting the "
        "statement on a run that has no placement to state anything about"
    )

    judgement = boundaries["placement_judgement"]
    assert "#301" in judgement["issue"], (
        f"the emitted block does not name the work item that built the control: {judgement}"
    )
    assert "#156" in judgement["issue"], (
        "…and it must still name the sibling's, because a reader who finds "
        f"`spatial-import-visium/compute/registration_qc.py` needs to know it is not this one: "
        f"{judgement}"
    )
    assert "PRODUCED by this importer" in judgement["status"], (
        f"the status must say the control is produced here: {judgement['status']!r}"
    )
    assert "NOT PRODUCED" not in judgement["status"], (
        "the status has gone back to #291's absence claim, which #301 made false: "
        f"{judgement['status']!r}"
    )
    assert "spatial-import-visium" in judgement["built_for"], (
        "the block must still say where the SIBLING's overlay is — the two are different "
        f"checks answering the same design section: {judgement['built_for']!r}"
    )
    assert "overlay" in judgement["judged_by_here"].lower(), (
        f"the block does not say what judges placement here: {judgement}"
    )
    assert "nothing" not in judgement["judged_by_here"].lower(), (
        f"…and it must no longer say NOTHING judges it: {judgement['judged_by_here']!r}"
    )
    # THE LIMIT, KEPT. #291's consequence had to be scoped so it did not overstate an
    # absence; #301's has to be scoped so it does not overstate a presence. Both are the same
    # rule and this is the assertion that carries it.
    consequence = judgement["consequence"]
    assert "does not see" in consequence or "still does not" in consequence, (
        "the consequence claims the control now covers this without stating what it still "
        f"does not see, which is 'judged by nothing' with the sign flipped: {consequence!r}"
    )
    assert "shape" in consequence.lower(), (
        "the overlay draws cell centres, not polygon outlines, so a boundary set correctly "
        f"SCALED and wrongly SHAPED is still ruled on by nothing: {consequence!r}"
    )
    assert "#228" in consequence, (
        "the workbench's image-to-coordinates binding can show the same picture and is now a "
        f"SECOND route to it rather than the only one; dropping it loses that: {consequence!r}"
    )
    assert "#302" in judgement["tracked_as"], (
        "the block must name the residue this branch could not reach — the same prose, still "
        f"stale in the shared modules this package vendors: {judgement['tracked_as']!r}"
    )

    # AND IT IS UNCONDITIONAL, not a reaction to this bundle. The same fact holds for a clean
    # import and a broken one, so it is asserted against the module constant rather than only
    # against whatever this fixture happened to produce.
    assert judgement == imported["module"].PLACEMENT_JUDGEMENT, (
        "the emitted block is not the module's standing statement — it has been rebuilt or "
        "conditioned on the bundle, which is how a fact about the IMPORTER turns into a "
        "reaction to the DATA"
    )

    # THE SIBLING DISCLOSURE IS HELD TO THE SAME STANDARD, in the same report. A package that
    # states one thing in one field and its opposite in the next has not stated anything.
    control = imported["report"]["scale_referent"]["compensating_control"]
    assert "PRODUCED by this importer" in control["status"]
    assert "NOT PRODUCED" not in control["status"], (
        f"`scale_referent.compensating_control` is back to #291's wording: {control['status']!r}"
    )
    assert control["still_not_decided"], (
        "the sibling statement must carry its own limit too, or 'PRODUCED' reads as "
        "'everything is checked now'"
    )
    assert "#302" in control["tracked_as"]
    assert "spatial-import-visium" in control["built_for"]

    # THE PRODUCER'S NOTE REACHES THE ARTIFACT UNCHANGED. This is the coupling TEST-15 above
    # cannot see: a blind audit severed it and re-derived the note as a literal in the report
    # builder, and every direct-call assertion stayed green.
    meta = XF.entry(imported["entries"], "spatial-boundaries")["meta"]
    assert boundaries["coverage"] == meta["boundary_coverage"], (
        "the report's coverage block is no longer the producer's own: something between "
        "`coverage_against` and the report is rewriting it, so the statement asserted "
        "elsewhere in this file is not what a reader gets"
    )

    # ── UNCONDITIONAL, PROVED ON THE OTHER BRANCH ───────────────────────────────────────
    #
    # Everything above ran on the staged fixture, whose extents are wholly apart — the LOUD
    # branch. An audit gated the emission on `coverage_is_reportable` (the exact defect this
    # block prevents) and the whole suite stayed green, because no fixture in this package
    # reaches the benign branch. `_well_placed_boundaries` builds it.
    benign = imported["benign_report"]["boundaries"]
    assert benign["emitted"] is True
    assert benign["coverage"]["overlaps"] is True, (
        "the well-placed fixture is not well placed; it cannot exercise the branch where the "
        f"note goes quiet: {benign['coverage']}"
    )
    assert benign["coverage"]["centroids_contained"] is True, (
        f"the well-placed fixture's centroids are not inside its polygons: {benign['coverage']}"
    )
    assert not BD_reportable(imported["module"], benign), (
        "the well-placed fixture is still REPORTABLE, so it is not the branch this leg needs"
    )
    assert benign["placement_judgement"] == judgement, (
        "the statement is not emitted on a WELL-PLACED bundle, or differs from the loud one — "
        "it is a standing fact about this importer, so it must be identical on both and "
        "present on both. This is the exact conditioning a blind angle re-introduced with the "
        "whole suite still green."
    )

    # ── AND IT REACHES A HUMAN, on the branch where nothing else does ───────────────────
    #
    # `render_report_html` renders the boundaries section only when the coverage note is
    # reportable. On a well-placed bundle it renders nothing — so without this, a reader of a
    # clean import would meet no placement statement at all outside the embedded JSON.
    XI = imported["module"]
    html = XI.render_report_html(imported["benign_report"])
    visible = html.split("<script", 1)[0]
    assert "What checks this import's placement" in visible, (
        "the placement statement does not reach the rendered summary on a well-placed "
        "bundle — it is back to being a fact only a machine reads"
    )
    for token in ("#301", "PRODUCED by this importer", "registration QC overlay"):
        assert token in visible, (
            f"the rendered statement has lost {token!r}; a reader sees a heading with no "
            "content behind it"
        )
    assert "NOT PRODUCED by this importer" not in visible, (
        "the rendered summary still tells a reader the control is not produced here"
    )
    # AND IT DOES NOT MASQUERADE AS A FINDING ABOUT THIS BUNDLE. #247's acceptance test
    # asserts a correctly placed pair renders no "Segmentation boundaries" section; folding
    # this standing fact into that section would delete that guard, not satisfy it.
    assert "Segmentation boundaries" not in visible, (
        "the placement statement has been folded into the per-bundle boundaries section, "
        "where a reader will read a fact about the IMPORTER as a finding about their data "
        "(and #247's acceptance assertion is deleted rather than met)"
    )
