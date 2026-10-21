#!/usr/bin/env python3
# ruff: noqa
"""TEST-26 — the `aux` channel: members whose length is NOT the axis's `n` (ITEM-12).

## The defect this suite exists for

The previous round shipped an artifact kind whose index body could not live among
`columns` — its length was the member count, not the table's `n` — so the writer declared
it somewhere else, and every gather over an artifact a REAL producer emitted failed with
"has no member". Both sides' unit fixtures were green throughout, **because each agreed
with itself**: the writer's tests asserted what the writer wrote, the gate's tests asserted
what the gate accepted, and nothing put the two in one room.

The alignment artifact's segment members have exactly that shape — their length is the
SEGMENT count, not the table's `n`. So the two refusals that close the hole are asserted
**in both directions, here, in one file**:

* a member declared among `columns` is refused by `_conform_member` for the wrong length;
* a member written but NOT declared is refused by `_conform_node_coverage` as an
  undeclared stored node.

Each is a real refusal today and each is load-bearing: between them they leave exactly no
way to store such a member, which is *why* the `aux` channel had to be added rather than
worked around at the producer. A suite asserting only that `aux` works would pass over a
gate that had quietly stopped refusing either alternative.

## D18 — the per-output-row vectors were DROPPED

`alignment_row_source` / `alignment_row_segment` used to be the aux example here. They were
pure redundancy over the segment table (output row `i` reconstructs to
`(declared_order, i - start_row)` from the segment whose range contains it), so they — and
the `_conform_alignment_row_space` cross-check that guarded them — were removed. This suite
now uses the surviving `alignment_segment_*` members as the aux example.
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

import conformance
import cyto_zarr as cz


# ── fixtures ─────────────────────────────────────────────────────────────────────

#: The fixture alignment below has TWO segments — source 0 contributes output rows 0..2,
#: source 1 rows 3..4. Small on purpose — every assertion here is about the declaration, and
#: a large fixture would only make a failure harder to read.
_SEGMENTS = 2
_FEATURES = 4
_SOURCES = 2

#: The fixture table's own axis — the same domain-free name the real producer declares.
ALIGN_AXIS = "unified_entities"


def an_alignment(root, *, n_features=_FEATURES):
    """A table shaped like the real alignment artifact, written through the REAL writer.

    Its axis is the unified FEATURE axis, so the feature id column is an ordinary member
    and the segment table — whose members' length is the SEGMENT count — is `aux`. That
    split is not a fixture convenience: it is the actual shape, and it is why exactly one
    length rule (`n`) is not enough for this artifact. Since D18 there is no per-output-row
    vector; the segment table alone carries the row layout.
    """
    with cz.Table(root, axis="unified_entities", n=n_features, key="feature_id") as t:
        t.string("feature_id", [f"ENSG{i:05d}" for i in range(n_features)])
        # unified feature × source → that source's column index (INV-2: INTERSECTION, so
        # every row here is total — there is no absence to encode).
        t.aux(
            "entity_index",
            np.arange(n_features * _SOURCES, dtype=np.int32).reshape(n_features, _SOURCES),
            dtype="int32",
            role="alignment_entity_index",
            extent=["unified_entities", "sources"],
        )
        # The segment table — four members, one per array, all length _SEGMENTS. Source 0
        # owns output rows [0, 3); source 1 owns [3, 5).
        t.aux(
            "segment_order",
            np.array([0, 1], dtype=np.int32),
            dtype="int32",
            role="alignment_segment_order",
            extent=["segments"],
        )
        t.aux(
            "segment_start",
            np.array([0, 3], dtype=np.int64),
            dtype="int64",
            role="alignment_segment_start",
            extent=["segments"],
        )
        t.aux(
            "segment_end",
            np.array([3, 5], dtype=np.int64),
            dtype="int64",
            role="alignment_segment_end",
            extent=["segments"],
        )
        t.aux(
            "segment_dataset",
            np.array([0, 1], dtype=np.int32),
            dtype="int32",
            role="alignment_segment_dataset",
            extent=["segments"],
        )
        return t.close()


def restamp(root, structure):
    """Rewrite the group stamp so a test editing the RETURNED structure is testing the
    check it means to, rather than tripping the group/row drift check first."""
    node = json.loads((Path(root) / "zarr.json").read_text())
    node["attributes"]["cyto"] = structure
    (Path(root) / "zarr.json").write_text(json.dumps(node, indent=2, ensure_ascii=False))


def aux_of(structure, path):
    return next(m for m in structure["aux"] if m["path"] == path)


# ── the positive control ─────────────────────────────────────────────────────────


def test_a_real_producer_writes_the_segment_table_and_the_real_gate_conforms_it(tmp_path):
    """The end-to-end leg: the real writer emits, the real gate conforms, `[]`.

    This is the assertion the prior round's two green suites could not make between them.
    """
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    assert conformance.conform_artifact(root, structure, full=True) == [], (
        "the writer emitted an artifact its own framework gate refuses — which is the "
        "defect this whole item exists to prevent"
    )


def test_every_aux_vector_resolves_by_path_from_the_declaration_alone(tmp_path):
    """A declaration a reader cannot follow is not a declaration.

    Asserted by RESOLVING each vector off disk from the structure — not by re-deriving the
    paths here, which would test this test's naming convention rather than the writer's.
    """
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    import cyto_zarr_read

    roles = {m["role"]: m for m in structure["aux"]}
    assert set(roles) == {
        "alignment_entity_index",
        "alignment_segment_order",
        "alignment_segment_start",
        "alignment_segment_end",
        "alignment_segment_dataset",
    }, roles
    values = cyto_zarr_read.read_array(root, roles["alignment_segment_start"]["path"])
    assert values.tolist() == [0, 3]
    feat = cyto_zarr_read.read_array(root, roles["alignment_entity_index"]["path"])
    assert list(feat.shape) == [_FEATURES, _SOURCES]


def test_the_extents_map_records_each_length_exactly_once(tmp_path):
    """Four members claim `segments`; ONE number answers for all of them.

    That indirection is what makes the check worth anything — see `_conform_aux`.
    """
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    assert structure["extents"] == {
        "unified_entities": _FEATURES,
        "sources": _SOURCES,
        "segments": _SEGMENTS,
    }
    claiming_segments = [
        m["path"] for m in structure["aux"] if "segments" in m["extent"]
    ]
    assert len(claiming_segments) == 4, (
        "the fixture must have several members sharing one extent or it cannot demonstrate "
        f"what the extent name is for; got {claiming_segments}"
    )


# ── refusal direction 1: declared among `columns` ────────────────────────────────


def test_an_aux_vector_declared_among_columns_is_refused_for_the_wrong_length(tmp_path):
    """The first of the two refusals the `aux` channel exists BECAUSE of.

    Moving the member's declaration into `columns` — which is what a producer without this
    channel would do — is refused by `_conform_member` against `expect_rows=n`. The bytes
    are untouched; only the declaration moves. `segment_order` is _SEGMENTS long in a
    _FEATURES-row table, so the length rule catches it. The `segments` extent is still
    claimed by the other three segment members, so no unresolved-extent finding drowns it.
    """
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    assert conformance.conform_artifact(root, structure, full=True) == [], "positive control"

    moved = aux_of(structure, "segment_order")
    structure["aux"] = [m for m in structure["aux"] if m["path"] != "segment_order"]
    moved.pop("role")
    moved.pop("extent")
    moved["axis"] = "unified_entities"
    structure["columns"].append(moved)
    restamp(root, structure)

    violations = conformance.conform_artifact(root, structure, full=True)
    assert any(
        "segment_order" in v and "the axis declares" in v for v in violations
    ), (
        f'declaring "segment_order" ({_SEGMENTS} long) among `columns` of a {_FEATURES}-row '
        f"table was NOT refused for its length. Got {violations}"
    )


# ── refusal direction 2: written but not declared ────────────────────────────────


def test_an_aux_vector_written_but_UNDECLARED_is_refused_as_an_unknown_stored_node(tmp_path):
    """The second refusal, and the one the prior round's defect actually took.

    Dropping the member from the declaration while its bytes stay on disk is the "cheapest
    opt-out there is": no byte-level check can see it, because nothing looks. Only asking
    the store what it holds can, and that is `_conform_node_coverage`. The `segments` extent
    stays claimed by the other three segment members, so this isolates the undeclared-node
    finding rather than an unresolved-extent one.
    """
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    assert conformance.conform_artifact(root, structure, full=True) == [], "positive control"

    structure["aux"] = [m for m in structure["aux"] if m["path"] != "segment_order"]
    restamp(root, structure)
    assert (root / "segment_order").is_dir(), "the bytes must still be there or this proves nothing"

    violations = conformance.conform_artifact(root, structure, full=True)
    assert any(
        "segment_order" in v and "does not name" in v for v in violations
    ), (
        "un-declaring a written aux member was SILENT — its bytes keep every byte they had "
        f"and lose every check in the suite. Got {violations}"
    )


def test_BOTH_refusal_directions_are_live_at_once(tmp_path):
    """Teaching the gate ONE direction is the failure mode, not a partial success.

    The prior round's defect survived precisely because each side agreed with itself, so
    this asserts the pair rather than trusting two separate greens above.
    """
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)

    undeclared = json.loads(json.dumps(structure))
    undeclared["aux"] = [m for m in undeclared["aux"] if m["path"] != "segment_order"]
    restamp(root, undeclared)
    a = conformance.conform_artifact(root, undeclared, full=True)

    root_b = tmp_path / "b.zarr"
    structure_b = an_alignment(root_b)
    moved = aux_of(structure_b, "segment_order")
    structure_b["aux"] = [m for m in structure_b["aux"] if m["path"] != "segment_order"]
    moved.pop("role")
    moved.pop("extent")
    moved["axis"] = "unified_entities"
    structure_b["columns"].append(moved)
    restamp(root_b, structure_b)
    b = conformance.conform_artifact(root_b, structure_b, full=True)

    assert a and b, (
        "one of the two directions stopped refusing — the gate must close on an aux "
        f"member from BOTH sides. undeclared={a!r} miscolumned={b!r}"
    )


# ── the role table is the anti-opt-out ───────────────────────────────────────────


def test_a_role_the_gate_has_no_opinion_about_is_REFUSED(tmp_path):
    """An aux member sits outside every length rule the axis provides, so an unenumerated
    role would be bytes held to a name alone — the opt-out re-opened one level down."""
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    aux_of(structure, "segment_start")["role"] = "something_nobody_declared"
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("no opinion about" in v for v in violations), violations


def test_an_absent_role_is_refused_rather_than_defaulting_to_unchecked(tmp_path):
    """Absence must not select a shallower check — the class this module exists to refuse."""
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    aux_of(structure, "segment_start").pop("role")
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("no opinion about" in v for v in violations), violations


def test_every_aux_role_carries_its_meaning():
    """A bare allow-list is how a role becomes optional-by-accident; the reason is what a
    reviewer actually checks. Same contract as `_OPTIONAL_MEMBER_KEYS`' reasons."""
    assert conformance._AUX_ROLES, "the role table is empty — every aux member would be refused"
    for role, why in conformance._AUX_ROLES.items():
        assert isinstance(why, str) and len(why.strip()) > 20, (
            f"aux role {role!r} carries no meaning ({why!r})"
        )


def test_the_key_tables_classify_every_key_the_aux_writer_emits(tmp_path):
    """The N+1 proof, for this channel: `role`/`extent` are classified, or this fails.

    The sibling of `test_conformance.py::test_the_key_tables_classify_every_key_the_
    writers_emit`, which does not cover `aux` because it enumerates `columns`/`arrays`.
    """
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    for member in structure["aux"]:
        kind = member["kind"]
        classified = set(conformance._REQUIRED_MEMBER_KEYS[kind]) | set(
            conformance._OPTIONAL_MEMBER_KEYS
        )
        unclassified = sorted(set(member) - classified)
        assert not unclassified, (
            f"the aux writer emits member key(s) {unclassified} the gate neither requires "
            "nor knows to be optional"
        )


# ── the extent indirection ───────────────────────────────────────────────────────


def test_a_member_whose_shape_contradicts_its_extent_is_refused(tmp_path):
    """The check the name buys: one number answers for every member claiming it."""
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    structure["extents"]["segments"] = _SEGMENTS + 1
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("extent 'segments' is declared" in v for v in violations), violations


def test_an_extent_name_that_resolves_to_nothing_is_refused(tmp_path):
    """A name pointing at no declaration is not a length rule."""
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    aux_of(structure, "segment_order")["extent"] = ["segments_typo"]
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("does not declare" in v for v in violations), violations


def test_an_extent_nothing_claims_is_refused(tmp_path):
    """A stale extent is how a length rule survives the member it was for."""
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    structure["extents"]["left_over"] = 7
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("left_over" in v and "no aux member" in v for v in violations), violations


def test_an_absent_extent_is_refused_rather_than_leaving_the_member_unbounded(tmp_path):
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    aux_of(structure, "segment_start").pop("extent")
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("no length rule at all" in v for v in violations), violations


def test_naming_fewer_extents_than_dimensions_is_refused(tmp_path):
    """The 2-D case: one name per dimension, or the second dimension is unbounded."""
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    aux_of(structure, "entity_index")["extent"] = ["unified_entities"]
    structure["extents"].pop("sources")
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("one name per dimension" in v for v in violations), violations


def test_extents_without_aux_members_is_refused(tmp_path):
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    for member in structure["aux"]:
        member.pop("role")
        member.pop("extent")
        member["axis"] = "unified_entities"
        structure["columns"].append(member)
    structure.pop("aux")
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("`extents` but no `aux`" in v for v in violations), violations


# ── the writer's own refusals ────────────────────────────────────────────────────


def test_the_writer_refuses_two_members_disagreeing_about_one_extent(tmp_path):
    """Refused where it is cheapest — before a byte of the second member is written."""
    root = tmp_path / "t.zarr"
    with cz.Table(root, axis="features", n=3) as t:
        t.numeric("v", np.arange(3, dtype=np.int32), dtype="int32")
        t.aux("a", np.zeros(5, dtype=np.int32), dtype="int32",
              role="alignment_segment_start", extent=["shared_len"])
        with pytest.raises(ValueError, match="already declared 5"):
            t.aux("b", np.zeros(6, dtype=np.int32), dtype="int32",
                  role="alignment_segment_end", extent=["shared_len"])


def test_the_writer_refuses_an_extent_list_that_does_not_match_the_dimensions(tmp_path):
    root = tmp_path / "t.zarr"
    with cz.Table(root, axis="features", n=3) as t:
        t.numeric("v", np.arange(3, dtype=np.int32), dtype="int32")
        with pytest.raises(ValueError, match="one name per dimension"):
            t.aux("a", np.zeros((5, 2), dtype=np.int32), dtype="int32",
                  role="alignment_entity_index", extent=["segments"])
        with pytest.raises(ValueError, match="list of extent names"):
            t.aux("b", np.zeros(5, dtype=np.int32), dtype="int32",
                  role="alignment_segment_start", extent="segments")


def test_the_writer_refuses_an_aux_member_with_no_role(tmp_path):
    root = tmp_path / "t.zarr"
    with cz.Table(root, axis="features", n=3) as t:
        t.numeric("v", np.arange(3, dtype=np.int32), dtype="int32")
        with pytest.raises(ValueError, match="non-empty `role`"):
            t.aux("a", np.zeros(5, dtype=np.int32), dtype="int32",
                  role="", extent=["segments"])


def test_the_writer_refuses_the_KEY_member_being_written_as_aux(tmp_path):
    """A key member IS the axis, so its length is `n` by definition; letting it be aux
    would let one producer declare an axis whose keys are a different length from it."""
    root = tmp_path / "t.zarr"
    # NOT a context manager: `close()` would then run on the way out and fail for the
    # unrelated reason that the declared key member was never written, which would report
    # a different fault than the one under test.
    t = cz.Table(root, axis="features", n=3, key="feature_id")
    with pytest.raises(ValueError, match="long by definition"):
        t.aux("feature_id", np.zeros(5, dtype=np.int32), dtype="int32",
              role="alignment_segment_start", extent=["segments"])


def test_an_ordinary_table_is_byte_identical_to_what_it_was_before_the_channel(tmp_path):
    """The negative control for the channel itself: additive, so a table using none of it
    declares neither key. Without this, `aux: []`/`extents: {}` could appear on every
    artifact in the tree and nothing would notice."""
    root = tmp_path / "plain.zarr"
    with cz.Table(root, axis="rows", n=4) as t:
        t.numeric("v", np.arange(4, dtype=np.int32), dtype="int32")
        structure = t.close()
    assert "aux" not in structure and "extents" not in structure, structure
    assert conformance.conform_artifact(root, structure, full=True) == []


# ── S2: an extent must be ANCHORED to the axis, not merely self-consistent ───────


def test_a_wrong_length_PER_ENTRY_vector_is_REFUSED(tmp_path):
    """The hole this rule closes, in the exact shape a blind audit measured.

    An extent is a producer-declared integer cross-checked only against OTHER members
    claiming the same name — so a per-entity vector whose length is simply WRONG is
    self-consistent and was conformed clean: a length-3 evidence vector in a table of n=4,
    zero violations. Self-consistency is not a check; it is the state `_conform_aux`'s own
    docstring says it exists to refuse, reached one level down.
    """
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    assert conformance.conform_artifact(root, structure, full=True) == [], "positive control"

    # The axis says 4 entities; the extent claims 3. Both copies edited coherently, which is
    # what a producer computing the wrong number would actually emit.
    structure["extents"][ALIGN_AXIS] = _FEATURES - 1
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("one axis is one length" in v for v in violations), violations


def test_a_PER_ENTRY_role_may_not_name_its_OWN_extent_to_escape_the_anchor(tmp_path):
    """The dodge the anchor would otherwise leave open: rename the extent and the member is
    checked against nothing but itself again."""
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    member = aux_of(structure, "entity_index")
    member["extent"] = ["a_private_extent"] + member["extent"][1:]
    structure["extents"]["a_private_extent"] = _FEATURES
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("must name the table's axis" in v for v in violations), violations


def test_a_role_whose_axis_dimension_is_absent_is_refused(tmp_path):
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    aux_of(structure, "entity_index")["extent"] = ["unified_entities"]
    structure["extents"].pop("sources")
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert violations, "a 2-D per-entry member declaring one extent must be refused"


# ── T7: the five refusal branches that had no test at all ───────────────────────


def test_a_NON_NUMERIC_aux_member_is_refused(tmp_path):
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    aux_of(structure, "segment_start")["kind"] = "string"
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("carries numeric members only" in v for v in violations), violations


def test_an_aux_member_DUPLICATING_another_members_path_is_refused(tmp_path):
    """Two declarations over one node: whichever is checked second describes bytes the first
    already claimed, so one of the two is unverified by construction.

    NOTE — the CROSS-CHANNEL variant (an aux member pointing at a string COLUMN's path) is
    deliberately not exercised here: `_conform_member` raises `KeyError: 'data_type'` on it
    rather than reporting a violation, because it reads a fixed-width member's node keys off
    a string member's group node. That is a pre-existing fragility in the member reader, not
    in this channel, and `conform_manifest` turns a raise into a report that names the
    symptom and loses every finding made so far. Recorded rather than papered over; it wants
    its own fix in the member reader.
    """
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    aux_of(structure, "segment_end")["path"] = "segment_start"
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("duplicate member path" in v for v in violations), violations


def test_an_EMPTY_aux_list_is_refused(tmp_path):
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    structure["aux"] = []
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("EMPTY `aux` list" in v for v in violations), violations


def test_aux_members_with_ABSENT_or_EMPTY_extents_are_refused(tmp_path):
    for replacement in ({}, None, "not-a-map"):
        root = tmp_path / f"a{hash(str(replacement)) & 0xffff}.zarr"
        structure = an_alignment(root)
        structure["extents"] = replacement
        restamp(root, structure)
        violations = conformance.conform_artifact(root, structure, full=True)
        assert violations, f"extents={replacement!r} must be refused"


def test_a_NON_INTEGER_extent_value_is_refused(tmp_path):
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    structure["extents"]["segments"] = "two"
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("not a non-negative" in v for v in violations), violations


# ── T8: `Table.aux`'s name guard ─────────────────────────────────────────────────


def test_the_writer_refuses_a_DUPLICATE_or_RESERVED_aux_member_name(tmp_path):
    """`_claim` is `aux()`'s first line and had no test: removing it changed nothing.

    `zarr.json` is the one that matters — writing a member under that name would overwrite
    the group node itself, i.e. the artifact's own declaration.
    """
    root = tmp_path / "t.zarr"
    t = cz.Table(root, axis="unified_entities", n=3)
    t.numeric("v", np.arange(3, dtype=np.int32), dtype="int32")
    t.aux("a", np.zeros(2, dtype=np.int32), dtype="int32",
          role="alignment_segment_start", extent=["segments"])

    with pytest.raises(ValueError, match="duplicate member name"):
        t.aux("a", np.zeros(2, dtype=np.int32), dtype="int32",
              role="alignment_segment_end", extent=["segments"])
    with pytest.raises(ValueError, match="duplicate member name"):
        t.aux("v", np.zeros(2, dtype=np.int32), dtype="int32",
              role="alignment_segment_end", extent=["segments"])
    for bad in ("zarr.json", "c", "", "sub/dir"):
        with pytest.raises(ValueError, match="invalid member name|duplicate member name"):
            t.aux(bad, np.zeros(2, dtype=np.int32), dtype="int32",
                  role="alignment_segment_end", extent=["segments"])


# ── The unified level VOCABULARY gate ───────────────────────────────────────────


def _alignment_with_levels(root, *, vocabulary, lookup_codes):
    """An alignment carrying one level lookup, plus whatever vocabulary the caller wants.

    Built by hand rather than through the producer, because the producer always emits a
    COHERENT pair — and the point is to check what the gate does with an incoherent one.
    """
    with cz.Table(root, axis=ALIGN_AXIS, n=2, key="unified_key",
                  attributes={"cyto_alignment": {"unified_levels": vocabulary}}
                  if vocabulary is not None else None) as t:
        t.string("unified_key", ["A", "B"])
        t.aux("entity_index", np.zeros((2, 2), dtype=np.int64), dtype="int64",
              role="alignment_entity_index", extent=[ALIGN_AXIS, "sources"])
        t.aux("levels__celltype__0", np.asarray(lookup_codes, dtype=np.int32),
              dtype="int32", role="alignment_level_lookup",
              extent=["levels_celltype_0"])
        return t.close()


def test_an_alignment_with_lookups_and_NO_vocabulary_is_refused(tmp_path):
    """The defect itself: lookups mapping into a list that exists nowhere. A consumer with
    no vocabulary renders integers where labels belong."""
    root = tmp_path / "novocab.zarr"
    structure = _alignment_with_levels(root, vocabulary=None, lookup_codes=[0, 1])
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("stamps no `cyto_alignment.unified_levels`" in v for v in violations), violations


def test_a_unified_code_PAST_THE_END_of_the_vocabulary_is_refused(tmp_path):
    root = tmp_path / "oob.zarr"
    structure = _alignment_with_levels(
        root, vocabulary={"celltype": ["B", "T"]}, lookup_codes=[0, 5]
    )
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("indexes past the end of the vocabulary" in v for v in violations), violations


def test_the_obs_axis_ABSENCE_code_is_not_treated_as_out_of_range(tmp_path):
    """`-1` is the ITEM-5 absence and indexes nothing by design — the positive control for
    the bound check, so it cannot be satisfied by refusing everything."""
    root = tmp_path / "absent.zarr"
    structure = _alignment_with_levels(
        root, vocabulary={"celltype": ["B", "T"]}, lookup_codes=[-1, 1]
    )
    assert conformance.conform_artifact(root, structure, full=True) == []


def test_a_vocabulary_for_a_column_with_NO_lookups_is_refused_as_stale(tmp_path):
    root = tmp_path / "stale.zarr"
    structure = _alignment_with_levels(
        root, vocabulary={"celltype": ["B", "T"], "ghost": ["X"]}, lookup_codes=[0, 1]
    )
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("no level lookup uses" in v for v in violations), violations


# ── T8 / S7 — `Table._claim`, the member-name guard that nothing exercised ────────
#
# T8: removing `self._claim(name)` from the member writers left this suite byte-identical.
# The guard covers three distinct failures and none had a test: writing after `close()`,
# a duplicate name, and a RESERVED name — `zarr.json` being the group node itself, so a
# member by that name overwrites the store's own metadata.
#
# S7 is the case the guard MISSED: `..` contains no `/`, so it passed the old check and
# `Table.aux("..", …)` resolved to the store's PARENT — a write outside the root. Not
# reachable from this producer's literal names, which is why it is low severity; it is
# fixed here because `cz.Table` is the writer EVERY producer in the tree shares, and
# a member name is the one part of a store path that can carry user-supplied column data.


def _open_table(tmp_path, name="t.zarr"):
    return cz.Table(tmp_path / name, axis="entities", n=2, key=None)


@pytest.mark.parametrize("bad", ["", "/", "a/b", "a\\b", ".", "..", "c", "zarr.json"])
def test_Table_REFUSES_an_unsafe_member_name(tmp_path, bad):
    """Each name is refused, and `..`/`.` are the ones the old guard let through."""
    with _open_table(tmp_path) as t:
        with pytest.raises(ValueError, match="invalid member name"):
            t.string(bad, ["x", "y"])


def test_a_TRAVERSING_member_name_would_have_written_OUTSIDE_the_store(tmp_path):
    """S7 stated as a consequence, not as a string comparison.

    The point is not that `..` is rejected — it is WHERE it would otherwise have written.
    This resolves the path the writer would have used and asserts it escapes the root, so
    the test states the impact rather than restating the check.
    """
    root = tmp_path / "store" / "t.zarr"
    assert (root / "..").resolve() == root.parent.resolve() != root.resolve()
    with cz.Table(root, axis="entities", n=2, key=None) as t:
        with pytest.raises(ValueError, match="traversal component"):
            t.aux("..", np.asarray([1, 2], dtype=np.int64), dtype="int64",
                  role="alignment_segment_start", extent=["segments"])


def test_Table_REFUSES_a_DUPLICATE_member_name(tmp_path):
    with _open_table(tmp_path) as t:
        t.string("a", ["x", "y"])
        with pytest.raises(ValueError, match="duplicate member name"):
            t.string("a", ["p", "q"])


def test_Table_REFUSES_a_write_AFTER_close(tmp_path):
    t = _open_table(tmp_path)
    t.string("a", ["x", "y"])
    t.close()
    with pytest.raises(RuntimeError, match="already closed"):
        t.string("b", ["p", "q"])


def test_a_SAFE_member_name_is_the_positive_control(tmp_path):
    """…and the guard must not refuse the names producers actually write.

    Without this, "refuses unsafe names" is indistinguishable from "refuses every name",
    which would break every producer in the tree while looking like a security fix.
    """
    with _open_table(tmp_path) as t:
        for good in ("values", "unified_key", "levels__celltype__0", "entity_index", "a.b"):
            t.string(good, ["x", "y"])
    assert (tmp_path / "t.zarr" / "values" / "zarr.json").exists()


# ── T7 — the `_conform_aux` refusal branches nothing exercised ───────────────────
#
# T7 reported "five branches". MEASURED by disabling each branch and running `_lib`, the
# real number is THREE, and they are not the five it names — six of its ten had acquired
# tests since it was filed. That is the same staleness class as the ledger's `status`
# field: a finding records what was true when it was written, and nothing updates it.
#
# The survey, per branch (`if …` → `if False and …`, `python3 -m pytest _lib`):
#
#     extents-without-aux        CAUGHT      duplicate member path      CAUGHT
#     empty aux list             CAUGHT      kind != numeric            CAUGHT
#     extents not a map          CAUGHT      unknown role               CAUGHT
#     extent not an integer      CAUGHT      extent count vs shape      CAUGHT
#     *** aux not a list         UNTESTED    *** aux entry not a dict   UNTESTED
#     *** absent/invalid extent  UNTESTED
#
# All three below are TYPE-CONFUSION branches — a producer emitting the wrong SHAPE of
# declaration rather than a wrong value. That is why they escaped: every existing test
# builds its structure through the real writer, which cannot produce them, so reaching
# them at all requires editing the structure after the fact.


def _aux_structure(tmp_path):
    """A real, conforming alignment plus its structure, ready to be corrupted."""
    root = tmp_path / "alignment.zarr"
    structure = an_alignment(root)
    assert conformance.conform_artifact(root, structure, full=True) == [], "fixture is not clean"
    return root, structure


def test_an_aux_key_that_is_NOT_A_LIST_is_refused(tmp_path):
    """`structure.aux` must be a list of members. A dict there resolves to nothing."""
    root, structure = _aux_structure(tmp_path)
    structure["aux"] = {"path": "segment_start"}        # a member, not a LIST of members
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("`aux` must be a list of members" in v for v in violations), violations


def test_an_aux_ENTRY_that_is_not_a_member_declaration_is_refused(tmp_path):
    """A non-dict ENTRY inside `aux` — the list is right, an element is not.

    Distinct from the case above and reached separately: the entry is skipped with a
    violation rather than crashing the gate, which is what lets the remaining members still
    be checked and reported in the same pass.
    """
    root, structure = _aux_structure(tmp_path)
    structure["aux"].append("segment_start")            # a NAME where a declaration belongs
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("not a member declaration" in v for v in violations), violations
    # …and the gate kept going: the other members were still conformed in the same pass.
    assert all("Traceback" not in v for v in violations), violations


@pytest.mark.parametrize("extent,why", [
    (None, "absent"),
    ([], "empty"),
    ("segments", "a bare string rather than a list"),
    ([""], "an empty name"),
    ([0], "a non-string name"),
])
def test_an_aux_member_with_NO_USABLE_extent_is_refused(tmp_path, extent, why):
    """The extent is an aux member's ONLY length rule — without it the bytes are unbounded.

    This is the branch that matters most of the three. `_conform_aux` exists precisely
    because an aux member sits outside `expect_rows=n`; a member whose `extent` is absent or
    malformed has therefore escaped every length rule in the module, which is the state the
    function's own docstring says this channel may not reach.

    **Only ONE of these five is uniquely pinned by the branch under test, and it is the
    dangerous one.** Measured: with the branch disabled, only `"segments"` — a bare STRING
    — goes red; the other four are caught downstream anyway. That is exactly why the string
    is the case worth having. A string is *iterable and indexable*, so it sails past the
    shape checks that reject the malformed-but-obvious forms and arrives looking like a list
    of single-character extent names. The others fail loudly whatever happens; this
    one is the shape that could be believed.

    Recorded rather than trimmed to the one case: the parametrization documents which forms
    are refused, and the redundancy is a property of the gate worth knowing. But no reader
    should take five green cases as five independent pins.
    """
    root, structure = _aux_structure(tmp_path)
    member = aux_of(structure, "segment_start")
    if extent is None:
        member.pop("extent")
    else:
        member["extent"] = extent
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("must be a non-empty list of extent names" in v for v in violations), (why, violations)


def test_the_UNCORRUPTED_alignment_is_the_positive_control(tmp_path):
    """…and none of the three refusals fires on a well-formed artifact.

    Without this, each test above is satisfied just as well by a gate that refuses
    everything — and a gate that refuses everything is indistinguishable from one that
    works, right up until a real producer runs.
    """
    root, structure = _aux_structure(tmp_path)
    assert conformance.conform_artifact(root, structure, full=True) == []


def test_an_EXTENT_on_an_ordinary_column_is_refused(tmp_path):
    """D7 — the doc said this was refused; nothing refused it.

    `_OPTIONAL_MEMBER_KEYS["extent"]` has always described a column carrying an `extent` as
    *"a second, independent length rule for the same bytes … the ambiguity this suite
    refuses"*. Measured: nothing outside `_conform_aux` read the key, so a column could
    carry any extent at all and conform clean. Same shape as D8 — a documented refusal with
    no implementation — and the class that has twice been the false premise on this branch.

    The column here is held to the axis's `n` AND names an extent, which is the ambiguity
    itself: two length rules for one set of bytes, with nothing able to say which governs.
    """
    root, structure = _aux_structure(tmp_path)
    structure["columns"][0]["extent"] = ["segments"]
    restamp(root, structure)
    violations = conformance.conform_artifact(root, structure, full=True)
    assert any("two independent length rules" in v for v in violations), violations


def test_an_extent_on_an_AUX_member_is_the_positive_control(tmp_path):
    """…and the refusal must not fire on the channel whose length rule IS an extent.

    Without this, "refuses an extent on a column" is satisfied by a gate that refuses every
    extent — which would condemn every conforming alignment in the system, since all of
    its segment members carry one. The uncorrupted fixture already exercises that path, so
    this asserts the discrimination directly rather than relying on it.
    """
    root, structure = _aux_structure(tmp_path)
    assert all("extent" in m for m in structure["aux"]), structure["aux"]
    assert conformance.conform_artifact(root, structure, full=True) == []
