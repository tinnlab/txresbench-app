# Contributing a change in `sdk/` upstream

`sdk/` is part of this repository and is built with it. It is also the code of the SDK project it came from, with its names
converted to TxResBench names (see `sdk/RENAME-MAP.md`).

**Sending a change upstream**

1. Make and test the change here, in a commit that touches only `sdk/`.
2. Export it: `git format-patch -1 <commit> --stdout > change.patch`.
3. In a checkout of the upstream project, apply the patch after converting it back: run
   `python3 scripts/rename/apply.py --reverse --root <a scratch checkout of this repository with the patch applied>` and take the diff
   of `sdk/` against the upstream tree; or edit the upstream files by hand following the map.
4. Read the converted diff before sending it: only the SDK-style names are restored.

**Bringing an upstream change in**

1. Apply the upstream patch to a scratch checkout of this repository's `sdk/` directory.
2. Run `python3 scripts/rename/apply.py --root <that checkout>` to convert it to TxResBench names, then review and commit it here.

`scripts/check-naming.sh` fails when a predecessor name appears anywhere outside the map, this guide, the tool and the notice files.
