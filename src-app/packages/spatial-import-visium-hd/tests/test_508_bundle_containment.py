#!/usr/bin/env python3
# ruff: noqa
"""#593 — the HD half of #508 option 1 (bundle-member containment): the NEW tests.

The #508 OWNER DECISION (issue comment) is the binding rule this file exists to pin:

> "The owner has chosen **option 1 — every bundle member must realpath to a path under
> the bundle root**"; "**`spatial-import-visium-hd` (#593)** — the same seam
> (`locate_bins`, `selected["positions"/"scalefactors"/"image"]`), in the **same pass or
> immediately after**, or the two importers diverge again the moment visium lands.";
> "The refusal must name the member and where it resolved to, at rc 2 with zero output
> paths, before the first writer".

TEST-1..9 are the discrimination rows: each hostile shape imported at rc 0 on the base
and NOW refuses by name. TEST-10..13 are the stay-green rows that keep the over-refusal
alarm pinned (the owner's measured trap: a naive `str(root)` comparison reddened the
untouched staged bundle AND the inside-relative symlink cases). TEST-14..16 are the
structural pins (ONE seam at the end of `locate_bins`, both-sided realpath, module-wide
site count 2 -> 3). TEST-17 is the no-symlink-in-fixture / sanctioned-symlink-use pin.
TEST-18/19 are the A14 manifest + issue-state pins. TEST-20 is flip accountability —
HD measured NO today-pins to flip (DEC-11), so this pins the NEW refusal rows as
the accountability set. TEST-21 is the uniform-rule prose pin. TEST-22/23 are the
FIX_ROUND-1 rows (the `+ os.sep` sibling-prefix refusal and the file-root slot arm).
TEST-24 is the FIX_ROUND-2 row: the FLATTENED production staging layout (the one arm
every other refusal row missed — round-2 re-audit N-B-1).

Same harness as `test_refusals.py`: every integration row is a real subprocess run of
the SHIPPED entrypoint (`HF.run_entry_bytes`) over a COPY of the committed fixture
(`HF.staged_tree`), staged through the `/inputs/<name>` SYMLINK the harness really uses
(`_staged`) — the staged ROOT itself is a symlink on every row (measured STEP0 §2 row D),
which is why the predicate realpaths both sides.

NOTE (F-3, DEC-14; corrected round 2 — N-B-5): the `_assert_containment_refusal` helper is
MIRRORED from the sibling's refusal helper (`_assert_option1_refusal`, in
`spatial-import-visium/tests/test_508_bundle_containment.py` — a different name, no
`located_name` kwarg, and no F-4 one-line/ASCII/control-byte assertions) and EXTENDED
here with those F-4 assertions (DEC-8) plus the `located_name` kwarg the F-1 candidate
rows need. The two files remain SELF-CONTAINED (each runnable/auditable on its own; a
shared helper module would couple the two packages' pins). Keep both helpers in sync
MANUALLY when the refusal surface changes.
"""
import ast
import json
import os
import re
import shutil
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent))
import hd_fixtures as HF  # noqa: E402

PKG = HF.PKG

#: The output-entry count of an UNTOUCHED staged bundle through this harness is NOT
#: pinned. MEASURED 2026-09-24 on this box (Python 3.10.12, h5py 3.16.0, pyarrow 25.0.0),
#: and TWO INDEPENDENT CAUSES (corrected round 2 — N-A-6) produce the 119-vs-120 split,
#: which the previous single "runner-environment-dependent" sentence stacked into one:
#:   * STAGING LAYOUT (`hd_hostile_bundles.py:796-799`): the path-preserving `staged_tree`
#:     layout stages the whole fixture and EMITS `spatial-image-lowres.ome.tif` (120
#:     entries: 61 files + 59 dirs), while the FLAT `staged_flat` layout stages ONLY the
#:     twelve declared members (the lowres image is outside the declared list, so no
#:     `spatial-image-lowres.ome.tif` is emitted there and `metrics_summary.csv` is
#:     structurally absent) -- 119 entries (60 files + 59 dirs), the same 119
#:     `hd_hostile_bundles.py:798` already records for the flat control;
#:   * RUNNER WRAPPER vs DIRECT CLI (`hd_hostile_bundles.py:2083-2084` and
#:     `hd_hostile_bundles.py:2133-2134`):
#:     the SAME tree pipeline measures 120 through the runner wrapper (the wrapper's
#:     `run-environment.json` is an extra entry) and 119 in a direct CLI run.
#: Neither is a contract: NO test asserts the count -- the invariant is rc 0 + no refusal
#: line + `manifest.json` on the control rows (TEST-10/11/12), exactly as the hostile-
#: table's own controls state it.

#: The four pre-existing staging-DIRECTORY symlink helpers (measured DEC-11: the ONLY
#: symlink creations in `tests/` outside this file). Pinned by TEST-17/TEST-20 as
#: legitimate and untouched.
SANCTIONED_STAGING_SYMLINK_FILES = (
    "test_refusals.py",
    "test_empty_matrix_refusal.py",
    "test_matrix_storage_refusals.py",
    "test_zero_partial_store.py",
)


def _count_output_entries(outputs):
    """Every path under `outputs`, files AND dirs — the 120/119 entry measure, reported not
    pinned (the controls assert rc 0 + no refusal + `manifest.json`; see the note above)."""
    root = Path(outputs)
    if not root.exists():
        return 0
    return sum(1 for _ in root.rglob("*"))


def _staged(tmp_path, bundle):
    """Mount one bundle as the `bundle` slot and return its `/inputs` dir.

    Reproduces `test_refusals._staged` BY CONSTRUCTION (same shape, duplicated for
    self-containment): the staged ROOT is a SYMLINK to the real bundle dir, so `main()`'s
    `load_inputs_index` hands `locate_bins` the UNRESOLVED `/inputs/<name>` — the exact
    shape the over-refusal alarm (TEST-10) is calibrated on.
    """
    inputs = tmp_path / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    staged = inputs / Path(bundle).name
    staged.symlink_to(Path(bundle).resolve(), target_is_directory=True)
    (inputs / "inputs.json").write_text(json.dumps({
        "inputs": [{"slot": "bundle", "kind": "dataset",
                    "sandbox_path": f"/inputs/{staged.name}"}]
    }), encoding="utf-8")
    return inputs


def _assert_containment_refusal(result, outputs, member_basename, resolved_path,
                                *, located_name=None):
    """A3's full refusal surface (shared by TEST-1..9): rc 2, ZERO paths, named member.

    `located_name` is the file name the refusal itself quotes — the same as
    `member_basename` for every row where the hostile file is called exactly the member's
    basename, and the ORDINAL-PREFIXED spelling (`7_...`) for the F-1 candidate rows
    (TEST-7/8), where the member is AMBIGUOUS and the located outside file is the `{i}_`
    duplicate. `member_basename` is always asserted as a substring (the prefixed spellings
    still carry it) so "naming the member" is pinned on its own, and the resolved path is
    asserted through the last-60-chars window like the sibling's helper.
    """
    stderr = result.stderr
    assert result.returncode == 2, (
        f"the containment refusal must exit 2, got {result.returncode}:\n"
        f"{stderr[-3000:].decode('utf-8', 'replace')}"
    )
    found_entries = _count_output_entries(outputs)
    assert found_entries == 0, (
        f"the refusal must leave ZERO paths under /outputs (before the first writer), "
        f"found {found_entries}"
    )
    assert not (Path(outputs) / "manifest.json").exists(), (
        "a refused bundle must not write a manifest.json"
    )
    text = stderr.decode("utf-8", "replace")
    quoted = located_name if located_name is not None else member_basename
    assert f"'{quoted}' resolves to" in text, (
        f"the refusal must name the member {quoted!r} independently of the quoted "
        f"resolved path:\n{text[-3000:]}"
    )
    assert member_basename in text, (
        f"the refusal must NAME the member {member_basename!r}:\n{text[-3000:]}"
    )
    assert "resolves to" in text, (
        f"the refusal must state where the member resolves to:\n{text[-3000:]}"
    )
    assert str(resolved_path)[-60:] in text, (
        f"the refusal must quote the resolved path {resolved_path}:\n{text[-3000:]}"
    )
    assert b"Refusing rather than" in stderr, (
        f"the refusal must end with the module's 'Refusing rather than' convention:\n"
        f"{text[-3000:]}"
    )
    # INV-9 byte discipline, ENFORCED here (DEC-8): drop the runner's own `progress:`
    # chatter, then the refusal itself must be exactly ONE line, pure ASCII, control-free
    # -- the same observable surface the package's TEST-9 table demands, and the property
    # that makes each line its own `job_logs` row (a vendor newline forges a row).
    refusal_lines = [ln for ln in stderr.splitlines()
                     if ln and not ln.startswith(b"progress: ")]
    assert len(refusal_lines) == 1, (
        f"the refusal must be exactly ONE non-progress stderr line, found "
        f"{len(refusal_lines)}:\n{text[-3000:]}"
    )
    line = refusal_lines[0]
    try:
        line.decode("ascii")
    except UnicodeDecodeError as exc:
        raise AssertionError(
            f"the refusal must be PURE ASCII (the interpolation funnel is total/ASCII): "
            f"{line[:400]!r}") from exc
    control = [b for b in line if b < 0x20 or b == 0x7F]
    assert not control, (
        f"the refusal carries control bytes {control!r}, which the UI renders "
        f"ANSI-unsafe: {line[:400]!r}"
    )


def _bin_dir(root, bin_um):
    return Path(root) / "binned_outputs" / f"square_{bin_um:03d}um"


def _spatial(root, bin_um):
    return _bin_dir(root, bin_um) / "spatial"


def _as_outside_symlink(target, link):
    """`target` (an ABSOLUTE outside path) symlinked at `link`."""
    target.parent.mkdir(parents=True, exist_ok=True)
    Path(link).unlink(missing_ok=True)
    Path(link).symlink_to(target)


# ── TEST-1: the POSITIONS row ───────────────────────────────────────────────────────


def test_508_option1_refuses_a_symlinked_positions_table_outside_the_bundle_at_rc2_with_zero_output_paths(tmp_path):
    r"""TEST-1 [acceptance] [invariant: INV-1, INV-4] [covers: ITEM-2, ITEM-3, ITEM-4] — the POSITIONS row.

    #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
    a path under the bundle root; #593's clause names this seam
    (`locate_bins`, `selected["positions"/"scalefactors"/"image"]`) and the refusal shape
    ("named, at rc 2 with zero output paths, before the first writer"). On the base this
    shape imported at rc 0 with the outside rows in the tissue map; the #508 owner-decision
    containment refusal is the NEW behavior, refused by name.

    `square_008um/spatial/tissue_positions.parquet` replaced by an ABSOLUTE symlink to
    `<tmp>/outside/tissue_positions.parquet` (real parquet bytes — the fixture's own — so
    the link is not dangling and the member is still located): rc 2, ZERO entries under
    /outputs, no `manifest.json`, the refusal names `tissue_positions.parquet`
    independently of the quoted resolved path, quotes the resolved path, and carries the
    module's "Refusing rather than" tail.
    """
    bundle = HF.staged_tree(tmp_path / "run")
    outside = tmp_path / "outside"
    outside.mkdir(parents=True, exist_ok=True)
    (outside / "tissue_positions.parquet").write_bytes(
        (_spatial(bundle, 8) / "tissue_positions.parquet").read_bytes())
    _as_outside_symlink(outside / "tissue_positions.parquet",
                        _spatial(bundle, 8) / "tissue_positions.parquet")
    inputs = _staged(tmp_path, bundle)
    outputs = tmp_path / "out"

    result = HF.run_entry_bytes(inputs, outputs)

    _assert_containment_refusal(result, outputs, "tissue_positions.parquet",
                                os.path.realpath(outside / "tissue_positions.parquet"))


# ── TEST-2: the SCALEFACTORS row ────────────────────────────────────────────────────


def test_508_option1_refuses_a_symlinked_scalefactors_file_outside_the_bundle_at_rc2_with_zero_output_paths(tmp_path):
    r"""TEST-2 [acceptance] [invariant: INV-1, INV-4] [covers: ITEM-2, ITEM-3, ITEM-4] — the SCALEFACTORS row.

    #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
    a path under the bundle root; the #593 refusal shape is "named, at rc 2 with zero
    output paths, before the first writer". On the base this shape imported at rc 0.

    `square_008um/spatial/scalefactors_json.json` as an ABSOLUTE outside symlink to a VALID
    scale document (the fixture's own, plus a marker scale) — `bin_size_um` 8 keeps the
    locator's own per-bin VERIFICATION green, so the refusal that fires is provably the
    CONTAINMENT one and not an earlier bin-size disagreement. DEC-15's placement nuance is
    exercised openly: this file IS read inside the locator (:1111) before the check — a
    READ only, no writer has run, so rc 2 + zero output paths still holds (the owner's
    contract is "before the first writer", not "before any read").
    """
    bundle = HF.staged_tree(tmp_path / "run")
    outside = tmp_path / "outside"
    outside.mkdir(parents=True, exist_ok=True)
    doc = json.loads((_spatial(bundle, 8) / "scalefactors_json.json")
                     .read_text(encoding="utf-8"))
    doc["marker_scale"] = 6049
    (outside / "scalefactors_json.json").write_text(json.dumps(doc), encoding="utf-8")
    _as_outside_symlink(outside / "scalefactors_json.json",
                        _spatial(bundle, 8) / "scalefactors_json.json")
    inputs = _staged(tmp_path, bundle)
    outputs = tmp_path / "out"

    result = HF.run_entry_bytes(inputs, outputs)

    _assert_containment_refusal(result, outputs, "scalefactors_json.json",
                                os.path.realpath(outside / "scalefactors_json.json"))


# ── TEST-3: the IMAGE row ───────────────────────────────────────────────────────────


def test_508_option1_refuses_a_symlinked_hires_image_outside_the_bundle_at_rc2_with_zero_output_paths(tmp_path):
    r"""TEST-3 [acceptance] [invariant: INV-1, INV-4] [covers: ITEM-2, ITEM-3, ITEM-4] — the IMAGE row.

    #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
    a path under the bundle root (the #593 seam names `selected["image"]`). On the base
    this shape imported at rc 0 with the outside pixels in `spatial/image`; now refused by
    name.

    `square_008um/spatial/tissue_hires_image.png` as an ABSOLUTE outside symlink (dangling
    links are NOT the tested shape — a dangling link simply fails `is_file()` and is
    refused as an incomplete bundle elsewhere; the link must RESOLVE, and the resolve must
    be outside): rc 2, zero paths, refusal naming `tissue_hires_image.png` + the resolved
    path + "Refusing rather than".
    """
    bundle = HF.staged_tree(tmp_path / "run")
    outside = tmp_path / "outside"
    outside.mkdir(parents=True, exist_ok=True)
    (outside / "tissue_hires_image.png").write_bytes(
        (_spatial(bundle, 8) / "tissue_hires_image.png").read_bytes())
    _as_outside_symlink(outside / "tissue_hires_image.png",
                        _spatial(bundle, 8) / "tissue_hires_image.png")
    inputs = _staged(tmp_path, bundle)
    outputs = tmp_path / "out"

    result = HF.run_entry_bytes(inputs, outputs)

    _assert_containment_refusal(result, outputs, "tissue_hires_image.png",
                                os.path.realpath(outside / "tissue_hires_image.png"))


# ── TEST-4: the MATRIX `.h5` row (the own-path gap) ─────────────────────────────────


def test_508_option1_refuses_a_symlinked_matrix_file_outside_the_bundle_at_rc2_with_zero_output_paths(tmp_path):
    r"""TEST-4 [acceptance] [invariant: INV-1, INV-4] [covers: ITEM-2, ITEM-3, ITEM-4] — the MATRIX `.h5` row.

    #508 OWNER DECISION (issue comment): "Option 1 closes that too, since the matrix is
    just another located member." On the base the `.h5` own-path gap was open: a symlink
    AT the matrix path admitted an outside matrix that passed the same-FILE HDF5-object
    walk (its objects live in the outside file the member resolved to). Under option 1 the
    matrix is contained like every other member.

    `square_008um/filtered_feature_bc_matrix.h5` as an ABSOLUTE outside symlink to a VALID
    outside matrix whose `/matrix/data[0]` carries the marker 6049: rc 2, ZERO output
    paths, refusal naming `filtered_feature_bc_matrix.h5` + resolved path. The refusal is
    provably the containment one (it is the containment message; the marker would otherwise
    land in `expression.zarr`, and ZERO paths proves it did not) — never a content refusal.
    """
    import h5py

    bundle = HF.staged_tree(tmp_path / "run")
    outside = tmp_path / "outside"
    outside.mkdir(parents=True, exist_ok=True)
    src = _bin_dir(bundle, 2) / "filtered_feature_bc_matrix.h5"
    (outside / "filtered_feature_bc_matrix.h5").write_bytes(src.read_bytes())
    with h5py.File(outside / "filtered_feature_bc_matrix.h5", "r+") as h5:
        h5["matrix/data"][0] = 6049
    with h5py.File(outside / "filtered_feature_bc_matrix.h5", "r") as h5:
        assert h5["matrix/data"][0] == 6049, "the marker must be measurable in the outside matrix"
    _as_outside_symlink(outside / "filtered_feature_bc_matrix.h5",
                        _bin_dir(bundle, 8) / "filtered_feature_bc_matrix.h5")
    inputs = _staged(tmp_path, bundle)
    outputs = tmp_path / "out"

    result = HF.run_entry_bytes(inputs, outputs)

    _assert_containment_refusal(result, outputs, "filtered_feature_bc_matrix.h5",
                                os.path.realpath(outside / "filtered_feature_bc_matrix.h5"))


# ── TEST-5: the EXTRA-IMAGES / RUN-ROOT-FALLBACK evasion (measured E3) ──────────────


def test_508_option1_refuses_the_run_root_fallback_lowres_adoption_outside_the_bundle_at_rc2(tmp_path):
    r"""TEST-5 [acceptance] [invariant: INV-1, INV-4] [covers: ITEM-2, ITEM-3, ITEM-4] — the RUN-ROOT FALLBACK evasion.

    #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
    a path under the bundle root. Measured E3: remove the 8 um bin's
    `spatial/tissue_lowres_image.png` and place `tissue_lowres_image.png` at the bundle
    ROOT as an ABSOLUTE outside symlink — `_named`'s layered fallback (`local or rooted`,
    the run-root layer) ADOPTS the run-root copy into `extra_images[0]["path"]` (and the
    whole-tree candidate walk finds the same file — that walk, `_named(files, basename,
    None, layout)`, is what actually FIRES this row: `extra_images` is a strict SUBSET of
    it (the scoping call only narrows), so the per-leg list is deliberate BREADTH /
    defense in depth, NOT the row's load-bearing discriminator — deleting the leg leaves
    this row green, and the leg itself is pinned by TEST-14's SEGMENT-SPECIFIC assertion
    on the `located_paths = (` list literal (the same literal appears elsewhere in
    `locate_bins`, so the pin is scoped to the list, not the function). The extra image
    is an
    OPTIONAL member, but it is locatable and it IS emitted (`spatial-image-lowres`) — an
    optional member is still a bundle member. On the base this imported at rc 0 with the
    outside lowres emitted; now rc 2, zero paths, refusal naming
    `tissue_lowres_image.png` + the resolved path (the located path is the ADOPTED
    run-root link — the message shows both).
    """
    bundle = HF.staged_tree(tmp_path / "run")
    (_spatial(bundle, 8) / "tissue_lowres_image.png").unlink()
    outside = tmp_path / "outside"
    outside.mkdir(parents=True, exist_ok=True)
    (outside / "tissue_lowres_image.png").write_bytes(b"not a real png, presence for the link")
    _as_outside_symlink(outside / "tissue_lowres_image.png",
                        bundle / "tissue_lowres_image.png")
    inputs = _staged(tmp_path, bundle)
    outputs = tmp_path / "out"

    result = HF.run_entry_bytes(inputs, outputs)

    _assert_containment_refusal(result, outputs, "tissue_lowres_image.png",
                                os.path.realpath(outside / "tissue_lowres_image.png"))


# ── TEST-6: the DIAGNOSTICS row ─────────────────────────────────────────────────────


def test_508_option1_refuses_a_symlinked_diagnostic_image_outside_the_bundle_at_rc2(tmp_path):
    r"""TEST-6 [acceptance] [invariant: INV-1, INV-4] [covers: ITEM-2, ITEM-3, ITEM-4] — the DIAGNOSTICS row.

    #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
    a path under the bundle root. Diagnostics are REPORT-ONLY images (`inline_diagnostic`
    embeds them in the report's `data:` URI), but they are still located members read by
    path. The fixture carries none, so this row places `aligned_fiducials.jpg` at the
    bundle ROOT (`_named`'s run-root layer; the vendor's own layout puts the diagnostics
    there) as an ABSOLUTE outside symlink: the locator ADOPTS it (single unique hit) into
    `diagnostics`, and the candidate walk (`_named(files, basename, None, layout)`) — NOT
    the `diagnostics` leg — is what actually FIRES this row's refusal (`diagnostics` is a
    strict SUBSET of that walk: the scoping call only narrows; the per-leg list is
    deliberate BREADTH / defense in depth, NOT the row's load-bearing discriminator —
    deleting the leg leaves this row green, and the leg itself is pinned by TEST-14's
    SEGMENT-SPECIFIC assertion on the `located_paths = (` list literal (the same literal
    also occurs in the per-bin `roles["diagnostics"] = [` assignment, so the pin is
    scoped to the list, not the function). The check
    refuses rc 2, zero paths, naming `aligned_fiducials.jpg` + resolved path. On the base
    this imported at rc 0 with the outside bytes embedded in the report.
    """
    bundle = HF.staged_tree(tmp_path / "run")
    outside = tmp_path / "outside"
    outside.mkdir(parents=True, exist_ok=True)
    (outside / "aligned_fiducials.jpg").write_bytes(b"\xff\xd8\xff\xe0not-a-real-jpeg")
    _as_outside_symlink(outside / "aligned_fiducials.jpg",
                        bundle / "aligned_fiducials.jpg")
    inputs = _staged(tmp_path, bundle)
    outputs = tmp_path / "out"

    result = HF.run_entry_bytes(inputs, outputs)

    _assert_containment_refusal(result, outputs, "aligned_fiducials.jpg",
                                os.path.realpath(outside / "aligned_fiducials.jpg"))


# ── TEST-7: the F-1 AMBIGUOUS DIAGNOSTICS / METRICS legs ────────────────────────────


def test_508_option1_refuses_the_ambiguous_diagnostic_or_metrics_candidates(tmp_path):
    r"""TEST-7 [acceptance] [invariant: INV-1, INV-2, INV-4] [covers: ITEM-2, ITEM-3, ITEM-4, ITEM-9] — the F-1 ambiguous legs.

    #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
    a path under the bundle root; the sibling's F-1 finding (documented at
    `import_visium.py:2776-2781`) applies to HD identically: an AMBIGUOUS match stores NO
    path at all — `diagnostics` drops the member (len != 1), `metrics` becomes `None` — so
    a check that only contained the stored path would miss an outside-resolving SECOND
    candidate entirely. The check must walk every `_named` candidate of the member
    basenames.

    DIAGNOSTIC arm: `aligned_fiducials.jpg` (real, inside the 8 um `spatial/`) plus
    `7_aligned_fiducials.jpg` (ORDINAL-prefixed, ABSOLUTE outside symlink, same scope) —
    the member is AMBIGUOUS and `diagnostics` keeps neither; the candidate walk refuses
    rc 2, zero paths, naming the member (`7_aligned_fiducials.jpg`, which carries the
    basename) + the resolved candidate path.

    METRICS arm: `metrics_summary.csv` (real, at the run root — the fixture's) plus
    `7_metrics_summary.csv` (ORDINAL-prefixed, ABSOLUTE outside symlink, same root) —
    `metrics` becomes `None` with neither candidate stored; the candidate walk refuses the
    same way, naming `7_metrics_summary.csv`.

    Both arms refuse through the candidate walk (`_named(files, basename, None, layout)`),
    NOT through the `diagnostics` / `metrics` legs — each leg is a strict SUBSET of that
    walk (the per-bin scoping call only narrows; here it stores the single-hit member or
    nothing). The legs are kept as deliberate BREADTH, defense in depth, not as the
    rows' load-bearing discriminators — deleting the legs leaves both arms green, and the
    legs themselves are pinned by TEST-14's SEGMENT-SPECIFIC assertions on the
    `located_paths = (` list literal (those literals also occur elsewhere in
    `locate_bins`, so the pins are scoped to the list, not the function).

    INVERSES (not refusal): each duplication with BOTH candidates INSIDE imports at rc 0 —
    ambiguity is NOT a refusal, nothing new over-refuses.
    """
    # ── DIAGNOSTICS: one candidate OUTSIDE the bundle root ──────────────────────────
    diag_run = tmp_path / "diag-run"
    outside_d = diag_run / "outside"
    outside_d.mkdir(parents=True, exist_ok=True)
    (outside_d / "7_aligned_fiducials.jpg").write_bytes(b"\xff\xd8\xff\xe0outside")
    bundle = HF.staged_tree(diag_run / "tree")
    sp8 = _spatial(bundle, 8)
    (sp8 / "aligned_fiducials.jpg").write_bytes(b"\xff\xd8\xff\xe0inside")
    _as_outside_symlink(outside_d / "7_aligned_fiducials.jpg",
                        sp8 / "7_aligned_fiducials.jpg")
    inputs = _staged(diag_run, bundle)
    outputs = diag_run / "out"
    result = HF.run_entry_bytes(inputs, outputs)
    _assert_containment_refusal(
        result, outputs, "aligned_fiducials.jpg",
        os.path.realpath(outside_d / "7_aligned_fiducials.jpg"),
        located_name="7_aligned_fiducials.jpg")

    # INVERSE: the same duplication with both candidates INSIDE must NOT refuse.
    inside_run = tmp_path / "diag-inside-run"
    bundle2 = HF.staged_tree(inside_run / "tree")
    sp8b = _spatial(bundle2, 8)
    (sp8b / "aligned_fiducials.jpg").write_bytes(b"\xff\xd8\xff\xe0inside")
    (sp8b / "7_aligned_fiducials.jpg").write_bytes(b"\xff\xd8\xff\xe0inside-2")
    inputs2 = _staged(inside_run, bundle2)
    outputs2 = inside_run / "out"
    result2 = HF.run_entry_bytes(inputs2, outputs2)
    assert result2.returncode == 0, result2.stderr[-3000:]
    assert b"Refusing rather than" not in result2.stderr, result2.stderr[-2000:]

    # ── METRICS: one candidate OUTSIDE the bundle root ──────────────────────────────
    met_run = tmp_path / "metrics-run"
    outside_m = met_run / "outside"
    outside_m.mkdir(parents=True, exist_ok=True)
    (outside_m / "7_metrics_summary.csv").write_text(
        "Sample ID\nnot-the-fixture-sample\n", encoding="utf-8")
    bundle3 = HF.staged_tree(met_run / "tree")
    _as_outside_symlink(outside_m / "7_metrics_summary.csv",
                        bundle3 / "7_metrics_summary.csv")
    inputs3 = _staged(met_run, bundle3)
    outputs3 = met_run / "out"
    result3 = HF.run_entry_bytes(inputs3, outputs3)
    _assert_containment_refusal(
        result3, outputs3, "metrics_summary.csv",
        os.path.realpath(outside_m / "7_metrics_summary.csv"),
        located_name="7_metrics_summary.csv")

    # INVERSE: both metrics candidates inside must NOT refuse (member dropped as before).
    met_inside_run = tmp_path / "metrics-inside-run"
    bundle4 = HF.staged_tree(met_inside_run / "tree")
    (bundle4 / "7_metrics_summary.csv").write_bytes(
        (bundle4 / "metrics_summary.csv").read_bytes())
    inputs4 = _staged(met_inside_run, bundle4)
    outputs4 = met_inside_run / "out"
    result4 = HF.run_entry_bytes(inputs4, outputs4)
    assert result4.returncode == 0, result4.stderr[-3000:]
    assert b"Refusing rather than" not in result4.stderr, result4.stderr[-2000:]


# ── TEST-8: the F-1 AMBIGUOUS LOWRES leg ────────────────────────────────────────────


def test_508_option1_refuses_the_ambiguous_lowres_candidate_and_never_touches_the_string(tmp_path):
    r"""TEST-8 [acceptance] [invariant: INV-1, INV-2, INV-4] [covers: ITEM-2, ITEM-3, ITEM-4, ITEM-9] — the AMBIGUOUS LOWRES leg.

    #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
    a path under the bundle root. The measured over-refusal trap (STEP0 §4: probe P3b):
    `ambiguous_images` stores only the BASENAME STRING, and `realpath('tissue_lowres_image.png')`
    resolves against the process CWD — a naive predicate that realpath'd the string would
    refuse on CWD and crash/silently misbehave. The check contains every `_named`
    candidate instead and NEVER touches the string.

    OUTSIDE arm: `tissue_lowres_image.png` (real — the fixture's own) plus
    `7_tissue_lowres_image.png` (ABSOLUTE outside symlink) inside the 8 um `spatial/`:
    `ambiguous_images` = ['tissue_lowres_image.png'], `extra_images` = []; the candidate
    walk refuses rc 2, zero paths, naming `tissue_lowres_image.png` (via the located
    `7_`-prefixed spelling) + the resolved candidate path.

    INVERSE: both candidates inside — rc 0 with the ambiguity REPORTED
    (`images_not_emitted` names the lowres), never refused.
    """
    outside_run = tmp_path / "outside-run"
    outside = outside_run / "outside"
    outside.mkdir(parents=True, exist_ok=True)
    (outside / "7_tissue_lowres_image.png").write_bytes(b"not a real png, presence for the link")
    bundle = HF.staged_tree(outside_run / "tree")
    sp8 = _spatial(bundle, 8)
    _as_outside_symlink(outside / "7_tissue_lowres_image.png",
                        sp8 / "7_tissue_lowres_image.png")
    inputs = _staged(outside_run, bundle)
    outputs = outside_run / "out"
    result = HF.run_entry_bytes(inputs, outputs)
    _assert_containment_refusal(
        result, outputs, "tissue_lowres_image.png",
        os.path.realpath(outside / "7_tissue_lowres_image.png"),
        located_name="7_tissue_lowres_image.png")

    # INVERSE: both inside — rc 0, ambiguity reported, no refusal.
    inside_run = tmp_path / "inside-run"
    bundle2 = HF.staged_tree(inside_run / "tree")
    sp8b = _spatial(bundle2, 8)
    (sp8b / "7_tissue_lowres_image.png").write_bytes(
        (sp8b / "tissue_lowres_image.png").read_bytes())
    inputs2 = _staged(inside_run, bundle2)
    outputs2 = inside_run / "out"
    result2 = HF.run_entry_bytes(inputs2, outputs2)
    assert result2.returncode == 0, result2.stderr[-3000:]
    assert (Path(outputs2) / "manifest.json").is_file()
    assert b"Refusing rather than" not in result2.stderr, result2.stderr[-2000:]
    report = json.loads((Path(outputs2) / "visium-hd-import-report.json")
                        .read_text(encoding="utf-8"))
    named = " ".join(report.get("images_not_emitted", []))
    assert "tissue_lowres_image.png" in named, (
        f"the ambiguity must be REPORTED (never silently dropped): "
        f"{report.get('images_not_emitted')!r}")


# ── TEST-9: the NON-PLACEABLE leg, both arms ────────────────────────────────────────


def test_508_option1_refuses_the_non_placeable_outside_candidate_while_the_inside_arm_imports(tmp_path):
    r"""TEST-9 [acceptance] [invariant: INV-1, INV-2, INV-3, INV-4] [covers: ITEM-2, ITEM-3, ITEM-4, ITEM-9] — the NON-PLACEABLE leg.

    #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
    a path under the bundle root. `non_placeable_images` is a list of SPEC DICTS
    (basename + reason, NO path — the measured over-refusal: realpath of a dict is a
    TypeError, probe P3a/P3c), so the check contains the `_named`-derived candidate and
    never the dict value.

    INSIDE arm: a real `cytassist_image.tiff` INSIDE at the run root (the vendor's own
    layout puts it there) imports at rc 0 — presence REPORTED in `images_not_emitted`,
    never refused; the spec dict and its reason are never realpath'd. OUTSIDE arm: the
    same basename as an ABSOLUTE outside symlink refuses rc 2, zero paths, naming
    `cytassist_image.tiff` + the resolved candidate path.
    """
    # INSIDE: a real non-placeable file, presence-only.
    inside_run = tmp_path / "inside-run"
    bundle = HF.staged_tree(inside_run / "tree")
    (bundle / "cytassist_image.tiff").write_bytes(
        b"\x49\x49\x2a\x00 presence-only, never opened")
    inputs = _staged(inside_run, bundle)
    outputs = inside_run / "out"
    result = HF.run_entry_bytes(inputs, outputs)
    assert result.returncode == 0, result.stderr[-3000:]
    assert (Path(outputs) / "manifest.json").is_file()
    assert b"Refusing rather than" not in result.stderr, result.stderr[-2000:]
    report = json.loads((Path(outputs) / "visium-hd-import-report.json")
                        .read_text(encoding="utf-8"))
    named = " ".join(report.get("images_not_emitted", []))
    assert "cytassist_image.tiff" in named, (
        f"the inside non-placeable member must be REPORTED (presence, not refusal): "
        f"{report.get('images_not_emitted')!r}")

    # OUTSIDE: the same basename as an ABSOLUTE symlink to outside the bundle.
    outside_run = tmp_path / "outside-run"
    outside = outside_run / "outside"
    outside.mkdir(parents=True, exist_ok=True)
    (outside / "cytassist_image.tiff").write_bytes(b"x")
    bundle2 = HF.staged_tree(outside_run / "tree")
    _as_outside_symlink(outside / "cytassist_image.tiff",
                        bundle2 / "cytassist_image.tiff")
    inputs2 = _staged(outside_run, bundle2)
    outputs2 = outside_run / "out"
    result2 = HF.run_entry_bytes(inputs2, outputs2)
    _assert_containment_refusal(result2, outputs2, "cytassist_image.tiff",
                                os.path.realpath(outside / "cytassist_image.tiff"))


# ── TEST-10: the CONTROL — the over-refusal alarm ───────────────────────────────────


def test_508_option1_the_untouched_staged_bundle_control_stays_rc0(tmp_path):
    r"""TEST-10 [acceptance] [invariant: INV-5] [covers: ITEM-5, ITEM-9, ITEM-10] — the CONTROL row.

    #508 OWNER DECISION (issue comment): "it reddened the inside-relative symlink cases
    AND the untouched-staged-bundle control … a real option 1 must keep those green".
    This is the over-refusal ALARM: an UNTOUCHED staged bundle (`staged_tree` copy staged
    through the `/inputs/<name>` SYMLINK — the staged ROOT itself is a symlink, measured
    STEP0 §2 row D) imports at rc 0 + `manifest.json`, and stderr carries no refusal line
    (measured 2026-09-24 on the staged-tree seam: 120 entries — 61 files + 59 dirs; the
    count is runner-environment-dependent per `hd_hostile_bundles.py` and deliberately NOT
    pinned — see the module note above). A predicate comparing against `str(root)` refuses
    EVERY member on this staged shape (every member realpaths under the REAL dir, the raw
    root does not — measured row D), so this row reddens the moment the root is not
    realpath'd.
    """
    bundle = HF.staged_tree(tmp_path / "tree")
    inputs = _staged(tmp_path, bundle)
    outputs = tmp_path / "out"

    result = HF.run_entry_bytes(inputs, outputs)

    assert result.returncode == 0, result.stderr[-3000:]
    assert (Path(outputs) / "manifest.json").is_file()
    assert b"Refusing rather than" not in result.stderr, result.stderr[-2000:]


# ── TEST-11: the INSIDE-RELATIVE members stay green ─────────────────────────────────


def test_508_option1_the_inside_relative_symlinked_members_stay_rc0(tmp_path):
    r"""TEST-11 [acceptance] [invariant: INV-5] [covers: ITEM-5, ITEM-9] — the INSIDE-RELATIVE members.

    #508 OWNER DECISION (issue comment): the naive predicate "reddened the inside-relative
    symlink cases" — a REAL option 1 keeps them green, because a RELATIVE same-bundle
    symlink realpaths UNDER the bundle root. `tissue_positions.parquet`,
    `scalefactors_json.json` and `tissue_hires_image.png` replaced by RELATIVE same-dir
    symlinks to `renamed_*` copies (and the lowres image likewise): rc 0,
    `manifest.json` + `expression.zarr` present, no refusal line (measured 120 entries on
    this seam — runner-environment-dependent, deliberately not pinned). The
    emitted values are the real fixture ones, unpinned individually (the values themselves
    are pinned by the end-to-end suites; the over-refusal claim is the rc-0/no-line thing).
    """
    bundle = HF.staged_tree(tmp_path / "tree")
    sp8 = _spatial(bundle, 8)
    pairs = (("tissue_positions.parquet", "renamed_tissue_positions.parquet"),
             ("scalefactors_json.json", "renamed_scalefactors_json.json"),
             ("tissue_hires_image.png", "renamed_tissue_hires_image.png"),
             ("tissue_lowres_image.png", "renamed_tissue_lowres_image.png"))
    for member, renamed in pairs:
        (sp8 / renamed).write_bytes((sp8 / member).read_bytes())
        (sp8 / member).unlink()
        (sp8 / member).symlink_to(renamed)
    inputs = _staged(tmp_path, bundle)
    outputs = tmp_path / "out"

    result = HF.run_entry_bytes(inputs, outputs)

    assert result.returncode == 0, result.stderr[-3000:]
    # measured 2026-09-24: 120 entries (61 files + 59 dirs) — runner-environment-dependent
    # per `hd_hostile_bundles.py`, deliberately not pinned (see the module note above); the
    # over-refusal claim is the rc-0/no-refusal-line pair, and the values are pinned by the
    # end-to-end suites.
    assert (Path(outputs) / "manifest.json").is_file()
    assert (Path(outputs) / "expression.zarr").exists()
    assert b"Refusing rather than" not in result.stderr, result.stderr[-2000:]


# ── TEST-12: the `metrics = None` folder-upload arm ─────────────────────────────────


def test_508_option1_the_metrics_None_flat_layout_arm_stays_rc0(tmp_path):
    r"""TEST-12 [acceptance] [invariant: INV-3, INV-5] [covers: ITEM-5, ITEM-9] — the `metrics = None` arm.

    #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to
    a path under the bundle root. The FLAT folder-upload arm (`HF.staged_flat`) structurally
    lacks a run-root `metrics_summary.csv` (measured STEP0 §2 row C / P5): `metrics` is
    `None`, and `None` is EXEMPT BY CONSTRUCTION — realpath(None) is a TypeError (measured
    P3d), and an optional member's ABSENCE is not a refusal. Imports at rc 0 with a
    `manifest.json` (measured 2026-09-24: 119 output entries for the flat layout —
    `hd_hostile_bundles.py` already records the flat-vs-tree 119/120 difference and that NO
    test asserts the count; re-measured on this box, deliberately not pinned).
    """
    inputs, _ordinals = HF.staged_flat(tmp_path)
    outputs = tmp_path / "out"

    result = HF.run_entry_bytes(inputs, outputs)

    assert result.returncode == 0, result.stderr[-3000:]
    # measured 2026-09-24: 119 entries (60 files + 59 dirs) — runner-environment-dependent
    # per `hd_hostile_bundles.py`, deliberately not pinned (see the module note above);
    # the invariant is that `metrics = None` is skipped, never realpath'd.
    assert (Path(outputs) / "manifest.json").is_file()
    assert b"Refusing rather than" not in result.stderr, result.stderr[-2000:]


# ── TEST-13: PER-BIN all-bins coverage ──────────────────────────────────────────────


def test_508_option1_every_bin_is_covered_not_only_the_default_8um(tmp_path):
    r"""TEST-13 [acceptance] [invariant: INV-5, INV-6] [covers: ITEM-5, ITEM-9] — PER-BIN all-bins coverage.

    #508 OWNER DECISION (issue comment): option 1 — EVERY bundle member must realpath
    under the bundle root; #593 pins it at `locate_bins`, which LOCATES ALL THREE bins
    (2/8/16 um) before `run_import` selects one — so the ONE check at the locator's end
    covers every bin's selections, not only the requested one.

    (a) the normal fixture imports at rc 0 for EACH requested bin (`params={"bin_um": 2/8/16}`)
    and the report shows the REQUESTED bin was honored (`report["bin_um"] == bin_um` — read
    from `visium-hd-import-report.json`; the key is the importer's own report field
    `"bin_um"`, `import_visium_hd.py` `report = { "bin_um": int(bin_um), ... }`) — the check
    must not redden a legitimate request for any bin, nor silently pick a different one;
    (b) an outside-symlinked `square_016um/spatial/tissue_positions.parquet` refuses rc 2,
    zero paths, naming `tissue_positions.parquet` even though 16 um is NOT the selected
    default (8 um) — the check is not scoped to the selected bin.
    """
    for bin_um in (2, 8, 16):
        run = tmp_path / f"bin-{bin_um}"
        bundle = HF.staged_tree(run / "tree")
        inputs = _staged(run, bundle)
        outputs = run / "out"
        result = HF.run_entry_bytes(inputs, outputs, params={"bin_um": bin_um})
        assert result.returncode == 0, (
            f"the {bin_um} um bin must import at rc 0 under the containment check:\n"
            f"{result.stderr[-3000:]}")
        report = json.loads(
            (outputs / "visium-hd-import-report.json").read_text(encoding="utf-8"))
        assert report["bin_um"] == bin_um, (
            f"the requested {bin_um} um bin must be the reported one, got "
            f"{report['bin_um']!r} — the check must not let the locator return a different "
            "bin than the caller asked for")
        assert b"Refusing rather than" not in result.stderr, result.stderr[-2000:]

    run16 = tmp_path / "bin-outside-16"
    bundle16 = HF.staged_tree(run16 / "tree")
    outside = run16 / "outside"
    outside.mkdir(parents=True, exist_ok=True)
    (outside / "tissue_positions.parquet").write_bytes(
        (_spatial(bundle16, 16) / "tissue_positions.parquet").read_bytes())
    _as_outside_symlink(outside / "tissue_positions.parquet",
                        _spatial(bundle16, 16) / "tissue_positions.parquet")
    inputs16 = _staged(run16, bundle16)
    outputs16 = run16 / "out"
    result16 = HF.run_entry_bytes(inputs16, outputs16)
    _assert_containment_refusal(result16, outputs16, "tissue_positions.parquet",
                                os.path.realpath(outside / "tissue_positions.parquet"))


# ── TEST-14: the structural pin — ONE containment check at the END of locate_bins ───


def test_508_the_one_containment_check_is_structural_and_lives_at_the_end_of_locate_bins():
    r"""TEST-14 [acceptance] [invariant: INV-2, INV-3, INV-6] [covers: ITEM-1, ITEM-2, ITEM-7, ITEM-9] — the single choke point, STRUCTURALLY.

    #508 OWNER DECISION (issue comment): "one containment check at the end of
    `locate_bins` (the single choke point: every consumer reads through the returned
    dict)". Reads the AST so a check moved to a consumer (or duplicated, or dropped)
    reddens:

    * exactly ONE `os.path.realpath(` line in the whole `locate_bins` body — the
      containment site (the matrix walk's two sites live in
      `_refuse_outside_matrix_objects`, not this function);
    * that ONE site realpaths the member AND `root`, compares with `root_real + os.sep`
      via `startswith` — the measured staging-symlink-safe form;
    * the site sits AFTER every member shape (after the `metrics = _named(...)`
      computation) and BEFORE `return {`;
    * the containing statement also raises `VisiumImportError`;
    * the site never names `ambiguous_images`, `non_placeable_images`,
      `bin_size_um_declared`, `bin_um` or `layout` — the non-path exemptions, and the
      path-only list is built from `MEMBER_ROLES` / `extra_images` / `diagnostics` /
      `metrics` / `_named` candidates, never from a str()-ed value.
    """
    import ast

    src = (PKG / "compute" / "import_visium_hd.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    fn = next((n for n in tree.body
               if isinstance(n, ast.FunctionDef) and n.name == "locate_bins"), None)
    assert fn is not None, "locate_bins no longer exists — the containment site has no home"
    body_src = ast.get_source_segment(src, fn)
    lines = body_src.splitlines()

    realpath_lines = [i for i, ln in enumerate(lines) if "os.path.realpath(" in ln]
    assert len(realpath_lines) == 1, (
        f"locate_bins must have exactly ONE containment realpath site, found "
        f"{realpath_lines}: the check must be one site at the end, never duplicated or "
        "split per member"
    )
    site = lines[realpath_lines[0]]
    assert "os.path.realpath(root" in site, (
        f"the containment site must realpath the root too (the staged root IS the "
        f"/inputs/<name> symlink): {site}"
    )
    assert "os.path.realpath(p)" in site, (
        f"the containment site must realpath the member path: {site}"
    )
    assert "os.sep" in site, (
        f"the containment site must compare against root_real + os.sep (an empty-sep "
        f"prefix would admit a sibling directory named like the root): {site}"
    )
    assert ".startswith(" in site, f"the containment test must be a prefix comparison: {site}"
    assert "root_real" in site, f"the root's resolved path must be the compared side: {site}"
    for exempt in ("ambiguous_images", "non_placeable_images", "bin_size_um_declared",
                   "bin_um", "layout"):
        assert exempt not in site, (
            f"the containment site must never touch the exempt {exempt!r} non-path member"
        )

    # Position: after every member shape (the metrics computation is the LAST shape) and
    # before `return {`. The lookups use a None-default generator so a renamed/gone shape
    # fails with the INTENDED message below, not a bare StopIteration.
    metrics_line = next((i for i, ln in enumerate(lines)
                         if 'metrics = _named(files, "metrics_summary.csv"' in ln), None)
    assert metrics_line is not None, "the metrics computation (last member shape) is gone"
    assert metrics_line < realpath_lines[0], (
        "the containment check must sit AFTER every member shape is built"
    )
    return_line = next((i for i, ln in enumerate(lines)
                        if ln.strip() == "return {"), None)
    assert return_line is not None, (
        "the `return {` line is gone — the locator must still return its members"
    )
    assert realpath_lines[0] < return_line, (
        "the containment check must sit BEFORE `return {`"
    )
    # The path-only list is built by construction from the path-bearing members and the
    # locator's OWN candidate machinery.
    text = "\n".join(lines)
    assert "for role in MEMBER_ROLES" in text, (
        "the located-path list must start from the four declared ROLES of every bin"
    )
    # SEGMENT-SPECIFIC leg pins: the three literal-bearing legs are asserted inside the
    # `located_paths = (` list literal itself. The same literals also occur ELSEWHERE in
    # locate_bins (`roles["extra_images"]` in the per-image emission, `roles["diagnostics"]
    # = [` in the per-bin assignment, `metrics[0]` in the returned dict), so a
    # whole-function substring pin would redden on nothing — the pin must be scoped to
    # the list it claims.
    legs_start = text.index("located_paths = (")
    legs_end = text.index("\n    for basename in (", legs_start)
    legs_src = text[legs_start:legs_end]
    assert 'roles["extra_images"]' in legs_src, (
        "the `located_paths = (` list literal itself must include the every-extra-image "
        "leg (`roles[\"extra_images\"]`) — the same literal elsewhere in locate_bins "
        "cannot stand in for the leg"
    )
    assert '"diagnostics"' in legs_src, (
        "the `located_paths = (` list literal itself must include the every-diagnostic "
        "leg (`roles[\"diagnostics\"]`) — the same literal elsewhere in locate_bins "
        "cannot stand in for the leg"
    )
    assert "metrics[0]" in legs_src, (
        "the `located_paths = (` list literal itself must include the unique-hit metrics "
        "leg (`metrics[0]`) — the returned dict's occurrence cannot stand in for it"
    )
    assert "_named(files, basename, None, layout)" in text, (
        "the F-1 candidate walk must use the locator's OWN name test over the whole tree"
    )
    # Root normalization happens in front of the check (the staged-root crux).
    assert "root = Path(root)" in text, "the root must still be normalized to Path"
    assert "root.is_file()" in text and "root = root.parent" in text, (
        "the is_file() branch must still normalize the root before the containment check"
    )
    # The containing statement also carries the refusal.
    for stmt in fn.body:
        seg = ast.get_source_segment(src, stmt) or ""
        if "os.path.realpath(" in seg:
            assert "raise VisiumImportError(" in seg, (
                "the containment site must be the refusal itself: the statement contains "
                "no VisiumImportError raise"
            )
            break
    else:
        raise AssertionError("the containment statement was not found in locate_bins' body")


# ── TEST-15: REALPATH-BOTH-SIDES form ───────────────────────────────────────────────


def test_508_the_containment_predicate_realpaths_BOTH_sides_and_uses_root_real_plus_os_sep():
    r"""TEST-15 [acceptance] [invariant: INV-1, INV-5] [covers: ITEM-2, ITEM-7] — the REALPATH-BOTH-SIDES form.

    #508 OWNER DECISION (issue comment): the known trap — "print what `root` and every
    member actually realpath to … BEFORE writing the predicate"; measured STEP0 §2 row D:
    the staged harness root IS a symlink (`str(root)` = `<tmp>/inputs/real-bundle`,
    realpath = `<tmp>/real-bundle`), so realpath'ing only the member would refuse EVERY
    staged bundle (the sibling's measured second cause). This pin asserts the containment LINE
    carries BOTH `os.path.realpath(root` and `os.path.realpath(p)` and compares against
    `root_real + os.sep` (the `os.sep` so an empty prefix cannot admit a sibling directory
    named like the root), and that the root NORMALIZATION (`root = Path(root)` + the
    `is_file()` branch) precedes the site. Behaviorally: TEST-10 reddens if the
    `str(root)` comparison is reintroduced.

    NOTE (plan-internal constraint): TESTS.md's predicate sketch binds `root_real` on its
    own line, but TEST-14/TEST-16 require the containment site to be a SINGLE `os.path.realpath(`
    line (the module-wide count goes exactly 2 -> 3; a second root-assignment line would be
    a fourth site) — so the root realpath is bound on the same line via the walrus
    operator, exactly as the shipped visium predicate does.
    """
    src = (PKG / "compute" / "import_visium_hd.py").read_text(encoding="utf-8")
    lines = src.splitlines()
    containment = [ln for ln in lines if "os.path.realpath(p)" in ln]
    assert len(containment) == 1, (
        f"exactly one containment realpath site expected, found {containment}"
    )
    site = containment[0]
    assert "os.path.realpath(root" in site and "os.path.realpath(p)" in site, (
        f"the containment line must realpath BOTH the member and the root: {site}"
    )
    assert "root_real" in site and "+ os.sep" in site, (
        f"the comparison must be root_real + os.sep (both sides realpath'd), got: {site}"
    )
    assert ".startswith(" in site, f"the containment test must be a prefix comparison: {site}"
    i_root = next(i for i, ln in enumerate(lines) if ln.strip() == "root = Path(root)")
    i_file = next(i for i, ln in enumerate(lines) if "if root.is_file():" in ln)
    i_site = next(i for i, ln in enumerate(lines) if "os.path.realpath(p)" in ln)
    assert i_root < i_file < i_site, (
        "the root normalization (Path + is_file branch) must precede the containment site"
    )


# ── TEST-16: the module-wide realpath-SITE enumeration (2 -> 3) ─────────────────────


def test_508_the_module_wide_realpath_sites_are_exactly_three():
    r"""TEST-16 [acceptance] [invariant: INV-6] [covers: ITEM-1, ITEM-7] — the module-wide site count.

    #508 OWNER DECISION (issue comment): option 1 pins "the same seam" — the one
    containment site, never duplicated, never in a consumer. `compute/import_visium_hd.py`
    has EXACTLY THREE lines containing `os.path.realpath(`:

    * the matrix walk's `matrix_realpath` site (:2581 on the base),
    * the matrix walk's `obj.file.filename` site (:2615 on the base),
    * the ONE containment line inside `locate_bins`, which carries BOTH
      `os.path.realpath(root` and `os.path.realpath(p)` on that single line.

    The base measured exactly TWO (the #508 node's own cross-pin
    `test_508_symlinked_members.py::test_508_the_HD_sibling_locates_non_h5_members_with_no_realpath_check_too`
    records the 2 -> the divergence #593 closes); the per-site predicate accepts exactly
    that triple and nothing at a non-path value. A duplicate containment site (or one in a
    consumer), or a containment site split over two lines, reddens the count.
    """
    src = (PKG / "compute" / "import_visium_hd.py").read_text(encoding="utf-8")
    sites = [ln for ln in src.splitlines() if "os.path.realpath(" in ln]
    assert len(sites) == 3, (
        f"{sites} — the only realpath call sites are the matrix walk's two "
        "(matrix_realpath and obj_file) plus the ONE containment site in `locate_bins` "
        "(root + member realpaths); a fourth would be an extra realpath check, and "
        "dropping one would break the containment or the walk"
    )
    matrix_sites = [ln for ln in sites if "matrix_realpath" in ln or "obj_file" in ln]
    assert len(matrix_sites) == 2, (
        f"the matrix walk must keep exactly its two realpath sites: {matrix_sites}"
    )
    assert any("selected[\"matrix\"]" in ln for ln in matrix_sites), matrix_sites
    assert any("obj.file.filename" in ln for ln in matrix_sites), matrix_sites
    containment_sites = [ln for ln in sites
                         if "matrix_realpath" not in ln and "obj_file" not in ln]
    assert len(containment_sites) == 1, (
        f"the containment check must be exactly ONE realpath site: {containment_sites}"
    )
    site = containment_sites[0]
    assert "os.path.realpath(root" in site and "os.path.realpath(p)" in site and \
        "os.sep" in site and ".startswith(" in site, (
        f"the containment site must realpath the root AND the member and compare with "
        f"root_real + os.sep (the measured staging-symlink-safe form): {site}"
    )
    assert "function locate_bins" in src or "def locate_bins(" in src
    for exempt in ("ambiguous_images", "non_placeable_images", "bin_size_um_declared",
                   "bin_um", "layout"):
        assert exempt not in site, (
            f"the containment site must never touch the exempt {exempt!r} non-path member"
        )


# ── TEST-17: no-symlink-in-fixture and NO UNLISTED symlink use ──────────────────────


def test_508_no_committed_fixture_or_test_relies_on_a_symlinked_bundle_member():
    r"""TEST-17 [covers: ITEM-7] — NO-SYMLINK-IN-FIXTURE and NO UNLISTED SYMLINK USE.

    **A4 blast-radius argument, re-voiced for HD:** a containment check can only be
    PROVEN non-circular if the committed fixture has ZERO symlinks (a fixture whose member
    bytes arrive through a symlink would let a check "pass" without containing the real
    path) — MEASURED on the base: `find -type l` over `tests/fixtures/visium-hd-outs/` is
    empty, and it stays empty here.

    **Pre-existing symlink use:** the ONLY `.symlink_to(`/`os.symlink(` calls in `tests/*.py`
    outside this file are the four staging-DIRECTORY helper lines
    (`test_refusals.py:62`, `test_empty_matrix_refusal.py:113`,
    `test_matrix_storage_refusals.py:147`, `test_zero_partial_store.py:92`) — all
    `target_is_directory=True` mounts of the WHOLE bundle at `/inputs/<name>`, never a
    member. THIS file adds the member-level links (outside-symlinked members and the
    inside-relative controls). No test may rely on a symlinked bundle member to pass by
    accident: every one is here, in the sanctioned files.
    """
    fixture = PKG / "tests" / "fixtures" / "visium-hd-outs"
    links = [p for p in fixture.rglob("*") if p.is_symlink()]
    assert links == [], (
        f"the committed fixture must carry ZERO symlinks (a fixture member whose bytes "
        f"arrive through a link would let the containment check pass without containing "
        f"the real path): {links}"
    )
    users = []
    for test_file in sorted((PKG / "tests").glob("*.py")):
        text = test_file.read_text(encoding="utf-8")
        if ".symlink_to(" in text or "os.symlink(" in text:
            users.append(test_file.name)
    sanctioned = set(SANCTIONED_STAGING_SYMLINK_FILES) | {
        "test_508_bundle_containment.py"}
    assert set(users) == sanctioned, (
        f"unexpected symlink creation outside the sanctioned files: "
        f"{sorted(set(users) - sanctioned)} — a test relying on a symlinked member outside "
        "this restraint set would be a pin for the wrong thing"
    )
    # The four pre-existing helpers are DIRECTORIES-only mounts (never a member link).
    for name in SANCTIONED_STAGING_SYMLINK_FILES:
        text = (PKG / "tests" / name).read_text(encoding="utf-8")
        assert "target_is_directory=True" in text, (
            f"{name} lost its directory-mount shape — the four staging helpers are the "
            "legitimate whole-bundle mounts"
        )


# ── TEST-18: the A14 manifest pin ───────────────────────────────────────────────────


# TEST-4 (#643), re-pointed by the owner at #471's merge, by the #648 node at its bump,
# and by this node at #650's: the A14-1 pin tracks the NEWEST entry, so a later bump
# re-points it (the convention every node in this chain followed). HD 0.23.0 is this
# node's own guard-bump (#650).
def test_654_the_manifest_bump_and_its_changelog_entry_are_at_0_23_2_and_name_this_issue():
    r"""TEST-18 [covers: ITEM-10] — the A14 manifest pin.

    Mirrors the sibling's TEST-10 (0.25.1, `test_654_the_manifest_bump_and_its_changelog_entry_are_at_
    0_25_1_and_name_this_issue`) for HD: `version:` is exactly one top-level
    key at >= (0, 23, 0); the newest changelog head immediately above `version:` starts
    `# 0.23.0 — #650:` (NOT `#648`-, `#471`-, `#643`-, `#641`-, `#638`-, `#593`- or
    `#613`-headed — the previous branches' issues must never be this entry's own head, and
    `#648` now joins that set as the 0.22.0 round's issue); it is a real block (>= 5
    continuation lines at the 10-space indent); it names the NEW concrete subject — the
    DATASET-READ residuals #648's audit recorded: the `four guarded matrix reads` that
    omitted OSError, the `UNGUARDED` dataset block-scan, the `six-name fence` the twins
    now share, and the `twins` agreement sentence. These four needles are scoped to THIS
    entry's body (extracted from `manifest.yaml` only, never from the compute comments)
    and name the entry's SUBJECT, not the mechanism — the #646 pin-discrimination trap
    (a presence-prose pin satisfiable by the fix's own explanatory comment) is why the
    assertions are (i) entry-body-scoped and (ii) subject phrases rather than mechanism
    words;
    `#313` (the birth issue) remains cited in the changelog. HD's OWN TEST-27
    (`test_package_registration.py`) is verified unchanged — it derives everything from
    the manifest and only requires the newest head's issue to be recorded in
    `tests/issue_states.json` (ITEM-10 is the third half: the `650`/`646` OPEN and `648`
    CLOSED re-capture). The VISIUM suite's HD divergence pin —
    `tests/test_508_symlinked_members.py::test_508_the_HD_sibling_locates_non_h5_members_with_no_realpath_check_too`
    (TEST-14) — reads this module's source every run and is UNCHANGED by this node (no
    `os.path.realpath(` call is added by the guarded reads), and is re-run for the record
    at phase 8. The sibling-divergence pin TEST-25 (same file) is re-run UNCHANGED by
    this node too, and TEST-29 (`test_no_closed_issue_pointers.py`) re-verifies the
    issue-states re-capture: every `#NNN` this node adds — `#650` in the compute
    comments, the TEST-113..118 docstrings and this entry; `#646` in THIS docstring;
    `#648` re-cited as the predecessor — must be recorded in the snapshot. Both re-run
    pins are re-verified at phase 8: TEST-25 (this file's sibling-mirror divergence pin,
    re-run UNCHANGED by this node) and the VISIUM suite's TEST-14
    (`test_508_symlinked_members.py`, the HD divergence pin reading this package's
    compute — re-run UNCHANGED, exactly three `os.path.realpath(` sites remain).
    """
    text = (PKG / "manifest.yaml").read_text(encoding="utf-8")
    lines = text.splitlines()
    declared = [ln.split(":", 1)[1].strip().strip('"\'')
                for ln in lines if ln.startswith("version:")]
    assert len(declared) == 1, (
        f"expected exactly one top-level `version:`, found {declared} — YAML takes the "
        "last, so a second key silently decides what ships"
    )
    version = tuple(int(p) for p in declared[0].split("."))
    assert version >= (0, 23, 2), (
        f"version {declared[0]} is below the (0, 23, 2) floor this bump claims"
    )
    heads = [ln for ln in lines if re.match(r"^# \d+\.\d+\.\d+ — #\d", ln)]
    version_line = next(i for i, ln in enumerate(lines) if ln.startswith("version:"))
    before = [ln for ln in heads if lines.index(ln) < version_line]
    assert before, "no changelog head sits above the `version:` line"
    newest = before[-1]
    assert newest.startswith(f"# {declared[0]} — #654:"), newest
    assert ("#648" not in newest and "#471" not in newest and "#638" not in newest
            and "#613" not in newest and "#593" not in newest and "#641" not in newest
            and "#643" not in newest), (
        f"the newest entry {newest!r} claims a PREVIOUS branch's issue as its own head"
    )
    body = text.split(newest, 1)[1].splitlines()[1:]
    continued = [ln for ln in body[:80] if ln.startswith("#" + " " * 10)]
    assert len(continued) >= 5, (
        f"the {declared[0]} entry has only {len(continued)} continuation lines at the "
        "10-space indent; a bare number bump with a one-line note is what this repo's "
        "convention refuses"
    )
    entry = [newest] + continued
    assert any("DIVERGENCE pin" in ln for ln in entry), (
        "the 0.23.1 entry must name its concrete subject — TEST-25 is a DIVERGENCE pin "
        "that reads the SIBLING's current version and A14 pin name every run, so the "
        "sibling's 0.25.0 bump reddened it with nothing in HD changed (#359)"
    )
    assert any("test_654_the_manifest_bump" in ln for ln in entry), (
        "the 0.23.1 entry must name the sibling's NEW A14 pin function — half of what "
        "the mirror note is re-pointed to (#359)"
    )
    assert any("PASSED in a clean `origin/main` worktree" in ln for ln in entry), (
        "the 0.23.1 entry must record the MEASUREMENT that justifies it — HD TEST-25 "
        "FAILED in the sibling's branch worktree and PASSED on origin/main (#359)"
    )
    assert "#313" in text, (
        "the changelog no longer names #313, the issue this package was born from"
    )


# ── TEST-19: the ISSUE-STATES re-capture ────────────────────────────────────────────


def test_508_issue_states_json_records_508_closed_and_593_open():
    r"""TEST-19 [acceptance] [invariant: INV-7] [covers: ITEM-8, ITEM-10] — the ISSUE-STATES re-capture.

    `tests/issue_states.json` (TEST-29's offline substitute) must record the MEASURED
    states of the issues this node cites: `"508": "CLOSED"`, `"593": "OPEN"`,
    `"638": "OPEN"`, `"641": "OPEN"` and `"643": "OPEN"` (measured via `gh issue view
    508|593 --json number,state,title` from the repo root on 2026-09-24 — #508 closed
    by the visium half's merge at `3722f437b`, #593 is this node's predecessor issue —
    and `gh issue view 638 --json number,state,title` on 2026-09-25 — #638 is the
    predecessor node's issue (measured OPEN when its 0.19.0 reference was written;
    CLOSED 2026-09-25 — the snapshot keeps the per-reference record) — and
    `gh issue view 641 --json number,state,title` on 2026-09-25 — #641 is the issue
    the 0.20.0 bump was for (measured OPEN when its 0.20.0 reference was written;
    CLOSED 2026-09-25 — the snapshot keeps the per-reference record) — and
    `gh issue view 643 --json number,state,title` on 2026-09-25 — #643 is the issue
    this node's 0.21.0 bump is for, still OPEN today), and `_why` must
    carry the dated re-capture note naming the command —
    the snapshot's stated rule: "Re-capture with the command in `_how` when a reference is
    added, and say in the commit why the new number's state is what it is." The
    snapshot-completeness rule of `test_no_closed_issue_pointers.py` (TEST-29) then covers
    every new `#NNN` citation, and #508's CLOSED state trips no layer-1/layer-2 rule
    because no refusal or deferral sentence names it (pinned by TEST-21).
    """
    doc = json.loads((PKG / "tests" / "issue_states.json")
                     .read_text(encoding="utf-8"))
    states = doc["issues"]
    assert states.get("508") == "CLOSED", (
        f"#508 must be recorded CLOSED (closed by the visium half's merge): "
        f"{states.get('508')!r}")
    assert states.get("593") == "OPEN", (
        f"#593 must be recorded OPEN (this issue is in flight): {states.get('593')!r}")
    why = doc.get("_why", "")
    assert "Re-captured again on 2026-09-24 for #593" in why, (
        "`_why` must carry the dated re-capture note for this node"
    )
    assert "593 added OPEN" in why and "508 added CLOSED" in why, (
        "`_why` must record BOTH measured states and their dates"
    )
    assert "gh issue view" in why, "`_why` must name the re-capture command"
    # TEST-9 (#638): the 0.19.0 bump cites #638, so the snapshot records it too —
    # measured `gh issue view 638 --json number,state,title` -> "OPEN" on 2026-09-25
    # (this issue is in flight).
    assert states.get("638") == "OPEN", (
        f"#638 must be recorded OPEN (this issue is in flight): {states.get('638')!r}")
    assert "Re-captured again on 2026-09-25 for #638" in why, (
        "`_why` must carry the dated 2026-09-25 re-capture note for #638"
    )
    assert "638 added OPEN" in why, (
        "`_why` must record the #638 measured state and its date"
    )
    # TEST-4 (#641): the 0.20.0 bump cites #641, so the snapshot records it too —
    # measured `gh issue view 641 --json number,state,title` -> "OPEN" on 2026-09-25
    # (this issue is in flight).
    assert states.get("641") == "OPEN", (
        f"#641 must be recorded OPEN (this issue is in flight): {states.get('641')!r}")
    assert "Re-captured again on 2026-09-25 for #641" in why, (
        "`_why` must carry the dated 2026-09-25 re-capture note for #641"
    )
    assert "641 added OPEN" in why, (
        "`_why` must record the #641 measured state and its date"
    )
    # TEST-5 (#643): the 0.21.0 bump cites #643, so the snapshot records it too —
    # measured `gh issue view 643 --json number,state,title` -> "OPEN" on 2026-09-25
    # (this issue is in flight).
    assert states.get("643") == "OPEN", (
        f"#643 must be recorded OPEN (this issue is in flight): {states.get('643')!r}")
    assert "Re-captured again on 2026-09-25 for #643" in why, (
        "`_why` must carry the dated 2026-09-25 re-capture note for #643"
    )
    assert "643 added OPEN" in why, (
        "`_why` must record the #643 measured state and its date"
    )


# ── TEST-25 (#638): the sibling mirror note stays re-pointed ──────────────────────────

# TEST-5 (#638): the DIVERGENCE pin for #638 site 5 — the stale mirror-note prose
# (the sibling's current version + TEST-10 name are derived from the sibling's files).
# TEST-6 (#643): re-verified by this node's phase-8 discrimination rung (A11 arm two —
# this file is modified by this node's ITEM-4/ITEM-5 lines; the pin's own lines are
# deliberately untouched).
def test_TEST_25_the_sibling_mirror_note_is_re_pointed():
    r"""TEST-25 (#638) — the mirror note in TEST-18's docstring stays re-pointed.

    #638 site 5 is prose-only: the mirror note named the sibling's TEST-10 at the
    stale 0.21.1-era version, while the sibling's TEST-10 was renamed and the
    sibling manifest moved to 0.23.0. This is a DIVERGENCE pin, not a self-read:
    the sibling's CURRENT version is read from `spatial-import-visium/manifest.yaml`'s
    top-level `version:` line and the sibling's CURRENT TEST-10 function name is
    discovered by regex over `spatial-import-visium/tests/test_508_symlinked_members.py`
    — both derived from the SIBLING's files every run, so a sibling version bump OR a
    sibling TEST-10 rename reddens this pin, which is the point. The needles are
    assembled from parts (the version and backticked function name are variables,
    never literals here) and the assertions read ONLY TEST-18's docstring (extracted
    via `ast` from the CURRENT tree), so the pin's own assertion strings can neither
    satisfy nor defeat the checks: the stale-era parenthetical's TOKEN may appear in
    this file only as an assembled part, and the full stale phrase never does
    (compare TEST-136's self-read discipline, whose check DOES read its own module
    docstring).
    """
    # The sibling's real state — paths derived from THIS file (verified: the two
    # package dirs are siblings under `src-app/packages`).
    hd_pkg = Path(__file__).resolve().parents[1]
    visium_pkg = hd_pkg.parent / "spatial-import-visium"
    vmatch = re.search(
        r"^version:\s*(\d+\.\d+\.\d+)\s*$",
        (visium_pkg / "manifest.yaml").read_text(encoding="utf-8"),
        re.MULTILINE)
    assert vmatch is not None, "the sibling's top-level `version:` line vanished"
    sib_ver = vmatch.group(1)
    fn_match = re.search(
        r"def (test_\w+_the_manifest_bump_and_its_changelog_entry_are_at_\d+_\d+_\d+"
        r"_and_name_this_issue)\(",
        (visium_pkg / "tests" / "test_508_symlinked_members.py").read_text(
            encoding="utf-8"))
    assert fn_match is not None, "the sibling's TEST-10 pin function has moved or gone"
    sib_fn = fn_match.group(1)

    # THIS file's own pin target: TEST-18's docstring, found the same dynamic way.
    text = (hd_pkg / "tests" / "test_508_bundle_containment.py").read_text(encoding="utf-8")
    host_match = re.search(
        r"def (test_\w+_the_manifest_bump_and_its_changelog_entry_are_at_\d+_\d+_\d+"
        r"_and_name_this_issue)\(", text)
    assert host_match is not None, "TEST-18's pin function has moved or gone"
    host_fn = next((n for n in ast.walk(ast.parse(text))
                    if isinstance(n, ast.FunctionDef)
                    and n.name == host_match.group(1)), None)
    assert host_fn is not None, f"{host_match.group(1)} is missing from the AST"
    doc = ast.get_docstring(host_fn) or ""
    flat = re.sub(r"\s+", " ", doc)    # the backticked function name is line-wrapped in
    compact = re.sub(r"\s+", "", doc)  # the note, so both normalisations are checked

    # Presence legs: needles assembled from parts, so the full strings exist only in
    # the target docstring when correct.
    presence = "Mirrors the sibling's TEST-10 (" + sib_ver
    fn_presence = "`" + sib_fn + "`"
    assert presence in flat, (
        "the mirror note must name the sibling's CURRENT version "
        f"{sib_ver} (#638 site 5)"
    )
    assert fn_presence in compact, (
        "the mirror note must name the sibling's CURRENT TEST-10 pin function "
        f"{sib_fn} (#638 site 5)"
    )
    # The stale needle is assembled from parts (this file's own `_fragment` idiom) so the
    # pin's assertion string cannot read its own text and satisfy—or defeat—the check.
    stale = "sibling's TEST-10 " + "(0.21.1)"
    assert stale not in flat, (
        "the mirror note must not carry the stale 0.21.1-era parenthetical (#638 site 5)"
    )


# ── TEST-20: NEW-PINS ACCOUNTABILITY (HD had NOTHING to flip) ───────────────────────


def test_508_new_pins_accountability_the_eleven_refusal_rows_are_the_whole_set():
    r"""TEST-20 [covers: ITEM-4, ITEM-9] — NEW-PINS ACCOUNTABILITY, re-voiced honestly.

    The #508 owner-decision flip sentence ("The 18 today-pins flip …") names the VISIUM
    package's own pins; HD measured NO today-pins to flip (DEC-11: the only symlinks in
    `tests/` are the four staging-DIRECTORY helpers — no test asserts an outside-symlinked
    member imports at rc 0). So the accountability shape for #593 is: the NEW file
    contains EXACTLY eleven refusal rows (namespace `test_508_option1_refuses_` — the nine
    F-1..F-9 discrimination rows, the FIX_ROUND-1 TEST-22 `os.sep` sibling-dir row and the
    FIX_ROUND-2 TEST-24 flat-layout row; the FILE-ROOT stay-green row is deliberately
    OUTSIDE this namespace because it asserts rc 0), each docstring citing `#508` +
    "OWNER DECISION" + option 1 / "refused", and NONE still claims today's behavior
    (`imports_at_rc0` in the name would be the flip never happening); the four
    pre-existing staging-symlink helper lines still exist — no pin was deleted because
    nothing existed to flip.
    """
    src = (PKG / "tests" / "test_508_bundle_containment.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    docs = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            docs[node.name] = ast.get_docstring(node) or ""
    refusal_names = [n for n in docs if n.startswith("test_508_option1_refuses_")]
    assert len(refusal_names) == 11, (
        f"exactly eleven option-1 refusal rows are expected, found {len(refusal_names)}: "
        f"{refusal_names}"
    )
    for name in refusal_names:
        low = re.sub(r"\s+", " ", docs[name].lower())
        assert "#508" in low, (
            f"{name}'s docstring lost the #508 marker — the row is no longer attributed "
            "to the owner decision"
        )
        assert "owner decision" in low, (
            f"{name}'s docstring must cite the OWNER DECISION (issue comment)"
        )
        assert "option 1" in low or "refus" in low, (
            f"{name}'s docstring must carry the option-1 / refused marker"
        )
        assert "imports_at_rc0" not in name, (
            f"{name} still claims today's rc-0 behavior in its name"
        )
    # The four pre-existing staging helper lines are untouched (nothing was flipped/deleted).
    for name in SANCTIONED_STAGING_SYMLINK_FILES:
        text = (PKG / "tests" / name).read_text(encoding="utf-8")
        assert ".symlink_to(Path(bundle).resolve(), target_is_directory=True)" in text, (
            f"{name}'s staging-directory symlink helper moved or vanished — the four "
            "legitimate whole-bundle mounts must still exist"
        )


# ── TEST-21: the UNIFORM-RULE prose pin (anti-overclaim) ────────────────────────────


def test_508_the_uniform_rule_prose_is_stated_and_nothing_overclaims():
    r"""TEST-21 [covers: ITEM-6] — the UNIFORM-RULE PROSE pin (anti-overclaim).

    The containment comment block in `compute/import_visium_hd.py` must carry `#508` +
    "OWNER DECISION" + "option 1" and the uniform-rule sentence ("every bundle member must
    realpath to a path under the bundle root" — the owner's one-line rule, verbatim). And
    the anti-overclaim goes both ways:

    * the new refusal message (AST of `locate_bins`) contains NO `#\d+` issue number —
      a refusal must never name an issue (TEST-29 layer 1; `#508` is CLOSED);
    * the new prose never states "no realpath check" (false after this branch — that is
      the visium node's record-only sentence about HD, now retired);
    * the new prose never pairs a DEFERRAL MARKER with `#508` (TEST-29 layer 2 — #508 is
      CLOSED, so "tracked as #508"-style sentences would be a dead end);
    * the matrix walk's own messages STAY matrix-file-scoped ("files outside this bundle"
      in `_refuse_outside_matrix_objects` is true of the matrix FILE); the new check's
      prose scopes its claim to the bundle root instead.
    """
    src = (PKG / "compute" / "import_visium_hd.py").read_text(encoding="utf-8")
    tree = ast.parse(src)

    # The containment comment block cites the owner decision + the uniform rule verbatim.
    comment_start = src.find("# ── THE ONE CONTAINMENT CHECK")
    assert comment_start != -1, "the containment comment block has moved or gone"
    region_end = src.find("located_paths = (")
    assert region_end > comment_start, "the located_paths list must follow the comment block"
    check_region = src[comment_start:region_end]
    assert "#508" in check_region and "OWNER DECISION" in check_region, (
        "the containment comment must cite the #508 OWNER DECISION"
    )
    assert "option 1" in check_region, "the containment comment must cite the owner's option 1"
    assert '"every bundle member must realpath to a path under the bundle root"' in check_region, (
        "the containment comment must state the owner's uniform-rule sentence verbatim"
    )
    assert "bundle root" in check_region, (
        "the containment comment must scope the rule to the bundle root"
    )

    # The refusal message carries no issue number.
    fn = next((n for n in tree.body
               if isinstance(n, ast.FunctionDef) and n.name == "locate_bins"), None)
    assert fn is not None, "locate_bins no longer exists"
    refusal_text = None
    for node in ast.walk(fn):
        if isinstance(node, ast.Raise) and isinstance(node.exc, ast.Call):
            arg = node.exc.args[0] if node.exc.args else None
            if isinstance(arg, ast.JoinedStr) and "resolves to" in (
                    "".join(v.value for v in arg.values if isinstance(v, ast.Constant))):
                refusal_text = ast.get_source_segment(src, node)
    assert refusal_text is not None, (
        "the containment refusal message was not found in locate_bins"
    )
    assert not re.search(r"#\d+", refusal_text), (
        f"a refusal message must never name an issue number: {refusal_text[:200]}"
    )

    # The new prose never states "no realpath check" and never defers to #508.
    assert "no realpath check" not in src, (
        "the compute now HAS a realpath containment check — saying 'no realpath check' "
        "anywhere is the record-only sentence retired by this node"
    )
    assert "no realpath" not in src.lower(), (
        "the compute now HAS the realpath containment check — any 'no realpath' prose is "
        "a stale claim"
    )
    for marker in ("tracked as", "filed as", "filed under", "deferred to", "see issue",
                   "that is issue", "is issue", "will be tracked"):
        assert marker not in check_region.lower(), (
            f"the containment comment pairs the deferral marker {marker!r} with #508, "
            "which is CLOSED — that is the #313 dead-end rule (TEST-29 layer 2)"
        )


# ── TEST-22: the `+ os.sep` sibling-directory anchor, behaviorally (FIX_ROUND-1 F-6) ─


def test_508_option1_refuses_a_sibling_directory_named_like_the_root(tmp_path):
    r"""TEST-22 [acceptance] [invariant: INV-1, INV-5] [covers: ITEM-2, ITEM-7] — the `os.sep` ANCHOR row.

    #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to a
    path under the bundle root. The `+ os.sep` suffix exists so a SIBLING directory whose
    NAME prefixes the root cannot prefix-match: the fixture bundle realpaths to
    `<tmp>/.../visium-hd-outs`, and the outside target here lives in
    `<tmp>/.../visium-hd-outs-evil/tissue_positions.parquet` — `realpath(member)` DOES
    start with `realpath(root)` but NOT with `realpath(root) + os.sep` (the root's own
    path). Without the `os.sep` the row would import at rc 0 with the outside bytes; with
    it, rc 2 + zero output paths + the named refusal. TEST-15/16 pin the FORM as source
    text; this row pins the BEHAVIOR (a refactor that keeps the literal and breaks the
    comparison reddens here).
    """
    bundle = HF.staged_tree(tmp_path / "run")
    evil_dir = tmp_path / "run" / (bundle.name + "-evil")
    evil_dir.mkdir(parents=True, exist_ok=True)
    (evil_dir / "tissue_positions.parquet").write_bytes(
        (_spatial(bundle, 8) / "tissue_positions.parquet").read_bytes())
    _as_outside_symlink(evil_dir / "tissue_positions.parquet",
                        _spatial(bundle, 8) / "tissue_positions.parquet")
    assert os.path.realpath(evil_dir).startswith(os.path.realpath(bundle)) and not \
        os.path.realpath(evil_dir).startswith(os.path.realpath(bundle) + os.sep), (
        "the evil sibling must be a true prefix-collision (starts with the resolved root "
        "but is not under it), or this row proves nothing")
    inputs = _staged(tmp_path, bundle)
    outputs = tmp_path / "out"

    result = HF.run_entry_bytes(inputs, outputs)

    _assert_containment_refusal(result, outputs, "tissue_positions.parquet",
                                os.path.realpath(evil_dir / "tissue_positions.parquet"))


# ── TEST-23: the single-file-slot arm — root.is_file() normalization (FIX_ROUND-1 F-13) ─


def test_508_option1_a_file_root_slot_still_imports_at_rc0_with_containment_working(tmp_path):
    r"""TEST-23 [acceptance] [invariant: INV-1, INV-5] [covers: ITEM-2, ITEM-7] — the FILE-ROOT slot arm.

    #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath under
    the bundle root. The single-file-slot arm is the one root SHAPE no other row exercises:
    `main()` may hand `locate_bins` a FILE ("a single-file dataset binds at the bare
    slot"), and the first thing `locate_bins` does is `if root.is_file(): root =
    root.parent` — the root the containment check compares against is the PARENT of the
    staged slot file. This row stakes the whole fixture tree directly under `/inputs` with
    a FILE at the bare slot: `locate_bins` normalizes the root to `/inputs`, every member
    realpaths under the resolved `/inputs`, so the import must stay rc 0 with a
    `manifest.json` and no refusal line. The is_file() normalization and the containment
    check must BOTH survive in that order (a containment check placed before the
    normalization — or a dropped is_file() branch — would refuse every member of this
    arm).
    """
    inputs = tmp_path / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    shutil.copytree(HF.FIXTURE, inputs / "tree")
    (inputs / "bundle-slot").write_text("")  # the FILE the bare slot actually binds
    (inputs / "inputs.json").write_text(json.dumps({
        "inputs": [{"slot": "bundle", "kind": "dataset",
                    "sandbox_path": "/inputs/bundle-slot"}]}), encoding="utf-8")
    outputs = tmp_path / "out"

    result = HF.run_entry_bytes(inputs, outputs)

    assert result.returncode == 0, result.stderr[-3000:]
    assert (outputs / "manifest.json").is_file()
    assert b"Refusing rather than" not in result.stderr, result.stderr[-2000:]


# ── TEST-24: the FLATTENED production staging layout row (FIX_ROUND-2 re-audit N-B-1) ─


def test_508_option1_refuses_a_flat_arm_absolute_outside_symlink_at_rc2(tmp_path):
    r"""TEST-24 [acceptance] [invariant: INV-1, INV-4] [covers: ITEM-2, ITEM-3, ITEM-4] — the FLATTENED-layout row.

    #508 OWNER DECISION (issue comment): option 1 — every bundle member must realpath to a
    path under the bundle root. The FIX_ROUND-2 tests-quality re-audit (N-B-1): every
    refusal row above is built on the PATH-PRESERVING `staged_tree` layout, while the
    FLATTENED folder-upload layout (`HF.staged_flat` — `{i}_{basename}`, what the
    platform's `build_dataset_inputs` actually stages a multi-file dataset as; the
    production staging layout) had never been driven by a REFUSAL row — only the
    stay-green TEST-12 exercised it. `_named`'s scoping is LAYOUT-DEPENDENT, so a
    refactor that wrapped the check in `if layout == "path-preserving"` (or rebuilt
    `located_paths` from leg-(a)-only structures) would ship an UNENFORCED containment on
    the arm production actually uses while TEST-14/15/16 (which see the site and its
    text), TEST-12 (rc 0) and the visium cross-pin all stay green. All 23 prior TESTs
    would stay green too — this row is the only REFUSAL row on the flat arm.

    `5_tissue_positions.parquet` (ordinal 5 = `square_008um/spatial/tissue_positions.parquet`,
    the DECLARED member order `import_visium_hd.py` stages at: matrix, positions,
    scalefactors, hires within each bin) replaced by an ABSOLUTE symlink to a byte-copy of
    the same file OUTSIDE the flat staging dir — the bytes are the fixture's own, so the
    bin verification READ (the 8 um `scalefactors_json.json` is untouched) passes and the
    only reachable refusal is containment: rc 2, ZERO output paths, naming
    `tissue_positions.parquet` (via the located `5_`-prefixed spelling) + the resolved
    candidate path.
    """
    inputs, ordinals = HF.staged_flat(tmp_path)
    flat_member = inputs / "5_tissue_positions.parquet"
    assert ordinals[flat_member] == 5, (
        f"ordinal 5 must be the 8 um `tissue_positions.parquet` per DECLARED_MEMBERS, got "
        f"{ordinals[flat_member]} for {flat_member.name} — the flat row would prove nothing "
        "if the member moved ordinal"
    )
    outside = tmp_path / "outside"
    outside.mkdir(parents=True, exist_ok=True)
    (outside / "tissue_positions.parquet").write_bytes(flat_member.read_bytes())
    flat_member.unlink()
    flat_member.symlink_to(outside / "tissue_positions.parquet")
    outputs = tmp_path / "out"

    result = HF.run_entry_bytes(inputs, outputs)

    _assert_containment_refusal(result, outputs, "tissue_positions.parquet",
                                os.path.realpath(outside / "tissue_positions.parquet"),
                                located_name="5_tissue_positions.parquet")
