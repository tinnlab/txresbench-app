#!/usr/bin/env python3
# ruff: noqa
"""TEST-15 — the package is REGISTERED, declares what it emits, and is collected by
something.

The first assertion in this file is the one the whole rest of the suite rests on: a
`<package>/tests/` directory absent from `packages/pytest.ini`'s `testpaths` is COLLECTED BY
NOTHING. Every PASS in this package would then be a test that never ran, and no test count
anywhere could tell the difference. That is the "what independent observation distinguishes
'it passed' from 'it never ran'" question, answered executably.

The rest asserts the manifest shape the processor lint accepts, that every declared
`produces` id is actually emitted by the compute, that every declared dependency is pinned
in the rootfs within its declared range, and that the two hand-maintained registers outside
this package really carry this producer.
"""
import ast
import json
import re
import sys
from pathlib import Path

import pytest
import yaml

PACKAGES = Path(__file__).resolve().parents[2]
PKG = PACKAGES / "spatial-import-xenium"
MANIFEST = PKG / "manifest.yaml"
COMPUTE_DIR = PKG / "compute"

#: Keys the processor lint REMOVED from the manifest vocabulary. Copied from the sibling's
#: copy of this guard rather than re-derived, because a key that quietly returns is exactly
#: the drift a per-package guard exists to catch.
REMOVED_KEYS = ("accepts", "when", "params", "defaults", "produces_annotations",
                "inStandardRecipe", "recipeOrder")


@pytest.fixture(scope="module")
def manifest():
    return yaml.safe_load(MANIFEST.read_text())


@pytest.fixture(scope="module")
def analysis(manifest):
    analyses = manifest["contributes"]["analyses"]
    assert len(analyses) == 1
    return analyses[0]


# ── the assertion every other PASS in this package depends on ────────────────────────


def test_pytest_ini_registers_this_suite():
    """TEST-15 — WITHOUT THIS, EVERY OTHER PASS IN THIS PACKAGE IS VACUOUS.

    `packages/pytest.ini`'s `testpaths` is a hand enumeration; `just check-py` fails loudly
    on a `<package>/tests/` directory missing from it, but a developer running one file by
    hand sees green either way. This is the independent observation that distinguishes "the
    suite passed" from "the suite was never collected".
    """
    ini = (PACKAGES / "pytest.ini").read_text()
    testpaths = re.search(r"^testpaths\s*=\s*(.+)$", ini, re.M).group(1).split()
    assert "spatial-import-xenium/tests" in testpaths, (
        "this suite is collected by nothing. Add it to packages/pytest.ini's testpaths in "
        "the SAME commit that creates the directory — that file's own header says so, and "
        "no test count can detect the omission."
    )
    # And the sibling arm is still there — a `testpaths` edit that replaced rather than
    # appended would silently stop collecting another package's whole suite.
    for sibling in ("spatial-import-visium/tests", "spatial-types/tests",
                    "_helpers/tests", "_lib"):
        assert sibling in testpaths, (
            f"{sibling} vanished from testpaths — an APPEND became a replacement"
        )


# ── the manifest shape ───────────────────────────────────────────────────────────────


def test_manifest_has_the_shape_the_processor_lint_accepts(manifest, analysis):
    assert manifest["id"] == "spatial-import-xenium"
    assert manifest["publisher"] == "cyto"
    assert manifest["apiVersion"] == "1.0"
    assert str(manifest["version"]).strip()

    assert analysis["id"] == "spatial.import-xenium"
    assert analysis["category"] == "data-io"
    assert analysis["safety"] == "read-run"
    assert analysis["schedule"]["class"] == "normal"
    assert analysis["arch"] == ["x86_64", "aarch64"]
    assert analysis["methodsText"].strip()
    assert analysis["env"] == "single-cell", (
        "the env must be DECLARED — the #80 build gate otherwise resolves every dependency "
        "against the deliberately-narrower R recipe too"
    )
    for key in REMOVED_KEYS:
        assert key not in analysis, f"{key!r} is not in the manifest vocabulary any more"

    run = analysis["run"]
    assert run["kind"] == "sandbox" and run["runtime"] == "python"
    assert (PKG / run["entry"]).exists()
    for helper in run["helpers"]:
        assert (PKG / helper).exists(), f"declared helper {helper} is not on disk"


def test_the_analysis_is_launchable_and_not_on_ingest(analysis):
    """#154's DEC-1, inherited: an import that silently REINTERPRETS an upload is not
    recoverable by undo, and this one mints a coordinate space every later image and every
    later section places itself into."""
    assert "trigger" not in analysis


def test_the_input_slot_is_the_bundle_container_not_its_members(analysis):
    slots = analysis["appliesTo"]
    assert len(slots) == 1, (
        "ONE slot: the bundle is already ONE dataset by the time it reaches here, and "
        "binding the members individually would re-open a grouping the container did"
    )
    slot = slots[0]
    assert slot["slot"] == "bundle"
    assert slot["type_id"] == "spatial/xenium-bundle"
    assert slot["auto_bind_sole_candidate"] is True


def test_produces_names_every_datatype_the_compute_actually_emits(analysis):
    """A `produces` that drifts from the compute is a lie the catalog acts on."""
    source = (COMPUTE_DIR / "import_xenium.py").read_text()
    declared = set(analysis["produces"])
    assert declared == {
        "single-cell/counts", "spatial/coordinates", "spatial/image",
        # #163. Emitted only when the bundle carries a `cell_boundaries.parquet`;
        # `produces` is the set this analysis CAN emit, which is the same reading
        # `spatial/image` already has (a bundle whose image is unreadable emits none).
        "spatial/boundaries",
        "metadata-column", "report/qc", "report/html",
    }
    for datatype in declared:
        assert f'"{datatype}"' in source, (
            f"{datatype} is declared in `produces` but appears nowhere as a literal in the "
            "compute — either the compute does not emit it, or it emits it under a name "
            "the manifest does not name"
        )


# ── the dependency contract ──────────────────────────────────────────────────────────


def test_every_declared_dependency_is_pinned_in_the_rootfs(analysis):
    """The local mirror of the build gate, which fails `cargo check` rather than a user's
    sandbox job — run here so a bad range is caught before a Rust build is spent on it."""
    from packaging.specifiers import SpecifierSet
    from packaging.version import Version

    reqs = (PACKAGES.parent / "env-rootfs" / "single-cell" / "requirements.txt").read_text()
    pins = dict(re.findall(r"^([A-Za-z0-9_.\-]+)==([^\s#]+)", reqs, re.M))
    for dep in analysis["run"]["dependencies"]:
        library, declared = dep["library"], dep["version"]
        assert library in pins, (
            f"{library} is declared but pinned nowhere in the python rootfs recipe; the "
            "build gate turns that into a cargo check failure"
        )
        assert Version(pins[library]) in SpecifierSet(declared), (
            f"{library} is pinned at {pins[library]} which is outside the declared range "
            f"{declared}"
        )


def test_the_imaging_dependencies_are_exactly_what_the_compute_imports(analysis):
    """TEST-15 — declared BECAUSE imported, imported BECAUSE declared.

    An undeclared import fails in the sandbox; a declared library nothing imports is the
    unconsumed-pin shape the requirements file refuses. Both directions, by AST rather than
    by grep, so a mention in a comment cannot satisfy either.

    The interesting entry is `imagecodecs`. #155 deliberately DECLINED it for Visium ("it is
    the LZW backend, and DEC-2 writes deflate") and the sibling's copy of this guard asserts
    its ABSENCE. Xenium cannot decline it: every vendor morphology OME-TIFF is JPEG-2000 and
    `tifffile` raises without it. The two assertions are opposite and both correct, which is
    why each package owns its own copy of this test.
    """
    libraries = {d["library"] for d in analysis["run"]["dependencies"]}
    assert {"tifffile", "imagecodecs", "h5py", "numpy"} <= libraries
    assert "squidpy" not in libraries
    # TEST-17 [covers: ITEM-6, ITEM-9] — INVERTED by #301, and the inversion is the scope
    # advance rather than the guard being edited around, exactly as `pyarrow` below was.
    #
    # It used to read `"pillow" not in libraries`, with the reason: "pillow is the PNG reader
    # Visium needs; no Xenium bundle ships a PNG, and a declared library no code path imports
    # is an unconsumed pin." Both halves of that are STILL TRUE about READING a PNG, and both
    # stop mattering: `compute/registration_qc.py` WRITES one — design §7.5's registration
    # overlay — on the path every run with a morphology image takes. The pin is consumed, so
    # the refusal that rested on it being unconsumed is gone.
    #
    # No content lock moves and no image republish follows: `pillow` is already pinned in
    # `env-rootfs/single-cell/requirements.txt` at 12.3.0 and already declared by
    # `spatial-import-visium`.
    assert "pillow" in libraries, (
        "this importer now RENDERS a PNG — §7.5's registration QC overlay (#301) — and must "
        "DECLARE the library it imports. An undeclared library is resolved against no pin at "
        "build time and surfaces first as a user's sandbox job failing"
    )
    # TEST-10 [covers: ITEM-1, ITEM-11] — this assertion is INVERTED by #163, and the
    # inversion is the scope advance rather than the guard being edited around.
    #
    # It used to read `"pyarrow" not in libraries`, with the reason: "DEC-3: this importer
    # reads `cells.csv.gz`, not `cells.parquet`. A parquet reader here would move the
    # env-rootfs content lock and imply an image republish." Both halves of that prediction
    # were tested by #163 and they came apart:
    #
    #   * the content lock DID move — `differential-expression/tests/test_rootfs_deps_r.py`
    #     went red on the recipe edit, was re-recorded in the same commit with the reason,
    #     and its load-bearingness was re-proven by mutation;
    #   * the image republish did NOT follow. `pyarrow` is already IN the shipped image at
    #     exactly the pinned version, as a hard transitive of the already-pinned
    #     `spatialdata==0.7.3`. Verified by RUNNING `import pyarrow` inside the shipped
    #     rootfs under bwrap, and again inside a freshly built one.
    #
    # `fastparquet` stays refused, and for a sharper reason than before: it is NOT in the
    # image, so it would be the one parquet reader that genuinely forces a republish.
    assert "pyarrow" in libraries, (
        "this importer reads `cell_boundaries.parquet` (#163) and must DECLARE the reader "
        "it imports — an undeclared library is resolved against no pin at build time and "
        "surfaces first as a user's sandbox job failing"
    )
    assert "fastparquet" not in libraries, (
        "fastparquet is not in the shipped image, so declaring it would force an image "
        "republish that `pyarrow` does not; the two are not interchangeable here"
    )

    def imports_of(*paths, top_level_only=False):
        """The modules these files import.

        `top_level_only` is the load-bearing distinction, not a convenience: a MODULE-level
        import is a hard requirement of every consumer, while an import inside a function is
        a requirement only of the code path that calls it. Conflating the two is what would
        make the `pillow` reasoning below wrong.
        """
        found = set()
        for path in paths:
            tree = ast.parse(Path(path).read_text())
            nodes = tree.body if top_level_only else list(ast.walk(tree))
            for node in nodes:
                if isinstance(node, ast.Import):
                    found.update(a.name.split(".")[0] for a in node.names)
                elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                    found.add(node.module.split(".")[0])
        return found

    # THIS PACKAGE'S OWN code — the entry and the plane selector. `tifffile` yes, `PIL` no:
    # nothing on the READ path touches a PNG, and #301 did not change that.
    own = imports_of(COMPUTE_DIR / "import_xenium.py", COMPUTE_DIR / "xenium_image.py")
    assert "tifffile" in own
    assert "PIL" not in own, "nothing this package wrote READS a PNG"

    # AND THE OTHER DIRECTION, which is what makes the declaration above a consumed pin
    # rather than a line in a file. The overlay module must really import `PIL`, and it must
    # do so LAZILY — inside the render functions — for the same reason `ome_writer` must:
    # a module-level import would make `pillow` a hard requirement of merely IMPORTING the
    # module, which the entry does unconditionally at startup, so a sandbox without it would
    # lose the matrix, the coordinates and the columns rather than one diagnostic picture.
    overlay = imports_of(COMPUTE_DIR / "registration_qc.py")
    overlay_top = imports_of(COMPUTE_DIR / "registration_qc.py", top_level_only=True)
    assert "PIL" in overlay, (
        "the premise for declaring `pillow`: the registration QC really does import PIL. If "
        "that stops being true the declaration above is an unconsumed pin and should be "
        "removed rather than inherited."
    )
    assert "PIL" not in overlay_top, (
        "`registration_qc` must not import PIL at MODULE level — the entry imports this "
        "module unconditionally, so a top-level import turns a missing optional library into "
        "a dead import rather than into one lost diagnostic"
    )
    assert "numpy" in overlay_top and "spatial_declarations" in overlay_top, (
        "the control: `imports_of(..., top_level_only=True)` really does see this module's "
        "module-level imports, or the PIL assertion above is vacuous"
    )

    # THE VENDORED helper is a different question, and the honest answer is stated rather
    # than asserted away: `ome_writer.py` DOES name `PIL`, in `read_image`'s PNG branch — a
    # LAZY import inside a function, on a code path this importer never enters (it calls
    # `xenium_image.read_plane`, never `ome_writer.read_image`, because every Xenium
    # morphology image is a TIFF whose axis order that reader refuses by design).
    #
    # So `pillow` is deliberately NOT declared: declaring it would claim a dependency no
    # reachable path has, which is the unconsumed-pin shape the requirements file refuses,
    # and the module-level import graph would fail without it — it does not, because the
    # import is inside the branch. Asserted in BOTH directions so neither half can rot: the
    # name appears in the vendored file, and it appears only lazily.
    vendored_top = imports_of(COMPUTE_DIR / "ome_writer.py", top_level_only=True)
    vendored = imports_of(COMPUTE_DIR / "ome_writer.py")
    assert "PIL" in vendored, (
        "the premise: the vendored helper really does reference PIL. If that stops being "
        "true the `pillow` reasoning below is stale and its absence should be re-derived "
        "rather than inherited."
    )
    assert "PIL" not in vendored_top, (
        "`ome_writer` must not import PIL at MODULE level — a top-level import would make "
        "`pillow` a hard requirement of every consumer of the shared helper, including this "
        "one, which does not need it"
    )
    # `imagecodecs` is a tifffile BACKEND: it is never imported by name, it is what tifffile
    # calls out to. Declared because the decode fails without it — asserted by the runtime
    # test (TEST-23), not by an import.
    assert "imagecodecs" not in own and "imagecodecs" not in vendored


def test_the_shared_helpers_are_imported_by_bare_name_as_the_sandbox_stages_them(analysis):
    """The `/code` staging contract: helpers sit BESIDE the entry and resolve bare.

    A relative or package-qualified import would work under pytest (the package is on the
    path) and fail in the sandbox, where `/code` is flat.
    """
    # AND THE STAGED SET IS ASSERTED, not only the import style. #301 adds
    # `compute/registration_qc.py`, and an undeclared helper is an ImportError inside a user's
    # sandbox with no build-time signal at all — the exact failure this test exists for. An
    # ENUMERATED expectation rather than a subset check: a helper silently DROPPED from the
    # manifest is the same outage as one never added.
    assert set(analysis["run"]["helpers"]) == {
        "compute/spatial_declarations.py",
        "compute/ome_writer.py",
        "compute/xenium_image.py",
        "compute/boundaries.py",
        "compute/registration_qc.py",
    }, (
        f"the staged helper set is {sorted(analysis['run']['helpers'])}. Every module the "
        "entry imports by bare name must be here; §7.5's registration QC (#301) is the "
        "newest one"
    )
    source = (COMPUTE_DIR / "import_xenium.py").read_text()
    for name in ("spatial_declarations", "ome_writer", "xenium_image", "registration_qc"):
        assert re.search(rf"^import {name}\b", source, re.M) or \
            re.search(rf"^import {name} as ", source, re.M), (
            f"{name} must be imported by BARE NAME — the sandbox stages a flat /code dir"
        )
        assert f"from .{name}" not in source and f"compute.{name}" not in source


# ── the registers outside this package ───────────────────────────────────────────────


def test_the_producer_register_carries_every_row_bearing_output():
    """The model-coverage guard asserts its register against the derived pair set in BOTH
    directions, so an omission here is red — but it is red in a Rust suite, and this brings
    the failure to the package that caused it."""
    register = json.loads(
        (PACKAGES / "_lib" / "model_coverage_exempt.json").read_text()
    )["producer"]
    mine = {r["datatype"]: r for r in register if r["producer"] == "spatial.import-xenium"}
    # `spatial/boundaries` joined this set in #163, and it is a `rows-undeclared` with a
    # reason rather than a `rows-declared`: one row of that table is a vertex, which is not a
    # subset of any axis a dataset anchors. The row-space question lives in the two sibling
    # offset metadata-columns, which ARE `rows-declared` above. Verified by RUNNING the Rust
    # guard, which named exactly `spatial.import-xenium x spatial/boundaries` as missing.
    assert set(mine) == {"spatial/coordinates", "metadata-column", "single-cell/counts",
                         "spatial/boundaries"}
    assert mine["spatial/boundaries"]["disposition"] == "rows-undeclared", (
        "a vertex-axis table cannot declare WHICH rows of a dataset axis it wrote, because "
        "its rows are not rows of one; claiming `rows-declared` would be inventing a "
        "membership to satisfy a guard"
    )
    for datatype, row in mine.items():
        assert row["disposition"] in ("rows-declared", "rows-undeclared")
        assert row["reason"].strip(), (
            f"{datatype} has no reason; a disposition with no reason is a waiver wearing a "
            "decision's clothes"
        )
    # The sibling's rows are untouched — an append that became a rewrite would show here.
    visium = {r["datatype"] for r in register if r["producer"] == "spatial.import-visium"}
    assert visium == {"spatial/coordinates", "metadata-column", "single-cell/counts"}


def test_this_package_is_in_the_spatial_arm():
    """`_helpers`' always-armed guard asserts that NO shipped analysis narrows on a
    `spatial/*` datatype — except the spatial arm's own packages. This importer legitimately
    does (it binds `spatial/xenium-bundle`), so it must be a member, and adding one is the
    review that guard exists to force."""
    source = (PACKAGES / "_helpers" / "tests" / "test_visium_chain_zero_src_app.py").read_text()
    match = re.search(r"spatial_arm = \{([^}]*)\}", source)
    members = {m.strip().strip('"\'') for m in match.group(1).split(",") if m.strip()}
    # A SUPERSET, not an equality — which is what the sentence below actually describes.
    #
    # This was `==`, and a blind extensibility audit proved what that costs: it simulated a
    # THIRD importer, made the mandatory `spatial_arm` append in `_helpers`, and THIS test
    # went red — so vendor three would have had to edit a test inside vendor two's package
    # to do the very thing the assertion exists to permit. The guard forbade exactly the
    # append it was written to allow.
    expected = {"spatial-types", "spatial-import-visium", "spatial-import-xenium"}
    assert expected <= members, (
        f"the spatial arm is {sorted(members)} and is missing {sorted(expected - members)}; "
        "a member added by REPLACEMENT rather than by append would drop another package's "
        "permission silently. Additions by a later vendor are expected and fine."
    )


def test_the_seed_version_floor_moved_for_this_contribution():
    """A FLOOR, not a diff: the packages this branch moves must be at or above the versions
    it left them at, so a later branch cannot roll one back while this package still
    depends on the promoted helper living where it now lives."""
    from packaging.version import Version

    # These moved once already, when a merge with main revealed that main had
    # INDEPENDENTLY bumped `spatial-types` and `spatial-import-visium` to the same 0.3.1
    # this branch had chosen — two correct edits producing one identical line, which git
    # merged silently and only `check-processor-seed-versions.sh` caught. The numbers below
    # are the ones that gate named, not ones computed here.
    # TEST-8 [covers: ITEM-9] (#247). The xenium floor moves to 0.4.0. `check-processor-seed-
    # versions` compares base..head, so it can only see a version that failed to move on THIS
    # branch — it cannot stop a later branch rolling one back, and #247's bump is one a
    # rollback would silently un-ship: at 0.3.0 an already-provisioned deployment skips
    # re-extraction and keeps running the importer that still emits `consistent` and still
    # decides on the invented 5.0 band. The floor is what holds that shut afterwards.
    #
    # TEST-7 [covers: ITEM-5, ITEM-7] (#269). The xenium floor moves again, to 0.6.0, for the
    # identical reason one issue later: it is what stops `check_stated_scales` REFUSING a
    # user's image on the invented `_STATED_SCALE_RTOL = 1e-6`, and below it a provisioned
    # deployment skips re-extraction and keeps refusing. A rollback here does not merely
    # un-ship a reporting change — it silently restores a REFUSAL, so an artifact the user
    # expects stops existing again. Verified to bite by rolling `manifest.yaml` back and
    # watching this go red.
    #
    # 0.6.0 AND NOT 0.5.0 BECAUSE THE COLLISION THIS COMMENT BLOCK PREDICTS ACTUALLY
    # HAPPENED. #269 chose 0.5.0; #227 (the OME-TIFF tiling change) landed on 0.5.0 first.
    # Two correct edits producing one identical line — the exact shape recorded above, and
    # the exact thing `check-processor-seed-versions` and this floor exist to stop merging
    # silently. Resolved by renumbering #269 to 0.6.0 on top of #227's changelog entry.
    for package, floor in (("spatial-import-xenium", "0.6.0"),
                           ("spatial-types", "0.3.2"),
                           ("spatial-import-visium", "0.3.2"),
                           ("_lib", "0.4.1"),
                           ("_helpers", "0.3.2")):
        doc = yaml.safe_load((PACKAGES / package / "manifest.yaml").read_text())
        assert Version(str(doc["version"])) >= Version(floor), (
            f"{package} is at {doc['version']}, below the {floor} this contribution needs"
        )
