#!/usr/bin/env python3
# ruff: noqa
"""TEST-11 — `spatial/visium-hd-bundle`, the container #160 made expressible, on a layout.

Member matching used to be BASENAME-only, so a Visium HD bundle could not group at all:
`binned_outputs/square_002um|008um|016um/` each mirror a full Visium `outs/`, giving every
declared member three candidates. #160 changed the core rule to **a declared member matches
on as many trailing path segments as it declares**, which lets a container say for itself
how much context it needs — and leaves every previously-shipped member, all of which are
bare basenames, matching exactly as before.

Everything here is checked against the real directory tree in
`fixtures/visium-hd-outs/` rather than reasoned about, because the failure mode is silent:
a member that resolves to zero files or to two does not error, the bundle simply never
groups.
"""
import json
import re
import sys
from pathlib import Path

import pytest
import yaml

HERE = Path(__file__).resolve().parent
PACKAGES = HERE.parent.parent
REPO = PACKAGES.parent.parent
SPATIAL_TYPES = HERE.parent / "manifest.yaml"
HD_FIXTURE = HERE / "fixtures" / "visium-hd-outs"
VISIUM_FIXTURE = PACKAGES / "spatial-import-visium" / "tests" / "fixtures" / "visium-outs"

HD = "spatial/visium-hd-bundle"
VISIUM = "spatial/visium-bundle"
XENIUM = "spatial/xenium-bundle"

#: The literal the CORE enumerates (`dataset/repository.rs::manifest_group_specs`). Read
#: out of the Rust source below rather than trusted here.
GROUPING_CAPABILITY = "mtx-trio-target"

_COMPRESSION = (".gz", ".bz2", ".xz", ".zst")


def _datatypes():
    doc = yaml.safe_load(SPATIAL_TYPES.read_text())
    return {d["id"]: d for d in doc["contributes"]["datatypes"]}


def _members(type_id):
    return _datatypes()[type_id]["input_requirements"]["members"]


_ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def _segments(name):
    """`repository.rs::member_path_segments` — a name ending in a separator names a
    DIRECTORY and yields nothing; otherwise both separators are honoured, empty segments
    are dropped, each segment is lowercased ASCII-ONLY (the core uses
    `to_ascii_lowercase`, so `str.lower()` here would fold U+212A and make this mirror
    wider than what ships), and ONE compression suffix comes off the LAST segment only.

    Pinned to the core by `test_the_python_mirror_agrees_with_the_cores_committed_case_table`
    — which is what caught all three of those divergences in this function's first cut.
    """
    text = str(name)
    if text.endswith("/") or text.endswith("\\"):
        return []
    segs = [s.translate(_ASCII_LOWER) for s in re.split(r"[/\\]", text) if s]
    if segs:
        for suffix in _COMPRESSION:
            if segs[-1].endswith(suffix):
                segs[-1] = segs[-1][: -len(suffix)]
                break
    return segs


def _alternatives(member):
    """A declared member, split on the core's ONE matching sugar."""
    return [m.strip() for m in member.split("|") if m.strip()]


def _matches_member(path, member):
    """`repository.rs::matches_member` — a K-segment alternative matches the candidate's
    LAST K segments."""
    got = _segments(path)
    for alt in _alternatives(member):
        want = _segments(alt)
        if want and len(got) >= len(want) and got[len(got) - len(want):] == want:
            return True
    return False


def _matching_files(root, member):
    root = Path(root)
    return [
        p.relative_to(root)
        for p in root.rglob("*")
        if p.is_file() and _matches_member(p.relative_to(root), member)
    ]


# ── the fixture is real, or every quantifier below is vacuous ────────────────────────


def test_the_hd_layout_fixture_exists_and_is_the_three_bin_shape():
    assert HD_FIXTURE.is_dir(), f"the HD layout fixture is missing at {HD_FIXTURE}"
    files = [p for p in HD_FIXTURE.rglob("*") if p.is_file()]
    assert len(files) >= 30, f"the fixture collapsed to {len(files)} files"
    for bin_dir in ("square_002um", "square_008um", "square_016um"):
        assert (HD_FIXTURE / "binned_outputs" / bin_dir).is_dir(), bin_dir
    # The collision that made this issue exist must be PRESENT in the fixture, or the
    # test below proves nothing.
    collisions = [p for p in HD_FIXTURE.rglob("filtered_feature_bc_matrix.h5")]
    assert len(collisions) == 3, (
        "the three identically-named per-bin matrices are the whole problem; the fixture "
        f"holds {len(collisions)}"
    )


# ── the container ────────────────────────────────────────────────────────────────────


def test_the_hd_container_is_declared_and_shaped_like_its_siblings():
    types = _datatypes()
    assert HD in types, "the HD upload container is not declared"
    dt = types[HD]
    assert dt["extends"] == "data/opaque"
    assert dt["is_abstract"] is False
    assert dt["title"] and dt["description"]
    ir = dt["input_requirements"]
    assert ir["requires"] == "manifest"
    assert ir["allow_archive"] is True
    assert dt["storage"]["file_layout"] == "manifest"
    assert dt["storage"]["layout"]["kind"] == "opaque_as_is"


def test_the_grouping_capability_literal_is_present_and_is_the_cores_own():
    """Without the literal the CORE enumerates, the type is never enumerated, no
    `ManifestGroupSpec` is built, `detect_manifest_group` never runs for it, and an HD
    upload silently lands as twelve unrelated single-file datasets."""
    source = (REPO / "src-app" / "server" / "src" / "modules" / "dataset"
              / "repository.rs").read_text(encoding="utf-8")
    m = re.search(r'MANIFEST_GROUP_CAPABILITY:\s*&str\s*=\s*"([^"]+)"', source)
    assert m, "MANIFEST_GROUP_CAPABILITY moved; re-point this derivation"
    assert m.group(1) == GROUPING_CAPABILITY
    assert GROUPING_CAPABILITY in _datatypes()[HD]["capabilities"]


def test_the_container_declares_the_axis_vocabulary_a_handed_over_container_must():
    """The shipped INV-7 rule, mirrored here because this container's FIRST CUT broke it.

    A container a user HANDS OVER (it declares `input_requirements`) must declare the axis
    vocabulary a supporting file aligns to — `dataset/routes.rs` validates a supporting
    file's axis against `reg.axes_for(dataset.datatype)`, so with no axes every axis is
    unknown and attaching an annotation table to an upload is refused. Withholding them
    "cost a working feature" once already, per the visium container's own comment, and
    `ui/src/modules/workbench/core/manifest/datatypeShape.test.ts` turned red on the first
    cut of this one.

    Declaring `cells` is not a claim that the bundle holds ONE row space: the axis name is
    a join key, and which resolution an emitted artifact describes is carried by
    `measured_entity` at write time. `spatial/image` and `spatial/labels` declare no axes
    because they carry no `input_requirements` — nobody hands them over.
    """
    types = _datatypes()
    dt = types[HD]
    names = {a["name"] for a in dt.get("axes", [])}
    assert names, (
        "the HD container declares `input_requirements` and NO axes; a supporting file "
        "attached to an uploaded bundle would then have no axis vocabulary to align to"
    )
    assert dt["entity_axis"] in names
    # …and it uses the SAME vocabulary as its siblings, or the join key forks.
    for sibling in (VISIUM, XENIUM):
        sib = types[sibling]
        assert {a["name"] for a in sib["axes"]} == names
        assert sib["entity_axis"] == dt["entity_axis"]
        assert {a["name"]: a["key_label"] for a in sib["axes"]} == {
            a["name"]: a["key_label"] for a in dt["axes"]
        }
    # The rule is about being HANDED OVER, not about being opaque — the two rasters are
    # opaque and axis-free precisely because they carry no `input_requirements`.
    for raster in ("spatial/image", "spatial/labels"):
        assert types[raster].get("input_requirements") is None
        assert not types[raster].get("axes")


# ── the members, on the real layout ──────────────────────────────────────────────────


def test_the_twelve_members_are_distinct_and_cover_exactly_the_three_bins():
    """A duplicated member is invisible to the "each matches exactly one file" check
    below — each copy still matches its one file — and it makes the WHOLE bundle
    ungroupable, because that file then claims two declared members and
    `detect_manifest_group` refuses. Found by a mutation that this suite did not catch.
    """
    members = _members(HD)
    assert len(members) == 12, f"expected four files x three bins, got {len(members)}"
    assert len(set(members)) == 12, (
        "a member is declared twice; one uploaded file would then claim two members and "
        f"the bundle could never group: {sorted(m for m in members if members.count(m) > 1)}"
    )
    bins = {m.split("/")[0] for m in members}
    assert bins == {"square_002um", "square_008um", "square_016um"}, sorted(bins)
    for b in sorted(bins):
        assert len([m for m in members if m.startswith(b + "/")]) == 4, (
            f"bin {b} declares an unequal number of members — the three resolutions are "
            "supposed to be described identically"
        )


def test_the_python_mirror_agrees_with_the_cores_committed_case_table():
    """The rule has THREE implementations; this one answers to the same table as the others.

    `server/src/modules/dataset/member_match_cases.json` is the authority: the Rust core
    asserts against it in its own unit test, the TypeScript upload-wizard mirror asserts
    against it in `memberMatch.test.ts`, and this mirror — which every member assertion in
    this file runs through — asserts against it here. Without it, `_matches_member` below
    could drift from the core and every "exactly one file" claim in this file would be a
    claim about a function nothing ships.
    """
    table = json.loads((REPO / "src-app" / "server" / "src" / "modules" / "dataset"
                        / "member_match_cases.json").read_text(encoding="utf-8"))
    cases = table["cases"]
    assert len(cases) >= 20, f"the case table collapsed to {len(cases)} row(s)"
    positives = sum(1 for c in cases if c["matches"])
    assert positives >= 5 and len(cases) - positives >= 5, (
        "both verdicts must be represented, or 'they all agree' is satisfied by a table of "
        "one answer and a predicate that always gives it"
    )
    wrong = [
        f"{c['file']!r} vs {c['member']!r} should be {c['matches']} ({c['why']})"
        for c in cases
        if _matches_member(c["file"], c["member"]) != c["matches"]
    ]
    assert not wrong, "this mirror disagrees with the core's case table:\n" + "\n".join(wrong)


def test_the_declared_member_ORDER_is_pinned():
    """The member ORDER is a live contract until sandbox staging preserves the path.

    `dataset/process.rs::build_dataset_inputs` flattens a multi-file dataset to
    `{ordinal}_{basename}`, and the ordinal is the link order, which is the DECLARED member
    order. So for this container the `square_NNNum/` segment — the entire distinction
    between the three resolutions — survives into the sandbox only as that integer.
    Reordering the list below would silently re-point every previously-ingested dataset's
    ordinals at a different resolution, with no version and no error anywhere.

    This test is the thing that fails instead. It is a GOLDEN, and it is deliberately
    unpleasant to update: the fix is not to re-freeze it but to make staging carry the path
    (recorded as the first task of the HD importer item), after which this can go.
    """
    assert _members(HD) == [
        "square_002um/filtered_feature_bc_matrix.h5",
        "square_002um/spatial/tissue_positions.parquet",
        "square_002um/spatial/scalefactors_json.json",
        "square_002um/spatial/tissue_hires_image.png",
        "square_008um/filtered_feature_bc_matrix.h5",
        "square_008um/spatial/tissue_positions.parquet",
        "square_008um/spatial/scalefactors_json.json",
        "square_008um/spatial/tissue_hires_image.png",
        "square_016um/filtered_feature_bc_matrix.h5",
        "square_016um/spatial/tissue_positions.parquet",
        "square_016um/spatial/scalefactors_json.json",
        "square_016um/spatial/tissue_hires_image.png",
    ]


def test_every_declared_member_matches_exactly_one_file_in_the_hd_layout():
    """The DECLARATION fits the layout: each declared member resolves to exactly one path
    in the tree Space Ranger writes, which is the statement that was false before #160.

    What this does NOT prove is that the CORE still implements the rule — it runs the
    Python mirror above, which is pinned to the core by the case-table test. The matcher
    claim itself is carried by `repository.rs`'s own unit tests and by the end-to-end
    upload in `server/tests/dataset/hd_bundle_group_test.rs`.
    """
    members = _members(HD)
    assert len(members) == 12, f"expected four files x three bins, got {len(members)}"
    for member in members:
        found = _matching_files(HD_FIXTURE, member)
        assert len(found) == 1, (
            f"{member!r} matched {len(found)} files ({[str(p) for p in found]}) — a member "
            "with zero or two candidates does not error, the bundle simply never groups"
        )
        # …and it matched the file in ITS OWN bin.
        bin_dir = member.split("/")[0]
        assert bin_dir in found[0].parts, f"{member!r} matched {found[0]} (wrong bin)"


def test_the_basename_only_rule_would_still_fail_on_this_fixture():
    """The before/after, asserted rather than remembered: with the `square_NNNum/`
    prefixes stripped — the declaration as it would have to be written under the old
    rule — every member has three candidates."""
    for member in _members(HD):
        flat = member.split("/")[-1]
        found = _matching_files(HD_FIXTURE, flat)
        assert len(found) >= 2, (
            f"{flat!r} matched {len(found)} file(s); this fixture is supposed to make the "
            "basename rule ambiguous, and if it does not the test above proves nothing"
        )


def test_no_shipped_member_matches_an_hd_upload_uniquely_and_vice_versa():
    """Three carriers are only safe while none can resolve another's upload. Proven in
    BOTH directions on real trees, not by comparing declaration strings."""
    types = _datatypes()
    # An HD bundle must not resolve for the plain-Visium or Xenium containers. Ambiguity
    # is enough to stop the group forming, and that is the point: the plain container
    # REFUSES an HD upload rather than quietly taking one bin.
    for foreign in (VISIUM, XENIUM):
        resolved = [
            m for m in types[foreign]["input_requirements"]["members"]
            if len(_matching_files(HD_FIXTURE, m)) == 1
        ]
        assert not resolved, (
            f"{foreign} would resolve {resolved} uniquely inside an HD bundle, so which "
            "carrier wins would depend on undeclared ordering"
        )
    # …and no HD member resolves inside a plain Visium bundle.
    #
    # Both directions above are satisfied by ABSENCE, which is also what a broken
    # `_matching_files` (or an emptied fixture) produces — so each side gets a positive
    # control on the very tree being scanned, and the Visium leg is no longer wrapped in an
    # `if` that would skip the whole thing silently.
    assert VISIUM_FIXTURE.is_dir(), (
        f"the Visium fixture is missing at {VISIUM_FIXTURE}; the leg below would pass by "
        "scanning nothing"
    )
    for m in _members(HD):
        assert not _matching_files(VISIUM_FIXTURE, m), (
            f"the HD member {m!r} matched inside a plain Visium bundle"
        )
    # POSITIVE CONTROLS — the scanner DOES find things in both trees.
    for member in types[VISIUM]["input_requirements"]["members"]:
        assert len(_matching_files(VISIUM_FIXTURE, member)) == 1, (
            f"{member!r} does not resolve in its OWN fixture, so every 'matched nothing' "
            "assertion above is about a scanner that finds nothing anywhere"
        )
    assert _matching_files(HD_FIXTURE, _members(HD)[0]), (
        "the HD scanner finds nothing in the HD tree either — the disjointness above is "
        "vacuous in both directions"
    )


def test_the_shipped_containers_members_are_all_depth_one():
    """A cross-guard on a Python mirror in ANOTHER package.

    `spatial-import-xenium/tests/test_bundle_container.py` re-implements the core matcher
    as BASENAME-only, which stays correct exactly as long as every member it examines is
    depth-1. This asserts that precondition here, so making one of those members
    path-carrying turns THIS test red instead of silently weakening that one.
    """
    for type_id in (VISIUM, XENIUM):
        for member in _members(type_id):
            for alt in _alternatives(member):
                assert len(_segments(alt)) == 1, (
                    f"{type_id}'s member {alt!r} now carries a path segment; the "
                    "basename-only mirror in spatial-import-xenium/tests must be updated "
                    "with it"
                )


def test_the_run_root_files_are_deliberately_not_members():
    """DEC-5 — `barcode_mappings.parquet` and `feature_slice.h5` are the REASON this is
    one dataset and are still not declared, because no real HD bundle was available to
    verify their presence and spelling, and an unverified member is a bundle-wide
    failure. They are present in the fixture so this exclusion is checked, not assumed.
    """
    declared = " ".join(_members(HD))
    for name in ("barcode_mappings.parquet", "feature_slice.h5", "web_summary.html",
                 "molecule_info.h5"):
        assert name not in declared, f"{name} became a member without a real bundle to check it"
    for name in ("barcode_mappings.parquet", "feature_slice.h5"):
        assert (HD_FIXTURE / name).is_file(), (
            f"{name} is missing from the fixture, so the exclusion above is untested"
        )
