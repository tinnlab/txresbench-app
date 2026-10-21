#!/usr/bin/env python3
# ruff: noqa
"""conformance — the FRAMEWORK-OWNED gate every emitted artifact passes (ITEM-18/19, DEC-8).

A processor may do anything. What it EMITS is not negotiable, and the thing that checks
it is not the processor author's to write. That asymmetry is the whole point: the same
agent that writes a bug writes the test that certifies it, so an author-written
"my output is fine" test is worth nothing. This module is the other half — it reads only
the emitted BYTES plus the producer's own DECLARATION and says whether the two agree.

## What makes it framework-owned STRUCTURALLY, not by convention (DEC-8)

Four properties, all mechanical:

1. **It lives in the framework tree.** `_lib` is a reserved `_`-prefixed package that
   contributes no datatype, converter or view; a processor package cannot shadow it, and
   the folder-scan registry skips `_`-prefixed dirs entirely.
2. **A processor cannot call it, and cannot NOT call it.** It runs OUTSIDE the processor's
   process — over the emitted `/outputs` directory, after the job exits. It is deliberately
   NOT imported by `cyto_zarr` / `cyto_csc`: those are staged into the sandbox `/code` dir
   and run as the processor, so a gate living there would be a gate the processor's own
   process executes, which is the arrangement DEC-8 rules out ("invoked by the ingest path,
   not by the processor").
3. **Its only inputs are the emitted bytes and the producer's declaration.** `conform_outputs`
   takes a DIRECTORY. It never opens the emitting package's `manifest.yaml`, never imports
   processor code, and reads no environment.
4. **There is no key that turns it off.** Not in `manifest.yaml`, not as a keyword argument,
   not as an environment variable, not as a field on the output entry. `gate()` takes exactly
   `(root, structure)` and consults nothing else — so "declare an opt-out" has nowhere to be
   declared. `test_conformance.py` asserts this by trying every opt-out shape and showing the
   verdict is byte-identical each time.

The absence of a knob is the enforcement. A `skip_conformance: true` a processor puts in
its manifest is inert data that nothing reads; a `conformance=False` it passes to a writer
is a `TypeError`.

### The knob that WAS here: `encoding: "opaque"`

Property 4 is about keys named like switches, and it held. The hole was a key that is not
named like one: `structure.encoding`. `"opaque"` routes to the branch that checks no
member structure — correctly, because an HTML report has none — and NOTHING cross-checked
the claim. So a producer emitting a Zarr store declared it `opaque` and every byte-level
check in this file was skipped for that artifact. A declaration that selects how hard the
gate looks, and that only the producer writes, IS an opt-out however it is spelled.

`_conform_opaque` now falsifies the claim instead of trusting it: an `opaque` artifact
whose bytes are a Zarr store, whose declaration also carries structured-artifact keys, or
whose bytes contradict its own declared media type is a violation. `opaque` stays
declarable — it just stops being unfalsifiable, which is the property that made it a knob.

### The knob after that one: an ABSENT declaration

`opaque` was a key whose VALUE selected a shallower branch. The next shape is a key whose
ABSENCE does, and it needs the same treatment for the same reason. Two were live:

* **`structure.key` omitted.** `_conform_key` returned `[]` and `conform_manifest` dropped
  the artifact from its axis's alignment group — switching off the exact mechanism §0.3
  names for catching row-order misalignment, by writing nothing at all. It is now falsified
  against the artifact's OTHER declaration: `meta.is_axis_index: true` says this row IS the
  axis the server resolves (INV-3), so omitting the key member contradicts it. For that
  cross-check to be possible the server had to stop stripping `meta` out of the gate
  manifest (`jobs::conformance::build_gate_manifest`), which it did.
* **a string member's value sequence never declared at all.** See `_conform_string_member`:
  the offsets are a degree of freedom the bytes do not pin, so the sequence is declared
  (`values_digest`, by the writer, for EVERY string member) and recomputed here. Absence is
  a violation, which is what stops "declare nothing" from being the cheapest opt-out.

### Retiring the class instead of patching instance N+1

Both of those were found and closed ONE AT A TIME, and a third was then found in the same
shape, which is the signal that the fix was at the wrong altitude. The root cause was
mechanical and it was here: **`_conform_member` treated every member key as `.get()`,
i.e. as optional.** A producer omitting one therefore chose how hard the gate looked at
its own member — the definition of an opt-out (DEC-8) — and each omission had to be
discovered before it could be refused. Measured before the fix (`full=True`, restamped so
the group/row drift check could not mask it), the gate was **SILENT** for: a member `dtype`
omitted; `shape` omitted; `inner_chunk` + `chunks_per_shard` both omitted; `kind`
downgraded from `categorical` to `numeric` (dropping the level-set check with it); and a
member DROPPED from `columns` altogether, whose bytes then sat in the store with nothing
in this suite ever looking at them.

So absence is now refused BY CONSTRUCTION rather than case by case, in three places:

1. **[`_REQUIRED_MEMBER_KEYS`]** — the keys a member declaration must carry, per kind,
   checked before anything is read. A key not in that table and not in
   [`_OPTIONAL_MEMBER_KEYS`] is unknown to the gate, which is itself a violation: that is
   what makes the table exhaustive rather than a list somebody has to remember to extend.
2. **[`_OPTIONAL_MEMBER_KEYS`]** — the ones that are genuinely optional, each carrying the
   REASON its absence cannot make the gate look less hard. Explicit optionality is
   INV-2-legal ("`required: false` is fine"); silent optionality is what was not.
3. **[`_conform_node_coverage`]** — every Zarr node in the store must be DECLARED by some
   member, so dropping a member from `columns` is refused instead of quietly removing that
   member's bytes from the check. This is the absence of a whole declaration rather than of
   a key, and it is the strongest of the three because it is the one that costs nothing to
   write.

The `kind`-downgrade row of that matrix is closed from the other side as well, by
[`_conform_member_attributes`] — see the section below.

What is NOT claimed: a positional numeric column's row order still cannot be checked from
its bytes — it carries nothing that identifies its rows. That is a limit of the data, not a
knob, and inventing an inference for it would be the guessing this module refuses elsewhere.

### The SECOND copy of a member's declaration is cross-checked too

`_conform_group_attributes` compares the GROUP's stamped `attributes.cyto` against the
`structure` the row carries, on the stated grounds that "two copies that can drift is
exactly the class of bug this suite exists for". `write_array` writes a second copy per
MEMBER (`attributes.cyto.{kind, name, levels, ordered, layout, n, role}`) and nothing
compared it. Oracle: corrupt ONLY `<member>/zarr.json`'s `attributes.cyto.{kind, levels}`
— leave the row, the group stamp and every byte untouched — and the gate reported `[]`
while a consumer holding nothing but the store URL (`§0.3`'s first-class client;
`cyto_zarr_read.read_column` is the reference implementation) decoded a categorical
member's raw codes `[0, 1, 0, 1]` where `structure` says `['x', 'y']`. Latent only because
the browser reader happens to prefer the row's `levels`.

[`_conform_member_attributes`] compares them. It also makes the stamp REQUIRED: a member
node with no `attributes.cyto` is a member a store-URL consumer learns nothing about, which
is the same absence-as-opt-out shape one level down.

### …and the class had moved one level down WITH it

The section above says the class is retired. It was not: it had moved into the copy of the
declaration this section added, and the fix and the claim were written in the same pass, so
nothing measured the new level. Three holes, all the same shape, all measured against the
code as it stood:

* **a key absent from the STORED STAMP.** The comparison loop read each key with `in` and
  `continue`d when the stamp did not carry it, so an absent stamped key skipped its
  comparison instead of failing it. `levels` and `ordered` had a bespoke `if` — which is what
  closing a class for the instances somebody thought of looks like — and the load-bearing one
  did not: popping ONLY `attributes.cyto.kind` out of a categorical member's `zarr.json` left
  the gate silent while `cyto_zarr_read.read_column` handed back raw `uint8` codes in place of
  labels. Measured over `a_table`'s three kinds, **8 of 10** stamp-key absences were silent.
  Now: [`_REQUIRED_STAMPED_KEYS`] (per kind, each key mapped to what a store-URL consumer
  decodes with it) + [`_OPTIONAL_STAMPED_KEYS`] (each with the reason its absence cannot
  weaken the gate) + an unknown-key report, i.e. the same three-part shape the ROW's tables
  have; and [`_stamped_key_violations`], where ABSENCE IS A VALUE ([`_ABSENT`]) and all four
  presence combinations are enumerated, so there is no `continue` for an absent key to reach.
* **a DECLARED node with nothing behind it, for one kind only.** `_conform_member` read the
  member's own `zarr.json` AFTER the `kind == "string"` fork, and
  `_conform_member_attributes` swallowed its own read failure ("the caller reports that" — the
  caller did, for two kinds out of three). So deleting a string member's `zarr.json` outright
  was reported by nobody, while the same deletion on a numeric or categorical member was
  refused. `_conform_node_coverage` could not see it either: it checked `stored ⊄ declared`
  and never the reverse. Now the read happens ONCE, before the fork, for every kind
  ([`_read_member_node`]), and the coverage check does BOTH directions — a set difference has
  two sides, and checking one of them is what made a per-kind exception expressible.
* **the `c/` chunk directory.** The node walk skips it, correctly (it holds shard files, not
  nodes) — but skipping is not checking, and it was the one place in a store where bytes were
  neither declared nor reported: a file at `<member>/c/evil`, and even a whole node at
  `<member>/c/sneaky/zarr.json`, produced `[]`. [`_chunk_dir_violations`] now holds the dir to
  what it is for: every entry under it is a chunk of THIS member, named by chunk index.
* **…and the chunk plane AGAIN, because "named by chunk index" is not "is a chunk".** The
  fix above shipped a NAME rule ([`_CHUNK_KEY_RE`]) and no GRID rule, and called the file
  rule total. Any numerically-named entry under any node's `c/` was therefore accepted:
  `value/c/7` on a member with ONE shard, `value/c/00000000123456789`, 5 MiB of random bytes
  at `value/c/1`, `xy/c/0/1` where the width is a single chunk, `<root>/c/0` and `label/c/0`
  under GROUP nodes that own no chunks at all, and 6 MiB across two planes through the real
  `conform_outputs` entry — every one of them `[]`. The class had moved one step: the earlier
  rounds closed *"absence skips a check"* at the row, at the stamp and at the `full`
  parameter, `c/` closed *"the walk does not look there"*, and this one closes **"the walk
  looks but does not know what belongs there."** [`_chunk_grid`] derives the key space from
  the node's own declaration and [`_chunk_key_place`] holds each entry to it, so an in-grid
  cell is READ by `_decode` and everything else is REPORTED, with no third outcome.
* **…and the GRID RULE ITSELF, because "I could not derive one" switched it off.** The fix
  above answered `None` for metadata it could not turn into a grid, which fell back to the
  name rule as the whole check — the same class again, now INSIDE the function written to
  close it. It was a live lever, not a theoretical one: an arity-mismatched member (`shape
  [200]` against `chunk_shape [4096, 4096]`) carried 12,003,461 bytes at `value/c/999`
  through the real `conform_outputs` entry for `[]`, on every node kind and at both depths,
  while `zarrReader.ts`'s `#assertRowChunked` throws on that same metadata — the gate was
  passing an artifact the shipped client cannot open. The docstring claimed the `None` arm
  "cannot be used as a lever because every path reaching it is already a failing path";
  THREE of its nine shapes were silent (arity, a float extent, a float-or-string step),
  because the checks it named read `shape` and `chunk_shape[0]` and nothing else. Now there
  is no third answer to select: [`_UnderivableGrid`] IS a
  violation ([`_underivable_grid_violation`]), reported unconditionally for any node that
  holds a chunk plane its own document cannot describe.
* **…and a required key of the wrong TYPE, which is the same lever with the value left in
  place.** The tables above made a key's ABSENCE a violation and left its TYPE to the
  producer, so every use of `shape` still sat behind an `isinstance(…, list)` guard: a
  SCALAR switched those uses off exactly the way omitting the key once did, including the
  ONLY check pinning a string group's stamped `attributes.cyto.n`. Measured through the real
  `conform_outputs` entry: a table declaring `shape: 200` against a `label/zarr.json`
  stamping `n=999` over 200 real strings returned `[]`, while the same wrong value written
  as `[999]` returned two violations — and the identical malformation on a NUMERIC member
  was refused, because `list(200)` raises. One kind silently passed what another crashed on,
  i.e. a per-kind exception ([`_read_member_node`] was written to retire those), and
  `zarrReader.openSplitStringColumn` throws on that metadata, so the gate was once more
  green-lighting what the shipped client refuses. A sweep of every required key × kind ×
  substitute JSON type, through that same entry, found **62 silent cells** (11 string
  `shape`, 12 string `dtype`, 16 falsy `dtype` on the fixed-width kinds, 10 `bool`-as-count,
  2 float extents, and one no-op substitution that was never a fault) — plus, from the same
  family, `levels: []` written into all three copies, which skipped the code-range check for
  60 out-of-range codes. Now the FORM is part of what "required" means
  ([`_MEMBER_KEY_FORMS`] — one table, keyed by KEY, applied to every kind that requires it),
  a key in the wrong form is a violation the same way a missing one is, and
  [`_conform_member`] refuses the member THERE rather than carrying a malformed declaration
  into comparisons that can only crash on it or skip it. The guards at those uses are now
  `is not None` and nothing more.

The lesson the third round teaches, written down where the fourth will read it: a fix for
"absence selects a shallower check" is only at the right altitude if the thing it makes
table-driven is EVERY copy of the declaration, in both directions of every set comparison.
Each of the three above was one level below where the previous fix stopped.

And the lesson the FIFTH occurrence adds, since it landed inside the fourth one's own code:
a rule that can answer "no answer" has not closed the class, it has moved it — the caller now
branches on absence, and the shallower arm is whatever was there before. The check is only
total when the underivable case is itself a refusal, so that there is no weaker rule left for
absence to select.

And the SIXTH: **requiring a key is only half of requiring it.** A declaration is a value of
a TYPE, and a table that says only "this key must be there" hands the producer the type as
the lever — `shape: 200` is present, and every comparison keyed on it was written to survive
a value it cannot read. Deciding the form in the SAME table and at the SAME altitude as the
requirement is what leaves nothing for a guard at the point of use to skip; a per-kind
coercion (`int(declared_shape[0])`) or a per-kind `isinstance` is the shape that puts the
class back one level down, where the next round finds it.

## Where it runs

    python3 -m conformance <outputs_dir>     # a CI step / a hand-run check

and, in production, as the **sandboxed verification job** the server dispatches AFTER
ingest (DEC-12): `_lib/verify_conformance.py` is the entry, this module is staged beside
it, and the artifacts it gates are the ones that actually landed in the object store,
hardlinked back into `/inputs`. Both routes call the SAME `conform_manifest`, so the CLI
and the production gate cannot check different things.

Exit 0 = every emitted artifact conforms; 1 = it does not, with every violation on stderr.
There is no flag that makes a violation non-fatal.

## Two depths, one implementation — and why the monotonicity claim is now TRUE

`conform_artifact(...)` defaults to a BOUNDED check: it verifies every declaration against
the on-disk metadata (O(members), not O(n)) and decodes a bounded SAMPLE of each member's
chunks. `full=True` decodes everything — the depth `conform_outputs` uses by default,
because a verification pass that skips bytes is not a verification pass.

**NO PRODUCTION PATH TAKES THE BOUNDED ARM, and this file will not pretend one might.**
`gate` hardcodes `full=True`, `conform_manifest`/`conform_outputs` default to it, and
`verify_conformance.py` passes it explicitly. The bounded arm was originally justified here as
being "for a caller that must not pay a second full read (a large matrix is 1.8 GB)" — a
caller that does not exist, i.e. a promise of a future one, which is the shape that leaves
built-and-tested-but-unreachable code standing indefinitely. Its actual, present job is
stated instead, at [`_shard_plan`] where the branch lives: **it is the SUBSET arm of the
monotonicity property test.** `test_the_full_depth_detects_everything_the_bounded_depth_does`
corrupts seven things and asserts `bounded reports ⇒ full reports`; without a second arm that
property cannot be stated, and it is the property — not a docstring — that keeps the depth a
matter of COVERAGE rather than of strictness. That is worth a subset branch and a constant.

`full=` is therefore not an opt-out: it only ever makes the check stricter, and it is not
reachable from a processor at all.

**And omitting it is not an opt-out either, because it cannot be omitted.** `conform_artifact`
used to default to `full=False`, so a caller that simply did not mention the depth got the arm
that reads a SAMPLE of the bytes — absence selecting the weaker behaviour, which is the exact
class this file retires at two other levels (a row key read with `.get()`; a stamp key skipped
with `continue`). It is now a REQUIRED keyword-only parameter: omission is a `TypeError` at the
call site. The rule the module holds itself to, checked by
`test_no_omission_can_select_a_weaker_depth` rather than reviewed by eye, is that **no omission
may select a weaker check** — so `full` is either required, or defaulted to `True`
(`conform_manifest`, `conform_outputs`, `gate_outputs`, where forgetting it gets you the whole
gate). A `full=False` default anywhere in this module now fails the suite.

**That sentence used to be false, and it was false in the DANGEROUS direction.** The two
depths did not share the container reader: `full=True` went through
`cyto_zarr_read.read_array` and the bounded depth through this module's own
`_decode_shards`. The convenience reader implements the Zarr rule that an EMPTY shard-index
slot means "chunk absent, fill it with `fill_value`" — legitimate for a reader, and exactly
wrong for a gate, because `cyto_zarr`'s writer never leaves a slot empty inside the logical
range. So a member whose shard index had one slot blanked was reported as a violation by
`full=False` and **passed** under `full=True`, while a consumer silently read a run of
zeroes in the middle of the array — the weaker arm being the only arm production takes
(`conform_outputs`, `verify_conformance`, `gate` are all `full=True`).

The claim is now structurally true rather than documented:

* there is ONE container reader in this module (`_decode_shards`, via `_shard_plan`), and
  the gate never calls `read_array` for member bytes. That second clause was FALSE for one
  live path: `key_sequence_digest_of_member` went through `cyto_zarr_read.read_column`,
  which is `read_array` plus a level-set resolution, and it is on the production path twice
  (`_conform_key` and `axis_alignment_violations`). Harmless in effect — the key must be a
  declared member, so its bytes were already walked strictly elsewhere — but a false
  invariant in a header is worse than none, because the next edit is checked against it.
  It now reads through `_read_whole`, and
  `test_the_gate_never_reads_member_bytes_through_the_convenience_reader` fails if any path
  reaches `read_array` again. `cyto_zarr_read` is still used, for METADATA (`read_meta`,
  `structure`), the `EMPTY` sentinel and `unshuffle` — none of which decodes a chunk;
* `_shard_plan` returns `range(n_shards)` for `full=True` and a SUBSET of it
  (`[0, n_shards-1]`) otherwise, so the bounded depth's shard set ⊆ the full depth's;
* the per-shard checks are the same code either way.

Any fault the bounded depth can detect, the full depth therefore also detects. The remaining
difference is coverage, which is the only difference `full=` is allowed to make.

**`_shard_plan` is NOT the only place `full` is consulted, and the docstring here used to
imply it was.** Measured: `full` is threaded through six functions and BRANCHED ON in exactly
two — `_shard_plan` (the shard subset) and `_conform_sparse_csc`'s `if full and indices.size
and indptr.size > 1` (the row-ids-ascending check, which runs at the FULL depth only). The
second one is in the safe direction, so monotonicity survives; the point is that "a future
check becomes depth-sensitive" is not hypothetical — it has already happened once, and nothing
flagged it. So the rule is stated as a direction rather than as a count: **a `full` branch may
only ADD checks under `full=True`, never remove one, and never add one under `full=False`.**

What ENFORCES that is neither this paragraph nor the structural argument above, both of which
are just claims. It is that the substantive violation tests now run at BOTH depths: 27 of them
are parametrized `[bounded, full]` (`test_conformance.py`), on top of the 7-corruption
`test_the_full_depth_detects_everything_the_bounded_depth_does`. Injecting `if full and …` in
front of the dtype comparison fails the `[bounded]` cell; injecting `if not full and …` —
the direction that would silently drop a check from production — fails the `[full]` cell. Before
that parametrization, ~30 substantive tests asserted rejection ONLY on the arm production never
takes, which is the shape of the fault this whole section describes: hardening the arm nobody
runs.

### The shard-index crc32c is now verified (it was not, at either depth)

`cyto_zarr` writes `crc32c` over each shard's chunk index precisely because that index is
the one part of a shard whose corruption is otherwise INVISIBLE: a flipped byte inside a
compressed chunk fails to gunzip loudly, but a flipped byte in an offset yields a
successful decode of the wrong bytes. Neither depth checked it, so swapping two index slots
transposed a member's values with both depths reporting `[]`. `_shard_index` verifies it
before the offsets are used for anything.

### Sampling history

The sampling path was, until recently, DEAD in practice — `shard_chunks` derives the shard
count from the array's own length, so anything under ~16.8M elements is one shard and the
bounded depth reads it whole. Nothing had ever executed `_decode_shards`, and it held two
faults that only a live test finds: it concatenated PADDED chunks (so a sampled value range
included fill values the array does not contain), and — because `gzip.decompress(b"")`
returns `b""` without raising — a shard truncated into its index trailer decoded to NOTHING
and reported no violation at all. Both are fixed and both are now covered. Because the full
depth now runs the same walker, the strictness those fixes added is what production gets.

## What it does NOT do

It never opens bytes on the SERVER's behalf and is never imported by the server (INV-1). It
has no opinion about what a column MEANS — only whether the bytes are what the declaration
says they are.

numpy + stdlib, same floor as the writer it gates (DEC-7).
"""
import json
import re
import sys
import traceback
from pathlib import Path

import numpy as np

import cyto_zarr_read
# ITEM-19's digest primitive, owned by the WRITER. This module recomputes the digest from
# the stored bytes and compares it to what the producer declared, so both sides have to
# digest identically — hence one definition, imported. See the ITEM-19 section below for
# why the dependency runs gate→writer and never the reverse (DEC-8).
#
# `crc32c` is imported for the same reason: the writer computes the shard index's checksum
# with it, so verifying that checksum has to use the SAME implementation or the comparison
# is between two different functions rather than between intent and bytes.
from cyto_zarr import crc32c, key_sequence_digest, vocab_declaration

#: How many SHARDS of each member the BOUNDED check decodes. The first and the last
#: are the two that catch the overwhelming majority of container faults — a wrong codec
#: chain shows up in the first, and a mis-sealed tail shard or an off-by-one in the padding
#: shows up in the last. Everything in between is the same code path.
#:
#: NOT production-reachable (every production entry passes `full=True`): this and
#: [`_shard_plan`]'s subset branch exist as the SUBSET ARM OF THE MONOTONICITY PROPERTY TEST.
#: See the "Two depths" section of the module docstring for why that is a live job rather than
#: a promise of a future caller.
SAMPLE_SHARDS = 2

#: `type/subtype`, RFC 6838 restricted-name charset, with optional `; param=value` tail.
#: A `media_type` that is not one is not a declaration — it is a placeholder that
#: satisfies a presence check, which is the shape INV-2 exists to refuse.
_MEDIA_TYPE_RE = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}"
    r"(\s*;.*)?$"
)

#: Keys that only mean something for a STRUCTURED (`zarr_v3`) artifact. An `opaque`
#: declaration carrying any of them is trying to be both — see `_conform_opaque`.
_STRUCTURED_ONLY_KEYS = (
    "kind",
    "columns",
    "arrays",
    "indptr",
    "indices",
    "data",
    "n",
    "nnz",
    "shape",
    "key",
    "key_sequence_digest",
)

#: Bound on the tree walk that proves an `opaque` artifact is not secretly a store, and
#: on the byte read that proves it agrees with its declared media type. Both are O(1)
#: guards, not scans: a real store trips the walk within its first few entries, and a
#: 64 MiB ceiling covers every report/JSON an opaque artifact plausibly is.
_OPAQUE_WALK_LIMIT = 20000
_OPAQUE_READ_LIMIT = 64 * 1024 * 1024

#: Charsets under which a `text/*` payload is required to decode as UTF-8. Anything else
#: the producer names explicitly is taken at its word (this module ships no transcoder).
_UTF8_CHARSETS = frozenset({"utf-8", "utf8", "us-ascii", "ascii"})

#: The member kinds this suite implements. A member declaring anything else is refused by
#: NAME rather than silently checked as if it were numeric — which is what used to happen,
#: and is how `kind` could be downgraded (`categorical` → `numeric`) to shed the level-set
#: check. Exhaustive against the writers: `cyto_zarr.write_array` emits `numeric`,
#: `Table.categorical` overrides it to `categorical`, `Table.string` to `string`.
_MEMBER_KINDS = ("numeric", "categorical", "string")

#: The keys a member DECLARATION must carry, per kind. Absence is a VIOLATION, not a
#: shallower check (INV-2, DEC-8) — see the "Retiring the class" section in the module
#: header for the measured matrix of what used to pass silently.
#:
#: Every key here is one the gate USES: it is compared against the member's own `zarr.json`
#: (`dtype`, `shape`, `inner_chunk`, `chunks_per_shard`, `shards`, `levels`, `ordered`,
#: `layout`) or against the bytes (`values_digest`, `n_bytes`). Requiring a key the gate
#: does not check would be a presence ritual; requiring one it does check is what makes the
#: check unavoidable.
_REQUIRED_MEMBER_KEYS = {
    "numeric": (
        "dtype", "shape", "inner_chunk", "chunks_per_shard", "shards",
    ),
    "categorical": (
        "dtype", "shape", "inner_chunk", "chunks_per_shard", "shards",
        # A categorical's codes are meaningless without the level set, and the set is
        # DECLARED, never inferred from the codes (DEC-6). This one was already refused —
        # but only once the bytes decoded, and only because a code happened to land out of
        # range; here it is refused on the face of the declaration.
        #
        # The ROW declares the set by DIGEST (`_conform_levels_digest` recomputes it from
        # the member's stamped `attributes.cyto.levels`, which is where every reader gets
        # the set itself). Restating the list here made one member's row entry 450 KB for
        # a 9 KB array and blew `MAX_MANIFEST_BYTES`; the digest pins the same fact at 64
        # bytes, the way `values_digest` already pins a string member's value sequence.
        "levels_digest",
        # The count is checked against `len(stamped levels)`, so a digest mismatch says
        # WHICH way the two disagree instead of only that they do.
        "n_levels",
        # Order semantics a consumer renders with. Absent, a consumer must assume
        # "unordered", which is the "if absent, assume X" INV-2 forbids.
        "ordered",
    ),
    "string": (
        # `utf8` — there is no stored `data_type` to compare it against (the member is a
        # GROUP of two arrays), so this one is presence-only. It is still required: it is
        # how a `structure` reader tells a string member from a numeric one without
        # opening the store.
        "dtype",
        "shape", "layout", "offsets", "values", "n_bytes", "values_digest",
    ),
}


def _is_text(value):
    """A non-empty string.

    An EMPTY one is the `media_type` fault one level down: it satisfies a presence check and
    names nothing, so the key is there and the declaration is not. Measured silent for
    `dtype: ""` on every fixed-width member, because the comparison behind it was written
    `if declared_dtype and …` and an empty string is falsy.
    """
    return isinstance(value, str) and value != ""


def _is_count(value):
    """An integer, and NOT a `bool`.

    `bool` is a subclass of `int` in Python and `int(True)` is 1, so `shards: true` would be
    READ as a count of one rather than refused as a declaration that is not a count —
    measured silent for exactly the members whose true count is 1 (`chunks_per_shard: true`
    and `shards: true` on all five numeric members of the fixtures).
    """
    return isinstance(value, int) and not isinstance(value, bool)


def _is_flag(value):
    """A boolean. `ordered` is a semantic a consumer renders with, not a number."""
    return isinstance(value, bool)


def _is_list(value):
    """A list — and deliberately not a NON-EMPTY one.

    An empty level set is a real artifact: `Table.categorical(codes=[], levels=[])` at `n=0`
    writes one and it conforms, so requiring `levels` to be non-empty would refuse a
    conforming artifact, which is worse than the hole. What an empty `levels` must not do is
    select a shallower check, and that is fixed where the check is (`_conform_member`'s
    code-range comparison now guards on `is not None`, not on truthiness).
    """
    return isinstance(value, list)


def _is_extents(value):
    """A non-empty list of counts — one axis length per dimension.

    Deeper than the other forms because this is the one key the gate reads THROUGH: it
    compares `list(meta["shape"]) != list(declared_shape)` and indexes `declared_shape[0]`,
    and the string arm coerced that element with `int(...)` — so `shape: ["200"]` and
    `shape: [200.0]` were silent while `shape: 200` was. The form is exactly as deep as what
    the gate does with the value, which is the same criterion [`_REQUIRED_MEMBER_KEYS`] uses
    to require the key at all. Empty is refused for every kind because a `shape` that spans
    no dimension answers no comparison — the identical judgement [`_chunk_grid`] already
    makes about the STORED shape ("declares an empty `shape`, which spans no index at all").
    """
    return isinstance(value, list) and bool(value) and all(_is_count(x) for x in value)


#: The FORM a required member key must be declared in — `key -> (phrase, predicate)` — where
#: "form" is the type a value has to have for the comparison that key exists for to be a
#: comparison at all.
#:
#: ## Why this is a table and not an `isinstance` at each use
#:
#: Requiring a key without requiring its TYPE leaves the same lever with the value left in
#: place. `shape: 200` is PRESENT, so the presence loop above passes it, and every use of it
#: then sat behind an `isinstance(declared_shape, list)` guard written to survive a value it
#: could not read — so a SCALAR switched those uses off exactly the way omitting the key once
#: did, including the ONLY check pinning a string group's stamped `attributes.cyto.n`.
#: Measured through the production entry (`conform_outputs`, real `manifest.json`,
#: `full=True`): a table declaring `shape: 200` against a `label/zarr.json` stamping `n=999`
#: over 200 real strings returned `[]`, while the same wrong value written as `[999]`
#: returned two violations — and the identical malformation on a NUMERIC member was refused,
#: because `list(200)` raises. One kind silently passed what another crashed on, i.e. a
#: per-kind exception, which is the shape [`_read_member_node`] was written to retire; and
#: `zarrReader.openSplitStringColumn` throws on that same metadata, so the gate was again
#: green-lighting what the shipped client refuses.
#:
#: So the form is decided HERE, once, keyed by KEY and applied to every kind that requires it
#: — there is no arm in which a guard at the point of use can silently skip a comparison,
#: because a member whose declaration is not in these forms never reaches one
#: ([`_conform_member`] refuses it first). A required key with no entry here fails
#: `test_every_required_member_key_declares_the_FORM_it_is_required_in`, so the N+1st key is
#: covered by construction rather than by somebody remembering.
_MEMBER_KEY_FORMS = {
    "dtype": ("a non-empty string", _is_text),
    "shape": ("a non-empty list of integers", _is_extents),
    "inner_chunk": ("an integer", _is_count),
    "chunks_per_shard": ("an integer", _is_count),
    "shards": ("an integer", _is_count),
    # No `levels` entry: the ROW does not carry the list any more (it declares
    # `levels_digest` + `n_levels` over it), and `test_every_required_member_key_declares_
    # the_FORM_it_is_required_in` holds this table and `_REQUIRED_MEMBER_KEYS` to be the
    # SAME key set in both directions — a form for a key nothing requires is as much a
    # staleness bug as a required key with no form.
    "levels_digest": ("a non-empty string", _is_text),
    "n_levels": ("an integer", _is_count),
    "ordered": ("a boolean", _is_flag),
    "layout": ("a non-empty string", _is_text),
    "offsets": ("a non-empty string", _is_text),
    "values": ("a non-empty string", _is_text),
    "n_bytes": ("an integer", _is_count),
    "values_digest": ("a non-empty string", _is_text),
}

#: Member keys that are EXPLICITLY optional, each with the reason its absence cannot make
#: the gate look less hard. INV-2 permits explicit optionality ("`required: false` is
#: fine") and forbids the silent kind; this table is what makes the distinction auditable
#: rather than a property of which `.get()` somebody wrote.
#:
#: A key in NEITHER table is unknown to the gate and is reported — so adding a key to the
#: writer without deciding which of the two it belongs in fails loudly instead of riding
#: along unchecked.
_OPTIONAL_MEMBER_KEYS = {
    "path": "the member's ADDRESS — required for every kind, checked before this table",
    "kind": "required for every kind, checked before this table (it selects the set)",
    "name": (
        "a display LABEL. INV-3: the name is a label, never a key — `path` is the address, "
        "and every check in this suite resolves members by `path`. `cyto_csc`'s trio "
        "carries no `name` at all, so requiring it would refuse a conforming artifact."
    ),
    "axis": (
        "a RESTATEMENT of `structure.axis`, which is required at the artifact level and is "
        "where `expect_rows` comes from. `cyto_csc`'s members carry none."
    ),
    "stored_bytes": (
        "an accounting value (the COMPRESSED size). Nothing decodes with it, and checking "
        "it would pin gzip's exact output across zlib versions — a brittle equality that "
        "says nothing about whether the bytes mean what the declaration says."
    ),
    "meta": (
        "the per-member column SUMMARY — a display concern (`colsummary`). Its absence "
        "means there is no summary to show, never a byte check that does not run."
    ),
    "layout": (
        "required for a string member (it is in that kind's set); meaningless for the "
        "fixed-width kinds, which have exactly one layout."
    ),
    "levels": "required for a categorical (in that kind's set); absent by design elsewhere",
    "ordered": "required for a categorical (in that kind's set); absent by design elsewhere",
    "vocab_digest": (
        "ITEM-51: the ORDER-INDEPENDENT set hash of a categorical's vocabulary. Optional "
        "because it is DROPPED — together with `vocab_sketch` — when the sketch exceeds "
        "`MAX_VOCAB_SKETCH_BYTES`, a real state a conforming producer reaches on a "
        "high-cardinality column. Its absence cannot weaken this gate: nothing here decodes "
        "with it, and it is a catalog-side OFFER filter rather than part of the read "
        "contract. When it IS present `_conform_vocab_declaration` recomputes it from the "
        "member's own stamped `attributes.cyto.levels`, so presence buys a check rather "
        "than a free pass."
    ),
    "vocab_sketch": (
        "ITEM-51: the sorted per-level short hashes that make SUBSET decidable. Optional for "
        "exactly the same reason as `vocab_digest`, and NEVER independently of it — the "
        "writer emits both or neither, and `_conform_vocab_declaration` refuses the "
        "exactly-one-present state that would otherwise let a stale survivor be read as an "
        "answer."
    ),
    "missing_level": (
        "ITEM-51: the level `write_metadata_column` INVENTED for pandas' -1 code, declared "
        "on the row so this gate can EXCLUDE it when recomputing the vocabulary pair. It is "
        "an artifact of one dataset's missingness rather than part of the vocabulary. "
        "Optional because most categoricals have no missing values and so invent no level; "
        "its absence means there was none to exclude, never a check that does not run."
    ),
    "offsets": "required for a string member (in that kind's set)",
    "values": "required for a string member (in that kind's set)",
    "n_bytes": "required for a string member (in that kind's set)",
    "values_digest": "required for a string member (in that kind's set)",
    "shards": "required for the fixed-width kinds (in those sets); a string member is a group",
    "inner_chunk": "required for the fixed-width kinds (in those sets)",
    "chunks_per_shard": "required for the fixed-width kinds (in those sets)",
    "dtype": "required for every kind (in every set)",
    "shape": "required for every kind (in every set)",
    # ── dimension-membership ITEM-34 ────────────────────────────────────────────────────
    #
    # OPTIONAL rather than required, and that is INV-9's "a default, not a rewrite": every
    # categorical written before this field existed carries neither, and refusing them would
    # fail every artifact in every project. Their absence cannot weaken the gate, because
    # nothing else in the row or the store is checked THROUGH them — a member with no vocab
    # pair is checked exactly as it was, and a member WITH one is checked harder
    # (`_conform_vocab_declaration` recomputes both from the stamped level set).
    "vocab_digest": (
        "the ORDER-INDEPENDENT set hash over the normalised level set (ITEM-34). Absent on "
        "every categorical written before the field existed, which the consumer reads as "
        "`undecidable` — a state, not a gap. When PRESENT it is recomputed from the "
        "member's own stamped `attributes.cyto.levels` by `_conform_vocab_declaration`."
    ),
    "vocab_sketch": (
        "the sorted per-level short hashes, which is what makes SUBSET decidable where the "
        "set hash alone answers only EQUALITY. Emitted with `vocab_digest` or not at all — "
        "`_conform_vocab_declaration` refuses exactly one of the pair, which is the write-"
        "side half of the consistency rule the consumer's `undecidable` arm rests on."
    ),
    "missing_level": (
        "the level `write_metadata_column` INVENTED for pandas' -1 code, named on the row "
        "so the vocabulary digest can exclude it AND so this gate can recompute the same "
        "exclusion. Absent whenever the column had no missing values."
    ),
    "role": (
        "REQUIRED on an `aux` member and checked by [`_conform_aux`] against [`_AUX_ROLES`], "
        "which refuses a role this gate has no opinion about. Optional elsewhere: `cyto_csc` "
        "stamps a member's ROLE (`indptr`/`indices`/`data`) into its `attributes.cyto` and "
        "the row declares the same fact by which KEY of `structure` the member sits under, "
        "so there a row-side `role` adds nothing. An `aux` member has no such key to sit "
        "under — every one of them sits under the same `aux` list — which is why the role is "
        "carried on the row THERE and is not optional THERE."
    ),
    "extent": (
        "REQUIRED on an `aux` member and checked by [`_conform_aux`]: the list of extent "
        "NAMES, one per dimension, that its stored shape is held to via `structure.extents`. "
        "Meaningless on a column, whose one length rule is the axis's `n` — a column "
        "carrying an `extent` would be declaring a second, independent length rule for the "
        "same bytes, and two rules for one value is the ambiguity this suite refuses."
    ),
}

#: The `aux` member ROLES this gate has an opinion about (ITEM-12), each with what the role
#: MEANS — because an aux member's length is not the axis's `n`, so the only thing standing
#: between it and a free pass is that the gate knows what it is looking at.
#:
#: [`_conform_aux`] REFUSES a role that is not in here. That refusal is the whole design: an
#: aux member is by construction outside every length rule the rest of this module applies,
#: so a role nobody enumerated would be bytes held to a name rule alone — the *"cheapest
#: opt-out there is"* [`_conform_node_coverage`] exists to close, re-opened one level down.
#: Add a role here with what it is, or the producer cannot write it.
#: Roles whose dimension 0 is ONE VALUE PER AXIS ENTRY, mapped to the dimension index that
#: must be the table's own axis.
#:
#: This is the anchor an extent otherwise has no way to reach. An extent is a
#: producer-declared integer cross-checked only against OTHER members claiming the same
#: name, so a member whose length is simply wrong — a per-entity vector of 3 in a table of
#: n=4 — is self-consistent and conformed clean. Measured exactly that way before this
#: existed. Naming the roles here is what turns "the producer says 3" into "the artifact
#: says 4 and this member disagrees".
#: The extent naming the alignment's SOURCE list. `alignment_segment_dataset` indexes it,
#: so it is what bounds those values.
_SOURCES_EXTENT = "sources"

_AUX_ROLE_AXIS_DIM = {
    "alignment_entity_index": 0,
    "alignment_entity_evidence": 0,
}

_AUX_ROLES = {
    "alignment_segment_dataset": (
        "segment → the index, into the alignment's declared source list, of the dataset "
        "that segment's rows come from. Each segment covers a DECLARED-ORDER-CONTIGUOUS "
        "range of output rows (`[segment_start, segment_end)`), so an output row `i` "
        "reconstructs to its `(source, row-within-source)` by finding the segment whose "
        "range contains it — source is that segment's `alignment_segment_order`, and "
        "row-within-source is `i - segment_start` (D18). There is deliberately NO "
        "per-output-row vector: it was pure redundancy over this table. "
        "\n\n"
        "The four `alignment_segment_*` members are ONE TABLE split across four arrays and "
        "are positionally consistent with EACH OTHER — row j of each describes the same "
        "segment. That shared position is NOT the segment's identity: its identity is its "
        "`alignment_segment_order` value, and the array order is deliberately something "
        "else. Index these four together; resolve anything else through `segment_order`."
    ),
    "alignment_segment_start": "segment → its first output row index (inclusive).",
    "alignment_segment_end": "segment → its last output row index, exclusive.",
    "alignment_segment_order": (
        "segment → its DECLARED order (INV-6). Taken from the producer's array index, never "
        "from the containing array's position, because the containing array's order is a "
        "caller's convention rather than a guarantee — which is as true of a Rust reader as "
        "of a TypeScript one. A reader SORTS on this field; it does not iterate the list."
    ),
    "alignment_entity_index": (
        "unified entity × source → that source's column index for the entity, and the "
        "INTERSECTION is what makes it total (INV-2/INV-12): an entity present in only one "
        "source has no row here at all, so there is no absence to encode and no fabricated "
        "zero to emit."
        "\n\n"
        "This role was `alignment_feature_index` until the stage-1 slot rework, and the "
        "rename is not cosmetic in two ways. It is DOMAIN VOCABULARY (`feature` is on "
        "`lint-no-domain-in-builtin`'s noun list) and the role string rides into every "
        "emitted artifact's `structure`, so it landed in the reference fixture that core's "
        "`zarrReader` parity tests consume — where core's domain-freedom rule applies and a "
        "consumer cannot fix it by editing, because regenerating restores it. It was also "
        "INCONSISTENT with the rest of this vocabulary, which is already entity-shaped "
        "(`alignment_entity_evidence`, the `unified_entities` axis): the engine aligns "
        "whichever entity axis the user chose and never knows which."
    ),
    "alignment_level_lookup": (
        "one source's categorical code → the unified code (ITEM-8). One member per (source, "
        "column) pair, each as long as that source's own level set, which is why its extent "
        "is member-named rather than shared. "
        "\n\n"
        "**Every code in it is IN RANGE.** A level this mode dropped maps to the vocabulary's "
        "DECLARED absence label (`attributes.cyto_alignment.missing_levels[<column>]`), not "
        "to a `-1` sentinel. That was the C4 correction: `-1` is pandas' in-memory missing "
        "code, and storing it is exactly what `cyto_columns` refuses (*\"rather than storing "
        "an out-of-range code\"*) — the read side rejects a negative code with a 400 for the "
        "whole column, so the only mode that drops emitted artifacts it could never serve. "
        "The read-side guard still stands and is now unreachable by construction. "
        "\n\n"
        "This is the OBS-axis absence (ITEM-5 / DEC-A). It is NOT the entity axis, where the "
        "intersection makes absence unreachable by construction."
    ),
    "alignment_entity_evidence": (
        "unified entity → whether the sources' SECONDARY identifiers agreed (ITEM-11), as 1 "
        "or 0. A VECTOR rather than a per-entity record in the artifact row's `meta`, for "
        "the reason the row's level list was replaced by a digest: a per-entity record over "
        "20k entities is a manifest entry measured in megabytes, and `MAX_MANIFEST_BYTES` "
        "refuses it. The disagreeing entities are few by construction, so the detail rides "
        "the meta and the total per-entity answer rides here."
    ),
}

#: The per-member `attributes.cyto` keys that restate a key of the member's ROW declaration,
#: as `stamped_key -> row_key`. Compared by [`_conform_member_attributes`] — two copies of
#: one fact that can drift is the class of bug this suite exists for, and the group-level
#: copy was the only one being checked.
_STAMPED_MEMBER_KEYS = {
    "kind": "kind",
    "name": "name",
    # `levels` is deliberately NOT here. This table drives an EQUALITY loop, and the
    # row no longer restates the level set — it declares `levels_digest` over it, so
    # the stamp's list and the row's declaration are not the same shape and cannot be
    # `==`-compared. The comparison did not go away, it moved to
    # [`_conform_levels_digest`], which recomputes the digest FROM this stamp; the
    # stamp itself is still REQUIRED (see `_REQUIRED_STAMPED_KEYS["categorical"]`).
    # Listing it here as well would compare a 35,477-item list against a hex string
    # and report every conforming artifact.
    "ordered": "ordered",
    "layout": "layout",
    "meta": "meta",
}


class _Absent:
    """The value of a key that is NOT there.

    `None` cannot serve: a stamped `null` is a value a producer wrote, and reading absence as
    `None` makes those two the same case.

    The point of a sentinel rather than a membership test is where the decision ends up. The
    comparison below used to open with `if stamped_key not in stamped … : continue`, so
    absence was handled by NOT handling it — a control-flow default, invisible in the diff of
    whoever adds the next stamped key, and the shape this module exists to refuse (one level
    down from where it was last refused). Passing absence in as a VALUE forces
    [`_stamped_key_violations`] to dispatch on it: all four (present/absent × present/absent)
    combinations are enumerated there, and none of them is a `continue`.
    """

    __slots__ = ()

    def __repr__(self):  # pragma: no cover - diagnostic only
        return "<absent>"


_ABSENT = _Absent()

#: The `attributes.cyto` keys a member's OWN `zarr.json` must stamp, per kind, each mapped
#: to WHAT a store-URL consumer does with it — which is the only admissible reason to
#: require it (a required key nothing decodes with would be a presence ritual).
#:
#: This is [`_REQUIRED_MEMBER_KEYS`] one level down, and it exists because that fix was at
#: the wrong altitude by exactly one level: the ROW's keys became required, while the
#: member's own stamp was still read key-by-key with `in`, so a key ABSENT from the stamp
#: skipped its comparison instead of failing it. Measured: popping ONLY
#: `attributes.cyto.kind` out of a categorical member's `zarr.json` left the gate silent
#: while `cyto_zarr_read.read_column` — §0.3's first-class store-URL client — handed back
#: raw `uint8` codes in place of labels. The `levels`/`ordered` pair was already required by
#: a bespoke `if`, which is precisely how a class gets closed for the instances somebody
#: happened to think of.
_REQUIRED_STAMPED_KEYS = {
    "numeric": {
        "kind": (
            "the stamp is the ONLY place a consumer holding just the store URL learns what "
            "this member is; with none, every reader has to guess a decode path"
        ),
    },
    "categorical": {
        "kind": (
            "`read_column` resolves codes through the level set only when the STAMP says "
            "`categorical` — absent, it returns the raw codes, which is a different type "
            "carrying different values"
        ),
        "levels": (
            "a store-URL consumer resolves codes through the stamped level set, so its "
            "absence there is silently-wrong labels, not a missing nicety"
        ),
        "ordered": (
            "the order semantics a consumer renders with; absent, it must assume "
            '"unordered", which is the "if absent, assume X" INV-2 forbids'
        ),
    },
    "string": {
        "kind": (
            "what tells a store-URL consumer this node is a two-array string GROUP rather "
            "than an array it can decode directly"
        ),
        "layout": (
            "which arrow layout the offsets/payload pair is in — the split the consumer "
            "applies is chosen by it"
        ),
        "n": (
            "how many values the pair splits into, i.e. the length a consumer allocates "
            "for; the row's `shape` is the other copy and they are compared"
        ),
    },
}

#: The stamped floor for a member whose `kind` this suite cannot resolve (absent, or a kind
#: it does not implement). Both are refused BY NAME in [`_required_member_key_violations`] —
#: but "the gate cannot tell which kind this is" must not silently become "the gate requires
#: nothing of the stamp", so the one key every kind needs still is.
_STAMP_FLOOR = {"kind": _REQUIRED_STAMPED_KEYS["numeric"]["kind"]}

#: Stamped keys that are EXPLICITLY optional, each with the reason its absence cannot make
#: the gate look less hard — the same auditable distinction [`_OPTIONAL_MEMBER_KEYS`] draws
#: for the row. A stamped key in NEITHER table is one the gate has no opinion about, and is
#: reported, so a key added to `cyto_zarr._member_meta` cannot ride along unclassified.
_OPTIONAL_STAMPED_KEYS = {
    "name": (
        "a display LABEL (INV-3: the name is a label, never a key). `cyto_csc`'s trio "
        "stamps one that its ROW does not carry, so the two copies are compared only when "
        "both exist — and nothing decodes with it either way"
    ),
    "meta": (
        "the per-member column SUMMARY, a display concern. Its absence means there is no "
        "summary to show, never a byte check that does not run"
    ),
    # ── dimension-membership ITEM-34 ────────────────────────────────────────────────────
    #
    # OPTIONAL rather than required, and that is INV-9's "a default, not a rewrite": every
    # categorical written before this field existed carries neither, and refusing them would
    # fail every artifact in every project. Their absence cannot weaken the gate, because
    # nothing else in the row or the store is checked THROUGH them — a member with no vocab
    # pair is checked exactly as it was, and a member WITH one is checked harder
    # (`_conform_vocab_declaration` recomputes both from the stamped level set).
    "vocab_digest": (
        "the ORDER-INDEPENDENT set hash over the normalised level set (ITEM-34). Absent on "
        "every categorical written before the field existed, which the consumer reads as "
        "`undecidable` — a state, not a gap. When PRESENT it is recomputed from the "
        "member's own stamped `attributes.cyto.levels` by `_conform_vocab_declaration`."
    ),
    "vocab_sketch": (
        "the sorted per-level short hashes, which is what makes SUBSET decidable where the "
        "set hash alone answers only EQUALITY. Emitted with `vocab_digest` or not at all — "
        "`_conform_vocab_declaration` refuses exactly one of the pair, which is the write-"
        "side half of the consistency rule the consumer's `undecidable` arm rests on."
    ),
    "missing_level": (
        "the level `write_metadata_column` INVENTED for pandas' -1 code, named on the row "
        "so the vocabulary digest can exclude it AND so this gate can recompute the same "
        "exclusion. Absent whenever the column had no missing values."
    ),
    "role": (
        "`cyto_csc` stamps a member's ROLE (`indptr`/`indices`/`data`); the row declares "
        "the same fact by which KEY of `structure` the member sits under, so there is "
        "nothing a stamped `role` adds and nothing its absence removes"
    ),
    "kind": "required for every kind (in every set, and in the floor above)",
    "levels": "required for a categorical (in that kind's set); absent by design elsewhere",
    "ordered": "required for a categorical (in that kind's set); absent by design elsewhere",
    "layout": (
        "required for a string member (in that kind's set); the fixed-width kinds have "
        "exactly one layout"
    ),
    "n": (
        "required for a string member (in that kind's set); a fixed-width member's length "
        "is its `shape`, which is compared against the stored grid"
    ),
}

#: Bound on the node walk that proves every stored node is declared. A store's node count
#: is its member count (a table: one per column, three per string column, plus the root),
#: so this is orders of magnitude of headroom — and, like the `opaque` walk, exceeding it
#: is REPORTED rather than passed: "too many nodes to enumerate" must not read the same as
#: "every node is declared".
_NODE_WALK_LIMIT = 10000

#: The Zarr chunk directory. It holds shard FILES, not nodes, so the NODE walk does not
#: recurse through it looking for `zarr.json`s — `Table._claim` refuses `c` as a member name,
#: so no declared node can be under one.
#:
#: It used to be skipped ENTIRELY, which made it the one place in a store where bytes were
#: neither declared nor reported: a file written to `<member>/c/evil` was invisible to the
#: whole gate (measured: `[]`), and so was a whole hidden NODE at `<member>/c/sneaky/`. The
#: fix is not to walk it as nodes but to hold it to what it is FOR — see
#: [`_chunk_dir_violations`].
_CHUNK_DIR = "c"

#: The ONE file a Zarr node owns. Named because the file-coverage rule below is stated in
#: terms of it: within an artifact, every file is either some node's `zarr.json` or a chunk
#: under that node's `c/`, and there is no third kind.
_NODE_META = "zarr.json"

#: A chunk key component, per the v3 `default` chunk-key encoding `cyto_zarr` writes: the
#: chunk's index along one dimension, so `c/3` (1-D) and `c/3/0` (2-D). Anything else under
#: a `c/` dir is not a chunk of this member.
#:
#: THIS IS A NAME RULE, AND A NAME RULE IS NOT A COVERAGE RULE. It answers "is this SHAPED
#: like a chunk key", which is a different question from "is this chunk one the declared
#: array actually HAS" — and shipping only the first made the "every file is a `zarr.json`
#: or a chunk" claim untrue for the whole chunk plane: `value/c/7` on a one-shard member,
#: `value/c/00000000123456789`, 5 MiB of random bytes at `value/c/1`, `<root>/c/0` and
#: `label/c/0` under GROUP nodes that own no chunks at all — every one of them matched this
#: regex and produced `[]`. [`_chunk_grid`] is the missing half: the set of keys the node's
#: own grid names. A key is a chunk only if it is BOTH.
_CHUNK_KEY_RE = re.compile(r"^[0-9]+$")


class _NoChunkPlane:
    """A node that owns no chunk grid AT ALL — a Zarr GROUP.

    Distinct from "the grid is empty" (`[0]`, a zero-length array) and from "the grid is not
    derivable" ([`_UnderivableGrid`], which is a VIOLATION): a group is not an array, so
    there is no index space for a chunk key to be in or out of, and EVERY entry under a `c/`
    dir it somehow acquired is undeclared bytes. The artifact root and a string member's
    parent are both groups, and `<root>/c/0` and `label/c/0` were both silent.

    This is the ONE answer that is a positive fact about the node rather than a gap in the
    derivation, and it is why the fix for the underivable case could not simply be "refuse
    everything that is not a list": every conforming store has two groups.
    """

    __slots__ = ()

    def __repr__(self):  # pragma: no cover - diagnostic only
        return "<no chunk plane>"


_NO_CHUNK_PLANE = _NoChunkPlane()


class _UnderivableGrid:
    """A node whose own `zarr.json` does not YIELD a grid — which is a violation, not a gap.

    This used to be `None`, "no answer", and "no answer" switched the grid rule OFF and left
    the NAME rule as the whole check. That is this file's own recurring defect one level
    further down — *absence selects a shallower check* — and it was live: an arity-mismatched
    member (`shape [200]`, `chunk_shape [4096, 4096]`) took 12,003,461 bytes at `value/c/999`
    through the real `conform_outputs` entry, with a real `manifest.json`, and the gate
    returned `[]`. The docstring that shipped with `None` argued it "cannot be used as a
    lever" because every path reaching it is already a failing path. It was measured against
    that code, and it was false for THREE of the nine shapes that produce it, because the
    checks that docstring named read `shape` and `chunk_shape[0]` and nothing else and so
    cannot see a fault anywhere else in the document. The 11 silent cells measured:

    | shape | silent for | refused for |
    |---|---|---|
    | arity mismatch | `chunk_shape` longer, on all EIGHT nodes¹ | `shape` longer |
    | extent not a non-negative int | a FLOAT extent (`[200.0]`) | negative, `str`, `bool` |
    | step not a positive int | a FLOAT (`[4096.0]`) or STRING (`["4096"]`) step | `0`, `bool` |

    ¹ 1-D numeric, categorical, both string legs, all three CSC members, and a 2-D member.
    The `shape`-longer direction is the one an unrelated check happens to catch (the row's
    `shape` comparison where there is one, the decode where there is not) — which is why
    picking either direction as representative is how a test comes to certify the hole.

    A float or a numeric string survives because every consumer of those two numbers coerces
    with `int(...)` before using it, which is exactly the shape of fault a check keyed on one
    element of a list cannot see.

    So the answer is not `None` and there is no weaker rule to fall back to: a node whose
    metadata does not describe a grid is MALFORMED and is refused by name
    ([`_underivable_grid_violation`]). That is not a stricter reading invented here —
    `zarrReader.ts`'s `#assertRowChunked` throws `zarr.json: chunk_grid chunk_shape has rank
    N, array has rank M` on exactly this metadata, so the gate was green-lighting an artifact
    the SHIPPED CLIENT refuses to open.

    Distinct from [`_NO_CHUNK_PLANE`], which is a positive fact about a node's KIND (a group
    owns no index space) rather than a gap in what the gate could derive, and which must keep
    passing: `<root>` and a string member's parent are groups in every conforming store.

    `reason` is the fact that made the grid underivable, carried into the message so an
    author is told which part of the document to fix. It is a LABEL attached at the return
    site, not a second derivation.
    """

    __slots__ = ("reason",)

    def __init__(self, reason):
        self.reason = reason

    def __repr__(self):  # pragma: no cover - diagnostic only
        return f"<underivable grid: {self.reason}>"


#: Bound on the CHUNK walk, separate from [`_NODE_WALK_LIMIT`] and far larger because it
#: counts shard files rather than nodes. Headroom: a shard spans `inner_chunk *
#: chunks_per_shard` ≤ 4096 * 4096 ≈ 16.8M elements (`cyto_zarr.SHARD_CAP_CHUNKS`), so
#: 200k entries is ~10^12 elements — while still bounding the walk over a store that is
#: pathological or hostile. Exceeding it is REPORTED, never passed.
_CHUNK_WALK_LIMIT = 200000

#: How many stray chunk-dir entries a violation NAMES before it truncates. The count is
#: always exact (the verdict crosses a process boundary into a log line and a DB write).
_STRAY_REPORT_LIMIT = 10


class Evidence:
    """A tally of the work the gate actually DID, kept by the code that does it.

    ## Why a gate needs to account for itself

    "No violations" and "examined nothing" are the SAME value — an empty list — and the
    second one read as the first is a green line for an artifact nobody looked at. The
    production entry (`verify_conformance.py`) reports a `checked` list that the server
    (`jobs::conformance::run_gate`) uses as its positive control, refusing any verdict that
    does not account for every artifact it submitted.

    That control was **vacuous**: `checked` was built as `[e["id"] for e in
    manifest["outputs"]]`, i.e. re-derived from the server's own input. With
    `conform_manifest` stubbed to return `[]` the entry still reported both ids as checked
    and exited 0, and the server logged "2 artifact(s) verified against their declared
    structure" for a gate that had read nothing. A safeguard that cannot fire is not one.

    ## `checks` counts COMPLETED READS, and nothing else — the second vacuity

    Deriving `checked` from this object was necessary and not sufficient. `checks` used to
    have a fourth contributor, [`note`], "one declaration-level comparison performed",
    and `conform_artifact` opened with an unconditional one — a `checks` bump that had
    read nothing at all. The rest came from comparing a row's declaration against the
    stamped copy in a `zarr.json`, which is cheap metadata work that happens BEFORE the
    expensive part. So the container walk — the whole substance of this gate — could be
    removed entirely and the receipt still looked full: with `_decode_shards` stubbed to
    `[]`, the production entry returned `checks: 10, shards: 0, chunks: 0,
    decoded_bytes: 0`, `checked: [the artifact]`, `violations: {}`, exit 0, and the server
    logged "every ingested artifact conforms to its declaration". A gate that decoded
    nothing produced a fully-accounted green verdict, and the docstring here asserted that
    a `_decode_shards` stub could not.

    `note` is therefore **gone**. There is exactly ONE quantity — `checks` — and only
    the methods below raise it. Each takes **the RESULT of an I/O act that has already
    completed**, and is called at the line that completed it.

    ## The receipt is earned by the ACT, not by reaching the code that performs it

    Deleting `note` was necessary and STILL not sufficient, because the same class walked
    back in through the fix: `_decode_shards` announced `_note(evidence, "walked",
    len(shards))` **before** the loop that opens a single shard. `len(shards)` comes from
    [`_shard_plan`], i.e. from the DECLARED grid — it is a statement about the manifest,
    not about the disk — so the receipt was earned by ENTERING the reader. Two shapes
    fell straight out of that, both measured through `verify_conformance.main()`:

    * an `n=0` member writes a real, empty `c/` (a LEGAL shape —
      `test_an_underivable_grid_is_refused_even_with_an_EMPTY_chunk_plane` asserts it
      conforms), so `shards == []`: `checks: 1, chunks: 0, decoded_bytes: 0`,
      `checked: [the artifact]`, `violations: {}`, **exit 0** — a fully-accounted green
      verdict over zero bytes;
    * a member whose shard file has been DELETED: `checks: 1, shards: 1,
      decoded_bytes: 0` — a receipt claiming a container was walked for a file that does
      not exist.

    So the verbs take the bytes, never a plan:

    * [`container`] — one container part read, given **the bytes it returned**
      (`_decode_shards`, per shard, on the line after `read_bytes()`); tallied as
      `shards` / `read_bytes`;
    * [`decoded`] — one inner chunk decompressed, tallied as `chunks` / `decoded_bytes`;
    * [`read`] — an `opaque` artifact's bytes read whole, tallied as `read_bytes`.

    **Nothing read ⇒ nothing recorded**, stated once, here, rather than at three call
    sites: every verb returns without touching a counter when its argument says no bytes
    came back. A walk over an empty plan is not a walk.

    ## The measure is BYTES, for every verb — there was a fourth, and it counted entries

    Three verbs is not an accident of what the module happens to read. There was a
    FOURTH, [`enumerated`], which took the number of entries `_bytes_are_not_a_store`'s
    tree walk had listed and raised `checks` off it. A directory LISTING reads no file, so
    it was the one way to earn a full receipt without a byte coming back, and it made the
    property stated above false while the property was written down five times across the
    two languages. Measured through the real `verify_conformance.main()`: an `opaque`
    DIRECTORY holding a 21-byte page and a 4096-byte blob — neither of which any gate path
    opens, because `_opaque_bytes_agree_with_media_type` returns early for a non-file root
    — returned `checks: 1, shards: 2, chunks: 0, decoded_bytes: 0, read_bytes: 0`,
    `checked: [the artifact]`, `violations: {}`, exit 0, and the server's real
    `verdict_from_run` + `conclude` turned that document into
    `GateOutcome::Conformed{checked: 1}`. It was also inconsistent with itself: a 0-byte
    opaque FILE landed INDETERMINATE while an opaque DIRECTORY holding one EMPTY
    subdirectory landed CONFORMED, and both read exactly nothing.

    The verb is GONE rather than given a bytes test of its own, because a fourth
    predicate would leave the same shape available to a fifth verb. The invariant is now
    carried by the SHAPE of the API and not by a rule each verb has to remember: every
    verb takes a byte count (or the bytes), and every one of them raises `read_bytes` or
    `decoded_bytes` on the same line it raises `checks`. `test_a_receipt_is_never_earned_
    without_bytes` drives every public verb on this class generically, so a verb added
    later that counts anything other than bytes fails there.

    So `checks > 0` **is** "at least one read of this artifact's bytes completed", and
    there is no weaker quantity beside it for a later author to key on. The other four
    counters are the breakdown of the same work, reported so an operator can see how much
    was read; none of them can move without `checks` moving too, and `checks` cannot move
    without `read_bytes + decoded_bytes` moving with it —
    `jobs::conformance::GateVerdict::examined` reads exactly that on the other side, so
    the rule is enforced where the verdict is consumed and not only where it is written.

    ## A directory-shaped `opaque` artifact is INDETERMINATE, and that is the honest answer

    Deleting the verb has one visible consequence, and it is the correct one: this module
    reads NO bytes of a directory-shaped `opaque` artifact. Its `opaque` claim is
    established by listing the tree ([`_bytes_are_not_a_store`]) and its content check
    ([`_opaque_bytes_agree_with_media_type`]) applies to a FILE, so there is nothing on
    that path that opens anything. An artifact the gate did not read is not one it can
    call clean, so it earns no receipt and lands in the same unaccounted-for channel as
    an `n=0` member — reported, never silent, never condemned. Reaching "conforms" for it
    would require a check that actually reads it; until there is one, saying so would be
    the vacuity this class exists to prevent.

    An artifact the gate refuses on the FACE of its declaration (no `encoding`, an encoding
    this suite does not implement, bytes that are not a store at all) earns no evidence,
    because it earned none: nothing was read. That is not a hole — it is condemned, and
    `GateVerdict::condemned` is what acts on it. The property the two consumers hold is the
    one that matters: **a CLEAN verdict is impossible without bytes read**, because a
    clean artifact is by definition one with no violation to account for it.

    ## An artifact with NOTHING to read is INDETERMINATE, not conforming

    The `n=0` member above is legal data, and the gate reads none of it. It therefore
    earns no receipt and is not "clean": `verify_conformance.main()` names it in the
    unaccounted-for RUN violation (exit 1), and `jobs::conformance::verdict_from_run`
    refuses the whole verdict, so `conclude` returns `GateOutcome::Indeterminate` and the
    row keeps the status ingest gave it. Both sides therefore land on the same
    consequence — not green, not condemned, and never silent (INV-2). Condemning it
    instead would be a false statement about data that is fine; passing it is the vacuity
    this whole mechanism exists to make impossible.

    Nothing outside the checking code touches an `Evidence`, and `conform_manifest` creates
    a fresh one per artifact, so a stub — of `conform_manifest`, of `conform_artifact`, of
    `_decode_shards` — cannot produce evidence it did not earn.
    """

    __slots__ = ("checks", "shards", "chunks", "decoded_bytes", "read_bytes")

    def __init__(self):
        self.checks = 0
        self.shards = 0
        self.chunks = 0
        self.decoded_bytes = 0
        self.read_bytes = 0

    def container(self, body):
        """One container part read off disk — `body` IS the bytes it returned.

        Takes the bytes rather than a count, because a count of the parts a declared grid
        SAYS exist is available before anything is opened, and that is exactly how the
        receipt came unstuck from the read (see the class doc). The only caller is the
        loop in [`_decode_shards`], on the line after the one that read `body`.

        No bytes ⇒ no receipt: an empty read establishes nothing about the container, and
        every path that produces one raises within three lines anyway.
        """
        if not body:
            return
        self.shards += 1
        self.read_bytes += len(body)
        self.checks += 1

    def decoded(self, nbytes):
        """One inner chunk decompressed to `nbytes` of payload."""
        if nbytes <= 0:
            return
        self.chunks += 1
        self.decoded_bytes += int(nbytes)
        self.checks += 1

    def read(self, nbytes):
        """`nbytes` read whole off disk (the `opaque` content check)."""
        if nbytes <= 0:
            return
        self.read_bytes += int(nbytes)
        self.checks += 1

    def as_dict(self):
        return {
            "checks": self.checks,
            "shards": self.shards,
            "chunks": self.chunks,
            "decoded_bytes": self.decoded_bytes,
            "read_bytes": self.read_bytes,
        }

    def __repr__(self):
        return f"Evidence({self.as_dict()})"


def _note(evidence, method, *args):
    """Call `evidence.<method>(*args)` when there is an evidence sink; a no-op otherwise.

    `evidence=None` is the default everywhere so a direct caller (`gate`, a test, the
    fidelity suite) needs no accumulator. It cannot become a way to check LESS: the
    counters feed the "was this examined" question only, never a decision about the bytes.

    Every `method` here is one of [`Evidence`]'s three, each is handed the RESULT of an I/O
    act, and each is called on the line that completed that act. There is deliberately no
    "I did something" verb: that was `note`, and an unconditional one at the top of
    `conform_artifact` is what let a gate with its container reader stubbed out report a
    full receipt. There is likewise no verb that takes a COUNT OF WORK TO COME: announcing
    `len(shards)` before the loop that opens them is how the same class walked back in.
    And there is no verb that takes a count of anything but BYTES: that was `enumerated`,
    which counted the entries a directory listing had seen, and a listing opens no file —
    see the class doc for the green verdict it produced over an artifact nothing read.
    """
    if evidence is not None:
        getattr(evidence, method)(*args)


#  ── RECORDED LIMITATION: an OS fault on an artifact's bytes CONDEMNS that artifact ──
#
#  All nine `except OSError` clauses in this module render the fault as a VIOLATION of the
#  artifact they were reading — the six READER sites by returning one, and the THREE WALK
#  sites ([`_store_nodes`], [`_chunk_dir_violations`], [`_bytes_are_not_a_store`]) by
#  recording the directory they could not enumerate ([`_unreadable_dir_violations`]).
#  `conform_manifest`'s outer `except Exception` catches whatever the inner readers let
#  escape and does the same.
#
#  That sentence was a DESCRIPTION when it was written here, and it has now been false
#  TWICE, in two different spellings, and the second is the more instructive:
#
#  * First, two of the walk sites answered an unenumerable directory with a bare `continue`,
#    so a subtree at mode `0o111` contributed nothing to the node set and the gate reported
#    the store CLEAN — exit 0 with a full receipt over bytes it could not open.
#  * Then the sentence was rewritten to say "the two WALK sites", and it was STILL false,
#    because there were three. `_bytes_are_not_a_store` — the DEC-8 anti-bypass check, the
#    one thing standing between an `opaque` declaration and a real store — enumerated with
#    `Path.rglob("*")`, and CPython's recursive-glob selector catches `PermissionError`
#    internally. So it, too, skipped what it could not list, with no `except OSError` clause
#    anywhere to name the fault. Measured: an `opaque`-declared store whose only `zarr.json`
#    sits under a `0o111` directory returned `violations: {}`, `checked: []`, `evidence: {}`
#    — INDETERMINATE, statuses untouched, still serving — where the identical store at
#    `0o755` is condemned. See [`_bytes_are_not_a_store`] for the full table.
#
#  It is a description again because all three were changed to match, not because the claim
#  was softened; `_unreadable_dir_violations` carries the measurement. A sentence is not a
#  mechanism, so it is no longer only a sentence:
#  `test_a_directory_the_walk_cannot_enumerate_is_reported_not_skipped` asserts the VERDICT
#  at all three walk sites, `test_no_OSError_handler_in_the_module_discards_the_fault` is a
#  tripwire on a bare `continue`/`pass` body (the shape the first two swallows had), and
#  `test_no_recursive_enumeration_hides_its_own_errors` is the tripwire the second swallow
#  needed — a handler-body scan is blind to a swallow that lives inside the standard
#  library, so the companion bans the CALL rather than looking for a handler. Both scanners
#  say in their own docstrings what they do not catch; a scanner trusted past its evidence
#  is how the `rglob` site survived the round that was written to close exactly this class.
#
#  `apply_verdict` turns an artifact-level
#  violation into `artifacts.status = 'failed'`, after which `consume::ConsumableArtifact`
#  refuses every serve/stage/promote path until someone edits the catalog by hand. So a
#  `chmod 000`, an EIO off a failing disk, or an allocation failure during a decode is
#  answered with a statement about the BYTES that the fault does not support. That is a
#  real defect and it is known; it is here on purpose.
#
#  ## What was tried, and why it was withdrawn
#
#  Two commits attacked it. `32082f67` routed an OS fault on `opaque` bytes to the
#  INDETERMINATE channel (no violation, no receipt) — on that ONE branch, while the
#  `zarr_v3` readers went on condemning the identical `chmod 000`. `7798bf42` generalised
#  it: a `_fault_if_unreadable(exc)` predicate (an `errno` discriminator, since
#  `gzip.BadGzipFile` subclasses `OSError` and must keep condemning), an `_IoFault`
#  exception, ~11 call sites, and two catch seams in `conform_manifest`.
#
#  The generalised version was strictly worse than the defect it replaced, measured
#  through the real `verify_conformance.main()`: a table whose `value` member is stored
#  `float32` and declared `float64` — a genuine, refuted, artifact-level violation —
#  reported `violations: {<aid>: ["… declared 'float64' but stored as 'float32'"]}`.
#  Add `chmod 000` to ONE shard of a DIFFERENT member (`group/c/0`) and `violations`
#  became `{}`. The seam dropped the artifact's receipt AND its violations together, the
#  server's `verdict_from_run` then refused the whole verdict, `conclude` returned
#  `Indeterminate`, no status was written, and a demonstrably non-conforming artifact kept
#  `status = 'ready'` and kept serving. The seam's own comment argued that silence would
#  be "trading a false condemnation for a false pass"; once any violation had been found,
#  that is exactly what it did.
#
#  ## Why the fail-closed behaviour is the one that stays
#
#  A false CONDEMNATION is visible and recoverable: the operator sees `status='failed'`,
#  fixes the mode, re-runs. A false PASS is silent and leaves proven-bad bytes serving.
#  A mechanism that cannot reliably tell the two apart has to fail toward the visible one.
#  And reverting only the class-wide half would have reinstated the opaque-vs-`zarr_v3`
#  asymmetry that `7798bf42` existed to remove, so BOTH went: one rule, no branch that
#  disagrees with another.
#
#  ## What a future fix has to get right
#
#  Not "route the fault somewhere else". Specifically, all five of:
#
#  1. **Attribute the fault WITHOUT discarding violations already found.** The verdict has
#     to be able to say "this artifact is refuted AND part of it went unread"; today's
#     `(violations, examined)` pair collapses that into one of the two. That is the HIGH
#     above and it is the hard part.
#  2. **Cover every reader, including the ones that are not in an `except OSError`.**
#     `Path.exists()` / `is_file()` / `is_dir()` raise `PermissionError` too (a mode-000
#     PARENT directory), and `_conform_opaque` calls them outside any handler — so a
#     predicate wired only into the `except OSError` sites leaves that path condemning and
#     recreates the very asymmetry `7798bf42` was written to remove.
#  3. **Classify non-`OSError` allocation failures.** `MemoryError` /
#     `numpy._core._exceptions._ArrayMemoryError` carry no `errno` and are not `OSError`,
#     so an `errno`-based discriminator condemns on `ENOMEM` — the one condition such a
#     doctrine's own text always names as "must never condemn".
#  4. **Keep `gzip.BadGzipFile` (and any later `OSError` subclass raised by a decoder)
#     condemning.** It IS a statement about the bytes. `errno is None` was the
#     discriminator that worked for this; whatever replaces it needs a test proving a
#     mangled chunk still fails.
#  5. **Never let a fault fail OPEN — and check the WALKS first, because that is where it
#     already happened, twice.** Points 1-4 are all about a fault condemning when it should
#     not: visible, recoverable, and the direction this design deliberately chose. The
#     direction that actually bit was the other one. THREE swallowed faults in the walks
#     turned an unreadable subtree into an EMPTY one, and empty is clean: the two store
#     walks measured `exit 0`, `violations: {}`, full receipt, `GateOutcome::Conformed` over
#     a directory the gate could not open, and the anti-bypass walk measured `violations:
#     {}`, `checked: []` → `GateOutcome::Indeterminate` over an `opaque` declaration made
#     across a real Zarr store. A reader that fails open loses ONE check; a WALK that fails
#     open makes a positive coverage claim about bytes nothing enumerated, which is the
#     DEC-8 bypass itself. So any future routing must state "part of this went unread" —
#     silence in a walk is indistinguishable from an all-clear, and unlike a false
#     condemnation nobody ever finds out.
#
#     **And do not go looking for it only where a handler could be written.** The third
#     swallow had no handler: it was `Path.rglob`, whose recursion catches `PermissionError`
#     inside pathlib. The fix for the first two was accompanied by a scan of `except OSError`
#     bodies, and that scan could not have seen the third — a guard that can only find the
#     shape already fixed is a guard that certifies the bug beside it.
#     `_unreadable_dir_violations` is where the measurements are recorded, and the four
#     points above are only worth attempting on top of a mechanism that cannot produce this
#     outcome.
#
#  The two withdrawn commits are the reference for the shape, and their audit findings
#  (round 22 LOW, round 24 HIGH + 2×MEDIUM + LOW, round 25 MEDIUM) are the reference for the
#  traps.


class ManifestReport:
    """What one `conform_manifest` pass found AND the evidence that it looked.

    Iterates exactly as the `[(labels, violation)]` list this function has always returned,
    so every existing caller (`for labels, v in report`, `report == []`, `len(report)`) is
    unchanged. `examined` is the addition: `{label: Evidence.as_dict()}`, the per-artifact
    tally described on [`Evidence`], which is what makes the production entry's `checked`
    list evidence of work rather than a restatement of its input.
    """

    __slots__ = ("violations", "examined")

    def __init__(self, violations, examined=None):
        self.violations = list(violations)
        self.examined = dict(examined or {})

    def __iter__(self):
        return iter(self.violations)

    def __len__(self):
        return len(self.violations)

    def __getitem__(self, index):
        return self.violations[index]

    def __bool__(self):
        return bool(self.violations)

    def __eq__(self, other):
        if isinstance(other, ManifestReport):
            return (self.violations, self.examined) == (other.violations, other.examined)
        return self.violations == other

    def __repr__(self):
        return f"ManifestReport({self.violations!r}, examined={self.examined!r})"


class ConformanceError(Exception):
    """An emitted artifact disagrees with its own declaration.

    Carries EVERY violation rather than the first: an author fixing one and re-running to
    discover the next is the slow loop this exists to avoid.
    """

    def __init__(self, root, violations):
        self.root = str(root)
        self.violations = list(violations)
        joined = "\n  - ".join(self.violations)
        super().__init__(
            f"{self.root} does not conform to its declared structure "
            f"({len(self.violations)} violation(s)):\n  - {joined}"
        )


# ── the gate ─────────────────────────────────────────────────────────────────────


def gate(root, structure, *, meta=None):
    """Check ONE emitted artifact and RAISE on any violation.

    Deliberately takes no options — no depth, no severity, no allow-list; exactly two
    positional parameters and nothing to bind. That is what leaves a processor author
    nothing to pass: the only way to change this verdict is to change the bytes or the
    declaration, which is the whole point.

    `meta=` is the artifact row's OTHER producer declaration, not a dial — it can only add
    checks (see `_conform_key`), never remove one, and the production path
    (`conform_manifest`) always supplies whatever the entry carried. It is keyword-only so
    the "two positional arguments" property above stays literally true.
    """
    violations = conform_artifact(root, structure, full=True, meta=meta)
    if violations:
        raise ConformanceError(root, violations)


def conform_artifact(root, structure, *, full, meta=None, evidence=None):
    """Every way `root`'s bytes disagree with `structure`, as a list of strings.

    Returns rather than raises so a caller checking a whole manifest can report all of it
    at once. `full=True` decodes every chunk instead of a sample.

    ## `full` is REQUIRED, and that is the same fix as the other two

    It used to default to `False`, i.e. **omitting it selected the weaker gate** — which is
    the class this module has now retired twice at other levels and would have been one new
    caller away from a fourth time:

    | level | absence used to mean |
    |---|---|
    | a member's ROW declaration key | `.get()` → the check was SKIPPED (`_REQUIRED_MEMBER_KEYS`) |
    | a member's STORED STAMP key | `continue` → the comparison was SKIPPED (`_ABSENT`) |
    | **this parameter** | **the caller got the depth that reads a SAMPLE of the bytes** |

    Both of the others were fixed by making absence a value the code must handle rather than a
    path it could take, and the same move applies here: with no default, omission is a
    `TypeError` at the call rather than a quiet downgrade. Nothing about today's behaviour
    changes — every production entry already passes `full=True` explicitly (`gate`,
    `conform_manifest`, `conform_outputs`, `verify_conformance.py`) and the tests that
    deliberately drive the bounded arm now say `full=False` — but the protection stops being a
    property of the CALLERS (all of which happen to be explicit) and becomes a property of the
    function, which is the only kind that holds for a caller nobody has written yet.

    This is also a normalization, not an invention: every other `full`-taking function in this
    module (`_conform_table`, `_conform_member`, `_conform_string_member`,
    `_conform_sparse_csc`, `_decode`, `_shard_plan`) already requires it. This entry was the
    single deviation, and the deviation was in the weak direction.

    THE ONLY DIRECTION A `full` DEFAULT MAY POINT IS STRICT. `conform_manifest` /
    `conform_outputs` / `gate_outputs` keep `full=True` defaults on purpose: absence there
    selects the STRONGEST depth, so it cannot be an opt-out, and a caller who forgets gets the
    whole gate. `test_no_omission_can_select_a_weaker_depth` checks every signature in the
    module against exactly that rule, so a future `full=False` default anywhere fails the suite
    instead of being reviewed by eye.

    `meta` is the manifest entry's `meta` (the producer's second declaration — what the
    bytes MEAN, e.g. `is_axis_index`), passed so a `structure` omission can be falsified
    against it. `evidence` is an [`Evidence`] sink; both default to absent so a direct
    caller needs neither — neither can remove a violation, which is why a default is legal for
    them and not for `full`.
    """
    # NOTHING is recorded here. This used to open with an unconditional `_note(evidence,
    # "note")` so that the branches reaching a conclusion without opening a byte "accounted
    # for themselves" — and that bump, plus the cheap declaration-vs-stamp comparisons below
    # it, is what let a gate with `_decode_shards` stubbed out report a full receipt and a
    # green verdict (see [`Evidence`]). Evidence is earned by reading bytes; a face refusal
    # reads none, and it does not need to be "examined" to be acted on — it returns a
    # violation, which is what condemns it.
    root = Path(root)
    if not isinstance(structure, dict):
        return [f"structure is {type(structure).__name__}, not an object"]

    encoding = structure.get("encoding")
    if encoding is None:
        # `{}` (and any structure that names no encoding) lands here. It is NOT a
        # declaration: nothing in it says what the bytes are, so there is nothing to
        # check them against, and treating it as "nothing to declare" would be a
        # second opt-out sitting next to the `opaque` one this module now verifies.
        # `workstore::ingest` refuses the same shape at the manifest, so the two
        # layers agree and this branch is the backstop for a row that got in some
        # other way — see `test_a_structure_that_names_no_encoding_is_not_a_declaration`.
        return [
            "structure declares no `encoding` — an empty/encoding-less structure is not "
            "a declaration about the bytes (INV-2), and `workstore::ingest` refuses it "
            "at the manifest for the same reason"
        ]
    if encoding == "opaque":
        return _conform_opaque(root, structure, evidence=evidence)
    if encoding != "zarr_v3":
        return [
            f'unknown encoding {encoding!r} — this suite implements "zarr_v3" and "opaque"'
        ]

    kind = structure.get("kind")
    if kind == "table":
        return _conform_table(root, structure, full=full, meta=meta, evidence=evidence)
    if kind == "sparse_csc":
        return _conform_sparse_csc(root, structure, full=full, evidence=evidence)
    return [
        f'zarr_v3 artifact declares kind {kind!r} — this suite implements "table" and '
        f'"sparse_csc"'
    ]


def _conform_opaque(root, structure, *, evidence=None):
    """An `opaque` artifact declares a media type and IS its bytes — and that CLAIM is
    checked, not taken.

    ## Why this is the most security-relevant branch in the module

    `opaque` is a legitimate declaration: an HTML report, a PDF, a user's uploaded
    `.h5ad` genuinely have no member structure this suite could verify. But the branch
    that says "there is nothing to check" is, by construction, the branch that checks
    nothing — so if the declaration alone selects it, a producer disables the gate on its
    own output by writing five words in a manifest. That is exactly the knob DEC-8 says
    does not exist ("the processor author can neither write nor weaken it"), reintroduced
    under a different name, and it was real: the previous implementation verified only
    that `media_type` was truthy and the path existed.

    So the claim is cross-checked against the bytes. Three things must hold, and each one
    is a way the claim can be FALSE rather than a way it can be incomplete:

    1. **The declaration is not self-contradictory.** An `opaque` structure carrying
       `columns`/`kind`/`nnz`/… is describing structure it simultaneously says it has
       none of. That is a producer that wrote a `zarr_v3` declaration and edited one
       field.
    2. **The bytes are not a store this suite could have checked.** A Zarr store declared
       `opaque` is the bypass in its purest form: the artifact IS structured, the gate CAN
       verify it, and the declaration is what stops it. A `zarr.json` under `root` refutes
       the claim outright, and a directory the walk cannot ENUMERATE refuses it too —
       "there might be one in there" is not "there is none", and the difference is the
       whole check. That second half is not a nicety: it was missing, the walk used
       `rglob`, and `rglob` silently skips an unlistable directory, so a `chmod 0o111` on
       one subdirectory converted the condemnation into an unverified-and-still-serving
       verdict. See [`_bytes_are_not_a_store`] for the measurement.
    3. **The bytes agree with the declared media type**, wherever that is mechanically
       decidable — JSON must parse, `text/*` must decode. A media type nothing can
       contradict is a free-form string, and the presence check that accepted `media_type`
       would accept `"x"` just as happily.

    None of this makes `opaque` un-declarable; it makes it *falsifiable*, which is the
    difference between a declaration and an opt-out.
    """
    out = []
    root = Path(root)

    media_type = structure.get("media_type")
    if not media_type:
        out.append("an `opaque` artifact must declare a `media_type` (INV-2)")
    elif not isinstance(media_type, str) or not _MEDIA_TYPE_RE.match(media_type.strip()):
        out.append(
            f"an `opaque` artifact declares media_type {media_type!r}, which is not a "
            "media type (`type/subtype`) — a presence check that accepts any string is "
            "not a declaration"
        )

    # (1) The declaration against itself. Cheap, and it needs no bytes at all.
    contradictory = [k for k in _STRUCTURED_ONLY_KEYS if k in structure]
    if contradictory:
        out.append(
            f"an `opaque` artifact declares {contradictory} — those describe a structured "
            "(`zarr_v3`) artifact, so this declaration says the bytes both have and have "
            "no member structure"
        )

    if not root.exists():
        out.append(f"declared bytes are missing at {root}")
        return out

    # (2) THE ANTI-BYPASS CHECK. `opaque` is the only encoding whose check is shallow, so
    # it is the only one worth mis-declaring; bytes that are a Zarr store refute it.
    # It is handed NO evidence sink: a tree walk lists, it does not read (see [`Evidence`]).
    out += _bytes_are_not_a_store(root)

    # (3) The media type against the bytes, where that is decidable.
    if isinstance(media_type, str):
        out += _opaque_bytes_agree_with_media_type(root, media_type, evidence=evidence)
    return out


def _bytes_are_not_a_store(root):
    """`[]` unless `root` holds a Zarr store — i.e. unless the `opaque` claim is false.

    A single FILE cannot be a store (a store is a directory of `zarr.json` nodes), so the
    walk only applies to a multi-file artifact. It is bounded by [`_OPAQUE_WALK_LIMIT`]:
    a real store trips it within its first entries, and an artifact large enough to
    exhaust the bound is reported as unverifiable rather than silently passed — "too big
    to check" must not read the same as "checked and fine".

    It takes NO `evidence` sink, because it earns none. This walk LISTS entries; it opens
    no file, so nothing about the artifact's bytes has been read when it returns. It used
    to record `Evidence.enumerated(seen)` here, which is what made a directory-shaped
    `opaque` artifact CONFORM on a listing alone — see [`Evidence`] for the measured
    verdict and for why the verb was deleted rather than qualified. The refusals below are
    the walk's whole output, and a refusal needs no receipt: it is named in `violations`,
    which is what the server acts on.

    ## The THIRD walk, and why it is spelled like the other two

    This enumerates with an explicit `iterdir` stack. It used to use `Path.rglob("*")`, and
    that was the same fail-OPEN the two store walks were fixed for — reached through a
    library instead of through a `continue`. CPython's recursive-glob machinery catches
    `PermissionError` internally, so `rglob` SILENTLY SKIPS a directory it cannot list
    (measured on 3.10.12; the swallow is the interface's documented behaviour, not one
    implementation's):

        sub/ at mode 0o111 holding zarr.json
          root.rglob("*")   -> [sub]                 # sub/zarr.json never yielded
          sub.iterdir()     -> PermissionError

    So the ANTI-BYPASS check — the one thing standing between an `opaque` declaration and a
    real store — could not see a `zarr.json` one `chmod` down. Measured through the real
    `verify_conformance.main()` on an `opaque`-declared store whose only node document sits
    at `sub/zarr.json`, varying only that mode:

    * `0o755` → `violations: {<aid>: ["… the bytes are a Zarr store (sub/zarr.json …)"]}`,
      which `apply_verdict` turns into `status = 'failed'`.
    * `0o111` → `violations: {}`, `checked: []`, `evidence: {}` — no condemnation and no
      receipt, i.e. `GateOutcome::Indeterminate`, statuses UNTOUCHED, the mis-declared store
      still serving.
    * `0o000` → identical to `0o111`.

    A producer disabling the gate on its own output is the exact knob DEC-8 says does not
    exist, and one `chmod` on a subdirectory of that output turned the condemnation into
    silence. `rglob` is therefore gone: an unenumerable directory is REPORTED here through
    the same [`_unreadable_dir_violations`] the other two walks use, so all three sites have
    one behaviour and one spelling rather than two that fail closed and one that does not.

    Every return path assembles its violations through `found()` for the reason
    [`_store_nodes`] does: three of them leave this function, and a forgotten
    `+ _unreadable_dir_violations(...)` on any one would reinstate the silence on whichever
    artifact happens to trip that path.
    """
    root = Path(root)
    if not root.is_dir():
        return []
    unreadable = []

    def found(extra=()):
        """Every violation this walk has, assembled in ONE place."""
        return list(extra) + _unreadable_dir_violations(unreadable)

    seen = 0
    stack = [root]
    while stack:
        current = stack.pop()
        try:
            entries = sorted(current.iterdir())
        except OSError as exc:
            # REPORTED, not skipped — see [`_unreadable_dir_violations`]. `rglob` did this
            # silently, inside pathlib, which is why no `except OSError` clause in this
            # module ever named the fault and no handler-body scan could have found it.
            unreadable.append((_rel(root, current), exc))
            continue
        for entry in entries:
            seen += 1
            if seen > _OPAQUE_WALK_LIMIT:
                return found([
                    f"declared `opaque`, but the artifact holds more than "
                    f"{_OPAQUE_WALK_LIMIT} entries — too many to establish that it is not a "
                    "structured store, so the claim is unverified rather than accepted"
                ])
            if entry.name == _NODE_META and entry.is_file():
                rel = _rel(root, entry)
                return found([
                    f"declared `encoding: opaque`, but the bytes are a Zarr store ({rel} is a "
                    "Zarr node) — `opaque` is the one encoding whose contents this suite does "
                    "not verify, so declaring it over a store the suite CAN verify disables "
                    "the gate for this artifact (DEC-8: no declaration may weaken it)"
                ])
            if entry.is_dir():
                stack.append(entry)
    return found()


def _opaque_bytes_agree_with_media_type(root, media_type, *, evidence=None):
    """`[]` unless the bytes contradict the declared media type.

    Only the two families whose disagreement is DECIDABLE are judged. Sniffing a
    `application/pdf` or an HDF5 upload would be guesswork, and a gate that guesses fails
    honest producers; JSON that does not parse and `text/*` that is not text are not
    guesses.

    ## The bounded read happens for EVERY media type, and is recorded

    The read used to be conditional on the media type being one of the two decidable
    families, so a file-shaped `application/pdf` artifact was never opened: the gate
    reached "conforms" without touching a byte of it. Two consequences, both fixed by
    reading first and judging second:

    * it earned no [`Evidence`], and `checks > 0` now MEANS "this artifact's bytes were
      read" — an artifact with no receipt is one the entry reports as unexamined, so a
      legitimate PDF would have been dragged into that bucket;
    * "the declared bytes are readable" went unchecked for exactly the artifacts whose
      contents nothing else in this module looks at.

    The read is capped at [`_OPAQUE_READ_LIMIT`], as it always was. Over that cap the
    media-type judgement is still skipped — a >64 MiB payload is out of scope for a
    content check and inventing one would be the gate guessing — but the prefix has been
    read, so the artifact is accounted for either way.

    A read the OS REFUSES is answered here the way it is answered by every other reader in
    this module: as a violation of this artifact. That includes a mode-000 file, which is
    condemned for a permissions setting — see the RECORDED LIMITATION block above
    `ManifestReport` for the two withdrawn attempts at a third answer and for what a future
    one has to get right. Uniformity is the property being kept: this branch had a bespoke
    `except OSError: return []` for one round, and an `opaque` artifact silently passing a
    fault that condemned the identical `zarr_v3` artifact is its own defect.
    """
    root = Path(root)
    if not root.is_file():
        return []
    try:
        size = root.stat().st_size
        with open(root, "rb") as fh:
            raw = fh.read(_OPAQUE_READ_LIMIT)
    except OSError as exc:
        return [f"declared bytes at {root} are not readable: {exc}"]
    _note(evidence, "read", len(raw))
    essence, params = _split_media_type(media_type)
    is_json = essence == "application/json" or essence.endswith("+json")
    charset = params.get("charset")
    is_text = essence.startswith("text/") and (
        charset is None or charset in _UTF8_CHARSETS
    )
    if not (is_json or is_text):
        return []
    if size > _OPAQUE_READ_LIMIT:
        return []
    if is_json:
        try:
            json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            return [
                f"declared media_type {media_type!r} but the bytes are not JSON: {exc}"
            ]
        return []
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        return [
            f"declared media_type {media_type!r} but the bytes are not valid UTF-8 text: "
            f"{exc}"
        ]
    return []


def _split_media_type(media_type):
    """`"text/html; charset=UTF-8"` → `("text/html", {"charset": "utf-8"})`."""
    head, _, tail = str(media_type).strip().partition(";")
    params = {}
    for part in tail.split(";"):
        key, sep, value = part.partition("=")
        if sep:
            params[key.strip().lower()] = value.strip().strip('"').lower()
    return head.strip().lower(), params


# ── zarr_v3 / table ──────────────────────────────────────────────────────────────


def _conform_table(root, structure, *, full, meta=None, evidence=None):
    out = []
    n = structure.get("n")
    if not isinstance(n, int):
        out.append(f"a table must declare an integer `n`, got {n!r}")
    axis = structure.get("axis")
    if not axis:
        out.append("a table must declare its `axis` (INV-2)")

    out += _conform_group_attributes(root, structure)

    members = list(structure.get("columns") or []) + list(structure.get("arrays") or [])
    if not members:
        out.append(
            "a table declares no members — an artifact with nothing in it is a producer "
            "bug, not an empty result (INV-2)"
        )
    seen = set()
    for member in members:
        path = member.get("path")
        if path in seen:
            out.append(f'duplicate member path "{path}"')
        seen.add(path)
        out += _conform_member(
            root, member, expect_rows=n, full=full, evidence=evidence
        )

    out += _conform_aux(root, structure, full=full, evidence=evidence, member_paths=seen)
    out += _conform_node_coverage(root, structure)
    out += _conform_key(root, structure, meta=meta, member_paths=seen)
    out += _conform_aligned_to(structure)
    out += _conform_groups_entries(structure, meta)
    return out


def _conform_group_attributes(root, structure):
    """The group's `zarr.json` carries the SAME declaration the artifact row does — that
    is the promise `Table.close()`/`write_csc_zarr()` make ("a client handed nothing but
    the store URL learns the layout"). Two copies that can drift is exactly the class of
    bug this suite exists for, so they are compared, not assumed.

    `OSError` rather than `FileNotFoundError`: a declared `zarr_v3` artifact whose bytes
    are a FILE raises `NotADirectoryError`, which is an `OSError` and not a
    `FileNotFoundError`, so the narrower clause let that case escape as an exception —
    which then aborted the whole batch's verdict (see `conform_manifest`).

    A mode-000 group `zarr.json` lands on the same clause and is condemned by it, which is
    a statement about the artifact made on the strength of a permission error — known, and
    kept deliberately: see the RECORDED LIMITATION block above `ManifestReport`.
    """
    try:
        stamped = cyto_zarr_read.structure(root)
    except FileNotFoundError:
        return [f"no group zarr.json at {root} — an artifact is a Zarr store"]
    except OSError as exc:
        return [
            f"the group zarr.json at {root} is not readable ({type(exc).__name__}: {exc})"
            " — a `zarr_v3` artifact is a DIRECTORY of Zarr nodes"
        ]
    except (KeyError, TypeError, ValueError):
        return [f"group zarr.json at {root} carries no `attributes.cyto` declaration"]
    if stamped != structure:
        return [
            "the declaration stamped into the group's zarr.json differs from the returned "
            "`structure` — a consumer reading the store URL and a consumer reading the "
            "artifact row would decode differently"
        ]
    return []


def _malformed_member_keys(member, kind):
    """`[(key, value, phrase)]` — every required key declared in the WRONG FORM.

    Absence is NOT this function's answer: a missing key is
    [`_required_member_key_violations`]' finding, and naming one fault twice makes an author
    fix it twice. What is left is the value that IS there and is not a value of the kind the
    gate can compare — which used to be either a crash (`list(200)`) or a silently skipped
    comparison (`isinstance(declared_shape, list)`), per kind.

    Kept separate from the message formatting because [`_conform_member`] needs the same
    answer as a DECISION (whether it may carry this declaration into the comparisons below)
    rather than as prose.
    """
    out = []
    for key in _REQUIRED_MEMBER_KEYS.get(kind or "", ()):
        value = member.get(key)
        phrase, well_formed = _MEMBER_KEY_FORMS[key]
        if value is not None and not well_formed(value):
            out.append((key, value, phrase))
    return out


def _required_member_key_violations(member):
    """Every key a member declaration OMITS that the gate needs — the class-level fix.

    ## Why this is at the top of `_conform_member` and not spread through it

    Every check below this function used to be written `if member.get(k) is not None:` — so
    a producer omitting `k` did not fail the check, it SKIPPED it. That made each member key
    an opt-out (DEC-8) and made every one of them a separate discovery: three were found and
    closed one at a time before the shape itself was named. Here the requirement is data
    ([`_REQUIRED_MEMBER_KEYS`]) and the check is one loop, so the N+1st key is covered by
    construction rather than by somebody remembering.

    The `kind` requirement is first because it SELECTS the required set: with no kind there
    is no way to know which keys apply, and a kind this suite does not implement is refused
    by name rather than checked as if it were numeric.

    An UNKNOWN key — in neither [`_REQUIRED_MEMBER_KEYS`] nor [`_OPTIONAL_MEMBER_KEYS`] — is
    reported as well. That is what keeps the two tables exhaustive: a key added to the writer
    without a decision about whether the gate checks it fails loudly instead of riding along.

    ## …and a key that is PRESENT in the wrong FORM is refused here too

    Requiring the key and not its type left the same lever with the value in place: a
    producer declaring `shape: 200` satisfies the loop above, and every comparison keyed on
    `shape` was written behind an `isinstance` guard that a scalar switched OFF. That is one
    level below where this function stopped, and it is decided in the same place and by the
    same kind of table ([`_MEMBER_KEY_FORMS`]), so a required key's FORM is part of what
    "required" means rather than a per-kind `isinstance` at each use.
    """
    out = []
    kind = member.get("kind")
    if kind is None:
        out.append(
            'a member declares no `kind` (INV-2) — the kind selects what the gate can check '
            f"about it, so its absence is not a member checked loosely, it is a member that "
            f"cannot be checked at all (expected one of {list(_MEMBER_KINDS)})"
        )
    elif kind not in _MEMBER_KINDS:
        out.append(
            f'member "{member.get("path")}" declares kind {kind!r} — this suite implements '
            f"{list(_MEMBER_KINDS)}, and an unimplemented kind checked as if it were "
            '"numeric" would silently shed whatever its own kind requires'
        )
    else:
        missing = [k for k in _REQUIRED_MEMBER_KEYS[kind] if member.get(k) is None]
        if missing:
            out.append(
                f'member "{member.get("path")}" ({kind}) declares no {missing} — every key '
                "in that list is one this gate COMPARES against the stored member, so "
                "omitting it does not relax the check, it removes it (INV-2: absence is an "
                "error; DEC-8: no producer-authored omission may make the gate look less "
                "hard). A key that is genuinely optional is listed as such, with its "
                "reason, in `_OPTIONAL_MEMBER_KEYS`"
            )
    for key, value, phrase in _malformed_member_keys(member, kind):
        out.append(
            f'member "{member.get("path")}" ({kind}) declares {key}={value!r}, which is not '
            f"{phrase} — a required key in the wrong form is not a check that runs looser, "
            "it is a check that cannot run at all: every comparison this gate makes with "
            f"`{key}` reads it as {phrase}, so a value that is not one either crashes that "
            "comparison or is skipped by the guard written to survive it (INV-2: the type is "
            "part of what is required; DEC-8: no producer-authored declaration may make the "
            "gate look less hard)"
        )
    unknown = sorted(
        k for k in member
        if k not in _OPTIONAL_MEMBER_KEYS
        and k not in _REQUIRED_MEMBER_KEYS.get(kind or "", ())
    )
    if unknown:
        out.append(
            f'member "{member.get("path")}" declares {unknown}, which this gate neither '
            "requires nor knows to be optional — a member key the gate has no opinion about "
            "is a declaration nothing checks. Add it to `_REQUIRED_MEMBER_KEYS` with the "
            "comparison it enables, or to `_OPTIONAL_MEMBER_KEYS` with the reason its "
            "absence cannot weaken the gate"
        )
    return out


def _stamped_key_violations(path, kind, stamped_key, row_key, stamped_value, row_value,
                            *, required_because):
    """ONE (stamp, row) pair — all FOUR presence combinations, none of them a `continue`.

    ## Why this is a function and not two lines inside a loop

    It was two lines inside a loop, and they were `if stamped_key not in stamped or row_key
    not in member: continue`. So a key ABSENT from the stored stamp skipped its comparison,
    which is the same "absence selects a shallower check" the row-level tables were built to
    retire — moved one level down, into the copy of the declaration the store itself carries.
    The oracle: pop ONLY `attributes.cyto.kind` from a categorical member's `zarr.json` and
    the gate reported `[]` while `cyto_zarr_read.read_column` returned raw `uint8` codes
    where the declaration says labels.

    Absence is a VALUE here ([`_ABSENT`]), the four combinations are enumerated, and
    "required" is read from a TABLE keyed by kind ([`_REQUIRED_STAMPED_KEYS`]) rather than
    inferred from whether the key happened to be there. That is what makes the next stamped
    key covered by construction instead of by somebody remembering to add an `if`.

    Row-side absence is deliberately NOT this function's finding: a required row key that is
    missing is [`_required_member_key_violations`]' violation (naming one fault twice makes
    an author fix it twice), and a row key that is explicitly optional is legal — `cyto_csc`'s
    members stamp a `name` their row does not carry.
    """
    if stamped_value is _ABSENT:
        if required_because:
            return [
                f'member "{path}" is declared {kind} but its own zarr.json stamps no '
                f"`{stamped_key}` — {required_because}. A consumer holding nothing but the "
                "store URL reads this member's declaration from that stamp and from nowhere "
                "else, so a "
                "key absent there is not a check that runs looser, it is a consumer decoding "
                "something else (INV-2, DEC-8)"
            ]
        if row_value is _ABSENT:
            # Neither copy carries it, and the kind's table says a store-URL consumer does
            # not need it. There is nothing to compare and nothing being skipped.
            return []
        return [
            f'member "{path}" declares {row_key}={row_value!r} in the artifact row but '
            f"stamps no `{stamped_key}` in its own zarr.json — the two copies of one fact "
            "have to agree, and one of them not existing is the strongest disagreement "
            "there is"
        ]
    if row_value is _ABSENT:
        # See the docstring: the row side belongs to `_required_member_key_violations`.
        return []
    if stamped_value != row_value:
        return [
            f'member "{path}" is stamped {stamped_key}={stamped_value!r} in its '
            f"own zarr.json but declared {row_key}={row_value!r} in the artifact "
            "row — a consumer reading the store URL and a consumer reading the row "
            "would decode this member differently"
        ]
    return []


def _conform_member_attributes(path, kind, member, node):
    """The member's OWN stamped `attributes.cyto` against the row's member declaration.

    ## The second copy nobody was comparing

    `_conform_group_attributes` checks the GROUP's stamped declaration against the row's
    `structure`, because "two copies that can drift is exactly the class of bug this suite
    exists for". `write_array` stamps a THIRD copy of the same facts onto each MEMBER
    (`cyto_zarr._member_meta` → `attributes.cyto.{kind, name}`, plus `levels`/`ordered` for a
    categorical, `layout`/`n` for a string group, `role` for a CSC member) and nothing
    compared it.

    Oracle for why that matters: edit ONLY `<member>/zarr.json`'s
    `attributes.cyto.{kind, levels}` — leave the row, the group stamp and every byte alone —
    and the whole gate reported `[]`, while a consumer holding nothing but the store URL
    decoded a categorical member's raw codes where `structure` declares labels. §0.3 names
    the store-URL client as first-class and `cyto_zarr_read.read_column` is its reference
    implementation: it reads `kind`/`levels` from exactly this stamp. The fault is latent
    today only because the browser reader happens to prefer the row's copy.

    The stamp is REQUIRED, not merely compared: a member node carrying no `attributes.cyto`
    is one a store-URL consumer learns nothing about, which is the same
    absence-selects-a-shallower-check shape one level down.

    ## …and the KEYS of that stamp are required too, per kind

    Requiring the stamp to EXIST closed one level and left the next one open: the loop that
    compared it read each key with `in` and `continue`d when the stamp did not carry it, so an
    absent stamped key still selected a shallower check. The two the writer's categorical path
    happens to emit (`levels`, `ordered`) had a bespoke `if` — which is what closing a class
    for the instances somebody thought of looks like — and `kind` did not, so the load-bearing
    key was the unguarded one.

    Per-kind requirement now comes from [`_REQUIRED_STAMPED_KEYS`], the four presence
    combinations are enumerated in [`_stamped_key_violations`], and a stamped key in neither
    that table nor [`_OPTIONAL_STAMPED_KEYS`] is reported — the same three-part shape (require
    / explicitly-permit / refuse-the-unknown) that makes the ROW's tables exhaustive.

    Takes the member's already-parsed `zarr.json` (`node`) rather than reading it: this used
    to read the node itself and return `[]` when the read FAILED, on the grounds that "the
    caller reports that". The caller reported it for two kinds out of three (`_conform_member`
    returned into the string branch before ever reading the node), so a string member whose
    own `zarr.json` was DELETED produced no violation from anywhere. One read, in the caller,
    for every kind — so there is no arm in which nobody reports it.
    """
    stamped = (node.get("attributes") or {}).get("cyto")
    if not isinstance(stamped, dict):
        return [
            f'member "{path}" carries no `attributes.cyto` declaration in its own zarr.json '
            "— the store is the only thing a consumer given just the `/data` URL can read, "
            "so a member with no stamped declaration is a member that consumer cannot "
            "decode (INV-2)"
        ]
    # An absent or unimplemented `kind` is refused by name in
    # `_required_member_key_violations`; the floor keeps "the gate cannot resolve the kind"
    # from becoming "the gate requires nothing of the stamp".
    required = _REQUIRED_STAMPED_KEYS.get(kind, _STAMP_FLOOR)
    out = []
    for stamped_key, row_key in _STAMPED_MEMBER_KEYS.items():
        out += _stamped_key_violations(
            path, kind, stamped_key, row_key,
            stamped.get(stamped_key, _ABSENT), member.get(row_key, _ABSENT),
            required_because=required.get(stamped_key),
        )
    # Required stamped keys that restate no ROW key, so the loop above never sees them: a
    # string member's `n` is the group's own statement of its length (the row's counterpart
    # is `shape`, compared below).
    for stamped_key, reason in required.items():
        if stamped_key not in _STAMPED_MEMBER_KEYS and stamped_key not in stamped:
            out += _stamped_key_violations(
                path, kind, stamped_key, stamped_key, _ABSENT, _ABSENT,
                required_because=reason,
            )
    unknown = sorted(
        k for k in stamped if k not in _OPTIONAL_STAMPED_KEYS and k not in required
    )
    if unknown:
        out.append(
            f'member "{path}" stamps {unknown} in its own zarr.json, which this gate neither '
            "requires nor knows to be optional — a stamped key the gate has no opinion about "
            "is the second copy of a declaration nothing compares. Add it to "
            "`_REQUIRED_STAMPED_KEYS` with what a store-URL consumer decodes with it, or to "
            "`_OPTIONAL_STAMPED_KEYS` with the reason its absence cannot weaken the gate"
        )
    if kind == "string":
        stamped_n = stamped.get("n")
        declared_shape = member.get("shape")
        # Both guards are `is not None` and nothing more: an absent stamped `n` is
        # `_stamped_key_violations`' finding (it is in `_REQUIRED_STAMPED_KEYS["string"]`)
        # and an absent row `shape` is `_required_member_key_violations`', so the only thing
        # either can skip here is a fault already named. The `isinstance(declared_shape,
        # list)` this used to carry could skip it for a fault named NOWHERE — a scalar
        # `shape` turned off the only check pinning this stamp.
        if stamped_n is not None and declared_shape is not None:
            # `declared_shape[0]` needs no `int(...)`: `_MEMBER_KEY_FORMS` pins the row's
            # form. The stamp's is the other copy and this module does not pin it, so that
            # side keeps its coercion.
            if int(stamped_n) != declared_shape[0]:
                out.append(
                    f'string member "{path}" is stamped n={stamped_n} but declared shape '
                    f"{declared_shape} in the artifact row"
                )
    return out


def _declared_member_nodes(structure):
    """Every store node path the `structure` DECLARES, relative to the artifact root.

    A string member declares three: the group at `<path>` plus its `offsets`/`values` arrays,
    which the declaration names explicitly (that is what those two keys are for), so this
    derives them from the declaration rather than assuming the writer's naming.

    A membership's INDEX BODY (ITEM-3) is declared on the membership entry rather than in
    `columns`, because it is not a column of this table: its length is the member count and
    its values are positions into a different sequence. It is still a stored node and must
    still be named, or writing one would be the free opt-out this check exists to close.

    `aux` is in the list for the reason the whole channel exists (ITEM-12): an aux member's
    length is not the axis's `n`, so it cannot ride in `columns`, and a member this function
    did not name would be refused by [`_conform_node_coverage`] as an undeclared stored node.
    Adding it here is what makes an aux member STOREABLE — and it is the half that must not
    be added without [`_conform_aux`], or the channel would be the free opt-out that
    function's own docstring is about.
    """
    nodes = set()
    members = (
        list(structure.get("columns") or [])
        + list(structure.get("arrays") or [])
        + list(structure.get("memberships") or [])
        + list(structure.get("aux") or [])
        + [structure.get(role) for role in ("indptr", "indices", "data")]
    )
    for member in members:
        if not isinstance(member, dict):
            continue
        path = member.get("path")
        if not path:
            continue
        nodes.add(str(path).strip("/"))
        for leg in ("offsets", "values"):
            leg_path = member.get(leg)
            if leg_path:
                nodes.add(str(leg_path).strip("/"))
    return nodes


def _rel(root, path):
    """`path` relative to the artifact root, in store (`/`-separated) form."""
    return str(Path(path).relative_to(root)).replace("\\", "/")


def _chunk_grid(meta):
    """`[chunks along each dimension]`, [`_NO_CHUNK_PLANE`], or [`_UnderivableGrid`] — the KEY
    SPACE a node's own metadata declares.

    This is the half the chunk plane was missing. [`_CHUNK_KEY_RE`] asks whether an entry is
    SHAPED like a chunk key; this asks which chunk keys the declared array actually HAS, and
    only the second bounds a set. Per dimension the count is `ceil(shape[d] / chunk_shape[d])`
    over the OUTER (`chunk_grid`) shape — the shard grid, since `cyto_zarr` writes one file
    per shard — which is the identical arithmetic `cyto_zarr_read.read_array` uses to decide
    which keys to fetch and [`_shard_count`] uses to count them. A reader and this rule
    therefore cannot disagree about which files exist by construction rather than by review.

    ## Derived from the node's OWN `zarr.json`, and why that IS the declaration

    The obvious source is the member's ROW in `structure` (`shape` / `inner_chunk` /
    `chunks_per_shard`), and for a numeric or categorical member it would serve. It cannot be
    the only source, because the two nodes that actually hold a string member's bytes —
    `<col>/offsets` and `<col>/values` — get NO geometry in the row at all: `Table.string`
    lets each leg derive its own `chunks_per_shard` from its own length (the offsets are
    `n + 1` elements, the payload is `n_bytes`), and the row carries neither. A rule keyed on
    the row would have no answer for those two nodes, i.e. exactly the "a kind with no
    checker" exception `_read_member_node` was written to retire.

    Reading the node's own document loses nothing, because the row IS pinned to it, three
    ways and for every fixed-width member: [`_conform_member`] compares `dtype` and `shape`,
    and [`_conform_geometry`] compares `inner_chunk`, `chunks_per_shard` AND the derived
    `shards` count against this same grid. So `row ≡ zarr.json` (checked there) ∧
    `zarr.json ≡ files present` (checked here) gives `row ≡ files`, and inflating the stored
    grid to widen the legal key set fails the first conjunct. For a string leg, whose row is
    silent, the grid is instead pinned by the DECODE: `_conform_string_member` reads both legs
    whole and compares the offset count against the axis and the payload length against
    `n_bytes`.

    ## The three answers are three different facts, and NONE of them is "no answer"

    * a list — an ARRAY node; its keys are the cells of this grid, and nothing else.
    * [`_NO_CHUNK_PLANE`] — a GROUP node. Not an empty grid: there is no index space at all,
      so no key under it can name a chunk. `<root>/c/0` and `label/c/0` are this case. This
      is the ONE thing this function may still legitimately refuse to give a grid for,
      because it is a fact about the node's kind rather than a gap in the derivation.
    * [`_UnderivableGrid`] — the metadata does not describe a grid. **A VIOLATION**, reported
      by [`_underivable_grid_violation`], not a skip.

    That third answer used to be `None` and used to skip the grid rule, on the argument that
    every path reaching it is already a failing path. Measured, that argument was false: the
    checks it named read `shape` and `chunk_shape[0]` and nothing else, so an arity mismatch
    (`shape [200]`, `chunk_shape [4096, 4096]`) sailed through `_conform_member`,
    `_conform_geometry` and `_shard_count` alike and carried 12 MB at `value/c/999` through
    `conform_outputs` for `[]`. Three of the nine shapes were silent, not one, and the arity
    one was silent on every node kind there is. See [`_UnderivableGrid`] for the measurement.

    ## The rule that keeps it total

    Every exit from the loop below is a REFUSAL, so there is no shape of metadata for which
    this function declines to have an opinion. A conforming store never reaches one: an array
    node yields a list (pinned set-against-set by
    `test_the_derived_grid_is_EXACTLY_the_real_writers_chunk_key_set`) and a group yields
    [`_NO_CHUNK_PLANE`].
    """
    if not isinstance(meta, dict):
        return _UnderivableGrid(f"is not a JSON object (it is a {type(meta).__name__})")
    shape = meta.get("shape")
    grid = meta.get("chunk_grid")
    cfg = grid.get("configuration") if isinstance(grid, dict) else None
    chunk_shape = cfg.get("chunk_shape") if isinstance(cfg, dict) else None
    if shape is None and grid is None:
        return _NO_CHUNK_PLANE
    if not isinstance(shape, list):
        return _UnderivableGrid(f"declares no `shape` list (it declares {shape!r})")
    if not isinstance(chunk_shape, list):
        return _UnderivableGrid(
            "declares no `chunk_grid.configuration.chunk_shape` list (it declares "
            f"{chunk_shape!r})"
        )
    if not shape:
        return _UnderivableGrid("declares an empty `shape`, which spans no index at all")
    if len(shape) != len(chunk_shape):
        return _UnderivableGrid(
            f"declares a {len(shape)}-dimensional `shape` {shape!r} against a "
            f"{len(chunk_shape)}-dimensional `chunk_shape` {chunk_shape!r}"
        )
    dims = []
    for extent, step in zip(shape, chunk_shape):
        if isinstance(extent, bool) or not isinstance(extent, int) or extent < 0:
            return _UnderivableGrid(
                f"declares a `shape` extent that is not a non-negative integer ({extent!r})"
            )
        if isinstance(step, bool) or not isinstance(step, int) or step < 1:
            return _UnderivableGrid(
                f"declares a `chunk_shape` step that is not a positive integer ({step!r})"
            )
        dims.append(-(-extent // step))
    return dims


def _node_chunk_grid(node_dir):
    """[`_chunk_grid`] of the node at `node_dir`, read from its own `zarr.json`.

    One extra read per node that HAS a `c/` dir — a file the gate already reads for every
    declared member ([`_read_member_node`]) — against a walk already bounded at
    [`_NODE_WALK_LIMIT`] nodes.

    A read that FAILS is an [`_UnderivableGrid`] like any other, for the same reason: a node
    holding a chunk plane it cannot describe is malformed, and "the gate could not read it"
    must not be the thing that decides which rule runs on the bytes under it. The cost is
    that a mode-000 node `zarr.json` condemns the artifact for a permissions setting — see
    the RECORDED LIMITATION block above `ManifestReport` for why that direction is the one
    kept, and for what a third answer would have to get right.
    """
    try:
        meta = json.loads((node_dir / _NODE_META).read_text())
    except OSError as exc:
        return _UnderivableGrid(f"is not readable ({exc})")
    except ValueError as exc:
        return _UnderivableGrid(f"is not parseable as JSON ({exc})")
    return _chunk_grid(meta)


def _chunk_key_place(parts, grid, is_dir):
    """Where the key components `parts` sit in `grid`: `"cell"`, `"prefix"`, or `None`.

    A CELL is a chunk: a FILE at exactly one component per dimension, each an in-range index.
    A PREFIX is the directory a deeper cell lives under (`c/3/` of a 2-D member's `c/3/0`).
    `None` is everything else, and "everything else" is the point — it covers an index past
    the end of the grid (`c/7` where the grid holds one chunk), a directory sitting where a
    shard file belongs, a file sitting where a directory belongs, a key deeper than the array
    has dimensions, and a NON-CANONICAL spelling.

    Canonical decimal (`name == str(int(name))`) because the key space is the set of strings
    a reader BUILDS, not the set of integers it could parse: `cyto_zarr` writes `f"{s}"` and
    `cyto_zarr_read` fetches `f"{s}"`, so `c/007` is a file that exists beside the real `c/7`
    and that no reader will ever open. `c/00000000123456789` was one of the measured silent
    probes, and it is this arm that catches it.
    """
    if grid is _NO_CHUNK_PLANE or not isinstance(grid, list) or len(parts) > len(grid):
        return None
    for name, extent in zip(parts, grid):
        if name != "0" and name.startswith("0"):
            return None
        # Digit COUNT first, and not merely as an optimisation: a filename may carry 255
        # digits, and CPython ≥ 3.11 raises on `int()` of a very long string — a walk that
        # RAISES reports nothing at all, which is the failure mode this whole file is about.
        # For canonical decimals more digits means strictly larger, so this is exact.
        if len(name) > len(str(extent)) or int(name) >= extent:
            return None
    if len(parts) == len(grid):
        return None if is_dir else "cell"
    return "prefix" if is_dir else None


def _chunk_dir_violations(root, chunk_dir, seen, grid):
    """`(entries seen | None, name strays, ungridded entries, unreadable dirs)` for ONE
    node's `c/` directory.

    ## The one part of a store nothing looked at

    The node walk does not recurse into `c/` — correctly, since it holds shard FILES rather
    than nodes — and it used to `continue` past it entirely. That made `c/` the single place
    in a store where bytes were neither declared nor reported: a file at `<member>/c/evil`
    was invisible to the whole gate (measured: `[]`), and so was a hidden NODE at
    `<member>/c/sneaky/zarr.json`, since the walk that would have found it never descended.

    ## …and holding it to a NAME was still not holding it to the declaration

    The first fix said "every entry here is named by chunk index" ([`_CHUNK_KEY_RE`]) and
    called the file rule TOTAL. It was not: a name rule accepts any numerically-named entry,
    so the whole chunk plane stayed open to anything that could count. Measured silent AFTER
    that fix: `value/c/7` on a member with one shard, `value/c/00000000123456789`, 5 MiB of
    random bytes at `value/c/1`, `<root>/c/0` and `label/c/0` under group nodes that own no
    chunks at all, `xy/c/0/1` where the width is a single chunk, and 6 MiB spread across two
    chunk planes through the real `conform_outputs` entry.

    That is the same class one step over, and naming the step is what decides the fix: the
    earlier rounds closed "absence skips a check" at the row, at the stamp and at the `full`
    parameter; `c/` closed "the walk does not look there"; this closes **"the walk looks but
    does not know what belongs there."** A name rule asks whether an entry is SHAPED like a
    chunk key. The rule that bounds the plane asks whether the declared array HAS that chunk
    — [`_chunk_grid`] — and only the second one is a set.

    So the plane is now total the way the file rule claimed to be: an entry is a chunk iff it
    is a CELL of the node's grid ([`_chunk_key_place`]), every in-grid cell is READ by
    `_decode` (at `full=True`, every shard), and every other entry is reported here. Read or
    reported, with no third outcome.

    ## The one case that is decided ABOVE this function, and why

    "Every entry is held to the node's grid" presumes the node HAS one. When it does not
    ([`_UnderivableGrid`]) that is the violation, raised against the NODE by
    [`_store_nodes`] before this walk starts — so the artifact is refused whatever is parked
    here, including nothing. That used to be a `None` that skipped the grid rule and left the
    name rule as the whole check, which is how 12 MB at `value/c/999` behind an
    arity-mismatched member came back `[]`. The entries themselves are deliberately NOT
    reported one by one in that case: `_decode` reads a member's shards off `shape[0]` and
    `chunk_shape[0]`, which an arity mismatch leaves intact, so `c/0` under such a node is a
    file the gate genuinely read, and calling it "not a chunk" would aim the author at a real
    shard instead of at the one document that is wrong.

    The two lists are kept apart because they say different things and an author fixes them
    differently — "this is not a chunk key" versus "this is not a chunk THIS member has" —
    and because a single shared code lets an unrelated rejection stand in for the one a test
    means to pin.

    `None` for the count means the walk hit [`_CHUNK_WALK_LIMIT`] and stopped: "too many
    entries to enumerate" must not read the same as "every entry is a chunk". Both lists
    found before that point are still returned — a bound was reached, which does not unfind
    them — while the caller withholds the node SET, so coverage is skipped rather than
    compared against a partial answer.

    The fourth list says the same thing about a directory the OS would not let the walk open:
    "could not enumerate" must not read the same as "enumerated, and everything in it was a
    chunk". See [`_unreadable_dir_violations`] for what that swallow was measured doing.
    """
    strays = []
    ungridded = []
    unreadable = []
    stack = [(chunk_dir, ())]
    while stack:
        current, prefix = stack.pop()
        try:
            entries = sorted(current.iterdir())
        except OSError as exc:
            # REPORTED, not skipped — see [`_unreadable_dir_violations`]. A `continue` here
            # made an unreadable chunk plane read as an EMPTY one, and an empty one is
            # clean.
            unreadable.append((_rel(root, current), exc))
            continue
        for entry in entries:
            seen += 1
            if seen > _CHUNK_WALK_LIMIT:
                return None, strays, ungridded, unreadable
            if not _CHUNK_KEY_RE.match(entry.name):
                # Not descended into either: whatever is inside is under a path no chunk key
                # can produce, and one violation per hiding place is enough to fix it.
                strays.append(_rel(root, entry))
                continue
            parts = prefix + (entry.name,)
            if isinstance(grid, _UnderivableGrid):
                # The node's declaration yields no grid, so nothing here CAN be classified
                # against one. That is not a fallback to the name rule: the node itself is
                # already refused by `_underivable_grid_violation`, unconditionally and
                # before this walk starts, so an underivable grid cannot produce a clean
                # verdict for anything. The name rule below is not "what is left" either —
                # it never needed a grid and runs for every node, gridded or not.
                #
                # Not reported per-entry ON PURPOSE. `_decode` reads a member's shards off
                # `shape[0]` / `chunk_shape[0]`, which an arity mismatch leaves intact, so
                # `c/0` here is a file the gate genuinely READ; calling it "not a chunk"
                # would point the author at a real shard instead of at the one document that
                # is actually wrong. One fault, one violation, naming the cause.
                if entry.is_dir():
                    stack.append((entry, parts))
                continue
            place = _chunk_key_place(parts, grid, entry.is_dir())
            if place is None:
                # Not descended into, same reason as a name stray: one violation per hiding
                # place, and there is no key below a key the grid does not name.
                ungridded.append(_rel(root, entry))
            elif place == "prefix":
                stack.append((entry, parts))
    return seen, strays, ungridded, unreadable


def _store_nodes(root):
    """`(node paths under root | None, violations)` — every Zarr node the store holds, and
    every FILE in it that no node accounts for.

    A node is a DIRECTORY holding a [`_NODE_META`]. `c/` chunk dirs are not walked as nodes
    (see [`_CHUNK_DIR`]) — they are handed to [`_chunk_dir_violations`], which is what stops
    them being a hiding place rather than merely skipping them.

    ## Nodes were the only thing counted, so a loose FILE was invisible anywhere

    Closing `c/` closed the biggest hiding place, not the class: the walk collected DIRS that
    hold a `zarr.json` and skipped every file, so a file under any other name — `<root>/evil`,
    or `<member>/junk/evil` beneath a dir that is not a node at all — was declared by nothing,
    read by nothing and reported by nothing. `c/` was one instance of "a place the walk does
    not look"; the class is "the walk looks for nodes, and bytes are files".

    An artifact's file set is completely determined, so the rule can be total rather than a
    list of the places somebody thought of: **every file is some node's `zarr.json`, or a
    chunk under that node's `c/`.** There is no third kind, so anything else is bytes the
    declaration does not account for.

    ## "…or a chunk" was a NAME, and a name does not bound a set

    That sentence was shipped as TOTAL while the second half of it was only a name rule: any
    numerically-named entry under any node's `c/` satisfied it. So the plane the rule claimed
    to cover was open to `value/c/7` on a one-shard member, to
    `value/c/00000000123456789`, to 5 MiB of random bytes at `value/c/1`, and — since a
    GROUP is a node too — to `<root>/c/0` and `label/c/0`, all measured `[]`. The half that
    was missing is the grid: `_chunk_grid` derives the key space from the node's own
    declaration, `_chunk_dir_violations` holds the plane to it, and only then is "or a chunk"
    a set rather than a spelling.

    Anchored on STORED node-ness, not declared: an undeclared node's own files are accounted
    for here and the node itself is named by [`_conform_node_coverage`]'s `stored ⊄ declared`
    arm, so one hiding place produces one violation rather than one per file in it.

    Safe against the production staging path, checked rather than assumed:
    `sandbox::inputs::stage_prefix_members` creates a FRESH per-artifact dir and hardlinks in
    exactly the members of that artifact's own manifest (`Stager::report` only logs), so
    `/inputs/<artifact-id>` holds the artifact and nothing else. The two derived siblings
    (`sandbox::inputs::DERIVED_INPUT_FILES` — `params.json`, `inputs.json`) live one level UP
    at `/inputs/`, and the gate walks the per-artifact subpath, never `/inputs` itself. The
    member manifest and `structure.columns` are DIFFERENT lists, which is what makes the rule
    load-bearing rather than tautological: a file can be a staged manifest member while no
    part of the declaration accounts for it.

    `None` for the node set means the walk did not finish — either bound exceeded, or a
    directory the OS would not let it enumerate ([`_unreadable_dir_violations`]) — so the
    caller must not compare coverage against a partial answer: neither "too many entries to
    enumerate" nor "could not enumerate" may read the same as "every stored node is
    declared".
    """
    root = Path(root)
    nodes = set()
    out = []
    unaccounted = []
    unreadable = []
    stack = [root]
    seen = 0
    chunk_seen = 0

    def found(extra=()):
        """Every violation this walk has, assembled in ONE place.

        Three return paths leave this function and each has to carry all four lists; a
        forgotten `+ _unreadable_dir_violations(...)` on one of them would reinstate the
        exact silence this reports, on whichever store happens to trip that path.
        """
        return (
            out
            + _unaccounted_violations(unaccounted)
            + _unreadable_dir_violations(unreadable)
            + list(extra)
        )

    while stack:
        current = stack.pop()
        try:
            entries = sorted(current.iterdir())
        except OSError as exc:
            # REPORTED, not skipped — see [`_unreadable_dir_violations`]. A `continue` here
            # made an unreadable subtree read as an EMPTY one: it contributed no node, no
            # unaccounted file and no chunk entry, and the verdict then called the store
            # clean.
            unreadable.append((_rel(root, current), exc))
            continue
        # Whether THIS dir is a node decides what its children are allowed to be, so it is
        # resolved before they are looked at.
        is_node = (current / _NODE_META).is_file()
        for entry in entries:
            seen += 1
            if seen > _NODE_WALK_LIMIT:
                return None, found([
                    f"the store holds more than {_NODE_WALK_LIMIT} entries — too many to "
                    "establish that every stored node is declared, so the coverage claim is "
                    "unverified rather than accepted"
                ])
            if not entry.is_dir():
                # The only file a node owns is its own metadata document. Chunks live under
                # `c/` and are checked there.
                if not (is_node and entry.name == _NODE_META):
                    unaccounted.append(_rel(root, entry))
                continue
            if entry.name == _CHUNK_DIR:
                if not is_node:
                    # A chunk plane belongs to a member. Under a dir that is not a node there
                    # is no member for these bytes to be the chunks OF.
                    unaccounted.append(_rel(root, entry) + "/")
                    continue
                # The node's OWN grid decides which keys under here are chunks. Read from
                # `current`, the node dir, because `entry` is its `c/` — see `_chunk_grid`.
                grid = _node_chunk_grid(current)
                if isinstance(grid, _UnderivableGrid):
                    # UNCONDITIONAL, and before the walk: a node holding a chunk plane its
                    # own document cannot describe is refused for BEING that, not for what
                    # happens to be parked under it. Conditioning this on finding entries
                    # would leave the empty-`c/` case (a legal shape — `n=0` writes one)
                    # silently declaring a grid nothing can derive.
                    out.append(_underivable_grid_violation(_node_label(root, current), grid))
                chunk_seen, strays, ungridded, chunk_unreadable = _chunk_dir_violations(
                    root, entry, chunk_seen, grid
                )
                unreadable += chunk_unreadable
                if strays:
                    out.append(_stray_chunk_violation(strays))
                if ungridded:
                    out.append(
                        _ungridded_chunk_violation(_node_label(root, current), grid, ungridded)
                    )
                if chunk_seen is None:
                    return None, found([
                        f"the store holds more than {_CHUNK_WALK_LIMIT} chunk entries — too "
                        "many to establish that every one of them is a chunk, so the claim "
                        "that nothing is parked in the chunk plane is unverified rather than "
                        "accepted"
                    ])
                continue
            if (entry / _NODE_META).is_file():
                nodes.add(_rel(root, entry))
            stack.append(entry)
    # A directory the walk could not open is a subtree whose nodes are not in `nodes`, so the
    # set is partial for exactly the reason a tripped bound makes it partial, and it is
    # withheld the same way. The violation above already refuses the artifact; withholding
    # the set on top of it stops a PARTIAL enumeration being compared with the declaration
    # and reported as though it were a complete one, in either direction.
    return (None if unreadable else nodes), found()


def _unaccounted_violations(unaccounted):
    """`[]`, or the one violation naming bytes no node accounts for. Count exact, list capped.

    An empty DIRECTORY tree is deliberately not reported: it holds no bytes, so there is
    nothing in it for a declaration to be missing about. Files are the thing.
    """
    if not unaccounted:
        return []
    named = sorted(unaccounted)
    shown = named[:_STRAY_REPORT_LIMIT]
    more = "" if len(named) <= _STRAY_REPORT_LIMIT else f", … (+{len(named) - len(shown)} more)"
    return [
        f"the store holds {len(named)} path(s) that no node accounts for: {shown}{more} — "
        "within an artifact every file is some node's `zarr.json` or a chunk under that "
        "node's `c/`, and there is no third kind, so bytes under any other path are bytes "
        "the declaration does not describe and no check in this suite reads (DEC-8)"
    ]


def _unreadable_dir_violations(unreadable):
    """`[]`, or the one violation naming directories a walk could not enumerate.

    ## The THREE sites that did NOT follow the module's own rule

    The RECORDED LIMITATION block above [`ManifestReport`] states that every `except OSError`
    in this module renders the fault as a violation of the artifact it was reading. That was
    written as a description and was false of three of the nine sites — all three WALKS
    ([`_store_nodes`], [`_chunk_dir_violations`], [`_bytes_are_not_a_store`]). Six sites
    failed closed, three failed OPEN, and a doctrine whose whole argument is "one rule, no
    branch that disagrees" had three branches that disagreed.

    They failed open in two different SPELLINGS, and the second is why this docstring says
    three rather than two:

    * `_store_nodes` and `_chunk_dir_violations` answered an unenumerable directory with a
      bare `continue` — visible in the source, and fixed first.
    * `_bytes_are_not_a_store` had no handler at all. It enumerated with `Path.rglob("*")`,
      and CPython's recursive-glob machinery catches `PermissionError` internally (the
      `_RecursiveWildcardSelector` of 3.10-3.12, the `glob._Globber` that replaced it after —
      the swallow is the documented behaviour of the interface, not of one implementation),
      so the walk skipped an unlistable directory with nothing in this module to see. A scan
      of `except OSError` bodies cannot find a swallow that lives in the standard library,
      which is exactly why it outlived the round written to close this class.

    `continue` is not "skip a directory" here, and neither is a library's silent recursion.
    A walk is HOW this gate establishes what a store holds, so a swallowed directory
    contributes no node to the set, no file to `unaccounted`, no entry to the chunk plane and
    no `zarr.json` to the anti-bypass check — and the rules above then compare a declaration
    against a set that silently omits it. The result is not a missing check, it is a POSITIVE
    clean statement about bytes nothing looked at.

    Measured through the real `verify_conformance.main()`, on a conforming `zarr_v3` table
    plus `hidden/evil.bin` (an unaccounted file) and `hidden/ghost/zarr.json` (an undeclared
    node), varying only the mode of `hidden`:

    * `0o755` → exit 1, both violations named.
    * `0o111` (search, but not read) → **exit 0**, `violations: {}`, `checked: [<aid>]`,
      `evidence: {checks: 2, read_bytes: 179, decoded_bytes: 16384}`. The readable member
      earns the receipt, so `GateVerdict::examined` holds, `accounts_for` holds, and
      `conclude` returns `GateOutcome::Conformed`. A GREEN verdict over a subtree the gate
      could not open — the DEC-8 coverage bypass reached through a directory mode instead of
      through a declaration.
    * `0o000` → exit 1 (`is_file()` on the node document raises outside any handler and the
      outer catch condemns).

    So adjacent modes disagreed, and the middle one failed open. The same swallow was
    reachable in the chunk plane on its own: `value/c` at `0o111` with a stray `value/c/evil`
    inside exited 0 with `violations: {}`, where `0o755` names the stray.

    The `rglob` site was measured the same way and was WORSE at both ends, because the check
    it disabled is the anti-bypass one. On an `opaque`-declared artifact whose only
    `zarr.json` sits at `sub/zarr.json`, varying only the mode of `sub`: `0o755` →
    `violations: {<aid>: ["… the bytes are a Zarr store …"]}` → `status = 'failed'`; `0o111`
    AND `0o000` → `violations: {}`, `checked: []`, `evidence: {}` → `GateOutcome::
    Indeterminate`, every row left with the status ingest gave it, the mis-declared store
    still serving. Here `0o000` did NOT recover the way it does above: nothing in the opaque
    branch ever stats a path inside the hidden directory, so there was no raise for the outer
    catch to convert.

    ## Why it fails CLOSED now

    Same reason the other six do, and it is the direction that decides it: a false
    CONDEMNATION is visible and recoverable — the operator sees `status='failed'`, fixes the
    mode, re-runs — while a false PASS is silent and leaves unexamined bytes serving. "We
    could not look" is stated; it is never rendered as "we looked and it was fine".

    This inherits the recorded limitation rather than escaping it: a `chmod` or an EIO on a
    directory now condemns the artifact, which is a statement about the BYTES the fault does
    not support. That cost is the block above `ManifestReport`, in full, including what a
    future fix would have to get right — of which this direction is now point 5.

    Count exact, list capped, matching [`_unaccounted_violations`].
    """
    if not unreadable:
        return []
    named = sorted(f"{path} ({type(exc).__name__}: {exc})" for path, exc in unreadable)
    shown = named[:_STRAY_REPORT_LIMIT]
    more = "" if len(named) <= _STRAY_REPORT_LIMIT else f", … (+{len(named) - len(shown)} more)"
    return [
        f"the gate could not enumerate {len(named)} director{'y' if len(named) == 1 else 'ies'}"
        f" of this store: {shown}{more} — the walk is how this suite establishes what the "
        "store HOLDS, so a directory it cannot open is a subtree over which no coverage claim "
        "can be made. It is reported rather than skipped: an unreadable subtree must never "
        "read as an empty one, which is a clean verdict over bytes nothing looked at (DEC-8)"
    ]


def _stray_chunk_violation(strays):
    """The message for entries parked in a member's chunk plane. Count exact, list capped."""
    named = sorted(strays)
    shown = named[:_STRAY_REPORT_LIMIT]
    more = "" if len(named) <= _STRAY_REPORT_LIMIT else f", … (+{len(named) - len(shown)} more)"
    return (
        f"the store holds {len(named)} entr{'y' if len(named) == 1 else 'ies'} under a chunk "
        f"directory that no chunk key can name: {shown}{more} — a `c/` dir holds the shard "
        "files of ONE member and nothing else, and it is the one part of a store the node "
        "walk does not descend into, so bytes parked there are bytes no declaration names "
        "and no check reads (DEC-8)"
    )


def _node_label(root, node_dir):
    """How a node is NAMED in a violation — its store path, or the artifact root itself."""
    rel = _rel(root, node_dir)
    return "the artifact root" if rel == "." else rel


def _grid_description(grid):
    """The grid a violation was measured against, in the message that reports it.

    An author reading "value/c/7 is not a cell" needs to see WHAT it was compared with, or
    the only way to act on the finding is to re-derive the arithmetic by hand.
    """
    if grid is _NO_CHUNK_PLANE:
        return (
            "no chunk grid at all — it is a GROUP, not an array, so no key under it can name "
            "a chunk"
        )
    return (
        "a chunk grid of " + "×".join(str(d) for d in grid) + ", and a `c/` dir holds "
        "exactly the shard file of each of its cells"
    )


def _underivable_grid_violation(label, grid):
    """The message for a node whose own document does not yield a chunk grid.

    Its own code, and not folded into [`_ungridded_chunk_violation`]: that one says "this
    entry is not a chunk THIS member has", which presupposes a grid to have been compared
    against. This one says the declaration is malformed, which is a different fault, is fixed
    in a different file, and — unlike its sibling — is about the NODE rather than about any
    particular byte under it.
    """
    return (
        f'"{label}" holds a chunk plane but its own `zarr.json` {grid.reason} — so nothing '
        "bounds which chunk keys it HAS, and every byte under it would be held to a name "
        "rule alone. A node whose declaration yields no grid is MALFORMED, not exempt: "
        "`zarrReader`'s `#assertRowChunked` throws on exactly this metadata, so these are "
        "bytes the shipped client cannot open and no check in this suite bounds (DEC-8)"
    )


def _ungridded_chunk_violation(label, grid, ungridded):
    """The message for entries in a chunk plane that the node's own grid does not name.

    SEPARATE from [`_stray_chunk_violation`], not a shared "bad chunk entry" code: they are
    different faults ("not a chunk key" vs "not a chunk this member has"), an author fixes
    them differently, and a coarse shared code lets an unrelated rejection masquerade as the
    one a test is pinning. Count exact, list capped — same contract as its sibling.
    """
    named = sorted(ungridded)
    shown = named[:_STRAY_REPORT_LIMIT]
    more = "" if len(named) <= _STRAY_REPORT_LIMIT else f", … (+{len(named) - len(shown)} more)"
    return (
        f"the store holds {len(named)} entr{'y' if len(named) == 1 else 'ies'} under "
        f'"{label}"\'s chunk plane that no cell of its chunk grid names: {shown}{more} — '
        f'"{label}" has {_grid_description(grid)}. Being NAMED like a chunk key does not make '
        "an entry a chunk: bytes at a key the grid does not name are bytes no reader ever "
        "fetches and no check in this suite reads (DEC-8)"
    )


def _conform_aux(root, structure, *, full, evidence=None, member_paths=()):
    axis_name = structure.get("axis")
    n = structure.get("n")
    """The `aux` members — those whose length is NOT the table's `n` (ITEM-12).

    ## What this function is for

    Every length rule in this module runs off one number: `expect_rows=n`, applied to every
    member in `columns`/`arrays`. An `aux` member is by construction outside it — a row
    vector is as long as the OUTPUT is, a segment table as long as the segment list, a
    feature vector as wide as the source count — so if this function did not exist, the
    channel that makes those members storeable would also make them the least-checked bytes
    in any artifact. That is the same trade [`_conform_node_coverage`] refuses one level up,
    and it is refused here the same way: by naming what is allowed rather than by allowing
    what is not named.

    ## The two declarations it holds an aux member to

    * **`role`**, against [`_AUX_ROLES`]. A role the gate does not know is REFUSED. This is
      the anti-opt-out: the alternative is bytes whose only constraint is that a producer
      called them something, which is a name rule and not a check.
    * **`extent`**, a list of extent NAMES — one per dimension — resolved through
      `structure.extents`. The indirection is the point. A member declaring its own length
      would agree with itself no matter what it stored; naming a shared extent means two
      members that claim `output_rows` are checked against ONE number, and a producer whose
      row vector and row-segment vector disagree about how many output rows there are is
      refused rather than believed.

    `expect_rows=None` on the `_conform_member` call, exactly as `_conform_sparse_csc` does
    for its trio, because `n` is the wrong number here — and the extent check below is what
    replaces it rather than what excuses its absence.
    """
    aux = structure.get("aux")
    extents = structure.get("extents")
    if aux is None and extents is None:
        return []
    out = []
    # The two keys travel together or one of them is unreadable: extents with no members is
    # a length rule for nothing, members with no extents is a name resolving to nothing.
    if aux is None:
        return [
            "a table declares `extents` but no `aux` members — an extent is the length rule "
            "for an aux member's dimension, so one with no member is a declaration nothing "
            "compares (DEC-8)"
        ]
    if not isinstance(aux, list):
        return [f"a table's `aux` must be a list of members, got {type(aux).__name__}"]
    if not aux:
        return [
            "a table declares an EMPTY `aux` list — the key is emitted only when there are "
            "members, so an empty one is a declaration that says nothing. Omit it"
        ]
    if not isinstance(extents, dict) or not extents:
        return out + [
            f"a table with `aux` members must declare a non-empty `extents` map, got "
            f"{extents!r} — the extent is where an aux member's length rule lives"
        ]
    for name, value in sorted(extents.items()):
        if not _is_count(value):
            out.append(
                f"extent {name!r} is declared {value!r}, which is not a non-negative "
                "integer — a length that is not a number bounds nothing"
            )
    claimed = set()
    seen_paths = set(member_paths)
    for member in aux:
        if not isinstance(member, dict):
            out.append(f"an `aux` entry is {type(member).__name__}, not a member declaration")
            continue
        path = member.get("path")
        if path in seen_paths:
            out.append(f'duplicate member path "{path}"')
        seen_paths.add(path)
        kind = member.get("kind")
        if kind != "numeric":
            # Deliberately narrow. A string aux member would need `_conform_string_member`
            # to work without `expect_rows`, and its `n` stamp means the axis's length —
            # untested ground. The alignment's aux vectors are all integer index vectors, so
            # widening this is a change with a caller behind it, not a hypothetical.
            out.append(
                f'aux member "{path}" is kind {kind!r}; the aux channel carries numeric '
                "members only — its length rule is an extent, and the string kind's length "
                "is declared by its own `n` stamp against the axis"
            )
            continue
        role = member.get("role")
        if role not in _AUX_ROLES:
            out.append(
                f'aux member "{path}" declares role {role!r}, which this gate has no opinion '
                "about. An aux member sits outside every length rule the axis provides, so a "
                "role nobody enumerated is bytes held to a name alone — the cheapest opt-out "
                "there is (DEC-8). Add it to `_AUX_ROLES` with what it means, or do not "
                f"write it. Known: {sorted(_AUX_ROLES)}"
            )
        out += _conform_member(root, member, expect_rows=None, full=full, evidence=evidence)
        if _malformed_member_keys(member, kind):
            # Same rule as `_conform_sparse_csc`: the extent arithmetic below reads the very
            # keys `_conform_member` just refused, and crashing on one would make
            # `conform_manifest` report the raise INSTEAD of every finding made so far.
            continue
        extent = member.get("extent")
        shape = member.get("shape")
        if not isinstance(extent, list) or not extent or not all(
            isinstance(e, str) and e for e in extent
        ):
            out.append(
                f'aux member "{path}" declares `extent` {extent!r} — it must be a non-empty '
                "list of extent names, one per dimension. Without it the member has no "
                "length rule at all, which is the state this channel may not reach"
            )
            continue
        if len(extent) != len(shape):
            out.append(
                f'aux member "{path}" is shape {list(shape)} but names {len(extent)} extent'
                f"(s) {extent} — one name per dimension, or some dimension is unbounded"
            )
            continue
        axis_dim = _AUX_ROLE_AXIS_DIM.get(role)
        if axis_dim is not None:
            if axis_dim >= len(extent):
                out.append(
                    f'aux member "{path}" has role {role!r}, whose dimension {axis_dim} must '
                    f"be the table's own axis, but it declares only {len(extent)} extent(s)"
                )
            elif extent[axis_dim] != axis_name:
                out.append(
                    f'aux member "{path}" has role {role!r}, whose dimension {axis_dim} is '
                    f"one value per axis entry — it must name the table's axis "
                    f"{axis_name!r}, not {extent[axis_dim]!r}. A per-entry member that names "
                    "its own extent is checked only against itself, which is how a "
                    "wrong-length vector conforms clean"
                )
        for axis_i, extent_name in enumerate(extent):
            claimed.add(extent_name)
            if extent_name not in extents:
                out.append(
                    f'aux member "{path}" dimension {axis_i} names extent {extent_name!r}, '
                    f"which `structure.extents` does not declare (it has {sorted(extents)}) "
                    "— a name that resolves to nothing is not a length rule"
                )
                continue
            declared = extents[extent_name]
            if _is_count(declared) and int(shape[axis_i]) != int(declared):
                out.append(
                    f'aux member "{path}" dimension {axis_i} is {shape[axis_i]} but extent '
                    f"{extent_name!r} is declared {declared} — two members claiming one "
                    "extent is the whole reason the name exists"
                )
    # THE ANCHOR. An extent named for the table's own axis must equal the table's `n` —
    # otherwise `structure` carries the same length twice and nothing compares the two, so a
    # producer can declare an axis of 4 and an axis-named extent of 3 and be conformed.
    if axis_name in extents and isinstance(n, int) and int(extents[axis_name]) != n:
        out.append(
            f"extent {axis_name!r} is declared {extents[axis_name]} but it names the table's "
            f"own axis, which declares n={n} — one axis is one length. An extent that "
            "restates the axis and disagrees with it is the duplicate-length rule this "
            "channel refuses, and it is how a wrong-length per-entry member passes"
        )
    out += _conform_alignment_vocabulary(root, aux, evidence=evidence)
    unclaimed = sorted(set(extents) - claimed)
    if unclaimed:
        out.append(
            f"`extents` declares {unclaimed}, which no aux member's dimension names — a "
            "length rule nothing is held to is a declaration nothing compares, and it is "
            "how a stale extent survives a member being removed (DEC-8)"
        )
    return out


def _conform_alignment_vocabulary(root, aux, *, evidence=None):
    """The unified LEVEL VOCABULARY covers every code the lookups emit.

    `alignment_level_lookup` maps a source's stored code to a UNIFIED code, and a unified
    code means nothing without the list it indexes. The producer stamps that list into the
    store's group attributes as `cyto_alignment.unified_levels` — with the BYTES, so it is
    uncapped and survives at any cardinality, unlike anything that rides the manifest row.

    Unverified it would be the shape this module refuses everywhere else: a declaration
    nothing compares. So the vocabulary is checked against the lookups that use it — every
    non-negative unified code must index a real label, and every column that HAS lookups
    must have a vocabulary. Both directions, because a vocabulary for a column with no
    lookups is as stale as a lookup with no vocabulary.

    Silent for an artifact carrying no level lookups: this is an alignment-specific
    cross-member check, not a rule about every table.
    """
    lookups = [
        member for member in aux
        if isinstance(member, dict) and member.get("role") == "alignment_level_lookup"
    ]
    if not lookups:
        return []

    try:
        attributes = cyto_zarr_read.read_meta(root).get("attributes") or {}
    except OSError as exc:
        return [f"the alignment's group node is not readable: {exc}"]
    vocabulary = (attributes.get("cyto_alignment") or {}).get("unified_levels")
    if not isinstance(vocabulary, dict):
        return [
            "the alignment emits `alignment_level_lookup` member(s) but stamps no "
            "`cyto_alignment.unified_levels` in its group attributes — a unified code "
            "indexes a list, and without it every lookup is uninterpretable and a consumer "
            "renders integers where labels belong"
        ]

    out = []
    # `levels__<column>__<source>` — the column is what a vocabulary is keyed by.
    columns_with_lookups = set()
    for member in lookups:
        path = str(member.get("path") or "")
        parts = path.split("__")
        if len(parts) < 3:
            out.append(
                f'level lookup "{path}" does not name its column — the vocabulary is keyed '
                "by column, so a member whose column cannot be read cannot be checked"
            )
            continue
        column = "__".join(parts[1:-1])
        columns_with_lookups.add(column)
        levels = vocabulary.get(column)
        if not isinstance(levels, list):
            out.append(
                f'level lookup "{path}" is for column {column!r}, which has no entry in '
                f"`unified_levels` (it has {sorted(vocabulary)})"
            )
            continue
        codes, errors = _read_whole(root, path, evidence=evidence)
        if errors:
            continue
        for code in codes.tolist():
            if int(code) < 0:
                continue  # the obs-axis absence (ITEM-5); it indexes nothing by design
            if int(code) >= len(levels):
                out.append(
                    f'level lookup "{path}" emits unified code {int(code)} but column '
                    f"{column!r} declares only {len(levels)} unified level(s) — the code "
                    "indexes past the end of the vocabulary, so the value has no label"
                )
                break

    stale = sorted(set(vocabulary) - columns_with_lookups)
    if stale:
        out.append(
            f"`unified_levels` declares vocabular(y|ies) for {stale}, which no level lookup "
            "uses — a vocabulary nothing indexes is a declaration nothing compares, and it "
            "is how a stale column survives its lookups being removed"
        )
    return out


def _conform_node_coverage(root, structure):
    """`[]` unless the store and the declaration name different sets of nodes — BOTH ways.

    ## The cheapest opt-out of all: write nothing

    Omitting a member KEY made one check shallower. Omitting the whole member entry made
    every check on those bytes disappear — the member's `zarr.json`, its dtype, its shape,
    its geometry, its codes and (for a string) its value sequence were simply not looked at,
    and the gate said `[]`. Nothing about the bytes changes, so no byte-level check can see
    it; the only thing that can is asking the store what it holds and comparing.

    This is the artifact-level twin of [`_required_member_key_violations`]: that one refuses
    an absent key, this one refuses an absent declaration.

    ## …and the OTHER direction, which was missing

    Only `stored ⊄ declared` was checked, so a DECLARED node whose bytes/metadata are not
    there was this function's blind spot, and the per-member checks were the only thing
    covering it — per KIND, which is where the hole was: `_conform_member` read the member's
    own `zarr.json` for the fixed-width kinds only, so DELETING a string member's `zarr.json`
    outright was reported by nobody (measured: `[]`, while the same deletion on a numeric or
    a categorical member was refused). A set difference has two sides; checking one of them
    made a per-kind exception possible at all. Both are checked here, so a declared node with
    nothing behind it is refused for EVERY kind, and no future kind can reintroduce the
    exception.
    """
    stored, out = _store_nodes(root)
    if stored is None:
        # The walk did not finish; comparing coverage against a partial node set would turn
        # "unverified" into "verified".
        return out
    declared = _declared_member_nodes(structure)
    undeclared = sorted(n for n in stored if n not in declared)
    if undeclared:
        out.append(
            f"the store holds node(s) {undeclared} that the declaration does not name — a "
            "member left out of `columns`/`arrays` keeps its bytes and loses every check in "
            "this suite, which is the cheapest opt-out there is (DEC-8). Declare it, or do "
            "not write it"
        )
    unstored = sorted(n for n in declared if n not in stored)
    if unstored:
        out.append(
            f"the declaration names node(s) {unstored} that the store does not hold — a Zarr "
            "node is a directory with a `zarr.json`, and a declared member with none is a "
            "member no consumer can open. This is refused for every kind: a per-kind "
            "exception here is how a string member's deleted `zarr.json` went unreported"
        )
    return out


def _read_member_node(root, path):
    """`(the member's parsed zarr.json | None, violations)` — one read, for every kind.

    Every kind: a member is a Zarr node, and "the node a declaration names is not there" is
    the same fault whether the node is an array or a string GROUP. Splitting this read across
    the kind fork is what let the string kind have no reader at all.

    "Not there" and "the OS will not let the gate look" are stated in one sentence by the
    `OSError` clause below, deliberately — see the RECORDED LIMITATION block above
    `ManifestReport`.
    """
    try:
        node = cyto_zarr_read.read_meta(root, path)
    except FileNotFoundError:
        return None, [f'declared member "{path}" has no zarr.json on disk']
    except OSError as exc:
        return None, [f'declared member "{path}" has no readable zarr.json ({exc})']
    except ValueError as exc:
        return None, [f'declared member "{path}" has a malformed zarr.json ({exc})']
    if not isinstance(node, dict):
        return None, [
            f'declared member "{path}" has a zarr.json that is not a JSON object '
            f"({type(node).__name__}) — a Zarr node's metadata is a document, and nothing "
            "can be read from it"
        ]
    return node, []


def _conform_member(root, member, *, expect_rows, full, evidence=None):
    """One declared member against its own `zarr.json` and its bytes."""
    path = member.get("path")
    if not path:
        return ["a member declares no `path` (INV-2)"]
    kind = member.get("kind")
    # D7 — an `extent` on a NON-AUX member, refused rather than merely documented.
    #
    # `_OPTIONAL_MEMBER_KEYS["extent"]` has always said a column carrying one *"would be
    # declaring a second, independent length rule for the same bytes, and two rules for one
    # value is the ambiguity this suite refuses"*. **It refused nothing.** Nothing read
    # `extent` outside `_conform_aux`, so a column could carry any extent it liked and be
    # conformed clean — a documented refusal with no implementation, which is the same shape
    # as D8 and the class that has been the false premise twice on this branch.
    #
    # Keyed on `expect_rows is not None`, which is exactly "this member is held to the
    # axis's `n`" — the aux channel passes `None` precisely because its length rule is an
    # extent instead. So the condition is the ambiguity itself rather than a proxy for it:
    # a member with BOTH a row rule and an extent has two length rules, and that is the
    # state being refused.
    if expect_rows is not None and "extent" in member:
        out_extent = [
            f'member "{path}" is held to the axis length ({expect_rows}) AND declares '
            f'`extent` {member.get("extent")!r} — two independent length rules for one set '
            "of bytes. An `extent` belongs to an `aux` member, whose length is NOT the "
            "axis's `n`; on a column it is either redundant or a contradiction, and nothing "
            "downstream can tell which"
        ]
    else:
        out_extent = []
    # Absence FIRST, and for every kind: the required-key check is what stops a producer
    # choosing which of the checks below run (see `_required_member_key_violations`). An
    # ABSENT key is appended to, never returned instead of, the byte-level findings — an
    # author fixing a declaration wants the whole list, not the first item of it. A key of
    # the wrong FORM is the one exception, immediately below, and for a reason that does not
    # generalise: those checks cannot RUN at all against it.
    out = out_extent + _required_member_key_violations(member)
    # A required key in the wrong FORM stops here, and this is the one case that RETURNS
    # rather than appending: the comparisons below do not merely need the key, they read it
    # as its form — `list(declared_shape)`, `declared_shape[0]`, `meta["data_type"] !=
    # declared_dtype`. Carrying a malformed declaration into them leaves exactly the two
    # arms this fix deletes: it CRASHES the numeric read (`list(200)` is a `TypeError`,
    # which `conform_manifest` catches and reports INSTEAD of every finding made so far, so
    # the report names the symptom and loses the cause), or it is SKIPPED by the `isinstance`
    # guard written to survive it (the string arm, which was silent). Refusing the member on
    # its declaration is the third option and the only one that is a rule. An ABSENT key is
    # deliberately NOT this: the checks below skip only their own comparison for a `None`,
    # each one already reported above, so the author still gets the whole list.
    if _malformed_member_keys(member, kind):
        return out

    # The member's OWN `zarr.json`, read ONCE and BEFORE the kind fork. It used to be read
    # after it, so the string branch never read it at all: `_conform_member_attributes`
    # swallowed its own read failure on the stated grounds that "the caller reports that",
    # and for a string member the caller never got that far. Deleting a string member's
    # `zarr.json` outright therefore produced no violation from anywhere, while the same
    # deletion on a numeric or categorical member was refused — a per-kind exception to
    # "declared bytes must exist". One read, before the fork, so there is no kind for which
    # nobody reports it.
    meta, read_errors = _read_member_node(root, path)
    if meta is None:
        return out + read_errors
    out += _conform_member_attributes(path, kind, member, meta)
    if kind == "categorical":
        out += _conform_levels_digest(path, member, meta)
        out += _conform_vocab_declaration(path, member, meta)

    if kind == "string":
        return out + _conform_string_member(
            root, member, expect_rows=expect_rows, full=full, evidence=evidence
        )

    declared_dtype = member.get("dtype")
    # `is not None`, not truthiness: an EMPTY declared dtype used to skip this comparison
    # (measured silent for `dtype: ""`, `[]`, `{}` and `false` on every fixed-width member).
    # It cannot be empty now — `_MEMBER_KEY_FORMS` requires a non-empty string — so the only
    # thing this guard skips is a key that is absent, which is reported above.
    if declared_dtype is not None and meta["data_type"] != declared_dtype:
        out.append(
            f'member "{path}" is declared {declared_dtype!r} but stored as '
            f'{meta["data_type"]!r}'
        )
    declared_shape = member.get("shape")
    if declared_shape is not None and list(meta["shape"]) != list(declared_shape):
        out.append(
            f'member "{path}" is declared shape {list(declared_shape)} but stored as '
            f'{list(meta["shape"])}'
        )
    if expect_rows is not None and isinstance(expect_rows, int):
        if int(meta["shape"][0]) != expect_rows:
            out.append(
                f'member "{path}" holds {meta["shape"][0]} entries but the axis declares '
                f"{expect_rows}"
            )
    out += _conform_geometry(path, member, meta)
    values, decode_errors = _decode(root, path, meta, full=full, evidence=evidence)
    out += decode_errors

    if kind == "categorical" and values is not None:
        # ABSENCE of `levels` is `_required_member_key_violations`' finding, not this one's —
        # naming one fault twice makes an author fix it twice. What is left here is the check
        # that needs the bytes: a declared level set too small for a code that is stored.
        # The bound is `n_levels`, the row's declared COUNT. It used to be `len(levels)`
        # off the row's copy of the list; the row declares the set by digest now, and
        # reading a key the row no longer carries would have made this check skip itself
        # — the "absence selects a shallower check" shape one level down, which is the
        # class this module exists to refuse. (It did exactly that for one commit;
        # `test_an_EMPTY_level_set_cannot_switch_off_the_code_range_check` caught it.)
        #
        # `n_levels` is load-bearing only because it is pinned from both sides:
        # `_REQUIRED_MEMBER_KEYS` makes its absence a violation, and
        # `_conform_levels_digest` refuses it unless it equals `len(stamped levels)` —
        # so a producer cannot widen this bound by overstating the count any more than
        # it could by padding the list.
        n_levels = member.get("n_levels")
        # `is not None`, not truthiness: `n_levels: 0` is exactly the level set no stored
        # code can be inside, and truthiness would skip it. Measured before this line
        # changed (in the `levels: []` form): an empty set written into all three copies
        # over 60 real codes returned `[]`. A genuinely empty categorical stays legal —
        # `Table.categorical(codes=[], levels=[])` at `n=0` writes one — which is why this
        # is fixed at the comparison and not by requiring a positive count.
        if n_levels is not None and values.size:
            if int(values.min()) < 0 or int(values.max()) >= int(n_levels):
                out.append(
                    f'member "{path}" holds a code outside its {n_levels} declared levels'
                )
    return out


def _conform_geometry(path, member, meta):
    """The declared geometry against the grid the member's own `zarr.json` describes.

    This is what catches an ITEM-35 regression at the artifact level rather than at the
    unit-test level: a member whose declaration says one shard while the store says 306
    is a producer that wrote its declaration from a different number than it wrote its
    bytes from.
    """
    out = []
    inner = member.get("inner_chunk")
    per_shard = member.get("chunks_per_shard")
    if inner is None and per_shard is None:
        return out
    codecs = meta.get("codecs") or []
    if not codecs or codecs[0].get("name") != "sharding_indexed":
        out.append(
            f'member "{path}" declares shard geometry but is not stored sharded'
        )
        return out
    stored_inner = codecs[0]["configuration"]["chunk_shape"][0]
    stored_shard_rows = meta["chunk_grid"]["configuration"]["chunk_shape"][0]
    if inner is not None and int(stored_inner) != int(inner):
        out.append(
            f'member "{path}" declares inner_chunk {inner} but is stored at {stored_inner}'
        )
    if per_shard is not None and int(stored_shard_rows) != int(stored_inner) * int(per_shard):
        out.append(
            f'member "{path}" declares {per_shard} chunks a shard but the stored grid '
            f"holds {int(stored_shard_rows) // int(stored_inner)}"
        )
    # `shards` is the count the writer says it WROTE, and it is derivable from the grid the
    # store describes — so it is a third copy of the same arithmetic, and now a checked one.
    # It is required (`_REQUIRED_MEMBER_KEYS`) for exactly this reason: a required key the
    # gate does not compare would be a presence ritual.
    declared_shards = member.get("shards")
    if declared_shards is not None:
        derived = _shard_count(meta)
        if int(declared_shards) != derived:
            out.append(
                f'member "{path}" declares {declared_shards} shard(s) but its stored grid '
                f"({meta['shape']} at {stored_shard_rows} rows a shard) holds {derived}"
            )
    return out


#: How many offending value indices a string-member message names before it truncates. The
#: COUNT is always exact; only the list is capped (the verdict crosses a process boundary
#: into a log line and a DB write).
_STRING_REPORT_LIMIT = 5


def _conform_string_member(root, member, *, expect_rows, full, evidence=None):
    """A SPLIT arrow-layout string member: a `uint32` offsets array and a `uint8` payload.

    ## The offsets are a degree of freedom the bytes do not pin

    Every other member kind is fixed-width: `(dtype, shape, bytes)` determines the values,
    and there is nothing left for anyone to declare. Here the SAME payload under different
    offsets is a different column, and the difference is invisible to every structural
    check there is. `["ab","c"]` at offsets `[0,2,3]` and `["a","bc"]` at `[0,1,3]` both
    start at 0, ascend, end at the payload length, and decode as UTF-8 as a whole. The gate
    returned `[]` for that re-split while `read_strings` returned different values for
    every row — silently wrong data with "OK — verified" on the run's log.

    `key_sequence_digest` caught it, but only ever for the ONE member an artifact may name
    as its `key`, which left every other string column uncheckable. So this member is
    checked three ways, in increasing strength:

    1. **Structure** — offset count, start-at-0, monotonic, ends at the payload length.
       Necessary and nowhere near sufficient, as above.
    2. **UTF-8 boundaries, per VALUE** (not just over the payload as a whole). An offset
       landing on a continuation byte (`0b10xxxxxx`) makes `payload[a:b].decode()` raise in
       every consumer while the concatenated payload decodes perfectly — reproduced with
       `["é","x"]` at offsets `[0,1,3]`, which this gate passed. Decoding each value is
       exactly equivalent to "no offset splits a codepoint" and produces a better message.
    3. **`values_digest`** — the producer's declaration of what the offsets split the
       payload INTO, written by `cyto_zarr.Table.string` for every string member and
       recomputed here from the bytes that landed. This is the only thing that can catch an
       all-ASCII re-split, because such a re-split is genuinely indistinguishable from the
       real split by any property of the bytes alone. Its ABSENCE is a violation: a
       declaration a producer may omit in order to be checked less is an opt-out (DEC-8),
       which is the same fault `encoding: "opaque"` was.

    Both legs are read WHOLE at either depth (an offsets array is `n+1` u32 and the payload
    is the strings themselves — there is no 1.8 GB case here, and offsets cannot be
    validated against a partial read), so the bounded/full distinction does not apply to
    this member and cannot make it weaker.
    """
    path = member["path"]
    out = []
    legs = {}
    for leg in ("offsets", "values"):
        try:
            leg_meta = cyto_zarr_read.read_meta(root, f"{path}/{leg}")
        except FileNotFoundError:
            return [f'string member "{path}" is missing its offsets/values pair']
        except OSError as exc:
            return [f'string member "{path}" {leg} are not readable: {exc}']
        except ValueError as exc:
            return [f'string member "{path}" {leg} carry a malformed zarr.json: {exc}']
        # Through the gate's OWN container walker, never `read_array`: the convenience
        # reader fills an empty shard-index slot with `fill_value`, which for an offsets
        # array silently rewrites the split.
        decoded, errors = _decode(
            root, f"{path}/{leg}", leg_meta, full=True, evidence=evidence
        )
        if errors:
            return [f'string member "{path}": {e}' for e in errors]
        legs[leg] = decoded
    offsets, payload = legs["offsets"], legs["values"]

    if expect_rows is not None and isinstance(expect_rows, int):
        if int(offsets.shape[0]) != expect_rows + 1:
            out.append(
                f'string member "{path}" has {offsets.shape[0]} offsets for '
                f"{expect_rows} values (expected {expect_rows + 1})"
            )
        declared_shape = member.get("shape")
        # `is not None`, for the same reason as the stamped-`n` comparison above: the
        # `isinstance` this used to carry made a scalar `shape` skip the axis comparison as
        # well, so BOTH of a string member's `shape` checks were switched off by one value.
        if declared_shape is not None:
            if declared_shape[0] != expect_rows:
                out.append(
                    f'string member "{path}" declares shape {declared_shape} but its axis '
                    f"declares {expect_rows} rows"
                )
    # `n_bytes` is the producer's statement of how long the payload is. It is REQUIRED
    # (`_REQUIRED_MEMBER_KEYS`) and therefore compared: an offsets/payload pair whose
    # length disagrees with the declaration is a member whose two halves were written from
    # different data.
    declared_bytes = member.get("n_bytes")
    if declared_bytes is not None and int(declared_bytes) != int(payload.shape[0]):
        out.append(
            f'string member "{path}" declares n_bytes {declared_bytes} but its payload holds '
            f"{int(payload.shape[0])} bytes"
        )
    if offsets.size:
        if int(offsets[0]) != 0:
            out.append(f'string member "{path}" starts at offset {int(offsets[0])}, not 0')
        if bool((np.diff(offsets.astype(np.int64)) < 0).any()):
            out.append(f'string member "{path}" has non-monotonic offsets')
        if int(offsets[-1]) != int(payload.shape[0]):
            out.append(
                f'string member "{path}" ends at offset {int(offsets[-1])} but its payload '
                f"holds {int(payload.shape[0])} bytes"
            )
    raw = payload.tobytes()
    try:
        raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        out.append(f'string member "{path}" payload is not valid UTF-8: {exc}')

    if out:
        # The offsets do not span the payload sanely, so slicing by them would report
        # consequences of a fault already named. The strongest available statement has
        # already been made.
        return out

    values, split = _split_string_values(path, offsets, raw)
    out += split
    if out:
        return out
    out += _conform_values_digest(path, member, values)
    return out


def _split_string_values(path, offsets, raw):
    """`(values, violations)` — the member's values, decoded ONE AT A TIME.

    Per-value decoding is what catches an offset that lands mid-codepoint. Given that the
    payload decodes as a whole (checked by the caller), "every value decodes" and "no offset
    splits a UTF-8 codepoint" are the same statement; decoding is the cheaper way to say it
    and names the value index a consumer will blow up on.
    """
    values = []
    bad = []
    for i in range(int(offsets.shape[0]) - 1):
        lo, hi = int(offsets[i]), int(offsets[i + 1])
        try:
            values.append(raw[lo:hi].decode("utf-8"))
        except UnicodeDecodeError:
            bad.append(i)
            values.append(None)
    if not bad:
        return values, []
    shown = ", ".join(str(i) for i in bad[:_STRING_REPORT_LIMIT])
    if len(bad) > _STRING_REPORT_LIMIT:
        shown += f", … (+{len(bad) - _STRING_REPORT_LIMIT} more)"
    return values, [
        f'string member "{path}" has {len(bad)} value(s) whose offsets split a UTF-8 '
        f"codepoint (index {shown}) — the payload decodes as a whole, so no whole-payload "
        "check can see this, but every consumer slicing by these offsets raises "
        "UnicodeDecodeError"
    ]


def _conform_levels_digest(path, member, node):
    """The row's declared `levels_digest` against the level set the MEMBER stamps.

    This is the drift check that `_conform_member_attributes` used to make by comparing
    two copies of the list. The row now declares a digest instead — the list itself was
    450 KB for a 35,477-level member, 87% of a real import's manifest, and it blew
    `MAX_MANIFEST_BYTES` — so the comparison recomputes rather than equates. Detection is
    unchanged: the oracle that edits ONLY `<member>/zarr.json`'s `attributes.cyto.levels`
    still lands here, because that stamp is the input being hashed.

    `key_sequence_digest` is the same function `values_digest` uses, and its
    order-sensitivity is load-bearing twice over: codes INDEX into the level set
    positionally, so a reordered set silently relabels every value, and a digest blind to
    order would certify exactly that.

    An absent `levels_digest` / `n_levels` is `_required_member_key_violations`' finding
    (both are in `_REQUIRED_MEMBER_KEYS["categorical"]`) and an absent stamped `levels` is
    `_stamped_key_violations`' — so the `is None` guards below can only skip a fault that
    is already named elsewhere, never one named nowhere.
    """
    stamped = (node.get("attributes") or {}).get("cyto")
    if not isinstance(stamped, dict):
        return []  # reported by `_conform_member_attributes`
    levels = stamped.get("levels")
    declared = member.get("levels_digest")
    if levels is None or declared is None:
        return []
    if not isinstance(levels, list):
        return [
            f'categorical member "{path}" stamps a non-list `attributes.cyto.levels` '
            f"({type(levels).__name__}) — the level set is an ORDERED sequence that the "
            "codes index into"
        ]
    out = []
    declared_n = member.get("n_levels")
    if declared_n is not None and int(declared_n) != len(levels):
        out.append(
            f'categorical member "{path}" declares n_levels={declared_n} but stamps '
            f"{len(levels)} levels in its own zarr.json"
        )
    recomputed = key_sequence_digest(levels)
    if declared != recomputed:
        out.append(
            f'categorical member "{path}" does not match its declared `levels_digest` '
            f"({str(declared)[:12]}… declared, {recomputed[:12]}… stamped) — the level "
            "set in the member's own zarr.json is not the one the artifact row declares, "
            "so a store-URL consumer resolves codes through a DIFFERENT set of labels "
            "than the row promises"
        )
    return out


def _conform_vocab_declaration(path, member, node):
    """The row's `{vocab_digest, vocab_sketch}` against the levels the MEMBER stamps (ITEM-51).

    Two refusals, and they are different claims:

    1. **Exactly one present.** The writer emits both or neither from one normalised level
       list in one pass (`cyto_zarr.vocab_declaration`), so a tree carrying one alone is a
       state this design cannot produce — which means something rewrote one of them, which
       means neither can be trusted. The consumer's rule is "exactly one present ⇒
       undecidable", and that rule is only SOUND if the writer genuinely cannot emit one
       alone. A read-side refusal guarding a state the writer can reach is a refusal that
       fires on healthy data; this is the write-side half that keeps it honest.
    2. **Drift.** When both are present they are RECOMPUTED from the member's own stamped
       `attributes.cyto.levels`, minus the row's declared `missing_level`. This is the same
       shape as `_conform_levels_digest` and it is why the pair is not a free opt-out: an
       oracle that edits only the member's `zarr.json` lands here.

    Both fields absent is CONFORMING and silent — that is the over-budget case
    (`MAX_VOCAB_SKETCH_BYTES`), where the sketch is dropped rather than truncated because a
    truncated sketch answers SUBSET wrongly while looking exactly like a right answer.

    `missing_level` must be excluded before hashing: it is a level the writer INVENTED for
    pandas' -1 code, an artifact of one dataset's missingness rather than part of the
    vocabulary. Hashing it in would make two genuinely identical vocabularies disagree
    whenever one of them happened to have missing values — the exact false mismatch this
    declaration exists to remove.
    """
    stamped = (node.get("attributes") or {}).get("cyto")
    if not isinstance(stamped, dict):
        return []  # reported by `_conform_member_attributes`
    declared_digest = member.get("vocab_digest")
    declared_sketch = member.get("vocab_sketch")
    if declared_digest is None and declared_sketch is None:
        return []  # over budget, or a producer predating ITEM-51 — both conforming
    if (declared_digest is None) != (declared_sketch is None):
        present, absent = (
            ("vocab_digest", "vocab_sketch") if declared_sketch is None
            else ("vocab_sketch", "vocab_digest")
        )
        return [
            f'categorical member "{path}" declares {present} without {absent} — the writer '
            "emits BOTH or NEITHER from one level list in one pass, so exactly one present "
            "means something rewrote it and the survivor cannot be trusted. A consumer's "
            '"exactly one present ⇒ undecidable" rule is only sound while this state is '
            "unreachable from the writer"
        ]
    levels = stamped.get("levels")
    if levels is None:
        return []  # reported by `_stamped_key_violations`
    if not isinstance(levels, list):
        return []  # reported by `_conform_levels_digest`
    recomputed = vocab_declaration(levels, missing_level=member.get("missing_level"))
    if not recomputed:
        return [
            f'categorical member "{path}" declares a vocabulary pair, but its stamped level '
            "set is over `MAX_VOCAB_SKETCH_BYTES` — where the writer emits NEITHER field. A "
            "declaration that could not have been produced from the stamped levels is not a "
            "summary of them"
        ]
    out = []
    if declared_digest != recomputed["vocab_digest"]:
        out.append(
            f'categorical member "{path}" does not match its declared `vocab_digest` '
            f"({str(declared_digest)[:12]}… declared, {recomputed['vocab_digest'][:12]}… "
            "recomputed from the member's own stamped levels) — the vocabulary the artifact "
            "row summarises is not the one the member holds, so an offer decision made from "
            "the catalog would be about a different set of labels than a reader resolves"
        )
    if declared_sketch != recomputed["vocab_sketch"]:
        out.append(
            f'categorical member "{path}" does not match its declared `vocab_sketch` — the '
            "sketch is what makes SUBSET decidable, and a stale one answers subset wrongly "
            "while looking exactly like a right answer"
        )
    return out


def _conform_values_digest(path, member, values):
    """The producer's `values_digest` against the value sequence the offsets produce.

    The declaration is REQUIRED. An arrow-split string member is the one place in this
    format where the stored bytes do not determine the values (see `_conform_string_member`),
    so it is the one place a producer has to say what they are — and a producer able to omit
    that and be checked less holds exactly the opt-out DEC-8 says does not exist.
    """
    declared = member.get("values_digest")
    if declared is None:
        return [
            f'string member "{path}" declares no `values_digest` — the offsets are a '
            "degree of freedom the bytes do not pin (`[0,2,3]` and `[0,1,3]` over `abc` "
            'are both well-formed and mean ["ab","c"] and ["a","bc"]), so a string '
            "member's value sequence is DECLARED by the writer and recomputed here. "
            "Without the declaration a boundary-preserving re-split changes every value "
            "and no byte-level check can see it (DEC-8: a declaration a producer may omit "
            "in order to be checked less is an opt-out)"
        ]
    recomputed = key_sequence_digest(values)
    if declared != recomputed:
        return [
            f'string member "{path}" does not match its declared `values_digest` '
            f"({str(declared)[:12]}… declared, {recomputed[:12]}… stored) — the offsets "
            "split the payload into a different value sequence than the producer wrote"
        ]
    return []


# ── zarr_v3 / sparse_csc ─────────────────────────────────────────────────────────


def _conform_sparse_csc(root, structure, *, full, evidence=None):
    """The CSC trio: three members that only mean anything TOGETHER.

    Each member being individually well-formed proves nothing here — a valid `indptr` and
    a valid `indices` can still describe a matrix that is not the one the producer counted.
    So the cross-member arithmetic is the substance: the pointer array must span the
    declared columns, terminate at nnz, be non-decreasing, and index rows that exist.
    """
    out = _conform_group_attributes(root, structure)
    out += _conform_node_coverage(root, structure)

    shape = structure.get("shape")
    if not (isinstance(shape, list) and len(shape) == 2):
        out.append(f"a sparse_csc artifact must declare `shape` as [rows, columns], got {shape!r}")
        shape = None
    nnz = structure.get("nnz")
    if not isinstance(nnz, int):
        out.append(f"a sparse_csc artifact must declare an integer `nnz`, got {nnz!r}")
        nnz = None

    members = {}
    for role in ("indptr", "indices", "data"):
        member = structure.get(role)
        if not isinstance(member, dict) or not member.get("path"):
            out.append(f'sparse_csc declares no "{role}" member')
            continue
        out += _conform_member(
            root, member, expect_rows=None, full=full, evidence=evidence
        )
        # The trio's cross-member arithmetic below reads the SAME row keys `_conform_member`
        # just refused (`shape[0]` against `nnz`), so a member whose declaration is
        # malformed is left OUT of the trio rather than crashed on — `int(stored[0])` on a
        # scalar `shape` raised, and `conform_manifest` reports a raise INSTEAD of every
        # finding made so far, which would have swallowed the violation naming the cause.
        # One predicate, the same one, so this cannot fall out of step with that refusal.
        if _malformed_member_keys(member, member.get("kind")):
            continue
        members[role] = member
    if len(members) != 3:
        return out

    # Re-read through the gate's own strict walker (never `read_array`) — the cross-member
    # arithmetic below is only as good as the values it is done over, and the convenience
    # reader would substitute `fill_value` for a chunk whose index slot was blanked.
    indptr, errors = _read_whole(root, members["indptr"]["path"], evidence=evidence)
    if errors:
        out += errors
        return out

    if shape is not None and int(indptr.shape[0]) != int(shape[1]) + 1:
        out.append(
            f"indptr holds {indptr.shape[0]} entries for {shape[1]} declared columns "
            f"(expected {int(shape[1]) + 1})"
        )
    if indptr.size:
        if int(indptr[0]) != 0:
            out.append(f"indptr starts at {int(indptr[0])}, not 0")
        if bool((np.diff(indptr.astype(np.int64)) < 0).any()):
            out.append("indptr is not non-decreasing — a column would have negative length")
        if nnz is not None and int(indptr[-1]) != nnz:
            out.append(f"indptr terminates at {int(indptr[-1])} but nnz is declared {nnz}")

    for role in ("indices", "data"):
        stored = members[role].get("shape")
        if nnz is not None and stored is not None and int(stored[0]) != nnz:
            out.append(f"{role} holds {stored[0]} values for a declared nnz of {nnz}")

    # The row ids are the one thing a consumer indexes WITH, so an out-of-range value is a
    # read past the end of somebody's buffer. Bounded by default, exhaustive under `full`.
    indices, errors = _read_whole(root, members["indices"]["path"], evidence=evidence)
    if errors:
        out += errors
        return out
    if indices.size and shape is not None:
        if int(indices.max()) >= int(shape[0]):
            out.append(
                f"a row index reaches {int(indices.max())} in a matrix declared "
                f"{shape[0]} rows deep"
            )
    if full and indices.size and indptr.size > 1:
        # Row ids ASCEND within a column. A consumer that binary-searches a column (the
        # masked-read path) is silently wrong on unsorted input rather than failing.
        starts = indptr.astype(np.int64)
        for c in range(int(starts.shape[0]) - 1):
            lo, hi = int(starts[c]), int(starts[c + 1])
            if hi - lo > 1 and bool((np.diff(indices[lo:hi].astype(np.int64)) <= 0).any()):
                out.append(f"column {c} row ids are not strictly ascending")
                break
    return out


# ── decoding ─────────────────────────────────────────────────────────────────────


def _read_whole(root, path, *, evidence=None):
    """`(values | None, violations)` for a member read EXHAUSTIVELY, meta included.

    The gate's replacement for `cyto_zarr_read.read_array` wherever it needs a whole member
    (a string member's offsets/payload, the CSC trio's `indptr`/`indices`). The convenience
    reader implements the Zarr fill-value rule for an absent chunk, which is right for a
    reader and wrong for a gate — see the module header.
    """
    try:
        meta = cyto_zarr_read.read_meta(root, path)
    except FileNotFoundError:
        return None, [f'member "{path}" has no zarr.json on disk']
    except (OSError, ValueError) as exc:
        return None, [f'member "{path}" has no readable zarr.json ({exc})']
    return _decode(root, path, meta, full=True, evidence=evidence)


def _shard_count(meta):
    """How many shards a member's declared grid divides its length into."""
    shard_rows = int(meta["chunk_grid"]["configuration"]["chunk_shape"][0])
    n = int(meta["shape"][0])
    return (n + shard_rows - 1) // shard_rows


def _shard_plan(meta, *, full):
    """WHICH shards a depth reads — and the reason `full=` can only ever check MORE.

    `full=True` ⇒ every shard. Otherwise a SUBSET of that same list: the first and the last,
    the two that catch the overwhelming majority of container faults (a wrong codec chain
    shows up in the first, a mis-sealed tail shard or an off-by-one in the padding in the
    last). Since the bounded set is a subset of the full one and `_decode_shards` applies
    identical checks to each shard either way, every fault the bounded depth can detect the
    full depth detects too.

    This is the difference `full=` is permitted to make, but NOT the only place `full` is
    consulted — `_conform_sparse_csc` also gates its row-ids-ascending check on it. So the
    permission is a DIRECTION, not a location: a `full` branch may only add checks under
    `full=True`. See the module docstring's "Two depths" section for what enforces that (the
    substantive violation tests run at both depths), because a claim in a docstring does not.

    ## The accounting, said where the branch is

    The `full=False` branch is NOT production-reachable — every production entry passes
    `full=True` (module docstring, "Two depths"). It is here as the subset arm of
    `test_the_full_depth_detects_everything_the_bounded_depth_does`, which asserts `bounded
    reports ⇒ full reports` over seven corruptions and is the only thing that can state the
    monotonicity claim as a property rather than as prose. A second consequence, not the
    reason: the next caller that genuinely needs a bounded read has a structurally-safe one to
    reach for, and does not write the second reader that caused the fault this section
    describes.

    ## WHEN THE SUBSET BRANCH ACTUALLY ENGAGES

    `cyto_zarr.shard_chunks` derives `chunks_per_shard` from the array's own length (capped),
    so an array up to `SHARD_CAP_CHUNKS * INNER_CHUNK` ≈ 16.8M elements lands in ONE shard and
    this returns all of it — bounded and full then decode the same bytes. The subset branch
    engages for a member ABOVE that size, or one whose producer declared an explicit small
    shard geometry, which is what
    `test_the_bounded_depth_really_samples_and_the_full_depth_really_does_not` drives: a test
    that only ever hits the whole-array case proves the sampling code compiles and nothing
    else.
    """
    n_shards = _shard_count(meta)
    if full or n_shards <= SAMPLE_SHARDS:
        return list(range(n_shards))
    return [0, n_shards - 1]


def _decode(root, path, meta, *, full, evidence=None):
    """Decode the member, bounded or whole, returning `(values | None, violations)`.

    ONE container reader at both depths (see [`_shard_plan`]), so the bounded run cannot check
    something DIFFERENT from the exhaustive one — only less of it. A container fault only the
    reader can see (a bad index crc32c, a wrong codec chain, a mis-sealed or blanked shard
    slot) is caught either way.

    THE ONLY WAY TO SPELL A BOUNDED DECODE. There used to be a second one: `_decode_sample`,
    whose body was the identical `_decode_shards(root, path, meta, _shard_plan(meta,
    full=False))` expression this function inlines, with no caller anywhere but one test. A
    duplicate wrapper around the one container reader is a second entry point that can drift
    away from this one — precisely the "two readers, two strictnesses" shape the module
    docstring's monotonicity section exists to have eliminated — so it is gone, and its test
    calls this function with `full=False` instead. `_shard_plan` is now the single place the
    depth is decided.

    The blanket clause below says "does not decode" over EVERY raise, including a
    `PermissionError` off a mode-000 shard file, which condemns the artifact for a
    permissions setting. Known and deliberate — see the RECORDED LIMITATION block above
    `ManifestReport`. Note for whoever revisits it: `gzip.BadGzipFile` is an `OSError`
    SUBCLASS and is THE canonical "these bytes disagree with their declaration", so any
    predicate added here that keys on the exception CLASS stops the gate condemning
    mangled chunks. (That was measured, by
    `test_the_full_depth_detects_everything_the_bounded_depth_does[chunk-bytes-mangled]`.)
    """
    try:
        return (
            _decode_shards(
                root, path, meta, _shard_plan(meta, full=full), evidence=evidence
            ),
            [],
        )
    except Exception as exc:
        return None, [f'member "{path}" does not decode: {type(exc).__name__}: {exc}']


def _shard_index(body, per_shard, *, path, shard):
    """A shard's chunk index, VERIFIED against its own crc32c, as a `(per_shard, 2)` array.

    ## Why the checksum is not optional

    `cyto_zarr` writes `crc32c` over the index bytes (`index_codecs: [bytes, crc32c]`)
    because the index is the one part of a shard whose corruption is otherwise SILENT. A
    flipped byte inside a compressed chunk fails to gunzip, loudly; a flipped byte in an
    offset yields a completely successful decode of the WRONG bytes. Neither depth of this
    gate checked it, so swapping two index slots transposed a member's values and both
    depths reported no violation at all — the format writes the checksum precisely so that
    is detectable, and the gate was throwing it away.

    Verified BEFORE the offsets are used for anything, since after that point every
    subsequent check is being made against bytes the index may have mis-addressed.
    """
    trailer = per_shard * 16 + 4
    if len(body) < trailer:
        raise ValueError(
            f"shard {shard} is {len(body)} bytes, shorter than its {trailer}-byte index "
            "trailer"
        )
    idx_bytes = bytes(body[len(body) - trailer : len(body) - 4])
    stored = int.from_bytes(bytes(body[len(body) - 4 :]), "little")
    computed = crc32c(idx_bytes)
    if stored != computed:
        raise ValueError(
            f"shard {shard} chunk index fails its crc32c (stored {stored:08x}, computed "
            f"{computed:08x}) — the offsets saying which bytes are which chunk are not the "
            "ones that were written, so any successful decode here would be a decode of "
            "the wrong bytes"
        )
    return np.frombuffer(idx_bytes, dtype="<u8").reshape(per_shard, 2)


def _decode_shards(root, path, meta, shards, *, evidence=None):
    """Decode named shards of a member into one flat array (the named positions only).

    THE gate's container reader, at every depth (`_shard_plan` chooses `shards`). The
    trailing inner chunk of an array is PADDED to `chunk_shape` with `fill_value`
    (`cyto_zarr.ArrayWriter._emit`), and `shape` is what bounds a reader. So each decoded
    chunk is trimmed to the logical rows it actually covers — without that, the subset read
    carries fill values the array does not contain and a value-range check (a
    categorical's codes) would be judging padding.

    ## Where the receipt is issued, and why it cannot move back up

    This function used to open with `_note(evidence, "walked", len(shards))`, ABOVE the
    loop. `shards` comes from [`_shard_plan`], which derives it from the declared grid, so
    that receipt was a restatement of the manifest issued by ENTERING the reader — and an
    `n=0` member (a legal shape whose `c/` is genuinely empty) then produced `checks: 1,
    chunks: 0, decoded_bytes: 0`, `violations: {}` and exit 0 through the real entry: a
    fully-accounted green verdict over zero bytes. A deleted shard file produced `checks:
    1, shards: 1` — a receipt for a file that does not exist.

    The receipt is now issued INSIDE the loop, on the line after the `read_bytes()` that
    obtained the bytes, and [`Evidence.container`] takes THE BYTES rather than a count, so
    there is nothing above the read that can file one. A shard whose read raises records
    nothing, which is correct twice over: those bytes were not read, and the raise becomes
    that member's violation, which is what accounts for the artifact instead.
    """
    import gzip

    cfg = meta["codecs"][0]["configuration"]
    dtype = np.dtype(meta["data_type"]).newbyteorder("<")
    inner_rows = int(cfg["chunk_shape"][0])
    shard_rows = int(meta["chunk_grid"]["configuration"]["chunk_shape"][0])
    per_shard = shard_rows // inner_rows
    n = int(meta["shape"][0])
    width = meta["shape"][1] if len(meta["shape"]) == 2 else None
    shuffled = any(c["name"] == "numcodecs.shuffle" for c in cfg["codecs"])

    per_chunk = inner_rows if width is None else inner_rows * int(width)
    parts = []
    shards = list(shards)
    for s in shards:
        key = f"{s}" if width is None else f"{s}/0"
        body = (Path(root) / path / "c" / key).read_bytes()
        # THE RECEIPT, earned by the line above and by nothing else. It is handed the
        # BYTES: there is no spelling of it available before the read.
        _note(evidence, "container", body)
        trailer = per_shard * 16 + 4
        # EVERY step below fails LOUDLY rather than yielding fewer values. That is the
        # difference between a real check and a vacuous one: a shard truncated into
        # its index trailer reads as garbage offsets, and `gzip.decompress(b"")` returns
        # `b""` WITHOUT raising — so an earlier version decoded a corrupt shard to zero
        # values and reported nothing at all. A read that silently decodes nothing is a
        # pass, which is the one answer a gate must never give by accident.
        index = _shard_index(body, per_shard, path=path, shard=s)
        covered = 0
        for k, (off, nb) in enumerate(index):
            lo = s * shard_rows + k * inner_rows
            if lo >= n:
                continue  # a slot past the end of the array is legitimately EMPTY
            rows = min(inner_rows, n - lo)
            if int(off) == cyto_zarr_read.EMPTY:
                # THE CASE THE FULL DEPTH USED TO PASS. `cyto_zarr` emits every chunk that
                # covers logical rows, so an EMPTY slot inside `shape` is a corrupt store —
                # but the Zarr rule a READER implements is "absent chunk ⇒ fill_value", so
                # `read_array` (which `full=True` used to call) silently substituted zeroes
                # for these rows and reported nothing.
                raise ValueError(
                    f"shard {s} chunk {k} is marked empty but covers rows {lo}..{lo + rows}"
                    " — a chunk inside the array's declared shape is never absent, and a "
                    "reader would silently substitute fill_value for these rows"
                )
            if int(nb) == 0 or int(off) + int(nb) > len(body) - trailer:
                raise ValueError(
                    f"shard {s} chunk {k} indexes bytes {off}..{int(off) + int(nb)} of a "
                    f"{len(body)}-byte shard"
                )
            plain = gzip.decompress(bytes(body[int(off) : int(off) + int(nb)]))
            _note(evidence, "decoded", len(plain))
            if shuffled:
                plain = cyto_zarr_read.unshuffle(plain, dtype.itemsize)
            block = np.frombuffer(plain, dtype=dtype)
            if int(block.size) != per_chunk:
                raise ValueError(
                    f"shard {s} chunk {k} decoded {block.size} values, not the "
                    f"{per_chunk} a chunk always holds"
                )
            if width is not None:
                block = block.reshape(inner_rows, width)[:rows].reshape(-1)
            else:
                block = block[:rows]
            parts.append(block)
            covered += rows
        expect = max(0, min(shard_rows, n - s * shard_rows))
        if covered != expect:
            raise ValueError(
                f"shard {s} decoded {covered} of the {expect} rows it covers"
            )
    return np.concatenate(parts) if parts else np.empty(0, dtype=dtype)


# ── ITEM-19: key_sequence_digest, the PRODUCER's alignment guarantee ─────────────
#
# Two artifacts share an axis when they are aligned to the same key sequence, in the same
# ORDER. Nothing server-side can check that: recomputing a digest from stored bytes to
# judge whether two artifacts agree IS opening bytes for meaning, which INV-1 forbids the
# server to do. So the check lives here, on the producer's side of the boundary, where the
# alignment was created and where getting it wrong is a bug that can still be fixed.
#
# The digest FUNCTION itself is `cyto_zarr`'s (see the section comment there): the producer
# DECLARES `structure.key_sequence_digest` over the values it stores, and this module
# RECOMPUTES the same digest from the bytes that landed. A comparison between the two is
# only meaningful if both sides digest identically, so there is exactly one implementation
# and this side imports it. The import runs gate→writer and never the other way: a staged
# module importing this one would put the gate inside the process it judges (DEC-8), which
# `test_the_gate_is_not_reachable_from_the_processors_own_process` fails on.
#
# `key_sequence_digest` is imported at the top of this module for that reason; it is
# re-exported here so `conformance.key_sequence_digest` keeps naming the one definition.


def _member_values(root, member):
    """A member's values as a READER gets them — through the GATE's own strict walker.

    What `cyto_zarr_read.read_column` returns (labels for a categorical, `str`s for a string
    member, the array otherwise), decoded via `_read_whole` instead. The difference is not
    cosmetic and it is why this exists rather than calling the convenience reader:
    `read_array` implements the Zarr rule that an absent chunk is `fill_value`, which for a
    key member means a blanked shard-index slot digests as a run of zeroes (or, for an
    offsets array, silently re-splits the payload) instead of failing. That is the exact
    weaker-arm fault the module header describes, and it was still live on this path — the
    header's claim that "the gate never calls `read_array` for member bytes" was false for
    `_conform_key` and `axis_alignment_violations`, both of which are production paths.

    Raises on a container fault (the caller turns it into that artifact's violation), so a
    fault here can never be reported as a digest that merely happens not to match.
    """
    root = Path(root)
    meta = cyto_zarr_read.read_meta(root, member)  # metadata, not bytes
    kind = ((meta.get("attributes") or {}).get("cyto") or {}).get("kind")
    if kind == "string" or (root / member / "offsets").is_dir():
        offsets, errors = _read_whole(root, f"{member}/offsets")
        if errors:
            raise ValueError("; ".join(errors))
        payload, errors = _read_whole(root, f"{member}/values")
        if errors:
            raise ValueError("; ".join(errors))
        raw = payload.tobytes()
        return [
            raw[int(offsets[i]) : int(offsets[i + 1])].decode("utf-8")
            for i in range(int(offsets.shape[0]) - 1)
        ]
    values, errors = _read_whole(root, member)
    if errors:
        raise ValueError("; ".join(errors))
    if kind == "categorical":
        levels = ((meta.get("attributes") or {})["cyto"])["levels"]
        return [levels[int(c)] for c in values]
    return values.tolist()


def key_sequence_digest_of_member(root, member):
    """The digest of a member's keys, RECOMPUTED FROM THE STORED BYTES.

    Reading it back rather than digesting the in-memory values is the point: what a
    downstream consumer aligns against is what landed on disk, so a writer that dropped or
    reordered a value on the way out is only visible from this side of the encoder.

    Reads through [`_member_values`] — i.e. through this module's own container walker — so
    the ONE-container-reader property the header claims holds for this path too.
    """
    values = _member_values(root, member)
    if isinstance(values, np.ndarray):
        values = values.tolist()
    return key_sequence_digest(values)


def axis_key_digests(artifacts):
    """`{label: digest}` for a group of key artifacts claiming one axis, RECOMPUTED FROM
    THE STORED BYTES.

    Split out of [`axis_alignment_violations`] because ITEM-16 needs the VALUE, not just
    the verdict: a non-key artifact declaring `structure.aligned_to` is checked against the
    key sequences the run actually emitted, and this function is where those come from. It
    was computed and discarded before — the whole cost of the alignment guarantee was
    already being paid, and the answer thrown away one line later.
    """
    return {
        str(label): key_sequence_digest_of_member(root, member)
        for label, root, member in artifacts
    }


def aligned_to_violations(declared, digests):
    """Every artifact whose declared `aligned_to` is not a key sequence this run emitted,
    as `[(label, violation)]`.

    ATTRIBUTED PER ARTIFACT, unlike the cross-artifact disagreement beside it, and the
    difference is real: when two key artifacts disagree about an axis no single one of them
    is "the wrong one", so both are named; here exactly one artifact made a claim its own
    run refutes, and naming its innocent siblings would mark them failed too — the verdict
    crosses into `apply_verdict`, which writes `status='failed'` per named artifact.

    `declared` is `[(label, aligned_to)]` for the artifacts on ONE axis that made the
    declaration; `digests` is [`axis_key_digests`] for that axis's KEY artifacts. This is
    the check that makes `aligned_to` worth anything: like `key_sequence_digest`, it is a
    producer DECLARATION, so it is verified against the bytes that landed rather than
    trusted (the module header's rule, applied to the other half of INV-3).

    **An axis with no key artifact in this run yields NOTHING**, and that is deliberate
    rather than lenient. A run that adds columns to an axis it did not create genuinely
    cannot be checked from inside itself, and the honest options are to say nothing or to
    condemn every such column — condemning what cannot be examined would make the
    declaration unusable for exactly the producers ITEM-15 most wants to adopt it, and the
    unverifiable claim is still refutable later, by the offering predicate that compares it
    against the real axis.
    """
    if not digests:
        return []
    emitted = set(digests.values())
    out = []
    for label, value in declared:
        if value in emitted:
            continue
        out.append((
            label,
            f"{label} declares aligned_to={str(value)[:12]}…, which is not the key "
            "sequence any of this axis's key artifacts stored ("
            + "; ".join(f"{d[:12]}… ← {lab}" for lab, d in sorted(digests.items()))
            + ") — the values are declared to line up with a row space this run does not "
            "contain, so nothing may be painted with them",
        ))
    return out


def axis_alignment_violations(artifacts):
    """Every way a set of artifacts claiming ONE axis fails to actually share it.

    `artifacts` is an iterable of `(label, root, member)`. They are aligned when every key
    sequence digests identically; the report names which labels disagree, because "these
    two are misaligned" is actionable and "something is misaligned" is not.
    """
    return alignment_disagreements(axis_key_digests(artifacts))


def alignment_disagreements(digests):
    """[`axis_alignment_violations`] over ALREADY-RECOMPUTED digests.

    The pure half, so `conform_manifest` can read each key member ONCE and answer both
    questions from it — this one and ITEM-16's `aligned_to` check. Re-reading a 10⁷-row key
    column to ask a second question about the same bytes is a cost the gate has no reason
    to pay twice.
    """
    distinct = sorted(set(digests.values()))
    if len(distinct) <= 1:
        return []
    groups = {
        d: sorted(label for label, got in digests.items() if got == d) for d in distinct
    }
    return [
        "artifacts declared to share one axis have "
        f"{len(distinct)} different key sequences: "
        + "; ".join(f"{d[:12]}… ← {', '.join(labels)}" for d, labels in groups.items())
    ]


def declares_axis_index(meta):
    """`True` when the producer's `meta` says this artifact IS its axis.

    `meta.is_axis_index` is the predicate the SERVER resolves an axis by
    (`CatalogRepository::list_dataset_axis_index_candidates` matches
    `meta @> '{"is_axis_index": true}'` plus `structure.axis`), so it is not decoration: it
    is the artifact volunteering to be the row every aligned artifact in the dataset is
    aligned against. One definition here, because two spellings of "is it the axis" is how
    the two halves of a paired declaration drift apart.
    """
    return isinstance(meta, dict) and meta.get("is_axis_index") is True


def declares_groups_entries(meta):
    """`True` when the producer's `meta` says this column GROUPS the entries of its axis.

    ITEM-53 / INV-16 — *"the column declares itself"*, on the `meta.is_axis_index` precedent
    above and for the same reason: the viewer asks an axis's columns *"does any of you group
    these entries?"* and resolves whichever one says yes, so it never learns what the groups
    MEAN. A naming convention would put that knowledge back in the viewer (it would have to
    know which column names are grouping ones), which is exactly what the declaration
    removes. One definition here, because two spellings of a predicate is how the two halves
    of a paired declaration drift apart.
    """
    return isinstance(meta, dict) and meta.get("groups_entries") is True


def _conform_groups_entries(structure, meta):
    """A `meta.groups_entries` declaration has to be one the viewer could act on (ITEM-53).

    Two ways it cannot be, both decidable from the producer's own two declarations with no
    bytes read:

    * **On a CONTINUOUS column.** A grouping is over discrete levels; measurements have
      none. The viewer would resolve the column, ask it for its groups and get one heading
      per distinct float — a list of 3.5k headings, which is not a failure it can see coming.
    * **On the axis INDEX.** The key artifact IS the entries; grouping entries by their own
      keys yields one group per entry and says nothing. A producer that declares both has
      confused "identifies" with "groups", and the two together are unfalsifiable later.

    `groups_entries` is not otherwise checkable here: WHICH grouping is correct is a domain
    fact this framework file must not know (INV-5), so the gate checks the shape of the claim
    and the viewer renders what the producer said.
    """
    if not declares_groups_entries(meta):
        return []
    if meta.get("groups_entries") is not True:
        return []
    out = []
    if declares_axis_index(meta):
        out.append(
            "`meta.groups_entries: true` is declared beside `meta.is_axis_index: true` — a "
            "key artifact IS its axis's entries, so grouping them by their own keys yields "
            "one group per entry. A grouping column is an ORDINARY column on the axis"
        )
    if str(meta.get("kind") or "") == "continuous":
        out.append(
            "`meta.groups_entries: true` is declared on a column whose own `meta.kind` is "
            "`continuous` — a grouping is over discrete levels, and one heading per distinct "
            "measurement is not a grouping"
        )
    if structure.get("key"):
        out.append(
            "`meta.groups_entries: true` is declared on a column that also declares "
            f'`structure.key` ({structure.get("key")!r}) — a column carrying the axis\'s own '
            "keys groups nothing: every key is its own group"
        )
    return out


def _conform_aligned_to(structure):
    """`structure.aligned_to` has to BE a key-sequence digest, and must not contradict this
    artifact's own key declaration (ITEM-15).

    The shape half catches the one slip the writer's own guard exists for, on the path where
    a structure did NOT come through `cyto_zarr.Table` (a hand-built manifest entry, a
    re-encoder): `aligned_to` holding a label, or the key sequence itself, would sail past
    every other check in this suite and surface only as a picker that quietly offers nothing.

    The contradiction half is the same statement made twice: an artifact that CARRIES an
    axis's keys is aligned to that axis, so declaring a different one is a disagreement
    between one producer's own two sentences — decidable without opening a byte, and named
    here rather than left to the cross-artifact comparison, which would report it as a
    disagreement with the RUN.

    Whether the digest names the RIGHT axis is not answerable from one artifact: that is
    `conform_manifest`'s cross-artifact check, which recomputes the run's key sequences from
    the stored bytes and compares.
    """
    declared = structure.get("aligned_to")
    if declared is None:
        return []
    if not isinstance(declared, str) or not re.fullmatch(r"[0-9a-f]{64}", declared):
        return [
            f"structure declares aligned_to={str(declared)[:40]!r}, which is not a "
            "`key_sequence_digest` — the declaration names the axis's ordered KEY SEQUENCE "
            "by its digest, never a label and never the keys themselves"
        ]
    own = structure.get("key_sequence_digest")
    if isinstance(own, str) and own != declared:
        return [
            f"structure declares aligned_to={declared[:12]}… while its own key member "
            f'"{structure.get("key")}" declares key_sequence_digest={own[:12]}… — an '
            "artifact that carries an axis's keys is aligned to that axis, so the two "
            "cannot disagree"
        ]
    return []


def _conform_key(root, structure, *, meta=None, member_paths=None):
    """A DECLARED key member has to exist, has to digest, and has to have SAID what it
    digests to (ITEM-19) — and an artifact that IS an axis has to declare one at all.

    The producer states two things: WHICH member holds the axis keys, and WHAT that
    ordered key sequence is (`key_sequence_digest`, over the values it stored). Neither is
    taken on trust — the digest is RECOMPUTED here, from the bytes that landed, and the
    declaration is checked against it.

    That comparison is the whole mechanism, and it is why the declaration is REQUIRED
    rather than optional. A structure naming a `key` member and nothing else says "the
    axis's keys are over there" without saying what they are, which leaves the artifact's
    only identity its LABEL — the thing INV-3 forbids being a key. With the declaration
    present, a writer that dropped or reordered values on the way out shows up as a
    disagreement between what the producer meant and what the store holds; without it,
    this function can only confirm that the bytes digest to whatever the bytes digest to.

    ## The OMISSION was the second `opaque`

    All of the above only ran when `key` was present, and `conform_manifest` only put an
    artifact into its axis's alignment group when `key` was present. So **writing nothing**
    removed the artifact from the digest check AND from the cross-artifact alignment
    check — §0.3's named mechanism for catching row-order misalignment — with no message
    and no trace. That is the `encoding: "opaque"` hole in its other form: a producer
    choosing how hard the gate looks at its own output.

    It is closed the way `opaque` was: not by forbidding the omission (a positional axis
    genuinely has no key member, and inventing one would be the inference INV-2 forbids)
    but by making the omission FALSIFIABLE against the producer's own other declaration.
    `meta.is_axis_index: true` says this artifact IS the axis — the row the server resolves
    `structure.axis` to — and an artifact that is an axis while declining to say what its
    ordered key sequence is has no identity but its label, which is exactly what INV-3
    forbids. The two declarations are made by the same producer in the same manifest entry,
    so their disagreement is a fact about the declaration, not a guess about the data.

    What is deliberately NOT symmetric: `key` WITHOUT `is_axis_index` is fine. A `cell_id`
    column legitimately carries the cells axis's keys without being the artifact the axis
    resolves to (`cyto_columns.write_metadata_column` documents exactly that case), and it
    is a strictly stronger declaration than staying silent.
    """
    key = structure.get("key")
    if not key:
        if structure.get("key_sequence_digest") is not None:
            return [
                "structure carries a `key_sequence_digest` without naming the `key` member "
                "it belongs to — the digest is unverifiable"
            ]
        if declares_axis_index(meta):
            return [
                "`meta.is_axis_index: true` declares that this artifact IS its axis — the "
                "row the server resolves `structure.axis` to — but the structure names no "
                "`key` member, so the ordered key sequence that IS the axis's identity "
                "(INV-3) is neither declared nor checkable. Omitting `key` also drops this "
                "artifact out of the cross-artifact alignment group, which is the mechanism "
                "for catching row-order misalignment; a declaration a producer may omit in "
                "order to be checked less is an opt-out (DEC-8), so the omission is "
                "falsified against this artifact's own other declaration rather than "
                "accepted. Emit `structure.key` + `structure.key_sequence_digest` (the "
                "writer does it from `holds_axis_keys=True` / `Table(key=…)`)"
            ]
        return []
    if member_paths is not None and key not in set(member_paths):
        return [
            f'structure names "{key}" as its key member, but no declared member has that '
            f"path ({sorted(str(p) for p in member_paths)}) — the digest below would be "
            "taken over bytes no other check in this suite ever looked at"
        ]
    try:
        recomputed = key_sequence_digest_of_member(root, key)
    except FileNotFoundError:
        return [f'the declared key member "{key}" is not on disk']
    except Exception as exc:
        return [f'key member "{key}" does not decode for the digest: {exc}']
    declared = structure.get("key_sequence_digest")
    if declared is None:
        return [
            f'structure names "{key}" as its key member but declares no '
            "`key_sequence_digest` — a key artifact that does not say what its ordered "
            "key sequence is has nothing identifying it but its label (INV-3)"
        ]
    if declared != recomputed:
        return [
            f'the declared key_sequence_digest ({str(declared)[:12]}…) is not what member '
            f'"{key}" actually digests to ({recomputed[:12]}…) — the declaration and the '
            f"bytes describe different key sequences"
        ]
    return []


# ── the verification-processor / CI entry point ──────────────────────────────────


def conform_manifest(root, manifest, *, full=True):
    """Gate every artifact a DECODED manifest declares, resolved under `root`.

    Returns a [`ManifestReport`], which IS the `[(labels, violation)]` list this has always
    returned (it iterates, indexes, compares and lengths as one) plus an `examined` tally.
    `labels` names the artifact(s) a violation is ATTRIBUTABLE to — one label for a
    per-artifact fault, every member of the group for a cross-artifact axis misalignment
    (they disagree with each other; no single one of them is "the wrong one"), and an empty
    list for a run-level fault that belongs to no artifact. `violation` is the fully-formatted
    string, so a caller that only wants the flat report drops the labels and gets exactly
    what `conform_outputs` returns.

    Attribution is what the production caller needs and a CLI does not: the verification
    job (DEC-12) has to mark THE non-conforming artifact failed, and "something in this run
    is broken" cannot do that. Splitting it out here rather than re-deriving it by parsing
    the report strings keeps ONE implementation — a caller cannot end up checking something
    different from, or less than, the CLI.

    `examined[label]` is that artifact's [`Evidence`] tally, kept by the code that reads the
    bytes. It exists because the production entry's `checked` list — the server's positive
    control against a vacuous verdict — used to be re-derived from this function's own INPUT,
    so a gate that read nothing still accounted for every artifact and exited 0.

    Each artifact is checked in ISOLATION. An exception escaping one artifact's check used to
    abort the whole batch (`NotADirectoryError` is not a `FileNotFoundError`, so a `zarr_v3`
    declaration over a plain file threw), which cost the innocent siblings their verdicts as
    well. A raise while reading ONE artifact's bytes is now that artifact's violation — the
    same judgement every inner check in this module already makes ("`string member "x" does
    not decode: …`"), just applied at the outermost seam. It is a claim about those bytes and
    those bytes only, so it cannot condemn a sibling.

    With NO exception, including an OS fault: `_raise_as_violation`'s sentence ("the
    declaration does not describe what is on disk") is said over a `PermissionError` too.
    That is the same fail-closed rule the inner readers apply, and it is uniform on purpose
    — see the RECORDED LIMITATION block above `ManifestReport` for the two withdrawn
    attempts at a third answer, and for the HIGH the second one shipped.

    It reads the manifest it is HANDED and the bytes under `root`; nothing else. The
    emitting package's `manifest.yaml` never enters this function, no environment is read,
    and there is no parameter that lowers the bar (`full=` only ever raises it), which is
    what leaves a processor author nothing to write that changes the outcome.
    """
    root = Path(root)
    entries = manifest.get("outputs") or []
    if not entries:
        return ManifestReport([([], f"{root} declares no outputs")], {})

    violations = []
    examined = {}
    aligned = {}
    # ITEM-15's declarations, collected per axis alongside the key artifacts they are
    # claims ABOUT, so the comparison below is between two things this one run emitted.
    declared_alignment = {}
    for entry in entries:
        label = entry.get("id") or entry.get("path") or "<unnamed>"
        structure = entry.get("structure")
        if structure is None:
            violations.append(
                ([label], f"output {label!r} declares no `structure` (ITEM-5/INV-2)")
            )
            continue
        path = entry.get("path")
        if not path:
            violations.append(([label], f"output {label!r} declares no `path`"))
            continue
        member_root = root / path
        # `meta` is the producer's OTHER declaration on the same entry (what the bytes MEAN
        # — `is_axis_index`, the column summary). Read so a `structure` omission can be
        # falsified against it; `jobs::conformance::build_gate_manifest` was stripping it,
        # which is why the pairing was previously only a comment.
        evidence = Evidence()
        try:
            found = conform_artifact(
                member_root,
                structure,
                full=full,
                meta=entry.get("meta"),
                evidence=evidence,
            )
        # THE SITE WHERE AN OS FAULT BECOMES A CONDEMNATION. There is no `_IoFault` arm
        # above this one: `except Exception` takes a `PermissionError` exactly as it takes a
        # `ValueError`, so a fault the inner readers let escape lands in `violations[label]`
        # and `apply_verdict` writes `status='failed'`. Read the RECORDED LIMITATION block
        # above `ManifestReport` before adding one back — the arm that used to be here
        # `continue`d, and `conform_artifact` accumulates its violations in a local list
        # that a raise from a LATER reader throws away with the frame. So one `chmod 000` on
        # an unrelated member erased a genuine, already-found refutation, turned a refuted
        # artifact into an unaccounted-for one, and it kept `status='ready'` and kept
        # serving. A third answer has to attribute the fault WITHOUT losing those.
        except Exception as exc:
            found = [_raise_as_violation(exc)]
        examined[str(label)] = evidence.as_dict()
        violations += [([label], f"{label}: {v}") for v in found]
        key = structure.get("key")
        # The axis is declared on the structure by `Table`, and on the manifest ENTRY by
        # the processors' `output_entry`. Either is the producer saying it; neither is
        # inferred, so both are read.
        axis = structure.get("axis") or entry.get("axis")
        if key and axis:
            aligned.setdefault(str(axis), []).append((label, member_root, key))
        # ITEM-15: the OTHER half of the same identity claim, made by an artifact that
        # carries no keys of its own. Collected under the axis it NAMES so it is checked
        # against that axis's key artifacts and not against some other axis's.
        declares = structure.get("aligned_to")
        if declares is not None and axis:
            declared_alignment.setdefault(str(axis), []).append((label, declares))

    # Outputs that named the same axis AND a key member have to agree about that axis's
    # key sequence — the ITEM-19 alignment check, run over a whole run's emissions. An
    # artifact declaring `meta.is_axis_index` is guaranteed to be in this group: omitting
    # `key` to escape it is refused by `_conform_key`.
    #
    # ITEM-16 reads the SAME digests: every DECLARED `aligned_to` is verified against the
    # key sequences this run's own key artifacts stored, so a producer that declared an
    # alignment its output does not have is refused rather than believed. Both questions
    # are answered from one read of each key member.
    digests_by_axis = {}
    for axis, group in aligned.items():
        labels = [label for label, _, _ in group]
        try:
            digests_by_axis[axis] = axis_key_digests(group)
        # Same rule at the same altitude, and the same recorded limitation: this reader
        # opens OTHER artifacts' key members, so an OS fault on any one of them is
        # rendered as a violation against the WHOLE group.
        except Exception as exc:
            violations.append((labels, f"axis {axis!r}: {_raise_as_violation(exc)}"))
            continue
        if len(group) > 1:
            found = alignment_disagreements(digests_by_axis[axis])
            violations += [(labels, f"axis {axis!r}: {v}") for v in found]

    # An axis whose key artifact is not part of THIS run yields no digests and therefore no
    # verdict — see `aligned_to_violations` for why silence is the honest answer there.
    for axis, declared in declared_alignment.items():
        found = aligned_to_violations(declared, digests_by_axis.get(axis) or {})
        violations += [([label], f"axis {axis!r}: {v}") for label, v in found]
    return ManifestReport(violations, examined)


def _raise_as_violation(exc):
    """An exception escaping one artifact's check, rendered as THAT artifact's violation.

    Bounded on purpose: the verdict crosses a process boundary into a log line and a DB
    write, so the type, the message and the failing source line go in, and the rest of the
    traceback does not.
    """
    frames = traceback.extract_tb(exc.__traceback__)
    where = ""
    if frames:
        last = frames[-1]
        where = f" (at {Path(last.filename).name}:{last.lineno})"
    return (
        f"the gate could not finish reading these bytes: {type(exc).__name__}: {exc}"
        f"{where} — the declaration does not describe what is on disk"
    )


def conform_outputs(outputs_dir, *, full=True):
    """Gate every artifact a run emitted, from `<outputs_dir>/manifest.json`.

    A directory and a manifest, and nothing else — no processor code, no processor
    manifest, no configuration. This is [`conform_manifest`] plus reading the manifest off
    disk, and the flat report it returns is that function's `violation` column verbatim.

    Returns the list of violations across all outputs; `gate_outputs` raises on them.
    """
    outputs_dir = Path(outputs_dir)
    manifest_path = outputs_dir / "manifest.json"
    if not manifest_path.exists():
        return [f"no manifest.json at {outputs_dir}"]
    manifest = json.loads(manifest_path.read_text())
    if not (manifest.get("outputs") or []):
        return [f"{manifest_path} declares no outputs"]
    return [v for _labels, v in conform_manifest(outputs_dir, manifest, full=full)]


def gate_outputs(outputs_dir, *, full=True):
    """`conform_outputs`, raising. The verification processor's `main`."""
    violations = conform_outputs(outputs_dir, full=full)
    if violations:
        raise ConformanceError(outputs_dir, violations)


def main(argv=None):
    """`python3 -m conformance <outputs_dir>` — the verification processor's CLI.

    Exit 0 = every emitted artifact conforms. Exit 1 = it does not, and every violation is
    on stderr. There is no flag that makes a violation non-fatal.
    """
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) != 1:
        print("usage: python3 -m conformance <outputs_dir>", file=sys.stderr)
        return 2
    violations = conform_outputs(argv[0])
    for v in violations:
        print(f"conformance: {v}", file=sys.stderr)
    if violations:
        print(f"conformance: {len(violations)} violation(s)", file=sys.stderr)
        return 1
    print("conformance: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
