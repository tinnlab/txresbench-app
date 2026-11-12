#!/usr/bin/env python3
# ruff: noqa
"""TEST-16 — the package is REGISTERED and its manifest has the shape the lints accept.

Registration here is not a list somebody edits: `extensions/embedded.rs` bakes the whole
`packages/` tree in with one `include_dir!`, extracts it on boot and SCANS the extracted
folder, so a directory that exists is a package that is registered. What still has to be
edited by hand is `pytest.ini`'s `testpaths` ENUMERATION — a suite absent from it is
collected by nothing, and no test COUNT can detect that, because the count is measured
from `testpaths` too.
"""
import ast
import importlib.util
import sys
from pathlib import Path

import pytest

yaml = pytest.importorskip("yaml")

_PKG = Path(__file__).resolve().parents[1]
_PYTEST_INI = _PKG.parent / "pytest.ini"
_MANIFEST = _PKG / "manifest.yaml"
_REQUIREMENTS = (
    _PKG.parents[1] / "env-rootfs" / "single-cell" / "requirements.txt"
)


def _load_ome_writer():
    """`compute/ome_writer.py` by PATH, with its `spatial_declarations` dependency staged.

    The same discipline `visium_fixtures.load_compute` documents: `spatial-types` ships a
    file of the same bare name, so loading by path is what guarantees the assertions are
    about the copy THIS package ships.
    """
    for name in ("spatial_declarations", "ome_writer"):
        spec = importlib.util.spec_from_file_location(
            name, _PKG / "compute" / f"{name}.py"
        )
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module
        spec.loader.exec_module(module)
    return sys.modules["ome_writer"]

#: Keys a manifest may no longer carry (`loadProcessors.ts` `assertNoRemovedKeys`).
REMOVED_KEYS = {"accepts", "when", "params", "defaults", "produces_annotations",
                "inStandardRecipe", "recipeOrder"}


def test_pytest_ini_registers_this_suite():
    testpaths = next(
        line for line in _PYTEST_INI.read_text().splitlines()
        if line.strip().startswith("testpaths")
    )
    assert "spatial-import-visium/tests" in testpaths, (
        "this suite is collected by NOTHING until it is enumerated in "
        "`packages/pytest.ini`; the file's own header requires the entry in the same "
        "commit that creates the directory"
    )


def test_manifest_has_the_shape_the_processor_lint_accepts():
    doc = yaml.safe_load(_MANIFEST.read_text())
    assert doc["id"] == "spatial-import-visium"
    assert doc["publisher"] == "txr"
    assert doc["apiVersion"] == "1.0"
    assert doc["version"], "the seed reconciliation keys on `version`"

    analyses = doc["contributes"]["analyses"]
    assert {a["id"] for a in analyses} == {"spatial.import-visium"}
    analysis = analyses[0]
    assert not (set(analysis) & REMOVED_KEYS), set(analysis) & REMOVED_KEYS
    assert analysis["category"] == "data-io"
    assert analysis["safety"] == "read-run"
    assert analysis["schedule"]["class"] == "normal"
    assert analysis["arch"] == ["x86_64", "aarch64"]
    assert analysis["methodsText"].strip()

    run = analysis["run"]
    assert run["kind"] == "sandbox" and run["runtime"] == "python"
    assert (_PKG / run["entry"]).is_file()
    assert "compute/spatial_declarations.py" in (run.get("helpers") or []), (
        "the vendored contract must be STAGED beside the entry, or the compute's "
        "`import spatial_declarations` resolves to nothing in the sandbox"
    )
    for helper in run["helpers"]:
        assert (_PKG / helper).is_file()


def test_the_analysis_is_launchable_and_not_on_ingest():
    """DEC-1, as an assertion rather than a comment.

    `import-h5ad` — the model for everything else about this manifest — is
    `trigger: on-ingest`, so the divergence is one word away from being undone by
    someone tidying towards the sibling. An import that silently REINTERPRETS an upload
    cannot be recovered by undo, and this one mints the coordinate space every later
    image and every later section places itself into.
    """
    doc = yaml.safe_load(_MANIFEST.read_text())
    analysis = doc["contributes"]["analyses"][0]
    assert "trigger" not in analysis, (
        "a `trigger` makes this analysis non-launchable; DEC-1 requires the user to "
        "confirm the registration"
    )


def test_the_input_slot_is_the_bundle_container_not_its_members():
    doc = yaml.safe_load(_MANIFEST.read_text())
    slots = doc["contributes"]["analyses"][0]["appliesTo"]
    assert len(slots) == 1
    assert slots[0]["slot"] == "bundle"
    assert slots[0]["type_id"] == "spatial/visium-bundle", (
        "binding the four Space Ranger members individually would re-open a grouping the "
        "upload container already did"
    )
    assert slots[0]["auto_bind_sole_candidate"] is True


def test_produces_names_every_datatype_the_compute_actually_emits():
    """A `produces` that disagrees with the compute is a lie the catalog believes."""
    doc = yaml.safe_load(_MANIFEST.read_text())
    declared = set(doc["contributes"]["analyses"][0]["produces"])
    module_text = (_PKG / "compute" / "import_visium.py").read_text()
    for datatype in declared:
        assert f'"{datatype}"' in module_text, (
            f"the manifest declares it produces {datatype!r} and the compute never names it"
        )
    assert declared == {
        "single-cell/counts", "spatial/coordinates", "spatial/image", "metadata-column",
        "report/qc", "report/html",
    }
    # `spatial/image` JOINED this set in #155. It was asserted ABSENT here while #154 was
    # the whole of the importer, which was correct then and is the opposite of correct now:
    # the importer writes the image, so a `produces` without it would be the same lie in
    # the other direction — a catalog that cannot see an artifact the compute really emits.
    assert "spatial/image" in declared


def test_every_declared_dependency_is_pinned_in_the_rootfs():
    """The build gate's own question, asked here where the failure is readable.

    `build_helper/processor_manifest.rs` resolves each declared library against the
    rootfs pins at BUILD time, so a library absent there fails `cargo check` with a
    message about a manifest rather than about this package. Asking it here names the
    dependency and the pin.
    """
    # TEST-P15 / #214-#215. This was `re.findall(r"^([A-Za-z0-9_.\-]+)==([^\s#]+)", …,
    # re.M)` over the pin file — and it was the one pin reader in the tree that sat behind
    # NO canonical-bytes precondition at all. Its `[^\s#]+` version capture stops at
    # U+001C-1F where the build gate's does not, so a version could be TRUNCATED here and
    # then satisfy the range check below against a prefix of the real pin, reporting a
    # declaration satisfied that the gate would refuse. It now reads the gate's parse.
    import env_pins

    doc = yaml.safe_load(_MANIFEST.read_text())
    declared = doc["contributes"]["analyses"][0]["run"]["dependencies"]
    pins = {
        p["raw_name"]: p["version"]
        for p in env_pins.pins(
            _REQUIREMENTS.parent.name, env_root=_REQUIREMENTS.parent.parent
        )
    }
    for dep in declared:
        assert dep["library"] in pins, (
            f"{dep['library']} is declared but is not pinned in "
            f"env-rootfs/single-cell/requirements.txt"
        )

    Version = pytest.importorskip("packaging.version").Version
    SpecifierSet = pytest.importorskip("packaging.specifiers").SpecifierSet
    for dep in declared:
        assert Version(pins[dep["library"]]) in SpecifierSet(dep["version"]), (
            f"{dep['library']}=={pins[dep['library']]} falls outside the declared range "
            f"{dep['version']}"
        )


def test_the_imaging_dependencies_are_exactly_what_the_compute_imports():
    """TEST-15 [covers: ITEM-8] — #154's DEC-10 assertion, inverted by #155.

    This test used to assert that NO imaging library was declared, which was the executable
    form of #154's DEC-10 ("the image artifact is #155/#156's"). #155 is that item, so the
    assertion now says the opposite thing in the same place — and keeps the part that is
    still true.

    STILL FORBIDDEN and still meaningful:
      * `squidpy` — DEC-2's reasoning is untouched. It is in the rootfs and NOT on the
        `just check-py` host, so importing it would put this compute behind the one gate
        that has to run it.
      * `imagecodecs` — it is the LZW backend, and DEC-2 writes `deflate` (which tifffile
        serves from stdlib `zlib`). It IS pinned in the rootfs by #181, but no code path
        here imports it, and declaring a library nothing imports is exactly the
        unconsumed-declaration shape `requirements.txt`'s own review standard refuses.

    REQUIRED now: `tifffile` (the OME-TIFF writer) and `pillow` (the PNG reader tifffile
    is not).
    """
    doc = yaml.safe_load(_MANIFEST.read_text())
    libraries = {
        d["library"] for d in doc["contributes"]["analyses"][0]["run"]["dependencies"]
    }
    assert {"tifffile", "pillow"} <= libraries, (
        "the compute imports tifffile and PIL; an undeclared import fails inside a user's "
        "sandbox with no build-time signal, which is what #80's gate exists to prevent"
    )
    assert not (libraries & {"imagecodecs", "squidpy"}), (
        "neither is imported by any path in this package — see this test's docstring"
    )
    # And the declaration matches reality in the other direction: what the compute really
    # IMPORTS is what is declared.
    #
    # Parsed with `ast`, NOT grepped. The first cut of this was
    # `assert "imagecodecs" not in compute_source` and it went red immediately — on the
    # module's own DOC-COMMENT, which explains why imagecodecs is deliberately unused. A
    # substring predicate over source text cannot tell an import from a comment, a string
    # or a variable name, and "fix the comment so the grep passes" would have been the
    # wrong repair: the guarantee is about what the module imports, so the check has to
    # read the import statements themselves.
    imported = set()
    for name in ("ome_writer.py", "import_visium.py"):
        tree = ast.parse((_PKG / "compute" / name).read_text())
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(a.name.split(".")[0] for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                imported.add(node.module.split(".")[0])
    assert {"tifffile", "PIL"} <= imported, f"compute imports: {sorted(imported)}"
    assert "imagecodecs" not in imported, (
        "a code path now imports imagecodecs, so it must be DECLARED — it is pinned in "
        "the rootfs but absent on the `just check-py` host, which would put this suite "
        "behind the gate that has to run it"
    )
    # The reason the module can get away with not importing it: the codec it writes is
    # served by stdlib `zlib`. Binding DEC-2 here means a change to `lzw` goes red HERE,
    # naming the dependency consequence, rather than as a mysterious KeyError in whichever
    # environment happens to lack imagecodecs.
    ome_writer = _load_ome_writer()
    assert ome_writer.CODEC == "deflate", (
        f"the writer's codec is {ome_writer.CODEC!r}; `lzw` is the only other lossless "
        "option and tifffile dispatches it to imagecodecs, which this host does not have"
    )


def test_the_seed_version_floor_moved_for_the_image_contribution():
    """#155's **TEST-17** [covers: ITEM-10] — the version-keyed reconcile, as a FLOOR.

    `scripts/check-processor-seed-versions.sh` requires a package's `version` to move when
    its content does, because an already-provisioned deployment SKIPS re-extraction at an
    unchanged version and would keep executing the OLD kernel.

    Asserted as a FLOOR rather than as "differs from the base", deliberately. A
    base-relative check EXPIRES at merge — once this branch lands, `merge-base` is HEAD and
    the assertion becomes vacuously true — which is the same defect
    `test_rootfs_deps_r.py`'s content lock records having fixed. A floor rises for free
    when a package is bumped again and falls only when someone lowers it on purpose.

    (`TEST-17` is a per-feature id; #154 uses the same spelling elsewhere in this
    directory for a different test. This is #155's.)

    #243's **TEST-7** [covers: ITEM-7, ITEM-8] also rides on this line. #243 replaces the
    committed `tissue_hires_image.png` with 10x's own emission, which moves bytes under this
    package and therefore compels a `version` bump (`check-processor-seed-versions.sh` diffs
    the whole package directory). Per this test's own instruction — "Raise the floor when
    bumping" — visium's floor moves from `0.2.0` to `0.8.0`, which is where main stood before
    #243's own bump to `0.8.1`. A floor five minor versions behind the package cannot fail,
    and an assertion that cannot fail is not one; raising it is what keeps this a ratchet
    rather than a decoration. `spatial-types`' floor is deliberately left alone — this branch
    does not touch that package and moving another package's ratchet is not its business.
    """
    Version = pytest.importorskip("packaging.version").Version
    for pkg, floor in (("spatial-import-visium", "0.8.0"), ("spatial-types", "0.2.0")):
        doc = yaml.safe_load((_PKG.parent / pkg / "manifest.yaml").read_text())
        assert Version(str(doc["version"])) >= Version(floor), (
            f"{pkg} is at {doc['version']}, below the {floor} floor #155 recorded — a "
            "provisioned host would keep running the pre-image kernel. Raise the floor "
            "when bumping; lower it only deliberately, with the reason."
        )

def test_the_dependency_check_reads_the_exported_parse(monkeypatch):
    """TEST-P15 (#214 / #215) — this was the ONE pin reader in the tree behind no
    canonical-bytes precondition at all, and its `[^\\s#]+` version capture stopped at
    U+001C-1F where the build gate's did not — so a version could be truncated here and
    then satisfy the range check against a prefix of the real pin.

    It now reads the gate's parse. Proved by replacing that parse with a sentinel: a
    consumer follows it, a residual `re.M` reader follows the file.
    """
    import env_pins

    seen = {}

    def _sentinel(env_id, env_root=None, data=None):
        seen["called"] = (env_id, str(env_root))
        return [
            {
                "name": "sentinel-pkg",
                "raw_name": "sentinel-pkg",
                "version": "9.9.9",
                "import": "sentinel_pkg",
                "line": 1,
            }
        ]

    monkeypatch.setattr(env_pins, "pins", _sentinel)
    with pytest.raises(AssertionError, match="not pinned in"):
        test_every_declared_dependency_is_pinned_in_the_rootfs()
    assert seen["called"][0] == "single-cell", (
        "the check must ask the exported parse about the recipe it names; if it never "
        "called the reader, a residual parse of requirements.txt survives"
    )
    monkeypatch.undo()

    # CONTROL — unpatched, the real check passes. Without this the raise above could come
    # from the test being broken rather than from the sentinel.
    test_every_declared_dependency_is_pinned_in_the_rootfs()
