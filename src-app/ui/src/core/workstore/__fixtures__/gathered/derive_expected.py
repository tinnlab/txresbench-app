#!/usr/bin/env python3
"""Derive, from LABELS, what the route parity fixture's gathered column must contain.

    $ python3 src-app/ui/src/core/workstore/__fixtures__/gathered/derive_expected.py

Exit 0 and it prints the expected value sequence; exit 1 and the alignment does not hold
together (it says which part).

## Why this exists — the bytes cannot be their own oracle

`zarrReader.gatheredParity.test.ts` asserts the exact rows the serve path returns for the
`celltype` column of the `stage1_alignment` scene. The bytes it reads are captured from the
route by `gathered_chain_test.rs::the_route_reproduces_the_committed_parity_fixture`, which
re-captures on every run and fails on drift. **So the fixture proves the capture is current
and says nothing about whether it is RIGHT.** The assertion is the only independent statement
of what the correct rows are, and updating it to agree with the captured bytes would convert
INV-3 from a claim about the gather into a tautology that passes against any gather —
including the two that served rows from the wrong dataset and labels from the wrong source
earlier in this stage.

This script is that independent statement, made re-runnable. It does NOT consult the Rust
gather, the captured bytes, or the client assertion. It goes back to the LABELS:

  1. each source's stored codes + its own DECLARED level list  → the label on each source row
  2. the alignment's SEGMENT TABLE (range search + subtraction) → which (source, row) each
                                                                 output row addresses
  3. the unified vocabulary on the alignment's group attributes → label → unified code

A label is what the data MEANS; a code is an encoding of it. Deriving through the labels
is what makes this an oracle rather than a second copy of the implementation.

## WHAT WOULD HAVE TO DIFFER FOR THIS TO FAIL — traced, not asserted

A derivation that reads the same bytes the assertion reads, in the same order, through the
same helper, cannot disagree with them: it is the bytes agreeing with themselves in a longer
form. So here is where the two routes actually diverge, measured in the implementation:

* **The Rust gather computes the served codes from the `levels__<column>__<src>` LOOKUP
  ARRAYS** (`gather_exec.rs:371-372` → `gathered::remap_codes`). It **never reads a source's
  own declared level list** — `sources/<level entry>.zarr/values/zarr.json` →
  `attributes.txr.levels` appears nowhere on that path.
* **This script computes them from exactly that list**: stored code → the source's own
  declared label → that label's index in the unified vocabulary. It does not use the lookup
  arrays to produce the answer.

So a wrong lookup array — the defect that labelled one dataset's rows with another source's
levels — moves the BYTES and leaves this derivation unmoved. That is the disagreement this
file exists to be capable of, and the cross-check below makes it loud instead of merely
possible.

**The honest boundary:** both routes read the same segment table, so this is an oracle for
the GATHER (does it resolve the right source row and encode the right level), not for whether
the producer's segment table is itself correct. The structural check below closes as much of
that as is checkable from here — segment lengths against the independently declared
`meta.sources[].n_rows` — and what remains is stage 1's contract, not this test's.

## The two traps this script is written around

* **The row layout is RECONSTRUCTED from the segment table (D18), not read from a per-row
  vector.** Output row `i` belongs to the segment whose `[segment_start, segment_end)` range
  contains it; that segment's `segment_order` is the source's `declared_order` and `i -
  segment_start` is the row within the source. The segment arrays are sorted by dataset id,
  so a reader that iterates them instead of range-searching gets the wrong ranges — and when
  array order and declared order coincide a wrong reader is indistinguishable from a right
  one. This cost a CRITICAL. Reconstructed below rather than assumed.
* **A source's level codes are in ITS OWN space.** `levels__<col>__<src>` maps them to the
  unified space and `-1` means the level was dropped. This script never assumes a source's
  codes are already unified — it resolves the LABEL and looks that up, which cannot silently
  agree with a wrong lookup table the way a code-to-code comparison can.

## Re-running it

A derivation nobody can re-run is a derivation that happens once. Stage 1 changed ds-a's
`celltypes` from `["T", "B"]` to `["T", "Mono"]` (so an `authority` run could actually drop a
level and emit `-1`), which moved the unified vocabulary and therefore every expected value.
The Rust side was updated; the client assertion was not, and drifted silently for four
rounds. Run this after ANY change to `emit_reference_alignment.py` or to the engine.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[6]
PACKAGES = REPO / "src-app" / "packages"
# The parity scene uses `stage1_alignment` (`gathered_chain_test.rs::producer_scene`).
# Overridable so the derivation can be run against the OTHER reference fixtures — which is
# also this script's own control: on `stage1_alignment_reversed` the segment orderings
# genuinely disagree, so a run there that still reported COINCIDE would mean the
# declared-order inversion below is not doing anything.
FIXTURE_NAME = sys.argv[1] if len(sys.argv) > 1 else "stage1_alignment"
FIXTURE = REPO / "src-app" / "server" / "tests" / "fixtures" / FIXTURE_NAME
# The ALIGNMENT's name for the fused column — the key into `unified_levels` and into
# `levels__<column>__<source>`. It is NOT the member path inside a source store: stage 1's
# slot rework gives each grid entry its own `metadata-column` artifact whose member is always
# `values`, with the column name carried by the SLOT (`level:<i>:group`). Those were one
# string while every column lived in one `rows.zarr`; they are two now, and the gather keys
# the level lookups on THIS one.
COLUMN = "group"
# The member every per-dataset source store holds. Constant by the datatype's own rule, not
# by coincidence of this fixture.
MEMBER = "values"

sys.path[:0] = [str(PACKAGES / "_lib"), str(PACKAGES / "_helpers")]
import txr_zarr_read as czr  # noqa: E402


def die(msg):
    print(f"DERIVATION FAILED: {msg}", file=sys.stderr)
    raise SystemExit(1)


def ints(root, member):
    return [int(v) for v in czr.read_array(root, member)]


def main():
    align = FIXTURE / "alignment.zarr"
    if not align.exists():
        die(f"no alignment fixture at {align}")

    # ── (3) the unified vocabulary — read, never reconstructed ────────────────────
    attrs = json.loads((align / "zarr.json").read_text()).get("attributes", {})
    unified = (attrs.get("txr_alignment", {}).get("unified_levels", {}) or {}).get(COLUMN)
    if not unified:
        die(f"the alignment declares no unified_levels for {COLUMN!r}")
    code_of = {label: i for i, label in enumerate(unified)}
    # ── DEC-27 — a label the unified vocabulary LACKS takes the DECLARED missing level ─────
    #
    # The oracle is a SCENARIO-guard, and this scenario changed. It used to `die` on a label
    # absent from the vocabulary, and that was the right statement of the old encoding: a
    # dropped level was a `-1`, which the serve path refused, so no correct output row
    # existed. Under the missing-level mechanism the vocabulary carries a real appended entry
    # and every absent label resolves to it, so refusing here would make the oracle disagree
    # with a correct gather.
    #
    # This is stage 1's rule applied to the derivation itself: *when an encoding changes, sort
    # the guards by whether their subject is the VALUE or the SCENARIO.* The `die` below stays
    # for a vocabulary that declares NO missing level, which really is unencodable.
    #
    # It remains an independent route to the answer: the missing level is read from the
    # alignment's own `missing_levels[<column>]` declaration, never from the served bytes and
    # never from the lookup tables the gather uses.
    missing_level = (attrs.get("txr_alignment", {}).get("missing_levels", {}) or {}).get(COLUMN)
    if missing_level is not None and missing_level not in code_of:
        die(f"the alignment declares missing level {missing_level!r} for {COLUMN!r}, which is "
            f"not in its own unified vocabulary {unified} — the two disagree")

    # ── which source index is which dataset (BY NAME, never by position) ──────────
    entry = json.loads((FIXTURE / "manifest.json").read_text())["outputs"][0]
    sources = entry["meta"]["sources"]
    index_of = {s["dataset_id"]: i for i, s in enumerate(sources)}

    # ── dataset id → its GRID INDEX → the MOUNT DIRECTORY its bytes are staged under ─
    #
    # These are two different strings and conflating them is the defect stage 1's identity
    # work fixed. The mount name is `sanitize(slot)[+ ".zarr"]` disambiguated positionally
    # (`rows.zarr`, `rows_1.zarr`) — a pure function of the SLOT, carrying no dataset identity
    # at all. The identity arrives separately, as `params.dataset_ids`, RELAYED POSITIONALLY
    # against the slot's binding order.
    #
    # After the slot rework the relay does one more job: `<i>` in the slot FAMILIES
    # `entity:<i>:<column>` and `level:<i>:<column>` indexes this same list, so a dataset's
    # GRID INDEX is what addresses its entries. That index is declared, not derived — which is
    # why the per-dataset stores below are found by slot NAME, and only the ordered literal
    # slot `rows` is addressed by position.
    #
    # Positional is not a workaround: `sandbox/inputs.rs:536-549` says an identity-keyed mount
    # scheme would produce distinct-but-misaligned mounts, so binding order is the contract
    # the runner deliberately offers.
    #
    # THE RELAY IS CROSS-CHECKED, because a relay believed on its own is how a mis-ordered
    # one stays silent. `params.dataset_content_hashes[<id>]` must equal the content hash
    # `inputs.json` recorded for that binding — two channels (the launcher writes params, the
    # runner writes inputs.json), so a swap moves one and not the other.
    #
    # LIMIT, named rather than left implicit: in THIS fixture both channels are written by
    # `emit_reference_alignment.py`, so they are self-consistent by construction and the
    # cross-check cannot fail here. It discriminates on a REAL run, where the two documents
    # have different authors. A check that cannot fail against the fixture it is tested on is
    # exactly what stage 1's first attempt shipped — comparing two relayed lists to each
    # other — so this file states the boundary instead of implying coverage it lacks.
    wire = json.loads((FIXTURE / "sources" / "inputs.json").read_text())["inputs"]
    params = json.loads((FIXTURE / "sources" / "params.json").read_text())
    relayed = list(params.get("dataset_ids") or [])
    # The cross-check rides the `rows` bindings, because `dataset_content_hashes` is keyed to
    # them: `rows` is the one slot bound once per dataset IN ORDER, so it is the only place
    # the relay's positional claim is checkable at all.
    bound = [e for e in wire if e.get("slot") == "rows"]
    if len(relayed) != len(bound):
        die(f"params relays {len(relayed)} dataset id(s) for {len(bound)} bound `rows` "
            "mount(s) — the relay is positional, so a length mismatch means it addresses "
            "the wrong ones")
    hashes = params.get("dataset_content_hashes") or {}
    grid_index_of, rows_mount_of = {}, {}
    for pos, (ds, binding) in enumerate(zip(relayed, bound)):
        declared = hashes.get(ds)
        actual = binding.get("content_hash")
        if declared is not None and actual is not None and declared != actual:
            die(f"the relay puts {ds!r} at binding {pos}, whose staged content hash is "
                f"{actual!r}, but params records {declared!r} for {ds!r}. The relay is "
                "mis-ordered — every row would be attributed to the wrong dataset")
        grid_index_of[ds] = pos
        rows_mount_of[ds] = binding["sandbox_path"].rsplit("/", 1)[-1]
    missing = [ds for ds in index_of if ds not in grid_index_of]
    if missing:
        die(f"the alignment names source(s) {missing} that the relay does not place at any "
            f"grid index (relayed: {relayed})")

    # Each dataset's fused-categorical entry, found by SLOT NAME. The grid index is what joins
    # it to the dataset; the mount directory is a positional artefact of the runner and says
    # nothing.
    def entry_mount(ds, family):
        slot = f"{family}:{grid_index_of[ds]}:{COLUMN}"
        hits = [e for e in wire if e.get("slot") == slot]
        if len(hits) != 1:
            die(f"slot {slot!r} is bound {len(hits)} time(s); a grid entry is bound exactly "
                "once, so any other count means the coordinate is not what this derivation "
                "thinks")
        return hits[0]["sandbox_path"].rsplit("/", 1)[-1]

    level_mount_of = {ds: entry_mount(ds, "level") for ds in index_of}
    print("relay: " + ", ".join(
        f"{ds} -> grid {grid_index_of[ds]} (rows {rows_mount_of[ds]}, "
        f"level {level_mount_of[ds]})" for ds in relayed))

    # ── (1) each source row's LABEL, through that source's OWN declared levels ────
    #
    # INDEPENDENT CROSS-CHECK OF THE BINDING, and it can fail: the level store stamps
    # `aligned_to` from its own bytes, while `meta.sources[].key_sequence_digest` is the
    # alignment's separate record. Bind the wrong grid entry and they disagree — which they
    # WOULD on `stage1_alignment_reversed`, where the grid order is the opposite of
    # `meta.sources`. Without this, a derivation that mis-resolved every entry would still be
    # internally consistent and would silently derive the wrong answer.
    labels_by_source = {}
    for ds in index_of:
        root = FIXTURE / "sources" / level_mount_of[ds]
        store_attrs = json.loads((root / "zarr.json").read_text()).get("attributes", {})
        stamped = (store_attrs.get("txr") or {}).get("aligned_to")
        pinned = sources[index_of[ds]].get("key_sequence_digest")
        if stamped is not None and pinned is not None and stamped != pinned:
            die(f"{ds!r} was resolved to {level_mount_of[ds]}, which declares aligned_to="
                f"{stamped!r}, but the alignment pins {pinned!r} for {ds!r} — the grid "
                "resolution is off and every label below would come from the wrong source")
        declared = (
            czr.read_meta(root, MEMBER).get("attributes", {}).get("txr", {}).get("levels")
        )
        if declared is None:
            die(f"source {ds!r} stamps no declared levels on {MEMBER!r}")
        codes = ints(root, MEMBER)
        for c in codes:
            if not 0 <= c < len(declared):
                die(f"source {ds!r} row code {c} is outside its declared levels {declared}")
        labels_by_source[ds] = [declared[c] for c in codes]

    # ── (2) which (source, row) each OUTPUT row addresses ─────────────────────────
    #
    # Since D18 there is NO per-output-row vector: output row `i` reconstructs to its
    # (source, row-within-source) from the SEGMENT TABLE alone. Each segment covers a
    # DECLARED-ORDER-CONTIGUOUS output range `[segment_start, segment_end)`; the segment
    # containing `i` names the source (its `segment_order` / declared order) and `i -
    # segment_start` is the row within that source — exactly the pair the dropped
    # `row_segment` / `row_source` vectors used to carry.
    seg_dataset = ints(align, "segment_dataset")
    seg_start = ints(align, "segment_start")
    seg_end = ints(align, "segment_end")
    seg_order = ints(align, "segment_order")

    # `segment_order` is a DECLARED ORDER. Invert it to get the array index. Kept for the
    # coincide diagnostic below and to guard that the orders form a permutation.
    by_declared_order = {}
    for ix, declared in enumerate(seg_order):
        if declared in by_declared_order:
            die(f"segment_order declares {declared} twice — it is not a permutation")
        by_declared_order[declared] = ix
    # Say out loud whether the two coincide here. When they do, an implementation that
    # indexed the arrays directly would pass — so this is the line that tells a reader
    # whether this fixture can discriminate that bug at all.
    coincide = all(by_declared_order[d] == d for d in by_declared_order)
    print(f"segment_order = {seg_order}  (declared-order and array-index "
          f"{'COINCIDE — this fixture cannot catch a direct-index reader' if coincide else 'DISAGREE'})")

    # ── STRUCTURAL: the segment table against an INDEPENDENT declaration ─────────
    #
    # `meta.sources[].n_rows` is declared separately from the segments, so checking the
    # segments against it can actually fail. Without this, a corrupted segment table would be
    # read identically by this script and by the gather, and both would agree — the shared
    # input named in the boundary note above.
    dataset_at = {i: ds for ds, i in index_of.items()}
    for seg in range(len(seg_order)):
        ds = dataset_at.get(seg_dataset[seg])
        if ds is None:
            die(f"segment {seg} names source index {seg_dataset[seg]}, absent from meta.sources")
        declared_rows = sources[index_of[ds]].get("n_rows")
        span = seg_end[seg] - seg_start[seg]
        if declared_rows is not None and span != declared_rows:
            die(f"segment {seg} ({ds}) spans {span} output rows but meta.sources declares "
                f"n_rows={declared_rows} — the segment table and the source record disagree")
        if span != len(labels_by_source[ds]):
            die(f"segment {seg} ({ds}) spans {span} output rows but the source's stored "
                f"column has {len(labels_by_source[ds])} — a short or long read")

    # Resolve each output row to its segment by a RANGE SEARCH — the reconstruction the Rust
    # reader does. This is also the PARTITION check: overlaps land two segments on one row,
    # gaps leave a row with none, and both are refused here rather than read past silently.
    n_out = max((int(e) for e in seg_end), default=0)
    segment_at_row = {}
    for seg in range(len(seg_order)):
        for i in range(int(seg_start[seg]), int(seg_end[seg])):
            if i in segment_at_row:
                die(f"output row {i} falls in two segments — the segment ranges overlap")
            segment_at_row[i] = seg
    if len(segment_at_row) != n_out:
        die(f"the segments cover {len(segment_at_row)} distinct rows but span up to {n_out} "
            "— the segment ranges do not partition the output")

    values, trace = [], []
    for i in range(n_out):
        seg = segment_at_row.get(i)
        if seg is None:
            die(f"output row {i} is covered by no segment")
        declared = seg_order[seg]
        ds = dataset_at.get(seg_dataset[seg])
        if ds is None:
            die(f"segment {seg} names source index {seg_dataset[seg]}, which meta.sources lacks")
        # `start_row`/`end_row` bound the OUTPUT row space; `i - start_row` is the row index
        # WITHIN the source — the value `row_source` used to carry (D18).
        src_local = i - int(seg_start[seg])
        if not 0 <= src_local < len(labels_by_source[ds]):
            die(f"output row {i} addresses source row {src_local} of {ds!r}, which has "
                f"{len(labels_by_source[ds])} rows")
        label = labels_by_source[ds][src_local]
        if label not in code_of:
            if missing_level is None:
                die(f"output row {i} resolves to label {label!r}, absent from the unified "
                    f"vocabulary {unified}, and the alignment declares NO missing level for "
                    f"{COLUMN!r} — a gather cannot encode it")
            code, shown = code_of[missing_level], f"{label!r} (dropped) -> {missing_level!r}"
        else:
            code, shown = code_of[label], f"{label!r}"
        values.append(code)
        trace.append(f"  row {i}: segment {seg} ({ds}) row {src_local} -> {shown} -> {code}")

    # ── CROSS-CHECK: the lookup tables the GATHER actually uses ───────────────────
    #
    # Everything above went label → unified code. The Rust gather does NOT do that: it
    # remaps each source's stored code through `levels__<column>__<source_index>`. Those are
    # two independent routes to the same answer, so comparing them is a real check rather
    # than a restatement — a wrong lookup table is exactly the defect that labelled one
    # dataset's rows with another source's labels, and a label-only derivation would
    # not have seen it.
    for ds, src_ix in index_of.items():
        member = f"levels__{COLUMN}__{src_ix}"
        if not (align / member).exists():
            die(f"the alignment declares no {member} for source {ds!r}")
        lookup = ints(align, member)
        root = FIXTURE / "sources" / level_mount_of[ds]
        declared = czr.read_meta(root, MEMBER)["attributes"]["txr"]["levels"]
        if len(lookup) != len(declared):
            die(f"{member} has {len(lookup)} entries for {len(declared)} declared levels "
                f"of {ds!r} — a stored code could index past the end")
        for local, label in enumerate(declared):
            got = lookup[local]
            if got == -1:
                # ABSENT, the OLD encoding. Now unreachable by construction — DEC-27 points a
                # dropped level at the declared missing level instead — but the check stays,
                # because a `-1` arriving here would mean the producer regressed to an
                # encoding the serve path still (correctly) refuses. That is a VALUE-guard:
                # its subject did not change.
                if label in code_of:
                    die(f"{member}[{local}] is -1 (absent) but {label!r} IS in the unified "
                        f"vocabulary — the lookup drops a level the vocabulary keeps")
                continue
            # DEC-27 — a label the vocabulary lacks must map to the DECLARED missing level,
            # and to nothing else. Checking it here is what makes the two routes independent:
            # this side reaches the code through the LABEL and the declaration, the gather
            # reaches it through this very table, and they must still agree.
            expect_code = code_of.get(label)
            if expect_code is None and missing_level is not None:
                expect_code = code_of[missing_level]
            if got != expect_code:
                die(f"{member}[{local}] = {got}, but {label!r} is unified code "
                    f"{expect_code}. The lookup table and the vocabulary disagree, so "
                    f"a gather through it relabels {ds!r}'s rows")
    print(f"lookup tables agree with the vocabulary for all {len(index_of)} sources")

    print(f"unified_levels[{COLUMN!r}] = {unified}")
    print(f"missing_levels[{COLUMN!r}] = {missing_level!r}")
    for ds in index_of:
        print(f"  {ds} labels = {labels_by_source[ds]}")
    print("\n".join(trace))
    print(f"\nEXPECTED (derived from labels) = {values}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
