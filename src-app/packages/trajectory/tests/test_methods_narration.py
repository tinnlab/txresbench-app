#!/usr/bin/env python3
# ruff: noqa
"""TEST-23 — the methods narration is DECLARED correctly, per the published contract.

For a trajectory the narration is not decoration: the root, and the fact that the root
determines the whole answer, ARE the result. A methods statement that omits them describes a
different analysis than the one that ran.

Two systems, both required, neither reading the other: `methodsText` is read only by the
frontend and rendered in the in-app provenance view; the `methods:` block is read only by
the server to narrate the exported document. Both are asserted here.

## What this file deliberately does NOT assert, and why

It does not read a GENERATED methods document. Two reasons, both recorded as an approved
descope rather than absorbed:

  * the narrator DROPS `note:` for any analysis that declares no constraint-producing param
    role, and prints a "no criteria were recorded" sentence that is FALSE for an analysis
    applying no predicate. That is a known shared defect being repaired separately.
  * generating that document from a test would need a Rust integration test under the app's
    server tree — a further app path this package is not entitled to open — and
    re-implementing the narrator in Python would be a fake oracle: a test that agrees with
    our own re-implementation proves nothing about the real one.

So this asserts the half that IS ours: that the declaration is correct and complete, and in
particular that we did NOT manufacture a fake constraint param to force the note to render.
That workaround exists elsewhere in the tree and is explicitly not to be copied — inventing
a parameter the analysis does not need, to unlock prose it does need, is a bad trade every
analysis would then repeat.

Mutation: use the placeholder spelling five shipped manifests use -> the placeholder test
fails (that spelling renders as literal braces in the export). Add a threshold param that
the analysis does not use -> the no-manufactured-param test fails. Drop a disclosure -> the
ten-points test names the missing one.
"""
import re
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]

#: The CLOSED seven-value role vocabulary. A spelling outside it fails the build.
PARAM_ROLES = {"predicate_list", "threshold_list", "opaque_predicate", "allow_list",
               "subsample_cap", "seed", "output_label"}
#: The four roles that PRODUCE a narrated constraint — and therefore the only ones that make
#: the narrator take the branch on which `note:` is emitted at all.
CONSTRAINT_ROLES = {"predicate_list", "threshold_list", "opaque_predicate", "allow_list"}
#: The ONLY placeholder the narrator substitutes.
SUBSTITUTED_PLACEHOLDER = "{label}"


def _haystack(analysis):
    """Both narration surfaces, whitespace-normalised — the yaml folds long prose across
    lines, so a phrase that reads as contiguous in the source is not contiguous in the
    string."""
    text = (analysis.get("methodsText") or "") + " " + (analysis["methods"].get("note") or "")
    return " ".join(text.split()).lower()


@pytest.fixture(scope="module")
def analyses():
    manifest = yaml.safe_load((_PKG / "manifest.yaml").read_text())
    return {a["id"]: a for a in manifest["contributes"]["analyses"]}


@pytest.mark.parametrize("analysis_id", ["trajectory.paga", "trajectory.dpt"])
def test_both_narration_systems_are_declared(analyses, analysis_id):
    """Nothing in the server reads the frontend field and nothing in the frontend reads the
    structured block. Both are required, and neither falls back to the other."""
    a = analyses[analysis_id]
    assert a.get("methodsText", "").strip(), f"{analysis_id} declares no methodsText"
    methods = a.get("methods")
    assert methods, f"{analysis_id} declares no methods block"
    assert methods["subject"]["singular"]
    assert methods["subject"]["plural"]
    assert methods["action"]


@pytest.mark.parametrize("analysis_id", ["trajectory.paga", "trajectory.dpt"])
def test_every_declared_param_role_is_in_the_closed_vocabulary(analyses, analysis_id):
    """A typo here fails the build, and a malformed block does not degrade — it fails the
    manifest parse and the WHOLE package is skipped at boot."""
    for param, role in (analyses[analysis_id]["methods"].get("params") or {}).items():
        assert role in PARAM_ROLES, (
            f"{analysis_id} maps {param!r} to role {role!r}, outside the closed vocabulary")


@pytest.mark.parametrize("analysis_id", ["trajectory.paga", "trajectory.dpt"])
def test_only_the_substituted_placeholder_is_used_anywhere(analyses, analysis_id):
    """Five shipped manifests use placeholder spellings the narrator does not substitute, and
    render literal braces into the exported document. This package uses the one that works."""
    methods = analyses[analysis_id]["methods"]
    for field in ("commits", "commits_unlabeled", "note"):
        text = methods.get(field) or ""
        for token in re.findall(r"\{[^}]*\}", text):
            assert token == SUBSTITUTED_PLACEHOLDER, (
                f"{analysis_id}.methods.{field} contains {token!r}, which the narrator does "
                f"NOT substitute — it would render as literal braces. Use "
                f"{SUBSTITUTED_PLACEHOLDER!r} or no placeholder.")
    # the frontend field interpolates with a different syntax entirely, and takes no braces.
    assert not re.findall(r"\{[^}]*\}", analyses[analysis_id]["methodsText"])


@pytest.mark.parametrize("analysis_id", ["trajectory.paga", "trajectory.dpt"])
def test_no_constraint_param_was_MANUFACTURED_to_unlock_the_note(analyses, analysis_id):
    """The workaround this package refuses to copy.

    Neither analysis applies a predicate, a threshold or an allow-list, so declaring one to
    make the narrator take the branch that emits `note:` would be inventing a parameter the
    analysis does not have. The note is declared correctly and the narrator repair is landing
    separately; this asserts we waited rather than faked it.
    """
    methods = analyses[analysis_id]["methods"]
    declared = set((methods.get("params") or {}).values())
    manufactured = declared & CONSTRAINT_ROLES
    assert not manufactured, (
        f"{analysis_id} declares the constraint-producing role(s) {sorted(manufactured)}. "
        "This analysis applies no predicate, so such a param would exist only to force the "
        "note to render — the exact bad trade the epic forbids.")
    assert not methods.get("allow_list_slots"), (
        f"{analysis_id} declares allow_list_slots, which would have the same effect")
    # …and the roles it DOES declare are the two it honestly has.
    assert declared <= {"seed", "output_label"}


@pytest.mark.parametrize("analysis_id", ["trajectory.paga", "trajectory.dpt"])
def test_the_note_is_declared_and_substantial_despite_not_rendering_yet(analyses,
                                                                       analysis_id):
    """Declared correctly NOW, so the repair lands into a correct declaration rather than
    into an empty one that would then need writing under time pressure."""
    note = analyses[analysis_id]["methods"].get("note") or ""
    assert len(note.split()) >= 60, (
        f"{analysis_id}'s note is {len(note.split())} words — the honesty payload for a "
        "trajectory is the substance of the narration, not a sentence")


# ── the ten disclosure points ─────────────────────────────────────────────────────────
#
# Each is (analysis, human name, [phrases that must appear across methodsText + note]).
_REQUIRED_DISCLOSURES = [
    ("trajectory.dpt", "pseudotime is not time",
     ["ordering, not a time", "no units"]),
    ("trajectory.dpt", "the root determines everything",
     ["root determines", "different root is a different result"]),
    ("trajectory.dpt", "which root, and by which rule",
     ["records which root", "three offered rules"]),
    ("trajectory.dpt", "a root choice is a biological assertion",
     ["biological assertion"]),
    ("trajectory.dpt", "unreachable cells",
     ["unreachable", "never given a value"]),
    ("trajectory.dpt", "branch detection was not performed, and why",
     ["branch detection was not performed", "abstracted graph"]),
    ("trajectory.dpt", "the reproducibility surface",
     ["diffusion components", "both are recorded"]),
    ("trajectory.paga", "the connectivity statistic, named",
     ["observed inter-level neighbour edges", "hard-capped at 1", "not a probability"]),
    ("trajectory.paga", "the statistic model was chosen, not defaulted",
     ["selected explicitly and recorded"]),
    ("trajectory.paga", "the graph is only as good as the partition",
     ["nodes are the levels", "an input and\n          not a discovery"]),
    # added after the design-conformance angle found all three absent from the package
    ("trajectory.paga", "the honest capability gap",
     ["no fate probabilities"]),
    ("trajectory.paga", "the benchmark context",
     ["45", "no universal winner"]),
    ("trajectory.dpt", "the honest capability gap",
     ["no fate probabilities", "no per-lineage pseudotime"]),
    ("trajectory.dpt", "the scheduled upstream numerical change",
     ["backwards-incompatible release", "comparable within a library version"]),
    ("trajectory.dpt", "the benchmark context",
     ["no universal winner"]),
]


@pytest.mark.parametrize("analysis_id,name,phrases", _REQUIRED_DISCLOSURES,
                         ids=[f"{a}:{n}" for a, n, _ in _REQUIRED_DISCLOSURES])
def test_each_required_disclosure_is_present(analyses, analysis_id, name, phrases):
    a = analyses[analysis_id]
    haystack = _haystack(a)
    for phrase in phrases:
        needle = " ".join(phrase.split()).lower()
        assert needle in haystack, (
            f"{analysis_id} does not disclose {name!r}: missing {phrase!r}")


def test_both_analyses_disclose_that_nothing_tests_a_trajectory_EXISTS(analyses):
    """The one disclosure the validity suite explicitly CANNOT make with a test, so it has
    to be narrated by both analyses."""
    for analysis_id in ("trajectory.paga", "trajectory.dpt"):
        a = analyses[analysis_id]
        haystack = _haystack(a)
        assert "tests whether" in haystack, analysis_id
        assert ("trajectory exists" in haystack or "continuum exists" in haystack), analysis_id
