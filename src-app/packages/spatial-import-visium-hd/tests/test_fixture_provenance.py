#!/usr/bin/env python3
# ruff: noqa
"""TEST-32 / TEST-33 — the fixture is what the generator says it is, and it says what it is not.

Every other suite in this directory runs on `tests/fixtures/visium-hd-outs/`. That makes
the fixture the thing all of them ultimately assert against, so two questions about it are
prior to every question about the importer:

* **TEST-32 — is it what it claims to be?** The committed bytes must be exactly what the
  committed `make_fixture.py` produces (regenerate, digest, compare); every file must have
  a `PROVENANCE.json` record and every record a file; the provenance must state IN WORDS
  that no real Visium HD bundle was available; and every FORMAT CLAIM must still resolve to
  a real repo file with the quoted sentence still in it.
* **TEST-33 — does it have the two properties the other suites' CONTROLS depend on?** It
  must be NON-SQUARE in both frames, and its three bins must really nest 16:1 and 64:1.

## Why a fixture whose limits are not written down is worse than one that has them

**No real Visium HD bundle was available** (DEC-9). Every byte under `visium-hd-outs/` is
in the vendor's own format and none of it is the vendor's own data, so what this whole
suite proves is a claim about the format this repo has DOCUMENTED — not about vendor bytes.

A synthesized fixture that says so is a bounded instrument: a reader knows what a green run
is evidence for, and knows to re-check the format claims against a real bundle when one
arrives. A synthesized fixture that does NOT say so is worse than no fixture at all,
because it manufactures the appearance of the evidence it lacks — every suite reads green,
nobody can tell which claims rest on the vendor and which rest on us, and the first real
bundle disagrees with a system that has been "tested" for months. The disclosure is
therefore ASSERTED here rather than trusted to survive editing, and so is each citation:
a citation that has rotted is a fixture built on a fact nobody can check any more.

This mirrors the disclosure `spatial-types/tests/README-hd-fixture.md` already makes for the
HD LAYOUT fixture. It is repeated rather than assumed because the two fixtures have the same
limitation for the same reason, and a reader who meets only one of them must still be told.

## Every read names `encoding="utf-8"`

`PROVENANCE.json` is `.json` and gets one anyway. `json.loads` over bytes would sniff, and
`read_text()` with no encoding uses the locale's — which under `LC_ALL=C` is
`ANSI_X3.4-1968`, and this file's own `_note` contains an em dash. The cited research
documents are worse: they are full of `µm` and `×`, and a mis-decoded read makes a quote
check fail for a reason that has nothing to do with the citation (#330/#333/#336/#339).
"""
import hashlib
import json
import re
import struct
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import make_fixture as MF  # noqa: E402

PKG = Path(__file__).resolve().parents[1]
PACKAGES = PKG.parent
REPO = PACKAGES.parents[1]
FIXTURE = PKG / "tests" / "fixtures" / "visium-hd-outs"
PROVENANCE = PKG / "tests" / "fixtures" / "PROVENANCE.json"

#: The research line TEST-33's ratios are read against, quoted rather than paraphrased.
NESTING_DOC = REPO / "docs" / "research" / "data-processing" / "01-file-formats.md"
NESTING_LINE = 630
NESTING_QUOTE = "8 µm bin = 16 native barcodes; 16 µm = 64."


def provenance():
    """`PROVENANCE.json`, parsed. The encoding is named on a `.json` too — no exceptions."""
    return json.loads(PROVENANCE.read_text(encoding="utf-8"))


def png_size(path):
    """`(width, height)` from a PNG's IHDR, read from the COMMITTED bytes.

    Parsed here rather than through pillow so this assertion is about the file on disk and
    depends on nothing the importer also depends on — the point of TEST-33 is that the
    fixture really has the property, not that two libraries agree about it.
    """
    raw = Path(path).read_bytes()
    assert raw[:8] == b"\x89PNG\r\n\x1a\n", f"{path} is not a PNG"
    assert raw[12:16] == b"IHDR", f"{path} has no leading IHDR chunk"
    return struct.unpack(">II", raw[16:24])


def positions_path(bin_um):
    return FIXTURE / "binned_outputs" / f"square_{bin_um:03d}um" / "spatial" / "tissue_positions.parquet"


def committed_positions(bin_um):
    """One bin's COMMITTED positions table, read with pyarrow directly.

    Not through `make_fixture.positions_rows()` and not through the importer's reader. Both
    would be comparing the generator with itself, which is the tautology this file exists to
    refuse — the subject is the bytes under version control.
    """
    import pyarrow.parquet as pq

    return pq.read_table(positions_path(bin_um))


# ── TEST-32: the fixture is what the generator produces ─────────────────────────────


def test_TEST_32_the_committed_fixture_is_EXACTLY_what_the_committed_generator_produces(tmp_path):
    """TEST-32 — regenerate into a tmp dir and compare digests, file for file.

    WHAT THIS WOULD CATCH. The two ways a generated fixture rots. First, a hand edit: a byte
    changed under `fixtures/` to make one test pass, after which the generator no longer
    explains the fixture and its module docstring — which is the only place the fixture's
    reasoning lives — is describing something else. Second, a generator change that was
    never re-run: `make_fixture.py` records one such correction already (the hires
    scalefactor moving 0.25 -> 0.2 so the emitted image lands exactly at the resolution cap
    and the affine test asserts against the DESIGN rather than against the code), and a
    change like that silently leaves the committed tree a version behind.

    `MF.build` is called with an explicit destination: its default is the committed fixture
    itself, and a test that rebuilt in place would compare the tree with the tree it had
    just overwritten and pass unconditionally.

    Determinism is part of the claim, not an assumption: `write_png` fixes the zlib level
    and emits no timestamp chunk, the count matrices seed on `1000 + bin_um`, and the
    parquet is written with an explicit schema. If any of that regressed, this test is where
    it shows up.
    """
    rebuilt = tmp_path / "visium-hd-outs"
    MF.build(rebuilt)

    fresh = MF.digest_tree(rebuilt)
    committed = MF.digest_tree(FIXTURE)

    assert committed, f"{FIXTURE} holds no files at all"
    assert len(committed) == 17, (
        f"the committed fixture holds {len(committed)} files; the generator writes three "
        "bins x five members plus the two run-root files"
    )

    only_committed = sorted(set(committed) - set(fresh))
    only_fresh = sorted(set(fresh) - set(committed))
    assert not only_committed, (
        f"these files are committed under fixtures/ but the generator does not write them: "
        f"{only_committed} — either they are hand-added, or the generator dropped them"
    )
    assert not only_fresh, (
        f"the generator writes these and they are NOT committed: {only_fresh} — the "
        "generator moved and the fixture was not rebuilt"
    )

    differing = sorted(k for k in committed if committed[k] != fresh[k])
    assert not differing, (
        f"the committed bytes differ from a fresh build for: {differing}. Re-run "
        "`python3 tests/make_fixture.py` and commit the result — until then the generator "
        "does not explain the fixture, and its docstring is documenting a tree that is not "
        "the one every other suite in this directory runs on."
    )


def test_TEST_32_every_fixture_file_has_a_PROVENANCE_record_with_a_MATCHING_digest():
    """TEST-32 — both directions, because each catches a different rot.

    WHAT THIS WOULD CATCH. A file added under `fixtures/` with no provenance entry (bytes in
    the suite that nothing accounts for); an entry for a file that no longer exists (a
    manifest describing a tree that is gone); and — the one that matters most — an entry
    whose `sha256` no longer matches the file it names. That last is how a provenance
    document quietly becomes decoration: the fixture is regenerated, the digests are not
    re-captured, and from then on the file asserts nothing while looking as if it does.

    Digested with `hashlib.sha256` over the raw bytes, which is what `make_fixture.digest_tree`
    does and what the `produced_by` field claims.
    """
    doc = provenance()
    recorded = doc["files"]
    assert recorded, "`PROVENANCE.json` records no files"

    on_disk = {
        p.relative_to(FIXTURE).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(FIXTURE.rglob("*")) if p.is_file()
    }

    unrecorded = sorted(set(on_disk) - set(recorded))
    assert not unrecorded, (
        f"these fixture files have no `PROVENANCE.json` record: {unrecorded}. Bytes in a "
        "test corpus that nothing accounts for are bytes nobody can justify keeping."
    )
    missing = sorted(set(recorded) - set(on_disk))
    assert not missing, (
        f"`PROVENANCE.json` records these files and they do not exist: {missing}"
    )

    for rel in sorted(on_disk):
        entry = recorded[rel]
        assert entry.get("produced_by"), f"{rel} records no `produced_by`"
        assert entry["sha256"] == on_disk[rel], (
            f"{rel}: PROVENANCE.json records sha256 {entry['sha256']} and the committed "
            f"file hashes to {on_disk[rel]}. The recorded digest is STALE — re-capture it "
            "in the same commit that changes the fixture, or the provenance document is "
            "asserting nothing about the bytes it names."
        )


def test_TEST_32_the_provenance_STATES_that_no_real_Visium_HD_bundle_was_available():
    """TEST-32 — the disclosure, asserted as prose because prose is what it is.

    WHAT THIS WOULD CATCH. The `_note` reworded into something that reads like a
    provenance record for real vendor bytes; the `not_verified` list emptied "because
    everything passes now". Both turn a bounded instrument into a misleading one, and both
    are the sort of edit that no other test in this tree would notice.

    The specific limits matter as much as the general disclosure, so all three recorded ones
    are required to still be recorded: the per-bin BARCODE SPELLING (unverified, and
    deliberately load-bearing for nothing — bin identity comes from `bin_size_um` and the
    staged member order, never from parsing a barcode), the two run-root members the
    container deliberately does not declare (DEC-8), and the fact that every NUMBER here is
    generated rather than measured.
    """
    doc = provenance()

    note = doc["_note"]
    assert "No real Visium HD bundle was available" in note, (
        f"`_note` no longer states the fixture's central limitation in words: {note!r}"
    )
    assert "format" in note.lower() and "vendor" in note.lower(), (
        "`_note` must say what the fixture IS (the vendor's format) as well as what it is "
        f"not (the vendor's data): {note!r}"
    )
    assert doc["_generator"].startswith("tests/make_fixture.py"), (
        "`_generator` must name the committed generator this fixture is rebuilt from"
    )
    assert "Not applicable" in doc["_licence"], (
        "nothing here is redistributed; a licence claim that said otherwise would be false"
    )

    not_verified = doc["not_verified"]
    assert len(not_verified) >= 3, (
        f"only {len(not_verified)} limitation(s) recorded; three are known and each is a "
        "different kind of thing this fixture cannot stand as evidence for"
    )
    for entry in not_verified:
        assert entry["what"].strip() and len(entry["why"].strip()) > 40, (
            f"a `not_verified` entry states no real reason: {entry!r}"
        )
    subjects = " ".join(e["what"] for e in not_verified).lower()
    assert "barcode" in subjects, "the unverified BARCODE spelling is no longer recorded"
    assert "feature_slice.h5" in subjects, (
        "the undeclared run-root members (DEC-8) are no longer recorded"
    )
    assert "number" in subjects, (
        "the fact that every number here is generated rather than measured is no longer "
        "recorded, which is the limitation a reader is most likely to forget"
    )
    reasons = " ".join(e["why"] for e in not_verified)
    assert "No real Visium HD bundle was available" in reasons, (
        "no `not_verified` entry gives the reason that bounds all of them"
    )


def test_TEST_32_every_format_claim_still_RESOLVES_to_its_cited_file_and_sentence():
    """TEST-32 — a citation that has rotted is a fixture built on a fact nobody can check.

    WHAT THIS WOULD CATCH. A cited file renamed, moved or deleted; a cited SENTENCE reworded
    or removed, which is the interesting one — the claim then rests on something the repo no
    longer says, and every suite that runs on this fixture is asserting against a fact whose
    source has silently changed. This is the difference between "the fixture is synthesized
    from documented facts" and "the fixture is made up": the citations, and whether they
    still resolve.

    The `quote` is asserted PRESENT IN THE FILE rather than present AT THE RECORDED LINE.
    Line numbers in a live document drift by ordinary editing a line or two above, and a
    guard that went red for that would train people to stop citing lines. The line number is
    still checked for being a real line of the file, so a record pointing past the end — a
    citation into a document that has since shrunk — is caught.

    One entry cites a BINARY file (the real Visium `.h5` in the sibling package, from which
    this fixture's matrix layout was read dataset for dataset) and carries `quote: null`. It
    is checked for existence only, and the null is what makes that explicit rather than an
    empty string nobody can distinguish from a lost quote.
    """
    doc = provenance()
    claims = doc["format_claims"]
    assert len(claims) >= 8, (
        f"only {len(claims)} format claim(s) recorded; the generator encodes more than that"
    )

    quoted = 0
    for claim in claims:
        for key in ("claim", "encoded_as", "file", "line"):
            assert key in claim, f"a format claim is missing `{key}`: {claim!r}"
        assert len(claim["claim"].strip()) > 30, (
            f"a format claim states no real claim: {claim['claim']!r}"
        )
        assert claim["encoded_as"].strip(), (
            f"claim {claim['claim'][:60]!r} does not say where in the fixture it is encoded"
        )

        cited = REPO / claim["file"]
        assert cited.is_file(), (
            f"the citation for {claim['claim'][:70]!r} names {claim['file']}, which does "
            "not exist — the fixture rests on a document that has moved or gone"
        )

        quote = claim["quote"]
        if quote is None:
            assert claim["line"] == 0, (
                f"{claim['file']} is cited with no quote, so its `line` must be 0 rather "
                f"than the misleading {claim['line']}"
            )
            assert claim.get("note"), (
                f"a quote-less citation ({claim['file']}) must say in a `note` what was "
                "read out of it, or it cites nothing a reader can follow"
            )
            continue

        quoted += 1
        text = cited.read_text(encoding="utf-8")
        assert quote in text, (
            f"the sentence cited for {claim['claim'][:70]!r} is GONE from "
            f"{claim['file']}:\n    quoted: {quote!r}\nA citation that has rotted is a "
            "fixture built on a fact nobody can check any more — re-read the document and "
            "either re-quote it or withdraw the claim."
        )
        lines = text.splitlines()
        assert 1 <= claim["line"] <= len(lines), (
            f"{claim['file']} is cited at line {claim['line']} and has {len(lines)} lines"
        )

    assert quoted >= 7, (
        f"only {quoted} claim(s) carry a checkable quote; the rest cannot rot detectably"
    )


# ── TEST-33: the two geometric properties every control depends on ──────────────────


def test_TEST_33_the_committed_fixture_is_NON_SQUARE_in_BOTH_frames():
    """TEST-33 — the precondition `test_coordinate_space.py`'s TEST-3 control rests on.

    `spatial-storage-layout.md` §7.3 rule 5 names the trap and names the fixture requirement
    in the same breath: `tissue_positions` gives `pxl_row_*` (y) BEFORE `pxl_col_*` (x)
    while `obsm['spatial']` convention is `(x, y)`, so the importer must transpose — and
    "the test for it must assert on a **non-square** fixture", because *a square image
    passes a transposed affine silently*. The design calls the transpose "the single most
    likely bug in the whole importer" and says outright that getting it wrong "does not
    error".

    WHAT THIS WOULD CATCH. A fixture edit — a rounder lattice, a square image, a bin whose
    row and column counts happened to coincide — that leaves every other suite GREEN while
    making `test_coordinate_space.py::test_TEST_3_the_TRANSPOSED_read_would_be_a_DIFFERENT_array`
    vacuous. That test states the property of the emitted ARRAY; this one states it of the
    COMMITTED BYTES, which is where it can be satisfied only on purpose. An asymmetric
    tissue mask can make the first pass on a square fixture; nothing can make this one.

    Measured on the committed PNG's IHDR and the committed parquet's own columns, not on
    `make_fixture`'s constants: the constants are what the generator INTENDS, and this is
    the tree the suites actually run on.
    """
    for bin_um in MF.BINS:
        image = (FIXTURE / "binned_outputs" / f"square_{bin_um:03d}um" / "spatial" /
                 "tissue_hires_image.png")
        width, height = png_size(image)
        assert width != height, (
            f"{image.relative_to(FIXTURE)} is {width}x{height} — SQUARE. A square image "
            "passes a transposed affine silently (§7.3 rule 5), so TEST-3's control is now "
            "vacuous while still reading green."
        )

        table = committed_positions(bin_um).to_pydict()
        rows = len(set(table["array_row"]))
        cols = len(set(table["array_col"]))
        assert rows != cols, (
            f"the committed {bin_um} um lattice is {rows}x{cols} — SQUARE, so a transposed "
            "read of it is indistinguishable from a correct one"
        )
        # And the x/y extents really differ, which is the property the emitted coordinates
        # inherit. Equal row and column COUNTS are not the only way to lose it: an equal
        # pixel EXTENT on both axes would do it too.
        span_x = max(table["pxl_col_in_fullres"]) - min(table["pxl_col_in_fullres"])
        span_y = max(table["pxl_row_in_fullres"]) - min(table["pxl_row_in_fullres"])
        assert span_x != span_y, (
            f"the {bin_um} um lattice spans {span_x} px in x and {span_y} px in y — equal "
            "extents make a transposed coordinate array numerically indistinguishable"
        )

    # The generator's own constants agree, so the two statements of this property cannot
    # drift apart: `test_coordinate_space.py` asserts on these, this file asserts on bytes.
    assert MF.FULLRES_W != MF.FULLRES_H
    assert MF.NATIVE_ROWS != MF.NATIVE_COLS


def test_TEST_33_the_committed_bins_nest_16_to_1_and_64_to_1_over_the_2um_grid():
    """TEST-33 — the vendor's stated nesting, checked against the committed parquet row counts.

    `docs/research/data-processing/01-file-formats.md:630`: "8 µm bin = 16 native barcodes;
    16 µm = 64." The 2 µm grid is the native capture lattice — "a **continuous grid of 2×2
    µm squares** (no gaps)" — so an 8 µm square covers 4x4 = 16 of them and a 16 µm square
    covers 8x8 = 64. The committed fixture is 40x64 native (2,560), 10x16 at 8 µm (160) and
    5x8 at 16 µm (40), and those three numbers stand in exactly that relation.

    WHAT THIS WOULD CATCH. A fixture edit that flattened the nesting — three bins with
    unrelated lattices, or a coarser bin that is not a whole-number binning of the native
    one. Nothing else in the suite would notice: every per-bin assertion would keep passing
    on its own bin, and the fixture would quietly stop being a Visium HD run at all. It also
    catches a `bin_shape` that starts rounding instead of raising on a ragged division.

    Read from the COMMITTED parquet via pyarrow, never from `positions_rows()`. Deriving the
    expected counts from the generator and then checking them against the generator proves
    only that the generator agrees with itself; the subject here is the bytes on disk.

    The doc line is quoted back at the file, so a research edit that withdrew the claim turns
    this red rather than leaving a ratio in the fixture that the repo no longer asserts.
    """
    doc = NESTING_DOC.read_text(encoding="utf-8").splitlines()
    assert 1 <= NESTING_LINE <= len(doc)
    assert NESTING_QUOTE in doc[NESTING_LINE - 1], (
        f"{NESTING_DOC.relative_to(REPO)}:{NESTING_LINE} no longer reads {NESTING_QUOTE!r} "
        f"(it reads {doc[NESTING_LINE - 1]!r}) — the ratios below cite a sentence that has "
        "moved or changed"
    )

    counts = {bin_um: committed_positions(bin_um).num_rows for bin_um in MF.BINS}
    native = counts[MF.NATIVE_BIN_UM]
    assert native > 0, "the native 2 um positions table is empty"

    for bin_um, expected_ratio in ((8, 16), (16, 64)):
        assert bin_um in counts, f"the fixture ships no {bin_um} um bin"
        assert counts[bin_um] > 0, f"the {bin_um} um positions table is empty"
        assert native == counts[bin_um] * expected_ratio, (
            f"the committed {bin_um} um bin holds {counts[bin_um]} rows and the native "
            f"{MF.NATIVE_BIN_UM} um grid holds {native}; the ratio is "
            f"{native / counts[bin_um]:g} and the vendor's documented nesting is "
            f"{expected_ratio}:1 ({NESTING_QUOTE!r}). A fixture whose bins do not nest is "
            "not a Visium HD run, and every per-bin suite would keep passing on it."
        )

    # The three bins the vendor writes by default, and no fourth: a bin the container does
    # not declare would be staged as an unmatched member.
    assert set(counts) == set(MF.BINS) == {2, 8, 16}
    assert sorted(counts.values(), reverse=True) == [2560, 160, 40], (
        f"the committed row counts are {counts}; the geometry block in `make_fixture.py` "
        "documents 40x64 / 10x16 / 5x8"
    )

    # The counts are the FULL lattices, not the in-tissue subsets: the positions table
    # covers every square in the capture area and the FILTERED matrix is the subset. If this
    # ever inverted, the ratios above would still hold by coincidence on a symmetric mask.
    for bin_um in MF.BINS:
        table = committed_positions(bin_um).to_pydict()
        in_tissue = sum(1 for v in table["in_tissue"] if v)
        assert 0 < in_tissue < counts[bin_um], (
            f"the {bin_um} um positions table calls {in_tissue} of {counts[bin_um]} squares "
            "in-tissue; a table that is all or none is not the full capture lattice, and "
            "the barcode join the importer performs would go untested"
        )
