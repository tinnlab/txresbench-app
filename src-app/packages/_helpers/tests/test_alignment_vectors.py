#!/usr/bin/env python3
# ruff: noqa
"""TEST-2 / TEST-21 / TEST-22 / TEST-23 — the three vectors (ITEM-6/7/8/9).

Four items, one file, because the vectors only mean anything together: a row vector is
positional into a source, so it is uninterpretable without the segment table that says which
source, and unverifiable without the digest that says the source has not moved underneath it.

## The failure this file is really about

`source_key_digests` (ITEM-9) guards the one defect in this feature with NO observable
symptom. The row vector is positional, so a source whose key sequence changed returns the
right NUMBER of the WRONG rows — every count agrees, every length assertion passes, the
console is clean, and the picture is simply of different cells. Every other test here can be
satisfied by an implementation that is silently reading the wrong data; only the digest
tests can tell.
"""
from __future__ import annotations

import pytest

import alignment
from alignment import (
    AUTHORITY,
    STRICT,
    AlignmentError,
    SourceTable,
    build_vectors,
    source_key_digests,
)


# ── fixtures ─────────────────────────────────────────────────────────────────────


def two_sources(*, a_rows=3, b_rows=2):
    """Two sources sharing entities A/B/C, each with one private entity.

    Row counts differ on purpose: equal counts would let an off-by-one in the segment
    arithmetic produce a plausible-looking vector.
    """
    a = SourceTable(
        "ds-a",
        {"symbol": ["A", "B", "C", "A_ONLY"], "ensembl_id": ["E1", "E2", "E3", "E9"]},
        row_keys=[f"a-cell-{i}" for i in range(a_rows)],
    )
    b = SourceTable(
        "ds-b",
        {"symbol": ["B_ONLY", "C", "B", "A"], "ensembl_id": ["E8", "E3", "E2", "E1"]},
        row_keys=[f"b-cell-{i}" for i in range(b_rows)],
    )
    return [a, b]


def by_dataset(segments):
    return {s["dataset_id"]: s for s in segments}


# ── TEST-2 (ITEM-7): the entity vector is an INTERSECTION ────────────────────────


def test_an_entity_present_in_ONE_source_only_has_NO_entry(tmp_path=None):
    """INV-2. `A_ONLY` and `B_ONLY` exist in the inputs; neither is addressable."""
    v = build_vectors(two_sources(), "symbol")
    assert v["entities"] == ["A", "B", "C"], v["entities"]
    assert "A_ONLY" not in v["entities"]
    assert "B_ONLY" not in v["entities"]
    # …and the inputs really do carry them, or this asserts nothing.
    assert "A_ONLY" in two_sources()[0].columns["symbol"]
    assert "B_ONLY" in two_sources()[1].columns["symbol"]


def test_the_entity_vector_is_TOTAL_so_absence_is_unrepresentable():
    """INV-12's foundation: every entity has an index for EVERY source, so there is no
    absence to encode and therefore no sentinel and no fabricated zero.

    Asserted as "no entry is None AND the width equals the source count" — a vector that
    had grown a `None` arm would fail the first, and one that had silently narrowed would
    fail the second.
    """
    sources = two_sources()
    v = build_vectors(sources, "symbol")
    assert len(v["entity_index"]) == len(v["entities"])
    for row in v["entity_index"]:
        assert len(row) == len(sources), row
        assert all(isinstance(i, int) for i in row), row
        assert None not in row, row


def test_each_index_addresses_the_RIGHT_entity_in_each_source():
    """A total vector of the wrong indices is still total. This resolves each index back
    through the source's own column and asserts the entity matches."""
    sources = two_sources()
    v = build_vectors(sources, "symbol")
    for entity, row in zip(v["entities"], v["entity_index"]):
        for src_i, col_index in enumerate(row):
            assert sources[src_i].columns["symbol"][col_index] == entity, (
                f"entity {entity!r} index {col_index} in {sources[src_i].dataset_id} points "
                f"at {sources[src_i].columns['symbol'][col_index]!r}"
            )


def test_the_sources_orders_DIFFER_so_the_index_is_not_a_position():
    """The fixture's two sources list their shared entities in different orders, so a
    build that returned `range(n)` for both would fail the resolution test above. Pinned
    here so the fixture cannot be "simplified" into agreement."""
    sources = two_sources()
    shared = ["A", "B", "C"]
    a_pos = [sources[0].columns["symbol"].index(e) for e in shared]
    b_pos = [sources[1].columns["symbol"].index(e) for e in shared]
    assert a_pos != b_pos, (a_pos, b_pos)


def test_an_EMPTY_intersection_is_REFUSED_rather_than_emitted():
    """`anndata-import`'s `align_barcodes` precedent. An alignment over zero shared
    entities is not a small alignment — it is a dataset with no readable column, and
    emitting it defers the failure to a reader that can only say "no data"."""
    a = SourceTable("ds-a", {"symbol": ["A"]}, row_keys=["a0"])
    b = SourceTable("ds-b", {"symbol": ["Z"]}, row_keys=["b0"])
    with pytest.raises(AlignmentError, match="share no 'symbol' value in common"):
        build_vectors([a, b], "symbol")


def test_a_union_would_be_visible_as_a_LONGER_entity_axis():
    """The negative control expressed as an arithmetic relation rather than a rerun: the
    union of the two fixtures is strictly larger than the intersection, so an
    implementation that unioned could not produce the length asserted above."""
    sources = two_sources()
    union = set(sources[0].columns["symbol"]) | set(sources[1].columns["symbol"])
    intersection = build_vectors(sources, "symbol")["entities"]
    assert len(union) == 5 and len(intersection) == 3, (sorted(union), intersection)


# ── TEST-21 (ITEM-6): the segment table and its DECLARED order ───────────────────


def test_declared_order_comes_from_the_PRODUCERS_index_and_reversing_it_reverses_them():
    """The declaration is what orders the segments — not the array they arrive in."""
    forward = build_vectors(two_sources(), "symbol")
    assert by_dataset(forward["segments"])["ds-a"]["declared_order"] == 0
    assert by_dataset(forward["segments"])["ds-b"]["declared_order"] == 1

    reversed_sources = list(reversed(two_sources()))
    backward = build_vectors(reversed_sources, "symbol")
    assert by_dataset(backward["segments"])["ds-b"]["declared_order"] == 0
    assert by_dataset(backward["segments"])["ds-a"]["declared_order"] == 1


def test_the_segment_ARRAY_order_is_deliberately_NOT_the_semantic_order():
    """The property that makes `declared_order` load-bearing rather than decorative.

    If the array happened to be in semantic order, a consumer that ignored the field would
    be ACCIDENTALLY RIGHT — every test would pass and the omission would surface only when
    something unrelated reordered the array. The array is sorted by `dataset_id`, so for a
    declaration that is not alphabetical the two orders differ and `start_row` is
    non-monotonic across the array.
    """
    v = build_vectors(list(reversed(two_sources())), "symbol")
    array_order = [s["dataset_id"] for s in v["segments"]]
    semantic_order = [
        s["dataset_id"] for s in sorted(v["segments"], key=lambda s: s["declared_order"])
    ]
    assert array_order == ["ds-a", "ds-b"], array_order
    assert semantic_order == ["ds-b", "ds-a"], semantic_order
    assert array_order != semantic_order, (
        "the array order and the declared order agree, so a consumer that iterated the "
        "array would be accidentally right and INV-6 would be untested"
    )
    starts = [s["start_row"] for s in v["segments"]]
    assert starts != sorted(starts), (
        f"start_row is monotonic across the array ({starts}), so iterating it happens to "
        "give the right row ranges — the array must not be in row order"
    )


def reconstruct_row(segments, i):
    """`(declared_order, row-within-source)` for output row `i`, from the SEGMENT TABLE alone.

    This is the read-side reconstruction D18 relies on: find the segment whose
    `[start_row, end_row)` output range contains `i`; its `declared_order` names the source
    and `i - start_row` is the row within that source. It replaces the dropped per-row
    `row_segment` / `row_source` vectors — whose value at `i` was exactly
    `(declared_order, i - start_row)`.
    """
    for seg in segments:
        if seg["start_row"] <= i < seg["end_row"]:
            return seg["declared_order"], i - seg["start_row"]
    raise AssertionError(f"output row {i} falls in no segment ({segments})")


def test_the_row_layout_is_laid_out_in_DECLARED_order():
    """Rows follow the declaration, so segment 0's rows come first regardless of where its
    entry sits in the serialised array — checked by RECONSTRUCTING each row from the
    segment table (D18), since the per-row vectors are gone."""
    v = build_vectors(list(reversed(two_sources())), "symbol")
    first = min(v["segments"], key=lambda s: s["declared_order"])
    assert first["dataset_id"] == "ds-b"
    assert first["start_row"] == 0, first
    # ds-b has 2 rows in the fixture, so output rows 0..1 belong to it: reconstructed as
    # (declared_order 0, row 0) and (declared_order 0, row 1).
    assert reconstruct_row(v["segments"], 0) == (0, 0)
    assert reconstruct_row(v["segments"], 1) == (0, 1)


def test_the_row_layout_covers_every_source_row_exactly_once():
    """A concatenation, not an intersection: the ROW axis moves the opposite way to the
    entity axis, and dropping or duplicating a row here would be silent. Reconstructed from
    the segment table (D18) rather than read off a stored vector."""
    sources = two_sources(a_rows=3, b_rows=2)
    v = build_vectors(sources, "symbol")
    assert v["n_rows"] == 5
    seen = sorted(reconstruct_row(v["segments"], i) for i in range(v["n_rows"]))
    expected = sorted(
        (declared, r)
        for declared, s in enumerate(sources)
        for r in range(s.n_rows)
    )
    assert seen == expected, (seen, expected)


def test_the_redundant_row_vectors_and_source_index_are_NO_LONGER_emitted():
    """TEST-40 — the D18 contract change, asserted directly.

    The per-output-row `row_source` / `row_segment` vectors and the segment `source_index`
    field were pure redundancy: every value is derivable from the segment table by a range
    search. This asserts they are ABSENT, and — the load-bearing half — that the
    segments-plus-arithmetic reconstruction of each output row equals what the dropped
    vectors would have held, on a MULTI-SOURCE fixture whose row counts differ so an
    off-by-one would show.
    """
    sources = two_sources(a_rows=3, b_rows=2)
    v = build_vectors(sources, "symbol")

    # The keys are gone from the built vectors…
    assert "row_source" not in v, v.keys()
    assert "row_segment" not in v, v.keys()
    # …and no segment dict carries the redundant `source_index` field.
    for seg in v["segments"]:
        assert "source_index" not in seg, seg
        assert set(seg) == {"dataset_id", "declared_order", "start_row", "end_row"}, seg

    # What the PRE-DROP vectors would have held, computed independently from the declaration:
    # rows laid out in declared order, so row_segment[i] = declared_order of the containing
    # segment and row_source[i] = row-within-source.
    pre_drop = []
    for declared, s in enumerate(sources):
        pre_drop.extend((declared, r) for r in range(s.n_rows))

    reconstructed = [reconstruct_row(v["segments"], i) for i in range(v["n_rows"])]
    assert reconstructed == pre_drop, (reconstructed, pre_drop)


def test_segment_ranges_tile_the_output_with_no_gap_and_no_overlap():
    v = build_vectors(two_sources(a_rows=4, b_rows=3), "symbol")
    ordered = sorted(v["segments"], key=lambda s: s["declared_order"])
    cursor = 0
    for seg in ordered:
        assert seg["start_row"] == cursor, (seg, cursor)
        cursor = seg["end_row"]
    assert cursor == v["n_rows"] == 7


def test_a_source_with_no_row_keys_is_REFUSED_rather_than_guessed():
    """A positional row vector over a source whose rows cannot be identified is exactly the
    failure ITEM-9's digest exists to catch — refused at build rather than emitted
    uncheckable."""
    a = SourceTable("ds-a", {"symbol": ["A"]}, row_keys=["a0"])
    b = SourceTable("ds-b", {"symbol": ["A"]})  # no row_keys
    with pytest.raises(AlignmentError, match="supplied no `row_keys`"):
        build_vectors([a, b], "symbol")


# ── TEST-22 (ITEM-8): the level lookups ──────────────────────────────────────────


def level_sources():
    """`celltype` is a ROW-axis (obs) column, NOT an entity column.

    Putting it in `columns` — as a first cut of this fixture did — makes it a SECONDARY
    IDENTIFIER of the entity join, so under `strict` two datasets whose cells are annotated
    differently drop their whole shared entity set as "conflicting". Measured; that is why
    `row_columns` exists and why DEC-A draws the same line.
    """
    a = SourceTable(
        "ds-a",
        {"symbol": ["A", "B"]},
        row_keys=["a0", "a1"],
        row_columns={"celltype": ["T", "B"]},
    )
    b = SourceTable(
        "ds-b",
        {"symbol": ["A", "B"]},
        row_keys=["b0", "b1"],
        row_columns={"celltype": ["B", "NK"]},
    )
    return [a, b]


def test_a_row_column_is_NOT_a_secondary_identifier_of_the_entity_join():
    """The regression this fixture's own first cut was: an obs column read as an entity
    identifier makes every shared entity "conflicting" and `strict` drops all of them.

    Asserted positively — the entities survive — with the wrong-axis placement shown
    alongside to prove the two really do behave differently.
    """
    assert build_vectors(level_sources(), "symbol")["entities"] == ["A", "B"]

    wrong_axis = [
        SourceTable("ds-a", {"symbol": ["A", "B"], "celltype": ["T", "B"]}, row_keys=["a0", "a1"]),
        SourceTable("ds-b", {"symbol": ["A", "B"], "celltype": ["B", "NK"]}, row_keys=["b0", "b1"]),
    ]
    with pytest.raises(AlignmentError, match="share no 'symbol' value in common"):
        build_vectors(wrong_axis, "symbol")


def test_a_row_column_whose_length_is_not_the_row_count_is_REFUSED_not_truncated():
    """Refused, not padded and not truncated.

    Truncating to the shorter of the two would produce a column that lines up with the row
    axis and is silently missing its tail — the same silent-and-plausible shape as the
    misplacement below, one level down. The assertion is the raise; the second half proves
    no partially-built object escaped.
    """
    with pytest.raises(AlignmentError, match="belongs to a different axis"):
        SourceTable(
            "ds-a", {"symbol": ["A"]}, row_keys=["a0", "a1"], row_columns={"celltype": ["T"]}
        )
    # …and the same mismatch the other way round (column LONGER than the axis) is refused
    # too, so the check is not an accidental one-sided bound.
    with pytest.raises(AlignmentError, match="belongs to a different axis"):
        SourceTable(
            "ds-a", {"symbol": ["A"]}, row_keys=["a0"], row_columns={"celltype": ["T", "B"]}
        )


def test_the_wrong_axis_placement_can_SILENTLY_shrink_the_intersection_without_raising():
    """**The dangerous case, and the reason `row_columns` exists.**

    The empty-intersection fixture above RAISES, which is the survivable failure: it is
    loud, and an author sees it immediately. The one that survives review is this one — an
    obs column misplaced among the entity columns disagrees on SOME entities and not
    others, so `strict` drops only those, the build SUCCEEDS, and the alignment is simply
    smaller than it should be. No error, no warning, a plausible number of genes.

    This pins the shape rather than the count: same sources, same key, and the only
    difference is which parameter `celltype` is passed through — one returns the full
    intersection and the other silently returns a strict subset of it.
    """
    entities = {"symbol": ["A", "B", "C"]}
    rows_a = ["a0", "a1", "a2"]
    rows_b = ["b0", "b1", "b2"]
    # `celltype` agrees on the FIRST two rows and differs on the third, so a misplacement
    # drops exactly one entity — not all of them, which is what makes it survivable.
    celltype_a = ["T", "B", "NK"]
    celltype_b = ["T", "B", "Mono"]

    correct = build_vectors(
        [
            SourceTable("ds-a", entities, row_keys=rows_a, row_columns={"celltype": celltype_a}),
            SourceTable("ds-b", entities, row_keys=rows_b, row_columns={"celltype": celltype_b}),
        ],
        "symbol",
    )
    misplaced = build_vectors(
        [
            SourceTable("ds-a", {**entities, "celltype": celltype_a}, row_keys=rows_a),
            SourceTable("ds-b", {**entities, "celltype": celltype_b}, row_keys=rows_b),
        ],
        "symbol",
    )

    assert correct["entities"] == ["A", "B", "C"], correct["entities"]
    # No exception was raised — that is the whole point of this test.
    assert misplaced["entities"] == ["A", "B"], misplaced["entities"]
    assert set(misplaced["entities"]) < set(correct["entities"]), (
        "the misplacement must produce a STRICT SUBSET — if it produced the same set, this "
        "test would be asserting nothing and the hazard would be untested"
    )
    # …and it is silent in every channel a caller would notice: the vectors are internally
    # consistent, so nothing downstream can tell the difference.
    assert len(misplaced["entity_index"]) == len(misplaced["entities"])
    assert misplaced["n_rows"] == correct["n_rows"], (
        "the ROW axis is unaffected, so a row-count check — the thing most likely to be "
        "asserted downstream — cannot catch this either"
    )


def test_every_source_code_maps_to_a_unified_code_under_strict():
    v = build_vectors(level_sources(), "symbol", level_columns=["celltype"])
    lk = v["level_lookups"]["celltype"]
    assert lk["levels"] == ["T", "B", "NK"], lk
    for source_i, source_levels in enumerate(lk["source_levels"]):
        for code, level in enumerate(source_levels):
            unified = lk["lookups"][source_i][code]
            assert unified is not None, (source_i, code, level)
            assert lk["levels"][unified] == level, (
                f"source {source_i} code {code} ({level!r}) maps to unified {unified} "
                f"which is {lk['levels'][unified]!r}"
            )


def test_a_level_only_ONE_source_carries_still_round_trips_under_strict():
    """The union keeps it, so omitting its lookup entry would leave an unmapped code."""
    v = build_vectors(level_sources(), "symbol", level_columns=["celltype"])
    lk = v["level_lookups"]["celltype"]
    assert "NK" in lk["levels"], lk["levels"]
    nk_source, nk_code = 1, lk["source_levels"][1].index("NK")
    assert lk["lookups"][nk_source][nk_code] == lk["levels"].index("NK")


def test_under_authority_a_dropped_level_maps_to_a_DECLARED_MISSING_LEVEL():
    """C4 — this test previously asserted `None`, and the change is the point.

    ITEM-5's intent was a full-axis column with an explicit absent value, and that is
    unchanged. Its ENCODING was wrong: `None` became `-1` on disk, and the read side refuses
    a negative code with a 400 for the ENTIRE column — so `authority`, the only mode that
    drops, emitted a conforming artifact that could never be served.

    The tree had already settled the encoding. `cyto_columns` invents a real, declared level
    rather than *"storing an out-of-range code"*, and that is what a dropped level maps to
    now: an in-range index into a vocabulary that CARRIES a label for absence.

    Mapping it to any OTHER real code would still be the silent relabel the old name warned
    about — which is why the assertion is that it maps to the missing level SPECIFICALLY,
    and that the label is the last entry rather than shadowing a real one.
    """
    v = build_vectors(
        level_sources(), "symbol", mode=AUTHORITY, authority="ds-a",
        level_columns=["celltype"],
    )
    lk = v["level_lookups"]["celltype"]
    assert lk["missing_level"] == "NA", lk["missing_level"]
    # The authority's vocabulary, PLUS the declared absence label — appended, never inserted.
    assert lk["levels"] == ["T", "B", "NA"], lk["levels"]
    nk_code = lk["source_levels"][1].index("NK")
    assert lk["lookups"][1][nk_code] == lk["levels"].index("NA"), lk["lookups"][1]
    # …and NOT onto one of the authority's real levels, which is the silent relabel.
    assert lk["lookups"][1][nk_code] not in (0, 1), lk["lookups"][1]
    assert lk["dropped"] == {"ds-b": ["NK"]}, lk["dropped"]
    # Every code now maps: no `None` survives to become an out-of-range sentinel on disk.
    assert all(c is not None for lookup in lk["lookups"] for c in lookup.values())


def test_a_run_that_drops_NOTHING_invents_no_missing_level():
    """The counterpart, and it is what keeps the change from being a tax on every run.

    `write_metadata_column` invents a missing level ONLY when pandas wrote a `-1`; this
    mirrors it. A `strict` union drops nothing, so its vocabulary must be byte-identical to
    what it was before the mechanism existed — otherwise every artifact grows a phantom
    level and every `vocab_digest` shifts.
    """
    v = build_vectors(level_sources(), "symbol", level_columns=["celltype"])
    lk = v["level_lookups"]["celltype"]
    assert lk["missing_level"] is None, lk["missing_level"]
    assert "NA" not in lk["levels"], lk["levels"]
    assert lk["dropped"] == {}, lk["dropped"]


def test_a_level_column_a_source_lacks_is_refused_by_name():
    a = SourceTable("ds-a", {"symbol": ["A"]}, row_keys=["a0"], row_columns={"celltype": ["T"]})
    b = SourceTable("ds-b", {"symbol": ["A"]}, row_keys=["b0"])
    with pytest.raises(AlignmentError, match="level column 'celltype' is not carried"):
        build_vectors([a, b], "symbol", level_columns=["celltype"])


# ── TEST-23 (ITEM-9): the per-source key-sequence digests ────────────────────────


def test_one_digest_per_source_equal_to_cyto_zarrs_own_recomputation():
    """The digest is the framework's, recomputed here from the same key sequence — not a
    second implementation that could drift from what the gate checks."""
    import cyto_zarr

    sources = two_sources()
    digests = source_key_digests(sources)
    assert len(digests) == len(sources)
    for source, digest in zip(sources, digests):
        assert digest == cyto_zarr.key_sequence_digest(source.row_keys)


def test_REORDERING_the_keys_CHANGES_the_digest():
    """The entire property. Two arrays holding the same keys in a different order describe
    DIFFERENT alignments — row 3 means a different cell in each — so a digest that could not
    tell them apart would certify exactly the failure it exists to catch."""
    keys = ["c0", "c1", "c2"]
    forward = SourceTable("ds", {"symbol": ["A"]}, row_keys=keys)
    backward = SourceTable("ds", {"symbol": ["A"]}, row_keys=list(reversed(keys)))
    assert source_key_digests([forward])[0] != source_key_digests([backward])[0]


def test_an_ORDER_INDEPENDENT_set_hash_would_NOT_catch_a_reorder():
    """TEST-23's declared negative control, RUN against the real alternative.

    `cyto_zarr` ships BOTH — `key_sequence_digest` (ordered) and `vocab_declaration`'s
    `vocab_digest` (an order-independent set hash) — so choosing the wrong one is a real and
    easy mistake rather than a hypothetical. This demonstrates the set hash is blind to the
    reorder that the ordered digest catches.
    """
    import cyto_zarr

    keys = ["c0", "c1", "c2"]
    set_hash_forward = cyto_zarr.vocab_declaration(keys)["vocab_digest"]
    set_hash_backward = cyto_zarr.vocab_declaration(list(reversed(keys)))["vocab_digest"]
    assert set_hash_forward == set_hash_backward, (
        "the set hash is supposed to be order-independent; if it is not, this control "
        "proves nothing about the ordered digest"
    )
    ordered_forward = cyto_zarr.key_sequence_digest(keys)
    ordered_backward = cyto_zarr.key_sequence_digest(list(reversed(keys)))
    assert ordered_forward != ordered_backward, (
        "the ORDERED digest failed to notice a reorder — this is the silent-wrong-rows "
        "defect ITEM-9 exists to prevent"
    )


def test_a_source_with_no_row_keys_digests_to_None_meaning_CANNOT_BE_CHECKED():
    """INV-5: `None` means "cannot be checked" and must never read as "matches". Asserted
    as an identity against `None` rather than falsiness, because an empty string is also
    falsy and would be a digest that compares equal to another empty one."""
    unknown = SourceTable("ds-x", {"symbol": ["A"]})
    digests = source_key_digests([unknown])
    assert digests[0] is None, digests
    assert digests[0] != "", "an empty digest would COMPARE EQUAL to another empty one"


def test_the_digests_ride_on_the_built_vectors():
    v = build_vectors(two_sources(), "symbol")
    assert len(v["source_digests"]) == 2
    assert all(isinstance(d, str) and len(d) == 64 for d in v["source_digests"]), v["source_digests"]


def test_two_sources_with_the_SAME_row_keys_digest_the_same():
    """The positive control for the digest's discrimination: it must distinguish sequences
    that differ, and NOT distinguish ones that do not."""
    a = SourceTable("ds-a", {"symbol": ["A"]}, row_keys=["c0", "c1"])
    b = SourceTable("ds-b", {"symbol": ["A"]}, row_keys=["c0", "c1"])
    d = source_key_digests([a, b])
    assert d[0] == d[1]


# ── An EMPTY declared level set must not silently NA a whole source ──────────────


def test_an_EMPTY_declared_level_set_over_a_populated_column_is_REFUSED():
    """The producer-side member of the silent-wrong-answer family.

    A source whose declared level set is EMPTY while its row column carries real values is a
    declaration contradicting its own data. Left unrefused it produced the worst possible
    combination: `lookups[i] == {}`, so EVERY row of that source became `NA` — and
    `dropped == {}`, so the coverage sidecar reported that nothing was dropped. A column that
    is entirely NA while the evidence says nothing was dropped is a silent wrong answer with
    a clean report, and `levels: []` conforms, so nothing downstream objected either.

    The refusal names the source and the column, because "some categorical had no levels" is
    not actionable across N datasets.
    """
    a = SourceTable(
        "ds-a", {"symbol": ["X"]}, row_keys=["a0", "a1"],
        row_columns={"celltype": ["T", "B"]},
        declared_levels={"celltype": []},
    )
    b = SourceTable(
        "ds-b", {"symbol": ["X"]}, row_keys=["b0", "b1"],
        row_columns={"celltype": ["B", "NK"]},
        declared_levels={"celltype": ["B", "NK"]},
    )
    with pytest.raises(AlignmentError, match="ds-a.*celltype|celltype.*ds-a"):
        build_vectors([a, b], "symbol", level_columns=["celltype"])


def test_a_GENUINELY_empty_column_still_declares_an_empty_level_set():
    """The negative control for the refusal: a column whose values are all ABSENT has no
    levels to declare, and an all-NA result is the CORRECT answer there rather than a
    contradiction. Refusing it would reject a legitimate source."""
    a = SourceTable(
        "ds-a", {"symbol": ["X"]}, row_keys=["a0", "a1"],
        row_columns={"celltype": [None, None]},
        declared_levels={"celltype": []},
    )
    b = SourceTable(
        "ds-b", {"symbol": ["X"]}, row_keys=["b0"],
        row_columns={"celltype": ["B"]},
        declared_levels={"celltype": ["B"]},
    )
    v = build_vectors([a, b], "symbol", level_columns=["celltype"])
    lk = v["level_lookups"]["celltype"]
    assert lk["levels"] == ["B"], lk
    assert alignment.apply_level_lookup([None, None], lk["lookups"][0]) == [None, None]


def test_an_ABSENT_declaration_is_NOT_the_same_as_an_EMPTY_one():
    """`level_set_for` documents a fallback to observation order when no declaration was
    supplied. That branch must be REACHABLE — the producer collapsed both states to `[]`,
    which made "not declared" indistinguishable from "declared empty" and turned the
    documented fallback into dead code."""
    supplied = SourceTable(
        "ds-a", {"symbol": ["X"]}, row_keys=["a0", "a1"],
        row_columns={"celltype": ["T", "B"]},
    )
    assert supplied.level_set_for("celltype") == ["T", "B"], (
        "with NO declaration the fallback must return observation order"
    )
    declared = SourceTable(
        "ds-a", {"symbol": ["X"]}, row_keys=["a0", "a1"],
        row_columns={"celltype": ["T", "B"]},
        declared_levels={"celltype": ["B", "T"]},
    )
    assert declared.level_set_for("celltype") == ["B", "T"], (
        "with a declaration the DECLARED order wins — the two states differ"
    )


def test_a_declared_level_set_containing_an_ABSENT_level_keeps_its_CODE_POSITIONS():
    """A regression introduced by the fix for the observation-order bug, and worse than it.

    The stored codes are positions into the FULL declared list. Filtering `""` out of that
    list — which the first fix did, correctly for the observation-order FALLBACK but not for
    a declaration — SHORTENS it and shifts every later position, so stored code 2 resolved
    to the entry for code 1 and the highest code indexed past the end. Every fused value of
    that source was silently relabelled, `dropped` stayed empty, and the recorded ITEM-14
    evidence carried the shortened list, so the evidence agreed with the corruption.

    `""` is a LEGAL level: `Table.categorical` stringifies its levels, so a producer can
    declare one. It must therefore keep its POSITION and resolve to absence, rather than be
    removed from the code space.
    """
    a = SourceTable(
        "ds-a", {"symbol": ["X"]}, row_keys=["r0", "r1", "r2"],
        row_columns={"celltype": ["", "T", "B"]},
        declared_levels={"celltype": ["", "T", "B"]},
    )
    b = SourceTable(
        "ds-b", {"symbol": ["X"]}, row_keys=["s0"],
        row_columns={"celltype": ["T"]}, declared_levels={"celltype": ["T"]},
    )
    assert a.level_set_for("celltype") == ["", "T", "B"], (
        "the declared code space must keep every position, including an absent level"
    )

    v = build_vectors([a, b], "symbol", level_columns=["celltype"])
    lk = v["level_lookups"]["celltype"]
    assert "" not in lk["levels"], (
        f"absence must not become a unified LEVEL; got {lk['levels']}"
    )
    lookup = lk["lookups"][0]
    # Stored code 1 is 'T' and code 2 is 'B' — both must resolve to their own level.
    assert lk["levels"][lookup[1]] == "T", (lookup, lk["levels"])
    assert lk["levels"][lookup[2]] == "B", (lookup, lk["levels"])
    # …and the absent level's own code resolves to ABSENCE — which since C4 is a real,
    # DECLARED level rather than a `None` that becomes an out-of-range `-1` on disk.
    #
    # `""` still never becomes a unified level (asserted above): admitting the empty string
    # would make absence read as an ordinary value. The declared `NA` is the opposite — it
    # is absence wearing a LABEL, which is what lets it have an in-range code the read side
    # can serve.
    assert lk["missing_level"] == "NA", lk["missing_level"]
    assert lookup[0] == lk["levels"].index("NA"), lookup
    assert lk["levels"][lookup[0]] == "NA", (lookup, lk["levels"])
    # It is ABSENCE, not a dropped level — `strict` drops nothing, and the coverage record
    # must not gain a phantom just because a missing level now exists.
    assert lk["dropped"] == {}, lk["dropped"]


def test_a_declared_set_whose_levels_COLLIDE_under_canonicalisation_keeps_its_positions():
    """The same shift by a different route: two declared levels that canonicalise to one
    value would collapse under a dedupe and shift every later code."""
    a = SourceTable(
        "ds-a", {"symbol": ["X"]}, row_keys=["r0", "r1", "r2"],
        row_columns={"celltype": ["A", "A", "Z"]},
        declared_levels={"celltype": ["A", "A", "Z"]},
    )
    b = SourceTable(
        "ds-b", {"symbol": ["X"]}, row_keys=["s0"],
        row_columns={"celltype": ["Z"]}, declared_levels={"celltype": ["Z"]},
    )
    assert a.level_set_for("celltype") == ["A", "A", "Z"], a.level_set_for("celltype")
    lk = build_vectors([a, b], "symbol", level_columns=["celltype"])["level_lookups"]["celltype"]
    assert lk["levels"][lk["lookups"][0][2]] == "Z", (lk["lookups"][0], lk["levels"])
