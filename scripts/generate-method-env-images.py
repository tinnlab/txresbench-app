#!/usr/bin/env python3
"""Build per-method environment layer artifacts (plan node method-env-images, ITEM-2).

WHAT THIS DOES
==============
For every runnable method in the benchmark methods repository, build the
method's OWN Dockerfile, export both the method image and its per-language
base image, compute the per-file delta, trim it, close each entry per the
subtree-closure rule, emit the layer contract files, normalize modes, and
pack a zstd squashfs layer. Layers are staged locally under --out; nothing
is pushed (the publish step is owner-gated, DEC-2). ITEM-3 added the
manifest writer to this same script: assemble + write the committed
manifest (`src-app/server/data/method-env-images.json`) from the staged
artifact records, and the regen-parity `--check` mode (byte-equality
against the committed file, DEC-15/INV-5).

Binding references (read them before changing a constant or a rule):

  - docs/design/method-env-layer-artifacts.md — the artifact contract:
    delta semantics (§3), trim rules (§4), the layer filesystem contract and
    the subtree-closed cover (§5/§5.1), the prefix refusal (§5.2), the mount
    semantics that make the cover rule load-bearing (§8), determinism (§10).
  - .lifecycle/txresbench-app/method-env-images/PLAN.md — ITEM-2's own text,
    INV-1/3/4/5, DEC-3/11/12/13.

WHAT IT DOES NOT DO (item boundaries; keep them so later items stay
ownership-clean):

  - It does NOT push or sign: ITEM-5 (scripts/publish-method-env-images.sh).
  - It does NOT verify a published artifact behaviorally: ITEM-7
    (scripts/lib/method-env-verify.sh + the sandbox integration test).
  - It does NOT build the app-side trimmed per-language base (sandbox-stacked)
    and does NOT re-wrap or re-gate methods. The methods repository is a
    read-only build-time input (CONS-method-env-images-1); the only network
    use is the docker pull of a missing base image, which the build needs.

THE STAGED OUTPUT (one directory per (env, arch)):

  <out>/layers/<env_id>-<arch>/
    layer.squashfs     the zstd squashfs (the OCI artifact's single file)
    artifact.json      the record the manifest writer consumes
    oci-manifest.json  the exact OCI artifact manifest bytes (written by
                       the writer's --manifest mode; ITEM-5 pushes these
                       bytes, so its digest is the recorded `digest`)
  <out>/bases/<base-digest16>-<arch>/
    rootfs/            the extracted base rootfs (reused across methods of
                       that language; the delta base index sits next to it)
  <out>/work/<env_id>-<arch>/   extraction scratch; removed unless --keep-rootfs

artifact.json is the ONLY hand-off from the build to the manifest writer. It
records everything the writer cannot derive from the index: the precise base
the delta was computed against (ref + digest + how the digest was obtained),
the layer file hash/size, the wrapper hash per the design doc's pinned byte
convention (§2.2), the layer-manifest entries, and the delta statistics the
ITEM-6 report summarizes (outside the repo, in the worker's report).

THE MANIFEST WRITER (ITEM-3)
----------------------------

  python3 scripts/generate-method-env-images.py --out <dir> --manifest <path>
      build every selected method, then assemble + write the manifest.
  python3 scripts/generate-method-env-images.py --check --out <dir> [--manifest <path>]
      assemble ONLY (no docker) from the staged records and byte-compare
      against <path> (default: the committed repo file); exit 0 = identical,
      1 = differs with the first differing key named, 2 = usage error.
  python3 scripts/generate-method-env-images.py --fixture <dir> --manifest <path>
      assemble from fixture records (tests; no build, no git needed).

Entry fields come from the record (everything the build measured) plus the
methods index (`contract`) and method.json (`licence`, verbatim — TEST-11);
`digest` is the sha256 of the exact OCI artifact manifest bytes the item's
publisher must push (construction pinned in design §6). Determinism (INV-5,
DEC-15): no wall-clock field, entries sorted by (env_id, arch), pinned key
order, byte-identical for one source revision. `--source-revision <12hex>`
pins the expected revision: every staged record must carry it (the parity
comparison against the committed manifest's own revision is the check
itself — a mismatch surfaces at `source_revision`).

LAYOUT NOTE: the squashfs root IS the layer filesystem root — the runtime
mounts the layer dir and binds <layer_dir>/<entry> (stack.rs's
--ro-bind-try loop) — so /code, /usr/… and /opt/… sit at the squashfs root
next to /.txr-method-env-layer-schema and /layer-manifest.json.

WHAT THE SHIPPED CODE ALREADY PROVED (do not re-derive):

  - the extract shape (docker create + export a built image) is
    scripts/publish-env-rootfs.sh step 2 and the CI workflow it mirrors;
  - the packer flags are src-app/env-rootfs/single-cell/Dockerfile's packer
    stage: mksquashfs -comp zstd -Xcompression-level 22 -b 1M -all-root;
  - the 0600-wrapper failure is a repeated benchmark record (the container's
    non-root user cannot read /code/run.py), which is why a wrapper below
    0644 read bits is a HARD ERROR (design §3.1) and every other file is
    normalized (files >= 0644, dirs >= 0755);
  - the generated-artifact discipline is env-pins.generated.json +
    scripts/check-recipe-pins.mjs: this script emits no wall-clock field,
    sorts every emitted array, and writes no temp path into any record, so
    ITEM-3's byte-parity --check is reachable.

USAGE
-----
  python3 scripts/generate-method-env-images.py --out <dir>               # every runnable method
  python3 scripts/generate-method-env-images.py --out <dir> --only <id>  # one method (ITEM-6 resume)
  python3 scripts/generate-method-env-images.py --dry-run --out <dir>    # print the sequence, run nothing
  python3 scripts/generate-method-env-images.py --out <dir> --manifest <path>   # build + write manifest
  python3 scripts/generate-method-env-images.py --check --out <dir>      # byte parity vs the committed file
  python3 scripts/generate-method-env-images.py --fixture <dir> --manifest <path>  # tests: assemble only

  --arch            amd64 (default) | arm64; a cross-arch build is refused
                    unless ALLOW_EMULATED_BUILD=1 (mirror of
                    publish-env-rootfs.sh: qemu bytes must not be staged
                    by accident, DEC-10).
  --methods-dir     the methods repository (default $TXR_METHODS_DIR, else
                    /data/share/pbya/sigtrans/methods — the plan's CONS-1
                    default).
  --benchmark-dir   the benchmark tree root used ONLY as the fallback base
                    source (docker-images/base-<lang> there) when a FROM
                    base is neither local nor pullable (default:
                    dirname(methods-dir)/dev/code/benchmark).
  --manifest <path> assemble + write the manifest (from this run's records,
                    or from --fixture records when --fixture is given).
  --check           assemble only and byte-compare against --manifest
                    (default src-app/server/data/method-env-images.json).
  --fixture <dir>   read records from <dir>/layers (tests; never builds).
  --source-revision <12hex>  expected source revision pin; every staged
                    record must carry it (an explicit pin, for the tests
                    and for a rebuild audited against a known revision).
  --no-trim         debugging only (DEC-12: trim constants are fixed).
  --keep-rootfs     keep the extracted rootfs + scratch (debugging).
  --force-base-build  skip the local/pull base lookup; build the base from
                    the benchmark tree (the owner's "bases published or
                    build from src" step).

EXIT CODES
----------
  0  every selected method produced a staged layer (and, with --manifest,
     the manifest was written; with --check, the parity matched)
  2  usage error
  1  a method failed — the FIRST failure is reported and the run stops
     (a silent skip of a runnable method is forbidden: DEC-8's rule that
     exactly the runnable methods are covered); or, with --check, the
     parity differs

Python 3.10+, stdlib only. POSIX paths only (the rootfs tars are POSIX).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile

# ─────────────────────────────── compiled constants ─────────────────────────

#: The layer schema version written into the squashfs (DEC-11), mirrored in
#: the manifest entry (layer_schema) and the artifact annotation
#: (com.txr.layer_schema). Bump on any breaking layer layout change, exactly
#: the ROOTFS_SCHEMA_VERSION discipline.
LAYER_SCHEMA_VERSION = 1

#: The generator's own version. 0.1.0 was the ITEM-1 design+schema step; the
#: first code (this file) is 0.2.0. ITEM-3's writer records this string in
#: the manifest's generator_version, so a bump here is a visible change —
#: deliberate, never silent.
GENERATOR_VERSION = "0.2.0"

#: The offline verification floor is sha256 (models.md's cached → verified →
#: offline flow, DEC-5/7), so both the layer hash and the wrapper hash are
#: sha256.
HASH = hashlib.sha256

#: Excluded tops (design §3, the EXACT list, in BOTH directions): a new or
#: changed path under one of them is build debris and never enters the
#: delta (TEST-4: a /tmp-only artifact never appears); a deletion under one
#: of them is a method cleaning its own caches and is never an error.
#: Any other deletion from the base REFUSES the build and names the paths.
EXCLUDED_TOPS = (
    "/tmp",
    "/var/cache",
    "/var/lib/apt/lists",
    "/root",
    "/run",
    "/proc",
    "/sys",
    "/dev",
)

#: The structural mount prefixes a layer entry may name — the SAME list
#: sandbox-stacked validates (stack.rs ALLOWED_LAYER_ENTRY_PREFIXES; it is
#: the reconcile-bound PROV-SS-2 pairing and must not drift from it). A
#: delta path outside these prefixes refuses the build (design §5.2) and
#: NAMES the paths: the runtime would refuse the entry anyway, and a silent
#: skip would hide a method whose layer cannot exist.
ALLOWED_PREFIXES = (
    "/usr/local",
    "/opt",
    "/code",
)

#: Trim rules (DEC-12, design §4) — the shipped single-cell recipe's own
#: set, as fixed constants (DEC-13: no settings row, no per-method profile).
#: KEPT: `.pyi`/`.pyx`/`.pxd` (skimage/scipy lazy loaders read them), R
#: package metadata (Meta/, R/) and man pages.
TRIM_DIR_NAMES = frozenset(
    ("include", "tests", "test", "docs", "doc", "examples", "__pycache__")
)
TRIM_FILE_SUFFIXES = (".pyc", ".a")
STRIP_PATTERN = re.compile(r"\.so(\.|$)")

#: The per-language base the method Dockerfiles must start FROM (INV-1: the
#: layer is the method's own bytes over its own base, never a hand-authored
#: re-install). The classifier is the ONLY place the base ref is derived,
#: so a build and its own record cannot disagree.
BASE_REF_RE = re.compile(r"^ghcr\.io/tinnlab/txresbench-base-(r|py):([0-9]+\.[0-9]+)$")
BASE_LANG_BY_KEY = {"r": "R", "py": "Python"}
CONTRACT_RE = re.compile(r"^[0-9]+\.[0-9]+$")

#: The runtime layer registry namespace (DEC-2); the manifest's oci_ref is
#: this prefix + env_id. Spelled WITHOUT a scheme exactly like the shipped
#: stack.rs TXR_LAYER_REGISTRY_PREFIX, so no new host enters the allowlist
#: (DEC-17).
OCI_REF_PREFIX = "ghcr.io/tinnlab/txr-method-env-layers"

#: Mirrors src-app/server/src/modules/sandbox/env_id.rs::is_valid_env_id.
#: An id failing this is refused at the top of the build, not rescued.
ENV_ID_RE = re.compile(r"^[a-z0-9._-]+$")

#: The local tag of the built method image. Arch-suffixed so amd64 and arm64
#: builds never collide in the local image store; never pushed.
METHOD_IMAGE_TAG = "txr-env-build:{env_id}-{arch}"

#: docker buildx --metadata-file key holding the exact registry digest
#: (manifest/index) of the built image — the only exact way to pin a
#: LOCALLY built base (RepoDigests exists for pulled/pushed refs only).
BUILDX_DIGEST_KEY = "containerimage.digest"

MIN_SIZE_BYTES = 1  # an empty layer is a build bug, not an artifact

# ── manifest writer constants (ITEM-3; PROV-1/PROV-2, DEC-14/15) ─────────────

#: The committed manifest's shape version (`schema_version` in the file).
#: Bump on any breaking field change, with the JSON Schema in the same change
#: (schema_version 1 == the seed emitted by ITEM-1).
MANIFEST_SCHEMA_VERSION = 1

#: The OCI artifact type (DEC-14) — the manifest's `artifactType` AND the
#: single file's media type (the publisher's `oras push` spells the file as
#: `layer.squashfs:<ARTIFACT_TYPE>`, exactly the publish-env-rootfs.sh shape).
ARTIFACT_TYPE = "application/vnd.txr.method-env.layer.v1"

#: The OCI image manifest media type of the artifact manifest.
OCI_MANIFEST_MEDIATYPE = "application/vnd.oci.image.manifest.v1+json"

#: The empty config blob every artifact manifest references
#: (`{}` — 2 bytes, digest fixed by sha256, never written by us).
OCI_EMPTY_CONFIG_DIGEST = "sha256:" + HASH(b"{}").hexdigest()
OCI_EMPTY_CONFIG_SIZE = 2

#: PROV-2's standard source annotation (the methods repository, the layer's
#: origin). Spelled with a scheme ONLY here — build-time annotation data,
#: never a runtime fetch: the network allowlist (DEC-17) stays untouched and
#: the publisher script resolves nothing from it.
SOURCE_URL = "https://github.com/tinnlab/txresbench-methods"

#: The committed manifest path, resolved against the repo root (never the
#: cwd) — the ITEM-1 data README's generation contract.
DEFAULT_MANIFEST_PATH = "src-app/server/data/method-env-images.json"

#: The OCI annotation the layer's runtime pairing anchors on is emitted by
#: the app-side trimmed base (sandbox-stacked), not by this node; the layer
#: records it in `com.txr.base_digest` (its manifest counterpart is the
#: `base_digest` field, §7).
SOURCE_REVISION_RE = re.compile(r"^[0-9a-f]{12}$")


# ─────────────────────────────── errors / helpers ────────────────────────────

class BuildError(Exception):
    """A refusal the plan/design makes a hard error; the message names paths."""


class Delta:
    """The per-file delta between the method rootfs and the base rootfs.

    Paths are relative POSIX strings without a leading slash (the
    layer-manifest entries are those plus a leading slash). `kind` is one of
    'file' | 'dir' | 'symlink' | 'special'.
    """

    def __init__(self) -> None:
        self.added: dict[str, str] = {}      # path -> kind
        self.changed: dict[str, str] = {}    # path -> kind
        self.refused: list[str] = []         # topmost removals outside excluded tops
        self.n_dropped_excluded_added = 0    # added/changed under an excluded top
        self.n_dropped_excluded_deleted = 0  # removals under an excluded top (allowed)
        self.n_specials = 0                  # specials landing in the delta

    @property
    def paths_count(self) -> int:
        return len(self.added) + len(self.changed)

    @classmethod
    def topmost(cls, paths: list[str]) -> list[str]:
        """The entries of `paths` with no ancestor also in the set (a removed
        directory implies every child under it; naming children too would
        drown the report)."""
        top = []
        for p in sorted(set(paths)):
            parent = os.path.dirname(p)
            while parent:
                if parent in paths:
                    break
                parent = os.path.dirname(parent)
            else:
                top.append(p)
        return sorted(top)


def _is_under(p: str, top: str) -> bool:
    rel = top.strip("/")
    return p == rel or p.startswith(rel + "/")


def _excluded(p: str) -> bool:
    return any(_is_under(p, top) for top in EXCLUDED_TOPS)


def _under_allowed(p: str) -> bool:
    return any(_is_under(p, top) for top in ALLOWED_PREFIXES)


def _type_of(mode: int) -> str:
    if stat.S_ISDIR(mode):
        return "dir"
    if stat.S_ISLNK(mode):
        return "symlink"
    if stat.S_ISREG(mode):
        return "file"
    return "special"


def _hash_file(path: str, size: int) -> str:
    h = HASH()
    with open(path, "rb") as f:
        remaining = size
        while remaining > 0:
            chunk = f.read(min(1 << 20, remaining))
            if not chunk:
                break
            h.update(chunk)
            remaining -= len(chunk)
    return h.hexdigest()


# ─────────────────────────────── the delta ───────────────────────────────────

def compute_delta(method_root: str, base_root: str,
                  base_index: dict[str, tuple[int, str]]) -> Delta:
    """Diff the two extracted rootfs dirs (design §3 step 3).

    Regular files compare by bytes (base sha256s are pre-indexed by
    build_base_index, so the method tree is hashed once per method and the
    base once per image); symlinks by target/source-type; directories by
    existence only (a directory present in both rootfs is not a change
    merely because its metadata differ).

    Deletions: every base path the method rootfs lacks, recorded as the
    TOPMOST removed paths (`delta.refused`). Which of them actually refuse
    the build is decided in closed_cover, after the cover is known: a
    removal SHADOWED by a cover entry is the method's replacement of that
    subtree (a changed package's new version may lack files the base's old
    version had — §5.1's content rule makes the entry carry the method's
    full subtree, so the bind shadows them); a removal under an excluded top
    is a method cleaning its own caches (counted, allowed); every OTHER
    removal refuses the build and names the paths (PROV-3: "no base-path
    deletions are allowed" outside the excluded tops).

    os.walk lists a symlink-to-directory in DIRNAMES (it does not descend
    into it, followlinks=0) — such an entry is a filesystem entry at that
    path, so it is compared as one (never mistaken for a deletion of the
    base dir it replaces) and pruned from descent.
    """
    delta = Delta()
    method_seen: set[str] = set()

    def compare(rel: str, method_path: str) -> None:
        """Compare ONE method entry against the base; record added/changed."""
        m_st = os.lstat(method_path)
        base_path = os.path.join(base_root, rel)
        b_st = os.lstat(base_path) if os.path.lexists(base_path) else None
        m_kind = _type_of(m_st.st_mode)
        b_kind = _type_of(b_st.st_mode) if b_st is not None else None
        if b_kind is None:
            delta.added[rel] = m_kind
            return
        if m_kind == "special" or b_kind == "special":
            # Compare specials by type only; a mismatch in the delta is a
            # refusal (materialization cannot carry one) — counted here.
            if m_kind != b_kind:
                delta.changed[rel] = m_kind
                delta.n_specials += 1
            return
        if m_kind == "symlink" and b_kind == "symlink":
            if os.readlink(method_path) != os.readlink(base_path):
                delta.changed[rel] = "symlink"
            return
        if m_kind == "symlink" or b_kind == "symlink":
            delta.changed[rel] = m_kind  # type change (symlink <-> dir/file)
            return
        entry = base_index.get(rel)
        if entry is None:
            delta.added[rel] = "file"
            return
        if entry[0] != m_st.st_size or entry[1] != _hash_file(method_path, m_st.st_size):
            delta.changed[rel] = "file"
        return

    for dirpath, dirnames, filenames in os.walk(method_root):
        rel_dir = os.path.relpath(dirpath, method_root)
        if rel_dir == ".":
            rel_dir = ""
        if rel_dir:
            m_kind = _dir_kind(dirpath)
            b_kind = _dir_kind(os.path.join(base_root, rel_dir))
            if b_kind is None:
                delta.added[rel_dir] = m_kind
            elif b_kind != m_kind:
                delta.changed[rel_dir] = m_kind
            method_seen.add(rel_dir)
        kept = []
        for name in sorted(dirnames):
            full = os.path.join(dirpath, name)
            rel = f"{rel_dir}/{name}".strip("/")
            st = os.lstat(full)
            if not stat.S_ISDIR(st.st_mode) or stat.S_ISLNK(st.st_mode):
                # symlink-to-dir: an entry, not a subtree (see docstring)
                method_seen.add(rel)
                compare(rel, full)
                continue
            if _excluded(rel):
                # Present (the dir exists in the method rootfs) but debris:
                # record it and its known children as seen (shallow list —
                # we do NOT descend) so the removal pass reports only the
                # method's REAL deletions, not the whole pruned subtree.
                method_seen.add(rel)
                try:
                    for child in os.listdir(full):
                        method_seen.add(rel + "/" + child)
                except OSError:
                    pass
                continue
            kept.append(name)
        dirnames[:] = kept
        for name in sorted(filenames):
            rel = f"{rel_dir}/{name}".strip("/")
            method_seen.add(rel)
            compare(rel, os.path.join(dirpath, name))

    # Removals: base paths the method rootfs lacks (topmost only).
    base_paths: set[str] = set()
    for dirpath, dirnames, filenames in os.walk(base_root):
        rel_dir = os.path.relpath(dirpath, base_root)
        if rel_dir == ".":
            rel_dir = ""
        if rel_dir:
            base_paths.add(rel_dir)
        for name in filenames:
            base_paths.add(f"{rel_dir}/{name}".strip("/"))
    for p in Delta.topmost([p for p in base_paths if p not in method_seen]):
        if _excluded(p):
            delta.n_dropped_excluded_deleted += 1
        else:
            delta.refused.append(p)

    # Drop excluded-top debris from the added/changed sets (counted, so a
    # method whose build writes only excluded-top nonsense still reports it).
    for p in list(delta.added):
        if _excluded(p):
            delta.n_dropped_excluded_added += 1
            del delta.added[p]
    for p in list(delta.changed):
        if _excluded(p):
            delta.n_dropped_excluded_added += 1
            del delta.changed[p]
    return delta


def _dir_kind(path: str) -> str | None:
    if not os.path.lexists(path):
        return None
    return _type_of(os.lstat(path).st_mode)


def build_base_index(base_root: str) -> dict[str, tuple[int, str]]:
    """One (size, sha256) per regular file under the base rootfs.

    Cached next to the extracted base rootfs (load_or_build_base_index) so a
    base image is hashed once, not once per method that FROMs it — that is
    what the full run would otherwise re-read 65/30 times.
    """
    index: dict[str, tuple[int, str]] = {}
    for dirpath, _dirnames, filenames in os.walk(base_root):
        for name in filenames:
            full = os.path.join(dirpath, name)
            st = os.lstat(full)
            if not stat.S_ISREG(st.st_mode):
                # Symlinks (os.walk lists them in filenames; the real
                # benchmark bases carry broken ones under /etc/alternatives)
                # are compared by TARGET in compute_delta, never hashed —
                # hashing would follow the link and open() a dangling target.
                continue
            rel = os.path.relpath(full, base_root)
            index[rel] = (st.st_size, _hash_file(full, st.st_size))
    return index


# ────────────────────────────── trim + cover ─────────────────────────────────

def trim_delta(delta: Delta) -> Delta:
    """Drop the DEC-12 debris from the delta path set. The layer gets the
    SAME trim after materialization (trim_layer), so the two always agree:
    a package whose only real change was in a trimmed directory produces no
    entry here, and the subtree copied into the layer is trimmed there too.
    """
    out = Delta()
    out.added = {p: k for p, k in delta.added.items() if not _trimmed(p, k)}
    out.changed = {p: k for p, k in delta.changed.items() if not _trimmed(p, k)}
    out.refused = list(delta.refused)
    out.n_dropped_excluded_added = delta.n_dropped_excluded_added
    out.n_dropped_excluded_deleted = delta.n_dropped_excluded_deleted
    out.n_specials = delta.n_specials
    return out


def _trimmed(p: str, kind: str) -> bool:
    parts = p.split("/")
    if any(comp in TRIM_DIR_NAMES for comp in parts):
        return True
    return kind == "file" and p.endswith(TRIM_FILE_SUFFIXES)


def closed_cover(delta: Delta, method_root: str) -> list[str]:
    """Derive the subtree-closed cover of the delta (design §5.1) and REFUSE
    what cannot be a layer under the frozen contract (§5.2).

    Rules, in order — each is the reason the emitted entry list makes the
    runtime's per-entry bind loop equivalent to an overlay union (§8):

      1. Every delta path must sit under an allowed prefix (/usr/local,
         /opt, /code); otherwise the build refuses and names the paths.
      2. /code is always an entry (the wrapper lives there; its parent is
         the mount root, so the runtime's parent-exists rule holds).
      3. A path under a package library root (site-packages / site-library)
         folds to the top-level package directory: new package dirs stay
         delta-sized, changed package dirs carry the method's FULL package
         subtree (the entry content rule). site-packages / site-library as
         a whole subtree is never an entry unless the delta covers it —
         the benchmark bases provide it, so it never does here.
      4. A delta directory keeps the topmost delta directory as its entry
         (a wholly new /opt/tool is one entry, not one per subtree root).
      5. A delta file/symlink with no delta-dir ancestor is its own entry
         (a lone new /usr/local/bin tool, a new /opt file).
      6. Nothing else is an entry: a path shared with the base whose delta
         is empty is not an entry at all.
    """
    if delta.paths_count == 0:
        raise BuildError(
            "the method image and its base are byte-identical (delta empty); "
            "a layer with nothing to carry cannot be built — a runnable "
            "method's wrapper must land in /code"
        )
    outside: list[str] = []
    entries: set[str] = set()
    for p, kind in list(delta.added.items()) + list(delta.changed.items()):
        if not _under_allowed(p):
            outside.append("/" + p)
            continue
        pkg = _package_root(p)
        if pkg is not None:
            entries.add("/" + pkg)
            continue
        if p == "code" or p.startswith("code/"):
            entries.add("/code")
            continue
        entry = _generic_entry(p, kind, delta)
        if entry is not None:
            entries.add("/" + entry)
    if outside:
        raise BuildError(
            "delta paths outside the layout contract; the runtime refuses "
            "entries not under /usr/local, /opt or /code (PROV-3, stack.rs "
            "ALLOWED_LAYER_ENTRY_PREFIXES):\n  " + "\n  ".join(sorted(outside))
        )
    if delta.n_specials:
        raise BuildError(
            f"{delta.n_specials} special filesystem entry/ies changed in the "
            "delta; a layer carries files, dirs and symlinks only"
        )
    if "/code" not in entries:
        raise BuildError("the layer manifest must include /code (PROV-3)")
    # The deletion half of PROV-3, decided AFTER the cover: a removal whose
    # path sits under a cover entry is shadowed by the entry's bind (the
    # method's replacement of that subtree — §5.1's content rule makes the
    # entry carry the method's full subtree, including its ABSENCE of files
    # the base's version had). A removal anywhere else refuses.
    refused = [p for p in delta.refused
               if not any(p == e.lstrip("/") or p.startswith(e.lstrip("/") + "/")
                          for e in entries)]
    if refused:
        raise BuildError(
            "the method build deletes base paths outside the excluded tops "
            "and outside every layer entry's subtree — a layer never "
            "silently removes a file the benchmark base provides (PROV-3, "
            "design §3/§5.1):\n  " + "\n  ".join(refused))
    return sorted(entries)


def _package_root(p: str) -> str | None:
    """The top-level unit when `p` sits under a library root.

    site-packages/<name>/… and site-library/<name>/… fold to
    site-packages/<name> (or site-library/<name>); `name` is whatever the
    first component after the root is — a package dir, a dist-info dir, a
    .libs dir. That component is the unit a bind shadows, so that is where
    the entry lives (design §5.1).
    """
    parts = p.split("/")
    for i, comp in enumerate(parts):
        if comp in ("site-packages", "site-library") and i + 1 < len(parts):
            return "/".join(parts[: i + 2])
    return None


def _generic_entry(p: str, kind: str, delta: Delta) -> str | None:
    """Topmost delta dir for a delta dir; the path itself for a lone
    file/symlink; None when a delta-dir ancestor already covers it.
    """
    parent = os.path.dirname(p)
    while parent:
        if delta.added.get(parent) == "dir" or delta.changed.get(parent) == "dir":
            return None
        parent = os.path.dirname(parent)
    if kind in ("dir", "file", "symlink"):
        return p
    return None


# ─────────────────────────────── layer build ─────────────────────────────────

def materialize_layer(entries: list[str], method_root: str, layer_root: str) -> None:
    """Copy each entry's method-image subtree into the layer root (§5.1).

    For an entry the base does not provide the subtree of, this is the
    delta; for an entry the base also provides (a changed package dir,
    /code), it is the method image's FULL subtree at that path — exactly
    the bytes a bind of that entry must expose, because the bind shadows
    whatever the base has underneath (§8). Symlinks are re-created as
    symlinks (docker export preserves them); modes are preserved here, and
    normalization happens AFTER, so the 0600-wrapper check sees the
    pristine build result.
    """
    if os.path.lexists(layer_root):
        shutil.rmtree(layer_root)
    os.makedirs(layer_root)
    for entry in entries:
        _copy_tree(os.path.join(method_root, entry.lstrip("/")),
                   os.path.join(layer_root, entry.lstrip("/")))


def _copy_tree(src: str, dst: str) -> None:
    st = os.lstat(src)
    if stat.S_ISLNK(st.st_mode):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        os.symlink(os.readlink(src), dst)
        return
    if stat.S_ISDIR(st.st_mode):
        os.makedirs(dst, exist_ok=True)
        for name in sorted(os.listdir(src)):
            _copy_tree(os.path.join(src, name), os.path.join(dst, name))
        return
    if stat.S_ISREG(st.st_mode):
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)  # copy2 keeps mode + mtimes
        return
    raise BuildError(
        f"refusing to carry a {stat.S_IFMT(st.st_mode)} entry ({src}) in the "
        "layer — the contract carries files, dirs and symlinks only"
    )


def trim_layer(layer_root: str) -> None:
    """The design §4 trim pass over the materialized layer, applied AFTER
    materialization so closure contents (a changed package's own tests/
    docs) are trimmed too; identical rules to trim_delta, so the cover and
    the bytes cannot diverge.

    strip --strip-unneeded failures are ignored (the shipped recipe's own
    posture: a symbol table that refuses to strip is not a broken artifact —
    an over-trimmed one is, and the ITEM-7 equivalence test catches that).
    """
    for dirpath, dirnames, filenames in os.walk(layer_root, topdown=True):
        for d in list(dirnames):
            if d in TRIM_DIR_NAMES:
                shutil.rmtree(os.path.join(dirpath, d))
                dirnames.remove(d)
        for name in filenames:
            full = os.path.join(dirpath, name)
            if name.endswith(TRIM_FILE_SUFFIXES):
                os.unlink(full)
                continue
            if STRIP_PATTERN.search(name):
                _run(["strip", "--strip-unneeded", full], check=False)


def normalize_modes(layer_root: str) -> None:
    """design §3.1: every file >= 0644, every dir >= 0755 (plus-or the read/
    execute bits — never a removal of an owner bit). Symlinks are left
    untouched AND never followed: os.chmod follows a symlink, and a layer
    can legitimately carry a dangling one (the benchmark bases do), so a
    chmod through it would chmod an unrelated target or raise. The wrapper
    runs the TARGET's mode; targets are regular files/dirs normalized here.
    """
    for dirpath, dirnames, filenames in os.walk(layer_root):
        for name in dirnames:
            p = os.path.join(dirpath, name)
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                continue  # symlink-to-dir entry; not a directory mode
            mode = stat.S_IMODE(st.st_mode)
            if mode & 0o555 != 0o555:
                os.chmod(p, mode | 0o555)
        for name in filenames:
            p = os.path.join(dirpath, name)
            st = os.lstat(p)
            if stat.S_ISLNK(st.st_mode):
                continue
            mode = stat.S_IMODE(st.st_mode)
            if mode & 0o444 != 0o444:
                os.chmod(p, mode | 0o444)


def check_wrapper_modes(layer_root: str, run_file: str) -> None:
    """A wrapper below 0644 read bits (mode & 0o044 != 0o044 — the 0600
    shape and its relatives) is a HARD ERROR naming the file and its octal
    mode. Read BEFORE normalize_modes: this is a build-result check, not a
    policy silently repaired — a layer re-built from the same broken build
    context must fail here again (the benchmark's repeated container-user
    pitfall, design §3.1).
    """
    for rel in ("code/method.json", f"code/{run_file}"):
        p = os.path.join(layer_root, rel)
        if not os.path.lexists(p):
            raise BuildError(f"wrapper file /{rel} missing from the layer")
        st = os.lstat(p)
        if stat.S_ISLNK(st.st_mode):
            continue
        mode = stat.S_IMODE(st.st_mode)
        if mode & 0o044 != 0o044:
            raise BuildError(
                f"wrapper file /{rel} is mode {oct(mode)[2:].zfill(4)} — not "
                "readable by the group/other the container runs as (the "
                "benchmark's repeated '/code/run.py unreadable' failure). "
                "Fix the mode in the method's build context and rebuild."
            )


def emit_marker_and_manifest(layer_root: str, entries: list[str]) -> None:
    """PROV-3: the schema marker (content the ASCII string "1", DEC-11 — no
    trailing newline, so the byte compare against the manifest's integer
    layer_schema is unambiguous) and /layer-manifest.json (a JSON array of
    the mount-entry strings, sorted — the runtime parses it with serde and
    validates every entry before any bind: stack.rs
    layer_entries_from_manifest).
    """
    with open(os.path.join(layer_root, ".txr-method-env-layer-schema"), "w") as f:
        f.write(str(LAYER_SCHEMA_VERSION))
    with open(os.path.join(layer_root, "layer-manifest.json"), "w") as f:
        json.dump(entries, f, separators=(",", ":"))
        f.write("\n")


# ─────────────────────────────── docker stages ───────────────────────────────

class DockerStageError(Exception):
    """A docker/build stage failed; the message names the command."""


def _run(cmd: list[str], *, check: bool = True) -> subprocess.CompletedProcess:
    """Run a build-stage command, printed with a `+ ` like
    publish-env-rootfs.sh. Every build-stage process is launched through the
    caller's cap (ops/cap.sh); this script only avoids its own unbounded
    parallelism — it never spawns a worker pool."""
    print("+ " + " ".join(cmd))
    try:
        return subprocess.run(cmd, check=check, capture_output=True)
    except FileNotFoundError as e:
        raise DockerStageError(f"missing tool {cmd[0]!r}: {e}") from e
    except subprocess.CalledProcessError as e:
        raise DockerStageError(
            f"command failed (rc={e.returncode}): {' '.join(cmd)}\n"
            f"{e.stderr.decode('utf-8', 'replace')[-2000:]}"
        ) from e


def docker(*args: str, **kw) -> subprocess.CompletedProcess:
    return _run(["docker", *args], **kw)


def image_exists(ref: str) -> bool:
    return docker("image", "inspect", ref, check=False).returncode == 0


def image_repo_digests(ref: str) -> list[str]:
    """The full `repo@sha256:…` entries in RepoDigests for `ref` (empty for
    a locally built image whose content was never pushed)."""
    p = docker("image", "inspect", "--format", "{{json .RepoDigests}}", ref,
               check=False)
    if p.returncode != 0:
        return []
    try:
        out = json.loads(p.stdout.decode("utf-8", "replace"))
    except json.JSONDecodeError:
        return []
    return out if isinstance(out, list) else []


def pick_digest(repo_digests: list[str], ref: str) -> str | None:
    """The sha256 hex after `@`, preferring the entry whose repo part is
    `ref` (a ref can carry more than one RepoDigest; the FROM ref pins the
    image by name)."""
    wanted = [d for d in repo_digests if d.startswith(ref + "@")]
    for d in wanted or repo_digests:
        if "@" in d:
            digest = d.rsplit("@", 1)[1]
            if re.match(r"^sha256:[0-9a-f]{64}$", digest):
                return digest
    return None


def build_image(tag: str, build_dir: str, arch: str,
                metadata_file: str | None = None) -> str | None:
    """Build one image; returns the digest when a buildx metadata file was
    requested.

    The METHOD build is the benchmark's own: plain `docker build` with the
    method directory as context, exactly the way the methods repository
    publishes its full images (INV-1 — the method's own bytes include the
    method's own build; a re-written build is the re-authoring the
    invariant forbids). The BASE fallback build uses buildx
    --metadata-file, the only exact way to pin a locally built image by its
    registry digest.
    """
    platform = f"linux/{arch}"
    if metadata_file:
        docker("buildx", "build", "--load", "--platform", platform,
               "--metadata-file", metadata_file, "-t", tag, build_dir)
        try:
            with open(metadata_file) as f:
                meta = json.load(f)
            return meta.get(BUILDX_DIGEST_KEY)
        except (OSError, json.JSONDecodeError, ValueError):
            return None
    docker("build", "--platform", platform, "-t", tag, build_dir)
    return None


def export_rootfs(image_ref: str, tar_path: str) -> None:
    """docker create + docker export + docker rm — the extract shape the
    shipped publish-env-rootfs.sh (step 2) proves. `docker create` needs no
    runtime; the exported stream is the image's filesystem (no volumes), so
    the delta is a pure image-vs-image comparison."""
    cid = docker("create", image_ref).stdout.decode("utf-8", "replace").strip()
    if not cid:
        raise DockerStageError(f"docker create {image_ref} returned no container id")
    try:
        with open(tar_path, "wb") as out:
            p = subprocess.run(["docker", "export", cid], stdout=out,
                               stderr=subprocess.PIPE)
        if p.returncode != 0:
            raise DockerStageError(
                f"docker export {cid} failed: "
                f"{p.stderr.decode('utf-8', 'replace')[-2000:]}")
    finally:
        docker("rm", cid, check=False)


def extract_tar(tar_path: str, dest: str) -> None:
    """Extract a docker-export tar safely: two passes, so no member is ever
    extracted THROUGH a symlink created by the tar itself (a tar is
    untrusted data; it comes from a method image whose chain is built from
    the published Dockerfile, but the boundary must stay at the tar).
    Device/FIFO members are skipped (/dev etc. are excluded tops; the delta
    refuses a special elsewhere). Hard links arrive as ordinary files
    (identical bytes, independent inode — the layer's mksquashfs dedup
    matches what the runtime needs)."""
    os.makedirs(dest, exist_ok=True)
    with tarfile.open(tar_path, "r") as tar:
        members = []
        for m in tar.getmembers():
            name = m.name[2:] if m.name.startswith("./") else m.name
            name = name.lstrip("/")
            if m.isdir():
                members.append((m, "dir", name))
            elif m.isreg() or m.ischr() or m.isblk() or m.isfifo():
                members.append((m, "file", name))
            elif m.issym():
                members.append((m, "sym", name))
            elif m.islnk():
                members.append((m, "file", name))  # hard link → content copy
        for m, kind, name in members:
            if kind == "dir":
                os.makedirs(os.path.join(dest, name), exist_ok=True)
        for m, kind, name in members:
            if kind == "file":
                f = tar.extractfile(m)
                if f is None:
                    continue
                dst = os.path.join(dest, name)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                with open(dst, "wb") as out:
                    shutil.copyfileobj(f, out)
                os.chmod(dst, m.mode)
            elif kind == "sym":
                dst = os.path.join(dest, name)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                if os.path.lexists(dst):
                    os.unlink(dst)
                os.symlink(m.linkname, dst)


# ─────────────────────────────── index + base ────────────────────────────────

def load_method_index(methods_dir: str) -> dict[str, dict]:
    with open(os.path.join(methods_dir, "index.json")) as f:
        index = json.load(f)
    methods = index.get("methods")
    if not isinstance(methods, list):
        raise SystemExit("index.json has no 'methods' array")
    by_id: dict[str, dict] = {}
    for entry in methods:
        eid = entry.get("id")
        if not eid or not ENV_ID_RE.match(eid):
            raise SystemExit(
                f"index.json entry without a valid env/method id: {eid!r}")
        by_id[eid] = entry
    return by_id


def source_revision(methods_dir: str) -> str:
    p = subprocess.run(["git", "-C", methods_dir, "rev-parse", "HEAD"],
                       capture_output=True, text=True)
    if p.returncode != 0:
        raise SystemExit("the methods directory is not a git checkout; "
                         "source_revision cannot be pinned (INV-5 requires it)")
    return p.stdout.strip()[:12]


def select_methods(by_id: dict, only: list[str]) -> list[tuple[str, dict]]:
    if only:
        chosen = []
        for eid in only:
            entry = by_id.get(eid)
            if entry is None:
                raise SystemExit(f"--only {eid}: no such method in index.json")
            if not entry.get("runnable"):
                raise SystemExit(
                    f"--only {eid}: the method is not runnable (DEC-8: exactly "
                    "the runnable methods get a layer)")
            chosen.append((eid, entry))
        return chosen
    runnable = [(m["id"], m) for m in by_id.values() if m.get("runnable")]
    if not runnable:
        raise SystemExit("index.json declares no runnable method — nothing to build")
    return runnable


def classify_from(dockerfile_path: str) -> tuple[str, str]:
    """Read the first FROM and classify it (design §3 step 1). Refuses a
    Dockerfile that does not start FROM a per-language benchmark base
    (INV-1). `FROM` may carry a `--platform=` arg (buildx syntax); ARG
    lines may precede it. Returns (base_ref, 'r'|'py').

    The match happens BEFORE any docker call — an unclassifiable FROM never
    costs a build, and a build never records a base ref different from the
    one the classifier accepted.
    """
    with open(dockerfile_path) as f:
        lines = f.readlines()
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("ARG "):
            continue
        m = re.match(r"^FROM(?:\s+--platform=\S+)?\s+(\S+)\s*$", stripped)
        if m:
            ref = m.group(1)
            bm = BASE_REF_RE.match(ref)
            if not bm:
                raise BuildError(
                    f"Dockerfile {dockerfile_path} does not start FROM a "
                    "per-language benchmark base (INV-1: the layer is the "
                    f"method's own bytes, never a hand-authored base): {ref!r}. "
                    "Accepted shape: "
                    "FROM ghcr.io/tinnlab/txresbench-base-(r|py):<contract>.")
            return ref, bm.group(1)
        raise BuildError(
            f"Dockerfile {dockerfile_path}: the first build instruction is "
            f"{stripped!r}, not FROM (INV-1)")
    raise BuildError(f"Dockerfile {dockerfile_path} has no FROM line")


def method_folder(methods_dir: str, eid: str) -> dict:
    """DEC-8: a runnable index entry whose folder is incomplete is a hard
    error naming the id, never a silent skip."""
    d = os.path.join(methods_dir, "methods", eid)
    missing = [f for f in ("method.json", "Dockerfile")
               if not os.path.isfile(os.path.join(d, f))]
    run_py = os.path.isfile(os.path.join(d, "run.py"))
    run_r = os.path.isfile(os.path.join(d, "run.R"))
    if not run_py and not run_r:
        missing.append("run.py or run.R")
    if missing:
        raise BuildError(f"method {eid}: missing {', '.join(missing)} in {d}")
    if run_py and run_r:
        raise BuildError(f"method {eid}: both run.py and run.R present; the "
                         "wrapper hash convention needs exactly one (design §2.2)")
    return {"dir": d, "wrapper": "run.py" if run_py else "run.R"}


def wrapper_code_sha256(method_dir: str, wrapper: str) -> str:
    """design §2.2's pinned byte convention: lowercase hex sha256 of
    bytes(method.json) || bytes(wrapper) — method.json first, no path
    names, no separators. ITEM-3's writer and ITEM-7's verifier both take
    this from the artifact record; they must not re-derive a second
    convention."""
    h = HASH()
    with open(os.path.join(method_dir, "method.json"), "rb") as f:
        h.update(f.read())
    with open(os.path.join(method_dir, wrapper), "rb") as f:
        h.update(f.read())
    return h.hexdigest()


def resolve_base(from_ref: str, language: str, benchmark_dir: str,
                 arch: str, force_build: bool) -> dict:
    """Produce the base image and its digest (design §3 step 1 + CONS-1).

    Order: local image (a publish/dev host that already has the base — no
    network) → docker pull (the build's network need; ghcr.io is already on
    the allowlist) → build from the benchmark tree's legacy base recipe
    (tagged with the FROM ref so the method build resolves it) with buildx
    --metadata-file so the exact registry digest is recorded.

    The digest is the OCI manifest/index digest: RepoDigests for a pulled
    or pushed ref, the buildx containerimage.digest for a locally built one.
    Recording the config digest instead would break the pairing anchor (the
    annotation compares manifest digests), so the fallback path records
    buildx's digest only.
    """
    legacy = os.path.join(benchmark_dir, "docker-images",
                          "base-" + ("r" if language == "R" else "py"))
    if not force_build and image_exists(from_ref):
        digest = pick_digest(image_repo_digests(from_ref), from_ref)
        if digest:
            return {"ref": from_ref, "digest": digest, "source": "local",
                    "digest_source": "repo_digests", "legacy_dir": legacy}
        print(f"info: {from_ref} is local but carries no repo digest"
              f" ({image_repo_digests(from_ref)}), trying the pull path",
              file=sys.stderr)
    if not force_build:
        try:
            docker("pull", from_ref)
        except DockerStageError as e:
            print(f"warn: docker pull {from_ref} failed; trying the benchmark "
                  f"tree fallback — {e}", file=sys.stderr)
        else:
            digest = pick_digest(image_repo_digests(from_ref), from_ref)
            if digest:
                return {"ref": from_ref, "digest": digest, "source": "pulled",
                        "digest_source": "repo_digests", "legacy_dir": legacy}
    if not os.path.isfile(os.path.join(legacy, "Dockerfile")):
        raise DockerStageError(
            f"base image {from_ref} is neither local nor pullable, and no "
            f"fallback recipe exists at {legacy}/Dockerfile (pass "
            "--benchmark-dir, or publish the base first)")
    digest = build_image(from_ref, legacy, arch, metadata_file=_meta_file())
    return {"ref": from_ref, "digest": digest, "source": "benchmark-tree",
            "digest_source": "buildx_metadata" if digest else "repo_digests",
            "legacy_dir": legacy}


def _meta_file() -> str:
    import tempfile
    tmp = os.environ.get("TMPDIR") or tempfile.gettempdir()
    os.makedirs(tmp, exist_ok=True)
    return os.path.join(tmp, "txr-base-build-meta.json")


def base_cache_key(base_digest: str | None, arch: str) -> str:
    return f"{base_digest[:16] if base_digest else 'no-digest'}-{arch}"


def base_cache_dirs(out: str, base_digest: str | None, arch: str) -> tuple[str, str]:
    root = os.path.join(out, "bases", base_cache_key(base_digest, arch))
    return root, os.path.join(root, "rootfs")


def load_or_build_base_index(out: str, base_digest: str | None, arch: str,
                             base_rootfs: str) -> dict[str, tuple[int, str]]:
    path = os.path.join(out, "bases", base_cache_key(base_digest, arch),
                        "index.json")
    if os.path.isfile(path):
        try:
            with open(path) as f:
                raw = json.load(f)
            return {k: (int(v[0]), v[1]) for k, v in raw.items()}
        except (OSError, ValueError, KeyError, TypeError):
            pass  # stale/partial cache — rebuild
    index = build_base_index(base_rootfs)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(index, f, separators=(",", ":"), sort_keys=True)
    return index


# ─────────────────────────────── the per-method build ────────────────────────

def build_one(eid: str, entry: dict, args) -> dict:
    """Build + stage one method layer; returns the artifact record. Every
    refusal propagates as an exception naming the method; the driver stops —
    no silent skip of a runnable method (DEC-8).
    """
    if not ENV_ID_RE.match(eid):
        raise BuildError(
            f"method id {eid!r} is not a valid env id (env_id.rs grammar); "
            "it cannot have a layer")
    folder = method_folder(args.methods_dir, eid)
    base_ref, base_key = classify_from(os.path.join(folder["dir"], "Dockerfile"))
    index_language = entry.get("language")
    if index_language != BASE_LANG_BY_KEY[base_key]:
        raise BuildError(
            f"method {eid}: index language {index_language!r} does not match "
            f"its FROM base {base_ref!r} (with LANGUAGE {BASE_LANG_BY_KEY[base_key]})")
    if not CONTRACT_RE.match(entry.get("contract") or ""):
        raise BuildError(f"method {eid}: index contract "
                         f"{entry.get('contract')!r} is not an X.Y version")
    version = entry.get("version") or ""
    if not re.match(r"^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$", version):
        raise BuildError(f"method {eid}: index version {version!r} is not a "
                         "semver-ish version; the registry tag needs it")

    print(f"\n=== {eid} ({index_language}, {version}) ===")

    if args.dry_run:
        tag = METHOD_IMAGE_TAG.format(env_id=eid, arch=args.arch)
        print("+ docker build --platform linux/%s -t %s %s"
              % (args.arch, tag, folder["dir"]))
        print("+ docker create/export %s + its FROM base %s -> tar"
              % (tag, base_ref))
        print("+ delta / trim / cover / marker / modes")
        print("+ mksquashfs -comp zstd -Xcompression-level 22 -b 1M "
              "-noappend -no-progress -all-root")
        print("+ write layers/%s-%s/artifact.json" % (eid, args.arch))
        return {"env_id": eid, "dry_run": True}

    # 1. base: local -> pull -> benchmark-tree fallback.
    base = resolve_base(base_ref, index_language, args.benchmark_dir,
                        args.arch, args.force_base_build)
    if not base.get("digest"):
        raise BuildError(
            f"method {eid}: no digest recorded for base {base_ref} — the "
            "pairing anchor cannot be emitted (pulled or buildx-built base "
            "required)")

    # 2. build the method image exactly as published.
    tag = METHOD_IMAGE_TAG.format(env_id=eid, arch=args.arch)
    build_image(tag, folder["dir"], args.arch)

    # 3-4. export + extract both rootfses. The base is extracted once per
    # (digest, arch) and cached under out/bases — the full run's 95 methods
    # share two base rootfses, not 95.
    work = os.path.join(args.out, "work", f"{eid}-{args.arch}")
    os.makedirs(work, exist_ok=True)
    m_tar = os.path.join(work, "method-rootfs.tar")
    export_rootfs(tag, m_tar)
    m_root = os.path.join(work, "method-rootfs")
    extract_tar(m_tar, m_root)

    b_tar = os.path.join(work, "base-rootfs.tar")
    base_cache, b_root = base_cache_dirs(args.out, base["digest"], args.arch)
    b_tar_cached = os.path.join(base_cache, "base-rootfs.tar")
    if os.path.isfile(b_tar_cached):
        os.replace(b_tar_cached, b_tar)  # reuse earlier export, same digest
    else:
        export_rootfs(base["ref"], b_tar)
    if not os.path.isdir(b_root):
        extract_tar(b_tar, b_root)

    # 5. delta + refusals (deletion refusal happens inside closed_cover,
    # after the cover is known — see its docstring).
    index = load_or_build_base_index(args.out, base["digest"], args.arch, b_root)
    delta = compute_delta(m_root, b_root, index)
    if not args.no_trim:
        delta = trim_delta(delta)
    print(f"  delta: {len(delta.added)} added, {len(delta.changed)} changed, "
          f"{len(delta.refused)} deletions (excluded-top: "
          f"{delta.n_dropped_excluded_deleted} dropped), "
          f"{delta.n_dropped_excluded_added} debris-dropped")

    # 6-9. cover, materialize, trim, modes, contract files.
    entries = closed_cover(delta, m_root)
    layer_dir = os.path.join(args.out, "layers", f"{eid}-{args.arch}")
    layer_root = os.path.join(layer_dir, "layer")
    materialize_layer(entries, m_root, layer_root)
    if not args.no_trim:
        trim_layer(layer_root)
    check_wrapper_modes(layer_root, folder["wrapper"])
    normalize_modes(layer_root)
    emit_marker_and_manifest(layer_root, entries)
    print(f"  entries: {', '.join(entries)}")

    # 10. pack.
    os.makedirs(layer_dir, exist_ok=True)
    squashfs = os.path.join(layer_dir, "layer.squashfs")
    _run(["mksquashfs", layer_root, squashfs, "-comp", "zstd",
          "-Xcompression-level", "22", "-b", "1M", "-noappend", "-no-progress",
          "-all-root"])
    _assert_squashfs_ok(squashfs)

    # 11. artifact record (ITEM-3 consumes this file directly).
    record = {
        "record_schema_version": 1,
        "generator_version": GENERATOR_VERSION,
        "env_id": eid,
        "method_id": eid,
        "method_version": version,
        "language": index_language,
        "arch": args.arch,
        "oci_ref": f"{OCI_REF_PREFIX}/{eid}",
        "tag": f"{version}-{args.arch}",
        "source_revision": source_revision(args.methods_dir),
        "base_ref": base["ref"],
        "base_digest": base["digest"],
        "base_digest_source": base["digest_source"],
        "base_ref_source": base["source"],
        "built_image_tag": tag,
        "layer_file": "layer.squashfs",
        "layer_sha256": _sha256_of(squashfs),
        "size_bytes": os.path.getsize(squashfs),
        "wrapper_code_sha256": wrapper_code_sha256(folder["dir"], folder["wrapper"]),
        "layer_schema": LAYER_SCHEMA_VERSION,
        "layer_manifest": entries,
        "run_file": folder["wrapper"],
        "delta": {
            "added": len(delta.added),
            "changed": len(delta.changed),
            "removed_refused": len(delta.refused),
            "dropped_excluded_tops_added": delta.n_dropped_excluded_added,
            "dropped_excluded_tops_deleted": delta.n_dropped_excluded_deleted,
        },
    }
    with open(os.path.join(layer_dir, "artifact.json"), "w") as f:
        json.dump(record, f, indent=2, sort_keys=True)
        f.write("\n")

    if not args.keep_rootfs:
        shutil.rmtree(m_root, ignore_errors=True)
        for t in (m_tar,):
            if os.path.exists(t):
                os.unlink(t)
        if os.path.isfile(b_tar) and not os.path.isfile(b_tar_cached):
            os.replace(b_tar, b_tar_cached)  # keep for the next method
        shutil.rmtree(work, ignore_errors=True)
    return record


def _sha256_of(path: str) -> str:
    h = HASH()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _assert_squashfs_ok(path: str) -> None:
    size = os.path.getsize(path)
    if size < MIN_SIZE_BYTES:
        raise BuildError(f"packed layer {path} is {size} bytes")
    p = subprocess.run(["unsquashfs", "-ll", path], capture_output=True, text=True)
    if p.returncode != 0:
        raise BuildError(f"unsquashfs rejects the packed layer {path}: "
                         f"{p.stderr[-2000:]}")


# ───────────────────────── manifest writer (ITEM-3) ───────────────────────────

def load_staged_records(records_dir: str) -> list[dict]:
    """Load every staged artifact record under <records_dir>/layers.

    Sorted by (env_id, arch) — the manifest's own sort key, so the writer
    re-sorts what it loads rather than trusting the directory listing.
    A record directory without artifact.json is a violation of the staging
    contract and is REFUSED (naming it): a partially-written staging dir
    must never silently produce a manifest with fewer entries.
    """
    layers = os.path.join(records_dir, "layers")
    if not os.path.isdir(layers):
        raise SystemExit(
            f"no staged records under {layers} (run the generator build "
            "first, or pass --fixture <dir> pointing at a fixture staging dir)")
    records: list[dict] = []
    for name in sorted(os.listdir(layers)):
        d = os.path.join(layers, name)
        if not os.path.isdir(d):
            continue
        rec_path = os.path.join(d, "artifact.json")
        if not os.path.isfile(rec_path):
            raise SystemExit(f"staged layer dir {d} has no artifact.json")
        with open(rec_path) as f:
            try:
                rec = json.load(f)
            except json.JSONDecodeError as e:
                raise SystemExit(f"{rec_path} is not valid JSON: {e}") from e
        if not isinstance(rec, dict) or rec.get("record_schema_version") != 1:
            raise SystemExit(
                f"{rec_path} is not a record_schema_version 1 artifact "
                f"record (got {rec.get('record_schema_version')!r})"
                " — rebuild with the current generator")
        records.append(rec)
    records.sort(key=lambda r: (r.get("env_id", ""), r.get("arch", "")))
    return records


def _ref_of_record(rec: dict) -> str:
    return f"{rec.get('env_id', '?')}-{rec.get('arch', '?')}"


def validate_record_and_entry(rec: dict, entry: dict,
                              index_entry: dict) -> None:
    """Writer-side structural checks; each refusal names the record.

    The ITEM-4 guard re-validates the COMMITTED file; the writer validates
    the same facts at assembly time so a bad record cannot produce a bad
    manifest that a later guard round then has to explain. Every check is
    a hard error (never a normalize-and-proceed): a value the writer
    silently repairs would not regenerate on the next run and would break
    byte parity. (The index-presence and DEC-8 runnable refusals are
    decided in assemble_manifest BEFORE any method.json read — a record
    for a method the index does not declare as runnable must refuse on
    that fact, not on whichever file happens to be missing.)
    """
    ref = _ref_of_record(rec)
    version, arch = (rec.get("method_version", ""), rec.get("arch", ""))
    if entry["env_id"] != entry["method_id"]:
        raise SystemExit(f"record {ref}: env_id != method_id (DEC-1)")
    if not ENV_ID_RE.match(entry["env_id"]):
        raise SystemExit(f"record {ref}: env_id {entry['env_id']!r} is not a valid "
                         "env id (env_id.rs grammar)")
    if arch not in ("amd64", "arm64"):
        raise SystemExit(f"record {ref}: arch {arch!r} not in amd64/arm64")
    if entry["tag"] != f"{version}-{arch}":
        raise SystemExit(
            f"record {ref}: tag {entry['tag']!r} != '<method_version>-<arch>' "
            f"(DEC-2; got version {version!r})")
    if entry["oci_ref"] != f"{OCI_REF_PREFIX}/{entry['env_id']}":
        raise SystemExit(f"record {ref}: oci_ref {entry['oci_ref']!r} is not "
                         f"{OCI_REF_PREFIX}/<env_id>")
    if not BASE_REF_RE.match(entry["base_ref"]):
        raise SystemExit(f"record {ref}: base_ref {entry['base_ref']!r} is not a "
                         "ghcr.io/tinnlab/txresbench-base-(r|py):<contract> ref")
    for field, pat in (("base_digest", r"^sha256:[0-9a-f]{64}$"),
                       ("layer_sha256", r"^[0-9a-f]{64}$"),
                       ("wrapper_code_sha256", r"^[0-9a-f]{64}$")):
        if not re.match(pat, entry[field]):
            raise SystemExit(f"record {ref}: {field} {entry[field]!r} is not the "
                             "required hex/digest shape")
    if not isinstance(entry["size_bytes"], int) or entry["size_bytes"] < 1:
        raise SystemExit(f"record {ref}: size_bytes {entry['size_bytes']!r} is "
                         "not a positive integer")
    if entry["language"] not in ("R", "Python"):
        raise SystemExit(f"record {ref}: language {entry['language']!r} not in R/Python")
    if index_entry.get("language") != entry["language"]:
        raise SystemExit(f"record {ref}: index language {index_entry.get('language')!r} "
                         f"!= record language {entry['language']!r}")
    if index_entry.get("version") != version:
        raise SystemExit(f"record {ref}: index version {index_entry.get('version')!r} "
                         f"!= record version {version!r}")
    base_contract = entry["base_ref"].rsplit(":", 1)[1]
    if entry["contract"] != base_contract:
        raise SystemExit(
            f"record {ref}: index contract {entry['contract']!r} != the base "
            f"tag contract {base_contract!r} of {entry['base_ref']} — a layer "
            "computed against one contract cannot be declared as another")
    if not CONTRACT_RE.match(entry["contract"]):
        raise SystemExit(f"record {ref}: index contract {entry['contract']!r} is "
                         "not an X.Y version")
    if entry["layer_schema"] != LAYER_SCHEMA_VERSION:
        raise SystemExit(f"record {ref}: layer_schema {entry['layer_schema']!r} != "
                         f"{LAYER_SCHEMA_VERSION} (DEC-11)")
    if not entry["licence"].strip():
        raise SystemExit(f"record {ref}: method.json licence is empty (minLength 1)")
    v = index_entry.get("version") or ""
    if not re.match(r"^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$", v):
        raise SystemExit(f"record {ref}: index version {v!r} is not semver-ish")


def load_licence(methods_dir: str, eid: str) -> str:
    """method.json's `licence`, verbatim (TEST-11 — the manifest reproduces
    the legal fact, never a paraphrase)."""
    with open(os.path.join(methods_dir, "methods", eid, "method.json")) as f:
        mj = json.load(f)
    lic = mj.get("licence")
    if not isinstance(lic, str) or not lic:
        raise SystemExit(f"method {eid}: method.json has no non-empty 'licence'")
    return lic


def oci_artifact_manifest_bytes(rec: dict, contract: str) -> bytes:
    """The EXACT OCI artifact manifest bytes ITEM-5's publisher must push
    (design §6): the manifest `digest` recorded in the committed file is
    sha256 of THESE bytes, so the construction is pinned here once and the
    publisher's verify (oras resolve == digest) is the runtime-visible seam
    that closes the loop when oras is at hand.

    The shape mirrors what `oras push --artifact-type <t> <ref>:<tag>
    layer.squashfs:<t>` stores (publish-env-rootfs.sh's own invocation
    shape): artifactType = the artifact type, the single layer's mediaType
    = the artifact type (the file is the layer, not a tar), config = the
    OCI empty JSON, the layer descriptor carries the file title annotation
    (oras's file-push convention). `org.opencontainers.image.revision` is
    the methods-repo commit — PROV-2's annotation set. Key order is the OCI
    manifest struct order (schemaVersion, mediaType, artifactType, config,
    layers, annotations), so the bytes are deterministic for one record and
    match a Go-encoded manifest: no whitespace, no HTML escapes needed
    (all annotation values are ASCII).
    """
    manifest = {
        "schemaVersion": 2,
        "mediaType": OCI_MANIFEST_MEDIATYPE,
        "artifactType": ARTIFACT_TYPE,
        "config": {
            "mediaType": "application/vnd.oci.empty.v1+json",
            "digest": OCI_EMPTY_CONFIG_DIGEST,
            "size": OCI_EMPTY_CONFIG_SIZE,
        },
        "layers": [
            {
                "mediaType": ARTIFACT_TYPE,
                "digest": "sha256:" + rec["layer_sha256"],
                "size": rec["size_bytes"],
                "annotations": {"org.opencontainers.image.title": rec["layer_file"]},
            }
        ],
        "annotations": {
            "org.opencontainers.image.source": SOURCE_URL,
            "org.opencontainers.image.revision": rec["source_revision"],
            "com.txr.method_id": rec["method_id"],
            "com.txr.method_version": rec["method_version"],
            "com.txr.language": rec["language"],
            "com.txr.arch": rec["arch"],
            "com.txr.contract": contract,
            "com.txr.base_ref": rec["base_ref"],
            "com.txr.base_digest": rec["base_digest"],
            "com.txr.layer_sha256": rec["layer_sha256"],
            "com.txr.layer_schema": str(rec["layer_schema"]),
        },
    }
    return json.dumps(manifest, separators=(",", ":"), ensure_ascii=False).encode()


def assemble_manifest(records: list[dict], methods_dir: str,
                      by_id: dict) -> tuple[dict, dict]:
    """One manifest from staged records (INV-5, DEC-15).

    Returns (manifest, entries_by_key) where the key is (env_id, arch) —
    the same key the check mode uses for its diff. Every record must carry
    the same source_revision (a mixed staging dir is a staging bug, not a
    manifest: the manifest records ONE revision, DEC-15).
    """
    if not records:
        raise SystemExit(
            "no staged records to assemble (the manifest is never written from "
            "an empty staging dir outside the ITEM-1 seed path)")
    revisions = {r.get("source_revision", "") for r in records}
    if len(revisions) != 1:
        raise SystemExit(
            "staged records carry different source revisions: "
            + ", ".join(sorted(revisions))
            + " — rebuild against ONE methods-repository revision (DEC-15)")
    source_revision = next(iter(revisions))

    entries: list[dict] = []
    by_key: dict[tuple[str, str], dict] = {}
    for rec in records:
        eid = rec.get("env_id", "")
        if not eid or not ENV_ID_RE.match(eid):
            raise SystemExit(f"record {_ref_of_record(rec)}: env_id missing/invalid")
        index_entry = by_id.get(eid)
        if index_entry is None:
            raise SystemExit(f"record {_ref_of_record(rec)}: method {eid!r} is not "
                             "in the methods index")
        if index_entry.get("runnable") is not True:
            raise SystemExit(f"record {_ref_of_record(rec)}: method {eid!r} is "
                             "not runnable in the index (DEC-8: exactly the "
                             "runnable methods get a layer)")
        contract = str(index_entry.get("contract") or "")
        try:
            licence = load_licence(methods_dir, eid)
        except OSError as e:
            raise SystemExit(
                f"record {_ref_of_record(rec)}: cannot read method {eid!r}'s "
                f"licence (method.json): {e}") from e
        entry = {
            "env_id": eid,
            "method_id": rec.get("method_id", eid),
            "method_version": rec.get("method_version", ""),
            "language": rec.get("language", ""),
            "arch": rec.get("arch", ""),
            "oci_ref": rec.get("oci_ref", ""),
            "tag": rec.get("tag", ""),
            "digest": "sha256:" + HASH(
                oci_artifact_manifest_bytes(rec, contract)).hexdigest(),
            "layer_sha256": rec.get("layer_sha256", ""),
            "size_bytes": rec.get("size_bytes", 0),
            "base_ref": rec.get("base_ref", ""),
            "base_digest": rec.get("base_digest", ""),
            "contract": contract,
            "licence": licence,
            "wrapper_code_sha256": rec.get("wrapper_code_sha256", ""),
            "layer_schema": rec.get("layer_schema", -1),
        }
        validate_record_and_entry(rec, entry, index_entry)
        entries.append(entry)
        by_key[(entry["env_id"], entry["arch"])] = entry
    entries.sort(key=lambda e: (e["env_id"], e["arch"]))
    manifest = {
        "schema_version": MANIFEST_SCHEMA_VERSION,
        "generator_version": GENERATOR_VERSION,
        "source_revision": source_revision,
        "base_contract": "2.0",
        "envs": entries,
    }
    return manifest, by_key


def manifest_bytes(manifest: dict) -> bytes:
    """The pinned serialization: 2-space indent, field order as emitted by
    assemble_manifest (the schema's own order), trailing newline — the same
    shape the ITEM-1 seed used, so `--check` is a byte comparison."""
    return (json.dumps(manifest, indent=2) + "\n").encode()


def first_difference(committed: dict, assembled: dict) -> str | None:
    """The path of the first field where the two manifests differ (TEST-2:
    the failure names the first differing key), or None when they agree."""
    if committed.get("schema_version") != assembled.get("schema_version"):
        return "schema_version"
    for key in ("generator_version", "source_revision", "base_contract"):
        if committed.get(key) != assembled.get(key):
            return key
    c_envs = committed.get("envs", [])
    a_envs = assembled.get("envs", [])
    if len(c_envs) != len(a_envs):
        c_keys = {(e.get("env_id"), e.get("arch")) for e in c_envs}
        a_keys = {(e.get("env_id"), e.get("arch")) for e in a_envs}
        missing = sorted(a_keys - c_keys)
        extra = sorted(c_keys - a_keys)
        if missing:
            return f"envs[{len(c_envs)}].env_id (missing {missing[0][0]}-{missing[0][1]})"
        return f"envs[{len(c_envs)}].env_id (unexpected {extra[0][0]}-{extra[0][1]})"
    for i, (c, a) in enumerate(zip(c_envs, a_envs)):
        if (c.get("env_id"), c.get("arch")) != (a.get("env_id"), a.get("arch")):
            return f"envs[{i}].env_id ({c.get('env_id')} != {a.get('env_id')})"
        for field in ("env_id", "method_id", "method_version", "language", "arch",
                      "oci_ref", "tag", "digest", "layer_sha256", "size_bytes",
                      "base_ref", "base_digest", "contract", "licence",
                      "wrapper_code_sha256", "layer_schema"):
            if c.get(field) != a.get(field):
                return f"envs[{i}].{field}"
    return None


def check_manifest(records: list[dict], methods_dir: str, by_id: dict,
                   manifest_path: str, pin: str | None) -> int:
    """ITEM-3's --check: assemble from staged records (no build) and compare
    BYTE equality against the committed manifest; report the first differing
    key. Returns 0 (identical) or 1 (differ) — never throws for a diff.
    An explicit --source-revision pin is checked first (a staging dir built
    at the wrong revision is reported as such); without the pin the parity
    comparison itself names `source_revision` when revisions mismatch
    (TEST-2: fails naming the first differing key after a bumped revision)."""
    with open(manifest_path, "rb") as f:
        committed_bytes = f.read()
    try:
        committed = json.loads(committed_bytes)
    except json.JSONDecodeError as e:
        print(f"check: {manifest_path} is not valid JSON: {e}", file=sys.stderr)
        return 1
    if pin is not None:
        wrong = [r["source_revision"] for r in records
                 if r.get("source_revision") != pin]
        if wrong:
            print(f"check: staged records are for revision {sorted(set(wrong))} "
                  f"but the pin is {pin} — regenerate at the pinned revision "
                  "(INV-5: one revision, one manifest)", file=sys.stderr)
            return 1
    manifest, _by_key = assemble_manifest(records, methods_dir, by_id)
    assembled_bytes = manifest_bytes(manifest)
    if assembled_bytes == committed_bytes:
        n = len(manifest["envs"])
        print(f"check: MANIFEST OK ({n} env entr{'y' if n == 1 else 'ies'}, "
              f"revision {manifest['source_revision']}, "
              f"generator {manifest['generator_version']})")
        return 0
    key = first_difference(committed, manifest)
    c_val = _lookup(committed, key)
    a_val = _lookup(manifest, key)
    print(f"check: MANIFEST DIFFERS at {key}: committed {c_val!r} != "
          f"assembled {a_val!r} ({len(manifest['envs'])} assembled entries "
          f"vs {len(committed.get('envs', []))} committed)", file=sys.stderr)
    print("check: regenerate with --manifest <path> (or rebuild at the "
          "recorded revision); never hand-edit (INV-5)", file=sys.stderr)
    return 1


def _lookup(obj: dict, path: str | None):
    if path is None:
        return None
    if path.startswith("envs["):
        i = int(path.split("[", 1)[1].split("]", 1)[0])
        field = path.split(".", 1)[1] if "." in path else None
        entry = obj.get("envs", [])[i] if i < len(obj.get("envs", [])) else {}
        return entry.get(field) if field else entry.get("env_id")
    return obj.get(path)


def check_methods_dir_revision(methods_dir: str, source_revision: str) -> None:
    """The methods dir the writer reads contract/licence from must BE the
    revision the layers were built at — otherwise the manifest could take
    year-newer licence facts while its layers are the old method's bytes.
    Enforced when the dir is a git checkout (the build itself refused a
    non-git dir at ITEM-2, so real runs always have git here); fixture
    trees are content snapshots and are exempt by design (--fixture)."""
    p = subprocess.run(["git", "-C", methods_dir, "rev-parse", "HEAD"],
                       capture_output=True, text=True)
    if p.returncode != 0:
        return  # not a git checkout: fixture snapshot
    head = p.stdout.strip()[:12]
    if head != source_revision:
        raise SystemExit(
            f"methods dir {methods_dir} is at {head}, not {source_revision} — "
            "the contract/licence facts (and the manifest's source_revision) "
            "would not match the built layers. Check out the recorded revision "
            "or regenerate at the current HEAD.")


def write_manifest(records: list[dict], methods_dir: str, by_id: dict,
                   manifest_path: str, record_dirs: dict[str, str],
                   pin: str | None) -> None:
    """Assemble + write the manifest, then stage each entry's exact OCI
    artifact manifest bytes next to its artifact record (ITEM-5 pushes those
    bytes, so the recorded digest is by construction the pushed digest)."""
    if pin is not None:
        wrong = sorted({r["source_revision"] for r in records
                        if r.get("source_revision") != pin})
        if wrong:
            raise SystemExit(f"--source-revision {pin}: staged records carry "
                             f"{wrong} (one revision per staging dir)")
    manifest, _by_key = assemble_manifest(records, methods_dir, by_id)
    check_methods_dir_revision(methods_dir, manifest["source_revision"])
    parent = os.path.dirname(manifest_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    with open(manifest_path, "wb") as f:
        f.write(manifest_bytes(manifest))
    for rec in records:
        layer_dir = record_dirs.get((rec.get("env_id"), rec.get("arch")))
        if layer_dir is None:
            raise SystemExit(f"record {_ref_of_record(rec)}: unknown layer dir")
        index_entry = by_id.get(rec.get("env_id"))
        contract = str(index_entry.get("contract") or "") if index_entry else ""
        with open(os.path.join(layer_dir, "oci-manifest.json"), "wb") as f:
            f.write(oci_artifact_manifest_bytes(rec, contract))
    print(f"manifest written: {manifest_path} ({len(manifest['envs'])} env "
          f"entr{'y' if len(manifest['envs']) == 1 else 'ies'}, revision "
          f"{manifest['source_revision']})")


# ─────────────────────────────── CLI ─────────────────────────────────────────
def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        description="Build per-method environment layer artifacts and write/"
                    "check the committed env manifest (node "
                    "method-env-images, ITEM-2 + ITEM-3). No push.")
    parser.add_argument("--only", nargs="+", metavar="ID",
                        help="build only these method ids (resume, ITEM-6); "
                             "default: every runnable method")
    parser.add_argument("--arch", default="amd64", help="amd64 (default) or "
                        "arm64; cross-arch is refused unless "
                        "ALLOW_EMULATED_BUILD=1")
    parser.add_argument("--methods-dir",
                        default=os.environ.get("TXR_METHODS_DIR")
                        or "/data/share/pbya/sigtrans/methods")
    parser.add_argument("--benchmark-dir",
                        default=os.environ.get("TXR_BENCHMARK_DIR"))
    parser.add_argument("--out", default=os.environ.get("TXR_ENV_BUILD_DIR"))
    parser.add_argument("--manifest", metavar="PATH",
                        help="assemble + write the manifest to PATH (build "
                             "mode: after this run's layers; fixture mode: "
                             "from the fixture records; --check mode: the "
                             "file to compare against, default "
                             "src-app/server/data/method-env-images.json)")
    parser.add_argument("--check", action="store_true",
                        help="assemble only (no docker) from the staged "
                             "records under --out/--fixture and byte-compare "
                             "against --manifest (default "
                             "src-app/server/data/method-env-images.json). "
                             "Exit 1 names the first differing key.")
    parser.add_argument("--fixture", metavar="DIR",
                        help="read staged records from DIR/layers without "
                             "building (the tests' local fixture mode). "
                             "Requires --manifest or --check.")
    parser.add_argument("--source-revision", metavar="12HEX",
                        help="expected source revision pin: every staged "
                             "record must carry it (the parity comparison "
                             "against the committed file's own revision is "
                             "the default check)")
    parser.add_argument("--no-trim", action="store_true",
                        help="debugging only (DEC-12: trim constants are fixed)")
    parser.add_argument("--keep-rootfs", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--force-base-build", action="store_true")
    args = parser.parse_args(argv)

    if args.source_revision is not None and not SOURCE_REVISION_RE.match(
            args.source_revision):
        parser.error("--source-revision must be 12 lowercase hex chars "
                     "(the methods-repo commit prefix)")
    if args.fixture and args.out:
        parser.error("--fixture and --out are exclusive; --fixture <dir> "
                     "reads records from <dir>/layers and never builds")
    if args.check and not args.fixture and not args.out:
        parser.error("--check needs the staged records: pass --out <dir> or "
                     "--fixture <dir>")

    repo_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    manifest_path = args.manifest or os.path.join(repo_root, DEFAULT_MANIFEST_PATH)

    if args.check:
        records_dir = args.fixture or args.out
        records = load_staged_records(records_dir)
        if not records:
            print(f"check: no staged records under {records_dir}/layers — "
                  "parity cannot be assessed (build first / point --fixture "
                  "at a fixture staging dir)", file=sys.stderr)
            return 1
        return check_manifest(records, args.methods_dir,
                              load_method_index(args.methods_dir),
                              manifest_path, args.source_revision)

    if args.fixture:
        records = load_staged_records(args.fixture)
        if not args.manifest:
            parser.error("--fixture requires --manifest <path> (write) or "
                         "--check (parity)")
        write_manifest(records, args.methods_dir,
                       load_method_index(args.methods_dir),
                       manifest_path,
                       _record_dirs_of(args.fixture, records),
                       args.source_revision)
        return 0

    if not args.out:
        parser.error("--out is required (TXR_ENV_BUILD_DIR also works); the "
                     "staging dir must live outside the repo")
    if not os.path.isdir(args.methods_dir):
        parser.error(f"methods directory {args.methods_dir} is not a "
                     "directory (TXR_METHODS_DIR / --methods-dir)")
    # verify_arch before any build (mirror publish-env-rootfs.sh).
    host = os.uname().machine
    host_arch = {"x86_64": "amd64", "amd64": "amd64",
                 "aarch64": "arm64", "arm64": "arm64"}.get(host)
    if args.arch not in ("amd64", "arm64"):
        parser.error("--arch must be amd64 or arm64")
    if args.arch != host_arch and os.environ.get("ALLOW_EMULATED_BUILD") != "1":
        parser.error(f"refusing to build a {args.arch} layer from a {host} host "
                     "(set ALLOW_EMULATED_BUILD=1 only with qemu configured and "
                     "meant; the tag is resolved by real deployments)")
    if args.benchmark_dir is None:
        args.benchmark_dir = os.path.dirname(os.path.abspath(args.methods_dir)) \
            + "/dev/code/benchmark"

    by_id = load_method_index(args.methods_dir)
    selected = select_methods(by_id, args.only)
    print(f"methods dir : {args.methods_dir}")
    print(f"out         : {args.out}")
    print(f"arch        : {args.arch}   ({len(selected)} method(s))")
    records = []
    for eid, entry in selected:
        try:
            records.append(build_one(eid, entry, args))
        except (BuildError, DockerStageError, OSError) as e:
            print(f"\nFAIL {eid}: {e}", file=sys.stderr)
            return 1
    print(f"\nbuilt {len(records)}/{len(selected)} layers into {args.out}")
    for r in records:
        if r.get("size_bytes"):
            print(f"  {r['env_id']:48s} {r['size_bytes']:>12,} bytes "
                  f"({len(r['layer_manifest'])} entries)")
    if args.manifest:
        if args.dry_run:
            print(f"+ write manifest {manifest_path} from the staged records")
            print(f"+ stage <layer_dir>/oci-manifest.json per entry")
        else:
            write_manifest(records, args.methods_dir, by_id, manifest_path,
                           _record_dirs_of(args.out, records),
                           args.source_revision)
    return 0


def _record_dirs_of(records_dir: str, records: list[dict]) -> dict:
    """(env_id, arch) -> the layer dir that holds artifact.json, for the
    writer's oci-manifest.json staging."""
    return {(r["env_id"], r["arch"]): os.path.join(
        records_dir, "layers", f"{r['env_id']}-{r['arch']}") for r in records}


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
