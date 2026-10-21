#!/usr/bin/env python3
# ruff: noqa
"""TEST-9 — every refusal is NAMED, BOUNDED and SAFE TO LOG. Measured on the real stderr.

**INV-9**, lifted verbatim from `docs/design/vendor-text-encodability-refusal.md` §6.5
INV-1:

> A bundle this importer cannot carry is REFUSED BY NAME — `VisiumImportError` — never a
> traceback and never an exit-1.

Its honest scope is the sibling's, and is repeated rather than quietly widened: this is a
statement about the failures THIS DESIGN REACHES, enumerated in `hd_hostile_bundles.REFUSALS`
and swept below. It is not a claim that no state of the module can produce a traceback — a
filesystem error at `write_manifest` (which runs after `main()`'s `try/except` closes) is the
known open shape on the sibling side and is not claimed closed here either.

## Why stderr is captured as BYTES

`scheduler.rs::drain_logs` reads a compute's stderr with `BufReader::lines()` and writes EACH
LINE as its own `job_logs` row, with no per-line cap, and the UI renders that text HTML-safe
but ANSI-unsafe. So the properties that matter are properties of the BYTES: one line, ASCII,
no control characters, bounded length. `text=True` would decode a raw `\\r` into an invisible
character, turn a vendor-supplied `\\n` into an ordinary newline indistinguishable from the
message's own — and that newline IS the attack, because it forges a log row.
"""
import re
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402
import hd_hostile_bundles as HB  # noqa: E402

IDS = [row[0] for row in HB.REFUSALS]

#: The byte ceiling one refusal line may occupy on stderr.
#:
#: DERIVED, not chosen. The dominant term is the funnels' own bound: at most
#: `_REFUSAL_QUOTE_ITEMS` (8) elements x `_REFUSAL_QUOTE_CHARS` (120) units x the widest
#: `ascii()` escape a single unit can produce (10 characters, `\\U0001f9ec`) = 9,600
#: characters, plus each element's clip sentence, plus the refusal's own fixed prose (the
#: longest in this module is the rewritten mixed message, ~2,000 characters) and the
#: analysis-id prefix. 24 KiB is
#: comfortably above that and far below anything a vendor field can push it to — which is the
#: property under test: the message must not GROW WITH THE INPUT.
REFUSAL_LINE_CEILING_BYTES = 24 * 1024

#: The prefix `main()` prints. Named so a test asserting "the line identifies the analysis"
#: cannot pass on a line that merely contains the word "visium".
PREFIX = b"spatial.import-visium-hd: "


def _staged(tmp_path, bundle):
    """Mount one bundle as the `bundle` slot and return its `/inputs` dir."""
    import json

    inputs = tmp_path / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    staged = inputs / Path(bundle).name
    staged.symlink_to(Path(bundle).resolve(), target_is_directory=True)
    (inputs / "inputs.json").write_text(json.dumps({
        "inputs": [{"slot": "bundle", "kind": "dataset",
                    "sandbox_path": f"/inputs/{staged.name}"}]
    }), encoding="utf-8")
    return inputs


def _refusal_lines(stderr_bytes):
    """The stderr lines that are NOT progress chatter.

    `progress()` writes `progress: …` to stderr on every phase, so a naive "stderr is one
    line" assertion would be about the progress channel rather than about the refusal.
    """
    return [ln for ln in stderr_bytes.split(b"\n") if ln and not ln.startswith(b"progress: ")]


@pytest.mark.parametrize("case", HB.REFUSALS, ids=IDS)
def test_TEST_9_every_refusal_is_ONE_ascii_control_free_line_at_exit_2(case, tmp_path):
    """TEST-9 [acceptance, INV-9] — the whole table, on the bytes that actually reach stderr.

    Five properties per case, and each is a defect the sibling's #336 measured on real bundles
    before it was closed:

    * **exit 2**, never 1 — an exit-1 means the refusal escaped `main()` as a traceback;
    * **no `Traceback`** anywhere on stderr, which is the same claim stated positively;
    * **ONE line**, because a vendor-supplied `\\n` forges a `job_logs` row (the measured
      case on the sibling forged `import SUCCEEDED`);
    * **pure ASCII and control-free**, because the UI renders this text ANSI-unsafe;
    * **bounded** — see `REFUSAL_LINE_CEILING_BYTES` for how the bound is derived.
    """
    case_id, build, requested, what = case
    bundle = build(tmp_path / case_id)
    inputs = _staged(tmp_path, bundle)
    params = {} if requested is None else {"bin_um": requested}

    result = HF.run_entry_bytes(inputs, tmp_path / "out", params=params)

    assert result.returncode == 2, (
        f"{case_id!r} ({what}) exited {result.returncode}\n{result.stderr[:2000]!r}")
    assert b"Traceback" not in result.stderr, (
        f"{case_id!r} produced a TRACEBACK rather than a named refusal:\n"
        f"{result.stderr[-2000:]!r}")

    lines = _refusal_lines(result.stderr)
    assert len(lines) == 1, (
        f"{case_id!r} put {len(lines)} non-progress lines on stderr; each becomes its own "
        f"`job_logs` row, so more than one means a vendor value carried a newline: {lines!r}")

    line = lines[0]
    assert line.startswith(PREFIX), (
        f"{case_id!r}'s refusal does not identify the analysis: {line[:200]!r}")
    assert line.isascii(), f"{case_id!r}'s refusal is not ASCII: {line[:400]!r}"
    control = [b for b in line if b < 0x20 or b == 0x7F]
    assert not control, (
        f"{case_id!r}'s refusal carries control bytes {control!r}, which the UI renders "
        f"ANSI-unsafe: {line[:400]!r}")
    assert len(line) <= REFUSAL_LINE_CEILING_BYTES, (
        f"{case_id!r}'s refusal is {len(line)} bytes, over the {REFUSAL_LINE_CEILING_BYTES} "
        "ceiling — a message that grows with the input is a stderr flood")


@pytest.mark.parametrize("case", HB.REFUSALS, ids=IDS)
def test_TEST_9_every_refusal_SAYS_something_a_reader_can_act_on(case, tmp_path):
    """TEST-9 [acceptance, INV-9] — "REFUSED BY NAME" means the message names the offence.

    A refusal that says only "this bundle is invalid" satisfies every byte-level property
    above and helps nobody. So each message must be substantive (a real sentence, not a
    label), and — the part #313 is actually about — it must not send the reader to a CLOSED
    issue. #313 exists because `import_visium.py`'s HD refusal points at #160, which is
    closed: "a deferral that outlived the issue it deferred to".
    """
    case_id, build, requested, what = case
    bundle = build(tmp_path / case_id)
    inputs = _staged(tmp_path, bundle)
    params = {} if requested is None else {"bin_um": requested}

    result = HF.run_entry_bytes(inputs, tmp_path / "out", params=params)
    line = _refusal_lines(result.stderr)[0].decode("ascii")
    body = line[len(PREFIX.decode()):]

    assert len(body) > 80, f"{case_id!r}'s refusal is a label, not an explanation: {body!r}"
    assert body.rstrip().endswith("."), (
        f"{case_id!r}'s refusal does not end in a sentence: {body[-120:]!r}")
    assert "#160" not in body, (
        f"{case_id!r}'s refusal points the reader at #160, which is CLOSED — that is the "
        f"exact defect #313 was filed about: {body!r}")


#: The groups of table rows that SHARE a diagnosis, and why each is correct rather than a gap.
#:
#: Named as ALLOWANCES rather than by loosening the assertion, because a loosened assertion
#: cannot tell these pairs from the next two rows that collapse by accident. Each entry has to
#: say why the SAME sentence is the right answer to two different inputs.
#:
#: * `not-a-bundle` / `standard-visium` — both are "no complete `square_NNNum` bin under this
#:   root": a directory of unrelated files and a standard Visium `outs/` differ in what they
#:   ARE, not in what this importer found. The message already names the second case's remedy
#:   ("import it with `Import Visium (Space Ranger)` instead"), so nothing a reader needs is
#:   missing.
#:
#: * `no-run-identity` / `library-id-only-whitespace` — the SAME FACT about the bundle, reached
#:   through two doors. A `library_ids` of `b"   "` is not a different problem from an absent
#:   one; it IS an absent one, and the whole defect FIX_ROUND-2 closed was that the code
#:   thought otherwise (bare truthiness let the blank through, and it died past the first
#:   writer with 51 paths on disk). A reader told "declares no `library_ids`" about a file
#:   containing three spaces has been told the truth, and the remedy is identical. Two rows
#:   exist to prove the DOOR is closed, not to demand two sentences.
#:
#: * `matrix-nonmonotonic-indptr` / `indptr-unsigned-decreasing` — likewise. The second row
#:   exists because the CHECK was dtype-blind (`np.diff` on an unsigned array cannot see a
#:   decrease), not because an unsigned decreasing offset array is a different defect from a
#:   signed one. Same file, same fault, same fix; the row is a regression test for the guard.
#:
#: * `matrix-external-link-barcodes` / `matrix-barcodes-same-file-external-link` /
#:   `matrix-external-link-barcodes-different-set` and
#:   `matrix-external-link-features-id` / `matrix-features-id-same-file-external-link` — the
#:   SAME diagnosis, reached through two doors. The #507 fix refuses an ExternalLink
#:   WHEREVER it points — to an outside file or BACK into the bundle's own file — so
#:   "'/matrix/barcodes' is an ExternalLink." is the right sentence for both. The second row
#:   of each pair exists because the realpath check alone passed the same-file spelling
#:   (same file), not because a same-file ExternalLink is a different defect from an
#:   outside-file one. The THIRD barcodes row (#476) exists because the outside file holds a
#:   DIFFERENT barcode set, so pre-fix the join fired first and blamed
#:   `tissue_positions.parquet` — the row proves the storage check now runs before the join,
#:   not that the diagnosis differs: the defect is still "'/matrix/barcodes' is an
#:   ExternalLink."
#:
#: * `matrix-data-hard-link` / `matrix-data-15-hop-softlink-chain` /
#:   `matrix-data-softlink-through-sibling-group-external-link` — likewise. All three make
#:   `/matrix/data` and `/matrix/indices` resolve to ONE object, so "'/matrix/data' and
#:   '/matrix/indices' are the SAME object." is the right sentence for all three. The second
#:   row exists because a hard link is invisible to `getlink=True` while a SoftLink chain is
#:   not, and #507 names them as two different bypass mechanisms; the third exists because
#:   the chain can detour OUTSIDE `/matrix` — through a top-level `/other_group`
#:   ExternalLink back onto `/matrix/indices` — where the structural walk never visits it,
#:   and only the alias check's direct resolution catches it. None of the three is a
#:   different defect.
#:
#: * `matrix-features-inline-dataset` / `matrix-features-softlink-to-dataset` /
#:   `matrix-features-hard-link-to-dataset` / `matrix-features-compound-dtype-dataset` —
#:   likewise (#539). All four make `/matrix/features` resolve to a DATASET instead of a
#:   Group, so "'/matrix/features' is not a group." is the right sentence for all four.
#:   The four rows exist because they reach that resolution through four doors with four
#:   MEASURED pre-fix outcomes (a non-compound Dataset -> raw `ValueError` traceback at
#:   rc 1 for the inline/SoftLink/hard-link spellings; a compound-dtype Dataset -> raw
#:   `AttributeError` traceback at rc 1 AFTER `dataset["id"]` succeeds), and the COMPOUND
#:   row is the discrimination proof that only the explicit type refusal closes the class —
#:   none of the four is a different defect.
#:
#: * `matrix-root-inline-dataset` / `matrix-root-softlink-to-dataset` /
#:   `matrix-root-hard-link-to-dataset` / `matrix-root-1d-dataset` — likewise (#585), the
#:   SAME class one level up: all four make `/matrix` itself resolve to a DATASET instead of
#:   a Group, so "'/matrix' is not a group." is the right sentence for all four. The four
#:   rows exist because they reach that resolution through four doors with three MEASURED
#:   pre-fix outcomes (2-D inline/SoftLink/hard-link -> raw `ValueError: The truth value of
#:   an array with more than one element is ambiguous` traceback at rc 1 at the membership
#:   test; 1-D -> rc 2 with the FALSE "has no `/matrix/data`" diagnosis — nothing raises,
#:   so the 1-D row is the canary for the source type-refusal: a catch-based alternative
#:   fix cannot see it), and none of the four is a different defect.
#:
#: * `matrix-root-dangling-softlink` / `matrix-root-softlink-chain-ends-nowhere` — likewise
#:   (#587). Both make `/matrix` a same-file link whose target does not resolve — the
#:   UNREADABLE-TARGET class, the second leg of the sibling's `/matrix` boundary — so
#:   "'/matrix' link exists but its target cannot be read." is the right sentence for both.
#:   The second row exists because a chain reaches the class through a different reach
#:   spelling (and defeats a check that inspects only the member's OWN link, the
#:   FIX_ROUND-2 lesson), not because a chain ending nowhere is a different defect from a
#:   one-hop link to nowhere. Neither is a different defect.
#:
#: * `matrix-root-external-link-missing-target` / `matrix-external-link-group` — likewise
#:   (#587). Both make `/matrix` an `h5py.ExternalLink`, so "'/matrix' is an ExternalLink."
#:   is the right sentence for both: `getlink=True` inspects the link WITHOUT following it,
#:   so the existing refusal fires by name regardless of whether the target file exists
#:   (MEASURED: the missing-target spelling already refused at rc 2 with this sentence on
#:   the 0.14.0 base). The new row exists to PIN the existing sentence against a fix that
#:   might start handling link targets globally — not because a missing target file is a
#:   different defect (the link class is the defect).
SHARED_DIAGNOSIS_ALLOWED = (
    {"not-a-bundle", "standard-visium"},
    {"no-run-identity", "library-id-only-whitespace"},
    {"matrix-nonmonotonic-indptr", "indptr-unsigned-decreasing"},
    {"matrix-external-link-barcodes", "matrix-barcodes-same-file-external-link",
     "matrix-external-link-barcodes-different-set"},
    {"matrix-external-link-features-id", "matrix-features-id-same-file-external-link"},
    {"matrix-data-hard-link", "matrix-data-15-hop-softlink-chain",
     "matrix-data-softlink-through-sibling-group-external-link"},
    {"matrix-features-inline-dataset", "matrix-features-softlink-to-dataset",
     "matrix-features-hard-link-to-dataset", "matrix-features-compound-dtype-dataset"},
    {"matrix-root-inline-dataset", "matrix-root-softlink-to-dataset",
     "matrix-root-hard-link-to-dataset", "matrix-root-1d-dataset"},
    {"matrix-root-dangling-softlink", "matrix-root-softlink-chain-ends-nowhere"},
    {"matrix-root-external-link-missing-target", "matrix-external-link-group"},
)


def test_TEST_9_the_refusals_are_DISTINGUISHABLE_from_one_another(tmp_path):
    """TEST-9 [acceptance, INV-9] — the table is as many refusals as it looks.

    The failure this catches is real and cheap to introduce: a single generic
    "the bundle could not be read" would pass every per-case assertion above while making the
    whole table one refusal wearing sixteen names. Comparing the messages to EACH OTHER is the
    only way to see it.

    Compared on the first sentence rather than the whole body, because several refusals
    legitimately share a closing instruction ("re-export the complete Space Ranger bundle") —
    it is the DIAGNOSIS that has to differ, not the remedy. And one PAIR legitimately shares a
    diagnosis; it is allowed by name above rather than by weakening the rule.

    The sentence is only read from a row that ACTUALLY refused: a row that escaped
    `main()` as a traceback exits 1 and its first non-progress line is
    `Traceback (most recent call last):` — one sentence every crashing row shares, so a
    whole row-set crashing together would "collide" under the shared sentence and pass this
    comparison for the wrong reason (measured: under a revert of the #539 fix all four new
    rows returned that same line). Each row must therefore exit 2 and start with a refusal,
    not a `Traceback`, before it is compared.
    """
    firsts = {}
    for case_id, build, requested, _what in HB.REFUSALS:
        bundle = build(tmp_path / case_id)
        inputs = _staged(tmp_path / case_id, bundle)
        params = {} if requested is None else {"bin_um": requested}
        result = HF.run_entry_bytes(inputs, tmp_path / f"out-{case_id}", params=params)
        assert result.returncode == 2, (
            f"{case_id} did not exit 2 — it CRASHED rather than refused (rc="
            f"{result.returncode}): {result.stderr[-2000:]!r}")
        lines = _refusal_lines(result.stderr)
        assert lines and not lines[0].startswith(b"Traceback"), (
            f"{case_id} produced a TRACEBACK instead of a named refusal (first "
            f"non-progress line {lines[0] if lines else b'<none>'!r}): "
            f"{result.stderr[-2000:]!r}")
        body = lines[0].decode("ascii")[len(PREFIX.decode()):]
        firsts[case_id] = re.split(r"(?<=[.?!])\s", body, maxsplit=1)[0]

    collisions = {}
    for case_id, sentence in firsts.items():
        collisions.setdefault(sentence, []).append(case_id)
    duplicated = {s: set(ids) for s, ids in collisions.items() if len(ids) > 1}
    unexpected = {s: ids for s, ids in duplicated.items()
                  if ids not in SHARED_DIAGNOSIS_ALLOWED}
    assert not unexpected, (
        "these refusals share a diagnosis, so the table is fewer refusals than it looks:\n" +
        "\n".join(f"  {sorted(ids)} -> {s[:160]!r}" for s, ids in unexpected.items()))
    # …and the ALLOWANCE is not a licence: the pair it names must still really collapse, or the
    # allowance is stale and is quietly excusing a different collision.
    for allowed in SHARED_DIAGNOSIS_ALLOWED:
        assert allowed in duplicated.values(), (
            f"{sorted(allowed)} no longer share a diagnosis; the allowance above is stale and "
            "should be removed rather than left to excuse a future collision")


def test_TEST_9_a_hostile_vendor_value_does_not_GROW_the_message(tmp_path):
    """TEST-9 [acceptance, INV-9] — the bound is on the MESSAGE, not on each interpolation.

    The measurement that made the sequence funnel necessary on the sibling side: bounding each
    element to 120 units still leaves 60 x 120 = 7,200 characters, and an h5 can carry far
    more members than a CSV can carry columns. So the assertion is a RATIO — feed the same
    refusal a value ten times larger and the message must grow by at most the decimal digits
    of the stated length, which is logarithmic and in practice a handful of bytes.
    """
    import pyarrow as pa
    import pyarrow.parquet as pq

    def bundle_with_column_names(tmp, width, count):
        root = HF.staged_tree(tmp)
        rows = HB.MF.positions_rows(8)
        columns = {f"c{i}{'z' * width}": pa.array([0] * len(rows), pa.int32())
                   for i in range(count)}
        pq.write_table(pa.table(columns),
                       HB._bin_dir(root, 8) / "spatial" / "tissue_positions.parquet")
        return root

    # The COLUMN COUNT is held constant and only the WIDTH varies. Varying both would confound
    # the two bounds: below `_REFUSAL_QUOTE_ITEMS` the message really does grow by one item per
    # column, which is correct and is not what this test is about. What must not grow is the
    # message's response to a bigger VALUE.
    sizes = []
    for label, width in (("small", 200), ("large", 20_000)):
        bundle = bundle_with_column_names(tmp_path / label, width, 60)
        inputs = _staged(tmp_path / label, bundle)
        result = HF.run_entry_bytes(inputs, tmp_path / f"out-{label}")
        assert result.returncode == 2, result.stderr[:2000]
        sizes.append(len(_refusal_lines(result.stderr)[0]))

    small, large = sizes
    # Each column name grew 100x — 12,000 characters to 1,200,000 across the table — and the
    # message may grow only by the DECIMAL DIGITS of the true lengths it states: at most
    # `_REFUSAL_QUOTE_ITEMS` (8) quoted names x a few digits each. 64 bytes is generous for
    # that and nowhere near proportional.
    assert large - small <= 64, (
        f"the refusal grew from {small} to {large} bytes when each vendor column name grew "
        "100x -- the bound is on each interpolation rather than on the message, which is the "
        "flood the sequence funnel exists to prevent")


def test_TEST_9_the_positive_control_a_GOOD_bundle_exits_0_with_no_refusal(tmp_path):
    """TEST-9 [acceptance, INV-9] — without this, "everything exits 2" would also pass.

    The same driver, the same staging, the committed fixture: rc 0, no refusal line, and a
    manifest on disk. A suite in which every input refuses is a suite that proves the importer
    refuses everything.
    """
    inputs, _ordinals = HF.staged_flat(tmp_path)
    result = HF.run_entry_bytes(inputs, tmp_path / "out")
    assert result.returncode == 0, result.stderr[-3000:]
    assert _refusal_lines(result.stderr) == []
    assert (tmp_path / "out" / "manifest.json").is_file()


def test_TEST_44_LEGITIMATE_non_ascii_and_an_ASTRAL_character_still_IMPORT(tmp_path):
    """TEST-44 [acceptance, INV-9] — the control that stops the guard becoming "refuse non-ASCII".

    `docs/design/vendor-text-encodability-refusal.md` §6.5 INV-6:

    > Legitimate non-ASCII vendor text — including an ASTRAL character — still IMPORTS and
    > round-trips to the artifacts. The guard tests the ENCODE, so it can never become
    > "refuse anything that is not ASCII".

    This package vendored the guard, the refusals and the invariant list, and did NOT vendor
    the sibling's control (`spatial-import-visium/tests/test_hostile_vendor_text.py::
    test_TEST_7_legitimate_non_ascii_and_an_ASTRAL_character_still_IMPORT`, whose own docstring
    says "without this test the guard could be 'reject anything that is not ASCII' and every
    other assertion in this file would still pass"). MEASURED: narrowing any ONE of this
    module's three text doors from UTF-8 to ASCII —

      * `import_visium_hd.py`'s `str` arm (`node.encode("utf-8")`),
      * its `bytes` arm (`bytes(node).decode("utf-8")`),
      * the join-key decode in `decoded_h5_strings` (`value.decode()`),

    — left the ENTIRE package suite green, while a legitimate bundle was refused at exit 2
    with a message that FALSELY calls its text "a LONE SURROGATE: half of a character".
    A wrong statement about a good bundle is the worst outcome INV-9 has, and nothing saw it.

    Two things a real vendor file can legitimately carry:

    * ordinary non-ASCII (`µ`, `ä`) — encodable, and already reaching the artifacts through
      `ensure_ascii=False` in the declaration mirror;
    * an ASTRAL character, which in a JSON file is written as a surrogate PAIR escape
      (`"\\ud83e\\uddec"`). `json.loads` assembles the pair into the single codepoint U+1F9EC
      before any guard sees it, and that encodes to UTF-8 perfectly. The astral leg is why the
      guard tests the ENCODE: a `U+D800..U+DFFF` scan over the assembled `str` would accept it
      too, so a range check is not wrong for that reason — it is wrong because it cannot see
      the BYTES arm at all.

    `library_ids` is exercised DELIBERATELY and not only `software_version`: it is the one
    vendor string that reaches the coordinate store's own `zarr.json`, through
    `coordinate_space_id` and `SD.section(sample_id=…)`. A control that only reached the report
    would leave the crossing-the-writer path unproven.
    """
    import json

    import h5py
    import numpy as np
    import pyarrow as pa
    import pyarrow.parquet as pq

    legit_library = "Bulb \U0001f9ec µm Gewächs"
    legit_symbol = "Gewächs-µ1"
    #: Appended to EVERY barcode, on both sides of the join. A 10x barcode is ASCII in
    #: practice, and that is exactly why the arm went untested: the invariant is that the
    #: guard tests the ENCODE, so any encodable key must pass -- not that every key a real
    #: vendor ships happens to be ASCII.
    BARCODE_SUFFIX = "µ"
    root = HF.staged_tree(tmp_path)
    bin_dir = Path(root) / "binned_outputs" / "square_008um"

    # DOOR 1 -- the `str` arm of the encodability guard, through the scale document.
    scale_path = bin_dir / "spatial" / "scalefactors_json.json"
    doc = json.loads(scale_path.read_text(encoding="utf-8"))
    doc["vendor_note"] = "run \U0001f9ec µm"
    scale_path.write_text(json.dumps(doc), encoding="utf-8")
    assert b"\\ud83e\\uddec" in scale_path.read_bytes(), (
        "the astral character must reach the reader as a surrogate PAIR escape, which is what "
        "`json.dumps` writes by default -- otherwise this test is about a plain UTF-8 file")

    h5_path = bin_dir / "filtered_feature_bc_matrix.h5"
    with h5py.File(h5_path, "r+") as handle:
        # DOOR 1 again, on the string that reaches the STORE: a UTF-8-typed attribute comes
        # back from h5py as `str`.
        handle.attrs.create("library_ids", legit_library,
                            dtype=h5py.string_dtype("utf-8"))
        # DOOR 2 -- the `bytes` arm. A FIXED-LENGTH `|S` attribute comes back as raw `bytes`,
        # which is the shape a real bundle uses and the one a codepoint scan cannot see at all.
        handle.attrs.create("software_version",
                            np.bytes_("spaceranger-3.1.0 µm Gewächs".encode("utf-8")))
        # DOOR 3 -- `decoded_h5_strings`, which decodes the barcodes AND both feature columns.
        # A gene SYMBOL is the legitimate non-ASCII case here (older references really do carry
        # Greek and accented characters); it is also emitted, so the round-trip is checkable.
        names = list(handle["matrix/features/name"][:])
        names[0] = legit_symbol.encode("utf-8")
        del handle["matrix/features/name"]
        handle["matrix/features"].create_dataset("name", data=np.array(names))
        # DOOR 3 again, on the JOIN KEY itself, and it is the same door on BOTH sides of the
        # join: the h5 barcodes here and the parquet barcodes below must carry the SAME
        # non-ASCII bytes or the join fails for a reason that has nothing to do with encoding.
        h5_barcodes = [b + BARCODE_SUFFIX.encode("utf-8")
                       for b in list(handle["matrix/barcodes"][:])]
        del handle["matrix/barcodes"]
        handle["matrix"].create_dataset("barcodes", data=np.array(h5_barcodes))

    # DOOR 4 -- the parquet `barcode` BINARY arm, which decodes the join key itself. The
    # committed fixture writes that column as `string`, so this arm is exercised by nothing
    # unless the column is rewritten as `binary` here.
    pos_path = bin_dir / "spatial" / "tissue_positions.parquet"
    table = pq.read_table(pos_path)
    barcodes = [(b + BARCODE_SUFFIX).encode("utf-8")
                for b in table.column("barcode").to_pylist()]
    table = table.set_column(table.schema.get_field_index("barcode"), "barcode",
                             pa.array(barcodes, pa.binary()))
    pq.write_table(table, pos_path, row_group_size=64)
    assert pa.types.is_binary(pq.read_table(pos_path).column("barcode").type), (
        "the barcode column must be BINARY for door 4 to be exercised at all")

    inputs, _ordinals = HF.staged_flat(tmp_path / "flat", root)
    result = HF.run_entry(inputs, tmp_path / "out")
    assert result.returncode == 0, (
        "a bundle carrying LEGITIMATE non-ASCII vendor text was refused, which is the guard "
        f"having become 'refuse anything that is not ASCII':\n{result.stderr[-1500:]}")
    assert _refusal_lines(result.stderr.encode("utf-8", "surrogatepass")) == []

    report = json.loads((tmp_path / "out" / "visium-hd-import-report.json").read_text(
        encoding="utf-8"))
    assert report["provenance"]["pipeline"] == "spaceranger-3.1.0 µm Gewächs", (
        report["provenance"])
    assert report["provenance"]["library_id"] == legit_library, report["provenance"]
    assert report["scalefactors"]["vendor_note"] == "run \U0001f9ec µm", (
        report["scalefactors"])

    # AND IT SURVIVED INTO THE STORES' OWN BYTES -- the writes that cross the first writer and
    # are validated by the VENDORED declaration contract, not merely into the report.
    stamped = (tmp_path / "out" / "spatial" / "coordinates.zarr" / "zarr.json").read_text(
        encoding="utf-8")
    assert f"visium-hd:library_id:{legit_library}" in stamped, stamped
    assert "Gewächs" in stamped and "\U0001f9ec" in stamped
    symbols = HF.read_column(tmp_path / "out", "axis/gene_symbol.zarr")
    assert legit_symbol in [str(v) for v in symbols], (
        f"the non-ASCII gene symbol did not round-trip to the emitted column: "
        f"{[str(v) for v in symbols][:4]}")


def test_TEST_9_a_WRONG_SHAPED_indptr_is_told_its_SHAPE_not_its_count(tmp_path):
    """TEST-9 [acceptance, INV-9] — "never a traceback" is not the whole of the invariant.

    INV-9 asks for a line a human can ACT on. A `(53, 1)` `/matrix/indptr` has ndim 2 and
    `size` 53, and the single pre-repair guard reported only the ENTRY COUNT:

        `/matrix/indptr` has 53 entries; a CSC matrix over 52 barcodes has exactly 53.

    Literally true, and it leaves the reader believing the importer cannot count. The refusal
    table alone cannot see this: its sweep asserts that SOME refusal fires at exit 2 in one
    ASCII line ending in a period, which the contradictory message satisfies in full. MEASURED
    at FIX_ROUND-4's own re-audit — reverting the production split left the entire table green.

    So the message is asserted here, by content: it must name the DIMENSIONALITY and the
    SHAPE, and it must not be the count sentence, whose two numbers a reader can read as equal.
    """
    root = HB.a_matrix_whose_INDPTR_IS_TWO_DIMENSIONAL(tmp_path)
    inputs, _ordinals = HF.staged_flat(tmp_path / "flat", root)
    result = HF.run_entry(inputs, tmp_path / "out")

    assert result.returncode == 2, result.stderr[-1500:]
    line = result.stderr.strip().splitlines()[-1]
    assert "2-dimensional" in line and "(53, 1)" in line, (
        "the refusal for a wrong-SHAPED `indptr` does not name its shape, so the reader is "
        f"told a fact that is not the defect: {line!r}")
    assert "has exactly" not in line, (
        "the refusal fell back to the ENTRY-COUNT sentence, whose two numbers are equal on "
        f"this input -- a statement a reader cannot act on: {line!r}")


def test_TEST_9_the_CONTROL_a_RIGHT_shaped_indptr_of_the_wrong_LENGTH_is_told_its_count(tmp_path):
    """TEST-9 — the other half of the split, without which the assertion above is one-sided.

    A 1-D `indptr` of the wrong length is a COUNT defect and must still get the count
    sentence. Asserting only the shape message would be satisfied by a guard that reports the
    shape for everything, which is the same defect facing the other way.
    """
    import h5py
    import numpy as np

    root = HF.staged_tree(tmp_path)
    with h5py.File(HB._bin_dir(root, 8) / "filtered_feature_bc_matrix.h5", "r+") as h5:
        indptr = np.asarray(h5["matrix/indptr"][:])
        del h5["matrix/indptr"]
        h5["matrix"].create_dataset("indptr", data=indptr[:-1])

    inputs, _ordinals = HF.staged_flat(tmp_path / "flat", root)
    result = HF.run_entry(inputs, tmp_path / "out")

    assert result.returncode == 2, result.stderr[-1500:]
    line = result.stderr.strip().splitlines()[-1]
    assert "has 52 entries" in line and "has exactly 53" in line, (
        f"a 1-D `indptr` of the wrong LENGTH was not told its count: {line!r}")
    assert "dimensional" not in line, (
        f"a count defect was reported as a shape defect: {line!r}")
