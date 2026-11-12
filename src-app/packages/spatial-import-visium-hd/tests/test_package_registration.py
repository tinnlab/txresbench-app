#!/usr/bin/env python3
# ruff: noqa
"""TEST-26 / TEST-27 / TEST-28 — this package is RESOLVABLE, LOGGED and COLLECTED.

Three claims that have nothing to do with what the importer computes and everything to do
with whether it ever runs, or whether anything ever checks that it did:

* **TEST-26 — it RESOLVES.** `server/build_helper/processor_manifest.rs` reads every
  `run.dependencies[]` this manifest declares and resolves it against
  `env-rootfs/<env>/requirements.txt` AT BUILD TIME, so an absent library or a range the
  pin falls outside fails `cargo check` rather than a user's sandbox job. The same question
  is asked here, where the failure names the dependency and the pin instead of naming a
  manifest. Its siblings: every declared `run.helpers` entry exists on disk, and every
  module the entry or a helper imports BY BARE NAME is one the platform really stages —
  because `/code` is assembled from those two tables ALONE and an unstaged module is
  `ModuleNotFoundError` at process start, which reaches the server as an opaque job
  failure with no hint of the cause.

* **TEST-27 — the bump is LOGGED.** `scripts/check-processor-seed-versions.sh` keys
  re-extraction on `version:`, so the number is load-bearing; this repo's convention is
  that it never moves without a changelog entry naming the issue that moved it. The exact
  shape `spatial-import-visium/tests/test_refusal_escaping.py::test_TEST_14` enforces on
  the sibling, mirrored here.

* **TEST-28 — it is COLLECTED.** `packages/pytest.ini`'s `testpaths` is an ENUMERATION.
  Its own header states the consequence in words: a package whose suite is not listed
  there "is collected by NOTHING" — and a gate that cannot run is indistinguishable from a
  gate that passes. No test COUNT can detect it either, because the count is measured from
  `testpaths` too.

## Every read here names `encoding="utf-8"`

Not decoration. `manifest.yaml` is full of em dashes, `µm` and `§`; `requirements.txt` and
`pytest.ini` carry them too. Under `LC_ALL=C` a locale-default `read_text()` raises or
mis-decodes, and a guard that dies on the read of the thing it is guarding is a guard that
goes green on a real regression the moment somebody wraps it in a `try`. #330 / #333 /
#336 / #339 are four separate landings of that same defect in this tree.
"""
import ast
import json
import re
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sandbox_code_dir as SCD  # noqa: E402

PKG = Path(__file__).resolve().parents[1]
PACKAGES = PKG.parent
SRC_APP = PACKAGES.parent
MANIFEST = PKG / "manifest.yaml"
PYTEST_INI = PACKAGES / "pytest.ini"
ENV_ROOT = SRC_APP / "env-rootfs"
BUILD_GATE = SRC_APP / "server" / "build_helper" / "processor_manifest.rs"

#: This package's one analysis. Spelled once, asserted everywhere.
ANALYSIS_ID = "spatial.import-visium-hd"

#: The issue this package's only release is for. TEST-27's subject.
ISSUE = "#313"

#: The operator subset `processor_manifest.rs::version_satisfies` implements, TWO-CHARACTER
#: FIRST so `>=` is never read as `>` followed by `=2.0` — the same ordering
#: `split_operator` uses, and for the same reason.
#:
#: The build gate is hand-written because `build.rs` cannot reach the reference version
#: library, and it FAILS CLOSED: a wildcard, a compatible-release operator (`~=`), an
#: epoch, a local version or a pre-release suffix is an ERROR naming the specifier, never a
#: silent pass. `packaging.specifiers` accepts all of those. So a range checked ONLY with
#: `packaging` could be satisfied here and refused at `cargo check` — which is a red build
#: for everyone with a green suite in the package that caused it. Both halves are asserted.
GATE_OPERATORS = ("==", "!=", ">=", "<=", ">", "<")

#: What the gate can compare: purely dotted digits, nothing else (`parse_release_in`).
GATE_RELEASE = re.compile(r"\d+(?:\.\d+)*")


def manifest_doc():
    """The manifest, parsed. `yaml.safe_load`, and the read names its encoding."""
    return yaml.safe_load(MANIFEST.read_text(encoding="utf-8"))


def the_analysis(doc=None):
    """This package's single analysis contribution, found by id rather than by index."""
    doc = doc if doc is not None else manifest_doc()
    analyses = doc["contributes"]["analyses"]
    hits = [a for a in analyses if a["id"] == ANALYSIS_ID]
    assert len(hits) == 1, (
        f"expected exactly one analysis with id {ANALYSIS_ID!r}, found "
        f"{[a.get('id') for a in analyses]}"
    )
    return hits[0]


def _bare_imports(path):
    """`{module: first line}` for every module `path` imports by TOP-LEVEL name.

    Parsed with `ast`, never grepped. A substring predicate over source text cannot tell an
    import from a comment, a docstring or a variable name — the sibling package records that
    exact false positive, on a comment explaining why a library is deliberately unused.

    Relative imports (`level > 0`) are skipped deliberately: `/code` is FLAT, there is no
    package for a relative import to resolve against, and a compute that contained one would
    fail on its own rather than on a staging question.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    out = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                out.setdefault(alias.name.split(".")[0], node.lineno)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            out.setdefault(node.module.split(".")[0], node.lineno)
    return out


# ── TEST-26: the manifest resolves, the way the BUILD resolves it ───────────────────


def test_TEST_26_every_declared_dependency_is_PINNED_and_INSIDE_its_declared_range():
    """TEST-26 — the build gate's own question (#80 / INV-1), asked where the answer is readable.

    WHAT THIS WOULD CATCH. A declaration for a library the `single-cell` recipe does not
    install (`cargo check` fails for everyone, naming a manifest and not this package); a
    range the shipped pin falls OUTSIDE, which is the same red build with a subtler cause;
    the same library declared twice with two ranges, which the gate refuses as ambiguous;
    an empty range, which would let ANY installed version satisfy the declaration and is the
    exact state #80's gate exists to remove. And, one step beyond what `packaging` alone
    would notice: a range spelled in PEP 440 grammar the hand-written build comparator
    refuses — `~=2.2`, `==2.*`, `>=2.0rc1` — each of which `packaging.specifiers` accepts
    happily and `processor_manifest.rs::version_satisfies` turns into a build ERROR.

    The pins are read through `_lib/env_pins.pins()`, the parse the gate itself exports,
    NOT through a local `re.findall` over `requirements.txt`. That was TEST-P15's finding
    (#214/#215): the ad-hoc reader's `[^\\s#]+` version capture stopped at U+001C-1F where
    the gate's did not, so a version could be TRUNCATED here and then satisfy a range check
    against a PREFIX of the real pin — reporting a declaration satisfied that the gate would
    refuse. One parse, one answer.

    Distribution names are folded PEP 503-style (`txr_deps.normalize_name`, which mirrors
    `normalize_dist_name` exactly), because an index treats `Pillow`, `pillow` and
    `pil-low`... does not, but does treat `foo.bar`/`foo_bar`/`foo-bar` as one distribution,
    and a declaration must not be rejected over a hyphen.
    """
    import txr_deps
    import env_pins
    from packaging.specifiers import SpecifierSet
    from packaging.version import Version

    analysis = the_analysis()
    env = analysis["env"]
    recipe = ENV_ROOT / env
    assert (recipe / "requirements.txt").is_file(), (
        f"the analysis declares `env: {env}` and {recipe / 'requirements.txt'} does not "
        "exist — the build gate resolves this manifest's dependencies against that recipe "
        "and would refuse the package outright"
    )

    pins = {p["name"]: p for p in env_pins.pins(env, env_root=ENV_ROOT)}
    assert pins, f"the exported parse returned no pins for the `{env}` recipe"

    declared = analysis["run"]["dependencies"]
    assert declared, (
        "this compute imports numpy/pandas/h5py/pyarrow/tifffile/PIL; a `run.dependencies` "
        "that declared none of them would ship an unrecorded contract into a user's sandbox"
    )

    seen = {}
    for dep in declared:
        raw = dep["library"]
        assert str(raw).strip(), f"a dependency declares an empty library name: {dep!r}"
        lib = txr_deps.normalize_name(raw)
        assert lib, (
            f"the library name {raw!r} folds to nothing under the PEP 503 rule the build "
            "gate applies, which the gate refuses by name"
        )
        assert lib not in seen, (
            f"`{lib}` is declared twice ({seen[lib]!r} and {raw!r}) — two ranges for one "
            "library is ambiguous and the build gate refuses it; state one range"
        )
        seen[lib] = raw

        assert lib in pins, (
            f"`{raw}` is declared but the `{env}` recipe does not pin it. Add it to "
            f"{recipe / 'requirements.txt'} (following the republish runbook) or drop the "
            "declaration — as it stands `cargo check` fails for everyone."
        )

        spec = str(dep["version"])
        clauses = [c.strip() for c in spec.split(",") if c.strip()]
        assert clauses, (
            f"`{raw}` declares the empty range {spec!r} — an empty range lets any installed "
            "version satisfy the declaration, which is the state the gate exists to remove"
        )
        for clause in clauses:
            op = next((o for o in GATE_OPERATORS if clause.startswith(o)), None)
            assert op is not None, (
                f"`{raw}`'s clause {clause!r} uses an operator outside the set the build "
                f"gate implements {GATE_OPERATORS} — it fails closed on a grammar it "
                "cannot interpret exactly, so this is a BUILD error, not a lax range"
            )
            rhs = clause[len(op):].strip()
            assert GATE_RELEASE.fullmatch(rhs), (
                f"`{raw}`'s clause {clause!r} compares against {rhs!r}, which is not a "
                "purely dotted-numeric release — the build gate refuses wildcards, epochs, "
                "local versions and pre-release suffixes rather than guessing at them"
            )

        installed = pins[lib]["version"]
        assert Version(installed) in SpecifierSet(spec), (
            f"{lib}=={installed} (pinned at {recipe / 'requirements.txt'}:"
            f"{pins[lib]['line']}) falls OUTSIDE the declared range {spec} — the build gate "
            "resolves this pair at `cargo check` time and refuses it"
        )

    # The gate this mirrors must still exist and still be the thing that asks. If it were
    # deleted or renamed, every assertion above would keep passing while nothing enforced
    # them at build time any more.
    assert BUILD_GATE.is_file(), (
        f"{BUILD_GATE} is gone — this test mirrors a build-time gate that no longer exists, "
        "so the declarations above are now checked ONLY here and only when this suite runs"
    )
    gate = BUILD_GATE.read_text(encoding="utf-8")
    assert "lint_declared_dependencies" in gate and "version_satisfies" in gate, (
        "the build gate no longer spells `lint_declared_dependencies` / `version_satisfies`; "
        "this test's model of what the build checks is stale"
    )


def test_TEST_26_every_declared_helper_EXISTS_and_every_bare_import_is_STAGED():
    """TEST-26 — `/code` is assembled from two tables ALONE, and this is both of them.

    WHAT THIS WOULD CATCH. A `run.helpers` entry whose file was renamed or moved (production
    stages nothing for it and the entry dies with `ModuleNotFoundError` at process start —
    an opaque job failure, not a degraded import); a compute that grew `import
    <some_sibling>` without the manifest growing the matching helper line; and an import of
    an app-wide module that the platform does NOT globally stage, which is the same death by
    a different door.

    The global list is DERIVED, never typed here: `sandbox_code_dir.py_helper_files()`
    parses `PY_HELPER_FILES` out of `server/src/modules/sandbox/processors/mod.rs`, and it
    RAISES rather than returning `[]` when the table moves. A hardcoded copy would be a
    second spelling of a fact the platform owns, and the two would drift — silently, in the
    direction of this test passing.

    A bare name that is neither stdlib nor one of THIS analysis's declared dependencies and
    neither staged nor declared is reported as a failure here rather than in a sandbox,
    which is the whole point: the one thing this check can see that a user's job cannot is
    the manifest that was supposed to declare it.
    """
    import env_pins

    analysis = the_analysis()
    run = analysis["run"]

    entry_rel = run["entry"]
    assert (PKG / entry_rel).is_file(), (
        f"`run.entry` names {entry_rel!r}, which does not exist under {PKG}"
    )

    helpers = list(run["helpers"])
    assert helpers, "this compute imports three siblings; declaring none would stage none"
    for rel in helpers:
        assert (PKG / rel).is_file(), (
            f"`run.helpers` declares {rel!r} but {PKG / rel} does not exist — the sandbox "
            "would stage nothing for it and the entry would die at process start"
        )

    # The manifest's own list, and the list the staging model reads out of it, must agree.
    # `declared_helpers` is a deliberately small YAML reader scoped to `run:`; if it and
    # `yaml.safe_load` ever disagreed, every suite that models `/code` would be modelling a
    # different sandbox from the one this test just checked.
    assert sorted(helpers) == SCD.declared_helpers(PKG), (
        f"`yaml.safe_load` reads helpers {sorted(helpers)} and `sandbox_code_dir."
        f"declared_helpers` reads {SCD.declared_helpers(PKG)} — the staging model and the "
        "manifest have diverged"
    )

    staged_globally = {Path(staged).stem for staged, _pkg, _rel in SCD.py_helper_files()}
    assert staged_globally, "`PY_HELPER_FILES` parsed to nothing"
    declared_modules = {Path(rel).stem for rel in helpers}

    # The IMPORT names of the libraries THIS analysis declares — not every pin in the
    # recipe. A distribution name is not an import name (`pillow` -> `PIL`), and scoping to
    # the declared set is what makes an UNDECLARED third-party import fail below instead of
    # being waved through because the recipe happens to install it.
    pins = {p["name"]: p for p in env_pins.pins(analysis["env"], env_root=ENV_ROOT)}
    import txr_deps

    third_party = {
        pins[txr_deps.normalize_name(d["library"])]["import"]
        for d in run["dependencies"]
        if txr_deps.normalize_name(d["library"]) in pins
    }
    stdlib = set(sys.stdlib_module_names)

    unstaged = {}
    for rel in [entry_rel, *helpers]:
        for name, lineno in _bare_imports(PKG / rel).items():
            if name in stdlib or name in third_party:
                continue
            if name in declared_modules or name in staged_globally:
                continue
            unstaged[f"{rel}:{lineno}"] = name
    assert not unstaged, (
        f"these modules are imported by bare name and are neither stdlib, nor a declared "
        f"dependency of this analysis, nor a declared `run.helpers` sibling "
        f"({sorted(declared_modules)}), nor globally staged by `PY_HELPER_FILES` "
        f"({sorted(staged_globally)}): {unstaged}. `/code` is assembled from those tables "
        "alone, so each one is a `ModuleNotFoundError` at process start in production."
    )

    # POSITIVE CONTROL. The loop above is a filter, and a filter over an empty set passes.
    # These three names are the reason `run.helpers` exists at all and these three are from
    # `_lib`; if the entry stopped importing them the check above would go quietly vacuous.
    entry_imports = set(_bare_imports(PKG / entry_rel))
    assert declared_modules <= entry_imports | set().union(
        *[set(_bare_imports(PKG / rel)) for rel in helpers]
    ), (
        f"a declared helper {sorted(declared_modules - entry_imports)} is imported by "
        "NOTHING in the staged set — the manifest stages a module no code asks for"
    )
    assert {"txr_columns", "txr_csc", "txr_deps"} <= entry_imports, (
        "the entry no longer imports the `_lib` modules this check is calibrated on; the "
        f"staged-vs-declared assertion above may now be measuring nothing (imports: "
        f"{sorted(entry_imports)})"
    )


def test_TEST_26_the_manifest_declares_its_TOP_LEVEL_identity():
    """TEST-26 — `id`, `name`, `publisher`, `version`, `apiVersion`: the package's own identity.

    WHAT THIS WOULD CATCH, and did. The first draft of this manifest had NONE of `id`, `name`
    or `publisher` — the whole file was a comment block, then `version:`. The python suite was
    entirely green, `check-processor-seed-versions.sh` was clean (a branch-born package is
    exempt from it), and the package would not have loaded AT ALL:

        packages/spatial-import-visium-hd/manifest.yaml: malformed manifest --
        missing field `id` at line 152 column 1

    That came out of `cargo check -p txresbench`, i.e. from `server/build.rs`'s
    processor-manifest gate, which is the only thing in the tree that had an opinion. A gate
    that lives only in the Rust build is a gate a python-only iteration never runs, and the
    failure it catches is total: no analysis, no contribution, nothing offered.

    So the identity is asserted HERE too. Not as a substitute for the build gate — as the
    check that fires in the loop this package is actually developed in.

    `id` is asserted as an EQUALITY against the DIRECTORY NAME, because that is the coupling
    `extensions/embedded.rs` relies on: it extracts the tree and the loader SCANS the folder,
    so a package whose declared id disagrees with its directory is two identities for one
    thing.
    """
    manifest = manifest_doc()
    assert manifest.get("id") == PKG.name, (
        f"the manifest declares id {manifest.get('id')!r} but lives in {PKG.name!r}; "
        "`embedded.rs` extracts by directory and the loader scans the folder, so the two "
        "must be one identity"
    )
    assert manifest.get("publisher") == "txr"
    name = manifest.get("name")
    assert isinstance(name, str) and name.strip(), "the package declares no `name`"
    assert manifest.get("apiVersion") == "1.0"
    version = manifest.get("version")
    assert isinstance(version, str) and re.fullmatch(r"\d+\.\d+\.\d+", version), (
        f"`version` is {version!r}; the seed reconciliation keys on it and "
        "`check-processor-seed-versions.sh` compares it as a dotted triple"
    )


def test_TEST_26_every_methods_PLACEHOLDER_is_a_DECLARED_param():
    """TEST-26 — `methods.commits`' `{token}`s resolve, or they print VERBATIM into methods.md.

    WHAT THIS WOULD CATCH, and did. `methods.commits` read
    `"one tissue map and one count matrix at the `{name}` square bin"` while `methods.params`
    declared nothing, so `{name}` was unsubstitutable. The build gate's own words:

        Left unsubstitutable it would print VERBATIM into the exported `methods.md`,
        which is the out-of-app trust deliverable.

    Again invisible to every python test and to the seed gate, and again a `cargo check`
    failure. And the consequence is not cosmetic: `methods.md` is the document a result
    leaves this application inside, so a literal `{name}` in it is a defect a reader sees and
    an author never does.

    This mirrors the gate's rule rather than restating its message: every `{token}` in any
    narrated field must be a key of `methods.params`, and every declared role must be one the
    narrator knows. The role vocabulary is READ from the shipped Rust rather than hardcoded,
    so a role added there does not make this guard wrong.
    """
    manifest = manifest_doc()
    analysis = manifest["contributes"]["analyses"][0]
    methods = analysis.get("methods") or {}
    declared = set((methods.get("params") or {}))

    narrated = [v for k, v in methods.items()
                if isinstance(v, str) and k != "params"]
    tokens = {tok for text in narrated for tok in re.findall(r"\{([A-Za-z_][A-Za-z0-9_]*)\}", text)}
    assert tokens, (
        "no `{token}` appears in any narrated field — if the narration genuinely needs none, "
        "delete this assertion deliberately rather than leaving a guard that measures nothing"
    )
    unresolved = sorted(tokens - declared)
    assert not unresolved, (
        f"{unresolved} appear as placeholders in `methods` but are not keys of "
        "`methods.params`, so they print VERBATIM into the exported `methods.md`"
    )

    # …and the ROLE each param declares must be one the narrator actually substitutes. Read
    # from the shipped Rust, not restated here: a vocabulary copied into a test is a second
    # spelling that goes stale the day the first one grows.
    gate = (PKG.parent.parent / "server" / "build_helper" / "processor_manifest.rs").read_text(
        encoding="utf-8")
    known_roles = set(re.findall(r'"(narrated_value|output_label|seed|subsample_cap)"', gate))
    assert known_roles, (
        "no substitutable role literal was found in `processor_manifest.rs` — this guard is "
        "checking against a vocabulary it could not read, so it would bless anything"
    )
    for token, role in (methods.get("params") or {}).items():
        assert role in known_roles, (
            f"`methods.params.{token}` declares role {role!r}, which the narrator does not "
            f"know (it substitutes {sorted(known_roles)})"
        )


def test_TEST_26_the_analysis_declares_env_arch_schedule_safety_and_category():
    """TEST-26 — the five declarations whose ABSENCE is silent.

    WHAT THIS WOULD CATCH. A missing `env` (since E3 landed a second recipe, the #80 build
    gate resolves an undeclared contribution's dependencies against EVERY recipe on disk, so
    dropping this line demands numpy/pandas/scipy/h5py/pyarrow in the deliberately-narrower
    R env too); a missing or narrowed `arch`, which silently makes the analysis unavailable
    on one of the two architectures this product ships; a missing `schedule.class`, a
    missing `safety` — and `category`, which is what places this in the catalog at all.

    Asserted as EQUALITIES, not as presence. `safety: read-run` on an import that mints the
    coordinate space every later image places itself into is a claim, and a widening of it
    to `write` should have to be typed here as well as there.
    """
    analysis = the_analysis()

    assert analysis["env"] == "single-cell", (
        "every one of this importer's pins lives in the `single-cell` recipe; naming "
        "another env asks the build gate to satisfy them somewhere they are not"
    )
    assert (ENV_ROOT / analysis["env"]).is_dir()
    assert analysis["arch"] == ["x86_64", "aarch64"], (
        f"arch is {analysis.get('arch')!r} — dropping one silently makes this analysis "
        "unavailable on that architecture rather than failing anywhere"
    )
    assert analysis["schedule"]["class"] == "normal"
    assert analysis["safety"] == "read-run", (
        "this import reads an upload and writes only its own artifacts; a wider `safety` "
        "is a claim about what it may touch"
    )
    assert analysis["category"] == "data-io"

    # DEC-1's other half, in the same place: no `trigger`. An import that silently
    # REINTERPRETS an upload is not recoverable by undo, and this one mints a coordinate
    # space. `import-h5ad` IS `trigger: on-ingest`, so the divergence is one word away from
    # being undone by somebody tidying towards the sibling.
    assert "trigger" not in analysis, (
        "a `trigger` makes this analysis non-launchable and reinterprets an upload without "
        "the user confirming it — see the manifest's `WHAT IS DELIBERATELY NOT HERE` block"
    )


def test_TEST_26_the_analysis_id_is_UNIQUE_across_every_shipped_manifest():
    """TEST-26 — two packages claiming one id is a registration nobody edits and nobody sees.

    WHAT THIS WOULD CATCH. `extensions/embedded.rs` bakes the whole `packages/` tree in with
    one `include_dir!`, extracts it on boot and SCANS the extracted folder — so a directory
    that exists IS a package that is registered, and there is no registry file where a
    collision would be visible as a diff. Two contributions with one id resolve by whatever
    order the scan happens to produce, which is the kind of defect that reproduces on one
    machine and not another.

    Swept over EVERY `packages/*/manifest.yaml`, not just the spatial ones: the id space is
    global, and a collision with `qc` or `trajectory` is exactly as fatal as one with a
    sibling importer.
    """
    owners = {}
    manifests = sorted(PACKAGES.glob("*/manifest.yaml"))
    assert len(manifests) > 5, (
        f"the sweep found only {len(manifests)} manifests under {PACKAGES}; a uniqueness "
        "claim over almost nothing is not one"
    )
    for path in manifests:
        doc = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        for analysis in ((doc.get("contributes") or {}).get("analyses") or []):
            owners.setdefault(analysis["id"], []).append(path.parent.name)

    collisions = {k: v for k, v in owners.items() if len(v) > 1}
    assert not collisions, (
        f"these analysis ids are contributed by more than one package: {collisions}. The "
        "loader scans a directory tree, so which one wins is scan order."
    )
    assert owners.get(ANALYSIS_ID) == [PKG.name], (
        f"{ANALYSIS_ID!r} is contributed by {owners.get(ANALYSIS_ID)!r}; it must be "
        f"contributed by {PKG.name} and by nothing else"
    )
    # And the sweep really saw the neighbours it claims to have swept.
    assert "spatial.import-visium" in owners and "spatial.import-xenium" in owners, (
        f"the sibling importers are missing from the swept id set {sorted(owners)} — the "
        "sweep is not reading the tree it says it is"
    )


# ── TEST-27: the version bump carries its changelog entry ───────────────────────────


def test_TEST_27_the_manifest_version_is_bumped_WITH_its_changelog_entry():
    """TEST-27 — a bare number bump breaks this repo's convention, and the number is load-bearing.

    `scripts/check-processor-seed-versions.sh` requires `version:` to move when anything
    under the package directory moves, because an already-provisioned deployment SKIPS
    re-extraction at an unchanged version and keeps executing the OLD kernel. So the number
    is the only thing that makes a change reach a running install — and a number that moves
    with no recorded reason is a deployment nobody can explain afterwards.

    WHAT THIS WOULD CATCH. A `version:` bumped with no changelog entry; a changelog entry
    written for a version the file does not declare; an entry that names NO issue, or an
    issue nobody has verified exists; a one-line note in place of a rationale; and a second
    top-level `version:` key, which YAML resolves last-wins and which would make the whole
    convention unreadable.

    ## The issue leg, and what #377 corrected in it

    This assertion used to read `assert ISSUE in newest` — the newest entry must name
    **#313**, on the premise stated here that *"this package exists for #313 and for nothing
    else"*. That premise expired on the first bump this package took for another issue: #377
    moved the `coordinate_space` id format, and a rule requiring its entry to cite #313 would
    have forced a citation that points a reader at the wrong issue — the guard mandating the
    defect its own neighbour (TEST-29) exists to prevent.

    So the number is no longer hardcoded, and the leg is not dropped either: the newest entry
    must name an issue that `tests/issue_states.json` RECORDS. That file is TEST-29's
    hand-captured, dated snapshot and its scanner already requires every `#NNN` written
    anywhere in this package to be in it — so an entry citing an invented or unlooked-up
    number cannot pass, which is strictly more than "the number is #313" ever checked. And
    #313 is still required to be in the changelog, as the entry the package was BORN from.

    This is the exact shape `spatial-import-visium/tests/test_refusal_escaping.py::
    test_TEST_14` enforces on the sibling. The NEWEST entry is the LAST head BEFORE the
    `version:` line — that is this file family's real convention, read from the sibling's
    own history rather than assumed: #330 and #321 each inserted their entry immediately
    above `version:`, so a test asserting "first in the file" would have failed on main.

    `encoding="utf-8"` is EXPLICIT. The changelog head is delimited by an EM DASH (U+2014)
    and its body carries `µm` and `§`; under `LC_ALL=C` a locale-default read raises
    `UnicodeDecodeError` or mis-decodes, and the head regex below then matches nothing.
    That failure mode is not hypothetical in this tree — #330, #333, #336 and #339 are four
    separate landings of it — and its shape is the dangerous one: the guard stops seeing
    the thing it guards rather than reporting that it cannot.
    """
    text = MANIFEST.read_text(encoding="utf-8")
    lines = text.splitlines()

    declared = [ln.split(":", 1)[1].strip().strip('"\'')
                for ln in lines if ln.startswith("version:")]
    assert len(declared) == 1, (
        f"expected exactly one top-level `version:`, found {declared} — YAML takes the "
        "last, so a second key silently decides what ships"
    )
    version = declared[0]
    assert re.fullmatch(r"\d+\.\d+\.\d+", version), (
        f"`version: {version}` is not X.Y.Z; the seed reconciliation compares it as one"
    )

    # The entry HEADS are the UNINDENTED `# X.Y.Z — #NNN:` lines. A continuation line is
    # indented under its head, so an indented match is a paragraph and not a new entry.
    heads = [(i, ln) for i, ln in enumerate(lines)
             if re.match(r"^# \d+\.\d+\.\d+ — #\d", ln)]
    assert heads, (
        "no `# X.Y.Z — #NNN: rationale` changelog head found in manifest.yaml. If this "
        "fires on a file that visibly has one, check the read: an em dash decoded under a "
        "non-UTF-8 locale is not the character this pattern matches."
    )

    version_line = next(i for i, ln in enumerate(lines) if ln.startswith("version:"))
    before = [ln for i, ln in heads if i < version_line]
    assert before, (
        f"every changelog head sits BELOW the `version:` line; the newest entry belongs "
        f"immediately above it (heads at lines {[i for i, _ in heads]}, version at "
        f"{version_line})"
    )
    newest = before[-1]

    assert newest.startswith(f"# {version} — #"), (
        f"the entry immediately above `version:` is {newest!r}; it must name the declared "
        f"version {version}, or the bump has no log entry"
    )
    # THE ISSUE THE BUMP IS FOR — a real, looked-up one, not a hardcoded constant. See the
    # docstring: pinning it to #313 would have made every later entry cite the wrong issue.
    recorded = json.loads(
        (Path(__file__).resolve().parent / "issue_states.json").read_text(encoding="utf-8")
    )["issues"]
    cited = newest.split("—", 1)[1].strip().split(":", 1)[0].strip()
    assert re.fullmatch(r"#\d+", cited), (
        f"the newest entry's head names no issue: {newest!r}")
    assert cited.lstrip("#") in recorded, (
        f"the {version} entry cites {cited}, which `tests/issue_states.json` does not record. "
        f"Capture it (`gh issue view {cited.lstrip('#')} --json number,state,title`) and commit "
        f"the result, so the number in a changelog is one somebody actually looked up.")
    assert ISSUE in text, (
        f"the changelog no longer names {ISSUE}, the issue this package was born from")
    rationale = newest.split(":", 1)[1].strip()
    assert len(rationale) > 20, (
        f"the entry needs a rationale, not a label: {newest!r}"
    )

    # And it is a real BLOCK, not a one-liner: the rationale continues under the head at the
    # 10-space continuation indent this family of manifests uses.
    body = text.split(newest, 1)[1].splitlines()[1:]
    continued = [ln for ln in body[:60] if ln.startswith("#" + " " * 10)]
    assert len(continued) >= 5, (
        f"the {version} entry has only {len(continued)} continuation lines at the 10-space "
        "indent; a bare number bump with a one-line note is what this repo's convention "
        "refuses. A deployment skips re-extraction at an unchanged version, so the entry is "
        "the only record of what a bump actually shipped."
    )


def test_TEST_27_the_read_that_finds_the_changelog_is_ENCODING_EXPLICIT():
    """TEST-27 — the em-dash leg, proved rather than promised.

    The guard above is only as good as its read. This asserts the two facts that make the
    `encoding="utf-8"` in it load-bearing: the changelog head really is delimited by U+2014
    (so a locale-default read on an ASCII locale would raise rather than merely differ), and
    this test file itself names an encoding on every `read_text`.

    Without this leg, somebody removing `encoding="utf-8"` from the read above would see
    every assertion still pass on a UTF-8 developer box, and the guard would go green on
    `LC_ALL=C` in CI for the one reason it must not: it stopped being able to see its
    subject. That is #339's defect verbatim.
    """
    raw = MANIFEST.read_bytes()
    assert "—".encode("utf-8") in raw, (
        "the manifest no longer contains an em dash, so the encoding-explicit read this "
        "test defends is no longer load-bearing — re-derive the claim or drop it"
    )
    with pytest.raises(UnicodeDecodeError):
        raw.decode("ascii")

    source = Path(__file__).read_text(encoding="utf-8")
    reads = re.findall(r"\.read_text\((?P<args>[^)]*)\)", source)
    assert reads, "no `read_text` call found in this file, so this control measures nothing"
    bare = [call for call in reads if "encoding=" not in call]
    assert not bare, (
        f"{len(bare)} `read_text(...)` call(s) in this file name no encoding: {bare}. "
        "Every read here is of a file with em dashes, `µm` or `§` in it."
    )


# ── TEST-28: the suite is collected by something ────────────────────────────────────


def test_TEST_28_pytest_ini_testpaths_COLLECTS_this_packages_suite():
    """TEST-28 — `testpaths` is an ENUMERATION, and this package's line is the whole registration.

    `packages/pytest.ini`'s own header states the consequence in its own words: a package
    whose suite is not listed there "is collected by NOTHING — `just check-py` runs bare
    `python3 -m pytest` from this directory, which honours this line", and "a gate that
    cannot run is indistinguishable from a gate that passes". That is not a hypothetical
    either: the header records `annotation-integrate/tests` as the case in point, where the
    package's I/O contract had no suite at all and ITEM-26 broke the live integrate job with
    every gate green.

    WHAT THIS WOULD CATCH. The entry deleted, renamed or reworded away — after which every
    other test in this directory would keep passing when run by hand and would run NOWHERE
    in CI. No test COUNT can detect that, because the count is measured from `testpaths`
    too. It is one line in a file this package does not otherwise touch, and it must land in
    the same commit that creates the directory.

    The entry is matched as a WHITESPACE-DELIMITED TOKEN, not as a substring: the sibling
    `spatial-import-visium/tests` is a proper prefix of nothing here, but
    `spatial-import-visium-hd/tests` CONTAINS `spatial-import-visium` — so a naive `in`
    check written the other way round would report the sibling's registration as this
    package's.
    """
    text = PYTEST_INI.read_text(encoding="utf-8")
    testpaths = [ln for ln in text.splitlines() if ln.strip().startswith("testpaths")]
    assert len(testpaths) == 1, (
        f"expected exactly one `testpaths` line in {PYTEST_INI}, found {len(testpaths)}"
    )
    entries = testpaths[0].split("=", 1)[1].split()
    expected = f"{PKG.name}/tests"
    assert expected in entries, (
        f"`{expected}` is absent from `testpaths` ({entries}). Until it is listed, this "
        "package's whole suite is collected by NOTHING: `just check-py` runs bare "
        "`python3 -m pytest` from `src-app/packages`, which honours this line, so every "
        "test in this directory would pass by hand and run nowhere in CI. `pytest.ini`'s "
        "own header requires the entry in the same commit that creates the directory."
    )

    # The path really resolves — a listed directory that does not exist is an enumeration
    # entry that collects nothing, which is the same outcome by a different route.
    assert (PACKAGES / expected).is_dir()
    assert (PACKAGES / expected) == Path(__file__).resolve().parent

    # And the header this docstring quotes is still there to be quoted. If the reasoning is
    # ever deleted, the next person to "tidy" the enumeration has nothing telling them why
    # it is one.
    # COMMENT-MARKER-STRIPPED and whitespace-normalized: the sentence is WRAPPED across two
    # `#` comment lines in the file, so a literal substring match would fail on line
    # formatting rather than on meaning — and "reflow the comment so the grep passes" would
    # be the wrong repair.
    prose = " ".join(" ".join(ln.lstrip("#").split()) for ln in text.splitlines())
    assert "is collected by NOTHING" in prose, (
        "`pytest.ini` no longer states why `testpaths` is an enumeration; this test's "
        "docstring quotes a sentence that is gone"
    )
    # The import mode that makes the shared-guard basenames legal at all (#198). This
    # package ships a FIFTH `test_zero_src_app_diff.py`; under pytest's default `prepend`
    # mode that basename collides in `sys.modules` and collection ABORTS the whole run.
    addopts = next(ln for ln in text.splitlines() if ln.strip().startswith("addopts"))
    assert "--import-mode=importlib" in addopts, (
        "`--import-mode=importlib` is gone from `addopts`; this package's "
        "`test_zero_src_app_diff.py` shares its basename with four other packages' copies "
        "and collection would abort for the whole tree, not just for this suite"
    )
