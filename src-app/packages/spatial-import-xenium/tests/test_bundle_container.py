#!/usr/bin/env python3
# ruff: noqa
"""`spatial/xenium-bundle` — the upload container, checked against real bundles.

The container is what turns N uploaded files into ONE dataset. It has one precondition and
it is unforgiving: member matching is by BASENAME, and `detect_manifest_group` returns
nothing unless EXACTLY ONE file matches each member. A member that matches zero files, or
two, does not error — the bundle simply never groups, and the upload lands as N unrelated
single-file datasets with no message anywhere.

So every member is checked against the REAL directory listings rather than reasoned about,
and the Visium container is re-checked in the same test because adding a second
`mtx-trio-target` carrier is exactly the kind of change that breaks the first one silently.
"""
import sys
from pathlib import Path

import pytest
import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402

PACKAGES = XF.PKG.parent
SPATIAL_TYPES = PACKAGES / "spatial-types" / "manifest.yaml"
VISIUM_FIXTURE = PACKAGES / "spatial-import-visium" / "tests" / "fixtures" / "visium-outs"

#: The literal the CORE enumerates (`dataset/repository.rs::manifest_group_specs`). Its
#: VALUE is what matters, not its readability: a container declaring only a
#: descriptively-named marker is never enumerated, no `ManifestGroupSpec` is built, and the
#: upload silently does not group.
GROUPING_CAPABILITY = "mtx-trio-target"


def _datatypes():
    doc = yaml.safe_load(SPATIAL_TYPES.read_text())
    return {d["id"]: d for d in doc["contributes"]["datatypes"]}


_ASCII_LOWER = str.maketrans("ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz")


def _normalize(filename):
    """The BASENAME case of `repository.rs::member_path_segments` — the last segment,
    lowercased ASCII-ONLY.

    #160 replaced `normalize_member_name` (which this used to name) with a segment
    splitter: a declared member now matches on as many trailing path segments as it
    declares, and a member with no separator still matches on the basename — which is every
    member this file examines, guarded by
    `spatial-types/tests/test_hd_bundle_container.py::test_the_shipped_containers_members_are_all_depth_one`.

    ASCII-only, not `str.lower()`: the core uses `to_ascii_lowercase`, so full Unicode
    folding here would make this mirror WIDER than what ships and quietly assert that a
    bundle groups when it does not.
    """
    base = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1].translate(_ASCII_LOWER)
    # ONE compression suffix comes off — a third divergence the case-table pin found. The
    # core has always done this ("drop ONE compression suffix"), and without it this mirror
    # is NARROWER than what ships: a vendor that stopped gzipping a member would still
    # group for real and would look ungroupable here.
    for suffix in (".gz", ".bz2", ".xz", ".zst"):
        if base.endswith(suffix):
            return base[: -len(suffix)]
    return base


def _alternatives(member):
    """A declared member, split on the core's ONE matching sugar."""
    return [m.strip() for m in member.split("|") if m.strip()]


def _matches(root, member):
    """Every file under `root` any alternative of `member` matches, by basename."""
    wanted = {_normalize(a) for a in _alternatives(member)}
    return [p for p in Path(root).rglob("*") if p.is_file() and _normalize(p.name) in wanted]


def test_this_mirror_agrees_with_the_cores_committed_case_table():
    """Four implementations of one matching rule, and this was the one nothing pinned.

    `server/src/modules/dataset/member_match_cases.json` is the authority the Rust core, the
    TypeScript upload-wizard mirror and `spatial-types`' Python mirror all answer to. This
    file carries a FOURTH — the basename-only form above — and until #160 it cited a symbol
    that no longer exists and folded the whole of Unicode.

    It is pinned on the subset it implements: the DEPTH-1 cases. A case whose member carries
    a separator is skipped, because the basename form is not supposed to answer those (and
    the precondition that the containers THIS file examines are all depth-1 is asserted in
    `spatial-types/tests/test_hd_bundle_container.py`). The skip is bounded so the pin
    cannot quietly become vacuous.
    """
    import json

    table = json.loads(
        (PACKAGES.parent.parent / "src-app" / "server" / "src" / "modules" / "dataset"
         / "member_match_cases.json").read_text(encoding="utf-8")
    )
    depth1 = [
        c for c in table["cases"]
        if all("/" not in a and "\\" not in a for a in _alternatives(c["member"]))
        and "/" not in c["file"] and "\\" not in c["file"]
        and not c["file"].endswith("/")
    ]
    assert len(depth1) >= 4, (
        f"only {len(depth1)} depth-1 case(s) survived the filter — the pin collapsed and "
        "was about to pass having checked almost nothing"
    )
    assert any(c["matches"] for c in depth1) and any(not c["matches"] for c in depth1)
    wrong = [
        f"{c['file']!r} vs {c['member']!r} should be {c['matches']} ({c['why']})"
        for c in depth1
        if any(_normalize(a) == _normalize(c["file"]) for a in _alternatives(c["member"]))
        != c["matches"]
    ]
    assert not wrong, "this mirror disagrees with the core's case table:\n" + "\n".join(wrong)


# ── TEST-21: the Xenium container ────────────────────────────────────────────────────


def test_the_xenium_container_is_declared_and_shaped_like_its_sibling():
    """TEST-21 — the declaration, mirrored line-for-line on `spatial/visium-bundle`."""
    types = _datatypes()
    assert "spatial/xenium-bundle" in types, (
        "the container must live in spatial-types beside spatial/visium-bundle — #163 and "
        "#164 operate on the same bundle and must not depend on the phase-1 importer"
    )
    bundle = types["spatial/xenium-bundle"]

    assert bundle["extends"] == "data/opaque"
    assert bundle["is_abstract"] is False
    assert bundle["entity_axis"] == "cells"
    assert [a["name"] for a in bundle["axes"]] == ["cells", "genes"]
    assert bundle["axes"][0]["key_label"] == "barcode", (
        "§9, verbatim: \"The entity axis must remain `cells` with `key_label: barcode` … "
        "the axis name is a JOIN KEY, not a biological claim.\" A Xenium row really is a "
        "cell and the vendor really calls it `cell_id`, and the rule still binds: the "
        "label is what `spatial/coordinates` and `spatial/visium-bundle` already declare, "
        "so a second spelling forks the vocabulary. It is also the only spelling ANCHORED "
        "by an ingest datatype — `cell_id` is anchored by nothing, so declaring it put this "
        "type outside the model-coverage lattice and turned three shipped guards red."
    )
    assert (bundle["axes"][0]["key_label"]
            == _datatypes()["spatial/visium-bundle"]["axes"][0]["key_label"]), (
        "the two vendor containers must agree on the cells-axis key label; they hold the "
        "same axis and their rows join to the same coordinates kind"
    )
    assert bundle["storage"]["layout"]["kind"] == "opaque_as_is"
    assert bundle["input_requirements"]["requires"] == "manifest"
    assert bundle["input_requirements"]["allow_archive"] is True


def test_the_grouping_capability_literal_is_present():
    """TEST-21 — the line without which the whole container does nothing.

    A descriptive marker alone declares nothing: the type is never enumerated and a Xenium
    `outs/` upload lands as unrelated single-file datasets, silently. Asserted as the exact
    string because that string IS the contract.
    """
    bundle = _datatypes()["spatial/xenium-bundle"]
    assert GROUPING_CAPABILITY in bundle["capabilities"]
    assert "spatial-bundle-target" in bundle["capabilities"]


@pytest.mark.parametrize("fixture", ["prime", "protein"])
def test_every_declared_member_matches_exactly_one_file_in_a_real_bundle(fixture):
    """TEST-21 — the grouping precondition, against real directory listings.

    Zero matches or two matches both mean "does not group". Both real bundles are checked
    because they are different XOA versions and the file set moved between them — which is
    precisely why the morphology image is NOT a declared member (DEC-2): its basename
    changes across the same two versions.
    """
    root = {"prime": XF.PRIME, "protein": XF.PROTEIN}[fixture]
    members = _datatypes()["spatial/xenium-bundle"]["input_requirements"]["members"]
    assert members, "a container with no members groups nothing"
    for member in members:
        found = _matches(root, member)
        assert len(found) == 1, (
            f"{member!r} matched {len(found)} files in {root.name} "
            f"({[str(p.relative_to(root)) for p in found]}); grouping needs EXACTLY one"
        )


def test_the_morphology_image_is_deliberately_not_a_member():
    """TEST-21 — DEC-2, asserted so it cannot be 'helpfully' added later.

    The image basename MOVES between XOA versions — `morphology_focus_0000.ome.tif` in the
    prime bundle, `ch0000_dapi.ome.tif` in the protein one — so declaring either would make
    the OTHER bundle fail to group entirely. This test names the evidence.
    """
    members = _datatypes()["spatial/xenium-bundle"]["input_requirements"]["members"]
    flat = {_normalize(a) for m in members for a in _alternatives(m)}
    assert not any(name.endswith((".tif", ".tiff")) for name in flat)

    prime_image = XF.experiment(XF.PRIME)["images"]["morphology_focus_filepath"]
    protein_image = XF.experiment(XF.PROTEIN)["images"]["morphology_focus_filepath"]
    assert _normalize(prime_image) != _normalize(protein_image), (
        "the two bundles must name DIFFERENT image basenames — that difference is the whole "
        "reason the image is located from experiment.xenium instead of by basename"
    )


def test_transcripts_and_boundaries_are_not_members_of_this_phase():
    """TEST-21 — scope, asserted. #163 and #164 own those files; a member nothing reads is
    a claim this container cannot honour."""
    members = _datatypes()["spatial/xenium-bundle"]["input_requirements"]["members"]
    flat = {_normalize(a) for m in members for a in _alternatives(m)}
    for absent in ("transcripts.parquet", "cell_boundaries.parquet",
                   "cell_boundaries.csv.gz", "nucleus_boundaries.parquet"):
        assert absent not in flat


# ── TEST-21 regression leg: the FIRST carrier still works ────────────────────────────


def test_the_visium_container_still_matches_its_own_fixture_exactly():
    """TEST-21 — a second `mtx-trio-target` carrier must cost the first one nothing.

    `plan_upload_groups_by_name` takes a SLICE and picks the first carrier whose members
    actually match, "instead of being the only one ever consulted" — so multiple carriers
    are supported. This asserts the shipped one is undisturbed, on its own committed fixture,
    including the `|` alternation that is the core's one matching sugar.
    """
    bundle = _datatypes()["spatial/visium-bundle"]
    assert GROUPING_CAPABILITY in bundle["capabilities"]
    assert VISIUM_FIXTURE.is_dir(), "the Visium fixture is the substrate for this leg"
    for member in bundle["input_requirements"]["members"]:
        found = _matches(VISIUM_FIXTURE, member)
        assert len(found) == 1, (
            f"{member!r} matched {len(found)} files in the Visium fixture "
            f"({[p.name for p in found]}) — adding the Xenium container has disturbed the "
            "one that shipped"
        )


def test_the_two_containers_member_sets_are_disjoint():
    """TEST-21 — why two carriers are safe, stated as an assertion rather than a comment.

    Matching is by basename over the whole upload, so two carriers are only safe while
    neither can match the other's files. A shared basename would make grouping depend on
    carrier ORDER, which nothing declares.
    """
    types = _datatypes()
    xenium = {_normalize(a)
              for m in types["spatial/xenium-bundle"]["input_requirements"]["members"]
              for a in _alternatives(m)}
    visium = {_normalize(a)
              for m in types["spatial/visium-bundle"]["input_requirements"]["members"]
              for a in _alternatives(m)}
    assert xenium and visium
    assert xenium.isdisjoint(visium), f"overlapping members: {xenium & visium}"


def test_neither_bundle_can_satisfy_the_others_members():
    """TEST-21 — disjointness proven on the BYTES, not only on the declarations.

    The set comparison above could pass while a real Xenium `outs/` happened to contain a
    file named `scalefactors_json.json`. This checks the actual directories.
    """
    types = _datatypes()
    for name, root, foreign in (
        ("prime", XF.PRIME, "spatial/visium-bundle"),
        ("protein", XF.PROTEIN, "spatial/visium-bundle"),
        ("visium", VISIUM_FIXTURE, "spatial/xenium-bundle"),
    ):
        for member in types[foreign]["input_requirements"]["members"]:
            assert not _matches(root, member), (
                f"{name} contains a file matching {foreign}'s member {member!r}; two "
                "carriers would then compete for the same upload"
            )
