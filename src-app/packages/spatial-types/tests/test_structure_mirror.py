#!/usr/bin/env python3
# ruff: noqa
"""#211 — the spatial declarations must be readable from INSIDE the sandbox.

`meta` is a catalog column. It does not cross into a sandbox: an input reaches a compute
as an `inputs.json` entry of `{slot, kind, content_hash, sandbox_path}` and as staged
BYTES, and nothing else. So a sandboxed analysis could decode a `spatial/coordinates`
artifact's numbers and could not learn the frame, the unit, the micron scale, or what one
row IS.

The fix is the one the OTHER spatial kind already uses: put the declarations in the
artifact's OWN FILE FORMAT. For an `opaque` OME-TIFF that is the OME-XML
(`encode_placement`). For a Zarr store it is the store's group `attributes.txr`, which
`stage_prefix_members` copies into the sandbox byte-verbatim. This module is the contract
for that second channel.

## What every test here is designed against

Two hazards, named rather than hoped away:

* **A fixture must not contain a value a fabrication would coincide with.** Every scale
  below is `0.4972` — not `1.0`, not round. A fixture scale of `1.0` would make "read the
  declared scale" and "fabricate 1.0" produce the SAME answer, and the whole INV-1 battery
  would be blind BY CONSTRUCTION rather than by oversight.
* **A refusal battery alone proves nothing.** Replace the reader with a bare `raise` and
  every refusal test still passes. TEST-2 is the control that makes the battery mean
  something: it mutates a declared value on disk and requires the consumer's ANSWER to
  move with it.
"""
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
import pytest

_PACKAGES = Path(__file__).resolve().parents[2]
_MODULE = _PACKAGES / "spatial-types" / "compute" / "spatial_declarations.py"

#: A scale that is neither 1.0 nor round. See the module docstring: with 1.0 here, a
#: reader that fabricated its answer and a reader that read the declaration would be
#: indistinguishable, and every assertion below would be vacuous.
SCALE = 0.4972
RADIUS_UM = 30.0


def _load_module():
    spec = importlib.util.spec_from_file_location("spatial_declarations", _MODULE)
    module = importlib.util.module_from_spec(spec)
    sys.modules["spatial_declarations"] = module
    spec.loader.exec_module(module)
    return module


sd = _load_module()


def _space(**over):
    kw = dict(space="slide-A1", unit="pixel", to_space=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0],
              microns_per_pixel=SCALE, microns_per_pixel_source="vendor:scalefactors_json",
              coordinate_space_source="vendor:library_id")
    kw.update(over)
    return sd.coordinate_space(**kw)


def _write(tmp_path, *, space=None, n=6, z=True):
    """Write a real `spatial/coordinates` artifact and return `(store, structure, meta)`.

    `z` defaults ON. That is not incidental: `z_column` is the ONE sub-block
    `_validated_declaration_block` copies rather than REBUILDS through a constructor, so
    it is the only key on which the mirror's deep copy is load-bearing. A fixture without
    a z was blind to that by construction — every artifact this file wrote was the same
    along that one dimension, so an entire class of aliasing defect could not appear.
    """
    coords = np.arange(n * 2, dtype=np.float32).reshape(n, 2)
    structure, meta = sd.write_spatial_coordinates(
        tmp_path, "coords.zarr", coords, axis="cells",
        space=space if space is not None else _space(),
        entity=sd.measured_entity(kind="spot", platform="visium", resolution_um=55.0),
        placement=sd.positioning(partial=False),
        series=sd.section(sample_id="S1", index=0),
        z=sd.z_column(name="z_um", kind="physical",
                      values=[float(i) + 0.5 for i in range(n)]) if z else None,
    )
    return tmp_path / "coords.zarr", structure, meta


def _stamped(store):
    return json.loads((store / "zarr.json").read_text())["attributes"]["txr"]


def _restamp(store, structure):
    doc = json.loads((store / "zarr.json").read_text())
    doc["attributes"]["txr"] = structure
    (store / "zarr.json").write_text(json.dumps(doc, indent=2))


# ── TEST-1 [acceptance] [invariant: INV-1] ──────────────────────────────────────────
def test_every_shape_a_sandboxed_consumer_can_hold_refuses_rather_than_answering(tmp_path):
    """TEST-1 [acceptance] [invariant: INV-1] — the refusal table, through the STORE reader.

    #211 measured this table against the four shapes a sandboxed consumer could hold when
    it had only `meta` to go on. This is the same table re-run against the shapes it can
    hold now that it reads a STAGED STORE — which is the surface this item creates, and
    therefore the surface a fabricated `1.0` would have to escape through.

    Every row must REFUSE. None may return a number. The point is not that an exception is
    raised; it is that `require_micron_scale` is never handed something it would answer.
    """
    # (a) a directory that is not a store at all
    empty = tmp_path / "not-a-store"
    empty.mkdir()
    # (b) a zarr.json with no attributes.txr
    no_attrs = tmp_path / "no-attrs.zarr"
    no_attrs.mkdir()
    (no_attrs / "zarr.json").write_text(json.dumps({"zarr_format": 3, "node_type": "group"}))
    # (c) a real store whose structure carries no spatial block — i.e. an artifact
    #     written before this change, or one whose structure a filter gather re-minted
    pre_mirror, structure, _meta = _write(tmp_path / "pre")
    del structure[sd.STRUCTURE_DECLARATION_KEY]
    _restamp(pre_mirror, structure)
    # (e) a block that is not a mapping
    corrupt, structure_c, _ = _write(tmp_path / "corrupt")
    structure_c[sd.STRUCTURE_DECLARATION_KEY] = "txr-spatial/1"
    _restamp(corrupt, structure_c)

    for label, store in [("no store", empty), ("no attributes.txr", no_attrs),
                         ("no spatial block", pre_mirror), ("block is not a mapping", corrupt)]:
        assert sd.read_spatial_declarations(store) is None, label
        with pytest.raises(sd.SpatialDeclarationError) as exc:
            sd.require_spatial_declarations(store, consumer="a neighbourhood analysis")
        assert "a neighbourhood analysis" in str(exc.value), label

    # (d) the block IS there, and declares a pixel space with no scale. This is the row
    #     that would produce a plausible number if anything defaulted, so it is asserted
    #     one level further in: the block is readable, and the SCALE still refuses.
    unscaled_store, _s, _m = _write(
        tmp_path / "unscaled",
        space=sd.coordinate_space(space="slide-A1", unit="pixel",
                                  to_space=[1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
    )
    block = sd.require_spatial_declarations(unscaled_store, consumer="a neighbourhood analysis")
    assert block["unit"] == "pixel" and "microns_per_pixel" not in block
    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.require_micron_scale(block, consumer="a neighbourhood analysis")
    assert "1.0" in str(exc.value)


def test_a_block_that_is_PRESENT_but_malformed_is_refused_on_read(tmp_path):
    """TEST-1 (cont.) [acceptance] [invariant: INV-1] — the PARTIAL-PRESENCE shapes.

    The refusal table above enumerates shapes of ABSENCE. Absence was never the dangerous
    case: `require_spatial_declarations` cannot return anything for it. The dangerous case
    is a block that IS there and is not what the writer would have produced — because that
    is the only shape that reaches `require_micron_scale` carrying something it would
    answer. The first cut of this file had zero such rows, so a reader that validated
    nothing passed every test in it.

    Each row below is written to the STORE — the only copy a sandboxed consumer has — and
    must be refused by name, not returned for a consumer to trip over with a `KeyError`.
    """
    store, structure, _meta = _write(tmp_path)
    good = _stamped(store)[sd.STRUCTURE_DECLARATION_KEY]

    def with_block(block):
        doc = json.loads((store / "zarr.json").read_text())
        doc["attributes"]["txr"][sd.STRUCTURE_DECLARATION_KEY] = block
        (store / "zarr.json").write_text(json.dumps(doc, indent=2))

    # Each row names a DISTINGUISHING substring of the refusal it must produce. Asserting
    # only the consumer prefix would be satisfied by EVERY refusal this function can emit,
    # including the generic "carries no spatial declaration" fallback — so a row could
    # start failing for a completely different reason (its own rule quietly gone) and stay
    # green.
    rows = {
        "no coordinate space at all": (
            {"declares": sd.SPATIAL_DECLARATION_TOKEN, "unit": "micrometre"},
            "coordinate space is not the shape"),
        "a unit outside the closed vocabulary": (
            {**good, "unit": "furlong"}, "furlong"),
        "an affine of the wrong length": (
            {**good, "to_space": [1.0, 0.0, 0.0]}, "6 numbers"),
        "an affine carrying a string": (
            {**good, "to_space": [1.0, 0.0, "0", 0.0, 1.0, 0.0]}, "not a number"),
        "a scale that is a bool": (
            {**good, "microns_per_pixel": True}, "flag coerced"),
        "a measured entity outside the closed kind vocabulary": (
            {**good, "measured_entity": {**good["measured_entity"], "kind": "voxel"}},
            "voxel"),
        "positioning.partial as an int rather than an explicit bool": (
            {**good, "positioning": {"partial": 0}}, "explicit bool"),
        "a section carrying a section-to-section transform": (
            {**good, "section": {**good["section"], "transform": [1, 0, 0, 0, 1, 0]}},
            "section-to-section"),
        "a measured entity that is not a mapping": (
            {**good, "measured_entity": "spot"}, "not the mapping"),
        "a block with no version token": (
            {k: v for k, v in good.items() if k != "declares"}, "no version token"),
        "a TYPO'D key, which would otherwise be lost forever": (
            {**{k: v for k, v in good.items() if k != "section"}, "sections": good["section"]},
            "unknown declaration key"),
        "a label that disagrees with its own entity": (
            {**good, "measured_entity_label": "a nucleus"}, "cannot both be right"),
        # `z_column` is the one sub-block the table validates through a STORED-shape
        # helper rather than its write-time constructor, and every fixture in this file
        # writes a VALID z — so without these two rows the whole arm could be deleted
        # green (measured: mutant P9 survived).
        "a z kind outside the closed vocabulary": (
            {**good, "z_column": {"name": "z_um", "kind": "voxel"}}, "outside"),
        "a z declaration missing its name": (
            {**good, "z_column": {"kind": "physical"}}, "not the shape"),
    }
    for label, (block, needle) in rows.items():
        with_block(block)
        with pytest.raises(sd.SpatialDeclarationError) as exc:
            sd.require_spatial_declarations(store, consumer="a neighbourhood analysis")
        message = str(exc.value)
        assert "a neighbourhood analysis" in message, label
        assert needle in message, f"{label}: refused for the wrong reason — {message}"

    # THE CONTROL: the untouched block still reads, so the rows above are refused for
    # what they are and not because this test broke the store.
    with_block(good)
    assert sd.require_spatial_declarations(store, consumer="a neighbourhood analysis")


def test_a_producer_cannot_desynchronise_the_store_by_mutating_the_row(tmp_path):
    """TEST-4 (cont.) [invariant: INV-3] — the two copies must not SHARE nested objects.

    `write_spatial_coordinates` merges one `coordinates_meta()` dict into `meta` and hands
    the SAME dict to the mirror. A shallow copy there leaves `structure[KEY]["section"]`
    and `meta["section"]` as ONE object — so a producer touching a nested value of the
    `meta` it was returned would silently desynchronise the row's `structure` from the
    on-disk stamp, which is the drift `_conform_group_attributes` condemns, arriving
    through a mutation nobody would think of as touching `structure` at all.

    Both importers only add TOP-LEVEL keys today, so this was a trap rather than a live
    bug. It is asserted by identity, not by behaviour, because the trap is the ALIASING.
    """
    store, structure, meta = _write(tmp_path)
    block = structure[sd.STRUCTURE_DECLARATION_KEY]

    # `z_column` LAST and deliberately: the validator rebuilds `section`, `positioning`
    # and `measured_entity` through their constructors, so those three stop aliasing even
    # WITHOUT the deep copy. `z_column` is only checked, not rebuilt — so it is the single
    # key on which the deep copy is the mechanism rather than defence in depth, and a
    # fixture with no z could not see that at all.
    assert "z_column" in meta, "the fixture has no z, so this test cannot see the one key that aliases"
    for key in ("section", "positioning", "measured_entity", "z_column"):
        assert block[key] is not meta[key], (
            f"structure['{sd.STRUCTURE_DECLARATION_KEY}']['{key}'] IS meta['{key}'] — one "
            "object in two declarations that a gate requires to stay equal"
        )

    # and behaviourally: mutating the row's nested value must not move the store's copy
    meta["section"]["index"] = 99
    meta["measured_entity"]["platform"] = "not-visium"
    meta["z_column"]["name"] = "not_z"
    assert _stamped(store) == structure, (
        "a nested mutation of `meta` moved the row's `structure` out of step with the "
        "store — disk and row now decode differently"
    )
    assert _stamped(store)[sd.STRUCTURE_DECLARATION_KEY]["section"]["index"] == 0
    assert _stamped(store)[sd.STRUCTURE_DECLARATION_KEY]["z_column"]["name"] == "z_um"


def test_producer_free_text_survives_the_store_stamp_whatever_the_locale(tmp_path):
    """TEST-4 (cont.) — the mirror is the first thing to put NON-ASCII into the group stamp.

    Until now `attributes.txr` held only ASCII framework vocabulary. The mirror puts
    producer free text in it — `section.sample_id`, `coordinate_space`,
    `measured_entity_label` — and `json.dumps(..., ensure_ascii=False)` emits those
    characters raw. Written with the LOCALE DEFAULT encoding that aborts the writer under
    an ASCII locale, AFTER the store is already on disk. Production sets `LC_ALL=C.UTF-8`,
    so this would have bitten a CI container rather than a job — which is exactly the kind
    of failure that gets diagnosed as flakiness.
    """
    store, _structure, _meta = _write(
        tmp_path, space=_space(space="Slide-Müller-Ω"),
    )
    block = sd.require_spatial_declarations(store, consumer="an audit")
    assert block["coordinate_space"] == "Slide-Müller-Ω"
    raw = (store / "zarr.json").read_bytes()
    assert "Slide-Müller-Ω".encode("utf-8") in raw

    # ── AND UNDER AN ASCII LOCALE, which is the only place this can actually fail ────
    #
    # The assertions above pass on any box whose default encoding is already UTF-8 — i.e.
    # on this one, and on every box where the bug is invisible. Dropping `encoding="utf-8"`
    # left them GREEN (measured: mutant N4 survived them). The condition has to be
    # OBSERVED, so the write is repeated in a subprocess under `LC_ALL=C`, where
    # `write_text`'s locale default is ASCII and `ensure_ascii=False` emits raw
    # characters — the combination that aborts the writer AFTER the store is on disk.
    import os
    import subprocess
    import sys as _sys

    probe = tmp_path / "ascii_locale_probe.py"
    probe.write_text(
        "import importlib.util, sys, numpy as np\n"
        f"sys.path.insert(0, {str(_PACKAGES / '_lib')!r})\n"
        f"spec = importlib.util.spec_from_file_location('spatial_declarations', {str(_MODULE)!r})\n"
        "m = importlib.util.module_from_spec(spec); sys.modules['spatial_declarations'] = m\n"
        "spec.loader.exec_module(m)\n"
        "from pathlib import Path\n"
        "out = Path(sys.argv[1])\n"
        "m.write_spatial_coordinates(\n"
        "    out, 'c.zarr', np.zeros((3, 2), dtype=np.float32), axis='cells',\n"
        "    space=m.coordinate_space(space='Slide-M\\u00fcller-\\u03a9', unit='pixel',\n"
        "                             to_space=[1, 0, 0, 0, 1, 0], microns_per_pixel=0.4972),\n"
        "    entity=m.measured_entity(kind='spot', platform='visium', resolution_um=55.0),\n"
        "    placement=m.positioning(partial=False),\n"
        "    series=m.section(sample_id='S1', index=0))\n"
        "b = m.require_spatial_declarations(out / 'c.zarr', consumer='probe')\n"
        "print(b['coordinate_space'] == 'Slide-M\\u00fcller-\\u03a9')\n",
        encoding="utf-8",
    )
    ascii_out = tmp_path / "ascii-out"
    ascii_out.mkdir()
    env = dict(os.environ)
    env.update({"LC_ALL": "C", "LANG": "C", "PYTHONCOERCECLOCALE": "0",
                "PYTHONUTF8": "0", "PYTHONIOENCODING": "utf-8"})
    result = subprocess.run([_sys.executable, str(probe), str(ascii_out)],
                            capture_output=True, text=True, env=env)
    assert result.returncode == 0, (
        "the writer aborted under an ASCII locale — a non-ASCII library id would abort "
        "the import AFTER the store is on disk:\n" + result.stderr[-2000:]
    )
    assert result.stdout.strip() == "True", result.stdout


# ── TEST-2 [acceptance] [invariant: INV-1] ──────────────────────────────────────────
def test_the_consumers_answer_moves_with_the_declared_scale(tmp_path):
    """TEST-2 [acceptance] [invariant: INV-1] — THE VALUE-SENSITIVITY CONTROL.

    TEST-1 is a battery of refusals, and a battery of refusals passes with the reader
    replaced by `raise`. This is the leg that proves the reader READS: the declared scale
    is mutated ON DISK — the only copy a sandboxed consumer has — and the consumer's answer
    must move with it, by exactly the factor the mutation applied.

    Without this test the suite would be structurally incapable of failing on the defect it
    exists to catch: a reader that returned a constant would satisfy every other assertion
    in this file.
    """
    store, _structure, _meta = _write(tmp_path)

    def radius_in_pixels():
        block = sd.require_spatial_declarations(store, consumer="a neighbourhood analysis")
        return RADIUS_UM / sd.require_micron_scale(block, consumer="a neighbourhood analysis")

    before = radius_in_pixels()
    assert before == pytest.approx(RADIUS_UM / SCALE)

    # ── the mutation: EXACTLY double the scale, on disk ───────────────────────────────
    doc = json.loads((store / "zarr.json").read_text())
    doc["attributes"]["txr"][sd.STRUCTURE_DECLARATION_KEY]["microns_per_pixel"] = SCALE * 2
    (store / "zarr.json").write_text(json.dumps(doc, indent=2))

    after = radius_in_pixels()
    assert after == pytest.approx(before / 2), (
        "the consumer's answer did not move with the declared scale, so it is not reading "
        "the declaration — it is producing a number of its own"
    )

    # ── THE COERCION TABLE: every value the write side refuses, refused on READ too ──
    #
    # This is the half the first cut of these tests got wrong, and it got it wrong in the
    # most dangerous way available: it asserted `scale == 0.0`, i.e. it PINNED the gap as
    # correct behaviour. The block a sandboxed consumer holds is JSON parsed off a staged
    # file, so none of `_number`'s write-time refusals travel with it — and measured
    # before the fix, `microns_per_pixel: true` came back from `require_micron_scale` as
    # exactly **1.0**. A fabricated 1.0, through the one function whose entire stated
    # purpose is that no 1.0 is ever fabricated, reachable only because #211 promoted the
    # store copy to the read path.
    for bad in (True, "0.65", 0.0, -3, float("nan"), float("inf"), None, [0.5]):
        doc["attributes"]["txr"][sd.STRUCTURE_DECLARATION_KEY]["microns_per_pixel"] = bad
        (store / "zarr.json").write_text(json.dumps(doc, indent=2))
        with pytest.raises(sd.SpatialDeclarationError):
            block = sd.require_spatial_declarations(store, consumer="a neighbourhood analysis")
            sd.require_micron_scale(block, consumer="a neighbourhood analysis")

    # and the CONTROL: a legitimate value still passes through the same path, so the loop
    # above is refusing these values rather than refusing everything.
    doc["attributes"]["txr"][sd.STRUCTURE_DECLARATION_KEY]["microns_per_pixel"] = SCALE
    (store / "zarr.json").write_text(json.dumps(doc, indent=2))
    assert radius_in_pixels() == pytest.approx(RADIUS_UM / SCALE)


def test_the_scale_guard_holds_on_the_RAW_read_not_only_through_the_validator(tmp_path):
    """TEST-2 (cont.) [acceptance] [invariant: INV-1] — the path with no validator on it.

    `require_spatial_declarations` runs the block through
    `_validated_declaration_block`, so every test that goes through it is protected before
    `require_micron_scale` is even reached. That made `require_micron_scale`'s OWN guard
    untested: removing it and going back to a bare `float()` left the entire suite green
    (measured — mutant P1 survived).

    `read_spatial_declarations` is PUBLIC, is documented as the raw read, and has a test
    blessing it, so this is a reachable path and not a hypothetical. It is exactly where
    the fabricated `1.0` lived: measured through it, `microns_per_pixel: true` came back
    as **1.0**.

    So the coercion table is re-run through the RAW read, which is the one place
    `require_micron_scale` has to defend itself.
    """
    store, _structure, _meta = _write(tmp_path)
    doc = json.loads((store / "zarr.json").read_text())

    def raw_scale(value):
        doc["attributes"]["txr"][sd.STRUCTURE_DECLARATION_KEY]["microns_per_pixel"] = value
        (store / "zarr.json").write_text(json.dumps(doc, indent=2))
        block = sd.read_spatial_declarations(store)
        assert block is not None, "the raw read did not even return the block"
        assert block["microns_per_pixel"] == value or value != value  # NaN
        return sd.require_micron_scale(block, consumer="a neighbourhood analysis")

    for bad in (True, False, "0.65", 0.0, -3, float("nan"), float("inf")):
        with pytest.raises(sd.SpatialDeclarationError):
            raw_scale(bad)

    # THE CONTROL: a legitimate value still comes back through the same raw path, so the
    # loop above is refusing these values rather than refusing everything.
    assert raw_scale(SCALE) == pytest.approx(SCALE)

    # and a `micrometre` space still answers 1.0 BY DEFINITION, without going through
    # `_number` at all — that 1.0 is derived from the declared unit, not fabricated.
    assert sd.require_micron_scale({"unit": "micrometre"}, consumer="c") == 1.0


# ── TEST-4 [acceptance] [invariant: INV-3] ──────────────────────────────────────────
def test_the_store_copy_and_the_row_copy_are_equal_and_the_check_can_fail(tmp_path):
    """TEST-4 [acceptance] [invariant: INV-3] — disk == row, and the assertion is not vacuous.

    `_conform_group_attributes` condemns an artifact whose stamped `attributes.txr`
    differs from the `structure` the manifest row carries — "a consumer reading the store
    URL and a consumer reading the artifact row would decode differently". The mirror must
    therefore leave the two EQUAL, including the block it just added.

    The second half is the part that makes the first half mean something: a hand-edited
    on-disk copy must make the same comparison FAIL. Without it, `stamped == structure`
    could be passing because both sides are the same object.
    """
    store, structure, meta = _write(tmp_path)

    stamped = _stamped(store)
    assert stamped == structure
    # NOT `assert stamped is not structure` — `_stamped()` re-parses JSON, so that can
    # never trip and is not the control it looks like. The real control is the
    # drift-detection block at the end of this test.
    assert sd.STRUCTURE_DECLARATION_KEY in stamped

    # the block is exactly the declarations the row carries, plus its version token
    block = stamped[sd.STRUCTURE_DECLARATION_KEY]
    assert block["declares"] == sd.SPATIAL_DECLARATION_TOKEN
    for key, value in block.items():
        if key == "declares":
            continue
        assert meta[key] == value, f"{key} disagrees between the store and the catalog row"

    # ── the control: drift is DETECTABLE ─────────────────────────────────────────────
    doc = json.loads((store / "zarr.json").read_text())
    doc["attributes"]["txr"][sd.STRUCTURE_DECLARATION_KEY]["unit"] = "micrometre"
    (store / "zarr.json").write_text(json.dumps(doc, indent=2))
    assert _stamped(store) != structure

    # ── and the mirror re-stamps the FULL structure, not merely its own key ──────────
    #
    # Added because a mutation that patched ONLY `txr_spatial` into the existing on-disk
    # `attributes.txr` SURVIVED the rest of this file: in the ordinary flow `Table.close()`
    # has already stamped everything else, so the two writes produce byte-identical files
    # and nothing could tell them apart. They are not equivalent in general — a producer key
    # added to `structure` after close would then reach the catalog row and NOT the store,
    # which is exactly the drift `_conform_group_attributes` condemns. So the divergence is
    # created deliberately and the property asserted directly.
    fresh, fresh_structure, _m = _write(tmp_path / "full-restamp")
    fresh_structure["producer_key_added_after_close"] = 7
    # A REAL block: the mirror re-validates through the constructors that own the rules,
    # so a `{"unit": "pixel"}` stub is refused — which is the point of that validation and
    # is asserted directly in `test_the_mirror_refuses_an_empty_block_...` below.
    stored = dict(_stamped(fresh)[sd.STRUCTURE_DECLARATION_KEY])
    stored.pop("declares")   # the token is stamped by the mirror and refused as an input
    sd.mirror_declarations_into_store(
        fresh, structure=fresh_structure, declarations=stored,
    )
    assert _stamped(fresh)["producer_key_added_after_close"] == 7, (
        "the mirror patched only its own key into `attributes.txr`, so a producer key "
        "added to `structure` after the writer closed reaches the catalog row and not the "
        "store — the drift the conformance gate condemns"
    )
    assert _stamped(fresh) == fresh_structure


# ── TEST-5 ──────────────────────────────────────────────────────────────────────────
def test_the_real_conformance_gate_accepts_the_added_structure_key(tmp_path):
    """TEST-5 — the FRAMEWORK gate, run for real, over an artifact carrying the block.

    `structure` is producer-declared and open-ended, but "the gate has no allow-list" is a
    claim about code I did not write. So it is measured: the real `_lib/conformance.py` is
    run over a real produced store and must return no findings for the group attributes.

    The control is what stops this being the gate declining to look — a tampered on-disk
    copy must be CONDEMNED by the same call.
    """
    # A HARD import, not `importorskip`. `pytest.importorskip` would turn "the framework
    # gate was never run" into a green run — and this test's whole claim is that it WAS
    # run. It resolves via `packages/conftest.py`, which puts `_lib` on `sys.path`; if
    # that ever stops being true this must go red, not quiet.
    import conformance

    store, structure, _meta = _write(tmp_path)

    findings = conformance._conform_group_attributes(store, structure)
    assert findings == [], findings

    doc = json.loads((store / "zarr.json").read_text())
    doc["attributes"]["txr"][sd.STRUCTURE_DECLARATION_KEY]["coordinate_space"] = "other"
    (store / "zarr.json").write_text(json.dumps(doc, indent=2))
    assert conformance._conform_group_attributes(store, structure) != []


# ── TEST-6 ──────────────────────────────────────────────────────────────────────────
def test_the_scales_provenance_travels_inside_the_block_that_states_the_scale(tmp_path):
    """TEST-6 — `microns_per_pixel_source` / `coordinate_space_source` round-trip (#222).

    The trap this pins is `coordinates_meta`'s re-validation: it rebuilds the space through
    `_revalidated(coordinate_space, _space_kwargs(space))`, and `_space_kwargs` RENAMES
    `coordinate_space` back to `space` on the way in. A new key that does not survive that
    rename raises `TypeError` -> `SpatialDeclarationError` at write time, so the round-trip
    is the assertion, not the constructor call alone.
    """
    store, _structure, meta = _write(tmp_path)
    block = sd.require_spatial_declarations(store, consumer="an audit")

    assert block["microns_per_pixel_source"] == "vendor:scalefactors_json"
    assert block["coordinate_space_source"] == "vendor:library_id"
    assert meta["microns_per_pixel_source"] == "vendor:scalefactors_json"
    assert meta["coordinate_space_source"] == "vendor:library_id"

    # A source WITHOUT a scale is allowed on a pixel space and is the honest record that a
    # leg was tried and found nothing — the shipped Visium `"unavailable"` case. It cannot
    # fabricate anything: `require_micron_scale` reads the VALUE, never the source.
    # A source naming a leg that PRODUCED a scale, beside no scale, is REFUSED. This is
    # the leg the first cut of this test omitted, and without it the whole sentinel rule
    # could be deleted with every assertion here still green.
    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.coordinate_space(space="s", unit="pixel", to_space=[1, 0, 0, 0, 1, 0],
                            microns_per_pixel_source="vendor")
    assert "produced nothing" in str(exc.value)
    with pytest.raises(sd.SpatialDeclarationError):
        sd.coordinate_space(space="s", unit="pixel", to_space=[1, 0, 0, 0, 1, 0],
                            microns_per_pixel_source="derived-from-spot-diameter")

    looked = sd.coordinate_space(space="s", unit="pixel", to_space=[1, 0, 0, 0, 1, 0],
                                 microns_per_pixel_source=sd.SCALE_SOURCE_UNAVAILABLE)
    assert looked["microns_per_pixel_source"] == "unavailable"
    assert "microns_per_pixel" not in looked
    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.require_micron_scale(looked, consumer="a neighbourhood analysis")
    assert "1.0" in str(exc.value)

    # ...but on a micrometre space, where a pixel scale is a CATEGORY ERROR rather than a
    # missing value, naming a leg that produced one is refused — as the value itself is.
    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.coordinate_space(space="s", unit="micrometre", to_space=[1, 0, 0, 0, 1, 0],
                            microns_per_pixel_source="vendor:scalefactors_json")
    assert "meaningless" in str(exc.value)

    # the space id's provenance is independent of the scale and survives without one
    micro = sd.coordinate_space(space="s", unit="micrometre", to_space=[1, 0, 0, 0, 1, 0],
                                coordinate_space_source="vendor:region_name")
    assert micro["coordinate_space_source"] == "vendor:region_name"
    assert "microns_per_pixel" not in micro


# ── TEST-11 ─────────────────────────────────────────────────────────────────────────
def test_one_version_token_serves_both_channels_and_the_ome_literal_is_unchanged():
    """TEST-11 — the two channels cannot be versioned apart, and old artifacts still decode.

    `OME_PLACEMENT_PREFIX` is now DERIVED from the shared token. If that derivation changed
    the literal, every `spatial/image` already written would stop decoding — silently, since
    `decode_placement` returns `None` for a payload whose prefix it does not recognise. So
    the literal is asserted directly, not merely its relationship to the token.
    """
    assert sd.SPATIAL_DECLARATION_TOKEN == "txr-spatial/1"
    assert sd.OME_PLACEMENT_PREFIX == "txr-spatial/1 "
    assert sd.OME_PLACEMENT_PREFIX == sd.SPATIAL_DECLARATION_TOKEN + " "

    # an OME payload written against the pre-change LITERAL still decodes
    legacy = ('<OME><Image><Description>txr-spatial/1 '
              '{"coordinate_space": "slide-A1", "unit": "pixel", '
              '"to_space": [5.0, 0, 0, 0, 5.0, 0]}</Description></Image></OME>')
    assert sd.decode_placement(legacy)["to_space"][0] == 5.0


def test_an_ome_payload_of_an_UNKNOWN_version_is_refused_as_such_not_as_absent():
    """TEST-11 (cont.) — the OTHER channel must diagnose a version bump too.

    The two channels share one token so they cannot be versioned apart. That is only worth
    having if BOTH can tell "a declaration I must refuse" from "no declaration". The zarr
    side does. The OME side matched on the exact current token, so after a bump every image
    already written would stop matching, `decode_placement` would return `None`, and
    `require_placement` would report a MISSING declaration for an image that has one —
    sending the operator after the wrong fault, on the channel introduced to make a bump
    safe.
    """
    def ome(token):
        return (f'<OME><Image><Description>{token} '
                '{"coordinate_space": "s", "unit": "pixel", '
                '"to_space": [5.0, 0, 0, 0, 5.0, 0]}</Description></Image></OME>')

    # a FUTURE version of ours: recognised as ours, refused BY VERSION
    future = sd.decode_placement(ome("txr-spatial/2"))
    assert future is not None, "a future version read as 'no declaration at all'"
    assert not future, "the sentinel must be FALSY so an untaught caller still fails closed"
    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.require_placement(ome("txr-spatial/2"), consumer="a spatial analysis")
    assert "txr-spatial/2" in str(exc.value)
    assert "no coordinate-space declaration" not in str(exc.value)

    # somebody ELSE's Description is still not ours, and still reads as absent
    assert sd.decode_placement(ome("acme-spatial/1")) is None
    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.require_placement(ome("acme-spatial/1"), consumer="a spatial analysis")
    assert "carries no coordinate-space declaration" in str(exc.value)

    # and the CONTROL: the current version still decodes
    assert sd.decode_placement(ome(sd.SPATIAL_DECLARATION_TOKEN))["to_space"][0] == 5.0


def test_an_unreadable_store_is_not_reported_as_an_artifact_that_predates_the_mirror(
        tmp_path):
    """TEST-13 (cont.) — an I/O fault is not an absent declaration.

    `require_spatial_declarations`' two-cause message tells the operator to re-import or to
    run unfiltered. Neither fixes a truncated file or a permission bit, and collapsing an
    I/O failure into *absence* is the one collapse this module refuses everywhere else.
    """
    store, _structure, _meta = _write(tmp_path)
    (store / "zarr.json").write_text("{ this is not json", encoding="utf-8")

    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.read_spatial_declarations(store)
    message = str(exc.value)
    assert "not readable as JSON" in message
    # it must say re-importing will NOT help — the opposite of the two-cause message
    assert "re-importing will not fix it" in message
    assert "GATHERED" not in message and "filtered dataset" not in message

    # ...while a store that is genuinely ABSENT still reads as absent, not as a fault
    assert sd.read_spatial_declarations(tmp_path / "nope") is None


# ── TEST-13 ─────────────────────────────────────────────────────────────────────────
def test_the_raw_read_returns_none_and_only_the_require_wrapper_refuses(tmp_path):
    """TEST-13 — `None`, never `{}`; and the refusal names BOTH causes of absence.

    `{}` is falsy AND indexable, so `(read(...) or {}).get("microns_per_pixel")` would
    return `None` for "no declaration" and for "a declared-absent scale" alike — and those
    two are the distinction this whole module exists to keep. The raw read must therefore
    hand back `None`, and it must not raise: deciding what absence MEANS is the caller's,
    and `require_*` is where that decision lives.
    """
    store, structure, _meta = _write(tmp_path)
    del structure[sd.STRUCTURE_DECLARATION_KEY]
    _restamp(store, structure)

    absent = sd.read_spatial_declarations(store)
    assert absent is None
    assert sd.read_spatial_declarations(tmp_path / "nope") is None
    # NOT `assert absent is not {}` — that is true of every object in Python and would
    # assert nothing. The property that matters is that the answer cannot be SUBSCRIPTED,
    # because `{}` is falsy AND indexable and a consumer writing `(read(...) or {}).get(k)`
    # would then get `None` for "no declaration" and for "a declared-absent value" alike.
    with pytest.raises(TypeError):
        absent["microns_per_pixel"]

    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.require_spatial_declarations(store, consumer="da.neighbourhoods")
    message = str(exc.value)
    assert "da.neighbourhoods" in message
    assert "re-import" in message.lower(), "the pre-0.5.0 cause is not named"
    assert "filter" in message.lower(), "the gathered/filtered cause is not named"

    # a block stamped with a token this reader does not understand REFUSES DISTINCTLY,
    # rather than being read as though it were the shape this code knows.
    structure[sd.STRUCTURE_DECLARATION_KEY] = {"declares": "txr-spatial/2", "unit": "furlong"}
    _restamp(store, structure)
    assert sd.read_spatial_declarations(store) is None
    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.require_spatial_declarations(store, consumer="da.neighbourhoods")
    assert "txr-spatial/2" in str(exc.value)


# ── the writer's own refusals ────────────────────────────────────────────────────────
def test_the_mirror_refuses_an_empty_block_and_a_store_that_does_not_exist(tmp_path):
    """TEST-13 (cont.) — the write half of "absence is absence".

    Mirroring an empty block would write a declaration that says nothing, which a reader
    cannot tell from a producer that declared nothing. Refused rather than written.
    """
    store, structure, _meta = _write(tmp_path)
    good = dict(_stamped(store)[sd.STRUCTURE_DECLARATION_KEY])
    good.pop("declares")

    # (a) an empty block — a declaration that says nothing
    with pytest.raises(sd.SpatialDeclarationError):
        sd.mirror_declarations_into_store(store, structure=structure, declarations={})

    # (b) a MALFORMED NON-EMPTY block against an EXISTING store. This is the row that
    #     actually exercises the write-side validator: the previous pair reached the
    #     store-existence branch instead, so replacing the validator call with the old
    #     presence check left both green.
    for label, bad in {
        "a closed vocabulary violated": {**good, "measured_entity": {**good["measured_entity"], "kind": "voxel"}},
        "an affine of the wrong length": {**good, "to_space": [1.0, 0.0, 0.0]},
        "a bool where a measurement belongs": {**good, "microns_per_pixel": True},
        "a typo'd key": {**{k: v for k, v in good.items() if k != "section"},
                         "sections": good["section"]},
        "a caller-supplied version token": {**good, "declares": "txr-spatial/9"},
    }.items():
        with pytest.raises(sd.SpatialDeclarationError, match=r".") as exc:
            sd.mirror_declarations_into_store(store, structure=dict(structure),
                                              declarations=bad)
        assert exc.value, label

    # (c) a VALID block against a store that does not exist — the branch that would
    #     otherwise be dead, since (b) now stops before it.
    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.mirror_declarations_into_store(tmp_path / "absent", structure=dict(structure),
                                          declarations=good)
    assert "after the writer has closed" in str(exc.value)

    # (d) THE CONTROL: the same valid block against the real store still writes.
    sd.mirror_declarations_into_store(store, structure=dict(structure), declarations=good)

    # (e) A value that SERIALIZES but does not survive the round trip UNCHANGED. The
    #     earlier spelling of this row used an unserializable `extent`, which `_extent`
    #     refuses long before `json.dumps` — so the serialize-before-commit reordering was
    #     asserted by a test exercising a different branch.
    #
    #     A TUPLE in `segmentation.params` is the real trigger, and it is not academic: it
    #     serializes to a JSON array and comes back a LIST, `measured_entity_label` renders
    #     `params` with `str()`, so the stamped label and the re-derived one disagree
    #     forever — and the label-disagreement check then refuses the artifact for its
    #     whole life, with NO error at write time. A conformant artifact no reader can read.
    tupled = sd.measured_entity(
        kind="cell", platform="xenium",
        segmentation={"method": "cellpose", "params": {"expansion": (1, 2)},
                      "software_version": "3.0"})
    victim = dict(structure)
    before = _stamped(store)
    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.mirror_declarations_into_store(
            store, structure=victim,
            declarations={**good, "measured_entity": tupled,
                          "measured_entity_label": sd.measured_entity_label(tupled)})
    assert "round trip" in str(exc.value)
    # ...and the failure left the in-memory row exactly as it was: no block the store lacks
    assert victim.get(sd.STRUCTURE_DECLARATION_KEY) == \
        before.get(sd.STRUCTURE_DECLARATION_KEY)

    # (f) an unserializable value ANYWHERE in `structure` — not only in the block — is
    #     refused, and the message says so rather than blaming the block.
    with pytest.raises(sd.SpatialDeclarationError) as exc:
        sd.mirror_declarations_into_store(
            store, structure={**structure, "arrays": [{"path": {1, 2}}]},
            declarations=good)
    assert "not JSON serializable" in str(exc.value)


# ── the manifest budget, RE-MEASURED — and the first attempt measured the wrong thing ─


def test_the_real_emitted_manifest_still_fits_the_budget_with_the_block_carried_twice():
    """§6.6's budget arithmetic assumed ONE copy of the declaration. An entry now has two.

    ## Two things the first version of this test got wrong

    1. **It measured a synthetic entry.** It hand-built one from this file's minimal
       fixture, which omits `platform`, `provenance`, `component_columns` and
       `spot_diameter_fullres` — four keys `EXPECTED_COORDINATES_META_KEYS` says a real row
       carries. The synthetic entry was 1487 B; the entry the shipped importer actually
       emits is **2165 B**. A budget test blind to 678 B of the thing it measures is not a
       budget test.
    2. **It asserted the wrong bound.** `MAX_MANIFEST_BYTES / MAX_OUTPUTS` is an AVERAGE
       per entry, not a per-entry cap — the shipped check is on the WHOLE manifest
       (`outputs.rs`). A single fat entry may exceed the average without exceeding
       anything, and the first version would have failed on a correct manifest.

    So this runs the REAL importer and measures the REAL manifest against the REAL cap,
    both read from the shipped Rust. The per-entry average is reported as context, not
    asserted as a limit.
    """
    import importlib
    import re as _re
    import shutil
    import sys as _sys
    import tempfile

    # `sys.path` is restored and the outputs are removed. The first version inserted a
    # sibling package's test dir with no teardown and left a full importer run's outputs
    # in `/tmp` on every invocation — a suite that pollutes the process it runs in makes
    # the NEXT test's failure somebody else's mystery.
    fixtures_dir = str(_PACKAGES / "spatial-import-visium" / "tests")
    _sys.path.insert(0, fixtures_dir)
    try:
        VF = importlib.import_module("visium_fixtures")
    finally:
        if fixtures_dir in _sys.path:
            _sys.path.remove(fixtures_dir)

    outputs_rs = (_PACKAGES.parent / "server" / "src" / "modules" / "sandbox"
                  / "outputs.rs")
    source = outputs_rs.read_text(encoding="utf-8")

    def const(name):
        # `usize` OR `u64` — the two are declared with different types in the shipped
        # file, and a pattern pinned to one would silently match nothing for the other.
        match = _re.search(
            rf"{name}\s*:\s*u(?:size|64)\s*=\s*([0-9_]+)\s*(?:\*\s*([0-9_]+))?",
            source)
        assert match, f"could not read `{name}` out of {outputs_rs} — it moved or renamed"
        value = int(match.group(1).replace("_", ""))
        if match.group(2):
            value *= int(match.group(2).replace("_", ""))
        return value

    max_bytes, max_outputs = const("MAX_MANIFEST_BYTES"), const("MAX_OUTPUTS")
    assert max_bytes > 0 and max_outputs > 0

    out = Path(tempfile.mkdtemp())
    try:
        _module, entries = VF.run_over(VF.FIXTURE, out)
        manifest = len(json.dumps({"outputs": entries}).encode("utf-8"))
    finally:
        shutil.rmtree(out, ignore_errors=True)

    assert len(entries) <= max_outputs, f"{len(entries)} outputs against a cap of {max_outputs}"
    assert manifest < max_bytes, (
        f"the emitted manifest is {manifest} B against the {max_bytes} B cap. The "
        "declaration now rides in BOTH `meta` and `structure`, so a coordinates entry "
        "carries it twice — if this fails, narrow what the mirror carries rather than "
        "raising the cap."
    )

    entry = VF.entry_by_id(entries, "spatial-coordinates")
    entry_bytes = len(json.dumps(entry).encode("utf-8"))
    block_bytes = len(
        json.dumps(entry["structure"][sd.STRUCTURE_DECLARATION_KEY]).encode("utf-8"))

    # The block is a REAL cost, not a rounding error waved through — which is why the
    # budget was worth re-measuring at all rather than asserting §6.6's stale ~200 B.
    assert block_bytes > 400, (
        f"the mirrored block is only {block_bytes} B, so this measurement is not "
        "exercising the doubling it exists to check"
    )
    assert entry_bytes > block_bytes
    # Context, deliberately NOT an assertion: a single entry may exceed the per-entry
    # AVERAGE without exceeding the manifest cap, and it does — 2165 B against ~2048.
    print(f"\ncoordinates entry {entry_bytes} B (block {block_bytes} B); "
          f"per-entry average {max_bytes // max_outputs} B; "
          f"manifest {manifest} B / {max_bytes} B over {len(entries)} entries")


# ── TEST-10 (#211) — the mirror channel cost the framework NOTHING ───────────────────
#
# A property of the SHIPPED TREE, not of a diff. These lived in `test_zero_src_app_diff.py`
# and did not belong there: that file's whole contract is that its assertions SKIP off the
# branch that introduces the package, and `_lib/test_zero_core_guard.py` enforces exactly
# that by running each package's guard inside a synthetic checkout of a DIFFERENT package.
# Unconditional tests in that file broke the contract and the meta-guard caught it — a
# failure invisible branch-locally and visible only on the staging merge.
# What INV-6 claims is narrower and permanent: the sandbox-reachable declaration channel
# works WITHOUT the framework knowing it exists.

_LIB_DIR = _PACKAGES / "_lib"
_DECLARATIONS = _MODULE


def test_the_framework_gate_has_no_opinion_about_the_spatial_declaration_block():
    """TEST-10 [acceptance] [invariant: INV-6] — `_lib` never names this channel.

    §1.2 of the design rejects the `aux` channel with one argument: *"Using the aux channel
    for spatial means editing `_lib/conformance.py` — the one file in the tree whose whole
    design thesis is that a producer may not influence it."* The mirror is only a legitimate
    alternative if it does not incur that cost, and "we did not edit it" is a claim about a
    diff. This is the claim about the RESULT: no file in `_lib` names the block, its key,
    its version token, or any spatial vocabulary — the gate carries the block because
    `structure` is open-ended, not because anybody taught it to.

    If a future change makes the gate aware of this block, this goes red and the choice
    gets re-argued rather than absorbed.
    """
    source = _DECLARATIONS.read_text()
    token = "txr-spatial/1"
    key = "txr_spatial"
    assert token in source and key in source, (
        "the tokens this test searches for are not in the module that defines them, so "
        "the search below would be vacuously satisfied by any tree at all"
    )

    offenders = []
    # The framework MODULES, not `_lib`'s own test files. A `_lib` test that merely
    # mentions `coordinate_space` in prose would turn this red for a reason that has
    # nothing to do with the gate acquiring an opinion — a guard that fires on the wrong
    # thing gets baselined, and then it is not a guard.
    modules = [p for p in sorted(_LIB_DIR.glob("*.py"))
               if not p.name.startswith("test_")]
    assert len(modules) >= 5, f"the _lib module scan found only {modules}"
    for path in modules:
        body = path.read_text(encoding="utf-8")
        for needle in (token, key, "spatial_declarations", "coordinate_space",
                       "measured_entity", "microns_per_pixel"):
            if needle in body:
                offenders.append(f"{path.name} names {needle!r}")
    assert offenders == [], (
        "the framework library now names the spatial declaration channel, which is the "
        "cost §1.2 rejected the aux channel for: " + "; ".join(offenders)
    )


def test_the_mirror_is_implemented_with_stdlib_and_needs_no_framework_module():
    """TEST-10 (cont.) [invariant: INV-6] — and it did not acquire a framework dependency.

    The complement of the test above: the gate does not know about the block, AND the block
    does not need the gate. `mirror_declarations_into_store` and the reader must resolve
    with nothing but the standard library, so a consumer package that vendors
    `spatial_declarations.py` gets a working channel whatever else is or is not staged
    beside it. `txr_columns` remains the module's ONE cross-package import, and it is
    confined to the writer that always needed it.
    """
    import ast

    tree = ast.parse(_DECLARATIONS.read_text())
    functions = {
        node.name: node for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef,))
    }
    for name in ("mirror_declarations_into_store", "read_spatial_declarations",
                 "require_spatial_declarations", "_read_stamped_structure"):
        assert name in functions, f"{name} is missing from {_DECLARATIONS}"
        imported = set()
        for node in ast.walk(functions[name]):
            if isinstance(node, ast.Import):
                imported |= {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module.split(".")[0])
        assert imported <= {"json", "pathlib", "copy"}, (
            f"{name} imports {sorted(imported - {'json', 'pathlib', 'copy'})}, so the "
            "mirror channel now depends on something beyond the standard library"
        )
    # ...and the two that actually DO the I/O must be among those that import, so the
    # assertion above is not vacuously satisfied by functions that import nothing at all.
    carriers = [n for n in ("mirror_declarations_into_store", "_read_stamped_structure")
                if any(isinstance(node, (ast.Import, ast.ImportFrom))
                       for node in ast.walk(functions[n]))]
    assert set(carriers) == {"mirror_declarations_into_store", "_read_stamped_structure"}, (
        f"only {carriers} carry imports, so the stdlib-only assertion above is checking "
        "functions that import nothing"
    )

    # the module's ONE cross-package import, unchanged and still confined to the writer
    # ZERO top-level imports — every import in this module is lazy by design, which is
    # what lets a consumer package vendor it and get a working channel whatever else is
    # staged beside it. Asserted as one statement: the earlier form was
    # `module_level <= {None} and not [...]`, whose first conjunct is vacuous the moment
    # the second holds.
    top_level = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))]
    assert top_level == [], (
        "the module acquired a top-level import "
        f"({[ast.dump(n)[:60] for n in top_level]}); every import here is lazy by design"
    )


# ── no disabled guard may ship, however it got there ─────────────────────────────────


def test_no_shipped_spatial_compute_module_carries_a_disabled_branch():
    """A guard neutralised by an edit must not reach a commit.

    This exists because it happened, on this branch: a mutation battery's `if False:`
    survived a revert into the working tree, and the ONLY thing that noticed was a test
    asserting a refusal that stopped happening. That is luck — the mutation targeted a
    guard that had a test; the next one might not.

    The repo has paid for this class before: `test_registration_qc.py` still documents an
    assertion that "was dead in the original suite (`if False:` survived)".

    Cheap, exact, and it covers every future battery: no shipped `compute/` module of a
    spatial package may contain a statically-dead branch.
    """
    packages = _PACKAGES
    modules = sorted(packages.glob("spatial-*/compute/*.py"))
    assert len(modules) >= 6, f"the module sweep found only {modules}"

    offenders = []
    for path in modules:
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            stripped = line.strip()
            for dead in ("if False:", "if 0:", "if None:", "while False:"):
                if stripped.startswith(dead):
                    offenders.append(f"{path.relative_to(packages)}:{number} {stripped}")
    assert offenders == [], (
        "a statically-dead branch is shipping in a spatial compute module — a guard that "
        "was switched off and not switched back on:\n  " + "\n  ".join(offenders)
    )
