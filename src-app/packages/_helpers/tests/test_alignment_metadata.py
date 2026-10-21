#!/usr/bin/env python3
# ruff: noqa
"""TEST-24/25/27/28/29 — the evidence record (ITEM-10, 11, 13, 14, 15).

The vectors say WHAT was included. This file is about what makes that interpretable
afterwards: the mode, the measured counts, the per-entity evidence, the per-source declared
orders, and the coverage record's single home.

## The one thread through all five

**Record what was observed; do not assert what was not.** The mode distinguishes an ASSERTED
identity from an OBSERVED one. The counts are kept as MEASURED because recomputing them
after resolution reports zero conflicts for every `strict` alignment. The per-entity flag
exists so nobody reads an `authority`-chosen `ensembl_id` as true for both datasets. The
per-source orders are kept precisely because the unified order is asserted by no one. And
the coverage figure has exactly one home, because two spellings of one fact means one of
them goes stale unwatched.
"""
from __future__ import annotations

import pytest

import alignment
from alignment import (
    AUTHORITY,
    STRICT,
    AlignmentError,
    SourceTable,
    alignment_metadata,
    build_vectors,
    coverage_sidecar,
    definition_content_hash,
    join_quality,
)


# ── fixtures ─────────────────────────────────────────────────────────────────────


def conflicting_sources():
    """`C` is one symbol carrying two different ensembl ids — the conflicting entity."""
    a = SourceTable(
        "ds-a",
        {"symbol": ["A", "B", "C"], "ensembl_id": ["E1", "E2", "E3"]},
        row_keys=["a0", "a1"],
        row_columns={"celltype": ["T", "B"]},
    )
    b = SourceTable(
        "ds-b",
        {"symbol": ["A", "B", "C"], "ensembl_id": ["E1", "E2", "E7"]},
        row_keys=["b0", "b1", "b2"],
        row_columns={"celltype": ["B", "NK", "T"]},
    )
    return [a, b]


def built(mode=None, authority=None, level_columns=("celltype",), sources=None):
    sources = list(sources or conflicting_sources())
    report = join_quality(sources, keys=["symbol"])
    vectors = build_vectors(
        sources, "symbol", mode=mode, authority=authority,
        level_columns=list(level_columns),
    )
    meta = alignment_metadata(
        sources, "symbol", vectors, join_quality_report=report,
        source_orders={"celltype": {"ds-a": ["T", "B"], "ds-b": ["B", "NK", "T"]}},
    )
    return sources, vectors, meta


def evidence_for(meta, entity):
    return next(e for e in meta["entity_evidence"] if e["entity"] == entity)


# ── TEST-24 (ITEM-10): the mode, the key, and the counts AS MEASURED ─────────────


def test_the_mode_and_the_join_key_are_recorded():
    _s, _v, meta = built()
    assert meta["mode"] == STRICT
    assert meta["join_key"] == "symbol"
    assert meta["authority"] is None, (
        "`strict` asserts nothing, so it names no authority — a dataset id here would read "
        "as a claim that was never made"
    )


def test_authority_records_WHICH_dataset():
    _s, _v, meta = built(mode=AUTHORITY, authority="ds-b")
    assert meta["mode"] == AUTHORITY
    assert meta["authority"] == "ds-b"


def test_the_counts_are_the_ones_MEASURED_not_recomputed_after_resolution():
    """TEST-24's substance, and its declared negative control in one place.

    Under `strict` the conflicting entity is DROPPED, so a metadata record that recomputed
    its counts from the resolved state would report `conflicting: 0` — the conflicts are no
    longer there to count. The measured record must still say 1.
    """
    _s, vectors, meta = built(mode=STRICT)
    assert meta["join_quality"]["conflicting"] == 1, meta["join_quality"]
    assert "C" not in vectors["entities"], "the fixture must actually drop it"
    # The recomputation this guards against, performed here so the contrast is real rather
    # than described: over the RESOLVED entity set there is no disagreement left to find.
    recomputed = join_quality(
        [
            SourceTable(
                s.dataset_id,
                {k: [v for i, v in enumerate(col) if s.columns["symbol"][i] in vectors["entities"]]
                 for k, col in s.columns.items()},
                row_keys=s.row_keys,
            )
            for s in conflicting_sources()
        ],
        keys=["symbol"],
    )["candidates"][0]
    assert recomputed["conflicting"] == 0, recomputed
    assert meta["join_quality"]["conflicting"] != recomputed["conflicting"], (
        "the measured and recomputed counts agree, so this test cannot tell them apart"
    )


def test_a_report_that_does_not_cover_the_chosen_key_is_REFUSED():
    """The counts must be the ones measured FOR THIS KEY. A mismatched report would record
    a different key's numbers under this key's name."""
    sources = conflicting_sources()
    vectors = build_vectors(sources, "symbol")
    wrong = join_quality(sources, keys=["ensembl_id"])
    with pytest.raises(AlignmentError, match="does not cover the chosen key"):
        alignment_metadata(sources, "symbol", vectors, join_quality_report=wrong)


def test_each_source_is_recorded_with_its_digest():
    sources, vectors, meta = built()
    assert [s["dataset_id"] for s in meta["sources"]] == ["ds-a", "ds-b"]
    assert [s["key_sequence_digest"] for s in meta["sources"]] == vectors["source_digests"]
    assert [s["n_rows"] for s in meta["sources"]] == [2, 3]


# ── TEST-25 (ITEM-11): the per-entity evidence ───────────────────────────────────


def test_every_entity_carries_its_sources_and_which_key_matched():
    _s, vectors, meta = built()
    assert [e["entity"] for e in meta["entity_evidence"]] == vectors["entities"]
    for e in meta["entity_evidence"]:
        assert e["source_indices"] == [0, 1], e
        assert e["matched_on"] == "symbol", e


def test_an_authority_entity_with_DISAGREEING_secondaries_is_FLAGGED():
    """TEST-25's substance: what stops a later reader taking the unified `ensembl_id` as
    true for BOTH datasets' rows — which authority mode does not assert."""
    _s, _v, meta = built(mode=AUTHORITY, authority="ds-b")
    c = evidence_for(meta, "C")
    assert c["secondaries_agreed"] is False, c
    assert c["disagreeing_columns"] == ["ensembl_id"], c
    # …and the entities that DO agree are not flagged, or the flag means nothing.
    assert evidence_for(meta, "A")["secondaries_agreed"] is True
    assert evidence_for(meta, "A")["disagreeing_columns"] == []


def test_recording_only_the_source_indices_would_lose_the_disagreement():
    """TEST-25's declared negative control, expressed as a property of the record: the
    disagreement is carried by a field that the source list cannot encode. If the two
    flagged/unflagged entities had identical records, the flag would be decorative."""
    _s, _v, meta = built(mode=AUTHORITY, authority="ds-b")
    agreeing, disagreeing = evidence_for(meta, "A"), evidence_for(meta, "C")
    assert agreeing["source_indices"] == disagreeing["source_indices"], (
        "the fixture's two entities differ in their source lists, so the flag is not the "
        "only thing distinguishing them and this control is weaker than it looks"
    )
    # Compare the records with the ENTITY NAME REMOVED. Comparing whole dicts was vacuous:
    # they always differ in `entity`, so `agreeing != disagreeing` held no matter what the
    # flag contained — the named control provided zero signal. What must differ is the
    # EVIDENCE, so the identity key is dropped before comparing.
    def evidence_only(record):
        return {k: v for k, v in record.items() if k != "entity"}

    assert evidence_only(agreeing) != evidence_only(disagreeing), (
        "the two entities carry identical evidence once their names are removed, so "
        "nothing records that one of them disagreed"
    )
    assert evidence_only(agreeing)["secondaries_agreed"] is True
    assert evidence_only(disagreeing)["secondaries_agreed"] is False


def test_under_strict_the_conflicting_entity_is_absent_rather_than_flagged():
    """The mode changes what there IS to record: `strict` drops it, so there is no entity
    to carry a flag, and the count in `join_quality` is where the fact survives."""
    _s, vectors, meta = built(mode=STRICT)
    assert "C" not in [e["entity"] for e in meta["entity_evidence"]]
    assert all(e["secondaries_agreed"] for e in meta["entity_evidence"])
    assert meta["join_quality"]["conflicting"] == 1


# ── TEST-28 (ITEM-14): the per-source declared orders ────────────────────────────


def test_both_sources_declared_orders_are_recorded_on_the_alignment():
    """INV-15: the fused column claims no order, and each source's declared order is kept
    as EVIDENCE so a future ordinal analysis finds it rather than losing it."""
    _s, _v, meta = built()
    assert meta["source_declared_orders"] == {
        "celltype": {"ds-a": ["T", "B"], "ds-b": ["B", "NK", "T"]}
    }


def test_the_fused_column_claims_NO_order_while_the_evidence_survives():
    """The distinction that keeps it honest: not claiming an order is NOT the same as
    silently dropping the flag while implying one.

    Asserted as two independent facts — the unified level set carries no order field, AND
    the per-source orders are present — so dropping the evidence goes red on its own while
    the union stays green, which is the whole reason they are separate assertions.
    """
    _s, vectors, meta = built()
    lookup = vectors["level_lookups"]["celltype"]
    assert "ordered" not in lookup, lookup
    assert "declared_order" not in lookup, lookup
    assert lookup["levels"] == ["T", "B", "NK"], lookup["levels"]
    assert meta["source_declared_orders"]["celltype"]["ds-b"] == ["B", "NK", "T"], (
        "ds-b's own order differs from the unified sequence — which is exactly why the "
        "unified one may not be read as an order"
    )


def test_an_ordered_pair_unions_by_the_SAME_path_with_no_extra_record():
    """There is no `ordered` branch to take, so an ordered fixture produces the same shape
    as an unordered one. Asserted by comparing the two outputs rather than by inspecting
    source text."""
    # An ORDERED-looking source (levels declared in a deliberate, non-alphabetical sequence)
    # against an unordered one. Calling `build_vectors` twice with identical arguments was a
    # determinism tautology for a pure function — it performed no ordered/unordered contrast
    # at all, which is the comparison the test is named for.
    ordered_like = [
        SourceTable(
            "ds-a", {"symbol": ["A", "B", "C"], "ensembl_id": ["E1", "E2", "E3"]},
            row_keys=["a0", "a1", "a2"],
            row_columns={"celltype": ["high", "low", "mid"]},
            declared_levels={"celltype": ["low", "mid", "high"]},
        ),
        SourceTable(
            "ds-b", {"symbol": ["A", "B", "C"], "ensembl_id": ["E1", "E2", "E3"]},
            row_keys=["b0"], row_columns={"celltype": ["mid"]},
            declared_levels={"celltype": ["mid"]},
        ),
    ]
    a = build_vectors(ordered_like, "symbol", level_columns=["celltype"])["level_lookups"]["celltype"]
    b = build_vectors(conflicting_sources(), "symbol", level_columns=["celltype"])["level_lookups"]["celltype"]
    # Same SHAPE — same keys, same absence of any order claim — for both.
    assert set(a) == set(b), (sorted(a), sorted(b))
    assert "ordered" not in a and "declared_order" not in a, a
    # …and the ordered-looking source's declared sequence is NOT imposed on the union.
    assert a["levels"] == ["low", "mid", "high"], a["levels"]
    # `missing_level` joined the record with C4 — it is the DECLARED absence label, and it
    # is emitted for every mode (None when nothing was dropped). It is not an `ordered`
    # special case, which is what this assertion actually guards.
    assert set(a) == {"mode", "authority", "levels", "lookups", "dropped", "source_levels",
                      "missing_level"}, (
        f"the level record grew a key — if it is an `ordered` special case, INV-15 is "
        f"broken; got {sorted(a)}"
    )


# ── TEST-29 (ITEM-15): the coverage record's SINGLE home ─────────────────────────


def test_the_coverage_record_lives_on_the_SIDECAR():
    sources, vectors, meta = built(mode=AUTHORITY, authority="ds-a")
    side = coverage_sidecar(sources, vectors, meta)
    assert side["kind"] == "alignment_summary"
    assert side["n_sources"] == 2
    assert side["n_rows"] == vectors["n_rows"]
    assert side["n_entities"] == len(vectors["entities"])
    # `authority` = ds-a, whose celltype vocabulary is [T, B]; ds-b's NK is dropped.
    assert side["dropped_levels"] == {"celltype": {"ds-b": ["NK"]}}, side["dropped_levels"]


def test_the_coverage_figure_does_NOT_also_appear_on_the_vectors_or_the_column_meta():
    """TEST-29's substance: EXACTLY ONE spelling. Two copies of one fact is the outcome the
    design forbids, and the one that goes stale is the one nobody is watching."""
    sources, vectors, meta = built(mode=AUTHORITY, authority="ds-a")
    side = coverage_sidecar(sources, vectors, meta)
    assert side["dropped_levels"], "the fixture must actually drop something"

    for key in ("coverage", "dropped_levels", "n_entities"):
        assert key not in vectors, f"{key!r} is on the vectors as well as the sidecar"
    for column, lookup in vectors["level_lookups"].items():
        assert "coverage" not in lookup, column
    assert "coverage" not in meta, meta.keys()


def test_the_sidecar_and_the_metadata_share_ONE_join_quality_object():
    """Not two copies that can drift — the same object, so they cannot disagree."""
    sources, vectors, meta = built()
    side = coverage_sidecar(sources, vectors, meta)
    assert side["join_quality"] is meta["join_quality"]


def test_the_sidecar_names_the_entities_STRICT_dropped_and_is_EMPTY_under_authority():
    """The two modes, asserted TOGETHER — because this test previously certified the bug.

    It ran in AUTHORITY mode under a name saying "strict dropped", and asserted ['C'] — the
    entity authority KEEPS. The field was derived from `entity_evidence`, which covers only
    the entities that SURVIVED, so it was empty in exactly the mode that drops and populated
    in the mode that does not. A green test asserting the inverse of its own name is how
    that reached the branch.

    Both directions are now pinned in one place, so neither can be satisfied alone.
    """
    sources, vectors, meta = built(mode=STRICT)
    side = coverage_sidecar(sources, vectors, meta)
    assert "C" not in vectors["entities"], "the fixture must actually drop C under strict"
    assert side["entities_dropped_conflicting"] == ["C"], side

    sources, vectors, meta = built(mode=AUTHORITY, authority="ds-b")
    side = coverage_sidecar(sources, vectors, meta)
    assert vectors["entities"] == ["A", "B", "C"], "authority drops nothing"
    assert side["entities_dropped_conflicting"] == [], (
        f"authority dropped nothing, so the dropped list must be empty; got {side}"
    )
    # …and the kept-but-disagreeing entities are recorded SEPARATELY, since that is a
    # different question from what was excluded.
    assert side["entities_kept_with_disagreeing_secondaries"] == ["C"], side


# ── TEST-27 (ITEM-13): real bytes vs an abstract DEFINITION ──────────────────────


def test_a_fused_columns_hash_is_STABLE_across_identical_re_emission():
    """The property that makes an `immutable` cache header on a fused column TRUE.

    Hashing gathered bytes instead would mint a new hash for every identical re-emission
    and quietly invalidate every cached read.
    """
    first = definition_content_hash("align-1", ["ds-a", "ds-b"], "celltype")
    second = definition_content_hash("align-1", ["ds-a", "ds-b"], "celltype")
    assert first == second


def test_the_definition_hash_changes_when_ANY_part_of_the_definition_does():
    base = definition_content_hash("align-1", ["ds-a", "ds-b"], "celltype")
    assert definition_content_hash("align-2", ["ds-a", "ds-b"], "celltype") != base
    assert definition_content_hash("align-1", ["ds-a", "ds-c"], "celltype") != base
    assert definition_content_hash("align-1", ["ds-a", "ds-b"], "total_counts") != base


def test_source_order_does_not_change_the_definition_hash():
    """The same definition supplied with its sources listed differently IS the same
    definition. Segment ORDER is carried by the alignment's `declared_order` (ITEM-6), not
    by this list, so sorting here cannot lose it."""
    assert definition_content_hash("align-1", ["ds-a", "ds-b"], "celltype") == \
        definition_content_hash("align-1", ["ds-b", "ds-a"], "celltype")


def test_the_hash_is_length_prefixed_so_parts_cannot_be_re_split():
    """`("align", "1x")` and `("align1", "x")` must not collide — the same defence
    `key_sequence_digest` applies, for the same reason."""
    assert definition_content_hash("align", ["ds"], "1x") != \
        definition_content_hash("align1", ["ds"], "x")


def test_a_definition_missing_its_alignment_or_selector_is_REFUSED():
    for bad in (("", ["ds-a"], "celltype"), ("align-1", ["ds-a"], "")):
        with pytest.raises(AlignmentError, match="needs both an alignment id"):
            definition_content_hash(*bad)
