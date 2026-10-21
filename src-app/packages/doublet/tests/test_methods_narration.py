#!/usr/bin/env python3
# ruff: noqa
"""TEST-8 [covers: ITEM-22] — the `methods.md` narration SEAM.

`server/src/modules/provenance/export/methods.rs` reads
`contributes.analyses[<id>].methods` to narrate the exported `methods.md`, which is the
OUT-OF-APP TRUST DELIVERABLE — the document a reader outside this app judges the work by.
Without the block, a run exports the generic *"Step 'compute' was performed using
`doublet.detect` v0.4.0 (random seed 0)"*, because the `kind` of every sandbox compute run is
the literal string `"compute"`. `qc.10x` ships `methodsText` and NO `methods:` block; that is
the thing not to copy.

── What this file can and cannot prove, stated rather than implied ─────────────────────
Rendering `methods.md` end-to-end is Rust and needs a server integration test, i.e. a file
under `src-app/server/tests/` — which would violate the zero-`src-app`-change invariant this
package exists to demonstrate. So this asserts the DECLARATION against the contract the
narrator actually enforces, read out of the Rust source itself rather than from memory:
the accepted field set (`MethodsNarration` is `#[serde(deny_unknown_fields)]`), the CLOSED
seven-member role vocabulary, the single supported placeholder, and the exact set of params
the name-disclosure clause will name. A declaration that satisfies all four cannot be the
reason a run narrates badly.

The end-to-end render is verified by the parallel methods-narrator branch, which owns the two
known rendering defects this file deliberately does NOT route around (see the last test).
"""
import re
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_SRC_APP = _PKG.parents[1]
_TYPES_RS = _SRC_APP / "server" / "src" / "modules" / "extensions" / "types.rs"
_METHODS_RS = _SRC_APP / "server" / "src" / "modules" / "provenance" / "export" / "methods.rs"
_COMPUTE = _PKG / "compute" / "doublet.py"
_VIEW = _PKG / "ui" / "doublet.yaml"

#: `MethodsNarration`'s accepted keys. Asserted against the Rust below rather than trusted,
#: so a struct change reddens this test instead of silently invalidating the manifest.
#: `reference_assets` joined the struct on main after this branch was cut (it is
#: `#[serde(default)]` and empty for every shipped manifest, so it is purely additive and
#: this package declares none). The set is widened DELIBERATELY, which is what the
#: docstring below asks for — not relaxed to `>=` to make the failure go away.
ACCEPTED_FIELDS = {"subject", "action", "commits", "commits_unlabeled", "note", "params",
                   "allow_list_slots", "reference_assets"}
REQUIRED_FIELDS = {"subject", "action"}

#: The CLOSED role vocabulary (`MethodsParamRole`, `rename_all = "snake_case"`).
#: `narrated_value` joined the enum on main after this branch was cut. This package
#: declares none of them; the vocabulary is still CLOSED, it is simply one member larger.
CLOSED_ROLES = {"predicate_list", "threshold_list", "opaque_predicate", "allow_list",
                "subsample_cap", "seed", "output_label", "narrated_value"}


def _analysis():
    doc = yaml.safe_load((_PKG / "manifest.yaml").read_text())
    return doc["contributes"]["analyses"][0]


def _methods():
    return _analysis()["methods"]


def test_the_accepted_field_set_still_matches_the_rust_struct():
    """The contract is read from the source of truth, not from this file's memory of it. If
    `MethodsNarration` gains or loses a field, this fails and the constants above (and the
    manifest) are revisited deliberately."""
    src = _TYPES_RS.read_text()
    body = src.split("pub struct MethodsNarration {", 1)[1].split("\n}", 1)[0]
    fields = set(re.findall(r"^\s*pub ([a-z_]+):", body, flags=re.M))
    assert fields == ACCEPTED_FIELDS, fields
    # …and it really is deny_unknown_fields, which is what makes an unknown key fatal
    prelude = src.split("pub struct MethodsNarration {", 1)[0]
    assert "deny_unknown_fields" in prelude.rsplit("#[derive", 1)[-1] or \
        "deny_unknown_fields" in prelude[-400:], "MethodsNarration is no longer strict"


def test_the_closed_role_vocabulary_still_matches_the_rust_enum_exactly():
    src = _TYPES_RS.read_text()
    body = src.split("pub enum MethodsParamRole {", 1)[1].split("\n}", 1)[0]
    variants = re.findall(r"^\s{4}([A-Z][A-Za-z]*),", body, flags=re.M)
    snake = {re.sub(r"(?<!^)(?=[A-Z])", "_", v).lower() for v in variants}
    # The COUNT is deliberately NOT asserted. It used to be a literal `== 7`, which was a
    # second place to update and drifted at the merge that added `narrated_value`. Deriving
    # it (`len(snake) == len(CLOSED_ROLES)`) fixed the drift and carried zero information —
    # it is strictly implied by the set equality above and can never fail independently.
    # The set equality is the whole assertion.
    assert snake == CLOSED_ROLES, snake


def test_the_block_declares_only_accepted_fields_and_both_required_ones():
    methods = _methods()
    assert set(methods) <= ACCEPTED_FIELDS, set(methods) - ACCEPTED_FIELDS
    assert REQUIRED_FIELDS <= set(methods)
    assert set(methods["subject"]) == {"singular", "plural"}
    assert methods["subject"]["singular"] == "cell"
    assert methods["subject"]["plural"] == "cells"
    assert methods["action"] == "scored for doublet likelihood"


def test_every_declared_param_role_is_in_the_closed_vocabulary():
    roles = _methods()["params"]
    assert set(roles.values()) <= CLOSED_ROLES, set(roles.values()) - CLOSED_ROLES
    # the three we deliberately map, and no more
    assert roles == {"criteria": "predicate_list", "seed": "seed", "label": "output_label"}


def test_the_only_placeholder_is_the_one_the_narrator_substitutes():
    """`methods.rs` substitutes exactly ONE token — `c.replace("{label}", …)`. Four other
    shipped packages spell it `{name}` (and one uses `{n_pcs}`/`{n_hvg}`/`{method}`), which
    renders LITERAL BRACES into the trust deliverable. This asserts our block cannot join
    them, and that the param filling it is named `label` and carries the `output_label` role.
    """
    src = _METHODS_RS.read_text()
    assert '"{label}"' in src, "the narrator's placeholder token moved"

    methods = _methods()
    for key in ("commits", "commits_unlabeled"):
        text = methods.get(key) or ""
        placeholders = set(re.findall(r"\{([a-z_0-9]+)\}", text))
        assert placeholders <= {"label"}, (key, placeholders)
    assert "{label}" in methods["commits"]
    assert "{" not in (methods["commits_unlabeled"] or "")
    assert methods["params"]["label"] == "output_label"


def test_the_label_placeholder_is_actually_fillable_by_a_real_run(detect_run):
    """A `{label}` that no run ever RECORDS renders as `commits_unlabeled` forever, so the
    narrator's `commits` phrase would never appear.

    This drives a real run rather than grepping for a helper name: the earlier version
    asserted two source substrings, which pinned a private implementation detail and proved
    nothing about whether a label reaches the recorded params. What the narrator needs is
    the run's `label` param present in the provenance record — so that is what is asserted,
    from a run that actually happened, together with the form sending it.
    """
    from doublet_fixtures import require_skimage, structured_counts

    require_skimage()
    run = detect_run()
    run.add_matrix(structured_counts(40, 90, n_groups=3, seed=0))
    run.run_ok({"n_prin_comps": 10, "label": "run2"})

    report = run.report()
    # the value `{label}` is substituted from, recorded by the run itself
    assert report["parameters_resolved"]["label"] == "run2"
    assert report["label"] == "run2"
    # …and it named the artifacts, so the phrase "labelled `run2`" describes something real
    ids = {e["id"] for e in run.entries()}
    assert {"metadata-column:run2_score", "metadata-column:run2_call"} <= ids

    view = yaml.safe_load(_VIEW.read_text())
    run_action = next(a for a in view["actions"] if a["id"] == "dd.run")
    assert run_action["body"][0]["run_processor"]["params"]["label"] == "$state.label"


def test_the_name_disclosed_params_are_exactly_the_publication_critical_ones():
    """A param with no declared role is DISCLOSED BY NAME, never dropped:
    `declared_sentence` collects every recorded param key absent from `spec.params` and
    appends "Additional recorded parameters are NOT narrated here…".

    That is the DESIRED outcome for this analysis, not a gap: the numbers a publication must
    cite (the expected rate, the per-1k rate, the threshold, the PC count, the simulated
    ratio) have no closed role that could render them faithfully, and being named with a
    pointer to `manifest.json` is better than being paraphrased. This asserts the set is
    exactly what we expect, so a param added tomorrow shows up here rather than drifting
    into silence.
    """
    src = _METHODS_RS.read_text()
    assert "Additional recorded parameters are NOT narrated here" in src, (
        "the name-disclosure clause moved or was removed — a param with no role would now "
        "be DROPPED, which is the failure this test exists to make visible"
    )

    view = yaml.safe_load(_VIEW.read_text())
    run_action = next(a for a in view["actions"] if a["id"] == "dd.run")
    sent = set(run_action["body"][0]["run_processor"]["params"])
    declared = set(_methods()["params"])
    disclosed_by_name = sent - declared

    assert disclosed_by_name == {
        "batch_column", "expected_doublet_rate", "doublet_rate_per_1k", "threshold",
        "n_prin_comps", "sim_doublet_ratio",
    }, disclosed_by_name
    # `batch_column` in particular MUST reach the export: it is how a reader learns whether
    # the run was per-sample at all, and it has no closed role that could carry it.
    assert "batch_column" in disclosed_by_name


def test_the_methods_text_states_the_method_the_citation_and_the_trade():
    text = " ".join(_analysis()["methodsText"].split())
    assert "Scrublet" in text
    assert "Wolock" in text and "2019" in text          # the citation the licence asks for
    # The per-sample rule, stated CONDITIONALLY. The unconditional wording asserted
    # batching on every run, which is false on an unbatched one — a permitted, disclosed and
    # default state — and false again whenever `expected_doublet_rate` is set. This is the
    # one sentence the run panel shows, so it must not misstate the batching state.
    assert "When a sample column is bound" in text
    assert "independently within each of its levels" in text
    assert "an unbatched run is permitted" in text
    assert "not modified" in text and "no cells were removed" in text
    assert "Xi & Li 2021" in text                        # the accuracy trade, stated
    assert "scDblFinder" in text
    assert "Homotypic" in text or "homotypic" in text


def test_the_note_declares_the_three_things_a_reader_must_not_miss():
    """…and declares the per-sample rule CONDITIONALLY.

    `methods.rs` appends `note` verbatim with no batching branch, so an unconditional
    "scores are computed independently per sample" asserts, in the out-of-app trust
    deliverable, a method that did not run on any UNBATCHED run — which is permitted,
    disclosed, and the default. An earlier version of this test asserted the unconditional
    phrase and so PINNED the defect in place, while the sibling test immediately
    above was correcting exactly that wording in `methodsText`. The conditional form is asserted
    here so the two fields cannot drift apart again.
    """
    note = " ".join((_methods()["note"] or "").split())
    assert "Where a sample column was recorded" in note
    assert "independently within each of its samples" in note
    assert "where none was recorded, the matrix was scored as a single capture" in note
    assert "independently per sample" not in note, (
        "the note asserts per-sample scoring unconditionally again; it is appended verbatim "
        "to every run's methods paragraph, including unbatched ones")
    assert "FLAGS for inspection, not removals" in note
    assert "Homotypic" in note


def test_the_known_narrator_defect_is_recorded_rather_than_routed_around():
    """`methods.rs` has a shipped defect this package deliberately does NOT work around.

    Read the `head` branch: when `constraints` is EMPTY the narrator emits *"NOTE: no
    criteria were recorded for this run…"* and DROPS `spec.note` entirely. This analysis'
    only constraint-producing role is `criteria: predicate_list`, so an UNFILTERED
    doublet run — the common case — currently loses its per-sample note AND is told that no
    criteria were recorded, which is true but reads as a deficiency rather than as "this run
    scored every cell".

    The correct response is to declare honestly and let the parallel methods-narrator fix own
    the rendering. The WRONG response would be to invent a constraint-shaped param purely to
    keep the note alive, which would put a fiction in the trust deliverable. This test pins
    the defect so that (a) nobody "fixes" it inside this package, and (b) it goes red the day
    the narrator is fixed, at which point this test should be deleted.
    """
    src = _METHODS_RS.read_text()
    head = src.split("let head = if constraints.is_empty() {", 1)[1].split("};", 1)[0]
    empty_branch = head.split("} else {", 1)[0]
    assert "no criteria \\\n             were recorded" in empty_branch or \
        "no criteria" in empty_branch, empty_branch[:400]
    assert "spec.note" not in empty_branch, (
        "the narrator now renders `note` on a constraint-free run — the defect this test "
        "pins is FIXED. Delete this test and re-verify the exported methods.md."
    )
