#!/usr/bin/env python3
# ruff: noqa
"""#163 — absence is absence, end to end.

TEST-4 [acceptance] [invariant: INV-4] [covers: ITEM-8], TEST-7 [covers: ITEM-5].

## The defect this file exists for, named up front

The cheapest implementation of the vertex→cell join is `index_of.get(cid, -1)`. It is one
character shorter than the correct one, it never raises, and **both real vendor bundles
have ZERO orphan ids** — so no fixture drawn from real data can ever catch the `-1`
reaching the store. `spatial-types/manifest.yaml:415-418` is explicit that a negative
sentinel is never stored and that the read side rejects a negative code for the WHOLE
column, which means the failure would not be a wrong polygon: it would be a boundaries
artifact that 400s forever, minted with no error at write time.

So the orphan case is CONSTRUCTED here, and the mutation battery re-introduces the sentinel
to prove this test catches it.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_fixtures as XF  # noqa: E402


@pytest.fixture(scope="module")
def BD():
    return XF.load_boundaries_module()


# ───────────────────────────── TEST-4 (INV-4) ────────────────────────────────────────


def test_a_vertex_whose_cell_is_not_on_the_axis_is_NOT_WRITTEN_and_is_counted(BD):
    """TEST-4 [acceptance] [invariant: INV-4] [covers: ITEM-8].

    `spatial-types/manifest.yaml:415-418`, verbatim: *"Valid-only: a negative sentinel is
    never stored … A vertex with no entity is not written."*

    **This test was WRONG in the first cut and the correction is the point.** It asserted
    that an orphan vertex makes the whole import REFUSE — a reading that satisfies "no
    sentinel is stored" vacuously (nothing is stored at all) while not doing what the
    sentence says, and that escalates a per-row condition into losing the counts matrix, the
    coordinates and the image. A blind design-conformance angle caught it. The invariant is a
    per-vertex OMISSION rule, so the vertex is not written, the count IS reported, and the
    surviving polygons are exactly the ones the bundle can account for.
    """
    ids = ["a", "a", "b", "ghost", "ghost"]
    xs = np.arange(5, dtype=np.float64)
    ys = np.arange(5, dtype=np.float64) * 2
    enc = BD.assemble(ids, xs, ys, ["a", "b", "c"])

    # NOT WRITTEN — and the mutation `index_of.get(cid, -1)` would put them back, at -1.
    assert enc["entity"].shape[0] == 3, "the orphan vertices were written"
    assert list(enc["entity"]) == [0, 0, 1]
    assert int(enc["entity"].min()) >= 0, "a negative sentinel reached the store"
    assert list(enc["count"]) == [2, 1, 0]
    assert list(enc["x"]) == [0.0, 1.0, 2.0], "a dropped vertex left a hole in the table"

    # COUNTED — dropping is only honest when it is reported.
    stats = enc["stats"]
    assert stats["n_vertices_not_written"] == 2
    assert stats["n_unmatched_vertex_rows"] == 2
    assert "ghost" in stats["unmatched_cell_ids_sample"], (
        f"the report does not name the offending id: {stats}"
    )


def test_a_null_cell_id_is_not_written_either(BD):
    """A null id is the same case wearing a different costume — parquet allows it."""
    enc = BD.assemble(["a", None], np.zeros(2), np.zeros(2), ["a"])
    assert enc["entity"].shape[0] == 1
    assert enc["stats"]["n_null_cell_ids"] == 1
    assert enc["stats"]["n_vertices_not_written"] == 1


def test_a_file_whose_every_vertex_is_unmatched_REFUSES(BD):
    """The one case that is still a refusal — and the line between them.

    A boundaries file with NO cell in common with its own bundle's matrix is not a partial
    result, it is the wrong file. Importing zero polygons from it as though that were the
    measurement is worse than saying so.
    """
    with pytest.raises(BD.BoundariesError) as exc:
        BD.assemble(["ghost", "ghost"], np.zeros(2), np.zeros(2), ["a", "b"])
    assert "the wrong file for this bundle" in str(exc.value)


def test_no_negative_entity_index_survives_a_MUTATION_of_the_join(BD, monkeypatch):
    """The armed form of the always-on check, and the first cut's was NOT armed.

    Its predecessor derived `axis_keys` from the same sidecar as the fixture, so no orphan
    could exist by construction and `entity.min() >= 0` held for ANY implementation —
    including the `index_of.get(cid, -1)` mutation the file exists to catch. A blind angle
    (both angles, in fact) found that it could not fail.

    This drives the shipped encoder over a REAL fixture whose axis has been narrowed so that
    a third of its cells become unmatched, then asserts the two things the sentinel would
    break: no negative index reaches the store, and the dropped rows are accounted for
    exactly. `count.sum()` must equal the rows WRITTEN, not the rows read.
    """
    _rings, order = XF.expected_rings(XF.REAL_LUNG_BOUNDARIES)
    narrowed = order[: (len(order) * 2) // 3]
    enc = BD.read_boundaries(XF.REAL_LUNG_BOUNDARIES, narrowed)

    assert enc["stats"]["n_unmatched_vertex_rows"] > 0, (
        "the narrowed axis produced no unmatched vertices — the subject is missing"
    )
    assert int(enc["entity"].min()) >= 0 and int(enc["entity"].max()) < len(narrowed), (
        "an entity_index escaped the narrowed axis"
    )
    written = int(enc["entity"].shape[0])
    assert int(enc["count"].sum()) == written
    assert written + enc["stats"]["n_vertices_not_written"] == sum(
        len(v) for v in _rings.values()), (
        "the rows written plus the rows not written do not account for the file"
    )


def test_a_cell_with_no_boundary_gets_count_zero_and_a_valid_start(BD):
    """DEC-7 — a cell the vendor drew no polygon for. Constructed: real data has none."""
    enc = BD.assemble(["a", "a", "c"], np.arange(3, dtype=float),
                      np.arange(3, dtype=float), ["a", "b", "c"])
    assert list(enc["count"]) == [2, 0, 1]
    assert list(enc["start"]) == [0, 2, 2], (
        "the empty cell's start is not its running offset; `[start, start+0)` must be the "
        "empty slice at a VALID index, never a sentinel"
    )
    assert 0 <= int(enc["start"][1]) <= enc["entity"].shape[0]
    assert enc["stats"]["n_entities_without_boundary"] == 1
    assert enc["stats"]["n_entities_with_boundary"] == 2


def test_a_coordinate_finite_in_float64_but_not_in_float32_is_REFUSED(BD):
    """TEST-19 [covers: ITEM-8]. The narrowing check, which the first cut ran on the WRONG side of the cast.

    `np.isfinite` on the float64 value passes for 1e300; the stored float32 is `inf`. The
    sibling centroid path in `import_xenium.py` documents fixing exactly this bug, and this
    module reintroduced it — an infinite vertex reached the store with only a RuntimeWarning
    while the module's own message claimed "a NaN or an infinity is not a position".
    """
    with pytest.raises(BD.BoundariesError) as exc:
        BD.assemble(["a", "a"], np.array([1e300, 1.0]), np.array([1.0, 2.0]), ["a"])
    assert "float32" in str(exc.value)


def test_a_present_but_EMPTY_boundaries_file_emits_no_artifact(tmp_path):
    """TEST-20 [covers: ITEM-5, ITEM-8]. The absence case the first cut missed: absence keyed on FILE PRESENCE only.

    A present-but-0-row parquet took the emit branch and produced exactly the artifact the
    block's own comment forbids — `spatial/boundaries` with n=0 plus two all-zero offset
    columns, i.e. the claim that every cell in the tissue has no shape. Found by running it,
    not by reading it.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    empty = tmp_path / "empty.parquet"
    pq.write_table(pa.table({"cell_id": pa.array([], type=pa.binary()),
                             "vertex_x": pa.array([], type=pa.float64()),
                             "vertex_y": pa.array([], type=pa.float64())}), empty)
    root = XF.stage_bundle(tmp_path, boundaries=empty)
    outputs = tmp_path / "out-empty"
    outputs.mkdir()
    _module, entries = XF.run_over(root, outputs)

    ids = [e["id"] for e in entries]
    assert "spatial-boundaries" not in ids
    assert "metadata-column:boundary_vertex_start" not in ids
    assert not (outputs / "spatial" / "boundaries.zarr").exists()
    report = json.loads((outputs / "xenium-import-report.json").read_text())
    assert report["boundaries"]["emitted"] is False
    assert "every cell has no shape" in report["boundaries"]["reason"]


def test_a_MALFORMED_boundaries_file_is_skipped_and_the_rest_of_the_import_survives(
        tmp_path):
    """TEST-21 [covers: ITEM-5]. The isolation the manifest's `Additive` changelog line CLAIMS — now true.

    The first cut let every refusal in `boundaries.py` escape `main()`'s handler as a raw
    traceback: a bundle whose counts matrix, coordinates and morphology image all imported
    cleanly produced NOTHING because of an optional side file that is not even a declared
    member of the container. Both blind angles found it; the correctness angle reproduced it
    end to end. The shape here is `emit_image`'s — catch, record the reason, carry on.
    """
    bad = tmp_path / "bad.parquet"
    bad.write_bytes(b"this is not parquet at all\n")
    root = XF.stage_bundle(tmp_path, boundaries=bad, name="bad-outs")
    outputs = tmp_path / "out-bad"
    outputs.mkdir()
    _module, entries = XF.run_over(root, outputs)

    ids = {e["id"] for e in entries}
    assert "spatial-boundaries" not in ids
    # ...and EVERYTHING ELSE still landed. This is the assertion the claim rests on.
    assert "expression" in ids and "spatial-coordinates" in ids
    assert (outputs / "expression.zarr").is_dir()
    assert (outputs / "spatial" / "coordinates.zarr").is_dir()
    assert len(entries) > 10, f"only {len(entries)} artifacts survived: {sorted(ids)}"
    report = json.loads((outputs / "xenium-import-report.json").read_text())
    assert report["boundaries"]["emitted"] is False
    assert "skipped" in report["boundaries"]["reason"]
    assert "not a readable parquet file" in report["boundaries"]["reason"]


def test_a_bundle_with_no_boundaries_parquet_emits_nothing_rather_than_empty_artifacts(
        tmp_path):
    """TEST-4 — the common case, driven through the REAL shipped importer.

    Both committed fixture bundles have no boundaries file, so this is what the whole
    existing suite already exercises on every run. Asserted explicitly because "no artifact"
    and "an artifact saying every cell has no shape" are very different claims, and only one
    of them is true.
    """
    outputs = tmp_path / "out"
    outputs.mkdir()
    _module, entries = XF.run_over(XF.PRIME, outputs)
    ids = [e["id"] for e in entries]
    assert "spatial-boundaries" not in ids
    assert not [e for e in entries if e["datatype"] == "spatial/boundaries"]
    for name in ("boundary_vertex_start", "boundary_vertex_count"):
        assert f"metadata-column:{name}" not in ids, (
            f"{name} was emitted for a bundle with no boundaries — an offset column with "
            "nothing to offset into is a claim the bundle does not support"
        )
    assert not (outputs / "spatial" / "boundaries.zarr").exists()

    report = json.loads((outputs / "xenium-import-report.json").read_text())
    assert report["boundaries"]["emitted"] is False
    assert "cell_boundaries.parquet" in report["boundaries"]["reason"], (
        "the report does not say WHY there are no boundaries; a silently absent artifact "
        "is indistinguishable from a broken importer"
    )


# ───────────────────────────── TEST-7 (ITEM-5) ───────────────────────────────────────


def test_the_boundaries_file_is_found_anywhere_under_the_bundle(tmp_path):
    """TEST-7 [covers: ITEM-5] — a 0-or-1 walk, like the morphology image's."""
    module = XF.load_compute()
    root = XF.stage_bundle(tmp_path, boundaries=XF.PRIME_STAGED_BOUNDARIES)
    assert module._at_most_one(root, "cell_boundaries.parquet") is not None
    nested = root / "deeper"
    nested.mkdir()
    (root / "cell_boundaries.parquet").rename(nested / "cell_boundaries.parquet")
    assert module._at_most_one(root, "cell_boundaries.parquet") is not None


def test_two_boundaries_files_refuse_rather_than_picking_one(tmp_path):
    module = XF.load_compute()
    root = XF.stage_bundle(tmp_path, boundaries=XF.PRIME_STAGED_BOUNDARIES)
    (root / "copy").mkdir()
    (root / "copy" / "cell_boundaries.parquet").write_bytes(
        (root / "cell_boundaries.parquet").read_bytes())
    with pytest.raises(module.XeniumImportError) as exc:
        module._at_most_one(root, "cell_boundaries.parquet")
    assert "would be a guess" in str(exc.value)


def test_the_bundle_container_still_does_not_declare_boundaries_as_a_member():
    """TEST-7 [covers: ITEM-5] — #162's grouping is NOT regressed.

    DEC-3. Member matching needs EXACTLY ONE file per declared member, so declaring
    `cell_boundaries.parquet` would make every bundle without one ungroupable — and both
    real full-size Xenium bundles reachable from this box ship their boundaries only as
    `cell_boundaries.csv.gz`. This branch adds a READER, not a member.
    """
    import yaml
    manifest = Path(__file__).resolve().parents[2] / "spatial-types" / "manifest.yaml"
    doc = yaml.safe_load(manifest.read_text())
    bundle = next(d for d in doc["contributes"]["datatypes"]
                  if d["id"] == "spatial/xenium-bundle")
    members = json.dumps(bundle)
    for forbidden in ("cell_boundaries", "nucleus_boundaries", "transcripts.parquet"):
        assert forbidden not in members, (
            f"`{forbidden}` became a declared member of the Xenium bundle container. "
            "Grouping returns nothing unless exactly one file matches EACH member, so "
            "every bundle without one would stop grouping — including the two real bundles "
            "#162 was verified against."
        )


def test_a_WRITER_failure_is_skipped_too_and_nothing_reaches_the_manifest(tmp_path,
                                                                         monkeypatch):
    """TEST-21 [covers: ITEM-5]. The writer half of the isolation — and the mutation battery proved it was UNTESTED.

    `test_a_MALFORMED_boundaries_file_is_skipped...` exercises only the READ half (a
    non-parquet file). Narrowing the writer's `except Exception` to a type that cannot fire
    left the whole suite green, which is the definition of an untested guard. Two blind
    angles independently flagged that the writer was outside the guard before it was widened;
    nothing was checking that the widening worked.

    This injects a failure INSIDE `write_boundaries`, after the store directory has been
    created, and asserts the two things that matter: every other artifact still lands, and
    NOTHING from the boundaries leg reaches the manifest — not even the half-written store's
    entry.
    """
    module = XF.load_compute()
    BD = sys.modules["boundaries"]
    real = BD.write_boundaries

    def exploding(outputs_dir, rel_dir, encoded, **kw):
        # Create the store first, so the failure is genuinely mid-write rather than before it.
        (Path(outputs_dir) / rel_dir).mkdir(parents=True, exist_ok=True)
        raise OSError("disk full while mirroring the declarations")

    monkeypatch.setattr(BD, "write_boundaries", exploding)
    try:
        root = XF.stage_bundle(tmp_path, boundaries=XF.PRIME_STAGED_BOUNDARIES,
                               name="writer-fail-outs")
        outputs = tmp_path / "out-writerfail"
        outputs.mkdir()
        entries = module.run_import(root, outputs)
    finally:
        monkeypatch.setattr(BD, "write_boundaries", real)

    ids = {e["id"] for e in entries}
    assert "spatial-boundaries" not in ids, (
        "a half-written boundaries store reached the manifest — an entry pointing at bytes "
        "that were never finished"
    )
    for name in ("boundary_vertex_start", "boundary_vertex_count"):
        assert f"metadata-column:{name}" not in ids
    # ...and the rest of the import is untouched, which is the whole claim.
    assert "expression" in ids and "spatial-coordinates" in ids
    assert len(entries) > 10, f"only {len(entries)} artifacts survived: {sorted(ids)}"
    report = json.loads((outputs / "xenium-import-report.json").read_text())
    assert report["boundaries"]["emitted"] is False
    assert "could not be written" in report["boundaries"]["reason"]
    assert "OSError" in report["boundaries"]["reason"]
