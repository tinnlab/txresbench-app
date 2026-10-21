#!/usr/bin/env python3
# ruff: noqa
"""#321 / #333 — #158's strip count is DERIVED from the artifact, never restated.

#158 measured, on the wire against a real backend, that one 512x512 level-0 tile of the
emitted Visium hires image cost 14 ranged GETs, 41,891 of 167,778 bytes. Five places under
`src-app/packages/` recorded the strip-count clause of that sentence as **ten**. It is
**nine**, and #259's amendment to `docs/design/ome-tiff-tile-layout.md` §2 is the accepted
correction this module realizes.

## Why this file is a MEASUREMENT and not a spell-check

Four failure modes are designed against, each of them observed rather than imagined:

* **A test that asserts a literal is a restatement, not a check.** So nothing here compares
  against the word "nine". The count is DERIVED, every run, from the artifact #158 measured
  — `spatial-image-hires-stripped.ome.tif`, kept byte-identical by #259 — using that file's
  own `RowsPerStrip`/`StripByteCounts` tags and the band height taken from the producer's own
  `TILE` constant. Whatever integer that derivation yields is the word the tree must state.
* **A guard that fires on a partial fix is a reminder, not a check** (#321, verbatim). The
  scan root is therefore the WHOLE of `src-app/packages/` — all twenty-odd package
  directories — and not a register of the five known paths, and not one root per package.
  #259's `PRODUCER_ROOT` in `staleClaims.test.ts` walks `spatial-types/compute` alone, which
  holds ONE of the five copies; a guard duplicated into each spatial package is the same
  defect one level up, because a copy planted in `cellranger/` or `qc/` — packages that ship
  no guard at all — is invisible to it. TEST-3 proves the whole-tree property by PLANTING a
  real sixth copy in exactly such a package and requiring it to be reported.
* **`read_text()` without an explicit encoding decodes with the LOCALE DEFAULT.** Under
  `LC_ALL=C` that raises `UnicodeDecodeError` on any file carrying non-ASCII bytes, and the
  `except UnicodeDecodeError: continue` that usually follows then skips the very files being
  guarded — silently. #333 measured it: a scan written that way returns exit 1 normally and
  **exit 0 under `LC_ALL=C`** with a real stale copy present, because
  `spatial-import-visium/compute/ome_writer.py` alone carries hundreds of non-ASCII bytes (715
  when #333 measured it, 735 once this change's amendment landed in it) and 443 of this tree's
  ~500 files carry some. So every read here names `encoding="utf-8"` — INCLUDING the
  `subprocess.run(..., text=True)` calls, which decode with the locale too and are how the
  first cut of this module reproduced the very defect it exists to close — and no file is EVER
  skipped: one that does not decode is re-read through the fallbacks in `readings_of`, which
  cover a wide encoding as well as a stray byte, because "the clause is ASCII so a replacement
  character cannot hide it" is true of latin-1 and FALSE of UTF-16 (there a NUL sits between
  every letter). TEST-4 proves the property by running the scan in TWO subprocesses — one
  under `LC_ALL=C PYTHONCOERCECLOCALE=0 PYTHONUTF8=0`, one with UTF-8 forced ON — and requiring
  the identical corpus and the identical findings, with a control inside each proving the two
  environments really differ. Neither side is this process, deliberately: comparing against an
  in-process scan is hollow exactly when pytest itself was launched under `LC_ALL=C`, which was
  measured going green with 443 of 502 files silently skipped.
* **A pure absence check goes green on a deleted paragraph.** `staleClaims.test.ts` states
  the rule — "Absence-checking alone would go green on a file that deleted the paragraph
  entirely" — so TEST-5 asserts the clause is still PRESENT in every shipped writer and
  across the tree, with floors, and not merely that no wrong number appears.

Two smaller traps, both of them real: `re.search` returns only the FIRST match in a file, so
a second copy in the same file would be invisible — everything here COUNTS matches (TEST-7);
and the clause is hard-wrapped in every file that carries it, mid-phrase in the design
document, so a raw substring scan misses it — the scanner normalizes comment prose first,
exactly as `staleClaims.test.ts` does (TEST-6 wraps the control at every word boundary).

## The coupling to #333, and why this module also reads `libs/viz`

`staleClaims.test.ts` asserts every path in `CORRECTED_BY_259_ALLOWED` STILL contains the
stale clause, deliberately, so that an exemption cannot outlive what it exempts. Correcting
`spatial-types/compute/ome_writer.py` therefore turns that test RED unless the allowlist
shrinks in the same commit. #333's own complaint is that "a pytest-only verification command
… cannot see it". TEST-8 is what makes it visible from here.

## The invariants the `[invariant: INV-n]` tags name

Restated here because the tags point at `.lifecycle/wire-measurement-nine/`, which this repo
strips at merge — after which the tags would name nothing a reader could look up:

* **INV-1** — a 512-row band spans nine of the fixture's 62-row strips; at y=0 they sum to
  36,383 B, and every full band (y = 0, 512, 1024) spans nine, so the correction does not
  depend on which tile #158 read.
* **INV-2** — `CORRECTED_BY_259_ALLOWED` cannot outlive the sentence it exempts: fix a copy
  without shrinking the list and `staleClaims.test.ts` fails and names the entry to delete.
* **INV-3** — a guard that fires on a partial fix is a reminder, not a check.
* **INV-4** — a `read_text()` without an explicit `encoding` decodes with the locale default,
  and the `except UnicodeDecodeError: continue` that follows skips the guarded files silently.
* **INV-5** — absence-checking alone goes green on a file that deleted the paragraph entirely.
* **INV-6** — a change vendored into three packages needs three version bumps.

## This module is INSIDE the tree it scans

There is no self-exemption — an exemption is per file and is a hiding place, which is a hole
`staleClaims.test.ts` documents in its own allowlist. Instead every literal spelling of the
clause in this file is SPLIT across a Python implicit-concatenation boundary, and the search
pattern is a regex whose own source text does not match itself. TEST-3 asserts this file is
among the scanned corpus and contributes zero findings, so the shielding is proven rather
than assumed.
"""
import ast
import contextlib
import functools
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "_lib"))
from zero_core_guard import changed_paths, diff_point, repo_root  # noqa: E402

_PACKAGES = Path(__file__).resolve().parents[2]
_REPO = _PACKAGES.parents[1]
_VIZ = _REPO / "src-app" / "libs" / "viz"

#: The artifact #158 measured. READ-ONLY here — #259 keeps it byte-identical, and it is the
#: ORACLE this module derives from rather than a citation it repeats.
_FIXTURE = _VIZ / "src/viz-core/spatial/fixtures/spatial-image-hires-stripped.ome.tif"

#: #333's coupling lives here.
_STALE_CLAIMS = _VIZ / "src/viz-core/spatial/staleClaims.test.ts"

#: The design section this correction realizes.
_DESIGN = _REPO / "docs" / "design" / "ome-tiff-tile-layout.md"

#: THE FIXTURE'S IDENTITY, anchored BEFORE anything is derived from it (TEST-2). Without this
#: a regenerated fixture at some other `RowsPerStrip` would make the derivation yield a
#: DIFFERENT number, and this module would then demand that the production comments state that
#: wrong number — a guard actively instructing the wrong fix. Anchored, the same event fails by
#: name and says the artifact moved.
_FIXTURE_BYTES = 167_778
_FIXTURE_ROWS_PER_STRIP = 62
_FIXTURE_STRIPS = 30

#: THE OTHER INPUT TO THE DERIVATION, anchored for the same reason as the fixture above.
#: The band height is read live out of the producer's `TILE` (so the derivation is not a
#: restatement), but #158's trace is a RECORDED MEASUREMENT of a past run: it does not become
#: a different number because a later change moves the writer's tile size. Left unpinned, a
#: routine `TILE = (1024, 1024)` would make this module derive seventeen and then demand that
#: five historical comments state a figure nobody ever measured — the same "guard actively
#: instructing the wrong fix" the fixture anchor exists to prevent, one input over.
_TRACE_BAND = 512

#: The canonical writer, and the vendored copies discovered beside it.
_WRITER_REL = Path("compute") / "ome_writer.py"

#: The package the writer is MAINTAINED in; the others are byte-identical copies of it
#: (`test_ome_dtype_refusal.py` TEST-8). Named once so a rename fails with an instruction
#: rather than nine bare `FileNotFoundError` tracebacks.
_CANONICAL_PKG = "spatial-types"

#: Directories that are not source and cannot carry a claim: bytecode and tool caches. Kept
#: as SHORT as it can be, because every name here is an escape hatch — a copy planted under a
#: skipped directory is a copy this guard does not see. `node_modules` and `.ipynb_checkpoints`
#: were in this set and are deliberately gone: neither exists anywhere under `src-app/packages/`,
#: so skipping them bought nothing and widened the hatch. `.ruff_cache` is in the list for the
#: same reason the others are AND is load-bearing besides: TEST-3's control plants a copy inside
#: one to prove the un-skipped walk can see in, so removing it by applying the rule above would
#: silently idle that control. What holds the hatch shut is not the
#: length of this list — asserting that would be tautological against it — but TEST-3's control:
#: it re-walks with the tool caches UN-skipped and requires no occurrence the normal walk
#: missed, and it PLANTS a copy inside a cache directory to prove that control can see in.
_SKIP_DIRS = frozenset({"__pycache__", ".git", ".pytest_cache", ".ruff_cache", ".mypy_cache"})

#: Liveness floors, set just under the real counts rather than at round numbers an emptied or
#: mis-rooted walk would still clear — the rule `staleClaims.test.ts` states for its own, with
#: one correction it needed: a floor set AT the live count is not "just under" it, it is a
#: tripwire under an editor's feet. `_MIN_OCCURRENCES` sat at exactly 5 against exactly 5
#: occurrences, so merging two of them — a legitimate editorial de-dup — reddened the guard.
#: What actually holds presence is TEST-5's per-writer requirement (every shipped
#: `ome_writer.py`, floor of 3); this tree-wide floor is the coarse backstop against the
#: paragraph being deleted wholesale, and 3 is where it does that job without owning the prose.
#: The
#: largest package in this tree contributes 70 files to the walk, so a walk narrowed to
#: ONE package cannot reach the file floor; that is the property the number is chosen for.
_MIN_SCANNED_FILES = 480
_MIN_OCCURRENCES = 3
_MIN_FILES_WITH_OCCURRENCE = 3
_MIN_SHIPPED_WRITERS = 3

#: The clause's tail, SPLIT so this module does not match itself (see the docstring). Python
#: joins the two literals; the source text between them never reads as the phrase.
_TAIL = "consecutive full" "-width strips"

#: The tail as a PATTERN. Its own source text does not match it either: `full[` is not
#: `full-` or `full `. The character classes absorb the spellings a re-wrap or an editing pass
#: produces — a hyphen turned into a space, dropped, or left dangling at a line break so the
#: rejoin reads `full- width` (which a single-character class does NOT match, and an earlier cut
#: of this pattern did not), a comma after "consecutive" — and
#: `normalize` folds the dash look-alikes it knows (`_DASHES`) to ASCII `-` and drops the
#: zero-width and soft characters first. That is a LIST, not a guarantee: unicode has more
#: hyphen-shaped codepoints than anyone enumerates, and an author determined to hide a copy has
#: easier tricks than this one (see the module docstring). What the fold buys is the accident —
#: a copy-paste out of a word processor.
_ANCHOR = re.compile(r"consecutive,?\s+full[-\s]*width\s+strips", re.IGNORECASE)

#: Dashes and invisible characters folded to ASCII before matching.
_DASHES = {"\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-",
           "\u2015": "-", "\u2043": "-", "\u2212": "-", "\ufe58": "-", "\ufe63": "-",
           "\uff0d": "-", "\u00ad": "", "\ufeff": "", "\u200b": "", "\u200c": "",
           "\u200d": "", "\u2060": ""}
_DASH_RE = re.compile("[" + "".join(_DASHES) + "]")

#: Leading comment markers only — `#:`, `#`, `//`, `*`, `>`, `"` — plus whitespace collapse. Enough
#: to rejoin prose wrapped across a comment boundary, which is the shape this clause has in
#: every file that carries it. Deliberately ANCHORED at line start, unlike the TypeScript
#: sibling's unanchored version, so it cannot strip hyphens out of compounds mid-line.
_LEADING_MARKER = re.compile(r"(?m)^[ \t]*(?:#:|#|//|\*|>|\")+[ \t]*")

#: A count may be spelled as a word or as digits. The lexicon is a lexicon, not a register of
#: paths — it says how English writes a small number, and nothing about where the clause lives.
_NUMBER_WORDS = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7,
    "eight": 8, "nine": 9, "ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13,
    "fourteen": 14, "fifteen": 15, "sixteen": 16, "seventeen": 17, "eighteen": 18,
    "nineteen": 19, "twenty": 20,
}
_WORD_FOR = {value: word for word, value in _NUMBER_WORDS.items()}

#: How far back of the tail the stated count is looked for. Wide enough for the longest
#: spelling that ships ("… for one 512x512 level-0 tile, nine of them …"), narrow enough that
#: a number from an unrelated neighbouring sentence cannot be mistaken for the count.
_LOOKBACK = 120

#: How far past `_LOOKBACK` the window may widen to avoid slicing a token in half. A count word
#: or a grouped numeral is short; this is generous for one and refuses an unbroken run.
_LOOKBACK_SLACK = 24

_TOKEN = re.compile(r"[A-Za-z]+|\d[\d,]*")

#: The construction #158's sentence uses: a count GOVERNING the tail. Preferred over the
#: last-token fallback so a numeral elsewhere in the same sentence cannot outvote it.
_GOVERNING = re.compile(r"\b([A-Za-z]+|\d[\d,]*)\s+of\s+(?:them|which|these|those)\b",
                        re.IGNORECASE)


# ── the scanner ─────────────────────────────────────────────────────────────────────


def normalize(text):
    """Collapse a source file to comparable prose.

    Leading comment markers go, whitespace collapses, and the unicode dashes plus the
    zero-width/soft characters fold to their ASCII spelling — so `full\u2011width` reads as
    `full-width` and `full\u00adwidth` as `fullwidth`, both of which the anchor matches, so
    neither can smuggle a copy past it.
    """
    folded = _DASH_RE.sub(lambda m: _DASHES[m.group(0)], text)
    return re.sub(r"\s+", " ", _LEADING_MARKER.sub(" ", folded))


def _stated_count(normalized, at):
    """The count this occurrence states, or None.

    TWO passes, and the order is the whole point. First look for `<count> of them` — the
    construction #158's sentence actually uses, and the one a rewording keeps ("ten of them ARE
    consecutive …"). Only if that is absent fall back to the last count token in the window,
    which is what makes a copy that drops the phrasing entirely still visible.

    The fallback SKIPS a `#`-prefixed number, and that is not a nicety: the single most likely
    edit anyone will ever make to this sentence is to cite the issue it comes from, and a
    parenthetical "(see #158)" between the count and the tail read as `158` under a plain
    last-number rule — the guard telling the author their correct sentence states 158.
    (The example is described rather than written out, because this module is inside the tree
    it scans and must not carry a matchable copy of the clause; see the module docstring.)
    """
    # Widened BACK to a token boundary. Slicing at a fixed offset can start mid-number, and a
    # truncated numeral is not `None` — it is a WRONG count silently reported as the stated one
    # (a `1120` straddling the edge read as `120`).
    start = max(0, at - _LOOKBACK)
    # BOUNDED. Widening to a token boundary stops a numeral being sliced in half and read as a
    # smaller number; left unbounded it walks the whole of an unbroken alnum run (dense code, a
    # CSV row) and defeats the narrow window `_LOOKBACK` exists to give.
    floor = max(0, at - _LOOKBACK - _LOOKBACK_SLACK)
    while start > floor and (normalized[start - 1].isalnum() or normalized[start - 1] == ","):
        start -= 1
    window = normalized[start:at]

    governed = None
    for match in _GOVERNING.finditer(window):
        governed = _as_count(match.group(1))
    if governed is not None:
        return governed

    found = None
    for token in _TOKEN.finditer(window):
        if token.start() > 0 and window[token.start() - 1] == "#":
            continue  # an issue reference, not a count
        value = _as_count(token.group(0))
        if value is not None:
            found = value
    return found


def _as_count(text):
    if text.lower() in _NUMBER_WORDS:
        return _NUMBER_WORDS[text.lower()]
    if text[:1].isdigit():
        try:
            return int(text.replace(",", ""))
        except ValueError:  # pragma: no cover — `_TOKEN` cannot produce one
            return None
    return None


def occurrences_in(text, where="<memory>"):
    """EVERY occurrence of the clause in `text`, as `(where, ordinal, count, excerpt)`.

    `finditer`, never `search`: `re.search` returns only the FIRST match in a file, so a
    second copy in the same file would be invisible to a guard built on it. TEST-7 is the
    proof that two copies in one file are both reported.
    """
    normalized = normalize(text)
    out = []
    for ordinal, match in enumerate(_ANCHOR.finditer(normalized)):
        start = max(0, match.start() - 90)
        out.append((where, ordinal, _stated_count(normalized, match.start()),
                    normalized[start:match.end() + 10].strip()))
    return out


def readings_of(path):
    """EVERY plausible text reading of one file, and how each was obtained.

    One file can be more than one string. A UTF-16 file decoded as UTF-8-with-replacement
    comes back with a NUL or a replacement character between every letter, which breaks the
    clause into fragments the anchor cannot match — so "the clause is ASCII, a replacement
    character cannot hide it" is true of a stray bad byte and FALSE of a wide encoding. Every
    reading is scanned; nothing here decides which one is "the" text and discards the rest.

    Never `except UnicodeDecodeError: continue` — that is the exact line #333 measured as
    silently skipping the guarded files and passing.
    """
    try:
        # EXPLICIT `encoding="utf-8"`. Without it this decodes with the LOCALE DEFAULT and
        # raises under `LC_ALL=C` on 443 of this tree's ~500 files (#333).
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        raw = path.read_bytes()
        readings = [(raw.decode("utf-8", errors="replace"), "utf-8-replaced")]
        if b"\x00" in raw:
            readings.append((raw.replace(b"\x00", b"").decode("utf-8", errors="replace"),
                             "nul-stripped"))
        return readings
    # THE STRICT READ SUCCEEDING IS NOT THE END OF IT, and an earlier cut of this function
    # assumed it was. BOM-less UTF-16/UTF-32 holding ASCII is VALID UTF-8 — every byte is
    # below 0x80 and NUL is a legal UTF-8 byte — so `read_text` returns happily and the text
    # has a NUL between every letter. The fallback branch above was therefore unreachable for
    # exactly the encodings it names, and the only reason a UTF-16 plant was caught at all is
    # that `str.encode("utf-16")` prepends a BOM. `iconv -t utf-16le`, a Windows editor, or
    # git's own working-tree conversion produce the file that got through.
    readings = [(text, "utf-8")]
    if "\x00" in text:
        readings.append((text.replace("\x00", ""), "nul-stripped"))
    return readings


def scan_packages_tree(root=None, skip=None):
    """Walk EVERY file under `src-app/packages/` and report every occurrence of the clause.

    Returns `{files, paths, occurrences, replaced, undescended, unreadable, skipped_dirs}`.

    * `replaced` names the files that did not decode as UTF-8 and were read through the
      fallback readings above — SCANNED, never skipped, which is the whole point (#333).
    * `undescended` names symlinked DIRECTORIES, which the walk does not follow, and it is
      built BEFORE the skip test so a link called `__pycache__` is reported rather than
      dismissed as a cache. Symlinked FILES are followed and scanned — an earlier cut skipped
      them, which made a one-line `ln -s /tmp/stale.md qc/WIRE.md` a complete evasion.
    * `unreadable` names anything the walk could not open, file or directory. `rglob` swallowed
      a directory `PermissionError` silently; this does not.
    * `skipped_dirs` names the `_SKIP_DIRS` entries actually encountered. It is REPORTED, not
      asserted on — what holds the skip list shut is TEST-3's control, which re-walks with the
      tool caches un-skipped and plants a copy inside one.
    """
    root = Path(root) if root is not None else _PACKAGES
    skip = _SKIP_DIRS if skip is None else frozenset(skip)
    paths, occurrences, replaced = [], [], []
    undescended, skipped, unreadable = [], set(), []
    # `os.walk`, not `rglob`, and for two reasons the round that used `rglob` got wrong.
    # (a) `rglob` SWALLOWS a `PermissionError` on a directory: the walk simply returns fewer
    #     files, the count barely moves, and a copy inside is invisible with nothing said. The
    #     `onerror` hook below turns that into a named failure.
    # (b) it gives no place to test a directory BEFORE deciding to skip it by name, so a
    #     symlinked directory called `__pycache__` was skipped as a cache instead of reported
    #     as undescended — one `ln -s` through both of this module's anti-hiding mechanisms.
    def _walk_error(failure):
        unreadable.append(f"{failure.filename}: {failure}")

    for parent, dirnames, filenames in os.walk(root, onerror=_walk_error):
        here = Path(parent)
        keep = []
        for name in sorted(dirnames):
            # SYMLINK FIRST, name second: a link is reported whatever it is called.
            if (here / name).is_symlink():
                undescended.append((here / name).relative_to(root).as_posix())
                continue
            if name in skip:
                skipped.add(name)
                continue
            keep.append(name)
        dirnames[:] = keep
        for name in sorted(filenames):
            path = here / name
            relative = path.relative_to(root)
            # The skip set is tested against DIRECTORY components only. Testing the basename
            # too meant a regular FILE named `__pycache__` was dropped — a hiding place that
            # needs no list growth at all, which is the opposite of what a short list is for.
            if not path.is_file():  # a broken symlink, a socket, a fifo — nothing to read
                continue
            where = relative.as_posix()
            try:
                readings = readings_of(path)
            except FileNotFoundError:
                continue  # it went away between listing and reading; nothing left to guard
            except OSError as failure:
                # NOT a traceback out of the middle of the walk. A file this guard cannot read
                # is a file it cannot guard, so it is NAMED and TEST-3 fails on it — the same
                # disposition as a symlinked directory, and for the same reason.
                unreadable.append(f"{relative.as_posix()}: {failure}")
                continue
            paths.append(where)
            # Deduped ACROSS readings only, and keyed on the ORDINAL rather than on the text.
            # Two DIFFERENT copies in one file can share a count and a preceding context — the
            # earlier (count, excerpt) key silently merged them, so `occurrences_in` found two
            # and the walk reported one — while ONE copy read twice can produce two different
            # excerpts, which that key double-reported as "occurrence #1" twice. The key is
            # (ordinal, count): the ordinal is unique within a reading, so nothing inside one
            # reading is ever dropped, and it is stable across readings for the same physical
            # copy, so a copy seen twice is merged. The
            # residual edge, stated: if a later reading reveals an occurrence EARLIER in the
            # file than one the first reading found, the ordinals shift and a copy could be
            # deduped against the wrong sibling. It needs a file that is valid UTF-8, carries a
            # NUL, and hides one copy behind it and not another; the cost if it happens is an
            # under-count, which the occurrence floors in TEST-5 would surface.
            seen = set()
            for text, how in readings:
                if how != "utf-8":
                    replaced.append(where)
                found = occurrences_in(text, where)
                occurrences.extend(o for o in found if (o[1], o[2]) not in seen)
                seen.update((o[1], o[2]) for o in found)
    return {"files": len(paths), "paths": tuple(paths),
            "replaced": tuple(sorted(set(replaced))), "undescended": tuple(undescended),
            "unreadable": tuple(unreadable), "skipped_dirs": tuple(sorted(skipped)),
            "occurrences": tuple(occurrences)}


# ── the derivation ──────────────────────────────────────────────────────────────────


#: Cached: it reads two files and is called once per test. `fixture_layout` and
#: `band_decomposition` are deliberately NOT cached — the fixture identity anchor is asserted
#: inside the former, and a cached anchor is an anchor that runs once.
@functools.lru_cache(maxsize=None)
def _tile_height():
    """The band height: the PRODUCER's `TILE`, required to still equal `_TRACE_BAND`.

    Being explicit about which half of this module is a derivation: the strip COUNT is derived,
    from the fixture's own tags. The band height is PINNED — `_TRACE_BAND` is a literal here —
    and read from the producer only so that a divergence is a named refusal rather than a
    silent disagreement. #158's trace is a RECORDED measurement of a past run: it does not
    become a different number because a later change moves the writer's tile size, so a guard
    that quietly re-derived it would demand five historical comments state a figure nobody read.

    THE READER IS DELIBERATELY NOT READ, and an earlier cut of this function did read
    `DEFAULT_OME_TIFF_LIMITS.tileSize` out of `omeTiffPyramid.ts` and called the agreement
    "corroboration". It is not: `ome_writer.py`'s own comment says so outright — "512 here is
    not 'agreeing with a value the reader computes'; it is agreeing with the value the reader
    REQUESTS." Producer and reader are ONE decision, so the second read supplied no independent
    evidence and bought only a third way to go red — a reader-side tuning change, touching
    neither the writer nor the fixture nor #158, would have failed all twelve tests with a
    message telling the developer to re-measure a wire trace. It also made a Python package
    test hard-depend on a TypeScript path in another workspace.
    """
    canonical = _PACKAGES / _CANONICAL_PKG / _WRITER_REL
    assert canonical.is_file(), (
        f"the canonical writer is missing: {canonical}. `{_CANONICAL_PKG}` is where the vendored "
        f"`{_WRITER_REL.as_posix()}` is maintained and the other copies are byte-identical to it "
        "(test_ome_dtype_refusal.py TEST-8). If the package was renamed, re-point "
        "`_CANONICAL_PKG`; if the layout changed, this derivation needs re-deriving.")
    source = canonical.read_text(encoding="utf-8")
    found = re.search(r"^TILE\s*=\s*\(\s*(\d+)\s*,\s*(\d+)\s*\)\s*$", source, re.MULTILINE)
    assert found, "`TILE` is no longer a literal pair in `ome_writer.py`; the band height that "\
                  "this derivation rests on can no longer be read from the producer"
    producer = int(found.group(2))
    assert producer == _TRACE_BAND, (
        f"the producer now writes a {producer}-row tile, but #158's trace was measured at "
        f"{_TRACE_BAND}. That is not a reason to re-derive the historical figure — a past "
        "measurement does not change retroactively. Re-measure the wire cost at the new tile "
        "size and amend `docs/design/ome-tiff-tile-layout.md` §2 and this constant together, "
        "deliberately; do NOT let this guard rewrite five comments to a number nobody read.")
    return producer


def fixture_layout():
    """`(rows_per_strip, strip_byte_counts, image_length)` — the fixture's OWN tags.

    Anchored on the artifact's identity FIRST (TEST-2). A different file may well be a
    perfectly good fixture; it is not the one #158 measured, and deriving from it would put a
    number into the production comments that no measurement produced.
    """
    import tifffile

    assert _FIXTURE.is_file(), (
        f"the oracle is missing: {_FIXTURE}. This guard DERIVES #158's strip count from that "
        "artifact; without it there is nothing to derive from and nothing to check. It is "
        "read-only here — #259 keeps it byte-identical precisely so this stays checkable.")
    size = _FIXTURE.stat().st_size
    with tifffile.TiffFile(_FIXTURE) as handle:
        page = handle.pages[0]
        rows_per_strip = page.tags["RowsPerStrip"].value
        counts = page.tags["StripByteCounts"].value
        length = int(page.imagelength)
    rows_per_strip = int(rows_per_strip[0] if isinstance(rows_per_strip, (tuple, list))
                         else rows_per_strip)
    counts = tuple(int(value) for value in counts)
    assert (size, rows_per_strip, len(counts)) == (
        _FIXTURE_BYTES, _FIXTURE_ROWS_PER_STRIP, _FIXTURE_STRIPS), (
        f"`{_FIXTURE.name}` is not the artifact #158 measured: got {size} B, "
        f"RowsPerStrip={rows_per_strip}, {len(counts)} strips; expected {_FIXTURE_BYTES} B, "
        f"RowsPerStrip={_FIXTURE_ROWS_PER_STRIP}, {_FIXTURE_STRIPS} strips. #259 keeps this "
        "file byte-identical precisely so the correction stays checkable. Deriving from a "
        "regenerated fixture would yield a different count and then demand the production "
        "comments state THAT — a guard instructing the wrong fix. Re-pin the artifact, or "
        "re-derive the whole amendment from the new one deliberately.")
    return rows_per_strip, counts, length


def band_decomposition():
    """`{band_start: (strips_spanned, bytes)}` for every band the image fully contains.

    TILE-GRID-ALIGNED bands, and that qualifier is load-bearing rather than an implementation
    convenience. A 512-row band at an ARBITRARY offset can span ten of these 62-row strips
    (y=61 covers strips 0..9), so "nine" is the span of the reads a viewer actually issues, not
    a bound over every offset. It is the right decomposition because the reader is grid-aligned
    by construction — `omeTiffPyramid.ts` builds its `TiffPixelSource` with
    `DEFAULT_OME_TIFF_LIMITS.tileSize = 512` and deck.gl requests whole tiles on that grid —
    which is also why #158's trace was of an aligned tile.
    """
    rows_per_strip, counts, length = fixture_layout()
    band = _tile_height()
    out = {}
    for top in range(0, length - band + 1, band):
        first = top // rows_per_strip
        last = (top + band - 1) // rows_per_strip
        out[top] = (last - first + 1, sum(counts[first:last + 1]))
    assert out, "the fixture is shorter than one band; nothing can be derived from it"
    return out


@functools.lru_cache(maxsize=None)
def derived_count():
    """The number of strips one full band spans — the whole point of this module."""
    spans = {strips for strips, _ in band_decomposition().values()}
    assert len(spans) == 1, (
        f"the bands of `{_FIXTURE.name}` no longer span a uniform number of strips: "
        f"{band_decomposition()}. The design's claim is that the correction 'does not depend "
        "on which tile #158 read'; that is false for this artifact, so the amendment itself "
        "needs re-deriving rather than this guard needs relaxing.")
    return spans.pop()


@functools.lru_cache(maxsize=None)
def derived_word():
    count = derived_count()
    assert count in _WORD_FOR, f"no English word is known for a span of {count} strips"
    return _WORD_FOR[count]


# ── TEST-2 — the fixture's identity, anchored before anything is derived ────────────


def test_the_fixture_is_the_artifact_158_measured():
    """TEST-2 [covers: ITEM-4] — the anchor, asserted on its own so its failure is legible.

    `fixture_layout` re-asserts this on every call, so no derivation in this module can run
    against an unanchored artifact. This test exists to make the anchor a NAMED failure rather
    than a side effect of whichever derivation happened to run first.
    """
    assert _FIXTURE.is_file(), (
        f"the oracle is missing: {_FIXTURE}. This guard DERIVES #158's strip count from that "
        "artifact; without it there is nothing to derive from and nothing to check.")
    # `fixture_layout` re-asserts the identity tuple itself and raises with the long message
    # above if it does not hold, so re-comparing the three fields here would be three
    # unreachable-false assertions. What is asserted instead is what the anchor does NOT cover.
    rows_per_strip, counts, length = fixture_layout()
    # Restored after a round deleted it as "always true": it is not. The strips are DEFLATE-
    # compressed pixel data and the file also carries a header, two SubIFDs and the OME-XML,
    # so 117,688 of 167,778 bytes is a live relationship between the tag table and the file.
    assert 0 < sum(counts) < _FIXTURE_BYTES, (
        f"the strip table accounts for {sum(counts)} of {_FIXTURE_BYTES} bytes, which is not a "
        "coherent reading of this artifact")
    assert length > _tile_height(), (
        "the fixture is not taller than one band, so no full band exists to decompose")
    assert length // _tile_height() >= 3, (
        "fewer than three full bands fit, so the design's 'every full band spans nine' claim "
        "cannot be exercised on this artifact")
    # The DECOMPOSITION is what the derivation reads, so the strip table has to be complete:
    # every strip accounted for, and the last one shorter than a full band's worth of rows.
    assert len(counts) == -(-length // rows_per_strip), (
        f"{len(counts)} strips do not tile {length} rows at {rows_per_strip} rows each, so "
        "the tags this derivation reads are inconsistent with each other")


# ── TEST-1 — the count is DERIVED, and is band-independent ─────────────────────────


def test_the_strip_count_is_derived_from_the_fixtures_own_tags():
    """TEST-1 [acceptance] [invariant: INV-1] [covers: ITEM-4] — the measurement.

    The design's amendment says: "a 512-row band spans nine of its 62-row strips — at y=0 they
    sum to 36,383 B — and every full band on this file (y = 0, 512, 1024) spans nine, so the
    correction does not depend on which tile #158 read." That is asserted here as a DERIVATION
    over the artifact's own tags, not as a literal. The numbers are PRINTED so a drift shows up
    in the log rather than being absorbed.
    """
    rows_per_strip, _counts, length = fixture_layout()
    band = _tile_height()
    decomposition = band_decomposition()
    count = derived_count()
    print(f"\nRowsPerStrip={rows_per_strip}  image_length={length}  band={band}")
    for top, (strips, size) in sorted(decomposition.items()):
        print(f"  band y={top:>5}  rows {top}..{top + band - 1}  ->  {strips} strips, {size:,} B")
    print(f"  derived: {count} strips per band -> {derived_word()!r}")

    # Band-independence is asserted inside `derived_count()` (which the line above called and
    # which raises with the decomposition printed), so it is not re-asserted here. What IS
    # asserted here is the size of the claim: "every full band" has to mean more than one band.
    assert len(decomposition) >= 3, (
        "fewer than three full bands exist, so 'every full band spans the same count' is a "
        "weaker statement here than the design makes")

    # The derivation is not a tautology and not a restatement: the count is exactly the span
    # the two tags FORCE. One fewer strip does not reach the band, which is the geometric half
    # of the design's argument ("seven strips cover 434 rows and eight cover 496, neither of
    # which reaches a 512-row band").
    assert count > 1, "a band spanning one strip would make this derivation trivial"
    assert count * rows_per_strip >= band, (
        f"{count} strips of {rows_per_strip} rows do not cover a {band}-row band")
    assert (count - 1) * rows_per_strip < band, (
        f"{count - 1} strips already cover a {band}-row band, so {count} is not the span")


# ── planting a probe into the real tree, without leaving one behind ────────────────


#: The package the probes are planted in: it ships NO test suite of its own, which is the
#: property being demonstrated — a guard that only walks the packages that HAVE guards cannot
#: see a copy planted here.
_HOSTLESS = "cellranger"

#: The probe prefix. Distinctive so a leaked one is greppable, and so the sweep below can
#: recognise it without a register.
_PROBE = "_wire_measurement_probe_"

#: How old a probe has to be before its pid is presumed reused rather than alive. An hour is
#: far longer than this module's entire run and far shorter than the interval at which a leaked
#: probe would confuse someone.
_PROBE_MAX_AGE_SECONDS = 3600


def _abandoned(probe):
    """Is this probe a leak, or another RUNNING copy of this module's live probe?

    The filename carries the planting process's pid. Sweeping on the prefix alone deleted a
    concurrent run's live probe out from under it, and that run then failed with "a sixth copy
    planted at … was NOT reported. The scan root has been narrowed" — a maximally misleading
    diagnosis of someone else's tidying. So: only a probe whose pid is gone (or that has no
    readable pid, or that is older than an hour) is a leak.
    """
    # The AGE fallback is not decoration. A pid is reused, and a probe whose number now belongs
    # to some unrelated live process would otherwise be immortal: never swept, and reported by
    # every later run as a real stale copy. An hour is far longer than this module's whole run.
    try:
        if time.time() - probe.stat().st_mtime > _PROBE_MAX_AGE_SECONDS:
            return True
    except OSError:
        return True  # it went away, or we cannot stat it; either way it is not ours to keep
    stem = probe.name[len(_PROBE):].split(".")[0]
    try:
        os.kill(int(stem), 0)
    except (ValueError, ProcessLookupError):
        return True
    except PermissionError:
        return False  # alive, owned by someone else
    return False


def sweep_abandoned_probes():
    """Remove probes left by KILLED runs, and say so. Returns what it removed."""
    home = _PACKAGES / _HOSTLESS
    swept = []
    for stale in list(home.rglob(f"{_PROBE}*")):
        if _abandoned(stale):
            swept.append(stale.relative_to(_PACKAGES).as_posix())
            stale.unlink(missing_ok=True)
    return swept


@pytest.fixture(autouse=True, scope="module")
def _sweep_first():
    """Sweep BEFORE the first test, not at the first plant.

    The sweep used to live only inside `planted()`, which TEST-3 reaches at its THIRD step —
    after the whole-tree wrong-count assertion. So a probe left by a killed run made TEST-3
    fail naming it as a real stale copy, with no "swept" line printed: exactly the confusion
    the sweep exists to prevent, arriving one assertion too late.
    """
    swept = sweep_abandoned_probes()
    if swept:
        print(f"\nswept probes abandoned by a killed run: {swept}")
    yield


@contextlib.contextmanager
def planted(content, suffix=".txt", encoding="utf-8", link_to=None, inside=None):
    """Put a real file into the real tree, and take it away again whatever happens.

    Created INSIDE the `try`, so nothing between the name and the first write can leave one
    behind; and any probe ABANDONED by a previously killed run is swept first and reported,
    because a leaked probe carrying the stale sentence reads exactly like a real stale copy and
    would send the next reader hunting a file that is not in git. `inside` plants it in a
    subdirectory (which is removed again), for the cache-directory control.
    """
    home = _PACKAGES / _HOSTLESS
    # TWO conditions, TWO messages: one message for two conditions names the wrong one half the
    # time, and a rename made this say "`cellranger` … ships no test suite" about a directory
    # that no longer existed.
    assert home.is_dir(), (
        f"the probe host `{_HOSTLESS}` does not exist under {_PACKAGES}. It only needs to be a "
        "package that ships NO test suite of its own — that is the property being demonstrated. "
        "Re-point `_HOSTLESS` at another one.")
    assert not (home / "tests").exists(), (
        f"`{_HOSTLESS}` now ships a test suite, so planting the probe there no longer "
        "demonstrates what it is for — that a package with no guard of its own is still "
        "scanned. Re-point `_HOSTLESS` at a package that has none.")
    sweep_abandoned_probes()
    where = home if inside is None else home / inside
    probe = where / f"{_PROBE}{os.getpid()}{suffix}"
    try:
        if inside is not None:
            where.mkdir(parents=True, exist_ok=True)
        if link_to is not None:
            probe.symlink_to(link_to)
        elif isinstance(content, bytes):
            probe.write_bytes(content)
        else:
            probe.write_text(content, encoding=encoding)
        yield probe.relative_to(_PACKAGES).as_posix()
    finally:
        # In the `finally`, not after it: a `contextmanager` whose body raises has that
        # exception thrown in at the `yield`, so anything after the try/finally never runs —
        # which is exactly the path on which a leak would matter most.
        probe.unlink(missing_ok=True)
        if inside is not None and where.is_dir():
            try:
                where.rmdir()
            except OSError:
                pass  # a concurrent run still has something in it; not ours to force
        # Only when nothing is already unwinding: an exception raised in a `finally` REPLACES
        # the in-flight one and demotes the real failure to `__context__`, which is the last
        # thing a reader of a red run needs.
        if sys.exc_info()[0] is None:
            assert not probe.exists()


# ── TEST-3 — the WHOLE package tree, including packages that ship no guard ─────────


def test_no_copy_anywhere_under_packages_states_a_different_count():
    """TEST-3 [acceptance] [invariant: INV-3] [covers: ITEM-1, ITEM-2, ITEM-3, ITEM-4].

    The scan root is `src-app/packages/` entire. Three things are asserted, and the third is
    the one that distinguishes a check from a reminder:

      1. the walk really walked (a file floor, and every package directory represented);
      2. every occurrence anywhere in it states the DERIVED count;
      3. a sixth copy PLANTED in a package that ships no guard of its own is reported — run
         for real, against the real tree, and cleaned up in a `finally`.
    """
    word = derived_word()
    count = derived_count()
    report = scan_packages_tree()

    # 1 — liveness. A guard that walks nothing passes every absence check ever written.
    assert report["unreadable"] == (), (
        "these files could not be read at all, so the guard cannot guard them: "
        f"{report['unreadable']}. Fix the permission or remove the file — a scan that walks "
        "past what it cannot open is the #333 failure with a different exception.")
    assert report["files"] >= _MIN_SCANNED_FILES, (
        f"only {report['files']} files scanned under {_PACKAGES}; expected at least "
        f"{_MIN_SCANNED_FILES}. A shrunken corpus is how an absence check goes vacuously green.")
    # Directories that actually CONTAIN a file. An empty one is not a hole in the walk — there
    # is nothing in it to miss — and reporting it as "not walked at all" sends the reader
    # hunting a scan bug that is a `mkdir`.
    package_dirs = {entry.name for entry in _PACKAGES.iterdir()
                    if entry.is_dir() and entry.name not in _SKIP_DIRS
                    and any(child.is_file() for child in entry.rglob("*"))}
    walked = {where.split("/", 1)[0] for where in report["paths"]}
    assert package_dirs <= walked, (
        f"these package directories were not walked at all: {sorted(package_dirs - walked)}. "
        "A copy of the clause planted in one of them would be invisible — which is exactly the "
        "'reminder, not a check' failure #321 names.")
    # This module is inside the tree it scans and is NOT exempt; its literals are split so it
    # contributes nothing. Proven, not assumed.
    mine = Path(__file__).resolve().relative_to(_PACKAGES).as_posix()
    assert mine in report["paths"], "this guard is not scanning itself"
    assert [o for o in report["occurrences"] if o[0] == mine] == [], (
        "this module now matches its own pattern; split the literal (see the module docstring) "
        "rather than exempting the file, because an exemption is per-file and is a hiding place")

    # 2 — every occurrence states the derived count. A probe belonging to a concurrent run is
    # excluded here too: it is by construction a stale copy, and reporting someone else's
    # in-flight fixture as this branch's defect is a false red with a maximally confusing
    # message. The autouse sweep removes the ones that are genuinely abandoned.
    wrong = [o for o in report["occurrences"] if o[2] != count and _PROBE not in o[0]]
    assert not wrong, _report(wrong, count, word)

    # …and the walk's own blind spots are REPORTED rather than silently passed over.
    assert report["undescended"] == (), (
        "these are symlinked DIRECTORIES, which the walk does not follow, so nothing inside "
        f"them is scanned: {report['undescended']}. Replace the link with a real directory or "
        "teach the walk to follow it — do not leave a hole the guard cannot see into.")
    # Every name in `_SKIP_DIRS` is an escape hatch, so the honest check is not "the list is
    # short" — that is tautological against the list — but "nothing is hiding in one": the walk
    # is repeated with the TOOL CACHES un-skipped, and must find no occurrence it did not
    # already have. `__pycache__` and `.git` stay skipped in the control, for a stated reason
    # rather than a convenient one: a `.pyc` is a byte-for-byte derivative of a `.py` this walk
    # ALREADY scanned, so it can only ever echo a finding, and it additionally materialises
    # THIS module's deliberately-split literal in its joined runtime form — so scanning
    # bytecode would report the guard itself, every run, for the shielding that exists to stop
    # exactly that. `.git` is object storage and holds every past revision of everything.
    print(f"\nskipped directory names encountered: {sorted(report['skipped_dirs'])}")
    control_skip = frozenset({"__pycache__", ".git"})
    unskipped = scan_packages_tree(skip=control_skip)
    # PROBE-FILTERED on both sides. These are two independent, non-atomic walks seconds apart,
    # so a probe planted by a CONCURRENTLY RUNNING copy of this module can exist for one and
    # not the other and read as a copy hiding in a skipped directory. That is not a
    # hypothetical: it was observed failing exactly this way, naming a probe whose process had
    # already exited. TEST-4 filters its two scans for the same reason; this one did not.
    def real(occurrences):
        return [o for o in occurrences if _PROBE not in o[0]]

    hidden = [o for o in real(unskipped["occurrences"]) if o not in real(report["occurrences"])]
    assert not hidden, (
        "these copies live under a directory `_SKIP_DIRS` walks past, so the guard is blind to "
        f"them: {hidden}. An escape hatch that something is actually hiding in is a hole.")
    # …and the control is PROVEN to be able to see into one, by planting a copy inside a cache
    # directory. An earlier cut asserted instead that the un-skipped walk read MORE files —
    # which is only true once a previous pytest run has littered `.pytest_cache` into the tree,
    # so on a genuinely clean checkout (CI, `git clean -xfd`, a container, a new developer's
    # first run) this test was RED. A liveness check that depends on a previous run's droppings
    # is not a liveness check.
    with planted(_sentence("ten"), inside=".ruff_cache") as rel:
        seen_by_control = [o for o in scan_packages_tree(skip=control_skip)["occurrences"]
                           if o[0] == rel]
        blind = [o for o in scan_packages_tree()["occurrences"] if o[0] == rel]
    assert seen_by_control, (
        "the un-skipped control walk could not see a copy planted inside a cache directory, so "
        "its silence above proves nothing about what the skip list hides")
    assert not blind, (
        "a cache directory is no longer being skipped at all, which is fine but means the "
        "control above is comparing two identical walks — re-point it")

    # 3 — a sixth copy in a package that ships NO guard of its own is caught.
    with planted(_sentence("ten")) as rel:
        flagged = [o for o in scan_packages_tree()["occurrences"]
                   if o[0] == rel and o[2] != count]
        assert flagged, (
            f"a sixth copy planted at {rel} — a package with no guard of its own — was NOT "
            "reported. The scan root has been narrowed, or the register replaced the walk.")


def _report(wrong, count, word):
    lines = [f"{o[0]} (occurrence #{o[1] + 1}) states {o[2]!r}: …{o[3]}…" for o in wrong]
    return (f"#158's wire measurement is {count} ({word!r}) consecutive strips, derived from "
            f"`{_FIXTURE.name}`'s own RowsPerStrip/StripByteCounts. These disagree:\n  "
            + "\n  ".join(lines))


def _sentence(count):
    """#158's clause with an arbitrary count, assembled so this file never carries it whole."""
    return (f"measured on the wire by the reader (#158) at 14 ranged GETs for one 512x512 "
            f"level-0 tile, {count} of them {_TAIL}. That is ~2.7x on a small fixture.")


# ── TEST-4 — the scan is locale-independent, and the control proves it matters ─────


#: The hostile environment: a genuine POSIX C locale with Python's two rescue mechanisms
#: (locale coercion and UTF-8 mode) explicitly switched OFF, so `open()` really does default to
#: ASCII. `PYTHONIOENCODING` is set only so the driver's own JSON can be printed.
_C_LOCALE = {"LC_ALL": "C", "LANG": "C", "LC_CTYPE": "C",
             "PYTHONCOERCECLOCALE": "0", "PYTHONUTF8": "0", "PYTHONIOENCODING": "utf-8"}

#: The friendly one, forced rather than inherited. This is what makes the comparison mean
#: something: comparing the C-locale run against THIS PROCESS is hollow whenever this process
#: is itself in the C locale — both sides then break identically and the test is green. It was
#: measured: with the #333 defect reinstated and pytest launched under `LC_ALL=C`, the
#: comparison passed while the scan skipped 443 of 502 files. Two subprocesses, neither
#: inheriting the parent, removes the assumption instead of documenting it.
_UTF8_LOCALE = {"LC_ALL": "C.UTF-8", "LANG": "C.UTF-8", "LC_CTYPE": "C.UTF-8",
                "PYTHONCOERCECLOCALE": "1", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}

_SUBPROCESS_DRIVER = """
import importlib.util, json, locale, sys

spec = importlib.util.spec_from_file_location("wire_guard", {module!r})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

report = module.scan_packages_tree()

# THE NEGATIVE CONTROL, inside the same interpreter the scan just ran in: a locale-default
# read of a file this tree really contains must FAIL here. If it does not, this environment
# is not the C locale and the equality below would be evidence of nothing.
control = {control!r}
try:
    open(control).read()
    locale_default_raises = False
except UnicodeDecodeError:
    locale_default_raises = True

print(json.dumps({{
    "preferred_encoding": locale.getpreferredencoding(False),
    "locale_default_raises": locale_default_raises,
    "files": report["files"],
    "paths": list(report["paths"]),
    "replaced": list(report["replaced"]),
    "occurrences": [[o[0], o[1], o[2]] for o in report["occurrences"]],
}}))
"""


def _scan_under(env, driver):
    """Run the module's own scan in a subprocess under `env`, and give back its report."""
    finished = subprocess.run([sys.executable, "-c", driver], env={**os.environ, **env},
                              cwd=str(_REPO), capture_output=True, text=True, encoding="utf-8",
                              timeout=900)
    assert finished.returncode == 0, (
        f"the scan DIED under {env.get('LC_ALL')!r}, which is the #333 failure in its loud "
        "form — a guard that cannot run in a locale is a guard that does not run:\n"
        + (finished.stderr or "")[-4000:])
    return json.loads(finished.stdout.strip().splitlines()[-1])


def test_the_scan_reads_the_same_corpus_under_LC_ALL_C():
    """TEST-4 [acceptance] [invariant: INV-4] [covers: ITEM-4] — the #333 measurement, re-run.

    #333: "a scan written that way returns exit 1 normally and exit 0 under `LC_ALL=C`" — the
    `except UnicodeDecodeError: continue` skips the guarded files and passes silently. The
    claim under test is that THIS scan does not, because every read names its encoding and no
    file is ever skipped.

    Two subprocesses, and NEITHER of them is this process. Comparing the C-locale run against
    an in-process scan is hollow exactly when it matters: if pytest itself was launched under
    `LC_ALL=C`, both sides break the same way and the test is green — measured, with the #333
    defect reinstated, at 443 of 502 files silently skipped and this comparison passing. So the
    reference run is a second subprocess with UTF-8 mode FORCED on, and the two environments
    are proven different by a control inside each: a locale-default `open(...).read()` of
    `spatial-import-visium/compute/ome_writer.py` (hundreds of non-ASCII bytes) must RAISE in
    the C child and must NOT raise in the UTF-8 child. If a platform coerces the locale anyway,
    the control says so and the test skips with that stated rather than passing on a
    coincidence.
    """
    # Any file with a good number of non-ASCII bytes works; this one was chosen because #333
    # measured it (715 bytes then, 735 now) and because it is a file this guard already reads.
    control = _PACKAGES / "spatial-import-visium" / _WRITER_REL
    assert control.is_file(), (
        f"the locale control file is missing: {control}. It only needs to be a file under "
        "`src-app/packages/` with a healthy number of non-ASCII bytes; re-point it at another "
        "if this package was renamed.")
    high = sum(1 for byte in control.read_bytes() if byte > 127)
    assert high > 0, (
        "the control file no longer carries non-ASCII bytes, so it can no longer demonstrate "
        "the locale-default failure this test is about; pick another")
    print(f"\ncontrol {control.name}: {high} non-ASCII bytes")

    driver = _SUBPROCESS_DRIVER.format(module=str(Path(__file__).resolve()),
                                       control=str(control))
    hostile = _scan_under(_C_LOCALE, driver)
    friendly = _scan_under(_UTF8_LOCALE, driver)
    for label, report in (("C", hostile), ("C.UTF-8", friendly)):
        print(f"  {label:>8} child: preferred_encoding={report['preferred_encoding']!r} "
              f"files={report['files']} replaced={len(report['replaced'])} "
              f"locale_default_raises={report['locale_default_raises']}")

    if not hostile["locale_default_raises"]:
        pytest.skip("this platform coerces the C locale, so a locale-default read does not "
                    "fail there and the comparison below would prove nothing — an environment "
                    "fact")
    assert not friendly["locale_default_raises"], (
        "the UTF-8 child ALSO failed a locale-default read, so the two environments are not "
        "actually different and this comparison is vacuous")

    # Any probe a concurrently-running copy of this module planted is removed from both sides:
    # two scans seconds apart are not entitled to assume the tree stood still, and an exact
    # file COUNT would turn that race into a flake while proving nothing extra. What must match
    # is WHICH files were read.
    def corpus(paths):
        return {where for where in paths if _PROBE not in where}

    missing = corpus(friendly["paths"]) - corpus(hostile["paths"])
    assert not missing, (
        f"the C-locale run did not read {len(missing)} file(s) the UTF-8 run did — that is the "
        f"#333 defect exactly, the guarded files skipped under a locale: {sorted(missing)[:20]}")
    assert corpus(hostile["paths"]) == corpus(friendly["paths"]), (
        "the two runs read different corpora: "
        f"{sorted(corpus(hostile['paths']) ^ corpus(friendly['paths']))[:20]}")

    def findings(report):
        return [row for row in report["occurrences"] if _PROBE not in row[0]]

    assert findings(hostile) == findings(friendly), (
        "the C-locale run found a DIFFERENT set of occurrences — the guarded files are being "
        "skipped under that locale")
    assert corpus(hostile["replaced"]) == corpus(friendly["replaced"]), (
        "a different set of files needed a fallback reading under the C locale, which means "
        "the strict read is locale-sensitive after all")
    assert findings(hostile), (
        "neither run found ANY occurrence, so this comparison is two empty sets agreeing — the "
        "corpus floors in TEST-3/TEST-5 are what would normally catch that, and it is asserted "
        "here too so this test cannot pass on a scan that found nothing")


# ── TEST-5 — the corrected clause is PRESENT, not merely the wrong one absent ──────


def _shipped_writers():
    return tuple(sorted((path.parent.parent for path in _PACKAGES.glob(f"*/{_WRITER_REL}")),
                        key=lambda path: path.name))


def test_the_corrected_clause_is_still_present_everywhere_it_belongs():
    """TEST-5 [acceptance] [invariant: INV-5] [covers: ITEM-1, ITEM-2, ITEM-3, ITEM-4].

    `staleClaims.test.ts` states the rule this implements: "Absence-checking alone would go
    green on a file that deleted the paragraph entirely." So the presence is asserted with
    floors — over the glob-discovered writers (a floor of three, because an identity or
    presence claim over ONE surviving copy is vacuously true, which is how a package silently
    stops being covered) and over the tree as a whole.
    """
    count = derived_count()
    writers = _shipped_writers()
    assert len(writers) >= _MIN_SHIPPED_WRITERS, (
        f"expected at least {_MIN_SHIPPED_WRITERS} packages shipping `{_WRITER_REL.as_posix()}`,"
        f" found {[p.name for p in writers]}. A copy that VANISHED is a package that stopped "
        "being covered.")
    for package in writers:
        found = occurrences_in((package / _WRITER_REL).read_text(encoding="utf-8"), package.name)
        assert found, (
            f"{package.name}'s `{_WRITER_REL.as_posix()}` does not state #158's measurement at "
            "all. The three shipped copies are byte-identical by contract "
            "(`test_ome_dtype_refusal.py::test_every_shipped_ome_writer_is_byte_identical`), so "
            "either the paragraph was DELETED from all of them — which is not correcting it, "
            "and is the cheapest way to satisfy a stale-prose guard — or a new package has "
            "vendored a copy that has diverged, which that byte-identity test will also refuse. "
            "Fix whichever it is; do not delete the paragraph.")
        assert all(occurrence[2] == count for occurrence in found), _report(
            [o for o in found if o[2] != count], count, derived_word())

    report = scan_packages_tree()
    # Probes belonging to a concurrently-running copy of this module are excluded: they would
    # inflate both floors, which is the direction that makes a floor stop protecting anything.
    found_here = [o for o in report["occurrences"] if _PROBE not in o[0]]
    assert len(found_here) >= _MIN_OCCURRENCES, (
        f"only {len(found_here)} copies of #158's clause remain under "
        f"{_PACKAGES.name}/; expected at least {_MIN_OCCURRENCES}. #321 corrected five, and a "
        "guard that goes green when they are deleted instead is not guarding anything.")
    carriers = {occurrence[0] for occurrence in found_here}
    assert len(carriers) >= _MIN_FILES_WITH_OCCURRENCE, (
        f"the clause now survives in only {sorted(carriers)}")


# ── TEST-6 / TEST-7 — the controls, without which the zero above is worthless ──────


def test_the_detector_really_does_report_a_wrong_count():
    """TEST-6 [covers: ITEM-4] — THE POSITIVE CONTROL, including line-wrapped.

    Without this, an empty offender list is indistinguishable from a matcher that never fires.
    The wrap is exercised at EVERY word boundary rather than the first: a 96-column comment
    wrap lands wherever it lands, and a control that only demonstrates the capability at
    position 1 demonstrates it nowhere a real wrap would occur.
    """
    count = derived_count()
    word = derived_word()

    # The correct spelling is quiet, in word form and in digits.
    for spelling in (word, str(count)):
        found = occurrences_in(_sentence(spelling))
        assert len(found) == 1 and found[0][2] == count, (spelling, found)

    # A restored "ten", a different wrong word, a wrong digit, and a spelled-out neighbour are
    # each REPORTED with the count they state.
    for spelling, expected in (("ten", 10), ("eight", 8), ("twelve", 12), ("10", 10), ("7", 7)):
        if expected == count:  # pragma: no cover — only if the fixture is regenerated
            continue
        found = occurrences_in(_sentence(spelling))
        assert len(found) == 1, (spelling, found)
        assert found[0][2] == expected, (spelling, found)
        assert found[0][2] != count

    # A rewording that drops the count entirely must not slip through as "no finding".
    reworded = f"14 ranged GETs for one tile, and they were {_TAIL}."
    found = occurrences_in(reworded)
    assert len(found) == 1 and found[0][2] != count, found

    # LINE-WRAPPED inside a `#:` comment block, at every word boundary.
    stale = _sentence("ten")
    words = stale.split(" ")
    for at in range(1, len(words)):
        wrapped = "#: " + " ".join(words[:at]) + "\n#: " + " ".join(words[at:])
        found = occurrences_in(wrapped)
        assert len(found) == 1, (at, wrapped, found)
        assert found[0][2] == 10, (at, found)

    # …and wrapped at the HYPHEN, which is a different shape and was a real hole: the rejoin
    # reads `full- width` — a hyphen AND a space — which a single-character class does not
    # match, so the earlier pattern went quiet on a copy a 96-column wrap could produce.
    hyphen_wrapped = "#: " + stale.replace("full-width", "full-\n#: width")
    found = occurrences_in(hyphen_wrapped)
    assert len(found) == 1 and found[0][2] == 10, (hyphen_wrapped, found)

    # …and with the compound closed up entirely, which an editing pass produces just as easily.
    found = occurrences_in(stale.replace("full-width", "fullwidth"))
    assert len(found) == 1 and found[0][2] == 10, found


def test_two_copies_in_one_file_are_both_reported():
    """TEST-7 [covers: ITEM-4] — the `re.search` trap, closed and proven.

    `re.search` returns only the FIRST match in a file. A guard built on it reports one copy
    and is blind to the second in the same file — and `staleClaims.test.ts` names exactly this
    hole in its own allowlist ("the exemption is per FILE, so a second copy inside … is not
    caught"). Everything here counts.
    """
    count = derived_count()
    both = _sentence("ten") + "\n\nAnd elsewhere in the same file: " + _sentence("eight")
    found = occurrences_in(both, "one-file.py")
    assert len(found) == 2, found
    assert [occurrence[1] for occurrence in found] == [0, 1]
    assert [occurrence[2] for occurrence in found] == [10, 8]
    assert all(occurrence[2] != count for occurrence in found)

    # …and the same, through the real tree walk rather than the in-memory helper.
    with planted(both) as rel:
        through_the_walk = [o for o in scan_packages_tree()["occurrences"] if o[0] == rel]
    assert len(through_the_walk) == 2, through_the_walk
    assert [occurrence[2] for occurrence in through_the_walk] == [10, 8]


# ── TEST-11 — the ways a copy could have hidden from the WALK itself ──────────────


def test_no_encoding_or_link_trick_keeps_a_copy_out_of_the_scan():
    """TEST-11 [covers: ITEM-4] — the never-skip half of #333, exercised rather than asserted.

    #333's lesson has two halves and only one of them is about the encoding argument. The
    other is `except UnicodeDecodeError: continue` — the file is not merely mis-read, it is
    NOT READ AT ALL, and the guard passes. This module answers that with `readings_of`, and
    a claim that a file is never skipped is worth exactly as much as a test that plants an
    unreadable one and demands it back.

    Seven plants, each a real file in the real tree, each a spelling a guard could plausibly
    have missed:

      * **latin-1** — a stray high byte makes the strict UTF-8 read raise; the fallback
        reading must still find the clause.
      * **UTF-16** — the case that makes "the clause is ASCII, a replacement character cannot
        hide it" false: decoded as UTF-8-with-replacement, every letter is separated by a NUL.
        The NUL-stripped reading is what closes it.
      * **a symlinked file whose target is OUTSIDE the tree** — one `ln -s` was a complete
        evasion while the walk skipped symlinks.
      * **a unicode non-breaking hyphen** inside the compound, which no hyphen-or-space
        character class matches until the dashes are folded;
      * **BOM-less `utf-16-le`, `utf-16-be` and `utf-32-le`** — the case a BOM'd plant does
        NOT cover, because without a BOM the bytes are valid UTF-8 and the strict read
        succeeds.
    """
    count = derived_count()

    def flagged(rel):
        return [o for o in scan_packages_tree()["occurrences"] if o[0] == rel and o[2] != count]

    stale = _sentence("ten")

    with planted(("café: " + stale).encode("latin-1"), suffix=".md") as rel:
        assert flagged(rel), "a latin-1 file's copy was skipped rather than scanned"

    with planted(stale.encode("utf-16"), suffix=".md") as rel:
        assert flagged(rel), (
            "a UTF-16 file's copy was invisible — the replacement decode leaves a NUL between "
            "every letter, so 'the clause is ASCII and survives a replacement' is false here")

    # …and BOM-LESS, which is the harder half and the one an earlier cut got wrong. WITH a BOM
    # the strict UTF-8 read raises and the fallback branch runs; without one the file is VALID
    # UTF-8 (every byte below 0x80, NUL is legal), so the strict read SUCCEEDS and returns a
    # string with a NUL between every letter. `iconv -t utf-16le`, a Windows editor and git's
    # own working-tree conversion all produce this file.
    for codec in ("utf-16-le", "utf-16-be", "utf-32-le"):
        with planted(stale.encode(codec), suffix=".md") as rel:
            assert flagged(rel), (
                f"a BOM-less {codec} copy was invisible: the strict UTF-8 read succeeds on it, "
                "so a fallback that only runs after a decode error never sees it")

    outside = Path(tempfile.mkdtemp(prefix="wire-outside-")) / "stale.md"
    outside.write_text(stale, encoding="utf-8")
    try:
        with planted(None, suffix=".md", link_to=outside) as rel:
            assert flagged(rel), (
                "a symlinked file was skipped, so `ln -s` anywhere under src-app/packages/ "
                "hides a copy from this guard entirely")
    finally:
        outside.unlink(missing_ok=True)
        outside.parent.rmdir()

    with planted(stale.replace("full-width", "full\u2011width"), suffix=".md") as rel:
        assert flagged(rel), "a non-breaking hyphen hid the compound from the anchor"


# ── TEST-12 — INV-4's LITERAL text, asserted on this module's own source ──────────


def _discards_the_file(body):
    """Is this `except` body the `continue` #333 names — i.e. does the file go unscanned?"""
    if len(body) != 1:
        return False
    only = body[0]
    if isinstance(only, (ast.Continue, ast.Pass)):
        return True
    if isinstance(only, ast.Return):
        if only.value is None:
            return True
        if isinstance(only.value, ast.Constant) and only.value.value is None:
            return True
        if isinstance(only.value, (ast.List, ast.Tuple)) and not only.value.elts:
            return True
    return False


#: The handlers that can ONLY come from a decode. Flagged wherever they discard the file.
#: `ValueError` is deliberately NOT here even though it is a base of `UnicodeDecodeError` — it
#: was, for one round, and it flagged `int()` parsing and a `relative_to()` containment test,
#: neither of which reads a file. A matcher whose findings a reader learns to scroll past is
#: worse than a narrower one.
_DECODE_ONLY = ("UnicodeDecodeError", "UnicodeError")

#: The handlers that catch a decode failure ALONG WITH everything else. A bare `except:` is one
#: of them (spelled `None` here). These are flagged only when the `try` they belong to actually
#: READS — otherwise every `rmdir` and `stat` guard in the file reads as #333's defect, which is
#: how a matcher earns the right to be ignored.
_SWALLOWS_ANYTHING = (None, "Exception", "BaseException", "OSError", "IOError",
                      "EnvironmentError")

#: Call names that mean "this `try` is reading a file".
_READ_CALLS = ("read_text", "read_bytes", "read", "open", "readlines")


def _handler_names(handler):
    node = handler.type
    if node is None:
        return [None]
    if isinstance(node, ast.Name):
        return [node.id]
    if isinstance(node, ast.Tuple):
        return [e.id for e in node.elts if isinstance(e, ast.Name)]
    return []


def _body_reads(body):
    for statement in body:
        for node in ast.walk(statement):
            if isinstance(node, ast.Call):
                name = (node.func.attr if isinstance(node.func, ast.Attribute)
                        else node.func.id if isinstance(node.func, ast.Name) else None)
                if name in _READ_CALLS:
                    return True
    return False


def _names_utf8(call):
    """Does this call name `encoding=` AND give it a UTF-8 spelling?

    Presence alone is not enough: `encoding=locale.getpreferredencoding()` and
    `encoding="latin-1"` both satisfy "the keyword is there" and both defeat INV-4. A keyword
    this walk cannot evaluate (a name, a call, a `**kwargs` splat) answers False and is
    reported as unverifiable rather than assumed good.
    """
    if any(keyword.arg is None for keyword in call.keywords):
        return False  # a `**{...}` splat; nothing here can see what is in it
    for keyword in call.keywords:
        if keyword.arg != "encoding":
            continue
        value = keyword.value
        return (isinstance(value, ast.Constant) and isinstance(value.value, str)
                and value.value.lower().replace("_", "-") in ("utf-8", "utf8"))
    return False


def locale_offenders(source, where="<memory>"):
    """Every place in PYTHON `source` that would decode with the LOCALE, or drop a file.

    Python only — it is an `ast.parse`, so anything else raises `SyntaxError` rather than
    answering "no findings".

    This is INV-4 stated as what it literally is — a property of the SOURCE, not of a run —
    and that is deliberate. A behavioural comparison of two locales cannot see a scan that
    reads with the locale and then papers over the failure with a byte fallback: the results
    are identical because the clause is ASCII, which is the very assumption this module had to
    disavow elsewhere. Measured: such a mutant passes TEST-4 and the whole module. It does not
    pass this.
    """
    # WHAT IT SEES, stated because a source matcher's reach is its whole meaning: calls written
    # as an ATTRIBUTE named `read_text` or `run`, and `except` handlers naming
    # `UnicodeDecodeError`/`UnicodeError`, a bare `except:`, or the broad handlers that catch
    # a decode error along with everything else. It does NOT see `io.open`, `codecs.open`, or a
    # read reached through `getattr`. That is a deliberate floor rather
    # than an oversight: those spellings do not appear in this tree's test modules, and a
    # matcher that chased every way to open a file would be the unbounded-predicate shape this
    # module's docstring disavows. The behavioural half (TEST-4's two locales, TEST-11's
    # planted undecodable files) is what covers a read this walk cannot name.
    offenders = []
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Call):
            named = {keyword.arg for keyword in node.keywords}
            attr = node.func.attr if isinstance(node.func, ast.Attribute) else None
            plain = node.func.id if isinstance(node.func, ast.Name) else None
            if attr == "read_text" and not _names_utf8(node):
                offenders.append(f"{where}:{node.lineno}: `.read_text()` does not name "
                                 "`encoding=\"utf-8\"`, so it decodes with the locale default "
                                 "(#333)")
            splatted = any(keyword.arg is None for keyword in node.keywords)
            if attr in ("run", "read_text") and splatted:
                offenders.append(f"{where}:{node.lineno}: `.{attr}(..., **kwargs)` hides its "
                                 "keywords from this check, so whether it names an encoding "
                                 "cannot be verified — write them out")
            if (attr in ("run", "check_output", "Popen")
                    and ("text" in named or "universal_newlines" in named)
                    and not _names_utf8(node)):
                offenders.append(f"{where}:{node.lineno}: `.{attr}(..., text=True)` does not "
                                 "name `encoding=\"utf-8\"`, so it decodes with the locale "
                                 "default")
            # A bare `open()` is the same defect with a different spelling, and an earlier cut
            # of this matcher could not see it at all.
            if (plain == "open" or attr == "open") and not _names_utf8(node) \
                    and "mode" not in named:
                offenders.append(f"{where}:{node.lineno}: `open()` does not name "
                                 "`encoding=\"utf-8\"`, so it decodes with the locale default")
        if isinstance(node, ast.Try):
            reads = _body_reads(node.body)
            for handler in node.handlers:
                if not _discards_the_file(handler.body):
                    continue
                names = _handler_names(handler)
                decode_only = any(name in _DECODE_ONLY for name in names)
                broad = any(name in _SWALLOWS_ANYTHING for name in names)
                if decode_only or (broad and reads):
                    offenders.append(
                        f"{where}:{handler.lineno}: this handler DISCARDS the file — that is "
                        "#333's `except UnicodeDecodeError: continue`, which skips the very "
                        "files being guarded and passes silently")
    return offenders


def test_nothing_in_this_module_reads_with_the_locale_or_drops_an_undecodable_file():
    """TEST-12 [acceptance] [invariant: INV-4] [covers: ITEM-4] — the invariant AS WRITTEN.

    #333's sentence is about the source: "if the scan uses `Path.read_text()` WITHOUT
    `encoding="utf-8"` … and a `except UnicodeDecodeError: continue` then skips the very files
    being guarded, silently passing." TEST-4 checks the behavioural consequence across two
    locales; this checks the literal thing.

    NEITHER ALONE IS ENOUGH, and the honest statement of which catches what was arrived at by
    measurement rather than by argument — both halves of it were wrong once. A scan that reads
    with the locale and falls back to bytes produces the SAME findings in both locales (the
    clause is ASCII), so TEST-4 goes green on it if the fallback is relabelled to hide in
    `replaced`; this catches that. Conversely, a read moved out of this module, spelled through
    `io.open`, or reached via `getattr`, is invisible to an AST walk over one file; TEST-4's
    `replaced` comparison catches those, because the C child then falls back on 443 files and
    the UTF-8 child on 27. A blind auditor demonstrated a mutant slipping past each of them in
    turn, which is why both are here and why neither docstring may claim to be the pin.

    Controls first, and they are not decoration: a source matcher that never fires certifies
    anything.
    """
    clean = "\n".join((
        "import subprocess",
        "from pathlib import Path",
        "def read(path):",
        "    try:",
        "        return path.read_text(encoding='utf-8')",
        "    except UnicodeDecodeError:",
        "        return path.read_bytes().decode('utf-8', errors='replace')",
        "def git(args):",
        "    return subprocess.run(args, capture_output=True, text=True, encoding='utf-8')",
    ))
    assert locale_offenders(clean) == [], locale_offenders(clean)

    for mutant, expected in (
        ("def f(p):\n    return p.read_text()\n", "does not name"),
        ("import subprocess\ndef f(a):\n    return subprocess.run(a, text=True)\n",
         "does not name"),
        ("def f(p):\n    for q in p:\n        try:\n            q.read_text(encoding='utf-8')\n"
         "        except UnicodeDecodeError:\n            continue\n", "DISCARDS the file"),
        ("def f(p):\n    try:\n        return p.read_text(encoding='utf-8')\n"
         "    except UnicodeDecodeError:\n        return []\n", "DISCARDS the file"),
        ("def f(p):\n    try:\n        return p.read_text(encoding='utf-8')\n"
         "    except UnicodeDecodeError:\n        pass\n", "DISCARDS the file"),
        # …and the shapes an earlier cut of this matcher could not see at all.
        ("def f(p):\n    return open(p).read()\n", "does not name"),
        ("def f(p):\n    return p.read_text(encoding='latin-1')\n", "does not name"),
        ("import locale\ndef f(p):\n"
         "    return p.read_text(encoding=locale.getpreferredencoding())\n", "does not name"),
        ("import subprocess\ndef f(a):\n"
         "    return subprocess.run(a, **{'text': True, 'encoding': 'utf-8'})\n",
         "cannot be verified"),
        ("def f(p):\n    for q in p:\n        try:\n            q.read_text(encoding='utf-8')\n"
         "        except:\n            continue\n", "DISCARDS the file"),
        ("def f(p):\n    for q in p:\n        try:\n            q.read_text(encoding='utf-8')\n"
         "        except Exception:\n            continue\n", "DISCARDS the file"),
    ):
        found = locale_offenders(mutant, "mutant")
        assert len(found) == 1 and expected in found[0], (mutant, found)

    offenders = locale_offenders(Path(__file__).read_text(encoding="utf-8"),
                                 Path(__file__).name)
    assert not offenders, (
        "this module — the one written to close #333 — would itself decode with the locale or "
        "drop a file it cannot decode:\n  " + "\n  ".join(offenders))


_ALLOWLIST = re.compile(
    r"const\s+CORRECTED_BY_259_ALLOWED\s*:\s*readonly\s+string\[\]\s*=\s*\[(.*?)\]",
    re.DOTALL)

#: One quoted path per line. The trailing comma AND a trailing `//` comment are both optional:
#: an entry written either way would otherwise be invisible here, and this test going green
#: while `staleClaims.test.ts` goes red on merge is the exact failure it exists to prevent — a
#: blind audit re-added the package path as `'…/ome_writer.py', // re-exempted while #340
#: lands`, in the style the surrounding file already uses, and this test passed. Matching
#: every quoted run inside the block instead would also catch the apostrophe in a comment
#: ("#259's scope"), which is how a lax parser invents entries that do not exist.
_ALLOWLIST_ENTRY = re.compile(r"(?m)^\s*['\"]([^'\"]+)['\"]\s*,?\s*(?://.*)?$")


def _allowlist_offenders(entries, count):
    """Allowlisted paths under `src-app/packages/` that NO LONGER state a stale count.

    Each such entry is one `staleClaims.test.ts` will fail on, because that test asserts every
    allowlisted path STILL contains the retired sentence.
    """
    offenders = []
    for entry in entries:
        resolved = (_VIZ / entry).resolve()
        try:
            resolved.relative_to(_PACKAGES)
        except ValueError:
            continue  # outside `src-app/packages/` — not this branch's business
        assert resolved.is_file(), f"allowlisted path does not exist: {entry}"
        stale = [o for o in occurrences_in(resolved.read_text(encoding="utf-8"), entry)
                 if o[2] != count]
        if not stale:
            offenders.append(entry)
    return offenders


def test_the_viz_allowlist_holds_no_package_path_that_no_longer_states_the_old_count():
    """TEST-8 [acceptance] [invariant: INV-2] [covers: ITEM-5] — #333, checkable from here.

    `staleClaims.test.ts` asserts every `CORRECTED_BY_259_ALLOWED` path STILL contains the
    stale clause, deliberately, "so the exemption cannot outlive what it exempts". The
    consequence is that landing #321 without shrinking that list turns main RED — and #333's
    complaint is precisely that "a pytest-only verification command … cannot see it".

    This test makes it visible from the package suite: an allowlist entry pointing under
    `src-app/packages/` is legitimate only while that file still states a count OTHER than the
    derived one. It is the same implication `staleClaims.test.ts` enforces, read from the other
    end, so a #321 implementer who never opens `libs/viz` is still told.

    HONEST SHAPE, because it matters for reading a green run: once the allowlist has been
    shrunk correctly it holds exactly one entry, the design document, which resolves OUTSIDE
    `src-app/packages/` — so the offender loop iterates an EMPTY in-scope set and the final
    assertion is true by construction. This is a REGRESSION guard, not a standing measurement:
    what does the work every run is the control just below, which applies the same predicate to
    the entry #321 deleted and requires it to be reported. Re-add a package path and this test
    goes red; that is the whole of what it promises.
    """
    assert _STALE_CLAIMS.is_file(), (
        f"{_STALE_CLAIMS} has moved; #333's coupling is no longer where this test looks for it")
    source = _STALE_CLAIMS.read_text(encoding="utf-8")
    block = _ALLOWLIST.search(source)
    assert block, ("`CORRECTED_BY_259_ALLOWED` is no longer a literal array in "
                   "staleClaims.test.ts — re-derive this check against its new shape rather "
                   "than dropping it")
    entries = _ALLOWLIST_ENTRY.findall(block.group(1))
    assert entries, "the allowlist is empty; `staleClaims.test.ts` asserts it is not"
    print(f"\nCORRECTED_BY_259_ALLOWED = {entries}")

    count = derived_count()

    # THE CONTROL, first: the same predicate applied to the entry #321 deletes MUST report it.
    # Without it, "no offenders" is indistinguishable from a parser that resolved nothing.
    control = "../../packages/spatial-types/compute/ome_writer.py"
    assert (_VIZ / control).resolve().is_file(), (
        "the control path no longer exists; re-point it at a corrected package copy")
    assert _allowlist_offenders([control], count) == [control], (
        "the predicate does not fire on a package copy that has been corrected, so its silence "
        "on the real allowlist below means nothing")

    offenders = _allowlist_offenders(entries, count)
    assert not offenders, (
        "these are still allowlisted in `CORRECTED_BY_259_ALLOWED` "
        f"({_STALE_CLAIMS.relative_to(_REPO).as_posix()}) but no longer state a count other "
        f"than the derived {count}, so that test's 'every allowlisted path must STILL contain "
        "the sentence' loop will FAIL on merge. Delete the entry in the SAME commit (#333):\n  "
        + "\n  ".join(offenders))


# ── TEST-9 — the seed versions moved, and the changelog says why ──────────────────


def _manifest_version(text):
    found = re.search(r"^version:\s*(\S+)\s*$", text, re.MULTILINE)
    # YAML lets the value be quoted; `\S+` would capture the quotes and `_as_tuple` would then
    # raise a ValueError — a test ERROR rather than a legible failure.
    return found.group(1).strip("'\"") if found else None


def _changelog_entries(text):
    """`[(version, line)]` for every `# X.Y.Z — …` changelog line in a manifest header.

    A LIST, not a dict keyed by version: two lines at the same version are both real, and a
    dict silently kept only the last — which would let a later non-`#321` line at that version
    mask the `#321` entry this test is looking for. The dash class takes the em-dash the
    manifests use, the en-dash a copy-paste produces, and the ASCII hyphen.
    """
    return [(match.group(1), match.group(0)) for match in
            re.finditer(r"(?m)^#\s+(\d+\.\d+\.\d+)\s+[\u2014\u2013-].*$", text)]


def test_every_package_carrying_the_clause_bumped_its_version_and_said_why():
    """TEST-9 [acceptance] [invariant: INV-6] [covers: ITEM-6] — the extract-cache trap.

    `src-app/packages/` is embedded as a seed and reconciled on `manifest.yaml`'s `version`, so
    a package whose files changed at an unchanged version keeps executing the OLD kernel on an
    already-provisioned deployment. The sibling
    `test_ome_dtype_refusal.py::test_a_vendoring_package_whose_files_changed_also_moved_its_manifest_version`
    enforces the bump; this adds the half that is convention rather than mechanism — a bare
    number bump with no changelog entry, which this repo's manifests do not do.

    Deliberately scoped to THIS change's entry rather than to every version. These manifests
    carry a pre-existing gap (several shipped versions have no entry of their own), and
    asserting the general rule here would redden on prose that predates the branch — which is
    a finding to file, not a guard to smuggle in.

    THE TWO HALVES HAVE DIFFERENT LIFETIMES, and the shorter one should not be mistaken for an
    invariant. The git half is an IMPLICATION over `git diff origin/main...` — once this branch
    is on main the premise is false and it passes vacuously, exactly like the sibling TEST-13,
    and that is what keeps it merge-stable instead of a permanent red. It also skips outright
    where no `origin/main` ref exists. What survives the merge is the changelog half: the
    `#321` entry must exist in all three manifests and may not name a version AHEAD of the
    declared one — which is what caught the un-bumped manifest in the mutation battery, not the
    git comparison.
    """
    recorded = []
    for package in _shipped_writers():
        text = (package / "manifest.yaml").read_text(encoding="utf-8")
        version = _manifest_version(text)
        assert version, f"{package.name}/manifest.yaml states no `version:`"
        entries = _changelog_entries(text)
        mine = [at for at, line in entries if re.search(r"#321(?![0-9])", line)]
        if mine:
            recorded.append(package.name)
        declared = _as_tuple(version)
        assert declared is not None, (
            f"{package.name}/manifest.yaml declares `version: {version}`, which is not an "
            "X.Y.Z triple; this test cannot compare it to a changelog entry")
        for at in mine:

            assert _as_tuple(at) is not None and _as_tuple(at) <= declared, (
                f"{package.name}: the #321 changelog entry names {at}, which is not comparable "
                f"to, or is AHEAD of, the declared `version: {version}`")

    # The `#321` entry is required of the packages that CARRIED the correction, and of no
    # others. An earlier cut demanded it of every package shipping the writer, so a future
    # `spatial-import-<vendor>` vendoring the file would have been told its brand-new
    # `manifest.yaml` "has no `# X.Y.Z — #321:` entry" and that "the version moved for this
    # change" — two statements about a history it has none of. A floor of three is what the
    # correction actually needs, and it is the same floor the byte-identity contract uses.
    assert len(recorded) >= _MIN_SHIPPED_WRITERS, (
        f"only {sorted(recorded)} record the #321 correction in their changelog; the writer is "
        f"vendored into {[p.name for p in _shipped_writers()]} and the seed is reconciled on "
        "`version`, so all three copies moved together and all three must say why. A bare "
        "number bump breaks this file's own convention: the log is how a reader learns what an "
        "extraction is bringing them.")



def _as_tuple(version):
    """`"0.8.4"` → `(0, 8, 4)`; anything else answers `None` rather than raising.

    A pre-release or build-metadata version (`1.2.3-rc.1`, `v1.2.3`) is not a reason for this
    test to ERROR with a ValueError traceback; the caller states plainly that it could not
    compare and why.
    """
    parts = version.split(".")
    if len(parts) != 3 or not all(part.isdigit() for part in parts):
        return None
    return tuple(int(part) for part in parts)


# ── TEST-10 — the design section no longer describes the gap as open ─────────────


def test_the_design_section_no_longer_says_the_package_copies_still_disagree():
    """TEST-10 [covers: ITEM-7] — a design that describes a fixed defect as open is worse than
    silence, because a reader who believes it will re-file the issue or re-introduce the gap.

    §2's amendment stated, correctly at the time, that five copies survive under
    `src-app/packages/` and that "this document and those five disagree". This change is what
    made both false. The QUOTED stale clause stays — `CORRECTED_BY_259_ALLOWED` still
    allowlists this file and asserts its presence, because the retraction must quote what it
    retracts — so this is a check on the surrounding tense, not on the quote.
    """
    assert _DESIGN.is_file()
    text = _DESIGN.read_text(encoding="utf-8")
    normalized = normalize(text)

    stale_prose = [
        "Five copies of the old sentence survive, deliberately.",
        "Until that lands, this document and those five disagree",
        "they are left rather than touched, and filed as",
    ]
    still_open = [phrase for phrase in stale_prose if normalize(phrase).strip() in normalized]
    assert not still_open, (
        f"{_DESIGN.relative_to(_REPO).as_posix()} §2 still describes #321 as unlanded:\n  "
        + "\n  ".join(repr(phrase) for phrase in still_open))

    # …and the retraction still quotes what it retracts, which the viz allowlist REQUIRES.
    quoted = occurrences_in(text, _DESIGN.name)
    assert any(occurrence[2] != derived_count() for occurrence in quoted), (
        "the design document no longer quotes the retired spelling. `CORRECTED_BY_259_ALLOWED` "
        "in staleClaims.test.ts asserts that it does — removing the quote turns that test red "
        "just as surely as leaving a stale copy in a package does.")
    # The needle `staleClaims.test.ts` pins by name, rebuilt from the DERIVED word rather than
    # typed — otherwise this one line would still demand "nine" while every other test in the
    # module demanded whatever the artifact says, and the module would assert two counts at once.
    needle = f"of which **{derived_word()} were consecutive full" "-width"
    # NORMALIZED, like every other match in this module. Raw, a cosmetic re-wrap of that
    # markdown paragraph — which renders identically — turned this red and dumped the whole
    # design document as the assert repr. `staleClaims.test.ts` pins the same literal in the
    # same file and normalizes both sides; this was the one place that did not.
    assert normalize(needle).strip() in normalized, (
        f"the corrected figure that `staleClaims.test.ts` pins by name ({needle!r}) is gone "
        "from §2")


def test_the_changed_packages_also_moved_their_manifest_version():
    """TEST-9b [acceptance] [invariant: INV-6] — the DIFF half of TEST-9, kept LIVE.

    ## Why this reads git history and is NOT behind a scope gate

    `_lib/test_zero_core_guard.py::test_no_package_test_reads_a_branch_diff_without_a_scope_gate`
    sweeps every package test module for a history read that does not route through
    `require_introducing_branch` / `require_introducing_file`, and it named this assertion — it
    used to sit UNGATED inside TEST-9, which is a real defect and is why this function exists.

    The first repair gated it on `require_introducing_file` keyed on this module's own path. That
    was WRONG, and measured wrong: this file has been on `origin/main` since `6fa8126f`, so
    `--diff-filter=A` can never match it again and the gate SKIPS on every branch that can ever be
    cut. A guard that can no longer fail reports green for a reason unrelated to what it claims
    (`derived-guards.md` §1) — self-limiting became SELF-DISABLING, which
    `require_introducing_file`'s own docstring names as strictly worse than the unscoped guard.

    So it takes the FOURTH remedy the sweep's own failure message offers, after the three §5
    refuses: it is entered in `_SWEEP_EXCEPTIONS` as `<path>::<test>` with the mechanism that
    makes it self-limiting WRITTEN DOWN. That mechanism, stated here as well as there:

        this loop asks, per shipped writer, whether THIS branch touched that package at all, and
        `continue`s when it did not. A branch that leaves `spatial-import-visium`,
        `spatial-import-xenium` and `spatial-types` alone cannot redden it. A branch that does
        touch one of them is asked for exactly the version bump
        `scripts/check-processor-seed-versions.sh` asks of it anyway.

    That is the same reasoning, and the same `<path>::<test>` narrowness, as
    `_helpers/tests/test_visium_chain_zero_src_app.py::test_the_helpers_package_version_moved_forward`
    — whose docstring states the preference this follows: *"Armed on any branch that touches
    `_helpers`, not only this one — the property is durable and the next branch to add a helper
    should inherit the check."* The durable reading is the right one here too: a future branch
    that edits a vendored `ome_writer.py` without bumping its package is exactly what this is for,
    and a gate would have let that through in silence.

    ## Why it is a SEPARATE test from TEST-9

    Kept from the first repair, because it is right for a second reason. This half can SKIP —
    `repo_root()` skips outside a git checkout, which is the one honest reason a diff-scoped
    assertion cannot run. Inside TEST-9 that skip marked the WHOLE test skipped, taking TEST-9's
    branch-independent assertions (every carrying package records a `#321` entry; at least three
    do) with it even though they had already run and passed. Split, they report as the pass they
    are.

    ## The git plumbing is the SHARED plumbing

    `repo_root` / `diff_point` / `changed_paths` rather than a fourth private copy of merge-base
    resolution — `zero_core_guard`'s module docstring exists because that plumbing had already
    been triplicated and had already diverged. This also fixes two things the private copy got
    wrong: it demanded `origin/main` and skipped when only `main` resolved (`diff_point` falls
    back), and it ran one `git diff` per package instead of one for the branch.
    """
    root = repo_root()
    base = diff_point(root)
    changed = changed_paths(root)

    unbumped = []
    for package in _shipped_writers():
        relative = package.relative_to(_REPO).as_posix()
        if not any(p == relative or p.startswith(f"{relative}/") for p in changed):
            continue
        # A package that did not exist at the base has no earlier version to move FROM; that is
        # the introducing diff, not a missing bump, and `check-processor-seed-versions.sh`
        # `continue`s on the same case for the same reason.
        before = subprocess.run(["git", "show", f"{base}:{relative}/manifest.yaml"],
                                cwd=str(root), capture_output=True, text=True, encoding="utf-8",
                                timeout=30)
        if before.returncode != 0:
            continue
        was = _manifest_version(before.stdout)
        now = _manifest_version((package / "manifest.yaml").read_text(encoding="utf-8"))
        if was is not None and was == now:
            unbumped.append(f"{package.name}: files changed but version stayed {now}")
    assert not unbumped, (
        "a seed package carrying #158's clause changed without a `manifest.yaml` version bump, "
        "so an already-provisioned deployment would skip re-extraction and keep running the "
        "OLD package:\n  " + "\n  ".join(unbumped))
