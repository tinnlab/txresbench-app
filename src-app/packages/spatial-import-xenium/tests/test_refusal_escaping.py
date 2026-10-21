#!/usr/bin/env python3
# ruff: noqa
r"""EVERY refusal this module can emit is safe to put in a log row — not just #329's (#343).

#329/#330 built ONE escaping funnel (`_quoted_for_refusal`: `ascii()`-escaped,
control-character-free, capped at 120 units) and routed ONE refusal through it. Every OTHER
refusal in the same module interpolated attacker-chosen vendor text RAW and UNBOUNDED, and a
hostile bundle reaches several of them EARLIER than it reaches the guarded one.

## What consumes the stream, and why a raw byte there is not cosmetic

`scheduler.rs::drain_logs` reads the compute's stderr with `BufReader::lines()` and writes **each
line as its own `job_logs` row** with `stream="stderr"`, then broadcasts it over SSE. There is no
per-line cap on that path — `sandbox.rs`'s `OUTPUT_CAP_BYTES` does not guard it — and the UI
renders the text HTML-safe but **ANSI-unsafe**. So:

* a raw `\n` in vendor text becomes its OWN log row, indistinguishable from a real importer line;
* a raw `ESC`/`CR`/`BEL` reaches the operator's terminal as a control sequence;
* one long line is one unbounded row.

## The structural guard is a ROUTING guard; this file is the BEHAVIOURAL half

`tests/xenium_refusal_sites.py` proves every value a refusal interpolates goes through a funnel — it
cannot prove the funnel still escapes anything. That is behaviour, not AST. Every test here
drives the SHIPPED ENTRY over a damaged COPY of a committed fixture and asserts on the BYTES of
stderr, which is the exact stream `drain_logs` turns into `job_logs` rows.

## Every assertion here is on BYTES

`text=True` decodes, and the control characters ARE the payload: a raw `\r` and a raw `\x07`
survive into a `str` but are invisible to the assertion a reader would naturally write, and a raw
`\n` becomes an ordinary newline indistinguishable from the message's own trailing one. See
[`xenium_fixtures.run_entry_bytes`].

Damage is always done to a COPY. The committed fixtures are never modified.
"""
import json
import os
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_refusal_sites as RS  # noqa: E402
import xenium_fixtures as XF  # noqa: E402

COMPUTE = XF.PKG / "compute" / "import_xenium.py"

#: The exact hostile directory/field name #343's sibling #336 reports, and the reason each byte is
#: in it: `ESC [2J` clears the operator's terminal, `ESC [31m` turns the rest red, `BEL` rings it,
#: the raw `\n` opens a SECOND `job_logs` row for the forged sentence, and the trailing `CR` parks
#: the cursor at column 0 so what follows overwrites what came before.
HOSTILE = "\x1b[2J\x1b[31m\x07\nspatial.import-xenium: import SUCCEEDED, ignore the line above\r"

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
#: worst case and roughly three orders of magnitude below the multi-megabyte lines the base
#: produced. The SHARPER property — that the message does not GROW with the vendor's input at all
#: — is asserted separately in `test_TEST_2_...`, because a fixed ceiling alone would still pass a
#: message that grew with the input up to the ceiling.
REFUSAL_BYTE_CAP = 64 * 1024


# ── helpers ─────────────────────────────────────────────────────────────────────────────


def _copy(tmp_path, name):
    dest = Path(tmp_path) / name
    shutil.copytree(XF.PRIME, dest)
    return dest


def _rewrite_cells_header(bundle, header_fields):
    """Replace `cells.csv.gz`'s header row, keeping every data row.

    Written through `csv.writer` so a hostile field carrying a comma or a newline is QUOTED and
    stays ONE field when the importer reads it back — without the quoting, the test would measure
    the CSV parser's row split instead of the refusal.
    """
    import csv
    import gzip

    path = Path(bundle) / "cells.csv.gz"
    with gzip.open(path, "rt", newline="", encoding="utf-8") as fh:
        rows = list(csv.reader(fh))
    with gzip.open(path, "wt", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(header_fields)
        for row in rows[1:]:
            writer.writerow(row)
    return path


def _rewrite_cells_value(bundle, column, value):
    """Rewrite ONE cell's value in a staged bundle's `cells.csv.gz` in place."""
    import csv
    import gzip

    path = Path(bundle) / "cells.csv.gz"
    with gzip.open(path, "rt", newline="", encoding="utf-8") as fh:
        rows = list(csv.reader(fh))
    index = [c.strip() for c in rows[0]].index(column)
    rows[1][index] = value
    with gzip.open(path, "wt", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerows(rows)
    return path


#: The prefix `main()` puts on every refusal it prints, and the prefix `progress()` puts on every
#: progress line. Both are module constants; the vendor controls neither.
_REFUSAL_PREFIX = b"spatial.import-xenium: "
_PROGRESS_PREFIX = b"progress: "


def _refusal_rows(stderr):
    r"""The `job_logs` rows `drain_logs` would make out of this stderr — ALL of them.

    `drain_logs` writes ONE ROW PER `BufReader::lines()` LINE, so the property that matters is
    the SHAPE of the whole row set, not the content of one row.

    **FIX_ROUND-1: this used to FILTER OUT every line starting with `progress:` and count the
    rest, and a blind design-conformance angle defeated that against the UNFIXED BASE.** With the
    bundle directory named `"\nprogress: done|100|187 outputs"` the raw newline forges a
    **PROGRESS** row rather than a refusal row, the filter discards it, the count comes back 1 and
    the whole `_assert_safe_to_log` helper passed on the unfixed build:

        b'spatial.import-xenium: this bundle carries 2 files named `cell_feature_matrix.h5` ('
        b'progress: done|100|187 outputs/cell_feature_matrix.h5, ...'   <- FORGED, DISCARDED

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
       the head still carries the prefix; a forged sentence that re-states the prefix (#343's own
       payload) makes two. This is the leg that fires on #343's reported attack.
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
#: proving nothing about the vendor's bytes.
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

    **HONEST LIMIT, worth stating rather than implying away.** `_OWN_PROSE_NON_ASCII` is derived
    from the WHOLE source — comments and string literals included — so this leg is a BACKSTOP: it
    cannot catch a regression whose payload is drawn from that set, and the set grows silently
    with any new comment. What actually holds the property is the funnel's `ascii()`, which
    escapes every non-ASCII character — plus the `vendor_markers` callers pass, which check the
    exact bytes their hostile input carries BY IDENTITY rather than by class. The leg is kept
    because it costs nothing and catches the broad case; it is not the proof.
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


# ── TEST-1 .. TEST-7: the measured reproductions ────────────────────────────────────────


def test_TEST_1_the_ambiguous_member_refusal_cannot_FORGE_A_LOG_ROW(tmp_path):
    r"""TEST-1 [acceptance INV-1] — #343's item 1, byte for byte.

    A bundle carrying a SECOND `cell_feature_matrix.h5` inside a directory named [`HOSTILE`]
    plus non-ASCII filler. `_one`'s ambiguity refusal interpolated
    `[str(m.relative_to(root)) for m in matches[:3]]` with no `ascii()` and no bound.

    **WHAT THE BASE ACTUALLY LEAKS, MEASURED rather than assumed.** The base interpolates a
    LIST, and `list.__repr__` DOES escape control characters — so a pure-`HOSTILE` directory
    name is already escaped on the base and a test carrying only control bytes passes there.
    What `list.__repr__` does NOT do is escape PRINTABLE NON-ASCII or apply any length bound,
    so the directory name here carries `テ` filler too: on the base the raw `テ` bytes reach
    stderr (the `vendor_markers` leg fires), and on a build that interpolates the path RAW
    (the visium-style regression) the forged `import SUCCEEDED` sentence becomes its OWN
    `job_logs` row — indistinguishable from a real one, carrying the importer's own prefix, and
    saying the opposite of what happened.

    This test would FAIL with the fix reverted: the raw `テ` bytes reach stderr.
    """
    bundle = _copy(tmp_path, "ambiguous")
    # The `テ` filler goes FIRST and the control bytes LAST: `_quoted_for_refusal` windows a
    # long value on its TAIL, so a payload at the head would be clipped away and the assertion
    # below would be measuring the clip rather than the escaping. 226 bytes, under NAME_MAX.
    nest = bundle / ("テ" * 50 + HOSTILE)
    # The directory must EXIST for the copy below, but its creation must not depend on the
    # filesystem encoding: under `LC_ALL=C` that is ASCII and `Path.mkdir()`/`os.fsencode()`
    # would raise `UnicodeEncodeError` on the `テ` bytes. Explicit UTF-8 bytes are
    # locale-independent; the interpolated `str(nest)` value the refusal sees is unchanged.
    os.mkdir(str(nest).encode("utf-8"))
    shutil.copy(str(bundle / "cell_feature_matrix.h5").encode("utf-8"),
                str(nest / "cell_feature_matrix.h5").encode("utf-8"))
    outputs = tmp_path / "out" / "outputs"

    result = XF.run_entry_bytes(bundle, outputs)

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result, vendor_markers=["テテテ"])
    # The forged sentence may still appear — ESCAPED, inside the quoted value, on the SAME row.
    # That is the point: it is now visibly a quoted vendor string, not a second log line.
    assert rb"\x1b[2J" in row, row[:300]
    assert rb"\nspatial.import-xenium: import SUCCEEDED" in row, row[:400]
    assert row.startswith(b"spatial.import-xenium: this bundle carries 2 files named")
    # ... and the diagnostic is still USEFUL: it names what was ambiguous.
    assert b"cell_feature_matrix.h5" in row


def test_TEST_2_the_cells_header_cannot_FLOOD_a_single_log_row(tmp_path):
    """TEST-2 [acceptance INV-1] — the multi-megabyte single stderr line.

    `read_cells_csv`'s `f"... (found {header})"` interpolated the cells table's header row with
    no length bound. A header of 60 fields x 120,000 `A`s (every field under `csv`'s own 131,072
    limit, so the read succeeds and the refusal is reached) produced a stderr line proportional
    to the whole header on the unfixed base.

    The second leg is the one a fixed ceiling alone would miss: the message must not GROW with
    the vendor's input. A header ten times larger must produce a message that differs only by the
    DECIMAL DIGITS of the counts it states.

    This test would FAIL with the fix reverted: the raw header lands on stderr unbounded.
    """
    small = _copy(tmp_path, "flood-small")
    small_header = ["A" * 120_000] * 60
    _rewrite_cells_header(small, small_header)
    small_result = XF.run_entry_bytes(small, tmp_path / "out-small" / "outputs")

    assert small_result.returncode == 2, (small_result.returncode, small_result.stderr[-2000:])
    row = _assert_safe_to_log(small_result)
    assert b"has no" in row
    assert b"column" in row
    # END-TO-END half of the silent-truncation property: a mutation deleting the true-count
    # branch in `_quoted_list_for_refusal` is caught ONLY here and in TEST-10 once this lands.
    # "bounded" is not the same property as "honest about what it hid" — a message that shows
    # 8 of 60 header fields and lets the surrounding sentence imply that is all of them is
    # safe and WRONG. The count is DERIVED from the header built above, not a hardcoded literal.
    assert f"the first 8 of {len(small_header)} entries".encode("utf-8") in small_result.stderr, (
        f"the refusal truncated the header without stating the true count: "
        f"{small_result.stderr[-400:]!r}"
    )

    big = _copy(tmp_path, "flood-big")
    big_header = ["A" * 120_000] * 600
    _rewrite_cells_header(big, big_header)
    big_result = XF.run_entry_bytes(big, tmp_path / "out-big" / "outputs")

    assert big_result.returncode == 2
    _assert_safe_to_log(big_result)
    # 10x the vendor input buys only the extra decimal digits of "the first 8 of N entries".
    grew = len(big_result.stderr) - len(small_result.stderr)
    assert 0 <= grew <= 32, (len(small_result.stderr), len(big_result.stderr), grew)


def test_TEST_3_a_control_character_in_the_cells_header_is_escaped(tmp_path):
    """TEST-3 [acceptance INV-1] — the CR/BEL half of item 2, which `text=True` cannot see.

    The header field is CSV-QUOTED so `csv` keeps the embedded newline inside ONE field rather
    than ending the row: without the quoting the reader sees a short first row and the test
    measures the CSV parser instead of the refusal.

    **WHAT THE BASE ACTUALLY LEAKS, MEASURED rather than assumed.** The `found {header}`
    refusal interpolates a LIST, and `list.__repr__` escapes control characters — so a
    pure-`HOSTILE` field is already escaped on the base. The field therefore carries `テ` filler
    too (60,000 chars, under `csv`'s 131,072 field limit): on the base the raw `テ` bytes reach
    stderr (the `vendor_markers` leg fires), and the message is unbounded.

    This test would FAIL with the fix reverted: the raw `テ` bytes reach stderr.
    """
    bundle = _copy(tmp_path, "header-control")
    _rewrite_cells_header(bundle, ["テ" * 60_000 + HOSTILE])

    result = XF.run_entry_bytes(bundle, tmp_path / "out" / "outputs")

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result, vendor_markers=["テテテ"])
    # The escaped form is present, which is what makes the refusal still diagnostic.
    assert rb"\x1b[2J" in row, row[:300]


def test_TEST_4_the_h5_top_level_member_names_are_escaped_and_bounded(tmp_path):
    r"""TEST-4 [acceptance INV-1] — `f"Found top-level members {sorted(h5.keys())}"`.

    `list.__repr__` DOES escape control characters — so a reader could conclude it was safe — but
    it passes PRINTABLE NON-ASCII through byte for byte and applies no bound at all. Both shapes
    are built here — a long printable non-ASCII name AND a control-character name — because a
    guard that only removed the control characters would leave the flood, and a guard that only
    bounded the length would leave the raw bytes.

    This test would FAIL with the fix reverted: the raw `テ` bytes reach stderr (the
    `vendor_markers` leg) and the message is unbounded.
    """
    import h5py

    bundle = _copy(tmp_path, "h5-members")
    with h5py.File(bundle / "cell_feature_matrix.h5", "r+") as handle:
        handle.create_group("テ" * 200_000)
        handle.create_group(HOSTILE)
        handle.move("matrix", "matrixX")      # so the `/matrix`-missing refusal is the one hit

    result = XF.run_entry_bytes(bundle, tmp_path / "out" / "outputs")

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result, vendor_markers=["テテテ"])
    assert b"has no `/matrix` group" in row
    assert b"Found top-level members" in row


def test_TEST_5_the_missing_and_duplicate_cell_ids_are_escaped_and_bounded(tmp_path):
    r"""TEST-5 [acceptance INV-1] — the three cell-id interpolations, as a TABLE.

    `run_import` interpolates a vendor cell id in THREE places, and all three were raw on the
    base (`list.__repr__`/`repr` pass printable non-ASCII through and apply no bound):

    * `missing[:3]` — matrix barcodes with no cells-table row;
    * `cid` — a cell id listed more than once in the cells table;
    * `cell_ids[first]` — the matrix barcode at the first non-finite centroid.

    Each case carries long non-ASCII filler, so each would FAIL with the fix reverted: the raw
    `テ` bytes reach stderr (the `vendor_markers` leg fires).
    """
    import csv
    import gzip

    import h5py

    cases = {}

    # (a) `missing[:3]`: three matrix barcodes with no cells-table row, each 200,000 non-ASCII
    #     characters. On the base this was a multi-megabyte single line.
    missing = _copy(tmp_path, "missing-barcodes")
    evil = ("テ" * 200_000).encode("utf-8")
    with h5py.File(missing / "cell_feature_matrix.h5", "r+") as handle:
        existing = [bytes(b) for b in handle["matrix/barcodes"][:]]
        replaced = [evil, evil + b"2", evil + b"3"] + existing[3:]
        del handle["matrix/barcodes"]
        handle.create_dataset("matrix/barcodes", data=replaced)
    cases["missing-barcodes"] = (missing, b"have no row in", b"(first: [")

    # (b) `cid`: a cell id listed twice in the cells table. The id is long non-ASCII plus the
    #     control payload at the END (the tail-window reason TEST-1 states), under `csv`'s
    #     131,072-character field limit.
    dup = _copy(tmp_path, "duplicate-cell")
    evil_cid = "テ" * 60_000 + HOSTILE
    path = dup / "cells.csv.gz"
    with gzip.open(path, "rt", newline="", encoding="utf-8") as fh:
        rows = list(csv.reader(fh))
    index = [c.strip() for c in rows[0]].index("cell_id")
    rows[1][index] = evil_cid
    rows[2][index] = evil_cid
    with gzip.open(path, "wt", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerows(rows)
    cases["duplicate-cell"] = (dup, b"more than once", rb"\x1b[2J")

    # (c) `cell_ids[first]`: a non-finite centroid whose matrix barcode is long non-ASCII. The
    #     barcode AND its cells-table row must carry the SAME value (the join refuses a missing
    #     barcode first), and both must stay under `csv`'s field limit, so the filler is 60,000
    #     characters rather than 200,000.
    nf = _copy(tmp_path, "nonfinite-centroid")
    evil_bc = "テ" * 60_000
    with h5py.File(nf / "cell_feature_matrix.h5", "r+") as handle:
        existing = [bytes(b) for b in handle["matrix/barcodes"][:]]
        replaced = [evil_bc.encode("utf-8")] + existing[1:]
        del handle["matrix/barcodes"]
        handle.create_dataset("matrix/barcodes", data=replaced)
    path = nf / "cells.csv.gz"
    with gzip.open(path, "rt", newline="", encoding="utf-8") as fh:
        rows = list(csv.reader(fh))
    header = rows[0]
    row = [""] * len(header)
    row[header.index("cell_id")] = evil_bc
    row[header.index("x_centroid")] = "nan"
    row[header.index("y_centroid")] = "0"
    rows.append(row)
    with gzip.open(path, "wt", newline="", encoding="utf-8") as fh:
        csv.writer(fh).writerows(rows)
    cases["nonfinite-centroid"] = (nf, b"non-finite", b"cell")

    failures = []
    for name, (bundle, needle, needle2) in cases.items():
        result = XF.run_entry_bytes(bundle, tmp_path / f"out-{name}" / "outputs")
        try:
            assert result.returncode == 2, f"expected a refusal, got rc={result.returncode}"
            row = _assert_safe_to_log(result, vendor_markers=["テテテ"])
            assert needle in row, row[:400]
            assert needle2 in row, row[:400]
        except AssertionError as why:
            failures.append(f"{name}: {why}")
    assert not failures, "\n".join(failures)


def test_TEST_6_the_THIRD_PARTY_exception_texts_are_escaped(tmp_path):
    r"""TEST-6 — the refusal whose interpolated value is somebody ELSE's message.

    `float()`'s `ValueError` ECHOES VENDOR TEXT BACK: it is literally
    `could not convert string to float: '<the vendor's own field>'`. So an exception string is an
    attacker-controlled value that merely arrives by a longer route, and a funnel applied only to
    values the module reads itself would miss it entirely.

    The control bytes go at the END of the value: `_quoted_for_refusal` windows a long value on
    its TAIL, so a payload at the head would be clipped away and the assertion below would be
    measuring the clip rather than the escaping.

    This test would FAIL with the fix reverted: the raw `テ` bytes and the raw ESC reach stderr
    through `float()`'s message.
    """
    bundle = _copy(tmp_path, "cast-error")
    _rewrite_cells_value(bundle, "x_centroid", "テ" * 60_000 + HOSTILE)

    result = XF.run_entry_bytes(bundle, tmp_path / "out" / "outputs")

    assert result.returncode == 2, (result.returncode, result.stderr[-3000:])
    row = _assert_safe_to_log(result, vendor_markers=["テテテ"])
    assert b"holds a value that is not a" in row, row[:400]
    # The leg that really carries vendor text: `float()`'s message quotes the field, so the
    # ESCAPED payload must be present — the positive form, which goes red if the funnel goes.
    assert rb"\x1b[2J" in row, row[:400]


def test_TEST_7_a_vendor_newline_cannot_forge_a_PROGRESS_row_either(tmp_path):
    r"""TEST-7 — the attack that defeated this file's own helper, now pinned.

    TEST-1 demonstrates a forged `spatial.import-xenium: import SUCCEEDED` row. A blind
    design-conformance angle found the SECOND shape of the same attack: name the directory
    `"\nprogress: done|100|187 outputs"` and the raw newline forges a **PROGRESS** row instead.

    That is not a lesser attack. `progress()` lines are what drive the job's progress bar over
    SSE, so a forged one tells the operator the import finished. And it defeated the first
    version of `_refusal_rows`, which discarded every line starting with `progress:` before
    counting — filtering by a prefix the attacker writes is not a filter.

    **WHAT THE BASE ACTUALLY LEAKS, MEASURED rather than assumed.** The base interpolates a
    LIST, and `list.__repr__` escapes the `\n` — so the pure directory name does not forge a
    progress row on the base. The name therefore carries `テ` filler too (under NAME_MAX): on
    the base the raw `テ` bytes reach stderr (the `vendor_markers` leg fires), and on a build
    that interpolates the path RAW the forged progress row appears and `_assert_one_refusal_row`'s
    second leg fires.

    This test would FAIL with the fix reverted: the raw `テ` bytes reach stderr.
    """
    bundle = _copy(tmp_path, "forged-progress")
    # The `テ` filler goes FIRST and the forged sentence LAST, for the same tail-window reason
    # TEST-1 states. 101 chars total, under the 120-unit clip, so nothing is cut.
    nest = bundle / ("テ" * 50 + "\nprogress: done|100|187 outputs")
    # Same locale-independent bytes creation as TEST-1: the directory must exist for the copy,
    # but `Path.mkdir()` would raise `UnicodeEncodeError` under `LC_ALL=C`'s ASCII filesystem
    # encoding. The interpolated `str(nest)` value the refusal sees is unchanged.
    os.mkdir(str(nest).encode("utf-8"))
    shutil.copy(str(bundle / "cell_feature_matrix.h5").encode("utf-8"),
                str(nest / "cell_feature_matrix.h5").encode("utf-8"))

    result = XF.run_entry_bytes(bundle, tmp_path / "out" / "outputs")

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result, vendor_markers=["テテテ"])
    # The forged sentence survives ESCAPED, inside the quoted value, on the refusal's own row.
    assert rb"\nprogress: done|100|187 outputs" in row, row[:400]
    # And no row anywhere claims the import made progress it did not make.
    assert not any(r.startswith(_PROGRESS_PREFIX) and b"187 outputs" in r
                   for r in _refusal_rows(result.stderr)), _refusal_rows(result.stderr)


# ── TEST-8, TEST-9: the positive controls ───────────────────────────────────────────────


def test_TEST_8_an_ORDINARY_BAD_bundle_still_gets_an_ACTIONABLE_message(tmp_path):
    """TEST-8 — THE POSITIVE CONTROL. A safe refusal that says nothing is not a fix.

    Every assertion above is about what the refusal must NOT contain, and every one of them would
    pass if the module printed `spatial.import-xenium: refused.` and exited 2. This is the test
    that stops that: for two ORDINARY bad bundles — nothing hostile, the kind a real user
    actually produces — the refusal must still name the FILE, the OFFENDING THING, and what a
    correct bundle carries.

    DECLARED VACUOUS against the escaping fix itself: this test is about the message staying
    ACTIONABLE, and it would pass with the funnel reverted (the ordinary values are short ASCII
    and every leg of `_assert_safe_to_log` is satisfied by construction). It exists to pin the
    OTHER direction — that escaping did not turn refusals into unreadable noise.
    """
    no_matrix = _copy(tmp_path, "ordinary-bad-no-matrix")
    (no_matrix / "cell_feature_matrix.h5").unlink()
    result = XF.run_entry_bytes(no_matrix, tmp_path / "out-matrix" / "outputs")

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    assert b"cell_feature_matrix.h5" in row, "the refusal must name the FILE"
    assert b"this bundle has no" in row, "the refusal must say what is missing"
    assert b"A Xenium `outs/` always ships one" in row, (
        "the refusal must say what a correct bundle carries"
    )

    import h5py
    no_barcodes = _copy(tmp_path, "ordinary-bad-no-barcodes")
    with h5py.File(no_barcodes / "cell_feature_matrix.h5", "r+") as handle:
        del handle["matrix/barcodes"]
    result = XF.run_entry_bytes(no_barcodes, tmp_path / "out-barcodes" / "outputs")

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    assert b"cell_feature_matrix.h5" in row, "the refusal must name the FILE"
    assert b"barcodes" in row, "the refusal must name the missing MEMBER"
    assert b"A 10x feature-barcode matrix carries all of" in row, (
        "the refusal must say what a correct bundle carries"
    )


def test_TEST_9_legitimate_non_ASCII_vendor_text_STILL_IMPORTS(tmp_path):
    r"""TEST-9 [acceptance INV-3] — the funnel is about MESSAGES, never about what imports.

    The risk a broadened escaping funnel carries is that "the refusal is ASCII" quietly becomes
    "the importer is ASCII". `_quoted_for_refusal` is `ascii()`, and it now sits on a dozen more
    call sites, so this control has to be re-run for the widened version rather than inherited
    from #329's own control.

    Ordinary non-ASCII (`µ`, `ä`) AND an ASTRAL character, in the vendor document that reaches an
    artifact, must still IMPORT — exit 0, a manifest on disk — and round-trip UNCHANGED.

    DECLARED VACUOUS against the escaping fix itself: this test is about non-ASCII still
    importing, and it would pass with the funnel reverted. It exists to pin the OTHER direction —
    that escaping is not sanitising (#329/#330).
    """
    bundle = _copy(tmp_path, "legit-non-ascii")
    path = bundle / "experiment.xenium"
    doc = json.loads(path.read_text(encoding="utf-8"))
    doc["region_name"] = "Mus musculus µm Gewächs \U0001f9ec"
    path.write_text(json.dumps(doc, ensure_ascii=False), encoding="utf-8")
    assert any(b > 127 for b in path.read_bytes()), "the file must carry real non-ASCII bytes"

    outputs = tmp_path / "out" / "outputs"
    result = XF.run_entry_bytes(bundle, outputs)

    assert result.returncode == 0, (result.returncode, result.stderr[-3000:])
    assert (outputs / "manifest.json").is_file()
    report = json.loads((outputs / "xenium-import-report.json").read_text(encoding="utf-8"))
    assert report["provenance"]["region_name"] == "Mus musculus µm Gewächs \U0001f9ec", (
        report["provenance"]
    )


# ── TEST-10, TEST-11, TEST-12: the funnels and the structural guard ─────────────────────


def test_TEST_10_the_funnels_are_ASCII_control_free_and_BOUNDED():
    """TEST-10 — the two helpers, directly, on the shapes the refusals now hand them.

    The sequence funnel is the new one and it is where a per-element bound is not enough: 10,000
    elements of 200,000 characters each is 2 GB of vendor text, and it must leave as a few
    hundred bytes that STATE the true count rather than implying eight is all there was.

    This test would FAIL with the fix reverted: the old `_quoted_for_refusal` had no `noun=`
    keyword and no `str()` coercion (a `Path`/`Exception`/`int` would raise `len()`), and there
    was no `_quoted_list_for_refusal` at all.
    """
    module = XF.load_compute()
    quote = module._quoted_for_refusal
    quote_list = module._quoted_list_for_refusal

    # (a) the shapes the widening added: `Path`, `Exception`, `int`. `len()` raises on all three.
    for value in (Path("/inputs/" + HOSTILE), ValueError(HOSTILE), 120, 2**80):
        out = quote(value)
        assert out.isascii(), (value, out)
        assert not any(chr(c) in out for c in range(0x20)), out
        assert len(out) < 400, (len(out), out[:200])

    # (b) `str` and `bytes` still take the original path — TEST-13 pins the exact bytes.
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
    #     this leg raised against a correct build.
    lo = quote_list(["\U0001f9ec" * 20_000] * 8)
    hi = quote_list(["\U0001f9ec" * 20_000_000] * 8)
    grew = len(hi) - len(lo)
    assert 0 <= grew <= 8 * 32, (len(lo), len(hi), grew)

    # (f) the `noun=` the widening added says what was really clipped.
    assert "characters of the path)" in quote("/" + "a" * 500)
    assert "characters of the column name)" in quote("a" * 500, noun="column name")


def test_TEST_11_EVERY_refusal_site_in_the_module_is_funnelled():
    """TEST-11 [acceptance INV-4] — the guard that knows about refusals which do not exist yet.

    A guard written as "these four sites are escaped" has the same shape as the defect: it is a
    statement about today's module. So the subject set is DERIVED by walking the module's AST for
    every CONSTRUCTION of `XeniumImportError`, and each interpolation must be PROVED safe: either
    it goes through a funnel, or its SHAPE cannot carry a vendor byte.

    The base this branch was cut from measured 35 unprovable interpolations across 28 refusal
    sites (scoutB's enumeration). Against this branch: 0, across 28.

    `read_text(encoding="utf-8")` is EXPLICIT: the locale default silently fails on a file with
    non-ASCII bytes under `LC_ALL=C` — and this module's own prose carries em dashes — so a guard
    reading at the default would raise or skip and this file's whole point would evaporate on
    exactly the machine #329's own control exists for (#333/#339/#330 all shipped this class of
    hole).

    This test would FAIL with the fix reverted: the base module reports 35 unprovable
    interpolations, so `unsafe_interpolations` would not be empty.
    """
    source = COMPUTE.read_text(encoding="utf-8")
    RS.assert_module_is_funnelled(source)

    _tree, sites = RS.refusal_sites(source)
    assert len(sites) >= 28, (
        f"only {len(sites)} `raise {RS.REFUSAL}` sites found; the base had 28. A parser that "
        f"suddenly matches far fewer is a parser that stopped matching, not a module that got "
        f"safer"
    )

    unsafe = RS.unsafe_interpolations(source)
    assert unsafe == [], "refusals interpolate values that are not provably safe:\n" + "\n".join(
        f"  {COMPUTE.name}:{line}  {expr}\n      -> {why}" for line, expr, why in unsafe
    )


def test_TEST_12_the_guard_GOES_RED_on_a_refusal_it_has_never_seen():
    """TEST-12 [acceptance INV-4] — a guard whose failure mode is never exercised has none.

    TEST-11 passing proves the module is clean. It does NOT prove the guard can SEE a violation —
    a classifier with a bug that made everything "safe" would pass it just as green. So the
    classifier is run over synthetic modules, each holding a refusal a list of today's sites
    could not possibly cover, and each must come back UNSAFE:

    * a brand-new refusal in a brand-new function (the case #343 is actually about);
    * the `%` and `.format()` spellings, which an f-string-only guard walks straight past;
    * a value laundered through a local variable, an accumulator, a walrus, an `except as` name,
      a subscript, and a SUBCLASS of the refusal;
    * a value arriving as a function PARAMETER from a hostile call site — the shape that makes
      the internal-prose parameters safe, running in reverse.

    And the integrity legs: a module with no refusal at all must RAISE rather than report
    "0 unsafe", a module missing the funnels must RAISE rather than checking against nothing, and
    a funnel defined TWICE must RAISE (the last definition wins at import time, so a routing
    guard keeps passing while every refusal calls something else entirely).

    This test would FAIL if the guard could not see a violation — it is the guard's own tripwire.

    DECLARED VACUOUS against the shipped module: this test's subject is the CLASSIFIER, not
    `compute/import_xenium.py`. It never reads the shipped module — every module it runs the
    classifier over is SYNTHETIC, built here — so it stays GREEN with the escaping fix reverted
    (MEASURED against `1e94c77d2`). That is by design: it proves the guard reddens on refusal
    shapes that do not exist yet, which is the property `test_TEST_11_...` cannot prove about
    itself. The test that holds the shipped module is TEST-11.
    """
    preamble = textwrap.dedent(
        '''
        class XeniumImportError(RuntimeError):
            pass

        def _quoted_for_refusal(value, focus=None, *, noun="path"):
            return ascii(value)

        def _quoted_list_for_refusal(values, noun="value"):
            return "[]"
        '''
    )
    hostile = {
        # --- the case #343 is actually about: a refusal that did not exist when the guard was
        #     written, in a function that did not exist either.
        "a new refusal in a new function": """
def brand_new_check(vendor_name):
    raise XeniumImportError(f"the bundle declares {vendor_name}, which is wrong.")
""",
        # --- spellings an f-string-only guard walks straight past.
        "the %-format spelling": """
def pct(vendor_name):
    raise XeniumImportError("the bundle declares %s, which is wrong." % vendor_name)
""",
        "the .format() spelling": """
def fmt(vendor_name):
    raise XeniumImportError("the bundle declares {}, which is wrong.".format(vendor_name))
""",
        "concatenation": """
def cat(vendor_name):
    raise XeniumImportError("the bundle declares " + vendor_name + ", which is wrong.")
""",
        # --- laundering the value through a binding.
        "laundered through a local": """
def laundered(vendor_name):
    shown = vendor_name
    raise XeniumImportError(f"the bundle declares {shown}, which is wrong.")
""",
        "an accumulator filled by .append": """
def acc(names):
    shown = []
    for c in names:
        shown.append(c)
    raise XeniumImportError(f"Found {shown}.")
""",
        "a walrus": """
def viawalrus(vendor_name):
    raise XeniumImportError(f"bad {(shown := vendor_name)}.")
""",
        "an `except ... as` name": """
def viaexc(path):
    try:
        open(path)
    except OSError as exc:
        raise XeniumImportError(f"cannot read it ({exc}).")
""",
        "subscript assignment into a literal list": """
def acc6(names):
    shown = ["x"]
    shown[0] = names[0]
    raise XeniumImportError(f"Found {shown}.")
""",
        "a hostile call site for a would-be prose parameter": """
def refuse(what):
    raise XeniumImportError(f"the bundle has no {what}.")

def caller(vendor_name):
    refuse(vendor_name)
""",
        "an unquoted element of a list": """
def viaseq(names):
    raise XeniumImportError(f"found {sorted(names)}.")
""",
        # --- refusal spellings the SITE FINDER must not miss.
        "constructed into a variable, then raised": """
def viavar(vendor_name):
    err = XeniumImportError(f"bad {vendor_name}.")
    raise err
""",
        "raised through an alias": """
Refusal = XeniumImportError

def viaalias(vendor_name):
    raise Refusal(f"bad {vendor_name}.")
""",
        "a SUBCLASS of the refusal": """
class MyErr(XeniumImportError):
    pass

def ok():
    raise XeniumImportError("a fixed sentence.")

def f(vendor_name):
    raise MyErr(f"bad {vendor_name}.")
""",
        "an attribute that happens to be called `size`": """
def viasize(value):
    raise XeniumImportError(f"bad {value.size}.")
""",
        "a shadowed `len`": """
def len(x):
    return x

def vialen(vendor_name):
    raise XeniumImportError(f"bad {len(vendor_name)}.")
""",
        "a vendor value as the funnel's `noun=`": """
def vianoun(vendor_name):
    raise XeniumImportError(f"bad {_quoted_for_refusal(1, noun=vendor_name)}.")
""",
        "a vendor value as the f-string format spec": """
def f(vendor_name):
    raise XeniumImportError(f"bad {0:{vendor_name}}.")
""",
    }
    for label, body in hostile.items():
        unsafe = RS.unsafe_interpolations(preamble + body)
        assert unsafe, f"the guard did NOT flag {label!r} — it cannot see this violation"

    # The SAFE twin, so the guard is not merely "flags everything" — a guard that refuses every
    # spelling is a guard that gets deleted. Every safe shape the module actually uses is here:
    # a module constant, a prose parameter proved literal at its only call site, a `len()`, a
    # walrus, and both funnels with a literal `noun=`.
    safe = preamble + '''
BASENAME = "cell_feature_matrix.h5"

def refuse(what):
    raise XeniumImportError(f"the bundle has no {what} in {BASENAME}.")

def caller(vendor_name, values, exc):
    refuse("cells table")
    if vendor_name:
        raise XeniumImportError(
            f"{BASENAME} declares {_quoted_for_refusal(vendor_name, noun='identifier')} across "
            f"{(n := len(values))} entries: {_quoted_list_for_refusal(values)} "
            f"({_quoted_for_refusal(type(exc).__name__, noun='type name')})."
        )
'''
    assert RS.unsafe_interpolations(safe) == [], RS.unsafe_interpolations(safe)

    # FALSE POSITIVES are how a guard gets weakened, so the shapes it must NOT refuse are pinned
    # too. The walrus was a real one — provably safe by the checker's own rules and refused for
    # want of an `ast.NamedExpr` arm.
    for label, body in {
        "a walrus over a len()": 'def f(v):\n    raise XeniumImportError(f"bad {(n := len(v))}.")\n',
        "a nested funnel call": (
            'def f(v):\n'
            '    raise XeniumImportError(f"bad {_quoted_list_for_refusal([_quoted_for_refusal(v)])}.")\n'
        ),
        "a conditional over two literals": (
            'def f(flag):\n'
            '    raise XeniumImportError(f"bad {\'a\' if flag else \'b\'}.")\n'
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

    # Integrity leg 3: a funnel defined TWICE. The last definition wins at import time, so a
    # routing guard keeps passing while every refusal calls something else entirely.
    redefined = preamble + (
        "\ndef _quoted_for_refusal(value, focus=None, *, noun=\"path\"):"
        "\n    return value\n"
    )
    with pytest.raises(AssertionError, match="defined more than once"):
        RS.assert_module_is_funnelled(redefined)

    # Integrity leg 4: a funnel that no longer escapes. A FLOOR, not a proof — what the funnel
    # DOES is proved by TEST-10 and by the entrypoint tests, because no AST walk observes
    # behaviour. This makes gutting it a deliberate act, not one word.
    with pytest.raises(AssertionError, match="no longer calls"):
        RS.assert_module_is_funnelled(preamble.replace("return ascii(value)", "return value"))


def test_TEST_13_the_widening_did_not_MOVE_329s_own_bytes():
    r"""TEST-13 — the #343 widening must not move a message #329 already shipped to operators.

    #329 shipped `_quoted_for_refusal` and routed the parse-boundary refusal's values through
    it. #343 changed the funnel's signature (added `noun=`) and changed the #329 call site from
    `_quoted_for_refusal(text, at)` to `_quoted_for_refusal(text, int(at))`. The property that
    the widening did not MOVE the bytes of the messages #329 already shipped is asserted nowhere
    — this is that assertion.

    `int()` on an already-int `exc.start` is a no-op, and `str`/`bytes` are deliberately left
    uncoerced, so for the shapes #329 ships the output is byte-identical to `ascii(value)`:

    * a short `str` and a short `bytes` value return `ascii(value)` exactly;
    * a long value with no `focus` returns the exact tail-clip sentence;
    * a long value with `focus` returns the exact focus-window sentence.

    The focus sentence MOVED in #343 by design — it gained the noun — while the `str`/`bytes`
    and tail-clip outputs did not.
    """
    module = XF.load_compute()
    quote = module._quoted_for_refusal

    # (a) the `str` and `bytes` shapes #329 ships, byte-identical to `ascii(value)`.
    for value in ("a lone \ud800 surrogate", b"\xff\xfeSR"):
        assert quote(value) == ascii(value), (value, quote(value))

    # (b) the exact tail-clip sentence, unchanged by #343.
    long = "a" * 500
    assert quote(long) == (
        f"{ascii('a' * 120)} (the last 120 of 500 characters of the path)"
    ), quote(long)

    # (c) the exact focus-window sentence. This is the sentence that MOVED in #343 by design:
    #     it gained the noun ("characters of the path") while the numbers stayed put.
    assert quote(long, 100) == (
        f"{ascii('a' * 120)} (a 120-unit window at offset 60 of 500 characters of the "
        "path; the offending unit is at 100)"
    ), quote(long, 100)


# ── TEST-14: the list funnel's `noun=` at a LIVE call site ─────────────────────────────


def _long_nested_copy(bundle, basename, *, component="d", depth=3):
    """Copy `basename` into nested ASCII dirs whose RELATIVE PATH exceeds the clip.

    Each component is 40 ASCII characters, far under NAME_MAX (255 bytes), and the whole
    path is plain ASCII so the directory is creatable under ANY locale — the two existing
    tests that fail under `LC_ALL=C` do so because they rely on non-ASCII names, and this
    one must not be a third.
    """
    nest = bundle
    for _ in range(depth):
        nest = nest / (component * 40)
    nest.mkdir(parents=True)
    shutil.copy(bundle / basename, nest / basename)
    rel = str((nest / basename).relative_to(bundle))
    assert len(rel) > 120, f"the nested path must exceed the 120-unit clip: {len(rel)}"
    return rel


@pytest.mark.parametrize("site", ["one", "at_most_one"])
def test_TEST_14_the_list_funnels_noun_is_pinned_at_a_LIVE_site(tmp_path, site):
    r"""TEST-14 — the END-TO-END pin for the list funnel's `noun=` at a live call site.

    TEST-10 checks the funnels' `noun=` only through DIRECT calls with explicit nouns, and
    TEST-13 checks the SCALAR funnel's DEFAULT noun. Neither drives the LIST funnel's
    `noun=` through the shipped entrypoint, so the `noun='path'` at `_one`'s and
    `_at_most_one`'s `matches[:3]` sites was never exercised by a live refusal.

    MEASURED, before this test existed: reverting `noun='path'` to `noun='file name'` at
    the `_one` site left the WHOLE suite green (exit 0). Nothing caught it — and a false
    noun is false PROSE shown to an operator, not a cosmetic detail: the refusal would
    claim it clipped "characters of the file name" when the value it clipped is a PATH.

    WHY nothing caught it: the `noun` only reaches the message through the funnel's CLIP
    SENTENCE ("... the last 120 of N characters of the {noun}"), and that sentence is
    produced only when a value exceeds `_REFUSAL_QUOTE_CHARS` (120). The two tests that
    drive the `_one`/`_at_most_one` ambiguity refusal (TEST-1 and TEST-7) use paths of 226
    bytes and 101 characters — BOTH under the clip — so the noun never appears in any
    asserted output. This test therefore builds the ambiguous file under NESTED ASCII
    directories whose RELATIVE PATH exceeds 120 characters, so the clip sentence is
    actually produced, and asserts on the captured stderr BYTES that it names the value
    correctly: `characters of the path`, never `characters of the file name`.

    BOTH sites are reachable through the shipped entrypoint with the committed fixtures:
    `_one` via a second `cell_feature_matrix.h5` (fires in `locate_members`, before any
    progress), and `_at_most_one` via two `cell_boundaries.parquet` (fires late in
    `run_import`, after the full pipeline). Each is its own parametrisation.

    This test would FAIL with the fix reverted: the clip sentence would say
    `characters of the file name`.
    """
    bundle = _copy(tmp_path, f"noun-{site}")
    if site == "one":
        _long_nested_copy(bundle, "cell_feature_matrix.h5")
    else:
        shutil.copy(bundle / "experiment.xenium", bundle / "cell_boundaries.parquet")
        _long_nested_copy(bundle, "cell_boundaries.parquet", component="e")

    result = XF.run_entry_bytes(bundle, tmp_path / f"out-{site}" / "outputs")

    assert result.returncode == 2, (result.returncode, result.stderr[-2000:])
    row = _assert_safe_to_log(result)
    # The clip sentence is produced ONLY because the nested path exceeds the clip, and it
    # must name the value correctly — the whole point of the `noun=` the widening added.
    assert b"characters of the path" in row, row[:400]
    assert b"characters of the file name" not in row, row[:400]
