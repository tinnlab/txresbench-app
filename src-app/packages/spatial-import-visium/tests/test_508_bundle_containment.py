#!/usr/bin/env python3
# ruff: noqa
"""#508 option 1 (bundled containment) — the NEW tests (TEST-19..22).

TEST-19 is structural (AST of `compute/import_visium.py`): exactly ONE containment
check at the end of `locate_members`. TEST-20/TEST-21 are integration rows through the
shipped entrypoint for the two members whose own VALUES are not paths — the
non-placeable spec dicts and the ambiguous basename strings — and prove the check
covers every `found`-derived candidate while never realpath'ing those values (the
measured over-refusal causes). TEST-22 is flip accountability: the nine flipped pins
still exist in `test_508_symlinked_members.py` by TEST-N id, each citing the OWNER
DECISION — flipped deliberately, never deleted.

Same harness as `test_508_symlinked_members.py`: `visium_fixtures` via `VF`
(load_compute / stage_bundle / run_entry_bytes), each row a real subprocess run of the
shipped entrypoint over a COPY of the committed fixture.
"""
import json
import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import visium_fixtures as VF  # noqa: E402


def _count_paths(outputs):
    return sum(1 for p in Path(outputs).rglob("*") if p.is_file())


def _assert_option1_refusal(result, outputs, member_basename, resolved_path):
    """A3's full refusal surface (shared by TEST-20/21/23): rc 2, ZERO paths, named member.

    NOTE (F-3, DEC-17): this helper is deliberately DUPLICATED in
    `test_508_symlinked_members.py` — the two test files remain SELF-CONTAINED (each is
    runnable/auditable on its own; a shared helper module would couple the flip pins to
    the new containment rows). Keep both copies in sync when the refusal surface changes.
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
        f"the refusal must quote the resolved path {resolved_path}:\n{text[-3000:]}"
    )
    assert b"Refusing rather than" in stderr, (
        f"the refusal must end with the module's 'Refusing rather than' convention:\n"
        f"{text[-3000:]}"
    )


# ── TEST-19: the structural pin — ONE containment check, at the END of locate_members ──


def test_508_the_one_containment_check_is_structural_and_lives_at_the_end_of_locate_members():
    r"""TEST-19 [acceptance] [invariant: INV-3] — the single choke point, STRUCTURALLY.

    The owner's option-1 spec: "one containment check at the end of `locate_members`
    (the single choke point: every consumer reads through the `members` dict)". This pin
    reads the AST, so a check moved to a consumer (or duplicated, or dropped) reddens:

    * exactly ONE `os.path.realpath(` line in the whole `locate_members` body — the
      containment site (the matrix walk's two sites live in
      `refuse_outside_matrix_objects` and are not this function's);
    * that ONE site realpaths the NORMALIZED root (`root = Path(root)` + the
      `is_file()` branch come first) AND the member, and compares with
      `root_real + os.sep` via `startswith` — the measured staging-symlink-safe form:
      the raw `root` is the unresolved `/inputs/<name>` symlink on every entrypoint run
      (STEP0-MEASUREMENT §1/§3(ii)), so realpath'ing only the member would refuse every
      staged bundle;
    * the site sits AFTER every member shape is built (after the
      `members["cytassist_image"] = bool(...)` assignment) and BEFORE `return members`;
    * it never touches `cytassist_image` (the bool is exempt — presence only, never
      opened; realpath(False) is the measured TypeError).

    INV-3's scope list is pinned behaviorally by TEST-20 (non-placeable / found-derived)
    and TEST-21 (ambiguous / found-derived) and by the nine flipped pins
    (TEST-2..7/15/16/17 in `test_508_symlinked_members.py`).
    """
    import ast

    src = (VF.PKG / "compute" / "import_visium.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    fn = next((n for n in tree.body
               if isinstance(n, ast.FunctionDef) and n.name == "locate_members"), None)
    assert fn is not None, "locate_members no longer exists — the containment site has no home"
    body_src = ast.get_source_segment(src, fn)
    lines = body_src.splitlines()

    realpath_lines = [i for i, ln in enumerate(lines) if "os.path.realpath(" in ln]
    assert len(realpath_lines) == 1, (
        f"locate_members must have exactly ONE containment realpath site, found "
        f"{realpath_lines}: the check must be one site at the end, never duplicated or "
        "split per member"
    )
    site = lines[realpath_lines[0]]
    assert "os.path.realpath(root" in site, (
        f"the containment site must realpath the NORMALIZED root (the is_file() branch "
        f"came first): {site}"
    )
    assert "os.path.realpath(p)" in site, (
        f"the containment site must realpath the member path too: {site}"
    )
    assert "os.sep" in site, (
        f"the containment site must compare against root_real + os.sep (an empty-sep "
        f"prefix would admit a sibling directory named like the root): {site}"
    )
    assert ".startswith(" in site, f"the containment test must be a prefix comparison: {site}"
    assert "cytassist_image" not in site, (
        "the containment site must never touch the exempt `cytassist_image` bool"
    )

    # Position: after every member shape (the cytassist_image assignment is the LAST
    # shape) and before `return members`. The lookups use a None-default generator so a
    # renamed/gone shape fails with the INTENDED message below, not a bare StopIteration.
    cyt_line = next((i for i, ln in enumerate(lines)
                     if 'members["cytassist_image"] = bool(' in ln), None)
    assert cyt_line is not None, (
        "the cytassist_image assignment (last member shape) is gone"
    )
    assert "members[\"cytassist_image\"] = bool(" in "\n".join(lines), (
        "the cytassist_image assignment (last member shape) is gone"
    )
    assert cyt_line < realpath_lines[0], (
        "the containment check must sit AFTER every member shape is built"
    )
    return_line = next((i for i, ln in enumerate(lines)
                        if ln.strip() == "return members"), None)
    assert return_line is not None, (
        "the `return members` line is gone — the locator must still return its members"
    )
    assert realpath_lines[0] < return_line, (
        "the containment check must sit BEFORE `return members`"
    )
    # Root normalization happens in front of the check (the staged-root crux).
    text = "\n".join(lines)
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
        raise AssertionError("the containment statement was not found in locate_members' body")


# ── TEST-20: the NON-PLACEABLE leg (spec dicts, checked through `found`) ──────────────


def test_508_option1_the_non_placeable_leg_inside_imports_and_an_outside_candidate_refuses(tmp_path):
    r"""TEST-20 [acceptance] [invariant: INV-3] — the non-placeable leg, both arms.

    `cytassist_image.tiff` is a NON_PLACEABLE_VENDOR_IMAGES member: `members` holds a
    SPEC DICT (basename + reason, NO path) and the `cytassist_image` bool. The naive
    predicate realpath'd the dict (TypeError — the measured over-refusal) and never
    looked at the located candidate at all. Under option 1 the check derives the
    candidate paths from the locator's `found` dict and contains every one of them.

    INSIDE arm: a real `cytassist_image.tiff` inside the bundle imports at rc 0 with
    the report note (presence reported, never refused — the spec dict and the bool were
    never realpath'd). OUTSIDE arm: the same file as an ABSOLUTE symlink to
    `<tmp>/outside/cytassist_image.tiff` refuses at rc 2 with ZERO paths and names
    `cytassist_image.tiff` and the resolved path — the refusal comes from the
    `found`-derived candidate, not from the member dict value.
    """
    # INSIDE: a real non-placeable file, presence-only.
    inside_run = tmp_path / "inside-run"
    bundle = VF.stage_bundle(inside_run, name="outs")
    (bundle / "cytassist_image.tiff").write_bytes(
        b"\x49\x49\x2a\x00 presence-only, never opened")
    outputs = inside_run / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, outputs)
    assert result.returncode == 0, result.stderr[-3000:]
    assert (outputs / "manifest.json").is_file()
    assert b"Refusing rather than" not in result.stderr, result.stderr[-2000:]
    report = json.loads((outputs / "visium-import-report.json")
                        .read_text(encoding="utf-8"))
    named = " ".join(report.get("images_not_emitted", []))
    assert "cytassist_image.tiff" in named, (
        f"the inside non-placeable member must be REPORTED (presence, not refusal): "
        f"{report.get('images_not_emitted')!r}"
    )

    # OUTSIDE: the same basename as an ABSOLUTE symlink to outside the bundle.
    outside_run = tmp_path / "outside-run"
    outside = outside_run / "outside"
    outside.mkdir(parents=True)
    (outside / "cytassist_image.tiff").write_bytes(b"x")
    bundle2 = VF.stage_bundle(outside_run, name="outs")
    (bundle2 / "cytassist_image.tiff").symlink_to(outside / "cytassist_image.tiff")
    outputs2 = outside_run / "out" / "outputs"
    result2 = VF.run_entry_bytes(bundle2, outputs2)
    _assert_option1_refusal(result2, outputs2, "cytassist_image.tiff",
                            os.path.realpath(outside / "cytassist_image.tiff"))


# ── TEST-21: the AMBIGUOUS leg (basename strings, checked through `found`) ────────────


def test_508_option1_the_ambiguous_leg_both_inside_imports_and_one_outside_candidate_refuses(tmp_path):
    r"""TEST-21 [acceptance] [invariant: INV-3] — the ambiguous leg, both arms.

    `tissue_hires_image.png` duplicated (root AND `spatial/`) makes `members["images"]`
    empty and `members["ambiguous_images"]` a list of the BASENAME STRING. The naive
    predicate realpath'd the string — `realpath('tissue_hires_image.png')` resolves
    relative to the process CWD (MEASURED: `/tmp/...` with CWD=/tmp) and refused a
    legitimate bundle. Under option 1 every `found['tissue_hires_image.png']` candidate
    is contained; the string is never realpath'd.

    INSIDE arm: two inside candidates import at rc 0 with `images_not_emitted`
    reporting the ambiguity. OUTSIDE arm: one candidate is an ABSOLUTE outside symlink —
    rc 2, ZERO paths, the refusal names `tissue_hires_image.png` and the resolved
    candidate path (the outside candidate is the member, not the string).
    """
    # INSIDE: root-level duplicate of the fixture's spatial image.
    inside_run = tmp_path / "inside-run"
    bundle = VF.stage_bundle(inside_run, name="outs")
    (bundle / "tissue_hires_image.png").write_bytes(
        (bundle / "spatial" / "tissue_hires_image.png").read_bytes())
    outputs = inside_run / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, outputs)
    assert result.returncode == 0, result.stderr[-3000:]
    assert (outputs / "manifest.json").is_file()
    assert b"Refusing rather than" not in result.stderr, result.stderr[-2000:]
    report = json.loads((outputs / "visium-import-report.json")
                        .read_text(encoding="utf-8"))
    named = " ".join(report.get("images_not_emitted", []))
    assert "tissue_hires_image.png" in named, (
        f"the ambiguity must be REPORTED (never silently dropped): "
        f"{report.get('images_not_emitted')!r}"
    )

    # OUTSIDE: the root-level candidate is an ABSOLUTE symlink to outside the bundle.
    outside_run = tmp_path / "outside-run"
    outside = outside_run / "outside"
    outside.mkdir(parents=True)
    (outside / "tissue_hires_image.png").write_bytes(b"not a real png, presence for the link")
    bundle2 = VF.stage_bundle(outside_run, name="outs")
    (bundle2 / "tissue_hires_image.png").symlink_to(outside / "tissue_hires_image.png")
    outputs2 = outside_run / "out" / "outputs"
    result2 = VF.run_entry_bytes(bundle2, outputs2)
    _assert_option1_refusal(result2, outputs2, "tissue_hires_image.png",
                            os.path.realpath(outside / "tissue_hires_image.png"))


# ── TEST-22: flip accountability — the nine pins were flipped, never deleted ──────────


def test_508_option1_flip_accountability_the_nine_pins_were_flipped_never_deleted():
    r"""TEST-22 [acceptance] [invariant: INV-5] — flip accountability.

    The owner's words: "The 18 today-pins flip from 'imports at rc 0 with the outside
    bytes landing' to 'refused by name'. Flip them deliberately, citing this comment; do
    not delete them." This pin scans `test_508_symlinked_members.py` by TEST-N ID (NOT
    by function name — the A-mend renames the flipped functions so their names state
    the refusal): every one of TEST-2..7, TEST-15..17 still exists, and each docstring
    cites the OWNER DECISION (#508 + "OWNER DECISION" + "option 1"/"refused"). The nine
    renamed functions (prefix `test_508_option1_refuses_`) are exactly nine — none lost,
    none left claiming today's behavior in its name.
    """
    import ast

    src = (VF.PKG / "tests" / "test_508_symlinked_members.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    docs_by_id = {}
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            doc = ast.get_docstring(node) or ""
            for m in re.finditer(r"TEST-(\d+)\b", doc):
                docs_by_id.setdefault(int(m.group(1)), []).append(doc)
    required = (2, 3, 4, 5, 6, 7, 15, 16, 17)
    for tid in required:
        docs = docs_by_id.get(tid)
        assert docs, (
            f"TEST-{tid} no longer exists in test_508_symlinked_members.py — a flipped "
            "pin must never be deleted"
        )
        for doc in docs:
            low = re.sub(r"\s+", " ", doc.lower())
            assert "#508" in low, (
                f"TEST-{tid}'s docstring lost the #508 marker — the pin is no longer "
                "attributed to the issue"
            )
            assert "owner decision" in low, (
                f"TEST-{tid}'s docstring must cite the OWNER DECISION (issue comment) — "
                "the deliberate flip's authority"
            )
            assert ("option 1" in low or "refus" in low), (
                f"TEST-{tid}'s docstring must carry the flip marker (option 1 / refused "
                "by name) — a pin left asserting today's behavior would be the flip never "
                "happened"
            )
    names = [n.name for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef))]
    flipped = [n for n in names if n.startswith("test_508_option1_refuses_")]
    assert len(flipped) == 9, (
        f"exactly nine renamed refusal pins are expected, found {len(flipped)}: "
        f"{flipped}"
    )
    for name in flipped:
        assert "imports_at_rc0" not in name, (
            f"{name} still claims today's rc-0 behavior in its name — rename so the name "
            "states the refusal"
        )


# ── TEST-23: ambiguous DIAGNOSTIC / METRICS candidates (F-1, fix round 1) ─────────────


def test_508_option1_the_ambiguous_diagnostic_or_metrics_candidate_is_contained_too(tmp_path):
    r"""TEST-23 [acceptance] [invariant: INV-1, INV-3] — the ambiguous diagnostics/metrics legs (F-1).

    `members["diagnostics"]` keeps `found[name][0]` only when exactly ONE candidate exists
    and `members["metrics"]` is None unless exactly one — so with TWO candidates NEITHER
    candidate entered `located_paths`, and an outside-symlinked second candidate imported at
    rc 0. No bytes land (the ambiguous member is never opened), but the owner's rule is
    "every bundle member must realpath to a path under the bundle root" and the ambiguous
    IMAGE candidates were already covered via `ambiguous_images` — the asymmetry was
    internal to the code's own rationale (F-1). The CHECK now walks every `found` candidate
    for `DIAGNOSTIC_BASENAMES` and for `metrics_summary.csv` while
    `members["diagnostics"]` / `members["metrics"]` keep their single-candidate / None
    shapes (the member stores, the check covers).

    DIAGNOSTIC arm: `aligned_fiducials.jpg` duplicated (root AND `spatial/`), the root copy
    an ABSOLUTE symlink to `<tmp>/outside/aligned_fiducials.jpg` → rc 2, ZERO paths, the
    refusal names `aligned_fiducials.jpg` and the resolved candidate path. Inverse: the same
    duplication with BOTH candidates inside imports at rc 0 — ambiguity is not a refusal
    (nothing new reddens), only the outside candidate is.

    METRICS arm: `metrics_summary.csv` duplicated (root AND `spatial/`), the `spatial/`
    copy an ABSOLUTE symlink to `<tmp>/outside/metrics_summary.csv` → rc 2, ZERO paths, the
    refusal names `metrics_summary.csv` and the resolved candidate path. Inverse (both
    inside) still imports at rc 0 — the optional member is dropped as before.
    """
    # ── DIAGNOSTICS: one candidate OUTSIDE the bundle root ──────────────────────────
    diag_run = tmp_path / "diag-run"
    outside = diag_run / "outside"
    outside.mkdir(parents=True)
    (outside / "aligned_fiducials.jpg").write_bytes(b"not a jpeg, presence for the link")
    bundle = VF.stage_bundle(diag_run, name="outs")
    # A SECOND candidate for the same diagnostic basename: the fixture ships
    # `spatial/aligned_fiducials.jpg`, so this makes the member ambiguous and — before the
    # F-1 fix — keeps ITS single-candidate path out of `members["diagnostics"]` (len != 1).
    (bundle / "aligned_fiducials.jpg").symlink_to(outside / "aligned_fiducials.jpg")
    outputs = diag_run / "out" / "outputs"
    result = VF.run_entry_bytes(bundle, outputs)
    _assert_option1_refusal(result, outputs, "aligned_fiducials.jpg",
                            os.path.realpath(outside / "aligned_fiducials.jpg"))

    # INVERSE: the same duplication with both candidates INSIDE must NOT refuse.
    inside_run = tmp_path / "diag-inside-run"
    bundle2 = VF.stage_bundle(inside_run, name="outs")
    (bundle2 / "aligned_fiducials.jpg").write_bytes(
        (bundle2 / "spatial" / "aligned_fiducials.jpg").read_bytes())
    outputs2 = inside_run / "out" / "outputs"
    result2 = VF.run_entry_bytes(bundle2, outputs2)
    assert result2.returncode == 0, result2.stderr[-3000:]
    assert b"Refusing rather than" not in result2.stderr, result2.stderr[-2000:]

    # ── METRICS: one candidate OUTSIDE the bundle root ──────────────────────────────
    met_run = tmp_path / "metrics-run"
    outside_m = met_run / "outside"
    outside_m.mkdir(parents=True)
    (outside_m / "metrics_summary.csv").write_text(
        "Sample ID\nnot-the-fixture-sample\n", encoding="utf-8")
    bundle3 = VF.stage_bundle(met_run, name="outs")
    # The fixture ships `metrics_summary.csv` at the ROOT, so a `spatial/` copy makes the
    # member ambiguous and — before the F-1 fix — `members["metrics"]` becomes None with
    # NEITHER candidate in `located_paths`.
    (bundle3 / "spatial" / "metrics_summary.csv").symlink_to(
        outside_m / "metrics_summary.csv")
    outputs3 = met_run / "out" / "outputs"
    result3 = VF.run_entry_bytes(bundle3, outputs3)
    _assert_option1_refusal(result3, outputs3, "metrics_summary.csv",
                            os.path.realpath(outside_m / "metrics_summary.csv"))

    # INVERSE: both metrics candidates inside must NOT refuse (member dropped as before).
    met_inside_run = tmp_path / "metrics-inside-run"
    bundle4 = VF.stage_bundle(met_inside_run, name="outs")
    (bundle4 / "spatial" / "metrics_summary.csv").write_bytes(
        (bundle4 / "metrics_summary.csv").read_bytes())
    outputs4 = met_inside_run / "out" / "outputs"
    result4 = VF.run_entry_bytes(bundle4, outputs4)
    assert result4.returncode == 0, result4.stderr[-3000:]
    assert b"Refusing rather than" not in result4.stderr, result4.stderr[-2000:]
