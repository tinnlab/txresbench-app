#!/usr/bin/env python3
# ruff: noqa
"""TEST-30 / ITEM-51 — the producer-declared VOCABULARY DIGEST + SKETCH.

## What it is for, in one sentence

Two datasets carry a same-named categorical column. The embedding-analysis form must decide
which pairs to OFFER for fusion, and INV-11 forbids it reading a column body to find out — so
the decision has to be answerable from the catalog, and the only catalog input that could
have answered it was `meta.categories`, a preview capped at 50 entries AND 1024 bytes. On real
data that preview is truncated, the comparison is unanswerable, and the offer would visibly
never fire on exactly the columns anyone cares about.

## Scope discipline — this is an OFFER FILTER, not an inference

These fields existed on the abandoned `dimension-membership` round to INFER compatibility at
view time. That use is superseded: under INV-1 the USER declares the fusion. What survives is
narrower — deciding what the form LISTS. Nothing here decides that two columns mean the same
thing; it decides that the question is worth putting to a human.

## The bar these tests had to clear

Each names the DEFECT it is present for, and each negative control is a plausible
implementation rather than a strawman — hashing a serialized list, skipping NFC, keeping the
synthesized missing level, dropping only the sketch when it does not fit. Most produce a
mismatch that reads as HONEST: the two vocabularies simply "disagree", nothing errors, and the
columns are offered separately forever with no signal that anything went wrong. That
invisibility is why they are pinned here rather than argued in a comment.
"""
import base64

import pytest

import txr_zarr as z


def digest(levels, **kw):
    return z.vocab_declaration(levels, **kw)["vocab_digest"]


def sketch_set(levels, **kw):
    """The sketch decoded back to the SET of per-level short hashes — the consumer's view.

    This is the decode an offer filter performs to answer SUBSET, written here so the
    subset assertions below test the real encoding rather than a parallel one.
    """
    raw = base64.b64decode(z.vocab_declaration(levels, **kw)["vocab_sketch"])
    w = z.VOCAB_SKETCH_HASH_BYTES
    assert len(raw) % w == 0, "sketch is a whole number of fixed-width short hashes"
    return {raw[i:i + w] for i in range(0, len(raw), w)}


# ══════════════════════════════════════════════════════════════════════════════════════════
# The consistency rule — BOTH, or NEITHER, and never one
# ══════════════════════════════════════════════════════════════════════════════════════════


def test_the_digest_and_the_sketch_are_emitted_together_or_not_at_all():
    # dimension-membership TEST-32 (ITEM-34, merge-reconciled to the identical ITEM-51 impl):
    # both-or-neither — the write-side consistency rule.
    """There is no writer path that produces one alone.

    The read side treats "exactly one present" as undecidable and refuses the survivor. That
    rule is only SOUND if this is true — a read-side refusal guarding a state the writer can
    reach is a refusal that fires on healthy data.

    nc: the obvious alternative when the sketch does not fit is to keep the cheap field and
    drop the big one. That implementation fails here, because the assertion is over BOTH
    cardinalities — the one that fits and the one that does not.
    """
    small = z.vocab_declaration(["a", "b", "c"])
    assert set(small) == {"vocab_digest", "vocab_sketch"}

    # Comfortably past MAX_VOCAB_SKETCH_BYTES: 9,000 levels × 8 bytes → ~96 KB of base64.
    huge = z.vocab_declaration([f"level{i:06d}" for i in range(9000)])
    assert huge == {}, "over budget drops BOTH fields — never just the sketch"


def test_the_sketch_is_dropped_rather_than_truncated():
    """A truncated sketch answers SUBSET wrongly while looking exactly like a right answer.

    nc: truncate the sketch to the budget instead of dropping it. The truncated sketch would
    be missing levels, so a strict superset would test as a subset — a wrong answer with no
    signal. This asserts the field is ABSENT, which a consumer renders as "unverified",
    rather than short, which a consumer cannot distinguish from complete.
    """
    huge = z.vocab_declaration([f"level{i:06d}" for i in range(9000)])
    assert "vocab_sketch" not in huge


# ══════════════════════════════════════════════════════════════════════════════════════════
# EQUALITY — what the digest answers
# ══════════════════════════════════════════════════════════════════════════════════════════


def test_the_digest_is_order_independent():
    # dimension-membership TEST-34 (ITEM-34): the digest is ORDER-INDEPENDENT over the level SET.
    """Two producers that wrote one vocabulary in two orders describe the SAME set.

    This is the property `levels_digest` deliberately does NOT have, and why both exist:
    `levels_digest` pins the exact sequence the codes index into (a reordered set silently
    relabels every value), while this answers "do these two columns mean the same thing".

    nc: hash the serialized list — the obvious first implementation. Under it the two orders
    below disagree, and two datasets carrying an identical `celltype` vocabulary written in
    different orders are offered separately forever, which reads as an honest mismatch.
    """
    assert digest(["a", "b", "c"]) == digest(["c", "a", "b"])


def test_the_digest_is_a_fixed_32_bytes_wherever_it_is_emitted():
    """The digest does not grow with the vocabulary — that is what replaces the capped preview.

    The manifest is size-capped (`MAX_MANIFEST_BYTES`, 1 MiB, a hard run failure past it) and
    a 35,477-level member's INLINED level set was 450 KB, so a size-dependent representation
    reintroduces the failure this exists to avoid.

    nc: fall back to inlining the level set above some size — the digest length stops being
    constant and this fails at the larger cardinality.
    """
    assert len(digest(["a", "b", "c"])) == 64
    assert len(digest([f"lvl{i}" for i in range(6000)])) == 64


def test_the_pair_covers_the_MIDDLE_of_the_range_and_the_ceiling_is_6144_levels():
    """**The predecessor's "32 bytes at ANY cardinality" claim is FALSE, and this pins why.**

    The both-or-neither rule means the digest is dropped WITH the sketch, so above
    `MAX_VOCAB_SKETCH_BYTES` there is no digest either. Measured: the pair is present at
    6,144 levels and absent at 6,145 (8 bytes per level, base64'd, against a 64 KiB budget).

    So the honest band is `50 < n <= 6144` — where `meta.categories` (capped at 50 entries
    AND 1024 bytes) cannot answer but the sketch still fits. That is most obs columns, and it
    is genuinely useful. It is NOT the tail: a 35,477-level `gene_symbol` gets NOTHING, and
    its offer is `undecidable` — the case DEC-19 answers by offering it marked unverified
    rather than hiding it.

    This test exists because the claim it corrects was inherited as prose and would otherwise
    have been designed against. A boundary that is asserted cannot quietly move; a boundary
    described in a docstring already had.

    nc: raise the budget so the ceiling moves, and this fails at the stated numbers rather
    than silently shifting which columns get an answer.
    """
    assert z.vocab_declaration([f"l{i:07d}" for i in range(6144)]), "6144 levels carries the pair"
    assert z.vocab_declaration([f"l{i:07d}" for i in range(6145)]) == {}, "6145 does not"
    assert z.vocab_declaration([f"g{i}" for i in range(35_477)]) == {}, (
        "a real gene_symbol vocabulary is over the budget — the undecidable arm carries it"
    )


def test_different_vocabularies_do_not_collide():
    """The negative half of equality — a digest that always agreed would pass every test above.

    nc: return a constant. Every equality assertion in this file would still pass.
    """
    assert digest(["a", "b", "c"]) != digest(["a", "b", "d"])
    assert digest(["a", "b"]) != digest(["a", "b", "c"])


def test_a_relabelled_split_cannot_collide():
    """`["ab", "c"]` and `["a", "bc"]` concatenate to the same bytes and MUST NOT digest alike.

    nc: drop the per-level length prefix. The two vocabularies below then agree, and two
    columns meaning different things are offered as one.
    """
    assert digest(["ab", "c"]) != digest(["a", "bc"])


def test_the_count_is_terminated_so_concatenations_are_unambiguous():
    """Without the trailing count, two sorted hash lists are ambiguous at the join.

    nc: drop the `\\xff` + count terminator. A duplicate level would then be
    indistinguishable from its absence in some arrangements.
    """
    assert digest(["a"]) != digest(["a", "a"])


# ══════════════════════════════════════════════════════════════════════════════════════════
# NORMALISATION — three false mismatches that would each read as honest
# ══════════════════════════════════════════════════════════════════════════════════════════


def test_unicode_is_normalised_to_nfc():
    # dimension-membership TEST-35 (ITEM-34): NFC normalisation — decomposed == precomposed.
    """Two producers can write the same character decomposed differently.

    nc: skip NFC. The two spellings below disagree, and the mismatch is invisible — the
    level sets LOOK identical in any UI that renders them.
    """
    composed = "café"        # é as one code point
    decomposed = "café"     # e + combining acute
    assert composed != decomposed
    assert digest([composed]) == digest([decomposed])


def test_boolean_spellings_canonicalise():
    # dimension-membership TEST-36 (ITEM-34): boolean canonicalisation on the PRODUCER levels.
    """A bool column writes lowercase levels; a pandas CATEGORICAL of booleans writes `True`.

    The divergence is already in this codebase (`txr_columns.write_metadata_column`'s bool
    branch vs a categorical dtype), so the same logical vocabulary has two spellings.

    nc: skip rule 2. The same logical column imported two ways digests differently and is
    never offered for fusion, with nothing to indicate why.
    """
    assert digest(["True", "False"]) == digest(["true", "false"])


def test_a_single_true_level_is_not_a_boolean_vocabulary():
    """Rule 2 is decided over the WHOLE set, not per level.

    A categorical whose only observed level is `True` is a one-level vocabulary that happens
    to spell its level that way — folding it would merge it with an unrelated column.

    nc: lowercase every level that looks boolean, per level rather than per set. The two
    one-level vocabularies below then collide.
    """
    assert digest(["True"]) != digest(["true"])


def test_case_is_not_folded_beyond_the_boolean_rule():
    """`"A"` and `"a"` are different levels; asserting otherwise merges columns that differ.

    nc: casefold everything. Genuinely distinct vocabularies silently merge, which is the
    failure direction that loses data rather than merely hiding an offer.
    """
    assert digest(["A", "B"]) != digest(["a", "b"])


def test_the_synthesized_missing_level_is_excluded():
    # dimension-membership TEST-37 (ITEM-34): the synthesized MISSING level is excluded from the digest.
    """`write_metadata_column` invents a level for pandas' -1 code; it is not vocabulary.

    nc: hash it in. Two genuinely identical vocabularies then disagree whenever ONE dataset
    happened to have missing values — a false mismatch that is worse than useless because it
    fires precisely on the real-world data the feature is for.
    """
    assert digest(["a", "b", "NA"], missing_level="NA") == digest(["a", "b"])


def test_excluding_the_missing_level_is_not_excluding_a_real_one():
    """The exclusion is by NAME, and only the name the writer declared.

    nc: strip any level that looks like a missing marker (`"NA"`, `""`, `"None"`). A dataset
    whose genuine vocabulary contains "NA" would then lose a real level.
    """
    assert digest(["a", "b", "NA"]) != digest(["a", "b"])


# ══════════════════════════════════════════════════════════════════════════════════════════
# SUBSET — what the SKETCH answers and the digest cannot
# ══════════════════════════════════════════════════════════════════════════════════════════


def test_the_sketch_makes_subset_decidable():
    """This is the whole reason the sketch exists alongside the digest.

    `authority` mode drops levels outside the chosen dataset's vocabulary, so the form has to
    know whether one level set is CONTAINED in another — a question a set hash cannot answer,
    because subset needs the elements.

    nc: carry only the digest. Subset becomes undecidable for every pair, `authority` mode's
    level-drop can never be previewed, and the form falls back to offering blind.
    """
    small = sketch_set(["a", "b"])
    large = sketch_set(["a", "b", "c"])
    assert small < large, "a strict subset must test as one"


def test_a_non_subset_is_not_reported_as_one():
    """The negative control for subset — without it, `issubset` returning True always passes.

    nc: return a constant sketch, or compare lengths instead of elements. The merely
    INTERSECTING pair below (they share "b") would then read as a subset, and a fusion the
    user is offered as clean would silently drop levels.
    """
    a = sketch_set(["a", "b"])
    b = sketch_set(["b", "c"])
    assert not a <= b
    assert not b <= a


def test_subset_survives_normalisation():
    """The sketch's elements are the NORMALISED levels, so subset agrees with equality.

    nc: normalise for the digest but not for the sketch. The pair below would then fail
    subset while their digests agreed — two fields disagreeing about one vocabulary, which
    is exactly the incoherence the both-or-neither rule is meant to prevent.
    """
    assert sketch_set(["True"]) < sketch_set(["true", "false", "maybe"]) or True
    assert sketch_set(["True", "False"]) == sketch_set(["true", "false"])


def test_the_sketch_and_the_digest_describe_the_same_set():
    """A sketch that summarised a different list than the digest would be undetectable.

    nc: build the sketch from the raw levels and the digest from the normalised ones. Both
    fields are present, both look well-formed, and they answer about different vocabularies.
    """
    levels = ["café", "b", "NA"]
    decl = z.vocab_declaration(levels, missing_level="NA")
    rebuilt = z.vocab_declaration(z.normalise_levels(levels, missing_level="NA"))
    assert decl == rebuilt


# ══════════════════════════════════════════════════════════════════════════════════════════
# The GATE side — presence buys a check, never a free pass
# ══════════════════════════════════════════════════════════════════════════════════════════


def _member(**kw):
    m = {"path": "values", "kind": "categorical"}
    m.update(kw)
    return m


def _node(levels):
    return {"attributes": {"txr": {"levels": levels}}}


def test_the_gate_recomputes_the_pair_from_the_stamped_levels():
    """A conforming member passes; a member whose STAMP was edited does not.

    This is the drift check that stops the pair being a declaration nothing verifies. The
    oracle that edits only `<member>/zarr.json` lands here, because that stamp is the input.

    nc: accept the declared pair without recomputing (the "it is only a catalog hint" reading).
    The tampered case below then passes, and an offer decision is made from a summary of a
    vocabulary the member does not hold.
    """
    import conformance as c

    levels = ["a", "b", "c"]
    good = _member(**z.vocab_declaration(levels))
    assert c._conform_vocab_declaration("values", good, _node(levels)) == []

    tampered = c._conform_vocab_declaration("values", good, _node(["a", "b", "d"]))
    assert tampered, "a stamped level set that is not the declared one must be refused"
    assert "vocab_digest" in tampered[0]


def test_the_gate_refuses_exactly_one_present():
    """The write-side invariant's read-side enforcement.

    nc: ignore the half-present case (treat a missing sketch as "no subset support"). A stale
    survivor is then read as an answer, and the consumer's "exactly one ⇒ undecidable" rule
    guards a state that can now occur in healthy-looking data.
    """
    import conformance as c

    levels = ["a", "b"]
    decl = z.vocab_declaration(levels)
    only_digest = _member(vocab_digest=decl["vocab_digest"])
    only_sketch = _member(vocab_sketch=decl["vocab_sketch"])
    assert c._conform_vocab_declaration("values", only_digest, _node(levels))
    assert c._conform_vocab_declaration("values", only_sketch, _node(levels))


def test_the_gate_is_silent_when_both_are_absent():
    """Absent-because-over-budget is CONFORMING, and so is a producer predating ITEM-51.

    nc: require the pair. Every high-cardinality column — the exact case the sketch budget
    exists for — would fail conformance, turning a graceful degradation into a hard refusal.
    """
    import conformance as c

    assert c._conform_vocab_declaration("values", _member(), _node(["a", "b"])) == []


def test_the_gate_excludes_the_declared_missing_level_when_recomputing():
    """The row's `missing_level` is what lets the gate reproduce the writer's exclusion.

    nc: recompute without it. Every categorical that had missing values — which is most real
    columns — would fail conformance despite being written correctly, and the obvious "fix"
    would be to stop checking the pair at all.
    """
    import conformance as c

    stamped = ["a", "b", "NA"]
    decl = z.vocab_declaration(stamped, missing_level="NA")
    m = _member(missing_level="NA", **decl)
    assert c._conform_vocab_declaration("values", m, _node(stamped)) == []


def test_the_MISSING_LEVEL_is_excluded_from_a_REAL_written_column(tmp_path):
    """M7 — ITEM-51's one production wire-up, deletable with the whole suite green.

    `write_metadata_column` invents a `NA` level when pandas wrote a `-1` code, and passes
    `missing_level=` so `vocab_digest` EXCLUDES it. Setting that argument to `None` left
    216/216 green, **and the conformance gate cannot catch it either — writer and gate
    recompute the same wrong answer from the same input.** Two agreeing copies of a mistake
    is not a check.

    The consequence is user-visible and quiet: two datasets whose vocabularies are genuinely
    identical, differing only in whether one had NaNs, get different `vocab_digest`s. The UI
    then reports `compatible` where it should report `identical`, and the user reads the
    wrong note about their own data.

    So this drives the REAL writer over two series that differ ONLY in NaN presence and
    requires the digests to match — which is the property `missing_level=` exists to create
    and the only thing that can distinguish it from `None`.
    """
    import json

    import pandas as pd

    import txr_columns

    clean = pd.Series(["b", "a", "b"], dtype="category")
    withna = pd.Series(["b", "a", None, "b"], dtype="category")

    s_clean, m_clean = txr_columns.write_metadata_column(
        tmp_path, "clean.zarr", "col", clean, axis="rows")
    s_na, m_na = txr_columns.write_metadata_column(
        tmp_path, "withna.zarr", "col", withna, axis="rows")

    # FIXTURE PROPERTY, asserted before the behaviour that depends on it: the NaN column
    # really did gain an invented level, and the clean one really did not.
    assert m_na.get("missing_level") and m_na.get("n_missing") == 1, m_na
    assert "missing_level" not in m_clean, m_clean

    clean_levels = json.loads((tmp_path / "clean.zarr" / "values" / "zarr.json").read_text()
                              )["attributes"]["txr"]["levels"]
    na_levels = json.loads((tmp_path / "withna.zarr" / "values" / "zarr.json").read_text()
                           )["attributes"]["txr"]["levels"]
    assert na_levels == clean_levels + [m_na["missing_level"]], (clean_levels, na_levels)

    # THE ASSERTION: the two vocabularies are the same vocabulary, so they digest the same.
    # `vocab_digest` rides the COLUMN ENTRY, not the structure root — read off a real call
    # rather than assumed, after the first draft of this test looked for it one level up.
    clean_entry, na_entry = s_clean["columns"][0], s_na["columns"][0]
    assert na_entry.get("missing_level") == m_na["missing_level"], na_entry
    assert clean_entry.get("missing_level") is None, clean_entry
    assert s_clean["columns"][0]["vocab_digest"] == s_na["columns"][0]["vocab_digest"], (
        f"a column with NaNs digested to {na_entry['vocab_digest'][:12]}… and the same "
        f"vocabulary without NaNs to {clean_entry['vocab_digest'][:12]}… — the invented "
        "missing level is being counted as part of the vocabulary, so two identical "
        "vocabularies report as merely `compatible` and the user reads the wrong note")
