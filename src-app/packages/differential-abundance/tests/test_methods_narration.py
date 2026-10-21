#!/usr/bin/env python3
# ruff: noqa
"""TEST-20 [covers: ITEM-12] — the `methods.md` narration, and the two traps that silently break it.

`server/src/modules/provenance/export/methods.rs` reads `contributes.analyses[<id>].methods` to
narrate the exported `methods.md` — the OUT-OF-APP TRUST DELIVERABLE, the document a reader cites.
For differential abundance this is not decoration: the statistical model, the design formula and
the normalization assumption are the only things that let a reader judge whether the result means
anything. Getting it wrong ships a plausible-looking document that omits the one caveat that
matters.

## The two traps, both of which are SILENT

  1. **The `note` is DROPPED when no constraint was narrated.** `declared_sentence` appends
     `spec.note` only on the `constraints` non-empty branch, and `threshold_phrases` only yields a
     phrase for an entry keyed by one of `THRESHOLD_MEASURE_KEYS` carrying a `min`/`max` bound. A
     declaration with no constraint-producing param role would drop this feature's whole
     compositional-correctness disclosure from the export, with nothing failing.
  2. **`{name}` does not substitute.** The narrator replaces the literal token `{label}` and
     nothing else; `clustering`, `differential-expression`, `geneset` and `embedding` all declare
     `{name}`/`{n_pcs}`/`{method}` placeholders that render VERBATIM into the exported document.

## The honest limit of this test (DEC-10)

It does NOT render `methods.md`. The narrator is Rust and is reachable only from a Rust test under
`src-app/server/**`, which would be a third non-package `src-app` file — and this feature already
carries one forced non-package edit it has to justify. What this test does instead is bind the
DECLARATION to the shipped narrator's own constants, read out of `methods.rs` at test time: the
measure keys, the bound keys, the `{label}` token and the note-drop branch. A change to any of
them fails here loudly. It cannot prove the rendered sentence reads well; it can prove the
declaration satisfies every precondition the renderer imposes.
"""
import re
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_MANIFEST = _PKG / "manifest.yaml"
_METHODS_RS = (_PKG.parents[1] / "server" / "src" / "modules" / "provenance" / "export"
               / "methods.rs")
_UI = _PKG / "ui"


def _analyses():
    doc = yaml.safe_load(_MANIFEST.read_text())
    return {a["id"]: a for a in doc["contributes"]["analyses"]}


def _narrator_const(name):
    src = _METHODS_RS.read_text()
    block = src.split(f"const {name}")[1].split("];")[0]
    return {m.group(1) for m in re.finditer(r'"([^"]+)"', block)}


def _run_params(view):
    spec = yaml.safe_load((_UI / view).read_text())
    run = next(e["run_processor"] for a in spec["actions"] for e in a["body"]
               if "run_processor" in e)
    return run["params"]


VIEW_FOR = {"da.clusters": "clusters.yaml", "da.neighbourhoods": "neighbourhoods.yaml"}


def test_the_narrator_narrates_the_note_UNCONDITIONALLY_now():
    """This test's predecessor fired, as designed, and is retired here DELIBERATELY.

    It used to assert that the narrator gated `spec.note` inside a non-empty-constraints branch —
    a trap, not a property we wanted. Its own failure message said so: "the `note` is no longer
    gated on a non-empty constraint list — good news, and this test should be relaxed
    deliberately rather than by accident". Upstream's #131
    (`docs/design/methods-narrator-repair.md`) moved the note OUT of that branch, because a
    package declaring no constraint-producing param role was silently losing its entire
    scientific caveat.

    So the assertion inverts: the note must NOT be reachable only through the constraints arm.
    Keeping a canary that asserts the OLD, broken shape would redden this suite for an upstream
    repair, which is the opposite of what a guard is for.

    Scope, stated rather than implied: this reads the shipped narrator SOURCE, so it is a cheap
    tripwire and not the guarantee. Upstream owns the behavioural proof of its own repair; what
    this pins is only that THIS package's caveat does not depend on the old gating, so nobody
    re-introduces a `threshold_list` param role here believing it is load-bearing for the note.
    """
    src = _METHODS_RS.read_text()
    assert "let head = if constraints.is_empty()" in src, (
        "the narrator's head-construction shape changed entirely; re-read #131 and re-derive "
        "what this package can rely on rather than editing this assertion to match")
    head = src.split("let head = if constraints.is_empty()")[1].split('format!("{head}')[0]
    empty_arm, nonempty_arm = head.split("} else {")[0], head.split("} else {")[1]
    assert "spec.note" not in nonempty_arm, (
        "`spec.note` is gated inside the non-empty-constraints arm again — #131's repair has "
        "been reverted, and every package declaring no constraint-producing param role has "
        "silently lost its scientific caveat")
    assert "spec.note" in src, "the narrator no longer references `spec.note` at all"


@pytest.mark.parametrize("aid", sorted(VIEW_FOR))
def test_each_analysis_declares_a_threshold_list_param_so_the_note_renders(aid):
    params = _analyses()[aid]["methods"]["params"]
    roles = set(params.values())
    assert "threshold_list" in roles, (
        f"{aid} declares no constraint-producing param role. NOTE THE REASON CHANGED: this role "
        "was originally required because the narrator DROPPED `spec.note` without it, and "
        "upstream #131 has since made the note unconditional — so dropping the role no longer "
        "costs the caveat. It is kept because `fdr`/`min_cells` really are the run's thresholds "
        "and declaring them is correct design on its own. Removing it is therefore allowed, but "
        "it is a DECISION about the methods record, not a cleanup.")
    assert params.get("name") == "output_label"
    # `seed` is declared ONLY where something is actually seeded: `da.neighbourhoods` draws its
    # index cells, `da.clusters` draws nothing. Declaring the role on an analysis with no
    # randomness would narrate a randomness into `methods.md` that the run does not have.
    assert (params.get("seed") == "seed") == (aid == "da.neighbourhoods")


@pytest.mark.parametrize("aid", sorted(VIEW_FOR))
def test_the_run_form_actually_sends_a_threshold_value_the_narrator_can_render(aid):
    """A declared role with nothing sent is the same silence. The shape is checked against the
    narrator's OWN constants, so a change to `THRESHOLD_MEASURE_KEYS` fails here."""
    measure_keys = _narrator_const("THRESHOLD_MEASURE_KEYS")
    bound_keys = _narrator_const("THRESHOLD_BOUND_KEYS")
    assert measure_keys and bound_keys

    threshold_param = next(p for p, role in _analyses()[aid]["methods"]["params"].items()
                           if role == "threshold_list")
    sent = _run_params(VIEW_FOR[aid])
    assert threshold_param in sent, (
        f"{aid}: the run form never sends {threshold_param!r}, so the declared role narrates "
        "nothing and the note is dropped")
    entries = sent[threshold_param]
    assert isinstance(entries, list) and entries, f"{aid}: the threshold list is empty"
    for entry in entries:
        assert isinstance(entry, dict)
        measure = [k for k in entry if k in measure_keys]
        bounds = [k for k in entry if k in bound_keys]
        assert measure, (
            f"{aid}: threshold entry {entry} carries no measure key; the narrator only renders "
            f"entries keyed by one of {sorted(measure_keys)}")
        assert bounds, (
            f"{aid}: threshold entry {entry} carries no {sorted(bound_keys)} bound, so "
            "`range_phrase` returns None and the entry narrates nothing")
        assert str(entry[measure[0]]).strip(), f"{aid}: an empty measure name narrates nothing"


def test_the_only_placeholder_token_anywhere_is_label():
    """Trap 2. The narrator substitutes `{label}` and nothing else; every other `{…}` renders
    verbatim into the exported document."""
    for aid, a in _analyses().items():
        blob = yaml.safe_dump(a["methods"])
        for m in re.finditer(r"\{([A-Za-z_][A-Za-z0-9_]*)\}", blob):
            assert m.group(1) == "label", (
                f"{aid}: `{{{m.group(1)}}}` would render VERBATIM into methods.md — the narrator "
                "substitutes `{label}` only")
    src = _METHODS_RS.read_text()
    assert '.replace("{label}"' in src, "the narrator's substitution token has moved"


NARRATION_POINTS = {
    "the statistical model": ("negative-binomial", "wald", "pydeseq2"),
    "the design formula": ("design formula",),
    "the normalization and its assumption": ("poscounts", "most populations are unchanged",
                                             "absolute abundance is constant"),
    "the unit of replication": ("unit of replication is the sample", "distinct samples"),
    "the relative-abundance caveat": ("relative composition", "spike-in", "total-cell-count"),
    "the undetectable-circularity limitation": ("circular",),
}


@pytest.mark.parametrize("aid", sorted(VIEW_FOR))
def test_the_note_covers_every_required_narration_point(aid):
    note = _analyses()[aid]["methods"]["note"].lower()
    for point, needles in NARRATION_POINTS.items():
        assert all(n in note for n in needles), (
            f"{aid}: the note does not cover {point!r} (missing "
            f"{[n for n in needles if n not in note]})")


def test_the_neighbourhood_note_states_that_the_fdr_is_spatially_weighted():
    note = _analyses()["da.neighbourhoods"]["methods"]["note"].lower()
    assert "overlap" in note and "connectivity-weighted" in note
    assert "resolution-free" in note


def test_the_cluster_note_carries_the_resolution_sensitivity_disclosure():
    note = _analyses()["da.clusters"]["methods"]["note"].lower()
    assert "sensitive to the clustering resolution" in note
    assert "arbitrary partition" in note
    assert "neighbourhood analysis is the resolution-free complement" in note


@pytest.mark.parametrize("aid", sorted(VIEW_FOR))
def test_methodsText_and_methods_do_not_contradict_each_other(aid):
    """They are DIFFERENT systems — `methodsText` is `$`-interpolated and read only by the
    frontend, `methods` only by Rust — and a reader who sees both must not be told two things."""
    a = _analyses()[aid]
    fe = a["methodsText"].lower()
    assert "negative-binomial" in fe or "negative binomial" in fe
    assert "never on raw proportions" in fe or "never on raw" in fe or "integer" in fe
    assert "sample" in fe
    assert "absent" in fe, "the frontend text must also say the p-value is ABSENT, not 1"
    if aid == "da.neighbourhoods":
        assert "connectivity-weighted" in fe or "spatial" in fe
    else:
        assert "resolution" in fe


@pytest.mark.parametrize("aid", sorted(VIEW_FOR))
def test_the_note_names_the_small_sample_reference_distribution(aid):
    """The shipped default refers the Wald statistic to a Student-t rather than to the normal the
    reference implementation uses. That is a real deviation from the pinned specification, so it
    is DISCLOSED in the out-of-app document rather than folded in silently."""
    note = _analyses()[aid]["methods"]["note"].lower()
    assert "student-t" in note and "residual degrees of freedom" in note
    assert "recorded with the result" in note or "recorded with every result" in note


#: Every engine the run form actually offers. The narration below must be true for ALL of them.
_ENGINE_KEYS = ("pydeseq2", "nb_glm")


@pytest.mark.parametrize("aid", sorted(VIEW_FOR))
def test_the_narration_is_TRUE_FOR_EVERY_ENGINE_THE_FORM_OFFERS(aid):
    """Round R1 finding. `methods.note` is the out-of-app trust deliverable, and it asserted
    UNCONDITIONALLY that the model is "fitted with PyDESeq2" and that the Wald statistic "is
    referred to a Student-t distribution on the residual degrees of freedom rather than to a
    normal". Both are FALSE for every run that selects the NB-GLM engine — which the shipped run
    form offers as a first-class choice, and which `_kernel.register_method` registers with
    `small_sample_correction=False`, so `fit()` leaves its statistic on a normal reference and
    statsmodels does the fitting. The artifact then records `small_sample_correction: false` while
    methods.md asserts the opposite.

    The narrator substitutes `{label}` and nothing else, so the note cannot be parameterised by
    engine: it has to be phrased so that it is true whichever engine ran, and it has to say that
    the choice is recorded. This test pins that, and the earlier absolute wording fails it.
    """
    a = _analyses()[aid]
    for field in ("note", "methodsText"):
        text = a["methods"]["note"] if field == "note" else a["methodsText"]
        low = " ".join(text.lower().split())

        assert "recorded" in low, (
            f"{aid}.{field}: nothing in the narration says the engine or its reference "
            "distribution is RECORDED, so a reader has no way to learn which one ran")
        for bad in ("fitted with pydeseq2",
                    "the wald statistic is referred to a student-t",
                    "the test statistic referred to a small-sample (student-t) reference "
                    "distribution."):
            assert bad not in low, (
                f"{aid}.{field}: {bad!r} states as UNCONDITIONAL a property that only the "
                "PyDESeq2 arm has. The NB-GLM engine is fitted by statsmodels and keeps its own "
                "normal reference, so this sentence is false for every NB-GLM run — and the "
                "artifact it accompanies records `small_sample_correction: false` beside it.")

    # …and the note must name the alternative, not merely stop asserting the false thing.
    note = " ".join(a["methods"]["note"].lower().split())
    assert "nb-glm" in note, (
        f"{aid}: the note never mentions the NB-GLM engine at all. Removing the false absolute is "
        "half the fix; a reader of methods.md still has to be told which engines exist.")
    assert "statsmodels" in note


#: Terms that are TRUE OF ONE ENGINE ONLY. A sentence asserting one of these must say which.
_ENGINE_SPECIFIC = ("pydeseq2", "student-t", "wald")
#: Words that make a sentence conditional rather than universal. One of these must appear in the
#: SAME sentence as an engine-specific term.
_HEDGES = ("default", "recorded", "selectable", "arm", "either", "when", "which", "nb-glm",
           "statsmodels", "choice", "alternative", "engine is")
#: Words that assert universality outright. Fatal in a sentence with an engine-specific term.
_UNIVERSALS = ("every run", "always", "in all cases", "each run", "any run")


def _sentences(text):
    import re

    return [x.strip() for x in re.split(r"(?<=[.;])\s+", " ".join(text.split())) if x.strip()]


@pytest.mark.parametrize("aid", sorted(VIEW_FOR))
def test_no_sentence_asserts_an_ENGINE_SPECIFIC_fact_unconditionally(aid):
    """Round R2 finding. The previous version of this guard forbade THREE literal substrings, so
    any paraphrase of the same false absolute walked straight through it. The auditor demonstrated
    it with:

        "Every run refers its Wald statistic to a Student-t distribution on the residual degrees
         of freedom, and the model is fitted by PyDESeq2."

    — false for every `nb_glm` run, inserted into BOTH notes, and `69 passed`.

    This checks a PROPERTY instead: no SENTENCE may assert an engine-specific fact without also
    saying that it is engine-specific. The premise is read from the kernel — if every registered
    engine agreed on the small-sample reference there would be nothing to hedge — so the rule
    switches itself off rather than becoming a style check the day that changes.

    It is a heuristic over prose and is honest about that; unlike the blacklist, its subject is the
    claim rather than one spelling of it.
    """
    import _kernel as K

    defaults = {m["key"]: m["small_sample_correction"] for m in K.catalog()}
    if len(set(defaults.values())) == 1:
        pytest.skip(f"all engines share small_sample_correction={set(defaults.values())}; "
                    "there is no engine-specific reference to hedge")

    a = _analyses()[aid]
    for field, text in (("note", a["methods"]["note"]), ("methodsText", a["methodsText"])):
        for sentence in _sentences(text):
            low = sentence.lower()
            if not any(t in low for t in _ENGINE_SPECIFIC):
                continue
            bad = [u for u in _UNIVERSALS if u in low]
            assert not bad, (
                f"{aid}.{field}: this sentence asserts an engine-specific fact UNIVERSALLY "
                f"({bad}) — engines differ ({defaults}):\n    {sentence}")
            assert any(h in low for h in _HEDGES), (
                f"{aid}.{field}: this sentence states an engine-specific fact with nothing marking "
                f"it as engine-specific. Engines differ ({defaults}), so as written it is false "
                f"for every run that selects the other one:\n    {sentence}")


def test_every_registered_engine_is_offered_by_the_form_and_vice_versa():
    """The premise of the test above: if an engine were registered in the kernel but absent from
    the form, or vice versa, "true for every engine the form offers" would be checking the wrong
    set."""
    import _kernel as K

    def walk(node):
        yield node
        if isinstance(node, dict):
            for v in node.values():
                yield from walk(v)
        elif isinstance(node, list):
            for v in node:
                yield from walk(v)

    registered = {m["key"] for m in K.catalog()}
    assert registered == set(_ENGINE_KEYS), (
        f"the kernel registers {sorted(registered)}; this module's narration checks assume "
        f"{sorted(_ENGINE_KEYS)}. Update both together.")
    for aid, view in VIEW_FOR.items():
        spec = yaml.safe_load((_UI / view).read_text())
        offered = set()
        for node in walk(spec):
            # Any `{value, label}` option list, wherever it is declared — the engine enum lives
            # under `const.methods`, not under an `options:` key, and hard-coding that path would
            # make this guard silently vacuous the day the spec moves it.
            if not isinstance(node, list):
                continue
            values = {str(o["value"]) for o in node
                      if isinstance(o, dict) and "value" in o}
            if values & registered:
                offered |= values
        assert offered == registered, (
            f"{aid} ({view}) offers the engines {sorted(offered)} but the kernel registers "
            f"{sorted(registered)} — the narration check above would then be quantifying over "
            "the wrong set")


@pytest.mark.parametrize("aid", sorted(VIEW_FOR))
def test_every_declared_role_is_actually_SENT_by_the_run_form(aid):
    """A role declared but never sent narrates NOTHING — and for `output_label` it is worse than
    nothing, because the `{label}` token in `commits` can then never render and the export
    silently falls back to `commits_unlabeled` forever. Declaring is half the contract; sending is
    the other half, and only this test covers the second half."""
    declared = set(_analyses()[aid]["methods"]["params"])
    sent = set(_run_params(VIEW_FOR[aid]))
    missing = declared - sent
    assert not missing, (
        f"{aid}: the methods declaration claims the role(s) {sorted(missing)} but the run form "
        "never sends them, so they narrate nothing")


@pytest.mark.parametrize("aid", sorted(VIEW_FOR))
def test_the_undeclared_params_that_ride_the_by_name_fallback_are_the_expected_ones(aid):
    """Undeclared params are auto-disclosed by NAME in a trailing sentence, which is a real
    safety net but not narration. Everything that MATTERS is in the note; this test records which
    params are left to the fallback so the set cannot grow silently."""
    declared = set(_analyses()[aid]["methods"]["params"])
    sent = set(_run_params(VIEW_FOR[aid]))
    fallback = sent - declared
    expected = {"group1", "group2", "method", "normalization", "min_cells", "fdr"}
    if aid == "da.clusters":
        expected |= {"reference", "emit_effect_column"}
    else:
        expected |= {"prop", "k"}
    assert fallback <= expected, f"{aid}: unexpected params on the by-name fallback: {fallback - expected}"
