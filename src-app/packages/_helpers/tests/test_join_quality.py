#!/usr/bin/env python3
# ruff: noqa
"""TEST-16 / TEST-17 — join quality (ITEM-1) and the duplicate-key refusal (ITEM-2).

## Why the fixture is hand-computed

Every count below is asserted against a number worked out by hand from a fixture small
enough to read, not against whatever the implementation returns. A test that asserts
`result == implementation(fixture)` is a change detector; these assert the arithmetic.

The larger fixture reproduces the design's own example row-for-row —

```
ensembl_id   17,900 matched   0 conflicting      0 duplicated
symbol       18,204 matched   1,204 conflicting  12 duplicated
```

— at 1/100th scale, because the SHAPE of that table (a key that matches more but conflicts,
next to one that matches less and does not) is the thing the measurement exists to show a
user, and a fixture that cannot exhibit it cannot fail when it stops being shown.
"""
from __future__ import annotations

import pytest

import align
import alignment
from alignment import AlignmentError, SourceTable, join_quality, refuse_duplicate_keys


# ── fixtures ─────────────────────────────────────────────────────────────────────


def two_clean_sources():
    """Four genes, three shared, one private to each source. No conflicts, no duplicates.

    Shared: A, B, C. `a_only` / `b_only` are in one source each — those are the genes INV-2
    drops, and they are here so a union can be told from an intersection.
    """
    a = SourceTable("ds-a", {
        "ensembl_id": ["ENSG1", "ENSG2", "ENSG3", "ENSG9"],
        "symbol": ["A", "B", "C", "A_ONLY"],
    })
    b = SourceTable("ds-b", {
        "ensembl_id": ["ENSG1", "ENSG2", "ENSG3", "ENSG8"],
        "symbol": ["A", "B", "C", "B_ONLY"],
    })
    return [a, b]


def sources_with_a_conflict():
    """Three shared symbols; ONE of them (`C`) carries a different ensembl id per source.

    So joining on `symbol`: 3 shared − 1 conflicting = 2 matched, 1 conflicting.
    And joining on `ensembl_id`: `ENSG3`/`ENSG7` are not shared, so 2 shared, and their
    symbols agree → 2 matched, 0 conflicting.
    """
    a = SourceTable("ds-a", {
        "ensembl_id": ["ENSG1", "ENSG2", "ENSG3"],
        "symbol": ["A", "B", "C"],
    })
    b = SourceTable("ds-b", {
        "ensembl_id": ["ENSG1", "ENSG2", "ENSG7"],
        "symbol": ["A", "B", "C"],
    })
    return [a, b]


def sources_with_a_duplicate():
    """`ds-b` carries the symbol `B` twice — a many-to-one join waiting to happen."""
    a = SourceTable("ds-a", {
        "ensembl_id": ["ENSG1", "ENSG2", "ENSG3"],
        "symbol": ["A", "B", "C"],
    })
    b = SourceTable("ds-b", {
        "ensembl_id": ["ENSG1", "ENSG2", "ENSG20", "ENSG3"],
        "symbol": ["A", "B", "B", "C"],
    })
    return [a, b]


def by_key(report):
    return {c["key"]: c for c in report["candidates"]}


# ── TEST-16: the counts ──────────────────────────────────────────────────────────


def test_a_clean_join_matches_the_intersection_and_nothing_else():
    report = join_quality(two_clean_sources())
    rows = by_key(report)
    assert set(rows) == {"ensembl_id", "symbol"}, rows
    for key in ("ensembl_id", "symbol"):
        assert rows[key]["matched"] == 3, (key, rows[key])
        assert rows[key]["conflicting"] == 0, (key, rows[key])
        assert rows[key]["duplicated"] == 0, (key, rows[key])
    assert report["sources"] == ["ds-a", "ds-b"]


def test_a_gene_present_in_only_ONE_source_is_not_matched():
    """The measurement's half of INV-2. `a_only`/`b_only` exist; neither is counted.

    Asserted here rather than only at the vector, because a measurement that told the user
    "4 matched" would make them choose a key on the strength of an intersection that does
    not exist.
    """
    rows = by_key(join_quality(two_clean_sources()))
    assert rows["symbol"]["matched"] == 3
    assert rows["symbol"]["present_per_source"] == {"ds-a": 4, "ds-b": 4}, (
        "each source really does carry 4 — so 3 matched is an INTERSECTION and not a "
        "miscount of the inputs"
    )


def test_a_conflicting_pair_is_counted_as_conflicting_and_NOT_as_matched():
    """TEST-16's substance: the two counts are disjoint.

    NEGATIVE CONTROL for this is `test_counting_conflicts_as_matched_would_hide_them`
    below, which performs the miscount and shows the number it produces.
    """
    rows = by_key(join_quality(sources_with_a_conflict()))
    assert rows["symbol"]["matched"] == 2, rows["symbol"]
    assert rows["symbol"]["conflicting"] == 1, rows["symbol"]
    assert rows["symbol"]["conflicting_columns"] == {"ensembl_id": 1}, rows["symbol"]
    # …and the other candidate is clean, which is the comparison the user is making.
    assert rows["ensembl_id"]["matched"] == 2, rows["ensembl_id"]
    assert rows["ensembl_id"]["conflicting"] == 0, rows["ensembl_id"]


def test_counting_conflicts_as_matched_would_hide_them():
    """The negative control, RUN rather than described.

    `matched + conflicting` is what a "count conflicts as matched" implementation would
    report. Showing that it equals the whole intersection — the same number for the
    conflicted key as for a clean one — is what makes the disjointness assertion above
    falsifiable rather than decorative.
    """
    rows = by_key(join_quality(sources_with_a_conflict()))
    miscount = rows["symbol"]["matched"] + rows["symbol"]["conflicting"]
    assert miscount == 3, miscount
    assert miscount != rows["symbol"]["matched"], (
        "the fixture has no conflict at all — then this control proves nothing and the "
        "assertion above is vacuous"
    )


def test_a_within_source_duplicate_is_counted_and_kept_out_of_matched():
    """`ds-b` has `B` twice. `B` is neither matched nor conflicting — it is duplicated."""
    rows = by_key(join_quality(sources_with_a_duplicate()))
    assert rows["symbol"]["duplicated"] == 1, rows["symbol"]
    assert rows["symbol"]["duplicated_per_source"] == {"ds-b": 1}, rows["symbol"]
    assert rows["symbol"]["matched"] == 2, (
        "A and C match; B is duplicated and must not be counted as a match, because "
        f"there is no single row for it to match. Got {rows['symbol']}"
    )
    # The clean candidate is unaffected — that side-by-side comparison IS the feature.
    assert rows["ensembl_id"]["duplicated"] == 0
    assert rows["ensembl_id"]["matched"] == 3


def test_the_design_example_shape_reproduces_at_scale():
    """The row the design prints: one key matches MORE but conflicts, one matches less and
    is clean. Scaled down, but the ordering relations are the ones a user reads."""
    n = 182
    a = SourceTable("ds-a", {
        "symbol": [f"SYM{i}" for i in range(n)],
        "ensembl_id": [f"ENSG{i}" for i in range(n)],
    })
    # `ds-b` shares every symbol. Three bands, and each one is a distinct real situation:
    #   0..159   the same ensembl id           → agree on both keys
    #   160..171 a DIFFERENT ensembl id (12)   → the symbol matches, the annotation conflicts
    #   172..181 NO ensembl id at all (10)     → the symbol matches, ensembl cannot join
    # plus 2 rows repeating an earlier symbol under a new id → a symbol-only duplicate.
    b_symbols = [f"SYM{i}" for i in range(n)] + ["SYM0", "SYM1"]
    b_ensembl = (
        [f"ENSG{i}" for i in range(160)]
        + [f"ENSGX{i}" for i in range(160, 172)]
        + [None] * 10
        + ["ENSGD0", "ENSGD1"]
    )
    b = SourceTable("ds-b", {"symbol": b_symbols, "ensembl_id": b_ensembl})

    rows = by_key(join_quality([a, b]))
    # symbol: 182 shared − 2 duplicated = 180 in play; 12 of them conflict on ensembl_id.
    assert rows["symbol"]["duplicated"] == 2, rows["symbol"]
    assert rows["symbol"]["conflicting"] == 12, rows["symbol"]
    assert rows["symbol"]["matched"] == 168, rows["symbol"]
    # ensembl_id: only the first 160 are shared at all — the 12 renamed and the 10 absent
    # simply do not join, which is why the looser key reaches more of the genome.
    assert rows["ensembl_id"]["matched"] == 160, rows["ensembl_id"]
    assert rows["ensembl_id"]["conflicting"] == 0, rows["ensembl_id"]
    assert rows["ensembl_id"]["duplicated"] == 0, rows["ensembl_id"]
    assert rows["symbol"]["matched"] > rows["ensembl_id"]["matched"], (
        "the whole point of the table is that a looser key matches MORE while conflicting; "
        f"got symbol={rows['symbol']} ensembl_id={rows['ensembl_id']}"
    )
    # …and the fixture's 10 blanks make `ensembl_id` unjoinable, which is a fact the three
    # columns of the design's example cannot express. See `test_two_MISSING_keys_…` below.
    assert rows["ensembl_id"]["missing"] == 10, rows["ensembl_id"]
    assert rows["ensembl_id"]["joinable"] is False, rows["ensembl_id"]
    assert rows["symbol"]["joinable"] is False, "…and symbol is unjoinable for the OTHER reason"


def test_the_measurement_reads_ONLY_the_key_columns_it_was_given():
    """INV-11 as an executable claim: the engine takes plain lists and can reach nothing
    else. A source built from lists has no handle to an artifact, a chunk or a socket, so a
    body read is not merely unperformed — it is unreachable from here."""
    sources = two_clean_sources()
    report = join_quality(sources, keys=["ensembl_id"])
    assert [c["key"] for c in report["candidates"]] == ["ensembl_id"]
    # NOT `isinstance(v, list)`: `SourceTable.__init__` coerces every column with `list(v)`,
    # so that assertion is unconditionally true for any input the constructor accepts and
    # cannot fail. The INV-11 claim is about REACHABILITY — a source carries plain values and
    # no handle to an artifact, a chunk or a socket — so that is what is asserted.
    for source in sources:
        assert not hasattr(source, "artifact_id"), source
        for values in source.columns.values():
            assert all(
                v is None or isinstance(v, (str, int, float, bool)) for v in values
            ), "a column holds a non-scalar, i.e. something that could reference a body"


def test_a_key_a_source_lacks_is_reported_rather_than_silently_dropped():
    a = SourceTable("ds-a", {"symbol": ["A"], "gene_id": ["g1"]})
    b = SourceTable("ds-b", {"symbol": ["A"]})
    rows = by_key(join_quality([a, b], keys=["symbol", "gene_id"]))
    assert rows["gene_id"]["unavailable_in"] == ["ds-b"], rows["gene_id"]
    assert rows["gene_id"]["matched"] == 0


def test_default_candidates_are_the_columns_every_source_shares():
    a = SourceTable("ds-a", {"symbol": ["A"], "gene_id": ["g1"]})
    b = SourceTable("ds-b", {"symbol": ["A"], "other": ["x"]})
    assert alignment.candidate_keys([a, b]) == ["symbol"]


def test_normalisation_is_the_SAME_canonicalisation_the_refusal_uses():
    """A count computed with a different notion of key equality than the refusal uses is
    how a report reads `0 duplicated` for a key that then hard-fails."""
    a = SourceTable("ds-a", {"barcode": ["AAAC-1", "TTTG-1"]})
    b = SourceTable("ds-b", {"barcode": ["AAAC", "TTTG"]})
    raw = by_key(join_quality([a, b]))
    assert raw["barcode"]["matched"] == 0, raw["barcode"]
    normed = by_key(join_quality([a, b], normalize=["barcode_suffix"]))
    assert normed["barcode"]["matched"] == 2, normed["barcode"]


def test_a_missing_value_is_absence_and_never_a_key():
    """`align._as_key` maps None/NaN to the empty string; two sources whose key column is
    empty in some rows must not "match" on emptiness."""
    a = SourceTable("ds-a", {"symbol": ["A", None]})
    b = SourceTable("ds-b", {"symbol": ["A", None]})
    rows = by_key(join_quality([a, b]))
    assert rows["symbol"]["matched"] == 1, rows["symbol"]


def test_two_MISSING_keys_make_a_column_unjoinable_and_the_REPORT_says_so_first():
    """MEASURED, not assumed: `align` refuses two blank keys as `duplicate key ''`.

    So a key column with two blanks cannot be joined on at all. The report must predict
    that — a table showing `0 duplicated` beside a key that then hard-fails is precisely
    the "report and refusal disagree" failure this module's docstring is about.

    The two facts are kept apart on purpose. `missing` is `10 of my genes have no ensembl
    id`; `duplicated` is `one gene appears twice`. They are fixed differently, so folding
    the blanks into `duplicated` would give the right refusal under the wrong label.
    """
    a = SourceTable("ds-a", {"symbol": ["A", "B", "C"]})
    b = SourceTable("ds-b", {"symbol": ["A", None, None]})
    row = by_key(join_quality([a, b]))["symbol"]
    assert row["duplicated"] == 0, f"blanks are not duplicates: {row}"
    assert row["missing"] == 2, row
    assert row["missing_per_source"] == {"ds-b": 2}, row
    assert row["joinable"] is False, row

    # The prediction, checked against the thing it predicts.
    with pytest.raises(AlignmentError) as excinfo:
        refuse_duplicate_keys([a, b], "symbol")
    assert "ds-b" in str(excinfo.value), str(excinfo.value)


def test_ONE_missing_key_is_still_joinable():
    """The negative control for the rule above: the refusal needs TWO blanks to fire, so a
    report that called one blank unjoinable would be refusing a key that works."""
    a = SourceTable("ds-a", {"symbol": ["A", "B"]})
    b = SourceTable("ds-b", {"symbol": ["A", None]})
    row = by_key(join_quality([a, b]))["symbol"]
    assert row["missing"] == 1, row
    assert row["joinable"] is True, row
    assert refuse_duplicate_keys([a, b], "symbol"), "…and it really does not raise"


def test_joinable_is_False_for_a_duplicated_key_too():
    row = by_key(join_quality(sources_with_a_duplicate()))["symbol"]
    assert row["duplicated"] == 1 and row["joinable"] is False, row
    assert by_key(join_quality(sources_with_a_duplicate()))["ensembl_id"]["joinable"] is True


def test_fewer_than_two_sources_is_refused():
    with pytest.raises(AlignmentError, match="at least two sources"):
        join_quality([two_clean_sources()[0]])


def test_the_same_dataset_twice_is_refused():
    a, _b = two_clean_sources()
    with pytest.raises(AlignmentError, match="appears twice"):
        join_quality([a, a])


def test_columns_of_differing_lengths_are_refused_at_construction():
    with pytest.raises(AlignmentError, match="differing lengths"):
        SourceTable("ds-a", {"symbol": ["A", "B"], "ensembl_id": ["ENSG1"]})


# ── TEST-17: the refusal, and that it is align's ─────────────────────────────────


def test_a_duplicated_key_is_REFUSED_when_the_alignment_is_actually_built():
    """The counterpart to the count above: measuring reports 1, building refuses."""
    sources = sources_with_a_duplicate()
    assert by_key(join_quality(sources))["symbol"]["duplicated"] == 1
    with pytest.raises(AlignmentError) as excinfo:
        refuse_duplicate_keys(sources, "symbol")
    message = str(excinfo.value)
    assert "ds-b" in message, f"the refusal must name the source; got {message!r}"
    assert "duplicate key" in message, message


def test_a_NORMALISATION_collision_is_refused_too_and_as_a_DIFFERENT_fault():
    """Two distinct raw keys collapsing to one is not a duplicate key — it is a pipeline
    that cannot align unambiguously, and `align` says so in its own words. Asserting the
    two messages differ is what stops a coarse shared refusal masking one with the other."""
    a = SourceTable("ds-a", {"barcode": ["AAAC", "TTTG"]})
    b = SourceTable("ds-b", {"barcode": ["AAAC-1", "AAAC-2"]})
    with pytest.raises(AlignmentError) as excinfo:
        refuse_duplicate_keys([a, b], "barcode", normalize=["barcode_suffix"])
    message = str(excinfo.value)
    assert "maps to multiple rows" in message, message
    assert "duplicate key" not in message, (
        "a normalisation collision was reported as a plain duplicate — two distinct faults "
        f"collapsed into one message: {message!r}"
    )


def test_EVERY_source_is_guarded_including_the_FIRST():
    """`align` guards the TABLE side only, so a pairwise join in one direction would leave
    the first source's duplicates unrefused — and the first source is the one the user is
    most likely looking at. Each source goes through as the table, so this fixture (where
    ONLY source 0 is duplicated) must still refuse."""
    a = SourceTable("ds-a", {"symbol": ["A", "A", "C"]})
    b = SourceTable("ds-b", {"symbol": ["A", "B", "C"]})
    with pytest.raises(AlignmentError) as excinfo:
        refuse_duplicate_keys([a, b], "symbol")
    assert "ds-a" in str(excinfo.value), str(excinfo.value)


def test_the_refusal_is_align_dot_align_and_not_a_second_copy():
    """INV-4 as an executable claim rather than a comment.

    `align.align` is monkeypatched to a sentinel; if this module carried its own duplicate
    check the refusal would still fire and the sentinel would go unseen. Rebinding the name
    this module imported is what makes the assertion honest — a `from … import` binding is
    exactly what a second copy would NOT be reached through.
    """
    calls = []

    def spy(table_rows, key_column, axis_index, normalize=None):
        calls.append((key_column, len(table_rows)))
        return {"columns": {}, "coverage": {}, "warnings": []}

    original = alignment.align
    alignment.align = spy
    try:
        sources = sources_with_a_duplicate()
        reports = refuse_duplicate_keys(sources, "symbol")
    finally:
        alignment.align = original

    assert len(calls) == 2, (
        "every source must pass through `align` as the table, or some source's duplicates "
        f"go unrefused; got {calls}"
    )
    assert len(reports) == 2
    assert [c[0] for c in calls] == ["symbol", "symbol"]
    # With the real refusal replaced, the duplicated fixture NO LONGER raises — which is
    # the proof that nothing in this module refuses it independently.
    assert calls[1][1] == 4, calls


def test_a_key_a_source_does_not_carry_is_refused_by_name():
    a = SourceTable("ds-a", {"symbol": ["A"]})
    b = SourceTable("ds-b", {"other": ["x"]})
    with pytest.raises(AlignmentError, match="no column 'symbol'"):
        refuse_duplicate_keys([a, b], "symbol")


def test_a_clean_key_returns_align_s_own_coverage_reports():
    reports = refuse_duplicate_keys(two_clean_sources(), "ensembl_id")
    assert len(reports) == 2
    for report in reports:
        assert report["coverage"]["matched"] == 4, report["coverage"]
        assert report["coverage"]["missing"] == 0, report["coverage"]


def test_the_module_reexports_align_s_error_type_rather_than_defining_a_second():
    """Two exception types for one fault is how a caller's `except` silently stops
    catching. The identity check is the assertion; `is` rather than a name comparison."""
    assert alignment.AlignmentError is align.AlignmentError


def test_the_documented_RETURNS_SHAPE_matches_a_real_call():
    """D12 — the `Returns::` block is the contract; keep it derived, not remembered.

    It omitted `missing`, `missing_per_source` and `joinable` while the prose above it
    described all three and the code emitted them. A docstring that under-states the payload
    is read by the next consumer as the payload — and `joinable` is the field a key picker
    may not skip, because the highest-`matched` candidate can still be unjoinable.

    So the block is no longer maintained by hand alone: this parses the key names OUT of the
    docstring and compares them to a REAL call's keys. Prose and behaviour cannot drift
    apart again without this going red.
    """
    import re

    sources = [
        SourceTable("ds-a", {"k": ["A", "B"], "x": ["1", "2"]}),
        SourceTable("ds-b", {"k": ["A", "B"], "x": ["1", "9"]}),
    ]
    actual = set(join_quality(sources)["candidates"][0])

    block = re.search(r"Returns::\n(.*?)\n\n", join_quality.__doc__, re.S)
    assert block, "the Returns:: block is gone — the contract has no written form"
    documented = set(re.findall(r'"([a-z_]+)"', block.group(1)))
    # VACUITY GUARD: an empty scrape would approve any payload at all.
    assert len(documented) > 5, f"only {len(documented)} names scraped: {documented}"

    assert actual <= documented, (
        f"the call returns keys the Returns:: block does not document: "
        f"{sorted(actual - documented)}")
