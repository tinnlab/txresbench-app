#!/usr/bin/env python3
# ruff: noqa
"""TEST-10..13 — resolving twelve declared members into three bins, in BOTH staged layouts.

This is the part of the importer with no analogue in `spatial-import-visium`, and it is the
part where a mistake is SILENT. Every other reader in this module fails loudly on bad input;
a bin mis-attribution imports real counts, writes a real tissue map, passes every internal
consistency check, and stamps the artifacts with a resolution that is not the one the counts
came from.

So the resolution is tested from three directions: that it works on the tree the container
declares against (TEST-10), that it works on the flat layout a real sandbox actually stages
(TEST-11), and that its answer is CHECKED against the bundle's own `bin_size_um` rather than
trusted (TEST-12). TEST-13 covers the bundles that are not HD at all.
"""
import json
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import make_fixture as MF  # noqa: E402

CONTAINER = "spatial/visium-hd-bundle"
SPATIAL_TYPES = HF.PACKAGES / "spatial-types" / "manifest.yaml"


def _declared_members():
    """The container's OWN member list, read from the shipped manifest.

    `encoding="utf-8"` is EXPLICIT: that manifest's prose is full of em dashes, so under
    `LC_ALL=C` a locale-default read raises and this guard would fail for a reason that has
    nothing to do with what it measures — or, worse, a `try` around it would make it green.
    (#330/#333/#336/#339 are four separate instances of this defect in this repo.)
    """
    doc = yaml.safe_load(SPATIAL_TYPES.read_text(encoding="utf-8"))
    by_id = {d["id"]: d for d in doc["contributes"]["datatypes"]}
    return by_id[CONTAINER]["input_requirements"]["members"]


# ── TEST-10: the declared member list, and this module's copy of it ─────────────────


def test_TEST_10_the_computes_member_list_IS_the_containers_member_list():
    """TEST-10 — the compute's `DECLARED_MEMBERS` is CHECKED against the container, not trusted.

    A compute cannot read a manifest: the sandbox stages a flat `/code` dir holding the entry
    and its declared helpers, and nothing else. So the member list is necessarily a SECOND
    SPELLING of a fact `spatial-types/manifest.yaml` owns — and an unchecked second spelling
    is how the container gains a fourth bin, or reorders one, while this importer keeps
    reading the old shape and silently attributing every file one slot over.

    The ORDER is asserted too, and it is the load-bearing half: in the flattened staging
    layout the ordinal IS the index into this list, so a reordering here re-points every
    staged file at a different bin with no error anywhere. `spatial-types`' own
    `test_the_declared_member_ORDER_is_pinned` freezes that order from the container's side;
    this is the consumer's side of the same contract.
    """
    module = HF.load_compute()
    assert list(module.DECLARED_MEMBERS) == list(_declared_members()), (
        "`import_visium_hd.DECLARED_MEMBERS` no longer matches "
        "`spatial/visium-hd-bundle.input_requirements.members`. Re-copy it; the ORDER "
        "matters as much as the contents, because the staging ordinal is an index into it."
    )


def test_TEST_10_the_declared_layout_is_DERIVED_and_covers_every_member():
    """TEST-10 — `declared_bin_layout()` derives both maps rather than restating them.

    The bin/role table and the ordinal table are computed from `DECLARED_MEMBERS`, so the
    test's job is to prove the derivation is total: every declared member lands in exactly
    one (bin, role) cell, every bin gets all four roles, and the ordinal map is a bijection
    onto the member indices. A derivation that quietly dropped a member would otherwise
    produce a bin that never resolves, which reads as "the bundle is incomplete".
    """
    module = HF.load_compute()
    by_bin, by_ordinal = module.declared_bin_layout()

    assert sorted(by_bin) == sorted(MF.BINS)
    for bin_um, roles in by_bin.items():
        assert sorted(roles) == sorted(module.MEMBER_ROLES), (
            f"the {bin_um} um bin resolved roles {sorted(roles)}"
        )
    assert sorted(by_ordinal) == list(range(len(module.DECLARED_MEMBERS)))
    # ...and each ordinal names the member at that index.
    for ordinal, (bin_um, role) in by_ordinal.items():
        assert by_bin[bin_um][role] == module.DECLARED_MEMBERS[ordinal]


def test_TEST_10_every_declared_member_resolves_to_exactly_one_file_in_the_tree():
    """TEST-10 — leg (a): the path-preserving layout, over the committed fixture.

    Each declared member must find exactly one file, and it must find the file in ITS OWN
    bin. The second half is not redundant: the three bins hold identically-named files, which
    is the whole reason #160 existed, so a matcher that fell back to basenames would find
    three candidates for each member and a matcher that took the first would be silently
    wrong two times in three.
    """
    module = HF.load_compute()
    bundle = module.locate_bins(HF.FIXTURE)

    assert bundle["layout"] == "path-preserving"
    assert sorted(bundle["bins"]) == sorted(MF.BINS)
    for bin_um, roles in bundle["bins"].items():
        for role in module.MEMBER_ROLES:
            path = roles[role]
            assert path.is_file()
            assert f"square_{bin_um:03d}um" in path.parts, (
                f"the {bin_um} um bin's {role} resolved to {path}, which is in another bin"
            )


def test_TEST_10_a_duplicated_member_is_REFUSED_rather_than_resolved(tmp_path):
    """TEST-10 — two candidates for one declared member is a refusal, not a choice.

    The same rule the upload planner applies (`detect_manifest_group` returns nothing unless
    exactly one file matches each member). Choosing between two would be a guess about which
    run's data this is, and the guess is invisible afterwards.
    """
    module = HF.load_compute()
    root = HF.staged_tree(tmp_path)
    victim = root / "binned_outputs" / "square_008um" / "spatial" / "tissue_positions.parquet"
    twin = root / "copy" / "square_008um" / "spatial"
    twin.mkdir(parents=True)
    (twin / victim.name).write_bytes(victim.read_bytes())

    with pytest.raises(module.VisiumImportError) as exc:
        module.locate_bins(root)
    assert "candidates" in str(exc.value)
    assert "tissue_positions.parquet" in str(exc.value)


# ── TEST-11: the flattened layout a real sandbox actually stages ────────────────────


def test_TEST_11_the_FLAT_staging_layout_resolves_the_same_three_bins(tmp_path):
    """TEST-11 — leg (b): `{i}_{basename}` at slot `bundle_{i}`, which is what production writes.

    `dataset/process.rs::build_dataset_inputs` flattens a multi-file dataset, so in the
    sandbox there is no `square_NNNum/` anywhere — twelve files with four distinct basenames,
    each appearing three times, distinguished only by an integer prefix. An importer tested
    only against the tree would meet this layout for the first time in production.

    The assertion is not merely "three bins came out": it is that each bin's four members are
    the RIGHT four, checked by comparing bytes against the source tree. The three bins' files
    are byte-distinguishable by construction (different lattices, different matrices), so a
    basename-first matcher that grouped `0_`, `4_` and `8_` together would be caught.
    """
    module = HF.load_compute()
    inputs, ordinals = HF.staged_flat(tmp_path)
    bundle = module.locate_bins(inputs, slot_ordinals=ordinals)

    assert bundle["layout"] == "flattened-by-staging-ordinal"
    assert sorted(bundle["bins"]) == sorted(MF.BINS)
    for bin_um, roles in bundle["bins"].items():
        for role, member in module.declared_bin_layout()[0][bin_um].items():
            staged = roles[role].read_bytes()
            source = (HF.FIXTURE / "binned_outputs" / member).read_bytes()
            assert staged == source, (
                f"the {bin_um} um bin's {role} resolved to bytes that belong to another bin"
            )


def test_TEST_11_the_ordinal_comes_from_the_SLOT_NAME_when_inputs_json_has_one(tmp_path):
    """TEST-11 — the slot name is the authority, and the filename prefix is the fallback.

    Both are written by the server, but only one of them is the CONTRACT: the slot is
    `{slot}_{i}` by construction in `build_dataset_inputs`, while the subpath's `{i}_` prefix
    exists to keep the flat directory collision-free. Proved by renaming the files so their
    prefixes LIE and leaving `inputs.json` correct — the bins must still come out right.
    """
    module = HF.load_compute()
    inputs, ordinals = HF.staged_flat(tmp_path)
    # TWO PHASES, because the lying prefix collides with a real one: ordinals 0, 4 and 8 all
    # carry `filtered_feature_bc_matrix.h5`, so a single-pass rename would OVERWRITE a sibling
    # and the test would then be about a bundle with eight files in it.
    staging = {}
    for path, ordinal in ordinals.items():
        parked = path.with_name(f"parked{ordinal}")
        path.rename(parked)
        staging[parked] = ordinal
    renamed = {}
    for parked, ordinal in staging.items():
        # A prefix that is a different, still-VALID ordinal: if the filename won, this would
        # silently regroup rather than fail, which is exactly the case worth proving.
        basename = Path(HF.load_compute().DECLARED_MEMBERS[ordinal]).name
        lying = parked.with_name(f"{(ordinal + 4) % 12}_{basename}")
        parked.rename(lying)
        renamed[lying] = ordinal
    bundle = module.locate_bins(inputs, slot_ordinals=renamed)
    for bin_um, roles in bundle["bins"].items():
        for role, member in module.declared_bin_layout()[0][bin_um].items():
            assert roles[role].read_bytes() == (
                HF.FIXTURE / "binned_outputs" / member).read_bytes()


def test_TEST_11_the_ordinal_alone_does_not_make_an_unrelated_file_a_member(tmp_path):
    """TEST-11 — the ordinal says WHERE a file sits, not WHAT it is.

    Both halves are required: an ordinal with the wrong basename must not be adopted (that is
    how a `7_notes.txt` would become the 8 um bin's tissue image), and the bundle must then
    be incomplete rather than silently three-quarters resolved.
    """
    module = HF.load_compute()
    inputs, ordinals = HF.staged_flat(tmp_path)
    image = next(p for p, o in ordinals.items() if o == 7)
    decoy = image.with_name("7_notes.txt")
    image.unlink()
    decoy.write_text("not an image", encoding="utf-8")
    ordinals = {(decoy if p == image else p): o for p, o in ordinals.items()}

    with pytest.raises(module.VisiumImportError) as exc:
        module.locate_bins(inputs, slot_ordinals=ordinals)
    # The 8 um bin is INCOMPLETE, so it is not offered — and an incomplete bin set is refused
    # by name rather than imported as the two bins that happen to be whole. The refusal must
    # name the missing bin, or a user has to work out which quarter of their bundle is gone.
    message = str(exc.value)
    assert "absent or incomplete" in message
    assert "'8'" in message, f"the refusal does not name the missing 8 um bin: {message}"


# ── TEST-12: the verification that makes leg (b) safe ───────────────────────────────


def test_TEST_12_a_bin_whose_own_scalefactors_DISAGREE_is_refused(tmp_path):
    """TEST-12 — the staging ordinal is CHECKED against the data, not trusted.

    This is the test that makes the whole flattened-layout leg defensible. The ordinal is a
    contract frozen by a golden in another package, and `spatial-types`' own docstring calls
    that golden "deliberately unpleasant to update" and names the real repair as making
    staging carry the path. Until it does, a staging change that reordered the ordinals would
    import the 16 um matrix and stamp every artifact 2 um — silently, with every internal
    check still passing.

    So the group's own `scalefactors_json.json` has to agree. Here the 8 um bin's scale file
    declares `bin_size_um: 16`, which is exactly what such a reorder would look like from
    inside the importer, and it must be a named refusal that states BOTH numbers.
    """
    module = HF.load_compute()
    root = HF.staged_tree(tmp_path, scalefactor_overrides={8: {"extra": {"bin_size_um": 16.0}}})

    with pytest.raises(module.VisiumImportError) as exc:
        module.locate_bins(root)
    message = str(exc.value)
    assert "bin_size_um" in message
    assert "16" in message and "8" in message


def test_TEST_12_the_FLAT_layout_refuses_a_bin_that_declares_no_bin_size(tmp_path):
    """TEST-12 — the strictness follows the strength of the evidence, deliberately.

    Under the flattened layout the ordinal is the ONLY evidence for which resolution a group
    is, so a scale file with no `bin_size_um` leaves nothing to corroborate it with and the
    bundle is REFUSED. Importing on the ordinal alone would stamp artifacts with a bin size
    nothing in the bundle confirms — and the refusal says so, and says what to do instead
    (upload as an archive so the directories survive).
    """
    module = HF.load_compute()
    root = HF.staged_tree(tmp_path, scalefactor_overrides={8: {"drop": ("bin_size_um",)}})
    inputs, ordinals = HF.staged_flat(tmp_path, source=root)

    with pytest.raises(module.VisiumImportError) as exc:
        module.locate_bins(inputs, slot_ordinals=ordinals)
    assert "bin_size_um" in str(exc.value)
    assert "archive" in str(exc.value)


def test_TEST_12_the_TREE_layout_ACCEPTS_a_bin_that_declares_no_bin_size(tmp_path):
    """TEST-12 — …and the same input is accepted when the PATH names the bin.

    The positive control on the rule above. Without it, "a missing `bin_size_um` is refused"
    would read as an unconditional rule, and the asymmetry — which is the whole design — would
    be indistinguishable from an oversight. Here the directory says `square_008um`, which is
    direct evidence, so the run proceeds and records that the vendor did not declare it.
    """
    module = HF.load_compute()
    root = HF.staged_tree(tmp_path, scalefactor_overrides={8: {"drop": ("bin_size_um",)}})
    bundle = module.locate_bins(root)
    assert bundle["bins"][8]["bin_size_um_declared"] is False
    assert bundle["bins"][16]["bin_size_um_declared"] is True


# ── TEST-13: the bundles that are not Visium HD ─────────────────────────────────────


def test_TEST_13_a_standard_visium_outs_bundle_is_refused_by_name(tmp_path):
    """TEST-13 — a plain Visium `outs/` is refused, and the refusal names the other importer.

    The mirror image of `spatial-import-visium`'s own HD refusal, and deliberately so: a user
    who points the wrong importer at a bundle must be told which one to use, not told that
    their bundle is broken. The bundle used here is the SIBLING'S REAL COMMITTED VENDOR
    BUNDLE, not a synthetic stand-in, so this assertion is about real Space Ranger bytes even
    though the HD fixture is not.
    """
    module = HF.load_compute()
    real_visium = HF.PACKAGES / "spatial-import-visium" / "tests" / "fixtures" / "visium-outs"
    assert real_visium.is_dir(), "the sibling's committed vendor bundle has moved"

    with pytest.raises(module.VisiumImportError) as exc:
        module.locate_bins(real_visium)
    message = str(exc.value)
    assert "Import Visium (Space Ranger)" in message


def test_TEST_13_a_bundle_with_only_one_bin_is_refused_by_name(tmp_path):
    """TEST-13 — a partial `binned_outputs/` is refused rather than imported as what is there.

    The container's stated assumption is that a run writes all three default bins, and its
    stated failure mode for a run that does not is a loud, self-explaining refusal rather
    than a silent partial import. This importer inherits that: two bins present is not "a
    bundle with two bins", it is a bundle this importer cannot vouch for.
    """
    module = HF.load_compute()
    root = HF.staged_tree(tmp_path, bins=(8,))
    with pytest.raises(module.VisiumImportError) as exc:
        module.locate_bins(root)
    message = str(exc.value)
    assert "absent or incomplete" in message
    # It must name BOTH missing bins, not merely say something is wrong: the whole point of
    # the container's "loud, self-explaining failure" is that the reader learns what to
    # re-export without opening the bundle.
    assert "'2'" in message and "'16'" in message, message
    assert "archive" in message


def test_TEST_13_the_corrected_claim_pins_the_archive_arm_and_loose_file_scope(tmp_path):
    """TEST-13 — #540: the corrected claim, pinned so the contradiction cannot return.

    The old message asserted a false guarantee ("did not come through that route") and then
    recommended the archive arm as a way to get a partial bundle past the check. #540
    corrected both halves: the `MANIFEST_GROUP_INCOMPLETE` refusal is TRUE ONLY FOR A
    LOOSE-FILE (FOLDER-MODE) UPLOAD, and a bundle reaching this importer incomplete via the
    ARCHIVE arm is a real, expected state the importer refuses by name here. This pins the
    corrected claim in the message AND the matching retirement qualifier in the comment, so
    reverting either to the old wording reddens this test.
    """
    module = HF.load_compute()
    root = HF.staged_tree(tmp_path, bins=(8,))
    with pytest.raises(module.VisiumImportError) as exc:
        module.locate_bins(root)
    message = str(exc.value)
    lower = message.lower()
    # The refusal is loose-file-only, and the archive arm is a REAL route for an incomplete
    # bundle — the opposite of the old "did not come through that route".
    assert "loose-file" in lower, message
    assert "archive arm" in lower, message
    # The old advice is gone: the archive route bypasses the upload-time completeness check,
    # so it is NOT a way to get a partial bundle past this refusal.
    assert "so the whole tree is retained" not in lower, message
    # The comment carries the matching retirement qualifier (mirroring spatial-types #440).
    source = Path(module.__file__).read_text(encoding="utf-8")
    assert "TRUE ONLY FOR A LOOSE-FILE (FOLDER-MODE) UPLOAD" in source
    assert "archive arm" in source


def test_TEST_13_no_refusal_in_this_PACKAGE_sends_a_reader_to_a_CLOSED_issue(tmp_path):
    """TEST-13 — the defect #313 was filed about, asserted at the point it would recur.

    #313 exists because `import_visium.py`'s HD refusal points the reader at #160, which is
    CLOSED — "a deferral that outlived the issue it deferred to". The general repair is that
    a refusal must send a reader somewhere they can ACT: another importer, an upload arm, a
    re-export. This asserts the negative on the refusals this module actually emits, which is
    a narrower claim than `test_no_closed_issue_pointers.py`'s source-wide sweep and a more
    direct one — these are the strings a user really sees.
    """
    module = HF.load_compute()
    seen = []
    for build, requested in (
        (dict(bins=(8,)), None),
        (dict(), 5),
    ):
        root = HF.staged_tree(tmp_path / f"case{len(seen)}", **build)
        with pytest.raises(module.VisiumImportError) as exc:
            bundle = module.locate_bins(root)
            module.select_bin(sorted(bundle["bins"]), requested)
        seen.append(str(exc.value))
    assert seen, "no refusal was exercised, so this guard measured nothing"
    for message in seen:
        assert "#160" not in message, (
            "a refusal points the reader at #160, which is CLOSED — that is the exact defect "
            "#313 was filed about"
        )


# ── TEST-37: optional members are matched by NAME, and scoped to the bin ────────────


def _bin_spatial(root, bin_um):
    return Path(root) / "binned_outputs" / f"square_{bin_um:03d}um" / "spatial"


def test_TEST_37_an_optional_member_is_matched_by_EQUALITY_and_not_by_SUFFIX(tmp_path):
    """TEST-37 — `run2_tissue_lowres_image.png` is not this run's lowres image.

    ## The defect

    The optional members — the lowres image, the diagnostics, `metrics_summary.csv` — were
    matched with `p.name.lower().endswith(<basename>)`. A suffix test also adopts
    `run2_tissue_lowres_image.png` as THE lowres image and `old_metrics_summary.csv` as the
    run's metrics. It is silent by construction: these are members that report NOTHING when
    they are simply absent, so the wrong file arriving looks exactly like the right one.

    The flattened staging layout is why a suffix test was reached for at all — there the
    file really is called `7_tissue_lowres_image.png` — so the fix is to strip the ordinal
    prefix EXPLICITLY and compare equal, which finds what staging writes and nothing that
    merely ends the same way.

    ## What is asserted

    Both directions, because a matcher that found nothing would also pass the first half: the
    decoy is NOT adopted, and the REAL file still is.
    """
    module = HF.load_compute()
    root = HF.staged_tree(tmp_path)
    decoy = _bin_spatial(root, 8) / "run2_tissue_lowres_image.png"
    decoy.write_bytes((_bin_spatial(root, 8) / "tissue_lowres_image.png").read_bytes())
    (Path(root) / "old_metrics_summary.csv").write_text("Sample ID,x\nOTHER,1\n",
                                                        encoding="utf-8")

    bundle = module.locate_bins(root)
    lowres = [img["path"] for img in bundle["bins"][8]["extra_images"]
              if img["basename"] == "tissue_lowres_image.png"]
    assert lowres == [_bin_spatial(root, 8) / "tissue_lowres_image.png"], (
        f"the lowres image resolved to {lowres!r}; a decoy whose name merely ENDS in the "
        f"member's basename was adopted as this run's image")
    assert bundle["metrics"] == Path(root) / "metrics_summary.csv", (
        f"the run's metrics resolved to {bundle['metrics']!r} — a file called "
        f"`old_metrics_summary.csv` is not this run's metrics summary")


def test_TEST_37_a_DIAGNOSTIC_from_ANOTHER_BIN_is_not_evidence_about_THIS_one(tmp_path):
    """TEST-37 — the diagnostics scan is scoped to the selected bin, and drops ambiguity.

    The scan took `[first match anywhere in the tree][:1]`. An archive upload carries one
    copy of each diagnostic PER BIN, so "the first file whose name ends in
    `aligned_fiducials.jpg`" is decided by sort order across three bins — and a diagnostic
    from the wrong bin is a picture a human reads as evidence about this one.

    Two cases, one assertion each:

    * a diagnostic present ONLY in another bin is not adopted at all;
    * a diagnostic present in SEVERAL places inside the selected bin's own `spatial/` is
      DROPPED rather than taken first — an ambiguous diagnostic is not a diagnostic.
    """
    module = HF.load_compute()
    root = HF.staged_tree(tmp_path)
    blob = b"\xff\xd8\xff\xe0not-a-real-jpeg"

    # (a) present only in the 2 um bin; the 8 um import must not adopt it.
    (_bin_spatial(root, 2) / "aligned_fiducials.jpg").write_bytes(blob)
    bundle = module.locate_bins(root)
    adopted = [p.name for p in bundle["bins"][8]["diagnostics"]]
    assert "aligned_fiducials.jpg" not in adopted, (
        f"the 8 um bin adopted a diagnostic that exists only under `square_002um/`: "
        f"{[str(p) for p in bundle['bins'][8]['diagnostics']]}")

    # (b) two copies inside the selected bin's own scope: ambiguous, so neither.
    (_bin_spatial(root, 8) / "detected_tissue_image.jpg").write_bytes(blob)
    (_bin_spatial(root, 8) / "3_detected_tissue_image.jpg").write_bytes(blob)
    bundle = module.locate_bins(root)
    adopted = [p.name for p in bundle["bins"][8]["diagnostics"]]
    assert not [n for n in adopted if n.endswith("detected_tissue_image.jpg")], (
        f"an ambiguous diagnostic was resolved by taking one of them: {adopted!r}")


def test_TEST_37_a_RUN_ROOT_vendor_image_is_still_REPORTED(tmp_path):
    """TEST-37 — §7.2's non-placeable and diagnostic images live at the RUN ROOT.

    ## The regression this pins shut

    Scoping the optional-member search to the selected bin's own `spatial/` directory closed
    a real defect (a diagnostic from another bin read as evidence about this one) and opened
    another: the vendor's layout (`01-file-formats.md:568-575`) puts `cytassist_image.tiff`,
    `aligned_fiducials.jpg` and `detected_tissue_image.jpg` in the RUN's `spatial/`, not
    under a bin — so every one of them silently vanished from the report. `[]` in
    `images_not_emitted` is indistinguishable from a bundle that carries no CytAssist image,
    while `NON_PLACEABLE_VENDOR_IMAGES`' own shipped text still promises "it is reported here
    instead".

    §7.2 requires `cytassist_image.tiff` to be reported rather than dropped, and the QC
    diagnostics to be embedded. Both are asserted here, from the run root.

    ## And the exclusion it must NOT undo

    The last leg re-asserts the original rule from the other side: a diagnostic sitting under
    ANOTHER bin is still not adopted. "Not another bin's" is the rule; "inside this bin's" was
    the over-correction.
    """
    module = HF.load_compute()
    root = HF.staged_tree(tmp_path)
    run_spatial = Path(root) / "spatial"
    run_spatial.mkdir(parents=True, exist_ok=True)
    (run_spatial / "cytassist_image.tiff").write_bytes(b"II*\x00 not a real tiff")
    (run_spatial / "aligned_fiducials.jpg").write_bytes(b"\xff\xd8\xff\xe0 not a real jpeg")

    bundle = module.locate_bins(root)
    roles = bundle["bins"][8]

    non_placeable = [spec["basename"] for spec in roles["non_placeable_images"]]
    assert "cytassist_image.tiff" in non_placeable, (
        f"the run-root CytAssist image is not reported: {non_placeable!r}. §7.2 says it is "
        f"'Not dropped' — an image this importer cannot place must be named, because absent "
        f"and unplaceable are the same `[]` to a reader")

    diagnostics = [p.name for p in roles["diagnostics"]]
    assert "aligned_fiducials.jpg" in diagnostics, (
        f"the run-root fiducials diagnostic is not embedded: {diagnostics!r}")

    # …and the rule it must not undo: another BIN's copy is still not this bin's evidence.
    other = Path(root) / "binned_outputs" / "square_002um" / "spatial"
    (other / "detected_tissue_image.jpg").write_bytes(b"\xff\xd8\xff\xe0 other bin")
    bundle = module.locate_bins(root)
    adopted = [p.name for p in bundle["bins"][8]["diagnostics"]]
    assert "detected_tissue_image.jpg" not in adopted, (
        f"the 8 um bin adopted a diagnostic that exists only under `square_002um/`: "
        f"{adopted!r}")


def test_TEST_37_the_run_root_report_REACHES_THE_ARTIFACTS(tmp_path):
    """TEST-37 — and it survives all the way into the emitted report, not just `locate_bins`.

    `locate_bins` returning the right paths is necessary and not sufficient: the reason §7.2
    names these files is that a HUMAN has to be told about them, and the channel is the
    report. A run-root CytAssist image must appear in `images_not_emitted` WITH its reason.
    """
    module = HF.load_compute()
    root = HF.staged_tree(tmp_path)
    run_spatial = Path(root) / "spatial"
    run_spatial.mkdir(parents=True, exist_ok=True)
    (run_spatial / "cytassist_image.tiff").write_bytes(b"II*\x00 not a real tiff")

    module.run_import(root, tmp_path / "out")
    report = json.loads(
        (Path(tmp_path) / "out" / "visium-hd-import-report.json").read_text(encoding="utf-8"))
    notes = [n for n in report["images_not_emitted"] if n.startswith("cytassist_image.tiff:")]
    assert len(notes) == 1, (
        f"the run-root CytAssist image produced {len(notes)} notes in the report: "
        f"{report['images_not_emitted']!r}")
    assert "scalefactor" in notes[0], (
        f"the note does not say WHY the image was not emitted: {notes[0]!r}")


def test_TEST_37_the_BINS_OWN_copy_WINS_over_a_run_root_copy(tmp_path):
    """TEST-37 — the run root is a FALLBACK, not a union. An artifact was lost to this.

    ## The defect a fix round introduced

    Admitting run-root files (so §7.2's diagnostics are reported) was done as a plain union.
    The very citation that authorises it — `01-file-formats.md:568-575` — puts
    `tissue_hires_image.png` and `tissue_lowres_image.png` in that same run `spatial/`
    directory, one line above the diagnostics. So on the DOCUMENTED layout the run-root copy
    and the bin's own copy of one basename both matched, `len(hits) > 1`, and the caller
    reported the member as AMBIGUOUS: `spatial-image-lowres` stopped being emitted at all.

    An artifact LOST, not a note gained. And the diagnostics collapsed the same way from the
    other side — `aligned_fiducials.jpg` present at both the run root and in the bin (which
    this module's own docstring says an archive upload really does carry) gave two hits and
    was dropped, back to the `[]` the scoping existed to prevent.

    ## What is asserted

    On the vendor's own layout — BOTH copies present — the bin's copy is chosen, the lowres
    image is still EMITTED, and the diagnostic is still embedded. Plus the control: with only
    the run-root copy, the run-root file is used (the fallback is real). And the rule that
    must not be undone: two copies inside the bin's OWN scope are still ambiguous, because
    resolving those by sort order is a guess.
    """
    module = HF.load_compute()
    root = HF.staged_tree(tmp_path)
    run_spatial = Path(root) / "spatial"
    run_spatial.mkdir(parents=True, exist_ok=True)
    bin_spatial = _bin_spatial(root, 8)
    (run_spatial / "tissue_lowres_image.png").write_bytes(
        (bin_spatial / "tissue_lowres_image.png").read_bytes())
    blob = b"\xff\xd8\xff\xe0 fiducials"
    (run_spatial / "aligned_fiducials.jpg").write_bytes(blob)
    (bin_spatial / "aligned_fiducials.jpg").write_bytes(blob)

    roles = module.locate_bins(root)["bins"][8]
    lowres = [img["path"] for img in roles["extra_images"]
              if img["basename"] == "tissue_lowres_image.png"]
    assert lowres == [bin_spatial / "tissue_lowres_image.png"], (
        f"the lowres image resolved to {lowres!r} with ambiguous="
        f"{roles['ambiguous_images']!r} — the vendor's own layout carries the file at BOTH "
        f"the run root and in the bin, and reading that as ambiguous LOSES the artifact")
    assert "tissue_lowres_image.png" not in roles["ambiguous_images"]
    assert [p for p in roles["diagnostics"] if p.name == "aligned_fiducials.jpg"] == [
        bin_spatial / "aligned_fiducials.jpg"], (
        f"the diagnostic resolved to {[str(p) for p in roles['diagnostics']]!r}")

    # …and it really is EMITTED, which is the thing that was lost.
    entries = module.run_import(root, tmp_path / "out")
    assert {e["id"] for e in entries if e["datatype"] == "spatial/image"} == {
        "spatial-image-hires", "spatial-image-lowres"}

    # The control: with no bin-local copy, the run-root one is used.
    (bin_spatial / "tissue_lowres_image.png").unlink()
    roles = module.locate_bins(root)["bins"][8]
    lowres = [img["path"] for img in roles["extra_images"]
              if img["basename"] == "tissue_lowres_image.png"]
    assert lowres == [run_spatial / "tissue_lowres_image.png"], (
        f"the run-root fallback did not fire: {lowres!r}")

    # The rule that must NOT be undone: ambiguity WITHIN the bin's own scope stays ambiguous.
    (bin_spatial / "tissue_lowres_image.png").write_bytes(blob)
    (bin_spatial / "9_tissue_lowres_image.png").write_bytes(blob)
    roles = module.locate_bins(root)["bins"][8]
    assert "tissue_lowres_image.png" in roles["ambiguous_images"], (
        "two copies inside the bin's own `spatial/` were resolved rather than reported")
