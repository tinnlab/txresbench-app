#!/usr/bin/env python3
# ruff: noqa
"""#327 — the frame identity, and the collisions it removes.

`coordinate_space_id` names the frame two artifacts share, and `resolveOverlayBinding`
(`libs/viz/src/viz-core/spatial/coordinateBinding.ts`) binds on that value by EQUALITY and by
nothing else — *"Two artifacts share a frame IFF they declare the SAME `coordinate_space` id."*
So a frame id two unrelated runs can both answer is not a naming problem. It is one tissue's image
silently registered against the other's cells, with no error, and a picture that looks right.

MEASURED on `4b63a482`, driving the shipped `coordinate_space_id` + the `section.sample_id`
expression, and every pair is exactly that:

    library_id='unknown'          run-A / run-B      -> BOTH visium:unknown           src=library_id
    library_id='0000000_0000000'  run-A / run-B      -> BOTH visium:0000000_0000000   src=library_id
    no library_id, /uploads/x/outs, /uploads/y/outs  -> BOTH visium:outs              src=bundle-directory-name
    no library_id, artifact-mounted A / B            -> BOTH visium:bundle            src=bundle-directory-name

Every test in this file that asserts a distinctness was written RED first, against that module.

## What these tests are anchored to

`docs/design/xenium-declaration-residues.md` §3 (the rule, shipped in `spatial-import-xenium` at
#323) and §4 (ONE rule for both importers, and its framing made injective — #327/#328). The
invariants they pin are §4's:

* **INV-1** — a coordinate frame identity is a value the vendor stated about THIS acquisition;
  where the vendor stated none it is DERIVED from the run's own measured content and DECLARED
  unverified, never borrowed from a name the run merely happens to sit under.
* **INV-2** — `<platform>:<frame>` where `<frame>` is from one of three DISJOINT namespaces, and
  the map from what the vendor stated to `<frame>` is INJECTIVE.
* **INV-3** — the reserved namespaces are enforced against untrusted vendor text, not hoped for.
* **INV-4** — a run whose frame identity is genuinely unknown SAYS so; it never invents one and it
  never borrows one.
* **INV-5** — a SINGLE stated identity is verbatim, so nothing that imports today moves.
"""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402

_LIB = VF.PKG.parent / "_lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))
from zero_core_guard import require_introducing_file  # noqa: E402

#: The marker that arms the ONE branch-diff assertion in this module — THIS FILE. The branch that
#: ADDS it is the branch whose diff the assertion describes, which is the shape
#: `spatial-types/tests/test_image_failure_provenance.py` already ships and the reason
#: `require_introducing_file` takes its marker as a parameter at all: keying on this package's
#: `manifest.yaml` would skip on the one branch the assertion is about (that manifest has been on
#: `origin/main` since long before this branch), which is self-limiting becoming SELF-DISABLING —
#: `derived-guards.md` §1 names that as strictly worse than no gate.
INTRODUCED = "src-app/packages/spatial-import-visium/tests/test_coordinate_space_identity.py"

#: A TREE root walked from this file — deliberately NOT `zero_core_guard.repo_root()`, which SKIPS
#: outside a git checkout (right for a branch-diff guard, wrong for a tree assertion).
_REPO_ROOT = Path(__file__).resolve().parents[4]


def test_the_arming_marker_names_a_real_file():
    """UNGATED. A marker that names nothing is a guard switched off, not a branch skipped.

    `require_introducing_file` takes its marker as a free string — the one thing it does not derive
    — so a typo, a rename or a deliberate edit disarms the assertion below permanently, and the skip
    looks exactly like a branch whose premise merely does not hold. The invariant is sound by
    construction: the marker is a path the introducing branch ADDS, so on every later branch it is a
    file that EXISTS, and this assertion is about no branch at all, so it runs everywhere.
    """
    assert (_REPO_ROOT / INTRODUCED).is_file(), (
        f"the arming marker `{INTRODUCED}` names no file in this tree, so the branch-diff "
        f"assertion in this module can never run again on any branch — and would go on reporting "
        f"a skip that says its premise merely does not hold")


def test_the_sibling_manifest_this_branch_does_NOT_own_is_untouched():
    """TEST-16 of `coordinate-frame-identity` [covers: ITEM-11] — #300's lesson, as a TEST.

    Manifest collisions hit FOUR consecutive spatial branches (#300). `spatial-types/manifest.yaml`
    is owned by a sibling branch (#313) right now and this branch changes no vendored declaration
    module (DEC-13), so it must be byte-identical to the one on `origin/main`.

    ## Why it is GATED, and why it lives in this file rather than beside the other TEST-16 half

    It is a question about a COMMIT RANGE, i.e. about somebody's branch, and
    `_lib/test_zero_core_guard.py::test_no_package_test_reads_a_branch_diff_without_a_scope_gate`
    refuses an ungated one — correctly: on `main` the branch is whoever happens to be running the
    suite, so the assertion is vacuous there, and on the next branch that legitimately moves
    `spatial-types` it goes RED in a package that had nothing to do with it. The repair the guard
    names is a scope gate keyed on a path THIS branch ADDS, and the only such path is this module,
    so the assertion lives where its own marker is. Its first spelling sat in
    `spatial-import-xenium/tests/test_coordinate_space_identity.py`, ungated, and the guard caught
    it — recorded here because the temptation is to widen `_SWEEP_EXCEPTIONS` instead, which
    `derived-guards.md` §5 names as one of the three things that are NOT the repair.

    `encoding="utf-8"` is EXPLICIT on the working-tree read (#333/#339/#330); the `origin/main` side
    is `subprocess` text, which `git` emits as UTF-8.
    """
    import subprocess

    root, _changed = require_introducing_file(
        INTRODUCED, __file__,
        reason="only the branch that introduces this module makes a claim about its own diff")
    types_manifest = VF.PKG.parent / "spatial-types" / "manifest.yaml"
    on_main = subprocess.run(
        ["git", "show", "origin/main:src-app/packages/spatial-types/manifest.yaml"],
        cwd=str(root), capture_output=True, text=True)
    if on_main.returncode != 0:
        pytest.skip(f"`origin/main` is not fetched in this checkout: {on_main.stderr.strip()}")
    assert types_manifest.read_text(encoding="utf-8") == on_main.stdout, (
        "`spatial-types/manifest.yaml` moved on this branch. A sibling branch (#313) owns it right "
        "now, and manifest collisions have hit four consecutive spatial branches (#300)")

#: The `library_ids` spellings #327 rows 1 and 2 were measured on: the vendor WROTE something and
#: it identifies nothing. They report `unverified-space-non-identifying-labels`, because each is a
#: thing the operator can go and replace.
PLACEHOLDER_LIBRARY_IDS = ("unknown", "0000000_0000000", "n/a", "NONE", " - ")

#: ...and the spellings that are NOTHING WRITTEN. A blank string is indistinguishable from the
#: attribute being absent and the operator has nothing to replace in it, so it reports
#: `unverified-space-no-vendor-statement` — the OTHER token, and the split is the point (§4.2).
BLANK_LIBRARY_IDS = ("", "  ")

#: THE POSITIVE CONTROL, as data (design §4.1 property 1 / DEC-3): every committed REAL vendor
#: bundle and the frame id it emitted BEFORE this branch, which it must still emit after. A fix
#: that moved these would have re-declared the frame of every already-imported dataset — the exact
#: cost #328's trade table is about, paid for nothing, since a single stated identity cannot be
#: framed non-injectively in the first place.
#:
#: LITERALS, not `f"visium:{VF.FIXTURE_LIBRARY_ID}"`: a test that re-derives the value it checks
#: is comparing the importer against a second copy of the importer's own expression.
REAL_BUNDLE_FRAMES = (
    (VF.FIXTURE, "visium:Visium_Mouse_Olfactory_Bulb"),
    (VF.CYTASSIST_V4, "visium:CytAssist_FFPE_Human_Lung_Squamous_Cell_Carcinoma"),
    (VF.CYTASSIST_V5_11MM, "visium:CytAssist_11mm_FFPE_Human_Colorectal_Cancer"),
)


def _module():
    return VF.load_compute()


def _space(entries):
    return VF.entry_by_id(entries, "spatial-coordinates")["meta"]


# ── TEST-1 [acceptance] (INV-2) — the vendor rung's own collisions ───────────────────

def test_a_placeholder_library_id_is_not_a_coordinate_frame():
    """TEST-1 [acceptance] [invariant: INV-2] [covers: ITEM-1, ITEM-2, ITEM-4, ITEM-8].

    INV-2, at the rung #327's first two measured rows land on. On `4b63a482` the `library_id` rung
    read the vendor string RAW — this module shipped no `vendor_statement`, no
    `_VENDOR_PLACEHOLDERS` and no `non_identifying_vendor_label`, the three predicates its sibling
    has had since #320 — so `library_ids: "unknown"` WAS the coordinate frame, identically, for
    every bundle that carried it.

    `0000000_0000000` is in the same list and on the same measurement: #270's DEC-7 rejected
    `library_ids` as the XENIUM frame identity precisely because both real Xenium bundles carry
    that value there (DEC-8, design §4.6).

    THE CONTROL is the last block, and it is what stops this passing by the ladder refusing
    everything: two runs stating the SAME identifying library id still DO share one frame. That
    property is the entire reason `coordinate_space` exists — without it a second image and a
    second section have nothing to place themselves against.
    """
    module = _module()
    ids_a, pos_a = ["A-1", "A-2"], np.asarray([[1.0, 2.0], [3.0, 4.0]], dtype=np.float32)
    ids_b, pos_b = ["B-1", "B-2"], np.asarray([[9.0, 8.0], [7.0, 6.0]], dtype=np.float32)

    for placeholder, expected_source in (
            [(v, module.NON_IDENTIFYING_SPACE_SOURCE) for v in PLACEHOLDER_LIBRARY_IDS]
            + [(v, module.NO_VENDOR_SPACE_SOURCE) for v in BLANK_LIBRARY_IDS]):
        attrs = {"library_ids": np.asarray([placeholder.encode()], dtype="S")}
        a = module.coordinate_space_id(attrs, ids_a, pos_a)
        b = module.coordinate_space_id(attrs, ids_b, pos_b)
        assert a[0] != b[0], (
            f"two unrelated runs whose matrix declares `library_ids: {placeholder!r}` are declared "
            f"to share one coordinate frame — one tissue's image registered against the other's "
            f"spots: {a} vs {b}")
        # ...and the SOURCE splits the operator-recoverable case from the one with nothing to
        # rename. A blank string is not a placeholder the operator can replace; it is the vendor
        # saying nothing, exactly as an absent attribute does.
        assert a[1] == b[1] == expected_source, (placeholder, a, b)

    # ...and the SELF-NAMING spellings, which are `non_identifying_vendor_label`'s question rather
    # than `_VENDOR_PLACEHOLDERS`': a value that is only the generic name of the field it fills
    # cannot distinguish this run from any other run that left it generic.
    for generic in ("library", "library_id", "  Library  "):
        attrs = {"library_ids": np.asarray([generic.encode()], dtype="S")}
        a = module.coordinate_space_id(attrs, ids_a, pos_a)
        b = module.coordinate_space_id(attrs, ids_b, pos_b)
        assert a[0] != b[0], (generic, a, b)

    # THE CONTROL. A real library id still names ONE frame for two imports of one slide.
    real = {"library_ids": np.asarray([b"Visium_Mouse_Olfactory_Bulb"], dtype="S")}
    assert module.coordinate_space_id(real, ids_a, pos_a) == \
        module.coordinate_space_id(real, ids_b, pos_b) == \
        ("visium:Visium_Mouse_Olfactory_Bulb", "library_id"), (
        "a stated library id must name ONE frame whatever the run contains, or two imports of one "
        "slide stop binding to each other")


# ── TEST-2 [acceptance] (INV-1) — the mount-name rung, end to end ────────────────────

def test_two_unrelated_bundles_mounted_at_the_same_directory_name_are_two_frames(tmp_path):
    """TEST-2 [acceptance] [invariant: INV-1] [covers: ITEM-3, ITEM-4, ITEM-10].

    INV-1's second half: *never borrowed from a name the run merely happens to sit under.*

    Rows 3 and 4 of #327's table, driven through the SHIPPED `run_import` over two staged REAL
    vendor bundles rather than through the helper alone — a unit test of the ladder proves the
    function, not that the importer calls it or that the rung it chose reaches the artifact.

    Both bundles are mounted at a directory literally called `outs`, which is what makes this the
    measured case rather than a contrived one: `bundle_root`'s basename is the SANDBOX MOUNT NAME
    (`sandbox/spec.rs`'s `derive_artifact_mount_name` / `InputDecl::declared_mount_name` derive it
    from the SLOT), so for an artifact-backed input it is plausibly the constant `bundle` for every
    Visium import in a deployment — and where it IS the user's own directory, `outs` is Space
    Ranger's own output directory name and therefore the most likely basename in existence for a
    Visium upload.

    The two runs are made genuinely UNRELATED the only way that matters after #327: by restaging
    the matrix's barcodes (and the positions rows they join to), because the frame identity is now
    a digest of the vendor's own measurement. Renaming the directories apart — what the old test
    did — would prove nothing about either version.

    The second assertion says the emitted id must not CONTAIN the directory name at all. A rung
    that mixed the mount into a digest preimage would still be distinct here and would still
    collide the day two uploads shared a basename.

    THE THIRD is the one that stops a MINTED id passing, and it is here because the docstring used
    to claim the second one did that — it does not, and a blind tests-quality angle proved it by
    making `unverified_space_id` return `uuid4().hex[:32]` and watching this test stay green
    (`"outs" not in <random hex>` is true for every mint). So bundle A is imported a SECOND time
    and must land in the SAME frame: a mint answers a new frame per import and dies here, which is
    the property `derived, never minted` actually means.
    """
    spaces = []
    for label in ("A", "B"):
        root = VF.stage_bundle(tmp_path / label)          # ...always named `outs`
        VF.set_library_id(root, None)
        VF.restage_barcodes(root, f"-{label}")
        VF.shift_positions(root, 137.5 if label == "B" else 0.0)
        _m, entries = VF.run_over(root, tmp_path / f"out-{label}")
        meta = _space(entries)
        assert root.name == "outs", root
        spaces.append(meta["coordinate_space"])

    assert spaces[0] != spaces[1], (
        "two unrelated bundles mounted at directories of the same name are declared to share one "
        f"coordinate frame: {spaces[0]}")
    for space in spaces:
        assert "outs" not in space, (
            "the frame id carries the bundle directory's name — a run's coordinate identity must "
            f"not be a function of where it happened to be mounted (#327): {space}")

    # ...and DERIVED, not MINTED: the same bundle, imported again, is the same frame.
    again = _space(VF.run_over(tmp_path / "A" / "outs", tmp_path / "out-A-again")[1])
    assert again["coordinate_space"] == spaces[0], (
        "two imports of ONE bundle landed in two frames, so the id is MINTED rather than derived "
        f"— a second image and a second section have nothing to place themselves against: "
        f"{again['coordinate_space']} vs {spaces[0]}")


# ── TEST-3 [acceptance] (INV-5) — the positive control over the REAL fixtures ────────

@pytest.mark.parametrize("bundle,expected", REAL_BUNDLE_FRAMES,
                         ids=[b.name for b, _ in REAL_BUNDLE_FRAMES])
def test_a_real_vendor_bundle_keeps_the_frame_id_it_has_today(bundle, expected):
    """TEST-3 [acceptance] [invariant: INV-5] [covers: ITEM-4, ITEM-6, ITEM-10].

    INV-5: *a SINGLE stated identity is verbatim, so nothing that imports today moves.*

    THE POSITIVE CONTROL for this whole branch. Every distinctness assertion in this file is
    satisfiable by a ladder that derives every frame and never reads the vendor at all — which
    would remove the collisions AND the property they are a corruption of. This is the assertion
    that forbids it, over the three committed REAL 10x bundles, at the exact values `origin/main`
    emits.

    It is also what makes DEC-3 checkable rather than merely stated: the sibling's rung 2 needed a
    namespace and a length-prefixed framing because it names a frame with TWO fields (#328); this
    platform names one with one, so it gets neither and its value does not move.
    """
    module = _module()
    import h5py

    with h5py.File(Path(bundle) / "filtered_feature_bc_matrix.h5", "r") as handle:
        attrs = dict(handle.attrs)
        barcodes = [b.decode() if isinstance(b, bytes) else str(b)
                    for b in handle["matrix"]["barcodes"][:]]
    positions = np.zeros((len(barcodes), 2), dtype=np.float32)

    assert module.coordinate_space_id(attrs, barcodes, positions) == (expected, "library_id"), (
        "a bundle that imports today changed the coordinate frame it declares — every artifact "
        "already emitted from it stops binding to its own re-import, and nothing downstream can "
        "detect that")
    # ...and it does not depend on the run's CONTENT, which is what "two imports of one slide
    # collide correctly" needs. Driven with a deliberately different measurement.
    assert module.coordinate_space_id(attrs, ["z-1"], np.asarray([[0.0, 0.0]], np.float32))[0] \
        == expected


def test_the_real_fixture_keeps_its_frame_id_through_the_WHOLE_import(tmp_path):
    """TEST-3 (cont.) [acceptance] [invariant: INV-5] [covers: ITEM-4] — on the ARTIFACT.

    The parametrized rows above drive the helper. This drives the shipped `run_import` over the
    committed bundle and reads the frame id off `spatial/coordinates.zarr`'s own declaration block,
    because a ladder can be right in a function the importer no longer calls — and this branch
    MOVED that call site (it is now below the positions join, where the derived rung's preimage
    exists), which is exactly the edit that can silently drop it.
    """
    _m, entries = VF.run_over(VF.FIXTURE, tmp_path / "out")
    meta = _space(entries)
    assert meta["coordinate_space"] == "visium:Visium_Mouse_Olfactory_Bulb"
    assert meta["coordinate_space_source"] == "library_id"
    assert meta["section"]["sample_id"] == VF.FIXTURE_LIBRARY_ID


# ── TEST-4 / TEST-5 — the derived rung is derived, and from BOTH halves ──────────────

def test_two_imports_of_one_bundle_with_no_library_id_are_ONE_frame(tmp_path):
    """TEST-4 [covers: ITEM-3] — DERIVED, never minted.

    The property §12.3 protects and the one a fresh digest per import would destroy: *"a minted id
    would make every import a new, unrelatable frame — and nothing downstream could tell."* Making
    the bottom rung a UUID passes every other test in this file.
    """
    root = VF.stage_bundle(tmp_path)
    VF.set_library_id(root, None)
    first, second = (_space(VF.run_over(root, tmp_path / f"out-{n}")[1]) for n in ("a", "b"))
    assert first["coordinate_space"] == second["coordinate_space"], (
        "two imports of ONE bundle landed in two different frames — the id is minted, not derived")
    assert first["coordinate_space_source"] == second["coordinate_space_source"]


def test_two_bundles_differing_ONLY_in_geometry_are_two_frames(tmp_path):
    """TEST-5 [covers: ITEM-3] — the positions half of the preimage is WIRED.

    The derived id is over the barcodes AND the positions joined to them. A digest of the barcodes
    alone is not enough, and that is a correction the sibling had to make after a blind angle drove
    two genuinely different measurements — one shifted 137.5 um from the other — whose matrices
    carried the same ids into ONE coordinate space. Nothing validates the vendor's barcode format,
    so identical ids across unrelated runs are reachable.

    Here the two bundles keep IDENTICAL barcodes and differ only in where their spots are, which is
    the one shape a barcode-only digest cannot see. It is also the shape that would let a mutant
    replace the call site's `coords` with zeros and stay green.
    """
    same, moved = VF.stage_bundle(tmp_path / "same"), VF.stage_bundle(tmp_path / "moved")
    for root in (same, moved):
        VF.set_library_id(root, None)
    VF.shift_positions(moved, 137.5)
    a = _space(VF.run_over(same, tmp_path / "out-same")[1])["coordinate_space"]
    b = _space(VF.run_over(moved, tmp_path / "out-moved")[1])["coordinate_space"]
    assert a != b, (
        "two runs measured in different places share one coordinate frame — the positions half of "
        f"the derived identity is not wired: {a}")


# ── TEST-6 — the mount rung is structurally gone, not merely unused ──────────────────

def test_the_bundle_root_parameter_is_GONE_from_the_frame_identity():
    """TEST-6 [covers: ITEM-4] — the parameter goes with the rung (DEC-5).

    Deleting the rung and keeping the parameter would leave the mount-name accident one edit away
    from returning. Deleting the PARAMETER makes the mount path structurally unavailable to the
    function — the same call #323 made one package over, for the same reason.

    Read from the shipped source with `encoding="utf-8"` explicitly: this module's comments carry
    em dashes, so a locale-default read raises or mis-decodes under `LC_ALL=C` and a guard that
    cannot read the file it audits goes green on a real regression (#333/#339/#330).
    """
    import inspect

    module = _module()
    parameters = list(inspect.signature(module.coordinate_space_id).parameters)
    assert "bundle_root" not in parameters, parameters
    assert parameters == ["matrix_attrs", "cell_ids", "positions"], parameters

    # The CODE, with the docstring dropped: the docstring legitimately says the parameter is gone,
    # and a substring scan over it would assert the opposite of what it means. Parsed rather than
    # sliced, so a later edit that moves the function cannot make this guard read the wrong text.
    import ast

    source = (VF.PKG / "compute" / "import_visium.py").read_text(encoding="utf-8")
    function = next(node for node in ast.walk(ast.parse(source))
                    if isinstance(node, ast.FunctionDef) and node.name == "coordinate_space_id")
    statements = function.body[1:] if ast.get_docstring(function) else function.body
    body = "\n".join(ast.unparse(node) for node in statements)
    assert "bundle_root" not in body, (
        "the frame identity reads the bundle root again — that is the SANDBOX MOUNT NAME and it is "
        "what #327 row 3 and row 4 collided on")


# ── TEST-7 [acceptance] (INV-4) — it SAYS so rather than borrowing ───────────────────

def test_a_run_with_no_stated_frame_says_so_and_borrows_nothing(tmp_path):
    """TEST-7 [acceptance] [invariant: INV-4] [covers: ITEM-3, ITEM-4, ITEM-10].

    INV-4: *a run whose frame identity is genuinely unknown SAYS so; it never invents one, and it
    never borrows one.* Three separate claims, because "unknown" can be said badly in three ways:

    1. the VALUE says it — `unverified-space:` is a namespace no vendor string may occupy, so the
       id is unreadable as a stated frame id by construction;
    2. the SOURCE says it, machine-readably, inside the declaration block that crosses into the
       sandbox (#211) rather than only in the report;
    3. and the source SPLITS the two cases, because only one of them is fixable by the operator: a
       bundle that wrote a placeholder can be re-exported with a real library id, and a bundle
       whose matrix has no `library_ids` attribute at all has nothing to rename.

    The split is asserted in both directions. Getting it backwards is not hypothetical — the
    sibling shipped it inverted once, telling the operator there was nothing to rename when a
    placeholder is precisely the thing they can replace, and a blind angle measured it.
    """
    module = _module()

    absent = VF.stage_bundle(tmp_path / "absent")
    VF.set_library_id(absent, None)
    meta = _space(VF.run_over(absent, tmp_path / "out-absent")[1])
    assert meta["coordinate_space"].startswith(f"visium:{module.UNVERIFIED_SPACE_PREFIX}"), meta
    assert meta["coordinate_space_source"] == module.NO_VENDOR_SPACE_SOURCE, meta

    placeholder = VF.stage_bundle(tmp_path / "placeholder")
    VF.set_library_id(placeholder, "unknown")
    meta = _space(VF.run_over(placeholder, tmp_path / "out-placeholder")[1])
    assert meta["coordinate_space"].startswith(f"visium:{module.UNVERIFIED_SPACE_PREFIX}"), meta
    assert meta["coordinate_space_source"] == module.NON_IDENTIFYING_SPACE_SOURCE, (
        "a bundle that WROTE a placeholder is reported as having written nothing — the operator is "
        "told there is nothing to rename when the placeholder is exactly what they can replace")

    # ...and the verbatim vendor value SURVIVES in the provenance block either way, which is what
    # makes the missed collision recoverable rather than merely visible (DEC-6).
    report_prov = _space(VF.run_over(placeholder, tmp_path / "out-p2")[1])["provenance"]
    assert report_prov["library_id"] == "unknown", report_prov


# ── TEST-8 — a digest over nothing is REFUSED, not minted ───────────────────────────

def test_a_matrix_with_no_spot_identity_is_REFUSED_by_name():
    """TEST-8 [covers: ITEM-3] — the one place the bottom rung may not answer.

    A matrix carrying no barcode identity at all would digest to ONE CONSTANT shared by every such
    bundle — this function's own defect, reintroduced at the rung that removes it. It refuses by
    name instead, which is the design's *never invents one* said at the only point where inventing
    is still possible.

    The refusal must be a `VisiumImportError`: `main()` catches only that, so anything else leaves
    the job as a raw traceback with output paths already on disk.

    The last assertion is the STRUCTURAL half, and it is the one that keeps working after this
    test's author has left: `refusal_sites` walks the module's own AST, finds every
    `raise VisiumImportError(...)` it contains, and proves each interpolation is either funnelled
    through `_quoted_for_refusal` or of a shape that cannot carry a vendor byte. The refusals this
    branch ADDS are inside that subject set the moment they are written, with nobody remembering
    anything (#336).
    """
    import visium_refusal_sites as refusal_sites

    module = _module()
    for ids in ([], ["", "  ", ""]):
        with pytest.raises(module.VisiumImportError) as exc:
            module.unverified_space_id(ids, np.zeros((len(ids), 2), dtype=np.float32))
        message = str(exc.value)
        assert "filtered_feature_bc_matrix.h5" in message, message
        assert "share one frame" in message, message

    source = (VF.PKG / "compute" / "import_visium.py").read_text(encoding="utf-8")
    refusal_sites.assert_module_is_funnelled(source)
    unprovable = refusal_sites.unsafe_interpolations(source)
    assert unprovable == [], (
        "a refusal this branch added interpolates a value the structural guard cannot prove safe. "
        "The guard firing IS the guard working — route the value through `_quoted_for_refusal`, or "
        f"state its shape in the source. {unprovable}")


# ── TEST-9 [acceptance] (INV-3) — the reserved namespace, against untrusted text ─────

def test_a_vendor_cannot_forge_the_unverified_space_namespace(tmp_path):
    """TEST-9 [acceptance] [invariant: INV-3] [covers: ITEM-2].

    INV-3: *a vendor value that opens with a reserved token is refused as an identity and the run
    falls to the derived rung.*

    The `.h5` root attributes are untrusted, so "no vendor writes `unverified-space:`" is a claim
    about attacker input. Without enforcement, a bundle stating a VICTIM's real derived id —
    readable out of any exported report — would emit a value byte-identical to the victim's frame
    while `coordinate_space_source` claimed `library_id`, and the two would be overlaid.

    Driven end to end, with the forged value taken from a real emitted id so the test cannot pass by
    the forgery being malformed, and in both case spellings because the claim is about what a READER
    can tell apart rather than about bytes.

    THE CONTROLS are the last block, and there are two because one of them could not discriminate.
    The first is a library id that merely contains the WORD `unverified`. The second CONTAINS THE
    WHOLE RESERVED TOKEN, just not at the front — which is the row that separates a PREFIX rule from
    a SUBSTRING one. Without it, replacing every `startswith(RESERVED_SPACE_PREFIXES)` in the module
    with `in` left this file and `test_coordinate_space.py` fully green, measured by a blind
    tests-quality angle; the xenium sibling's equivalent control (`roi-slide_id+region_name:7`) had
    the token in it and did discriminate. A substring rule would eat real ids, and this is the row
    that says so.
    """
    victim = VF.stage_bundle(tmp_path / "victim")
    VF.set_library_id(victim, None)
    VF.restage_barcodes(victim, "-VICTIM")
    stolen = _space(VF.run_over(victim, tmp_path / "out-victim")[1])["coordinate_space"]
    assert stolen.startswith("visium:unverified-space:"), stolen

    for label, forged in (("exact", stolen[len("visium:"):]),
                          ("upper", stolen[len("visium:"):].upper())):
        attacker = VF.stage_bundle(tmp_path / f"attacker-{label}")
        VF.set_library_id(attacker, forged)
        VF.restage_barcodes(attacker, f"-ATTACKER-{label}")
        VF.shift_positions(attacker, 555.0)
        meta = _space(VF.run_over(attacker, tmp_path / f"out-attacker-{label}")[1])
        assert meta["coordinate_space"] != stolen, (
            f"a bundle forged another run's derived frame id ({label} spelling) and was declared to "
            f"share its coordinate frame: {meta['coordinate_space']}")
        assert meta["coordinate_space_source"] == "unverified-space-non-identifying-labels", meta

    for label, honest_id in (("word", "unverified-library-7"),
                             ("token-not-at-the-front", "lib-unverified-space:7")):
        honest = VF.stage_bundle(tmp_path / f"honest-{label}")
        VF.set_library_id(honest, honest_id)
        meta = _space(VF.run_over(honest, tmp_path / f"out-honest-{label}")[1])
        assert meta["coordinate_space"] == f"visium:{honest_id}", (label, meta)
        assert meta["coordinate_space_source"] == "library_id", (label, meta)


# ── TEST-10 — `section.sample_id` stops inheriting the collision ─────────────────────

def test_the_section_sample_id_is_a_vendor_statement_or_says_it_is_not(tmp_path):
    """TEST-10 [covers: ITEM-5] — #327's third defect, which is #270's one package over.

    `provenance.get("sample_id") or provenance.get("library_id") or space_id`. Three raw reads into
    a field a consumer reads as *the vendor's sample identity*:

    * the `library_id` leg emitted a PLACEHOLDER as a stated sample id, so two unrelated tissues
      declared themselves sections of one sample;
    * the bare `space_id` leg inherited every frame collision the ladder could make, verbatim, into
      a field that does not even say it is a frame id.

    Both legs now read through the same predicates as the frame ladder, and the fallback is
    `unverified-sample:<space_id>` — a value unreadable as a vendor id by construction, which is the
    only channel `section(*, sample_id, index, ...)` leaves open (#318, DEC-7).

    THE CONTROLS, and there are three, because every one of the assertions above is satisfiable by
    a version that simply stopped emitting a sample id: a real `Sample ID` still wins; a real
    library id still answers when the metrics file has none; and the committed real fixture is
    unchanged.
    """
    module = _module()

    # 1. A PLACEHOLDER library id is not a sample identity — and neither run borrows the other's.
    sample_ids = []
    for label in ("A", "B"):
        root = VF.stage_bundle(tmp_path / f"placeholder-{label}")
        VF.set_library_id(root, "unknown")
        (root / "metrics_summary.csv").unlink()
        VF.restage_barcodes(root, f"-{label}")
        VF.shift_positions(root, 137.5 if label == "B" else 0.0)
        meta = _space(VF.run_over(root, tmp_path / f"out-placeholder-{label}")[1])
        sample_ids.append(meta["section"]["sample_id"])
        assert meta["section"]["sample_id"].startswith(module.UNVERIFIED_SAMPLE_PREFIX), meta
    assert sample_ids[0] != sample_ids[1], (
        "two unrelated runs are declared sections of ONE sample because both matrices carry the "
        f"same placeholder library id: {sample_ids[0]}")

    # 2. The BARE `space_id` leg is gone: whatever the fallback emits must announce itself.
    for sample_id in sample_ids:
        assert not sample_id.startswith("visium:"), (
            "`section.sample_id` is a raw coordinate frame id — a value a consumer reads as the "
            f"vendor's sample identity, filled from a frame: {sample_id}")

    # 3. A vendor cannot forge the sample namespace either, through `metrics_summary.csv`'s own
    #    `Sample ID` — untrusted vendor text, and the sibling shipped exactly this asymmetry once.
    forger = VF.stage_bundle(tmp_path / "forger")
    VF.set_library_id(forger, None)
    VF.restage_barcodes(forger, "-FORGER")
    metrics = (forger / "metrics_summary.csv").read_text(encoding="utf-8").splitlines()
    header, row = metrics[0].split(","), metrics[1].split(",")
    row[header.index("Sample ID")] = sample_ids[0]
    (forger / "metrics_summary.csv").write_text(
        "\n".join([",".join(header), ",".join(row)]) + "\n", encoding="utf-8")
    meta = _space(VF.run_over(forger, tmp_path / "out-forger")[1])
    assert meta["section"]["sample_id"] != sample_ids[0], (
        "a bundle forged another run's unverified sample id and was declared a section of ITS "
        f"sample, while sitting in a different coordinate frame: {meta['section']}")

    # 4. A SELF-NAMING `Sample ID` is not a sample identity either — #320's rule, on the rung
    #    #320 did not reach. `section_sample_id` wires `non_identifying_vendor_label` for this and
    #    NOTHING drove it: a blind tests-quality angle deleted that clause and the whole visium
    #    suite — this file, `test_coordinate_space.py`, `test_producer_end_to_end.py` and
    #    `test_vendored_contract.py` — stayed green. A predicate no test reaches is a claim, not a
    #    guard. The bundle carries a REAL library id, so a version that merely stopped emitting
    #    anything cannot pass this: the answer has to fall through to the NEXT rung, not to the
    #    bottom one.
    for generic in ("sample", "Sample"):
        root = VF.stage_bundle(tmp_path / f"generic-{generic}")
        VF.set_library_id(root, "Some_Library")
        metrics = (root / "metrics_summary.csv").read_text(encoding="utf-8").splitlines()
        header, row = metrics[0].split(","), metrics[1].split(",")
        row[header.index("Sample ID")] = generic
        (root / "metrics_summary.csv").write_text(
            "\n".join([",".join(header), ",".join(row)]) + "\n", encoding="utf-8")
        meta = _space(VF.run_over(root, tmp_path / f"out-generic-{generic}")[1])
        assert meta["section"]["sample_id"] == "Some_Library", (
            f"`Sample ID: {generic}` is the word every unfilled instance of that field carries, so "
            f"it cannot distinguish this run from any other run that left it generic — and it was "
            f"emitted as the vendor's sample identity: {meta['section']}")

    # CONTROL (a): a real `Sample ID` in the metrics file still wins, verbatim.
    stated = VF.stage_bundle(tmp_path / "stated")
    VF.set_library_id(stated, "Some_Library")
    metrics = (stated / "metrics_summary.csv").read_text(encoding="utf-8").splitlines()
    header, row = metrics[0].split(","), metrics[1].split(",")
    row[header.index("Sample ID")] = "Donor-04-BlockA"
    (stated / "metrics_summary.csv").write_text(
        "\n".join([",".join(header), ",".join(row)]) + "\n", encoding="utf-8")
    meta = _space(VF.run_over(stated, tmp_path / "out-stated")[1])
    assert meta["section"]["sample_id"] == "Donor-04-BlockA", meta["section"]

    # CONTROL (b): with no metrics file, a REAL library id still answers.
    library_only = VF.stage_bundle(tmp_path / "library-only")
    VF.set_library_id(library_only, "Some_Library")
    (library_only / "metrics_summary.csv").unlink()
    meta = _space(VF.run_over(library_only, tmp_path / "out-library-only")[1])
    assert meta["section"]["sample_id"] == "Some_Library", meta["section"]

    # CONTROL (c): the committed REAL fixture is untouched by all of it.
    meta = _space(VF.run_over(VF.FIXTURE, tmp_path / "out-real")[1])
    assert meta["section"]["sample_id"] == VF.FIXTURE_LIBRARY_ID, meta["section"]


# ── TEST-17 / TEST-18 — the two shapes the first cut of the TEXT rule let through ───

def test_a_NON_TEXT_library_ids_is_not_a_coordinate_frame(tmp_path):
    """TEST-17 [acceptance] [invariant: INV-2] [covers: ITEM-2] — design §3.3's *a frame label must
    be a STRING*, and §4.2's "a non-string" row.

    `library_ids` is an h5 root ATTRIBUTE, so h5py hands back a different Python type per dtype and
    a number arrives as an `np.ndarray` — the same CONTAINER shape every real bundle's string uses.
    The first cut of `vendor_frame_label` checked the container and not the element, so
    `library_ids: [0]` was stringified and emitted as `visium:0` with
    `coordinate_space_source: "library_id"`, IDENTICALLY for two unrelated runs. That is the exact
    `roi_uuid: 0` defect the sibling's DEC-15 removed, and #327's own defect at the rung meant to
    remove it: both identity predicates are blind to a non-string, so a number is an UNFILTERABLE
    identity.

    Found by two blind angles at once (correctness and design-conformance) and by a third
    (tests-quality) as the hole in the suite that let it through — no visium test drove a non-text
    `library_ids` at all.

    THE CONTROLS, both in the same run: the source token must be the OPERATOR-RECOVERABLE one (the
    vendor wrote something you can go and replace — `_wrote_a_frame_label` counts a non-text value
    as written, and getting that backwards tells the operator there is nothing to rename), and a
    real string library id must still answer on the vendor rung, or "no two runs collide" would be
    satisfiable by a module that refused everything.
    """
    import numpy as np

    module = _module()
    spaces = []
    for label, raw in (("int", np.array([0])), ("float", np.array([0.0])), ("bool", np.array([False]))):
        for run in ("A", "B"):
            root = VF.stage_bundle(tmp_path / f"{label}-{run}")
            VF.set_library_id_raw(root, raw)
            # The fixture's `metrics_summary.csv` states a REAL `Sample ID`, which is rung 1 of the
            # SAMPLE ladder and would answer before the library id ever gets asked. Removed so the
            # sample assertion below is about the rung this test is measuring.
            (root / "metrics_summary.csv").unlink()
            VF.restage_barcodes(root, f"-{label}-{run}")
            VF.shift_positions(root, 137.5 if run == "B" else 0.0)
            meta = _space(VF.run_over(root, tmp_path / f"out-{label}-{run}")[1])
            assert meta["coordinate_space"].startswith(
                f"visium:{module.UNVERIFIED_SPACE_PREFIX}"), (label, run, meta)
            assert meta["coordinate_space_source"] == module.NON_IDENTIFYING_SPACE_SOURCE, (
                f"a {label} `library_ids` is something the operator can go and replace, so the "
                f"report must say so rather than 'the vendor wrote nothing': {meta}")
            # ...and it must not have leaked into the SAMPLE identity either.
            assert meta["section"]["sample_id"].startswith(
                module.UNVERIFIED_SAMPLE_PREFIX), (label, run, meta["section"])
            spaces.append((label, run, meta["coordinate_space"]))
        a, b = [sp for lbl, _run, sp in spaces if lbl == label]
        assert a != b, (
            f"two unrelated runs whose `library_ids` is a {label} were declared to share one "
            f"coordinate frame: {a}")

    # CONTROL: a real, string library id still answers on the vendor rung, verbatim.
    honest = VF.stage_bundle(tmp_path / "honest")
    VF.set_library_id(honest, "Some_Library")
    meta = _space(VF.run_over(honest, tmp_path / "out-honest")[1])
    assert meta["coordinate_space"] == "visium:Some_Library", meta
    assert meta["coordinate_space_source"] == "library_id", meta


def test_a_MULTI_VALUED_library_ids_is_not_ONE_stated_identity(tmp_path):
    """TEST-18 [acceptance] [invariant: INV-2] [covers: ITEM-2] — #328's defect, one package over.

    Design §4.1's stated namespace is *the vendor identified the frame with ONE field -> that
    field's value, VERBATIM*, and §4.5 rests Visium's exemption from a namespace token on exactly
    that: *it is a single component, so it cannot be framed non-injectively.* `library_ids` is
    PLURAL and array-shaped, and `spaceranger aggr` genuinely writes several — so the premise is
    not free, it is a thing the code has to enforce.

    It did not. The identity path read through `decoded_vendor_text`, whose `", "` join is right for
    the PROVENANCE block (evidence: show what the vendor wrote) and is not injective:
    `[b"LibA", b"LibB"]` and `[b"LibA, LibB"]` are two different vendor statements and both emitted
    `visium:LibA, LibB`. Measured by two blind angles.

    The repair is NOT to frame the join — §4.1 says a stated identity is ONE field's value verbatim,
    so a multi-element attribute is not a stated identity at all and the run falls to the derived
    rung, DECLARED unverified (INV-4). The two runs below are otherwise identical in every byte the
    vendor rung can see, so a version that still read the join answers ONE frame for both.
    """
    import numpy as np

    module = _module()
    spaces = []
    for label, raw in (("split", np.array([b"LibA", b"LibB"])),
                       ("joined", np.array([b"LibA, LibB"]))):
        root = VF.stage_bundle(tmp_path / label)
        VF.set_library_id_raw(root, raw)
        VF.restage_barcodes(root, f"-{label}")
        VF.shift_positions(root, 137.5 if label == "split" else 0.0)
        meta = _space(VF.run_over(root, tmp_path / f"out-{label}")[1])
        spaces.append((label, meta))

    split = dict(spaces)["split"]
    joined = dict(spaces)["joined"]
    assert split["coordinate_space"] != joined["coordinate_space"], (
        "two unrelated runs making DIFFERENT vendor statements — a two-element `library_ids` and a "
        "one-element one that happens to contain the joiner — were declared to share one "
        f"coordinate frame: {split['coordinate_space']}")
    # The MULTI-valued one is not a stated identity; it is derived and says so.
    assert split["coordinate_space"].startswith(f"visium:{module.UNVERIFIED_SPACE_PREFIX}"), split
    assert split["coordinate_space_source"] == module.NON_IDENTIFYING_SPACE_SOURCE, split
    # CONTROL: the SINGLE-valued one is still the vendor's own statement, emitted verbatim — the
    # whole point of §4.5's exemption, and what a rule that simply refused arrays would destroy.
    assert joined["coordinate_space"] == "visium:LibA, LibB", joined
    assert joined["coordinate_space_source"] == "library_id", joined


def test_this_package_RESERVES_the_composed_namespace_it_never_writes(tmp_path):
    """TEST-19 [acceptance] [invariant: INV-3] [covers: ITEM-1] — INV-3 is about the SCHEME.

    INV-3: *the composed and derived namespaces are RESERVED: a vendor value that opens with EITHER
    token (case-folded) is refused as an identity and the run falls to the derived rung.*

    `spatial-import-visium` never EMITS a composed id — one field, one component, §4.5 — and a blind
    design-conformance angle pointed out that reserving is a different question from emitting: with
    only `unverified-space:` reserved, `library_ids: "slide_id+region_name:1:a|1:b|"` was accepted
    as a stated identity and emitted verbatim, i.e. a STATED frame sitting inside the COMPOSED
    namespace, so the three namespaces were not disjoint in this package.

    THE CONTROL, in the same run: a value that merely CONTAINS the token, not at the front, is the
    vendor's own statement and is emitted verbatim — the guard is a PREFIX rule (TEST-9's shape,
    which is where the substring/prefix distinction was measured).
    """
    module = _module()
    assert module.COMPOSED_SPACE_PREFIX in module.RESERVED_SPACE_PREFIXES

    for label, forged in (("exact", "slide_id+region_name:1:a|1:b|"),
                          ("upper", "SLIDE_ID+REGION_NAME:1:a|1:b|")):
        root = VF.stage_bundle(tmp_path / f"forge-{label}")
        VF.set_library_id(root, forged)
        VF.restage_barcodes(root, f"-{label}")
        meta = _space(VF.run_over(root, tmp_path / f"out-forge-{label}")[1])
        assert meta["coordinate_space"] != f"visium:{forged}", (
            f"a vendor value opening with the COMPOSED token ({label} spelling) was emitted as a "
            f"stated frame identity, inside a namespace this scheme writes itself: {meta}")
        assert meta["coordinate_space"].startswith(
            f"visium:{module.UNVERIFIED_SPACE_PREFIX}"), (label, meta)
        assert meta["coordinate_space_source"] == module.NON_IDENTIFYING_SPACE_SOURCE, (label, meta)

    honest = VF.stage_bundle(tmp_path / "honest-composed")
    VF.set_library_id(honest, "lib-slide_id+region_name:7")
    meta = _space(VF.run_over(honest, tmp_path / "out-honest-composed")[1])
    assert meta["coordinate_space"] == "visium:lib-slide_id+region_name:7", meta
    assert meta["coordinate_space_source"] == "library_id", meta


# ── TEST-15 — ONE frame scheme, not two ─────────────────────────────────────────────

#: The probe table both importers' `vendor_statement` must answer identically. STRINGS only: the
#: sibling's non-string arm is `_finite` (its vendor document is untrusted JSON and a numeric
#: `region_name` has to reach its provenance block) while this module's is `None`, and that
#: divergence is stated in `vendor_statement`'s own docstring rather than papered over here.
#:
#: EXPECTATIONS ARE LITERALS, and that is the whole of what makes this table a test. Its first
#: spelling computed them — `None if probe.strip().lower() in visium._VENDOR_PLACEHOLDERS else
#: probe.strip()` — which is `vendor_statement`'s own body over `vendor_statement`'s own constant,
#: so it could not fail on a wrong vocabulary. A blind tests-quality angle proved it by adding `"0"`
#: to BOTH importers' `_VENDOR_PLACEHOLDERS` — silently turning a stated identity into a no-answer —
#: and watching the test stay green. Written out, the same edit reddens the `"0"` row.
SHARED_STATEMENT_PROBES = (
    ("unknown", None),
    ("UNKNOWN", None),
    (" n/a ", None),
    ("", None),
    ("  ", None),
    ("-", None),
    ("none", None),
    ("null", None),
    ("na", None),
    ("0000000_0000000", None),
    ("Visium_Mouse_Olfactory_Bulb", "Visium_Mouse_Olfactory_Bulb"),
    ("Slide_1", "Slide_1"),
    ("0", "0"),
    ("  Donor-04  ", "Donor-04"),
)


def test_the_two_importers_agree_on_what_a_vendor_STATEMENT_is():
    """TEST-15 [covers: ITEM-1, ITEM-8] — the two packages are one frame scheme.

    #327 and #328 are the same defect in two packages, and the task they came from names the
    failure mode directly: implementing them separately produces two incompatible frame schemes.
    Nothing mechanical holds these two modules equal — they are SIBLINGS, not a vendored pair
    (only `compute/spatial_declarations.py` is byte-identical across the three spatial packages,
    and this branch does not touch it) — so the agreement is asserted rather than assumed.

    Three things must agree: the placeholder vocabulary, the key-suffix rule that derives the
    self-naming question, and the answers both `vendor_statement`s give over a shared probe table.
    A drift in any of them means a consumer reading `coordinate_space` off the two importers is
    reading two vocabularies while believing it is reading one.
    """
    visium = _module()
    xenium_path = VF.PKG.parent / "spatial-import-xenium" / "compute" / "import_xenium.py"
    assert xenium_path.is_file(), xenium_path
    source = xenium_path.read_text(encoding="utf-8")

    # Read the sibling's tuples out of its SOURCE rather than importing it: importing both entries
    # in one process makes them fight over the bare `spatial_declarations` name in `sys.modules`,
    # which is the ambiguity `visium_fixtures.load_compute` exists to avoid.
    import ast

    tree = ast.parse(source)
    literals = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign) and len(node.targets) == 1:
            target = node.targets[0]
            if isinstance(target, ast.Name) and target.id in (
                    "_VENDOR_PLACEHOLDERS", "_NON_IDENTIFYING_KEY_SUFFIXES"):
                literals[target.id] = ast.literal_eval(node.value)

    assert literals["_VENDOR_PLACEHOLDERS"] == visium._VENDOR_PLACEHOLDERS, (
        "the two importers disagree about what a vendor's NO-ANSWER spelling is, so one of them "
        f"treats a placeholder as an identity: {literals['_VENDOR_PLACEHOLDERS']} vs "
        f"{visium._VENDOR_PLACEHOLDERS}")
    assert "0000000_0000000" in visium._VENDOR_PLACEHOLDERS, visium._VENDOR_PLACEHOLDERS
    assert literals["_NON_IDENTIFYING_KEY_SUFFIXES"] == visium._NON_IDENTIFYING_KEY_SUFFIXES

    # ...and the RESERVED namespace tokens, which INV-3 states about the SCHEME rather than about a
    # package. `spatial-import-visium` never EMITS a composed id and still reserves the token; a
    # blind design-conformance angle found the two tuples disagreeing, which made the three
    # namespaces non-disjoint on one side of a scheme whose whole claim is that it is ONE.
    for name in ("UNVERIFIED_SPACE_PREFIX", "COMPOSED_SPACE_PREFIX"):
        assert f'{name} = "{getattr(visium, name)}"' in source, (
            f"the two importers disagree about `{name}`, so a value one refuses as a forgery the "
            f"other emits as a vendor statement")
    assert visium.RESERVED_SPACE_PREFIXES == (
        visium.UNVERIFIED_SPACE_PREFIX, visium.COMPOSED_SPACE_PREFIX), visium.RESERVED_SPACE_PREFIXES

    # ...and the SHARED namespace token, which is what a consumer actually reads.
    assert visium.UNVERIFIED_SPACE_PREFIX == "unverified-space:"
    assert visium.UNVERIFIED_SAMPLE_PREFIX == "unverified-sample:"
    assert f'UNVERIFIED_SPACE_PREFIX = "{visium.UNVERIFIED_SPACE_PREFIX}"' in source
    assert f'UNVERIFIED_SAMPLE_PREFIX = "{visium.UNVERIFIED_SAMPLE_PREFIX}"' in source

    for probe, expected in SHARED_STATEMENT_PROBES:
        assert visium.vendor_statement(probe) == expected, (probe, expected)
    for key, value, expected in (("library_id", "library", True),
                                 ("library_id", "library_id", True),
                                 ("library_id", "Visium_Mouse_Olfactory_Bulb", False),
                                 ("sample_id", "sample", True),
                                 ("sample_id", "Donor-04", False)):
        assert visium.non_identifying_vendor_label(key, value) is expected, (key, value)
