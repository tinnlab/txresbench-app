#!/usr/bin/env python3
# ruff: noqa
"""#508 — the option-1 node FLIPPED the nine outside-link today-pins to "refused by name".

BEFORE the owner's option-1 decision this file pinned TODAY's behavior: the nine
outside-link rows (TEST-2..7, TEST-15..17) imported at rc 0 with the outside bytes
landing. The OWNER DECISION (issue comment): option 1 — every bundle member must
realpath to a path under the bundle root. Those pins are now deliberate REFUSAL pins —
same file, same TEST-N ids, renamed to state the refusal rather than today's behavior,
each citing the owner decision, never deleted (TEST-22 holds the accountability).
TEST-8/9/18 (the untouched control + the inside-relative shapes) stay green; TEST-1
(anti-overclaim prose), the A14 manifest pin (re-pointed again by #654 for the 0.25.1
bump) and TEST-13 (three realpath sites) are re-pointed to the new uniform rule. (The
`#654` sections below are marked `A14 pin (#654)` / `seam contract (#654)` so they
cannot be read as this file's own TEST-8 / TEST-9 control rows; the TEST-9/TEST-10 ids
inside the A14-pin docstrings sit OUTSIDE the #508-era required-id set (2-7/15-17) that
this package's TEST-22 accountability pin scans, and this feature's per-feature ids
(TEST-3/TEST-4) are cited in the `A14 pin (#654)` / `seam contract (#654)` comments.)

THE MEASUREMENT AND THE PINS ARE THE SAME FILE (the refusal half now). Every row still
runs the SHIPPED entrypoint (`compute/import_visium.py` via `main()` as a subprocess)
over a COPY of the committed fixture, and each refused row asserts the ZERO-path state,
so the numbers in the phase report are reproducible by anyone who runs this file. A
refused bundle leaves NOTHING under `/outputs`: `locate_members` is the first call of
`run_import`, and the containment check is its last statement — before the first writer.

The one harness symlink NOT measured: `visium_fixtures._entry_invocation`'s
`/inputs/<name>` -> bundle_root symlink is the mount seam (it symlinks the top-level
INPUTS MOUNT, never a bundle member) and is excluded from every count.
"""
import csv
import json
import os
import re
import shutil
import stat
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402

#: Measured on this branch through the shipped entrypoint (deterministic producer):
#: every row that emits the SAME artifacts as the untouched fixture writes 60 files
#: under `/outputs`. The count is pinned so "rc 0" cannot be reported as success
#: without the store actually being written.
#: (LOWRES_PATHS was the old 61-count constant; its only user — the lowres row — now
#: asserts ZERO paths after the #508 option-1 flip, so the constant is removed.)
BASELINE_PATHS = 60

#: The positions columns, by the importer's own read order.
PX_COL = 5  # 0-based: barcode, in_tissue, array_row, array_col, pxl_row, pxl_col


def _count_paths(outputs):
    return sum(1 for p in Path(outputs).rglob("*") if p.is_file())


def _emitted_xy_by_barcode(outputs):
    """Read the coordinates store and the barcode axis back, keyed by barcode."""
    barcodes = list(VF.read_column(outputs, "axis/barcode.zarr"))
    values = VF.read_member(outputs, "spatial/coordinates.zarr", "coordinates")
    return dict(zip(barcodes, values[:, 0].astype(float)))


def _write_outside_positions(tmp_path, delta, basename="tissue_positions.csv",
                             headerless=False):
    """Write a marked positions file under `<tmp>/outside`; returns (path, barcode, x).

    The barcode column and the row count are IDENTICAL to the fixture's, so the matrix
    join still succeeds and the marker measures the member READ, not an unrelated
    refusal. `delta` is added to the first data row's `pxl_col_in_fullres`.
    """
    outside = tmp_path / "outside"
    outside.mkdir(exist_ok=True)
    fixture_csv = VF.FIXTURE / "spatial" / "tissue_positions.csv"
    rows = list(csv.reader(fixture_csv.open(newline="")))
    header = rows[0]
    data_rows = rows[1:]
    barcode = data_rows[0][0]
    old_x = float(data_rows[0][PX_COL])
    data_rows[0][PX_COL] = str(int(old_x) + delta)
    dest = outside / basename
    with dest.open("w", newline="") as fh:
        writer = csv.writer(fh)
        if headerless:
            writer.writerows(data_rows)  # field order is positional: barcode..pxl_col
        else:
            writer.writerows([header] + data_rows)
    return dest, barcode, old_x + delta


def _assert_option1_refusal(result, outputs, member_basename, resolved_path):
    """A3's FULL refusal surface, for every flipped option-1 pin.

    One assertion surface for all nine pins, so a flip cannot half-assert: rc 2, ZERO
    files under `/outputs` and no `manifest.json`, stderr NAMES the member (its
    basename), states where it "resolves to" (the QUOTED resolved path — the funnel's
    ASCII output, so the last 60 characters of the resolved path are always inside the
    quote), and carries the module's "Refusing rather than" ending. The marker-file
    setup stays in each test (it creates the outside file the symlink points at), but
    no outside-bytes assertion survives.

    NOTE (F-3, DEC-17): this helper is deliberately DUPLICATED in
    `tests/test_508_bundle_containment.py` — the two test files remain SELF-CONTAINED
    (each is runnable/auditable on its own; a shared helper module would couple the flip
    pins to the new containment rows). Keep both copies in sync when the refusal surface
    changes.
    """
    stderr = result.stderr
    assert result.returncode == 2, (
        f"the containment refusal must exit 2, got {result.returncode}:\n"
        f"{stderr[-3000:].decode('utf-8', 'replace')}"
    )
    found_paths = _count_paths(outputs)
    assert found_paths == 0, (
        f"the refusal must leave ZERO paths under /outputs (before the first writer), "
        f"found {found_paths}"
    )
    assert not (outputs / "manifest.json").exists(), (
        "a refused bundle must not write a manifest.json"
    )
    text = stderr.decode("utf-8", "replace")
    # The member name is asserted INDEPENDENTLY of the resolved-path tail: the refusal
    # message states "'<basename>' resolves to '<quoted path>' (it was located at ...)",
    # so a message that dropped the member-name quote but kept the resolved path would
    # still pass the tail assertion below (F-3) — pin the name on its own.
    assert f"'{member_basename}' resolves to" in text, (
        f"the refusal must name the member {member_basename!r} independently of the quoted "
        f"resolved path:\n{text[-3000:]}"
    )
    assert member_basename in text, (
        f"the refusal must NAME the member {member_basename!r}:\n{text[-3000:]}"
    )
    assert "resolves to" in text, (
        f"the refusal must state where the member resolves to:\n{text[-3000:]}"
    )
    assert str(resolved_path)[-60:] in text, (
        f"the refusal must quote the resolved path {resolved_path} "
        f"(tail {str(resolved_path)[-60:]!r}):\n{text[-3000:]}"
    )
    assert b"Refusing rather than" in stderr, (
        f"the refusal must end with the module's 'Refusing rather than' convention:\n"
        f"{text[-3000:]}"
    )


def _source_parts(source):
    """Split a Python source into `(code with comments removed, comments)`.

    Via `tokenize`, so a `#` inside a string literal is never mistaken for a comment
    marker. Each COMMENT token's leading run of `#` characters (the `#`, `#:` and
    `##`-led markers the compute module's comment styles use) plus one
    immediately-following `:` — and leading whitespace — is stripped, and the blocks
    are JOINED, so a claim split across comment lines is ONE sentence and a comment
    reflow (line splits, whitespace) cannot dodge a pin. Used by TEST-1:
    the FIX_ROUND-2 audit found the old normalizer kept the `#` markers AND pinned
    only the plural spelling, so a line-SPLIT comment ("outside this" + "# bundle")
    and a SINGULAR claim ("a file outside this bundle") both escaped the module-wide
    absence assertion — each of those two shapes now reddens TEST-1 (measured,
    FIX_ROUND-2). The final addendum round closed the last shape: the old strip also
    left the `#:` marker's colon, so "outside this" + "#: bundle" flattened to
    "outsidethis:bundle" and escaped; the strip is now `^#+:?\\s*` (any hash-led
    comment style), and that shape — and the `##`-led shape too (C1) — reddens
    (measured — see TEST-1).
    """
    import io
    import tokenize

    code, comments = [], []
    try:
        for tok in tokenize.generate_tokens(io.StringIO(source).readline):
            if tok.type == tokenize.COMMENT:
                comments.append(re.sub(r"^#+:?\s*", "", tok.string))
                comments.append("\n")
            else:
                code.append(tok.string)
    except (tokenize.TokenError, IndentationError) as exc:
        raise AssertionError(f"the pinned source does not tokenize: {exc}") from None
    return "".join(code), "".join(comments)


def _flat(text):
    """Whitespace, quotes and line-continuations removed, lowercased — a reflow cannot dodge."""
    return re.sub(r"[\s\"\\]+", "", text).lower()


#: The general claim's shape-complete needle (FIX_ROUND-2). The round-1 pin matched
#: ONLY the plural spelling `filesoutsidethisbundle`, so a singular claim ("a file
#: outside this bundle") and a claim split across comment lines both survived it.
#: Every spelling shares the core "outside this bundle", which is the #508 overclaim
#: UNLESS it is the scoped form "outside this bundle's matrix file" (flattened to
#: "outsidethisbundle'smatrixfile" — kept legal by the negative lookahead, as is the
#: "own matrix file" variant). The option-1 node's own prose says "outside the bundle
#: ROOT" — a different phrase, deliberately outside this needle's coverage because the
#: containment check IS bundle-wide.
_GENERAL_CLAIM = re.compile(r"outsidethisbundle(?!'smatrixfile|'sownmatrixfile)")


#: TEST-15's outside marker: a `Sample ID` the fixture could never have stated. The
#: marker file setup stays; the old read-back assertions (the outside sample id landing
#: in provenance AND report) are gone with the flip.
OUTSIDE_SAMPLE_ID = "outside-sample-508"


# ── TEST-1: the scoped refusal prose (the matrix walk stays scoped; the docstring
#    anchors re-point to the uniform containment rule) ────────────────────────────────


def test_508_the_refusal_prose_names_the_matrix_file_scope_never_the_general_bundle():
    """TEST-1 [acceptance] [invariant: INV-6] — the re-pointed anti-overclaim pin.

    The #[508] overclaim: the walk's refusal stated the rule in general terms ("a
    dataset whose values depend on files outside this bundle cannot be imported — the
    importer cannot know what it will read") while enforcing it for the matrix file's
    HDF5 objects only. FIX_ROUND-1 made this pin SITE-ANCHORED after the blind audit
    showed its previous `flat.count("issue#508") >= 2` form was vacuous (origin/main
    already carries "own matrix file" four times, and one docstring paragraph alone
    supplied the two issue mentions — so deleting the walk's boundary paragraph would
    NOT have reddened).

    THE #508 OPTION-1 RE-POINT (the owner decision, A-mended): the TWO reader-facing
    docstrings (`refuse_outside_matrix_objects`, `locate_members`) no longer say the
    rule is `.h5`-only with "no realpath check" — both now state the NEW uniform rule
    ("realpath" + "bundle root" + "#508"): every bundle member must realpath to a path
    under the bundle root, enforced by ONE containment check at the end of
    `locate_members`. The matrix WALK's refusal MESSAGES stay scoped to "the bundle's
    matrix file" (a truth about the same-FILE HDF5-object check, which does not check
    the path), so the module-wide absence of the general claim holds in code AND
    comments.

    Asserted, each naming its own regression: (a) in EACH of the five changed refusal
    functions — `refuse_malformed_counts`'s VDS/EXTERNAL refusal, the
    `refuse_outside_matrix_objects` walk's VDS/EXTERNAL refusal,
    `refuse_malformed_shape`'s VDS/EXTERNAL refusal, `refuse_malformed_features`'s
    `inline_what` and `run_import`'s barcodes `inline_what` — the raise-message text
    contains "the bundle's matrix file" and NOT the general claim (comments stripped,
    so a comment alone cannot masquerade as the message); (b) the two reader-facing
    docstrings each carry "#508" + "realpath" + "bundle root" (the uniform-rule
    statement, which the option-1 node replaced the old "no realpath check" anchor
    with — "no realpath check" must now be ABSENT, it was made false by the owner's
    decision); (c) module-wide, in code/docstrings AND in comments, the general claim
    is absent in EVERY spelling — the plural "files outside this bundle", the singular
    "a file outside this bundle" — i.e. any "outside this bundle" NOT followed by "'s matrix
    file" (the one legal, scoped form). Comments are tokenized, their `#:`/`#` marker
    stripped and the blocks joined, so a claim SPLIT ACROSS comment lines — in a `# `,
    `#:`, `##` or any hash-led `#+` line — is one sentence and cannot dodge the pin (all five shapes
    redden: the plural, singular and `#`-line-split shapes measured FIX_ROUND-2, the
    `#:`-line-split shape measured in the final addendum round, and the `##`-line-split
    shape measured in the C1 closure round).

    KNOWN PIN LIMIT (documented — this is a limitation, not a gap to close): the
    needle is keyed to the LITERAL "outside this bundle" (in code/docstrings/comments,
    in every hash-led split shape of the `#`/`#:`/`##` comment styles); a paraphrase like "outside the bundle" is OUTSIDE its
    coverage — by design, because this branch's own legitimate text says "outside the
    bundle root" (the option-1 uniform rule's own wording, in the containment check, in
    both docstrings and in the manifest). A claim that drops the "this" is therefore NOT
    caught by this pin; the scoped sentences that sit in the same paragraphs are what
    state the truth.
    """
    import ast

    src = (VF.PKG / "compute" / "import_visium.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    by_name = {node.name: node for node in tree.body
               if isinstance(node, ast.FunctionDef)}
    code_all, comments_all = _source_parts(src)
    flat_code, flat_comments = _flat(code_all), _flat(comments_all)

    scoped = "valuesdependonfilesoutsidethebundle'smatrixfile"

    # (c) module-wide: no site — message, docstring OR comment block — carries the
    # general claim in ANY spelling (plural "files outside this bundle", singular
    # "a file outside this bundle", line-split or single-line; comments joined with
    # their `#:`/`#` marker stripped).
    assert not _GENERAL_CLAIM.search(flat_code), (
        "the general-claim sentence ('a dataset whose values depend on files outside "
        "this bundle cannot be imported — …') is BACK in code or docstring text — #508's "
        "overclaim. The prose must name the scope the checks actually enforce: the "
        "bundle's matrix file."
    )
    assert not _GENERAL_CLAIM.search(flat_comments), (
        "the general-claim sentence is BACK in a COMMENT (the FIX_ROUND-1/FIX_ROUND-2 "
        "sweep) — in the plural, singular or a line-split spelling — a reader of a "
        "comment must not conclude a bundle-wide rule that nothing enforces. Scoped "
        "comments say the bundle's matrix file too."
    )
    n = flat_code.count(scoped)
    assert n >= 5, (
        f"found only {n} scoped site(s); expected 5 (refuse_malformed_counts, the "
        "refuse_outside_matrix_objects walk, refuse_malformed_shape, the features "
        "inline_what and the barcodes inline_what)"
    )

    # (a) per-function site anchors.
    for fn_name in ("refuse_malformed_counts", "refuse_outside_matrix_objects",
                    "refuse_malformed_shape", "refuse_malformed_features", "run_import"):
        assert fn_name in by_name, f"{fn_name} no longer exists — a #508 refusal site anchor needs it"
        seg = _flat(_source_parts(ast.get_source_segment(src, by_name[fn_name]))[0])
        assert "thebundle'smatrixfile" in seg, (
            f"{fn_name}'s refusal site no longer scopes the message to the bundle's matrix "
            "file — the general claim would be back at this site"
        )
        assert not _GENERAL_CLAIM.search(seg), (
            f"the general claim is at {fn_name}'s refusal site — scope it to the bundle's "
            "matrix file"
        )

    # (b) both reader-facing docstrings state the NEW uniform rule; the WALK's
    # docstring is the anchor (deleting its #508 scope paragraph reddens HERE). The old
    # anchor claimed "no realpath check" — the owner's option 1 made that FALSE, so the
    # anchor is RE-POINTED to the uniform-rule statement, and "no realpath check" must
    # now be absent from both.
    for fn_name in ("refuse_outside_matrix_objects", "locate_members"):
        assert fn_name in by_name
        doc = " ".join((ast.get_docstring(by_name[fn_name]) or "").split()).lower()
        assert "#508" in doc, (
            f"{fn_name}'s docstring lost the issue #508 boundary marker — the pinned "
            "statement of the rule's scope is gone"
        )
        assert "no realpath check" not in doc, (
            f"{fn_name}'s docstring still claims the pre-option-1 'no realpath check' "
            "scope — the owner's decision made that statement false; the NEW uniform "
            "containment rule is stated there now"
        )
        assert "realpath" in doc and "bundle root" in doc, (
            f"{fn_name}'s docstring must state the new uniform rule — every bundle "
            "member must realpath to a path under the bundle root (issue #508 option 1)"
        )


# ── TEST-2 .. TEST-7: the FLIPPED outside-link rows (refused by name) ─────────────────


# #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
# a path under the bundle root; this pin now asserts the refusal.
def test_508_option1_refuses_a_symlinked_positions_table_outside_the_bundle_at_rc2_with_zero_output_paths(tmp_path):
    r"""TEST-2 [acceptance] [invariant: INV-1, INV-2] — the FLIPPED positions row, ABSOLUTE link (#508 option 1).

    Was a TODAY'S-behavior pin ("imports at rc 0 and the outside coordinates land");
    the OWNER DECISION for #508 (issue comment: option 1 — every bundle member must realpath to
    a path under the bundle root) flips it IN PLACE, deliberately, to assert the
    REFUSAL — never deleted. The fixture's `tissue_positions.csv` is moved OUT of the
    bundle copy and replaced by an ABSOLUTE symlink to `<tmp>/outside/tissue_positions.csv`
    (barcode column + row count identical to the fixture's, marker on
    `pxl_col_in_fullres`; the setup is unchanged, only the asserted OUTCOME is): rc 2,
    ZERO files under `/outputs`, no manifest.json, the refusal names the member and the
    quoted resolved path, and carries "Refusing rather than" (A3).
    """
    outside, _, _ = _write_outside_positions(tmp_path, 1000)
    bundle = VF.stage_bundle(tmp_path, name="outs")
    (bundle / "spatial" / "tissue_positions.csv").unlink()
    (bundle / "spatial" / "tissue_positions.csv").symlink_to(outside)
    outputs = tmp_path / "out" / "outputs"

    result = VF.run_entry_bytes(bundle, outputs)

    _assert_option1_refusal(result, outputs, "tissue_positions.csv",
                            os.path.realpath(outside))


# #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
# a path under the bundle root; this pin now asserts the refusal.
def test_508_option1_refuses_a_symlinked_scalefactors_file_outside_the_bundle_at_rc2_with_zero_output_paths(tmp_path):
    r"""TEST-3 [acceptance] [invariant: INV-1, INV-2] — the FLIPPED scalefactors row, ABSOLUTE link (#508 option 1).

    Was a TODAY'S-behavior pin ("imports at rc 0 and the outside scale lands"); the
    OWNER DECISION (issue comment: option 1 — every bundle member must realpath to a
    path under the bundle root) flips it IN PLACE to assert the REFUSAL. 
    `scalefactors_json.json` is replaced by an ABSOLUTE symlink to an outside copy with
    `spot_diameter_fullres` 73.61433 -> 50.0 (same keys/structure — the setup is
    unchanged; the old micron-scale read-back is gone): rc 2, ZERO files under
    `/outputs`, no manifest.json, the refusal names `scalefactors_json.json` and the
    quoted resolved path, and carries "Refusing rather than" (A3).
    """
    outside = tmp_path / "outside"
    outside.mkdir(exist_ok=True)
    sf = json.loads((VF.FIXTURE / "spatial" / "scalefactors_json.json").read_text())
    sf["spot_diameter_fullres"] = 50.0
    (outside / "scalefactors_json.json").write_text(json.dumps(sf))
    bundle = VF.stage_bundle(tmp_path, name="outs")
    (bundle / "spatial" / "scalefactors_json.json").unlink()
    (bundle / "spatial" / "scalefactors_json.json").symlink_to(outside / "scalefactors_json.json")
    outputs = tmp_path / "out" / "outputs"

    result = VF.run_entry_bytes(bundle, outputs)

    _assert_option1_refusal(result, outputs, "scalefactors_json.json",
                            os.path.realpath(outside / "scalefactors_json.json"))


# #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
# a path under the bundle root; this pin now asserts the refusal.
def test_508_option1_refuses_a_symlinked_hires_image_outside_the_bundle_at_rc2_with_zero_output_paths(tmp_path):
    r"""TEST-4 [acceptance] [invariant: INV-1, INV-2] — the FLIPPED hires row, ABSOLUTE link (#508 option 1).

    Was a TODAY'S-behavior pin ("imports at rc 0 and the outside pixels land"); the
    OWNER DECISION (issue comment: option 1 — every bundle member must realpath to a
    path under the bundle root) flips it IN PLACE to assert the REFUSAL. The vendor PNG
    is replaced by an ABSOLUTE symlink to a crafted 64x64 RGB PNG (the setup is
    unchanged; the old OME-TIFF shape read-back is gone): rc 2, ZERO files under
    `/outputs`, no manifest.json, the refusal names `tissue_hires_image.png` and the
    quoted resolved path, and carries "Refusing rather than" (A3).
    """
    from PIL import Image

    outside = tmp_path / "outside"
    outside.mkdir(exist_ok=True)
    Image.new("RGB", (64, 64), (200, 30, 30)).save(outside / "tissue_hires_image.png")
    bundle = VF.stage_bundle(tmp_path, name="outs")
    (bundle / "spatial" / "tissue_hires_image.png").unlink()
    (bundle / "spatial" / "tissue_hires_image.png").symlink_to(outside / "tissue_hires_image.png")
    outputs = tmp_path / "out" / "outputs"

    result = VF.run_entry_bytes(bundle, outputs)

    _assert_option1_refusal(result, outputs, "tissue_hires_image.png",
                            os.path.realpath(outside / "tissue_hires_image.png"))


# #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
# a path under the bundle root; this pin now asserts the refusal.
def test_508_option1_refuses_a_symlinked_lowres_image_outside_the_bundle_at_rc2_with_zero_output_paths(tmp_path):
    r"""TEST-5 [acceptance] [invariant: INV-1, INV-2] — the FLIPPED lowres row, ABSOLUTE link (#508 option 1).

    Was a TODAY'S-behavior pin ("imports at rc 0 with 61 paths and the outside 32x32
    pixels land"); the OWNER DECISION for #508 (issue comment: option 1 — every bundle member
    must realpath to a path under the bundle root) flips it IN PLACE to assert the
    REFUSAL. The committed fixture carries only the hires image; this row adds a
    `tissue_lowres_image.png` as an ABSOLUTE symlink to a crafted 32x32 PNG (the
    bundle's scalefactors_json.json already declares `tissue_lowres_scalef`), so the
    second `VENDOR_IMAGES` member is the one refused: rc 2, ZERO files under `/outputs`,
    no manifest.json, the refusal names `tissue_lowres_image.png` and the quoted
    resolved path, and carries "Refusing rather than" (A3).
    """
    from PIL import Image

    outside = tmp_path / "outside"
    outside.mkdir(exist_ok=True)
    Image.new("RGB", (32, 32), (30, 200, 30)).save(outside / "tissue_lowres_image.png")
    bundle = VF.stage_bundle(tmp_path, name="outs")
    (bundle / "spatial" / "tissue_lowres_image.png").symlink_to(outside / "tissue_lowres_image.png")
    outputs = tmp_path / "out" / "outputs"

    result = VF.run_entry_bytes(bundle, outputs)

    _assert_option1_refusal(result, outputs, "tissue_lowres_image.png",
                            os.path.realpath(outside / "tissue_lowres_image.png"))


# #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
# a path under the bundle root; this pin now asserts the refusal.
def test_508_option1_refuses_a_RELATIVE_outside_positions_link_at_rc2_with_zero_output_paths(tmp_path):
    r"""TEST-6 [acceptance] [invariant: INV-1, INV-2] — the FLIPPED relative-link parity row (#508 option 1).

    Was a TODAY'S-behavior pin ("a RELATIVE `../…` link behaves exactly like an
    absolute one, i.e. imports at rc 0 with the outside value landing"); the OWNER
    DECISION (issue comment: option 1 — every bundle member must realpath to a path
    under the bundle root) flips it IN PLACE to assert the REFUSAL. Same marker as
    TEST-2 but the symlink target is RELATIVE (`../reloutside/tissue_positions.csv`),
    which is the spelling that survives a tree being moved — the resolved path is
    outside the bundle root either way, so the link STYLE must not matter: rc 2, ZERO
    files under `/outputs`, no manifest.json, the refusal names `tissue_positions.csv`
    and the quoted resolved path, and carries "Refusing rather than" (A3).
    """
    outside = tmp_path / "reloutside"
    outside.mkdir()
    fixture_csv = VF.FIXTURE / "spatial" / "tissue_positions.csv"
    rows = list(csv.reader(fixture_csv.open(newline="")))
    barcode = rows[1][0]
    marker_x = float(rows[1][PX_COL]) + 2000
    rows[1][PX_COL] = str(int(marker_x))
    outside_file = outside / "tissue_positions.csv"
    with outside_file.open("w", newline="") as fh:
        csv.writer(fh).writerows(rows)

    bundle = VF.stage_bundle(tmp_path, name="outs")
    spatial = bundle / "spatial"
    (spatial / "tissue_positions.csv").unlink()
    (spatial / "tissue_positions.csv").symlink_to(
        os.path.relpath(outside_file, spatial))
    outputs = tmp_path / "out" / "outputs"

    result = VF.run_entry_bytes(bundle, outputs)

    _assert_option1_refusal(result, outputs, "tissue_positions.csv",
                            os.path.realpath(outside_file))


# #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
# a path under the bundle root; this pin now asserts the refusal.
def test_508_option1_refuses_the_HEADERLESS_positions_sibling_outside_the_bundle_at_rc2_with_zero_output_paths(tmp_path):
    r"""TEST-7 [acceptance] [invariant: INV-1, INV-2] — the FLIPPED headerless-sibling row (#508 option 1).

    Was a TODAY'S-behavior pin ("the HEADERLESS `tissue_positions_list.csv` sibling
    symlinked outside imports at rc 0 and the outside value lands"); the OWNER DECISION
    (issue comment: option 1 — every bundle member must realpath to a path under the
    bundle root) flips it IN PLACE to assert the REFUSAL. `POSITIONS_BASENAMES` accepts
    both vendor spellings by basename; this row removes the headered file and symlinks
    the HEADERLESS one (positional columns, marker on `pxl_col_in_fullres`) to the
    outside file (the setup is unchanged; the positional read-back is gone): rc 2, ZERO
    files under `/outputs`, no manifest.json, the refusal names
    `tissue_positions_list.csv` and the quoted resolved path, and carries "Refusing
    rather than" (A3).
    """
    outside, _, _ = _write_outside_positions(
        tmp_path, 1000, basename="tissue_positions_list.csv", headerless=True)
    bundle = VF.stage_bundle(tmp_path, name="outs")
    (bundle / "spatial" / "tissue_positions.csv").unlink()
    (bundle / "spatial" / "tissue_positions_list.csv").symlink_to(outside)
    outputs = tmp_path / "out" / "outputs"

    result = VF.run_entry_bytes(bundle, outputs)

    _assert_option1_refusal(result, outputs, "tissue_positions_list.csv",
                            os.path.realpath(outside))


# ── TEST-8: the control row (and the before/after anchor) ────────────────────────────


def test_508_the_untouched_staged_bundle_is_the_control_and_writes_the_measured_path_count(tmp_path):
    r"""TEST-8 — the CONTROL row: an untouched bundle copy imports at rc 0.

    Every row above must write the SAME number of files as this control (60), which is
    what makes "rc 0" a full store rather than "rc 0, something happened". Also the
    executable anchor of the baseline leg (a): the before/after comparison starts from
    this exact run shape.

    RE-VERIFIED GREEN, UNCHANGED by the #508 option-1 node (A11): the containment check
    realpaths every member against realpath(root); every member of this control
    realpaths under the bundle root, so this shape stays rc 0 with the measured 60
    paths — the over-refusal the STEP0 measurement reproduced must not ship.
    """
    bundle = VF.stage_bundle(tmp_path, name="outs")
    outputs = tmp_path / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, outputs)
    assert result.returncode == 0, result.stderr[-3000:]
    assert _count_paths(outputs) == BASELINE_PATHS
    assert (outputs / "manifest.json").is_file()
    meta = json.loads((outputs / "manifest.json").read_text())
    ids = [e["id"] for e in meta["outputs"]]
    assert "spatial-coordinates" in ids and "spatial-image-hires" in ids


# ── TEST-9: Measurement 2 — INSIDE bundle symlinks (accepted today AND under option 1) ─


def test_508_TODAYS_behavior_INSIDE_bundle_symlinked_members_import_at_rc0_and_nothing_refuses_them(tmp_path):
    r"""TEST-9 [acceptance] [invariant: INV-1] — Measurement 2, INSIDE relative links.

    TODAY'S behavior, pinned for #508 — and UNCHANGED by the owner's option-1 decision.
    `tissue_positions.csv`, `scalefactors_json.json` and `tissue_hires_image.png` are
    each replaced by a RELATIVE symlink to a same-bundle copy (`renamed_*`, both under
    `spatial/`), the bundle otherwise valid. Nothing refuses it: rc 0, the same 60
    output files, the emitted values are the REAL fixture ones (marker = fixture x), and
    stderr carries no refusal line. The links here resolve UNDER the bundle root
    (…/outs/spatial/renamed_positions.csv), and option 1 is "realpath to a path under
    the bundle root", which ACCEPTS them — so this rc-0 shape is GREEN under the new
    containment check (MEASURED in STEP0-MEASUREMENT §2c).

    RE-VERIFIED GREEN, UNCHANGED by the #508 option-1 node (A11): the inside-relative
    rows are exactly the class the naive predicate reddened; the realpath-rooted
    containment check keeps them rc 0.
    """
    bundle = VF.stage_bundle(tmp_path, name="outs")
    spatial = bundle / "spatial"
    for member, renamed in (("tissue_positions.csv", "renamed_positions.csv"),
                            ("scalefactors_json.json", "renamed_scalefactors.json"),
                            ("tissue_hires_image.png", "renamed_hires.png")):
        (spatial / renamed).write_bytes((spatial / member).read_bytes())
        (spatial / member).unlink()
        (spatial / member).symlink_to(renamed)
    outputs = tmp_path / "out" / "outputs"

    result = VF.run_entry_bytes(bundle, outputs)

    assert result.returncode == 0, result.stderr[-3000:]
    assert _count_paths(outputs) == BASELINE_PATHS
    assert (outputs / "manifest.json").is_file()
    assert b"Refusing rather than" not in result.stderr, result.stderr[-2000:]
    by_barcode = _emitted_xy_by_barcode(outputs)
    fixture_row = {r["barcode"]: r for r in VF.positions_table()}
    # The values are the REAL fixture ones: the first barcode's emitted x is the
    # fixture's, never a marker and never a refusal.
    first_barcode = list(by_barcode)[0]
    assert by_barcode[first_barcode] == pytest.approx(
        float(fixture_row[first_barcode]["pxl_col_in_fullres"]))


# ── A14 pin (TEST-3 #654): the A12 manifest pin (OUTSIDE the fix commit on purpose) ───


# TEST-3 (#654): this node's A14-1 pin for the visium 0.25.1 bump — the derive pin (the
# `binned_outputs/` HD refusal's importer name is DERIVED from HD's manifest every run and
# asserted in the EMITTED message, never a literal in the assertion) (per TESTS.md).
# A14 pin (#654): re-pointed for the 0.25.1 bump — renamed to keep the exact shape HD's
# TEST-25 derives by regex; floor >= (0,25,1), head #654, subject = the derive pin
# (per TESTS.md).
def test_654_the_manifest_bump_and_its_changelog_entry_are_at_0_25_1_and_name_this_issue():
    r"""TEST-10 (#654) — A14/A12 pin, re-pointed for the 0.25.1 bump.

    This pin holds the declared version floor (0, 25, 1), exactly one top-level
    `version:`, the newest changelog entry naming the SAME declared version and `#654`
    (RE-POINTED from the 0.25.0 row: `#359`, `no issue number` and `hide the platform
    gap` were the 0.25.0 entry's subject and are NO LONGER required of the newest
    entry) — the 0.25.1 entry's subject is the DERIVE PIN: the `binned_outputs/` HD
    refusal's importer name is read from `spatial-import-visium-hd/manifest.yaml`
    every run (the operator-facing needle being the `spatial.import-visium-hd`
    analysis `title:`), the needle is scoped to the EMITTED message so a neighbouring
    comment cannot satisfy it (#646), and the test reddens BY DESIGN when HD renames,
    WITHOUT the PREVIOUS entry's issue (#359) as its own head claim, and a real
    multi-line entry block.
    """
    import yaml
    text = (VF.PKG / "manifest.yaml").read_text(encoding="utf-8")
    doc = yaml.safe_load(text)
    assert doc["id"] == "spatial-import-visium"
    declared = [ln.split(":", 1)[1].strip() for ln in text.splitlines()
                if ln.startswith("version:")]
    assert len(declared) == 1, f"expected exactly one top-level `version:`, found {declared}"
    version = tuple(int(p) for p in declared[0].split("."))
    assert version >= (0, 25, 1), (
        f"version {declared[0]} is below the (0, 25, 1) floor this bump claims — the "
        "0.25.1 pin exists so the floor reddens on any revert to 0.25.0"
    )
    heads = [ln for ln in text.splitlines() if re.match(r"^# \d+\.\d+\.\d+ — #\d", ln)]
    version_line = next(i for i, ln in enumerate(text.splitlines())
                        if ln.startswith("version:"))
    newest = [ln for ln in heads if text.splitlines().index(ln) < version_line][-1]
    assert newest.startswith(f"# {declared[0]} — #654"), newest
    assert "#508" not in newest, (
        f"the newest entry {newest!r} claims the PREVIOUS branch's issue (#508, the "
        "0.21.1 head) as its own head — the newest entry must name THIS branch's issue"
    )
    # The PREVIOUS entries' issues must never be the newest entry's OWN head claim. The
    # old 0.22.0-era pin checked the whole head line; the 0.23.0 head line's trailing
    # prose names the round that filed these issues ("the #615/#624/#625 close run
    # filed are") — a reference, not a head claim — so what is pinned here is the
    # HEAD-CLAIM TOKEN (the "#N(/#N)*" between "—" and ":").
    head_claim = newest.split(":", 1)[0].replace(f"# {declared[0]} — ", "").strip()
    assert "#471" not in head_claim, (
        f"the newest entry's head claim {head_claim!r} names the PREVIOUS branch's issue "
        "(#471, the 0.24.0 head) as its own head"
    )
    assert "#638" not in head_claim, (
        f"the newest entry's head claim {head_claim!r} names the PREVIOUS branch's issue "
        "(#638, the 0.23.0 head) as its own head"
    )
    assert "#615" not in head_claim and "#624" not in head_claim and "#625" not in head_claim, (
        f"the newest entry's head claim {head_claim!r} names the PREVIOUS branch's issue "
        "(#615/#624/#625, the 0.22.0 head) as its own head"
    )
    assert "#503" not in head_claim and "#489" not in head_claim, (
        f"the newest entry's head claim {head_claim!r} names the PREVIOUS branch's issue "
        "(#503/#489, the 0.20.0 head) as its own head"
    )
    assert "#548" not in head_claim, (
        f"the newest entry's head claim {head_claim!r} names the PREVIOUS branch's issue "
        "(#548, the 0.18.0 head) as its own head"
    )
    assert "#359" not in head_claim, (
        f"the newest entry's head claim {head_claim!r} names the PREVIOUS branch's issue "
        "(#359, the 0.25.0 head) as its own head"
    )
    body = text.split(newest, 1)[1].splitlines()[1:]
    continued = [ln for ln in body[:80] if ln.startswith("#          ")]
    assert len(continued) >= 5, f"the {declared[0]} entry is a one-liner, not a block"
    entry = [newest] + continued
    assert any("deriv" in ln.lower() for ln in entry), (
        "the 0.25.1 entry must name its concrete subject — the `binned_outputs/` HD "
        "refusal's importer name is DERIVED from HD's manifest every run (a literal "
        "with no derive pin is the defect this branch closes, one level up from #359)"
    )
    assert any("emitted message" in ln.lower() or "runtime message" in ln.lower() for ln in entry), (
        "the 0.25.1 entry must name the pin's scope — the needle is asserted in the "
        "EMITTED message an operator sees, so a same-named string inside the retirement "
        "comment cannot satisfy it (#646)"
    )
    assert any("reddens by design" in ln.lower() for ln in entry), (
        "the 0.25.1 entry must name the contract — the test reddens BY DESIGN when HD "
        "renames, and the fix is then visium's message, never to relax the test"
    )
    # A14: the floor pins in the other suites are floors and stay satisfied.
    assert str(doc["version"]) == declared[0]


# ── seam contract (#654): the HD sibling's derive-regex seam stays mechanical ─────────


# TEST-4 (#654): the seam-pattern pin — the A14 pin's function-name shape and the
# manifest version form are exactly what HD's TEST-25 derives by regex (seam
# contract (#654); per TESTS.md).
def test_654_the_A14_pin_function_keeps_the_HD_sibling_seam_pattern():
    r"""TEST-9 (#654) — the mechanical half of ITEM-5's cross-package seam.

    HD's `test_508_bundle_containment.py` TEST-25 derives THIS package's current
    `version:` and the A14 pin function name by regex every run, and asserts HD's
    TEST-18 mirror note names both. This pin holds the contract the seam depends on,
    so the seam breaks LOUDLY rather than silently: (a) the re-pointed A14 pin's
    function name matches the EXACT regex HD derives (the shape HD's regex demands);
    (b) the manifest's `version:` matches HD's derive regex (`^\d+\.\d+\.\d+$` — this
    package has no pre-release suffix); (c) HD's `test_508_bundle_containment.py`
    still carries the sibling-deriving regexes — the seam is mechanical and intact.

    It does NOT fix or hide the seam: this node's bump + rename reddens HD TEST-25 on
    HD's next run, which is the RECORDED owner action of DEC-4, never something this
    node may fix or silence. HD is read-only here.
    """
    this_src = (VF.PKG / "tests" / "test_508_symlinked_members.py").read_text(
        encoding="utf-8")
    hd_pkg = VF.PKG.parent / "spatial-import-visium-hd"
    hd_src = (hd_pkg / "tests" / "test_508_bundle_containment.py").read_text(
        encoding="utf-8")

    # (a) The A14 pin function name matches the EXACT regex HD derives by.
    fn_re = re.compile(
        r"def (test_\w+_the_manifest_bump_and_its_changelog_entry_are_at_\d+_\d+_\d+"
        r"_and_name_this_issue)\(")
    fn_match = fn_re.search(this_src)
    assert fn_match is not None, (
        "the A14 pin function no longer matches the name shape HD's TEST-25 derives by "
        "regex — the seam's mechanical contract is broken"
    )
    assert fn_match.group(1) == (
        "test_654_the_manifest_bump_and_its_changelog_entry_are_at_0_25_1_and_name_this_issue"
    ), f"the A14 pin renamed off the 0.25.1 shape: {fn_match.group(1)}"

    # (b) The manifest's top-level `version:` matches HD's derive regex.
    manifest_text = (VF.PKG / "manifest.yaml").read_text(encoding="utf-8")
    vmatch = re.search(r"^version:\s*(\d+\.\d+\.\d+)\s*$", manifest_text, re.MULTILINE)
    assert vmatch is not None, (
        "the manifest's top-level `version:` line no longer matches the shape HD's "
        r"TEST-25 derives (`^\d+\.\d+\.\d+$`) — a pre-release suffix or a missing line "
        "would silently break the sibling mirror"
    )

    # (c) HD still carries the sibling-deriving regexes — the seam is mechanical.
    assert r"_the_manifest_bump_and_its_changelog_entry_are_at_" in hd_src, (
        "HD's TEST-25 no longer carries the sibling-derive regex for the A14 pin "
        "function name — the seam is no longer mechanical"
    )
    assert r"^version:\s*(\d+\.\d+\.\d+)\s*$" in hd_src, (
        "HD's TEST-25 no longer carries the sibling-derive regex for the manifest "
        "version — the seam is no longer mechanical"
    )


# ── TEST-11: no issue_states.json mechanism is created here ─────────────────────────

def test_508_no_issue_states_json_in_this_package():
    """TEST-11 — `tests/issue_states.json` is the HD sibling's mechanism, not ours.

    Only `spatial-import-visium-hd` has the file + its scanner; this package has
    neither the file nor any reference to it, and #508's HD issue number is cited only
    in the GitHub issue, never in repo code. If someone adds the mechanism here, this
    test names the moment.

    RE-VERIFIED GREEN, UNCHANGED by the #508 option-1 node (A11): this node adds no
    mechanism, no file, no scanner — the containment check is one predicate in
    `locate_members` and the HD story stays #593.
    """
    assert not (VF.PKG / "tests" / "issue_states.json").exists(), (
        "this package has no issue_states.json (verified: only spatial-import-visium-hd "
        "has one) — creating one would be a new mechanism, out of #508's LIGHT scope"
    )
    for test_file in (VF.PKG / "tests").glob("test_*.py"):
        if test_file.name == "test_508_symlinked_members.py":
            continue  # THIS file's own docstring quotes the mechanism it refuses to add
        text = test_file.read_text(encoding="utf-8")
        assert "issue_states" not in text, (
            f"{test_file.name} references the HD-only issue_states mechanism"
        )


def _staging_refusal_like_copy_original_streaming(src, dest):
    """A Python MIRROR of `src-app/server/src/modules/file/stream.rs:762-769` —
    `copy_original_streaming`'s storage-path guard (the `dataset-file` input kind).

    `symlink_metadata` (never following) decides: a SYMLINK at the storage path is
    REFUSED (`AppError::not_found("File")` in the Rust) and `dest` is never touched;
    a REGULAR file is copied byte-wise (stream) to a fresh `dest`. This is Decisions
    DEC-6's mechanics demonstration for that input kind — it is NOT the Rust function
    running and is NOT a substitute for it: the cargo drive of
    `modules::workstore::object_store::local_fs::tests` (16 passed, incl.
    `get_refuses_to_follow_a_symlink` and
    `link_blob_shares_the_inode_and_survives_pool_deletion`) is the Rust record and
    is kept in DECISIONS.md DEC-6. TEST-12 drives this mirror's TWO arms and asserts
    each decision (symlink → refused with no dest created; regular → byte-identical
    dest), replacing the FIX_ROUND-1 finding's tautological `S_ISLNK`-then-`if
    S_ISLNK: refused=True; assert refused` double-assertion.
    """
    meta = os.lstat(src)  # `symlink_metadata` — never follows
    if stat.S_ISLNK(meta.st_mode):
        raise FileNotFoundError(src)  # mirror of AppError::not_found("File")
    with open(src, "rb") as fh_in, open(dest, "wb") as fh_out:
        shutil.copyfileobj(fh_in, fh_out)


# ── TEST-12: Measurement 3 — the sandbox staging mechanics demonstration ─────────────


def test_508_the_sandbox_staging_mechanics_flatten_or_refuse_every_symlink(tmp_path):
    r"""TEST-12 [acceptance] [invariant: INV-4] — MEASUREMENT 3, mechanics demonstration.

    LABELLED AS SUCH: this drives the STAGING MECHANICS with real files in a tmp dir —
    it is NOT the Rust functions running (those were run on this branch from the MAIN
    checkout: `cargo test --lib modules::workstore::object_store::local_fs::tests` →
    16 passed, incl. `get_refuses_to_follow_a_symlink` and
    `link_blob_shares_the_inode_and_survives_pool_deletion`; see DECISIONS DEC-6).
    The three production input kinds:
      * artifact/artifact-prefix (`inputs.rs:415-454`, `:848-880`): a `link(2)`
        hardlink of a content-addressed pool FILE (regular), or `File::create` +
        `write_all` of blob bytes (regular) — the importer sees a regular file;
      * dataset-file (`inputs.rs:949-981` → `file/stream.rs:762-769`): a symlink at the
        STORAGE path is REFUSED (`symlink_metadata` `is_symlink` → not_found), a
        regular file is copied byte-wise to a fresh dest — regular;
      * host_path (`inputs.rs:305-312` → `spec.rs:778-803`): canonicalized under the
        allowlist (escape → refused), then copied to a fresh dest — regular.
    This test proves each step's mechanics: the staged result is a REGULAR file even
    when the origin could have been a symlink, the storage-path refusal fires, and the
    output-capture canonicalization accepts only targets under the canonical /outputs.

    RE-VERIFIED GREEN, UNCHANGED by the #508 option-1 node (A11): the containment check
    is a SECOND belt on the bundle-member read path — the sandbox staging mechanics half
    of the "before the first writer" argument stays true, and the refusal still fires
    before any writer.
    """
    def regular(path):
        return stat.S_ISREG(os.stat(path).st_mode) and not os.path.islink(path)

    # (1) hardlink of a regular pool file → regular staged file.
    pool = tmp_path / "pool"
    pool.mkdir()
    blob = pool / "blob.dat"
    blob.write_bytes(b"pool bytes")
    stag = tmp_path / "inputs" / "m.zarr"
    stag.parent.mkdir()
    os.link(blob, stag)
    assert regular(stag), "link(2) of a regular pool file must yield a regular file"

    # (2) File::create+write (copy floor) → regular.
    stag2 = tmp_path / "inputs" / "copy.bin"
    with open(stag2, "w") as fh:
        fh.write("copied bytes")
    assert regular(stag2)

    # (3) storage-path symlink → the refusal branch (`symlink_metadata` `is_symlink` →
    # `not_found`, never followed). Driven through the Python mirror: we change the
    # INPUT and assert the DECISION (refusal for a symlink, byte-copy for a regular
    # file) — the FIX_ROUND-1 audit found the old form (`assert S_ISLNK` then `if
    # S_ISLNK: refused=True; assert refused`) tautological, re-asserting the check it
    # had just made instead of the behavior the Rust encodes.
    storage = tmp_path / "storage"
    storage.mkdir()
    secret = tmp_path / "secret.bin"
    secret.write_bytes(b"TOP SECRET")
    link = storage / "user.bin"
    link.symlink_to(secret)
    dest = tmp_path / "staged" / "user.bin"
    dest.parent.mkdir()
    with pytest.raises(FileNotFoundError):
        _staging_refusal_like_copy_original_streaming(link, dest)
    assert not dest.exists(), (
        "the refusal must leave NO dest — a dest created on the refusal branch would "
        "be a partial file a later reader could mistake for the real stage"
    )
    # The other arm: a regular file at the storage path is copied byte-wise to a fresh
    # dest — a regular file, never a link.
    plain = storage / "plain.bin"
    plain.write_bytes(b"copied bytes")
    dest2 = tmp_path / "staged" / "plain.bin"
    _staging_refusal_like_copy_original_streaming(plain, dest2)
    assert dest2.read_bytes() == plain.read_bytes(), "the regular arm must copy bytes"
    assert regular(dest2), "the importer reads a fresh regular file, never the symlink"

    # (4) output capture canonicalization (`outputs.rs:312-331`).
    outputs = tmp_path / "outputs"
    outputs.mkdir()
    (outputs / "real.ome.tif").write_bytes(b"img")
    inside = outputs / "declared.ome.tif"
    inside.symlink_to(outputs / "real.ome.tif")
    canon_dir = os.path.realpath(outputs)
    canon_inside = os.path.realpath(inside)
    assert canon_inside.startswith(canon_dir) and os.path.isfile(canon_inside)
    # an escape: a declared output resolving OUTSIDE /outputs is refused.
    outside = tmp_path / "outside.txt"
    outside.write_bytes(b"x")
    escape = outputs / "evil.tif"
    escape.symlink_to(outside)
    assert not os.path.realpath(escape).startswith(canon_dir), (
        "output capture refuses a declared output that resolves outside /outputs"
    )


# ── TEST-13: Measurement 4 — blast radius (package-scope, executable) ────────────────


def test_508_no_committed_fixture_or_test_relies_on_a_symlinked_bundle_member():
    r"""TEST-13 — Measurement 4, by-name scan of THIS package (RE-POINTED for option 1).

    `git grep -n "symlink"` over the package returned exactly one hit on the base:
    `tests/visium_fixtures.py:971` — the `_entry_invocation` `/inputs/<name>` MOUNT
    SEAM (it symlinks the top-level inputs mount to the bundle root, never a bundle
    member). THIS file adds the other symlink creation, the #508 pins (and the new
    `tests/test_508_bundle_containment.py` joins the allow-list: its TEST-20/21 build
    non-placeable/ambiguous outside symlinks). Everything else — every fixture byte,
    every other test — has no symlink reliance.

    THE REALPATH-SITE RE-POINT: `import_visium.py`'s call sites are now EXACTLY THREE —
    the matrix walk's `matrix_realpath` and `obj.file.filename` (the same-FILE
    HDF5-object check), plus the ONE containment site at the end of `locate_members`.
    The per-site predicate now accepts the containment site (it realpaths the root AND
    the member, comparing with `root_real + os.sep` — the measured staging-symlink-safe
    form), not only matrix/obj_file sites. The count and the predicate name the same
    three sites, so neither a fourth realpath nor a lost containment site passes.
    """
    allowed = {"visium_fixtures.py", "test_508_symlinked_members.py",
               "test_508_bundle_containment.py"}
    hits = []
    for test_file in (VF.PKG / "tests").glob("*.py"):
        text = test_file.read_text(encoding="utf-8")
        if "symlink" in text:
            hits.append(test_file.name)
    assert set(hits) == allowed, (
        f"unexpected symlink usage outside the allow-list {sorted(set(hits) - allowed)}"
    )
    compute = (VF.PKG / "compute" / "import_visium.py").read_text(encoding="utf-8")
    sites = [ln for ln in compute.splitlines() if "os.path.realpath(" in ln]
    assert len(sites) == 3, (
        f"{sites} — the only realpath call sites are the matrix walk's two "
        "(matrix_realpath and obj_file) plus the ONE containment site in "
        "`locate_members` (root + member realpaths); a fourth would be an extra "
        "realpath check, and dropping one would break the containment or the walk"
    )
    matrix_walk_sites = [ln for ln in sites if "matrix_realpath" in ln or "obj_file" in ln]
    assert len(matrix_walk_sites) == 2, (
        f"the matrix walk must keep exactly its two realpath sites: {matrix_walk_sites}"
    )
    containment_sites = [ln for ln in sites if "matrix_realpath" not in ln and "obj_file" not in ln]
    assert len(containment_sites) == 1, (
        f"the containment check must be exactly ONE realpath site: {containment_sites}"
    )
    site = containment_sites[0]
    assert "os.path.realpath(root" in site and "os.path.realpath(p)" in site and \
        "os.sep" in site and ".startswith(" in site, (
        f"the containment site must realpath the root AND the member and compare with "
        f"root_real + os.sep (the measured staging-symlink-safe form): {site}"
    )
    assert "cytassist_image" not in site, (
        "the containment site must never touch the `cytassist_image` bool"
    )


# ── TEST-14: Measurement 5 — the HD sibling divergence pin ───────────────────────────


def test_508_the_HD_sibling_locates_non_h5_members_with_no_realpath_check_too():
    r"""TEST-14 — Measurement 5, the HD divergence pin (RE-POINTED by #593).

    #593 RE-POINT, in the #508 run's OWN voice first: "if the two importers ever
    diverge on this pin, this test names it." The HD half (#593) has now LANDED the
    same option-1 rule at HD's own seam (`locate_bins`), so the divergence this pin
    measured is CLOSED — and the pin is re-pointed to the closed state, not deleted:
    the two importers agree again, but must stay that way.

    HD's member locator is `locate_bins` (`def` at `import_visium_hd.py:905`); every
    member is matched by path SUFFIX over `rglob`, and `selected["positions"]` is read
    by path at the `read_positions(selected["positions"])` call (:2436),
    `selected["scalefactors"]` at `read_scalefactors(selected["scalefactors"])` (:2435)
    and `selected["image"]` at the `image_specs = [dict(VENDOR_IMAGES[0],
    path=selected["image"])]` call (:3954). The option-1 node added ONE containment
    check at the END of `locate_bins` (before `return`): it builds a path-only list
    (per-bin matrix/positions/scalefactors/image + extra_images[*]["path"] +
    diagnostics + metrics-when-present + every located candidate of the
    ambiguous/presence-only members) and realpaths BOTH sides at
    `import_visium_hd.py:1236` (`os.path.realpath(p)` against
    `os.path.realpath(root) + os.sep` — the measured staging-symlink-safe form). The
    THREE `os.path.realpath(` call sites are now the matrix leg
    (`matrix_realpath = os.path.realpath(selected["matrix"])`, :2677), the walk's
    `obj.file.filename` (:2711), and the containment site (:1236).
    `_refuse_outside_matrix_objects` remains `def` at :2683 (unchanged, the same-FILE
    HDF5-object check layered on top of the containment rule). HD's refusal prose
    still carries the general-claim sentence — "a dataset whose values depend on
    files outside this bundle cannot be imported": the member VDS/EXTERNAL refusal
    (:2654) and the walk's VDS/EXTERNAL refusal (:2802), plus the comment (:2568).
    The #508 run recorded its PRESENCE in HD — "recorded, not fixed" (HD read-only;
    the record-only issue was #593, its companion), never "recorded as
    over-claiming". That prose is now backed by an enforced check: `locate_bins`
    (:1236) refuses every located member whose resolved path is outside the bundle
    root before the matrix is opened, and the walk's same-FILE checks enforce the
    matrix-file half. (The one ceiling — option 1 is containment by resolved path,
    not by inode, so a member hard-linked from outside shares the bundle's inode and
    is not caught — is disclosed in HD's own containment comment.)
    """
    hd = VF.PKG.parent / "spatial-import-visium-hd" / "compute" / "import_visium_hd.py"
    assert hd.is_file(), "the sibling package must exist in the checkout"
    src = hd.read_text(encoding="utf-8")
    assert "def locate_bins(" in src, "HD's member locator is locate_bins"
    assert "def _refuse_outside_matrix_objects(" in src
    sites = [ln for ln in src.splitlines() if "os.path.realpath(" in ln]
    assert len(sites) == 3, (
        f"{sites} — HD must have EXACTLY the three realpath call sites "
        "(matrix_realpath + the walk's obj_file + the option-1 containment site); "
        "a fourth would be an unplanned member realpath, a return to two would mean "
        "the containment check was removed and the importers diverge again"
    )
    assert any('selected["matrix"]' in ln for ln in sites), sites
    assert any("obj.file.filename" in ln for ln in sites), sites
    assert any("realpath(root)" in ln for ln in sites), (
        f"{sites} — the containment site must realpath the root (both sides) — the "
        "over-refusal trap: comparing against the unresolved `/inputs/<name>` staging "
        "symlink reddened the untouched-bundle control and the inside-relative rows"
    )


# ── TEST-15: the FLIPPED metrics row (READ BY PATH, FIX_ROUND-1) ─────────────────────


# #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
# a path under the bundle root; this pin now asserts the refusal.
def test_508_option1_refuses_a_symlinked_metrics_summary_outside_the_bundle_at_rc2_with_zero_output_paths(tmp_path):
    r"""TEST-15 [acceptance] [invariant: INV-1, INV-2] — the FLIPPED metrics row, ABSOLUTE link (#508 option 1).

    Was a TODAY'S-behavior pin ("imports at rc 0 and the outside Sample ID lands");
    the OWNER DECISION for #508 (issue comment: option 1 — every bundle member must realpath to
    a path under the bundle root) flips it IN PLACE to assert the REFUSAL. FIX_ROUND-1's
    blind audit found `metrics_summary.csv` was missing from the M1 measurement
    entirely: `locate_members` locates it by basename, and `vendor_provenance` (called
    from `run_import`) OPENS it by path and reads it — so it is exactly the read-by-path
    class option 1 exists for (DEC-11). This row replaces the file with an ABSOLUTE
    symlink to an outside copy whose ONLY changed cell is the `Sample ID`
    (`outside-sample-508`; every other cell is the fixture's — the setup is unchanged;
    the outside sample id landing in provenance AND report is gone): rc 2, ZERO files
    under `/outputs`, no manifest.json, the refusal names `metrics_summary.csv` and the
    quoted resolved path, and carries "Refusing rather than" (A3).
    """
    outside = tmp_path / "outside"
    outside.mkdir(exist_ok=True)
    fixture_metrics = VF.FIXTURE / "metrics_summary.csv"
    rows = list(csv.reader(fixture_metrics.open(newline="")))
    assert rows[0][0] == "Sample ID", "the fixture's own metrics header moved — re-seed the row"
    rows[1][0] = OUTSIDE_SAMPLE_ID
    with (outside / "metrics_summary.csv").open("w", newline="") as fh:
        csv.writer(fh).writerows(rows)
    bundle = VF.stage_bundle(tmp_path, name="outs")
    (bundle / "metrics_summary.csv").unlink()
    (bundle / "metrics_summary.csv").symlink_to(outside / "metrics_summary.csv")
    outputs = tmp_path / "out" / "outputs"

    result = VF.run_entry_bytes(bundle, outputs)

    _assert_option1_refusal(result, outputs, "metrics_summary.csv",
                            os.path.realpath(outside / "metrics_summary.csv"))


# ── TEST-16: the FLIPPED diagnostic row (READ BY PATH) ───────────────────────────────


# #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
# a path under the bundle root; this pin now asserts the refusal.
def test_508_option1_refuses_a_symlinked_diagnostic_image_outside_the_bundle_at_rc2_with_zero_output_paths(tmp_path):
    r"""TEST-16 [acceptance] [invariant: INV-1, INV-2] — the FLIPPED diagnostic row, ABSOLUTE link (#508 option 1).

    Was a TODAY'S-behavior pin ("imports at rc 0 and the outside bytes are embedded in
    the report"); the OWNER DECISION for #508 (issue comment: option 1 — every bundle member must
    realpath to a path under the bundle root) flips it IN PLACE to assert the REFUSAL.
    FIX_ROUND-1's blind audit found `DIAGNOSTIC_BASENAMES` were wrongly described as
    "report-only … no bytes are read": `inline_diagnostic` reads the whole file with
    `Path(path).read_bytes()` and base64-embeds it into the report HTML. This row
    replaces the fixture's own `aligned_fiducials.jpg` with an ABSOLUTE symlink to a
    crafted 32x32 solid JPEG (the setup is unchanged; the base64-embedding assertion is
    gone): rc 2, ZERO files under `/outputs`, no manifest.json, the refusal names
    `aligned_fiducials.jpg` and the quoted resolved path, and carries "Refusing rather
    than" (A3).
    """
    import io as _io
    from PIL import Image

    outside = tmp_path / "outside"
    outside.mkdir(exist_ok=True)
    buf = _io.BytesIO()
    Image.new("RGB", (32, 32), (250, 25, 150)).save(buf, "JPEG")
    (outside / "aligned_fiducials.jpg").write_bytes(buf.getvalue())
    bundle = VF.stage_bundle(tmp_path, name="outs")
    (bundle / "spatial" / "aligned_fiducials.jpg").unlink()
    (bundle / "spatial" / "aligned_fiducials.jpg").symlink_to(
        outside / "aligned_fiducials.jpg")
    outputs = tmp_path / "out" / "outputs"

    result = VF.run_entry_bytes(bundle, outputs)

    _assert_option1_refusal(result, outputs, "aligned_fiducials.jpg",
                            os.path.realpath(outside / "aligned_fiducials.jpg"))


# ── TEST-17/18 — the matrix file itself as a symlink (FLIPPED / stays green) ─────────


#: TEST-17's outside-matrix marker. The fixture's `/matrix/data[0]` is 2 and its max
#: is 1891, so 6049 cannot be a fixture value — an unambiguous marker that also keeps
#: the matrix non-zero and finite (no all-zero/all-nonfinite refusal can fire). The
#: marker setup stays in TEST-17 (the outside file the symlink points at must be a
#: VALID matrix, so the refusal is the containment one, never a content refusal).
MATRIX_OUTSIDE_MARKER = 6049


def _marked_outside_matrix(tmp_path):
    """Copy the fixture's h5 to `<tmp>/outside/` and set `/matrix/data[0]` to the marker.

    Shape, indptr, indices, barcodes and features stay byte-identical to the fixture's
    (a plain one-cell value mutation), so no content refusal can fire — the marker
    measures WHICH FILE was read, never an unrelated refusal. Returns (path, fixture0).
    """
    import h5py
    import shutil as _shutil

    outside = tmp_path / "outside"
    outside.mkdir(exist_ok=True)
    dest = outside / "filtered_feature_bc_matrix.h5"
    _shutil.copyfile(VF.FIXTURE / "filtered_feature_bc_matrix.h5", dest)
    with h5py.File(dest, "a") as handle:
        fixture0 = int(handle["matrix/data"][0])
        assert fixture0 != MATRIX_OUTSIDE_MARKER, (
            f"fixture /matrix/data[0] is already {MATRIX_OUTSIDE_MARKER} — the marker "
            "must be unambiguous"
        )
        handle["matrix/data"][0] = MATRIX_OUTSIDE_MARKER
    return dest, fixture0


def _expression_data(outputs):
    """Read `expression.zarr/data` back through the platform's own reader."""
    return VF.read_member(outputs, "expression.zarr", "data")


# #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
# a path under the bundle root; this pin now asserts the refusal.
def test_508_option1_refuses_a_symlinked_matrix_file_outside_the_bundle_at_rc2_with_zero_output_paths(tmp_path):
    r"""TEST-17 [acceptance] [invariant: INV-1, INV-2] — the FLIPPED matrix row, ABSOLUTE link (#508 option 1).

    Was a TODAY'S-behavior pin ("imports at rc 0 and the outside values land in
    `expression.zarr`"); the OWNER DECISION for #508 (issue comment: option 1 — every bundle
    member must realpath to a path under the bundle root) flips it IN PLACE to assert
    the REFUSAL — and this row is the one that closes the `.h5` OWN-path gap the final
    re-judgment exposed (N2): [`refuse_outside_matrix_objects`] derives
    `matrix_realpath = os.path.realpath(matrix_path)` FROM THE LOCATED PATH
    (`import_visium.py` :1896), so a filesystem symlink AT
    `filtered_feature_bc_matrix.h5` pointing OUTSIDE the bundle is NOT caught by the
    walk — every `/matrix` object's backing file then EQUALS the resolved outside file,
    the same-FILE check passes, and the outside matrix's values flow into the store.
    Under option 1 the matrix is just another LOCATED member: the containment check at
    the end of `locate_members` realpaths its located path too, so the OWN-path gap is
    closed. This row replaces the matrix file with an ABSOLUTE symlink to an outside
    copy whose only mutation is `/matrix/data[0]` = 6049 (the setup is unchanged; the
    outside marker landing in `expression.zarr` is gone): rc 2, ZERO files under
    `/outputs`, no manifest.json, the refusal names `filtered_feature_bc_matrix.h5` and
    the quoted resolved path, and carries "Refusing rather than" (A3).
    """
    outside, _fixture0 = _marked_outside_matrix(tmp_path)
    bundle = VF.stage_bundle(tmp_path, name="outs")
    (bundle / "filtered_feature_bc_matrix.h5").unlink()
    (bundle / "filtered_feature_bc_matrix.h5").symlink_to(outside)
    outputs = tmp_path / "out" / "outputs"

    result = VF.run_entry_bytes(bundle, outputs)

    _assert_option1_refusal(result, outputs, "filtered_feature_bc_matrix.h5",
                            os.path.realpath(outside))


def test_508_TODAYS_behavior_an_INSIDE_bundle_matrix_symlink_imports_at_rc0_without_any_refusal(tmp_path):
    r"""TEST-18 — Measurement 2 (final round), the matrix file as an INSIDE relative link.

    TODAY'S behavior, pinned for #508 — and UNCHANGED by the owner's option-1 decision:
    `filtered_feature_bc_matrix.h5` is replaced by a RELATIVE symlink to
    `renamed_matrix.h5` (a byte-identical copy inside the bundle), so the located path
    resolves UNDER the bundle root and option 1 ("realpath to a path under the bundle
    root") ACCEPTS it — exactly like TEST-9's inside-linked members. Nothing refuses it
    today or under the new check: rc 0, the same output-path count, no refusal on
    stderr, and the emitted values are the REAL fixture ones (`expression.zarr/data[0]`
    is the fixture's 2, never the test-17 marker 6049).

    RE-VERIFIED GREEN, UNCHANGED by the #508 option-1 node (A11): the inside-relative
    matrix is the second class the naive predicate reddened; the realpath-rooted
    containment check keeps it rc 0 (MEASURED in STEP0-MEASUREMENT §2d).
    """
    import h5py

    with h5py.File(VF.FIXTURE / "filtered_feature_bc_matrix.h5", "r") as handle:
        fixture0 = float(handle["matrix/data"][0])
    assert fixture0 != MATRIX_OUTSIDE_MARKER, "the marker choice must stay unambiguous"

    bundle = VF.stage_bundle(tmp_path, name="outs")
    (bundle / "renamed_matrix.h5").write_bytes(
        (bundle / "filtered_feature_bc_matrix.h5").read_bytes())
    (bundle / "filtered_feature_bc_matrix.h5").unlink()
    (bundle / "filtered_feature_bc_matrix.h5").symlink_to("renamed_matrix.h5")
    outputs = tmp_path / "out" / "outputs"

    result = VF.run_entry_bytes(bundle, outputs)

    assert result.returncode == 0, result.stderr[-3000:]
    assert _count_paths(outputs) == BASELINE_PATHS, _count_paths(outputs)
    assert (outputs / "manifest.json").is_file()
    assert b"Refusing rather than" not in result.stderr, result.stderr[-2000:]
    data = _expression_data(outputs)
    assert float(data[0]) == fixture0, (
        f"expression.zarr/data[0] is {data[0]} but the inside copy is byte-identical "
        f"to the fixture, whose data[0] is {fixture0} — if it is the marker "
        f"{MATRIX_OUTSIDE_MARKER}, the inside copy was not the file read"
    )
