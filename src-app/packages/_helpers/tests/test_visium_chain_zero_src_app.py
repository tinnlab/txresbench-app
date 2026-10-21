#!/usr/bin/env python3
# ruff: noqa
"""#157 INV-7 — proving the chain-compatibility claim cost ZERO `src-app` production change.

`spatial-storage-layout.md` §10 opens with the sentence this file exists to make
machine-checkable:

    **For the Visium foundation: zero `src-app` changes.**

For the *importer* (#154) that was a claim about a new analysis. Here it is a stronger and
more surprising claim: that making a spatially-imported matrix run QC, filtering, embedding,
clustering and differential expression required no change to any of those analyses, to any
selector, to the server, or to either frontend. If it had — if one shipped `manifest.yaml`
had needed a spatial case, or one gate a spatial branch — then spatial data does NOT inherit
the existing analyses for free, and the epic's central bet is lost. That is why this is an
assertion and not a note.

## Honesty about what "zero" means here

This branch adds test files, and test files live under `src-app/`. So the guard asserts a
precise thing rather than a slogan: **every** changed path under `src-app/` falls inside one
of two NAMED directories, plus one NAMED file. Anything else is a failure. The report says
"zero `src-app` PRODUCTION changes, with test-only additions stated out loud", never "zero
changes".

**The two directories are not equivalent, and conflating them would understate the cost.**

* `src-app/server/tests/` is never built into anything. #154's own guard drew exactly this
  line: *"This branch changes no Rust outside `server/tests/`."*
* `src-app/packages/**/tests/` **ships**. `server/src/modules/extensions/embedded.rs`
  `include_dir!`s the whole `src-app/packages` tree into the server binary — and its build
  filter deliberately KEEPS `tests/*.py` — so this branch's package test code is embedded in
  the binary and extracted onto every provisioned host, which is also why the `_helpers`
  version bump is required. §10 sanctions a package's tests as part of the cost, so the
  claim survives; it is stated here rather than glossed, because "test-only" reads as
  "changes nothing that ships" and for this half that is not true.

## Why the exemptions are NAMED directories and not a prefix blessing

`docs/design/derived-guards.md` §5: a prefix exemption grants every future file under it the
same pass, so the guard stops describing the change it was written for. The two directories
above are the whole exemption, they are asserted one path at a time, and the second half of
the guard is a set of explicit REFUSALS (no shipped selector edit, nothing under the server's
`src/`, nothing in either UI workspace, no generated client) that no widening of the first
half can turn off.

## Two halves, because only one of them can be branch-scoped

The DIFF assertions below are necessarily a claim about THIS branch, and after this branch
merges they skip forever — which a blind audit correctly pointed out leaves INV-7 with no
standing coverage on main. So the durable half is split out into
`test_no_shipped_analysis_narrows_on_a_spatial_datatype`, which reads the shipped manifests
as data, needs no diff, and is armed on every branch for ever.

## Why the diff half is not vacuously green everywhere

Mirroring `_lib/zero_core_guard.py`'s derivation, the guard decides its own applicability
from the diff: it is armed only on the branch that ADDED this very file
(`git diff --diff-filter=A`), and elsewhere it SKIPS visibly with a stated reason. A guard
that reads `merge-base...HEAD` without that gate re-executes on every later branch and
asserts that THAT branch also touched nothing outside a package it has nothing to do with —
the exact false-red `derived-guards.md` was written to remove. A skip is a skip; it never
degrades into a pass.
"""
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "_lib"))
from zero_core_guard import (  # noqa: E402
    added_paths,
    changed_paths,
    diff_point,
    repo_root,
    require_introducing_file,
)

#: This file's own repo-relative path — the ADD-ONLY marker this guard is keyed on.
#: Derived from `__file__` rather than typed, so moving the file cannot silently disarm it.
_SELF = "src-app/packages/_helpers/tests/test_visium_chain_zero_src_app.py"

#: The ONLY `src-app/` paths this branch is permitted to touch.
#:
#: * `src-app/packages/**/tests/` — §10's stated cost for this arm: a pure-data package's
#:   TESTS. The suite that proves the chain and its harness.
#: * `src-app/server/tests/` — the Rust half (INV-6). Tests, never product code.
#:
#: Plus exactly one named FILE (`SANCTIONED_SRC_APP_FILES`).
#:
#: **This used to say `src-app/packages/` and that was a real hole**, found by a blind
#: audit: a branch that made the chain "work" by teaching a shipped COMPUTE a spatial
#: branch — `embedding/compute/_shared.py`, where the design's own cited
#: `structure.kind != "sparse_csc"` refusal lives — would have passed every assertion in
#: this file. Selectors are not the only place a consumer can learn it is spatial, and the
#: manifest refusal below closed only the selector half of the hole.
#:
#: A second audit then removed two MORE entries that were here and unused
#: (`spatial-import-visium/tests/`, `spatial-types/tests/`). A blessing that describes a
#: change the branch did not make is the prefix-exemption failure this file's own header
#: argues against — and the first of those two holds the committed vendor bundle every
#: assertion in the suite rests on, so it was precisely the directory where the evidence
#: could have been doctored without tripping anything. It is now an explicit REFUSAL.
SANCTIONED_SRC_APP_DIRS = (
    "src-app/packages/_helpers/tests/",
    "src-app/server/tests/",
)

#: The one non-test file this branch may move: the version bump
#: `scripts/check-processor-seed-versions.sh` demands the moment a file in that package
#: changes. Named individually, never by prefix.
SANCTIONED_SRC_APP_FILES = (
    "src-app/packages/_helpers/manifest.yaml",
)

#: Paths that must NOT move, one refusal at a time. Widening the allowlists above cannot
#: turn any of these off — that is the point of stating them separately
#: (`docs/design/derived-guards.md` §5).
#:
#: The `packages/` entries are the ones the audit added: a shipped analysis's `compute/`
#: or `ui/`, and the shared `_lib/` framework, are exactly where a spatial special-case
#: would go if somebody wanted the chain to pass by teaching it about space.
FORBIDDEN_PREFIXES = (
    # the server
    "src-app/server/src/",
    "src-app/server/build.rs",
    "src-app/server/build_helper/",
    "src-app/server/migrations/",
    "src-app/server/Cargo.toml",
    "src-app/server/Cargo.lock",
    # the frontends
    "src-app/ui/",
    "src-app/desktop/",
    "src-app/libs/",
    # the analysis environment
    "src-app/env-rootfs/",
    # the shared framework every package's output is judged against
    "src-app/packages/_lib/",
    "src-app/packages/_helpers/align.py",
    "src-app/packages/_helpers/alignment.py",
    "src-app/packages/_helpers/colsummary.py",
    "src-app/packages/_helpers/compute/",
    # the gates that enforce every invariant around this one
    "scripts/",
    ".github/",
    # the committed vendor bundle every assertion in this suite reads. The harness says it
    # "modifies nothing in it"; this is what makes that true rather than aspirational.
    "src-app/packages/spatial-import-visium/tests/fixtures/",
)

#: A shipped analysis's executable half. Any `compute/` or `ui/` directory under any
#: package is refused, matched as a SEGMENT so a package name is never hardcoded.
FORBIDDEN_PACKAGE_SEGMENTS = ("/compute/", "/ui/")


def _armed() -> tuple[Path, list[str]]:
    """`(repo_root, changed_paths)` on the introducing branch, else `pytest.skip`.

    Delegated to `zero_core_guard.require_introducing_file`, which is this body promoted
    into the module that exists to stop it being maintained per-copy. It was open-coded
    here and in `spatial-import-xenium/tests/test_zero_src_app_diff_boundaries.py`, and a
    third copy was about to be written in that package's `test_boundaries_long_table.py`
    — which is exactly how the git plumbing `zero_core_guard` replaced got triplicated and
    diverged in the first place. `_helpers` is a `_`-prefixed reserved folder, so the
    MANIFEST-keyed `require_introducing_branch` refuses it by design; the marker-keyed gate
    is the form that serves it, and this file's own path is the marker.

    The original copy's own sentence is passed through as `reason=` rather than dropped: a
    blind audit caught the first cut silently losing the INV-7 attribution, which is a
    de-duplication changing behaviour — a regression dressed as tidying. TEST-15 pins that
    a caller-supplied reason really reaches the skip message, and
    `test_this_modules_skip_still_names_INV_7` below pins that THIS call site still supplies
    one: a blind audit pointed out that testing the parameter proves nothing about the call
    that lost the sentence, and dropping the `reason=` here reproduced the regression with
    nothing red.
    """
    return require_introducing_file(
        _SELF, __file__,
        reason="INV-7 is a claim about THAT branch's diff, and asserting it against an "
               "unrelated branch is the false-red `docs/design/derived-guards.md` exists "
               "to remove.")


def test_this_modules_skip_still_names_INV_7():
    """The regression this module's `reason=` exists to prevent, pinned at the CALL SITE.

    Folding an open-coded gate into the shared helper dropped this module's own sentence
    from its skip message, so a `pytest -rs` summary stopped saying WHICH claim had stood
    down. Testing `require_introducing_file(reason=...)` in the abstract does not notice
    that; only driving THIS `_armed()` does. Written to hold in both directions: off the
    introducing branch it inspects the skip, and on that branch there is no skip to inspect
    and nothing here to check.
    """
    try:
        _armed()
    except pytest.skip.Exception as skipped:
        if _SELF not in str(skipped):
            # A DIFFERENT skip — `repo_root()` standing the guard down outside a git checkout,
            # which this module's own docstring calls the one honest reason a diff-scoped
            # guard cannot run. Reading that as a lost INV-7 attribution turned the tarball
            # case from six clean skips into a hard failure; a blind audit measured it.
            pytest.skip(f"not the gate's own skip, so there is no attribution to check: "
                        f"{skipped}")
        assert "INV-7" in str(skipped), (
            f"this module's skip no longer names the invariant it belongs to, so a reader "
            f"of `pytest -rs` cannot tell which claim stood down: {skipped}")


# ── TEST-7 [acceptance] [INV-7] ─────────────────────────────────────────────────────


def test_the_arming_marker_names_a_real_file():
    """UNGATED. A marker that names nothing is a guard switched off, not a branch skipped.

    `_SELF` is this module's own path and is the ONE input deciding whether any assertion
    here ever runs again. A blind audit repointed it at a nonexistent path and every guard in
    this file became permanently unarmable with the suite green — including
    `test_this_modules_skip_still_names_INV_7`, which asserts `_SELF in str(skipped)` and is
    satisfied by a bogus marker just as well as by a real one.
    """
    root = Path(__file__).resolve().parents[4]
    assert (root / _SELF).is_file(), (
        f"the arming marker `{_SELF}` names no file in this tree, so every guard in this "
        f"module can never run again on any branch.")


def test_no_src_app_path_outside_the_sanctioned_set_changed():
    """TEST-7 [acceptance] [invariant: INV-7] [covers: ITEM-11] — the positive half."""
    root, changed = _armed()
    src_app = [p for p in changed if p.startswith("src-app/")]
    assert src_app, (
        "this branch changed nothing under `src-app/` at all, so the assertion below "
        "would be vacuously true — INV-7 is a statement about a real, non-empty diff")

    unsanctioned = [p for p in src_app
                    if not any(p.startswith(d) for d in SANCTIONED_SRC_APP_DIRS)
                    and p not in SANCTIONED_SRC_APP_FILES]
    assert not unsanctioned, (
        f"this branch changed {len(unsanctioned)} `src-app/` path(s) outside the "
        f"sanctioned set — directories {list(SANCTIONED_SRC_APP_DIRS)} plus files "
        f"{list(SANCTIONED_SRC_APP_FILES)}:\n  "
        + "\n  ".join(sorted(unsanctioned))
        + "\n\nINV-7 (§10) says making a spatially-imported matrix run the existing chain "
          "costs ZERO `src-app` change. Each path above is a counter-example, and a "
          "counter-example here is the epic's headline finding, not a lint failure to "
          "waive.")

    # …and nothing OUTSIDE `src-app/` either, apart from the lifecycle artifacts (which
    # are stripped at merge). The refusals below name `scripts/` and `.github/`
    # explicitly, but a whitelist of the whole repo is the stronger statement: INV-7 is
    # "the existing chain needed NO change", and a branch that stayed green here while
    # rewriting a gate script or a workflow would satisfy the narrower reading.
    outside = [p for p in changed
               if not p.startswith("src-app/") and not p.startswith(".lifecycle/")]
    assert not outside, (
        "this branch changed repo paths outside `src-app/` and `.lifecycle/`:\n  "
        + "\n  ".join(sorted(outside)))


def test_no_production_surface_was_touched():
    """TEST-7 [acceptance] [invariant: INV-7] [covers: ITEM-11] — the refusals.

    Stated separately from the directory allowlist so that widening the allowlist cannot
    quietly authorise any of them.
    """
    _root, changed = _armed()
    assert changed, (
        "the branch diff is empty, so every refusal below would be evaluated zero times "
        "and this test would pass having asserted nothing")
    for path in sorted(changed):
        if path.startswith("src-app/packages/"):
            for segment in FORBIDDEN_PACKAGE_SEGMENTS:
                assert segment not in path, (
                    f"{path} is a shipped analysis's executable half. Teaching a `compute/` "
                    f"or a `ui/` view about space is exactly how the chain could be made to "
                    f"'pass' while INV-2 (\"Nothing needs to know it is spatial\") was false")
        for prefix in FORBIDDEN_PREFIXES:
            assert not path.startswith(prefix), (
                f"{path} is under {prefix!r}. The backwards-compatibility claim is that "
                f"the existing chain needed NO change; a production edit here means it did")
        assert not path.endswith("openapi.json"), (
            f"{path}: a regenerated client means a route or schema moved, which INV-7 forbids")
        assert not path.endswith("api-client/types.ts"), (
            f"{path}: a regenerated client means a route or schema moved, which INV-7 forbids")


def test_no_shipped_analysis_manifest_was_edited():
    """TEST-7 [acceptance] [invariant: INV-7] [covers: ITEM-11] — the SELECTOR refusal.

    The sharpest form of the claim, and the one the directory allowlist alone would let
    through: `src-app/packages/**` is sanctioned, and a shipped `manifest.yaml` lives
    there. So a branch could "prove" the chain runs on a spatial matrix by teaching one of
    the consumers to accept it — which is precisely the failure INV-2 forbids ("Nothing
    needs to know it is spatial") and would leave every other assertion in this suite
    green.

    Only `_helpers/manifest.yaml` may move, and only for the version bump
    `scripts/check-processor-seed-versions.sh` demands the moment a file in that package
    changes (TEST-12 asserts it did move, and by how little).
    """
    _root, changed = _armed()
    manifests = [p for p in changed
                 if p.startswith("src-app/packages/") and p.endswith("/manifest.yaml")]
    assert manifests == ["src-app/packages/_helpers/manifest.yaml"], (
        f"this branch edited package manifest(s) {manifests}. A shipped analysis manifest "
        f"is where a selector lives; editing one to make the spatial matrix resolve is the "
        f"exact reframing INV-2 forbids. The ONLY permitted manifest edit is the "
        f"`_helpers` version bump the seed reconciliation requires.")


# ── TEST-12: registration ───────────────────────────────────────────────────────────


def _version_of(text: str) -> str:
    for line in text.splitlines():
        if line.startswith("version:"):
            return line.split(":", 1)[1].strip().strip('"').strip("'")
    raise AssertionError("no `version:` line in the manifest")


def test_the_helpers_package_version_moved_forward():
    """TEST-12 [covers: ITEM-12].

    `scripts/check-processor-seed-versions.sh` refuses a seed package whose files moved
    without a `version` bump, because an already-provisioned deployment skips re-extraction
    at an unchanged version. Asserted HERE as well as there so that the suite fails with
    the reason, rather than a gate script failing later with the diff.

    Armed on any branch that touches `_helpers`, not only this one — the property is
    durable and the next branch to add a helper should inherit the check.
    """
    root = repo_root()
    changed = changed_paths(root)
    if not any(p.startswith("src-app/packages/_helpers/") for p in changed):
        pytest.skip("this branch does not touch `_helpers`, so it owes no version bump")

    import subprocess

    manifest = "src-app/packages/_helpers/manifest.yaml"
    before = subprocess.run(
        ["git", "show", f"{diff_point(root)}:{manifest}"],
        cwd=root, capture_output=True, text=True, check=True).stdout
    after = (root / manifest).read_text()

    old, new = _version_of(before), _version_of(after)
    assert old != new, (
        f"`_helpers` files changed but its version stayed {old!r}; a provisioned host "
        f"would keep running the old extraction")
    old_parts = tuple(int(x) for x in old.split("."))
    new_parts = tuple(int(x) for x in new.split("."))
    assert new_parts > old_parts, f"`_helpers` version went backwards: {old} -> {new}"

    # …AND NOTHING ELSE IN THE FILE MOVED. This is the one non-test file the branch is
    # allowed to touch, and "only the version bump" was the stated reason that is safe —
    # but nothing checked it. `_helpers` ships `contributes: {}` today; a branch could add
    # `contributes.analyses` (a real production surface) here and pass every other
    # assertion in this file, including the two above, which only compare version numbers.
    def _without_version(text: str) -> list[str]:
        return [line for line in text.splitlines() if not line.startswith("version:")]

    assert _without_version(before) == _without_version(after), (
        "`_helpers/manifest.yaml` changed by more than its `version:` line. That file is "
        "sanctioned ONLY for the seed-reconciliation bump; anything else in it is a "
        "production surface and INV-7 forbids it.")


def test_every_test_module_this_branch_adds_is_collected_by_something():
    """TEST-12 [covers: ITEM-12] — the "collected by nothing" trap.

    `packages/pytest.ini`'s `testpaths` is a hand ENUMERATION, and its own header records
    what that costs: a package whose suite is not listed is collected by NOTHING, and no
    test COUNT can detect that. This branch relies on `_helpers/tests` already being
    listed — so it makes no `pytest.ini` edit at all, and asserts the reliance instead of
    trusting it.
    """
    root, changed = _armed()
    testpaths = None
    for line in (root / "src-app/packages/pytest.ini").read_text().splitlines():
        if line.startswith("testpaths"):
            testpaths = line.split("=", 1)[1].split()
            break
    assert testpaths, "packages/pytest.ini declares no `testpaths`"

    added = [p for p in added_paths(root)
             if p.startswith("src-app/packages/") and Path(p).name.startswith("test_")]
    assert added, "this branch added no package test module — TEST-12 would be vacuous"
    for path in added:
        relative = path[len("src-app/packages/"):]
        assert any(relative.startswith(tp.rstrip("/") + "/") or relative.startswith(tp)
                   for tp in testpaths), (
            f"{path} is in no directory named by `testpaths` {testpaths} — it would be "
            f"collected by nothing, and a gate that cannot run is indistinguishable from "
            f"a gate that passes")


# ── the DURABLE half: armed on every branch, for ever ───────────────────────────────


#: The prefix that makes a datatype id spatial. Spelled ONCE — the scan below asks it four
#: different questions and a fifth was one typo away from asking a different one.
_SPATIAL_PREFIX = "spatial/"


def _is_spatial(value) -> bool:
    return isinstance(value, str) and value.startswith(_SPATIAL_PREFIX)


def is_spatial_arm(doc: dict, analysis: dict) -> bool:
    """Does `analysis`, in the package described by `doc`, belong to the SPATIAL ARM?

    Answered about the analysis OBJECT, never about its id: two analyses can both be
    missing an `id` (a malformed manifest is exactly when a guard must not get confused
    about which one it exempted), and an id-keyed exemption set would then exempt both.

    ## Why this is derived and no longer a list of package names

    It was `spatial_arm = {"spatial-types", "spatial-import-visium", "spatial-import-xenium"}`
    — a hand-maintained snapshot of the tree at the moment it was typed. It went stale in
    silence the day `spatial-import-visium-hd` (#313) was created: a fourth spatial importer,
    in no set, so the scan below treated its `spatial.import-visium-hd` analysis as a
    GENERAL-PURPOSE one and reported the epic's headline finding against the one package
    whose whole job is to name a spatial bundle. That is the #303/#324 class — a guard
    enumerating what it could derive — and adding a fourth name would have repaired the
    instance and left the mechanism.

    ## What actually defines the spatial arm, as a property of the manifest

    An analysis is in the spatial arm iff it PRODUCES a `spatial/*` artifact; a package is
    iff it DECLARES `spatial/*` datatypes (that is `spatial-types`, the vocabulary itself,
    which contributes no analysis at all — it is derived rather than special-cased so that
    the day it does contribute one, the answer is already right).

    That is deliberately not "the package name starts with `spatial-`". A prefix blessing
    grants every future file under it the same pass — this module's own header, and
    `docs/design/derived-guards.md` §5 — and a name is not a property of the artifact graph.
    Emitting a `spatial/*` store is.

    ## Why an exemption keyed on `produces` is not a way out

    The claim under test is "a general-purpose analysis had to learn about space". An
    analysis that reaches for this exemption must declare that it EMITS spatial artifacts,
    which is a strictly louder statement than the one it was trying to avoid making: the
    datatype registry routes on it, `spatial-types` has to declare the kind for it to name,
    and the producer's own end-to-end suite has to write one. `de.compare` cannot quietly
    claim to produce `spatial/image`. The exemption is not a waiver, it is a different and
    more falsifiable assertion — which is the trade `derived-guards.md` asks for.

    THE DERIVATION IS STRICTLY TIGHTER THAN THE LIST IT REPLACES, and that is worth stating
    because a derivation usually is not. The old set exempted EVERY analysis in a spatial
    package; this exempts only the analyses that produce spatial output. A second,
    non-producing analysis added to `spatial-import-xenium` that narrowed on `spatial/*` was
    waved through before and is caught now.
    """
    contributes = doc.get("contributes") or {}
    if any(_is_spatial((datatype or {}).get("id"))
           for datatype in contributes.get("datatypes") or []):
        return True
    return any(_is_spatial(produced) for produced in analysis.get("produces") or [])


def spatial_narrowings(analysis: dict) -> list:
    """Every place `analysis` NAMES a spatial datatype in its input declaration.

    The observable form of "an existing analysis learned about space": narrowing an input
    slot on a `spatial/*` type, excluding one, or consuming one.
    """
    named = []
    for slot in analysis.get("appliesTo") or []:
        for key in ("type_id", "subtypes_of"):
            if _is_spatial(slot.get(key)):
                named.append(f"{slot.get('slot')}.{key}={slot.get(key)}")
        for excluded in slot.get("excludes") or []:
            if _is_spatial(str(excluded)):
                named.append(f"{slot.get('slot')}.excludes={excluded}")
    for consumed in analysis.get("consumes") or []:
        if _is_spatial(str(consumed)):
            named.append(f"consumes={consumed}")
    return named


def scan_for_spatial_narrowing(packages_dir: Path) -> tuple[dict, int]:
    """`({analysis id: [narrowings]}, analyses examined)` over every manifest under `packages_dir`.

    Split out from the assertion so the SAME scan can be pointed at a fictional tree — see
    `test_a_fictional_new_spatial_importer_is_exempt_without_editing_any_list`. A guard whose
    subject is derived is only as good as the derivation, and the only way to show a
    derivation notices a new package is to give it one.
    """
    import yaml

    offenders, checked = {}, 0
    for manifest in sorted(Path(packages_dir).glob("*/manifest.yaml")):
        doc = yaml.safe_load(manifest.read_text(encoding="utf-8")) or {}
        for analysis in ((doc.get("contributes") or {}).get("analyses") or []):
            if is_spatial_arm(doc, analysis):
                continue
            checked += 1
            named = spatial_narrowings(analysis)
            if named:
                offenders[f"{manifest.parent.name}/{analysis['id']}"] = named
    return offenders, checked


def test_no_shipped_analysis_narrows_on_a_spatial_datatype():
    """TEST-7 [acceptance] [invariant: INV-7] [covers: ITEM-11] — the permanent half.

    Every assertion above reads this branch's DIFF, so all of them skip once the branch
    merges and INV-7 would then have no standing coverage on main — a later branch could
    add a spatial special-case to a shipped analysis and trip nothing. This test is the
    durable complement: it reads the shipped `manifest.yaml` files as DATA, needs no diff,
    and is armed everywhere.

    What it forbids is the observable form of "an existing analysis learned about space":
    a shipped analysis (one that is NOT part of the spatial arm) narrowing an input slot on
    a `spatial/*` datatype, or excluding one, or declaring one in `consumes`. §9's promise
    is that spatial rides in as an ORDINARY `single-cell/counts` matrix; the moment a
    general-purpose analysis has to name a spatial type to accept or reject it, that
    promise is gone whatever this branch's diff said at the time.

    WHICH ANALYSES ARE THE SPATIAL ARM IS DERIVED, NOT LISTED — see `is_spatial_arm`
    for why, and for what a hand list of three package names cost when a fourth landed.
    """
    offenders, checked = scan_for_spatial_narrowing(
        Path(repo_root()) / "src-app" / "packages")

    assert not offenders, (
        f"{len(offenders)} shipped analysis/analyses name a spatial datatype in their input "
        f"declaration: {offenders}. §9's promise is that a spatial dataset's matrix rides in "
        f"as an ordinary `single-cell/counts` store and that NOTHING needs to know it is "
        f"spatial; an analysis that has to name a `spatial/*` type to accept or reject one "
        f"has already broken that.")

    # THE FLOOR, and it is what fail-closes the derivation in its dangerous direction. A
    # derivation that started exempting EVERYTHING would report zero offenders and pass — so
    # the count of analyses actually examined is asserted, and a spatial-arm rule that had
    # swallowed the general-purpose packages could not reach five.
    assert checked >= 5, (
        f"only {checked} non-spatial analyses were examined, so this scan is close to "
        f"vacuous — either the package layout has changed and this test must be re-derived, "
        f"or `is_spatial_arm` has widened until it exempts the tree.")


#: A FICTIONAL sibling package, shaped exactly like a spatial importer and belonging to no
#: branch: it is a package the guard was never told about, which is the whole point.
_FICTIONAL_SPATIAL_IMPORTER = {
    "id": "spatial-import-fictional",
    "version": "0.1.0",
    "apiVersion": "1.0",
    "contributes": {"analyses": [{
        "id": "spatial.import-fictional",
        # It NARROWS on a spatial bundle — the exact act the guard forbids a general-purpose
        # analysis — and it PRODUCES spatial artifacts, which is what makes it the arm.
        "appliesTo": [{"slot": "bundle", "type_id": "spatial/fictional-bundle"}],
        "produces": ["single-cell/counts", "spatial/coordinates", "spatial/image"],
    }]},
}

#: The same narrowing, in an analysis that produces NOTHING spatial — a general-purpose
#: analysis that learned about space. Its package name is spatial-looking on purpose: under
#: the hand list this was exempt, and it must not be now.
_FICTIONAL_GENERAL_ANALYSIS = {
    "id": "spatial-import-fictional",
    "version": "0.1.0",
    "apiVersion": "1.0",
    "contributes": {"analyses": [{
        "id": "fictional.cluster",
        "appliesTo": [{"slot": "matrix", "subtypes_of": "single-cell/expression",
                       "excludes": ["spatial/coordinates"]}],
        "produces": ["metadata-column", "report/qc"],
    }]},
}


@pytest.mark.parametrize(
    "manifest,expected_offenders",
    [(_FICTIONAL_SPATIAL_IMPORTER, 0), (_FICTIONAL_GENERAL_ANALYSIS, 1)],
    ids=["a-new-spatial-importer-is-exempt", "a-new-general-analysis-is-caught"])
def test_a_fictional_new_spatial_importer_is_exempt_without_editing_any_list(
        tmp_path, manifest, expected_offenders):
    """The MECHANISM, not the instance (#303/#324, third and fourth occurrence).

    The spatial arm used to be three package names typed into this function. A row-adding
    repair is green the day it lands and stale the day the next package lands, which is
    exactly what happened when `spatial-import-visium-hd` was created. So the proof that the
    mechanism is fixed cannot be "the fourth name is there now". It is this: a package that
    exists in NO list and that no branch has ever mentioned gets the right answer the moment
    its `manifest.yaml` exists — and, in the second leg, gets the OPPOSITE answer when it is
    spatial in name only, which the hand list could never have distinguished.
    """
    import yaml

    packages = tmp_path / "packages"
    packages.mkdir()
    package = packages / manifest["id"]
    package.mkdir()
    (package / "manifest.yaml").write_text(yaml.safe_dump(manifest), encoding="utf-8")

    offenders, checked = scan_for_spatial_narrowing(packages)
    assert len(offenders) == expected_offenders, (
        f"a fictional package with no entry in any list produced {offenders}, expected "
        f"{expected_offenders} offender(s). The spatial arm is decided by what a manifest "
        f"DECLARES, not by a name somebody remembered to add.")
    assert checked == (0 if expected_offenders == 0 else 1), (
        f"expected the derivation to examine {'no' if expected_offenders == 0 else 'one'} "
        f"analysis here, it examined {checked}")
