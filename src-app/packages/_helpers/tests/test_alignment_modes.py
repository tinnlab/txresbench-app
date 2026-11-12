#!/usr/bin/env python3
# ruff: noqa
"""TEST-18 / TEST-19 / TEST-20 — the two conflict modes (ITEM-3, ITEM-4, ITEM-5).

The three items are one concept seen from three places, so they are one file:

* **ITEM-3** — on the FEATURE axis, `strict` drops a conflicting pair and `authority` keeps
  it, with the named dataset's annotation labelling it.
* **ITEM-4** — the SAME two modes govern categorical LEVELS. There is deliberately no third
  mode name for the level case, and a test asserts the vocabularies are literally the same
  object rather than two lists that happen to agree today.
* **ITEM-5** — a row whose level `authority` dropped holds `NA`, in a FULL-AXIS column.

## The asymmetry these tests pin

On features `strict` DROPS and `authority` KEEPS; on levels `strict` KEEPS and `authority`
DROPS. That reads like a contradiction and is not: `strict` never asserts an identity nobody
observed, and `authority` lets one dataset's annotation be the assertion. Merging two
disagreeing gene annotations is an assertion; unioning two vocabularies is not; declaring
one vocabulary complete is. Each direction is asserted below, because an implementation that
got the level case backwards would be self-consistent and wrong.
"""
from __future__ import annotations

import pytest

import alignment
from alignment import (
    AUTHORITY,
    DEFAULT_MODE,
    MODES,
    STRICT,
    AlignmentError,
    SourceTable,
    apply_level_lookup,
    resolve_features,
    resolve_levels,
)


def sources_with_a_conflict():
    """`C` is one symbol carrying two different ensembl ids — the conflicting pair."""
    a = SourceTable("ds-a", {
        "symbol": ["A", "B", "C"],
        "ensembl_id": ["ENSG1", "ENSG2", "ENSG3"],
    })
    b = SourceTable("ds-b", {
        "symbol": ["A", "B", "C"],
        "ensembl_id": ["ENSG1", "ENSG2", "ENSG7"],
    })
    return [a, b]


def two_sources():
    a = SourceTable("ds-a", {"symbol": ["A", "B"]})
    b = SourceTable("ds-b", {"symbol": ["A", "B"]})
    return [a, b]


# ── TEST-18: strict is the DEFAULT, and it drops ─────────────────────────────────


def test_strict_is_the_default_when_no_mode_is_supplied():
    """Choosing `authority` must be a deliberate act, not the path of least resistance —
    it makes a claim about biology on the user's behalf (INV-1)."""
    assert DEFAULT_MODE == STRICT
    resolved = resolve_features(sources_with_a_conflict(), "symbol")
    assert resolved["mode"] == STRICT
    assert resolved["dropped"] == ["C"], resolved
    assert resolved["features"] == ["A", "B"], resolved


def test_strict_drops_the_conflicting_pair_and_keeps_the_rest():
    resolved = resolve_features(sources_with_a_conflict(), "symbol", mode=STRICT)
    assert resolved["conflicting"] == ["C"], resolved
    assert resolved["dropped"] == ["C"], resolved
    assert "C" not in resolved["features"], resolved
    assert resolved["labels"]["A"] == {"ensembl_id": "ENSG1"}, resolved["labels"]


def test_authority_drops_NOTHING_and_labels_the_pair_from_the_named_dataset():
    """`authority` keeps the conflicting feature; the named dataset's annotation names it.

    The label check is the substance. Without it, "authority" could be implemented as
    "keep the pair and take whichever value arrived first", which is a different claim
    wearing the same word.
    """
    resolved = resolve_features(
        sources_with_a_conflict(), "symbol", mode=AUTHORITY, authority="ds-b"
    )
    assert resolved["dropped"] == [], resolved
    assert resolved["features"] == ["A", "B", "C"], resolved
    assert resolved["conflicting"] == ["C"], "the conflict is RECORDED, not erased"
    assert resolved["labels"]["C"] == {"ensembl_id": "ENSG7"}, (
        "ds-b is the authority, so its ENSG7 must label the unified feature; got "
        f"{resolved['labels']['C']}"
    )
    # …and naming the OTHER dataset gives the OTHER label, or "authority" is not selecting
    # anything and the assertion above passes by accident.
    other = resolve_features(
        sources_with_a_conflict(), "symbol", mode=AUTHORITY, authority="ds-a"
    )
    assert other["labels"]["C"] == {"ensembl_id": "ENSG3"}, other["labels"]


def test_authority_keeps_BOTH_datasets_contributing_rows():
    """`authority` selects whose ANNOTATION labels the feature — never whose data is used.

    Encoded as an assertion about the output rather than a comment: the resolution names
    exactly one authority and both sources remain in play, so nothing here can be read as
    "use dataset B's values".
    """
    sources = sources_with_a_conflict()
    resolved = resolve_features(sources, "symbol", mode=AUTHORITY, authority="ds-b")
    assert resolved["authority"] == "ds-b"
    assert set(resolved["features"]) <= set(sources[0].columns["symbol"])
    assert set(resolved["features"]) <= set(sources[1].columns["symbol"]), (
        "every kept feature must be present in BOTH sources — an authority mode that "
        "silently took only the authority's features would be a different feature axis"
    )


def test_defaulting_to_authority_would_keep_the_conflicting_pair():
    """TEST-18's declared negative control, RUN: the no-mode fixture must NOT look like the
    authority one. Comparing the two outputs is what makes the default assertion
    falsifiable rather than a restatement of the constant."""
    default = resolve_features(sources_with_a_conflict(), "symbol")
    authority = resolve_features(
        sources_with_a_conflict(), "symbol", mode=AUTHORITY, authority="ds-a"
    )
    assert default["features"] != authority["features"], (
        "the fixture has no conflict to distinguish the modes — then the default "
        f"assertion is vacuous. {default['features']} vs {authority['features']}"
    )
    assert len(authority["features"]) == len(default["features"]) + 1


def test_an_unknown_mode_is_refused_rather_than_falling_back():
    with pytest.raises(AlignmentError, match="unknown conflict mode"):
        resolve_features(two_sources(), "symbol", mode="lenient")


def test_authority_with_no_dataset_named_is_refused():
    with pytest.raises(AlignmentError, match="requires the dataset"):
        resolve_features(two_sources(), "symbol", mode=AUTHORITY)


def test_authority_naming_a_non_source_is_refused():
    with pytest.raises(AlignmentError, match="not one of this alignment's sources"):
        resolve_features(two_sources(), "symbol", mode=AUTHORITY, authority="ds-zzz")


def test_strict_with_an_authority_supplied_is_refused_rather_than_ignored():
    """A silently-ignored parameter is how a user believes they chose authority."""
    with pytest.raises(AlignmentError, match="names no authority"):
        resolve_features(two_sources(), "symbol", mode=STRICT, authority="ds-a")


def test_the_unified_feature_order_is_the_first_source_s_order_not_set_iteration():
    """A row vector is POSITIONAL, so a feature axis that reordered between runs would be a
    different artifact wearing the same name."""
    a = SourceTable("ds-a", {"symbol": ["Z", "M", "A"]})
    b = SourceTable("ds-b", {"symbol": ["A", "M", "Z"]})
    assert resolve_features([a, b], "symbol")["features"] == ["Z", "M", "A"]
    for _ in range(3):
        assert resolve_features([a, b], "symbol")["features"] == ["Z", "M", "A"]


def test_a_duplicated_key_still_hard_fails_under_either_mode():
    """The ITEM-2 refusal is not switched off by choosing a mode."""
    a = SourceTable("ds-a", {"symbol": ["A", "B"]})
    b = SourceTable("ds-b", {"symbol": ["A", "A", "B"]})
    for kwargs in ({}, {"mode": AUTHORITY, "authority": "ds-a"}):
        with pytest.raises(AlignmentError, match="duplicate key"):
            resolve_features([a, b], "symbol", **kwargs)


# ── TEST-19: the SAME two modes govern levels ────────────────────────────────────


def test_strict_UNIONS_the_level_sets():
    sources = two_sources()
    resolved = resolve_levels(sources, [["x", "y"], ["y", "z"]])
    assert resolved["mode"] == STRICT
    assert resolved["levels"] == ["x", "y", "z"], resolved
    assert resolved["dropped"] == {}, resolved
    assert resolved["lookups"][0] == {0: 0, 1: 1}, resolved["lookups"]
    assert resolved["lookups"][1] == {0: 1, 1: 2}, resolved["lookups"]


def test_authority_takes_the_named_vocabulary_and_drops_levels_outside_it():
    sources = two_sources()
    resolved = resolve_levels(
        sources, [["x", "y"], ["y", "z"]], mode=AUTHORITY, authority="ds-a"
    )
    # ["x","y"] plus the DECLARED absence label (C4): `authority` dropped ds-b's "z", and a
    # dropped level maps to a real, labelled, IN-RANGE code rather than to an out-of-range
    # `-1` the read side refuses with a 400 for the whole column.
    assert resolved["levels"] == ["x", "y", "NA"], resolved
    assert resolved["missing_level"] == "NA", resolved
    assert resolved["dropped"] == {"ds-b": ["z"]}, resolved
    # ds-b's code 0 ("y") -> unified 1; its code 1 ("z") was DROPPED and now maps to the
    # declared absence level's code rather than to `None` (C4).
    assert resolved["lookups"][1] == {0: 1, 1: resolved["levels"].index("NA")}, \
        resolved["lookups"]


def test_the_asymmetry_is_the_rule_and_not_a_bug():
    """On features `strict` DROPS and `authority` KEEPS; on levels it is the other way.

    Both directions in one assertion, because an implementation that got the level case
    backwards would be perfectly self-consistent — and this is the test that would not pass
    for it.
    """
    features_strict = resolve_features(sources_with_a_conflict(), "symbol", mode=STRICT)
    features_auth = resolve_features(
        sources_with_a_conflict(), "symbol", mode=AUTHORITY, authority="ds-a"
    )
    levels_strict = resolve_levels(two_sources(), [["x"], ["y"]], mode=STRICT)
    levels_auth = resolve_levels(
        two_sources(), [["x"], ["y"]], mode=AUTHORITY, authority="ds-a"
    )
    assert len(features_strict["features"]) < len(features_auth["features"]), "features: strict drops"
    # Compare the REAL vocabularies: since C4 an `authority` result carries one extra
    # DECLARED absence label, and counting it would mask the drop this asserts.
    def real_levels(r):
        return [lv for lv in r["levels"] if lv != r["missing_level"]]

    assert len(real_levels(levels_strict)) > len(real_levels(levels_auth)), (
        "levels: authority drops", levels_strict["levels"], levels_auth["levels"])


def test_there_is_no_THIRD_mode_name_for_the_level_case():
    """TEST-19's declared negative control. One concept for the user to learn, not two.

    Asserted as an identity — both entry points validate against the SAME `MODES` tuple —
    rather than as two lists that happen to agree today.
    """
    assert MODES == (STRICT, AUTHORITY)
    for entry in (resolve_features, resolve_levels):
        assert entry.__module__ == alignment.__name__
    with pytest.raises(AlignmentError, match="unknown conflict mode"):
        resolve_levels(two_sources(), [["x"], ["y"]], mode="union")
    with pytest.raises(AlignmentError, match="unknown conflict mode"):
        resolve_features(two_sources(), "symbol", mode="union")
    # The refusal message names the shared vocabulary, so a third name cannot be introduced
    # for one side without this going red.
    with pytest.raises(AlignmentError) as excinfo:
        resolve_levels(two_sources(), [["x"], ["y"]], mode="vocabulary_union")
    assert "no third mode for the level case" in str(excinfo.value)


def test_the_level_case_cannot_be_told_that_a_categorical_is_ordered():
    """ITEM-14 / INV-15 previewed here — asserted STRUCTURALLY and BEHAVIOURALLY, never by
    scanning the source.

    A source-text assertion (`"ordered" not in getsource(...)`) is the guard shape this
    repo has already paid for twice: its evasion space is unbounded, and the first thing it
    catches is a docstring that mentions the word. So the claim is made two ways that a
    real branch would have to defeat:

    * **structurally** — the resolver's parameters are exactly these, so a caller has no
      channel through which to tell it a categorical is ordered. An `ordered` branch would
      have to be unreachable, which makes it dead rather than dangerous;
    * **behaviourally** — two level sets whose SEQUENCES differ (which is exactly what two
      `ordered` categoricals disagreeing looks like) union by the same rule as any other
      pair, and the result is order-of-appearance, not either source's declared order.
    """
    import inspect

    params = list(inspect.signature(resolve_levels).parameters)
    assert params == ["sources", "level_sets", "mode", "authority"], params

    sources = two_sources()
    forward = resolve_levels(sources, [["low", "mid", "high"], ["high", "mid", "low"]])
    assert forward["levels"] == ["low", "mid", "high"], forward
    assert forward["dropped"] == {}, "an ordered disagreement must not drop anything"
    # The union is order-of-APPEARANCE, so swapping which source is first swaps the result —
    # which is the proof it is not deriving an order from anything it was told.
    backward = resolve_levels(
        list(reversed(sources)), [["high", "mid", "low"], ["low", "mid", "high"]]
    )
    assert backward["levels"] == ["high", "mid", "low"], backward


def test_mismatched_level_set_count_is_refused():
    with pytest.raises(AlignmentError, match="one per source"):
        resolve_levels(two_sources(), [["x"]])


# ── TEST-20: authority-dropped levels are FULL-AXIS + NA ─────────────────────────


def test_a_dropped_level_becomes_NA_in_a_FULL_AXIS_column():
    """The three wrong answers, each excluded by a separate assertion.

    An empty string is a level that reads as a real value; a synthetic `"other"` invents a
    category the data never had; an omitted row changes the length so the column no longer
    aligns with anything. Only `None`, in place, is the tree's existing idiom.
    """
    sources = two_sources()
    resolved = resolve_levels(
        sources, [["x", "y"], ["y", "z"]], mode=AUTHORITY, authority="ds-a"
    )
    codes = [0, 1, 0, 1]  # ds-b's codes: y, z, y, z
    column = apply_level_lookup(codes, resolved["lookups"][1])

    assert len(column) == len(codes), (
        f"the column is not full-axis — {len(column)} values for {len(codes)} rows, so the "
        "dropped rows were OMITTED rather than filled"
    )
    # SINCE C4 the fill is the DECLARED absence level's code, not `None`. The column is
    # still full-axis and the dropped rows are still not relabelled as a real category —
    # what changed is that absence now has a LABEL and therefore an in-range code, which is
    # the only form the read side can serve.
    absent = resolved["levels"].index(resolved["missing_level"])
    assert column == [1, absent, 1, absent], column
    assert resolved["levels"][absent] == "NA", resolved["levels"]
    assert absent not in (0, 1), "absence took a REAL level's code — a silent relabel"
    assert "" not in column, "an empty string is a level, not an absence"
    assert not any(isinstance(v, str) for v in column), (
        "a synthetic level was invented for the dropped rows"
    )


def test_under_strict_no_row_is_NA_because_nothing_was_dropped():
    """The negative control for the fill: a union drops nothing, so a `NA` appearing here
    would mean the fill fires on something other than a dropped level."""
    sources = two_sources()
    resolved = resolve_levels(sources, [["x", "y"], ["y", "z"]])
    column = apply_level_lookup([0, 1, 0, 1], resolved["lookups"][1])
    assert column == [1, 2, 1, 2], column
    assert None not in column


def test_a_source_row_with_no_code_at_all_is_also_NA():
    """pandas' -1 / `None` code — an absent value in the SOURCE — lands in the same place
    as a dropped level, which is correct: both are "this row has no level"."""
    sources = two_sources()
    resolved = resolve_levels(sources, [["x", "y"], ["y", "z"]])
    assert apply_level_lookup([0, None, 1], resolved["lookups"][1]) == [1, None, 2]


def test_a_missing_ROW_and_a_missing_LEVEL_are_spelled_DIFFERENTLY_and_deliberately():
    """C4 — this test used to assert ONE spelling of absence. That was the mistake.

    `align` fills a missing ROW with in-memory `None`, and that is unchanged. ITEM-5 reached
    for the same `None` for a missing LEVEL and then translated it to STORAGE as `-1` — the
    out-of-range code `txr_columns` explicitly refuses, and the one the read side rejects
    with a 400 for the entire column.

    DEC-A already draws the line this test blurred: a missing row and a missing level are on
    different axes and are different facts. They are now spelled differently on purpose —
    the row keeps `None`, the level gets a DECLARED label with a real code — and asserting
    they are the same object is what made the wrong translation look consistent.
    """
    import align

    aligned = align.align([{"k": "A", "v": 1}], "k", ["A", "B"])
    assert aligned["columns"]["v"] == [1, None], "a missing ROW is still in-memory None"

    sources = two_sources()
    resolved = resolve_levels(
        sources, [["x"], ["z"]], mode=AUTHORITY, authority="ds-a"
    )
    column = apply_level_lookup([0], resolved["lookups"][1])
    absent = resolved["levels"].index(resolved["missing_level"])
    assert column == [absent], column
    assert None not in column, (
        "a dropped level still resolves to None, so it will be written as an out-of-range "
        "sentinel the serve path refuses — C4's whole point")
