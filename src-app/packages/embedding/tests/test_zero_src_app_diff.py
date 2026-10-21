#!/usr/bin/env python3
# ruff: noqa
"""TEST-28 [acceptance] [invariant: INV-16, INV-17] [covers: ITEM-29] — the executable
anchor for "UI is data, not code".

On the branch that INTRODUCES this package, `git diff main...HEAD --name-only`
contains NO path under `src-app/ui/` or `src-app/server/src/` — the only files outside
the new package are `src-app/packages/pytest.ini` and (optionally)
`src-app/env-rootfs/single-cell/Dockerfile`.

## Scope — TEST-4 (fix/zero-core-derived), docs/design/derived-guards.md §3

These are assertions about a DIFF, and a diff belongs to a branch. They are therefore
gated on `zero_core_guard.require_introducing_branch`, which runs them only on the
branch whose `manifest.yaml` ADD introduced this package, and SKIPS elsewhere with a
stated reason.

Without that gate they re-executed on every later branch and asserted that branch's
diff was also confined to this package — false for every branch after this one, and
unfixable by its author without editing this file. The assertions below are unchanged;
only the question of WHICH branch is asked has been made derived rather than eternal.
"""
import sys
from pathlib import Path

# `_lib` is on `sys.path` for every package suite via `src-app/packages/conftest.py`.
# Re-asserted here so this module also imports when a suite is run with a narrower
# rootdir than the canonical `cd src-app/packages && python3 -m pytest`.
_LIB = Path(__file__).resolve().parents[2] / "_lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from zero_core_guard import (  # noqa: E402
    infra_exempt,
    package_prefix,
    require_introducing_branch,
)


# The only sanctioned non-package files (ITEM-29). Package-specific, deliberately NOT
# shared: a union across packages would grant every package every other package's
# exemptions, which is the prefix-exemption failure in a new costume.
SANCTIONED_NON_PACKAGE = {
    "src-app/packages/pytest.ini",
    "src-app/env-rootfs/single-cell/Dockerfile",
}


def test_no_src_app_ui_or_server_src_changes():
    root, _pkg, changed = require_introducing_branch(__file__)
    for p in changed:
        if not p.startswith("src-app/"):
            continue
        if infra_exempt(p, root):
            continue
        assert not p.startswith("src-app/ui/"), f"UI file changed (breaks INV-16/17): {p}"
        assert not p.startswith("src-app/server/src/"), f"server src changed: {p}"


def test_only_package_files_and_sanctioned_two_changed():
    root, pkg, changed = require_introducing_branch(__file__)
    for p in changed:
        if not p.startswith("src-app/"):
            continue  # lifecycle docs etc. are outside the src-app scope this test guards
        if p.startswith(package_prefix(pkg)):
            continue
        if infra_exempt(p, root):
            continue
        assert p in SANCTIONED_NON_PACKAGE, (
            f"unexpected non-package src-app change (ITEM-29): {p}")
