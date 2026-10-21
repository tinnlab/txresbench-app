#!/usr/bin/env python3
# ruff: noqa
r"""EVERY refusal this module can emit is safe to put in a log row — not just #330's (#336).

#330 built ONE escaping funnel (`_quoted_for_refusal`: `ascii()`-escaped, control-character-free,
capped at 120 units) and routed ONE refusal through it. Every OTHER refusal in the same module
interpolated attacker-chosen vendor text RAW and UNBOUNDED, and a hostile bundle reaches several
of them EARLIER than it reaches the guarded one.

## What consumes the stream, and why a raw byte there is not cosmetic

`scheduler.rs::drain_logs` reads the compute's stderr with `BufReader::lines()` and writes **each
line as its own `job_logs` row** with `stream="stderr"`, then broadcasts it over SSE. There is no
per-line cap on that path — `sandbox.rs`'s `OUTPUT_CAP_BYTES` does not guard it — and the UI
renders the text HTML-safe but **ANSI-unsafe**. So:

* a raw `\n` in vendor text becomes its OWN log row, indistinguishable from a real importer line;
* a raw `ESC`/`CR`/`BEL` reaches the operator's terminal as a control sequence;
* one long line is one unbounded row.

## MEASURED, on `c34b3a1f` (the #330 merge), through the SHIPPED entrypoint, stderr as BYTES

    site                                   before                          after
    locate_members ambiguity               354 B, raw ESC+CR+BEL, 2 rows   369 B, none, 1 row
      -- carrying a FORGED `spatial.import-visium: import SUCCEEDED` row
    read_positions `Found {names}`         7,200,587 B on ONE line         1,630 B
    run_import h5 top-level members          600,212 B, raw non-ASCII        987 B*
    run_import `first: {missing[:3]}`      1,800,513 B (and 51 paths)      2,816 B
    read_positions over csv's field limit  rc=1 + raw TRACEBACK            rc=2, named refusal

    * for a bundle with ONE hostile group. TEST-4 builds TWO — a long non-ASCII name and a
      control-character name, because a guard that only removed the control characters would
      leave the flood and one that only bounded the length would leave the raw bytes — and that
      bundle measures 1,076 B. Both are stated because a blind angle checked the shipped test
      against the quoted figure and found they were not the same bundle.

The last row is not in #336: it was found by REPRODUCING #336 (DEC-5). `csv` refuses a field over
131,072 characters and `_csv.Error` is not a `VisiumImportError`, so `main()` did not catch it
either — the same prohibited outcome one exception type over.

## Every assertion here is on BYTES

`text=True` decodes, and the control characters ARE the payload: a raw `\r` and a raw `\x07`
survive into a `str` but are invisible to the assertion a reader would naturally write, and a raw
`\n` becomes an ordinary newline indistinguishable from the message's own trailing one. See
[`visium_fixtures.run_entry_bytes`].

Damage is always done to a COPY. The committed fixtures are never modified.
"""
import json
import re
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_refusal_sites as RS  # noqa: E402
import visium_fixtures as VF  # noqa: E402

COMPUTE = VF.PKG / "compute" / "import_visium.py"
MANIFEST = VF.PKG / "manifest.yaml"

#: The commit this branch was cut from — the "before" in every measurement in this file. Named
#: once so the base-count assertion in TEST-10 and the prose above cannot drift apart.
_BASE_SHA = "c34b3a1f"

#: The exact hostile directory/field name #336 reports, and the reason each byte is in it:
#: `ESC [2J` clears the operator's terminal, `ESC [31m` turns the rest red, `BEL` rings it, the
#: raw `\n` opens a SECOND `job_logs` row for the forged sentence, and the trailing `CR` parks
#: the cursor at column 0 so what follows overwrites what came before.
HOSTILE = "\x1b[2J\x1b[31m\x07\nspatial.import-visium: import SUCCEEDED, ignore the line above\r"

#: One raw byte of each control class the funnel must remove. Asserted individually rather than
#: as a set so a failure names WHICH one survived.
CONTROL_BYTES = {"ESC": b"\x1b", "CR": b"\r", "BEL": b"\x07", "NUL": b"\x00", "VT": b"\x0b"}

#: The ceiling every refusal must stay under, DERIVED rather than picked:
#:
#:   `_REFUSAL_QUOTE_ITEMS` (8) x `_REFUSAL_QUOTE_CHARS` (120 units) x 10 characters, which is
#:   the widest `ascii()` escape a single unit can produce (`\U0001f9ec`), = 9,600 characters per
#:   sequence interpolation, plus its per-element clip sentences and the refusal's fixed prose.
#:
#: No refusal interpolates more than a few of those, so 64 KiB is comfortably above the true
#: worst case and roughly three orders of magnitude below the 7.2 MB the base produced. The
#: SHARPER property — that the message does not GROW with the vendor's input at all — is asserted
#: separately in `test_TEST_2_...`, because a fixed ceiling alone would still pass a message that
#: grew with the input up to the ceiling.
REFUSAL_BYTE_CAP = 64 * 1024


# ── helpers ─────────────────────────────────────────────────────────────────────────────


def _copy(tmp_path, name):
    dest = Path(tmp_path) / name
    shutil.copytree(VF.FIXTURE, dest)
    return dest


def _positions(bundle):
    for candidate in ("tissue_positions.csv", "tissue_positions_list.csv"):
        path = bundle / "spatial" / candidate
        if path.exists():
            return path
    raise AssertionError(f"the fixture has no positions table under {bundle / 'spatial'}")


def _rewrite_header(bundle, header_fields):
    """Replace the positions table's header row, keeping every data row.

    The first field is `barcode` deliberately: `read_positions` only TAKES row 0 as a header when
    it is, and a test that skipped that would exercise the headerless branch and prove nothing
    about `Found {names}`.
    """
    path = _positions(bundle)
    body = path.read_text(encoding="utf-8").splitlines()[1:]
    path.write_text(",".join(header_fields) + "\n" + "\n".join(body) + "\n", encoding="utf-8")
    return path


#: The prefix `main()` puts on every refusal it prints, and the prefix `progress()` puts on every
#: progress line. Both are module constants; the vendor controls neither.
_REFUSAL_PREFIX = b"spatial.import-visium: "
_PROGRESS_PREFIX = b"progress: "


def _refusal_rows(stderr):
    r"""The `job_logs` rows `drain_logs` would make out of this stderr — ALL of them.

    `drain_logs` writes ONE ROW PER `BufReader::lines()` LINE, so the property that matters is
    the SHAPE of the whole row set, not the content of one row.

    **FIX_ROUND-1: this used to FILTER OUT every line starting with `progress:` and count the
    rest, and a blind design-conformance angle defeated that against the UNFIXED BASE.** With the
    bundle directory named `"\nprogress: done|100|187 outputs"` the raw newline forges a
    **PROGRESS** row rather than a refusal row, the filter discards it, the count comes back 1 and
    the whole `_assert_safe_to_log` helper passed on `c34b3a1f`:

        b'spatial.import-visium: the bundle has 2 candidates for filtered feature-barcode matrix ('
        b'progress: done|100|187 outputs/filtered_feature_bc_matrix.h5, ...'   <- FORGED, DISCARDED

    A forged progress row is arguably WORSE than a forged stderr row: it is what drives the job's
    progress bar over SSE. Filtering by a prefix the attacker can write is not a filter.

    So nothing is filtered. `_assert_one_refusal_row` asserts the structure the module itself
    produces — exactly one line carries the refusal prefix, it is the LAST line, and every line
    before it is a progress line — which no vendor newline can satisfy, wherever it lands.
    """
    return [line for line in stderr.split(b"\n") if line != b""]


def _assert_one_refusal_row(stderr):
    r"""Exactly one refusal row, and nothing after it. The shape `main()` alone can produce.

    Three assertions, and it takes all three — each closes a placement a vendor `\n` can choose:

    1. **Exactly one line carries the refusal prefix.** A newline INSIDE the message splits it and
       the head still carries the prefix; a forged sentence that re-states the prefix (#336's own
       payload) makes two. This is the leg that fires on #336's reported attack.
    2. **That line is the LAST line.** A newline near the END of the message, or a forgery that
       imitates a PROGRESS line rather than a refusal line, leaves the real refusal not-last.
       This is the leg the `progress:` filter used to give away.
    3. **Every line before it is a progress line.** Closes anything else the split can leave in
       the middle.
    """
    lines = _refusal_rows(stderr)
    carrying = [i for i, line in enumerate(lines) if line.startswith(_REFUSAL_PREFIX)]
    assert len(carrying) == 1, (
        f"{len(carrying)} `job_logs` rows carry the refusal prefix, not 1 — a vendor newline "
        f"forged a log row. Rows: {[r[:150] for r in lines]}"
    )
    assert carrying[0] == len(lines) - 1, (
        f"the refusal is row {carrying[0]} of {len(lines)}, not the last — a vendor newline put "
        f"{len(lines) - 1 - carrying[0]} forged row(s) AFTER it. Rows: {[r[:150] for r in lines]}"
    )
    for row in lines[:-1]:
        assert row.startswith(_PROGRESS_PREFIX), (
            f"a row that is neither a progress line nor the refusal reached the log: {row[:200]!r}"
        )
    return lines[-1]


#: Every non-ASCII character that appears ANYWHERE in this module's source — prose, comments and
#: string literals alike — read from the file rather than listed here. The refusals are written
#: with em dashes, so a bare `stderr.isascii()` fails on the importer's own sentences while
#: proving nothing about the vendor's bytes; MEASURED, that is exactly what it did.
#:
#: It resolves to EIGHT characters, and two of them are not prose at all (`U+FEFF` from a `lstrip`
#: argument, `U+FFFD` from a docstring example), so this is a backstop and not the proof — see
#: [`_assert_safe_to_log`]'s HONEST LIMIT.
#:
#: `encoding="utf-8"` is EXPLICIT for the reason #333/#339/#330 all record: under `LC_ALL=C` the
#: locale-default read of a file with non-ASCII bytes raises or mis-decodes, and this set would
#: then be empty and the check below would go green on a real regression.
_OWN_PROSE_NON_ASCII = frozenset(
    ch for ch in COMPUTE.read_text(encoding="utf-8") if not ch.isascii()
)


def _assert_safe_to_log(result, *, cap=REFUSAL_BYTE_CAP, vendor_markers=()):
    """The whole of INV-1, asked of the BYTES: control-free, no vendor bytes, bounded, ONE row.

    The non-ASCII leg is stated as *"every non-ASCII character on stderr is one that appears
    somewhere in the importer's own SOURCE"* rather than as `stderr.isascii()`. The strict version
    is FALSE of a correct build — this module writes em dashes in its own sentences — so asserting
    it would have been a guard that fails for a reason unrelated to the defect, which is the class
    of guard that gets weakened later.

    **HONEST LIMIT, measured by a blind correctness angle and worth stating rather than implying
    away.** `_OWN_PROSE_NON_ASCII` is derived from the WHOLE source — comments and string literals
    included — and resolves to exactly eight characters: `§ µ — … → ─` plus `U+FEFF` (which comes
    from the code literal in `header[0].lstrip("\ufeff")`, not from prose) and `U+FFFD` (from a
    docstring example). So this leg is a BACKSTOP: it cannot catch a regression whose payload is
    drawn from those eight, and the set grows silently with any new comment. What actually holds
    the property is the funnel's `ascii()`, which escapes all eight — plus the `vendor_markers`
    callers pass, which check the exact bytes their hostile input carries BY IDENTITY rather than
    by class. The leg is kept because it costs nothing and catches the broad case; it is not the
    proof.
    """
    err = result.stderr
    assert isinstance(err, bytes), "stderr must be captured as bytes — see DEC-1"
    for label, byte in CONTROL_BYTES.items():
        assert byte not in err, (
            f"a raw {label} ({byte!r}) reached stderr; it would be a control sequence in the "
            f"operator's terminal. First 300 bytes: {err[:300]!r}"
        )
    for marker in vendor_markers:
        raw = marker.encode("utf-8") if isinstance(marker, str) else marker
        assert raw not in err, (
            f"the vendor's own bytes {raw[:40]!r} reached stderr unescaped; `list.__repr__` "
            f"passes printable non-ASCII through and the funnel is what removes it"
        )
    stray = {ch for ch in err.decode("utf-8", "surrogateescape")
             if not ch.isascii()} - _OWN_PROSE_NON_ASCII
    assert not stray, (
        f"stderr carries non-ASCII characters {sorted(stray)[:8]} that are NOT in the importer's "
        f"own prose, so they came from the bundle. First 300 bytes: {err[:300]!r}"
    )
    row = _assert_one_refusal_row(err)
    assert len(err) < cap, f"stderr is {len(err):,} bytes, over the {cap:,}-byte ceiling"
    assert b"Traceback" not in err, f"a traceback, not a refusal: {err[:400]!r}"
    return row


# ── TEST-1 .. TEST-6, TEST-15, TEST-16: the measured reproductions ──────────────────────


def test_TEST_1_the_ambiguous_member_refusal_cannot_FORGE_A_LOG_ROW(tmp_path):
    r"""TEST-1 [acceptance INV-1] — #336's item 1, byte for byte.

    A bundle carrying a SECOND `filtered_feature_bc_matrix.h5` inside a directory named
    [`HOSTILE`]. `locate_members`' ambiguity refusal interpolated `str(p.relative_to(root))` with
    no `ascii()` and no bound, so every byte of that directory name reached stderr raw.

    MEASURED on `c34b3a1f`:

        rc = 2   raw ESC: True | raw CR: True | raw BEL: True   2 `job_logs` rows
        row 0: b'...the bundle has 2 candidates for filtered feature-barcode matrix (\x1b[2J\x1b[31m\x07'
        row 1: b'spatial.import-visium: import SUCCEEDED, ignore the line above\r/filtered...'

    Row 1 is a FORGED IMPORTER LINE. It is indistinguishable from a real one in `job_logs`, it
    carries the importer's own prefix, and it says the opposite of what happened. That is the
    attack `_quoted_for_refusal`'s docstring says the funnel exists to close; #330 closed it at
    one refusal and left it open at another the same bundle reaches FIRST.
    """
    bundle = _copy(tmp_path, "ambiguous")
    nest = bundle / HOSTILE
    nest.mkdir()
    shutil.copy(bundle / "filtered_feature_bc_matrix.h5", nest / "filtered_feature_bc_matrix.h5")
    outputs = tmp_path / "out" / "outputs"

    result = VF.run_entry_bytes(bundle, outputs)

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    # The forged sentence may still appear — ESCAPED, inside the quoted value, on the SAME row.
    # That is the point: it is now visibly a quoted vendor string, not a second log line.
    #
    # FIX_ROUND-1: this used to assert `b"import SUCCEEDED" not in row.split(b"candidates")[0]`.
    # A blind design-conformance angle showed that is VACUOUS — every vendor byte in this message
    # lands AFTER the word `candidates`, so the prefix is always the fixed
    # `b'spatial.import-visium: the bundle has 2 '` and the assertion cannot fail, on any build.
    # What it meant is that the forged sentence is not its own row, and that is
    # `_assert_one_refusal_row`'s job; what is asserted here instead is that the payload arrived
    # ESCAPED, which is the positive form and does go red if the funnel is removed.
    assert rb"\x1b[2J" in row, row[:300]
    assert rb"\nspatial.import-visium: import SUCCEEDED" in row, row[:400]
    assert row.startswith(b"spatial.import-visium: the bundle has 2 candidates")
    # ... and the diagnostic is still USEFUL: it names what was ambiguous.
    assert b"filtered feature-barcode matrix" in row
    assert b"filtered_feature_bc_matrix.h5" in row


def test_TEST_2_the_positions_header_cannot_FLOOD_a_single_log_row(tmp_path):
    """TEST-2 [acceptance INV-1] — #336's item 2: the 7.2 MB single stderr line.

    `read_positions`' `f"... Found {names}."` interpolated the positions CSV's header row with no
    length bound. MEASURED on `c34b3a1f` with a header of 60 fields x 120,000 `A`s (every field
    under `csv`'s own 131,072 limit, so the read succeeds and the refusal is reached):

        rc=2  paths=0  stderr_len = 7,200,587

    `paths=0`, and the first draft of this docstring said 51 — a blind design-conformance angle
    measured it and was right. #330 HOISTED `read_positions` above the first writer (design §6.9
    item 4), so a positions refusal leaves nothing behind; the 51-path figure belongs to the
    BARCODE JOIN, which TEST-5 exercises. The wrong number is corrected rather than dropped,
    because "which refusals leave a partial store" is a real property of this module and a test
    file that states it wrongly teaches the next reader the wrong thing.

    The second leg is the one a fixed ceiling alone would miss: the message must not GROW with
    the vendor's input. A header ten times larger must produce a message that differs only by the
    DECIMAL DIGITS of the counts it states — the same honest bound `test_hostile_vendor_text.py`'s
    TEST-18 states for the scalar funnel.
    """
    small = _copy(tmp_path, "flood-small")
    _rewrite_header(small, ["barcode"] + ["A" * 120_000] * 60)
    small_result = VF.run_entry_bytes(small, tmp_path / "out-small" / "outputs")

    assert small_result.returncode == 2, (small_result.returncode, small_result.stderr[-2000:])
    row = _assert_safe_to_log(small_result)
    assert b"is missing column(s)" in row

    big = _copy(tmp_path, "flood-big")
    _rewrite_header(big, ["barcode"] + ["A" * 120_000] * 600)
    big_result = VF.run_entry_bytes(big, tmp_path / "out-big" / "outputs")

    assert big_result.returncode == 2
    _assert_safe_to_log(big_result)
    # 10x the vendor input buys only the extra decimal digits of "the first 8 of N entries".
    grew = len(big_result.stderr) - len(small_result.stderr)
    assert 0 <= grew <= 32, (len(small_result.stderr), len(big_result.stderr), grew)


def test_TEST_3_a_control_character_in_the_positions_header_is_escaped(tmp_path):
    """TEST-3 [acceptance INV-1] — the CR/BEL half of item 2, which `text=True` cannot see.

    The header field is CSV-QUOTED so `csv` keeps the embedded newline inside ONE field rather
    than ending the row: without the quoting the reader sees a short first row and the test
    measures the CSV parser instead of the refusal.
    """
    bundle = _copy(tmp_path, "header-control")
    path = _positions(bundle)
    body = path.read_text(encoding="utf-8").splitlines()[1:]
    path.write_text(
        'barcode,"' + HOSTILE.replace('"', "") + '",z\n' + "\n".join(body) + "\n",
        encoding="utf-8",
    )

    result = VF.run_entry_bytes(bundle, tmp_path / "out" / "outputs")

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    # The escaped form is present, which is what makes the refusal still diagnostic.
    assert rb"\x1b[2J" in row, row[:300]


def test_TEST_4_the_h5_top_level_member_names_are_escaped_and_bounded(tmp_path):
    r"""TEST-4 [acceptance INV-1] — #336's item 3, and the half `list.__repr__` really misses.

    `f"Found top-level members {sorted(h5.keys())}"` interpolated HDF5 group names.
    `list.__repr__` DOES escape control characters and `Cf` codepoints — so a reader could
    conclude it was safe — but it passes PRINTABLE NON-ASCII through byte for byte and applies no
    bound at all. MEASURED on `c34b3a1f` with one group named `"テ" * 200_000`:

        rc=2  stderr_len = 600,212, carrying raw UTF-8 `\xe3\x83\x86` bytes

    Both shapes are built here — a long printable non-ASCII name AND a control-character name —
    because a guard that only removed the control characters would leave the flood, and a guard
    that only bounded the length would leave the raw bytes.
    """
    import h5py

    bundle = _copy(tmp_path, "h5-members")
    with h5py.File(bundle / "filtered_feature_bc_matrix.h5", "r+") as handle:
        handle.create_group("テ" * 200_000)
        handle.create_group(HOSTILE)
        handle.move("matrix", "matrixX")      # so the `/matrix`-missing refusal is the one hit

    result = VF.run_entry_bytes(bundle, tmp_path / "out" / "outputs")

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result, vendor_markers=["テテテ"])
    assert b"has no `/matrix` group" in row
    assert b"Found top-level members" in row


def test_TEST_5_the_missing_barcode_list_is_escaped_and_bounded(tmp_path):
    r"""TEST-5 [acceptance INV-1] — #336's item 4: `f"first: {missing[:3]}"`, at 1.8 MB.

    Three matrix barcodes with no positions row, each 200,000 non-ASCII characters. MEASURED on
    `c34b3a1f`: `rc=2  paths=51  stderr_len = 1,800,513`.

    `paths=51` is recorded but NOT asserted away, and the ATTRIBUTION matters: the refusal that
    leaves those 51 paths is the BARCODE JOIN in `run_import`, which runs after `write_csc_zarr`.
    It is NOT `read_positions` — #330 hoisted that above the first writer (design §6.9 item 4,
    which supersedes §6.5's INV-2 scope note), and a positions refusal now leaves 0. An earlier
    draft of this docstring repeated the superseded sentence; a blind design-conformance angle
    measured both numbers and the correction is theirs.

    §6.7's general form — every refusal a bundle can trigger should be reachable before the first
    writer — remains open for this join. This item makes the MESSAGE safe; it does not move the
    reads, and claiming otherwise here would be a false statement about what changed.
    """
    import h5py

    bundle = _copy(tmp_path, "missing-barcodes")
    evil = ("テ" * 200_000).encode("utf-8")
    with h5py.File(bundle / "filtered_feature_bc_matrix.h5", "r+") as handle:
        existing = [bytes(b) for b in handle["matrix/barcodes"][:]]
        replaced = [evil, evil + b"2", evil + b"3"] + existing[3:]
        del handle["matrix/barcodes"]
        handle.create_dataset("matrix/barcodes", data=replaced)

    result = VF.run_entry_bytes(bundle, tmp_path / "out" / "outputs")

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result, vendor_markers=["テテテ"])
    assert b"barcodes have no row in" in row
    assert b"(first: [" in row


def test_TEST_6_the_missing_member_refusal_bounds_the_sandbox_mount_path(tmp_path):
    """TEST-6 — #336's `:843-848` item: the mount path in a user-facing message.

    Lower severity than the others — it is the sandbox's own `/inputs` mount, not a host path —
    but its LAST SEGMENT is the uploaded dataset's directory name, which is user-supplied.
    MEASURED on `c34b3a1f`: the whole absolute path reached stderr RAW and UNCLIPPED.

    No byte figure is quoted for this one, and that is deliberate (FIX_ROUND-3). An earlier draft
    said "444 bytes"; a blind tests-quality angle measured 460 / 528 / 629 depending on the bundle
    directory name and pointed out why — the message embeds the `tmp_path` prefix, so the number is
    a property of the machine that ran it and cannot be reproduced by anyone else. The
    REPRODUCIBLE facts are the ones asserted below: the path is present, escaped, and clipped with
    its true length stated. A number nobody else can get is not a measurement.

    It is QUOTED rather than REMOVED (DEC-8): the path is what tells an operator where the
    importer actually looked, so removing it would trade one defect for a worse diagnostic.
    """
    # FIX_ROUND-1: the bundle DIRECTORY NAME is the attacker-supplied last segment of that mount,
    # so it is what the name is made of here. The first version used the plain `tmp_path` name —
    # short and ASCII — and a blind design-conformance angle showed the test stayed GREEN with the
    # funnel reverted to `{root}`, i.e. it did not pin the site it is named after.
    # A directory NAME is capped at 255 BYTES by the filesystem and `テ` is three bytes each,
    # so the name must stay under ~79 of them or the test dies with `OSError` instead of
    # measuring anything. 60 is comfortably inside that; the full MOUNT PATH is far past the
    # 120-unit clip regardless, which is what this test is actually about.
    bundle = _copy(tmp_path, "no-matrix-member-" + "テ" * 60)  # 197 bytes, under NAME_MAX
    (bundle / "filtered_feature_bc_matrix.h5").unlink()

    result = VF.run_entry_bytes(bundle, tmp_path / "out" / "outputs")

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result, vendor_markers=["テテテ"])
    assert b"the bundle has no filtered feature-barcode matrix" in row
    assert b"filtered_feature_bc_matrix.h5" in row, "the refusal must still name what it wanted"
    # The mount path is QUOTED and CLIPPED, not removed (DEC-8) — the sentence that says what was
    # cut is what makes the clip honest rather than a silent truncation.
    assert b"characters of the path)" in row, row[:400]


def test_TEST_7_a_field_over_csvs_LIMIT_is_a_REFUSAL_not_a_TRACEBACK(tmp_path):
    """TEST-7 — found by REPRODUCING #336, not reported in it (DEC-5).

    `csv` refuses a field over 131,072 characters, and `_csv.Error` is not a `VisiumImportError`,
    so `main()`'s `except VisiumImportError` did not catch it. MEASURED on `c34b3a1f` with one
    positions field of 200,000 characters:

        rc=1
        Traceback (most recent call last):
          ...
          File ".../import_visium.py", line 1143, in read_positions
            rows = list(csv.reader(fh))
        _csv.Error: field larger than field limit (131072)

    A raw traceback and exit 1 — the identical prohibited outcome the `UnicodeDecodeError` arm
    beside it was added to remove, reached by the identical hostile vendor text. The `csv` limit
    itself is deliberately NOT raised: a positions field is a barcode or a number, and a
    131,072-character one is not a value this importer should be trying to read.
    """
    bundle = _copy(tmp_path, "csv-field-limit")
    path = _positions(bundle)
    lines = path.read_text(encoding="utf-8").splitlines()
    row = lines[1].split(",")
    row[4] = "テ" * 200_000
    lines[1] = ",".join(row)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    result = VF.run_entry_bytes(bundle, tmp_path / "out" / "outputs")

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    line = _assert_safe_to_log(result, vendor_markers=["テテテ"])
    assert b"cannot be read as CSV" in line
    assert b"field larger than field limit" in line, "the refusal must say WHY it could not read"
    assert b"Re-export the bundle from Space Ranger." in line, "and what to do about it"


@pytest.mark.parametrize("probe,expected", [
    ("h5-barcodes-dangling-softlink", b"link exists but its target cannot be read"),
    ("positions-value-not-a-number", b"holds a value that is not a number"),
])
def test_TEST_15_the_THIRD_PARTY_exception_texts_are_escaped(probe, expected, tmp_path):
    """TEST-15 — the two refusals whose interpolated value is somebody ELSE's message.

    `float()`'s `ValueError` ECHOES VENDOR TEXT BACK: it is literally
    `could not convert string to float: '<the vendor's own field>'`. So an exception string is an
    attacker-controlled value that merely arrives by a longer route, and a funnel applied only to
    values the module reads itself would miss it entirely.

    **FIX_ROUND-1 — the h5py leg's premise was overstated, and a blind design-conformance angle
    measured it.** This docstring used to say `h5py`'s `TypeError` echoes vendor text too. It does
    not: on the original probe h5py says
    `"Accessing a group is done with bytes or str, not <class 'slice'>"` — our own shapes, no
    vendor bytes — so reverting that site's funnel leaves this leg GREEN and only the structural
    guard (TEST-10) catches it. The leg is KEPT and its claim corrected rather than deleted: it
    still proves the third-party message is ROUTED and the refusal is one safe row, and the
    routing is what stops the next h5py version's message — which we do not control — from being
    the one that echoes. The vendor-echo property is pinned by the `float()` leg, which does.

    **FIX_ROUND-4b — the probe was RE-POINTED, because the original one stopped exercising
    third-party text.** The original probe put a GROUP at `/matrix/barcodes`; once `/matrix/barcodes`
    gained its own four-state validation, that bundle is intercepted in the shared helper's
    NOT-A-DATASET arm, whose only interpolated value is `type(ds).__name__` — the literal string
    `"Group"`, a module-internal constant — so the leg passed without any third-party text reaching
    the funnel. The probe is now a DANGLING ExternalLink at `/matrix/barcodes` whose TARGET PATH
    carries the hostile bytes: the shared helper's PRESENT-BUT-UNREADABLE arm catches the `KeyError`
    h5py raises for the unresolvable target and funnels `_quoted_for_refusal(exc, noun='message')` —
    h5py's own exception text, which we do not control. The external FILE exists, so HDF5 resolves
    the link and its message names the missing target — `"Unable to synchronously open object
    (object '<the vendor's own path>' doesn't exist)"` — which is how the vendor-chosen bytes reach
    the funnel; the link's FILE NAME would not do, because for a nonexistent external file HDF5 says
    only `"can't open file"`, naming nothing (MEASURED on this h5py/HDF5). The leg is now
    mutation-sensitive: the probe places hostile bytes in the bundle, so reverting the funnel turns
    this leg RED. Do not re-point it back at the group: that case no longer exercises third-party
    text.

    **FIX_ROUND-6 — the probe was RE-POINTED again, because the structural walk's P1 now
    intercepts the dangling ExternalLink before any resolution.** The walk refuses every
    `h5py.ExternalLink` under `/matrix` BY NAME before resolving it, so the dangling
    ExternalLink probe no longer reaches the PRESENT-BUT-UNREADABLE arm — P1's refusal
    names the member, not the link's target, so no third-party text reaches the funnel.
    The probe is now a DANGLING SOFTLINK whose MEMBER NAME carries the hostile bytes:
    the walk's guarded child read raises the `KeyError` for the unresolvable target and
    funnels `_quoted_for_refusal(exc, noun='message')` — h5py's own exception text,
    which we do not control — while the refusal names the hostile member path through
    `_quoted_for_refusal(path, noun='path')`, which is how the vendor-chosen bytes reach
    the funnel. The leg is still mutation-sensitive: the probe places hostile bytes in
    the bundle, so reverting the funnel turns this leg RED.

    The offending field is kept under `csv`'s 131,072-character limit on the second leg, so the
    `float()` refusal is the one reached rather than TEST-7's.
    """
    import h5py

    bundle = _copy(tmp_path, f"third-party-{probe}")
    if probe == "h5-barcodes-dangling-softlink":
        # The hostile bytes ride in the MEMBER NAME, which the walk's resolution-error
        # refusal names through `_quoted_for_refusal(path, noun='path')`. The probe is a
        # DANGLING SoftLink, not an ExternalLink: the structural walk's P1 refuses every
        # ExternalLink under `/matrix` before resolution, so a dangling ExternalLink no
        # longer reaches this arm (FIX_ROUND-6).
        with h5py.File(bundle / "filtered_feature_bc_matrix.h5", "r+") as handle:
            del handle["matrix/barcodes"]
            handle["matrix/" + "テテテ" + HOSTILE.replace(",", "")] = h5py.SoftLink("/nonexistent")
    else:
        path = _positions(bundle)
        lines = path.read_text(encoding="utf-8").splitlines()
        row = lines[1].split(",")
        # The control bytes go at the END: `_quoted_for_refusal` windows a long value on its
        # TAIL, so a payload at the head is clipped away and the assertion below would be
        # measuring the clip rather than the escaping.
        row[4] = "テ" * 60_000 + HOSTILE.replace(",", "")
        lines[1] = '"' + '","'.join(row) + '"'
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    result = VF.run_entry_bytes(bundle, tmp_path / "out" / "outputs")

    assert result.returncode == 2, (result.returncode, result.stderr[-3000:])
    row = _assert_safe_to_log(result, vendor_markers=["テテテ"])
    assert expected in row, row[:400]
    if probe == "h5-barcodes-dangling-softlink":
        # The leg that really carries vendor text: the walk's refusal names the member
        # path, so the ESCAPED payload must be present — the positive form, which goes
        # red if the funnel goes.
        assert b"\\u30c6\\u30c6\\u30c6" in row, row[:400]
    if probe == "positions-value-not-a-number":
        # The leg that really carries vendor text: `float()`'s message quotes the field, so the
        # ESCAPED payload must be present — the positive form, which goes red if the funnel goes.
        assert rb"\x1b[2J" in row, row[:400]


def test_TEST_16_every_refusal_this_suite_reaches_is_ONE_job_logs_row(tmp_path):
    """TEST-16 — the property `scheduler.rs::drain_logs` actually consumes, over a TABLE.

    `_assert_safe_to_log` checks it per test; this one checks it across every refusal shape at
    once so that the invariant reads as one fact about the module rather than as a coincidence
    repeated in six places. `drain_logs` writes one `job_logs` row per `BufReader::lines()` line
    with no per-line cap, so "the refusal is exactly one row, ASCII, and bounded" IS the contract.

    **FIX_ROUND-3 — what this test does and does not pin, measured rather than assumed.** A blind
    tests-quality angle ran the mutation: revert the funnel at the site `empty-positions`,
    `short-row` or `shape-mismatch` drives, and this test STAYED GREEN, because those probes
    produced short ASCII-only messages and every leg of `_assert_safe_to_log` was satisfied by
    construction rather than by the funnel.

    One of the three is now fixed and two are DISCLOSED, because they turn out to be different
    facts and only one of them is a test defect:

    * `shape-mismatch` WAS a test defect. The h5 `shape` dataset is vendor-written and unbounded;
      the probe used a two-entry `[999, 999]` that no bound could ever fire on. It now writes
      20,000 entries, and reverting `_quoted_list_for_refusal` there turns this test RED —
      VERIFIED by running the mutation: `stderr is 131,159 bytes, over the 65,536-byte ceiling`.
    * `empty-positions` and `short-row` quote `path.name`, and **no behavioural test can pin those
      funnel calls, because on every reachable path the value is already a module constant.**
      `read_positions` is only ever called with `members["positions"]`, which `locate_members`
      resolves by matching against `POSITIONS_BASENAMES` — so `path.name` is literally
      `"tissue_positions.csv"` or `"tissue_positions_list.csv"`. Funnelling it is DEFENCE IN DEPTH
      against a future caller that passes something else, not a live defect, and the only thing
      that can hold it is the structural guard (TEST-10), which is precisely the case the guard
      exists for. Saying "TEST-16 covers it" would be the coverage inflation this file's own
      TEST-11 docstring warns about.
    """
    import h5py

    cases = {}

    # These two quote `path.name`, which is a DECLARED BASENAME on every reachable path (see the
    # docstring). No payload is planted here, because none can reach the message — a probe carrying
    # bytes the assertion cannot see would imply coverage this test does not have.
    empty = _copy(tmp_path, "row-empty-positions")
    _positions(empty).write_text("", encoding="utf-8")
    cases["empty-positions"] = empty

    short = _copy(tmp_path, "row-short-row")
    path = _positions(short)
    lines = path.read_text(encoding="utf-8").splitlines()
    lines[2] = "AAA-1,1"
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    cases["short-row"] = short

    # FIX_ROUND-1: the barcode is LONG and NON-ASCII, not merely control-bearing. `repr()` already
    # escapes control characters, so a short `HOSTILE`-only barcode left this case GREEN with
    # `{bc!r}` restored — measured by a blind design-conformance angle. Non-ASCII and length are
    # the two properties `repr()` does NOT give, so they are what the probe carries.
    dup = _copy(tmp_path, "row-duplicate-barcode")
    path = _positions(dup)
    lines = path.read_text(encoding="utf-8").splitlines()
    row = lines[1].split(",")
    row[0] = HOSTILE.replace(",", "").replace("\n", "") + "テ" * 4000
    lines[1] = '"' + '","'.join(row) + '"'
    lines.append(lines[1])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    cases["duplicate-barcode"] = dup

    hd = _copy(tmp_path, "row-visium-hd")
    (hd / "binned_outputs").mkdir()
    cases["visium-hd"] = hd

    # The shape refusal quotes the h5 `shape` DATASET, which the vendor writes. A two-entry
    # `[999, 999]` is bounded by construction; a long one is what makes the sequence funnel
    # load-bearing at this site.
    shape = _copy(tmp_path, "row-shape-mismatch")
    with h5py.File(shape / "filtered_feature_bc_matrix.h5", "r+") as handle:
        del handle["matrix/shape"]
        handle.create_dataset(
            "matrix/shape", data=np.arange(999, 999 + 20_000, dtype=np.int64))
    cases["shape-mismatch"] = shape

    markers = {"duplicate-barcode": ["テテテ"]}
    failures = []
    for name, bundle in cases.items():
        result = VF.run_entry_bytes(bundle, tmp_path / f"out-{name}" / "outputs")
        try:
            assert result.returncode == 2, f"expected a refusal, got rc={result.returncode}"
            _assert_safe_to_log(result, vendor_markers=markers.get(name, ()))
        except AssertionError as why:
            failures.append(f"{name}: {why}")
    assert not failures, "\n".join(failures)


# ── TEST-8, TEST-9, TEST-17: the positive controls ──────────────────────────────────────


def test_TEST_8_an_ORDINARY_BAD_bundle_still_gets_an_ACTIONABLE_message(tmp_path):
    """TEST-8 — THE POSITIVE CONTROL. A safe refusal that says nothing is not a fix.

    Every assertion above is about what the refusal must NOT contain, and every one of them would
    pass if the module printed `spatial.import-visium: refused.` and exited 2. This is the test
    that stops that: for two ORDINARY bad bundles — nothing hostile, the kind a real user
    actually produces — the refusal must still name the FILE, the OFFENDING THING, and what a
    correct bundle carries.
    """
    ordinary = _copy(tmp_path, "ordinary-bad-positions")
    _rewrite_header(ordinary, ["barcode", "in_tissue", "array_row", "array_col",
                              "pxl_row_in_fullres", "totally_not_the_column"])
    result = VF.run_entry_bytes(ordinary, tmp_path / "out-positions" / "outputs")

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    assert b"tissue_positions" in row, "the refusal must name the FILE"
    assert b"totally_not_the_column" in row, "the refusal must show what it FOUND instead"
    assert b"a Visium positions table carries" in row, "the refusal must say what is expected"

    # THE MISSING COLUMN, asserted so that ONE source alone can fail it (FIX_ROUND-3). A blind
    # tests-quality angle showed the old spelling — a bare `b"pxl_col_in_fullres" in row` — is
    # satisfiable from TWO independent places in the same sentence: the `missing` list AND the
    # `POSITION_COLUMNS` prose that says what the table should carry. Deleting EITHER left the
    # suite green; only deleting both turned it red. So the module could stop saying WHICH column
    # is missing and this positive control would not notice — which is the one thing it exists to
    # notice. The two are now separated by splitting the sentence at its own fixed pivot.
    named, expected = row.split(b"; a Visium positions table carries", 1)
    assert b"pxl_col_in_fullres" in named, (
        f"the refusal must name the MISSING COLUMN in its `missing` list, not merely in the "
        f"prose that says what a correct table carries: {named[:300]!r}"
    )
    assert b"pxl_col_in_fullres" in expected, (
        f"the refusal must also say what a correct table carries: {expected[:300]!r}"
    )

    no_scale = _copy(tmp_path, "ordinary-bad-no-scalefactors")
    (no_scale / "spatial" / "scalefactors_json.json").unlink()
    result = VF.run_entry_bytes(no_scale, tmp_path / "out-scale" / "outputs")

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    assert b"scale factors" in row, "the refusal must name the missing MEMBER"
    assert b"scalefactors_json.json" in row, "and the basename it looked for"


def test_TEST_9_legitimate_non_ASCII_vendor_text_STILL_IMPORTS(tmp_path):
    r"""TEST-9 [acceptance INV-3] — the funnel is about MESSAGES, never about what imports.

    The risk a broadened escaping funnel carries is that "the refusal is ASCII" quietly becomes
    "the importer is ASCII". `_quoted_for_refusal` is `ascii()`, and it now sits on a dozen more
    call sites, so this control has to be re-run for the widened version rather than inherited
    from #330's TEST-7.

    Ordinary non-ASCII (`µ`, `ä`) AND an ASTRAL character, in the two vendor documents that reach
    an artifact, must still IMPORT — exit 0, a manifest on disk — and round-trip UNCHANGED.
    """
    import h5py

    library = "Bulb \U0001f9ec µm Gewächs"
    bundle = _copy(tmp_path, "legit-non-ascii")
    with h5py.File(bundle / "filtered_feature_bc_matrix.h5", "r+") as handle:
        handle.attrs.create("software_version", "spaceranger-2.0.0 µm Gewächs",
                            dtype=h5py.string_dtype("utf-8"))
        handle.attrs.create("library_ids", library, dtype=h5py.string_dtype("utf-8"))
    scale = bundle / "spatial" / "scalefactors_json.json"
    doc = json.loads(scale.read_text(encoding="utf-8"))
    doc["vendor_note"] = "run \U0001f9ec µ"
    scale.write_text(json.dumps(doc, ensure_ascii=True), encoding="ascii")

    outputs = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, outputs)

    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    assert (outputs / "manifest.json").is_file()
    report = json.loads((outputs / "visium-import-report.json").read_text(encoding="utf-8"))
    assert report["provenance"]["library_id"] == library, report["provenance"]
    assert report["provenance"]["pipeline"] == "spaceranger-2.0.0 µm Gewächs"
    assert report["scalefactors"]["vendor_note"] == "run \U0001f9ec µ"


def test_TEST_17_escaping_is_not_SANITISING(tmp_path):
    r"""TEST-17 [acceptance INV-2] — the outcome did not move; only the message did.

    Two legs, and both are needed:

    * a bundle carrying unwritable vendor text is still REFUSED with nothing on disk — the
      widened funnel did not turn a refusal into a repair;
    * an ORDINARY bundle still imports to the SAME outputs — the funnel was not accidentally
      applied on a path that reaches an ARTIFACT rather than a MESSAGE. Every "the message is
      safe" assertion in this file would pass on a build that quoted an artifact value too.
    """
    import h5py

    poisoned = _copy(tmp_path, "still-refused")
    with h5py.File(poisoned / "filtered_feature_bc_matrix.h5", "r+") as handle:
        handle.attrs.create("software_version", b"\xff\xfeSR", dtype=h5py.string_dtype("utf-8"))
    refused_out = tmp_path / "out-refused" / "outputs"
    refused = VF.run_entry_bytes(poisoned, refused_out)

    assert refused.returncode == 2, (refused.returncode, refused.stderr[-2000:])
    _assert_safe_to_log(refused)
    survivors = sorted(p.name for p in refused_out.rglob("*")) if refused_out.exists() else []
    assert survivors == [], f"a refused import left {len(survivors)} paths behind: {survivors[:12]}"

    ok_out = tmp_path / "out-ok" / "outputs"
    ok = VF.run_entry_bytes(VF.FIXTURE, ok_out)
    assert ok.returncode == 0, (ok.returncode, ok.stderr[-3000:])
    manifest = json.loads((ok_out / "manifest.json").read_text(encoding="utf-8"))
    ids = sorted(e["id"] for e in manifest["outputs"])
    assert ids, manifest
    report = json.loads((ok_out / "visium-import-report.json").read_text(encoding="utf-8"))
    # The vendor's own identity reached the artifact UNQUOTED — no `ascii()` on this path.
    assert report["provenance"]["library_id"] == VF.FIXTURE_LIBRARY_ID, report["provenance"]
    assert report["provenance"]["pipeline"] == VF.FIXTURE_SPACE_RANGER, report["provenance"]


# ── TEST-10, TEST-11: the STRUCTURAL guard, and its own tripwire ────────────────────────


def test_TEST_10_EVERY_refusal_site_in_the_module_is_funnelled():
    """TEST-10 [acceptance INV-4] — the guard that knows about refusals which do not exist yet.

    A guard written as "these four sites are escaped" has the same shape as the defect: it is a
    statement about today's module. `vendor-text-encodability-refusal.md` §6.5 says so about
    itself, one level down — *"a rule scoped to today's readers silently stops covering an
    attribute the day someone reads one more"* — so the subject set is DERIVED by walking the
    module's AST for every CONSTRUCTION of `VisiumImportError`, and each interpolation must be
    PROVED safe: either it goes through a funnel, or its SHAPE cannot carry a vendor byte.

    MEASURED against `origin/main` @ `c34b3a1f`, the base this branch was cut from: **26
    unprovable interpolations across 19 refusal sites**, including all four the issue names.
    Against this branch: 0, across 20.

    That base count ROSE as the guard was hardened — 22, then 24, then 26 — and the movement is
    the honest record of how much the first classifier was blessing rather than proving. 22 -> 24
    when the by-NAME attribute rule went (it had trusted `node.nbytes`/`node.size` because of what
    the attribute was CALLED); 24 -> 25 when the funnel's own `focus=` stopped being exempt (it is
    interpolated into the funnel's output); 25 -> 26 when the last blessed attribute,
    `type(x).__name__`, went, because `type()` accepts any string so a class name is neither
    ASCII nor necessarily an identifier. The number is re-measured, never adjusted to match.

    `read_text(encoding="utf-8")` is EXPLICIT: the locale default silently fails on a file with
    non-ASCII bytes under `LC_ALL=C` — and this module's own prose carries em dashes — so a guard
    reading at the default would raise or skip and this file's whole point would evaporate on
    exactly the machine #330's TEST-8 exists for (#333/#339/#330 all shipped this class of hole).
    """
    source = COMPUTE.read_text(encoding="utf-8")
    RS.assert_module_is_funnelled(source)

    _tree, sites = RS.refusal_sites(source)
    assert len(sites) >= 19, (
        f"only {len(sites)} `raise {RS.REFUSAL}` sites found; the base had 19. A parser that "
        f"suddenly matches far fewer is a parser that stopped matching, not a module that got "
        f"safer"
    )

    unsafe = RS.unsafe_interpolations(source)
    assert unsafe == [], "refusals interpolate values that are not provably safe:\n" + "\n".join(
        f"  {COMPUTE.name}:{line}  {expr}\n      -> {why}" for line, expr, why in unsafe
    )



def test_TEST_11_and_TEST_20_the_guard_GOES_RED_on_a_refusal_it_has_never_seen():
    """TEST-11 / TEST-20 [acceptance INV-4] — a guard whose failure mode is never exercised has none.

    TEST-20 is the SAME battery after FIX_ROUND-1 expanded it from 9 spellings to 31 plus four
    integrity legs, and it is named separately because its SUBJECT changed rather than its size:
    TEST-11 asked "can the classifier see a refusal it has never seen?"; TEST-20 asks "can it see
    the twelve DEFEATS two blind angles demonstrated against it?" — including one that
    re-introduced #336's own defect into the real module and returned a clean bill of health while
    the regressed build emitted a 28,320,522-byte stderr line.

    TEST-10 passing proves the module is clean. It does NOT prove the guard can SEE a violation —
    a classifier with a bug that made everything "safe" would pass it just as green. So the
    classifier is run over synthetic modules, each holding a refusal a list of today's sites
    could not possibly cover, and each must come back UNSAFE:

    * a brand-new refusal in a brand-new function (the case #336 is actually about);
    * the `%` and `.format()` spellings, which an f-string-only guard walks straight past;
    * a value laundered through a local variable and through a helper's return;
    * a value arriving as a function PARAMETER from a hostile call site — the shape that makes
      the internal-prose parameters (`absent_what`, `unreadable_what`, `not_dataset_what`,
      `inline_what`, `label`, `source`) safe, running in reverse.

    And the two integrity legs: a module with no refusal at all must RAISE rather than report
    "0 unsafe", and a module missing the funnels must RAISE rather than checking against nothing.
    """
    preamble = textwrap.dedent(
        '''
        class VisiumImportError(RuntimeError):
            pass

        def _quoted_for_refusal(value, focus=None, *, noun="path"):
            return ascii(value)

        def _quoted_list_for_refusal(values, noun="value"):
            return "[]"
        '''
    )
    hostile = {
        # --- the case #336 is actually about: a refusal that did not exist when the guard was
        #     written, in a function that did not exist either.
        "a new refusal in a new function": """
def brand_new_check(vendor_name):
    raise VisiumImportError(f"the bundle declares {vendor_name}, which is wrong.")
""",
        # --- spellings an f-string-only guard walks straight past.
        "the %-format spelling": """
def pct(vendor_name):
    raise VisiumImportError("the bundle declares %s, which is wrong." % vendor_name)
""",
        "the .format() spelling": """
def fmt(vendor_name):
    raise VisiumImportError("the bundle declares {}, which is wrong.".format(vendor_name))
""",
        "concatenation": """
def cat(vendor_name):
    raise VisiumImportError("the bundle declares " + vendor_name + ", which is wrong.")
""",
        # --- laundering the value through a binding.
        "laundered through a local": """
def laundered(vendor_name):
    shown = vendor_name
    raise VisiumImportError(f"the bundle declares {shown}, which is wrong.")
""",
        "laundered through a helper's return": """
def render(vendor_name):
    return vendor_name

def viahelper(vendor_name):
    raise VisiumImportError(f"the bundle declares {render(vendor_name)}, which is wrong.")
""",
        "an exception object": """
def viaexc(path):
    try:
        open(path)
    except OSError as exc:
        raise VisiumImportError(f"cannot read it ({exc}).")
""",
        "a hostile call site for a would-be prose parameter": """
def refuse(what):
    raise VisiumImportError(f"the bundle has no {what}.")

def caller(vendor_name):
    refuse(vendor_name)
""",
        "an unquoted element of a list": """
def viaseq(names):
    raise VisiumImportError(f"found {sorted(names)}.")
""",
        # --- FIX_ROUND-1: the CONTAINER-MUTATION family. Each of these was MISSED by the first
        #     version of the guard, and the first one is #336's own defect re-introduced into the
        #     real module in an accumulator spelling: it returned a clean bill of health while the
        #     regressed module put a 28,320,522-byte single stderr line on the wire.
        "an accumulator filled by .append": """
def acc(names):
    shown = []
    for c in names:
        shown.append(c)
    raise VisiumImportError(f"Found {shown}.")
""",
        "list() + .append": """
def acc2(names):
    shown = list()
    shown.append(names[0])
    raise VisiumImportError(f"Found {shown}.")
""",
        "set() + .add": """
def acc3(names):
    seen = set()
    seen.add(names[0])
    raise VisiumImportError(f"Found {seen}.")
""",
        ".extend": """
def acc4(names):
    shown = []
    shown.extend(names)
    raise VisiumImportError(f"Found {shown}.")
""",
        "a MODULE-level list filled inside a function": """
NAMES = []

def acc5(names):
    NAMES.append(names[0])
    raise VisiumImportError(f"Found {NAMES}.")
""",
        "subscript assignment into a literal list": """
def acc6(names):
    shown = ["x"]
    shown[0] = names[0]
    raise VisiumImportError(f"Found {shown}.")
""",
        "a dict filled by subscript": """
def acc7(names):
    d = {}
    d["k"] = names[0]
    raise VisiumImportError(f"Found {d}.")
""",
        "augmented assignment": """
def viaaug(vendor_name):
    shown = "prefix"
    shown += vendor_name
    raise VisiumImportError(f"bad {shown}.")
""",
        "a walrus": """
def viawalrus(vendor_name):
    raise VisiumImportError(f"bad {(shown := vendor_name)}.")
""",
        # --- FIX_ROUND-1: shapes that only LOOK numeric.
        "min() over strings": """
def viamin(names):
    raise VisiumImportError(f"the shortest is {min(names)}.")
""",
        "max() over strings": """
def viamax(names):
    raise VisiumImportError(f"the longest is {max(names)}.")
""",
        "an attribute that happens to be called `size`": """
def viasize(value):
    raise VisiumImportError(f"bad {value.size}.")
""",
        "an attribute that happens to be called `__name__`": """
def vianame(value):
    raise VisiumImportError(f"bad {value.__name__}.")
""",
        # --- FIX_ROUND-1: shadowing a name the guard trusts.
        "a shadowed `len`": """
def len(x):
    return x

def vialen(vendor_name):
    raise VisiumImportError(f"bad {len(vendor_name)}.")
""",
        "a class-body binding leaking into module scope": """
class Box:
    payload = ""

def viaclass(vendor_name):
    payload = vendor_name
    raise VisiumImportError(f"bad {payload}.")
""",
        # --- FIX_ROUND-1: refusal spellings the SITE FINDER missed. The guard matched
        #     `raise VisiumImportError(...)`; each of these builds the same exception a different
        #     way, and each returned "0 unsafe" on a module putting raw vendor bytes on stderr.
        "constructed into a variable, then raised": """
def viavar(vendor_name):
    err = VisiumImportError(f"bad {vendor_name}.")
    raise err
""",
        "raised through a factory function": """
def _refuse(message):
    return VisiumImportError(message)

def viafactory(vendor_name):
    raise _refuse(f"bad {vendor_name}.")
""",
        "raised through an alias": """
Refusal = VisiumImportError

def viaalias(vendor_name):
    raise Refusal(f"bad {vendor_name}.")
""",
        "raised through an attribute callee": """
import types
mod = types.SimpleNamespace(VisiumImportError=VisiumImportError)

def viaattr(vendor_name):
    raise mod.VisiumImportError(f"bad {vendor_name}.")
""",
        # --- FIX_ROUND-1, from the design-conformance angle: the funnel's OWN arguments. `noun=`
        #     is interpolated into the funnel's output, so a vendor `noun` is raw on stderr
        #     THROUGH the funnel, and a checker that returns on sight of the callee name misses it.
        "a vendor value as the funnel's `noun=`": """
def vianoun(vendor_name):
    raise VisiumImportError(f"bad {_quoted_for_refusal(1, noun=vendor_name)}.")
""",
        # `focus=` is interpolated too ("the offending unit is at {focus}"), so exempting it
        # would have left the identical hole one keyword over — found by re-reading the funnel's
        # own output after closing `noun=`, which is the check the first fix did not make.
        "a vendor value as the funnel's `focus=`": """
def viafocus(vendor_offset):
    raise VisiumImportError(f"bad {_quoted_for_refusal('x', focus=vendor_offset)}.")
""",
        "a vendor value as the funnel's positional focus": """
def viafocus2(vendor_offset):
    raise VisiumImportError(f"bad {_quoted_for_refusal('x', vendor_offset)}.")
""",
        "a vendor value as the list funnel's positional `noun`": """
def vianoun2(vendor_name):
    raise VisiumImportError(f"bad {_quoted_list_for_refusal([], vendor_name)}.")
""",
        "**kwargs splatted into a funnel": """
def viasplat(vendor_kwargs):
    raise VisiumImportError(f"bad {_quoted_for_refusal(1, **vendor_kwargs)}.")
""",
        # --- FIX_ROUND-1: dunder-backed "numeric" calls. `__abs__`/`__round__` can return
        #     anything a type wants; only `len`/`int`/`ord` are total to `int` by contract.
        "abs(), whose __abs__ a type defines": """
def viaabs(vendor_name):
    raise VisiumImportError(f"bad {abs(vendor_name)}.")
""",
        "round(), whose __round__ a type defines": """
def viaround(vendor_name):
    raise VisiumImportError(f"bad {round(vendor_name)}.")
""",
        "sum() with a non-numeric start": """
def viasum(vendor_list):
    raise VisiumImportError(f"bad {sum(vendor_list, [])}.")
""",
        # --- FIX_ROUND-1: a funnel shadowed LOCALLY, which a module-scope-only check cannot see.
        "a locally shadowed funnel": """
def vialocal(vendor_name):
    _quoted_for_refusal = lambda value: value
    raise VisiumImportError(f"bad {_quoted_for_refusal(vendor_name)}.")
""",
        # --- FIX_ROUND-2, from the correctness angle. Seven more, and the first six are all one
        #     idea: a BINDING this checker did not model. Each was measured leaking real bytes.
        "`global` rebinding a module constant": """
SHOWN = "safe literal"

def poison(vendor_name):
    global SHOWN
    SHOWN = vendor_name

def emit():
    raise VisiumImportError(f"bad {SHOWN}.")
""",
        "`nonlocal` rebinding an enclosing local": """
def outer(vendor_name):
    shown = "safe"

    def poison():
        nonlocal shown
        shown = vendor_name

    poison()
    raise VisiumImportError(f"bad {shown}.")
""",
        # The mutation family again, in the three ORDERINGS the FIX_ROUND-1 battery did not
        # cover. The poison used to be resolved DURING the source-order walk, so a mutation
        # textually before its container's binding could not find the owner.
        "a mutation in a nested function, above the binding": """
def f(vendor_name):
    def fill():
        shown.append(vendor_name)

    shown = []
    fill()
    raise VisiumImportError(f"bad {shown}.")
""",
        "a module-level mutation above the binding": """
def acc(names):
    NAMES.append(names[0])

NAMES = []

def show():
    raise VisiumImportError(f"Found {NAMES}.")
""",
        "a subscript poison above the binding": """
def poison(vendor_name):
    D["k"] = vendor_name

D = {}

def show():
    raise VisiumImportError(f"Found {D}.")
""",
        "a `match` capture pattern shadowing a constant": """
SHOWN = "constant"

def f(vendor_name):
    match vendor_name:
        case SHOWN:
            raise VisiumImportError(f"bad {SHOWN}.")
""",
        # --- the f-string FORMAT SPEC, which is interpolated as literally as the value is.
        "a vendor value as the f-string format spec": """
def f(vendor_name):
    raise VisiumImportError(f"bad {0:{vendor_name}}.")
""",
        # --- call sites the parameter tracer cannot see. One VISIBLE safe call used to satisfy
        #     the "has a call site" guard while an INVISIBLE hostile one supplied the argument.
        "an attribute-dispatched call site": """
def refuse(what):
    raise VisiumImportError(f"bad {what}.")

refuse("a literal")

class Importer:
    def go(self, vendor_name):
        self.refuse(vendor_name)
""",
        "an aliased call site": """
def refuse(what):
    raise VisiumImportError(f"bad {what}.")

refuse("a literal")
fn = refuse

def go(vendor_name):
    fn(vendor_name)
""",
        # --- IMPORTS shadow every trusted name; `def len(x)` was the only spelling pinned before.
        "an import shadowing `len`": """
from evil import len

def vialen(vendor_name):
    raise VisiumImportError(f"bad {len(vendor_name)}.")
""",
        "an import shadowing the funnel": """
from evil import _quoted_for_refusal

def f(vendor_name):
    raise VisiumImportError(f"bad {_quoted_for_refusal(vendor_name)}.")
""",
        # --- a SUBCLASS is the same exception to `main()`'s `except`, and it prints it.
        "a SUBCLASS of the refusal": """
class MyErr(VisiumImportError):
    pass

def ok():
    raise VisiumImportError("a fixed sentence.")

def f(vendor_name):
    raise MyErr(f"bad {vendor_name}.")
""",
        # --- and the last blessed attribute, removed: `type()` accepts ANY string, so a class
        #     name is neither ASCII (PEP 3131) nor necessarily an identifier.
        "`type(x).__name__`, which need not be an identifier": """
def f(vendor_name):
    raise VisiumImportError(f"bad {type(vendor_name).__name__}.")
""",
        # --- FIX_ROUND-3, from the tests-quality angle's MUTATION matrix. These three rules were
        #     already in the guard and already working — what was missing was a probe that FAILS
        #     when the rule is deleted. The angle proved that by deleting each rule and watching
        #     the whole suite stay green: a rule with no negative control is a rule the next
        #     edit removes silently. Each probe below is the shape that rule alone catches.
        "a `.join` over a vendor iterable": """
def one(basenames):
    raise VisiumImportError(f"looked for {' / '.join(basenames)} anywhere.")

def caller(vendor_names):
    one(vendor_names)
""",
        "a class-body binding read from module scope": """
class Box:
    payload = ""

def viaclass():
    raise VisiumImportError(f"bad {payload}.")
""",
        "an `except ... as` name shadowing a module constant": """
exc = ""

def viaexc(path):
    try:
        open(path)
    except OSError as exc:
        raise VisiumImportError(f"cannot read it ({exc}).")
""",
        # --- indirect dispatch, in the two spellings the parameter tracer must refuse.
        "an alias-dispatched call site": """
def refuse(what):
    raise VisiumImportError(f"the bundle has no {what}.")

def ok():
    refuse("tissue positions table")

def hostile(vendor_name):
    fn = refuse
    fn(vendor_name)
""",
        "a functools.partial call site": """
import functools

def refuse3(what):
    raise VisiumImportError(f"the bundle has no {what}.")

def ok():
    refuse3("a literal")

def viapartial(vendor_name):
    functools.partial(refuse3, vendor_name)()
""",
        "`global` smuggling past a module-level literal": """
NAMES = ""

def stash(vendor_name):
    global NAMES
    NAMES = vendor_name

def viaglobal():
    raise VisiumImportError(f"Found {NAMES}.")
""",
    }
    for label, body in hostile.items():
        unsafe = RS.unsafe_interpolations(preamble + body)
        assert unsafe, f"the guard did NOT flag {label!r} — it cannot see this violation"

    # The SAFE twin of each, so the guard is not merely "flags everything".
    # The SAFE twin, so the guard is not merely "flags everything" — a guard that refuses every
    # spelling is a guard that gets deleted. Every safe shape the module actually uses is here:
    # a module constant, a prose parameter proved literal at its only call site, a `len()`, a
    # walrus (which FIX_ROUND-2 stopped refusing), and both funnels with a literal `noun=`.
    safe = preamble + '''
BASENAME = "filtered_feature_bc_matrix.h5"

def refuse(what):
    raise VisiumImportError(f"the bundle has no {what} in {BASENAME}.")

def caller(vendor_name, values, exc):
    refuse("tissue positions table")
    if vendor_name:
        raise VisiumImportError(
            f"{BASENAME} declares {_quoted_for_refusal(vendor_name, noun='identifier')} across "
            f"{(n := len(values))} entries: {_quoted_list_for_refusal(values)} "
            f"({_quoted_for_refusal(type(exc).__name__, noun='type name')})."
        )
'''
    assert RS.unsafe_interpolations(safe) == [], RS.unsafe_interpolations(safe)

    # FALSE POSITIVES are how a guard gets weakened, so the shapes it must NOT refuse are pinned
    # too. The walrus was a real one — provably safe by the checker's own rules and refused for
    # want of an `ast.NamedExpr` arm — found by a blind correctness angle.
    for label, body in {
        "a walrus over a len()": 'def f(v):\n    raise VisiumImportError(f"bad {(n := len(v))}.")\n',
        "a nested funnel call": (
            'def f(v):\n'
            '    raise VisiumImportError(f"bad {_quoted_list_for_refusal([_quoted_for_refusal(v)])}.")\n'
        ),
        "a conditional over two literals": (
            'def f(flag):\n'
            '    raise VisiumImportError(f"bad {\'a\' if flag else \'b\'}.")\n'
        ),
    }.items():
        got = RS.unsafe_interpolations(preamble + body)
        assert got == [], f"the guard REFUSED a safe spelling ({label}): {got}"

    # Integrity leg 1: a module with no refusal must RAISE, never report a clean bill of health.
    with pytest.raises(AssertionError, match="matched NOTHING"):
        RS.refusal_sites("x = 1\n")

    # Integrity leg 2: a module without the funnels must RAISE.
    with pytest.raises(AssertionError, match="does not define"):
        RS.assert_module_is_funnelled("def f():\n    pass\n")

    # Integrity leg 3 (FIX_ROUND-1): a funnel defined TWICE. The last definition wins at import
    # time, so a routing guard keeps passing while every refusal calls something else entirely —
    # a blind angle used exactly this to make a gutted funnel invisible.
    redefined = preamble + (
        "\ndef _quoted_for_refusal(value, focus=None, *, noun=\"path\"):"
        "\n    return value\n"
    )
    with pytest.raises(AssertionError, match="defined more than once"):
        RS.assert_module_is_funnelled(redefined)

    # Integrity leg 4 (FIX_ROUND-1): a funnel that no longer escapes. A FLOOR, not a proof —
    # what the funnel DOES is proved by TEST-12/TEST-13 and by the entrypoint tests, because
    # no AST walk observes behaviour. This makes gutting it a deliberate act, not one word.
    with pytest.raises(AssertionError, match="no longer calls"):
        RS.assert_module_is_funnelled(preamble.replace("return ascii(value)", "return value"))


# ── TEST-12, TEST-13: the funnels themselves ────────────────────────────────────────────


def test_TEST_12_the_funnels_are_ASCII_control_free_and_BOUNDED():
    """TEST-12 — the two helpers, directly, on the shapes the refusals now hand them.

    The sequence funnel is the new one and it is where a per-element bound is not enough: 10,000
    elements of 200,000 characters each is 2 GB of vendor text, and it must leave as a few
    hundred bytes that STATE the true count rather than implying eight is all there was.
    """
    module = VF.load_compute()
    quote = module._quoted_for_refusal
    quote_list = module._quoted_list_for_refusal

    # (a) the shapes the widening added: `Path`, `Exception`, `int`. `len()` raises on all three.
    for value in (Path("/inputs/" + HOSTILE), ValueError(HOSTILE), 120, 2**80):
        out = quote(value)
        assert out.isascii(), (value, out)
        assert not any(chr(c) in out for c in range(0x20)), out
        assert len(out) < 400, (len(out), out[:200])

    # (b) `str` and `bytes` still take the original path — see TEST-13 for the exact bytes.
    assert quote("ab") == "'ab'"
    assert quote(b"\xff\xfeSR") == "b'\\xff\\xfeSR'"

    # (c) the sequence funnel: two unbounded dimensions, both bounded.
    huge = ["\U0001f9ec" * 200_000] * 10_000
    out = quote_list(huge)
    assert out.isascii(), out[:200]
    assert "\n" not in out and "\r" not in out and "\x1b" not in out
    assert len(out) < REFUSAL_BYTE_CAP, len(out)
    assert "the first 8 of 10000 entries" in out, out[-120:]

    # (d) and the true count is NOT stated when nothing was hidden — no false implication either
    #     way. Every element is shown, so there is nothing to disclose.
    short = quote_list(["a", "b"])
    assert short == "['a', 'b']", short
    assert "entries" not in short

    # (e) the bound does not GROW with the vendor's input. BOTH sides are over the clip, on
    #     purpose: comparing a clipped value against a short UNCLIPPED one measures the clip
    #     sentence's own length rather than growth, which is a false alarm the first version of
    #     this leg raised against a correct build. (That draft also quoted a difference of "8,408
    #     characters" without naming what it was measured against; a blind tests-quality angle got
    #     10,030 and 9,368 for two different comparands and was right that the figure was
    #     unpinnable. The assertion below needs no such number — it compares two values that are
    #     BOTH over the clip, where the only legitimate difference is decimal digits.)
    lo = quote_list(["\U0001f9ec" * 20_000] * 8)
    hi = quote_list(["\U0001f9ec" * 20_000_000] * 8)
    grew = len(hi) - len(lo)
    assert 0 <= grew <= 8 * 32, (len(lo), len(hi), grew)

    # (f) the `noun=` the widening added says what was really clipped.
    assert "characters of the path)" in quote("/" + "a" * 500)
    assert "characters of the column name)" in quote("a" * 500, noun="column name")


def test_TEST_13_the_widening_did_not_MOVE_330s_own_messages():
    """TEST-13 — `str` and `bytes` output must be byte-identical to the base.

    The widening adds a coercion arm (`str(value)` for a `Path`/`Exception`/`int`) and a `noun=`
    keyword. Both are written so the two shapes #330 already passes through this helper take the
    EXISTING path unchanged — `ascii(str(b"\\xff\\xfeSR"))` is a quoted repr OF a repr, so a
    blanket coercion would have silently rewritten every #330 message. This asserts the default
    is the old behaviour rather than assuming it.
    """
    module = VF.load_compute()
    quote = module._quoted_for_refusal
    cap = module._REFUSAL_QUOTE_CHARS

    assert quote("plain") == ascii("plain")
    assert quote(b"\xff\xfeSR") == ascii(b"\xff\xfeSR")
    assert quote("\x1b[2J\n\r") == ascii("\x1b[2J\n\r")

    long_path = "images.notes.vendor." + "z" * 500
    assert quote(long_path) == (
        f"{ascii(long_path[len(long_path) - cap:])} (the last {cap} of {len(long_path)} "
        f"characters of the path)"
    )

    value = "A" * 300 + "\ud800"
    focused = quote(value, 300)
    assert focused.isascii() and "the offending unit is at 300" in focused
    assert f"of {len(value)}" in focused


# ── TEST-14: the manifest ───────────────────────────────────────────────────────────────


# TEST-7 (#638): this node's A14-2 pin (per TESTS.md).
# TEST-7 (#359): re-pointed for the 0.25.0 bump — floor > (0,24,0), literal #359,
# subject = the corrected `binned_outputs/` HD refusal (per TESTS.md).
# TEST-5 (#654): re-pointed for the 0.25.1 bump — floor > (0,25,0), literal #654,
# subject = the derive pin (per TESTS.md).
def test_TEST_14_the_manifest_version_is_bumped_WITH_its_changelog_entry():
    """TEST-14 — a bare number bump breaks this repo's convention.

    `manifest.yaml` carries a newest-first `# X.Y.Z — #NNN: rationale` block above `version:`.
    Both halves are asserted: the number must be strictly greater than main's version, AND the
    newest changelog entry must name that same number and this issue. A version bumped without a
    log entry, or a log entry for a version the file does not declare, both fail.

    ## The floor and the issue number are PER-BRANCH, and moving them is this guard working

    They were `> (0, 11, 0)` and `#336`, which is #336's branch's answer to *"strictly greater than
    main's"* and *"this issue"*. #327 bumped 0.12.1 -> 0.13.0, so the floor moved UP to `> (0,12,1)`
    — a tightening, not a relaxation. This branch (#349) bumps 0.13.0 -> 0.14.0, so the floor moves
    UP again to `> (0,13,0)` and the literal moves to this branch's issue, whose entry must name
    the concrete subject `/matrix`. A guard still naming a previous branch's issue after this bump
    would be asserting that the newest entry names a DIFFERENT branch's issue, which is the guard
    broken rather than the guard working. This branch (#345/#451/#445) bumps 0.14.0 -> 0.15.0, so
    the floor moves UP again to `> (0,14,0)`, the issue literal becomes `#345` (the entry head names
    `#345/#451/#445`), and the subject tightens from `/matrix` to `/matrix/shape` — a tightening on
    both axes, exactly as the two before it. This branch (#462) bumps 0.15.0 -> 0.16.0, so the
    floor moves UP again to `> (0,15,0)`, the issue literal becomes `#462`, and the subject
    tightens from `/matrix/shape` to the ExternalLink/aliasing hole — an `h5py.ExternalLink`
    anywhere under `/matrix` (including `/matrix` itself) and a hard-link or same-file SoftLink
    chain aliasing two of the seven consumed members now refuse by name, and HDF5's own
    link-chain-depth `RuntimeError` is caught by the widened tuple. Every other assertion below
    is untouched (DEC-11). This branch (#474/#478/#505/#506/#517) bumps 0.16.0 -> 0.17.0, so the
    floor moves UP again to `> (0,16,0)`, the issue literal becomes `#474` (the entry head names
    `#474/#478/#505/#506/#517`), and the subject assertion moves from `ExternalLink` to the
    all-zero decision — the subject tightens from the ExternalLink/aliasing hole to the matrix's
    CONTENT: an all-zero `/matrix/data` (every stored value exactly 0) now refuses before the
    first writer, a duplicated `/matrix/barcodes` entry now refuses, the one-element `data[0:1]`
    decodability probe is widened to a full blockwise scan of the whole dataset, the three string
    members must be stored as HDF5 strings, and a structural test proves every widened
    `except (..., RuntimeError, ...)` is preceded by `except VisiumImportError: raise`.
    This branch (#453) bumps 0.17.0 -> 0.17.1, so the floor moves UP again to `> (0,17,0)`, the
    issue literal becomes `#453`, and the subject assertion moves from the all-zero decision to
    the rename — the vendored `tests/refusal_sites.py` AST guard is renamed to
    `tests/visium_refusal_sites.py` so three packages' same-basename copies can no longer
    collide under a shared-process pytest run (TEST-ONLY; no `compute/` change).
    This branch (#432) bumps 0.17.1 -> 0.17.2, so the floor moves UP again to `> (0,17,1)`, the
    issue literal becomes `#432`, and the subject assertion moves from the rename to the
    registration-overlay claims correction — the two shared modules vendored byte-identically
    into this package carry two FALSE prose claims (the "#156's registration overlay is the
    only real check" sentence and the Xenium refusal sentence); the canonical files are
    corrected (quoted + retirement marker + true statement, residue measured rather than
    closed) and re-vendored here byte-identically, so no emitted byte, declaration or computed
    number moves.

    This branch (#548) bumps 0.17.2 -> 0.18.0, so the floor moves UP again to `> (0,17,2)`,
    the issue literal becomes `#548`, and the subject assertion moves from the
    registration-overlay claims correction to the non-finite boundary extension — the
    all-zero `data` scan's predicate becomes "usable = finite AND non-zero", so a
    `/matrix/data` with NO usable stored value (all-NaN, all-Inf, all-zero or any mix)
    now refuses before the first writer while one that merely CONTAINS some NaN/Inf
    among real counts still imports; #474's "does not cover NaN/Inf" comment is retired
    with the corrected-rather-than-removed idiom, and the sister package ships the same
    boundary (HD 0.12.0). MINOR, not patch, by this log's own 0.11.0 convention: a
    class of bundle that imported at rc 0 with unusable counts now refuses.

    This branch (#508) bumps 0.18.0 -> 0.19.0, so the floor moves UP again to `> (0,18,0)`,
    the issue literal becomes `#508`, and the subject assertion moves from the
    non-finite boundary extension to the refusal-prose scope correction — the five
    "a dataset whose values depend on files outside this bundle" sentences now say
    "outside the bundle's matrix file" (the only scope the matrix-side checks
    enforce), and the two docstrings a reader looks at (
    `refuse_outside_matrix_objects`, `locate_members`) state the asymmetric scope:
    the realpath/outside rule covers the matrix file's HDF5 objects ONLY, the other
    bundle members are located BY BASENAME with no realpath check (issue #508), and
    the owner's option-1/option-2 decision is deliberately not made here. NO
    refusal, behavior or byte change — the committed vendor fixtures still import at
    rc 0 with byte-identical artifacts (MINOR by 0.11.0: the user-visible refusal
    MESSAGE text changes; the HD sibling's 0.11.0/#540 text-only correction is the
    precedent).

    This branch (#503/#489) bumps 0.19.0 -> 0.20.0, so the floor moves UP again to
    `> (0,19,0)`, the issue literal becomes `#503` (the entry head names `#503/#489`),
    and the subject assertion moves from the refusal-prose scope correction to the
    corrected-and-ENFORCED empty-matrix reason — the reason is one module constant
    (`REASON_NO_USABLE_COUNTS`) interpolated into every reason-carrying refusal, the
    #503 overstatement corrected ("exactly two DESIGNED outcomes" naming the
    measured exit-1 path; "no outcome REPORTED TO THE OPERATOR as anything other
    than SUCCESS" with the passive report/meta channels named), the #489 duplication
    closed by the new package-wide absence scan, and the prose-only scope stated
    (MINOR by 0.11.0: user-visible refusal-text change; no rc, trigger, predicate or
    byte moves).

    This branch (#508) bumps 0.20.0 -> 0.21.1, so the floor moves UP again to
    `> (0,20,0)`, the issue literal becomes `#508` (the entry head names
    `#508`), and the subject assertion moves from the corrected-and-ENFORCED
    empty-matrix reason to the OPTION-1 CONTAINMENT RULE — the owner's issue
    comment decided option 1: every bundle member must realpath to a path under
    the bundle root, implemented as ONE containment check at the end of
    `locate_members` (the single choke point). The refusal names the member and
    the quoted resolved path, exits 2 with ZERO paths under /outputs, before the
    first writer; the raw `root` is the unresolved `/inputs/<name>` staging
    path (a link to the real dir), so the comparison realpaths both sides (the
    measured over-refusal trap: naive shapes reddened the control AND the
    inside-relative rows, which stay rc 0, MEASURED); the `.h5` OWN-path gap is
    closed because the matrix is just another located member; the
    `cytassist_image` bool is exempt; `spatial-import-visium-hd`'s same seam is
    #593, the next node. MINOR, not patch, by this log's own 0.11.0 convention:
    behaviour changed for some inputs — a bundle that imported at rc 0 with a
    member resolving outside the bundle root now refuses. A14/A12: the floor
    pins move to > 0.20.0 here, the test_508 TEST-10 pin moves to >= 0.21.0; no
    unmerged ref claims 0.21.1.

    This branch (#615/#624/#625) bumps 0.21.1 -> 0.22.0, so the floor moves UP again to
    `> (0,21,1)`, the issue literal becomes `#615` (the entry head names
    `#615/#624/#625`), and the subject assertion moves from the option-1 containment
    rule to the CLAIM-ACCURACY correction — the three #503/#489 residuals the round
    filed: the #548 every-value-non-finite refusal's vendor fact downgraded to the
    block's own inferred reading with its certainty aligned to the mixed message's
    (both readings possible / cannot be told apart), the 0.17.0 all-zero clause
    re-scoped to the per-shape scoped form with the measured machine-readable
    exception (expression entry `data.stored_bytes`: 19,504 B real vs 339 B all-zero
    and 362 B mixed; `data` dtype float32 in every case), and the six #625 honesty
    clauses. MINOR, not patch, by this log's own 0.11.0 convention: user-visible
    refusal-text changes ship (the #548 non-finite message and the `nnz == 0`
    "one artifact difference" clause are shipped messages); no rc, trigger, predicate
    or emitted byte moves. A14/A12: the floor pins move to > 0.21.1 here, the
    test_508 TEST-10 pin moves to >= 0.22.0; no unmerged ref claims 0.22.0.

    This branch (#638) bumps 0.22.0 -> 0.23.0, so the floor moves UP again to
    `> (0,22,0)`, the issue literal becomes `#638`, and the subject assertion moves
    from the claim-accuracy correction of the #615/#624/#625 round to the SAME-CLASS
    residuals that round filed instead of fixed — issue #638's five prose-only sites
    across the two importers: the #548 MIXED message's vendor-fact head ("a
    well-formed 10x Space Ranger matrix produces") downgraded to the block's inferred
    reading, the decision comment's "10x Space Ranger never emits NaN" vendor claim
    corrected in place, the Refusal-B docstring's bare "(MEASURED)" gaining its
    fixture-scoping/len(entries) note, the HD non-finite message's verbatim #615
    defect corrected in HD's voice (same reading, same certainty — "the two
    importers"), and the stale "(0.21.1)" mirror note re-pointed. MINOR, not patch,
    by this log's own 0.11.0 convention: user-visible refusal-text changes ship; no
    rc, trigger, predicate or emitted byte moves. A14/A12: the floor pins move to
    > 0.22.0 here, the test_508 TEST-10 pin moves to >= 0.23.0; the HD sibling ships
    the same round as 0.19.0; no unmerged ref claims 0.23.0.

    This branch (#471) bumps 0.23.0 -> 0.24.0, so the floor moves UP again to
    `> (0,23,0)`, the issue literal becomes `#471`, and the subject assertion moves
    from the #638 five-residual correction to the LAST unguarded read in the matrix
    block — `attrs = dict(h5.attrs)` in `run_import` (`import_visium.py`, the
    root-attribute read): `dict(h5.attrs)` MATERIALISES every attribute value, and
    h5py raises while doing so on a truncated or corrupt attribute, an unmappable
    datatype or a damaged object header; those escapes were rc 1 + a raw traceback
    (INV-1), now a named `VisiumImportError` at exit 2 with zero paths on disk
    (INV-2). The guard is NARROW — only the expression is wrapped, so a genuine
    internal error below cannot be laundered into a refusal about the customer's
    bundle — and the widened tuple keeps its `except VisiumImportError: raise` FIRST
    (test_runtimeerror_guard_ordering.py). MINOR, not patch, by this log's own 0.11.0
    convention: a bundle whose root attributes cannot be materialised changed outcome
    (rc 1 + traceback -> rc 2 + named refusal); no bundle that imported successfully
    before now refuses. A14/A12: the floor pins move to > 0.23.0 here, the test_508
    TEST-10 pin moves to >= 0.24.0; no unmerged ref claims 0.24.0.

    This branch (#359) bumps 0.24.0 -> 0.25.0, so the floor moves UP again to
    `> (0,24,0)`, the issue literal becomes `#359`, and the subject assertion moves
    from the #471 unguarded root-attribute read to the claim-correction class this
    log has shipped since 0.19.0/0.20.0 — the `binned_outputs/` HD refusal in
    `locate_members` no longer defers to the CLOSED #160 (which closed without ever
    shipping an importer): it keeps the true platform-gap content (identically-named
    bin files defeating basename member matching; per-bin upload or directory-aware
    matcher), names NO issue number at all, and points the reader at the HD importer
    (`Import Visium HD (Space Ranger binned_outputs)`); the comment above the refusal
    is corrected in place and names #160 only as HISTORY. MINOR, not patch, by this
    log's own 0.11.0 convention: operator-visible refusal text changes; no rc,
    trigger, predicate or emitted byte moves. A14/A12: the floor pins move to
    > 0.24.0 here, the test_508 TEST-10 pin moves to >= 0.25.0; no unmerged ref
    claims 0.25.0.

    This branch (#654) bumps 0.25.0 -> 0.25.1, so the floor moves UP again to
    `> (0,25,0)`, the issue literal becomes `#654`, and the subject assertion moves
    from the #359 claim-correction to the DERIVE PIN — the same class one level up:
    the `binned_outputs/` HD refusal's importer name was a literal with no derive pin,
    so an HD rename (a one-line manifest edit HD's own suite would accept) left the
    emitted message stale with every test green. The message still names the HD
    importer verbatim and intentionally (visium cannot read HD's manifest at import
    time), and the new test derives the name from
    `spatial-import-visium-hd/manifest.yaml` every run — the operator-facing needle
    being the `spatial.import-visium-hd` analysis `title:` — and asserts it in the
    EMITTED message driven through the shipped entrypoint, so a same-named string
    inside the retirement comment can never satisfy it (#646); the test's docstring
    states it reddens BY DESIGN when HD renames, and the fix is then to update
    visium's message, never to relax the test. PATCH, not minor, by this log's
    test-only class (the 0.17.1/#453 rename and the 0.21.1/#508 re-point are the
    precedent): no rc, trigger, predicate, control flow or emitted byte moves — no
    importer behaviour changed for any input. A14/A12: the floor pins move to
    > 0.25.0 here, the test_508 TEST-10 pin moves to >= 0.25.1 (renamed
    `test_654_the_manifest_bump_and_its_changelog_entry_are_at_0_25_1_and_name_this_issue`
    to keep the shape HD's TEST-25 derives by regex); no unmerged ref claims 0.25.1
    (census 2026-09-26).

    `encoding="utf-8"` is EXPLICIT — the manifest's changelog uses em dashes, so under `LC_ALL=C`
    a locale-default read raises or mis-decodes and this guard would go green on a real
    regression (#333/#339/#330).
    """
    text = MANIFEST.read_text(encoding="utf-8")

    declared = [ln.split(":", 1)[1].strip().strip('"\'')
                for ln in text.splitlines() if ln.startswith("version:")]
    assert len(declared) == 1, f"expected exactly one top-level `version:`, found {declared}"
    version = tuple(int(p) for p in declared[0].split("."))
    assert version > (0, 25, 0), f"version {declared[0]} is not above main's 0.25.0"

    # The entry HEADS are the unindented `# X.Y.Z — #NNN:` lines; the continuation lines of an
    # entry are indented under it, so an indented match is a paragraph and not a new entry.
    heads = [(i, ln) for i, ln in enumerate(text.splitlines())
             if re.match(r"^# \d+\.\d+\.\d+ — #\d", ln)]
    assert heads, "no `# X.Y.Z — #NNN: rationale` changelog entry head found in manifest.yaml"

    # The NEWEST entry is the LAST one before `version:`. That is this file's actual convention,
    # read from its own history rather than assumed: #330 (af1cbd03) and #321 (6fa8126f) each
    # inserted their entry immediately above the `version:` line, which is why 0.10.1 sits below
    # 0.11.0 in the file. A test asserting "first in the file" would have failed on main.
    version_line = next(i for i, ln in enumerate(text.splitlines()) if ln.startswith("version:"))
    before = [ln for i, ln in heads if i < version_line]
    newest = before[-1]
    assert newest.startswith(f"# {declared[0]} — #"), (
        f"the entry immediately above `version:` is {newest!r}; it must name the declared "
        f"version {declared[0]}, or the bump has no log entry"
    )
    assert "#654" in newest, f"the newest entry must name this issue: {newest!r}"
    assert len(newest.split(":", 1)[1].strip()) > 20, f"the entry needs a rationale: {newest!r}"

    # And the entry is a real block, not a one-liner: the rationale continues under the head.
    body = text.split(newest, 1)[1].splitlines()[1:]
    continued = [ln for ln in body[:60] if ln.startswith("#          ")]
    assert len(continued) >= 5, (
        f"the {declared[0]} entry has only {len(continued)} continuation lines; a bare number "
        f"bump with a one-line note is what this repo's convention refuses"
    )
    # ...and THIS entry must name the concrete subject of the bump. An integrator reading
    # the changelog is the reader this entry exists for, and "bumped for #654" tells them
    # nothing about the HD-importer-name DERIVE PIN whose missing derive-pin test this
    # branch adds.
    #
    # SCOPED TO THIS ENTRY'S OWN LINES. The first spelling read a 4000-character WINDOW after the
    # head, which is not the entry — it happened not to reach another mention, and a longer entry
    # or a reordered file would have made it pass on somebody else's paragraph. The xenium sibling
    # was already scoped this way; a blind tests-quality angle named the divergence.
    entry_lines = [newest] + continued
    assert any("deriv" in ln.lower() for ln in entry_lines), (
        "the entry does not name the #654 subject — the `binned_outputs/` HD refusal's "
        "importer name is DERIVED from HD's manifest every run (a literal with no derive "
        "pin is the defect this branch closes, one level up from #359); merely mentioning "
        "#654 is not enough"
    )
    assert any("emitted message" in ln.lower() or "runtime message" in ln.lower()
               for ln in entry_lines), (
        "the entry does not name the #654 scope — the needle is asserted in the EMITTED "
        "message an operator sees, so a same-named string inside the retirement comment "
        "cannot satisfy it (#646)"
    )
    assert any("reddens by design" in ln.lower() for ln in entry_lines), (
        "the entry does not name the #654 contract — the test reddens BY DESIGN when HD "
        "renames, and the fix is then to update visium's message, never to relax the test"
    )


# ── TEST-18: the csv.Error twin FIX_ROUND-1's own fix left open ─────────────────────────


def test_TEST_18_the_OPTIONAL_metrics_file_DEGRADES_instead_of_a_TRACEBACK(tmp_path):
    r"""TEST-18 — the SECOND `list(csv.reader(fh))`, which TEST-7's fix did not cover.

    TEST-7 closed `read_positions`. The module has TWO `csv.reader` calls, and the other —
    `vendor_provenance`'s read of the OPTIONAL `metrics_summary.csv` — was guarded by
    `except (OSError, ValueError)`. `_csv.Error.__mro__` is
    `(_csv.Error, Exception, BaseException, object)`: it is **not** a `ValueError`, so a field
    over `csv`'s 131,072-character limit escaped there too. MEASURED by a blind security angle on
    the first version of this branch, `metrics_summary.csv` = `'"' + "A"*200000 + '",x\n1,2\n'`:

        rc=1  a raw TRACEBACK  14 output paths on disk, NO manifest

    The path count and the exit code are the reproducible parts and are what this test asserts. An
    earlier draft quoted "899 B over 12 lines"; a blind tests-quality angle measured 1,147 B total
    (1,056 B of traceback over 10 traceback lines, 12 rows) and was right that a traceback's byte
    count embeds absolute checkout paths, so it is not portable. The corrected shape: quote what
    reproduces, and do not quote what cannot.

    WORSE than the twin it was compared to, because `vendor_provenance` runs AFTER
    `write_csc_zarr` while `read_positions`' failure leaves 0 paths — and it is exactly the
    "fixed the reported site, left its identical sibling" shape this whole item exists to stop.

    It DEGRADES rather than refusing, unlike the positions twin, and the difference is not
    inconsistency: `metrics_summary.csv` is an OPTIONAL member with a documented degrade contract
    (`metrics_summary_unreadable: true` in the report, a documented fallback LADDER for the sample
    id). The positions table is not optional. So the assertion is exit 0 WITH the flag recorded —
    a version that refused the bundle would also be wrong.
    """
    # BOTH ways `csv.Error` is reachable here, because a fix aimed at one reason is a fix that
    # answers differently for the other. The second was named by a blind correctness angle:
    # `csv` also raises `Error("line contains NUL")` on an embedded NUL byte, which under the old
    # two-name tuple was the same uncaught traceback.
    probes = {
        "field-over-csvs-limit": ('"' + "A" * 200_000 + '",x\n1,2\n').encode("utf-8"),
        "an-embedded-NUL-byte": b"Sample ID,x\n\x00value,2\n",
    }
    failures = []
    for name, body in probes.items():
        bundle = _copy(tmp_path, f"metrics-{name}")
        (bundle / "metrics_summary.csv").write_bytes(body)
        outputs = tmp_path / f"out-{name}" / "outputs"

        result = VF.run_entry_bytes(bundle, outputs)

        try:
            assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
            assert b"Traceback" not in result.stderr, result.stderr[-3000:]
            assert (outputs / "manifest.json").is_file(), "the import must still complete"
            report = json.loads(
                (outputs / "visium-import-report.json").read_text(encoding="utf-8"))
            assert report["provenance"]["metrics_summary_unreadable"] is True, report["provenance"]
            # The documented LADDER still fills the sample id from the rung below — the vendor's
            # unreadable value must not have become the identity.
            assert report["provenance"].get("sample_id") != "A" * 200_000
            assert "\x00" not in str(report["provenance"].get("sample_id", ""))
        except AssertionError as why:
            failures.append(f"{name}: {why}")
    assert not failures, "\n".join(failures)


# ── TEST-19: the forged PROGRESS row, which the first version of this file could not see ────


def test_TEST_19_a_vendor_newline_cannot_forge_a_PROGRESS_row_either(tmp_path):
    r"""TEST-19 — the attack that defeated this file's own helper, now pinned.

    #336 demonstrates a forged `spatial.import-visium: import SUCCEEDED` row. A blind
    design-conformance angle found the SECOND shape of the same attack: name the directory
    `"\nprogress: done|100|187 outputs"` and the raw newline forges a **PROGRESS** row instead.

    That is not a lesser attack. `progress()` lines are what drive the job's progress bar over
    SSE, so a forged one tells the operator the import finished. And it defeated the first version
    of `_refusal_rows`, which discarded every line starting with `progress:` before counting —
    filtering by a prefix the attacker writes is not a filter. MEASURED against the UNFIXED
    `c34b3a1f` with this exact bundle:

        b'spatial.import-visium: the bundle has 2 candidates for filtered feature-barcode matrix ('
        b'progress: done|100|187 outputs/filtered_feature_bc_matrix.h5, ...'   <- FORGED
        the old helper's row count: 1   ->  the old assertion PASSED on the vulnerable build

    Both shapes are re-measured against the base as part of FIX_ROUND-1 and both now go RED:
    the refusal-row forgery on "2 rows carry the refusal prefix, not 1", and this one on
    "the refusal is row 0 of 2, not the last".
    """
    bundle = _copy(tmp_path, "forged-progress")
    nest = bundle / "\nprogress: done|100|187 outputs"
    nest.mkdir()
    shutil.copy(bundle / "filtered_feature_bc_matrix.h5", nest / "filtered_feature_bc_matrix.h5")

    result = VF.run_entry_bytes(bundle, tmp_path / "out" / "outputs")

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    # The forged sentence survives ESCAPED, inside the quoted value, on the refusal's own row.
    assert rb"\nprogress: done|100|187 outputs" in row, row[:400]
    # And no row anywhere claims the import made progress it did not make.
    assert not any(r.startswith(_PROGRESS_PREFIX) and b"187 outputs" in r
                   for r in _refusal_rows(result.stderr)), _refusal_rows(result.stderr)


# ── TEST-21: the design and the module must agree about whether #336 is open ────────────


def test_TEST_21_the_NAMED_DESIGN_and_the_SHIPPED_MODULE_still_describe_each_other():
    """TEST-21 — both directions, for the reason `test_hostile_vendor_text.py::TEST-10` gives.

    A note-only assertion cannot notice that the code stopped implementing the note; a code-only
    assertion cannot notice that the NOTE went stale. This branch shipped the second failure and a
    blind design-conformance angle caught it: the diff touched no docs, so
    `vendor-text-encodability-refusal.md` §6.8 item 1 still recorded #336 as an OPEN reproduced
    finding and §6.5's INV-5 note still read "Scoped to the refusals THIS DESIGN adds" — the exact
    sentence this work widens. The named design and the shipped module disagreed about whether the
    defect existed, and every other test in this file was green.

    So both halves are asserted together. Widen the design without widening the code and the
    second half goes red; narrow the code back and the second half goes red; revert the design
    note and the first half goes red.

    `read_text(encoding="utf-8")` is EXPLICIT: the design doc is full of section signs and em
    dashes, so a locale-default read raises under `LC_ALL=C` and this guard would go green on a
    real regression (#333/#339/#330 all shipped that hole).
    """
    design = VF.PKG.parents[2] / "docs" / "design" / "vendor-text-encodability-refusal.md"
    assert design.is_file(), f"the named design is missing: {design}"
    text = design.read_text(encoding="utf-8")

    # THE NOTE half — the design records that INV-5 is widened, and that §6.8 item 1 is closed.
    assert "WIDENED BY #336" in text, (
        "§6.5's INV-5 block-quote no longer records the #336 widening, so the design says this "
        "module's other refusals are still unescaped while the module says otherwise"
    )
    assert "CLOSED BY #336" in text, "§6.8 item 1 still records #336 as an open finding"
    # And the sentence the widening is scoped AGAINST is still there — the record of what shipped.
    assert "Scoped to the refusals THIS DESIGN adds" in text, (
        "the original scope sentence was DELETED rather than superseded; it is the record of what "
        "#330 shipped and of why #336 existed"
    )

    # THE CODE half — the module really holds the property those sentences now claim.
    source = COMPUTE.read_text(encoding="utf-8")
    RS.assert_module_is_funnelled(source)
    assert RS.unsafe_interpolations(source) == [], (
        "the design now claims every refusal in this module is funnelled, and the module does not "
        "hold that: " + repr(RS.unsafe_interpolations(source)[:4])
    )


# ── TEST-22: the base measurement, ASSERTED on every branch ─────────────────────────────


def test_TEST_22_the_BASE_measurement_this_branch_claims_is_re_derived_from_git():
    """TEST-22 — the "N unprovable interpolations on the base" figure, ASSERTED not narrated.

    A blind tests-quality angle found that this number lived ONLY in prose — TEST-10's docstring,
    the manifest changelog and the design note — with nothing checking it, and that it had already
    gone stale TWICE as the guard was hardened (22 -> 24 -> 25 unnoticed -> 26). A number nothing
    asserts is a number that rots, and this one is the whole measurement of the defect the branch
    closes. So the base module is read back out of git and the guard is re-run over it.

    ## Why it reads git history, and why it is NOT behind a scope gate

    Reading git history from a package test is what `_lib/test_zero_core_guard.py` sweeps for, and
    it caught the first version of this — which lived inside TEST-10 and was ungated.

    The first repair put it behind `require_introducing_file` keyed on `refusal_sites.py`. That
    was WRONG, and measured wrong: `refusal_sites.py` has been on `origin/main` since `aeeea949`,
    so `--diff-filter=A` can never match it again and the gate SKIPS on every branch that can ever
    be cut. That put the 19/26 figure back where this test was written to rescue it from — a
    number nothing asserts — while looking like a guard. A guard that can no longer fail reports
    green for a reason unrelated to what it claims (`derived-guards.md` §1).

    So it takes the FOURTH remedy the sweep's own failure message offers, after the three §5
    refuses: `_SWEEP_EXCEPTIONS` as `<path>::<test>`, with the mechanism that makes it
    self-limiting written down there and here:

        the read names a FIXED commit and compares it to FIXED constants, so no branch's own diff
        is its subject. It can only redden a branch that changes `compute/import_visium.py` (the
        second half — the branch side must still measure ZERO) or `refusal_sites.py` (the guard
        itself, which changes what these numbers mean). Both reds land on the branch that caused
        them and say what to do about it. A branch that touches neither cannot redden it.

    STATED HONESTLY, because the sibling entry this follows
    (`doublet/tests/test_scrublet_lane_unchanged.py`, also pinned to a fixed commit) had the first
    version of ITS note corrected for exactly this: a fixed-SHA comparison is not the same property
    as self-limiting. The residue here is a shallow clone, where `c34b3a1f` is unreachable and this
    fails on any branch. That is left as a FAILURE rather than a skip on purpose — "I could not
    read the base" must not become a silent way for the whole measurement to stop asserting, which
    is the rule `zero_core_guard.base_ref` states one layer down.

    It is a SEPARATE test from TEST-10 because they answer different questions and can fail for
    different reasons: TEST-10 asserts the property of the module as it stands today, this asserts
    the measurement of what it was cut from. The split also kept TEST-10 alive through the gated
    round, and there is no reason to undo it now.
    """
    base = subprocess.run(
        ["git", "show", f"{_BASE_SHA}:src-app/packages/spatial-import-visium/compute/"
                        "import_visium.py"],
        cwd=str(VF.PKG), capture_output=True, timeout=300,
    )
    assert base.returncode == 0, (
        f"{_BASE_SHA} is not readable in this checkout: {base.stderr[:300]!r}"
    )
    base_source = base.stdout.decode("utf-8")

    _base_tree, base_sites = RS.refusal_sites(base_source)
    base_unsafe = RS.unsafe_interpolations(base_source)
    assert (len(base_sites), len(base_unsafe)) == (19, 26), (
        f"the base measurement moved: {_BASE_SHA} now reports {len(base_sites)} refusal sites and "
        f"{len(base_unsafe)} unprovable interpolations, not 19 and 26. Either the guard changed "
        f"what it can prove — in which case UPDATE this number and the two prose copies of it in "
        f"manifest.yaml and the design note, having re-read what moved — or the base is not what "
        f"this branch was cut from"
    )

    # And the branch itself is the other half of the same measurement.
    assert RS.unsafe_interpolations(COMPUTE.read_text(encoding="utf-8")) == []
