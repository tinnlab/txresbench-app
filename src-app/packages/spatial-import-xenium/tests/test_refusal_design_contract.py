"""The design doc and the shipped module must keep describing each other (#343).

Two contracts, each reddening on a specific drift:

* TEST A — the design's §3 INV-5 note (`WIDENED BY #343`) and the module's actual refusal
  routing must widen TOGETHER: the design note names the structural guard and the module must
  still pass it.
* TEST C — the manifest version bump and its changelog entry cannot drift apart (a PACKAGING
  check, declared as such in its docstring).

Every read of a repo file names `encoding="utf-8"` explicitly: the design doc is full of
section signs and em dashes, and a locale-default read RAISES under `LC_ALL=C` — which would
turn a real regression green.

## What was given up, and why

The pre-fix base measurement — 28 refusal sites, 35 unprovable interpolations on `1e94c77d2` —
is quoted in `manifest.yaml`'s 0.11.0 entry and in `docs/design/vendor-text-encodability-refusal.md`
§3's INV-5 note, and is NOT asserted executably here. Asserting it means reading that commit out
of git, which `_lib/test_zero_core_guard.py` sweeps for, which needs a `_SWEEP_EXCEPTIONS` entry,
which changes `_lib` and therefore forces a `_lib` version bump on a shared package owned by four
live sibling branches. A number nothing asserts is a number that rots, so this is a KNOWN GAP
filed as follow-up work, not an oversight.
"""
import sys
from pathlib import Path

import pytest

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(__file__).resolve().parents[4]
DESIGN_DOC = REPO_ROOT / "docs" / "design" / "vendor-text-encodability-refusal.md"
MANIFEST = PACKAGE_ROOT / "manifest.yaml"
COMPUTE = PACKAGE_ROOT / "compute" / "import_xenium.py"

sys.path.insert(0, str(Path(__file__).resolve().parent))
import xenium_refusal_sites as RS  # noqa: E402
import xenium_fixtures as XF  # noqa: E402


def test_the_NAMED_DESIGN_and_the_SHIPPED_MODULE_still_describe_each_other():
    """The design note and the module must widen TOGETHER.

    Widening the design without widening the code reddens the second half; narrowing the code
    back reddens the second half; reverting the design note reddens the first.
    """
    design = DESIGN_DOC.read_text(encoding="utf-8")
    assert "WIDENED BY #343" in design
    # The second anchor is the §3 note's own XENIUM measurement, not the #329 scope sentence:
    # that sentence survives in §6.5 only as a QUOTATION of the Visium module, so asserting it
    # would be satisfied by main's text and could never redden on any drift #343 can cause. This
    # phrase lives in the WIDENED BY #343 note alone, so removing or rewording the note reddens.
    assert "unprovable interpolations across 28 sites on `1e94c77d2`, 0 across 28 after" in design

    source = COMPUTE.read_text(encoding="utf-8")
    RS.assert_module_is_funnelled(source)
    assert RS.unsafe_interpolations(source) == []


def test_the_manifest_version_is_bumped_WITH_its_changelog_entry():
    """A PACKAGING check, declared as such.

    This would pass with the behavioural fix reverted. It exists so the version bump and its
    changelog entry cannot drift apart, not to prove anything about escaping. A declared vacuous
    test is fine; an undeclared one is a lie.

    The version floor and the history-preservation half are DERIVED from `origin/main` rather
    than pinned to the previous branch's facts — #437 (this was the second copy of that landmine
    in this package; TEST-16 in `test_coordinate_space_identity.py` was the first).
    """
    import re

    text = MANIFEST.read_text(encoding="utf-8")
    lines = text.splitlines()
    version_index = next(i for i, line in enumerate(lines) if line.startswith("version:"))
    declared = lines[version_index].split(":", 1)[1].strip().strip('"\'')
    version = tuple(int(part) for part in declared.split("."))

    # The version floor is DERIVED from `origin/main`'s own `version:`, not a literal: a
    # hardcoded floor rots the moment main moves past it. #437.
    origin_text, skip_reason = XF.origin_main_text(
        "src-app/packages/spatial-import-xenium/manifest.yaml")
    if skip_reason is not None:
        pytest.skip(skip_reason)
    origin_lines = origin_text.splitlines()
    origin_version_lines = [i for i, line in enumerate(origin_lines)
                            if line.startswith("version:")]
    assert len(origin_version_lines) == 1, (
        f"expected exactly one top-level `version:` on origin/main, found "
        f"{[origin_lines[i] for i in origin_version_lines]}")
    origin_version_index = origin_version_lines[0]
    origin_declared = origin_lines[origin_version_index].split(":", 1)[1].strip().strip('"\'')
    origin_version = tuple(int(part) for part in origin_declared.split("."))
    # The strict `>` is required ONLY when this branch actually TOUCHES the package
    # (relative to `origin/main`); when it does not — the state `main` itself is in after
    # any merge, including this very branch after it lands — there is no local version claim
    # to verify, so the guard SKIPS rather than asserting a relationship it has no basis to
    # demand (#530). The discriminator lives in `xenium_fixtures.package_touched_since_origin_main`,
    # a non-`test_*` helper, so the branch-diff sweep
    # (`_lib/test_zero_core_guard.py::test_no_package_test_reads_a_branch_diff_without_a_scope_gate`)
    # does not flag it — exactly as `origin_main_text` in the same file is not flagged.
    if XF.package_touched_since_origin_main():
        assert version > origin_version, (
            f"version {declared} is not above origin/main's {origin_declared} — this branch "
            "touches the package (per `git diff origin/main...HEAD`) and must bump it")
    else:
        pytest.skip(
            "this branch does not touch spatial-import-xenium (per `git diff origin/main...HEAD`), "
            "so there is no local version claim to verify against origin/main's own — see #530")

    # The newest entry must exist, name the declared version, and name AT LEAST ONE issue — the
    # head regex requires the `#NNN` by construction, so no branch-specific issue number is
    # hardcoded here (#437).
    heads = [(i, line) for i, line in enumerate(lines[:version_index])
             if re.match(r"^# \d+\.\d+\.\d+ — #\d", line)]
    assert heads, "no `# X.Y.Z — #NNN: rationale` changelog entry head found in manifest.yaml"
    _, newest = heads[-1]
    assert newest.startswith(f"# {declared} — #"), (
        f"the entry immediately above `version:` is {newest!r}; it must name the declared "
        f"version {declared}, or the bump has no log entry")

    # The changelog is APPEND-ONLY: every head and continuation line that exists on `origin/main`
    # above ITS version line must still be present, byte for byte, above the (new, higher) version
    # line here. This subsumes the old `# 0.11.0 — #343:` history assertion — it asserts about ALL
    # history, not one named entry, and needs no branch-specific literal. Reached only when the
    # `git show` above succeeded (otherwise the whole test skipped). #437.
    origin_heads = [(i, line) for i, line in enumerate(origin_lines)
                    if re.match(r"^# \d+\.\d+\.\d+ — #\d", line)]
    assert origin_heads, "no changelog entry head found in origin/main's manifest.yaml"
    origin_block = "\n".join(origin_lines[origin_heads[0][0]:origin_version_index])
    current_block = "\n".join(lines[heads[0][0]:version_index])
    assert origin_block in current_block, (
        "the changelog is not append-only: some head or continuation line that exists on "
        "`origin/main` above its `version:` line is missing or edited above the current "
        "`version:` line")
    # A tail-append after a past entry's last continuation line would still pass the substring
    # check above, so look at what immediately follows the origin block inside the current one:
    # it must be a NEW head (or nothing), never a continuation line bolted onto a past entry.
    idx = current_block.index(origin_block)
    tail = current_block[idx + len(origin_block):]
    # Scan the WHOLE of `tail`, not just its first non-empty line: a non-continuation,
    # non-blank line (e.g. `# NOTE: stray comment`) before a genuine continuation-shaped
    # append line must not let the append through. Only a head-shaped line stops the scan;
    # blank lines and any other line neither stop it nor trigger it.
    for line in tail.splitlines():
        if re.match(r"^# \d+\.\d+\.\d+ — #\d", line):
            break  # a genuine new head — everything before it in `tail` was already scanned clean
        assert not re.match(r"^#          ", line), (
            "a line was appended after a past changelog entry's last continuation line — "
            "appending to a past entry's tail is still editing history")
