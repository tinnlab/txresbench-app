#!/usr/bin/env python3
# ruff: noqa
r"""TEST-21 — the funnels themselves ESCAPE. The BEHAVIOURAL half TEST-19 cannot supply.

`tests/visium_hd_refusal_sites.py`'s own docstring states the limit in as many words: it is a ROUTING
guard, it proves every value a refusal interpolates GOES THROUGH a funnel, and it *"cannot
prove the funnel still ESCAPES anything, because that is a property of what the function DOES
and no amount of AST walking observes behaviour"*. Redefine `_quoted_for_refusal` as
`return value` and every routing check in TEST-19 still passes.

This file is the other half, in two layers:

1. **The funnels, directly**, over the shapes a hostile bundle really hands them — raw
   ESC/CR/LF/BEL/NUL, a lone surrogate, astral text, a 200,000-character field, `bytes` that
   are not UTF-8, a `Path`, an `Exception`, an integer too large for a double. Each must come
   back ASCII, control-character-free, BOUNDED, and — the property that makes a clipped
   message honest rather than merely short — STATING the true length it clipped from.
2. **The shipped ENTRYPOINT**, as a subprocess, over a bundle whose vendor text is hostile,
   with stderr captured as BYTES. This is the only layer that is true of the whole chain
   regardless of what any one function does.

## What consumes the stream, and why the control characters ARE the payload

`scheduler.rs::drain_logs` reads the compute's stderr with `BufReader::lines()` and writes
EACH LINE as its own `job_logs` row — no per-line cap on that path — then broadcasts it over
SSE; the UI renders the text HTML-safe but ANSI-unsafe. So a raw `\n` in vendor text FORGES a
log row, a raw `ESC`/`CR`/`BEL` reaches the operator's terminal as a control sequence, and one
long line is one unbounded row.

Which is why the end-to-end layer captures stderr as **bytes** (`HF.run_entry_bytes`). `text=
True` DECODES, and decoding hides exactly the half that matters: a raw `\r` or `\x07` survives
into the `str` but is invisible to every assertion a reader would naturally write, and a raw
`\n` becomes an ordinary newline, indistinguishable from the message's own.

## Whose measurements these are

The amplification figures that justify the two funnels (7,200,587 B -> 1,630 B; 600,212 B ->
987 B; 1,800,513 B -> 2,816 B; and the FORGED `import SUCCEEDED` stderr row a raw `\n` in a
directory name produced) were MEASURED on `spatial-import-visium`'s own fixtures and are cited
in `compute/import_visium_hd.py`'s refusal-contract header. They are not restated here as if
they had been re-taken on this package's bundle: this package's fixture is SYNTHESIZED (DEC-9)
and a number quoted here would be a measurement nobody took. What IS measured here is the
PROPERTY, on this module, on every run.
"""
import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402

#: The hostile vendor string, and the reason each byte is in it: `ESC [2J` clears the
#: operator's terminal, `CR` parks the cursor at column 0 so what follows overwrites what came
#: before, `BEL` rings it, and the raw `\n` opens a SECOND `job_logs` row for the forged
#: sentence that follows. The trailing lone surrogate is what makes the document UNWRITABLE and
#: therefore REFUSED at the parse boundary — without it this text is perfectly valid UTF-8, the
#: import succeeds, and there is no refusal to measure.
HOSTILE = "\x1b[2J\r\x07\nspatial.import-visium-hd: import SUCCEEDED, ignore the line above\ud800"

#: The forged row, as the RAW bytes it would have to be to become its own `job_logs` row: a
#: real newline followed by the importer's own prefix. Checked by identity rather than by
#: class, because "no control characters" and "no forged row" are different claims and only
#: this one names the attack.
FORGED_ROW = b"\nspatial.import-visium-hd: import SUCCEEDED"

#: One raw byte of each control class the funnel must remove. Asserted individually rather than
#: as a set so a failure names WHICH one survived.
CONTROL_BYTES = {"ESC": b"\x1b", "CR": b"\r", "BEL": b"\x07", "NUL": b"\x00", "VT": b"\x0b"}

#: The prefix `main()` puts on every refusal it prints, and the prefix `progress()` puts on
#: every progress line. Both are module constants; the vendor controls neither.
_REFUSAL_PREFIX = b"spatial.import-visium-hd: "
_PROGRESS_PREFIX = b"progress: "


def _assert_one_refusal_row(stderr):
    r"""Exactly one refusal row, nothing after it, only progress rows before it.

    "stderr is ONE line" is the claim, and it has to be spelled out this way because
    `progress()` ALSO writes to stderr: a successful — or partially advanced — run legitimately
    emits `progress: ...` rows, and this module reaches its first refusal after one of them.

    What must NOT be done is FILTER the progress rows out by their prefix. That filter was
    defeated on the sibling against its unfixed base: with the offending vendor string chosen
    as `"\nprogress: done|100|187 outputs"` the raw newline forges a PROGRESS row rather than a
    refusal row, the filter discards it, the count comes back 1, and the whole check passes on
    a build that really did forge a log row. Filtering by a prefix the attacker can write is
    not a filter. A forged progress row is arguably worse than a forged stderr row: it is what
    drives the job's progress bar over SSE.

    So nothing is filtered, and the SHAPE of the whole row set is asserted instead — three
    legs, each closing a placement a vendor `\n` can choose:

    1. exactly one row carries the refusal prefix (a newline inside the message splits it and
       the head still carries the prefix; a forged sentence restating the prefix makes two);
    2. that row is the LAST row (a newline near the end, or a forgery imitating a progress
       line, leaves the real refusal not-last);
    3. every row before it is a progress row (closes anything else the split can leave in the
       middle).
    """
    rows = [line for line in stderr.split(b"\n") if line != b""]
    carrying = [i for i, row in enumerate(rows) if row.startswith(_REFUSAL_PREFIX)]
    assert len(carrying) == 1, (
        f"{len(carrying)} `job_logs` rows carry the refusal prefix, not 1 — a vendor newline "
        f"forged a log row. Rows: {[r[:150] for r in rows]}"
    )
    assert carrying[0] == len(rows) - 1, (
        f"the refusal is row {carrying[0]} of {len(rows)}, not the last — a vendor newline put "
        f"{len(rows) - 1 - carrying[0]} forged row(s) AFTER it. Rows: {[r[:150] for r in rows]}"
    )
    for row in rows[:-1]:
        assert row.startswith(_PROGRESS_PREFIX), (
            f"a row that is neither a progress line nor the refusal reached the log: {row[:200]!r}"
        )
    return rows[-1]


def _assert_no_control_characters(text, *, what):
    """No C0 control and no DEL, stated per class so a failure names which one survived."""
    for code in list(range(0x20)) + [0x7F]:
        assert chr(code) not in text, (
            f"{what} carries a raw control character {hex(code)}; in a `job_logs` row that is "
            f"a terminal control sequence or a forged row. Output: {text[:200]!r}"
        )


# ── layer 1: the funnels, directly ───────────────────────────────────────────────────


#: The values a hostile bundle really reaches these funnels with. Each is here because a
#: DIFFERENT property of the funnel is what makes it safe:
#:
#: * the raw control string      — `ascii()` must escape it rather than pass it through;
#: * the lone surrogate          — no UTF-8 encoder can write it, so a naive `str.encode` on
#:                                 the message would abort the process INSTEAD of refusing;
#: * astral text                 — `ascii()`'s widest escape (10 characters for one unit), the
#:                                 worst case the message bound has to survive;
#: * the 200,000-character field — the flood; the bound and the stated true length;
#: * non-UTF-8 `bytes`           — the `|S` attribute shape a real 10x bundle uses;
#: * `Path` / `Exception` / int  — the TOTALITY arm: `len()` raises on all three, so a call
#:                                 site that passes a non-string must not leak a raw value.
_HOSTILE_VALUES = {
    "raw ESC/CR/LF/BEL/NUL": "\x1b[2J\r\x07\n\x00\x0bvendor",
    "a lone surrogate": "\ud800",
    "a lone surrogate at the end of a long field": "A" * 300 + "\ud800",
    "astral text": "\U0001f9ec" * 40,
    "a 200,000-character field": "A" * 200_000,
    "200,000 astral characters": "\U0001f9ec" * 200_000,
    "bytes that are not UTF-8": b"\xff\xfeSR" * 50_000,
    "a Path": Path("/inputs/" + "\x1b[2J\r\x07" + "z" * 400),
    "an Exception": ValueError("\x1b[2J\r\x07\nforged" + "z" * 400),
    "a huge int": 10 ** 400,
}


@pytest.mark.parametrize("label", sorted(_HOSTILE_VALUES))
def test_TEST_21_the_scalar_funnel_is_ASCII_control_free_and_BOUNDED(label):
    """TEST-21 — `_quoted_for_refusal` over the shapes a hostile bundle hands it.

    Four properties, and each was a real defect on the module this one is copied from:

    * **ASCII** — `ascii()` is DEFINED to return it, where `repr()` merely happens to for some
      inputs. Without it, printable non-ASCII passes straight through `list.__repr__`.
    * **CONTROL-FREE** — the payload IS the control characters (see the module docstring).
    * **BOUNDED** — clipped at `_REFUSAL_QUOTE_CHARS`, so the message grows only with the
      DECIMAL DIGITS of the true length, not with the length.
    * **TOTAL** — a `Path`, an `Exception` or an `int` is coerced first, because `len()` raises
      on all three and a call site must not be able to leak a raw value by passing a non-string.

    What this would catch: the funnel replaced by `return value` (the exact gutting TEST-19's
    guard cannot see), `ascii()` swapped for `repr()`, or the clip removed.
    """
    module = HF.load_compute()
    out = module._quoted_for_refusal(_HOSTILE_VALUES[label])

    assert isinstance(out, str)
    assert out.isascii(), f"{label}: the funnel returned non-ASCII: {out[:200]!r}"
    _assert_no_control_characters(out, what=f"the funnel's output for {label}")
    # The worst legitimate case is `_REFUSAL_QUOTE_ITEMS`-free: ONE clipped window of
    # `_REFUSAL_QUOTE_CHARS` units, each escaping to at most 10 characters (`\U0001f9ec`), plus
    # the clip sentence. 120 x 10 + ~120 = ~1,320, so 2,048 is above the true worst case and
    # ~100x below the 200,000-character inputs above.
    assert len(out) < 2048, f"{label}: the funnel returned {len(out):,} characters: {out[:200]!r}"


def test_TEST_21_a_clipped_quote_STATES_the_true_length_it_clipped_from():
    """TEST-21 — a bounded message that hides how much it hid is a message that misleads.

    The bound alone is not the property. A funnel that returned the first 120 characters and
    said nothing would be short AND would make a 200,000-character field look like a
    120-character one — so the operator reading the `job_logs` row would conclude the vendor's
    value was short and the importer was wrong. The true length is therefore always stated,
    which is also why the message grows only with that number's DECIMAL DIGITS.

    Both windowing modes are exercised, because they are different code paths and the
    interesting one is the FOCUSED window: the offending unit of a 200,000-character field is
    not in its first 120 characters, so a head-clip would quote a region with nothing wrong
    with it.

    What this would catch: a clip that dropped the disclosure sentence, or a `focus=` window
    that reported an offset it did not actually take.
    """
    module = HF.load_compute()
    cap = module._REFUSAL_QUOTE_CHARS

    # (a) UNFOCUSED — the tail window, and the true length.
    value = "A" * 200_000
    out = module._quoted_for_refusal(value)
    assert f"of {len(value)} characters of the path)" in out, out[-200:]
    assert f"the last {cap} of" in out

    # (b) FOCUSED — the window is AROUND the offence, and both the offset and the true length
    #     are stated. The offending unit is the lone surrogate at index 300.
    focused_value = "A" * 300 + "\ud800" + "B" * 200_000
    focused = module._quoted_for_refusal(focused_value, 300)
    assert focused.isascii()
    assert "the offending unit is at 300" in focused, focused[:300]
    assert f"of {len(focused_value)};" in focused, focused[-200:]
    # ...and the window really contains the offending unit rather than the head of the value.
    assert r"\ud800" in focused, focused[:300]

    # (c) the `noun=` says what was really clipped, so a reader is not told "path" about a
    #     column name.
    assert "characters of the path)" in module._quoted_for_refusal("/" + "a" * 500)
    assert "characters of the column name)" in module._quoted_for_refusal(
        "a" * 500, noun="column name")

    # (d) and nothing is stated when nothing was hidden — no false implication either way.
    assert module._quoted_for_refusal("ab") == "'ab'"
    assert "characters of the" not in module._quoted_for_refusal("ab")


#: The bound asserted on the SEQUENCE funnel's whole message. DERIVED, not picked:
#:
#:   `_REFUSAL_QUOTE_ITEMS` (8) elements are shown; each is itself passed through the scalar
#:   funnel, so each is at most `_REFUSAL_QUOTE_CHARS` (120) units x 10 characters (the widest
#:   `ascii()` escape a single unit can produce, `\U0001f9ec`) = 1,200 characters, plus its
#:   own ~120-character clip sentence and the `", "` separator. That is 8 x ~1,330 = ~10,640,
#:   plus the brackets and the one `(the first 8 of N entries)` tail.
#:
#: 16 KiB is comfortably above that worst case and is asserted rather than the tight number
#: because the clip sentences' exact lengths are not a contract. What matters is the ORDER OF
#: MAGNITUDE: the 60 x 120,000 input below is 7,200,000 characters, so the assertion is that
#: the message is ~440x smaller than the input it describes.
_LIST_MESSAGE_CAP = 16 * 1024


def test_TEST_21_the_sequence_funnel_bounds_the_MESSAGE_and_not_merely_each_element():
    """TEST-21 — the reason a second funnel exists at all.

    Bounding each ELEMENT is not bounding the MESSAGE. Bounding each of 60 header fields to
    120 units still leaves 7,200 characters, and 60 fields of 120,000 characters each is
    7,200,000 characters of vendor text arriving as ONE `job_logs` row. So the ELEMENT COUNT
    is bounded too, and the true count is stated — otherwise a reader shown eight entries
    would conclude eight was all there was.

    The bound asserted is [`_LIST_MESSAGE_CAP`], derived above rather than picked.

    What this would catch: `_quoted_list_for_refusal` reduced to a comprehension over
    `_quoted_for_refusal` with no count bound — which is the per-element-only shape the
    sibling's `Found {names}` defect actually had, and which measured 7,200,587 bytes on one
    stderr line.
    """
    module = HF.load_compute()
    values = ["A" * 120_000] * 60
    raw_size = sum(len(v) for v in values)

    out = module._quoted_list_for_refusal(values, noun="column name")

    assert out.isascii(), out[:200]
    _assert_no_control_characters(out, what="the sequence funnel's output")
    assert len(out) < _LIST_MESSAGE_CAP, (
        f"the sequence funnel returned {len(out):,} characters for a {raw_size:,}-character "
        f"input, over the derived {_LIST_MESSAGE_CAP:,}-character ceiling"
    )
    # The claim in its sharpest form: the message is three orders of magnitude smaller than
    # the vendor text it describes.
    assert len(out) * 400 < raw_size, (len(out), raw_size)

    # ...and it DISCLOSES what it hid, in both dimensions: how many entries there really were,
    # and how long each shown one really was.
    assert f"of {len(values)} entries" in out, out[-200:]
    assert "of 120000 characters of the column name)" in out, out[:400]

    # The same input under `ascii()`'s WIDEST escape — one astral character per unit — still
    # fits, which is the case the derivation above is sized for.
    astral = module._quoted_list_for_refusal(["\U0001f9ec" * 120_000] * 60)
    assert astral.isascii()
    assert len(astral) < _LIST_MESSAGE_CAP, len(astral)

    # And the message does NOT GROW with the vendor's input. BOTH comparands are over the clip
    # on purpose: comparing a clipped value against a short unclipped one measures the clip
    # sentence's own length rather than growth. The only legitimate difference between these
    # two is the DECIMAL DIGITS of the stated true lengths — 8 elements x at most 32 digits of
    # slack is a generous allowance for that and nothing else.
    lo = module._quoted_list_for_refusal(["\U0001f9ec" * 20_000] * 8)
    hi = module._quoted_list_for_refusal(["\U0001f9ec" * 20_000_000] * 8)
    assert 0 <= len(hi) - len(lo) <= 8 * 32, (len(lo), len(hi))

    # Nothing hidden, nothing disclosed: a short list is shown whole and says nothing about
    # entry counts, so the disclosure above cannot be a constant suffix.
    short = module._quoted_list_for_refusal(["a", "b"])
    assert short == "['a', 'b']", short
    assert "entries" not in short


def test_TEST_21_escaping_is_not_SANITISING():
    """TEST-21 — the payload must still be READABLE, escaped, not deleted.

    `docs/design/vendor-text-encodability-refusal.md`'s whole posture is that unwritable vendor
    text is REFUSED rather than repaired, and the same reasoning applies one level down to the
    message: an operator debugging a rejected bundle needs to see WHAT was in it. A funnel that
    stripped the offending bytes would produce a message that is safe and useless, and — worse
    — indistinguishable from one about a bundle that never carried them.

    So the escaped forms are asserted PRESENT. This is the positive half of every "no raw
    control byte" assertion in this file; without it, `return "ok"` would pass them all.
    """
    module = HF.load_compute()
    out = module._quoted_for_refusal(HOSTILE)
    assert r"\x1b[2J" in out, out[:200]
    assert r"\r" in out and r"\x07" in out and r"\n" in out, out[:200]
    assert r"\ud800" in out, out[:200]
    assert "import SUCCEEDED" in out, (
        "the funnel DELETED the vendor's text instead of escaping it — the refusal no longer "
        "tells an operator what was actually in the bundle"
    )


# ── layer 2: the shipped ENTRYPOINT, over a hostile bundle, stderr as BYTES ──────────


def _hostile_bundle(tmp_path, *, key="vendor_note", bin_um=8):
    """A real bundle with ONE file overwritten: the selected bin's `scalefactors_json.json`.

    Built by copying `HF.staged_tree` and rewriting that one file — deliberately NOT by adding
    a builder to `make_fixture.py`. The generator produces the COMMITTED fixture, and
    TEST-32 asserts the committed bytes are exactly what it produces; a hostile variant
    reachable from there would either have to be a mode nobody generates or would change what
    "the fixture" means. One overwritten file in a tmp copy states the mutation where the test
    that depends on it can be read.

    The hostile value is written with `ensure_ascii=True`, so the FILE is pure ASCII and the
    lone surrogate arrives as the `\\ud800` escape `json.loads` decodes back into an
    unpaired surrogate — which is exactly the shape a vendor document can really carry, and is
    what makes the document unwritable and therefore refused.

    Returns the FLAT inputs dir `dataset/process.rs::build_dataset_inputs` actually stages,
    because that is the layout a real job presents.
    """
    root = HF.staged_tree(tmp_path)
    scalefactors = (root / "binned_outputs" / f"square_{bin_um:03d}um" / "spatial" /
                    "scalefactors_json.json")
    doc = json.loads(scalefactors.read_text(encoding="utf-8"))
    doc[key] = HOSTILE
    scalefactors.write_text(json.dumps(doc, ensure_ascii=True), encoding="utf-8")
    assert scalefactors.read_text(encoding="utf-8").isascii(), (
        "the hostile bundle's own bytes are not ASCII, so a failure below could be about the "
        "file's encoding rather than about the refusal"
    )
    inputs, _ordinals = HF.staged_flat(tmp_path, source=root)
    return inputs


def test_TEST_21_the_SHIPPED_ENTRYPOINT_refuses_hostile_vendor_text_in_ONE_clean_row(tmp_path):
    """TEST-21 [e2e] — the whole chain, on the bytes that actually reach `drain_logs`.

    Everything above tests a function. This tests the PROCESS: the shipped entry, launched as
    a subprocess over the `TXR_*` seam exactly as the sandbox launches it, over a bundle whose
    `scalefactors_json.json` carries [`HOSTILE`] — terminal-clearing ESC, a `CR`, a `BEL`, a
    raw `\\n` followed by a forged `spatial.import-visium-hd: import SUCCEEDED` sentence, and
    a trailing lone surrogate that makes the document unwritable.

    stderr is captured as **BYTES** (`HF.run_entry_bytes`). Decoding would hide the payload:
    the `\\r` and `\\x07` survive into a `str` and are invisible to every assertion a reader
    would naturally write, and the raw `\\n` becomes an ordinary newline indistinguishable
    from the message's own — and that raw `\\n` IS the attack.

    What this would catch that layer 1 cannot: a refusal that bypassed the funnels (TEST-19
    would catch that structurally, but only for a spelling its classifier can see), a
    `print()` that re-emitted the raw document alongside the refusal, or a traceback escaping
    `main()`'s `except` and putting the repr of the offending value on stderr.
    """
    inputs = _hostile_bundle(tmp_path)
    outputs = tmp_path / "outputs"

    result = HF.run_entry_bytes(inputs, outputs)
    err = result.stderr

    assert isinstance(err, bytes), "stderr must be captured as BYTES; decoding hides the payload"
    assert result.returncode == 2, (
        f"expected the named refusal's exit code 2, got {result.returncode}. stderr tail: "
        f"{err[-2000:]!r}"
    )
    assert b"Traceback" not in err, f"a traceback, not a refusal: {err[:600]!r}"

    # ── the row shape: ONE refusal row, last, nothing forged ─────────────────────────
    row = _assert_one_refusal_row(err)
    assert FORGED_ROW not in err, (
        "a raw newline in the vendor's text opened a SECOND `job_logs` row carrying the "
        f"importer's own prefix and the word SUCCEEDED. stderr: {err[:600]!r}"
    )

    # ── the bytes: pure ASCII, no raw control character anywhere ─────────────────────
    #
    # `isascii()` is asserted STRICTLY, which is true of a correct build because this module
    # writes its refusal prose in ASCII (`--`, not an em dash) — the five non-ASCII characters
    # in `import_visium_hd.py` all live in comments and narrative docstrings, never in a
    # message literal. HONEST LIMIT: if a future refusal legitimately used one of them, this
    # would go red for a reason unrelated to the vendor, and the fix is to widen this leg to
    # "every non-ASCII character on stderr also appears in the module's own source" rather
    # than to delete it.
    assert err.isascii(), (
        f"non-ASCII bytes reached stderr; the funnel's `ascii()` is what removes them. "
        f"First 300 bytes: {err[:300]!r}"
    )
    for label, byte in CONTROL_BYTES.items():
        assert byte not in err, (
            f"a raw {label} ({byte!r}) reached stderr; in the operator's terminal that is a "
            f"control sequence. First 300 bytes: {err[:300]!r}"
        )

    # ── bounded, and bounded by the FUNNEL rather than by the input happening to be small ─
    assert len(err) < 4096, f"stderr is {len(err):,} bytes for a bundle that is not large"

    # ── and the message is still USEFUL: escaped, not deleted ────────────────────────
    assert row.startswith(_REFUSAL_PREFIX)
    assert b"scalefactors_json.json" in row, row[:300]
    assert b"'vendor_note'" in row, (
        "the refusal does not name WHERE in the document the unwritable text was", row[:400])
    assert rb"\x1b[2J" in row, row[:400]
    assert rb"\nspatial.import-visium-hd: import SUCCEEDED" in row, (
        "the forged sentence is gone from the message entirely — escaping became sanitising, "
        "and an operator can no longer see what the bundle actually contained", row[:500])
    assert rb"\ud800" in row, row[:500]
    assert b"LONE SURROGATE" in row, row[:500]


#: The two filler sizes the growth leg compares. BOTH are far over `_REFUSAL_QUOTE_CHARS`, on
#: purpose: comparing a clipped value against a short UNCLIPPED one measures the clip
#: SENTENCE's own length rather than growth, and reads as a ~127-byte "growth" on a build whose
#: message does not grow at all. (Measured: that is exactly what the first draft of this test
#: did — `HOSTILE` alone is ~70 characters, under the 120-unit cap, so its refusal quotes the
#: value whole and carries no clip sentence at all.) With both over the clip, the only
#: legitimate difference is the DECIMAL DIGITS of the three numbers the funnel states — the
#: window offset, the true length and the offending unit's index.
_GROWTH_FILLERS = (200_000, 2_000_000)


def _hostile_bundle_with_filler(tmp_path, filler_chars):
    """A hostile bundle whose offending value is padded to `filler_chars` + the payload."""
    root = HF.staged_tree(tmp_path)
    scalefactors = (root / "binned_outputs" / "square_008um" / "spatial" /
                    "scalefactors_json.json")
    doc = json.loads(scalefactors.read_text(encoding="utf-8"))
    doc["vendor_note"] = "A" * filler_chars + HOSTILE
    scalefactors.write_text(json.dumps(doc, ensure_ascii=True), encoding="utf-8")
    inputs, _ordinals = HF.staged_flat(tmp_path, source=root)
    return inputs, filler_chars + len(HOSTILE)


def test_TEST_21_the_refusal_does_not_GROW_with_the_hostile_field(tmp_path):
    """TEST-21 [e2e] — a fixed ceiling alone would pass a message that grew up to the ceiling.

    The same bundle twice, with the offending field TEN TIMES longer the second time. The
    refusal must not get materially longer: the message grows only with the DECIMAL DIGITS of
    the numbers the funnel states, which is a handful of bytes for a tenfold input.

    Without this leg the `len(err) < 4096` assertion above is satisfied by an unbounded
    implementation on a small input, and the flood the funnels exist to stop reappears the
    first time a real bundle carries a large field.

    Both comparands are over the clip — see [`_GROWTH_FILLERS`] for why a short comparand makes
    this leg raise a false alarm against a correct build.
    """
    small_inputs, small_total = _hostile_bundle_with_filler(tmp_path / "small", _GROWTH_FILLERS[0])
    big_inputs, big_total = _hostile_bundle_with_filler(tmp_path / "big", _GROWTH_FILLERS[1])

    small = HF.run_entry_bytes(small_inputs, tmp_path / "small-out")
    big = HF.run_entry_bytes(big_inputs, tmp_path / "big-out")

    assert small.returncode == 2 and big.returncode == 2, (small.returncode, big.returncode)
    assert big.stderr.isascii()
    grew = len(big.stderr) - len(small.stderr)
    assert 0 <= grew <= 64, (
        f"the refusal grew by {grew:,} bytes when the vendor's field grew by "
        f"{big_total - small_total:,} characters. It must grow only with the decimal digits of "
        f"the numbers the funnel states.\n"
        f"small: {len(small.stderr):,} bytes\nbig:   {len(big.stderr):,} bytes"
    )
    # ...and each one still states its OWN true length rather than the clipped one, so the
    # flat size above is a bounded message and not a message that stopped saying anything.
    assert str(small_total).encode() in small.stderr, small.stderr[:600]
    assert str(big_total).encode() in big.stderr, big.stderr[:600]


def test_TEST_21_an_ORDINARY_bundle_still_IMPORTS_and_leaves_no_refusal_on_stderr(tmp_path):
    """TEST-21 — the control: every assertion above must be about the HOSTILE bundle.

    An importer that refused every bundle would satisfy the whole of this file. So the
    unmodified fixture is run through the same driver and must exit 0 with no refusal row at
    all — which also pins that `_hostile_bundle`'s single-file overwrite is what causes the
    refusal, rather than the flattening, the driver, or the fixture itself.
    """
    inputs, _ordinals = HF.staged_flat(tmp_path)
    result = HF.run_entry_bytes(inputs, tmp_path / "outputs")

    assert result.returncode == 0, (result.returncode, result.stderr[-2000:])
    assert _REFUSAL_PREFIX not in result.stderr, result.stderr[-600:]
    assert (tmp_path / "outputs" / "manifest.json").exists()
