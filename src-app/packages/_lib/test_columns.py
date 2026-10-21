#!/usr/bin/env python3
# ruff: noqa
"""ITEM-26 — the pandas→Zarr column adapter every processor now writes through.

Decodes with the same independent reference reader `test_zarr_writer.py` uses, so these
assert the BYTES, not the adapter agreeing with itself.

Every call below DECLARES its `axis` (and, for an embedding, its `name` and `kind`). The
adapter used to default them — `axis="cells"`, `name`/`kind` to `"embedding"` — and these
tests pinned those defaults, which made them a certification of the bug: a framework
library naming a domain (INV-5) and inventing a declaration for the producer (INV-2). Most
of them now declare a deliberately NON-domain axis, because a framework library that has
no domain in it must be exercised without one;
`test_a_declared_axis_name_and_kind_reach_the_bytes_verbatim` covers the domain-flavoured
values as PASSED-IN data, and
`test_an_undeclared_axis_name_or_kind_is_an_error_not_a_default` is the control that no
default sneaked back.
"""
import json

import numpy as np
import pandas as pd
import pytest

import cyto_columns as cc
import cyto_zarr
from test_zarr_writer import read_array, read_meta, read_string


def test_a_declared_categorical_keeps_its_declared_levels(tmp_path):
    s = pd.Series(pd.Categorical(["a", "c", "a"], categories=["a", "b", "c", "d"]))
    structure, meta = cc.write_metadata_column(tmp_path, "col.zarr", "cluster", s, axis="rows")
    assert meta["kind"] == "categorical"
    # The level LIST is asserted on `structure` (below) and on the stored stamp, not on
    # `meta`: `meta` carries only `n_levels` now, because a level set is data and the
    # manifest is size-capped metadata (a 35,477-level column blew the 1 MiB cap). The
    # "unobserved level survives" contract is unchanged and still checked — through the
    # declaration the conformance gate actually cross-checks.
    assert meta["n_levels"] == 4 and "levels" not in meta
    assert read_meta(tmp_path / "col.zarr", "values")["data_type"] == "uint8"
    np.testing.assert_array_equal(read_array(tmp_path / "col.zarr", "values"), [0, 2, 0])
    assert structure["columns"][0]["levels_digest"] == cyto_zarr.key_sequence_digest(
        ["a", "b", "c", "d"]
    ), "an unobserved level survives"
    assert read_meta(tmp_path / "col.zarr", "values")["attributes"]["cyto"]["levels"] == [
        "a", "b", "c", "d"
    ], "and the stored stamp — the copy every reader resolves through — agrees"


def test_a_missing_categorical_gets_a_declared_non_colliding_level(tmp_path):
    s = pd.Series(pd.Categorical(["a", None, "b"], categories=["a", "b", "NA"]))
    structure, meta = cc.write_metadata_column(tmp_path, "c.zarr", "arm", s, axis="rows")
    # "NA" is already declared, so the missing level steps aside rather than merging.
    assert meta["missing_level"] == "NA_" and meta["n_missing"] == 1
    assert meta["n_levels"] == 4
    # The list itself is on `structure` + the stamp (see the note above), so the
    # stepped-aside level is asserted there.
    assert structure["columns"][0]["levels_digest"] == cyto_zarr.key_sequence_digest(
        ["a", "b", "NA", "NA_"]
    )
    np.testing.assert_array_equal(read_array(tmp_path / "c.zarr", "values"), [0, 3, 1])


def test_integers_stay_integers_at_the_source_width(tmp_path):
    s = pd.Series(np.array([1, 2, 2**40], dtype=np.int64))
    _s, meta = cc.write_metadata_column(tmp_path, "i.zarr", "count", s, axis="rows")
    assert meta["kind"] == "continuous" and meta["stored_dtype"] == "int64"
    assert read_meta(tmp_path / "i.zarr", "values")["data_type"] == "int64"
    np.testing.assert_array_equal(read_array(tmp_path / "i.zarr", "values"), [1, 2, 2**40])


def test_floats_carry_nan_natively(tmp_path):
    s = pd.Series([1.5, np.nan, -2.25])
    _s, meta = cc.write_metadata_column(tmp_path, "f.zarr", "pct_mt", s, axis="rows")
    assert meta["kind"] == "continuous" and meta["n_missing"] == 1
    got = read_array(tmp_path / "f.zarr", "values")
    assert got[0] == 1.5 and np.isnan(got[1]) and got[2] == -2.25


def test_free_text_becomes_a_string_column_not_a_giant_categorical(tmp_path):
    s = pd.Series([f"AAAC{i:04d}-1" for i in range(50)])
    structure, meta = cc.write_metadata_column(tmp_path, "b.zarr", "cell_id", s, axis="rows")
    assert meta["stored_dtype"] == "utf8"
    assert structure["columns"][0]["kind"] == "string"
    assert read_string(tmp_path / "b.zarr", "values") == list(s)


def test_a_missing_string_is_recorded_not_lost(tmp_path):
    s = pd.Series(["x", None, "z"], dtype=object)
    _s, meta = cc.write_metadata_column(tmp_path, "s.zarr", "note", s, axis="rows")
    assert meta["missing"] == {"n": 1, "encoded_as": ""}
    assert read_string(tmp_path / "s.zarr", "values") == ["x", "", "z"]


def test_a_bool_column_stores_bytes_and_declares_its_legend(tmp_path):
    s = pd.Series([True, False, True])
    _s, meta = cc.write_metadata_column(tmp_path, "m.zarr", "keep", s, axis="rows")
    assert meta["kind"] == "categorical" and meta["levels"] == ["false", "true"]
    assert read_meta(tmp_path / "m.zarr", "values")["data_type"] == "bool"
    np.testing.assert_array_equal(read_array(tmp_path / "m.zarr", "values"), [1, 0, 1])


def test_an_embedding_is_one_two_dimensional_member(tmp_path):
    mat = np.random.default_rng(1).normal(size=(300, 2))
    structure, meta = cc.write_embedding(tmp_path, "umap.zarr", mat, axis="rows",
                                         name="coords", kind="coordinates", method="umap")
    assert meta == {"name": "coords", "kind": "coordinates", "axis": "rows",
                    "n": 300, "n_dims": 2, "method": "umap"}
    assert structure["columns"] == [] and len(structure["arrays"]) == 1
    got = read_array(tmp_path / "umap.zarr", "coords")
    assert got.shape == (300, 2)
    np.testing.assert_allclose(got, mat.astype(np.float32))
    with pytest.raises(ValueError, match="dense 2-D"):
        cc.write_embedding(tmp_path, "bad.zarr", np.arange(4), axis="rows", name="coords",
                           kind="coordinates")


def test_a_declared_axis_name_and_kind_reach_the_bytes_verbatim(tmp_path):
    """The values `anndata-import` passes, asserted as PASSED-IN rather than as defaults.

    This is the same triple the adapter used to default (`cells` / `embedding` /
    `embedding`) — but here it arrives from the caller, so what is pinned is that a
    producer's declaration flows through unaltered into `structure.axis`, the Zarr
    `dimension_names`, the member path and `meta`. The adapter is exercised with the
    domain-flavoured values it must transport and must not know.
    """
    mat = np.random.default_rng(2).normal(size=(64, 3))
    structure, meta = cc.write_embedding(tmp_path, "e.zarr", mat, axis="cells",
                                         name="embedding", kind="embedding")
    assert meta == {"name": "embedding", "kind": "embedding", "axis": "cells",
                    "n": 64, "n_dims": 3}
    assert structure["axis"] == "cells"
    assert structure["arrays"][0]["name"] == "embedding"
    assert read_meta(tmp_path / "e.zarr", "embedding")["dimension_names"] == ["cells", None]
    assert read_array(tmp_path / "e.zarr", "embedding").shape == (64, 3)

    # Same for a column: the axis the producer names is the axis the bytes carry, right
    # down to the Zarr node's `dimension_names`.
    structure, meta = cc.write_metadata_column(tmp_path, "k.zarr", "n_counts",
                                               pd.Series([1.5, 2.5]), axis="genes")
    assert meta["axis"] == "genes" and structure["axis"] == "genes"
    assert read_meta(tmp_path / "k.zarr", "values")["dimension_names"] == ["genes"]

    # …and a key column keeps the producer's axis on its key declaration (INV-3), which is
    # what gives the artifact an identity that is not its name.
    keys, _meta = cc.write_metadata_column(tmp_path, "keys.zarr", "cell_id",
                                           pd.Series(["AAACc-1", "AAACg-1"]),
                                           axis="genes", holds_axis_keys=True)
    assert keys["axis"] == "genes" and keys["key"] == "values"
    assert len(keys["key_sequence_digest"]) == 64


def test_an_undeclared_axis_name_or_kind_is_an_error_not_a_default(tmp_path):
    """INV-2 on the framework library: absence is an error, never an assumed `"cells"`.

    The control for the whole fix. `cyto_columns` is staged into EVERY processor, so a
    default here is this library authoring a domain fact for every producer that will ever
    exist (INV-5). Omission is a `TypeError` (keyword-required, enforced by the language);
    a present-but-meaningless value is a `ValueError`, because `cyto_zarr.Table` does
    `str(axis)` and `None` would otherwise become an axis literally named `"None"`.
    """
    s = pd.Series([1.0, 2.0])
    mat = np.zeros((2, 2))
    with pytest.raises(TypeError):
        cc.write_metadata_column(tmp_path, "no-axis.zarr", "x", s)
    with pytest.raises(TypeError):
        cc.write_embedding(tmp_path, "no-axis-emb.zarr", mat, name="coords",
                           kind="coordinates")
    with pytest.raises(TypeError):
        cc.write_embedding(tmp_path, "no-name.zarr", mat, axis="rows", kind="coordinates")
    with pytest.raises(TypeError):
        cc.write_embedding(tmp_path, "no-kind.zarr", mat, axis="rows", name="coords")

    for bad in (None, "", "   ", 7):
        with pytest.raises(ValueError, match="INV-2"):
            cc.write_metadata_column(tmp_path, "bad-axis.zarr", "x", s, axis=bad)
        with pytest.raises(ValueError, match="INV-2"):
            cc.write_embedding(tmp_path, "bad-emb.zarr", mat, axis=bad, name="coords",
                               kind="coordinates")
        with pytest.raises(ValueError, match="INV-2"):
            cc.write_embedding(tmp_path, "bad-name.zarr", mat, axis="rows", name=bad,
                               kind="coordinates")
        with pytest.raises(ValueError, match="INV-2"):
            cc.write_embedding(tmp_path, "bad-kind.zarr", mat, axis="rows", name="coords",
                               kind=bad)


def test_opaque_still_declares_something(tmp_path):
    assert cc.opaque("application/json") == {"encoding": "opaque",
                                             "media_type": "application/json"}
    assert cc.opaque("text/html", role="report")["role"] == "report"


# ── TEST-23 / ITEM-15 — `structure.aligned_to`, the row space a column belongs to ──


def test_a_column_declares_the_row_space_its_values_line_up_with(tmp_path):
    """The axis LABEL does not identify; the axis's key sequence does.

    `structure.axis` is the same string (`rows`) for every dataset in a project, so a
    consumer reading the catalog cannot tell whether a column may be painted on a given set
    of points. `aligned_to` is the axis's `key_sequence_digest` — taken off the key artifact
    that IS the axis, which is where the value is authored (a producer cannot mint an axis's
    `content_hash`; ingest does, after the fact).
    """
    keys = pd.Series(["c1", "c2", "c3"])
    axis, _meta = cc.write_metadata_column(tmp_path, "axis.zarr", "cell_id", keys,
                                           axis="rows", holds_axis_keys=True)
    digest = axis["key_sequence_digest"]

    column, _ = cc.write_metadata_column(tmp_path, "col.zarr", "score",
                                         pd.Series([1.0, 2.0, 3.0]), axis="rows",
                                         aligned_to=digest)
    coords, _ = cc.write_embedding(tmp_path, "emb.zarr", np.zeros((3, 2)), axis="rows",
                                   name="embedding", kind="coordinates",
                                   aligned_to=digest)
    assert column["aligned_to"] == digest
    assert coords["aligned_to"] == digest
    # The SAME document is stamped into the store, not only returned — a consumer handed
    # the URL learns the alignment from the first request it was going to make anyway.
    stamped = json.loads((tmp_path / "col.zarr" / "zarr.json").read_text())
    assert stamped["attributes"]["cyto"]["aligned_to"] == digest


def test_an_undeclared_alignment_is_ABSENT_never_guessed(tmp_path):
    """Omission emits NO key at all.

    Not `null`, and above all not the artifact's own axis LABEL: a producer that does not
    hold the axis's keys cannot honestly say which row space its values belong to, and the
    viewer renders that absence as a real state (alignment not declared, A3) rather than
    treating it as a match.
    """
    column, _ = cc.write_metadata_column(tmp_path, "col.zarr", "score",
                                         pd.Series([1.0, 2.0]), axis="rows")
    coords, _ = cc.write_embedding(tmp_path, "emb.zarr", np.zeros((2, 2)), axis="rows",
                                   name="embedding", kind="coordinates")
    assert "aligned_to" not in column and "aligned_to" not in coords


def test_the_keys_themselves_are_not_a_digest(tmp_path):
    """The obvious slip — passing the key SEQUENCE where the digest goes — is refused.

    Without this, `aligned_to=obs_names` would stamp a stringified Index into the artifact
    row as an alignment declaration, and the only symptom would be a picker silently
    offering nothing.
    """
    s = pd.Series([1.0, 2.0])
    for bad in (["c1", "c2"], "rows", "", "not-a-digest", 7, "A" * 64):
        with pytest.raises(ValueError, match="key_sequence_digest"):
            cc.write_metadata_column(tmp_path, "bad.zarr", "x", s, axis="rows",
                                     aligned_to=bad)


def test_an_artifact_that_carries_the_keys_cannot_claim_a_different_axis(tmp_path):
    """A key artifact IS its axis, so it is aligned to itself.

    Declaring both, disagreeing, is a contradiction between one producer's own two
    statements — decidable without opening a byte, so it is refused at the writer instead of
    being left for the gate.
    """
    other = cyto_zarr.key_sequence_digest(["z1", "z2"])
    with pytest.raises(ValueError, match="cannot disagree"):
        cc.write_metadata_column(tmp_path, "keys.zarr", "cell_id",
                                 pd.Series(["c1", "c2"]), axis="rows",
                                 holds_axis_keys=True, aligned_to=other)
    # …and agreeing is fine: it is redundant, not wrong.
    same = cyto_zarr.key_sequence_digest(["c1", "c2"])
    keys, _ = cc.write_metadata_column(tmp_path, "keys2.zarr", "cell_id",
                                       pd.Series(["c1", "c2"]), axis="rows",
                                       holds_axis_keys=True, aligned_to=same)
    assert keys["aligned_to"] == keys["key_sequence_digest"] == same


def test_the_anticipated_digest_either_matches_the_stored_one_or_refuses(tmp_path):
    """`axis_key_digest` exists so a producer can declare `aligned_to` on artifacts it
    writes BEFORE the axis's own key artifact — and it is only safe while it anticipates
    exactly what the writer stores, coercion included.

    So this walks every dtype the writer dispatches on and allows exactly two outcomes:
    the anticipated digest EQUALS the stored one, or the anticipation is REFUSED. A silent
    disagreement — the one failure that would make every column in a run declare a row
    space that does not exist — cannot pass this test, which is why the assertion is
    written as a fork rather than as a list of dtypes someone has to keep in sync.
    """
    cases = {
        "text": pd.Series(["c1", "c2", "c3"]),
        "text-with-missing": pd.Series(["c1", None, "c3"]),
        "integer": pd.Series([1, 2, 3]),
        "bool": pd.Series([True, False, True]),
        "categorical": pd.Series(pd.Categorical(["a", "b", "a"])),
    }
    refused = []
    for name, raw in cases.items():
        stored, _ = cc.write_metadata_column(tmp_path, f"k-{name}.zarr", "cell_id", raw,
                                             axis="rows", holds_axis_keys=True)
        try:
            anticipated = cc.axis_key_digest(raw)
        except ValueError:
            refused.append(name)
            continue
        assert anticipated == stored["key_sequence_digest"], name
    # The negative control: the refusals are real refusals of the NON-text encodings, not
    # a function that refuses everything and passes the fork vacuously.
    assert "text" not in refused and "text-with-missing" not in refused
    assert set(refused) == {"integer", "bool", "categorical"}
    # Float is absent from the fork above because it cannot be an axis key at ALL — the
    # digest refuses it upstream of any of this ("a float key has no canonical spelling"),
    # so there is no stored digest for an anticipation to agree or disagree with.
    with pytest.raises(TypeError, match="float key"):
        cc.write_metadata_column(tmp_path, "k-float.zarr", "cell_id",
                                 pd.Series([1.0, 2.0]), axis="rows", holds_axis_keys=True)


# ── membership: WHICH members of an axis these rows are (ITEM-1/3/4/5) ──────────


def _axis_keys(n, prefix="c"):
    """An axis's ordered key sequence — what a membership is selected OUT OF."""
    return [f"{prefix}{i}" for i in range(n)]


def _axis_artifact(tmp_path, rel_dir, keys):
    """A real key artifact, written by the same writer a producer would use, so
    `derived_from` in the tests is the thing a producer actually holds rather than a
    hand-built dict that agrees with the writer by construction."""
    structure, _ = cc.write_metadata_column(tmp_path, rel_dir, "cell_id",
                                            pd.Series(keys), axis="rows",
                                            holds_axis_keys=True)
    return structure


def test_two_memberships_are_two_entries_in_the_declared_order(tmp_path):
    """TEST-1 — a table resting on TWO axes declares TWO pairs, in the order given.

    The plural case is the one the whole model exists for, and it is the one a scalar
    `aligned_to` cannot express at all: an integrated coordinate rests on both datasets'
    axes and neither is "the" one, so a single entry is not a partial answer but a wrong
    one — half its rows are declared to be about rows they are not.
    """
    left = _axis_artifact(tmp_path, "left.zarr", _axis_keys(10, "l"))
    right = _axis_artifact(tmp_path, "right.zarr", _axis_keys(10, "r"))

    structure, _ = cc.write_metadata_column(
        tmp_path, "col.zarr", "score", pd.Series([1.0, 2.0, 3.0]), axis="rows",
        membership=[
            {"axis": "left", "aligned_to": left["key_sequence_digest"],
             "derived_from": left, "members": [1, 4], "member": "members_left"},
            {"axis": "right", "aligned_to": right["key_sequence_digest"],
             "derived_from": right, "members": [7], "member": "members_right"},
        ],
    )

    entries = structure["memberships"]
    # The SET-and-ORDER assertion, not a length check: a wrong set of the same size is
    # the failure a count absorbs. `aligned_to` is the identifying component, so it is
    # what the comparison is made on.
    assert [e["aligned_to"] for e in entries] == [
        left["key_sequence_digest"], right["key_sequence_digest"]
    ], "the declared order IS the segment order; a gather may not re-derive it"
    assert [e["axis"] for e in entries] == ["left", "right"]
    assert [e["kind"] for e in entries] == ["subset", "subset"]
    assert [e["n_members"] for e in entries] == [2, 1]
    # nc: collapsing to ONE entry fails the first assertion (one digest, not two);
    # reversing the declaration fails it too, in the other direction — which is what
    # makes this more than "two things came back".


def test_a_membership_is_refused_when_its_evidence_is_a_different_axis(tmp_path):
    """TEST-4 — the producer half of the off-by-thousands guard.

    `aligned_to` on its own is an unchecked claim, and the failure it hides is the
    expensive kind: positions selected out of axis X declared against axis Y gather the
    right NUMBER of the wrong rows. Every declaration stays well-formed and every byte is
    present, so nothing downstream can tell. The writer is therefore given the axis the
    positions came out of and refuses the pair when the two are not one axis.
    """
    left = _axis_artifact(tmp_path, "left.zarr", _axis_keys(10, "l"))
    right = _axis_artifact(tmp_path, "right.zarr", _axis_keys(10, "r"))
    assert left["key_sequence_digest"] != right["key_sequence_digest"]

    with pytest.raises(ValueError, match="derived from"):
        cc.write_metadata_column(
            tmp_path, "col.zarr", "score", pd.Series([1.0, 2.0]), axis="rows",
            membership={"axis": "rows", "aligned_to": right["key_sequence_digest"],
                        "derived_from": left, "members": [1, 4]},
        )

    # …and the same call with matching evidence succeeds — the positive control that the
    # writer refuses the DISAGREEMENT rather than refusing memberships.
    structure, _ = cc.write_metadata_column(
        tmp_path, "ok.zarr", "score", pd.Series([1.0, 2.0]), axis="rows",
        membership={"axis": "rows", "aligned_to": left["key_sequence_digest"],
                    "derived_from": left, "members": [1, 4]},
    )
    assert structure["memberships"][0]["aligned_to"] == left["key_sequence_digest"]
    # nc: with the comparison removed the first call SUCCEEDS and this test fails.

    # Evidence is not optional. Making it so is the cheapest way to lose the check
    # without deleting it, so absence is refused rather than defaulted.
    with pytest.raises(ValueError, match="DERIVED FROM"):
        cc.write_metadata_column(
            tmp_path, "no-evidence.zarr", "score", pd.Series([1.0, 2.0]), axis="rows",
            membership={"axis": "rows", "aligned_to": left["key_sequence_digest"],
                        "members": [1, 4]},
        )


def test_the_inline_member_set_round_trips_and_is_absent_above_the_budget(tmp_path):
    """TEST-5 — the inline copy is exact within the budget and ABSENT above it.

    Absent, never truncated: a truncated member set is a wrong answer that reads as a
    right one, while an absent one is a state the consumer renders. `n_members` and the
    index body are present either way, so nothing about the artifact becomes unknowable —
    only the catalog-only shortcut goes away.
    """
    positions = [0, 1, 2, 5, 9, 130, 131, 16_500]
    axis = _axis_artifact(tmp_path, "axis.zarr", _axis_keys(20_000))
    structure, _ = cc.write_metadata_column(
        tmp_path, "small.zarr", "score", pd.Series([float(p) for p in positions]),
        axis="rows",
        membership={"axis": "rows", "aligned_to": axis["key_sequence_digest"],
                    "derived_from": axis, "members": positions},
    )
    entry = structure["memberships"][0]
    assert entry["n_members"] == len(positions)
    # EXACTLY the positions, decoded — not "a set of the right size". The multi-byte
    # varints (130, 16_500) are in the fixture on purpose: a one-byte-per-gap
    # implementation returns a plausible ascending list and fails only here.
    assert cyto_zarr.decode_member_set(entry["bitmap"]) == positions

    # Above the budget. Contiguous positions cost one byte each, so the blob crosses
    # 64 KiB of base64 at ~49,152 members; 50,000 is over it with margin.
    n_big = 50_000
    big_axis = _axis_artifact(tmp_path, "big-axis.zarr", _axis_keys(n_big, "b"))
    big, _ = cc.write_metadata_column(
        tmp_path, "big.zarr", "score", pd.Series(np.arange(n_big, dtype="float64")),
        axis="rows",
        membership={"axis": "rows", "aligned_to": big_axis["key_sequence_digest"],
                    "derived_from": big_axis, "members": list(range(n_big))},
    )
    big_entry = big["memberships"][0]
    assert "bitmap" not in big_entry, "above the budget the inline copy is absent"
    assert big_entry["n_members"] == n_big, "the count survives the budget"
    # …and the BODY is still written, which is what keeps the set knowable at all.
    np.testing.assert_array_equal(
        read_array(tmp_path / "big.zarr", "members"), np.arange(n_big, dtype="uint32")
    )
    # nc: emitting a truncated blob above the budget fails the round trip in the small
    # arm's shape (decode ≠ positions) and fails `"bitmap" not in` here; dropping
    # `n_members` with the blob fails the count assertion.


# ══════════════════════════════════════════════════════════════════════════════
#  cyto_zarr_read — the UNSHARDED array a materialised gathered column is
# ══════════════════════════════════════════════════════════════════════════════
#
# `cyto_zarr` never writes this shape; the SERVER does. A gathered (virtual) column has no
# blob, so the coordinator materialises it into an ordinary zarr store before staging it as a
# sandbox input, declaring `codecs: [bytes]` rather than re-encoding each chunk into the
# writer's shuffle+gzip+shard container.
#
# `read_array` reached for `codecs[0].configuration.chunk_shape`, which a `bytes` codec does
# not have, so EVERY processor consuming a gathered input died with `KeyError: 'chunk_shape'`.
# Measured against a store of that shape, not reasoned from the format doc.


def _write_plain_store(root, values, levels=None, chunk=4):
    """A store in the shape the server materialises: group + one plain-codec member."""
    import json

    member = root / "values"
    (member / "c").mkdir(parents=True)
    cyto = {"kind": "categorical", "name": "values", "levels": levels} if levels else {}
    (member / "zarr.json").write_text(
        json.dumps(
            {
                "zarr_format": 3,
                "node_type": "array",
                "shape": [len(values)],
                "data_type": "uint8",
                "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [chunk]}},
                "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
                "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
                "fill_value": 0,
                "attributes": {"cyto": cyto},
            }
        )
    )
    for g in range((len(values) + chunk - 1) // chunk):
        block = values[g * chunk : (g + 1) * chunk]
        # Chunks are padded to full width, exactly as the server writes them — a reader that
        # trusted the file length rather than the declared shape would read the padding as
        # data on the trailing chunk.
        (member / "c" / str(g)).write_bytes(bytes(block + [0] * (chunk - len(block))))
    return root


def test_a_plain_codec_member_decodes_across_chunks_including_a_padded_tail(tmp_path):
    import cyto_zarr_read as r

    root = _write_plain_store(tmp_path / "g", [1, 0, 2, 3, 1])
    out = r.read_array(root, "values")
    # Five elements at four per chunk: two chunks, the second padded to full width. A reader
    # that trusted the file length would return six.
    assert len(out) == 5, "the declared shape bounds the read, not the padded chunk length"
    assert list(out) == [1, 0, 2, 3, 1]


def test_a_plain_categorical_resolves_to_labels_not_codes(tmp_path):
    """`read_column` dispatches on `attributes.cyto.kind`, which the member must declare.

    Without it a processor gets integers at the right address — a wrong answer with a clean
    console, which is worse than the KeyError it replaced.
    """
    import cyto_zarr_read as r

    root = _write_plain_store(tmp_path / "g", [1, 0, 2, 3, 1], levels=["g1", "g2", "g3", "g4"])
    assert r.read_column(root) == ["g2", "g1", "g3", "g4", "g2"]

    # NEGATIVE CONTROL — the same bytes with no declared kind read as raw codes, so the
    # assertion above is about the DECLARATION and not about the values happening to match.
    bare = _write_plain_store(tmp_path / "bare", [1, 0, 2, 3, 1])
    assert list(r.read_column(bare)) == [1, 0, 2, 3, 1]
