#!/usr/bin/env python3
# ruff: noqa
"""TEST-9 [covers: ITEM-1] — the skeleton manifest is the shape the epic contracted for.

Every assertion reads the FILE (and, where the claim is about the rest of the tree, the
tree), so it goes red on the real artifact rather than on a restatement of it. This is a
TREE property, not a diff property, so — unlike `test_zero_src_app_diff.py` — it is NOT
gated on the introducing branch: it must keep asserting forever.

What it pins, and which decision each line belongs to:

  * `env: single-cell-r`, naming a recipe that EXISTS on disk (E6/ITEM-1, CONS-E6-4).
    Derived from `src-app/env-rootfs/`, never compared to a second hardcoded literal.
  * `run.runtime: rscript` + `run.entry` existing on disk (E6/ITEM-1).
  * NO `run.dependencies`, AND a version still recorded for every library the entry
    loads. The DECISION is stated in the manifest, beside the key it governs; how it was
    REACHED is in `DECISIONS.md` DEC-8. Neither is restated here.
  * NO contributed datatype / converter / section / view (E6/DEC-5, DEC-6) — the
    INV-5 surface, so E7 has nothing to bind to but E6's declared `Provides`.
  * `produces` naming only kinds that already exist (E6/DEC-5, DEC-9).
  * a NON-EMPTY `appliesTo` and `launchable: false` (E6/DEC-12) — the two halves that
    trade against each other, pinned together so neither can be dropped alone.
"""
import re
from pathlib import Path

import pytest
import yaml

#: The emitted-field prefix that distinguishes a LIBRARY's resolved version from the
#: interpreter's own (`r_version`, emitted unconditionally). Without the prefix, a check
#: for "some `*_version` field" is satisfied by R telling you what R is — mutation-proven
#: on the version that used a bare `<lib>_version` key. Shared with TEST-2, which asserts
#: the same prefix in the EMITTED BYTES.
LIB_VERSION_KEY = "lib_version:"

PKG = Path(__file__).resolve().parents[1]
REPO = PKG.parents[2]
MANIFEST = PKG / "manifest.yaml"


@pytest.fixture(scope="module")
def manifest():
    return yaml.safe_load(MANIFEST.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def analysis(manifest):
    analyses = manifest["contributes"]["analyses"]
    assert len(analyses) == 1, "the skeleton contributes exactly one analysis"
    return analyses[0]


def _recipe_ids() -> set[str]:
    """Every env id the recipe tree DECLARES, read off disk.

    Derived rather than typed: the assertion below must fail if the R recipe is renamed
    or removed, and must not fail merely because somebody typed the same string twice.
    """
    root = REPO / "src-app/env-rootfs"
    return {d.name for d in root.iterdir() if (d / "Dockerfile").is_file()}


def test_the_declared_env_names_a_recipe_that_exists(analysis):
    env = analysis.get("env")
    assert env, "the skeleton DECLARES an env — that declaration is what E6 exists to prove"
    assert env in _recipe_ids(), (
        f"`env: {env}` names no recipe under src-app/env-rootfs/ "
        f"(found: {sorted(_recipe_ids())}). The env registry is OPEN, so a typo resolves "
        f"to a repo that will never publish — it fails at PULL time on a user's job "
        f"instead of here.")
    # …and it is the R one, identified by a property of the RECIPE rather than by its
    # name: the recipe this analysis names must actually install an R interpreter.
    dockerfile = (REPO / "src-app/env-rootfs" / env / "Dockerfile").read_text(encoding="utf-8")
    assert re.search(r"^FROM\s+rocker/r-ver", dockerfile, re.MULTILINE), (
        f"`env: {env}`'s recipe is not built on an R base image, so an `rscript` entry "
        f"would have no interpreter there — the E6/INV-2 failure this analysis must not "
        f"be the cause of")


def test_the_run_block_is_the_r_shape(analysis):
    run = analysis["run"]
    assert run["kind"] == "sandbox"
    assert run["runtime"] == "rscript", (
        "the whole point: this is the first shipped contribution to declare an R runtime")
    entry = run["entry"]
    assert entry == "compute/skeleton.R"
    assert (PKG / entry).is_file(), f"`run.entry` names a file that is not on disk: {entry}"
    # The extension matters independently of `runtime`: `Language::from_code_ref` is the
    # FALLBACK the resolver uses when a manifest declares no usable runtime, and the two
    # must not disagree about what this file is.
    assert entry.endswith(".R")


def test_it_declares_no_dependency_contract_it_could_not_enforce(analysis):
    """The entry loads a library and declares NO dependency contract, on purpose.

    The decision is in the manifest, beside the key; how it was reached is in
    `DECISIONS.md` DEC-8. This docstring restates neither.

    What matters HERE is that BOTH halves are pinned, because either alone is satisfiable
    by the wrong thing: the contract is absent, AND the entry still records the resolved
    version of what it loads. A manifest that declared nothing while the entry recorded
    nothing either would pass the first assertion and lose the provenance the decision
    exists to keep.
    """
    assert not analysis["run"].get("dependencies"), (
        "the skeleton declares a `run.dependencies` contract; DEC-8 says it declares none, "
        "and the manifest states why beside the key.")

    # ── the OTHER half: what it loads, it must also RECORD ────────────────────────
    #
    # Scope, stated because the first two versions of this check over-claimed. This is a
    # SOURCE-level check and it cannot prove the artifact carries anything — the
    # ARTIFACT-level proof is TEST-2, which fetches the emitted bytes back through the
    # platform and asserts a version field is in them. What this adds is the mapping the
    # artifact test cannot see: that EVERY library the entry loads is one it also records.
    raw = (PKG / analysis["run"]["entry"]).read_text(encoding="utf-8")
    # Whole-line comments dropped. NOT a general comment strip: `line.split("#")[0]` would
    # cut a `#` inside a string literal, and this file emits HTML where a `#` is a
    # plausible character. A leading-`#` test cannot do that. The cost is that a TRAILING
    # comment on a code line still counts, which is stated rather than hidden.
    src = "\n".join(l for l in raw.splitlines() if not l.lstrip().startswith("#"))
    loaded = set(re.findall(r"(?:library|require)\(([A-Za-z][A-Za-z0-9._]*)\)", src))
    assert loaded, "the extraction found no `library(...)` call — the assertion below would be vacuous"
    for lib in loaded:
        assert f'packageVersion("{lib}")' in src, (
            f"the entry loads `{lib}` but never READS its resolved version, so nothing it "
            f"emits could carry one.")
        # The KEY, not the expression that fills it. Pinning `row(… packageVersion("x"))`
        # made a behaviour-preserving refactor — hoisting the value to a variable — turn
        # this red, which is a shape predicate rather than a check. The key survives that
        # refactor and still names the library, which is the mapping only a source check
        # can see. The BYTES are TEST-2's job.
        assert f'row("{LIB_VERSION_KEY}{lib}"' in src, (
            f"the entry reads `{lib}`'s version but emits no `{LIB_VERSION_KEY}{lib}` "
            f"field, so it reaches no artifact.")
        # …and the value it emits is not an INLINE LITERAL. Neither this check nor
        # TEST-2's can prove the emitted string IS the resolved version — the artifact
        # check sees a field, this one sees a key — so `row("lib_version:x", "0.0.0")`
        # would satisfy both while the artifact carried a FALSE provenance value.
        #
        # BOTH QUOTE STYLES. R treats '…' and "…" identically, and the first version of
        # this check matched only double quotes: an auditor bypassed it by changing one
        # character.
        #
        # WHAT THIS DOES NOT CATCH, stated here and not only in DECISIONS.md: a literal
        # assigned to a VARIABLE and emitted through it. That is the same tolerance that
        # lets a behaviour-preserving refactor (hoisting the value) pass, and no
        # source-level check can have one without the other. See DEC-8's table of which
        # mutations are caught — every row of it was run.
        assert not re.search(
            rf"""row\(\s*"{re.escape(LIB_VERSION_KEY + lib)}"\s*,\s*["']""", src), (
            f"the `{LIB_VERSION_KEY}{lib}` field is filled with an inline string literal. "
            f"Nothing downstream can tell a hardcoded version from a resolved one, so the "
            f"artifact would carry a provenance value that is simply false.")


def test_the_skeleton_contributes_no_new_vocabulary(manifest):
    """E6/DEC-5 + DEC-6 + INV-5 — the surface E7 is allowed to see."""
    contributes = manifest["contributes"]
    assert set(contributes) == {"analyses"}, (
        f"the skeleton contributes ONLY analyses; found {sorted(contributes)}. A datatype "
        f"would drag in the lattice cardinality assertion and check-kinds-zero-core.sh "
        f"(E6/DEC-5); a converter or a section would give E7 a shape to bind to (INV-5).")


def test_the_skeleton_declares_no_view(analysis):
    assert "ui" not in analysis, (
        "E6/DEC-6 — no view. An analysis with no `ui:` falls back to the generic form, "
        "which keeps the tracer bullet's diff inside the seams it tests.")


def test_produces_only_names_kinds_that_already_exist(analysis):
    """E6/DEC-5/DEC-9 — no new kind, and the one it emits is real.

    `report/html` is a CORE BUILTIN (`datatype/builtin.rs::report_html_dt`), so its
    existence is asserted against the Rust source that defines it rather than against a
    manifest — which is the only place a builtin kind IS declared.
    """
    produces = analysis["produces"]
    assert produces == ["report/html"], produces
    builtin = (REPO / "src-app/server/src/modules/datatype/builtin.rs").read_text(encoding="utf-8")
    for kind in produces:
        assert f'"{kind}"' in builtin, (
            f"`produces: {kind}` names no builtin datatype. If it is a CONTRIBUTED kind "
            f"this assertion is the wrong one; if it is neither, the run's outputs will "
            f"fail ingest.")


def test_it_satisfies_every_per_analysis_rule_the_repo_wide_fe_sweep_imposes(analysis):
    """TEST-11 — the new analysis cannot break the shipped FE conformance sweep.

    `src-app/ui/src/modules/workbench/core/spec/processorViewSpecs.test.ts` discovers every
    `src-app/packages/*/manifest.yaml` by `readdirSync` and applies a per-analysis case to
    each. A new package joins that sweep automatically, with no edit there — which is the
    good property, and also the reason a package can break a suite it never mentions.

    This asserts the same requirements from THIS package's side, one at a time, so the
    branch that adds the package owns a falsifiable statement of them rather than
    inheriting a green from a file it does not touch. The sweep itself is RUN in phase 8
    and its result recorded there, including the mutation (emptying `appliesTo` turns it
    red naming this analysis) that shows it really ranges over this package.

    Each rule below is the sweep's, restated with its consequence, not its wording:
      1. a NON-EMPTY `appliesTo` — an empty one is UNIVERSALLY available, not unavailable;
      2. every `ui:` entry names a file that exists — a missing one registers nothing;
      3. every SINGLE-VALUE input slot declares `auto_bind_sole_candidate` — without it a
         headless (agent/MCP) launch leaves that input unresolved. Multi-value slots are
         out of scope by definition and the sweep has its own negative control for that.
    """
    applies = analysis.get("appliesTo") or []
    assert applies, "rule 1: a shipped analysis declares a non-empty `appliesTo`"

    for entry in analysis.get("ui", []):
        assert (PKG / entry).is_file(), (
            f"rule 2: `ui:` names `{entry}`, which is not on disk — it would register nothing")

    for sel in applies:
        if not isinstance(sel, dict) or "slot" not in sel:
            continue  # not an input slot: a bare type/supertype selector binds no input
        if sel.get("multiple"):
            continue  # 0-or-more by definition; never auto-bound
        assert sel.get("auto_bind_sole_candidate") is True, (
            f"rule 3: single-value slot {sel.get('slot')!r} does not opt IN to the "
            f"sole-candidate bind, so a headless launch would leave it unresolved")
    # …and the vacuity floor for rule 3, which is the one that could silently apply to
    # nothing: this manifest declares no `slot` at all, so state that rather than let the
    # loop above pass by never executing.
    assert all("slot" not in s for s in applies if isinstance(s, dict)), (
        "this manifest now declares an input SLOT. Rule 3's loop above stops being vacuous "
        "at that moment — check it asserts what you meant before deleting this line.")


def test_it_is_applicable_but_not_advertised(analysis):
    """E6/DEC-12 — the two halves, pinned together.

    An EMPTY `appliesTo` means UNIVERSALLY available, not unavailable, so it is the
    loudest possible version of the thing it looks like it avoids. `launchable: false` is
    what actually keeps a deliberately meaningless probe out of the user's launcher.
    """
    applies = analysis.get("appliesTo") or []
    assert applies, "a non-empty `appliesTo` is required of every shipped analysis"
    assert analysis.get("launchable") is False, (
        "the skeleton stays registered and runnable but is NOT advertised in the picker")


def test_the_package_ships_no_helpers_to_stage(analysis):
    """E6/DEC-2 — an R entry is SELF-CONTAINED by contract.

    It receives its own package's declared `run.helpers` and nothing else. The skeleton
    declares none, so its `/code` directory holds exactly `entry.R`. Pinning it here is
    what makes the Rust-side staging assertion (TEST-6) a statement about a real shipped
    package rather than about a fixture.
    """
    assert not analysis["run"].get("helpers"), (
        "the skeleton declares no helpers; DEC-2's contract is that an R entry gets its "
        "own declared helpers and NOTHING from the app's python helper table")
